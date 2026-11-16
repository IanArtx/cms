// ============================================================
// MONTHS — endpoints (v1.90.0)   (mounted under /api/reports)
//   GET  /months                 every month since the books began, its status,
//                                the checklist of the next month to close, history
//   POST /months/:ym/close       Treasurer — { note }
//   POST /months/:ym/reopen      Admin     — { reason }
// See services/periodService.js for the rules.
// ============================================================
const { withTransaction } = require('../config/database');
const { asyncHandler } = require('../utils/errors');
const { sendSuccess } = require('../utils/response');
const periods = require('../services/periodService');

const list = asyncHandler(async (req, res) => {
    sendSuccess(res, await periods.listMonths());
});

const close = asyncHandler(async (req, res) => {
    const out = await withTransaction(client => periods.closeMonth(client, req.user, req.params.ym, req.body && req.body.note));
    sendSuccess(res, out, `${out.label} is closed. Nothing dated in it can be added, changed or removed now.`);
});

const reopen = asyncHandler(async (req, res) => {
    const out = await withTransaction(client => periods.reopenMonth(client, req.user, req.params.ym, req.body && req.body.reason));
    sendSuccess(res, out, `${out.label} is open again.${out.taxYearSentBack ? ` The tax computation for ${out.taxYearSentBack} was sent back to be prepared again.` : ''}`);
});

module.exports = { list, close, reopen };
