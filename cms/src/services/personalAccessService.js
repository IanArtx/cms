// ============================================================
// PERSONAL ACCESS RULES (v1.89.0)
// "the admin can limit one's individual actions like approvals or any
//  permission depite the role they hold since even directors and
//  secretaries can have different roles and limitations with in the
//  company" (13 Nov 2026).
//
// A person's access = what their roles give, adjusted by their own
// rules (user_access_rules):
//   PERMISSION_REMOVE  one permission their roles give is taken away
//   PERMISSION_ADD     one permission is given without a whole role
//   ACTION_BLOCK       one action is not allowed (approve transfers,
//                      release requisitions, sign documents …)
//   APPROVAL_LIMIT     approvals only up to an amount in one currency,
//                      and/or only on certain accounts
//   AREA_HIDE          a part of the system is hidden (menu, pages and
//                      the matching server requests)
// Each rule has a reason, a start date and an optional end date (Kampala
// dates); after the end date it simply stops applying.
//
// WHERE THE RULES BITE
//   • middleware/auth.js authenticate() — every request: the person's
//     permissions become the adjusted list (so all 270+ permission checks
//     follow it), and a request into a hidden area is refused.
//   • approvalGuard.js — every approval step (four-eyes checkpoints)
//     calls assertMayApprove() with the record's amount, currency and
//     account(s).
//   • signatureService.signSlot (documents, certificate rounds),
//     written-resolution signing, financial statements approval and the
//     choice of who signs a meeting's documents call assertActionAllowed().
// Some powers in the system come from holding a ROLE rather than a
// permission (for example only the Treasurer releases money). Those are
// limited with ACTION_BLOCK / APPROVAL_LIMIT / AREA_HIDE.
// ============================================================

const { query } = require('../config/database');
const { createError } = require('../utils/errors');

const KINDS = ['PERMISSION_REMOVE', 'PERMISSION_ADD', 'ACTION_BLOCK', 'APPROVAL_LIMIT', 'AREA_HIDE'];

// Actions that can be blocked. money: approvals that carry an amount, so
// an APPROVAL_LIMIT can apply to them.
const ACTIONS = [
    { code: 'ALL_MONEY_APPROVALS', group: 'Approvals', label: 'Every approval that involves money', money: true, limitOnly: true },
    { code: 'APPROVE_MONEY_ENTRIES', group: 'Approvals', label: 'Approve money entries waiting in "Awaiting approval"', money: true },
    { code: 'APPROVE_TRANSFERS', group: 'Approvals', label: 'Approve transfers between accounts', money: true },
    { code: 'APPROVE_REQUISITIONS', group: 'Approvals', label: 'Approve requisitions (money requests)', money: true },
    { code: 'RELEASE_REQUISITIONS', group: 'Approvals', label: 'Release the money of approved requisitions', money: true },
    { code: 'APPROVE_INVESTMENTS', group: 'Approvals', label: 'Approve investments and their closing', money: true },
    { code: 'APPROVE_LOANS', group: 'Approvals', label: 'Approve loans received and given', money: true },
    { code: 'APPROVE_GRANTS', group: 'Approvals', label: 'Approve grants', money: true },
    { code: 'APPROVE_SAVINGS', group: 'Approvals', label: 'Approve savings deposits, pool entries, handouts, conversions and fine settlements', money: true },
    { code: 'APPROVE_SERVICE_FEES', group: 'Approvals', label: 'Approve service-fee payments, advances and reimbursements', money: true },
    { code: 'APPROVE_DIVIDENDS', group: 'Approvals', label: 'Approve dividends', money: true },
    { code: 'APPROVE_SHARE_CAPITAL', group: 'Approvals', label: 'Approve share-capital changes and share-credit refunds', money: true },
    { code: 'APPROVE_CAPITAL_CALLS', group: 'Approvals', label: 'Approve pledge payments (capital calls)', money: true },
    { code: 'PARDON_PLEDGES', group: 'Approvals', label: 'Pardon pledges and waive their fines (capital calls)', money: false }, // v1.90.0
    { code: 'APPROVE_PAYMENT_ACKS', group: 'Approvals', label: 'Approve payment acknowledgements', money: true },
    { code: 'APPROVE_REVERSALS', group: 'Approvals', label: 'Approve reversal requests', money: false },
    { code: 'APPROVE_FX_RATES', group: 'Approvals', label: 'Approve exchange rates', money: false },
    { code: 'APPROVE_TAX', group: 'Approvals', label: 'Approve a tax year', money: false },
    { code: 'APPROVE_DOCUMENTS', group: 'Approvals', label: 'Approve documents', money: false },
    { code: 'APPROVE_EVENTS', group: 'Approvals', label: 'Approve events', money: false },
    { code: 'SIGN_DOCUMENTS', group: 'Signing', label: 'Sign documents (minutes, notices, registers, resolutions, receipts…) and be chosen to sign a meeting’s documents', money: false },
    { code: 'SIGN_RESOLUTIONS', group: 'Signing', label: 'Sign written resolutions', money: false },
    { code: 'SIGN_CERTIFICATES', group: 'Signing', label: 'Sign share certificates', money: false },
    { code: 'APPROVE_FINANCIAL_STATEMENTS', group: 'Signing', label: 'Approve and sign the annual financial statements', money: false },
];
const ACTION_BY_CODE = new Map(ACTIONS.map(a => [a.code, a]));

// Parts of the system that can be hidden — the ids are the menu's page
// ids (navConfig.js), so the frontend hides the same thing.
const AREAS = [
    { code: 'accounts', label: 'Accounts', api: ['/api/accounts'] },
    { code: 'transactions', label: 'Transactions', api: ['/api/transactions'] },
    { code: 'transfers', label: 'Transfers', api: ['/api/transfers'] },
    { code: 'requisitions', label: 'Requisitions', api: ['/api/requisitions'] },
    { code: 'money-approvals', label: 'Awaiting approval', api: ['/api/money-approvals'] },
    { code: 'savings', label: 'Savings', api: ['/api/savings'] },
    { code: 'side-fund', label: 'Side fund', api: ['/api/side-fund'] },
    { code: 'deposits', label: 'Deposits', api: ['/api/deposits'] },
    { code: 'fines', label: 'Fines', api: ['/api/fines'] },
    { code: 'share-capital', label: 'Share capital', api: ['/api/share-capital'] },
    { code: 'dividends', label: 'Dividends', api: ['/api/dividends'] },
    { code: 'capital-goals', label: 'Capital goals', api: ['/api/capital-goals'] },
    { code: 'portfolio', label: 'Investments portfolio (and money market funds)', api: ['/api/investments', '/api/mmf'] },
    { code: 'projects', label: 'Projects', api: ['/api/projects'] },
    { code: 'loans', label: 'Loans', api: ['/api/loans'] },
    { code: 'grants', label: 'Grants', api: ['/api/grants'] },
    { code: 'tax', label: 'Tax', api: ['/api/tax'] },
    { code: 'reports', label: 'Reports & ledger (incl. financial statements)', api: ['/api/reports'] },
    { code: 'events', label: 'Events', api: ['/api/events'] },
    { code: 'meetings', label: 'Meetings & resolutions', api: ['/api/meetings'] },
    { code: 'documents', label: 'Documents', api: ['/api/documents'] },
    { code: 'service-fees', label: 'Service fees', api: ['/api/service-fees'] },
    { code: 'members', label: 'Members (other people’s details, roles, access)', api: ['/api/users', '/api/member-register', '/api/access'] },
    { code: 'settings', label: 'Settings', api: ['/api/settings', '/api/email-settings'] },
];
const AREA_BY_CODE = new Map(AREAS.map(a => [a.code, a]));

// A hidden area still lets the person reach their OWN things there (their
// profile, savings, pledges, requests …) and the shared lookups every page
// needs (the people picker, company settings for letterheads).
const OWN_SEGMENT = /^(me|my|mine|my-[a-z0-9-]+|my[A-Z][A-Za-z]*)$/;
const ALWAYS_ALLOWED = [
    { method: 'GET', re: /^\/api\/users\/(directory|roles|shareholding)(\/|$)/ },
    { method: 'GET', re: /^\/api\/settings(\/|$)/ },
    { method: 'GET', re: /^\/api\/documents\/pending-signatures(\/|$)/ },
];

const kampalaToday = () => new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);

let ready = null;
const tableReady = async () => {
    if (ready) return true;
    const r = await query("SELECT to_regclass('public.user_access_rules') IS NOT NULL AS ok");
    ready = !!r.rows[0].ok;
    return ready;
};

const toDateStr = (d) => (d ? (typeof d === 'string' ? d.slice(0, 10) : new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)) : null);

const ACTIVE_SQL = `ended_at IS NULL AND starts_on <= $2::date AND (ends_on IS NULL OR ends_on >= $2::date)`;

// The rules that apply to a person today.
const activeRules = async (userId) => {
    if (!(await tableReady())) return [];
    const r = await query(`SELECT * FROM user_access_rules WHERE user_id = $1 AND ${ACTIVE_SQL} ORDER BY id`, [userId, kampalaToday()]);
    return r.rows;
};

// Called by authenticate(): adjusts req.user.permissions and attaches a
// summary the frontend uses to hide menus and pages.
const applyToUser = async (user) => {
    const rules = await activeRules(user.id);
    const fromRoles = Array.isArray(user.permissions) ? user.permissions : [];
    const removed = rules.filter(r => r.kind === 'PERMISSION_REMOVE').map(r => r.permission_code);
    const added = rules.filter(r => r.kind === 'PERMISSION_ADD').map(r => r.permission_code);
    const perms = new Set(fromRoles);
    removed.forEach(p => perms.delete(p));
    added.forEach(p => perms.add(p));
    user.permissions = Array.from(perms).sort();
    user.access = {
        rules_count: rules.length,
        removed_permissions: removed,
        added_permissions: added,
        blocked_actions: rules.filter(r => r.kind === 'ACTION_BLOCK').map(r => r.action_code),
        approval_limits: rules.filter(r => r.kind === 'APPROVAL_LIMIT').map(r => ({
            action: r.action_code, currency_code: r.currency_code, max_amount: r.max_amount === null ? null : Number(r.max_amount),
            account_ids: r.account_ids || [], ends_on: toDateStr(r.ends_on),
        })),
        hidden_areas: rules.filter(r => r.kind === 'AREA_HIDE').map(r => r.area_code),
    };
    return user;
};

// Refuses a request into an area hidden from this person.
const assertAreaAllowed = (user, method, originalUrl) => {
    const hidden = (user.access && user.access.hidden_areas) || [];
    if (!hidden.length) return;
    const path = String(originalUrl || '').split('?')[0];
    if (ALWAYS_ALLOWED.some(a => a.method === method && a.re.test(path))) return;
    for (const code of hidden) {
        const area = AREA_BY_CODE.get(code);
        if (!area) continue;
        const prefix = area.api.find(p => path === p || path.startsWith(`${p}/`));
        if (!prefix) continue;
        const rest = path.slice(prefix.length).split('/').filter(Boolean);
        if (rest.some(seg => OWN_SEGMENT.test(seg))) return; // their own things
        const e = createError.forbidden(`${area.label} is not available to you — an Admin has limited your access to it.`);
        e.error = 'AREA_HIDDEN';
        throw e;
    }
};

// Throws when the person may not do this action today.
const assertActionAllowed = async (userId, action, label = null) => {
    const rules = await activeRules(userId);
    const block = rules.find(r => r.kind === 'ACTION_BLOCK' && r.action_code === action);
    if (block) {
        const a = ACTION_BY_CODE.get(action);
        throw createError.forbidden(`You may not ${label || (a ? a.label.charAt(0).toLowerCase() + a.label.slice(1) : action.toLowerCase())} — an Admin has limited this for you${block.ends_on ? ` until ${toDateStr(block.ends_on)}` : ''}. Reason: ${block.reason}`);
    }
    return rules;
};

const fmtAmount = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });

// Throws when the person may not approve this record: the action is
// blocked, or an approval limit (amount per currency / accounts) is
// exceeded. amount/currency/accountIds may be unknown (null) — a limit
// that cannot be checked does not block.
const assertMayApprove = async (userId, action, { amount = null, currency = null, accountIds = [], label = 'item' } = {}) => {
    if (!action || !(await tableReady())) return;
    const rules = await assertActionAllowed(userId, action, `approve this ${label}`);
    const money = ACTION_BY_CODE.get(action)?.money;
    if (!money) return;
    const limits = rules.filter(r => r.kind === 'APPROVAL_LIMIT' && (r.action_code === action || r.action_code === 'ALL_MONEY_APPROVALS'));
    for (const r of limits) {
        if (r.max_amount !== null && r.currency_code && amount !== null && amount !== undefined && currency
            && String(currency).toUpperCase() === r.currency_code && Number(amount) > Number(r.max_amount) + 1e-9) {
            throw createError.forbidden(`This ${label} is ${r.currency_code} ${fmtAmount(amount)}; you may approve up to ${r.currency_code} ${fmtAmount(r.max_amount)}. Someone else must approve it. (Limit set by an Admin: ${r.reason})`);
        }
        const allowed = (r.account_ids || []).map(Number);
        const ids = (accountIds || []).filter(x => x !== null && x !== undefined).map(Number);
        if (allowed.length && ids.length && ids.some(id => !allowed.includes(id))) {
            const names = await query('SELECT name FROM accounts WHERE id = ANY($1::int[]) ORDER BY name', [allowed]);
            throw createError.forbidden(`You may approve only on ${names.rows.map(x => x.name).join(', ')}; this ${label} uses another account. Someone else must approve it. (Limit set by an Admin: ${r.reason})`);
        }
    }
};

// What each approval checkpoint (approvalGuard) is, and how to read the
// record's amount, currency and account(s). Tables and SQL are fixed
// strings in code, never from a request.
const CUR = (col) => `(SELECT code FROM currencies WHERE id = ${col})`;
const APPROVAL_TABLES = {
    payment_acknowledgements: { action: 'APPROVE_PAYMENT_ACKS', sql: `SELECT amount, ${CUR('currency_id')} AS currency, ARRAY[]::int[] AS accounts FROM payment_acknowledgements WHERE id = $1` },
    documents: { action: 'APPROVE_DOCUMENTS' },
    requisitions: { action: 'APPROVE_REQUISITIONS', sql: `SELECT COALESCE(amount_approved, amount_requested) AS amount, ${CUR('currency_id')} AS currency, ARRAY[account_id] AS accounts FROM requisitions WHERE id = $1` },
    capital_goal_pledges: { action: 'APPROVE_CAPITAL_CALLS' },
    savings_fine_settlements: { action: 'APPROVE_SAVINGS', sql: `SELECT total_amount AS amount, ${CUR('currency_id')} AS currency, ARRAY[account_id, destination_account_id] AS accounts FROM savings_fine_settlements WHERE id = $1` },
    events: { action: 'APPROVE_EVENTS' },
    grants: { action: 'APPROVE_GRANTS', sql: `SELECT total_amount AS amount, ${CUR('currency_id')} AS currency, ARRAY[account_id] AS accounts FROM grants WHERE id = $1` },
    investments: { action: 'APPROVE_INVESTMENTS', sql: `SELECT planned_budget AS amount, ${CUR('currency_id')} AS currency, ARRAY[funding_account_id] AS accounts FROM investments WHERE id = $1` },
    member_savings: { action: 'APPROVE_SAVINGS', sql: `SELECT principal_amount AS amount, ${CUR('currency_id')} AS currency, ARRAY[account_id] AS accounts FROM member_savings WHERE id = $1` },
    savings_pool_inflows: { action: 'APPROVE_SAVINGS', sql: `SELECT amount, ${CUR('currency_id')} AS currency, ARRAY[account_id] AS accounts FROM savings_pool_inflows WHERE id = $1` },
    transfers: { action: 'APPROVE_TRANSFERS', sql: `SELECT amount_sent AS amount, ${CUR('currency_sent_id')} AS currency, ARRAY[from_account_id, to_account_id] AS accounts FROM transfers WHERE id = $1` },
    service_fee_payment_requests: { action: 'APPROVE_SERVICE_FEES', sql: `SELECT a.monthly_amount AS amount, ${CUR('a.currency_id')} AS currency, ARRAY[a.account_id] AS accounts FROM service_fee_payment_requests x JOIN service_fee_agreements a ON a.id = x.agreement_id WHERE x.id = $1` },
    service_fee_advances: { action: 'APPROVE_SERVICE_FEES', sql: `SELECT x.amount, ${CUR('a.currency_id')} AS currency, ARRAY[a.account_id] AS accounts FROM service_fee_advances x JOIN service_fee_agreements a ON a.id = x.agreement_id WHERE x.id = $1` },
    service_reimbursement_requests: { action: 'APPROVE_SERVICE_FEES', sql: `SELECT amount, ${CUR('currency_id')} AS currency, ARRAY[account_id] AS accounts FROM service_reimbursement_requests WHERE id = $1` },
    dividends: { action: 'APPROVE_DIVIDENDS', sql: `SELECT total_amount AS amount, ${CUR('currency_id')} AS currency, ARRAY[account_id] AS accounts FROM dividends WHERE id = $1` },
    loans_received: { action: 'APPROVE_LOANS', sql: `SELECT principal_amount AS amount, ${CUR('currency_id')} AS currency, ARRAY[account_id] AS accounts FROM loans_received WHERE id = $1` },
    loans_given: { action: 'APPROVE_LOANS', sql: `SELECT principal_amount AS amount, ${CUR('currency_id')} AS currency, ARRAY[account_id] AS accounts FROM loans_given WHERE id = $1` },
    capital_credit_refunds: { action: 'APPROVE_SHARE_CAPITAL', sql: `SELECT payout_amount AS amount, ${CUR('payout_currency_id')} AS currency, ARRAY[account_id] AS accounts FROM capital_credit_refunds WHERE id = $1` },
};

// For approvalGuard.assertNotOwnRecord(table, id).
const assertMayApproveRecord = async (userId, table, id, label, client = null) => {
    const spec = APPROVAL_TABLES[table];
    if (!spec || !(await tableReady())) return;
    let ctx = { label };
    if (spec.sql) {
        try {
            const r = await (client || { query }).query(spec.sql, [id]);
            if (r.rows[0]) ctx = { label, amount: r.rows[0].amount, currency: r.rows[0].currency, accountIds: (r.rows[0].accounts || []).filter(Boolean) };
        } catch (_) { /* a column missing on an older database — fall back to the action check */ }
    }
    await assertMayApprove(userId, spec.action, ctx);
};

// ------------------------------------------------------------
// Managing the rules (Admin)
// ------------------------------------------------------------
const listPermissions = async () => (await query('SELECT code, module, description FROM permissions ORDER BY module, code')).rows;

const rolePermissionsOf = async (userId) => (await query(`
    SELECT p.code, string_agg(DISTINCT r.name, ', ' ORDER BY r.name) AS via
    FROM   user_roles ur JOIN roles r ON r.id = ur.role_id AND r.is_active = TRUE
    JOIN   role_permissions rp ON rp.role_id = r.id JOIN permissions p ON p.id = rp.permission_id
    WHERE  ur.user_id = $1 AND ur.revoked_at IS NULL GROUP BY p.code ORDER BY p.code`, [userId])).rows;

const ruleRows = async (where, params, runner = { query }) => (await runner.query(`
    SELECT x.*, u.first_name || ' ' || u.last_name AS user_name,
           cb.first_name || ' ' || cb.last_name AS created_by_name,
           eb.first_name || ' ' || eb.last_name AS ended_by_name,
           (SELECT array_agg(a.name ORDER BY a.name) FROM accounts a WHERE a.id = ANY(x.account_ids)) AS account_names
    FROM   user_access_rules x JOIN users u ON u.id = x.user_id
    LEFT   JOIN users cb ON cb.id = x.created_by LEFT JOIN users eb ON eb.id = x.ended_by
    WHERE  ${where} ORDER BY x.ended_at NULLS FIRST, x.created_at DESC`, params)).rows;

const stateOf = (r, today) => {
    if (r.ended_at) return 'ENDED';
    const s = toDateStr(r.starts_on); const e = toDateStr(r.ends_on);
    if (s > today) return 'SCHEDULED';
    if (e && e < today) return 'EXPIRED';
    return 'ACTIVE';
};
const describe = (r) => {
    const a = ACTION_BY_CODE.get(r.action_code);
    switch (r.kind) {
    case 'PERMISSION_REMOVE': return `Cannot: ${r.permission_code}`;
    case 'PERMISSION_ADD': return `Also allowed: ${r.permission_code}`;
    case 'ACTION_BLOCK': return `Blocked: ${a ? a.label : r.action_code}`;
    case 'AREA_HIDE': return `Hidden: ${(AREA_BY_CODE.get(r.area_code) || {}).label || r.area_code}`;
    case 'APPROVAL_LIMIT': {
        const parts = [];
        if (r.max_amount !== null && r.currency_code) parts.push(`up to ${r.currency_code} ${fmtAmount(r.max_amount)}`);
        if (r.account_names && r.account_names.length) parts.push(`only on ${r.account_names.join(', ')}`);
        return `${a ? a.label : r.action_code}: ${parts.join(', ')}`;
    }
    default: return r.kind;
    }
};
const present = (rows) => {
    const today = kampalaToday();
    return rows.map(r => ({
        ...r, starts_on: toDateStr(r.starts_on), ends_on: toDateStr(r.ends_on),
        max_amount: r.max_amount === null ? null : Number(r.max_amount),
        state: stateOf(r, today), summary: describe(r),
    }));
};

const userView = async (userId) => {
    const u = await query(`
        SELECT u.id, u.first_name || ' ' || u.last_name AS name, u.email, u.is_active,
               COALESCE(array_agg(DISTINCT r.name) FILTER (WHERE r.name IS NOT NULL), '{}') AS roles
        FROM users u LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
        LEFT JOIN roles r ON r.id = ur.role_id AND r.is_active = TRUE WHERE u.id = $1 GROUP BY u.id`, [userId]);
    if (!u.rows.length) throw createError.notFound('Person not found.');
    const [fromRoles, permissions, rules, accounts, currencies] = await Promise.all([
        rolePermissionsOf(userId), listPermissions(),
        (await tableReady()) ? ruleRows('x.user_id = $1', [userId]) : Promise.resolve([]),
        query('SELECT a.id, a.name, c.code AS currency_code FROM accounts a JOIN currencies c ON c.id = a.currency_id ORDER BY a.name').then(r => r.rows),
        query('SELECT code FROM currencies WHERE is_active IS NOT FALSE ORDER BY code').then(r => r.rows.map(x => x.code)).catch(() => []),
    ]);
    const presented = present(rules);
    const active = presented.filter(r => r.state === 'ACTIVE');
    const removed = new Set(active.filter(r => r.kind === 'PERMISSION_REMOVE').map(r => r.permission_code));
    const added = new Set(active.filter(r => r.kind === 'PERMISSION_ADD').map(r => r.permission_code));
    const via = new Map(fromRoles.map(p => [p.code, p.via]));
    return {
        ready: await tableReady(),
        person: u.rows[0],
        permissions: permissions.map(p => ({
            ...p, from_roles: via.get(p.code) || null,
            removed: removed.has(p.code), added: added.has(p.code),
            effective: (via.has(p.code) && !removed.has(p.code)) || added.has(p.code),
        })),
        rules: presented,
        catalogue: { kinds: KINDS, actions: ACTIONS, areas: AREAS.map(a => ({ code: a.code, label: a.label })), accounts, currencies },
    };
};

const overview = async () => {
    if (!(await tableReady())) return { ready: false, people: [] };
    const rows = present(await ruleRows("x.ended_at IS NULL AND (x.ends_on IS NULL OR x.ends_on >= $1::date)", [kampalaToday()]));
    const people = new Map();
    for (const r of rows) {
        if (!people.has(r.user_id)) people.set(r.user_id, { user_id: r.user_id, name: r.user_name, rules: [] });
        people.get(r.user_id).rules.push({ id: r.id, kind: r.kind, state: r.state, summary: r.summary, ends_on: r.ends_on, starts_on: r.starts_on });
    }
    return { ready: true, people: Array.from(people.values()).sort((a, b) => a.name.localeCompare(b.name)) };
};

// The Admin role's essential areas: at least one Admin must keep them.
const ADMIN_ESSENTIAL_AREAS = ['members', 'settings'];
const ADMIN_ESSENTIAL_PERMISSIONS = ['ROLE_ASSIGN', 'USER_MANAGE', 'SYSTEM_CONFIG'];

const validateRule = async (actorId, userId, body) => {
    if (Number(actorId) === Number(userId)) throw createError.forbidden('You cannot set access rules on your own account — another Admin must do it.');
    const kind = String(body.kind || '');
    if (!KINDS.includes(kind)) throw createError.badRequest('Choose what kind of rule this is.');
    const reason = String(body.reason || '').trim();
    if (reason.length < 5) throw createError.badRequest('Give the reason (at least 5 characters) — it is shown to the person and kept in the history.');
    const today = kampalaToday();
    const startsOn = body.starts_on ? String(body.starts_on).slice(0, 10) : today;
    const endsOn = body.ends_on ? String(body.ends_on).slice(0, 10) : null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startsOn) || (endsOn && !/^\d{4}-\d{2}-\d{2}$/.test(endsOn))) throw createError.badRequest('Dates must be YYYY-MM-DD.');
    if (endsOn && endsOn < startsOn) throw createError.badRequest('The end date cannot be before the start date.');
    if (endsOn && endsOn < today) throw createError.badRequest('The end date has already passed.');
    const rule = { kind, reason: reason.slice(0, 1000), starts_on: startsOn, ends_on: endsOn, permission_code: null, action_code: null, area_code: null, currency_code: null, max_amount: null, account_ids: null };

    const person = await userView(userId);
    const isAdminTarget = person.person.roles.includes('Admin');
    if (kind === 'PERMISSION_REMOVE' || kind === 'PERMISSION_ADD') {
        const p = person.permissions.find(x => x.code === body.permission_code);
        if (!p) throw createError.badRequest('Choose a permission.');
        if (kind === 'PERMISSION_REMOVE' && !p.from_roles) throw createError.badRequest(`${p.code} is not given by this person's roles, so there is nothing to take away.`);
        if (kind === 'PERMISSION_ADD' && p.from_roles) throw createError.badRequest(`${p.code} is already given by this person's roles (${p.from_roles}).`);
        rule.permission_code = p.code;
        if (kind === 'PERMISSION_REMOVE' && isAdminTarget && ADMIN_ESSENTIAL_PERMISSIONS.includes(p.code)) await assertAnotherFullAdmin(userId, { permission: p.code });
    } else if (kind === 'ACTION_BLOCK' || kind === 'APPROVAL_LIMIT') {
        const a = ACTION_BY_CODE.get(body.action_code);
        if (!a) throw createError.badRequest('Choose the action.');
        if (kind === 'ACTION_BLOCK' && a.limitOnly) throw createError.badRequest('To block every approval, block each kind of approval, or set an approval limit of 0.');
        if (kind === 'APPROVAL_LIMIT' && !a.money) throw createError.badRequest(`"${a.label}" has no amount, so it can only be blocked, not limited.`);
        rule.action_code = a.code;
        if (kind === 'APPROVAL_LIMIT') {
            const hasAmount = body.max_amount !== undefined && body.max_amount !== null && body.max_amount !== '';
            if (hasAmount) {
                const amt = Number(body.max_amount);
                if (!Number.isFinite(amt) || amt < 0) throw createError.badRequest('The most they may approve must be 0 or more.');
                const cur = String(body.currency_code || '').toUpperCase();
                if (!/^[A-Z]{3}$/.test(cur)) throw createError.badRequest('Choose the currency of the limit.');
                rule.max_amount = Math.round(amt * 100) / 100; rule.currency_code = cur;
            }
            const ids = Array.isArray(body.account_ids) ? body.account_ids.map(Number).filter(Number.isInteger) : [];
            if (ids.length) {
                const ok = await query('SELECT id FROM accounts WHERE id = ANY($1::int[])', [ids]);
                if (ok.rows.length !== new Set(ids).size) throw createError.badRequest('One of the accounts chosen does not exist.');
                rule.account_ids = Array.from(new Set(ids));
            }
            if (!hasAmount && !ids.length) throw createError.badRequest('Set an amount (with its currency), choose the accounts, or both.');
        }
    } else if (kind === 'AREA_HIDE') {
        const area = AREA_BY_CODE.get(body.area_code);
        if (!area) throw createError.badRequest('Choose the part of the system to hide.');
        rule.area_code = area.code;
        if (isAdminTarget && ADMIN_ESSENTIAL_AREAS.includes(area.code)) await assertAnotherFullAdmin(userId, { area: area.code });
    }
    return rule;
};

// At least one OTHER active Admin must keep the essentials.
const assertAnotherFullAdmin = async (exceptUserId, { permission = null, area = null }) => {
    const admins = await query(`
        SELECT DISTINCT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
        JOIN roles r ON r.id = ur.role_id AND r.name = 'Admin' WHERE u.is_active = TRUE AND u.id <> $1`, [exceptUserId]);
    for (const a of admins.rows) {
        const rules = await activeRules(a.id);
        const lacks = rules.some(r => (permission && r.kind === 'PERMISSION_REMOVE' && r.permission_code === permission)
            || (area && r.kind === 'AREA_HIDE' && r.area_code === area));
        if (!lacks) return;
    }
    throw createError.conflict('At least one other Admin must keep full access to members, roles and settings — this would leave nobody able to manage the system.');
};

const addRule = async (actorId, userId, body, client) => {
    const r = await validateRule(actorId, userId, body);
    const dup = await client.query(`
        SELECT id FROM user_access_rules WHERE user_id = $1 AND kind = $2 AND ended_at IS NULL
          AND COALESCE(permission_code, '') = COALESCE($3, '') AND COALESCE(action_code, '') = COALESCE($4, '') AND COALESCE(area_code, '') = COALESCE($5, '')
          AND COALESCE(currency_code, '') = COALESCE($6, '')
          AND (ends_on IS NULL OR ends_on >= $7::date)`, [userId, r.kind, r.permission_code, r.action_code, r.area_code, r.currency_code, kampalaToday()]);
    if (dup.rows.length && r.kind !== 'APPROVAL_LIMIT') throw createError.conflict('This person already has the same rule — end it first if you want to change it.');
    if (dup.rows.length && r.kind === 'APPROVAL_LIMIT') throw createError.conflict('This person already has a limit for this action and currency — end it first, then add the new one.');
    const ins = await client.query(`
        INSERT INTO user_access_rules (user_id, kind, permission_code, action_code, area_code, currency_code, max_amount, account_ids,
            reason, starts_on, ends_on, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [userId, r.kind, r.permission_code, r.action_code, r.area_code, r.currency_code, r.max_amount, r.account_ids,
        r.reason, r.starts_on, r.ends_on, actorId]);
    return present(await ruleRows('x.id = $1', [ins.rows[0].id], client))[0];
};

const endRule = async (actorId, userId, ruleId, reason, client) => {
    if (Number(actorId) === Number(userId)) throw createError.forbidden('You cannot change access rules on your own account — another Admin must do it.');
    const why = String(reason || '').trim();
    if (why.length < 5) throw createError.badRequest('Give the reason for ending this rule (at least 5 characters).');
    const r = await client.query(`
        UPDATE user_access_rules SET ended_at = NOW(), ended_by = $3, end_reason = $4
        WHERE id = $1 AND user_id = $2 AND ended_at IS NULL RETURNING *`, [ruleId, userId, actorId, why.slice(0, 1000)]);
    if (!r.rows.length) throw createError.notFound('That rule is not active.');
    return present(await ruleRows('x.id = $1', [ruleId], client))[0];
};

// The person's own view (My Profile).
const myView = async (userId) => {
    if (!(await tableReady())) return { ready: false, rules: [] };
    const rows = present(await ruleRows("x.user_id = $1 AND x.ended_at IS NULL AND (x.ends_on IS NULL OR x.ends_on >= $2::date)", [userId, kampalaToday()]));
    return { ready: true, rules: rows.map(r => ({ id: r.id, kind: r.kind, state: r.state, summary: r.summary, reason: r.reason, starts_on: r.starts_on, ends_on: r.ends_on })) };
};

module.exports = {
    KINDS, ACTIONS, AREAS, tableReady, activeRules, applyToUser, assertAreaAllowed,
    assertActionAllowed, assertMayApprove, assertMayApproveRecord, userView, overview, addRule, endRule, myView, kampalaToday,
};
