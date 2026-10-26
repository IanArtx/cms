// ============================================================
// BANK OF UGANDA RATES (v1.83.0)
//
// Reads the Bank of Uganda's daily "OPENING RATES" workbook — the file
// behind the "Copy Link" button on bou.or.ug › Interest rates & exchange
// rates (Major Exchange Rates). It holds, for each currency, the UGX
// MIDDLE, BUYING and SELLING rate for one unit, and the date they are
// for ("EXCHANGE RATES FOR <date> OPENING").
//
//   const r = await fetchBouOpeningRates();
//   → { rateDate: '2026-10-14', kind: 'OPENING', fileUrl, fileUpdatedAt,
//       rates: { EUR: { middle, buying, selling, label }, USD: {…}, … } }
//
// How the file is found: BoU's website is built on a content system
// with a public read-only address (/api/interest-rate) that lists the
// files on that page. The workbook's address changes when BoU uploads
// a new one, so it is looked up each time; the last known address is
// only a fallback.
//
// How it is read: an .xlsx file is a zip of XML files. Only two are
// needed (the shared text and the first sheet), so they are unpacked
// with Node's own zlib — no extra library. The layout is found by its
// headings ("MIDDLE RATE", "BUYING RATE", "SELLING RATE"), not by fixed
// cell positions, so small layout changes don't break it; anything
// unexpected throws a clear error and the Treasurer is told.
//
// v1.87.1 — BoU STOPPED UPDATING that workbook on 22 Oct 2026. Its page
// now shows a Power BI report fed by a new file, "Daily Exchange Rate
// Cards_Website.xlsx" (re-uploaded under a new address each day), laid out:
//     Currency (26 October 2026) | Mid Rate | Buying | Selling
//     USD (Opening)              | 4434.76  | 4429.76 | 4439.76
//     USD (Midday) … USD (Closing) … GBP, EUR, KES, TZS, ZAR the same way
// It is found through the site's public file list (/api/upload/files,
// newest first) and read by parseRateCardWorkbook. The OPENING rate is
// used (the Midday rate if the opening one is blank), as before. The old
// workbook is still read when the card cannot be found or read, and the
// check log then says why.
//
// AllRatesToday (optional backup / cross-check, only when the key
// BOU_RATES_API_KEY is set in .env) republishes the same BoU table:
//   const r = await fetchAllRatesToday();   → same shape
// ============================================================

const zlib = require('zlib');

const BOU_SITE = 'https://bou.or.ug';
const BOU_PAGE_API = `${BOU_SITE}/api/interest-rate?populate=chart.chart.file.file`;
const BOU_FALLBACK_FILE = '/uploads/OPENING_RATES_4ffc75da06.xlsx';
// v1.87.1 — the daily rate card behind the Power BI report
const BOU_RATE_CARD_NAME = 'Daily Exchange Rate Cards';
const BOU_FILES_API = `${BOU_SITE}/api/upload/files`;
const ALLRATES_URL = 'https://allratestoday.com/api/v1/central-bank/bou/latest';
const TIMEOUT_MS = 30000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

const fetchWithTimeout = async (url, options = {}) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
        return await fetch(url, {
            ...options,
            signal: ctrl.signal,
            headers: { 'User-Agent': 'CompanyManagementSystem/1.83 (daily BoU rate check)', ...(options.headers || {}) },
        });
    } catch (err) {
        throw new Error(err.name === 'AbortError' ? `${url} did not answer within ${TIMEOUT_MS / 1000} seconds` : `${url} could not be reached (${err.message})`);
    } finally {
        clearTimeout(t);
    }
};

// ------------------------------------------------------------
// v1.86.2 — try again when BoU's website has a passing problem.
// Reported: "The BoU rates file could not be downloaded (status 502)".
// A 502 / 503 / 504 (BoU's server or the gateway in front of it not
// answering properly), 429 (too many requests), 500, a timeout or no
// connection are usually brief, so the request is repeated before the
// check is reported as failed:
//   scheduled checks: 3 tries, 1 and then 2 minutes apart;
//   "Check BoU now":  3 tries, 5 and then 10 seconds apart (a person waits).
// Any other answer (404 file gone, 403 refused …) is not repeated.
// ------------------------------------------------------------
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRY_WAITS = { patient: [60000, 120000], quick: [5000, 10000] };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const STATUS_TEXT = {
    429: 'too many requests', 500: 'server error at Bank of Uganda', 502: 'Bank of Uganda\'s website did not answer properly (bad gateway)',
    503: 'Bank of Uganda\'s website is unavailable', 504: 'Bank of Uganda\'s website took too long to answer (gateway timeout)',
    403: 'refused by Bank of Uganda\'s website', 404: 'the file is no longer at this address',
};
const describeStatus = (st) => `status ${st}${STATUS_TEXT[st] ? ` — ${STATUS_TEXT[st]}` : ''}`;
const waitWords = (ms) => (ms >= 60000 ? `${Math.round(ms / 60000)} min` : `${Math.round(ms / 1000)} s`);

// Returns { res, tries } for an OK answer; throws { message, tries } otherwise.
const fetchWithRetry = async (url, options = {}, { patient = true } = {}) => {
    const waits = patient ? RETRY_WAITS.patient : RETRY_WAITS.quick;
    let last = '';
    for (let i = 0; i <= waits.length; i++) {
        let retryable = true;
        try {
            const res = await fetchWithTimeout(url, options);
            if (res.ok) return { res, tries: i + 1 };
            last = describeStatus(res.status);
            retryable = RETRY_STATUSES.has(res.status);
        } catch (err) {
            last = err.message; // timeout / could not be reached
        }
        if (!retryable || i === waits.length) {
            const tried = i + 1 > 1 ? `; tried ${i + 1} times, ${waits.slice(0, i).map(waitWords).join(' and ')} apart` : '';
            const e = new Error(`${last}${tried}`);
            e.tries = i + 1;
            throw e;
        }
        await sleep(waits[i]);
    }
    throw new Error(last);
};

// ------------------------------------------------------------
// The workbook's current address (and when BoU last replaced it).
// ------------------------------------------------------------
const findOpeningRatesFile = async ({ patient = true } = {}) => {
    let why = '';
    try {
        const { res } = await fetchWithRetry(BOU_PAGE_API, { headers: { Accept: 'application/json' } }, { patient });
        const json = await res.json();
        const files = [];
        for (const group of json?.data?.chart || []) {
            for (const chart of group?.chart || []) {
                const f = chart?.file?.file;
                if (f?.url) files.push({ name: f.name || '', url: f.url, updatedAt: f.updatedAt || null, title: chart.title || '' });
            }
        }
        const hit = files.find(f => /opening\s*rates/i.test(f.name)) || files.find(f => /\.xlsx$/i.test(f.url));
        if (hit) return { url: new URL(hit.url, BOU_SITE).href, updatedAt: hit.updatedAt, name: hit.name, discovered: true };
        why = 'the page lists no opening-rates file';
    } catch (err) { why = err.message; /* fall back to the last known address */ }
    return { url: `${BOU_SITE}${BOU_FALLBACK_FILE}`, updatedAt: null, name: 'OPENING RATES.xlsx', discovered: false, why };
};

// ------------------------------------------------------------
// Minimal .xlsx reading: unzip two parts, read the cells of sheet 1.
// ------------------------------------------------------------
const unzipEntries = (buf) => {
    let eocd = buf.length - 22;
    while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
    if (eocd < 0) throw new Error('The BoU file is not a valid Excel workbook (no zip directory).');
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    const entries = new Map();
    for (let i = 0; i < count; i++) {
        if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('The BoU workbook could not be read (broken zip directory).');
        const method = buf.readUInt16LE(p + 10);
        const csize = buf.readUInt32LE(p + 20);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const offset = buf.readUInt32LE(p + 42);
        const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
        entries.set(name, { method, csize, offset });
        p += 46 + nameLen + extraLen + commentLen;
    }
    const read = (name) => {
        const e = entries.get(name);
        if (!e) return null;
        const lnl = buf.readUInt16LE(e.offset + 26);
        const lel = buf.readUInt16LE(e.offset + 28);
        const data = buf.slice(e.offset + 30 + lnl + lel, e.offset + 30 + lnl + lel + e.csize);
        if (e.method === 0) return data.toString('utf8');
        if (e.method === 8) return zlib.inflateRawSync(data).toString('utf8');
        throw new Error(`The BoU workbook uses an unknown compression (${e.method}).`);
    };
    return { read, names: Array.from(entries.keys()) };
};

const xmlText = (s) => s
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

const readSheetCells = (buf) => {
    const zip = unzipEntries(buf);
    const sharedXml = zip.read('xl/sharedStrings.xml') || '';
    const shared = [];
    for (const m of sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(xmlText(m[1]));
    // The first sheet named in the workbook (normally sheet1.xml).
    const sheetName = zip.names.find(n => /^xl\/worksheets\/sheet1\.xml$/i.test(n)) || zip.names.find(n => /^xl\/worksheets\/sheet\d+\.xml$/i.test(n));
    if (!sheetName) throw new Error('The BoU workbook has no sheet.');
    const sheetXml = zip.read(sheetName);
    const cells = new Map(); // 'B21' → value (string or number)
    for (const m of sheetXml.matchAll(/<c\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = m[1];
        const inner = m[2] || '';
        const ref = (/r="([A-Z]+\d+)"/.exec(attrs) || [])[1];
        if (!ref) continue;
        const type = (/t="(\w+)"/.exec(attrs) || [])[1];
        const v = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
        let value;
        if (type === 's' && v !== undefined) value = shared[parseInt(v, 10)];
        else if (type === 'inlineStr') value = xmlText((/<is>([\s\S]*?)<\/is>/.exec(inner) || [])[1] || '');
        else if (type === 'str' && v !== undefined) value = xmlText(v);
        else if (v !== undefined) value = Number(v);
        if (value === undefined || value === '' || (typeof value === 'number' && Number.isNaN(value))) continue;
        cells.set(ref, value);
    }
    return cells;
};

const colOf = (ref) => /^([A-Z]+)/.exec(ref)[1];
const rowOf = (ref) => parseInt(/(\d+)$/.exec(ref)[1], 10);
const colNum = (col) => col.split('').reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
const colName = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

// Excel stores dates as days since 30 Dec 1899.
const excelDate = (serial) => {
    const ms = Math.round((serial - 25569) * 86400 * 1000);
    return new Date(ms).toISOString().slice(0, 10);
};

const NAME_CODES = [
    [/UGANDA\s+SHILLINGS?/i, 'USD'],   // "U.S. DOLLAR / UGANDA SHILLINGS (UGX)" prices the US dollar
    [/^\s*EURO\b/i, 'EUR'],
    [/^\s*SDR\b/i, 'XDR'],
    [/S\.?\s*A\.?\s*RAND/i, 'ZAR'],
];

// Which currency a row of the table prices (UGX per one unit of it).
const currencyOfLabel = (label) => {
    const text = String(label || '').trim();
    for (const [rx, code] of NAME_CODES) if (rx.test(text)) return code;
    const m = /\(([A-Z]{3})\)/.exec(text);
    return m ? m[1] : null;
};

/**
 * Turn the workbook's cells into rates. Exported for the tests.
 */
const parseOpeningRatesWorkbook = (buf) => {
    const cells = readSheetCells(buf);

    // The date: the number next to "EXCHANGE RATES FOR".
    let rateDate = null;
    let kind = null;
    for (const [ref, v] of cells) {
        if (typeof v === 'string' && /EXCHANGE\s+RATES\s+FOR/i.test(v)) {
            const r = rowOf(ref);
            for (let c = colNum(colOf(ref)) + 1; c <= colNum(colOf(ref)) + 6; c++) {
                const x = cells.get(`${colName(c)}${r}`);
                if (typeof x === 'number' && x > 30000 && x < 80000 && !rateDate) rateDate = excelDate(x);
                else if (typeof x === 'string' && /OPENING|CLOSING|MID/i.test(x) && !kind) kind = x.trim().toUpperCase();
            }
        }
    }
    if (!rateDate) throw new Error('The BoU workbook does not say which date its rates are for.');

    // Every heading row: a "MIDDLE RATE" cell, with BUYING / SELLING
    // beside it, and the currency names in the "CURRENCY" column.
    const rates = {};
    const headers = [];
    for (const [ref, v] of cells) {
        if (typeof v === 'string' && /^\s*MIDDLE\s+RATE\s*$/i.test(v)) headers.push(ref);
    }
    if (headers.length === 0) throw new Error('The BoU workbook has no "MIDDLE RATE" column — its layout has changed.');
    for (const h of headers) {
        const hr = rowOf(h);
        const mc = colNum(colOf(h));
        let bc = null; let sc = null; let nameCol = null;
        for (let c = mc - 4; c <= mc + 3; c++) {
            if (c < 1) continue;
            const t = cells.get(`${colName(c)}${hr}`);
            if (typeof t !== 'string') continue;
            if (/BUYING\s+RATE/i.test(t)) bc = c;
            else if (/SELLING\s+RATE/i.test(t)) sc = c;
            else if (/^\s*CURRENCY\s*$/i.test(t)) nameCol = c;
        }
        if (!nameCol) continue;
        for (let r = hr + 1; r <= hr + 80; r++) {
            const label = cells.get(`${colName(nameCol)}${r}`);
            if (typeof label !== 'string') continue;
            const code = currencyOfLabel(label);
            const middle = cells.get(`${colName(mc)}${r}`);
            if (!code || code === 'UGX' || typeof middle !== 'number' || !(middle > 0)) continue;
            if (rates[code]) continue; // the main table wins over the COMESA list
            rates[code] = {
                middle,
                buying: bc && typeof cells.get(`${colName(bc)}${r}`) === 'number' ? cells.get(`${colName(bc)}${r}`) : null,
                selling: sc && typeof cells.get(`${colName(sc)}${r}`) === 'number' ? cells.get(`${colName(sc)}${r}`) : null,
                label: label.trim(),
            };
        }
    }
    if (!rates.USD && !rates.EUR) throw new Error('The BoU workbook was read but no US dollar or euro rate was found — its layout has changed.');
    return { rateDate, kind: kind || 'OPENING', rates };
};

// ------------------------------------------------------------
// v1.87.1 — the daily rate card ("Daily Exchange Rate Cards_Website.xlsx")
// ------------------------------------------------------------
const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
    jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const SESSION_ORDER = ['OPENING', 'MIDDAY', 'CLOSING'];

/**
 * Read the rate card. Exported for the tests.
 *   → { rateDate, kind: 'OPENING' | 'MIDDAY' | 'CLOSING', rates: { EUR: { middle, buying, selling, label, session } … } }
 */
const parseRateCardWorkbook = (buf) => {
    const cells = readSheetCells(buf);
    // the date and the heading row: "Currency (26 October 2026)"
    let rateDate = null; let headRef = null;
    for (const [ref, v] of cells) {
        if (typeof v !== 'string') continue;
        const m = /currency\s*\(\s*(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\.?,?\s+(\d{4})\s*\)/i.exec(v);
        if (m && MONTHS[m[2].toLowerCase()]) {
            const mm = MONTHS[m[2].toLowerCase()];
            rateDate = `${m[3]}-${String(mm).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
            headRef = ref;
            break;
        }
    }
    if (!rateDate) throw new Error('The BoU rate card does not say which date its rates are for ("Currency (<date>)" heading not found).');
    const hr = rowOf(headRef); const nameCol = colNum(colOf(headRef));
    let mc = null; let bc = null; let sc = null;
    for (let c = nameCol + 1; c <= nameCol + 8; c++) {
        const t = cells.get(`${colName(c)}${hr}`);
        if (typeof t !== 'string') continue;
        if (/mid/i.test(t)) mc = c; else if (/buy/i.test(t)) bc = c; else if (/sell/i.test(t)) sc = c;
    }
    if (!mc) throw new Error('The BoU rate card has no "Mid Rate" column — its layout has changed.');
    const found = {}; // code → { OPENING: {…}, MIDDAY: {…}, … }
    for (let r = hr + 1; r <= hr + 200; r++) {
        const label = cells.get(`${colName(nameCol)}${r}`);
        if (typeof label !== 'string') continue;
        const m = /^\s*([A-Z]{3})\s*\(\s*(opening|midday|mid-day|closing)\s*\)/i.exec(label);
        if (!m) continue;
        const code = m[1].toUpperCase();
        const session = /open/i.test(m[2]) ? 'OPENING' : /clos/i.test(m[2]) ? 'CLOSING' : 'MIDDAY';
        const middle = cells.get(`${colName(mc)}${r}`);
        if (code === 'UGX' || typeof middle !== 'number' || !(middle > 0)) continue;
        const num = (c) => (c && typeof cells.get(`${colName(c)}${r}`) === 'number' ? cells.get(`${colName(c)}${r}`) : null);
        (found[code] = found[code] || {})[session] = {
            middle: Math.round(middle * 1e6) / 1e6,
            buying: num(bc) === null ? null : Math.round(num(bc) * 1e6) / 1e6,
            selling: num(sc) === null ? null : Math.round(num(sc) * 1e6) / 1e6,
            label: label.trim(),
            session,
        };
    }
    const rates = {};
    for (const [code, bySession] of Object.entries(found)) {
        const pick = SESSION_ORDER.find(x => bySession[x]);
        if (pick) rates[code] = bySession[pick];
    }
    if (!rates.USD && !rates.EUR) throw new Error('The BoU rate card was read but no US dollar or euro rate was found — its layout has changed.');
    const kind = (rates.EUR || rates.USD).session;
    return { rateDate, kind, rates };
};

const findRateCardFile = async ({ patient = true } = {}) => {
    const url = `${BOU_FILES_API}?filters[name][$containsi]=${encodeURIComponent(BOU_RATE_CARD_NAME)}`
        + `&sort=createdAt:desc&pagination[limit]=5&t=${Date.now()}`;
    const { res } = await fetchWithRetry(url, { headers: { Accept: 'application/json' }, cache: 'no-store' }, { patient });
    const body = await res.json();
    const list = Array.isArray(body) ? body : (Array.isArray(body?.data) ? body.data : []);
    const f = list
        .filter(x => x && /\.xlsx$/i.test(String(x.url || '')))
        .sort((a, b) => String(b.createdAt || b.updatedAt || '').localeCompare(String(a.createdAt || a.updatedAt || '')))[0];
    if (!f) throw new Error('BoU\'s file list has no daily exchange-rate card');
    return { url: new URL(f.url, BOU_SITE).href, updatedAt: f.updatedAt || f.createdAt || null, name: f.name || 'Daily Exchange Rate Cards.xlsx' };
};

const downloadXlsx = async (url, { patient }) => {
    const { res } = await fetchWithRetry(`${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`, { cache: 'no-store' }, { patient });
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_FILE_BYTES) throw new Error('The BoU rates file is unexpectedly large — not read.');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_FILE_BYTES) throw new Error('The BoU rates file is unexpectedly large — not read.');
    return { buf, lastModified: res.headers.get('last-modified') };
};

const fetchBouRateCard = async ({ patient = true } = {}) => {
    const file = await findRateCardFile({ patient });
    let got;
    try { got = await downloadXlsx(file.url, { patient }); } catch (err) {
        throw new Error(`The BoU daily rate card could not be downloaded (${err.message}) — ${file.url}`);
    }
    const parsed = parseRateCardWorkbook(got.buf);
    return { ...parsed, source: 'BOU', fileUrl: file.url, fileName: file.name, fileUpdatedAt: file.updatedAt || got.lastModified || null };
};

// v1.87.1 — the rate card first, the old OPENING RATES workbook as well
// when the card cannot be read; the newer table wins. When both fail the
// error says what happened to each.
const fetchBouOpeningRates = async ({ patient = true } = {}) => {
    let card = null; let cardError = null;
    try { card = await fetchBouRateCard({ patient }); } catch (err) { cardError = err.message; }
    if (card) return card;
    try {
        const old = await fetchBouOldWorkbook({ patient });
        return { ...old, note: `daily rate card not read: ${cardError}` };
    } catch (err) {
        throw new Error(`Daily rate card: ${cardError}. Old OPENING RATES workbook: ${err.message}`);
    }
};

// patient: true for the scheduled checks (retries minutes apart), false
// for "Check BoU now" (retries seconds apart).
const fetchBouOldWorkbook = async ({ patient = true } = {}) => {
    const file = await findOpeningRatesFile({ patient });
    // where the address came from — tells an outage apart from a moved file
    const whereFrom = file.discovered
        ? `address ${file.url}, as listed on BoU's exchange-rates page`
        : `last known address ${file.url}, because BoU's exchange-rates page could not be read (${file.why || 'unknown reason'})`;
    let res;
    try {
        ({ res } = await fetchWithRetry(`${file.url}${file.url.includes('?') ? '&' : '?'}t=${Date.now()}`, { cache: 'no-store' }, { patient }));
    } catch (err) {
        throw new Error(`The BoU rates file could not be downloaded (${err.message}). Tried the ${whereFrom}.`);
    }
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_FILE_BYTES) throw new Error('The BoU rates file is unexpectedly large — not read.');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_FILE_BYTES) throw new Error('The BoU rates file is unexpectedly large — not read.');
    const parsed = parseOpeningRatesWorkbook(buf);
    return {
        ...parsed,
        source: 'BOU',
        fileUrl: file.url,
        fileName: file.name,
        fileUpdatedAt: file.updatedAt || res.headers.get('last-modified') || null,
    };
};

// ------------------------------------------------------------
// AllRatesToday — optional, the same BoU table through a keyed API.
// ------------------------------------------------------------
const allRatesKey = () => (process.env.BOU_RATES_API_KEY || '').trim();

const fetchAllRatesToday = async () => {
    const key = allRatesKey();
    if (!key) return null;
    const res = await fetchWithTimeout(ALLRATES_URL, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`AllRatesToday answered with status ${res.status}${res.status === 401 ? ' — check BOU_RATES_API_KEY' : ''}.`);
    const json = await res.json();
    const body = json?.data || json;
    const rateDate = String(body?.rate_date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rateDate)) throw new Error('AllRatesToday did not say which date its rates are for.');
    const rates = {};
    for (const r of body?.rates || []) {
        const base = String(r.base || '').toUpperCase();
        const quote = String(r.quote || '').toUpperCase();
        const value = Number(r.value);
        if (!(value > 0)) continue;
        // UGX per one unit of the other currency
        let code = null; let ugxPerUnit = null;
        if (quote === 'UGX' && base !== 'UGX') { code = base; ugxPerUnit = value; }
        else if (base === 'UGX' && quote !== 'UGX') { code = quote; ugxPerUnit = 1 / value; }
        if (!code) continue;
        const slot = rates[code] || (rates[code] = { middle: null, buying: null, selling: null, label: `${code}/UGX` });
        const type = String(r.type || '').toLowerCase();
        if (type === 'reference' || type === 'middle' || type === 'mid') slot.middle = ugxPerUnit;
        else if (type === 'buy' || type === 'buying') slot.buying = ugxPerUnit;
        else if (type === 'sell' || type === 'selling') slot.selling = ugxPerUnit;
    }
    for (const code of Object.keys(rates)) if (!(rates[code].middle > 0)) delete rates[code];
    return { rateDate, kind: 'OPENING', rates, source: 'ALLRATESTODAY', fileUrl: ALLRATES_URL, fileName: null, fileUpdatedAt: null };
};

module.exports = {
    fetchBouOpeningRates,
    fetchAllRatesToday,
    parseOpeningRatesWorkbook,
    parseRateCardWorkbook,
    currencyOfLabel,
    allRatesConfigured: () => !!allRatesKey(),
};
