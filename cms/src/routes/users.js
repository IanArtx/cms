// ============================================================
// USERS ROUTES
// Prefix: /api/users
// ============================================================

const router = require('express').Router();
const { body, param } = require('express-validator');
const { validateRequest, validators } = require('../middleware/validate');
const { authenticate, requirePermissions, requireRoles, isSelfOrHasPermission } = require('../middleware/auth');
const { uploadSingle } = require('../middleware/upload');
const usersController = require('../controllers/usersController');
const { asyncHandler } = require('../utils/errors');
const { query } = require('../config/database');
const { sendSuccess } = require('../utils/response');

// All routes require authentication
router.use(authenticate);

// --- PUBLIC TO ALL AUTHENTICATED USERS ---
router.get('/me',                   usersController.getMyProfile);
router.get('/roles',                usersController.getAllRoles);
router.get('/shareholding',         usersController.getShareholding);

router.patch('/me',
    [
        body('first_name').optional().trim().notEmpty().isLength({ max: 100 }),
        body('last_name').optional().trim().notEmpty().isLength({ max: 100 }),
        body('date_of_birth').optional().isISO8601(),
        body('phone').optional().isLength({ max: 30 }),
        body('gender').optional().isIn(['MALE', 'FEMALE', 'OTHER']),
        body('avatar_choice').optional().trim().isLength({ max: 30 }),
        body('auditor_company_name').optional().trim().isLength({ max: 200 }),
        body('auditor_company_initials').optional().trim().isLength({ max: 10 }),
        body('auditor_contact_phone').optional().trim().isLength({ max: 30 }),
    ],
    validateRequest,
    usersController.updateMyProfile
);

router.patch('/me/photo',
    ...uploadSingle('photo', 'profiles'),
    usersController.updateProfilePhoto
);

// --- ADMIN / PRIVILEGED ROUTES ---
router.get('/',
    requirePermissions(['USER_VIEW_ALL']),
    usersController.getAllUsers
);

router.get('/role-requests',
    requirePermissions(['ROLE_ASSIGN']),
    usersController.getRoleRequests
);

// Get all shareholders — for contribution form dropdown
// NOTE: must stay above the '/:id' route below — otherwise Express treats
// "shareholders" as the ':id' value and 422s on the "must be an integer" check.
router.get('/shareholders',
    requirePermissions(['FINANCE_TRANSACTION_CREATE']),
    asyncHandler(async (req, res) => {
        const result = await query(`
            SELECT
                u.id,
                u.first_name,
                u.last_name,
                u.email,
                sr.shares_held,
                sr.percentage
            FROM   users u
            JOIN   shareholding_registry sr ON sr.user_id = u.id
            WHERE  sr.effective_to IS NULL
            AND    u.is_active = TRUE
            ORDER BY u.first_name, u.last_name
        `);
        sendSuccess(res, result.rows);
    })
);

router.get('/:id',
    validators.idParam('id'),
    validateRequest,
    isSelfOrHasPermission('USER_VIEW_ALL'),
    usersController.getUserById
);

router.patch('/:id/deactivate',
    validators.idParam('id'),
    validateRequest,
    requirePermissions(['USER_MANAGE']),
    usersController.deactivateUser
);

router.post('/:id/roles',
    validators.idParam('id'),
    [body('role_id').isInt({ min: 1 }).withMessage('Role ID required')],
    validateRequest,
    requirePermissions(['ROLE_ASSIGN']),
    usersController.assignRole
);

router.delete('/:id/roles/:roleId',
    validators.idParam('id'),
    validators.idParam('roleId'),
    validateRequest,
    requirePermissions(['ROLE_ASSIGN']),
    usersController.revokeRole
);

module.exports = router;
