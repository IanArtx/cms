// ============================================================
// NOTIFICATION SERVICE
// One place that creates an in-app "bell" notification and,
// almost always, sends the matching email — for the same reason
// logAction() is the one place audit entries get written.
//
// DELIBERATE DESIGN CHOICE: this always uses the plain pool query()
// (never a transaction client), and every failure is caught and
// logged rather than thrown. Notifications and emails are always
// best-effort side effects — a slow/broken email server must never
// roll back or fail the real business transaction (recording a
// contribution, approving a requisition, etc.). Call this AFTER the
// main withTransaction() block has already committed successfully.
//
// Usage:
//   await notify({
//       userId:   contributorId,
//       type:     'CONTRIBUTION_RECORDED',
//       title:    'Contribution recorded',
//       body:     'Your contribution of EUR 500 has been recorded.',
//       link:     '/transactions',
//       module:   'FINANCE',
//       recordType: 'transactions',
//       recordId: transactionId,
//       email: {
//           subject: 'Your contribution has been recorded',
//           html:    '<p>...</p>',
//       },
//   });
// ============================================================

const { query } = require('../config/database');
const { sendEmail } = require('../config/email');
const logger = require('../config/logger');

// ============================================================
// NOTIFY ONE USER
// Inserts the bell notification, then sends the email (if an
// `email` block is provided and the user has an email address).
// Returns the notification id, or null if it failed entirely.
// ============================================================
const notify = async ({
    userId,
    type,
    title,
    body = null,
    link = null,
    module = null,
    recordType = null,
    recordId = null,
    email = null, // { to, subject, html } — `to` optional, looked up from userId if omitted
}) => {
    let notificationId = null;

    try {
        const result = await query(`
            INSERT INTO notifications (
                user_id, type, title, body, link,
                related_module, related_record_type, related_record_id
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id
        `, [userId, type, title, body, link, module, recordType, recordId || null]);
        notificationId = result.rows[0].id;
    } catch (err) {
        logger.error('Failed to create notification', { userId, type, error: err.message });
        return null;
    }

    if (email) {
        try {
            let to = email.to;
            if (!to) {
                const u = await query('SELECT email FROM users WHERE id = $1', [userId]);
                to = u.rows[0]?.email;
            }

            if (to) {
                const result = await sendEmail({ to, subject: email.subject, html: email.html });
                await query(`
                    UPDATE notifications
                    SET    email_sent  = $1,
                           email_error = $2
                    WHERE  id = $3
                `, [result.success, result.success ? null : result.error, notificationId]);
            }
        } catch (err) {
            logger.error('Failed to send notification email', { userId, type, error: err.message });
            await query(`
                UPDATE notifications SET email_sent = FALSE, email_error = $1 WHERE id = $2
            `, [err.message, notificationId]).catch(() => {});
        }
    }

    return notificationId;
};

// ============================================================
// NOTIFY MANY USERS
// Same as notify(), but for a list of recipients — used for
// general broadcasts (meeting/event announcements, monthly
// reports) where every shareholder gets their own personalised
// notification + email rather than one shared message.
//
// `recipients` — array of { id, email, first_name, ... }
// `build(recipient)` — returns { title, body, link, module,
//                       recordType, recordId, email: {...} }
//                       tailored to that recipient
// ============================================================
const notifyMany = async (recipients, type, build) => {
    const results = [];
    for (const recipient of recipients) {
        const fields = build(recipient);
        const id = await notify({
            userId: recipient.id,
            type,
            ...fields,
            email: fields.email
                ? { to: recipient.email, ...fields.email }
                : null,
        });
        results.push({ userId: recipient.id, notificationId: id });
        // Small stagger to stay well under Gmail's rate limits when
        // broadcasting to a large shareholder list.
        await new Promise(resolve => setTimeout(resolve, 150));
    }
    return results;
};

module.exports = { notify, notifyMany };
