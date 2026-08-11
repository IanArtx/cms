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

        // Yellow — in progress/pending
        PENDING:              'badge-yellow',
        AWAITING_APPROVAL:    'badge-yellow',
        PARTIALLY_RECEIVED:   'badge-yellow',
        PARTIALLY_REPAID:     'badge-yellow',
        PENDING_APPROVAL:     'badge-yellow',
        IN_PROGRESS:          'badge-yellow',
        DRAFT:                'badge-yellow',
        ON_HOLD:              'badge-yellow',

        // Red — negative/failed
        OVERDUE:     'badge-red',
        REJECTED:    'badge-red',
        CANCELLED:   'badge-red',
        DEFAULTED:   'badge-red',
        FAILED:      'badge-red',
        MISSED:      'badge-red',
        REVERSED:    'badge-red',

        // Blue — informational
        SUPERSEDED:  'badge-blue',
        ARCHIVED:    'badge-blue',
        CLOSED:      'badge-blue',
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
// GET PHOTO URL
// Turns a stored users.photo_path (e.g. "uploads/profiles/xxx.jpg",
// as saved by the backend's multer upload) into a full URL the
// browser can load, using the same origin as the API but WITHOUT
// the trailing /api — that's where server.js serves the static
// /uploads mount from.
// ============================================================
export const getPhotoUrl = (photoPath) => {
    if (!photoPath) return null;
    const apiBase = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';
    const origin = apiBase.replace(/\/api\/?$/, '');
    const cleanPath = String(photoPath).replace(/\\/g, '/').replace(/^\.?\/?/, '');
    return `${origin}/${cleanPath}`;
};

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