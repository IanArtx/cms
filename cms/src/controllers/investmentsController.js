// ============================================================
// INVESTMENTS & PROJECTS CONTROLLER
// Handles investment portfolio tracking and project management.
//
// RULES ENFORCED HERE:
//   - Investments are always funded from secondary accounts
//   - Returns always go back to the funding source account
//   - Returns are always in the same currency as the investment
//   - Projects belong to investments
//   - Budget tracking at both investment and project level
//   - Milestones tracked per project
// ============================================================

const { query, withTransaction } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess, sendCreated, sendPaginated, getPagination } = require('../utils/response');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');
const capitalGoalFunds = require('../services/capitalGoalFundsService'); // v1.78.0
const { generateReference, linkReferenceToRecord, MODULE_CODES, resolveModuleCode } = require('../services/referenceService');
const { postTransaction } = require('./transactionsController');
const { generateBondCouponSchedule } = require('../utils/bondSchedule');
const { notify } = require('../services/notificationService');
const { wrapEmail } = require('../services/emailTemplates');
const taxService = require('../services/taxService');
const { assertNotOwnRecord } = require('../services/approvalGuard'); // v1.72.0
const investmentCost = require('../services/investmentCostService'); // v1.80.0 — buying vs running

// ============================================================
// v1.40.0 SHARED HELPERS
// ============================================================

// Statuses in which returns/expenses can still be recorded against an
// investment — normal operation (ACTIVE) plus the termination review
// window (PENDING_TERMINATION), so the responsible person can catch up
// any missing entries before confirming records are up to date.
const MUTABLE_INVESTMENT_STATUSES = ['ACTIVE', 'PENDING_TERMINATION'];

// Every time actual_expenditure grows (capital funding, or an
// operational EXPENSE/TAX entry), figure out how much of THIS increase
// falls beyond planned_budget and should be logged as supplementary
// budget. Handles partial overage correctly (e.g. spend that's half
// within budget, half beyond it) and works whether the investment was
// already over budget or not. Returns the new expenditure total and
// the supplementary delta to add — callers do the actual UPDATE
// themselves (they usually already hold a FOR UPDATE lock on the row).
function computeSupplementaryOverage(plannedBudget, currentExpenditure, amount) {
    const planned    = parseFloat(plannedBudget);
    const before      = parseFloat(currentExpenditure);
    const newExpenditure = before + parseFloat(amount);
    const overageBefore  = Math.max(0, before - planned);
    const overageAfter   = Math.max(0, newExpenditure - planned);
    return {
        newExpenditure,
        supplementaryDelta: overageAfter - overageBefore,
    };
}

function round2(n) {
    return Math.round((parseFloat(n) + Number.EPSILON) * 100) / 100;
}

// v1.70.0 — a DATE column (read by pg as local midnight) as 'YYYY-MM-DD',
// without the one-day shift toISOString() gives on a server ahead of UTC.
function dateOnly(d) {
    if (!d) return null;
    if (typeof d === 'string') return d.slice(0, 10);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ============================================================
// CREATE INVESTMENT
// POST /api/investments
// ============================================================
const createInvestment = asyncHandler(async (req, res) => {
    const {
        name,
        description,
        category_id,
        funding_account_id,
        planned_budget,
        start_date,
        expected_end_date,
        responsible_user_id,
        investment_type,
        face_value,
        coupon_rate,
        coupon_frequency,
        tax_withholding_rate,
        first_coupon_date,
        settlement_value,
        bond_term_years,
        tbill_tax_timing,
    } = req.body;

    const isBond = investment_type === 'BOND';
    // v1.70.0 — a treasury bill: bought below its face value (the
    // settlement value is the price paid), repaid at face value on the
    // maturity date; the difference (the discount) is interest income,
    // taxed as FINAL tax (20% for bills) — either added to the purchase
    // price (AT_PURCHASE) or deducted from the maturity proceeds.
    const isTbill = investment_type === 'TREASURY_BILL';
    if (isTbill) {
        if (!face_value || face_value <= 0) throw createError.badRequest('A treasury bill needs its face value (what is repaid at maturity)');
        if (!settlement_value || settlement_value <= 0) throw createError.badRequest('A treasury bill needs its settlement value (the price paid, before any tax)');
        if (parseFloat(settlement_value) >= parseFloat(face_value)) throw createError.badRequest('The price paid for a treasury bill must be below its face value');
        if (!start_date || !expected_end_date) throw createError.badRequest('A treasury bill needs its purchase (issue) date and maturity date');
        if (tbill_tax_timing && !['AT_MATURITY', 'AT_PURCHASE'].includes(tbill_tax_timing)) throw createError.badRequest('Tax timing must be AT_MATURITY or AT_PURCHASE');
    }

    // v1.60.0 — how bonds are actually categorised when bought (2/3/5/
    // 10/15/20/25yr). Also enforced by the DB's CHECK constraint on
    // the column itself (once set, it can only ever be one of these
    // seven values or NULL) — required here specifically so every NEW
    // bond always carries one, while a legacy bond backfilled by
    // migration_v1.60.0.sql can still sit at NULL pending manual
    // review (see the "Set Term" action on the investment's own page).
    const BOND_TERMS = [2, 3, 5, 10, 15, 20, 25];

    if (isBond) {
        // These are also enforced by the DB's bond_fields_required
        // check constraint, but checking here first gives a much
        // friendlier error message than a raw Postgres error.
        if (!face_value || face_value <= 0) {
            throw createError.badRequest('Bond investments require a face value greater than zero');
        }
        if (coupon_rate === undefined || coupon_rate === null || coupon_rate < 0) {
            throw createError.badRequest('Bond investments require an interest (coupon) rate');
        }
        if (!coupon_frequency) {
            throw createError.badRequest('Bond investments require a coupon payment frequency');
        }
        if (!start_date || !expected_end_date) {
            throw createError.badRequest('Bond investments require both an issue date and a maturity date');
        }
        if (!BOND_TERMS.includes(parseInt(bond_term_years))) {
            throw createError.badRequest(
                `Bond investments require a term — one of: ${BOND_TERMS.map(t => t + 'yr').join(', ')}`
            );
        }
    }

    await withTransaction(async (client) => {
        // Verify funding account exists and is secondary
        const account = await client.query(`
            SELECT id, account_type, currency_id, name
            FROM   accounts
            WHERE  id = $1 AND is_active = TRUE
        `, [funding_account_id]);

        if (account.rows.length === 0) {
            throw createError.notFound('Funding account not found');
        }
        if (account.rows[0].account_type !== 'SECONDARY') {
            throw createError.badRequest(
                'Investments must be funded from a secondary operational account'
            );
        }

        // Generate investment reference: INV-INVEST-YYYYMM-00001
        const { referenceId, referenceCode } = await generateReference(
            client,
            MODULE_CODES.INVESTMENT,
            'INVEST',
            'INVESTMENT',
            req.user.id
        );

        // Create investment record
        const result = await client.query(`
            INSERT INTO investments (
                reference_id,
                name,
                description,
                category_id,
                funding_account_id,
                currency_id,
                planned_budget,
                actual_expenditure,
                returns_account_id,
                total_returns,
                status,
                start_date,
                expected_end_date,
                responsible_user_id,
                created_by,
                investment_type,
                face_value,
                coupon_rate,
                coupon_frequency,
                tax_withholding_rate,
                first_coupon_date,
                settlement_value,
                bond_term_years
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, 0, $5, 0,
                'PENDING', $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19
            )
            RETURNING id
        `, [
            referenceId,
            name.trim(),
            description || null,
            category_id,
            funding_account_id,
            account.rows[0].currency_id,
            planned_budget,
            start_date || null,
            expected_end_date || null,
            responsible_user_id || null,
            req.user.id,
            investment_type || 'STANDARD',
            (isBond || isTbill) ? face_value : null,
            isBond ? coupon_rate : null,
            isBond ? coupon_frequency : null,
            isBond ? (tax_withholding_rate || 0)
                : isTbill ? (tax_withholding_rate !== undefined && tax_withholding_rate !== null && tax_withholding_rate !== ''
                    ? tax_withholding_rate : (await taxService.getRateOn(client, 'WHT_GOV_SECURITIES_SHORT', start_date)).rate)
                : 0,
            isBond ? (first_coupon_date || null) : null,
            (isBond || isTbill) ? (settlement_value || null) : null,
            isBond ? parseInt(bond_term_years) : null,
        ]);

        const investmentId = result.rows[0].id;
        await linkReferenceToRecord(client, referenceId, investmentId);
        if (isTbill) {
            await client.query(`UPDATE investments SET tbill_tax_timing = $1 WHERE id = $2`,
                [tbill_tax_timing || 'AT_MATURITY', investmentId]);
        }

        // Bonds get their full coupon (interest payment) schedule
        // generated up front, so the detail page can show expected
        // payment dates and yield before any money has moved.
        if (isBond) {
            const schedule = generateBondCouponSchedule({
                faceValue:           face_value,
                couponRate:          coupon_rate,
                frequency:           coupon_frequency,
                taxWithholdingRate:  tax_withholding_rate || 0,
                issueDate:           start_date,
                maturityDate:        expected_end_date,
                // For a bond the company bought after it was already
                // running, the next coupon date is fixed by the
                // issuer's own schedule, not `frequency` after our
                // start_date — pass it through when supplied.
                firstCouponDate:     first_coupon_date || null,
            });

            for (const coupon of schedule) {
                await client.query(`
                    INSERT INTO bond_coupons (
                        investment_id, coupon_number, due_date,
                        gross_amount, tax_amount, net_amount
                    ) VALUES ($1, $2, $3, $4, $5, $6)
                `, [
                    investmentId, coupon.coupon_number, coupon.due_date,
                    coupon.gross_amount, coupon.tax_amount, coupon.net_amount,
                ]);
            }
        }

        // Create approval workflow
        await client.query(`
            INSERT INTO approval_workflows (
                workflow_type, record_type, record_id,
                required_approvals, initiated_by
            ) VALUES ('INVESTMENT', 'investments', $1, 1, $2)
        `, [investmentId, req.user.id]);

        await logAction(req.user.id, ACTIONS.INVESTMENT_CREATED, MODULES.INVESTMENTS, {
            ipAddress:   req.ip,
            recordType:  'investments',
            recordId:    investmentId,
            newValues:   { referenceCode, name, planned_budget, funding_account_id, investment_type: investment_type || 'STANDARD' },
            description: `Investment created: ${referenceCode} — ${name}`,
            client,
        });

        sendCreated(res, {
            investment_id: investmentId,
            reference:     referenceCode,
            name,
            planned_budget,
            funding_account: account.rows[0].name,
            status:        'PENDING',
        }, `Investment created. Reference: ${referenceCode}`);
    });
});

// ============================================================
// EDIT INVESTMENT (before approval)
// PATCH /api/investments/:id
// Only while still PENDING. Editable by whoever created it, or
// anyone who could approve it. For a bond, if any field that
// drives the coupon schedule changes (face value, rate, frequency,
// tax rate, first coupon date), the existing schedule is deleted
// and regenerated — safe at this stage since no coupon can have
// been paid on a not-yet-approved investment.
// ============================================================
const editInvestment = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const {
        name, description, category_id, funding_account_id,
        planned_budget, start_date, expected_end_date, responsible_user_id,
        face_value, coupon_rate, coupon_frequency, tax_withholding_rate, first_coupon_date,
        settlement_value, bond_term_years, tbill_tax_timing,
    } = req.body;

    await withTransaction(async (client) => {
        const existing = await client.query(
            'SELECT * FROM investments WHERE id = $1 FOR UPDATE', [id]
        );
        if (existing.rows.length === 0) {
            throw createError.notFound('Investment not found');
        }
        const investment = existing.rows[0];

        if (investment.status !== 'PENDING') {
            throw createError.badRequest('Only a pending investment can be edited');
        }

        const isCreator = investment.created_by === req.user.id;
        const canApprove = (req.user.permissions || []).includes('INVESTMENT_APPROVE');
        if (!isCreator && !canApprove) {
            throw createError.forbidden(
                'Only the person who created this investment, or someone who can approve it, can edit it'
            );
        }

        const isBond = investment.investment_type === 'BOND';
        const isTbill = investment.investment_type === 'TREASURY_BILL';

        let currencyId = investment.currency_id;
        let newFundingAccountId = investment.funding_account_id;
        if (funding_account_id) {
            const account = await client.query(`
                SELECT id, account_type, currency_id FROM accounts
                WHERE  id = $1 AND is_active = TRUE
            `, [funding_account_id]);
            if (account.rows.length === 0) {
                throw createError.notFound('Funding account not found');
            }
            if (account.rows[0].account_type !== 'SECONDARY') {
                throw createError.badRequest(
                    'Investments must be funded from a secondary operational account'
                );
            }
            currencyId = account.rows[0].currency_id;
            newFundingAccountId = funding_account_id;
        }

        const newFaceValue    = (isBond || isTbill) ? (face_value !== undefined ? face_value : investment.face_value) : null;
        const newCouponRate   = isBond ? (coupon_rate           !== undefined ? coupon_rate           : investment.coupon_rate)          : null;
        const newFrequency    = isBond ? (coupon_frequency      || investment.coupon_frequency)                                          : null;
        const newTaxRate      = (isBond || isTbill) ? (tax_withholding_rate !== undefined ? tax_withholding_rate : investment.tax_withholding_rate) : 0;
        const newStartDate    = start_date        || investment.start_date;
        const newEndDate      = expected_end_date || investment.expected_end_date;
        const newFirstCoupon  = first_coupon_date !== undefined ? first_coupon_date : investment.first_coupon_date;
        const newSettlement   = (isBond || isTbill) ? (settlement_value !== undefined ? settlement_value : investment.settlement_value) : null;
        if (isTbill && newSettlement !== null && newFaceValue !== null && parseFloat(newSettlement) >= parseFloat(newFaceValue)) {
            throw createError.badRequest('The price paid for a treasury bill must be below its face value');
        }
        const newBondTerm     = isBond ? (bond_term_years  !== undefined ? parseInt(bond_term_years) : investment.bond_term_years) : null;
        if (isBond && newBondTerm !== null && ![2, 3, 5, 10, 15, 20, 25].includes(newBondTerm)) {
            throw createError.badRequest('Bond term must be one of: 2yr, 3yr, 5yr, 10yr, 15yr, 20yr, 25yr');
        }

        const bondScheduleFieldsChanged = isBond && (
            face_value          !== undefined ||
            coupon_rate          !== undefined ||
            coupon_frequency     !== undefined ||
            tax_withholding_rate !== undefined ||
            first_coupon_date    !== undefined ||
            start_date            !== undefined ||
            expected_end_date     !== undefined
        );

        const updated = await client.query(`
            UPDATE investments
            SET    name                 = COALESCE($1, name),
                   description          = $2,
                   category_id          = COALESCE($3, category_id),
                   funding_account_id   = $4,
                   returns_account_id   = $4,
                   currency_id          = $5,
                   planned_budget       = COALESCE($6, planned_budget),
                   start_date           = $7,
                   expected_end_date    = $8,
                   responsible_user_id  = $9,
                   face_value           = $10,
                   coupon_rate          = $11,
                   coupon_frequency     = $12,
                   tax_withholding_rate = $13,
                   first_coupon_date    = $14,
                   settlement_value     = $15,
                   bond_term_years      = $16
            WHERE  id = $17
            RETURNING *
        `, [
            name ? name.trim() : null, description !== undefined ? description : investment.description,
            category_id || null, newFundingAccountId, currencyId,
            planned_budget || null, newStartDate, newEndDate,
            responsible_user_id !== undefined ? responsible_user_id : investment.responsible_user_id,
            newFaceValue, newCouponRate, newFrequency, newTaxRate, newFirstCoupon, newSettlement,
            newBondTerm,
            id,
        ]);

        if (isTbill && tbill_tax_timing) {
            if (!['AT_MATURITY', 'AT_PURCHASE'].includes(tbill_tax_timing)) throw createError.badRequest('Tax timing must be AT_MATURITY or AT_PURCHASE');
            await client.query(`UPDATE investments SET tbill_tax_timing = $1 WHERE id = $2`, [tbill_tax_timing, id]);
        }

        if (bondScheduleFieldsChanged) {
            await client.query('DELETE FROM bond_coupons WHERE investment_id = $1', [id]);
            const schedule = generateBondCouponSchedule({
                faceValue:          newFaceValue,
                couponRate:         newCouponRate,
                frequency:          newFrequency,
                taxWithholdingRate: newTaxRate || 0,
                issueDate:          newStartDate,
                maturityDate:       newEndDate,
                firstCouponDate:    newFirstCoupon || null,
            });
            for (const coupon of schedule) {
                await client.query(`
                    INSERT INTO bond_coupons (
                        investment_id, coupon_number, due_date,
                        gross_amount, tax_amount, net_amount
                    ) VALUES ($1, $2, $3, $4, $5, $6)
                `, [
                    id, coupon.coupon_number, coupon.due_date,
                    coupon.gross_amount, coupon.tax_amount, coupon.net_amount,
                ]);
            }
        }

        await logAction(req.user.id, ACTIONS.INVESTMENT_UPDATED, MODULES.INVESTMENTS, {
            ipAddress:   req.ip,
            recordType:  'investments',
            recordId:    id,
            oldValues:   investment,
            newValues:   updated.rows[0],
            description: `Investment edited before approval: ID ${id}`,
            client,
        });

        sendSuccess(res, updated.rows[0], 'Investment updated');
    });
});

// ============================================================
// APPROVE INVESTMENT
// POST /api/investments/:id/approve
// ============================================================
const approveInvestment = asyncHandler(async (req, res) => {
    // v1.72.0 — four-eyes rule: the creator (or the member it benefits) can't approve it; an Admin can.
    await assertNotOwnRecord(req, null, 'investments', req.params.id, ['created_by'], 'investment');
    const { id } = req.params;

    await withTransaction(async (client) => {
        const investResult = await client.query(`
            SELECT i.*, a.currency_id, a.account_type, a.reference_prefix, r.reference_code, r.public_id
            FROM   investments i
            JOIN   accounts a ON a.id = i.funding_account_id
            JOIN   references_registry r ON r.id = i.reference_id
            WHERE  i.id = $1
            FOR UPDATE
        `, [id]);

        if (investResult.rows.length === 0) {
            throw createError.notFound('Investment not found');
        }
        const investment = investResult.rows[0];

        if (investment.status !== 'PENDING') {
            throw createError.badRequest(
                `Investment cannot be approved. Status: ${investment.status}`
            );
        }

        await client.query(`
            UPDATE investments
            SET    status      = 'ACTIVE',
                   approved_by = $1,
                   approved_at = NOW()
            WHERE  id = $2
        `, [req.user.id, id]);

        await client.query(`
            UPDATE approval_workflows
            SET    status            = 'APPROVED',
                   current_approvals = 1,
                   completed_at      = NOW()
            WHERE  record_type = 'investments'
            AND    record_id   = $1
        `, [id]);

        // v1.42.0 — a BOND whose settlement value is already known (set
        // at creation, or edited in while still PENDING) is
        // automatically funded for that exact amount the moment it's
        // approved — no separate manual "Fund" step needed for money
        // that's already known and due. Guarded by postTransaction's
        // own negative-balance/floor-limit check, exactly as it is for
        // a manual funding entry — if the account can't cover it, this
        // whole approval fails and rolls back rather than activating
        // an unpaid-for bond. If settlement_value isn't known yet, the
        // investment still activates — see setSettlementValue below for
        // the "fill it in later" path once it's available.
        // v1.70.0 — a TREASURY BILL is funded the same way; when its tax
        // is paid with the purchase (AT_PURCHASE) the funding is the price
        // plus the tax on the discount.
        let settlementFunded = null;
        const isBond = investment.investment_type === 'BOND';
        const isTbill = investment.investment_type === 'TREASURY_BILL';
        if ((isBond || isTbill) && investment.settlement_value !== null && parseFloat(investment.settlement_value) > 0) {
            let fundAmount = parseFloat(investment.settlement_value);
            if (isTbill && investment.tbill_tax_timing === 'AT_PURCHASE') {
                const discount = parseFloat(investment.face_value) - fundAmount;
                fundAmount = round2(fundAmount + round2(discount * (parseFloat(investment.tax_withholding_rate) || 0) / 100));
            }
            const funding = await postInvestmentFunding(client, investment, {
                amount:      fundAmount,
                description: isTbill
                    ? `Treasury bill purchase${investment.tbill_tax_timing === 'AT_PURCHASE' ? ' (price + tax on the discount)' : ''}, auto-funded on approval — ${investment.name} (${investment.reference_code})`
                    : `Bond settlement value, auto-funded on approval — ${investment.name} (${investment.reference_code})`,
                // A bill is paid for on its purchase date (never a future one).
                valueDate:   (() => {
                    const today = new Date().toISOString().slice(0, 10);
                    if (!isTbill || !investment.start_date) return today;
                    const start = dateOnly(investment.start_date);
                    return start < today ? start : today;
                })(),
                userId:      req.user.id,
            });
            settlementFunded = {
                amount:         fundAmount,
                reference_code: funding.referenceCode,
                balance_after:  funding.balanceAfter,
            };

            await logAction(req.user.id, ACTIONS.INVESTMENT_SETTLEMENT_FUNDED, MODULES.INVESTMENTS, {
                ipAddress:   req.ip,
                recordType:  'investments',
                recordId:    parseInt(id),
                newValues:   settlementFunded,
                description: `Bond settlement value ${settlementFunded.amount} auto-funded on approval: ${settlementFunded.reference_code} (investment ID ${id})`,
                client,
            });
        }

        await logAction(req.user.id, ACTIONS.INVESTMENT_APPROVED, MODULES.INVESTMENTS, {
            ipAddress:   req.ip,
            recordType:  'investments',
            recordId:    parseInt(id),
            newValues:   { settlementFunded },
            description: `Investment approved: ID ${id}` +
                         (settlementFunded ? ` — settlement value ${settlementFunded.amount} auto-funded (${settlementFunded.reference_code})` : ''),
            client,
        });

        sendSuccess(res, { settlement_funded: settlementFunded }, 'Investment approved successfully');
    });
});

// ============================================================
// RECORD SETTLEMENT VALUE (post-approval)
// PATCH /api/investments/:id/settlement-value
// v1.42.0 — settlement_value can be set/edited freely while an
// investment is still PENDING (editInvestment). Once it's ACTIVE, it
// used to be permanently un-settable if it wasn't known at approval
// time. This closes that gap: an ACTIVE bond that has never been
// funded yet (actual_expenditure still 0 — nothing has been auto- or
// manually funded against it) can have its settlement value filled in
// here, which immediately triggers the same guarded auto-funding
// approval would have done had it been known then. Once ANY funding
// has happened (actual_expenditure > 0), this is locked — same
// "can't rewrite money that's already moved" principle as the coupon
// schedule being locked after the first coupon is paid.
// ============================================================
const setSettlementValue = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { settlement_value } = req.body;

    if (settlement_value === undefined || settlement_value === null || parseFloat(settlement_value) <= 0) {
        throw createError.badRequest('A settlement value greater than zero is required');
    }

    await withTransaction(async (client) => {
        const investResult = await client.query(`
            SELECT i.*, a.currency_id, a.account_type, a.reference_prefix, r.reference_code, r.public_id
            FROM   investments i
            JOIN   accounts a ON a.id = i.funding_account_id
            JOIN   references_registry r ON r.id = i.reference_id
            WHERE  i.id = $1
            FOR UPDATE
        `, [id]);

        if (investResult.rows.length === 0) {
            throw createError.notFound('Investment not found');
        }
        const investment = investResult.rows[0];

        if (investment.investment_type !== 'BOND') {
            throw createError.badRequest('Only bond investments have a settlement value');
        }
        if (investment.status !== 'ACTIVE') {
            throw createError.badRequest(
                'This investment must be approved and active before its settlement value can be recorded here — ' +
                'while still pending, edit it directly instead'
            );
        }
        if (parseFloat(investment.actual_expenditure) > 0) {
            throw createError.badRequest(
                'This investment has already been funded — its settlement value can no longer be changed here'
            );
        }

        const amount = parseFloat(settlement_value);

        await client.query('UPDATE investments SET settlement_value = $1 WHERE id = $2', [amount, id]);

        const funding = await postInvestmentFunding(client, investment, {
            amount,
            description: `Bond settlement value, recorded and funded — ${investment.name} (${investment.reference_code})`,
            valueDate:   new Date().toISOString().slice(0, 10),
            userId:      req.user.id,
        });

        await logAction(req.user.id, ACTIONS.INVESTMENT_SETTLEMENT_VALUE_RECORDED, MODULES.INVESTMENTS, {
            ipAddress:   req.ip,
            recordType:  'investments',
            recordId:    parseInt(id),
            oldValues:   { settlement_value: investment.settlement_value },
            newValues:   { settlement_value: amount, reference_code: funding.referenceCode },
            description: `Settlement value ${amount} recorded and funded: ${funding.referenceCode} (investment ID ${id})`,
            client,
        });

        sendSuccess(res, {
            settlement_value:      amount,
            transaction_reference: funding.referenceCode,
            balance_before:        funding.balanceBefore,
            balance_after:         funding.balanceAfter,
        }, `Settlement value recorded and funded. Reference: ${funding.referenceCode}`);
    });
});

// ============================================================
// SET / CORRECT BOND TERM (v1.60.0)
// PATCH /api/investments/:id/bond-term
// Every NEW bond requires this at creation time (see createInvestment
// above); this endpoint exists for two cases: (1) a legacy bond that
// migration_v1.60.0.sql's auto-backfill left at NULL because its
// duration didn't cleanly match one of the 7 standard terms, and (2)
// correcting a bond that was backfilled or entered with the wrong
// term. No status restriction — unlike settlement value or the coupon
// schedule, the term is purely a categorical label and doesn't drive
// any money movement or schedule generation, so it's safe to set or
// change at any point in the bond's life.
// ============================================================
const setBondTerm = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { bond_term_years } = req.body;

    const BOND_TERMS = [2, 3, 5, 10, 15, 20, 25];
    const term = parseInt(bond_term_years);
    if (!BOND_TERMS.includes(term)) {
        throw createError.badRequest(
            `Bond term must be one of: ${BOND_TERMS.map(t => t + 'yr').join(', ')}`
        );
    }

    await withTransaction(async (client) => {
        const existing = await client.query(
            'SELECT id, investment_type, bond_term_years FROM investments WHERE id = $1 FOR UPDATE', [id]
        );
        if (existing.rows.length === 0) {
            throw createError.notFound('Investment not found');
        }
        const investment = existing.rows[0];

        if (investment.investment_type !== 'BOND') {
            throw createError.badRequest('Only bond investments have a term');
        }

        await client.query('UPDATE investments SET bond_term_years = $1 WHERE id = $2', [term, id]);

        await logAction(req.user.id, ACTIONS.INVESTMENT_UPDATED, MODULES.INVESTMENTS, {
            ipAddress:   req.ip,
            recordType:  'investments',
            recordId:    parseInt(id),
            oldValues:   { bond_term_years: investment.bond_term_years },
            newValues:   { bond_term_years: term },
            description: `Bond term set to ${term}yr (investment ID ${id})`,
            client,
        });

        sendSuccess(res, { bond_term_years: term }, `Bond term set to ${term}yr`);
    });
});

// ============================================================
// SHARED: post a capital-funding DEBIT against an investment.
// v1.42.0 — extracted out of fundInvestment so the exact same
// reference-generation / postTransaction / investment_funding /
// actual_expenditure(+supplementary_budget) logic is reused by
// approveInvestment (bond settlement value, auto-funded on approval
// when already known) and setSettlementValue (the same, triggered
// later if it wasn't known yet at approval time) — rather than three
// near-duplicate copies of this money-movement logic drifting apart
// over time. Must be called from inside an existing withTransaction
// block, with `investment` already SELECT ... FOR UPDATE locked by
// the caller and carrying its joined account/reference columns
// (currency_id, reference_code — see the JOIN shape used below).
// ============================================================
async function postInvestmentFunding(client, investment, {
    amount, categoryId, description, valueDate, projectId, userId, capitalGoalId = null,
    accountId = null, // v1.80.0 — a requisition may pay from another account in the same currency
}) {
    // v1.80.0 — money put INTO an investment is capital; its category trail
    // is Expense › Investments › Purchase & expansion unless one was chosen.
    if (!categoryId) categoryId = await investmentCost.purposeCategory(client, 'CAPITAL', userId);
    const { referenceId: txRefId, referenceCode: txRefCode } =
        await generateReference(
            client,
            resolveModuleCode(investment),
            'INVEST-OUT',
            'TRANSACTION',
            userId
        );

    const { transactionId, balanceBefore, balanceAfter } = await postTransaction(client, {
        accountId:       accountId || investment.funding_account_id,
        transactionType: 'DEBIT',
        inflowType:      'EXPENSE',
        amount,
        currencyId:      investment.currency_id,
        categoryId:      categoryId || investment.category_id,
        description:     description ||
                         `Investment funding — ${investment.name} (${investment.reference_code})`,
        valueDate,
        createdBy:       userId,
        referenceId:     txRefId,
        investmentId:    investment.id,
    });

    await linkReferenceToRecord(client, txRefId, transactionId);
    await investmentCost.setCostType(client, transactionId, 'CAPITAL');

    const fundingRow = await client.query(`
        INSERT INTO investment_funding (
            investment_id, project_id, transaction_id, amount, created_by
        ) VALUES ($1, $2, $3, $4, $5)
        RETURNING id
    `, [investment.id, projectId || null, transactionId, amount, userId]);
    // v1.78.0 — funded with a capital goal's money (checked by the caller)
    if (capitalGoalId) {
        await client.query('UPDATE investment_funding SET capital_goal_id = $1 WHERE id = $2', [capitalGoalId, fundingRow.rows[0].id]);
    }

    // Auto-log any portion of this funding that pushes total spend
    // past planned_budget as supplementary budget (v1.40.0).
    const { newExpenditure, supplementaryDelta } = computeSupplementaryOverage(
        investment.planned_budget, investment.actual_expenditure, amount
    );
    await client.query(`
        UPDATE investments
        SET    actual_expenditure   = $1,
               supplementary_budget = supplementary_budget + $2
        WHERE  id = $3
    `, [newExpenditure, supplementaryDelta, investment.id]);

    if (projectId) {
        await client.query(`
            UPDATE projects SET actual_expenditure = actual_expenditure + $1 WHERE id = $2
        `, [amount, projectId]);
    }

    return { transactionId, referenceCode: txRefCode, balanceBefore, balanceAfter };
}

// ============================================================
// FUND INVESTMENT
// POST /api/investments/:id/fund
// Records money being allocated from secondary account
// to this investment.
// ============================================================
const fundInvestment = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { amount, category_id, description, value_date, project_id, capital_goal_id } = req.body;

    await withTransaction(async (client) => {
        const investResult = await client.query(`
            SELECT i.*, a.currency_id, a.account_type, a.reference_prefix, r.reference_code, r.public_id
            FROM   investments i
            JOIN   accounts a ON a.id = i.funding_account_id
            JOIN   references_registry r ON r.id = i.reference_id
            WHERE  i.id = $1
            FOR UPDATE
        `, [id]);

        if (investResult.rows.length === 0) {
            throw createError.notFound('Investment not found');
        }

        const investment = investResult.rows[0];

        if (investment.status !== 'ACTIVE') {
            throw createError.badRequest(
                'Investment must be active before funding'
            );
        }

        // v1.78.0 — investing a capital goal's money: never more than the
        // goal money that has reached this investment's account.
        let goalLink = null;
        if (capital_goal_id) {
            goalLink = await capitalGoalFunds.assertFundingAllowed(client, {
                goalId: parseInt(capital_goal_id, 10), investmentId: investment.id, amount,
            });
        }

        const funding = await postInvestmentFunding(client, investment, {
            amount, categoryId: category_id,
            description: description || (goalLink ? `Investment funding from ${goalLink.goal.reference_code} (${goalLink.goal.title}) — ${investment.name} (${investment.reference_code})` : undefined),
            valueDate: value_date,
            projectId: project_id, userId: req.user.id,
            capitalGoalId: goalLink ? goalLink.goal.id : null,
        });

        sendCreated(res, {
            transaction_reference: funding.referenceCode,
            amount_funded:         amount,
            balance_before:        funding.balanceBefore,
            balance_after:         funding.balanceAfter,
        }, `Investment funded. Reference: ${funding.referenceCode}`);
    });
});

// ============================================================
// RECORD INVESTMENT RETURN
// POST /api/investments/:id/returns
// Records profit/return coming back into the source account.
// ============================================================
const recordReturn = asyncHandler(async (req, res) => {
    const { id } = req.params;
    // v1.70.0 — tax_deducted / tax_treatment: the payer kept back tax
    // from this return (amount is then the GROSS return). A PRINCIPAL
    // return is the company's own money coming back — booked against the
    // investment (1400), never as income.
    const { amount, return_type, return_date, notes, tax_deducted, tax_treatment, payer_name, tax_certificate_number } = req.body;
    const taxDeducted = tax_deducted ? parseFloat(tax_deducted) : 0;
    if (taxDeducted > 0 && return_type === 'PRINCIPAL') {
        throw createError.badRequest('Tax is not deducted from a return of principal — record the tax with the income it was taken from.');
    }
    if (taxDeducted > 0 && !(taxDeducted < parseFloat(amount))) {
        throw createError.badRequest('The tax deducted must be less than the gross return.');
    }

    await withTransaction(async (client) => {
        const investResult = await client.query(`
            SELECT i.*, a.currency_id, a.account_type, a.reference_prefix, r.reference_code, r.public_id
            FROM   investments i
            JOIN   accounts a ON a.id = i.funding_account_id
            JOIN   references_registry r ON r.id = i.reference_id
            WHERE  i.id = $1
            FOR UPDATE
        `, [id]);

        if (investResult.rows.length === 0) {
            throw createError.notFound('Investment not found');
        }

        const investment = investResult.rows[0];

        // Generate return reference
        const { referenceId: retRefId, referenceCode: retRefCode } =
            await generateReference(
                client,
                MODULE_CODES.INVESTMENT,
                'RETURN',
                'INVESTMENT_RETURN',
                req.user.id
            );

        // Generate transaction reference
        const { referenceId: txRefId } = await generateReference(
            client,
            resolveModuleCode(investment),
            'INVEST-IN',
            'TRANSACTION',
            req.user.id
        );

        // Post credit transaction — return arrives in source account
        const { transactionId, balanceBefore, balanceAfter } = await postTransaction(client, {
            accountId:       investment.returns_account_id,
            transactionType: 'CREDIT',
            inflowType:      'INVESTMENT_RETURN',
            amount,
            currencyId:      investment.currency_id,
            categoryId:      investment.category_id,
            description:     `Investment return (${return_type}) — ` +
                             `${investment.name} (${investment.reference_code})`,
            valueDate:       return_date,
            createdBy:       req.user.id,
            referenceId:     txRefId,
            investmentId:    investment.id,
            glOverrideAccountCode: return_type === 'PRINCIPAL' ? '1400' : null,
        });

        await linkReferenceToRecord(client, txRefId, transactionId);

        let balanceAfterAll = balanceAfter;
        let taxRecord = null;
        if (taxDeducted > 0) {
            const treatment = tax_treatment === 'CREDITABLE' ? 'CREDITABLE' : 'FINAL';
            const leg = await taxService.postTaxLeg(client, {
                accountId: investment.returns_account_id, currencyId: investment.currency_id, amount: taxDeducted,
                date: return_date, treatment, categoryId: investment.category_id, investmentId: investment.id,
                description: `Tax deducted at source (${treatment.toLowerCase()}) — ${return_type} return, ${investment.name} (${investment.reference_code})`,
                userId: req.user.id,
            });
            balanceAfterAll = leg.balanceAfter;
            await client.query(`
                INSERT INTO investment_transactions (reference_id, investment_id, transaction_id, entry_type, amount, description, entry_date, created_by)
                SELECT $1, $2, $3, 'TAX', $4, $5, $6, $7
            `, [(await generateReference(client, MODULE_CODES.INVESTMENT, 'INV-OP', 'INVESTMENT_TRANSACTION', req.user.id)).referenceId,
                id, leg.transactionId, taxDeducted, `Tax deducted at source on ${return_type.toLowerCase()} return`, return_date, req.user.id]);
            taxRecord = await taxService.recordTaxAtSource(client, {
                sourceType: 'INVESTMENT_RETURN', payerName: payer_name || investment.name, investmentId: investment.id,
                incomeTransactionId: transactionId, taxTransactionId: leg.transactionId, cashLeg: true,
                rate: Math.round((taxDeducted / parseFloat(amount)) * 1000000) / 10000, treatment,
                gross: amount, tax: taxDeducted, currencyId: investment.currency_id, date: return_date,
                certificateNumber: tax_certificate_number || null, userId: req.user.id,
            });
        }

        // Record the return
        const returnResult = await client.query(`
            INSERT INTO investment_returns (
                reference_id, investment_id, transaction_id,
                return_type, amount, return_date, notes, created_by
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id
        `, [
            retRefId, id, transactionId,
            return_type, amount, return_date,
            notes || null, req.user.id,
        ]);

        await linkReferenceToRecord(client, retRefId, returnResult.rows[0].id);

        // Update total returns on investment
        await client.query(`
            UPDATE investments
            SET    total_returns = total_returns + $1
            WHERE  id = $2
        `, [amount, id]);

        await logAction(req.user.id, ACTIONS.INVESTMENT_RETURN, MODULES.INVESTMENTS, {
            ipAddress:   req.ip,
            recordType:  'investment_returns',
            recordId:    returnResult.rows[0].id,
            newValues:   { retRefCode, amount, return_type, balanceBefore, balanceAfter },
            description: `Investment return recorded: ${retRefCode} — ${amount}`,
            client,
        });

        if (investment.responsible_user_id) {
            notify({
                userId:     investment.responsible_user_id,
                type:       'INVESTMENT_RETURN_RECORDED',
                title:      'Investment return recorded',
                body:       `A ${return_type.toLowerCase()} return of ${amount} was recorded for ${investment.name}. Reference: ${retRefCode}.`,
                link:       `/investments/${id}`,
                module:     'INVESTMENTS',
                recordType: 'investment_returns',
                recordId:   returnResult.rows[0].id,
                email: {
                    subject: `Investment return recorded — ${investment.name}`,
                    html:    await wrapEmail(`
                        <p>A return has been recorded on an investment you're responsible for:</p>
                        <table style="width:100%; border-collapse:collapse; margin:12px 0;">
                            <tr><td style="padding:4px 0; color:#6b7280;">Investment</td><td style="padding:4px 0; text-align:right;">${investment.name}</td></tr>
                            <tr><td style="padding:4px 0; color:#6b7280;">Return type</td><td style="padding:4px 0; text-align:right;">${return_type}</td></tr>
                            <tr><td style="padding:4px 0; color:#6b7280;">Amount</td><td style="padding:4px 0; text-align:right; font-weight:700;">${amount}</td></tr>
                            <tr><td style="padding:4px 0; color:#6b7280;">Reference</td><td style="padding:4px 0; text-align:right;">${retRefCode}</td></tr>
                        </table>
                    `, { preheader: 'An investment return has been recorded' }),
                },
            });
        }

        sendCreated(res, {
            return_reference: retRefCode,
            return_type,
            amount,
            tax_deducted:     taxDeducted || 0,
            tax_record:       taxRecord ? taxRecord.referenceCode : null,
            total_returns:    parseFloat(investment.total_returns) + parseFloat(amount),
            balance_before:   balanceBefore,
            balance_after:    balanceAfterAll,
        }, `Return recorded. Reference: ${retRefCode}`);
    });
});

// ============================================================
// SHARED (v1.80.0): pay a running / maintenance / capital EXPENSE of
// an investment from inside another flow (a paid requisition). Same
// effect as "Record expense" on the investment page: a ledger DEBIT
// tagged with the investment and its purpose, an investment_transactions
// row, and the investment's "Spent" figure. The caller has the
// investment locked (SELECT … FOR UPDATE, with currency_id /
// reference_code / reference_prefix joined as below).
// ============================================================
async function postInvestmentExpense(client, investment, {
    amount, description, entryDate, costType, accountId = null, categoryId = null, userId,
}) {
    if (!MUTABLE_INVESTMENT_STATUSES.includes(investment.status)) {
        throw createError.badRequest(`${investment.name} is ${String(investment.status).toLowerCase().replace(/_/g, ' ')} — expenses can only be recorded against an active investment.`);
    }
    if (!categoryId) categoryId = await investmentCost.purposeCategory(client, costType, userId);
    const { referenceId: opRefId, referenceCode: opRefCode } =
        await generateReference(client, MODULE_CODES.INVESTMENT, 'INV-OP', 'INVESTMENT_TRANSACTION', userId);
    const { referenceId: txRefId, referenceCode: txRefCode } =
        await generateReference(client, resolveModuleCode(investment), 'INVEST-OP-OUT', 'TRANSACTION', userId);
    const { transactionId, balanceBefore, balanceAfter } = await postTransaction(client, {
        accountId:       accountId || investment.returns_account_id,
        transactionType: 'DEBIT',
        inflowType:      'EXPENSE',
        amount,
        currencyId:      investment.currency_id,
        categoryId,
        description:     description || `Investment expense — ${investment.name} (${investment.reference_code})`,
        valueDate:       entryDate,
        createdBy:       userId,
        referenceId:     txRefId,
        investmentId:    investment.id,
    });
    await linkReferenceToRecord(client, txRefId, transactionId);
    await investmentCost.setCostType(client, transactionId, costType);
    const op = await client.query(`
        INSERT INTO investment_transactions (reference_id, investment_id, transaction_id, entry_type, amount, description, entry_date, created_by)
        VALUES ($1, $2, $3, 'EXPENSE', $4, $5, $6, $7) RETURNING id
    `, [opRefId, investment.id, transactionId, amount, description || 'Investment expense', entryDate, userId]);
    await linkReferenceToRecord(client, opRefId, op.rows[0].id);
    const { newExpenditure, supplementaryDelta } = computeSupplementaryOverage(
        investment.planned_budget, investment.actual_expenditure, amount
    );
    await client.query(`
        UPDATE investments SET actual_expenditure = $1, supplementary_budget = supplementary_budget + $2 WHERE id = $3
    `, [newExpenditure, supplementaryDelta, investment.id]);
    return { transactionId, referenceCode: txRefCode, operationReference: opRefCode, balanceBefore, balanceAfter };
}

// ============================================================
// RECORD INVESTMENT OPERATIONAL TRANSACTION
// POST /api/investments/:id/transactions
// Records a dedicated operational entry against ONE investment —
// an EXPENSE (running cost of the investment), an extra INFLOW
// (income beyond the scheduled/manual returns), or TAX withheld
// on the investment. Every entry here also posts automatically to
// the general ledger via postTransaction, so nothing here bypasses
// the universal transactions table — this just tags which ledger
// entries belong to which investment's own operating budget.
// ============================================================
const recordInvestmentTransaction = asyncHandler(async (req, res) => {
    const { id } = req.params;
    // v1.70.0 — a TAX entry is tax deducted at source from this
    // investment's income: FINAL (default — government securities) goes
    // to 5700, CREDITABLE to 1500; either way it is added to the register
    // of tax deducted from the company. gross_amount (optional) is the
    // income it was deducted from.
    const { entry_type, amount, description, entry_date, tax_treatment, gross_amount, tax_certificate_number } = req.body;
    let { category_id } = req.body;

    if (!['EXPENSE', 'INFLOW', 'TAX'].includes(entry_type)) {
        throw createError.badRequest('entry_type must be EXPENSE, INFLOW, or TAX');
    }
    // v1.80.0 — an EXPENSE says what it was for (buying / running /
    // maintenance). An entry without one (e.g. waiting in "Awaiting
    // approval" since before v1.80) is kept as before: capital.
    const costType = entry_type === 'EXPENSE' ? investmentCost.assertCostType(req.body.cost_type) : null;

    await withTransaction(async (client) => {
        const investResult = await client.query(`
            SELECT i.*, a.currency_id, a.account_type, a.reference_prefix, r.reference_code, r.public_id
            FROM   investments i
            JOIN   accounts a ON a.id = i.funding_account_id
            JOIN   references_registry r ON r.id = i.reference_id
            WHERE  i.id = $1
            FOR UPDATE
        `, [id]);

        if (investResult.rows.length === 0) {
            throw createError.notFound('Investment not found');
        }
        const investment = investResult.rows[0];

        if (!MUTABLE_INVESTMENT_STATUSES.includes(investment.status)) {
            throw createError.badRequest(
                'Operational transactions can only be recorded against an active investment, ' +
                'or one currently under termination review'
            );
        }

        // INFLOW is money arriving (credit); EXPENSE and TAX are money
        // leaving the investment's operating cash (debit).
        const isInflow = entry_type === 'INFLOW';

        // Generate a reference for the investment_transactions row itself
        const { referenceId: opRefId, referenceCode: opRefCode } =
            await generateReference(
                client,
                MODULE_CODES.INVESTMENT,
                'INV-OP',
                'INVESTMENT_TRANSACTION',
                req.user.id
            );

        // Generate the general-ledger transaction reference
        const { referenceId: txRefId } = await generateReference(
            client,
            resolveModuleCode(investment),
            isInflow ? 'INVEST-OP-IN' : 'INVEST-OP-OUT',
            'TRANSACTION',
            req.user.id
        );

        const entryLabel = entry_type === 'TAX' ? 'Tax' :
                            entry_type === 'INFLOW' ? 'Inflow' : 'Expense';
        if (costType && !category_id) category_id = await investmentCost.purposeCategory(client, costType, req.user.id);

        const { transactionId, balanceBefore, balanceAfter } = await postTransaction(client, {
            accountId:       investment.returns_account_id,
            transactionType: isInflow ? 'CREDIT' : 'DEBIT',
            inflowType:      isInflow ? 'INVESTMENT_RETURN' : 'EXPENSE',
            amount,
            currencyId:      investment.currency_id,
            categoryId:      category_id || investment.category_id,
            description:     description ||
                             `Investment ${entryLabel.toLowerCase()} — ` +
                             `${investment.name} (${investment.reference_code})`,
            valueDate:       entry_date,
            createdBy:       req.user.id,
            referenceId:     txRefId,
            investmentId:    investment.id,
            glOverrideAccountCode: entry_type === 'TAX'
                ? (tax_treatment === 'CREDITABLE' ? taxService.TAX_GL.WHT_RECOVERABLE : taxService.TAX_GL.FINAL_TAX)
                : null,
        });

        await linkReferenceToRecord(client, txRefId, transactionId);
        if (costType) await investmentCost.setCostType(client, transactionId, costType);

        if (entry_type === 'TAX') {
            const gross = gross_amount && parseFloat(gross_amount) > parseFloat(amount) ? parseFloat(gross_amount) : parseFloat(amount);
            await taxService.recordTaxAtSource(client, {
                sourceType: 'INVESTMENT_TAX_ENTRY', payerName: investment.name, investmentId: investment.id,
                taxTransactionId: transactionId, cashLeg: true,
                rate: gross > parseFloat(amount) ? Math.round((parseFloat(amount) / gross) * 1000000) / 10000 : null,
                treatment: tax_treatment === 'CREDITABLE' ? 'CREDITABLE' : 'FINAL',
                gross, tax: amount, currencyId: investment.currency_id, date: entry_date,
                certificateNumber: tax_certificate_number || null, userId: req.user.id,
                notes: gross === parseFloat(amount) ? 'Gross income not entered — the gross shown equals the tax.' : null,
            });
        }

        const opResult = await client.query(`
            INSERT INTO investment_transactions (
                reference_id, investment_id, transaction_id,
                entry_type, amount, description, entry_date, created_by
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id
        `, [
            opRefId, id, transactionId,
            entry_type, amount,
            description || `Investment ${entryLabel.toLowerCase()}`,
            entry_date, req.user.id,
        ]);

        await linkReferenceToRecord(client, opRefId, opResult.rows[0].id);

        // v1.40.0 fix: EXPENSE and TAX entries are real money spent on
        // this investment's behalf and must count toward "Spent"
        // (actual_expenditure), same as capital funding already does —
        // previously this money left the funding account but was never
        // reflected in the investment's own spend figure. INFLOW is
        // income, not spend, so it's left out of actual_expenditure
        // (it's already visible via total_income in the operating
        // budget summary). Any portion that pushes total spend past
        // planned_budget is auto-logged as supplementary budget.
        if (!isInflow) {
            const { newExpenditure, supplementaryDelta } = computeSupplementaryOverage(
                investment.planned_budget, investment.actual_expenditure, amount
            );
            await client.query(`
                UPDATE investments
                SET    actual_expenditure   = $1,
                       supplementary_budget = supplementary_budget + $2
                WHERE  id = $3
            `, [newExpenditure, supplementaryDelta, id]);
        }

        await logAction(req.user.id, ACTIONS.INVESTMENT_RETURN, MODULES.INVESTMENTS, {
            ipAddress:   req.ip,
            recordType:  'investment_transactions',
            recordId:    opResult.rows[0].id,
            newValues:   { opRefCode, entry_type, amount, balanceBefore, balanceAfter },
            description: `Investment ${entryLabel.toLowerCase()} recorded: ${opRefCode} — ${amount}`,
            client,
        });

        if (investment.responsible_user_id) {
            notify({
                userId:     investment.responsible_user_id,
                type:       'INVESTMENT_OPERATION_RECORDED',
                title:      `Investment ${entryLabel.toLowerCase()} recorded`,
                body:       `An ${entryLabel.toLowerCase()} of ${amount} was recorded against ${investment.name}. Reference: ${opRefCode}.`,
                link:       `/investments/${id}`,
                module:     'INVESTMENTS',
                recordType: 'investment_transactions',
                recordId:   opResult.rows[0].id,
                email: {
                    subject: `Investment ${entryLabel.toLowerCase()} recorded — ${investment.name}`,
                    html:    await wrapEmail(`
                        <p>An operational entry has been recorded against an investment you're responsible for:</p>
                        <table style="width:100%; border-collapse:collapse; margin:12px 0;">
                            <tr><td style="padding:4px 0; color:#6b7280;">Investment</td><td style="padding:4px 0; text-align:right;">${investment.name}</td></tr>
                            <tr><td style="padding:4px 0; color:#6b7280;">Entry type</td><td style="padding:4px 0; text-align:right;">${entryLabel}</td></tr>
                            <tr><td style="padding:4px 0; color:#6b7280;">Amount</td><td style="padding:4px 0; text-align:right; font-weight:700;">${amount}</td></tr>
                            <tr><td style="padding:4px 0; color:#6b7280;">Reference</td><td style="padding:4px 0; text-align:right;">${opRefCode}</td></tr>
                        </table>
                    `, { preheader: 'An investment operational entry has been recorded' }),
                },
            });
        }

        sendCreated(res, {
            reference:      opRefCode,
            entry_type,
            amount,
            balance_before: balanceBefore,
            balance_after:  balanceAfter,
        }, `${entryLabel} recorded. Reference: ${opRefCode}`);
    });
});

// ============================================================
// CREATE PROJECT UNDER INVESTMENT
// POST /api/investments/:id/projects
// ============================================================
const createProject = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const {
        name,
        description,
        category_id,
        planned_budget,
        start_date,
        expected_end_date,
        responsible_user_id,
    } = req.body;

    await withTransaction(async (client) => {
        // Verify investment exists and is active
        const investment = await client.query(`
            SELECT id, status, planned_budget, actual_expenditure, name
            FROM   investments
            WHERE  id = $1
        `, [id]);

        if (investment.rows.length === 0) {
            throw createError.notFound('Investment not found');
        }
        if (investment.rows[0].status === 'CANCELLED') {
            throw createError.badRequest('Cannot add projects to a cancelled investment');
        }

        // Generate project reference: PRJ-PROJECT-YYYYMM-00001
        const { referenceId, referenceCode } = await generateReference(
            client,
            MODULE_CODES.PROJECT,
            'PROJ',
            'PROJECT',
            req.user.id
        );

        const result = await client.query(`
            INSERT INTO projects (
                reference_id,
                investment_id,
                name,
                description,
                category_id,
                planned_budget,
                actual_expenditure,
                status,
                start_date,
                expected_end_date,
                responsible_user_id,
                created_by
            ) VALUES (
                $1, $2, $3, $4, $5, $6, 0,
                'PENDING', $7, $8, $9, $10
            )
            RETURNING id
        `, [
            referenceId,
            id,
            name.trim(),
            description || null,
            category_id,
            planned_budget,
            start_date || null,
            expected_end_date || null,
            responsible_user_id || null,
            req.user.id,
        ]);

        const projectId = result.rows[0].id;
        await linkReferenceToRecord(client, referenceId, projectId);

        await logAction(req.user.id, ACTIONS.PROJECT_CREATED, MODULES.INVESTMENTS, {
            ipAddress:   req.ip,
            recordType:  'projects',
            recordId:    projectId,
            newValues:   { referenceCode, name, planned_budget },
            description: `Project created: ${referenceCode} — ${name}`,
            client,
        });

        sendCreated(res, {
            project_id:    projectId,
            reference:     referenceCode,
            name,
            planned_budget,
            investment:    investment.rows[0].name,
            status:        'PENDING',
        }, `Project created. Reference: ${referenceCode}`);
    });
});

// ============================================================
// ADD PROJECT MILESTONE
// POST /api/investments/:id/projects/:projectId/milestones
// ============================================================
const addMilestone = asyncHandler(async (req, res) => {
    const { projectId } = req.params;
    const { name, description, due_date } = req.body;

    const result = await query(`
        INSERT INTO project_milestones (
            project_id, name, description, due_date,
            status, created_by
        ) VALUES ($1, $2, $3, $4, 'PENDING', $5)
        RETURNING *
    `, [projectId, name.trim(), description || null, due_date, req.user.id]);

    sendCreated(res, result.rows[0], 'Milestone added successfully');
});

// ============================================================
// UPDATE MILESTONE STATUS
// PATCH /api/investments/:id/projects/:projectId/milestones/:milestoneId
// ============================================================
const updateMilestone = asyncHandler(async (req, res) => {
    const { milestoneId, projectId } = req.params;
    const { status, completed_at } = req.body;

    const result = await query(`
        UPDATE project_milestones
        SET    status       = $1,
               completed_at = $2
        WHERE  id         = $3
        AND    project_id = $4
        RETURNING *
    `, [status, completed_at || null, milestoneId, projectId]);

    if (result.rows.length === 0) {
        throw createError.notFound('Milestone not found');
    }

    await logAction(req.user.id, ACTIONS.MILESTONE_UPDATED, MODULES.INVESTMENTS, {
        ipAddress:   req.ip,
        recordType:  'project_milestones',
        recordId:    parseInt(milestoneId),
        newValues:   { status, completed_at },
        description: `Milestone updated to ${status}`,
    });

    sendSuccess(res, result.rows[0], 'Milestone updated successfully');
});

// ============================================================
// UPDATE INVESTMENT STATUS
// PATCH /api/investments/:id/status
// ============================================================
const updateInvestmentStatus = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { status, actual_end_date } = req.body;

    // v1.40.0: PENDING_TERMINATION and TERMINATED are only reachable via
    // the dedicated /terminate/* endpoints below (which enforce the
    // responsible-person-then-Treasurer sign-off workflow) — this
    // generic endpoint must never be used to bypass it. Its own route
    // validator already excludes these two values from the allowed
    // list; this is a second, defense-in-depth check directly in the
    // controller in case that list is ever loosened.
    if (['PENDING_TERMINATION', 'TERMINATED'].includes(status)) {
        throw createError.badRequest(
            'Use the termination workflow (POST /:id/terminate/request, etc.) to close an investment'
        );
    }

    const result = await query(`
        UPDATE investments
        SET    status          = $1,
               actual_end_date = $2
        WHERE  id = $3
        RETURNING id, status, actual_end_date
    `, [status, actual_end_date || null, id]);

    if (result.rows.length === 0) {
        throw createError.notFound('Investment not found');
    }

    sendSuccess(res, result.rows[0], `Investment status updated to ${status}`);
});

// ============================================================
// GET ALL INVESTMENTS
// GET /api/investments
// ============================================================
const getAllInvestments = asyncHandler(async (req, res) => {
    const { status } = req.query;
    const { page, limit, offset } = getPagination(req.query);

    const conditions = [];
    const params = [];
    let p = 0;

    if (status) {
        p++; conditions.push(`i.status = $${p}`);
        params.push(status.toUpperCase());
    }

    const where = conditions.length > 0
        ? 'WHERE ' + conditions.join(' AND ')
        : '';

    const countResult = await query(
        `SELECT COUNT(*) AS total FROM investments i ${where}`, params
    );
    const total = parseInt(countResult.rows[0].total);

    params.push(limit, offset);
    const result = await query(`
        SELECT
            i.id,
            i.name,
            i.description,
            i.planned_budget,
            i.actual_expenditure,
            i.total_returns,
            i.status,
            i.start_date,
            i.expected_end_date,
            i.actual_end_date,
            i.created_at,
            i.created_by,
            i.investment_type,
            i.bond_term_years,
            i.supplementary_budget,
            r.reference_code,
            r.public_id,
            a.name       AS funding_account,
            c.code       AS currency_code,
            c.symbol     AS currency_symbol,
            cat.name     AS category_name,
            cp.full_path AS category_trail,
            u.first_name || ' ' || u.last_name AS responsible_person,
            -- ROI calculation
            CASE
                WHEN i.actual_expenditure > 0 THEN
                    ROUND(((i.total_returns - i.actual_expenditure)
                    / i.actual_expenditure * 100)::numeric, 2)
                ELSE 0
            END AS roi_percentage,
            -- v1.40.0: profit/loss flag (see getInvestmentById for the
            -- identical derivation)
            CASE
                WHEN i.actual_expenditure = 0 THEN 'NOT_YET_FUNDED'
                WHEN i.total_returns > i.actual_expenditure THEN 'PROFITABLE'
                WHEN i.total_returns < i.actual_expenditure THEN 'LOSING'
                ELSE 'BREAK_EVEN'
            END AS performance_status,
            -- Project count
            (
                SELECT COUNT(*) FROM projects p
                WHERE  p.investment_id = i.id
            ) AS project_count
        FROM  investments i
        JOIN  references_registry r ON r.id  = i.reference_id
        JOIN  accounts a            ON a.id  = i.funding_account_id
        JOIN  currencies c          ON c.id  = i.currency_id
        JOIN  categories cat        ON cat.id = i.category_id
        JOIN  category_paths cp     ON cp.category_id = i.category_id
        LEFT JOIN users u           ON u.id  = i.responsible_user_id
        ${where}
        ORDER BY i.created_at DESC
        LIMIT $${p + 1} OFFSET $${p + 2}
    `, params);

    sendPaginated(res, result.rows, total, page, limit);
});

// ============================================================
// GET BEST/WORST PERFORMING INVESTMENT
// GET /api/investments/performance-summary
// Lightweight, company-wide summary (name + ROI% only — no budget
// figures) so it's safe to show on every user's dashboard, not just
// those with full INVESTMENT_VIEW access.
//
// v1.28.0: UNIONs in Money Market Fund sub-accounts (a standalone
// module — see mmfController.js) so MMFs compete on ROI right
// alongside every other investment, per the user's explicit
// requirement that MMF performance "should be compared to
// investments and also appear when its ROI is competitively best or
// worst as the other investments." The MMF ROI formula mirrors the
// investment one exactly, substituting principal-in for expenditure
// and (interest − management fees) for returns:
//   ROUND(((total_interest - total_management_fees)
//          / total_principal_in * 100)::numeric, 2)
// ============================================================
const getPerformanceSummary = asyncHandler(async (req, res) => {
    const result = await query(`
        SELECT id, name, investment_type, status, roi_percentage FROM (
            SELECT
                i.id, i.name, i.investment_type, i.status,
                CASE
                    WHEN i.actual_expenditure > 0 THEN
                        ROUND(((i.total_returns - i.actual_expenditure)
                        / i.actual_expenditure * 100)::numeric, 2)
                    ELSE 0
                END AS roi_percentage
            FROM investments i
            WHERE i.status IN ('ACTIVE', 'COMPLETED')
            AND   i.actual_expenditure > 0

            UNION ALL

            SELECT
                m.id, m.name, 'MMF' AS investment_type, m.status,
                CASE
                    WHEN m.total_principal_in > 0 THEN
                        ROUND(((m.total_interest - m.total_management_fees)
                        / m.total_principal_in * 100)::numeric, 2)
                    ELSE 0
                END AS roi_percentage
            FROM mmf_accounts m
            WHERE m.status IN ('ACTIVE', 'CLOSED')
            AND   m.total_principal_in > 0
        ) combined
        ORDER BY roi_percentage DESC
    `);

    const rows = result.rows;

    sendSuccess(res, {
        best:  rows.length > 0 ? rows[0] : null,
        worst: rows.length > 1 ? rows[rows.length - 1] : null,
        count: rows.length,
    });
});

// ============================================================
// INPUT vs RETURN — per-investment chart data
// GET /api/investments/input-vs-return
// v1.56.0 — feeds the Shareholder Dashboard's "Investment
// Performance" section addition: a chart of amount invested vs
// amount returned, per investment (and per MMF sub-account, same
// UNION pattern as getPerformanceSummary above). Same
// ACTIVE/COMPLETED + funded-only filter as performance-summary, so
// the two sections always agree on which investments are "live"
// enough to chart. Ordered by amount invested, largest first.
// v1.62.0: dropped the LIMIT 10 cap — charts must represent every
// record, not just a page/subset of them (per direct request); the
// frontend line chart this feeds (ShareholderDashboard.jsx) now
// truncates long x-axis labels instead of relying on a short list to
// stay readable, since a bar chart's "one bar per record" layout was
// what actually needed the cap, not the underlying data.
// ============================================================
const getInputVsReturn = asyncHandler(async (req, res) => {
    const result = await query(`
        SELECT id, name, investment_type, invested, returned FROM (
            SELECT
                i.id, i.name, 'INVESTMENT' AS investment_type,
                i.actual_expenditure AS invested,
                i.total_returns      AS returned
            FROM investments i
            WHERE i.status IN ('ACTIVE', 'COMPLETED')
            AND   i.actual_expenditure > 0

            UNION ALL

            SELECT
                m.id, m.name, 'MMF' AS investment_type,
                m.total_principal_in AS invested,
                (m.total_interest - m.total_management_fees) AS returned
            FROM mmf_accounts m
            WHERE m.status IN ('ACTIVE', 'CLOSED')
            AND   m.total_principal_in > 0
        ) combined
        ORDER BY invested DESC
    `);

    sendSuccess(res, result.rows.map(r => ({
        id:              r.id,
        name:            r.name,
        investmentType:  r.investment_type,
        invested:        parseFloat(r.invested),
        returned:        parseFloat(r.returned),
    })));
});

// ============================================================
// PORTFOLIO SUMMARY — headline figures + status breakdown (v1.57.0,
// currency fix in v1.57.1, unified with MMF in v1.60.0)
// GET /api/investments/portfolio-summary
// Feeds the new "Portfolio Overview" section at the top of the
// Investments page: total planned budget/spent/returns, overall
// ROI%, and a count per status for the donut chart.
//
// v1.57.1 fix: this originally scoped the money totals to the
// PRIMARY account's own currency, copying the convention used by
// accountsController.getInflowOutflowTrend and
// usersController.getMyPaymentLedger. That assumption doesn't hold
// here — an investment's funding_account can be ANY account, not
// necessarily the Primary one, and in the reported case every real
// investment was funded through a UGX account while the Primary
// account itself was EUR, so filtering by "the Primary account's
// currency" matched zero rows and every headline figure silently
// showed EUR 0 despite real investments existing. Fixed by picking
// the currency the portfolio's own money is actually IN — whichever
// currency has the largest total actual_expenditure across
// investments — rather than an unrelated account's currency. The
// three plain COUNTS (total/active/bond) and the status breakdown
// are also no longer currency-filtered at all, since a count doesn't
// need a common currency to be meaningful the way a money sum does —
// only the three money totals (planned budget/spent/returns) and the
// ROI% derived from them stay scoped to the one dominant currency —
// a portfolio genuinely spanning a second currency in real volume
// will have that portion excluded from the money totals, a known,
// documented simplification (same class of limitation as every other
// single-base-currency summary this session), not a silent zero.
//
// v1.60.0: folds in Money Market Fund sub-accounts (mmf_accounts) so
// this headline summary treats Investments and MMF as one pool —
// "the stats shall also be treated as one category not two," per the
// direct request. Mirrors the UNION pattern getPerformanceSummary/
// getInputVsReturn already used for MMF: an MMF's total_principal_in
// stands in for actual_expenditure/"invested", and
// (total_interest - total_management_fees) stands in for
// total_returns — MMF has no planned_budget equivalent, so that
// figure stays investments-only. mmf_accounts.status only ever has
// two values (ACTIVE/CLOSED), both of which also appear on
// investments, so the byStatus breakdown below is a genuine combined
// count per status, not two separate lists stitched together.
// ============================================================
const getPortfolioSummary = asyncHandler(async (req, res) => {
    const countsResult = await query(`
        SELECT
            (SELECT COUNT(*) FROM investments) +
            (SELECT COUNT(*) FROM mmf_accounts)                          AS total_count,
            (SELECT COUNT(*) FROM investments WHERE status = 'ACTIVE') +
            (SELECT COUNT(*) FROM mmf_accounts WHERE status = 'ACTIVE')  AS active_count,
            (SELECT COUNT(*) FROM investments WHERE investment_type = 'BOND') AS bond_count,
            (SELECT COUNT(*) FROM mmf_accounts)                          AS mmf_count
    `);
    const c = countsResult.rows[0];

    const byStatusResult = await query(`
        SELECT status, COUNT(*) AS count
        FROM (
            SELECT status FROM investments
            UNION ALL
            SELECT status FROM mmf_accounts
        ) combined
        GROUP  BY status
        ORDER  BY count DESC
    `);

    // Whichever currency the combined portfolio's money is actually
    // denominated in, by total amount invested (investments'
    // actual_expenditure + MMF's total_principal_in) — not an
    // unrelated account's currency.
    const dominantCurrencyResult = await query(`
        SELECT currency_id, cur.code AS currency_code
        FROM (
            SELECT currency_id, SUM(amt) AS total_invested
            FROM (
                SELECT currency_id, actual_expenditure AS amt FROM investments
                UNION ALL
                SELECT currency_id, total_principal_in AS amt FROM mmf_accounts
            ) combined
            GROUP BY currency_id
        ) totals
        JOIN currencies cur ON cur.id = totals.currency_id
        ORDER BY total_invested DESC
        LIMIT 1
    `);
    const dominantCurrency = dominantCurrencyResult.rows[0] || null;

    let totalPlannedBudget = 0, totalActualExpenditure = 0, totalReturns = 0;
    if (dominantCurrency) {
        const totalsResult = await query(`
            SELECT
                COALESCE((SELECT SUM(planned_budget) FROM investments WHERE currency_id = $1), 0)
                    AS total_planned_budget,
                COALESCE((SELECT SUM(actual_expenditure) FROM investments WHERE currency_id = $1), 0) +
                COALESCE((SELECT SUM(total_principal_in) FROM mmf_accounts WHERE currency_id = $1), 0)
                    AS total_actual_expenditure,
                COALESCE((SELECT SUM(total_returns) FROM investments WHERE currency_id = $1), 0) +
                COALESCE((SELECT SUM(total_interest - total_management_fees) FROM mmf_accounts WHERE currency_id = $1), 0)
                    AS total_returns
        `, [dominantCurrency.currency_id]);
        const t = totalsResult.rows[0];
        totalPlannedBudget     = parseFloat(t.total_planned_budget);
        totalActualExpenditure = parseFloat(t.total_actual_expenditure);
        totalReturns            = parseFloat(t.total_returns);
    }

    const overallRoi = totalActualExpenditure > 0
        ? Math.round(((totalReturns - totalActualExpenditure) / totalActualExpenditure) * 1000) / 10
        : 0;

    sendSuccess(res, {
        currencyCode:           dominantCurrency?.currency_code || null,
        totalCount:             parseInt(c.total_count),
        activeCount:            parseInt(c.active_count),
        bondCount:              parseInt(c.bond_count),
        mmfCount:               parseInt(c.mmf_count),
        totalPlannedBudget,
        totalActualExpenditure,
        totalReturns,
        overallRoiPercentage:   overallRoi,
        byStatus: byStatusResult.rows.map(r => ({
            status: r.status,
            count:  parseInt(r.count),
        })),
    });
});

// ============================================================
// GET SINGLE INVESTMENT WITH FULL DETAILS
// GET /api/investments/:id
// ============================================================
const getInvestmentById = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const result = await query(`
        SELECT
            i.*,
            r.reference_code,
            r.public_id,
            a.name       AS funding_account_name,
            c.code       AS currency_code,
            c.symbol     AS currency_symbol,
            cat.name     AS category_name,
            cp.full_path AS category_trail,
            creator.first_name  || ' ' || creator.last_name  AS created_by_name,
            approver.first_name || ' ' || approver.last_name AS approved_by_name,
            responsible.first_name || ' ' || responsible.last_name AS responsible_name,
            term_req.first_name  || ' ' || term_req.last_name  AS termination_requested_by_name,
            term_conf.first_name || ' ' || term_conf.last_name AS records_confirmed_by_name,
            term_appr.first_name || ' ' || term_appr.last_name AS termination_approved_by_name,
            -- ROI
            CASE
                WHEN i.actual_expenditure > 0 THEN
                    ROUND(((i.total_returns - i.actual_expenditure)
                    / i.actual_expenditure * 100)::numeric, 2)
                ELSE 0
            END AS roi_percentage,
            -- v1.40.0: profit/loss flag — derived from the same figures
            -- as roi_percentage, no separate stored field.
            CASE
                WHEN i.actual_expenditure = 0 THEN 'NOT_YET_FUNDED'
                WHEN i.total_returns > i.actual_expenditure THEN 'PROFITABLE'
                WHEN i.total_returns < i.actual_expenditure THEN 'LOSING'
                ELSE 'BREAK_EVEN'
            END AS performance_status,
            -- v1.40.0: bond settlement discount/premium — % of face value
            -- actually paid, and the amount saved (discount, positive)
            -- or paid extra (premium, negative). NULL when no
            -- settlement_value is set (bond bought at par).
            CASE
                WHEN i.settlement_value IS NOT NULL AND i.face_value > 0 THEN
                    ROUND((i.settlement_value / i.face_value * 100)::numeric, 4)
                ELSE NULL
            END AS settlement_percentage,
            CASE
                WHEN i.settlement_value IS NOT NULL THEN i.face_value - i.settlement_value
                ELSE NULL
            END AS settlement_discount_amount,
            -- Projects
            (
                SELECT json_agg(p_data ORDER BY p_data.created_at ASC)
                FROM (
                    SELECT
                        p.id, p.name, p.planned_budget,
                        p.actual_expenditure, p.status,
                        p.start_date, p.expected_end_date, p.created_at,
                        pr.reference_code AS project_reference,
                        -- Milestone summary
                        (SELECT COUNT(*) FROM project_milestones pm
                         WHERE pm.project_id = p.id) AS total_milestones,
                        (SELECT COUNT(*) FROM project_milestones pm
                         WHERE pm.project_id = p.id
                         AND   pm.status = 'COMPLETED') AS completed_milestones
                    FROM projects p
                    JOIN references_registry pr ON pr.id = p.reference_id
                    WHERE p.investment_id = i.id
                ) p_data
            ) AS projects,
            -- Returns summary (profit/income trail — who recorded it, and when)
            (
                SELECT json_agg(ret_data ORDER BY ret_data.return_date ASC)
                FROM (
                    SELECT
                        ir.id, ir.return_type, ir.amount,
                        ir.return_date, ir.notes, ir.created_at,
                        ir.is_reversed, ir.reversed_at,
                        rr.reference_code AS return_reference,
                        retcreator.first_name || ' ' || retcreator.last_name AS recorded_by_name
                    FROM investment_returns ir
                    JOIN references_registry rr ON rr.id = ir.reference_id
                    JOIN users retcreator        ON retcreator.id = ir.created_by
                    WHERE ir.investment_id = i.id
                ) ret_data
            ) AS returns,
            -- Bond coupon schedule (only populated for investment_type = 'BOND')
            (
                SELECT json_agg(bc_data ORDER BY bc_data.coupon_number ASC)
                FROM (
                    SELECT
                        bc.id, bc.coupon_number, bc.due_date,
                        bc.gross_amount, bc.tax_amount, bc.net_amount,
                        bc.status, bc.paid_at,
                        bc.actual_gross_amount, bc.actual_tax_amount, bc.actual_net_amount,
                        bc.adjusted_at,
                        adjuster.first_name || ' ' || adjuster.last_name AS adjusted_by_name
                    FROM bond_coupons bc
                    LEFT JOIN users adjuster ON adjuster.id = bc.adjusted_by
                    WHERE bc.investment_id = i.id
                ) bc_data
            ) AS coupons,
            -- Operational transactions (expenses / extra inflows / tax
            -- recorded directly against this investment's own budget)
            (
                SELECT json_agg(op_data ORDER BY op_data.entry_date ASC)
                FROM (
                    SELECT
                        it.id, it.entry_type, it.amount, it.description,
                        it.entry_date, it.created_at,
                        it.is_reversed, it.reversed_at,
                        opr.reference_code AS reference_code,
                        opcreator.first_name || ' ' || opcreator.last_name AS recorded_by_name
                    FROM investment_transactions it
                    JOIN references_registry opr ON opr.id = it.reference_id
                    JOIN users opcreator          ON opcreator.id = it.created_by
                    WHERE it.investment_id = i.id
                ) op_data
            ) AS operations,
            -- Operational budget summary: operating capital funded into the
            -- investment, plus scheduled/manual returns and any extra
            -- operational inflows, minus operational expenses and tax —
            -- gives the running balance of unspent operating capital.
            COALESCE((
                SELECT SUM(it.amount) FROM investment_transactions it
                WHERE it.investment_id = i.id AND it.entry_type = 'INFLOW' AND it.is_reversed = FALSE
            ), 0) AS operational_inflows,
            COALESCE((
                SELECT SUM(it.amount) FROM investment_transactions it
                WHERE it.investment_id = i.id AND it.entry_type = 'EXPENSE' AND it.is_reversed = FALSE
            ), 0) AS operational_expenses,
            COALESCE((
                SELECT SUM(it.amount) FROM investment_transactions it
                WHERE it.investment_id = i.id AND it.entry_type = 'TAX' AND it.is_reversed = FALSE
            ), 0) AS operational_tax
        FROM  investments i
        JOIN  references_registry r    ON r.id  = i.reference_id
        JOIN  accounts a               ON a.id  = i.funding_account_id
        JOIN  currencies c             ON c.id  = i.currency_id
        JOIN  categories cat           ON cat.id = i.category_id
        JOIN  category_paths cp        ON cp.category_id = i.category_id
        JOIN  users creator            ON creator.id = i.created_by
        LEFT JOIN users approver       ON approver.id = i.approved_by
        LEFT JOIN users responsible    ON responsible.id = i.responsible_user_id
        LEFT JOIN users term_req       ON term_req.id  = i.termination_requested_by
        LEFT JOIN users term_conf      ON term_conf.id = i.records_confirmed_by
        LEFT JOIN users term_appr      ON term_appr.id = i.termination_approved_by
        WHERE i.id = $1
    `, [id]);

    if (result.rows.length === 0) {
        throw createError.notFound('Investment not found');
    }

    const investment = result.rows[0];

    // Operational budget summary — operating capital funded in, plus all
    // income (scheduled/manual returns + extra operational inflows),
    // minus operational expenses and tax. What's left is the running
    // balance of operating capital not yet spent.
    const operatingCapital     = parseFloat(investment.actual_expenditure) || 0;
    const scheduledReturns     = parseFloat(investment.total_returns) || 0;
    const operationalInflows   = parseFloat(investment.operational_inflows) || 0;
    const operationalExpenses  = parseFloat(investment.operational_expenses) || 0;
    const operationalTax       = parseFloat(investment.operational_tax) || 0;

    investment.operating_budget = {
        operating_capital:    operatingCapital,
        total_income:         scheduledReturns + operationalInflows,
        total_expenses:       operationalExpenses,
        total_tax:            operationalTax,
        running_balance:      operatingCapital + scheduledReturns +
                               operationalInflows - operationalExpenses - operationalTax,
    };

    sendSuccess(res, investment);
});

// ============================================================
// PAY BOND COUPON
// PATCH /api/investments/:id/coupons/:couponId/pay
// Marks one scheduled coupon payment as received. Posts TWO ledger
// entries rather than one: a credit for the GROSS interest (the true
// income earned — recorded as an investment_returns INTEREST row) and,
// if tax was withheld, a debit for the TAX (recorded as an
// investment_transactions TAX entry, the same convention already used
// for a STANDARD investment's own tax entries). The bond issuer never
// actually pays the gross amount into the account — only the net lands
// there — but crediting gross then debiting tax nets to exactly the
// real cash received while keeping interest income and tax withheld
// separately visible and auditable, instead of silently netting them
// into one opaque figure.
// ============================================================
const payBondCoupon = asyncHandler(async (req, res) => {
    const { id, couponId } = req.params;
    const { paid_date, notes, actual_gross_amount } = req.body;

    await withTransaction(async (client) => {
        const investResult = await client.query(`
            SELECT i.*, a.currency_id, a.account_type, a.reference_prefix, r.reference_code, r.public_id
            FROM   investments i
            JOIN   accounts a ON a.id = i.funding_account_id
            JOIN   references_registry r ON r.id = i.reference_id
            WHERE  i.id = $1
            FOR UPDATE
        `, [id]);

        if (investResult.rows.length === 0) {
            throw createError.notFound('Investment not found');
        }
        const investment = investResult.rows[0];

        if (investment.investment_type !== 'BOND') {
            throw createError.badRequest('This investment does not have a bond coupon schedule');
        }

        if (!MUTABLE_INVESTMENT_STATUSES.includes(investment.status)) {
            throw createError.badRequest(
                'Coupons can only be paid on an active investment, or one currently under termination review'
            );
        }

        const couponResult = await client.query(`
            SELECT * FROM bond_coupons
            WHERE  id = $1 AND investment_id = $2
            FOR UPDATE
        `, [couponId, id]);

        if (couponResult.rows.length === 0) {
            throw createError.notFound('Coupon not found');
        }
        const coupon = couponResult.rows[0];

        if (coupon.status === 'PAID') {
            throw createError.badRequest('This coupon has already been marked paid');
        }

        // v1.40.0: a coupon can only be paid on or after its due date —
        // this button (and the "Record Actual Payment" variant below)
        // must never be usable to approve a future payment.
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const dueDate = new Date(coupon.due_date); dueDate.setHours(0, 0, 0, 0);
        if (dueDate > today) {
            throw createError.badRequest(
                `This coupon is not due until ${coupon.due_date} — it cannot be marked paid before then`
            );
        }

        const paymentDate = paid_date || coupon.due_date;

        // v1.40.0: "Record Actual Payment" — the amount actually
        // received differs from what was scheduled (a bond can pay out
        // differently from the coupon math for reasons determined
        // outside the system). Tax is auto-recalculated on the new
        // gross amount using the bond's own tax_withholding_rate; the
        // rest of the coupon schedule (other coupons) is untouched.
        const isAdjusted = actual_gross_amount !== undefined && actual_gross_amount !== null;
        const grossAmount = isAdjusted ? parseFloat(actual_gross_amount) : parseFloat(coupon.gross_amount);
        const taxRate     = parseFloat(investment.tax_withholding_rate) || 0;
        const taxAmount   = isAdjusted ? round2(grossAmount * (taxRate / 100)) : (parseFloat(coupon.tax_amount) || 0);
        const netAmount   = isAdjusted ? round2(grossAmount - taxAmount) : parseFloat(coupon.net_amount);

        // --- 1. Gross interest — the true income earned on the bond ---
        const { referenceId: retRefId, referenceCode: retRefCode } =
            await generateReference(
                client,
                MODULE_CODES.INVESTMENT,
                'RETURN',
                'INVESTMENT_RETURN',
                req.user.id
            );

        const { referenceId: txRefId } = await generateReference(
            client,
            resolveModuleCode(investment),
            'INVEST-IN',
            'TRANSACTION',
            req.user.id
        );

        const { transactionId, balanceBefore, balanceAfter } = await postTransaction(client, {
            accountId:       investment.returns_account_id,
            transactionType: 'CREDIT',
            inflowType:      'INVESTMENT_RETURN',
            amount:          grossAmount,
            currencyId:      investment.currency_id,
            categoryId:      investment.category_id,
            description:     `Bond coupon #${coupon.coupon_number} interest — ` +
                             `${investment.name} (${investment.reference_code})`,
            valueDate:       paymentDate,
            createdBy:       req.user.id,
            referenceId:     txRefId,
            investmentId:    investment.id,
        });

        await linkReferenceToRecord(client, txRefId, transactionId);

        const returnNotes = notes ||
            (isAdjusted
                ? `Coupon #${coupon.coupon_number} (ACTUAL, scheduled was ${parseFloat(coupon.gross_amount)}): ` +
                  `gross ${grossAmount}, tax withheld ${taxAmount}, net ${netAmount}`
                : `Coupon #${coupon.coupon_number}: gross ${grossAmount}, ` +
                  `tax withheld ${taxAmount}, net ${netAmount}`);

        const returnResult = await client.query(`
            INSERT INTO investment_returns (
                reference_id, investment_id, transaction_id,
                return_type, amount, return_date, notes, created_by
            ) VALUES ($1, $2, $3, 'INTEREST', $4, $5, $6, $7)
            RETURNING id
        `, [
            retRefId, id, transactionId,
            grossAmount, paymentDate,
            returnNotes, req.user.id,
        ]);

        await linkReferenceToRecord(client, retRefId, returnResult.rows[0].id);

        await client.query(`
            UPDATE investments
            SET    total_returns = total_returns + $1
            WHERE  id = $2
        `, [grossAmount, id]);

        // --- 2. Tax withheld — its own debit + investment_transactions
        // TAX entry, only if this bond actually withholds tax ---
        let finalBalanceAfter = balanceAfter;
        if (taxAmount > 0) {
            const { referenceId: taxOpRefId } =
                await generateReference(
                    client,
                    MODULE_CODES.INVESTMENT,
                    'INV-OP',
                    'INVESTMENT_TRANSACTION',
                    req.user.id
                );

            const { referenceId: taxTxRefId } = await generateReference(
                client,
                resolveModuleCode(investment),
                'INVEST-OP-OUT',
                'TRANSACTION',
                req.user.id
            );

            // v1.70.0 — the coupon's withholding tax is income tax deducted
            // at source (FINAL for government bonds), booked to 5700 — not
            // money invested (1400) as before — and kept in the register of
            // tax deducted from the company.
            const taxPosted = await postTransaction(client, {
                accountId:       investment.returns_account_id,
                transactionType: 'DEBIT',
                inflowType:      'EXPENSE',
                amount:          taxAmount,
                currencyId:      investment.currency_id,
                categoryId:      investment.category_id,
                description:     `Bond coupon #${coupon.coupon_number} withholding tax — ` +
                                 `${investment.name} (${investment.reference_code})`,
                valueDate:       paymentDate,
                createdBy:       req.user.id,
                referenceId:     taxTxRefId,
                investmentId:    investment.id,
                glOverrideAccountCode: taxService.TAX_GL.FINAL_TAX,
            });
            finalBalanceAfter = taxPosted.balanceAfter;

            await linkReferenceToRecord(client, taxTxRefId, taxPosted.transactionId);

            await taxService.recordTaxAtSource(client, {
                sourceType: 'BOND_COUPON', payerName: investment.name, investmentId: investment.id,
                bondCouponId: coupon.id, incomeTransactionId: transactionId, taxTransactionId: taxPosted.transactionId,
                cashLeg: true,
                rateCode: parseInt(investment.bond_term_years) >= 10 ? 'WHT_GOV_SECURITIES_LONG' : 'WHT_GOV_SECURITIES_SHORT',
                rate: taxRate || null, treatment: 'FINAL',
                gross: grossAmount, tax: taxAmount, currencyId: investment.currency_id, date: paymentDate,
                userId: req.user.id,
            });

            const taxOpResult = await client.query(`
                INSERT INTO investment_transactions (
                    reference_id, investment_id, transaction_id,
                    entry_type, amount, description, entry_date, created_by
                ) VALUES ($1, $2, $3, 'TAX', $4, $5, $6, $7)
                RETURNING id
            `, [
                taxOpRefId, id, taxPosted.transactionId, taxAmount,
                `Withholding tax on bond coupon #${coupon.coupon_number}`,
                paymentDate, req.user.id,
            ]);

            await linkReferenceToRecord(client, taxOpRefId, taxOpResult.rows[0].id);

            // v1.40.0 fix: withholding tax is real money spent on this
            // investment's behalf — count it toward "Spent", same as
            // any other operational TAX entry (see
            // recordInvestmentTransaction for the identical fix).
            const { newExpenditure, supplementaryDelta } = computeSupplementaryOverage(
                investment.planned_budget, investment.actual_expenditure, taxAmount
            );
            await client.query(`
                UPDATE investments
                SET    actual_expenditure   = $1,
                       supplementary_budget = supplementary_budget + $2
                WHERE  id = $3
            `, [newExpenditure, supplementaryDelta, id]);
        }

        await client.query(`
            UPDATE bond_coupons
            SET    status = 'PAID',
                   investment_return_id = $1,
                   paid_at = NOW(),
                   actual_gross_amount = $2,
                   actual_tax_amount   = $3,
                   actual_net_amount   = $4,
                   adjusted_by         = $5,
                   adjusted_at         = $6
            WHERE  id = $7
        `, [
            returnResult.rows[0].id,
            isAdjusted ? grossAmount : null,
            isAdjusted ? taxAmount   : null,
            isAdjusted ? netAmount   : null,
            isAdjusted ? req.user.id : null,
            isAdjusted ? new Date()  : null,
            couponId,
        ]);

        // --- 3. Face value repayment — v1.42.0. A bond returns its
        // principal at maturity alongside the final coupon's interest;
        // previously this controller never credited it at all. "Final"
        // is determined by coupon_number, not by due_date, so it stays
        // correct even if the schedule was edited/rescheduled after
        // this coupon's row was first created. Credited at FACE VALUE
        // always — settlement_value only ever affected what was paid
        // to acquire the bond, never what's owed back at maturity.
        // Deliberately NOT added to investments.total_returns: that
        // figure drives roi_percentage/performance_status, and getting
        // your own principal back is not profit — folding it in would
        // make ROI look wildly (and wrongly) inflated the moment a
        // bond matures.
        let principalRepaid = null;
        let completedAtMaturity = false;
        const maxCouponResult = await client.query(
            'SELECT MAX(coupon_number) AS max_num FROM bond_coupons WHERE investment_id = $1',
            [id]
        );
        const isFinalCoupon = coupon.coupon_number === parseInt(maxCouponResult.rows[0].max_num);

        if (isFinalCoupon) {
            const faceValue = parseFloat(investment.face_value);

            const { referenceId: prinRefId, referenceCode: prinRefCode } =
                await generateReference(client, MODULE_CODES.INVESTMENT, 'PRINCIPAL', 'INVESTMENT_RETURN', req.user.id);
            const { referenceId: prinTxRefId } =
                await generateReference(client, resolveModuleCode(investment), 'INVEST-IN', 'TRANSACTION', req.user.id);

            const prinPosted = await postTransaction(client, {
                accountId:       investment.returns_account_id,
                transactionType: 'CREDIT',
                inflowType:      'INVESTMENT_RETURN',
                amount:          faceValue,
                currencyId:      investment.currency_id,
                categoryId:      investment.category_id,
                description:     `Bond face value repaid at maturity — ${investment.name} (${investment.reference_code})`,
                valueDate:       paymentDate,
                createdBy:       req.user.id,
                referenceId:     prinTxRefId,
                investmentId:    investment.id,
                // v1.70.0 — the company's own money back, not income.
                glOverrideAccountCode: '1400',
            });
            finalBalanceAfter = prinPosted.balanceAfter;

            await linkReferenceToRecord(client, prinTxRefId, prinPosted.transactionId);

            const prinReturnResult = await client.query(`
                INSERT INTO investment_returns (
                    reference_id, investment_id, transaction_id,
                    return_type, amount, return_date, notes, created_by
                ) VALUES ($1, $2, $3, 'PRINCIPAL', $4, $5, $6, $7)
                RETURNING id
            `, [
                prinRefId, id, prinPosted.transactionId, faceValue, paymentDate,
                `Face value (principal) repaid alongside final coupon #${coupon.coupon_number}`,
                req.user.id,
            ]);
            await linkReferenceToRecord(client, prinRefId, prinReturnResult.rows[0].id);

            principalRepaid = { referenceCode: prinRefCode, amount: faceValue };

            await logAction(req.user.id, ACTIONS.INVESTMENT_PRINCIPAL_REPAID, MODULES.INVESTMENTS, {
                ipAddress:   req.ip,
                recordType:  'investment_returns',
                recordId:    prinReturnResult.rows[0].id,
                newValues:   { referenceCode: prinRefCode, amount: faceValue },
                description: `Bond face value repaid at maturity: ${prinRefCode} — ${faceValue} (investment ID ${id})`,
                client,
            });

            // A matured bond that's just had its final coupon AND its
            // principal repaid has nothing left to do — automatically
            // close it out, the same way a natural conclusion (rather
            // than an early termination) should look. Only from ACTIVE
            // — if it's mid termination-review (PENDING_TERMINATION),
            // that workflow owns the final status, not this.
            if (investment.status === 'ACTIVE') {
                await client.query(`
                    UPDATE investments
                    SET    status = 'COMPLETED', actual_end_date = $1
                    WHERE  id = $2 AND status = 'ACTIVE'
                `, [paymentDate, id]);
                completedAtMaturity = true;

                await logAction(req.user.id, ACTIONS.INVESTMENT_COMPLETED_AT_MATURITY, MODULES.INVESTMENTS, {
                    ipAddress:   req.ip,
                    recordType:  'investments',
                    recordId:    parseInt(id),
                    description: `Investment automatically marked COMPLETED at maturity: ID ${id}`,
                    client,
                });
            }
        }

        await logAction(req.user.id, isAdjusted ? ACTIONS.INVESTMENT_COUPON_ADJUSTED : ACTIONS.INVESTMENT_RETURN, MODULES.INVESTMENTS, {
            ipAddress:   req.ip,
            recordType:  'bond_coupons',
            recordId:    coupon.id,
            newValues:   {
                retRefCode, coupon_number: coupon.coupon_number,
                scheduled_gross_amount: parseFloat(coupon.gross_amount),
                gross_amount: grossAmount, tax_amount: taxAmount, net_amount: netAmount,
                is_adjusted: isAdjusted, balanceBefore, balanceAfter: finalBalanceAfter,
                is_final_coupon: isFinalCoupon, principal_repaid: principalRepaid,
            },
            description: isAdjusted
                ? `Bond coupon #${coupon.coupon_number} paid with ACTUAL amount: ${retRefCode} — gross ${grossAmount} (scheduled ${parseFloat(coupon.gross_amount)}), tax ${taxAmount}, net ${netAmount}`
                : `Bond coupon #${coupon.coupon_number} paid: ${retRefCode} — gross ${grossAmount}, tax ${taxAmount}, net ${netAmount}`,
            client,
        });

        sendSuccess(res, {
            coupon_id:            coupon.id,
            coupon_number:        coupon.coupon_number,
            return_reference:     retRefCode,
            gross_amount:         grossAmount,
            tax_amount:           taxAmount,
            net_amount:           netAmount,
            is_adjusted:          isAdjusted,
            balance_before:       balanceBefore,
            balance_after:        finalBalanceAfter,
            is_final_coupon:      isFinalCoupon,
            principal_repaid:     principalRepaid,
            completed_at_maturity: completedAtMaturity,
        }, principalRepaid
            ? `Coupon #${coupon.coupon_number} marked paid, and face value ${principalRepaid.amount} repaid at maturity. Reference: ${retRefCode}`
            : `Coupon #${coupon.coupon_number} marked paid. Reference: ${retRefCode}`);
    });
});

// ============================================================
// TREASURY BILL MATURITY (v1.70.0)
// POST /api/investments/:id/treasury-bill-maturity
// A treasury bill is bought below its face value and repaid at face
// value on its maturity date. The difference (the discount) is interest
// income; tax on it (20% for bills, FINAL tax) is taken either
//   AT_MATURITY — out of the maturity proceeds (the company receives
//                 face value minus the tax), or
//   AT_PURCHASE — added to the price when the bill was bought (the
//                 funding then included it; the company receives the
//                 full face value).
// Posted here:
//   - the proceeds, as a PRINCIPAL return (the company's own money back,
//     1400), gross of any tax taken at maturity;
//   - AT_MATURITY: the tax as its own leg (5700), AT_PURCHASE: the tax is
//     moved out of the bill's cost (Dr 5700 / Cr 1400, no cash);
//   - a row in the register of tax deducted from the company (FINAL).
// The bill is then COMPLETED; the ledger's investment closure entry turns
// what is left in 1400 (face value above the price paid) into investment
// income — the discount.
// ============================================================
const recordTreasuryBillMaturity = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { maturity_date, amount_received, tax_amount, notes, tax_certificate_number } = req.body;

    await withTransaction(async (client) => {
        const investResult = await client.query(`
            SELECT i.*, a.currency_id, a.account_type, a.reference_prefix, r.reference_code
            FROM   investments i
            JOIN   accounts a ON a.id = i.funding_account_id
            JOIN   references_registry r ON r.id = i.reference_id
            WHERE  i.id = $1
            FOR UPDATE OF i
        `, [id]);
        if (investResult.rows.length === 0) throw createError.notFound('Investment not found');
        const inv = investResult.rows[0];
        if (inv.investment_type !== 'TREASURY_BILL') throw createError.badRequest('This investment is not a treasury bill');
        if (!MUTABLE_INVESTMENT_STATUSES.includes(inv.status)) {
            throw createError.badRequest('Maturity can only be recorded on an active treasury bill (or one under termination review)');
        }
        const already = await client.query(`SELECT 1 FROM investment_returns WHERE investment_id = $1 AND return_type = 'PRINCIPAL' AND is_reversed = FALSE`, [id]);
        if (already.rows.length) throw createError.badRequest('The maturity of this treasury bill has already been recorded');

        const date = maturity_date || dateOnly(inv.expected_end_date);
        if (date > new Date().toISOString().slice(0, 10)) {
            throw createError.badRequest(`This bill matures on ${date}; its maturity can't be recorded before then.`);
        }
        if (!date) throw createError.badRequest('Enter the maturity date');
        const face = parseFloat(inv.face_value);
        const price = parseFloat(inv.settlement_value);
        const rate = parseFloat(inv.tax_withholding_rate) || 0;
        const timing = inv.tbill_tax_timing || 'AT_MATURITY';
        const discount = round2(face - price);
        const tax = tax_amount !== undefined && tax_amount !== null && tax_amount !== ''
            ? round2(parseFloat(tax_amount)) : round2(discount * rate / 100);
        if (tax < 0) throw createError.badRequest('Tax cannot be negative');

        // Gross proceeds = what was repaid before any tax taken at maturity.
        const received = amount_received !== undefined && amount_received !== null && amount_received !== ''
            ? parseFloat(amount_received) : (timing === 'AT_MATURITY' ? round2(face - tax) : face);
        const grossProceeds = timing === 'AT_MATURITY' ? round2(received + tax) : round2(received);
        const discountEarned = round2(grossProceeds - price);

        const { referenceId: retRefId, referenceCode: retRefCode } =
            await generateReference(client, MODULE_CODES.INVESTMENT, 'PRINCIPAL', 'INVESTMENT_RETURN', req.user.id);
        const { referenceId: txRefId } =
            await generateReference(client, resolveModuleCode(inv), 'INVEST-IN', 'TRANSACTION', req.user.id);
        const posted = await postTransaction(client, {
            accountId: inv.returns_account_id, transactionType: 'CREDIT', inflowType: 'INVESTMENT_RETURN',
            amount: grossProceeds, currencyId: inv.currency_id, categoryId: inv.category_id,
            description: `Treasury bill matured — face value repaid: ${inv.name} (${inv.reference_code})`,
            valueDate: date, createdBy: req.user.id, referenceId: txRefId, investmentId: inv.id,
            glOverrideAccountCode: '1400',
        });
        await linkReferenceToRecord(client, txRefId, posted.transactionId);
        let balanceAfter = posted.balanceAfter;

        const ret = await client.query(`
            INSERT INTO investment_returns (reference_id, investment_id, transaction_id, return_type, amount, return_date, notes, created_by)
            VALUES ($1, $2, $3, 'PRINCIPAL', $4, $5, $6, $7) RETURNING id
        `, [retRefId, id, posted.transactionId, grossProceeds, date,
            notes || `Treasury bill maturity: face ${face}, price paid ${price}, discount ${discountEarned}, tax ${tax} (${timing === 'AT_MATURITY' ? 'deducted from the proceeds' : 'paid with the purchase'})`,
            req.user.id]);
        await linkReferenceToRecord(client, retRefId, ret.rows[0].id);

        let taxRecord = null;
        if (tax > 0) {
            let taxTxId = null;
            if (timing === 'AT_MATURITY') {
                const leg = await taxService.postTaxLeg(client, {
                    accountId: inv.returns_account_id, currencyId: inv.currency_id, amount: tax, date,
                    treatment: 'FINAL', categoryId: inv.category_id, investmentId: inv.id,
                    description: `Treasury bill tax deducted at maturity (final) — ${inv.name} (${inv.reference_code})`,
                    userId: req.user.id,
                });
                taxTxId = leg.transactionId;
                balanceAfter = leg.balanceAfter;
                const { referenceId: opRef } = await generateReference(client, MODULE_CODES.INVESTMENT, 'INV-OP', 'INVESTMENT_TRANSACTION', req.user.id);
                await client.query(`
                    INSERT INTO investment_transactions (reference_id, investment_id, transaction_id, entry_type, amount, description, entry_date, created_by)
                    VALUES ($1, $2, $3, 'TAX', $4, $5, $6, $7)
                `, [opRef, id, leg.transactionId, tax, 'Tax on treasury bill discount (deducted at maturity)', date, req.user.id]);
            }
            taxRecord = await taxService.recordTaxAtSource(client, {
                sourceType: 'TREASURY_BILL', payerName: inv.name, investmentId: inv.id,
                incomeTransactionId: posted.transactionId, taxTransactionId: taxTxId,
                cashLeg: timing === 'AT_MATURITY', contraGlCode: timing === 'AT_MATURITY' ? null : '1400',
                rateCode: 'WHT_GOV_SECURITIES_SHORT', rate: rate || null, treatment: 'FINAL',
                gross: discountEarned > 0 ? discountEarned : tax, tax, currencyId: inv.currency_id, date,
                certificateNumber: tax_certificate_number || null, userId: req.user.id,
                notes: timing === 'AT_PURCHASE' ? 'Tax was paid with the purchase price (included in the funding).' : null,
            });
        }

        // The discount is the bill's income (for its ROI figures).
        await client.query(`
            UPDATE investments
            SET    total_returns = total_returns + $1,
                   status = CASE WHEN status = 'ACTIVE' THEN 'COMPLETED' ELSE status END,
                   actual_end_date = CASE WHEN status = 'ACTIVE' THEN $2::date ELSE actual_end_date END
            WHERE  id = $3
        `, [Math.max(0, discountEarned), date, id]);

        await logAction(req.user.id, ACTIONS.INVESTMENT_PRINCIPAL_REPAID, MODULES.INVESTMENTS, {
            ipAddress: req.ip, recordType: 'investment_returns', recordId: ret.rows[0].id,
            newValues: { retRefCode, face, price, grossProceeds, discountEarned, tax, timing },
            description: `Treasury bill matured: ${retRefCode} — proceeds ${grossProceeds}, discount ${discountEarned}, tax ${tax} (${timing})`,
            client,
        });

        sendSuccess(res, {
            return_reference: retRefCode,
            gross_proceeds: grossProceeds,
            discount_income: discountEarned,
            tax_amount: tax,
            tax_timing: timing,
            tax_record: taxRecord ? taxRecord.referenceCode : null,
            balance_after: balanceAfter,
        }, `Treasury bill maturity recorded. Reference: ${retRefCode}`);
    });
});

// ============================================================
// UPDATE FIRST COUPON DATE AND/OR FREQUENCY / RESCHEDULE COUPON SCHEDULE
// PATCH /api/investments/:id/coupon-schedule
// A bond's first coupon date is sometimes not known at the time of
// purchase/settlement, and — v1.42.0 — its payment frequency can turn
// out to have been recorded wrong too (or simply need correcting for
// the same "not known yet" reason). Either or both can be supplied;
// whichever isn't provided keeps its current value. The WHOLE schedule
// is regenerated from the resulting anchor date + frequency so every
// later coupon date auto-recalculates too (same math as at creation
// time). Only allowed while no coupon has actually been paid yet —
// once real money has moved against coupon #1, the schedule is locked
// (editInvestment's normal PENDING-only path is not an option
// post-approval, and this endpoint deliberately doesn't touch amounts
// already paid).
// ============================================================
const updateCouponSchedule = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { first_coupon_date, coupon_frequency } = req.body;

    if (first_coupon_date === undefined && coupon_frequency === undefined) {
        throw createError.badRequest('Provide a first coupon date and/or a frequency to update');
    }

    await withTransaction(async (client) => {
        const existing = await client.query(
            'SELECT * FROM investments WHERE id = $1 FOR UPDATE', [id]
        );
        if (existing.rows.length === 0) {
            throw createError.notFound('Investment not found');
        }
        const investment = existing.rows[0];

        if (investment.investment_type !== 'BOND') {
            throw createError.badRequest('This investment does not have a bond coupon schedule');
        }

        // v1.42.1 — widened from status = 'PAID' to status != 'PENDING' so
        // this also blocks rescheduling over a coupon marked MISSED by
        // the termination workflow (Section 39.8) — that's a real
        // historical record too (a coupon that was never going to be
        // paid because the bond was terminated), not something a
        // reschedule should be able to silently erase.
        const settledCount = await client.query(`
            SELECT COUNT(*) AS n FROM bond_coupons
            WHERE  investment_id = $1 AND status != 'PENDING'
        `, [id]);
        if (parseInt(settledCount.rows[0].n) > 0) {
            throw createError.badRequest(
                'The coupon schedule cannot be rescheduled once a coupon has already been paid or marked missed'
            );
        }

        const newFirstCouponDate = first_coupon_date !== undefined ? first_coupon_date : investment.first_coupon_date;
        const newFrequency       = coupon_frequency || investment.coupon_frequency;

        const schedule = generateBondCouponSchedule({
            faceValue:          parseFloat(investment.face_value),
            couponRate:         parseFloat(investment.coupon_rate),
            frequency:          newFrequency,
            taxWithholdingRate: parseFloat(investment.tax_withholding_rate) || 0,
            issueDate:          investment.start_date,
            maturityDate:       investment.expected_end_date,
            firstCouponDate:    newFirstCouponDate,
        });

        await client.query('DELETE FROM bond_coupons WHERE investment_id = $1', [id]);
        for (const coupon of schedule) {
            await client.query(`
                INSERT INTO bond_coupons (
                    investment_id, coupon_number, due_date,
                    gross_amount, tax_amount, net_amount
                ) VALUES ($1, $2, $3, $4, $5, $6)
            `, [
                id, coupon.coupon_number, coupon.due_date,
                coupon.gross_amount, coupon.tax_amount, coupon.net_amount,
            ]);
        }

        await client.query(
            'UPDATE investments SET first_coupon_date = $1, coupon_frequency = $2 WHERE id = $3',
            [newFirstCouponDate, newFrequency, id]
        );

        await logAction(req.user.id, ACTIONS.INVESTMENT_COUPON_SCHEDULE_UPDATED, MODULES.INVESTMENTS, {
            ipAddress:   req.ip,
            recordType:  'investments',
            recordId:    id,
            oldValues:   { first_coupon_date: investment.first_coupon_date, coupon_frequency: investment.coupon_frequency },
            newValues:   { first_coupon_date: newFirstCouponDate, coupon_frequency: newFrequency },
            description: `Bond coupon schedule rescheduled (first coupon date ${newFirstCouponDate}, frequency ${newFrequency}): investment ID ${id}`,
            client,
        });

        sendSuccess(res, { coupons: schedule }, 'Coupon schedule updated');
    });
});

// ============================================================
// MID-TERM TERMINATION WORKFLOW
//
// Step 1 — REQUEST (INVESTMENT_MANAGE): status -> PENDING_TERMINATION.
// Step 2 — CONFIRM RECORDS (the investment's own responsible person,
//          or an approver if none is set): attests every return,
//          expense and transaction against this investment is up to
//          date. Returns/expenses can still be recorded while
//          PENDING_TERMINATION (see MUTABLE_INVESTMENT_STATUSES) so
//          anything missing can be caught up first.
// Step 3 — APPROVE (INVESTMENT_APPROVE, same permission as initial
//          investment approval): final Treasurer/Director sign-off.
//          Locks in status -> TERMINATED, actual_end_date -> today,
//          and a termination_report stating whether the investment
//          profited or lost money, and by how much. Any coupons still
//          PENDING are marked MISSED since they'll never be paid now.
//
// REJECT (either step's approver) can be used at any point while
// PENDING_TERMINATION to abandon the request and restore the
// investment to exactly the status it was in before (status_before_
// termination), clearing all termination_* fields.
// ============================================================

const requestTermination = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;

    await withTransaction(async (client) => {
        const existing = await client.query(
            'SELECT * FROM investments WHERE id = $1 FOR UPDATE', [id]
        );
        if (existing.rows.length === 0) {
            throw createError.notFound('Investment not found');
        }
        const investment = existing.rows[0];

        if (!['ACTIVE', 'ON_HOLD'].includes(investment.status)) {
            throw createError.badRequest(
                `Only an active (or on-hold) investment can be put up for termination. Status: ${investment.status}`
            );
        }

        await client.query(`
            UPDATE investments
            SET    status                     = 'PENDING_TERMINATION',
                   status_before_termination   = $1,
                   termination_requested_by    = $2,
                   termination_requested_at    = NOW(),
                   termination_reason          = $3,
                   records_confirmed_by        = NULL,
                   records_confirmed_at        = NULL,
                   termination_approved_by     = NULL,
                   termination_approved_at     = NULL,
                   termination_report          = NULL
            WHERE  id = $4
        `, [investment.status, req.user.id, reason.trim(), id]);

        await logAction(req.user.id, ACTIONS.INVESTMENT_TERMINATION_REQUESTED, MODULES.INVESTMENTS, {
            ipAddress:   req.ip,
            recordType:  'investments',
            recordId:    id,
            newValues:   { reason },
            description: `Termination requested for investment ID ${id}: ${reason}`,
            client,
        });

        if (investment.responsible_user_id) {
            notify({
                userId:     investment.responsible_user_id,
                type:       'INVESTMENT_TERMINATION_REQUESTED',
                title:      'Investment termination requested — please confirm records',
                body:       `${investment.name} has been put up for termination. Please confirm all returns, expenses and transactions against it are up to date.`,
                link:       `/investments/${id}`,
                module:     'INVESTMENTS',
                recordType: 'investments',
                recordId:   id,
                email: {
                    subject: `Please confirm records — ${investment.name} is being terminated`,
                    html:    await wrapEmail(`
                        <p>An investment you're responsible for has been put up for mid-term termination:</p>
                        <table style="width:100%; border-collapse:collapse; margin:12px 0;">
                            <tr><td style="padding:4px 0; color:#6b7280;">Investment</td><td style="padding:4px 0; text-align:right;">${investment.name}</td></tr>
                            <tr><td style="padding:4px 0; color:#6b7280;">Reason</td><td style="padding:4px 0; text-align:right;">${reason}</td></tr>
                        </table>
                        <p>Please review its records and confirm they are up to date before it can be formally closed.</p>
                    `, { preheader: 'Please confirm investment records before termination' }),
                },
            });
        }

        sendSuccess(res, null, 'Termination requested — awaiting records confirmation');
    });
});

const confirmTerminationRecords = asyncHandler(async (req, res) => {
    const { id } = req.params;

    await withTransaction(async (client) => {
        const existing = await client.query(
            'SELECT * FROM investments WHERE id = $1 FOR UPDATE', [id]
        );
        if (existing.rows.length === 0) {
            throw createError.notFound('Investment not found');
        }
        const investment = existing.rows[0];

        if (investment.status !== 'PENDING_TERMINATION') {
            throw createError.badRequest('This investment is not currently under termination review');
        }

        const canApprove = (req.user.permissions || []).includes('INVESTMENT_APPROVE');
        if (investment.responsible_user_id) {
            if (investment.responsible_user_id !== req.user.id) {
                throw createError.forbidden(
                    'Only this investment\'s responsible person can confirm its records are up to date'
                );
            }
        } else if (!canApprove) {
            // No responsible person on file — fall back to whoever can
            // approve investments, rather than blocking the workflow.
            throw createError.forbidden(
                'This investment has no responsible person on file — an investment approver must confirm records instead'
            );
        }

        await client.query(`
            UPDATE investments
            SET    records_confirmed_by = $1,
                   records_confirmed_at = NOW()
            WHERE  id = $2
        `, [req.user.id, id]);

        await logAction(req.user.id, ACTIONS.INVESTMENT_RECORDS_CONFIRMED, MODULES.INVESTMENTS, {
            ipAddress:   req.ip,
            recordType:  'investments',
            recordId:    id,
            description: `Records confirmed up to date for investment ID ${id}, ahead of termination`,
            client,
        });

        sendSuccess(res, null, 'Records confirmed — awaiting final approval to close');
    });
});

const approveTermination = asyncHandler(async (req, res) => {
    // v1.72.0 — four-eyes rule: the creator (or the member it benefits) can't approve it; an Admin can.
    await assertNotOwnRecord(req, null, 'investments', req.params.id, ['termination_requested_by'], 'termination request');
    const { id } = req.params;
    const { closing_note } = req.body;

    await withTransaction(async (client) => {
        const existing = await client.query(
            'SELECT * FROM investments WHERE id = $1 FOR UPDATE', [id]
        );
        if (existing.rows.length === 0) {
            throw createError.notFound('Investment not found');
        }
        const investment = existing.rows[0];

        if (investment.status !== 'PENDING_TERMINATION') {
            throw createError.badRequest('This investment is not currently under termination review');
        }
        if (!investment.records_confirmed_at) {
            throw createError.badRequest(
                'Records must be confirmed up to date by the responsible person before final approval'
            );
        }

        const totalReturns     = parseFloat(investment.total_returns);
        const totalExpenditure = parseFloat(investment.actual_expenditure);
        const netResult        = totalReturns - totalExpenditure;
        const outcome = netResult > 0 ? 'a profit' : netResult < 0 ? 'a loss' : 'break-even';

        const report =
            `Investment "${investment.name}" (${investment.investment_type}) terminated mid-term.\n` +
            `Reason: ${investment.termination_reason || 'Not stated'}\n` +
            `Planned budget: ${investment.planned_budget}\n` +
            `Total spent: ${totalExpenditure}${parseFloat(investment.supplementary_budget) > 0 ? ` (of which ${investment.supplementary_budget} was supplementary, beyond the planned budget)` : ''}\n` +
            `Total returns received: ${totalReturns}\n` +
            `Result: ${outcome} of ${Math.abs(netResult).toFixed(2)}\n` +
            (closing_note ? `Closing note: ${closing_note}` : '');

        await client.query(`
            UPDATE investments
            SET    status                   = 'TERMINATED',
                   actual_end_date           = CURRENT_DATE,
                   termination_approved_by   = $1,
                   termination_approved_at   = NOW(),
                   termination_report        = $2
            WHERE  id = $3
        `, [req.user.id, report, id]);

        // Coupons still pending will never be paid now — mark them
        // MISSED so the schedule reads accurately rather than showing
        // stale "Pending" rows on a closed bond.
        await client.query(`
            UPDATE bond_coupons
            SET    status = 'MISSED'
            WHERE  investment_id = $1 AND status = 'PENDING'
        `, [id]);

        await logAction(req.user.id, ACTIONS.INVESTMENT_TERMINATED, MODULES.INVESTMENTS, {
            ipAddress:   req.ip,
            recordType:  'investments',
            recordId:    id,
            newValues:   { totalReturns, totalExpenditure, netResult, report },
            description: `Investment ID ${id} terminated — ${outcome} of ${Math.abs(netResult).toFixed(2)}`,
            client,
        });

        if (investment.responsible_user_id) {
            notify({
                userId:     investment.responsible_user_id,
                type:       'INVESTMENT_TERMINATED',
                title:      'Investment terminated',
                body:       `${investment.name} has been formally closed — ${outcome} of ${Math.abs(netResult).toFixed(2)}.`,
                link:       `/investments/${id}`,
                module:     'INVESTMENTS',
                recordType: 'investments',
                recordId:   id,
            });
        }

        sendSuccess(res, { report, net_result: netResult }, 'Investment terminated');
    });
});

const rejectTermination = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;

    await withTransaction(async (client) => {
        const existing = await client.query(
            'SELECT * FROM investments WHERE id = $1 FOR UPDATE', [id]
        );
        if (existing.rows.length === 0) {
            throw createError.notFound('Investment not found');
        }
        const investment = existing.rows[0];

        if (investment.status !== 'PENDING_TERMINATION') {
            throw createError.badRequest('This investment is not currently under termination review');
        }

        const restoredStatus = investment.status_before_termination || 'ACTIVE';

        await client.query(`
            UPDATE investments
            SET    status                     = $1,
                   status_before_termination   = NULL,
                   termination_requested_by    = NULL,
                   termination_requested_at    = NULL,
                   termination_reason          = NULL,
                   records_confirmed_by        = NULL,
                   records_confirmed_at        = NULL,
                   termination_approved_by     = NULL,
                   termination_approved_at     = NULL,
                   termination_report          = NULL
            WHERE  id = $2
        `, [restoredStatus, id]);

        await logAction(req.user.id, ACTIONS.INVESTMENT_TERMINATION_REJECTED, MODULES.INVESTMENTS, {
            ipAddress:   req.ip,
            recordType:  'investments',
            recordId:    id,
            newValues:   { reason },
            description: `Termination request rejected for investment ID ${id}, restored to ${restoredStatus}: ${reason || 'No reason given'}`,
            client,
        });

        sendSuccess(res, null, `Termination request rejected — investment restored to ${restoredStatus}`);
    });
});

// ============================================================
// GET PROJECT WITH FULL DETAILS INCLUDING MILESTONES
// GET /api/investments/:id/projects/:projectId
// ============================================================
const getProjectById = asyncHandler(async (req, res) => {
    const { id, projectId } = req.params;

    const result = await query(`
        SELECT
            p.*,
            r.reference_code,
            r.public_id,
            cat.name     AS category_name,
            cp.full_path AS category_trail,
            u.first_name || ' ' || u.last_name AS created_by_name,
            -- Milestones
            (
                SELECT json_agg(m ORDER BY m.due_date ASC)
                FROM (
                    SELECT id, name, description, due_date,
                           status, completed_at
                    FROM project_milestones
                    WHERE project_id = p.id
                ) m
            ) AS milestones,
            -- Funding transactions
            (
                SELECT json_agg(f_data ORDER BY f_data.amount DESC)
                FROM (
                    SELECT
                        inf.amount, inf.is_reversed,
                        tr.reference_code AS transaction_reference,
                        t.value_date,
                        t.description
                    FROM investment_funding inf
                    JOIN transactions t ON t.id = inf.transaction_id
                    JOIN references_registry tr ON tr.id = t.reference_id
                    WHERE inf.project_id = p.id
                ) f_data
            ) AS funding_transactions
        FROM  projects p
        JOIN  references_registry r ON r.id  = p.reference_id
        JOIN  categories cat        ON cat.id = p.category_id
        JOIN  category_paths cp     ON cp.category_id = p.category_id
        JOIN  users u               ON u.id  = p.created_by
        WHERE p.id = $1
        AND   p.investment_id = $2
    `, [projectId, id]);

    if (result.rows.length === 0) {
        throw createError.notFound('Project not found');
    }

    sendSuccess(res, result.rows[0]);
});

// ============================================================
// INVESTMENT LEDGER (v1.80.0) — GET /api/investments/:id/ledger
// Every ledger entry tagged with this investment (funding, expenses,
// returns, tax, requisitions paid for it, and their reversals), with
// what each expense was for, its category trail, connected documents
// and the requisition it came from. Plus totals by purpose.
// ============================================================
const getInvestmentLedger = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const inv = await query('SELECT id, name, currency_id FROM investments WHERE id = $1', [id]);
    if (!inv.rows.length) throw createError.notFound('Investment not found');
    const hasCost = await investmentCost.costTypeReady({ query });
    const hasLinks = (await query(`SELECT to_regclass('public.transaction_document_links') IS NOT NULL AS ok`)).rows[0].ok;
    const hasReqInv = (await query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'requisitions' AND column_name = 'investment_id'`)).rows.length > 0;
    const r = await query(`
        SELECT t.id, t.transaction_type, t.inflow_type, t.amount, t.value_date::text AS value_date, t.description,
               t.is_reversal, t.is_reversed, t.reversal_of, t.posted_at,
               ${hasCost ? 'COALESCE(t.investment_cost_type, o.investment_cost_type)' : 'NULL'} AS cost_type,
               rr.reference_code, c.code AS currency_code, a.name AS account_name, cp.full_path AS category_trail,
               CASE WHEN f.id IS NOT NULL OR fo.id IS NOT NULL THEN 'FUNDING'
                    WHEN ir.id IS NOT NULL OR iro.id IS NOT NULL THEN 'RETURN'
                    WHEN it.id IS NOT NULL THEN it.entry_type
                    WHEN ito.id IS NOT NULL THEN ito.entry_type
                    ELSE 'OTHER' END AS kind,
               COALESCE(it.id, ito.id) AS operation_id,
               ${hasLinks ? '(SELECT COUNT(*)::int FROM transaction_document_links l WHERE l.transaction_id = t.id AND l.removed_at IS NULL)' : '0'} AS document_count,
               (SELECT q.id FROM requisitions q WHERE q.transaction_id = t.id OR q.transaction_id = t.reversal_of LIMIT 1) AS requisition_id,
               (SELECT qr.reference_code FROM requisitions q JOIN references_registry qr ON qr.id = q.reference_id
                 WHERE q.transaction_id = t.id OR q.transaction_id = t.reversal_of LIMIT 1) AS requisition_reference
        FROM   transactions t
        LEFT JOIN transactions o ON o.id = t.reversal_of
        JOIN   references_registry rr ON rr.id = t.reference_id
        JOIN   currencies c ON c.id = t.currency_id
        JOIN   accounts a ON a.id = t.account_id
        LEFT JOIN category_paths cp ON cp.category_id = t.category_id
        LEFT JOIN investment_funding f  ON f.transaction_id = t.id
        LEFT JOIN investment_funding fo ON fo.transaction_id = t.reversal_of
        LEFT JOIN investment_returns ir  ON ir.transaction_id = t.id
        LEFT JOIN investment_returns iro ON iro.transaction_id = t.reversal_of
        LEFT JOIN investment_transactions it  ON it.transaction_id = t.id
        LEFT JOIN investment_transactions ito ON ito.transaction_id = t.reversal_of
        WHERE  t.investment_id = $1 OR o.investment_id = $1
        ORDER  BY t.value_date DESC, t.id DESC
    `, [id]);
    const totals = { capital: 0, operating: 0, maintenance: 0, unclassified: 0, returns: 0, tax: 0, inflows: 0 };
    const unclassified = [];
    for (const t of r.rows) {
        if (t.is_reversal || t.is_reversed) continue; // a reversed entry and its reversal cancel out
        const amt = parseFloat(t.amount);
        if (t.transaction_type === 'DEBIT' && t.inflow_type === 'EXPENSE' && t.kind !== 'TAX') {
            if (t.cost_type === 'OPERATING') totals.operating += amt;
            else if (t.cost_type === 'MAINTENANCE') totals.maintenance += amt;
            else if (t.cost_type === 'CAPITAL') totals.capital += amt;
            else { totals.unclassified += amt; if (t.kind === 'EXPENSE') unclassified.push(t.id); }
        } else if (t.kind === 'TAX') totals.tax += amt;
        else if (t.kind === 'RETURN') totals.returns += amt;
        else if (t.transaction_type === 'CREDIT') totals.inflows += amt;
    }
    for (const k of Object.keys(totals)) totals[k] = Math.round(totals[k] * 100) / 100;
    sendSuccess(res, {
        transactions: r.rows.map(t => ({ ...t, amount: parseFloat(t.amount), can_classify: hasCost && t.kind === 'EXPENSE' && !t.is_reversal })),
        totals,
        unclassified_ids: unclassified,
        ready: hasCost,
        requisitions_ready: hasReqInv,
        labels: investmentCost.COST_TYPE_LABEL,
    });
});

// ============================================================
// CLASSIFY AN EXPENSE (v1.80.0) — PATCH /api/investments/:id/cost-type
// body: { transaction_id, cost_type }
// For expenses recorded before v1.80 (shown as "not classified", booked
// as capital) or recorded with the wrong purpose. Changes which ledger
// account the expense sits in (1400 asset ↔ 5150 / 5160 expense) and its
// category trail, from its own date — so past statements change too.
// Treasurer or Admin; audit-logged with the old and new purpose.
// ============================================================
const classifyInvestmentExpense = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const costType = investmentCost.assertCostType(req.body.cost_type, { required: true });
    const txId = parseInt(req.body.transaction_id, 10);
    if (!Number.isInteger(txId)) throw createError.badRequest('transaction_id is required.');
    if (!(await investmentCost.costTypeReady({ query }))) throw createError.conflict('Classifying needs the v1.80.0 database update — ask the Admin to run it.');
    await withTransaction(async (client) => {
        const r = await client.query(`
            SELECT t.id, t.investment_id, t.investment_cost_type, t.is_reversal, t.inflow_type, t.transaction_type, t.category_id,
                   rr.reference_code, it.id AS op_id
            FROM   transactions t
            JOIN   references_registry rr ON rr.id = t.reference_id
            JOIN   investment_transactions it ON it.transaction_id = t.id AND it.entry_type = 'EXPENSE'
            WHERE  t.id = $1 FOR UPDATE OF t`, [txId]);
        if (!r.rows.length) throw createError.notFound('That expense of this investment was not found (only investment expenses can be classified; funding is always capital).');
        const t = r.rows[0];
        if (String(t.investment_id) !== String(id)) throw createError.badRequest('That transaction belongs to another investment.');
        if (t.is_reversal) throw createError.badRequest('Classify the original entry, not its reversal.');
        if (t.investment_cost_type === costType) return;
        const categoryId = await investmentCost.purposeCategory(client, costType, req.user.id);
        await client.query('UPDATE transactions SET investment_cost_type = $1, category_id = $2 WHERE id = $3', [costType, categoryId, t.id]);
        await logAction(req.user.id, ACTIONS.INVESTMENT_UPDATED || 'INVESTMENT_UPDATED', MODULES.INVESTMENTS, {
            ipAddress: req.ip, recordType: 'transactions', recordId: t.id,
            oldValues: { investment_cost_type: t.investment_cost_type, category_id: t.category_id },
            newValues: { investment_cost_type: costType, category_id: categoryId },
            description: `Investment expense ${t.reference_code} classified as ${investmentCost.COST_TYPE_LABEL[costType]} (was ${t.investment_cost_type ? investmentCost.COST_TYPE_LABEL[t.investment_cost_type] : 'not classified — capital'})`,
            client,
        });
    });
    sendSuccess(res, { transaction_id: txId, cost_type: costType }, `Classified as ${investmentCost.COST_TYPE_LABEL[costType]}`);
});

module.exports = {
    getInvestmentLedger, classifyInvestmentExpense, // v1.80.0
    postInvestmentFunding, // v1.80.0 — used by paid requisitions
    postInvestmentExpense, // v1.80.0
    createInvestment,
    editInvestment,
    approveInvestment,
    fundInvestment,
    recordReturn,
    recordInvestmentTransaction,
    payBondCoupon,
    recordTreasuryBillMaturity,
    updateCouponSchedule,
    setSettlementValue,
    setBondTerm,
    requestTermination,
    confirmTerminationRecords,
    approveTermination,
    rejectTermination,
    createProject,
    addMilestone,
    updateMilestone,
    updateInvestmentStatus,
    getAllInvestments,
    getInvestmentById,
    getPerformanceSummary,
    getInputVsReturn,
    getPortfolioSummary,
    getProjectById,
};