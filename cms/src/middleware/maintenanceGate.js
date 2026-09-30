// ============================================================
// MAINTENANCE GATE (v1.74.0)
// Mounted on /api in server.js BEFORE every module's routes, so it
// works whatever state the rest of the system is in.
//
// While maintenance mode is on, every API request from anyone who is
// not an Admin is answered with HTTP 503 and { maintenance: true } —
// nothing can be read or recorded, even from a page that was already
// open. Always allowed (so an Admin can still sign in, and the page can
// ask whether maintenance is on):
//   /api/auth/*          sign in, refresh, sign out
//   /api/maintenance/*   the status check and the Admin switch
// ============================================================

const { getState, isAdminRequest } = require('../services/maintenanceService');

const ALWAYS_OPEN = [/^\/auth(\/|$)/, /^\/maintenance(\/|$)/];

const maintenanceGate = async (req, res, next) => {
    try {
        if (ALWAYS_OPEN.some(rx => rx.test(req.path))) return next();
        const state = await getState();
        if (!state.on) return next();
        if (await isAdminRequest(req)) return next();
        return res.status(503).json({
            success: false,
            maintenance: true,
            message: state.message,
            data: { on: true, message: state.message, expected_end: state.expected_end, started_at: state.started_at },
        });
    } catch (_) {
        // The gate must never be the thing that breaks the system.
        return next();
    }
};

module.exports = { maintenanceGate };
