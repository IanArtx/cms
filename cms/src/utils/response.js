// ============================================================
// API RESPONSE HELPERS
// All API responses use these helpers to ensure every endpoint
// returns data in a consistent, predictable structure.
//
// Every response has:
//   success  — boolean, always present
//   message  — human-readable description
//   data     — the actual payload (on success)
//   meta     — pagination or extra context (optional)
// ============================================================

// Success response
const sendSuccess = (res, data = null, message = 'Success', statusCode = 200, meta = null) => {
    const response = { success: true, message };
    if (data !== null) response.data = data;
    if (meta !== null) response.meta = meta;
    return res.status(statusCode).json(response);
};

// Created response (201)
const sendCreated = (res, data, message = 'Created successfully') => {
    return sendSuccess(res, data, message, 201);
};

// No content response (204) — used for deletes/soft-deletes
const sendNoContent = (res) => {
    return res.status(204).send();
};

// Paginated response — includes pagination metadata
const sendPaginated = (res, data, total, page, limit, message = 'Success') => {
    return sendSuccess(res, data, message, 200, {
        pagination: {
            total,
            page: parseInt(page),
            limit: parseInt(limit),
            totalPages: Math.ceil(total / limit),
            hasNextPage: page * limit < total,
            hasPrevPage: page > 1,
        },
    });
};

// ============================================================
// PAGINATION HELPER
// Extracts and validates page/limit from query parameters.
// Usage: const { limit, offset, page } = getPagination(req.query);
// ============================================================
const getPagination = (query) => {
    const page  = Math.max(1, parseInt(query.page)  || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit) || 20));
    const offset = (page - 1) * limit;
    return { page, limit, offset };
};

module.exports = { sendSuccess, sendCreated, sendNoContent, sendPaginated, getPagination };
