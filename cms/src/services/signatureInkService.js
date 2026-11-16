// ============================================================
// BLUE SIGNATURES (v1.88.0)
//
// Requested: "I would also like that the color of the signature is blue
// across."
//
// Signatures are images (drawn on the signature pad, dark ink on white).
// They appear on screens, printed documents, PDFs made by the server and
// emails, so the only way to have them blue everywhere is to make the
// IMAGE blue:
//   • the signature pad now draws in blue;
//   • every signature saved is turned blue here before it is stored
//     (toBlueInk), so the copies made at each signing are blue too;
//   • the signatures already stored — each person's own signature and the
//     copies already on signed documents — are turned blue once, in the
//     background after the server starts (convertStored). Only the colour
//     of the ink changes: the strokes, the size and the place on each
//     document stay exactly the same. Each converted file is listed in
//     signature_ink_done so it is never processed twice.
//
// The colour mapping: how dark a pixel is decides how much blue ink it
// carries — white stays white, black becomes BLUE, the soft edges in
// between become the matching light blue; see-through stays see-through.
// Running it on an already-blue signature leaves it unchanged.
// ============================================================

const sharp = require('sharp');
const { query } = require('../config/database');
const logger = require('../config/logger');

const BLUE = { r: 29, g: 63, b: 168 }; // ballpoint blue (#1d3fa8)
const lum = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
const L_BLUE = lum(BLUE.r, BLUE.g, BLUE.b);

const toBlueInk = async (buffer) => {
    const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let i = 0; i < data.length; i += 4) {
        const L = lum(data[i], data[i + 1], data[i + 2]);
        const t = Math.max(0, Math.min(1, (1 - L) / (1 - L_BLUE))); // 1 = full ink, 0 = paper
        data[i] = Math.round(255 - (255 - BLUE.r) * t);
        data[i + 1] = Math.round(255 - (255 - BLUE.g) * t);
        data[i + 2] = Math.round(255 - (255 - BLUE.b) * t);
    }
    return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
};

let running = false;
const convertStored = async () => {
    if (running) return { skipped: true };
    running = true;
    try {
        const ok = (await query(`SELECT to_regclass('public.signature_ink_done') IS NOT NULL AS ok`)).rows[0].ok;
        if (!ok) return { skipped: true };
        const { listKeys, readBuffer, uploadBuffer } = require('./storageService');
        const keys = [...(await listKeys('signatures/')), ...(await listKeys('signature-snapshots/'))]
            .filter(k => /\.png$/i.test(k));
        if (!keys.length) return { converted: 0 };
        const done = new Set((await query('SELECT key FROM signature_ink_done WHERE key = ANY($1::text[])', [keys])).rows.map(r => r.key));
        let converted = 0; let failed = 0;
        for (const key of keys) {
            if (done.has(key)) continue;
            try {
                const buf = await readBuffer(key);
                if (!buf) continue;
                await uploadBuffer(await toBlueInk(buf), key, 'image/png');
                await query('INSERT INTO signature_ink_done (key) VALUES ($1) ON CONFLICT DO NOTHING', [key]);
                converted += 1;
            } catch (err) {
                failed += 1;
                logger.warn(`Signature ${key} could not be turned blue: ${err.message}`);
            }
        }
        if (converted || failed) logger.info(`Signatures turned blue: ${converted}${failed ? `, ${failed} could not be read` : ''}`);
        return { converted, failed };
    } finally {
        running = false;
    }
};

// Record a file this service has just written blue (a new signature).
const markDone = async (key) => {
    try { await query('INSERT INTO signature_ink_done (key) VALUES ($1) ON CONFLICT DO NOTHING', [key]); } catch { /* before the migration */ }
};

module.exports = { toBlueInk, convertStored, markDone, BLUE };
