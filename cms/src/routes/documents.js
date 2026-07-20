// ============================================================
// DOCUMENTS ROUTES
// Prefix: /api/documents
// All routes require authentication.
//
// PERMISSION LEVELS:
//   - View documents: all authenticated members
//   - Upload documents: Secretary, Directors, Treasurer
//   - Generate documents: Secretary, Directors, Treasurer
//   - Approve documents: Directors, Treasurer
//   - Archive documents: Admin, Directors
//   - Manage templates: Admin only
// ============================================================

const router = require('express').Router();
const { body, param } = require('express-validator');
const { validateRequest, validators } = require('../middleware/validate');
const { authenticate, blockAuditor, requirePermissions } = require('../middleware/auth');
const { uploadSingle } = require('../middleware/upload');
const documentsController = require('../controllers/documentsController');

// All routes require login
router.use(authenticate);
router.use(blockAuditor);

// ============================================================
// TEMPLATE ROUTES
// ============================================================

// Get all templates
router.get('/templates',
    requirePermissions(['DOCUMENT_VIEW']),
    documentsController.getTemplates
);

// Create a template (Admin only)
router.post('/templates',
    requirePermissions(['SYSTEM_CONFIG']),
    [
        body('name')
            .trim().notEmpty().withMessage('Template name is required'),
        body('template_type')
            .isIn([
                'MEETING_MINUTES', 'MEETING_AGENDA', 'INVESTMENT_PROPOSAL',
                'FINANCIAL_REPORT_GENERAL', 'FINANCIAL_REPORT_INDIVIDUAL',
                'RECEIPT', 'RESOLUTION', 'CONTRACT', 'LOAN_AGREEMENT', 'GRANT_AGREEMENT', 'OTHER'
            ])
            .withMessage('Invalid template type'),
        body('template_body')
            .notEmpty().withMessage('Template body is required'),
        body('description')
            .optional().trim(),
    ],
    validateRequest,
    documentsController.createTemplate
);

// ============================================================
// GET ALL DOCUMENTS
// GET /api/documents?document_type=MEETING_MINUTES&status=FINAL
// ============================================================
router.get('/',
    requirePermissions(['DOCUMENT_VIEW']),
    documentsController.getAllDocuments
);

// ============================================================
// UPLOAD A DOCUMENT
// POST /api/documents/upload
// ============================================================
router.post('/upload',
    requirePermissions(['DOCUMENT_UPLOAD']),
    ...uploadSingle('document', 'documents'),
    [
        body('category_id')
            .isInt({ min: 1 }).withMessage('A valid category is required'),
        body('title')
            .trim().notEmpty().withMessage('Document title is required'),
        body('document_type')
            .isIn([
                'MEETING_MINUTES', 'MEETING_AGENDA', 'INVESTMENT_PROPOSAL',
                'FINANCIAL_REPORT_GENERAL', 'FINANCIAL_REPORT_INDIVIDUAL',
                'RECEIPT', 'RESOLUTION', 'CONTRACT', 'LOAN_AGREEMENT', 'GRANT_AGREEMENT', 'OTHER'
            ])
            .withMessage('Invalid document type'),
        body('related_record_type').optional().trim(),
        body('related_record_id').optional().isInt({ min: 1 }),
    ],
    validateRequest,
    documentsController.uploadDocument
);

// ============================================================
// GENERATE DOCUMENT FROM TEMPLATE
// POST /api/documents/generate
// ============================================================
router.post('/generate',
    requirePermissions(['DOCUMENT_GENERATE']),
    [
        body('template_id')
            .isInt({ min: 1 }).withMessage('A valid template is required'),
        body('category_id')
            .isInt({ min: 1 }).withMessage('A valid category is required'),
        body('title')
            .trim().notEmpty().withMessage('Document title is required'),
        body('document_type')
            .isIn([
                'MEETING_MINUTES', 'MEETING_AGENDA', 'INVESTMENT_PROPOSAL',
                'FINANCIAL_REPORT_GENERAL', 'FINANCIAL_REPORT_INDIVIDUAL',
                'RECEIPT', 'RESOLUTION', 'CONTRACT', 'LOAN_AGREEMENT', 'GRANT_AGREEMENT', 'OTHER'
            ])
            .withMessage('Invalid document type'),
        body('template_data')
            .optional().isObject(),
        body('related_record_type').optional().trim(),
        body('related_record_id').optional().isInt({ min: 1 }),
    ],
    validateRequest,
    documentsController.generateDocument
);

// ============================================================
// GET SINGLE DOCUMENT
// GET /api/documents/:id
// ============================================================
router.get('/:id',
    requirePermissions(['DOCUMENT_VIEW']),
    validators.idParam('id'),
    validateRequest,
    documentsController.getDocumentById
);

// ============================================================
// DOWNLOAD / PREVIEW A DOCUMENT
// GET /api/documents/:id/download
// ============================================================
router.get('/:id/download',
    requirePermissions(['DOCUMENT_VIEW']),
    validators.idParam('id'),
    validateRequest,
    documentsController.downloadDocument
);

// ============================================================
// APPROVE DOCUMENT
// POST /api/documents/:id/approve
// ============================================================
router.post('/:id/approve',
    requirePermissions(['DOCUMENT_APPROVE']),
    validators.idParam('id'),
    validateRequest,
    documentsController.approveDocument
);

// ============================================================
// CREATE NEW VERSION
// POST /api/documents/:id/new-version
// ============================================================
router.post('/:id/new-version',
    requirePermissions(['DOCUMENT_UPLOAD']),
    ...uploadSingle('document', 'documents'),
    validators.idParam('id'),
    validateRequest,
    documentsController.createNewVersion
);

// ============================================================
// ARCHIVE DOCUMENT
// POST /api/documents/:id/archive
// ============================================================
router.post('/:id/archive',
    requirePermissions(['DOCUMENT_ARCHIVE']),
    validators.idParam('id'),
    validateRequest,
    documentsController.archiveDocument
);

module.exports = router;