// ============================================================
// CERTIFICATES ROUTES
// Prefix: /api/certificates
// Certificate of Shares — monthly and annual, same format.
// ============================================================

const router = require('express').Router();
const { body, query } = require('express-validator');
const { validateRequest } = require('../middleware/validate');
const { authenticate, requireAssignedRole, requireConsent, blockFinanceRestricted, requireRoles } = require('../middleware/auth');
const certificatesController = require('../controllers/certificatesController');

router.use(authenticate);
router.use(requireAssignedRole);
router.use(requireConsent);
router.use(blockFinanceRestricted);

// ============================================================
// ISSUE A CERTIFICATE (on-demand)
// POST /api/certificates
// Self, or (with user_id) Treasurer/Assistant Treasurer/Admin
// ============================================================
router.post('/',
    [
        body('certificate_type').isIn(['MONTHLY', 'ANNUAL'])
            .withMessage('certificate_type must be MONTHLY or ANNUAL'),
        body('user_id').optional().isInt(),
    ],
    validateRequest,
    certificatesController.issueOne
);

// ============================================================
// GET MY CERTIFICATE HISTORY
// GET /api/certificates/me
// ============================================================
router.get('/me',
    [
        query('page').optional().isInt({ min: 1 }),
        query('limit').optional().isInt({ min: 1, max: 100 }),
    ],
    validateRequest,
    certificatesController.getMine
);

// ============================================================
// GET ALL CERTIFICATES
// GET /api/certificates
// Treasurer / Assistant Treasurer / Admin
// ============================================================
router.get('/',
    requireRoles(['Treasurer', 'Assistant Treasurer', 'Admin']),
    [
        query('page').optional().isInt({ min: 1 }),
        query('limit').optional().isInt({ min: 1, max: 100 }),
    ],
    validateRequest,
    certificatesController.getAll
);

// ============================================================
// ISSUE NOW FOR ALL SHAREHOLDERS (Admin only)
// POST /api/certificates/issue-now
// ============================================================
router.post('/issue-now',
    requireRoles(['Admin']),
    [
        body('certificate_type').isIn(['MONTHLY', 'ANNUAL'])
            .withMessage('certificate_type must be MONTHLY or ANNUAL'),
    ],
    validateRequest,
    certificatesController.issueNow
);

// ============================================================
// CERTIFICATE SIGNING ROUNDS (v1.23.0, Section 4.29)
// GET /api/certificates/rounds must come before /rounds/:id for the
// same reason /shareholders comes before /:id elsewhere in this app.
// ============================================================
router.get('/rounds',
    requireRoles(['Treasurer', 'Assistant Treasurer', 'Admin']),
    certificatesController.getRounds
);

router.get('/rounds/:id',
    requireRoles(['Treasurer', 'Assistant Treasurer', 'Admin']),
    certificatesController.getRoundById
);

// Signing itself is open to any role-assigned, consented member —
// signSlot (signatureService) is what actually enforces that the
// caller holds one of the round's required signatory roles.
router.post('/rounds/:id/sign',
    certificatesController.signRound
);

module.exports = router;
