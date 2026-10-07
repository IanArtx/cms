// ============================================================
// DOCUMENT VIEWER ROUTES (v1.82.1)
// Prefix: /api/viewer
//
// POST /pdf  { html, title }  → application/pdf
//   The document viewer's "Save as PDF" on phones and tablets: the
//   document the person is already looking at (receipt, minutes,
//   statement, this manual …) comes back as a real PDF file. Nothing
//   is stored. See services/pdfService.js renderViewerHtmlToPdf for how
//   the HTML is kept from doing anything but draw itself.
// ============================================================

const router = require('express').Router();
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { body } = require('express-validator');
const { validateRequest } = require('../middleware/validate');
const { authenticate, requireAssignedRole } = require('../middleware/auth');
const { asyncHandler, createError } = require('../utils/errors');
const { renderViewerHtmlToPdf } = require('../services/pdfService');
const logger = require('../config/logger');

router.use(authenticate);
router.use(requireAssignedRole);

// A PDF takes a few seconds of server time — 12 a minute per person is
// far more than anyone needs and stops the server being flooded.
const pdfLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 12,
    keyGenerator: (req) => (req.user?.id ? `viewer-pdf:${req.user.id}` : ipKeyGenerator(req.ip)),
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many PDFs at once — wait a minute and try again.' },
});

const safeName = (t) => String(t || 'document')
    .replace(/[^\w\s.\-()&]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'document';

router.post('/pdf',
    pdfLimiter,
    [
        body('html').isString().withMessage('html is required')
            .isLength({ min: 20, max: 8 * 1024 * 1024 }).withMessage('The document is empty or too large'),
        body('title').optional().isString().isLength({ max: 300 }),
    ],
    validateRequest,
    asyncHandler(async (req, res) => {
        let pdf;
        try {
            pdf = await renderViewerHtmlToPdf(req.body.html);
        } catch (err) {
            logger.error('Viewer PDF failed', { error: err.message, user: req.user?.id });
            throw createError.internal('The PDF could not be made on the server. Use Print instead, or try again.');
        }
        const name = `${safeName(req.body.title)}.pdf`;
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/"/g, '')}"`);
        res.setHeader('Cache-Control', 'no-store');
        res.send(Buffer.from(pdf));
    }),
);

module.exports = router;
