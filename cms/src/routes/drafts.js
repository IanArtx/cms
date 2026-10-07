// ============================================================
// DRAFTS ROUTES (v1.81.0) — Prefix: /api/drafts
// Unfinished forms, always scoped to the signed-in person
// (see controllers/draftsController.js).
// ============================================================

const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const c = require('../controllers/draftsController');

router.use(authenticate);

router.get('/', c.listDrafts);
router.get('/:key', c.getDraft);
router.put('/:key', c.saveDraft);
router.delete('/:key', c.deleteDraft);

module.exports = router;
