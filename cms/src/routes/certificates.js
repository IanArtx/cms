// ============================================================
// CERTIFICATES ROUTES
// Prefix: /api/certificates
// Certificate of Shares — monthly and annual, same format.
// ============================================================

const router = require('express').Router();
const { body, query } = require('express-validator');
const { validateRequest } = require('../middleware/validate');
const { authenticate, requireRoles } = require('../middleware/auth');
const certificatesController = require('../controllers/certificatesController');

router.use(authenticate);

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

module.exports = router;
