// ============================================================
// MAINTENANCE ROUTES (v1.74.0)
// Prefix: /api/maintenance
//
//   GET  /status   PUBLIC (no sign-in needed). Is maintenance on, the
//                  message and expected end, and — when the caller
//                  sends an Admin's token — exempt: true plus the Admin
//                  status details. Never fails: if the database can't
//                  be read it answers from MAINTENANCE_MODE alone.
//   GET  /         Admin — full detail: history and skipped jobs.
//   PUT  /         Admin — switch on / off / change the message.
//                  body: { on, message, expected_end, email_members }
// ============================================================

const router = require('express').Router();
const { body } = require('express-validator');
const { validateRequest } = require('../middleware/validate');
const { authenticate, requireRoles } = require('../middleware/auth');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess } = require('../utils/response');
const svc = require('../services/maintenanceService');

router.get('/status', async (req, res) => {
    let state;
    try { state = await svc.getState(); } catch (_) {
        state = { on: svc.envForced(), message: svc.DEFAULT_MESSAGE, db_ok: false };
    }
    let exempt = false;
    try { exempt = await svc.isAdminRequest(req); } catch (_) { exempt = false; }
    const out = {
        on: !!state.on,
        message: state.message,
        expected_end: state.expected_end || null,
        started_at: state.started_at || null,
        exempt,
    };
    if (exempt) {
        Object.assign(out, {
            source: state.source, forced: !!state.forced, switch_on: !!state.switch_on,
            started_by_name: state.started_by_name || null,
            skipped_jobs: state.skipped_jobs || 0, db_ok: state.db_ok !== false,
        });
    }
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, data: out });
});

router.get('/',
    authenticate,
    requireRoles(['Admin']),
    asyncHandler(async (req, res) => {
        sendSuccess(res, await svc.getAdminDetail());
    })
);

router.put('/',
    authenticate,
    requireRoles(['Admin']),
    [
        body('on').isBoolean().withMessage('on must be true or false'),
        body('message').optional({ values: 'null' }).isString().trim().isLength({ max: 1000 }),
        body('expected_end').optional({ values: 'falsy' }).isISO8601().withMessage('Expected end must be a date and time'),
        body('email_members').optional().isBoolean(),
    ],
    validateRequest,
    asyncHandler(async (req, res) => {
        const { logAction, MODULES } = require('../services/auditService');
        const on = req.body.on === true || req.body.on === 'true';
        if (!on && svc.envForced()) {
            throw createError.badRequest(
                'Maintenance is forced on by the server setting MAINTENANCE_MODE. Remove that setting in Render (cms-backend › Environment) to turn it off.');
        }
        const result = await svc.setMaintenance({
            on, message: req.body.message, expectedEnd: req.body.expected_end || null, userId: req.user.id,
        });

        await logAction(req.user.id, 'MAINTENANCE_MODE_CHANGED', MODULES.SYSTEM, {
            ipAddress: req.ip, recordType: 'system_maintenance', recordId: 1,
            newValues: { on, message: req.body.message || null, expected_end: req.body.expected_end || null },
            description: `Maintenance mode ${result.event === 'ON' ? 'switched ON' : result.event === 'OFF' ? 'switched OFF' : 'message updated'}`,
        }).catch(() => {});

        // Turning it off: run whatever nightly jobs were skipped, in the background.
        if (!on && result.wasOn) setImmediate(() => { svc.catchUpSkippedJobs().catch(() => {}); });

        // Optional email to every active member (never to block the switch).
        if (req.body.email_members === true && result.event !== 'UPDATE') {
            setImmediate(async () => {
                try {
                    const { query } = require('../config/database');
                    const { sendBulkEmail } = require('../config/email');
                    const { wrapEmail } = require('../services/emailTemplates');
                    const members = (await query(`SELECT email, first_name FROM users WHERE is_active = TRUE AND email IS NOT NULL`)).rows;
                    const state = await svc.getState({ fresh: true });
                    const when = state.expected_end ? new Date(state.expected_end).toLocaleString('en-GB', { timeZone: 'Africa/Kampala', dateStyle: 'medium', timeStyle: 'short' }) + ' (Kampala time)' : null;
                    const inner = on
                        ? `<p>The company system is <strong>temporarily unavailable</strong> while it is being updated.</p>
                           <p>${escapeHtml(state.message)}</p>${when ? `<p>Expected to be back by <strong>${when}</strong>.</p>` : ''}
                           <p>Nothing you have recorded is affected. You will be able to sign in again as soon as the update is finished.</p>`
                        : `<p>The update is finished — the company system is <strong>available again</strong>. You can sign in as usual.</p>`;
                    const html = await wrapEmail(inner, { preheader: on ? 'System maintenance' : 'System available again' });
                    await sendBulkEmail(members, () => (on ? 'System maintenance in progress' : 'The system is available again'), () => html);
                    await svc.markEmailed(result.eventId);
                } catch (err) {
                    require('../config/logger').error('Maintenance email failed', { error: err.message });
                }
            });
        }

        sendSuccess(res, await svc.getAdminDetail(),
            on ? (result.event === 'ON' ? 'Maintenance mode is ON. Only Admins can use the system.' : 'Maintenance details updated.')
               : 'Maintenance mode is OFF. The system is open again' + (result.wasOn ? ' — any skipped nightly jobs are being caught up now.' : '.'));
    })
);

const escapeHtml = (s) => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

module.exports = router;
