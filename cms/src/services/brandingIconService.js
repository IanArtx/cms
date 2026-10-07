// ============================================================
// APP ICONS FROM THE COMPANY LOGO (v1.81.0)
//
// Requested: "the react app logo shows as the icon when one installs the
// system link on their mobile homescreen and on the mobile tab view in a
// browser instead of the company logo".
//
// Both companies run the same code, so the icons cannot be fixed files.
// They are made here, on request, from the logo each company uploads in
// Settings › Company (company_settings.logo_url):
//   GET /api/public/branding/icon-<size>.png       square, white, logo centred
//   GET /api/public/branding/maskable-<size>.png   extra margin for Android's
//                                                  round / squircle masks
//   GET /api/public/branding/favicon.ico           browser tab
//   GET /api/public/branding/manifest.webmanifest  "install / add to home
//                                                  screen" details: name,
//                                                  colours and the icons above
// No sign-in is needed (a phone fetches these on its own). Nothing private is
// served: only the logo, which is already public under /uploads/branding/.
// Without a logo a neutral building symbol is used — never the React logo.
// ============================================================

const sharp = require('sharp');
const { query } = require('../config/database');
const { readBuffer, toKey } = require('./storageService');

const SIZES = [16, 32, 48, 64, 96, 120, 152, 167, 180, 192, 256, 384, 512];
const THEME = '#0b1f3a';

// A neutral building symbol (no text, so no fonts are needed on the server).
const FALLBACK_SVG = Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="${THEME}"/>
  <g fill="#ffffff">
    <path d="M256 92 L420 172 L420 196 L92 196 L92 172 Z"/>
    <rect x="124" y="214" width="40" height="160" rx="4"/>
    <rect x="200" y="214" width="40" height="160" rx="4"/>
    <rect x="272" y="214" width="40" height="160" rx="4"/>
    <rect x="348" y="214" width="40" height="160" rx="4"/>
    <rect x="92" y="390" width="328" height="30" rx="4"/>
  </g>
</svg>`);

let cache = { logoUrl: undefined, name: null, shortName: null, source: null, pngs: new Map() };

const loadSettings = async () => {
    const r = await query(`SELECT company_name, logo_url FROM company_settings ORDER BY id LIMIT 1`).catch(() => ({ rows: [] }));
    const row = r.rows[0] || {};
    return { name: row.company_name || process.env.COMPANY_NAME || 'Company system', logoUrl: row.logo_url || null };
};

// The logo bytes (or null), re-read whenever the stored logo changes.
const current = async () => {
    const s = await loadSettings();
    if (s.logoUrl !== cache.logoUrl || s.name !== cache.name) {
        let source = null;
        if (s.logoUrl) {
            const buf = await readBuffer(toKey(s.logoUrl));
            if (buf) {
                try {
                    // Trim the empty margin around the artwork so it fills the icon.
                    source = await sharp(buf).trim({ threshold: 10 }).png().toBuffer();
                } catch (_) {
                    try { source = await sharp(buf).png().toBuffer(); } catch (e) { source = null; }
                }
            }
        }
        cache = { logoUrl: s.logoUrl, name: s.name, shortName: shortName(s.name), source, pngs: new Map() };
    }
    return cache;
};

const shortName = (name) => {
    // e.g. "INVESTABO GLOBAL INVESTMENTS LIMITED" → "Investabo"
    const first = String(name || '').trim().split(/\s+/)[0] || 'Company';
    return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
};

// size = canvas, fill = share of the canvas the artwork may use.
const render = async (size, { maskable = false } = {}) => {
    const c = await current();
    const key = `${maskable ? 'm' : 'i'}${size}`;
    if (c.pngs.has(key)) return c.pngs.get(key);
    let png;
    if (c.source) {
        const fill = maskable ? 0.62 : 0.84;
        const inner = Math.max(1, Math.round(size * fill));
        const art = await sharp(c.source)
            .resize(inner, inner, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
            .flatten({ background: '#ffffff' })
            .png().toBuffer();
        png = await sharp({ create: { width: size, height: size, channels: 4, background: '#ffffff' } })
            .composite([{ input: art, gravity: 'centre' }])
            .png().toBuffer();
    } else {
        png = await sharp(FALLBACK_SVG, { density: 300 }).resize(size, size).png().toBuffer();
    }
    c.pngs.set(key, png);
    return png;
};

// An .ico file may simply contain PNG images (supported by every current
// browser): a 6-byte header, one 16-byte entry per image, then the images.
const toIco = (pngs) => {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
    const entries = [];
    let offset = 6 + 16 * pngs.length;
    for (const { size, data } of pngs) {
        const e = Buffer.alloc(16);
        e.writeUInt8(size >= 256 ? 0 : size, 0); e.writeUInt8(size >= 256 ? 0 : size, 1);
        e.writeUInt8(0, 2); e.writeUInt8(0, 3);
        e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
        e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12);
        offset += data.length;
        entries.push(e);
    }
    return Buffer.concat([header, ...entries, ...pngs.map(p => p.data)]);
};

const favicon = async () => {
    const parts = [];
    for (const size of [16, 32, 48]) parts.push({ size, data: await render(size) });
    return toIco(parts);
};

// `apiBase` is this server's own public address (…/api/public/branding).
const manifest = async (apiBase) => {
    const c = await current();
    const frontend = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
    const v = encodeURIComponent(c.logoUrl || 'none'); // a new logo → new icon addresses → phones refresh them
    return {
        id: '/',
        name: c.name,
        short_name: c.shortName,
        description: `${c.name} — company system`,
        start_url: `${frontend}/`,
        scope: `${frontend}/`,
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: THEME,
        icons: [
            { src: `${apiBase}/icon-192.png?v=${v}`, sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: `${apiBase}/icon-512.png?v=${v}`, sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: `${apiBase}/maskable-192.png?v=${v}`, sizes: '192x192', type: 'image/png', purpose: 'maskable' },
            { src: `${apiBase}/maskable-512.png?v=${v}`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
    };
};

module.exports = { SIZES, render, favicon, manifest };
