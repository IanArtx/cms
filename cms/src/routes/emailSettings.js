// ============================================================
// EMAIL CONTROLS (v1.88.0) — prefix /api/email-settings
//   GET  /company   the Admin's rules per kind of email (Admin)
//   PUT  /company   change them (Admin)
//   GET  /mine      my own choices (anyone signed in)
//   PUT  /mine      change my own choices
// Legal notices (meeting notices) and security emails are always sent.
// See services/emailPolicyService.js for how one email is decided.
// ============================================================

const router = require('express').Router();
const { body } = require('express-validator');
const { validateRequest } = require('../middleware/validate');
const { authenticate, requireAssignedRole, requireConsent, requireRoles } = require('../middleware/auth');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess } = require('../utils/response');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');
const policy = require('../services/emailPolicyService');

router.use(authenticate);
router.use(requireAssignedRole);
router.use(requireConsent);

const wrap = (fn) => asyncHandler(async (req, res) => {
    try { await fn(req, res); } catch (err) {
        if (err.statusCode === 409) throw createError.conflict(err.message);
        if (err.statusCode === 400) throw createError.badRequest(err.message);
        throw err;
    }
});

router.get('/company', requireRoles(['Admin']), wrap(async (req, res) => sendSuccess(res, await policy.adminView())));

router.put('/company',
    requireRoles(['Admin']),
    [
        body('essential_only').optional().isBoolean(),
        body('digest_hour').optional().isInt({ min: 0, max: 23 }),
        body('kinds').optional().isArray({ max: 50 }),
        body('kinds.*.key').optional().isString(),
        body('kinds.*.mode').optional().isIn(policy.MODES),
        body('kinds.*.members_may_change').optional().isBoolean(),
    ],
    validateRequest,
    wrap(async (req, res) => {
        const before = await policy.adminView();
        await policy.saveAdmin({
            essentialOnly: req.body.essential_only, digestHour: req.body.digest_hour, kinds: req.body.kinds,
        }, req.user.id);
        const after = await policy.adminView();
        await logAction(req.user.id, ACTIONS.EMAIL_SETTINGS_UPDATED, MODULES.SYSTEM, {
            ipAddress: req.ip, recordType: 'email_settings', recordId: 1,
            oldValues: { essential_only: before.essential_only, digest_hour: before.digest_hour, kinds: before.kinds.map(k => [k.key, k.mode, k.members_may_change]) },
            newValues: { essential_only: after.essential_only, digest_hour: after.digest_hour, kinds: after.kinds.map(k => [k.key, k.mode, k.members_may_change]) },
            description: 'Email settings changed (which emails the system sends)',
        });
        sendSuccess(res, after, after.essential_only ? 'Saved — only essential emails (meeting notices, security) are being sent.' : 'Email settings saved.');
    }));

router.get('/mine', wrap(async (req, res) => sendSuccess(res, await policy.userView(req.user.id))));

router.put('/mine',
    [body('kinds').isArray({ max: 50 }), body('kinds.*.key').isString(), body('kinds.*.mode').optional({ nullable: true })],
    validateRequest,
    wrap(async (req, res) => {
        await policy.saveMine(req.user.id, req.body.kinds);
        sendSuccess(res, await policy.userView(req.user.id), 'Your email choices are saved.');
    }));

module.exports = router;
