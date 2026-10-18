// ============================================================
// PROJECTS ROUTES (v1.85.0)
// Prefix: /api/projects
//   View:   INVESTMENT_VIEW
//   Manage: INVESTMENT_MANAGE (create, edit, status, milestones,
//           adding to / taking out of an investment)
// Money for a project is NOT recorded here: a project on its own is paid
// with Record Expense (project chosen); a project inside an investment
// is paid as funding of that investment (project chosen).
// ============================================================

const router = require('express').Router();
const { body } = require('express-validator');
const { validateRequest, validators } = require('../middleware/validate');
const { authenticate, requireAssignedRole, requireConsent, blockFinanceRestricted, requirePermissions } = require('../middleware/auth');
const c = require('../controllers/projectsController');

router.use(authenticate);
router.use(requireAssignedRole);
router.use(requireConsent);
router.use(blockFinanceRestricted);

const dateOpt = (f) => body(f).optional({ values: 'falsy' }).isISO8601().withMessage('Invalid date');

router.get('/', requirePermissions(['INVESTMENT_VIEW']), c.listProjects);
router.get('/options', requirePermissions(['INVESTMENT_VIEW']), c.projectOptions);

router.post('/',
    requirePermissions(['INVESTMENT_MANAGE']),
    [
        body('name').trim().notEmpty().withMessage('Project name is required').isLength({ max: 200 }),
        body('planned_budget').isFloat({ min: 0.01 }).withMessage('Planned budget must be greater than zero'),
        body('category_id').optional({ values: 'falsy' }).isInt({ min: 1 }),
        body('currency_id').optional({ values: 'falsy' }).isInt({ min: 1 }),
        body('investment_id').optional({ values: 'falsy' }).isInt({ min: 1 }),
        body('responsible_user_id').optional({ values: 'falsy' }).isInt({ min: 1 }),
        body('status').optional({ values: 'falsy' }).isIn(['PENDING', 'ACTIVE']),
        dateOpt('start_date'), dateOpt('expected_end_date'),
    ],
    validateRequest,
    c.createProject
);

router.get('/:id', requirePermissions(['INVESTMENT_VIEW']), validators.idParam('id'), validateRequest, c.getProject);

router.put('/:id',
    requirePermissions(['INVESTMENT_MANAGE']),
    validators.idParam('id'),
    [
        body('name').optional().trim().notEmpty().isLength({ max: 200 }),
        body('planned_budget').optional().isFloat({ min: 0.01 }).withMessage('Planned budget must be greater than zero'),
        body('category_id').optional({ values: 'falsy' }).isInt({ min: 1 }),
        body('currency_id').optional({ values: 'falsy' }).isInt({ min: 1 }),
        body('responsible_user_id').optional({ values: 'null' }),
        dateOpt('start_date'), dateOpt('expected_end_date'),
    ],
    validateRequest,
    c.updateProject
);

router.post('/:id/status',
    requirePermissions(['INVESTMENT_MANAGE']),
    validators.idParam('id'),
    [
        body('status').isIn(['PENDING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED']).withMessage('Invalid status'),
        body('note').optional({ values: 'falsy' }).trim().isLength({ max: 1000 }),
        dateOpt('date'),
    ],
    validateRequest,
    c.setStatus
);

router.post('/:id/investment',
    requirePermissions(['INVESTMENT_MANAGE']),
    validators.idParam('id'),
    [body('investment_id').isInt({ min: 1 }).withMessage('Choose an investment')],
    validateRequest,
    c.linkInvestment
);

router.post('/:id/investment/remove',
    requirePermissions(['INVESTMENT_MANAGE']),
    validators.idParam('id'),
    [body('reason').trim().notEmpty().withMessage('Say why').isLength({ max: 1000 })],
    validateRequest,
    c.unlinkInvestment
);

router.post('/:id/milestones',
    requirePermissions(['INVESTMENT_MANAGE']),
    validators.idParam('id'),
    [
        body('name').trim().notEmpty().withMessage('Milestone name is required').isLength({ max: 200 }),
        body('due_date').isISO8601().withMessage('A valid due date is required'),
        body('description').optional().trim(),
    ],
    validateRequest,
    c.addMilestone
);

router.patch('/:id/milestones/:mid',
    requirePermissions(['INVESTMENT_MANAGE']),
    validators.idParam('id'),
    validators.idParam('mid'),
    [
        body('status').optional().isIn(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'MISSED']).withMessage('Invalid milestone status'),
        body('name').optional().trim().notEmpty().isLength({ max: 200 }),
        body('due_date').optional().isISO8601(),
        dateOpt('completed_at'),
    ],
    validateRequest,
    c.updateMilestone
);

module.exports = router;
