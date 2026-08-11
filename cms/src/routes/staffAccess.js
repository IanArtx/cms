// ============================================================
// STAFF ACCESS ROUTES (v1.21.0)
// Prefix: /api/staff-access
//
// ADMIN routes (requireRoles(['Admin'])): grant/revoke individual
// document access to a specific user — the same direct-role-check
// treatment already given to Settings, floor limits, and Audit
// engagement management, since this is access-control
// configuration, not a normal day-to-day permission.
//
// Self-service routes: open to any authenticated user (not just
// the Administrative Officer role) since a grant could in principle
// be given to anyone — access is governed entirely by whether a
// grant row exists for that specific user, not by role.
// ============================================================

const router = require('express').Router();
const { body, query } = require('express-validator');
const { validateRequest, validators } = require('../middleware/validate');
const { authenticate, requireAssignedRole, requireConsent, requireRoles } = require('../middleware/auth');
const staffAccessController = require('../controllers/staffAccessController');

router.use(authenticate);
router.use(requireAssignedRole);
router.use(requireConsent);

// ============================================================
// ADMIN — MANAGE GRANTS
// ============================================================

router.get('/grants',
    requireRoles(['Admin']),
    [query('user_id').optional().isInt({ min: 1 })],
    validateRequest,
    staffAccessController.listGrants
);

router.post('/grants',
    requireRoles(['Admin']),
    [
        body('document_id').isInt({ min: 1 }).withMessage('A valid document is required'),
        body('user_id').isInt({ min: 1 }).withMessage('A valid user is required'),
    ],
    validateRequest,
    staffAccessController.grantDocument
);

router.delete('/grants/:id',
    requireRoles(['Admin']),
    validators.idParam('id'),
    validateRequest,
    staffAccessController.revokeGrant
);

// ============================================================
// SELF-SERVICE — MY GRANTED DOCUMENTS
// ============================================================

router.get('/my-documents',
    staffAccessController.getMyGrantedDocuments
);

router.get('/my-documents/:documentId',
    validators.idParam('documentId'),
    validateRequest,
    staffAccessController.previewGrantedDocument
);

module.exports = router;
