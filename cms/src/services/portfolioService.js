// ============================================================
// PORTFOLIO SERVICE (v1.34.0)
// Builds the full "Member Portfolio" snapshot shown on the new
// per-member detail page (Section 6.x, CMS_BIBLE.md) — everything
// about one member's standing in the company in a single read-only
// aggregate: profile, roles held, shareholding + contribution
// history, savings, dividends received, side fund standing, every
// payment ever paid out to them, and every transaction they've
// been involved in (as the member the money is for, or as the
// staff member who created/approved it).
//
// Deliberately a snapshot, not a period-scoped report like
// reportService.js's generateIndividualReport() (which is monthly,
// contribution-only, and built for the automated email pipeline).
// This is the always-current "here is everything about this
// member right now" view, and the source of the template_data
// used to generate a formal, saved Portfolio Summary document
// (documentsController.generateDocument, document_type
// FINANCIAL_REPORT_INDIVIDUAL — see migration_v1.34.0.sql).
//
// Every section below queries independently rather than one giant
// JOIN — these tables don't share a single natural join key (a
// member might have contributions but no savings, dividends but no
// side fund activity, etc.), and keeping each section's query
// simple and readable matters more here than round-trip count for
// what is, by nature, a low-traffic "look up one member" endpoint.
// ============================================================

const { query } = require('../config/database');

// ------------------------------------------------------------
// Section: profile + roles held
// ------------------------------------------------------------
const getProfileAndRoles = async (userId) => {
    const profileResult = await query(`
        SELECT
            u.id, u.uuid, u.email, u.first_name, u.last_name,
            u.phone, u.address, u.nationality, u.gender,
            u.photo_path, u.avatar_choice,
            u.is_active, u.is_email_verified,
            u.last_login_at, u.created_at
        FROM users u
        WHERE u.id = $1
    `, [userId]);

    if (profileResult.rows.length === 0) return null;

    const rolesResult = await query(`
        SELECT r.id, r.name, ur.assigned_at, ur.revoked_at,
               a.first_name || ' ' || a.last_name AS assigned_by_name
        FROM   user_roles ur
        JOIN   roles r ON r.id = ur.role_id
        LEFT JOIN users a ON a.id = ur.assigned_by
        WHERE  ur.user_id = $1
        ORDER  BY ur.revoked_at IS NULL DESC, ur.assigned_at DESC
    `, [userId]);

    return {
        profile: profileResult.rows[0],
        rolesCurrent: rolesResult.rows.filter(r => !r.revoked_at),
        rolesHistory: rolesResult.rows,
    };
};

// ------------------------------------------------------------
// Section: shareholding + full contribution history
// ------------------------------------------------------------
const getShareholdingSection = async (userId) => {
    const registryResult = await query(`
        SELECT shares_held, percentage, effective_from
        FROM   shareholding_registry
        WHERE  user_id = $1 AND effective_to IS NULL
    `, [userId]);

    const currentPriceResult = await query(`
        SELECT sph.price_per_share, c.code AS currency_code, c.symbol AS currency_symbol
        FROM   share_price_history sph
        JOIN   currencies c ON c.id = sph.currency_id
        WHERE  sph.effective_to IS NULL
        ORDER  BY sph.effective_from DESC
        LIMIT  1
    `);

    const contributionsResult = await query(`
        SELECT sc.id, sc.amount, sc.currency_id, c.code AS currency_code,
               sc.contribution_date, sc.status, sc.account_id, a.name AS account_name,
               r.reference_code, cat.name AS category_name
        FROM   shareholder_contributions sc
        JOIN   currencies c   ON c.id = sc.currency_id
        JOIN   accounts a     ON a.id = sc.account_id
        JOIN   references_registry r ON r.id = sc.reference_id
        JOIN   categories cat ON cat.id = sc.category_id
        WHERE  sc.user_id = $1
        ORDER  BY sc.contribution_date DESC, sc.id DESC
    `, [userId]);

    const totalApproved = contributionsResult.rows
        .filter(c => c.status === 'APPROVED')
        .reduce((sum, c) => sum + parseFloat(c.amount), 0);

    const registry = registryResult.rows[0] || null;
    const currentPrice = currentPriceResult.rows[0] || null;
    const sharesHeld = registry ? parseFloat(registry.shares_held) : 0;
    const currentValue = (registry && currentPrice)
        ? sharesHeld * parseFloat(currentPrice.price_per_share)
        : null;

    return {
        sharesHeld,
        percentage: registry ? parseFloat(registry.percentage || 0) : 0,
        currentPrice,
        currentValue,
        totalContributedApproved: totalApproved,
        contributions: contributionsResult.rows,
    };
};

// ------------------------------------------------------------
// Section: savings (FLEXIBLE balance + recent deposit/handout history)
// ------------------------------------------------------------
const getSavingsSection = async (userId) => {
    const balanceResult = await query(`
        SELECT sb.principal_balance, sb.accrued_interest, sb.total_interest_paid,
               c.code AS currency_code, c.symbol AS currency_symbol
        FROM   savings_balances sb
        LEFT JOIN currencies c ON c.id = sb.currency_id
        WHERE  sb.user_id = $1
    `, [userId]);

    const depositsResult = await query(`
        SELECT ms.id, ms.principal_amount, ms.entry_type, ms.status,
               ms.deposit_date, ms.maturity_date, ms.amount_at_maturity,
               c.code AS currency_code
        FROM   member_savings ms
        JOIN   currencies c ON c.id = ms.currency_id
        WHERE  ms.user_id = $1
        ORDER  BY ms.deposit_date DESC, ms.id DESC
        LIMIT  50
    `, [userId]);

    const handoutsResult = await query(`
        SELECT sh.id, sh.principal_amount, sh.interest_amount, sh.total_amount,
               sh.status, sh.handout_date, c.code AS currency_code
        FROM   savings_handouts sh
        JOIN   currencies c ON c.id = sh.currency_id
        WHERE  sh.user_id = $1
        ORDER  BY sh.handout_date DESC, sh.id DESC
        LIMIT  50
    `, [userId]);

    const balance = balanceResult.rows[0] || null;

    return {
        principalBalance: balance ? parseFloat(balance.principal_balance) : 0,
        accruedInterest:  balance ? parseFloat(balance.accrued_interest)  : 0,
        totalInterestPaid: balance ? parseFloat(balance.total_interest_paid) : 0,
        currencyCode: balance?.currency_code || null,
        deposits: depositsResult.rows,
        handouts: handoutsResult.rows,
    };
};

// ------------------------------------------------------------
// Section: dividends received
// ------------------------------------------------------------
const getDividendsSection = async (userId) => {
    const result = await query(`
        SELECT dd.id, dd.shares_at_time, dd.percentage_at_time, dd.amount,
               dd.status, dd.credited_amount, dd.paid_at,
               d.period_label, d.declaration_date, c.code AS currency_code
        FROM   dividend_distributions dd
        JOIN   dividends d   ON d.id = dd.dividend_id
        JOIN   currencies c  ON c.id = d.currency_id
        WHERE  dd.user_id = $1
        ORDER  BY d.declaration_date DESC, dd.id DESC
    `, [userId]);

    const totalReceived = result.rows
        .filter(d => d.status === 'PAID')
        .reduce((sum, d) => sum + parseFloat(d.credited_amount || d.amount), 0);

    return { distributions: result.rows, totalReceived };
};

// ------------------------------------------------------------
// Section: side fund standing — membership status + full dues history
// ------------------------------------------------------------
const getSideFundSection = async (userId) => {
    const membershipResult = await query(`
        SELECT is_in, start_period, added_at, removed_at
        FROM   side_fund_members
        WHERE  user_id = $1
    `, [userId]);

    const duesResult = await query(`
        SELECT id, period, amount_due, amount_paid, status, paid_date
        FROM   side_fund_dues
        WHERE  user_id = $1
        ORDER  BY period DESC
    `, [userId]);

    const overdueTotal = duesResult.rows
        .filter(d => d.status === 'PENDING' || d.status === 'PARTIAL' || d.status === 'DEFAULTED')
        .reduce((sum, d) => sum + (parseFloat(d.amount_due) - parseFloat(d.amount_paid)), 0);

    return {
        membership: membershipResult.rows[0] || null,
        dues: duesResult.rows,
        overdueTotal,
    };
};

// ------------------------------------------------------------
// Section: every payment ever paid OUT to this member — dividends,
// service fees, reimbursements, savings handouts, side fund payouts,
// all unified through payment_acknowledgements (Section 4.35).
// ------------------------------------------------------------
const getPaymentsReceivedSection = async (userId) => {
    const result = await query(`
        SELECT pa.id, pa.source_type, pa.amount, pa.status, pa.purpose,
               pa.acknowledged_at, pa.created_at, c.code AS currency_code,
               p.first_name || ' ' || p.last_name AS payer_name
        FROM   payment_acknowledgements pa
        JOIN   currencies c ON c.id = pa.currency_id
        JOIN   users p      ON p.id = pa.payer_id
        WHERE  pa.recipient_id = $1
        ORDER  BY pa.created_at DESC
        LIMIT  50
    `, [userId]);

    return { payments: result.rows };
};

// ------------------------------------------------------------
// Section: transactions this member has been involved in — either
// as the member the money is for (contributed_by), or as the staff
// member who created/approved the posting. A transaction can match
// more than one of these at once (e.g. a Treasurer recording their
// own contribution); "role" lists every way it matches, not just one.
// ------------------------------------------------------------
const getTransactionsInvolvedSection = async (userId) => {
    const result = await query(`
        SELECT t.id, t.transaction_type, t.inflow_type, t.amount, t.status,
               t.description, t.value_date, t.transaction_date,
               c.code AS currency_code, a.name AS account_name,
               r.reference_code,
               (t.contributed_by = $1) AS as_beneficiary,
               (t.created_by = $1)     AS as_creator,
               (t.approved_by = $1)    AS as_approver
        FROM   transactions t
        JOIN   currencies c ON c.id = t.currency_id
        JOIN   accounts a   ON a.id = t.account_id
        JOIN   references_registry r ON r.id = t.reference_id
        WHERE  t.contributed_by = $1 OR t.created_by = $1 OR t.approved_by = $1
        ORDER  BY t.transaction_date DESC, t.id DESC
        LIMIT  100
    `, [userId]);

    const countResult = await query(`
        SELECT COUNT(*) AS total
        FROM   transactions t
        WHERE  t.contributed_by = $1 OR t.created_by = $1 OR t.approved_by = $1
    `, [userId]);

    return {
        transactions: result.rows,
        totalCount: parseInt(countResult.rows[0].total, 10),
    };
};

// ------------------------------------------------------------
// PUBLIC: build the full portfolio
// ------------------------------------------------------------
const buildMemberPortfolio = async (userId) => {
    const identity = await getProfileAndRoles(userId);
    if (!identity) return null;

    const [shareholding, savings, dividends, sideFund, payments, transactionsInvolved] =
        await Promise.all([
            getShareholdingSection(userId),
            getSavingsSection(userId),
            getDividendsSection(userId),
            getSideFundSection(userId),
            getPaymentsReceivedSection(userId),
            getTransactionsInvolvedSection(userId),
        ]);

    const summary = {
        memberSince:        identity.profile.created_at,
        isActive:            identity.profile.is_active,
        isEmailVerified:      identity.profile.is_email_verified,
        roles:               identity.rolesCurrent.map(r => r.name),
        sharesHeld:          shareholding.sharesHeld,
        percentage:          shareholding.percentage,
        currentValue:        shareholding.currentValue,
        totalContributed:    shareholding.totalContributedApproved,
        savingsBalance:      savings.principalBalance + savings.accruedInterest,
        dividendsReceived:   dividends.totalReceived,
        sideFundIn:          sideFund.membership?.is_in || false,
        sideFundOverdue:     sideFund.overdueTotal,
    };

    return {
        profile: identity.profile,
        rolesCurrent: identity.rolesCurrent,
        rolesHistory: identity.rolesHistory,
        shareholding,
        savings,
        dividends,
        sideFund,
        payments,
        transactionsInvolved,
        summary,
        generatedAt: new Date().toISOString(),
    };
};

module.exports = {
    buildMemberPortfolio,
};
