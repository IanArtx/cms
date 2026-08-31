// ============================================================
// DATE UTILITIES (v1.43.0)
//
// Shared helpers for normalizing dates that may arrive as either a
// plain "YYYY-MM-DD" string (e.g. from a request body) or a native JS
// Date object (node-postgres returns a DATE column as a Date object,
// not a string). See the v1.42.1 postmortem in bondSchedule.js for
// the exact bug this exists to prevent everywhere else in the app:
// building `new Date(`${value}T00:00:00Z`)` straight from an
// un-normalized Date object silently produces an Invalid Date, and
// every comparison against an Invalid Date evaluates to false —
// masking real bugs instead of throwing. normalizeDateInput() must be
// the first thing done to any date value before it's compared,
// added to, or used in a template literal.
// ============================================================

function normalizeDateInput(value) {
    if (value === null || value === undefined || value === '') return null;
    if (value instanceof Date) {
        return isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
    }
    return String(value).slice(0, 10);
}

function toISODate(date) {
    return date.toISOString().slice(0, 10);
}

function toDateObject(value) {
    const normalized = normalizeDateInput(value);
    const d = new Date(`${normalized}T00:00:00Z`);
    if (isNaN(d.getTime())) {
        throw new Error(`Could not parse a valid date from: ${value}`);
    }
    return d;
}

function addMonthsUTC(dateInput, months) {
    const d = toDateObject(dateInput);
    d.setUTCMonth(d.getUTCMonth() + months);
    return d;
}

function addDaysUTC(dateInput, days) {
    const d = toDateObject(dateInput);
    d.setUTCDate(d.getUTCDate() + days);
    return d;
}

// Number of calendar months from startDate's month through endDate's
// month, inclusive — e.g. 2027-01-15 to 2027-12-01 = 12.
function monthsBetweenInclusive(startDate, endDate) {
    const start = toDateObject(startDate);
    const end = toDateObject(endDate);
    return (end.getUTCFullYear() - start.getUTCFullYear()) * 12
        + (end.getUTCMonth() - start.getUTCMonth()) + 1;
}

// Returns 'YYYY-MM' for the Nth month (0-indexed) after startDate's
// own month.
function periodAtOffset(startDate, offset) {
    const d = toDateObject(startDate);
    d.setUTCMonth(d.getUTCMonth() + offset);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Builds an actual DATE (YYYY-MM-DD) for "day N of period P
// (YYYY-MM)", clamped to the real last day of that month if N
// exceeds it.
function dateInPeriod(period, day) {
    const [year, month] = period.split('-').map(Number);
    const lastDayOfMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const clampedDay = Math.min(day, lastDayOfMonth);
    return `${period}-${String(clampedDay).padStart(2, '0')}`;
}

// Whole days between two dates (b - a); positive means b is after a.
function daysBetween(a, b) {
    return Math.round((toDateObject(b) - toDateObject(a)) / 86400000);
}

module.exports = {
    normalizeDateInput,
    toISODate,
    toDateObject,
    addMonthsUTC,
    addDaysUTC,
    monthsBetweenInclusive,
    periodAtOffset,
    dateInPeriod,
    daysBetween,
};
