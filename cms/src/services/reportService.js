// ============================================================
// REPORT SERVICE
// Generates financial reports for the company and individuals.
// Reports are built by querying the database and compiling
// all relevant financial data into a structured object
// that can be rendered as HTML or PDF.
// ============================================================

const { query } = require('../config/database');
const { sendEmail } = require('../config/email');
const { notify } = require('./notificationService');
const { getBranding } = require('./emailTemplates');

// ============================================================
// GENERATE GENERAL COMPANY REPORT
// Compiles the full company financial picture for a given
// month. Used for both scheduled and on-demand reports.
// ============================================================
const generateGeneralReport = async (year, month) => {
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const endDate   = new Date(year, month, 0).toISOString().split('T')[0];
    const periodLabel = new Date(year, month - 1).toLocaleString('en-GB', {
        month: 'long', year: 'numeric'
    });

    // --------------------------------------------------------
    // SECTION 1: Account Balances
    // --------------------------------------------------------
    const accountsResult = await query(`
        SELECT
            a.name,
            a.account_type,
            -- General balance — an active side fund's allocation is
            -- excluded (display-only; real ledger total is unaffected).
            a.current_balance - COALESCE(sfc.current_balance, 0) AS current_balance,
            COALESCE(sfc.current_balance, 0) AS side_fund_allocation,
            c.code   AS currency_code,
            c.symbol AS currency_symbol,
            CASE
                WHEN a.account_type != 'SAVINGS' THEN
                    (a.current_balance - COALESCE(sfc.current_balance, 0)) - COALESCE((
                        SELECT fl.floor_amount
                        FROM   primary_account_floor_limits fl
                        WHERE  fl.account_id = a.id
                        AND    fl.effective_to IS NULL
                        LIMIT  1
                    ), 0)
                ELSE a.current_balance - COALESCE(sfc.current_balance, 0)
            END AS available_balance,
            CASE
                WHEN a.account_type != 'SAVINGS' THEN (
                    SELECT fl.floor_amount
                    FROM   primary_account_floor_limits fl
                    WHERE  fl.account_id = a.id
                    AND    fl.effective_to IS NULL
                    LIMIT  1
                )
                ELSE NULL
            END AS floor_limit
        FROM  accounts a
        JOIN  currencies c ON c.id = a.currency_id
        LEFT JOIN side_fund_config sfc
               ON sfc.parent_account_id = a.id AND sfc.is_active = TRUE
        WHERE a.is_active = TRUE
        ORDER BY a.account_type DESC
    `);

    // --------------------------------------------------------
    // SECTION 2: Income Summary for the Period
    // --------------------------------------------------------
    const incomeResult = await query(`
        SELECT
            t.inflow_type,
            COUNT(*)            AS transaction_count,
            SUM(t.amount)       AS total_amount,
            c.code              AS currency_code
        FROM  transactions t
        JOIN  accounts a   ON a.id = t.account_id
        JOIN  currencies c ON c.id = t.currency_id
        WHERE t.transaction_type IN ('CREDIT', 'REVERSAL_CREDIT')
        AND   t.value_date BETWEEN $1 AND $2
        AND   t.status = 'POSTED'
        GROUP BY t.inflow_type, c.code
        ORDER BY total_amount DESC
    `, [startDate, endDate]);

    // --------------------------------------------------------
    // SECTION 3: Expense Summary for the Period
    // --------------------------------------------------------
    const expenseResult = await query(`
        SELECT
            cat.name            AS category_name,
            cp.full_path        AS category_trail,
            COUNT(*)            AS transaction_count,
            SUM(t.amount)       AS total_amount,
            c.code              AS currency_code
        FROM  transactions t
        JOIN  accounts a        ON a.id   = t.account_id
        JOIN  currencies c      ON c.id   = t.currency_id
        JOIN  categories cat    ON cat.id = t.category_id
        JOIN  category_paths cp ON cp.category_id = t.category_id
        WHERE t.transaction_type IN ('DEBIT', 'REVERSAL_DEBIT')
        AND   t.inflow_type = 'EXPENSE'
        AND   t.value_date BETWEEN $1 AND $2
        AND   t.status = 'POSTED'
        GROUP BY cat.name, cp.full_path, c.code
        ORDER BY total_amount DESC
    `, [startDate, endDate]);

    // --------------------------------------------------------
    // SECTION 4: Transfers Summary
    // --------------------------------------------------------
    const transfersResult = await query(`
        SELECT
            t.transfer_type,
            COUNT(*)             AS count,
            SUM(t.amount_sent)   AS total_sent,
            fc.code              AS from_currency,
            SUM(t.amount_received) AS total_received,
            tc.code              AS to_currency
        FROM  transfers t
        JOIN  currencies fc ON fc.id = t.currency_sent_id
        JOIN  currencies tc ON tc.id = t.currency_received_id
        WHERE t.value_date BETWEEN $1 AND $2
        AND   t.status = 'POSTED'
        GROUP BY t.transfer_type, fc.code, tc.code
    `, [startDate, endDate]);

    // --------------------------------------------------------
    // SECTION 5: Active Loans Summary
    // --------------------------------------------------------
    const loansResult = await query(`
        SELECT
            lr.lender_name,
            lr.lender_type,
            lr.principal_amount,
            lr.outstanding_principal,
            lr.fixed_interest_rate,
            lr.penalty_interest_rate,
            lr.due_date,
            lr.is_overdue,
            lr.status,
            c.code AS currency_code
        FROM  loans_received lr
        JOIN  currencies c ON c.id = lr.currency_id
        WHERE lr.status IN ('ACTIVE','OVERDUE','PARTIALLY_REPAID')
        ORDER BY lr.is_overdue DESC, lr.due_date ASC
    `);

    // --------------------------------------------------------
    // SECTION 6: Active Grants Summary
    // --------------------------------------------------------
    const grantsResult = await query(`
        SELECT
            g.title,
            g.grantor_name,
            g.total_amount,
            g.amount_received,
            g.amount_remaining,
            g.status,
            c.code AS currency_code
        FROM  grants g
        JOIN  currencies c ON c.id = g.currency_id
        WHERE g.status IN ('ACTIVE','PARTIALLY_RECEIVED')
        ORDER BY g.amount_remaining DESC
    `);

    // --------------------------------------------------------
    // SECTION 7: Investments Portfolio Summary
    // --------------------------------------------------------
    const investmentsResult = await query(`
        SELECT
            i.name,
            i.planned_budget,
            i.actual_expenditure,
            i.total_returns,
            i.status,
            c.code AS currency_code,
            CASE
                WHEN i.actual_expenditure > 0 THEN
                    ROUND(((i.total_returns - i.actual_expenditure)
                    / i.actual_expenditure * 100)::numeric, 2)
                ELSE 0
            END AS roi_percentage,
            (SELECT COUNT(*) FROM projects p
             WHERE p.investment_id = i.id) AS project_count
        FROM  investments i
        JOIN  currencies c ON c.id = i.currency_id
        WHERE i.status IN ('ACTIVE','ON_HOLD')
        ORDER BY i.actual_expenditure DESC
    `);

    // --------------------------------------------------------
    // SECTION 8: Contributions this period
    // --------------------------------------------------------
    const contributionsResult = await query(`
        SELECT
            u.first_name || ' ' || u.last_name AS member_name,
            SUM(sc.amount)  AS total_contributed,
            COUNT(*)        AS contribution_count,
            c.code          AS currency_code
        FROM  shareholder_contributions sc
        JOIN  users u      ON u.id  = sc.user_id
        JOIN  currencies c ON c.id  = sc.currency_id
        WHERE sc.contribution_date BETWEEN $1 AND $2
        AND   sc.status = 'APPROVED'
        GROUP BY u.first_name, u.last_name, c.code
        ORDER BY total_contributed DESC
    `, [startDate, endDate]);

    // --------------------------------------------------------
    // SECTION 9: Upcoming Events (next 30 days)
    // --------------------------------------------------------
    const eventsResult = await query(`
        SELECT
            e.title,
            e.event_date,
            e.location,
            et.name AS event_type
        FROM  events e
        JOIN  event_types et ON et.id = e.event_type_id
        WHERE e.event_date BETWEEN NOW() AND NOW() + INTERVAL '30 days'
        AND   e.status = 'APPROVED'
        ORDER BY e.event_date ASC
        LIMIT 10
    `);

    return {
        period:         periodLabel,
        generated_at:   new Date().toISOString(),
        accounts:       accountsResult.rows,
        income:         incomeResult.rows,
        expenses:       expenseResult.rows,
        transfers:      transfersResult.rows,
        loans:          loansResult.rows,
        grants:         grantsResult.rows,
        investments:    investmentsResult.rows,
        contributions:  contributionsResult.rows,
        upcoming_events: eventsResult.rows,
    };
};

// ============================================================
// GENERATE INDIVIDUAL MEMBER REPORT
// Compiles a personal financial summary for one member.
// ============================================================
const generateIndividualReport = async (userId, year, month) => {
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const endDate   = new Date(year, month, 0).toISOString().split('T')[0];
    const periodLabel = new Date(year, month - 1).toLocaleString('en-GB', {
        month: 'long', year: 'numeric'
    });

    // Member profile
    const memberResult = await query(`
        SELECT
            u.first_name, u.last_name, u.email,
            u.phone, u.nationality,
            COALESCE(
                json_agg(DISTINCT r.name) FILTER (WHERE r.name IS NOT NULL),
                '[]'
            ) AS roles
        FROM  users u
        LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
        LEFT JOIN roles r       ON r.id = ur.role_id
        WHERE u.id = $1
        GROUP BY u.id
    `, [userId]);

    if (memberResult.rows.length === 0) return null;
    const member = memberResult.rows[0];

    // Shareholding
    const shareholdingResult = await query(`
        SELECT shares_held, percentage, effective_from
        FROM   shareholding_registry
        WHERE  user_id = $1
        AND    effective_to IS NULL
        ORDER  BY effective_from DESC
        LIMIT  1
    `, [userId]);

    // Contributions this period
    const contributionsResult = await query(`
        SELECT
            sc.amount,
            sc.contribution_date,
            r.reference_code,
            cat.name     AS category_name,
            cp.full_path AS category_trail
        FROM  shareholder_contributions sc
        JOIN  references_registry r ON r.id  = sc.reference_id
        JOIN  categories cat        ON cat.id = sc.category_id
        JOIN  category_paths cp     ON cp.category_id = sc.category_id
        WHERE sc.user_id = $1
        AND   sc.contribution_date BETWEEN $2 AND $3
        AND   sc.status = 'APPROVED'
        ORDER BY sc.contribution_date DESC
    `, [userId, startDate, endDate]);

    // All-time total contributions
    const totalContribResult = await query(`
        SELECT COALESCE(SUM(amount), 0) AS total
        FROM   shareholder_contributions
        WHERE  user_id = $1 AND status = 'APPROVED'
    `, [userId]);

    return {
        period:              periodLabel,
        generated_at:        new Date().toISOString(),
        member,
        shareholding:        shareholdingResult.rows[0] || null,
        contributions_period: contributionsResult.rows,
        total_contributed:   totalContribResult.rows[0].total,
    };
};

// ============================================================
// RENDER REPORT AS HTML
// Takes the structured report data and builds an HTML email.
// ============================================================
const renderGeneralReportHTML = async (report) => {
    const branding = await getBranding();
    const companyName = branding.company_name;

    const accountRows = report.accounts.map(a => `
        <tr>
            <td style="padding:8px; border-bottom:1px solid #e5e7eb;">${a.name}</td>
            <td style="padding:8px; border-bottom:1px solid #e5e7eb;">${a.account_type}</td>
            <td style="padding:8px; border-bottom:1px solid #e5e7eb; text-align:right;">
                ${a.currency_symbol} ${parseFloat(a.current_balance).toLocaleString('en-US', { maximumFractionDigits: 2 })}
            </td>
            <td style="padding:8px; border-bottom:1px solid #e5e7eb; text-align:right;">
                ${a.floor_limit
                    ? `${a.currency_symbol} ${parseFloat(a.floor_limit).toLocaleString('en-US', { maximumFractionDigits: 2 })}`
                    : '—'}
            </td>
            <td style="padding:8px; border-bottom:1px solid #e5e7eb; text-align:right;">
                ${a.currency_symbol} ${parseFloat(a.available_balance).toLocaleString('en-US', { maximumFractionDigits: 2 })}
            </td>
        </tr>
    `).join('');

    const investmentRows = report.investments.map(i => `
        <tr>
            <td style="padding:8px; border-bottom:1px solid #e5e7eb;">${i.name}</td>
            <td style="padding:8px; border-bottom:1px solid #e5e7eb;">${i.status}</td>
            <td style="padding:8px; border-bottom:1px solid #e5e7eb; text-align:right;">
                ${i.currency_code} ${parseFloat(i.planned_budget).toLocaleString('en-US', { maximumFractionDigits: 2 })}
            </td>
            <td style="padding:8px; border-bottom:1px solid #e5e7eb; text-align:right;">
                ${i.currency_code} ${parseFloat(i.actual_expenditure).toLocaleString('en-US', { maximumFractionDigits: 2 })}
            </td>
            <td style="padding:8px; border-bottom:1px solid #e5e7eb; text-align:right;">
                ${i.roi_percentage}%
            </td>
        </tr>
    `).join('');

    const upcomingRows = report.upcoming_events.map(e => `
        <tr>
            <td style="padding:8px; border-bottom:1px solid #e5e7eb;">${e.title}</td>
            <td style="padding:8px; border-bottom:1px solid #e5e7eb;">${e.event_type}</td>
            <td style="padding:8px; border-bottom:1px solid #e5e7eb;">
                ${new Date(e.event_date).toLocaleDateString('en-GB')}
            </td>
            <td style="padding:8px; border-bottom:1px solid #e5e7eb;">${e.location || '—'}</td>
        </tr>
    `).join('');

    return `
        <div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto;">
            <div style="background:#1e3a5f; color:white; padding:24px; border-radius:8px 8px 0 0;">
                <h1 style="margin:0; font-size:24px;">${companyName}</h1>
                <h2 style="margin:8px 0 0; font-size:16px; font-weight:normal;">
                    Monthly Financial Report — ${report.period}
                </h2>
            </div>

            <div style="background:white; padding:24px; border:1px solid #e5e7eb;">

                <h3 style="color:#1e3a5f; border-bottom:2px solid #1e3a5f; padding-bottom:8px;">
                    Account Balances
                </h3>
                <table style="width:100%; border-collapse:collapse; margin-bottom:24px;">
                    <thead>
                        <tr style="background:#f3f4f6;">
                            <th style="padding:8px; text-align:left;">Account</th>
                            <th style="padding:8px; text-align:left;">Type</th>
                            <th style="padding:8px; text-align:right;">Balance</th>
                            <th style="padding:8px; text-align:right;">Floor Limit</th>
                            <th style="padding:8px; text-align:right;">Available</th>
                        </tr>
                    </thead>
                    <tbody>${accountRows}</tbody>
                </table>

                <h3 style="color:#1e3a5f; border-bottom:2px solid #1e3a5f; padding-bottom:8px;">
                    Investment Portfolio
                </h3>
                <table style="width:100%; border-collapse:collapse; margin-bottom:24px;">
                    <thead>
                        <tr style="background:#f3f4f6;">
                            <th style="padding:8px; text-align:left;">Investment</th>
                            <th style="padding:8px; text-align:left;">Status</th>
                            <th style="padding:8px; text-align:right;">Budget</th>
                            <th style="padding:8px; text-align:right;">Spent</th>
                            <th style="padding:8px; text-align:right;">ROI</th>
                        </tr>
                    </thead>
                    <tbody>${investmentRows || '<tr><td colspan="5" style="padding:8px; text-align:center;">No active investments</td></tr>'}</tbody>
                </table>

                <h3 style="color:#1e3a5f; border-bottom:2px solid #1e3a5f; padding-bottom:8px;">
                    Upcoming Events (Next 30 Days)
                </h3>
                <table style="width:100%; border-collapse:collapse; margin-bottom:24px;">
                    <thead>
                        <tr style="background:#f3f4f6;">
                            <th style="padding:8px; text-align:left;">Event</th>
                            <th style="padding:8px; text-align:left;">Type</th>
                            <th style="padding:8px; text-align:left;">Date</th>
                            <th style="padding:8px; text-align:left;">Location</th>
                        </tr>
                    </thead>
                    <tbody>${upcomingRows || '<tr><td colspan="4" style="padding:8px; text-align:center;">No upcoming events</td></tr>'}</tbody>
                </table>

            </div>

            <div style="background:#f3f4f6; padding:16px; border-radius:0 0 8px 8px;
                        text-align:center; color:#6b7280; font-size:12px;">
                This report was automatically generated by ${companyName} Management System
                on ${new Date().toLocaleDateString('en-GB')}.
                Generated at: ${new Date().toLocaleTimeString('en-GB')}
            </div>
        </div>
    `;
};

// ============================================================
// RENDER INDIVIDUAL REPORT AS HTML
// ============================================================
const renderIndividualReportHTML = async (report) => {
    const branding = await getBranding();
    const companyName = branding.company_name;

    const contributionRows = report.contributions_period.map(c => `
        <tr>
            <td style="padding:8px; border-bottom:1px solid #e5e7eb;">
                ${c.reference_code}
            </td>
            <td style="padding:8px; border-bottom:1px solid #e5e7eb;">
                ${new Date(c.contribution_date).toLocaleDateString('en-GB')}
            </td>
            <td style="padding:8px; border-bottom:1px solid #e5e7eb; text-align:right;">
                ${parseFloat(c.amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}
            </td>
            <td style="padding:8px; border-bottom:1px solid #e5e7eb;">
                ${c.category_trail}
            </td>
        </tr>
    `).join('');

    return `
        <div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto;">
            <div style="background:#1e3a5f; color:white; padding:24px; border-radius:8px 8px 0 0;">
                <h1 style="margin:0; font-size:24px;">${companyName}</h1>
                <h2 style="margin:8px 0 0; font-size:16px; font-weight:normal;">
                    Personal Financial Report — ${report.period}
                </h2>
            </div>

            <div style="background:white; padding:24px; border:1px solid #e5e7eb;">

                <h3 style="color:#1e3a5f;">Member Details</h3>
                <table style="width:100%; margin-bottom:24px;">
                    <tr>
                        <td style="padding:4px; color:#6b7280; width:160px;">Name</td>
                        <td style="padding:4px; font-weight:bold;">
                            ${report.member.first_name} ${report.member.last_name}
                        </td>
                    </tr>
                    <tr>
                        <td style="padding:4px; color:#6b7280;">Email</td>
                        <td style="padding:4px;">${report.member.email}</td>
                    </tr>
                    <tr>
                        <td style="padding:4px; color:#6b7280;">Roles</td>
                        <td style="padding:4px;">${report.member.roles.join(', ')}</td>
                    </tr>
                    ${report.shareholding ? `
                    <tr>
                        <td style="padding:4px; color:#6b7280;">Shares Held</td>
                        <td style="padding:4px;">
                            ${parseFloat(report.shareholding.shares_held).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                        </td>
                    </tr>
                    <tr>
                        <td style="padding:4px; color:#6b7280;">Shareholding %</td>
                        <td style="padding:4px; font-weight:bold; color:#1e3a5f;">
                            ${report.shareholding.percentage || '—'}%
                        </td>
                    </tr>` : ''}
                    <tr>
                        <td style="padding:4px; color:#6b7280;">Total Contributed</td>
                        <td style="padding:4px; font-weight:bold;">
                            ${parseFloat(report.total_contributed).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                        </td>
                    </tr>
                </table>

                <h3 style="color:#1e3a5f; border-bottom:2px solid #1e3a5f; padding-bottom:8px;">
                    Contributions This Period
                </h3>
                <table style="width:100%; border-collapse:collapse; margin-bottom:24px;">
                    <thead>
                        <tr style="background:#f3f4f6;">
                            <th style="padding:8px; text-align:left;">Reference</th>
                            <th style="padding:8px; text-align:left;">Date</th>
                            <th style="padding:8px; text-align:right;">Amount</th>
                            <th style="padding:8px; text-align:left;">Category</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${contributionRows ||
                          '<tr><td colspan="4" style="padding:8px; text-align:center;">No contributions this period</td></tr>'}
                    </tbody>
                </table>

            </div>

            <div style="background:#f3f4f6; padding:16px; border-radius:0 0 8px 8px;
                        text-align:center; color:#6b7280; font-size:12px;">
                This is a confidential personal report generated for
                ${report.member.first_name} ${report.member.last_name} only.
                ${companyName} — ${new Date().toLocaleDateString('en-GB')}
            </div>
        </div>
    `;
};

// ============================================================
// SEND GENERAL REPORT TO ALL MEMBERS
// ============================================================
const sendGeneralReportToAllMembers = async (year, month) => {
    const report    = await generateGeneralReport(year, month);
    const html      = await renderGeneralReportHTML(report);
    const branding  = await getBranding();
    const subject   = `${branding.company_name} — Monthly Report: ${report.period}`;

    // Get all active members
    const members = await query(`
        SELECT id, email, first_name, last_name
        FROM   users
        WHERE  is_active = TRUE
        AND    is_email_verified = TRUE
        ORDER  BY first_name ASC
    `);

    const results = [];
    for (const member of members.rows) {
        const result = await sendEmail({
            to:      member.email,
            subject,
            html,
        });
        results.push({ email: member.email, ...result });

        // Bell notification too — no `email` block here since sendEmail
        // above already delivered it; this just surfaces it in the bell.
        notify({
            userId: member.id,
            type:   'MONTHLY_REPORT_SENT',
            title:  `Monthly report — ${report.period}`,
            body:   `The company's monthly report for ${report.period} has been emailed to you.`,
            link:   `/reports`,
            module: 'REPORTS',
        });

        await new Promise(resolve => setTimeout(resolve, 200));
    }

    return {
        period:       report.period,
        recipients:   members.rows.length,
        sent:         results.filter(r => r.success).length,
        failed:       results.filter(r => !r.success).length,
    };
};

// ============================================================
// SEND INDIVIDUAL REPORTS TO ALL MEMBERS
// ============================================================
const sendIndividualReportsToAllMembers = async (year, month) => {
    const members = await query(`
        SELECT id, email, first_name, last_name
        FROM   users
        WHERE  is_active = TRUE
        AND    is_email_verified = TRUE
    `);
    const branding = await getBranding();

    const results = [];
    for (const member of members.rows) {
        const report = await generateIndividualReport(member.id, year, month);
        if (!report) continue;

        const html = await renderIndividualReportHTML(report);
        const result = await sendEmail({
            to:      member.email,
            subject: `${branding.company_name} — Your Personal Report: ${report.period}`,
            html,
        });
        results.push({ email: member.email, ...result });

        notify({
            userId: member.id,
            type:   'PERSONAL_REPORT_SENT',
            title:  `Your personal report — ${report.period}`,
            body:   `Your personal financial report for ${report.period} has been emailed to you.`,
            link:   `/reports/me`,
            module: 'REPORTS',
        });

        await new Promise(resolve => setTimeout(resolve, 200));
    }

    return {
        recipients: members.rows.length,
        sent:       results.filter(r => r.success).length,
        failed:     results.filter(r => !r.success).length,
    };
};

module.exports = {
    generateGeneralReport,
    generateIndividualReport,
    renderGeneralReportHTML,
    renderIndividualReportHTML,
    sendGeneralReportToAllMembers,
    sendIndividualReportsToAllMembers,
};