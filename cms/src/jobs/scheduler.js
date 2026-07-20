// ============================================================
// SCHEDULER
// Runs automated background jobs on a schedule using node-cron.
//
// JOBS:
//   1. Monthly general report      — 1st of every month at 8am
//   2. Monthly individual report   — 1st of every month at 9am
//   3. Daily interest accrual      — every day at midnight
//   4. Daily overdue check         — every day at 00:05am
//   5. Monthly share certificates  — 1st of every month at 10am
//   6. Annual share certificates   — 1st of January at 10:10am
//   7. Side fund due generation    — 1st of every month at 00:15
//   8. Side fund default check     — 1st of every month at 00:20
// ============================================================

const cron = require('node-cron');
const { query } = require('../config/database');
const logger = require('../config/logger');
const {
    sendGeneralReportToAllMembers,
    sendIndividualReportsToAllMembers,
} = require('../services/reportService');
const { calculateDailyAccrual, calculateSimpleInterest, calculateCompoundInterest } = require('../services/loanService');
const { issueCertificatesForAllShareholders } = require('../services/certificateService');

// ============================================================
// JOB 1: MONTHLY GENERAL REPORT
// Runs on the 1st of every month at 8:00 AM
// Sends the company financial report to all members
// ============================================================
const scheduleMonthlyGeneralReport = () => {
    const cronExpression = process.env.MONTHLY_REPORT_CRON || '0 8 1 * *';

    cron.schedule(cronExpression, async () => {
        logger.info('Starting monthly general report job...');
        try {
            const now   = new Date();
            // Report covers the previous month
            const month = now.getMonth() === 0 ? 12 : now.getMonth();
            const year  = now.getMonth() === 0
                ? now.getFullYear() - 1
                : now.getFullYear();

            const result = await sendGeneralReportToAllMembers(year, month);

            logger.info('Monthly general report job completed', result);

            // Log to report_log table
            await query(`
                INSERT INTO report_log (
                    report_type, report_period,
                    send_status, sent_at, generated_by
                ) VALUES (
                    'MONTHLY_GENERAL',
                    $1,
                    'SENT',
                    NOW(),
                    NULL
                )
            `, [`${year}${String(month).padStart(2, '0')}`]);

        } catch (err) {
            logger.error('Monthly general report job failed', { error: err.message });
        }
    }, {
        timezone: 'Africa/Kampala',
    });

    logger.info(`Monthly general report scheduled: ${cronExpression}`);
};

// ============================================================
// JOB 2: MONTHLY INDIVIDUAL REPORTS
// Runs on the 1st of every month at 9:00 AM
// Sends personal reports to each member
// ============================================================
const scheduleMonthlyIndividualReports = () => {
    // One hour after the general report
    const cronExpression = '0 9 1 * *';

    cron.schedule(cronExpression, async () => {
        logger.info('Starting monthly individual reports job...');
        try {
            const now   = new Date();
            const month = now.getMonth() === 0 ? 12 : now.getMonth();
            const year  = now.getMonth() === 0
                ? now.getFullYear() - 1
                : now.getFullYear();

            const result = await sendIndividualReportsToAllMembers(year, month);

            logger.info('Monthly individual reports job completed', result);

        } catch (err) {
            logger.error('Monthly individual reports job failed', { error: err.message });
        }
    }, {
        timezone: 'Africa/Kampala',
    });

    logger.info('Monthly individual reports scheduled: 0 9 1 * *');
};

// ============================================================
// JOB 3: DAILY INTEREST ACCRUAL
// Runs every day at midnight (00:00)
// Calculates and records interest on all active loans
// ============================================================
const scheduleDailyInterestAccrual = () => {
    cron.schedule('0 0 * * *', async () => {
        logger.info('Starting daily interest accrual job...');
        const today = new Date().toISOString().split('T')[0];

        try {
            // Get all active loans received
            const loansReceived = await query(`
                SELECT
                    lr.*,
                    -- Get most recent penalty rate amendment if any
                    (
                        SELECT new_penalty_rate
                        FROM   loan_received_rate_amendments
                        WHERE  loan_received_id = lr.id
                        AND    effective_from <= $1
                        ORDER  BY effective_from DESC
                        LIMIT  1
                    ) AS current_penalty_rate
                FROM loans_received lr
                WHERE lr.status IN ('ACTIVE', 'OVERDUE', 'PARTIALLY_REPAID')
            `, [today]);

            let accrualCount = 0;

            for (const loan of loansReceived.rows) {
                // Check if accrual already done today
                const existing = await query(`
                    SELECT id FROM loan_received_interest_accrual
                    WHERE  loan_received_id = $1
                    AND    accrual_date = $2
                `, [loan.id, today]);

                if (existing.rows.length > 0) continue;

                // Calculate today's accrual
                const accrual = calculateDailyAccrual(loan, new Date(today));

                // Record the accrual
                await query(`
                    INSERT INTO loan_received_interest_accrual (
                        loan_received_id,
                        accrual_date,
                        rate_used,
                        rate_type,
                        principal_balance,
                        interest_accrued
                    ) VALUES ($1, $2, $3, $4, $5, $6)
                `, [
                    loan.id,
                    today,
                    accrual.rate_used,
                    accrual.rate_type,
                    accrual.principal_balance,
                    accrual.interest_accrued,
                ]);

                // Update outstanding interest on the loan
                await query(`
                    UPDATE loans_received
                    SET    outstanding_interest = outstanding_interest + $1
                    WHERE  id = $2
                `, [accrual.interest_accrued, loan.id]);

                accrualCount++;
            }

            // Get all active loans given
            const loansGiven = await query(`
                SELECT
                    lg.*,
                    (
                        SELECT new_penalty_rate
                        FROM   loan_given_rate_amendments
                        WHERE  loan_given_id = lg.id
                        AND    effective_from <= $1
                        ORDER  BY effective_from DESC
                        LIMIT  1
                    ) AS current_penalty_rate
                FROM loans_given lg
                WHERE lg.status IN ('ACTIVE', 'OVERDUE', 'PARTIALLY_REPAID')
            `, [today]);

            for (const loan of loansGiven.rows) {
                const existing = await query(`
                    SELECT id FROM loan_given_interest_accrual
                    WHERE  loan_given_id = $1
                    AND    accrual_date  = $2
                `, [loan.id, today]);

                if (existing.rows.length > 0) continue;

                const accrual = calculateDailyAccrual(loan, new Date(today));

                await query(`
                    INSERT INTO loan_given_interest_accrual (
                        loan_given_id,
                        accrual_date,
                        rate_used,
                        rate_type,
                        principal_balance,
                        interest_accrued
                    ) VALUES ($1, $2, $3, $4, $5, $6)
                `, [
                    loan.id,
                    today,
                    accrual.rate_used,
                    accrual.rate_type,
                    accrual.principal_balance,
                    accrual.interest_accrued,
                ]);

                await query(`
                    UPDATE loans_given
                    SET    outstanding_interest = outstanding_interest + $1
                    WHERE  id = $2
                `, [accrual.interest_accrued, loan.id]);

                accrualCount++;
            }

            logger.info(`Daily interest accrual completed — ${accrualCount} loans processed`);

        } catch (err) {
            logger.error('Daily interest accrual job failed', { error: err.message });
        }
    }, {
        timezone: 'Africa/Kampala',
    });

    logger.info('Daily interest accrual scheduled: 0 0 * * *');
};

// ============================================================
// JOB 4: DAILY OVERDUE CHECK
// Runs every day at 00:05 AM
// Switches loan status to OVERDUE when due date has passed
// Also switches interest rate from fixed to penalty
// ============================================================
const scheduleDailyOverdueCheck = () => {
    cron.schedule('5 0 * * *', async () => {
        logger.info('Starting daily overdue check job...');
        const today = new Date().toISOString().split('T')[0];

        try {
            // Check loans received
            const overdueReceived = await query(`
                UPDATE loans_received
                SET    status       = 'OVERDUE',
                       is_overdue   = TRUE,
                       overdue_since = $1
                WHERE  due_date < $1
                AND    status IN ('ACTIVE', 'PARTIALLY_REPAID')
                AND    is_overdue = FALSE
                RETURNING id, lender_name
            `, [today]);

            // Check loans given
            const overdueGiven = await query(`
                UPDATE loans_given
                SET    status        = 'OVERDUE',
                       is_overdue    = TRUE,
                       overdue_since = $1
                WHERE  due_date < $1
                AND    status IN ('ACTIVE', 'PARTIALLY_REPAID')
                AND    is_overdue = FALSE
                RETURNING id, borrower_name
            `, [today]);

            logger.info('Daily overdue check completed', {
                loans_received_overdue: overdueReceived.rows.length,
                loans_given_overdue:    overdueGiven.rows.length,
            });

        } catch (err) {
            logger.error('Daily overdue check job failed', { error: err.message });
        }
    }, {
        timezone: 'Africa/Kampala',
    });

    logger.info('Daily overdue check scheduled: 5 0 * * *');
};

// ============================================================
// JOB 4b: DAILY SAVINGS INTEREST ACCRUAL
// Runs every day at 00:10 (after the loan accrual job).
// Accrues interest on every member's FLEXIBLE savings principal
// balance at the single company-wide rate in savings_settings —
// mirrors the loan accrual job's pattern exactly.
// ============================================================
const scheduleDailySavingsAccrual = () => {
    cron.schedule('10 0 * * *', async () => {
        logger.info('Starting daily savings interest accrual job...');
        const today = new Date().toISOString().split('T')[0];

        try {
            const settingsResult = await query('SELECT * FROM savings_settings WHERE id = 1');
            const settings = settingsResult.rows[0];
            if (!settings || parseFloat(settings.interest_rate) <= 0) {
                logger.info('Savings interest rate is 0 — skipping accrual');
                return;
            }

            const balances = await query(`
                SELECT * FROM savings_balances WHERE principal_balance > 0
            `);

            let accrualCount = 0;

            for (const balance of balances.rows) {
                const existing = await query(`
                    SELECT id FROM savings_interest_accrual
                    WHERE  user_id = $1 AND accrual_date = $2
                `, [balance.user_id, today]);

                if (existing.rows.length > 0) continue;

                const principal = parseFloat(balance.principal_balance);
                const interestAccrued = settings.interest_calculation === 'SIMPLE'
                    ? calculateSimpleInterest(principal, settings.interest_rate, settings.interest_period, 1)
                    : calculateCompoundInterest(principal, settings.interest_rate, settings.interest_period, 1);

                const rounded = parseFloat(interestAccrued.toFixed(4));

                await query(`
                    INSERT INTO savings_interest_accrual (
                        user_id, accrual_date, rate_used, principal_balance, interest_accrued
                    ) VALUES ($1, $2, $3, $4, $5)
                `, [balance.user_id, today, settings.interest_rate, principal, rounded]);

                await query(`
                    UPDATE savings_balances
                    SET    accrued_interest = accrued_interest + $1,
                           updated_at = NOW()
                    WHERE  user_id = $2
                `, [rounded, balance.user_id]);

                accrualCount++;
            }

            logger.info(`Daily savings interest accrual completed — ${accrualCount} members processed`);
        } catch (err) {
            logger.error('Daily savings interest accrual job failed', { error: err.message });
        }
    }, {
        timezone: 'Africa/Kampala',
    });

    logger.info('Daily savings interest accrual scheduled: 10 0 * * *');
};

// ============================================================
// JOB 4c: MONTHLY SIDE FUND DUE GENERATION
// Runs on the 1st of every month at 00:15 (after the daily accrual
// jobs). Creates one side_fund_dues row per active shareholder for
// the new month, using whatever monthly_amount is set on
// side_fund_config at that time. Does nothing if the side fund
// isn't active. Safe to re-run — ON CONFLICT DO NOTHING per member.
// ============================================================
const scheduleSideFundDueGeneration = () => {
    cron.schedule('15 0 1 * *', async () => {
        logger.info('Starting monthly side fund due generation job...');
        try {
            const configResult = await query('SELECT * FROM side_fund_config WHERE id = 1');
            const config = configResult.rows[0];
            if (!config || !config.is_active) {
                logger.info('Side fund is not active — skipping due generation');
                return;
            }

            const now = new Date();
            const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

            const shareholders = await query(`
                SELECT sr.user_id
                FROM   shareholding_registry sr
                JOIN   users u ON u.id = sr.user_id
                WHERE  sr.effective_to IS NULL
                AND    u.is_active = TRUE
            `);

            let created = 0;
            for (const s of shareholders.rows) {
                const result = await query(`
                    INSERT INTO side_fund_dues (user_id, period, amount_due, status)
                    VALUES ($1, $2, $3, 'PENDING')
                    ON CONFLICT (user_id, period) DO NOTHING
                    RETURNING id
                `, [s.user_id, period, config.monthly_amount]);
                if (result.rows.length > 0) created++;
            }

            logger.info(`Side fund due generation completed — ${created} dues created for ${period}`);
        } catch (err) {
            logger.error('Side fund due generation job failed', { error: err.message });
        }
    }, {
        timezone: 'Africa/Kampala',
    });

    logger.info('Side fund due generation scheduled: 15 0 1 * *');
};

// ============================================================
// JOB 4d: MONTHLY SIDE FUND DEFAULT CHECK
// Runs on the 1st of every month at 00:20 (right after due
// generation above). Any due from the month that just ended that's
// still PENDING or PARTIAL is marked DEFAULTED — a record that it
// wasn't paid, not a block on anything. The member can still settle
// it later; recordDuePayment doesn't check status beyond "not PAID".
// ============================================================
const scheduleSideFundDefaultCheck = () => {
    cron.schedule('20 0 1 * *', async () => {
        logger.info('Starting monthly side fund default check job...');
        try {
            const now = new Date();
            const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
            const previousPeriod = `${prevMonthDate.getFullYear()}-${String(prevMonthDate.getMonth() + 1).padStart(2, '0')}`;

            const result = await query(`
                UPDATE side_fund_dues
                SET    status = 'DEFAULTED', updated_at = NOW()
                WHERE  period = $1
                AND    status IN ('PENDING', 'PARTIAL')
                RETURNING id
            `, [previousPeriod]);

            logger.info(`Side fund default check completed — ${result.rows.length} dues defaulted for ${previousPeriod}`);
        } catch (err) {
            logger.error('Side fund default check job failed', { error: err.message });
        }
    }, {
        timezone: 'Africa/Kampala',
    });

    logger.info('Side fund default check scheduled: 20 0 1 * *');
};

// ============================================================
// JOB 5: MONTHLY SHARE CERTIFICATES
// Runs on the 1st of every month at 10:00 AM (after the two
// report jobs above). Issues + emails every active shareholder
// a Monthly Certificate of Shares — the same pipeline the Admin
// "Issue Certificates Now" button runs manually.
// ============================================================
const scheduleMonthlyShareCertificates = () => {
    const cronExpression = process.env.MONTHLY_CERTIFICATE_CRON || '0 10 1 * *';

    cron.schedule(cronExpression, async () => {
        logger.info('Starting monthly share certificate job...');
        try {
            const result = await issueCertificatesForAllShareholders('MONTHLY');
            logger.info('Monthly share certificate job completed', result);
        } catch (err) {
            logger.error('Monthly share certificate job failed', { error: err.message });
        }
    }, {
        timezone: 'Africa/Kampala',
    });

    logger.info(`Monthly share certificates scheduled: ${cronExpression}`);
};

// ============================================================
// JOB 6: ANNUAL SHARE CERTIFICATES
// Runs once a year, 1st of January at 10:10 AM. Issues + emails
// every active shareholder an Annual Certificate of Shares,
// labelled for the year that just ended.
// ============================================================
const scheduleAnnualShareCertificates = () => {
    const cronExpression = process.env.ANNUAL_CERTIFICATE_CRON || '10 10 1 1 *';

    cron.schedule(cronExpression, async () => {
        logger.info('Starting annual share certificate job...');
        try {
            const result = await issueCertificatesForAllShareholders('ANNUAL');
            logger.info('Annual share certificate job completed', result);
        } catch (err) {
            logger.error('Annual share certificate job failed', { error: err.message });
        }
    }, {
        timezone: 'Africa/Kampala',
    });

    logger.info(`Annual share certificates scheduled: ${cronExpression}`);
};

// ============================================================
// START ALL SCHEDULED JOBS
// Called once when the server starts
// ============================================================
const startAllJobs = () => {
    logger.info('Starting scheduled jobs...');
    scheduleMonthlyGeneralReport();
    scheduleMonthlyIndividualReports();
    scheduleDailyInterestAccrual();
    scheduleDailyOverdueCheck();
    scheduleDailySavingsAccrual();
    scheduleSideFundDueGeneration();
    scheduleSideFundDefaultCheck();
    scheduleMonthlyShareCertificates();
    scheduleAnnualShareCertificates();
    logger.info('All scheduled jobs started successfully');
};

module.exports = { startAllJobs };