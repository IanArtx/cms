// ============================================================
// FINANCIAL STATEMENTS PACK — endpoints (v1.88.0)
// Mounted under /api/reports (routes/reports.js):
//   GET  /financial-statements/years              the financial years
//   GET  /financial-statements?year=2026          the whole pack (JSON)
//   PUT  /financial-statements/:year/texts        change the wording (Treasurer / Assistant Treasurer / Admin)
//   PUT  /financial-statements/settings           non-current accounts, auditors, approvals needed (same people)
//   POST /financial-statements/:year/approve      a director approves (their signature is copied)
//   POST /financial-statements/:year/withdraw     a director withdraws their own approval (reason)
//   GET  /financial-statements/:year/pdf          download — PDF
//   GET  /financial-statements/:year/xlsx         download — Excel (statements, notes, books)
//   GET  /books.xlsx?from_date=&to_date=          download — trial balance, general ledger, cash book
// Viewing needs FINANCE_VIEW_ALL (like every statement).
// ============================================================

const db = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess } = require('../utils/response');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');
const fs = require('../services/financialStatementsService');
const render = require('../services/fsPackRenderService');
const { renderHtmlToPdfBuffer } = require('../services/pdfService');
const { readBuffer, toKey } = require('../services/storageService');
const gov = require('../services/governanceService');

const roles = (req) => (req.user && req.user.roles) || [];
const canEdit = (req) => roles(req).some(r => fs.EDITOR_ROLES.includes(r));
const isDirector = (req) => roles(req).includes(fs.APPROVER_ROLE);
const yearParam = (req) => {
    const y = parseInt(req.params.year || req.query.year, 10);
    if (!y || y < 2000 || y > 2100) throw createError.badRequest('Choose a financial year.');
    return y;
};
const assertReady = async () => {
    if (!(await fs.tablesReady())) throw createError.conflict('The financial statements pack needs the v1.88.0 database update — run update_live_database.js first.');
};
const safeName = (s) => String(s || 'Company').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');

const getYears = asyncHandler(async (req, res) => {
    sendSuccess(res, await fs.listYears());
});

const getPack = asyncHandler(async (req, res) => {
    const years = await fs.listYears();
    const year = req.query.year ? yearParam(req) : years.defaultYear;
    const pack = await fs.buildPack(year);
    const ready = await fs.tablesReady();
    sendSuccess(res, {
        ...pack, ready,
        can: {
            edit: ready && canEdit(req),
            approve: ready && isDirector(req) && !pack.year.inProgress,
            myApproval: pack.approvals.find(a => a.user_id === req.user.id && !a.withdrawn_at) || null,
        },
    });
});

const saveTexts = asyncHandler(async (req, res) => {
    await assertReady();
    if (!canEdit(req)) throw createError.forbidden('Only the Treasurer, Assistant Treasurer or Admin can change the wording.');
    const year = yearParam(req);
    const incoming = (req.body && req.body.texts) || {};
    const { saved } = await fs.getTexts(year);
    const next = { ...saved };
    const changed = [];
    for (const [k, v] of Object.entries(incoming)) {
        if (!fs.TEXT_KEYS.has(k)) continue;
        const std = fs.TEXT_SECTIONS.find(s => s.key === k).text;
        if (v === null || v === undefined || String(v).trim() === std.trim()) { if (k in next) { delete next[k]; changed.push(k); } continue; }
        const text = String(v).replace(/\r\n/g, '\n').slice(0, 20000);
        if (next[k] !== text) { next[k] = text; changed.push(k); }
    }
    await db.query(`
        INSERT INTO fs_notes (fy_end_year, texts, updated_by, updated_at) VALUES ($1, $2, $3, NOW())
        ON CONFLICT (fy_end_year) DO UPDATE SET texts = EXCLUDED.texts, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [year, JSON.stringify(next), req.user.id]);
    await logAction(req.user.id, ACTIONS.FS_NOTES_UPDATED, MODULES.REPORTS, {
        ipAddress: req.ip, recordType: 'fs_notes', recordId: year, newValues: { changed },
    });
    sendSuccess(res, { changed }, changed.length ? `Saved — ${changed.length} section${changed.length === 1 ? '' : 's'} changed.` : 'Nothing changed.');
});

const saveSettings = asyncHandler(async (req, res) => {
    await assertReady();
    if (!canEdit(req)) throw createError.forbidden('Only the Treasurer, Assistant Treasurer or Admin can change these settings.');
    const b = req.body || {};
    const cls = {};
    for (const [code, v] of Object.entries(b.classification || {})) {
        if (/^[0-9]{4}$/.test(code) && (v === 'CURRENT' || v === 'NON_CURRENT')) cls[code] = v;
    }
    const needed = Math.max(1, Math.min(10, parseInt(b.approvals_required, 10) || 2));
    const clip = (s) => (s === undefined || s === null ? null : String(s).slice(0, 1000));
    await db.query(`
        UPDATE fs_pack_settings SET classification = $1, auditors = $2, bankers = $3, lawyers = $4,
               approvals_required = $5, updated_by = $6, updated_at = NOW() WHERE id = 1`,
    [JSON.stringify(cls), clip(b.auditors), clip(b.bankers), clip(b.lawyers), needed, req.user.id]);
    await logAction(req.user.id, ACTIONS.FS_SETTINGS_UPDATED, MODULES.REPORTS, {
        ipAddress: req.ip, recordType: 'fs_pack_settings', recordId: 1, newValues: { classification: cls, approvals_required: needed },
    });
    sendSuccess(res, await fs.getPackSettings(), 'Settings saved.');
});

const approve = asyncHandler(async (req, res) => {
    await assertReady();
    if (!isDirector(req)) throw createError.forbidden('Only a director can approve the financial statements.');
    await require('../services/personalAccessService').assertActionAllowed(req.user.id, 'APPROVE_FINANCIAL_STATEMENTS', 'approve the financial statements'); // v1.89.0
    const year = yearParam(req);
    const pack = await fs.buildPack(year);
    if (pack.year.inProgress) throw createError.conflict(`The financial year ${pack.year.label} has not ended yet — it can be approved after ${render.longDate(pack.year.end)}.`);
    if (pack.approvals.some(a => a.user_id === req.user.id && !a.withdrawn_at)) throw createError.conflict('You have already approved these financial statements.');
    const sig = await gov.captureSignature(db, req.user.id, `fs-approval-${year}-${req.user.id}`);
    await db.query(`INSERT INTO fs_approvals (fy_end_year, user_id, signature_snapshot_path, figures) VALUES ($1, $2, $3, $4)`,
        [year, req.user.id, sig, JSON.stringify(pack.figures)]);
    await logAction(req.user.id, ACTIONS.FS_APPROVED, MODULES.REPORTS, {
        ipAddress: req.ip, recordType: 'fs_approvals', recordId: year, newValues: { year, figures: pack.figures },
    });
    const done = pack.approvals.filter(a => !a.withdrawn_at).length + 1;
    sendSuccess(res, null, done >= pack.approvalsRequired
        ? `Approved. The financial statements for ${pack.year.label} now carry ${done} director approvals and are final.`
        : `Approved. ${pack.approvalsRequired - done} more director approval${pack.approvalsRequired - done === 1 ? ' is' : 's are'} needed.`);
});

const withdraw = asyncHandler(async (req, res) => {
    await assertReady();
    const year = yearParam(req);
    const reason = String((req.body && req.body.reason) || '').trim();
    if (reason.length < 5) throw createError.badRequest('Give a reason (at least 5 characters) for withdrawing your approval.');
    const r = await db.query(`UPDATE fs_approvals SET withdrawn_at = NOW(), withdrawn_by = $2, withdrawn_reason = $3
                              WHERE fy_end_year = $1 AND user_id = $2 AND withdrawn_at IS NULL RETURNING id`, [year, req.user.id, reason]);
    if (!r.rows.length) throw createError.notFound('You have no approval to withdraw for this year.');
    await logAction(req.user.id, ACTIONS.FS_APPROVAL_WITHDRAWN, MODULES.REPORTS, {
        ipAddress: req.ip, recordType: 'fs_approvals', recordId: year, newValues: { reason },
    });
    sendSuccess(res, null, 'Your approval was withdrawn.');
});

// Logo and signatures as data: images, so the PDF needs no network.
const dataUri = async (stored) => {
    if (!stored) return null;
    if (/^data:image\//.test(stored)) return stored;
    const buf = await readBuffer(toKey(stored));
    if (!buf) return null;
    const type = /\.svg$/i.test(stored) ? 'image/svg+xml' : /\.jpe?g$/i.test(stored) ? 'image/jpeg' : 'image/png';
    return `data:${type};base64,${buf.toString('base64')}`;
};

const downloadPdf = asyncHandler(async (req, res) => {
    const year = yearParam(req);
    const pack = await fs.buildPack(year);
    const images = { logo: await dataUri(pack.company.logo_url) };
    for (const a of pack.approvals.filter(x => !x.withdrawn_at)) images[`sig-${a.id}`] = await dataUri(a.signature_snapshot_path);
    const html = render.renderPackHtml(pack, images);
    const footer = `<div style="font-family:Arial,sans-serif;font-size:7.5px;color:#6b7280;width:100%;padding:0 15mm;display:flex;justify-content:space-between">
        <span>${pack.company.name.replace(/</g, '&lt;')} — financial statements for the year ended ${render.longDate(pack.year.to)}</span>
        <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`;
    const pdf = await renderHtmlToPdfBuffer(html, {
        displayHeaderFooter: true, headerTemplate: '<div></div>', footerTemplate: footer,
        margin: { top: '16mm', bottom: '18mm', left: '16mm', right: '16mm' },
    });
    await logAction(req.user.id, ACTIONS.FS_EXPORTED, MODULES.REPORTS, {
        ipAddress: req.ip, recordType: 'financial_statements', recordId: year, newValues: { format: 'PDF', status: pack.status },
    }).catch(() => {});
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName(pack.company.name)}_Financial_Statements_${pack.year.label.replace('/', '-')}.pdf"`);
    res.send(Buffer.from(pdf));
});

const sendWorkbook = async (res, wb, filename) => {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    const buf = await wb.xlsx.writeBuffer();
    res.send(Buffer.from(buf));
};

const downloadXlsx = asyncHandler(async (req, res) => {
    const year = yearParam(req);
    const pack = await fs.buildPack(year);
    const wb = await render.buildPackWorkbook(pack);
    await logAction(req.user.id, ACTIONS.FS_EXPORTED, MODULES.REPORTS, {
        ipAddress: req.ip, recordType: 'financial_statements', recordId: year, newValues: { format: 'XLSX', status: pack.status },
    }).catch(() => {});
    await sendWorkbook(res, wb, `${safeName(pack.company.name)}_Financial_Statements_${pack.year.label.replace('/', '-')}.xlsx`);
});

const downloadBooks = asyncHandler(async (req, res) => {
    const to = (req.query.to_date || new Date().toISOString().slice(0, 10)).slice(0, 10);
    const from = (req.query.from_date || `${to.slice(0, 4)}-01-01`).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw createError.badRequest('Choose a valid date range.');
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const name = (await db.query('SELECT company_name FROM company_settings WHERE id = 1')).rows[0];
    wb.creator = name ? name.company_name : 'CMS';
    await render.addBooksSheets(wb, { fromDate: from, toDate: to });
    await sendWorkbook(res, wb, `${safeName(name && name.company_name)}_Books_${from}_to_${to}.xlsx`);
});

module.exports = { getYears, getPack, saveTexts, saveSettings, approve, withdraw, downloadPdf, downloadXlsx, downloadBooks };
