// ============================================================
// MEETINGS ROUTES (v1.79.0)
// Prefix: /api/meetings
//
// Statutory meetings (AGM / EGM / Board), the register of
// attendees, resolutions (ordinary, special, board, written) and the
// governance settings. Who may do what is checked in
// meetingsController.js / governanceService.js:
//   • run meetings (create, notice, attendance, votes, minutes):
//     MEETING_MANAGE, or the Admin / Director / Secretary /
//     Assistant Secretary roles
//   • see general meetings: MEETING_VIEW or Shareholder, plus anyone
//     on the meeting's register
//   • see board meetings: directors, plus anyone on the register
//   • confirm attendance / sign a written resolution: only the
//     person themselves
// The Auditor (external) has no access here.
// ============================================================

const router = require('express').Router();
const { authenticate, requireAssignedRole, requireConsent, blockAuditor } = require('../middleware/auth');
const c = require('../controllers/meetingsController');

router.use(authenticate);
router.use(requireAssignedRole);
router.use(requireConsent);
router.use(blockAuditor);
// Bodyless POSTs (open, close, withdraw…) arrive without req.body.
router.use((req, res, next) => { if (!req.body) req.body = {}; next(); });

// ---- fixed paths first (before /:id) ----
router.get('/settings', c.getGovernanceSettings);
router.patch('/settings', c.updateGovernanceSettings);
router.get('/my-actions', c.myActions);
router.get('/document-categories', c.documentCategories);
router.post('/documents', c.saveStatutoryDocument);

router.get('/resolutions', c.listResolutions);
router.post('/resolutions/written', c.createWrittenResolution);
router.get('/resolutions/:rid', c.getResolution);
router.patch('/resolutions/:rid', c.updateResolution);
router.post('/resolutions/:rid/vote', c.recordVote);
router.post('/resolutions/:rid/withdraw', c.withdrawResolution);
router.post('/resolutions/:rid/filed', c.markFiled);
router.post('/resolutions/:rid/sign', c.signWrittenResolution);

// ---- meetings ----
router.get('/', c.listMeetings);
router.post('/', c.createMeeting);
router.get('/:id', c.getMeeting);
router.patch('/:id', c.updateMeeting);
router.post('/:id/register/refresh', c.refreshRegister);
router.post('/:id/attendees', c.addAttendee);
router.patch('/:id/attendees/:aid', c.markAttendance);
router.delete('/:id/attendees/:aid', c.removeAttendee);
router.post('/:id/notice', c.issueNotice);
router.post('/:id/open', c.openMeeting);
router.post('/:id/confirm', c.confirmAttendance);
router.put('/:id/minutes', c.saveMinutes);
router.post('/:id/close', c.closeMeeting);
router.post('/:id/cancel', c.cancelMeeting);
router.post('/:id/resolutions', c.createMeetingResolution);

module.exports = router;
