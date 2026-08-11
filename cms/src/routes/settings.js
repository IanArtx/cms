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
        // v1.24.1 — company-wide stamps on/off switch (Section 4.30)
        body('stamps_enabled').optional().isBoolean().withMessage('stamps_enabled must be true or false'),
    ],
    validateRequest,
    settingsController.updateCompanySettings
);

router.post('/company/logo',
    requireRoles(['Admin']),
    uploadSingle('logo', 'branding'),
    settingsController.uploadCompanyLogo
);

// ------------------------------------------------------------
// MEMBERSHIP AGREEMENT + SIGNATURE REQUIREMENTS (v1.23.0, Section
// 4.29) — Admin-only management. Reading the agreement text itself
// (for the Consent page) goes through GET /users/me/membership-
// agreement instead, not through here, so it works before a role is
// even assigned.
// ------------------------------------------------------------
router.patch('/membership-agreement',
    requireRoles(['Admin']),
    [body('content').trim().notEmpty().withMessage('Agreement content is required')],
    validateRequest,
    settingsController.updateMembershipAgreement
);

router.get('/signature-requirements',
    requireRoles(['Admin']),
    settingsController.getSignatureRequirements
);

router.put('/signature-requirements/:documentType',
    requireRoles(['Admin']),
    [body('role_ids').isArray().withMessage('role_ids must be an array')],
    validateRequest,
    settingsController.setSignatureRequirements
);

// ------------------------------------------------------------
// COMPANY STAMPS & SEALS (v1.24.0, Section 4.30) — Admin-only.
// Uploading/listing/deactivating stamp images, and configuring which
// stamp(s) apply to which document type.
// ------------------------------------------------------------
router.post('/stamps',
    requireRoles(['Admin']),
    uploadSingle('stamp', 'stamps'),
    [body('name').trim().notEmpty().withMessage('A stamp name is required')],
    validateRequest,
    settingsController.uploadStamp
);

router.get('/stamps',
    requireRoles(['Admin']),
    settingsController.getStamps
);

router.patch('/stamps/:id/deactivate',
    requireRoles(['Admin']),
    settingsController.deactivateStamp
);

router.get('/stamp-requirements',
    requireRoles(['Admin']),
    settingsController.getStampRequirements
);

router.put('/stamp-requirements/:documentType',
    requireRoles(['Admin']),
    [body('stamp_ids').isArray().withMessage('stamp_ids must be an array')],
    validateRequest,
    settingsController.setStampRequirements
);

// ------------------------------------------------------------
// CUSTOM FISCAL QUARTERS (v1.25.0, Section 4.10 addendum) — read is
// open to any authenticated user (Reports/documents need the
// labels), writes are Admin only.
// ------------------------------------------------------------
router.get('/fiscal-quarters', settingsController.getFiscalQuarters);

router.post('/fiscal-quarters',
    requireRoles(['Admin']),
    [
        body('label').trim().notEmpty().withMessage('A label is required'),
        body('start_date').isISO8601().withMessage('A valid start date is required'),
        body('end_date').isISO8601().withMessage('A valid end date is required'),
    ],
    validateRequest,
    settingsController.createFiscalQuarter
);

router.put('/fiscal-quarters/:id',
    requireRoles(['Admin']),
    [
        body('label').optional().trim().notEmpty(),
        body('start_date').optional().isISO8601(),
        body('end_date').optional().isISO8601(),
    ],
    validateRequest,
    settingsController.updateFiscalQuarter
);

router.delete('/fiscal-quarters/:id',
    requireRoles(['Admin']),
    settingsController.deleteFiscalQuarter
);

module.exports = router;
