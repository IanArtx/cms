// ============================================================
// PUBLIC BRANDING ROUTES (v1.81.0)
// Prefix: /api/public/branding — no sign-in. The phone or browser asks
// for these itself when the system is opened or added to a home screen.
// See services/brandingIconService.js.
// ============================================================

const router = require('express').Router();
const { asyncHandler } = require('../utils/errors');
const icons = require('../services/brandingIconService');

// Loadable from the website's own address (a different origin from this API).
router.use((req, res, next) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
});

const base = (req) => `${req.protocol}://${req.get('host')}${req.baseUrl}`;

const sendPng = (res, png) => {
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.end(png);
};

router.get('/manifest.webmanifest', asyncHandler(async (req, res) => {
    res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.end(JSON.stringify(await icons.manifest(base(req)), null, 2));
}));

router.get('/favicon.ico', asyncHandler(async (req, res) => {
    res.setHeader('Content-Type', 'image/x-icon');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.end(await icons.favicon());
}));

// icon-192.png, maskable-512.png, apple-touch-icon.png (180)
router.get('/apple-touch-icon.png', asyncHandler(async (req, res) => sendPng(res, await icons.render(180))));
router.get('/:kind-:size.png', asyncHandler(async (req, res, next) => {
    const size = parseInt(req.params.size, 10);
    if (!['icon', 'maskable'].includes(req.params.kind) || !icons.SIZES.includes(size)) return next();
    sendPng(res, await icons.render(size, { maskable: req.params.kind === 'maskable' }));
}));

module.exports = router;
