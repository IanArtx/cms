// ============================================================
// CSV EXPORT HELPERS (v1.50.0)
// A small, dependency-free RFC4180-ish CSV builder — this system's
// exports are always simple flat rows (transactions, transfers),
// nothing nested, so a real CSV library would be one more dependency
// for something a handful of lines already covers correctly.
//
// Usage:
//   const csv = rowsToCsv(
//       [{ key: 'reference_code', header: 'Reference' }, ...],
//       rows,
//   );
//   sendCsv(res, 'transactions-2026-09.csv', csv);
// ============================================================

// ------------------------------------------------------------
// Escapes a single value per RFC4180: wrap in quotes and double up
// any embedded quotes whenever the value contains a comma, quote,
// or newline (CR or LF) — the three characters that would otherwise
// break column alignment or truncate a row when opened in Excel/
// Google Sheets/LibreOffice.
// ------------------------------------------------------------
const escapeCsvValue = (value) => {
    if (value === null || value === undefined) return '';
    const str = String(value);
    if (/[",\r\n]/.test(str)) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
};

// ------------------------------------------------------------
// ROWS TO CSV
// `columns` — [{ key, header, format }], where `format` is an
// optional (value, row) => string transform (e.g. for dates or
// signed amounts); `key` supports dot-paths are NOT supported on
// purpose (keeps this a plain-object helper, not a query language) —
// pass already-flattened row objects.
// ------------------------------------------------------------
const rowsToCsv = (columns, rows) => {
    const headerLine = columns.map(c => escapeCsvValue(c.header)).join(',');
    const lines = rows.map(row => columns.map(c => {
        const raw = c.format ? c.format(row[c.key], row) : row[c.key];
        return escapeCsvValue(raw);
    }).join(','));
    // Leading ﻿ (UTF-8 BOM) so Excel on Windows doesn't mangle
    // any non-ASCII character (member names, notes) into garbled text —
    // a well-known Excel-specific quirk with plain UTF-8 CSVs.
    return '﻿' + [headerLine, ...lines].join('\r\n') + '\r\n';
};

// ------------------------------------------------------------
// SEND CSV — sets the two headers a browser needs to treat the
// response as a downloadable file rather than inline text/plain.
// ------------------------------------------------------------
const sendCsv = (res, filename, csvString) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(csvString);
};

module.exports = { rowsToCsv, sendCsv, escapeCsvValue };
