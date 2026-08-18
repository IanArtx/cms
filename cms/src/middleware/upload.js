// ============================================================
// FILE UPLOAD MIDDLEWARE
// Uses Multer to handle multipart/form-data file uploads.
//
// v1.29.1 — switched from multer.diskStorage to memoryStorage. Files
// no longer touch local disk here at all: req.file.buffer holds the
// raw bytes, and the controller handling each route passes that
// buffer to services/storageService.js's uploadBuffer(), which sends
// it to R2 (or falls back to local disk only if R2 isn't configured —
// see storageService.js). req.uploadCategory (set below) is still
// used by controllers to build the file's storage key via
// storageService.generateKey(category, originalname).
//
// Only specific file types are accepted.
// ============================================================

const multer  = require('multer');
const { createError } = require('../utils/errors');

// Allowed MIME types
const ALLOWED_TYPES = {
    'application/pdf':                                      'pdf',
    'application/msword':                                   'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'image/jpeg':                                           'jpg',
    'image/png':                                            'png',
    'image/gif':                                            'gif',
    'application/vnd.ms-excel':                             'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    // v1.24.0 — company stamps/seals are uploaded as transparent PNG
    // or SVG so they overlay cleanly onto a document.
    'image/svg+xml':                                        'svg',
};

// Maximum file size from environment (default 20MB)
const MAX_SIZE = (parseInt(process.env.MAX_FILE_SIZE_MB) || 20) * 1024 * 1024;

// ============================================================
// STORAGE ENGINE
// In-memory only — see the v1.29.1 note above. Whatever key each
// file ends up stored under (its category subdirectory + a
// timestamped, sanitised filename) is decided by the controller via
// storageService.generateKey(), not here.
// ============================================================
const storage = multer.memoryStorage();

// ============================================================
// FILE FILTER
// Rejects any file whose MIME type is not in the allowed list.
// ============================================================
const fileFilter = (req, file, cb) => {
    if (ALLOWED_TYPES[file.mimetype]) {
        cb(null, true);
    } else {
        cb(createError.badRequest(
            `File type not allowed. Accepted types: PDF, Word, Excel, JPEG, PNG, SVG`
        ), false);
    }
};

// ============================================================
// MULTER INSTANCE
// ============================================================
const upload = multer({
    storage,
    fileFilter,
    limits: { fileSize: MAX_SIZE },
});

// ============================================================
// UPLOAD MIDDLEWARE FACTORIES
// Use these in routes to accept specific numbers of files.
//
// Single file:   uploadSingle('document')
// Multiple files: uploadMultiple('attachments', 5)
// ============================================================
const uploadSingle = (fieldName, category = 'general') => [
    // Set the category before multer runs so storage can use it
    (req, res, next) => { req.uploadCategory = category; next(); },
    upload.single(fieldName),
    handleUploadError,
];

const uploadMultiple = (fieldName, maxCount = 5, category = 'general') => [
    (req, res, next) => { req.uploadCategory = category; next(); },
    upload.array(fieldName, maxCount),
    handleUploadError,
];

// Handle multer-specific errors with friendly messages
const handleUploadError = (err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return next(createError.badRequest(
                `File too large. Maximum size is ${process.env.MAX_FILE_SIZE_MB || 20}MB`
            ));
        }
        return next(createError.badRequest(`Upload error: ${err.message}`));
    }
    next(err);
};

module.exports = { uploadSingle, uploadMultiple };
