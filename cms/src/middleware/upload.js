// ============================================================
// FILE UPLOAD MIDDLEWARE
// Uses Multer to handle multipart/form-data file uploads.
// Files are stored on disk in organised subdirectories.
// Only specific file types are accepted.
// ============================================================

const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
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
// Files are stored in subdirectories by category.
// Original filename is sanitised and a timestamp prepended
// to prevent naming conflicts.
// ============================================================
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        // Subdirectory based on the upload category
        const category = req.uploadCategory || 'general';
        const dir = path.join(process.env.UPLOAD_DIR || './uploads', category);

        // Create the directory if it does not exist
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        // Sanitise original filename — remove special characters
        const sanitised = file.originalname
            .replace(/[^a-zA-Z0-9.\-_]/g, '_')
            .toLowerCase();
        // Prepend timestamp to guarantee uniqueness
        const unique = `${Date.now()}-${sanitised}`;
        cb(null, unique);
    },
});

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
