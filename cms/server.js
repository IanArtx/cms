// ============================================================
// SERVER ENTRY POINT
// Configures Express, registers all middleware and routes,
// and starts listening for requests.
// ============================================================

require('dotenv').config();

const express = require('express');
const helmet  = require('helmet');
const cors    = require('cors');
const rateLimit = require('express-rate-limit');
const path    = require('path');
const fs      = require('fs');

const logger             = require('./src/config/logger');
const { checkConnection } = require('./src/config/database');
const { verifyEmailConnection } = require('./src/config/email');
const { globalErrorHandler, createError } = require('./src/utils/errors');
const { streamInline, isS3Configured } = require('./src/services/storageService');

// ============================================================
// INITIALISE EXPRESS
// ============================================================
const app = express();

// ============================================================
// SECURITY MIDDLEWARE
// These run on every request before routes are evaluated.
// ============================================================

// Helmet sets secure HTTP headers (prevents common web attacks)
app.use(helmet());

// CORS — defines which frontend origins can call this API
//
// FRONTEND_URL is the site's "real" address — also used elsewhere (e.g.
// authService.js's password-reset/verify-email links), so it should be
// whatever address you want members to actually see and click.
//
// EXTRA_ORIGINS (optional, added v1.32.2) is a comma-separated list of
// any OTHER addresses that should also be allowed to call this API — for
// example, the service's own onrender.com URL, kept as a working fallback
// once a custom domain is in place (DNS can take time to propagate, and
// it's handy to still be able to load the onrender.com address directly
// for testing). Leave it unset and nothing changes from before.
const allowedOrigins = [
    process.env.FRONTEND_URL || 'http://localhost:3000',
    ...(process.env.EXTRA_ORIGINS
        ? process.env.EXTRA_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
        : []),
];

app.use(cors({
    origin: (origin, callback) => {
        // No Origin header at all (server-to-server calls, curl, the
        // Render health check) — always allow, nothing to check against.
        if (!origin || allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Rate limits are much looser in development so page reloads and repeated
// login attempts while testing don't lock you out. Production keeps the
// strict limits — this only relaxes things when NODE_ENV=development.
const isDev = process.env.NODE_ENV !== 'production';

// Global rate limiter — prevents brute-force and DDoS
// Production: 200 requests per IP per 15 minutes across all endpoints
// Development: 5000 — effectively won't trip during normal testing
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: isDev ? 5000 : 200,
    message: { success: false, message: 'Too many requests. Please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});
app.use(globalLimiter);

// Stricter rate limiter for authentication endpoints
// Production: 10 attempts per IP per 15 minutes
// Development: 200 — still catches a real runaway loop, but won't block
// you after a handful of test logins
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: isDev ? 200 : 10,
    message: { success: false, message: 'Too many login attempts. Please try again in 15 minutes.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// ============================================================
// BODY PARSING
// ============================================================
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ============================================================
// UPLOADED FILE SERVING (v1.29.1, Section 4.34)
// Was a plain express.static('/uploads', ...) mount — now proxies
// through storageService instead, so it reads from Cloudflare R2 in
// production (where the disk is ephemeral) and transparently falls
// back to local disk when S3_* env vars aren't set (local dev).
// Every existing /uploads/<key> URL already stored in the database
// (photo_path, signature_path, logo_url, stamp/document/audit-report/
// receipt file_path columns) keeps resolving exactly as before — only
// how the bytes get fetched has changed, not the URL format.
// ============================================================
if (!isS3Configured) {
    // Local dev fallback only — makes sure the folder exists so
    // storageService's local-disk branch has somewhere to write.
    const uploadDir = process.env.UPLOAD_DIR || './uploads';
    fs.mkdirSync(uploadDir, { recursive: true });
}
// Express 5 (this project's version) requires a named wildcard —
// bare '*' throws "Missing parameter name" at startup under its
// path-to-regexp v6+ router. req.params.splat is an array of the
// matched segments, joined back into the full key.
app.get('/uploads/*splat', async (req, res) => {
    const key = Array.isArray(req.params.splat) ? req.params.splat.join('/') : req.params.splat;
    // Helmet (above) sets Cross-Origin-Resource-Policy: same-origin on every
    // response by default — a browser-enforced rule that blocks a DIFFERENT
    // origin from embedding this response as an <img>/<script>/<link> etc.
    // The frontend and backend are always separate origins on this two-service
    // Render setup, so without this override every <img src="/uploads/...">
    // (profile photos, signatures, company logo, stamps) silently fails to
    // render — the request never even reaches this handler's logs as an
    // error, since the browser blocks it client-side before painting it.
    // These files are intentionally public-style with no access-control
    // check of their own (see streamInline's comment in storageService.js),
    // so it's safe to explicitly mark them loadable cross-origin — this does
    // NOT loosen anything for the rest of the app, which still defaults to
    // same-origin (v1.32.3).
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    await streamInline(key, res);
});

// ============================================================
// HEALTH CHECK ENDPOINT
// Used by monitoring tools and load balancers
// ============================================================
app.get('/health', (req, res) => {
    res.json({
        success: true,
        status:  'OK',
        service: process.env.COMPANY_NAME || 'CMS',
        time:    new Date().toISOString(),
    });
});

// ============================================================
// API ROUTES
// All routes are versioned under /api
// ============================================================
app.use('/api/auth',        authLimiter,                    require('./src/routes/auth'));
app.use('/api/users',                                       require('./src/routes/users'));
app.use('/api/categories',                                  require('./src/routes/categories'));

// --- ROUTES TO BE ADDED IN SUBSEQUENT PARTS ---
app.use('/api/accounts',     require('./src/routes/accounts'));
app.use('/api/transactions', require('./src/routes/transactions'));
app.use('/api/transfers',    require('./src/routes/transfers'));
app.use('/api/grants',       require('./src/routes/grants'));
app.use('/api/loans',        require('./src/routes/loans'));
app.use('/api/investments',  require('./src/routes/investments'));
app.use('/api/mmf',          require('./src/routes/mmf'));
app.use('/api/capital-goals', require('./src/routes/capitalGoals'));
app.use('/api/payment-acknowledgements', require('./src/routes/paymentAcknowledgements'));
app.use('/api/events',       require('./src/routes/events'));
app.use('/api/documents',    require('./src/routes/documents'));
app.use('/api/reports',      require('./src/routes/reports'));
app.use('/api/system', require('./src/routes/system'));
app.use('/api/dividends', require('./src/routes/dividends'));
app.use('/api/savings', require('./src/routes/savings'));
app.use('/api/side-fund', require('./src/routes/sideFund'));
app.use('/api/requisitions', require('./src/routes/requisitions'));
app.use('/api/settings', require('./src/routes/settings'));
app.use('/api/notifications', require('./src/routes/notifications'));
app.use('/api/shares', require('./src/routes/shares'));
app.use('/api/exchange-rates', require('./src/routes/exchangeRates'));
app.use('/api/certificates', require('./src/routes/certificates'));
app.use('/api/search', require('./src/routes/search'));

app.use('/api/audit', require('./src/routes/audit'));
app.use('/api/staff-access', require('./src/routes/staffAccess'));
app.use('/api/service-fees', require('./src/routes/serviceFees'));

// ============================================================
// 404 HANDLER
// Catches any request that didn't match a route above
// ============================================================
app.use((req, res, next) => {
    next(createError.notFound(`Route not found: ${req.method} ${req.path}`));
});

// ============================================================
// GLOBAL ERROR HANDLER
// Must be the LAST middleware registered
// ============================================================
app.use(globalErrorHandler);

// ============================================================
// START SERVER
// ============================================================
const PORT = parseInt(process.env.PORT) || 5000;

const startServer = async () => {
    // Verify database connection before accepting requests
    const dbOk = await checkConnection();
    if (!dbOk) {
        logger.error('Cannot start server — database connection failed');
        process.exit(1);
    }

    // Verify email connection (non-fatal — server still starts)
    await verifyEmailConnection();

    // Start scheduled jobs
    const { startAllJobs } = require('./src/jobs/scheduler');
    startAllJobs();

    // Start listening
    app.listen(PORT, () => {
        logger.info(`🚀 Server running on port ${PORT} in ${process.env.NODE_ENV} mode`);
        logger.info(`📋 Health check: http://localhost:${PORT}/health`);
    });
};

// Handle unhandled promise rejections (e.g. DB crashes mid-request)
process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Promise Rejection:', { reason: reason?.message || reason });
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
    logger.error('Uncaught Exception — shutting down:', { error: err.message, stack: err.stack });
    process.exit(1);
});

startServer();

module.exports = app;
