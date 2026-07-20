// ============================================================
// SETTINGS ROUTES
// Prefix: /api/settings
// Company branding — name, address, logo, brand colors.
// ============================================================

const router = require('express').Router();
const { body } = require('express-validator');
const { validateRequest } = require('../middleware/validate');
const { authenticate, requireRoles } = require('../middleware/auth');
const { uploadSingle } = require('../middleware/upload');
const settingsController = require('../controllers/settingsController');

router.use(authenticate);

// Read — any authenticated user (sidebar/topbar/documents need this
// on every page load, not just for admins).
router.get('/company',
    settingsController.getCompanySettings
);

// Write — restricted to the "Admin" role directly, not the
// configurable permission system. Company identity is foundational
// configuration, the same treatment given to contribution recording
// in v1.4.0 (requireRoles rather than requirePermissions).
router.patch('/company',
    requireRoles(['Admin']),
    [
        body('company_name').optional().trim().notEmpty()
            .withMessage('Company name cannot be empty'),
        body('company_address').optional().trim(),
        body('primary_color').optional().trim(),
        body('accent_color').optional().trim(),
        body('description').optional().trim(),
        body('mission').optional().trim(),
        body('vision').optional().trim(),
        body('core_values').optional().trim(),
    ],
    validateRequest,
    settingsController.updateCompanySettings
);

router.post('/company/logo',
    requireRoles(['Admin']),
    uploadSingle('logo', 'branding'),
    settingsController.uploadCompanyLogo
);

module.exports = router;
