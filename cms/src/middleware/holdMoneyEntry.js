// ============================================================
// HOLD MONEY ENTRY (v1.73.0) — "four eyes" on money entries
//
// Requested directly: "lets also make the approval rule apply for
// transactions as well for any one that is not the treasurer or admin"
// — confirmed as: held until approved · approved by the Treasurer or an
// Admin · every money entry (not only the Transactions page).
//
// How it works
//   Every route that moves money STRAIGHT AWAY (record an expense, top
//   up a money market fund, record a loan repayment, pay a coupon, pay
//   tax …) has this step placed after its input checks and just before
//   its controller:
//
//     router.post('/expenses', requireRoles([...]), [validators],
//         validateRequest,
//         holdMoneyEntry('transactions.expense', transactionsController.recordExpense,
//             { label: 'Expense', account: b => b.account_id }),
//         transactionsController.recordExpense);
//
//   • Caller holds the Treasurer or Admin role → nothing changes, the
//     controller runs and the money moves as before.
//   • Anyone else → NOTHING is posted. The request (the checked form
//     values) is saved in held_money_entries as PENDING, the Treasurer
//     and Admins are notified, and the caller gets
//     "Sent for approval …" (HTTP 202, data.held = true).
//   • When the Treasurer or an Admin approves it (Money ›
//     Awaiting approval), the very same action runs again on behalf of
//     the person who recorded it — same checks (balance, floor limit,
//     dates…), same references, same notifications — and the ledger
//     rows store approved_by = the approver. If a check fails at that
//     moment (e.g. the account no longer has enough money), nothing is
//     posted and the entry stays waiting, with the reason shown.
//
// Steps that are THEMSELVES an approval (approving a transfer, a savings
// deposit, a requisition …) are not held — they already are the second
// pair of eyes (v1.72.0 four-eyes rule).
// ============================================================

const { query } = require('../config/database');
const { notify } = require('../services/notificationService');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');

// Who may record money without a second person, and who approves.
const FREE_ROLES = ['Treasurer', 'Admin'];

// route key → { controller, label, ... } — filled when the route files
// load at start-up, read when an entry is approved.
const registry = new Map();

const isFree = (req) => (req.user?.roles || []).some(r => FREE_ROLES.includes(r));

// Common amount fields, in the order they are looked for.
const AMOUNT_FIELDS = ['amount', 'principal_amount', 'gross_amount', 'initial_amount',
    'settlement_value', 'amount_received', 'actual_gross_amount', 'amount_sent'];

const pickAmount = (body) => {
    if (Array.isArray(body?.payments)) {
        return body.payments.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
    }
    for (const f of AMOUNT_FIELDS) {
        const v = parseFloat(body?.[f]);
        if (!Number.isNaN(v) && v > 0) return v;
    }
    return null;
};

// What the entry is about — shown on the approval list.
const SUBJECTS = {
    investment: {
        sql: `SELECT i.name, c.code FROM investments i JOIN currencies c ON c.id = i.currency_id WHERE i.id = $1`,
        prefix: 'Investment',
    },
    mmf: {
        sql: `SELECT m.name, c.code FROM mmf_accounts m JOIN currencies c ON c.id = m.currency_id WHERE m.id = $1`,
        prefix: 'Money market fund',
    },
    loanReceived: {
        sql: `SELECT l.lender_name AS name, c.code FROM loans_received l JOIN currencies c ON c.id = l.currency_id WHERE l.id = $1`,
        prefix: 'Loan from',
    },
    loanGiven: {
        sql: `SELECT l.borrower_name AS name, c.code FROM loans_given l JOIN currencies c ON c.id = l.currency_id WHERE l.id = $1`,
        prefix: 'Loan to',
    },
    grant: {
        sql: `SELECT g.title AS name, c.code FROM grants g JOIN currencies c ON c.id = g.currency_id WHERE g.id = $1`,
        prefix: 'Grant',
    },
    fine: {
        sql: `SELECT u.first_name || ' ' || u.last_name || ' — ' || f.reason AS name, c.code
              FROM fines f JOIN users u ON u.id = f.user_id JOIN currencies c ON c.id = f.currency_id WHERE f.id = $1`,
        prefix: 'Fine',
    },
    sideFundDue: {
        sql: `SELECT u.first_name || ' ' || u.last_name || ' — ' || d.period AS name, NULL AS code
              FROM side_fund_dues d JOIN users u ON u.id = d.user_id WHERE d.id = $1`,
        prefix: 'Side fund due',
    },
    member: {
        sql: `SELECT first_name || ' ' || last_name AS name, NULL AS code FROM users WHERE id = $1`,
        prefix: 'Member',
    },
    currency: {
        sql: `SELECT NULL AS name, code FROM currencies WHERE id = $1`,
        prefix: null,
    },
};

const describe = async (req, opts) => {
    const out = { subject: null, currency: null, account: null };
    try {
        if (opts.subject) {
            const id = opts.subject.id(req);
            const def = SUBJECTS[opts.subject.type];
            if (id && def) {
                const r = await query(def.sql, [id]);
                if (r.rows[0]) {
                    if (r.rows[0].name) out.subject = def.prefix ? `${def.prefix}: ${r.rows[0].name}` : r.rows[0].name;
                    if (r.rows[0].code) out.currency = r.rows[0].code;
                }
            }
        }
        const accountId = opts.account ? opts.account(req.body || {}) : null;
        if (accountId) {
            const r = await query(`SELECT a.name, c.code FROM accounts a JOIN currencies c ON c.id = a.currency_id WHERE a.id = $1`, [accountId]);
            if (r.rows[0]) {
                out.account = r.rows[0].name;
                if (!out.currency) out.currency = r.rows[0].code;
            }
        }
    } catch (_) { /* description is best-effort only */ }
    return out;
};

// A short line describing the entry (e.g. the description the person typed).
const pickNote = (body) => {
    for (const f of ['description', 'notes', 'authority_name', 'payee_name', 'payer_name', 'name']) {
        if (body?.[f] && typeof body[f] === 'string') return body[f].slice(0, 300);
    }
    return null;
};

const holdMoneyEntry = (key, controller, opts = {}) => {
    if (!controller) throw new Error(`holdMoneyEntry(${key}): controller is missing`);
    registry.set(key, { key, controller, ...opts });

    return async (req, res, next) => {
        try {
            if (isFree(req)) return next();
            if (opts.when && !opts.when(req)) return next();

            const d = await describe(req, opts);
            const amount = pickAmount(req.body);
            const ins = await query(`
                INSERT INTO held_money_entries
                    (route_key, label, method, path, params, body, query_params,
                     subject, account_name, amount, currency_code, note, created_by)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                RETURNING id
            `, [
                key, opts.label || key, req.method, req.originalUrl,
                JSON.stringify(req.params || {}), JSON.stringify(req.body || {}), JSON.stringify(req.query || {}),
                d.subject, d.account, amount, d.currency, pickNote(req.body), req.user.id,
            ]);
            const heldId = ins.rows[0].id;

            await logAction(req.user.id, ACTIONS.TRANSACTION_CREATED, MODULES.FINANCE, {
                ipAddress: req.ip, recordType: 'held_money_entries', recordId: heldId,
                newValues: { route: key, amount, currency: d.currency, subject: d.subject },
                description: `${opts.label || key} recorded and held for approval by the Treasurer or an Admin (held entry #${heldId})`,
            });

            // Tell the Treasurer(s) and Admins.
            try {
                const approvers = await query(`
                    SELECT DISTINCT u.id FROM users u
                    JOIN user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
                    JOIN roles r ON r.id = ur.role_id
                    WHERE r.name = ANY($1) AND u.is_active = TRUE AND u.id <> $2
                `, [FREE_ROLES, req.user.id]);
                const who = `${req.user.first_name || ''} ${req.user.last_name || ''}`.trim();
                const amt = amount ? ` — ${d.currency ? d.currency + ' ' : ''}${Number(amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}` : '';
                for (const a of approvers.rows) {
                    notify({
                        userId: a.id, type: 'MONEY_ENTRY_HELD',
                        title: 'Money entry waiting for your approval',
                        body: `${opts.label || key}${amt}${d.subject ? ` (${d.subject})` : ''} recorded by ${who}`,
                        link: '/money-approvals', module: 'FINANCE',
                        recordType: 'held_money_entries', recordId: heldId,
                    });
                }
            } catch (_) { /* notifications are best-effort */ }

            return res.status(202).json({
                success: true,
                message: `Sent for approval: ${opts.label || 'this entry'} will be posted once the Treasurer or an Admin approves it. No money has moved yet.`,
                data: { held: true, held_entry_id: heldId, status: 'PENDING' },
            });
        } catch (err) {
            next(err);
        }
    };
};

module.exports = { holdMoneyEntry, registry, FREE_ROLES, isFree };
