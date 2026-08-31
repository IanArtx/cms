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
//   6b. Certificate signing reminders — daily 08:00, last week of month
//   6c. Document signature reminders — daily 08:30
//   7. Side fund due generation    — 1st of every month at 00:15
//   8. Side fund default check     — 1st of every month at 00:20
//   9. Capital goal call deadlines — every day at 00:30
// ============================================================

const cron = require('node-cron');
const { query, withTransaction } = require('../config/database');
const logger = require('../config/logger');
const {
    sendGeneralReportToAllMembers,
    sendIndividualReportsToAllMembers,
} = require('../services/reportService');
const { calculateDailyAccrual, calculateSimpleInterest, calculateCompoundInterest } = require('../services/loanService');
const { issueCertificatesForAllShareholders } = require('../services/certificateService');
const { getSignatureStatus, notifyPendingSignatories } = require('../services/signatureService');
const { notify, notifyMany } = require('../services/notificationService');
const { wrapEmail } = require('../services/emailTemplates');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');
const { generateDuesForPeriod } = require('../services/sideFundService');
const { processIteration1Deadline, processIteration2Deadline } = require('../services/capitalGoalCallService');

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
// the new month, using that member's own side_fund_member_overrides
// amount if one is set (v1.25.0), otherwise the company-wide
// side_fund_config.monthly_amount. Does nothing if the side fund
// isn't active. Safe to re-run — ON CONFLICT DO NOTHING per member.
//
// v1.25.0 — right after a new due is created, this also checks
// whether that member has a banked side_fund_member_credit balance
// (from a past overpayment) and immediately draws it down against
// the new due — no new transaction is posted here, since the money
// already moved into the account back when the credit was originally
// banked; this step only reallocates it to a specific due.
// ============================================================
const scheduleSideFundDueGeneration = () => {
    cron.schedule('15 0 1 * *', async () => {
        logger.info('Starting monthly side fund due generation job...');
        try {
            const now = new Date();
            const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

            // v1.28.3 — the actual generation logic now lives in
            // services/sideFundService.js, shared with the manual
            // "Generate Dues Now" trigger (sideFundController.generateDues)
            // so both behave identically.
            const result = await generateDuesForPeriod(period);
            if (result.skipped) {
                logger.info(`Side fund due generation skipped for ${period} — ${result.reason}`);
                return;
            }

            logger.info(`Side fund due generation completed — ${result.created}/${result.total} dues created for ${period}, credit auto-applied to ${result.creditApplied}`);
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
// JOB 6b: CERTIFICATE SIGNING ROUND REMINDERS (v1.23.0, Section 4.29)
// Runs every day at 08:00 during the last week of the month
// (day-of-month 24-31 covers it regardless of month length — cron
// simply never matches on months shorter than the day given). For
// any still-OPEN certificate_signing_rounds row, reminds whichever
// signatories still have a PENDING slot that accounts should be up
// to date by now and their signature is overdue. Safe to run more
// than once a day/week — it just re-notifies, there's no dedup
// table, since a signatory who already signed no longer has a
// PENDING slot to be reminded about.
// ============================================================
const scheduleCertificateSigningReminders = () => {
    cron.schedule('0 8 24-31 * *', async () => {
        logger.info('Starting certificate signing round reminder job...');
        try {
            const openRounds = await query(`
                SELECT id, certificate_type, period_label
                FROM   certificate_signing_rounds
                WHERE  status = 'OPEN'
            `);

            let remindersSent = 0;

            for (const round of openRounds.rows) {
                const signatures = await getSignatureStatus('CERTIFICATE_ROUND', round.id);
                const pendingRoleIds = signatures.filter(s => s.status === 'PENDING').map(s => s.role_id);
                if (pendingRoleIds.length === 0) continue;

                const signatoriesResult = await query(`
                    SELECT DISTINCT u.id, u.first_name, u.email
                    FROM   user_roles ur
                    JOIN   users u ON u.id = ur.user_id AND u.is_active = TRUE
                    WHERE  ur.role_id = ANY($1::int[]) AND ur.revoked_at IS NULL
                `, [pendingRoleIds]);

                await notifyMany(signatoriesResult.rows, 'CERTIFICATE_ROUND_REMINDER', (recipient) => ({
                    title: `Last week of the month — Certificate of Shares signature still pending`,
                    body:  `The ${round.period_label} certificate round is still waiting on your signature. Please review now that accounts are up to date.`,
                    // v1.41.0 fix: '/certificates' isn't a real route — certificate
                    // download/signing actually lives on the Profile page.
                    link:  '/profile',
                    module: 'SYSTEM',
                    recordType: 'certificate_signing_rounds',
                    recordId: round.id,
                    email: {
                        subject: `Reminder: Certificate of Shares signature pending — ${round.period_label}`,
                        html: `<p>Dear ${recipient.first_name},</p>
                               <p>It's the last week of the month — the ${round.period_label} Certificate of Shares
                               round is still waiting on your signature. Please sign in to review and sign it now
                               that accounts for the period are up to date.</p>`,
                    },
                })).catch(() => {});

                remindersSent += signatoriesResult.rows.length;
            }

            logger.info(`Certificate signing round reminder job completed — ${remindersSent} reminder(s) sent across ${openRounds.rows.length} open round(s)`);
        } catch (err) {
            logger.error('Certificate signing round reminder job failed', { error: err.message });
        }
    }, {
        timezone: 'Africa/Kampala',
    });

    logger.info('Certificate signing round reminders scheduled: 0 8 24-31 * *');
};

// ============================================================
// JOB 6c: DOCUMENT SIGNATURE REMINDERS (v1.23.1, Section 4.29)
// Runs every day at 08:30. For any DOCUMENT (Resolution/Loan/Grant
// Agreement) with at least one still-PENDING signature slot, reminds
// (bell + email) whoever currently holds a role with an open slot.
// Unlike the certificate round reminder (which only makes sense
// during the last week of the month), a Resolution can be opened for
// signature any day of the month, so this simply reminds daily for
// as long as any slot on it stays PENDING — no dedup table, since a
// signatory who already signed no longer has a PENDING slot to be
// reminded about.
// ============================================================
const scheduleDocumentSignatureReminders = () => {
    cron.schedule('30 8 * * *', async () => {
        logger.info('Starting document signature reminder job...');
        try {
            const openDocs = await query(`
                SELECT DISTINCT d.id, d.title
                FROM   documents d
                JOIN   document_signatures ds ON ds.target_type = 'DOCUMENT' AND ds.target_id = d.id
                WHERE  ds.status = 'PENDING'
            `);

            let remindersSent = 0;
            for (const doc of openDocs.rows) {
                const { notified } = await notifyPendingSignatories('DOCUMENT', doc.id, 'DOCUMENT_SIGNATURE_REMINDER', {
                    title: `Signature still pending: ${doc.title}`,
                    link: '/documents',
                    recordType: 'documents',
                    emailSubject: `Reminder: your signature is needed — ${doc.title}`,
                    buildEmailHtml: (recipient) => `<p>Dear ${recipient.first_name},</p>
                        <p>The document <strong>${doc.title}</strong> is still waiting on your signature
                        (${recipient.roleNames.join(', ')}). Please sign in to review and sign it.</p>`,
                });
                remindersSent += notified;
            }

            logger.info(`Document signature reminder job completed — ${remindersSent} reminder(s) sent across ${openDocs.rows.length} document(s)`);
        } catch (err) {
            logger.error('Document signature reminder job failed', { error: err.message });
        }
    }, {
        timezone: 'Africa/Kampala',
    });

    logger.info('Document signature reminders scheduled: 30 8 * * *');
};

// ============================================================
// JOB 7: AUDIT ENGAGEMENT ACCESS-EXPIRY REMINDERS
// Runs every day at 07:00. For every ACTIVE audit engagement with
// an access_expires_at set, emails the auditor once at each of the
// configured day-thresholds as that date approaches (7, 3, and 1
// day(s) before). Dedup lives in audit_engagement_reminders_sent
// (UNIQUE engagement_id + days_before) — same insert-and-detect-
// conflict idiom as side_fund_dues above, so a re-run on the same
// day is always safe.
// ============================================================
const AUDIT_REMINDER_DAY_THRESHOLDS = [7, 3, 1];

const scheduleAuditAccessExpiryReminders = () => {
    cron.schedule('0 7 * * *', async () => {
        logger.info('Starting audit access-expiry reminder job...');
        try {
            const engagements = await query(`
                SELECT e.id, e.name, e.access_expires_at
                FROM   audit_engagements e
                WHERE  e.status = 'ACTIVE' AND e.access_expires_at IS NOT NULL
            `);

            const msPerDay = 24 * 60 * 60 * 1000;
            let sentCount = 0;

            for (const engagement of engagements.rows) {
                const daysRemaining = Math.ceil(
                    (new Date(engagement.access_expires_at).getTime() - Date.now()) / msPerDay
                );
                if (!AUDIT_REMINDER_DAY_THRESHOLDS.includes(daysRemaining)) continue;

                const usersResult = await query(`
                    SELECT u.id, u.first_name, u.email
                    FROM   audit_engagement_users eu
                    JOIN   users u ON u.id = eu.user_id
                    WHERE  eu.engagement_id = $1
                `, [engagement.id]);

                for (const auditor of usersResult.rows) {
                    let dedupOk = true;
                    try {
                        const inserted = await query(`
                            INSERT INTO audit_engagement_reminders_sent (engagement_id, days_before)
                            VALUES ($1, $2)
                            ON CONFLICT (engagement_id, days_before) DO NOTHING
                            RETURNING id
                        `, [engagement.id, daysRemaining]);
                        dedupOk = inserted.rows.length > 0;
                    } catch (err) {
                        logger.error('Audit reminder dedup insert failed', { error: err.message });
                        continue;
                    }
                    if (!dedupOk) continue;

                    const expiryDate = new Date(engagement.access_expires_at).toDateString();
                    await notify({
                        userId:  auditor.id,
                        type:    'AUDIT_ACCESS_EXPIRING',
                        title:   `Audit access expires in ${daysRemaining} day${daysRemaining === 1 ? '' : 's'}`,
                        body:    `Your access to "${engagement.name}" expires on ${expiryDate}.`,
                        link:    '/audit',
                        module:  'SYSTEM',
                        recordType: 'audit_engagements',
                        recordId: engagement.id,
                        email: {
                            subject: `Audit access expires in ${daysRemaining} day${daysRemaining === 1 ? '' : 's'}`,
                            html: await wrapEmail(`
                                <p style="margin:0 0 12px 0;">Hello ${auditor.first_name},</p>
                                <p style="margin:0 0 12px 0;">Your access to the audit engagement <strong>${engagement.name}</strong>
                                    expires on <strong>${expiryDate}</strong> (${daysRemaining} day${daysRemaining === 1 ? '' : 's'} from now).</p>
                                <p style="margin:0 0 12px 0;">If you need more time to complete the audit, you can request an
                                    extension from the External Audit portal before access expires.</p>
                            `, { preheader: `Your audit access expires in ${daysRemaining} day(s)` }),
                        },
                    }).catch(() => {});

                    await logAction(null, ACTIONS.AUDIT_REMINDER_SENT, MODULES.SYSTEM, {
                        recordType:  'audit_engagements',
                        recordId:    engagement.id,
                        description: `Access-expiry reminder (${daysRemaining} day(s)) sent for engagement "${engagement.name}"`,
                    }).catch(() => {});

                    sentCount++;
                }
            }

            logger.info(`Audit access-expiry reminder job completed — ${sentCount} reminder(s) sent`);
        } catch (err) {
            logger.error('Audit access-expiry reminder job failed', { error: err.message });
        }
    }, {
        timezone: 'Africa/Kampala',
    });

    logger.info('Audit access-expiry reminders scheduled: 0 7 * * *');
};

// ============================================================
// JOB 9: CAPITAL GOAL CALL — DEADLINE TRANSITIONS (v1.43.0)
// Runs daily at 00:30 (after the side fund jobs). Two independent
// sweeps:
//   1. Every monthly call still in ITERATION_1 whose own deadline has
//      passed — either closes it outright (target was fully met) or
//      opens iteration 2 for 7 more days (capitalGoalCallService
//      handles both branches and all the eligibility/notification
//      logic — this job is just the trigger).
//   2. Every monthly call in ITERATION_2 whose 7-day window has
//      passed — closes it out. No further iterations.
// Each row is processed in its own transaction so one failure can't
// block the rest of the sweep.
// ============================================================
const scheduleCapitalGoalCallDeadlines = () => {
    cron.schedule('30 0 * * *', async () => {
        logger.info('Starting capital goal call deadline sweep...');
        const today = new Date().toISOString().slice(0, 10);
        let iteration1Processed = 0;
        let iteration2Processed = 0;

        try {
            const dueIteration1 = await query(`
                SELECT id FROM capital_goal_monthly_calls
                WHERE  status = 'ITERATION_1' AND iteration1_deadline < $1
            `, [today]);
            for (const row of dueIteration1.rows) {
                try {
                    await withTransaction(async (client) => {
                        const callResult = await client.query(
                            'SELECT * FROM capital_goal_monthly_calls WHERE id = $1 FOR UPDATE', [row.id]
                        );
                        if (callResult.rows.length === 0) return;
                        await processIteration1Deadline(client, callResult.rows[0]);
                    });
                    iteration1Processed++;
                } catch (err) {
                    logger.error(`Capital goal call iteration-1 deadline processing failed for monthly call ${row.id}`, { error: err.message });
                }
            }

            const dueIteration2 = await query(`
                SELECT id FROM capital_goal_monthly_calls
                WHERE  status = 'ITERATION_2' AND iteration2_deadline < $1
            `, [today]);
            for (const row of dueIteration2.rows) {
                try {
                    await withTransaction(async (client) => {
                        await processIteration2Deadline(client, row.id);
                    });
                    iteration2Processed++;
                } catch (err) {
                    logger.error(`Capital goal call iteration-2 deadline processing failed for monthly call ${row.id}`, { error: err.message });
                }
            }

            logger.info(`Capital goal call deadline sweep completed — ${iteration1Processed} iteration-1 deadline(s), ${iteration2Processed} iteration-2 deadline(s) processed`);
        } catch (err) {
            logger.error('Capital goal call deadline sweep failed', { error: err.message });
        }
    }, {
        timezone: 'Africa/Kampala',
    });

    logger.info('Capital goal call deadline sweep scheduled: 30 0 * * *');
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
    scheduleCapitalGoalCallDeadlines();
    scheduleMonthlyShareCertificates();
    scheduleAnnualShareCertificates();
    scheduleCertificateSigningReminders();
    scheduleDocumentSignatureReminders();
    scheduleAuditAccessExpiryReminders();
    logger.info('All scheduled jobs started successfully');
};

module.exports = { startAllJobs };