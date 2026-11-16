// ============================================================
// PERSONAL ACCESS RULES — endpoints (v1.89.0)
// Mounted in routes/users.js:
//   GET  /api/users/me/access                 my own limits (everyone)
//   GET  /api/users/access/overview           everyone with rules (Admin)
//   GET  /api/users/:id/access                one person: permissions by source, rules, choices (Admin)
//   POST /api/users/:id/access                add a rule (Admin, never on yourself)
//   POST /api/users/:id/access/:ruleId/end    end a rule early, with the reason (Admin)
// The person is told (bell + email, always sent: it is a security matter)
// when a rule is added or ended. Every change is in the audit log.
// ============================================================

const { withTransaction } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess, sendCreated } = require('../utils/response');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');
const { notify } = require('../services/notificationService');
const pa = require('../services/personalAccessService');
const logger = require('../config/logger');

const idParam = (v) => {
    const n = parseInt(v, 10);
    if (!Number.isInteger(n) || n < 1) throw createError.badRequest('Invalid id.');
    return n;
};
const assertReady = async () => {
    if (!(await pa.tableReady())) throw createError.conflict('Personal access rules need the v1.89.0 database update — run update_live_database.js first.');
};

const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const tellPerson = (userId, title, body) => {
    notify({
        userId, type: 'ACCESS_RULE_CHANGED', title, body, link: '/profile?tab=access', module: 'USERS', recordType: 'user_access_rules',
        email: { subject: title, html: `<p>${esc(body)}</p><p>You can see your current limits under My Profile › Sign-in &amp; security › My access.</p>` },
    }).catch(err => logger.warn(`Access rule notification failed: ${err.message}`));
};

const getMine = asyncHandler(async (req, res) => {
    sendSuccess(res, await pa.myView(req.user.id));
});

const getOverview = asyncHandler(async (req, res) => {
    sendSuccess(res, await pa.overview());
});

const getPerson = asyncHandler(async (req, res) => {
    sendSuccess(res, await pa.userView(idParam(req.params.id)));
});

const addRule = asyncHandler(async (req, res) => {
    await assertReady();
    const userId = idParam(req.params.id);
    const rule = await withTransaction(async (client) => {
        const r = await pa.addRule(req.user.id, userId, req.body || {}, client);
        await logAction(req.user.id, ACTIONS.ACCESS_RULE_ADDED, MODULES.USERS, {
            ipAddress: req.ip, recordType: 'user_access_rules', recordId: r.id,
            newValues: { user_id: userId, kind: r.kind, summary: r.summary, reason: r.reason, starts_on: r.starts_on, ends_on: r.ends_on },
            description: `Access rule for ${r.user_name}: ${r.summary}`, client,
        });
        return r;
    });
    tellPerson(userId, 'Your access in the system has changed',
        `${rule.summary}. Reason: ${rule.reason}. ${rule.starts_on > pa.kampalaToday() ? `From ${rule.starts_on}` : 'From today'}${rule.ends_on ? ` until ${rule.ends_on}` : ''}.`);
    sendCreated(res, rule, `Saved for ${rule.user_name}: ${rule.summary}${rule.ends_on ? ` (until ${rule.ends_on})` : ''}. It applies from their next click.`);
});

const endRule = asyncHandler(async (req, res) => {
    await assertReady();
    const userId = idParam(req.params.id);
    const rule = await withTransaction(async (client) => {
        const r = await pa.endRule(req.user.id, userId, idParam(req.params.ruleId), req.body && req.body.reason, client);
        await logAction(req.user.id, ACTIONS.ACCESS_RULE_ENDED, MODULES.USERS, {
            ipAddress: req.ip, recordType: 'user_access_rules', recordId: r.id,
            newValues: { user_id: userId, summary: r.summary, end_reason: r.end_reason },
            description: `Access rule ended for ${r.user_name}: ${r.summary}`, client,
        });
        return r;
    });
    tellPerson(userId, 'A limit on your access was lifted', `${rule.summary} no longer applies. Reason: ${rule.end_reason}.`);
    sendSuccess(res, rule, `Ended: ${rule.summary}.`);
});

module.exports = { getMine, getOverview, getPerson, addRule, endRule };
