// ============================================================
// REPORTS CONTROLLER
// Handles on-demand report generation and viewing.
//
// HANDLES:
//   - Generate general company report on demand
//   - Generate individual member report on demand
//   - View report history
//   - Manually trigger monthly reports (Admin only)
// ============================================================

const { query, withTransaction } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess, sendCreated, sendPaginated, getPagination } = require('../utils/response');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');
const {
    generateGeneralReport,
    generateIndividualReport,
    renderGeneralReportHTML,
    renderIndividualReportHTML,
    sendGeneralReportToAllMembers,
    sendIndividualReportsToAllMembers,
} = require('../services/reportService');
const { notify } = require('../services/notificationService');
const { wrapEmail } = require('../services/emailTemplates');
const { getQuarterForDate } = require('../services/fiscalService');

// ============================================================
// ATTACH THE CONFIGURED FISCAL QUARTER (v1.25.0) a report's period
// falls into, if an Admin has set one up covering it — looked up
// against the LAST day of the reported month, since that's the
// closing date the report's figures are as-of. Purely a label
// (report.fiscal_quarter = { id, label, start_date, end_date } or
// null) — never changes any of the report's actual figures, which
// stay strictly calendar-month based as they always have.
// ============================================================
const attachFiscalQuarter = async (report, year, month) => {
    const periodEndDate = new Date(year, month, 0).toISOString().split('T')[0]; // last day of `month`
    report.fiscal_quarter = await getQuarterForDate(periodEndDate).catch(() => null);
    return report;
};

// ============================================================
// GET CHART OF ACCOUNTS
// GET /api/reports/chart-of-accounts
// v1.28.0, Section 4.32.
//
// A live, as-of-right-now snapshot of every money pool in the
// system — deliberately NOT month-scoped like the general report
// above (which is a historical monthly statement). This just reads
// each pool's own running-balance columns directly, exactly the way
// each module's own page already displays them, so the numbers here
// can never drift out of sync with what a user sees on the Accounts,
// Side Fund, Loans, Investments or MMF pages.
//
// Figures are grouped by currency within each section (never summed
// across currencies) since accounts, loans, investments, MMFs and
// grants can each be denominated in a different currency.
// ============================================================
const getChartOfAccounts = asyncHandler(async (req, res) => {
    const [
        accountsResult,
        sideFundResult,
        loansReceivedResult,
        loansGivenResult,
        investmentsResult,
        mmfResult,
        grantsResult,
    ] = await Promise.all([
        // Accounts — every active Primary/Secondary/Savings account
        query(`
            SELECT a.id, a.name, a.account_type, a.current_balance,
                   c.code AS currency_code, c.symbol AS currency_symbol
            FROM   accounts a
            JOIN   currencies c ON c.id = a.currency_id
            WHERE  a.is_active = TRUE
            ORDER  BY a.account_type DESC, a.name ASC
        `),

        // Side Fund — single-row running balance
        query(`
            SELECT sfc.is_active, sfc.monthly_amount, sfc.current_balance,
                   a.name AS parent_account_name,
                   c.code AS currency_code, c.symbol AS currency_symbol
            FROM   side_fund_config sfc
            LEFT JOIN accounts a    ON a.id = sfc.parent_account_id
            LEFT JOIN currencies c  ON c.id = sfc.currency_id
            WHERE  sfc.id = 1
        `),

        // Loans Received — money the company owes, still outstanding
        query(`
            SELECT c.code AS currency_code, c.symbol AS currency_symbol,
                   COUNT(*) AS count,
                   COALESCE(SUM(lr.outstanding_principal), 0) AS outstanding_principal,
                   COALESCE(SUM(lr.outstanding_interest), 0)  AS outstanding_interest
            FROM   loans_received lr
            JOIN   currencies c ON c.id = lr.currency_id
            WHERE  lr.status IN ('ACTIVE', 'OVERDUE', 'PARTIALLY_REPAID')
            GROUP  BY c.code, c.symbol
        `),

        // Loans Given — money owed TO the company, still outstanding
        query(`
            SELECT c.code AS currency_code, c.symbol AS currency_symbol,
                   COUNT(*) AS count,
                   COALESCE(SUM(lg.outstanding_principal), 0) AS outstanding_principal,
                   COALESCE(SUM(lg.outstanding_interest), 0)  AS outstanding_interest
            FROM   loans_given lg
            JOIN   currencies c ON c.id = lg.currency_id
            WHERE  lg.status IN ('ACTIVE', 'OVERDUE', 'PARTIALLY_REPAID')
            GROUP  BY c.code, c.symbol
        `),

        // Investments — active/on-hold capital deployed and returns earned
        query(`
            SELECT c.code AS currency_code, c.symbol AS currency_symbol,
                   COUNT(*) AS count,
                   COALESCE(SUM(i.planned_budget), 0)      AS planned_budget,
                   COALESCE(SUM(i.actual_expenditure), 0)  AS actual_expenditure,
                   COALESCE(SUM(i.total_returns), 0)       AS total_returns
            FROM   investments i
            JOIN   currencies c ON c.id = i.currency_id
            WHERE  i.status IN ('ACTIVE', 'ON_HOLD')
            GROUP  BY c.code, c.symbol
        `),

        // Money Market Funds — active sub-accounts (v1.28.0)
        query(`
            SELECT c.code AS currency_code, c.symbol AS currency_symbol,
                   COUNT(*) AS count,
                   COALESCE(SUM(m.current_balance), 0)       AS current_balance,
                   COALESCE(SUM(m.total_principal_in), 0)    AS total_principal_in,
                   COALESCE(SUM(m.total_interest), 0)        AS total_interest,
                   COALESCE(SUM(m.total_management_fees), 0) AS total_management_fees
            FROM   mmf_accounts m
            JOIN   currencies c ON c.id = m.currency_id
            WHERE  m.status = 'ACTIVE'
            GROUP  BY c.code, c.symbol
        `),

        // Grants — active/partially-received, amount still expected
        query(`
            SELECT c.code AS currency_code, c.symbol AS currency_symbol,
                   COUNT(*) AS count,
                   COALESCE(SUM(g.total_amount), 0)     AS total_amount,
                   COALESCE(SUM(g.amount_received), 0)  AS amount_received,
                   COALESCE(SUM(g.amount_remaining), 0) AS amount_remaining
            FROM   grants g
            JOIN   currencies c ON c.id = g.currency_id
            WHERE  g.status IN ('ACTIVE', 'PARTIALLY_RECEIVED')
            GROUP  BY c.code, c.symbol
        `),
    ]);

    const sideFund = sideFundResult.rows[0] || null;

    sendSuccess(res, {
        generated_at:     new Date().toISOString(),
        accounts:         accountsResult.rows,
        side_fund:        (sideFund && sideFund.is_active) ? sideFund : null,
        loans_received:   loansReceivedResult.rows,
        loans_given:      loansGivenResult.rows,
        investments:      investmentsResult.rows,
        mmf:              mmfResult.rows,
        grants:           grantsResult.rows,
    });
});

// ============================================================
// GET GENERAL COMPANY REPORT (on demand)
// GET /api/reports/general?year=2026&month=6
// Returns the full report data as JSON.
// ============================================================
const getGeneralReport = asyncHandler(async (req, res) => {
    const year  = parseInt(req.query.year)  || new Date().getFullYear();
    const month = parseInt(req.query.month) || new Date().getMonth() + 1;

    if (month < 1 || month > 12) {
        throw createError.badRequest('Month must be between 1 and 12');
    }

    const report = await generateGeneralReport(year, month);
    await attachFiscalQuarter(report, year, month);

    await logAction(req.user.id, ACTIONS.REPORT_GENERATED, MODULES.REPORTS, {
        ipAddress:   req.ip,
        description: `General report generated for ${report.period}`,
    });

    sendSuccess(res, report, `General report for ${report.period}`);
});

// ============================================================
// GET INDIVIDUAL MEMBER REPORT (on demand)
// GET /api/reports/individual/:userId?year=2026&month=6
// ============================================================
const getIndividualReport = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const year  = parseInt(req.query.year)  || new Date().getFullYear();
    const month = parseInt(req.query.month) || new Date().getMonth() + 1;

    if (month < 1 || month > 12) {
        throw createError.badRequest('Month must be between 1 and 12');
    }

    // Only allow viewing own report unless admin/treasurer
    const isSelf = parseInt(userId) === req.user.id;
    const canViewAll = req.user.permissions.includes('REPORT_VIEW_ALL');

    if (!isSelf && !canViewAll) {
        throw createError.forbidden('You can only view your own report');
    }

    const report = await generateIndividualReport(parseInt(userId), year, month);

    if (!report) {
        throw createError.notFound('Member not found');
    }
    await attachFiscalQuarter(report, year, month);

    await logAction(req.user.id, ACTIONS.REPORT_GENERATED, MODULES.REPORTS, {
        ipAddress:   req.ip,
        description: `Individual report generated for user ${userId} — ${report.period}`,
    });

    sendSuccess(res, report, `Individual report for ${report.period}`);
});

// ============================================================
// GET OWN REPORT
// GET /api/reports/me?year=2026&month=6
// Any member can view their own report
// ============================================================
const getMyReport = asyncHandler(async (req, res) => {
    const year  = parseInt(req.query.year)  || new Date().getFullYear();
    const month = parseInt(req.query.month) || new Date().getMonth() + 1;

    if (month < 1 || month > 12) {
        throw createError.badRequest('Month must be between 1 and 12');
    }

    const report = await generateIndividualReport(req.user.id, year, month);

    if (!report) {
        throw createError.notFound('Report could not be generated');
    }
    await attachFiscalQuarter(report, year, month);

    sendSuccess(res, report, `Your report for ${report.period}`);
});

// ============================================================
// SEND MONTHLY REPORTS MANUALLY (Admin only)
// POST /api/reports/send-monthly
// Triggers the monthly report send immediately.
// Useful for testing or if the scheduler missed a run.
// ============================================================
const sendMonthlyReports = asyncHandler(async (req, res) => {
    const year  = parseInt(req.body.year)  || new Date().getFullYear();
    const month = parseInt(req.body.month) || new Date().getMonth() + 1;

    if (month < 1 || month > 12) {
        throw createError.badRequest('Month must be between 1 and 12');
    }

    // Send general report
    const generalResult = await sendGeneralReportToAllMembers(year, month);

    // Send individual reports
    const individualResult = await sendIndividualReportsToAllMembers(year, month);

    // Log to report_log
    await query(`
        INSERT INTO report_log (
            report_type, report_period,
            send_status, sent_at, generated_by
        ) VALUES (
            'MONTHLY_GENERAL', $1, 'SENT', NOW(), $2
        )
    `, [`${year}${String(month).padStart(2, '0')}`, req.user.id]);

    await logAction(req.user.id, ACTIONS.REPORT_SENT, MODULES.REPORTS, {
        ipAddress:   req.ip,
        description: `Monthly reports manually triggered for ${year}-${month}`,
        newValues:   { generalResult, individualResult },
    });

    sendSuccess(res, {
        general_report:    generalResult,
        individual_reports: individualResult,
    }, 'Monthly reports sent successfully');
});

// ============================================================
// SEND GENERAL ANNOUNCEMENT (Admin/Treasurer/Secretary)
// POST /api/reports/broadcast
// The "central email" for one-off broadcasts that aren't tied to
// a specific event's own notification list — general meeting
// notices, ad-hoc company-wide announcements, etc. Every active
// user gets a personal bell notification AND an email, built from
// the same branded shell as every other system email.
// ============================================================
const sendBroadcastAnnouncement = asyncHandler(async (req, res) => {
    const { subject, message, link } = req.body;

    if (!subject || !subject.trim()) {
        throw createError.badRequest('Subject is required');
    }
    if (!message || !message.trim()) {
        throw createError.badRequest('Message is required');
    }

    // Every active user — in this system every active member is a
    // shareholder by default, so this doubles as "all shareholders".
    const members = await query(`
        SELECT id, email, first_name, last_name
        FROM   users
        WHERE  is_active = TRUE
        ORDER  BY first_name ASC
    `);

    const emailHtml = await wrapEmail(`
        <p>${message.trim().replace(/\n/g, '<br>')}</p>
        ${link ? `<p><a href="${link}" style="color:#1e3a5f;">View details</a></p>` : ''}
        <p style="color:#6b7280; font-size:12px;">Sent by ${req.user.first_name} ${req.user.last_name}</p>
    `, { preheader: subject.trim() });

    let sent = 0;
    let failed = 0;

    for (const member of members.rows) {
        const notificationId = await notify({
            userId:     member.id,
            type:       'GENERAL_ANNOUNCEMENT',
            title:      subject.trim(),
            body:       message.trim(),
            link:       link || null,
            module:     'ANNOUNCEMENTS',
            email: {
                to:      member.email,
                subject: subject.trim(),
                html:    emailHtml,
            },
        });

        if (notificationId) {
            sent++;
        } else {
            failed++;
        }

        // Stagger to stay well under Gmail's rate limits.
        await new Promise(resolve => setTimeout(resolve, 150));
    }

    await logAction(req.user.id, ACTIONS.REPORT_SENT, MODULES.REPORTS, {
        ipAddress:   req.ip,
        description: `General announcement broadcast: "${subject.trim()}" to ${members.rows.length} member(s)`,
        newValues:   { subject: subject.trim(), recipients: members.rows.length, sent, failed },
    });

    sendSuccess(res, {
        recipients: members.rows.length,
        sent,
        failed,
    }, `Announcement sent to ${sent} of ${members.rows.length} member(s)`);
});

// ============================================================
// GET REPORT LOG
// GET /api/reports/log
// Shows history of all generated and sent reports
// ============================================================
const getReportLog = asyncHandler(async (req, res) => {
    const { page, limit, offset } = getPagination(req.query);

    const countResult = await query(
        'SELECT COUNT(*) AS total FROM report_log'
    );
    const total = parseInt(countResult.rows[0].total);

    const result = await query(`
        SELECT
            rl.id,
            rl.report_type,
            rl.report_period,
            rl.email_sent_to,
            rl.send_status,
            rl.sent_at,
            rl.generated_at,
            u.first_name || ' ' || u.last_name AS generated_by_name
        FROM  report_log rl
        LEFT JOIN users u ON u.id = rl.generated_by
        ORDER BY rl.generated_at DESC
        LIMIT $1 OFFSET $2
    `, [limit, offset]);

    sendPaginated(res, result.rows, total, page, limit);
});

// ============================================================
// GET AUDIT LOG (Admin only)
// GET /api/reports/audit?module=FINANCE&action=TRANSACTION_CREATED
// ============================================================
const getAuditLog = asyncHandler(async (req, res) => {
    const { module, action, user_id, from_date, to_date } = req.query;
    const { page, limit, offset } = getPagination(req.query);

    const conditions = [];
    const params = [];
    let p = 0;

    if (module) {
        p++; conditions.push(`al.module = $${p}`);
        params.push(module.toUpperCase());
    }
    if (action) {
        p++; conditions.push(`al.action = $${p}`);
        params.push(action.toUpperCase());
    }
    if (user_id) {
        p++; conditions.push(`al.user_id = $${p}`);
        params.push(user_id);
    }
    if (from_date) {
        p++; conditions.push(`al.created_at >= $${p}`);
        params.push(from_date);
    }
    if (to_date) {
        p++; conditions.push(`al.created_at <= $${p}`);
        params.push(to_date);
    }

    const where = conditions.length > 0
        ? 'WHERE ' + conditions.join(' AND ')
        : '';

    const countResult = await query(
        `SELECT COUNT(*) AS total FROM audit_log al ${where}`, params
    );
    const total = parseInt(countResult.rows[0].total);

    params.push(limit, offset);
    const result = await query(`
        SELECT
            al.id,
            al.action,
            al.module,
            al.record_type,
            al.record_id,
            al.description,
            al.status,
            al.ip_address,
            al.created_at,
            u.first_name || ' ' || u.last_name AS user_name,
            u.email AS user_email
        FROM  audit_log al
        LEFT JOIN users u ON u.id = al.user_id
        ${where}
        ORDER BY al.created_at DESC
        LIMIT $${p + 1} OFFSET $${p + 2}
    `, params);

    sendPaginated(res, result.rows, total, page, limit);
});

module.exports = {
    getChartOfAccounts,
    getGeneralReport,
    getIndividualReport,
    getMyReport,
    sendMonthlyReports,
    sendBroadcastAnnouncement,
    getReportLog,
    getAuditLog,
};