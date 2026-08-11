// ============================================================
// FISCAL SERVICE (v1.25.0, Section 4.10 addendum)
// Looks up which Admin-configured fiscal quarter (fiscal_quarters)
// a given date falls into — used by Reports/documents to show a
// company-defined financial-year label (e.g. "FY2025/26 — Q1")
// alongside the plain calendar month/year the system otherwise uses
// everywhere. Purely a lookup — this never changes what any figure
// actually is, only how a date is labelled.
// ============================================================

const { query } = require('../config/database');

// ============================================================
// GET THE CONFIGURED QUARTER a specific date falls into, if any.
// If quarters overlap (an Admin's own configuration mistake — not
// prevented at the database level, since fully custom ranges were
// deliberately chosen over rigid non-overlapping enforcement), the
// most recently-starting match wins.
// ============================================================
const getQuarterForDate = async (date) => {
    const result = await query(`
        SELECT id, label, start_date, end_date
        FROM   fiscal_quarters
        WHERE  start_date <= $1 AND end_date >= $1
        ORDER  BY start_date DESC
        LIMIT  1
    `, [date]);
    return result.rows[0] || null;
};

module.exports = { getQuarterForDate };
