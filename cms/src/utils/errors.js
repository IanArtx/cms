// ============================================================
// ERROR HANDLING
// Centralised error classes and an async wrapper so we don't
// have to write try/catch in every route handler.
// ============================================================

// ============================================================
// CUSTOM ERROR CLASS
// Extends the built-in Error with an HTTP status code and
// optional structured details (for validation errors etc.)
// ============================================================
class AppError extends Error {
    constructor(message, statusCode, details = null) {
        super(message);
        this.statusCode = statusCode;
        this.details = details;      // optional: array of field-level errors
        this.isOperational = true;   // distinguishes expected errors from bugs
        Error.captureStackTrace(this, this.constructor);
    }
}

// Convenience factory functions — keeps route code readable
const createError = {
    badRequest:    (msg, details = null) => new AppError(msg, 400, details),
    unauthorized:  (msg = 'Unauthorised')      => new AppError(msg, 401),
    forbidden:     (msg = 'Forbidden')         => new AppError(msg, 403),
    notFound:      (msg = 'Not found')         => new AppError(msg, 404),
    conflict:      (msg)                       => new AppError(msg, 409),
    unprocessable: (msg, details = null)       => new AppError(msg, 422, details),
    internal:      (msg = 'Internal server error') => new AppError(msg, 500),
};

// ============================================================
// ASYNC WRAPPER
// Wraps an async route handler so any thrown error is
// automatically passed to Express's next() error handler.
// Without this we would need try/catch in every single route.
//
// Usage:
//   router.get('/users', asyncHandler(async (req, res) => {
//       const users = await getUsers();
//       res.json(users);
//   }));
// ============================================================
const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

// ============================================================
// GLOBAL ERROR HANDLER MIDDLEWARE
// Registered as the last middleware in server.js.
// Catches every error thrown anywhere in the app.
// ============================================================
const globalErrorHandler = (err, req, res, next) => {
    const logger = require('../config/logger');

    // JWT errors thrown directly by the `jsonwebtoken` library (an
    // expired or malformed token — see middleware/auth.js's
    // authenticate()) aren't AppError instances, so they arrive here
    // with no isOperational flag even though an expired session is a
    // completely routine, expected condition, not a bug. Without this,
    // every expired token logged as a scary "Unexpected error" with a
    // full stack trace at error level, and the logged statusCode read
    // 500 even though the JSON response further below already
    // correctly sends 401 — normalising both here fixes the log, not
    // just the (already-correct) response.
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
        err.statusCode = 401;
        err.isOperational = true;
    }

    // Default to 500 if no status code was set
    err.statusCode = err.statusCode || 500;

    // Log all errors — include stack trace for unexpected ones
    if (err.isOperational) {
        logger.warn('Operational error', {
            statusCode: err.statusCode,
            message: err.message,
            path: req.path,
            method: req.method,
        });
    } else {
        // Unexpected error — log with full stack
        logger.error('Unexpected error', {
            statusCode: err.statusCode,
            message: err.message,
            stack: err.stack,
            path: req.path,
            method: req.method,
        });
    }

    // Handle specific PostgreSQL errors with friendly messages
    if (err.code === '23505') {
        // Unique constraint violation
        return res.status(409).json({
            success: false,
            message: 'A record with this value already exists',
            error: 'DUPLICATE_ENTRY',
        });
    }

    if (err.code === '23503') {
        // Foreign key violation
        return res.status(400).json({
            success: false,
            message: 'Referenced record does not exist',
            error: 'INVALID_REFERENCE',
        });
    }

    if (err.code === '23514') {
        // Check constraint violation (e.g. negative balance)
        return res.status(400).json({
            success: false,
            message: 'Data violates a business rule constraint',
            error: 'CONSTRAINT_VIOLATION',
            detail: err.detail || null,
        });
    }

    // JWT errors
    if (err.name === 'JsonWebTokenError') {
        return res.status(401).json({
            success: false,
            message: 'Invalid authentication token',
            error: 'INVALID_TOKEN',
        });
    }
    if (err.name === 'TokenExpiredError') {
        return res.status(401).json({
            success: false,
            message: 'Authentication token has expired',
            error: 'TOKEN_EXPIRED',
        });
    }

    // Send response
    res.status(err.statusCode).json({
        success: false,
        message: err.isOperational ? err.message : 'Something went wrong',
        error: err.error || 'SERVER_ERROR',
        ...(err.details && { details: err.details }),
        // Only include stack trace in development
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
    });
};

module.exports = { AppError, createError, asyncHandler, globalErrorHandler };
