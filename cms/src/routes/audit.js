// ============================================================
// EXTERNAL AUDIT ROUTES
// Prefix: /api/audit
//
// ADMIN routes (requireRoles(['Admin'])): manage engagements —
// the same direct-role-check treatment given to Settings and the
// floor limit, since this is foundational access-control
// configuration, not a normal day-to-day permission.
//
// AUDITOR routes (requireRoles(['Auditor'])): read-only, and every
// controller function additionally re-checks engagement membership
// before returning anything — the role alone opens no doors.
// ============================================================

const router = require('express').Router();
const { body, param, query } = require('express-validator');
const { validateRequest, validators } = require('../middleware/validate');
const { authenticate, requireAssignedRole, requireConsent, requireRoles } = require('../middleware/auth');
const { uploadSingle } = require('../middleware/upload');
const auditController = require('../controllers/auditController');

router.use(authenticate);
router.use(requireAssignedRole);
router.use(requireConsent);

// ============================================================
// ADMIN — ENGAGEMENT MANAGEMENT
// ============================================================

router.get('/engagements',
    requireRoles(['Admin']),
    auditController.listEngagements
);

router.get('/engagements/:id',
    requireRoles(['Admin']),
    validators.idParam('id'),
    validateRequest,
    auditController.getEngagementById
);

router.post('/engagements',
    requireRoles(['Admin']),
    [
        body('name').trim().notEmpty().withMessage('Engagement name is required')
            .isLength({ max: 200 }),
        body('description').optional().trim(),
        body('period_start').isISO8601().withMessage('A valid start date is required'),
        body('period_end').isISO8601().withMessage('A valid end date is required'),
        body('access_expires_at').optional({ nullable: true }).isISO8601(),
        body('account_ids').isArray({ min: 1 }).withMessage('Select at least one account'),
        body('account_ids.*').isInt({ min: 1 }),
    ],
    validateRequest,
    auditController.createEngagement
);

router.patch('/engagements/:id',
    requireRoles(['Admin']),
    validators.idParam('id'),
    [
        body('name').trim().notEmpty().withMessage('Engagement name is required')
            .isLength({ max: 200 }),
        body('description').optional().trim(),
        body('period_start').isISO8601().withMessage('A valid start date is required'),
        body('period_end').isISO8601().withMessage('A valid end date is required'),
        body('access_expires_at').optional({ nullable: true }).isISO8601(),
        body('account_ids').optional().isArray({ min: 1 }),
        body('account_ids.*').optional().isInt({ min: 1 }),
    ],
    validateRequest,
    auditController.updateEngagement
);

router.post('/engagements/:id/revoke',
    requireRoles(['Admin']),
    validators.idParam('id'),
    validateRequest,
    auditController.revokeEngagement
);

router.post('/engagements/:id/users',
    requireRoles(['Admin']),
    validators.idParam('id'),
    [body('email').isEmail().withMessage('A valid email is required').normalizeEmail()],
    validateRequest,
    auditController.addUserToEngagement
);

router.delete('/engagements/:id/users/:userId',
    requireRoles(['Admin']),
    validators.idParam('id'),
    validators.idParam('userId'),
    validateRequest,
    auditController.removeUserFromEngagement
);

router.post('/engagements/:id/documents',
    requireRoles(['Admin']),
    validators.idParam('id'),
    [body('document_id').isInt({ min: 1 }).withMessage('A valid document is required')],
    validateRequest,
    auditController.addDocumentToEngagement
);

router.delete('/engagements/:id/documents/:documentId',
    requireRoles(['Admin']),
    validators.idParam('id'),
    validators.idParam('documentId'),
    validateRequest,
    auditController.removeDocumentFromEngagement
);

// ============================================================
// AUDITOR — SCOPED READ-ONLY ACCESS
// ============================================================

router.get('/my-engagements',
    requireRoles(['Auditor']),
    auditController.getMyEngagements
);

router.get('/engagements/:id/allowed-accounts',
    requireRoles(['Auditor']),
    validators.idParam('id'),
    validateRequest,
    auditController.getAllowedAccounts
);

router.get('/engagements/:id/transactions',
    requireRoles(['Auditor']),
    validators.idParam('id'),
    [
        query('account_id').optional().isInt({ min: 1 }),
        query('from_date').optional().isISO8601(),
        query('to_date').optional().isISO8601(),
    ],
    validateRequest,
    auditController.getEngagementTransactions
);

router.get('/engagements/:id/documents',
    requireRoles(['Auditor']),
    validators.idParam('id'),
    validateRequest,
    auditController.getEngagementDocuments
);

router.get('/engagements/:id/documents/:documentId',
    requireRoles(['Auditor']),
    validators.idParam('id'),
    validators.idParam('documentId'),
    validateRequest,
    auditController.previewEngagementDocument
);

router.get('/engagements/:id/summary',
    requireRoles(['Auditor']),
    validators.idParam('id'),
    validateRequest,
    auditController.getEngagementSummary
);

// ============================================================
// AUDITOR — SUBMISSION WORKFLOW (v1.20.0)
// ============================================================

router.get('/engagements/:id/comments',
    requireRoles(['Auditor']),
    validators.idParam('id'),
    validateRequest,
    auditController.getComments
);

router.post('/engagements/:id/comments',
    requireRoles(['Auditor']),
    validators.idParam('id'),
    [body('comment_text').trim().notEmpty().withMessage('Comment text is required').isLength({ max: 5000 })],
    validateRequest,
    auditController.addComment
);

router.get('/engagements/:id/report-files',
    requireRoles(['Auditor']),
    validators.idParam('id'),
    validateRequest,
    auditController.getReportFiles
);

router.post('/engagements/:id/report-files',
    requireRoles(['Auditor']),
    validators.idParam('id'),
    validateRequest,
    ...uploadSingle('report', 'audit-reports'),
    auditController.uploadReportFile
);

router.delete('/engagements/:id/report-files/:fileId',
    requireRoles(['Auditor']),
    validators.idParam('id'),
    validators.idParam('fileId'),
    validateRequest,
    auditController.deleteReportFile
);

router.get('/engagements/:id/submissions',
    requireRoles(['Auditor']),
    validators.idParam('id'),
    validateRequest,
    auditController.getEngagementSubmissions
);

router.post('/engagements/:id/finish',
    requireRoles(['Auditor']),
    validators.idParam('id'),
    validateRequest,
    auditController.finishAudit
);

router.post('/engagements/:id/extension-requests',
    requireRoles(['Auditor']),
    validators.idParam('id'),
    [
        body('requested_new_access_expires_at').isISO8601().withMessage('A valid new access date is required'),
        body('reason').trim().notEmpty().withMessage('A reason is required').isLength({ max: 2000 }),
    ],
    validateRequest,
    auditController.requestExtension
);

router.get('/engagements/:id/extension-requests',
    requireRoles(['Auditor']),
    validators.idParam('id'),
    validateRequest,
    auditController.getMyExtensionRequests
);

// ============================================================
// DIRECTOR / SECRETARY — SUBMISSION REVIEW (v1.20.0)
// ============================================================

router.get('/submissions',
    requireRoles(['Director', 'Secretary']),
    [query('status').optional().isIn(['SUBMITTED', 'APPROVED', 'REJECTED'])],
    validateRequest,
    auditController.listSubmissions
);

router.get('/submissions/:id',
    requireRoles(['Director', 'Secretary']),
    validators.idParam('id'),
    validateRequest,
    auditController.getSubmissionById
);

router.get('/submissions/:id/files/:fileId',
    requireRoles(['Director', 'Secretary']),
    validators.idParam('id'),
    validators.idParam('fileId'),
    validateRequest,
    auditController.previewSubmissionFile
);

router.post('/submissions/:id/approve',
    requireRoles(['Director', 'Secretary']),
    validators.idParam('id'),
    validateRequest,
    auditController.approveSubmission
);

router.post('/submissions/:id/reject',
    requireRoles(['Director', 'Secretary']),
    validators.idParam('id'),
    [body('reason').trim().notEmpty().withMessage('A rejection reason is required').isLength({ max: 2000 })],
    validateRequest,
    auditController.rejectSubmission
);

router.get('/extension-requests',
    requireRoles(['Director', 'Secretary']),
    [query('status').optional().isIn(['PENDING', 'APPROVED', 'REJECTED'])],
    validateRequest,
    auditController.listExtensionRequests
);

router.post('/extension-requests/:id/approve',
    requireRoles(['Director', 'Secretary']),
    validators.idParam('id'),
    [body('reviewer_notes').optional().trim().isLength({ max: 2000 })],
    validateRequest,
    auditController.approveExtensionRequest
);

router.post('/extension-requests/:id/reject',
    requireRoles(['Director', 'Secretary']),
    validators.idParam('id'),
    [body('reviewer_notes').optional().trim().isLength({ max: 2000 })],
    validateRequest,
    auditController.rejectExtensionRequest
);

module.exports = router;
