// ============================================================
// AUTHENTICATION ROUTES
// All routes are prefixed /api/auth in server.js
// ============================================================

const router = require('express').Router();
const { body } = require('express-validator');
const { validateRequest } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const authController = require('../controllers/authController');
const accountSecurity = require('../controllers/accountSecurityController'); // v1.75.0

// --- REGISTER ---
router.post('/register',
    [
        body('email')
            .isEmail().withMessage('Valid email is required')
            .normalizeEmail(),
        body('password')
            .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
            .matches(/[A-Z]/).withMessage('Password must contain at least one uppercase letter')
            .matches(/[0-9]/).withMessage('Password must contain at least one number')
            .matches(/[^A-Za-z0-9]/).withMessage('Password must contain at least one special character'),
        body('first_name')
            .trim().notEmpty().withMessage('First name is required')
            .isLength({ max: 100 }).withMessage('First name too long'),
        body('last_name')
            .trim().notEmpty().withMessage('Last name is required')
            .isLength({ max: 100 }).withMessage('Last name too long'),
        body('date_of_birth')
            .optional().isISO8601().withMessage('Date of birth must be a valid date'),
        body('requested_role_id')
            .optional().isInt({ min: 1 }).withMessage('Role ID must be a positive integer'),
    ],
    validateRequest,
    authController.register
);

// --- VERIFY EMAIL ---
router.get('/verify-email', authController.verifyEmail);

// --- PUBLIC ROLES (for the Register page's role-request dropdown) ---
router.get('/roles', authController.getPublicRoles);

// --- LOGIN ---
router.post('/login',
    [
        body('email').isEmail().withMessage('Valid email is required').normalizeEmail(),
        body('password').notEmpty().withMessage('Password is required'),
    ],
    validateRequest,
    authController.login
);

// --- REFRESH TOKEN ---
router.post('/refresh',
    [body('refreshToken').notEmpty().withMessage('Refresh token is required')],
    validateRequest,
    authController.refreshToken
);

// --- LOGOUT (requires login) ---
router.post('/logout', authenticate, authController.logout);

// --- FORGOT PASSWORD ---
router.post('/forgot-password',
    [body('email').isEmail().withMessage('Valid email is required').normalizeEmail()],
    validateRequest,
    authController.forgotPassword
);

// --- RESET PASSWORD ---
router.post('/reset-password',
    [
        body('token').notEmpty().withMessage('Reset token is required'),
        body('password')
            .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
            .matches(/[A-Z]/).withMessage('Must contain uppercase')
            .matches(/[0-9]/).withMessage('Must contain a number')
            .matches(/[^A-Za-z0-9]/).withMessage('Must contain a special character'),
    ],
    validateRequest,
    authController.resetPassword
);

// --- CHANGE PASSWORD while signed in (v1.75.0) ---
// Current password + new password; other devices are signed out.
router.post('/change-password',
    authenticate,
    [
        body('current_password').notEmpty().withMessage('Enter your current password'),
        body('new_password')
            .isLength({ min: 8 }).withMessage('The new password must be at least 8 characters')
            .matches(/[A-Z]/).withMessage('The new password needs an uppercase letter')
            .matches(/[0-9]/).withMessage('The new password needs a number')
            .matches(/[^A-Za-z0-9]/).withMessage('The new password needs a special character'),
    ],
    validateRequest,
    accountSecurity.changePassword
);

// --- EMAIL CHANGE LINKS (v1.75.0) — public: opened from an email ---
router.post('/email-change/confirm',
    [body('token').isLength({ min: 32, max: 128 }).withMessage('The link is incomplete')],
    validateRequest,
    accountSecurity.confirmEmailChange
);
router.post('/email-change/cancel',
    [body('token').isLength({ min: 32, max: 128 }).withMessage('The link is incomplete')],
    validateRequest,
    accountSecurity.cancelEmailChangeByLink
);

// --- 2FA SETUP (requires login) ---
router.post('/2fa/setup', authenticate, authController.setupTwoFactor);

// --- 2FA ACTIVATE (requires login, confirms setup with first code) ---
router.post('/2fa/activate',
    authenticate,
    [body('token').isLength({ min: 6, max: 6 }).withMessage('2FA code must be 6 digits')],
    validateRequest,
    authController.activateTwoFactor
);

// --- 2FA VERIFY (post-login step) ---
router.post('/2fa/verify',
    authenticate,
    [body('token').isLength({ min: 6, max: 6 }).withMessage('2FA code must be 6 digits')],
    validateRequest,
    authController.verifyTwoFactor
);

module.exports = router;
