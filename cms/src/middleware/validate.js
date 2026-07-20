// ============================================================
// VALIDATION MIDDLEWARE
// Uses express-validator to check incoming request data
// before it reaches the controller. If validation fails,
// a 422 error is returned with field-level details so the
// frontend knows exactly what to fix.
// ============================================================

const { validationResult, body, param, query } = require('express-validator');
const { createError } = require('../utils/errors');

// ============================================================
// VALIDATE REQUEST
// Place this after your validation chain in a route.
// It collects all validation errors and returns them together.
//
// Usage:
//   router.post('/login',
//       body('email').isEmail(),
//       body('password').notEmpty(),
//       validateRequest,
//       authController.login
//   );
// ============================================================
const validateRequest = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        const details = errors.array().map(err => ({
            field:   err.path,
            message: err.msg,
            value:   err.value,
        }));
        return next(createError.unprocessable('Validation failed', details));
    }
    next();
};

// ============================================================
// COMMON VALIDATION CHAINS
// Reusable sets of validation rules for frequently used fields
// ============================================================

const validators = {
    // Pagination query params
    pagination: [
        query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
        query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100'),
    ],

    // ID in URL params
    idParam: (name = 'id') => [
        param(name).isInt({ min: 1 }).withMessage(`${name} must be a valid positive integer`),
    ],

    // Money amount — must be positive, max 4 decimal places
    amount: (field = 'amount') => [
        body(field)
            .isFloat({ min: 0.0001 })
            .withMessage(`${field} must be a positive number`)
            .custom(val => {
                // Enforce max 4 decimal places (matches NUMERIC(20,4))
                const decimals = (String(val).split('.')[1] || '').length;
                if (decimals > 4) throw new Error(`${field} cannot have more than 4 decimal places`);
                return true;
            }),
    ],

    // Date — must be a valid ISO date string
    date: (field) => [
        body(field)
            .isISO8601()
            .withMessage(`${field} must be a valid date (YYYY-MM-DD)`),
    ],

    // Exchange rate — positive, up to 8 decimal places
    exchangeRate: [
        body('exchange_rate')
            .isFloat({ min: 0.00000001 })
            .withMessage('Exchange rate must be a positive number')
            .custom(val => {
                const decimals = (String(val).split('.')[1] || '').length;
                if (decimals > 8) throw new Error('Exchange rate cannot have more than 8 decimal places');
                return true;
            }),
    ],

    // Interest rate — percentage, 0–100, 4 decimal places
    interestRate: (field) => [
        body(field)
            .isFloat({ min: 0, max: 100 })
            .withMessage(`${field} must be between 0 and 100`),
    ],
};

module.exports = { validateRequest, validators, body, param, query };
