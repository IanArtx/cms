// ============================================================
// HELPER UTILITIES
// Shared formatting and utility functions used across
// the entire frontend.
// ============================================================

import { format, formatDistanceToNow, parseISO } from 'date-fns';

// ============================================================
// DATE FORMATTING
// ============================================================
export const formatDate = (date) => {
    if (!date) return '—';
    try {
        return format(parseISO(date), 'dd MMM yyyy');
    } catch {
        return '—';
    }
};

export const formatDateTime = (date) => {
    if (!date) return '—';
    try {
        return format(parseISO(date), 'dd MMM yyyy, HH:mm');
    } catch {
        return '—';
    }
};

export const formatRelativeTime = (date) => {
    if (!date) return '—';
    try {
        return formatDistanceToNow(parseISO(date), { addSuffix: true });
    } catch {
        return '—';
    }
};

// ============================================================
// CURRENCY FORMATTING
// ============================================================
export const formatCurrency = (amount, currencyCode = 'EUR', symbol = null) => {
    if (amount === null || amount === undefined) return '—';
    const num = parseFloat(amount);
    if (isNaN(num)) return '—';

    const formatted = num.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });

    // Use currency code instead of symbol to avoid encoding issues
    return `${currencyCode} ${formatted}`;
};

export const formatNumber = (num) => {
    if (num === null || num === undefined) return '—';
    return parseFloat(num).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
};

// ============================================================
// STATUS BADGE COLOURS
// Returns the correct badge class based on status string
// ============================================================
export const getStatusBadgeClass = (status) => {
    if (!status) return 'badge-gray';

    const statusMap = {
        // Green — positive/complete
        ACTIVE:           'badge-green',
        APPROVED:         'badge-green',
        POSTED:           'badge-green',
        COMPLETED:        'badge-green',
        FULLY_RECEIVED:   'badge-green',
        FULLY_REPAID:     'badge-green',
        FINAL:            'badge-green',
        MET:              'badge-green',
        SENT:             'badge-green',
        SUCCESS:          'badge-green',
        PAID:             'badge-green',
        ON_TRACK:         'badge-green',
        TARGET_REACHED:   'badge-green',
        FINAL_APPROVED:   'badge-green',
        // Capital Goal Calls (v1.43.0) — a fully-settled pledge, and a
        // monthly call whose target has been fully met.
        FULFILLED:        'badge-green',

        // Violet — waiting for someone's approval (v1.71.0: was yellow;
        // the Harbour chip colours give "awaiting approval" its own colour)
        PENDING:              'badge-purple',
        AWAITING_APPROVAL:    'badge-purple',
        PENDING_APPROVAL:     'badge-purple',

        // Amber — in progress / partly done
        PARTIALLY_RECEIVED:   'badge-yellow',
        PARTIALLY_REPAID:     'badge-yellow',
        IN_PROGRESS:          'badge-yellow',
        DRAFT:                'badge-yellow',
        ON_HOLD:              'badge-yellow',
        PENDING_ACK:          'badge-purple',
        PENDING_TERMINATION:  'badge-yellow',
        // Capital Goal Calls (v1.43.0)
        PLEDGED:              'badge-yellow',
        PARTIAL:              'badge-yellow',
        PARTIALLY_PAID:       'badge-yellow',
        ITERATION_1:          'badge-yellow',
        ITERATION_2:          'badge-yellow',

        // Red — negative/failed
        UNPAID:      'badge-red',
        OVERDUE:     'badge-red',
        REJECTED:    'badge-red',
        DEFAULTED:   'badge-red',
        FAILED:      'badge-red',
        MISSED:      'badge-red',
        BEHIND:      'badge-red',
        DISPUTED:    'badge-red',

        // Gray — finished / no longer in effect (v1.71.0: reversed and
        // cancelled were red, closed/superseded/archived were blue)
        CANCELLED:    'badge-gray',
        REVERSED:     'badge-gray',
        SUPERSEDED:   'badge-gray',
        ARCHIVED:     'badge-gray',
        CLOSED:       'badge-gray',

        // Blue — informational
        ACKNOWLEDGED: 'badge-blue',
        TERMINATED:   'badge-blue',
        // Service Fees (v1.54.0) — a month waived out of the agreement
        // entirely: deliberately blue/informational rather than red
        // (not a failure to pay) or green (nothing was actually paid).
        EXCLUDED:     'badge-blue',
        // Capital Goal Calls (v1.43.0) — a shareholder hasn't pledged
        // anything yet (deliberately neutral, not red — not pledging at
        // all is never fined and shouldn't visually read as a failure).
        NOT_RESPONDED: 'badge-gray',
    };

    return statusMap[status.toUpperCase()] || 'badge-gray';
};

// ============================================================
// INFLOW TYPE LABELS
// Human-readable labels for transaction inflow types
// ============================================================
export const getInflowTypeLabel = (inflowType) => {
    const labels = {
        CONTRIBUTION:       'Capital Contribution',
        GRANT:              'Grant Disbursement',
        LOAN_RECEIVED:      'Loan Received',
        LOAN_REPAYMENT_IN:  'Loan Repayment In',
        INTEREST_IN:        'Interest Received',
        INVESTMENT_RETURN:  'Investment Return',
        TRANSFER_IN:        'Transfer In',
        OTHER_INCOME:       'Other Income',
        TRANSFER_OUT:       'Transfer Out',
        LOAN_DISBURSED:     'Loan Disbursed',
        LOAN_REPAYMENT_OUT: 'Loan Repayment Out',
        INTEREST_OUT:       'Interest Paid',
        EXPENSE:            'Expense',
        GRANT_REFUND:       'Grant Refund',
    };
    return labels[inflowType] || inflowType;
};

// ============================================================
// TRUNCATE TEXT
// ============================================================
export const truncate = (text, length = 50) => {
    if (!text) return '—';
    return text.length > length ? `${text.substring(0, length)}...` : text;
};

// ============================================================
// GET INITIALS
// Used for avatar placeholders
// ============================================================
export const getInitials = (firstName, lastName) => {
    if (!firstName && !lastName) return '?';
    return `${(firstName || '')[0]}${(lastName || '')[0]}`.toUpperCase();
};

// ============================================================
// GET UPLOAD URL (v1.62.1)
// Turns ANY backend-stored relative file path — profile photos,
// signature snapshots, receipts, branding assets, etc, as returned
// by storageService.js whether the underlying file lives on
// Cloudflare R2 or local disk — into a full URL the browser can
// load, using the same origin as the API but WITHOUT the trailing
// /api. That's where server.js serves the static /uploads mount
// from; a bare relative path resolves against the FRONTEND's own
// origin instead and 404s, which is what was happening to signature
// images (getPhotoUrl below already did this for photos, which is
// why those "worked perfectly" while signatures didn't).
// ============================================================
export const getUploadUrl = (path) => {
    if (!path) return null;
    if (/^https?:\/\//i.test(path)) return path; // already absolute — leave it
    const apiBase = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';
    const origin = apiBase.replace(/\/api\/?$/, '');
    const cleanPath = String(path).replace(/\\/g, '/').replace(/^\.?\/?/, '');
    return `${origin}/${cleanPath}`;
};

// Kept as a thin alias — existing call sites (Avatar.jsx) read fine as
// "photo url" even though the underlying resolver is now generic.
export const getPhotoUrl = (photoPath) => getUploadUrl(photoPath);

// ============================================================
// FORMAT FILE SIZE
// ============================================================
export const formatFileSize = (bytes) => {
    if (!bytes) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

// ============================================================
// ERROR MESSAGE EXTRACTOR
// Pulls the most useful error message from an axios error
// ============================================================
export const getErrorMessage = (error) => {
    if (!error) return 'An unexpected error occurred';

    // Validation errors with details array
    if (error.response?.data?.details?.length > 0) {
        return error.response.data.details
            .map(d => d.message)
            .join(', ');
    }

    // API error message
    if (error.response?.data?.message) {
        return error.response.data.message;
    }

    // Network error
    if (error.message) return error.message;

    return 'An unexpected error occurred';
};

// ============================================================
// BUILD QUERY STRING
// Converts an object to a query string, skipping empty values
// ============================================================
export const buildQueryString = (params) => {
    return Object.entries(params)
        .filter(([, value]) => value !== null && value !== undefined && value !== '')
        .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
        .join('&');
};