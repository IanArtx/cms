// ============================================================
// DRAFTS — unfinished forms kept for the person (v1.81.0)
//
// Requested: "as one fills the forms / templates that the system can
// recall where they left off in case they don't complete filling the
// template in case there is a sudden refresh, loss of internet or any
// other reason … if one is writing minutes and they press the back button
// or click a button in the UI unintentionally".
// Confirmed: kept on the server AND on the device. The device copy is
// written as the person types (survives refresh and lost internet); this
// server copy is updated every few seconds (survives automatic sign-out
// and a change of device). The device copy is removed when the person
// signs out themselves; the server copy stays until the form is submitted
// or the person discards it.
//
// Every draft belongs to one person. Nobody else — Admins included — can
// list or read it. Nothing here is a company record: a draft never posts,
// approves or files anything; it only refills a form.
//
//   GET    /api/drafts           my drafts (title, page, when) — no contents
//   GET    /api/drafts/:key      one draft's contents (null if none)
//   PUT    /api/drafts/:key      { data, title, page } — create / replace
//   DELETE /api/drafts/:key      remove (submitted or discarded)
// ============================================================

const { query } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess } = require('../utils/response');

const KEY_RE = /^[a-z0-9][a-z0-9:_.\-]{0,159}$/i;
const MAX_BYTES = 512 * 1024;    // a long set of minutes fits easily
const MAX_DRAFTS = 100;          // per person; the oldest go first
const KEEP_DAYS = 90;            // untouched drafts are removed after this

const checkKey = (key) => {
    if (!KEY_RE.test(String(key || ''))) throw createError.badRequest('Invalid draft name.');
    return String(key);
};

let ready = null;
const assertReady = async () => {
    if (ready === null) {
        const r = await query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'form_drafts'`);
        ready = r.rows.length > 0;
    }
    if (!ready) throw createError.badRequest('Saving drafts needs the v1.81.0 database update.');
};

const listDrafts = asyncHandler(async (req, res) => {
    await assertReady();
    const r = await query(`
        SELECT draft_key, title, page_path, updated_at, created_at, length(data::text) AS size
        FROM   form_drafts
        WHERE  user_id = $1
        ORDER  BY updated_at DESC`, [req.user.id]);
    sendSuccess(res, r.rows);
});

const getDraft = asyncHandler(async (req, res) => {
    await assertReady();
    const key = checkKey(req.params.key);
    const r = await query(`SELECT draft_key, title, page_path, data, updated_at FROM form_drafts WHERE user_id = $1 AND draft_key = $2`,
        [req.user.id, key]);
    sendSuccess(res, r.rows[0] || null);
});

const saveDraft = asyncHandler(async (req, res) => {
    await assertReady();
    const key = checkKey(req.params.key);
    const { data } = req.body || {};
    if (data === undefined || data === null || typeof data !== 'object') throw createError.badRequest('Nothing to save.');
    const json = JSON.stringify(data);
    if (Buffer.byteLength(json, 'utf8') > MAX_BYTES) throw createError.badRequest('This draft is too large to keep (over 512 KB).');
    const title = String(req.body.title || '').trim().slice(0, 200) || null;
    const page = String(req.body.page || '').trim().slice(0, 300) || null;
    if (page && !page.startsWith('/')) throw createError.badRequest('Invalid page.');
    const r = await query(`
        INSERT INTO form_drafts (user_id, draft_key, title, page_path, data)
        VALUES ($1, $2, $3, $4, $5::jsonb)
        ON CONFLICT (user_id, draft_key)
        DO UPDATE SET data = EXCLUDED.data, title = COALESCE(EXCLUDED.title, form_drafts.title),
                      page_path = COALESCE(EXCLUDED.page_path, form_drafts.page_path), updated_at = NOW()
        RETURNING updated_at`, [req.user.id, key, title, page, json]);
    // Housekeeping for this person only: old and surplus drafts.
    await query(`DELETE FROM form_drafts WHERE user_id = $1 AND updated_at < NOW() - make_interval(days => $2)`, [req.user.id, KEEP_DAYS]);
    await query(`
        DELETE FROM form_drafts WHERE id IN (
            SELECT id FROM form_drafts WHERE user_id = $1 ORDER BY updated_at DESC OFFSET $2)`, [req.user.id, MAX_DRAFTS]);
    sendSuccess(res, { draft_key: key, updated_at: r.rows[0].updated_at });
});

const deleteDraft = asyncHandler(async (req, res) => {
    await assertReady();
    const key = checkKey(req.params.key);
    await query(`DELETE FROM form_drafts WHERE user_id = $1 AND draft_key = $2`, [req.user.id, key]);
    sendSuccess(res, null, 'Draft removed');
});

module.exports = { listDrafts, getDraft, saveDraft, deleteDraft };
