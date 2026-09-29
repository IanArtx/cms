// ============================================================
// EXPORT UTILITIES
// Renders data into styled HTML documents with company
// letterhead and opens the print dialog.
//
// Three modes:
//   1. Single record  — one row exported as a full document
//   2. Filtered set   — current table view exported as a list
//   3. Full export    — all records exported as a list
// ============================================================

// These start from env vars / the static logo file as a fallback, but
// are meant to be overwritten at runtime by setBranding() once the app
// loads the company's actual settings from the database (Settings >
// Company). Using `let` instead of `const` is what makes that possible
// — every template function below reads these at CALL time, not at
// import time, so a branding change takes effect on the very next
// document generated without needing a rebuild or page reload.
let COMPANY_NAME     = process.env.REACT_APP_COMPANY_NAME    || 'INVESTABO GLOBAL INVESTMENTS LIMITED';
let COMPANY_ADDRESS  = process.env.REACT_APP_COMPANY_ADDRESS || '';
let COMPANY_INITIALS = process.env.REACT_APP_COMPANY_INITIALS || 'CMS';
// Same file the sidebar uses (public/logo.png) — if it's missing or
// empty, the onerror handler below hides it and the text company name
// alone carries the letterhead instead of showing a broken-image icon.
let COMPANY_LOGO_URL = process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL}/logo.png` : '/logo.png';
let PRIMARY_COLOR    = '#1e3a5f';
let ACCENT_COLOR     = '#c9a227';

// ============================================================
// SET BRANDING (called once by BrandingContext after it loads the
// company's settings from GET /api/settings/company)
// ============================================================
export const setBranding = ({ name, address, logoUrl, primaryColor, accentColor } = {}) => {
    if (name)         COMPANY_NAME     = name;
    if (address !== undefined) COMPANY_ADDRESS = address || '';
    if (logoUrl)      COMPANY_LOGO_URL = logoUrl;
    if (primaryColor) PRIMARY_COLOR    = primaryColor;
    if (accentColor)  ACCENT_COLOR     = accentColor;
};

// ============================================================
// RESOLVE UPLOAD URL (v1.62.1)
// Backend-stored file paths (e.g. signature snapshots:
// "/uploads/signature-snapshots/xxx.png") are relative to the API's
// OWN origin, not the frontend's — server.js serves the /uploads
// mount there, whether the underlying file lives on Cloudflare R2 or
// local disk (see storageService.js). Documents built by this file
// are opened in a standalone print/preview window with no <base>
// pointing at the API, so a bare relative <img src> 404s there even
// though the identical path works fine for an <img> rendered inside
// the main React app.
//
// This mirrors helpers.js's getPhotoUrl() (used for profile photos,
// which is why "profile pictures work perfectly") and the same
// origin-stripping BrandingContext.js already applies to the company
// logo before handing it to setBranding() above — signatures were
// the one path through this file that skipped that step.
// ============================================================
const resolveUploadUrl = (path) => {
    if (!path) return null;
    if (/^https?:\/\//i.test(path)) return path; // already absolute — leave it
    const apiBase = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';
    const origin = apiBase.replace(/\/api\/?$/, '');
    const cleanPath = String(path).replace(/\\/g, '/').replace(/^\.?\/?/, '');
    return `${origin}/${cleanPath}`;
};

// ============================================================
// BASE STYLES
// Shared CSS injected into every document
// ============================================================
// A function, not a plain string — so it always reflects the CURRENT
// PRIMARY_COLOR at the moment a document is generated (see setBranding
// above), rather than whatever color was in effect when this module
// first loaded.
const getBaseStyles = () => `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
        font-family: 'Arial', sans-serif;
        font-size: 12px;
        color: #1a1a1a;
        background: white;
        padding: 0;
    }
    .page {
        max-width: 900px;
        margin: 0 auto;
        padding: 40px;
        min-height: 100vh;
    }

    /* LETTERHEAD */
    .letterhead {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        padding-bottom: 20px;
        border-bottom: 3px solid ${PRIMARY_COLOR};
        margin-bottom: 28px;
    }
    .letterhead-left {
        display: flex;
        align-items: center;
        gap: 12px;
    }
    .company-logo {
        height: 48px;
        width: 48px;
        object-fit: contain;
        flex-shrink: 0;
    }
    .company-name {
        font-size: 18px;
        font-weight: 800;
        color: ${PRIMARY_COLOR};
        letter-spacing: 0.5px;
        margin-bottom: 4px;
    }
    .company-address {
        font-size: 10px;
        color: #6b7280;
        line-height: 1.5;
    }
    .letterhead-right {
        text-align: right;
    }
    .doc-type {
        font-size: 11px;
        font-weight: 600;
        color: #6b7280;
        text-transform: uppercase;
        letter-spacing: 1px;
    }
    .doc-ref {
        font-size: 13px;
        font-weight: 700;
        color: ${PRIMARY_COLOR};
        font-family: monospace;
        margin-top: 4px;
    }
    .doc-date {
        font-size: 10px;
        color: #9ca3af;
        margin-top: 4px;
    }

    /* DOCUMENT TITLE */
    .doc-title {
        font-size: 22px;
        font-weight: 800;
        color: ${PRIMARY_COLOR};
        margin-bottom: 6px;
    }
    .doc-subtitle {
        font-size: 12px;
        color: #6b7280;
        margin-bottom: 24px;
    }

    /* META BOX */
    .meta-box {
        background: #f8fafc;
        border: 1px solid #e5e7eb;
        border-radius: 8px;
        padding: 16px 20px;
        margin-bottom: 24px;
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 12px;
    }
    .meta-box.cols-3 {
        grid-template-columns: repeat(3, 1fr);
    }
    .meta-box.cols-4 {
        grid-template-columns: repeat(4, 1fr);
    }
    .meta-item {}
    .meta-label {
        font-size: 9px;
        font-weight: 700;
        color: #9ca3af;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 3px;
    }
    .meta-value {
        font-size: 12px;
        font-weight: 600;
        color: #1a1a1a;
    }
    .meta-value.large {
        font-size: 16px;
        color: ${PRIMARY_COLOR};
    }
    .meta-value.green { color: #16a34a; }
    .meta-value.red   { color: #dc2626; }
    .meta-value.blue  { color: #2563eb; }

    /* SECTION */
    .section {
        margin-bottom: 24px;
    }
    .section-title {
        font-size: 11px;
        font-weight: 700;
        color: ${PRIMARY_COLOR};
        text-transform: uppercase;
        letter-spacing: 1px;
        padding-bottom: 8px;
        border-bottom: 2px solid #e5e7eb;
        margin-bottom: 14px;
    }

    /* TABLE */
    table {
        width: 100%;
        border-collapse: collapse;
        font-size: 11px;
    }
    thead tr {
        background: ${PRIMARY_COLOR};
        color: white;
    }
    thead th {
        padding: 8px 10px;
        text-align: left;
        font-weight: 600;
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
    }
    tbody tr {
        border-bottom: 1px solid #f3f4f6;
    }
    tbody tr:nth-child(even) {
        background: #f9fafb;
    }
    tbody td {
        padding: 8px 10px;
        vertical-align: top;
    }
    .text-right { text-align: right; }
    .text-center { text-align: center; }
    .font-bold { font-weight: 700; }
    .font-mono { font-family: monospace; }
    .text-green { color: #16a34a; }
    .text-red   { color: #dc2626; }
    .text-blue  { color: #2563eb; }
    .text-gray  { color: #6b7280; }
    .total-row td {
        background: #f0f4f8;
        font-weight: 700;
        border-top: 2px solid ${PRIMARY_COLOR};
    }

    /* STATUS BADGE */
    .badge {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 20px;
        font-size: 9px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.5px;
    }
    .badge-green  { background: #dcfce7; color: #16a34a; }
    .badge-red    { background: #fee2e2; color: #dc2626; }
    .badge-blue   { background: #dbeafe; color: #2563eb; }
    .badge-yellow { background: #fef9c3; color: #a16207; }
    .badge-gray   { background: #f3f4f6; color: #6b7280; }

    /* FOOTER */
    .footer {
        margin-top: 40px;
        padding-top: 16px;
        border-top: 1px solid #e5e7eb;
        display: flex;
        justify-content: space-between;
        font-size: 9px;
        color: #9ca3af;
    }
    .confidential {
        text-align: center;
        margin-top: 10px;
        font-size: 9px;
        color: #9ca3af;
        font-style: italic;
    }
    .signature-section {
        margin-top: 48px;
        display: flex;
        gap: 48px;
    }
    .signature-block {
        flex: 1;
        border-top: 1px solid #374151;
        padding-top: 8px;
        font-size: 10px;
        color: #374151;
    }

    /* v1.24.0 — company stamps/seals (Section 4.30). Wrap
       .signature-section in .stamp-overlay-wrap to position a stamp
       image over/near it — never shown on a draft, only once
       data.stamps is actually populated by the caller. */
    .stamp-overlay-wrap { position: relative; }
    .stamp-overlay {
        position: absolute; right: 4%; bottom: -14px;
        max-height: 100px; max-width: 140px; opacity: 0.92;
        pointer-events: none;
    }

    /* DOCUMENT TRAIL — who prepared/approved/was involved, and when */
    .trail-role {
        font-weight: 700;
        color: ${ACCENT_COLOR};
        white-space: nowrap;
    }

    @media print {
        body { padding: 0; }
        .page { padding: 20px; }
        .no-print { display: none !important; }
    }
`;

// ============================================================
// STATUS BADGE HELPER
// ============================================================
const badge = (status) => {
    const map = {
        ACTIVE:            'badge-green',
        APPROVED:          'badge-green',
        POSTED:            'badge-green',
        PAID:              'badge-green',
        COMPLETED:         'badge-green',
        WITHDRAWN:         'badge-green',
        PENDING:           'badge-yellow',
        AWAITING_APPROVAL: 'badge-yellow',
        DRAFT:             'badge-blue',
        FINAL:             'badge-blue',
        OVERDUE:           'badge-red',
        REJECTED:          'badge-red',
        CANCELLED:         'badge-red',
        DEFAULTED:         'badge-red',
    };
    const cls = map[status] || 'badge-gray';
    return `<span class="badge ${cls}">${status?.replace(/_/g, ' ') || '—'}</span>`;
};

// ============================================================
// FORMAT HELPERS
// ============================================================
const fmt = {
    // v1.62.1 — guards against "Invalid Date" ever being printed on a
    // generated document. Most callers pass a proper ISO timestamp, but
    // documents GENERATED BEFORE the v1.57.2 fix had their template_data
    // saved with generated_date already run through toLocaleDateString('en-GB')
    // (e.g. "17/09/2026") — reopening one of those older saved documents
    // re-parses that display string with `new Date(...)`, which JS reads
    // as MM/DD/YYYY and rejects as invalid (day "17" isn't a valid month).
    // The v1.57.2 fix only stopped NEW documents from saving a bad value;
    // it can't retroactively repair ones already stored. Falling back to
    // '—' here — the same placeholder already used for a missing date —
    // is what actually stops the broken text from reaching the page,
    // for old documents and any other not-quite-parseable value alike.
    date: (d) => {
        if (!d) return '—';
        const parsed = new Date(d);
        return isNaN(parsed.getTime())
            ? '—'
            : parsed.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    },
    amount: (a) => a ? parseFloat(a).toLocaleString('en-GB', {
        minimumFractionDigits: 2, maximumFractionDigits: 2
    }) : '0.00',
    num: (n) => n ? parseFloat(n).toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—',
};

// ============================================================
// LETTERHEAD HTML
// The reference code is shown here ONCE, top-right — this is the
// single authoritative place a reader looks to identify the
// document. Individual template sections should avoid repeating
// it again in a subtitle or footer (see documentTrail()/footer()
// below) to keep the page from feeling cluttered with the same
// code printed three or four times.
// ============================================================
const letterhead = (docType, reference, date) => `
    <div class="letterhead">
        <div class="letterhead-left">
            <img class="company-logo" src="${COMPANY_LOGO_URL}" alt=""
                onerror="this.style.display='none'" />
            <div>
                <div class="company-name">${COMPANY_NAME}</div>
                <div class="company-address">${COMPANY_ADDRESS}</div>
            </div>
        </div>
        <div class="letterhead-right">
            <div class="doc-type">${docType}</div>
            <div class="doc-ref">${reference || ''}</div>
            <div class="doc-date">Generated: ${fmt.date(date || new Date())}</div>
        </div>
    </div>
`;

// ============================================================
// FOOTER HTML
// Deliberately does NOT repeat the reference code (already shown
// once in the letterhead) — just the company name and generation
// timestamp, so the page identifies itself without echoing the
// same code a third or fourth time.
// ============================================================
const footer = () => `
    <div class="footer">
        <span>${COMPANY_NAME}</span>
        <span>Generated: ${new Date().toLocaleDateString('en-GB')} at ${new Date().toLocaleTimeString('en-GB')}</span>
    </div>
    <div class="confidential">CONFIDENTIAL — For authorised members only</div>
`;

// ============================================================
// STAMP OVERLAY (v1.24.0, Section 4.30)
// Renders whichever company stamp(s) were actually applied to a
// fully approved/signed document, positioned over the signature
// area. `data.stamps` — an array of { name, file_path } — is only
// populated by the caller (DocumentsPage.openDocument) once the
// document is confirmed fully_signed, so a draft never shows one.
// Returns '' (nothing) when there's no stamp to show, so callers can
// unconditionally splice this into their signature-section markup.
// ============================================================
const stampOverlay = (data) => {
    if (!data?.stamps || data.stamps.length === 0) return '';
    // v1.62.1 — same relative-path-vs-origin issue as signatureBlock()
    // above: file_path is relative to the API's own origin, not
    // whatever origin this print/preview window is on.
    return data.stamps.map(stamp =>
        `<img class="stamp-overlay" src="${resolveUploadUrl(stamp.file_path)}" alt="${stamp.name || 'Company stamp'}" />`
    ).join('');
};

// ============================================================
// PERSON FIELD HELPERS (v1.45.0)
// Meeting Minutes / Agenda / Resolution now let a user pick a
// Chairperson/Secretary/attendee from a dropdown of system users
// (stored as `${key}_user_id` + `${key}_name`) or just type a free
// name (stored as the plain `${key}` string, same as before this
// version). Both shapes render identically here — the picker never
// changes what gets printed, only whether the named person also
// becomes a required digital signatory (see documentsController.js
// approveDocument / signatureService.ensurePersonSignatureSlots).
// personName() reads either shape; personListNames() does the same
// for a repeatable list field (attendees/present), which is either
// the old single free-text blob or an array of
// { user_id, name } / plain-string entries.
// ============================================================
const personName = (data, key) => data[`${key}_name`] || data[key] || '';

// ============================================================
// SIGNATURE BLOCK HELPER (v1.57.2)
// Previously every printed "Signature: ___ / Date: ___" pair was a
// hardcoded blank line, regardless of whether that person had
// actually signed — the saved signature image and signed date were
// never wired in. `data.signatures` — when present — is the array
// GET /documents/:id/signatures returns (signatureService.
// getSignatureStatus), attached by DocumentsPage.openDocument()
// before re-rendering a saved document; it's simply absent while
// previewing an unsaved draft (GenerateDocumentPage.handlePreview),
// which is exactly when there's nothing to show yet anyway.
// A slot is matched to a printed name by `positionTitle` (e.g.
// 'Chairman'/'Secretary') against that row's `role_name` — for a
// person-specific signatory, role_name IS the position_title (see
// getSignatureStatus), so this lines up directly with
// PERSON_SIGNATORY_FIELDS on the backend (documentsController.js).
// Falls back to the original blank lines whenever there's no match.
// ============================================================
const signatureBlock = (data, label, name, positionTitle) => {
    const slot = (data.signatures || []).find(s => s.role_name === positionTitle);
    const signed = slot?.status === 'SIGNED';
    const signatureLine = signed && slot.signature_url
        ? `<img src="${resolveUploadUrl(slot.signature_url)}" alt="Signature" style="height:32px;display:block;margin-top:2px;" />`
        : '_______________';
    const dateLine = signed && slot.signed_at ? fmt.date(slot.signed_at) : '_______________';
    return `
        <div class="signature-block">
            ${label}: ${name || '_______________'}<br>
            Signature: ${signatureLine}<br>
            Date: ${dateLine}
        </div>`;
};

const personListNames = (value) => {
    if (Array.isArray(value)) {
        return value
            .map(p => (typeof p === 'string' ? p : p?.name))
            .filter(Boolean)
            .join(', ');
    }
    return value || '';
};

// ============================================================
// DOCUMENT TRAIL
// Every document that's meant to be filed should say, at a
// glance, who prepared it, who approved/reviewed it, and anyone
// else formally involved — with their role on THIS document and
// the date they acted. Pass an array of
//   { role: 'Prepared By', name: '...', date: '...' }
// Entries with no name are skipped automatically, so it's safe
// to pass optional approver/reviewer fields that may be null.
// ============================================================
const documentTrail = (entries = []) => {
    const rows = entries.filter(e => e && e.name);
    if (rows.length === 0) return '';
    return `
    <div class="section">
        <div class="section-title">Document Trail</div>
        <table>
            <thead>
                <tr>
                    <th>Role</th>
                    <th>Name</th>
                    <th>Date</th>
                </tr>
            </thead>
            <tbody>
                ${rows.map(e => `
                <tr>
                    <td class="trail-role">${e.role}</td>
                    <td>${e.name}</td>
                    <td>${e.date ? fmt.date(e.date) : '—'}</td>
                </tr>`).join('')}
            </tbody>
        </table>
    </div>
`;
};

// ============================================================
// MAP A "tx_*"-PREFIXED ROW INTO transactionTemplate()'S SHAPE (v1.32.0)
// Self-service list endpoints that aren't themselves the Transactions
// ledger (side-fund/dues/me, savings/me, savings/handouts/me) return
// their linked transaction's own details as tx_-prefixed columns,
// specifically so a member without FINANCE_VIEW_ALL can still
// preview/print each one as a proper transaction statement — without
// a separate call to GET /transactions/:id, which they may not have
// permission for. Returns null when there's no linked transaction yet
// (e.g. an unpaid due, or a deposit still pending approval), so
// callers know to hide the preview button for that row.
// ============================================================
export const txFromRow = (row) => {
    if (!row || !row.tx_reference_code) return null;
    return {
        reference_code:   row.tx_reference_code,
        description:      row.tx_description,
        value_date:       row.tx_value_date,
        transaction_type: row.tx_transaction_type,
        amount:           row.tx_amount,
        currency_code:    row.tx_currency_code,
        account_name:     row.tx_account_name,
        category_name:    row.tx_category_name,
        balance_before:   row.tx_balance_before,
        balance_after:    row.tx_balance_after,
    };
};

// ============================================================
// TEMPLATE 1: TRANSACTION STATEMENT
// Single transaction or list of transactions
// ============================================================
export const transactionTemplate = (transactions, options = {}) => {
    const isSingle = !Array.isArray(transactions);
    const list     = isSingle ? [transactions] : transactions;
    const title    = isSingle
        ? 'Transaction Statement'
        : 'Transaction Ledger';
    const ref      = isSingle
        ? transactions.reference_code
        : `${options.accountName || 'All Accounts'} — ${options.period || ''}`;

    const totalCredit = list
        .filter(t => t.transaction_type === 'CREDIT' || t.transaction_type === 'REVERSAL_CREDIT')
        .reduce((s, t) => s + parseFloat(t.amount || 0), 0);
    const totalDebit = list
        .filter(t => t.transaction_type === 'DEBIT' || t.transaction_type === 'REVERSAL_DEBIT')
        .reduce((s, t) => s + parseFloat(t.amount || 0), 0);

    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>${title}</title>
    <style>${getBaseStyles()}</style>
</head>
<body>
<div class="page">
    ${letterhead(title, ref, new Date())}

    ${isSingle ? `
    <div class="doc-title">${transactions.description || 'Transaction'}</div>
    <div class="doc-subtitle">${fmt.date(transactions.value_date)}</div>

    <div class="meta-box cols-4">
        <div class="meta-item">
            <div class="meta-label">Reference</div>
            <div class="meta-value font-mono">${transactions.reference_code}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Type</div>
            <div class="meta-value">${transactions.transaction_type}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Amount</div>
            <div class="meta-value large ${
                transactions.transaction_type === 'CREDIT' ? 'green' : 'red'
            }">
                ${transactions.currency_code} ${fmt.amount(transactions.amount)}
            </div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Date</div>
            <div class="meta-value">${fmt.date(transactions.value_date)}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Account</div>
            <div class="meta-value">${transactions.account_name || '—'}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Category</div>
            <div class="meta-value">${transactions.category_trail || transactions.category_name || '—'}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Balance Before</div>
            <div class="meta-value">${transactions.currency_code} ${fmt.amount(transactions.balance_before)}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Balance After</div>
            <div class="meta-value">${transactions.currency_code} ${fmt.amount(transactions.balance_after)}</div>
        </div>
    </div>
    ` : `
    <div class="doc-title">${title}</div>
    <div class="doc-subtitle">${list.length} transactions • ${options.period || fmt.date(new Date())}</div>

    <div class="meta-box cols-3">
        <div class="meta-item">
            <div class="meta-label">Total Records</div>
            <div class="meta-value large">${list.length}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Total Credits</div>
            <div class="meta-value large green">+${fmt.amount(totalCredit)}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Total Debits</div>
            <div class="meta-value large red">-${fmt.amount(totalDebit)}</div>
        </div>
    </div>
    `}

    <div class="section">
        <div class="section-title">Transaction Details</div>
        <table>
            <thead>
                <tr>
                    <th>Reference</th>
                    <th>Description</th>
                    <th>Category</th>
                    <th>Date</th>
                    <th class="text-right">Amount</th>
                    <th class="text-right">Balance After</th>
                </tr>
            </thead>
            <tbody>
                ${list.map(t => {
                    const isCredit = t.transaction_type === 'CREDIT' ||
                                     t.transaction_type === 'REVERSAL_CREDIT';
                    return `
                    <tr>
                        <td class="font-mono text-blue">${t.reference_code}</td>
                        <td>${t.description || '—'}</td>
                        <td class="text-gray">${t.category_trail || t.category_name || '—'}</td>
                        <td>${fmt.date(t.value_date)}</td>
                        <td class="text-right font-bold ${isCredit ? 'text-green' : 'text-red'}">
                            ${isCredit ? '+' : '-'}${t.currency_code} ${fmt.amount(t.amount)}
                        </td>
                        <td class="text-right">${t.currency_code} ${fmt.amount(t.balance_after)}</td>
                    </tr>`;
                }).join('')}
                ${!isSingle ? `
                <tr class="total-row">
                    <td colspan="4">TOTALS</td>
                    <td class="text-right">
                        <span class="text-green">+${fmt.amount(totalCredit)}</span> /
                        <span class="text-red">-${fmt.amount(totalDebit)}</span>
                    </td>
                    <td></td>
                </tr>` : ''}
            </tbody>
        </table>
    </div>

    ${isSingle ? documentTrail([
        { role: 'Recorded By', name: transactions.created_by_name, date: transactions.created_at },
    ]) : ''}

    ${footer(ref)}
</div>
</body>
</html>`;
};

// ============================================================
// TEMPLATE 2: LOAN STATEMENT
// ============================================================
export const loanTemplate = (loan, repayments = [], loanType = 'received') => {
    const partyLabel = loanType === 'received' ? 'Lender' : 'Borrower';
    const partyName  = loanType === 'received' ? loan.lender_name : loan.borrower_name;
    const partyType  = loanType === 'received' ? loan.lender_type : loan.borrower_type;

    const totalRepaid = repayments.reduce(
        (s, r) => s + parseFloat(r.amount || 0), 0
    );

    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Loan Statement</title>
    <style>${getBaseStyles()}</style>
</head>
<body>
<div class="page">
    ${letterhead('Loan Statement', loan.reference_code, new Date())}

    <div class="doc-title">Loan Statement</div>
    <div class="doc-subtitle">
        ${loanType === 'received' ? 'Loan Received from' : 'Loan Given to'}: ${partyName}
    </div>

    <div class="meta-box cols-4">
        <div class="meta-item">
            <div class="meta-label">Reference</div>
            <div class="meta-value font-mono">${loan.reference_code}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">${partyLabel}</div>
            <div class="meta-value">${partyName}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">${partyLabel} Type</div>
            <div class="meta-value">${partyType || '—'}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Status</div>
            <div class="meta-value">${badge(loan.status)}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Principal Amount</div>
            <div class="meta-value large">
                ${loan.currency_code} ${fmt.amount(loan.principal_amount)}
            </div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Outstanding</div>
            <div class="meta-value large red">
                ${loan.currency_code} ${fmt.amount(loan.outstanding_principal)}
            </div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Fixed Rate</div>
            <div class="meta-value">${loan.fixed_interest_rate}% ${loan.interest_period}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Penalty Rate</div>
            <div class="meta-value red">${loan.penalty_interest_rate}%</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Disbursement Date</div>
            <div class="meta-value">${fmt.date(loan.disbursement_date)}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Due Date</div>
            <div class="meta-value">${fmt.date(loan.due_date)}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Account</div>
            <div class="meta-value">${loan.account_name || '—'}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Total Repaid</div>
            <div class="meta-value green">${loan.currency_code} ${fmt.amount(totalRepaid)}</div>
        </div>
    </div>

    ${repayments.length > 0 ? `
    <div class="section">
        <div class="section-title">Repayment History</div>
        <table>
            <thead>
                <tr>
                    <th>#</th>
                    <th>Date</th>
                    <th class="text-right">Amount</th>
                    <th>Notes</th>
                </tr>
            </thead>
            <tbody>
                ${repayments.map((r, i) => `
                <tr>
                    <td>${i + 1}</td>
                    <td>${fmt.date(r.payment_date)}</td>
                    <td class="text-right font-bold text-green">
                        ${loan.currency_code} ${fmt.amount(r.amount)}
                    </td>
                    <td class="text-gray">${r.notes || '—'}</td>
                </tr>`).join('')}
                <tr class="total-row">
                    <td colspan="2">TOTAL REPAID</td>
                    <td class="text-right text-green">
                        ${loan.currency_code} ${fmt.amount(totalRepaid)}
                    </td>
                    <td></td>
                </tr>
            </tbody>
        </table>
    </div>
    ` : '<p style="color:#9ca3af;font-size:11px;">No repayments recorded yet.</p>'}

    ${documentTrail([
        { role: 'Recorded By', name: loan.created_by_name, date: loan.created_at },
        { role: 'Approved By', name: loan.approved_by_name, date: loan.approved_at },
    ])}

    ${footer(loan.reference_code)}
</div>
</body>
</html>`;
};

// ============================================================
// TEMPLATE 3: GRANT STATEMENT
// ============================================================
export const grantTemplate = (grant, tranches = []) => {
    const totalReceived = tranches.reduce(
        (s, t) => s + parseFloat(t.amount || 0), 0
    );

    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Grant Statement</title>
    <style>${getBaseStyles()}</style>
</head>
<body>
<div class="page">
    ${letterhead('Grant Statement', grant.reference_code, new Date())}

    <div class="doc-title">${grant.title}</div>
    <div class="doc-subtitle">Grant from ${grant.grantor_name}</div>

    <div class="meta-box cols-4">
        <div class="meta-item">
            <div class="meta-label">Reference</div>
            <div class="meta-value font-mono">${grant.reference_code}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Grantor</div>
            <div class="meta-value">${grant.grantor_name}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Type</div>
            <div class="meta-value">${grant.grantor_type || '—'}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Status</div>
            <div class="meta-value">${badge(grant.status)}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Total Amount</div>
            <div class="meta-value large">
                ${grant.currency_code} ${fmt.amount(grant.total_amount)}
            </div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Received</div>
            <div class="meta-value large green">
                ${grant.currency_code} ${fmt.amount(totalReceived)}
            </div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Grant Type</div>
            <div class="meta-value">${grant.grant_type || '—'}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Account</div>
            <div class="meta-value">${grant.account_name || '—'}</div>
        </div>
    </div>

    ${grant.conditions ? `
    <div class="section">
        <div class="section-title">Conditions</div>
        <p style="font-size:11px;color:#374151;line-height:1.6;">${grant.conditions}</p>
    </div>` : ''}

    ${tranches.length > 0 ? `
    <div class="section">
        <div class="section-title">Tranches Received</div>
        <table>
            <thead>
                <tr>
                    <th>#</th>
                    <th>Date</th>
                    <th class="text-right">Amount</th>
                    <th>Reference</th>
                    <th>Notes</th>
                </tr>
            </thead>
            <tbody>
                ${tranches.map((t, i) => `
                <tr>
                    <td>${i + 1}</td>
                    <td>${fmt.date(t.received_date)}</td>
                    <td class="text-right font-bold text-green">
                        ${grant.currency_code} ${fmt.amount(t.amount)}
                    </td>
                    <td class="font-mono text-blue">${t.reference_code || '—'}</td>
                    <td class="text-gray">${t.notes || '—'}</td>
                </tr>`).join('')}
                <tr class="total-row">
                    <td colspan="2">TOTAL RECEIVED</td>
                    <td class="text-right text-green">
                        ${grant.currency_code} ${fmt.amount(totalReceived)}
                    </td>
                    <td colspan="2"></td>
                </tr>
            </tbody>
        </table>
    </div>` : ''}

    ${documentTrail([
        { role: 'Recorded By', name: grant.created_by_name, date: grant.created_at },
        { role: 'Approved By', name: grant.approved_by_name, date: grant.approved_at },
    ])}

    ${footer(grant.reference_code)}
</div>
</body>
</html>`;
};

// ============================================================
// TEMPLATE 4: TRANSFER STATEMENT
// ============================================================
export const transferTemplate = (transfers) => {
    const isSingle = !Array.isArray(transfers);
    const list     = isSingle ? [transfers] : transfers;

    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Transfer Statement</title>
    <style>${getBaseStyles()}</style>
</head>
<body>
<div class="page">
    ${letterhead(
        isSingle ? 'Transfer Statement' : 'Transfer Report',
        isSingle ? transfers.reference_code : `${list.length} transfers`,
        new Date()
    )}

    <div class="doc-title">
        ${isSingle ? 'Transfer Statement' : 'Transfer Report'}
    </div>
    <div class="doc-subtitle">
        ${isSingle
            ? `${transfers.from_account} → ${transfers.to_account}`
            : `${list.length} transfers exported on ${fmt.date(new Date())}`}
    </div>

    ${isSingle ? `
    <div class="meta-box cols-4">
        <div class="meta-item">
            <div class="meta-label">Reference</div>
            <div class="meta-value font-mono">${transfers.reference_code}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Status</div>
            <div class="meta-value">${badge(transfers.status)}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">From Account</div>
            <div class="meta-value">${transfers.from_account}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">To Account</div>
            <div class="meta-value">${transfers.to_account}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Amount Sent</div>
            <div class="meta-value large red">
                ${transfers.from_currency} ${fmt.amount(transfers.amount_sent)}
            </div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Amount Received</div>
            <div class="meta-value large green">
                ${transfers.to_currency} ${fmt.amount(transfers.amount_received)}
            </div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Exchange Rate</div>
            <div class="meta-value">${fmt.num(transfers.exchange_rate)}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Transfer Date</div>
            <div class="meta-value">${fmt.date(transfers.value_date)}</div>
        </div>
    </div>` : ''}

    ${isSingle && (parseFloat(transfers.sending_bank_charge || 0) > 0 || parseFloat(transfers.receiving_bank_charge || 0) > 0) ? `
    <div class="section">
        <div class="section-title">Bank Charges</div>
        <table>
            <thead>
                <tr>
                    <th>Leg</th>
                    <th class="text-right">Charge</th>
                </tr>
            </thead>
            <tbody>
                ${parseFloat(transfers.sending_bank_charge || 0) > 0 ? `
                <tr>
                    <td>Sending (${transfers.from_account})</td>
                    <td class="text-right text-red">
                        ${transfers.from_currency} ${fmt.amount(transfers.sending_bank_charge)}
                    </td>
                </tr>` : ''}
                ${parseFloat(transfers.receiving_bank_charge || 0) > 0 ? `
                <tr>
                    <td>Receiving (${transfers.to_account})</td>
                    <td class="text-right text-red">
                        ${transfers.to_currency} ${fmt.amount(transfers.receiving_bank_charge)}
                    </td>
                </tr>` : ''}
            </tbody>
        </table>
    </div>` : ''}

    <div class="section">
        <div class="section-title">Transfer Records</div>
        <table>
            <thead>
                <tr>
                    <th>Reference</th>
                    <th>From</th>
                    <th>To</th>
                    <th>Date</th>
                    <th class="text-right">Amount Sent</th>
                    <th class="text-right">Amount Received</th>
                    <th>Rate</th>
                    <th>Status</th>
                </tr>
            </thead>
            <tbody>
                ${list.map(t => `
                <tr>
                    <td class="font-mono text-blue">${t.reference_code}</td>
                    <td>${t.from_account}</td>
                    <td>${t.to_account}</td>
                    <td>${fmt.date(t.value_date)}</td>
                    <td class="text-right text-red">
                        ${t.from_currency} ${fmt.amount(t.amount_sent)}
                    </td>
                    <td class="text-right text-green">
                        ${t.to_currency} ${fmt.amount(t.amount_received)}
                    </td>
                    <td>${fmt.num(t.exchange_rate)}</td>
                    <td>${badge(t.status)}</td>
                </tr>`).join('')}
            </tbody>
        </table>
    </div>

    ${isSingle ? documentTrail([
        { role: 'Initiated By', name: transfers.initiated_by_name, date: transfers.created_at },
        { role: 'Approved By',  name: transfers.approver_name,     date: transfers.approved_at },
    ]) : ''}

    ${footer(isSingle ? transfers.reference_code : 'Transfer Report')}
</div>
</body>
</html>`;
};

// ============================================================
// TEMPLATE 5: EVENT NOTICE
// ============================================================
export const eventTemplate = (events) => {
    const isSingle = !Array.isArray(events);
    const list     = isSingle ? [events] : events;
    const ev       = isSingle ? events : null;

    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>${isSingle ? 'Event Notice' : 'Events Report'}</title>
    <style>${getBaseStyles()}</style>
</head>
<body>
<div class="page">
    ${letterhead(
        isSingle ? 'Event Notice' : 'Events Report',
        isSingle ? events.reference_code : `${list.length} events`,
        new Date()
    )}

    <div class="doc-title">
        ${isSingle ? ev.title : 'Events Report'}
    </div>
    <div class="doc-subtitle">
        ${isSingle
            ? `${ev.event_type} • ${fmt.date(ev.event_date)}`
            : `${list.length} events exported on ${fmt.date(new Date())}`}
    </div>

    ${isSingle ? `
    <div class="meta-box cols-4">
        <div class="meta-item">
            <div class="meta-label">Reference</div>
            <div class="meta-value font-mono">${ev.reference_code}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Event Type</div>
            <div class="meta-value">${ev.event_type?.replace(/_/g, ' ')}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Date & Time</div>
            <div class="meta-value">${fmt.date(ev.event_date)} ${ev.start_time || ''}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Status</div>
            <div class="meta-value">${badge(ev.status)}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Location</div>
            <div class="meta-value">${ev.location || '—'}</div>
        </div>
        ${ev.is_online ? `
        <div class="meta-item">
            <div class="meta-label">Join Online</div>
            <div class="meta-value">${ev.meeting_link
                ? `<a href="${ev.meeting_link}">${ev.meeting_provider === 'GOOGLE_MEET' ? 'Join Google Meet' : 'Join Meeting'}</a>`
                : 'Link to follow'}</div>
        </div>` : ''}
        <div class="meta-item">
            <div class="meta-label">Organiser</div>
            <div class="meta-value">${ev.organiser_name || '—'}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Category</div>
            <div class="meta-value">${ev.category_name || '—'}</div>
        </div>
    </div>

    ${ev.description ? `
    <div class="section">
        <div class="section-title">Description</div>
        <p style="font-size:11px;color:#374151;line-height:1.7;">${ev.description}</p>
    </div>` : ''}

    ${ev.attendees ? `
    <div class="section">
        <div class="section-title">Attendees / Recipients</div>
        <p style="font-size:11px;color:#374151;">${ev.attendees}</p>
    </div>` : ''}

    ${documentTrail([
        { role: 'Organised By', name: ev.created_by_name,  date: ev.created_at },
        { role: 'Approved By',  name: ev.approved_by_name, date: ev.approved_at },
    ])}

    <div class="signature-section">
        <div class="signature-block">
            Organiser: ${ev.created_by_name || '_______________'}<br>
            Signature: _______________<br>
            Date: _______________
        </div>
        <div class="signature-block">
            Chairperson: _______________<br>
            Signature: _______________<br>
            Date: _______________
        </div>
    </div>
    ` : `
    <div class="section">
        <div class="section-title">Event List</div>
        <table>
            <thead>
                <tr>
                    <th>Reference</th>
                    <th>Title</th>
                    <th>Type</th>
                    <th>Date</th>
                    <th>Location</th>
                    <th>Status</th>
                </tr>
            </thead>
            <tbody>
                ${list.map(e => `
                <tr>
                    <td class="font-mono text-blue">${e.reference_code}</td>
                    <td>${e.title}</td>
                    <td>${e.event_type?.replace(/_/g, ' ')}</td>
                    <td>${fmt.date(e.event_date)}</td>
                    <td>${e.location || '—'}</td>
                    <td>${badge(e.status)}</td>
                </tr>`).join('')}
            </tbody>
        </table>
    </div>`}

    ${footer(isSingle ? ev.reference_code : 'Events Report')}
</div>
</body>
</html>`;
};

// ============================================================
// TEMPLATE 6: REQUISITION STATEMENT
// ============================================================
export const requisitionTemplate = (requisitions) => {
    const isSingle = !Array.isArray(requisitions);
    const list     = isSingle ? [requisitions] : requisitions;
    const req      = isSingle ? requisitions : null;

    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Requisition Statement</title>
    <style>${getBaseStyles()}</style>
</head>
<body>
<div class="page">
    ${letterhead(
        isSingle ? 'Requisition Statement' : 'Requisitions Report',
        isSingle ? req.reference_code : `${list.length} requisitions`,
        new Date()
    )}

    <div class="doc-title">
        ${isSingle ? req.title : 'Requisitions Report'}
    </div>
    <div class="doc-subtitle">
        ${isSingle
            ? `Requested by ${req.requested_by_name || '—'}`
            : `${list.length} requisitions exported on ${fmt.date(new Date())}`}
    </div>

    ${isSingle ? `
    <div class="meta-box cols-4">
        <div class="meta-item">
            <div class="meta-label">Reference</div>
            <div class="meta-value font-mono">${req.reference_code}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Status</div>
            <div class="meta-value">${badge(req.status)}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Priority</div>
            <div class="meta-value">${req.priority}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Category</div>
            <div class="meta-value">${req.category_trail || req.category_name || '—'}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Amount Requested</div>
            <div class="meta-value large">${fmt.amount(req.amount_requested)}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Amount Approved</div>
            <div class="meta-value large green">
                ${req.amount_approved ? fmt.amount(req.amount_approved) : '—'}
            </div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Required By</div>
            <div class="meta-value">${fmt.date(req.required_by_date)}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Reviewed By</div>
            <div class="meta-value">${req.reviewed_by_name || '—'}</div>
        </div>
    </div>

    <div class="section">
        <div class="section-title">Purpose</div>
        <p style="font-size:11px;color:#374151;line-height:1.7;">${req.purpose || '—'}</p>
    </div>

    ${req.description ? `
    <div class="section">
        <div class="section-title">Additional Details</div>
        <p style="font-size:11px;color:#374151;line-height:1.7;">${req.description}</p>
    </div>` : ''}

    ${req.review_notes ? `
    <div class="section">
        <div class="section-title">Review Notes</div>
        <p style="font-size:11px;color:#374151;line-height:1.7;">${req.review_notes}</p>
    </div>` : ''}

    ${documentTrail([
        { role: 'Requested By', name: req.requested_by_name, date: req.created_at },
        { role: 'Reviewed By',  name: req.reviewed_by_name,  date: req.reviewed_at },
    ])}

    <div class="signature-section">
        <div class="signature-block">
            Requested By: ${req.requested_by_name || '_______________'}<br>
            Signature: _______________<br>
            Date: _______________
        </div>
        <div class="signature-block">
            Approved By: ${req.reviewed_by_name || '_______________'}<br>
            Signature: _______________<br>
            Date: _______________
        </div>
    </div>
    ` : `
    <div class="section">
        <div class="section-title">Requisition List</div>
        <table>
            <thead>
                <tr>
                    <th>Reference</th>
                    <th>Title</th>
                    <th>Requested By</th>
                    <th>Priority</th>
                    <th class="text-right">Requested</th>
                    <th class="text-right">Approved</th>
                    <th>Status</th>
                </tr>
            </thead>
            <tbody>
                ${list.map(r => `
                <tr>
                    <td class="font-mono text-blue">${r.reference_code}</td>
                    <td>${r.title}</td>
                    <td>${r.requested_by_name || '—'}</td>
                    <td>${r.priority}</td>
                    <td class="text-right">${fmt.amount(r.amount_requested)}</td>
                    <td class="text-right text-green">
                        ${r.amount_approved ? fmt.amount(r.amount_approved) : '—'}
                    </td>
                    <td>${badge(r.status)}</td>
                </tr>`).join('')}
            </tbody>
        </table>
    </div>`}

    ${footer(isSingle ? req.reference_code : 'Requisitions Report')}
</div>
</body>
</html>`;
};

// ============================================================
// TEMPLATE 7: INVESTMENT RETURN / OPERATIONAL TRANSACTION RECEIPT
// A single profit/return entry, or a single operational transaction
// (expense, extra inflow, or tax) recorded against an investment —
// each printable individually so the income/spending trail on an
// investment is just as filing-ready as every other document.
// `entry` needs: investment_name, investment_reference, entry_label
// (e.g. "Profit Share", "Operational Expense"), amount, direction
// ('IN' or 'OUT'), date, reference_code, notes, recorded_by_name,
// recorded_at.
// ============================================================
export const investmentEntryTemplate = (entry) => `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Investment ${entry.direction === 'IN' ? 'Income' : 'Expense'} Receipt</title>
    <style>${getBaseStyles()}</style>
</head>
<body>
<div class="page">
    ${letterhead(
        `Investment ${entry.direction === 'IN' ? 'Income' : 'Expense'} Receipt`,
        entry.reference_code,
        new Date()
    )}

    <div class="doc-title">${entry.entry_label}</div>
    <div class="doc-subtitle">
        ${entry.investment_name} (${entry.investment_reference})
    </div>

    <div class="meta-box cols-3">
        <div class="meta-item">
            <div class="meta-label">Reference</div>
            <div class="meta-value font-mono">${entry.reference_code}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Date</div>
            <div class="meta-value">${fmt.date(entry.date)}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Amount</div>
            <div class="meta-value large ${entry.direction === 'IN' ? 'green' : 'red'}">
                ${entry.direction === 'IN' ? '+' : '-'}${entry.currency_code || ''} ${fmt.amount(entry.amount)}
            </div>
        </div>
    </div>

    ${entry.notes ? `
    <div class="section">
        <div class="section-title">Notes</div>
        <p style="font-size:11px;color:#374151;line-height:1.7;">${entry.notes}</p>
    </div>` : ''}

    ${documentTrail([
        { role: 'Recorded By', name: entry.recorded_by_name, date: entry.recorded_at },
    ])}

    ${footer(entry.reference_code)}
</div>
</body>
</html>`;

// ============================================================
// MEETING AGENDA TEMPLATE
// ============================================================
export const meetingAgendaTemplate = (data) => `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Meeting Agenda</title>
    <style>${getBaseStyles()}
    .agenda-item { display:flex; gap:12px; padding:10px 0;
        border-bottom:1px dotted #e5e7eb; }
    .item-num { width:24px; font-weight:700; color:${PRIMARY_COLOR}; flex-shrink:0; }
    .item-dur { width:60px; text-align:right; color:#9ca3af; flex-shrink:0; }
    </style>
</head>
<body>
<div class="page">
    ${letterhead('Meeting Agenda', data.reference || '', new Date())}
    <div class="doc-title">MEETING AGENDA</div>
    <div class="doc-subtitle">${data.meeting_title || ''}</div>

    <div class="meta-box cols-3">
        <div class="meta-item">
            <div class="meta-label">Date & Time</div>
            <div class="meta-value">${data.meeting_date || '—'} at ${data.meeting_time || '—'}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Venue</div>
            <div class="meta-value">${data.venue || '—'}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Chairperson</div>
            <div class="meta-value">${personName(data, 'chairperson') || '—'}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Secretary</div>
            <div class="meta-value">${personName(data, 'secretary') || '—'}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Expected Attendees</div>
            <div class="meta-value">${personListNames(data.attendees) || '—'}</div>
        </div>
    </div>

    <div class="section">
        <div class="section-title">Agenda Items</div>
        ${(data.agenda_items || []).map(item => `
        <div class="agenda-item">
            <div class="item-num">${item.number}.</div>
            <div style="flex:1">
                <strong>${item.title}</strong>
                ${item.description
                    ? `<p style="margin:4px 0 0;color:#6b7280;font-size:11px;">
                        ${item.description}</p>`
                    : ''}
            </div>
            <div class="item-dur">${item.duration || ''}</div>
        </div>`).join('')}
    </div>

    ${data.additional_notes ? `
    <div class="section">
        <div class="section-title">Additional Notes</div>
        <p style="font-size:11px;color:#374151;">${data.additional_notes}</p>
    </div>` : ''}

    ${documentTrail([
        { role: 'Chairperson', name: personName(data, 'chairperson'), date: data.meeting_date },
        { role: 'Secretary',   name: personName(data, 'secretary'),   date: data.meeting_date },
        { role: 'Prepared By', name: data.prepared_by, date: data.generated_date },
    ])}

    <div class="signature-section">
        ${signatureBlock(data, 'Chairperson', personName(data, 'chairperson'), 'Chairman')}
        ${signatureBlock(data, 'Secretary', personName(data, 'secretary'), 'Secretary')}
    </div>

    ${footer(`${COMPANY_NAME} | ${data.meeting_title || ''}`)}
</div>
</body>
</html>`;

// ============================================================
// MEETING MINUTES TEMPLATE
// ============================================================
export const meetingMinutesTemplate = (data) => `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Meeting Minutes</title>
    <style>${getBaseStyles()}
    .minute-item { margin-bottom:16px; padding:14px;
        background:#f9fafb; border-left:4px solid ${PRIMARY_COLOR};
        border-radius:0 6px 6px 0; }
    .minute-item h4 { color:${PRIMARY_COLOR}; margin-bottom:6px; }
    </style>
</head>
<body>
<div class="page">
    ${letterhead('Meeting Minutes', data.reference || '', new Date())}
    <div class="doc-title">MINUTES OF MEETING</div>
    <div class="doc-subtitle">${data.meeting_title || ''}</div>

    <div class="meta-box cols-3">
        <div class="meta-item">
            <div class="meta-label">Date & Time</div>
            <div class="meta-value">${data.meeting_date || '—'} at ${data.meeting_time || '—'}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Venue</div>
            <div class="meta-value">${data.venue || '—'}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Chairperson</div>
            <div class="meta-value">${personName(data, 'chairperson') || '—'}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Secretary</div>
            <div class="meta-value">${personName(data, 'secretary') || '—'}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Present</div>
            <div class="meta-value">${personListNames(data.present) || '—'}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Apologies</div>
            <div class="meta-value">${data.apologies || '—'}</div>
        </div>
    </div>

    <div class="section">
        <div class="section-title">Minutes</div>
        ${(data.minute_items || []).map(item => `
        <div class="minute-item">
            <h4>${item.number}. ${item.title}</h4>
            <p style="font-size:11px;color:#374151;line-height:1.7;">
                ${item.content}
            </p>
        </div>`).join('')}
    </div>

    ${(data.action_points || []).length > 0 ? `
    <div class="section">
        <div class="section-title">Action Points</div>
        <table>
            <thead>
                <tr>
                    <th>#</th>
                    <th>Action</th>
                    <th>Responsible</th>
                    <th>Deadline</th>
                </tr>
            </thead>
            <tbody>
                ${data.action_points.map(a => `
                <tr>
                    <td>${a.number}</td>
                    <td>${a.action}</td>
                    <td>${a.responsible}</td>
                    <td>${a.deadline}</td>
                </tr>`).join('')}
            </tbody>
        </table>
    </div>` : ''}

    <div class="section">
        <div class="section-title">Closure</div>
        <p style="font-size:11px;">${data.closure_notes || ''}</p>
        <p style="font-size:11px;margin-top:6px;">
            Meeting closed at: <strong>${data.close_time || '—'}</strong>
        </p>
        <p style="font-size:11px;margin-top:4px;">
            Next meeting: <strong>${data.next_meeting || '—'}</strong>
        </p>
    </div>

    ${documentTrail([
        { role: 'Chairperson', name: personName(data, 'chairperson'),  date: data.meeting_date },
        { role: 'Secretary',   name: personName(data, 'secretary'),    date: data.meeting_date },
        { role: 'Prepared By', name: data.prepared_by,  date: data.generated_date },
    ])}

    <div class="signature-section">
        ${signatureBlock(data, 'Chairperson', personName(data, 'chairperson'), 'Chairman')}
        ${signatureBlock(data, 'Secretary', personName(data, 'secretary'), 'Secretary')}
    </div>

    ${footer()}
</div>
</body>
</html>`;

// ============================================================
// RECEIPT TEMPLATE
// A general-purpose receipt for money received in person (cash,
// cheque, mobile money, etc) — distinct from the system's automatic
// transaction receipts (transactionTemplate above), which are only
// generated from an already-posted ledger transaction. This one is
// for money changing hands informally, before/without a ledger entry
// existing yet — e.g. handing someone a paper receipt on the spot.
// ============================================================
export const receiptTemplate = (data) => `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Receipt</title>
    <style>${getBaseStyles()}</style>
</head>
<body>
<div class="page">
    ${letterhead('Receipt', data.reference || '', new Date())}
    <div class="doc-title">RECEIPT</div>
    <div class="doc-subtitle">Acknowledgement of money received</div>

    <div class="meta-box cols-3">
        <div class="meta-item">
            <div class="meta-label">Received From</div>
            <div class="meta-value">${data.received_from || '—'}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Amount</div>
            <div class="meta-value large green">
                ${data.currency_code || ''} ${fmt.amount(data.amount)}
            </div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Payment Method</div>
            <div class="meta-value">${data.payment_method || '—'}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Receipt Date</div>
            <div class="meta-value">${fmt.date(data.receipt_date)}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Received By</div>
            <div class="meta-value">${data.received_by || '—'}</div>
        </div>
    </div>

    <div class="section">
        <div class="section-title">Purpose</div>
        <p style="font-size:12px;line-height:1.7;">${data.purpose || '—'}</p>
    </div>

    ${data.notes ? `
    <div class="section">
        <div class="section-title">Notes</div>
        <p style="font-size:11px;color:#6b7280;line-height:1.7;">${data.notes}</p>
    </div>` : ''}

    ${documentTrail([
        { role: 'Received By', name: data.received_by, date: data.receipt_date },
        { role: 'Prepared By', name: data.prepared_by,  date: data.generated_date },
    ])}

    <div class="signature-section">
        <div class="signature-block">
            Received By: ${data.received_by || '_______________'}<br>
            Signature: _______________<br>
            Date: _______________
        </div>
        <div class="signature-block">
            Received From: ${data.received_from || '_______________'}<br>
            Signature: _______________<br>
            Date: _______________
        </div>
    </div>

    ${footer()}
</div>
</body>
</html>`;

// ============================================================
// SHARE PURCHASE RECEIPT TEMPLATE (v1.65.0; single-currency since v1.67.0)
// Auto-generated the moment a capital contribution is recorded
// (transactionsController.creditShareholderContribution) — shows the
// member's shareholding immediately before and after this one
// contribution, so it reads as a genuine "purchase receipt," not just
// a payment acknowledgement. Uses document_type 'RECEIPT' (same as
// receiptTemplate above) but is a DIFFERENT renderer, picked by
// DocumentsPage.jsx via `template_data.receipt_kind === 'SHARE_PURCHASE'`
// rather than by document_type alone, since both share the same type.
//
// v1.67.0 — the whole receipt is expressed in ONE currency: the share
// price's own currency (UGX). v1.65.0 printed the UGX price per share
// with the contribution's € symbol ("€ 50,000.00"). Now the amount is
// shown converted into UGX at the exact rate the share calculation
// used (the rate effective on the contribution date), with the amount
// actually paid (e.g. EUR 26.00) and that rate stated underneath.
// A receipt issued before v1.67.0 and not yet re-built by
// backfill_v1.67.0_share_receipts.js (no share_currency_code) falls
// back to printing the price with no currency label rather than a
// wrong one.
//
// The Treasurer's signature is baked in directly from `template_data`
// (`treasurer_signature_url`/`treasurer_name`/`signed_at`) — snapshotted
// server-side the moment the contribution was recorded, the same
// "Prepared By" pattern used elsewhere in this file, not the multi-role
// document_signatures/signing-round mechanism `signatureBlock()` above
// reads from (a receipt has exactly one signer, captured immediately,
// never a pending multi-signatory approval).
//
// `data` shape: { reference, member_name, member_email, contribution_date,
//   amount, currency_code, currency_symbol,               <- as paid
//   share_currency_code, share_currency_symbol,           <- receipt currency (v1.67.0)
//   amount_in_share_currency, exchange_rate, exchange_rate_date, (v1.67.0)
//   shares_purchased, shares_before, shares_after, percentage_after,
//   price_per_share, recorded_by_name, treasurer_name,
//   treasurer_signature_url, signed_at, generated_date, notes }
// ============================================================
const receiptCurrencyLabel = (symbol, code) => (symbol && symbol !== code ? symbol : (code || symbol || ''));

export const sharePurchaseReceiptTemplate = (data) => {
    const shareCur = receiptCurrencyLabel(data.share_currency_symbol, data.share_currency_code);
    const paidCur = receiptCurrencyLabel(data.currency_symbol, data.currency_code);
    const converted = !!(data.share_currency_code && data.currency_code && data.share_currency_code !== data.currency_code);
    const amountInShareCurrency = data.amount_in_share_currency != null
        ? data.amount_in_share_currency
        : (data.share_currency_code && data.share_currency_code === data.currency_code ? data.amount : null);
    const rateText = data.exchange_rate != null
        ? parseFloat(data.exchange_rate).toLocaleString('en-US', { maximumFractionDigits: 6 })
        : null;
    // v1.69.0 — whole shares + share credit. Receipts issued before
    // v1.69.0 (no whole_shares flag) keep their original layout.
    const whole = !!data.whole_shares;
    const sc = data.share_currency_code || '';
    const row = (label, value, strong = false, last = false) => `
                <tr>
                    <td style="padding:8px; ${last ? '' : 'border-bottom:1px solid #e5e7eb;'} font-size:12px;${strong ? ' font-weight:700;' : ''}">${label}</td>
                    <td style="padding:8px; ${last ? '' : 'border-bottom:1px solid #e5e7eb;'} text-align:right; font-size:12px;${strong ? ' font-weight:700;' : ''}">${value}</td>
                </tr>`;
    const wholeSharesTable = whole ? `
    <div class="section">
        <div class="section-title">How The Shares Were Calculated</div>
        <table style="width:100%; border-collapse:collapse; margin-top:8px;">
            <tbody>
                ${converted && rateText ? row('Amount paid', `${data.currency_code} ${fmt.amount(data.amount)}`) : ''}
                ${converted && rateText ? row(`Exchange rate applied (company rate effective ${fmt.date(data.exchange_rate_date || data.contribution_date)})`, `1 ${data.currency_code} = ${rateText} ${sc}`) : ''}
                ${row(`Value of this contribution in ${sc}`, `${sc} ${fmt.amount(amountInShareCurrency)}`)}
                ${row('Share credit brought forward (from earlier contributions)', `${sc} ${fmt.amount(data.credit_before)}`)}
                ${row('Available to buy shares', `${sc} ${fmt.amount(data.credit_available)}`, true)}
                ${row('Issue price per share', `${sc} ${fmt.amount(data.price_per_share)}`)}
                ${row('Whole shares allotted (available ÷ price, whole shares only)', `${data.shares_purchased}`, true)}
                ${row(`Used for the shares (${data.shares_purchased} × ${fmt.amount(data.price_per_share)})`, `${sc} ${fmt.amount(data.credit_used)}`)}
                ${row('Share credit carried forward to your next contribution', `${sc} ${fmt.amount(data.credit_after)}`, true, true)}
            </tbody>
        </table>
        ${data.nominal_value != null ? `
        <p style="font-size:10px;color:#6b7280;margin-top:6px;line-height:1.6;">
            Nominal (registered) value per share: ${sc} ${fmt.amount(data.nominal_value)}.
            ${data.share_capital_amount != null ? `Recorded as share capital ${sc} ${fmt.amount(data.share_capital_amount)}` : ''}${data.share_premium_amount ? ` and share premium ${sc} ${fmt.amount(data.share_premium_amount)}` : ''}${data.share_capital_amount != null ? '.' : ''}
            ${data.allotment_reference ? `Allotment reference: ${data.allotment_reference}.` : ''}
            Share credit is capital you have paid in that is not yet enough for a whole share; it is used first at your next contribution and can be refunded on request.
        </p>` : ''}
    </div>` : '';

    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Share Purchase Receipt</title>
    <style>${getBaseStyles()}</style>
</head>
<body>
<div class="page">
    ${letterhead('Share Purchase Receipt', data.reference || '', new Date())}
    <div class="doc-title">SHARE PURCHASE RECEIPT</div>
    <div class="doc-subtitle">Acknowledgement of a capital contribution and the shares it purchased${data.share_currency_code ? ` — all figures in ${data.share_currency_code}` : ''}</div>

    <div class="meta-box cols-3">
        <div class="meta-item">
            <div class="meta-label">Shareholder</div>
            <div class="meta-value">${data.member_name || '—'}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Amount Contributed</div>
            <div class="meta-value large green">
                ${amountInShareCurrency != null
                    ? `${shareCur} ${fmt.amount(amountInShareCurrency)}`
                    : `${paidCur} ${fmt.amount(data.amount)}`}
            </div>
            ${converted && amountInShareCurrency != null ? `
            <div style="font-size:10px;color:#6b7280;margin-top:2px;">
                Paid ${data.currency_code} ${fmt.amount(data.amount)}${rateText ? ` at 1 ${data.currency_code} = ${rateText} ${data.share_currency_code}` : ''}
            </div>` : ''}
        </div>
        <div class="meta-item">
            <div class="meta-label">Contribution Date</div>
            <div class="meta-value">${fmt.date(data.contribution_date)}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Price Per Share</div>
            <div class="meta-value">
                ${data.price_per_share != null
                    ? `${shareCur ? `${shareCur} ` : ''}${fmt.amount(data.price_per_share)}`
                    : '—'}
            </div>
        </div>
        <div class="meta-item">
            <div class="meta-label">${whole ? 'Whole Shares Allotted' : 'Shares Purchased'}</div>
            <div class="meta-value large green">+${whole ? data.shares_purchased : fmt.amount(data.shares_purchased)}</div>
            ${whole ? `<div style="font-size:10px;color:#6b7280;margin-top:2px;">Share credit carried forward: ${sc} ${fmt.amount(data.credit_after)}</div>` : ''}
        </div>
        <div class="meta-item">
            <div class="meta-label">Recorded By</div>
            <div class="meta-value">${data.recorded_by_name || '—'}</div>
        </div>
    </div>

    ${wholeSharesTable}

    ${!whole && converted && rateText ? `
    <div class="section">
        <div class="section-title">How The Shares Were Calculated</div>
        <table style="width:100%; border-collapse:collapse; margin-top:8px;">
            <tbody>
                <tr>
                    <td style="padding:8px; border-bottom:1px solid #e5e7eb; font-size:12px;">Amount paid</td>
                    <td style="padding:8px; border-bottom:1px solid #e5e7eb; text-align:right; font-size:12px;">${data.currency_code} ${fmt.amount(data.amount)}</td>
                </tr>
                <tr>
                    <td style="padding:8px; border-bottom:1px solid #e5e7eb; font-size:12px;">Exchange rate applied (company rate effective ${fmt.date(data.exchange_rate_date || data.contribution_date)})</td>
                    <td style="padding:8px; border-bottom:1px solid #e5e7eb; text-align:right; font-size:12px;">1 ${data.currency_code} = ${rateText} ${data.share_currency_code}</td>
                </tr>
                <tr>
                    <td style="padding:8px; border-bottom:1px solid #e5e7eb; font-size:12px;">Value in ${data.share_currency_code}</td>
                    <td style="padding:8px; border-bottom:1px solid #e5e7eb; text-align:right; font-size:12px;">${data.share_currency_code} ${fmt.amount(amountInShareCurrency)}</td>
                </tr>
                <tr>
                    <td style="padding:8px; border-bottom:1px solid #e5e7eb; font-size:12px;">Price per share</td>
                    <td style="padding:8px; border-bottom:1px solid #e5e7eb; text-align:right; font-size:12px;">${data.share_currency_code} ${fmt.amount(data.price_per_share)}</td>
                </tr>
                <tr>
                    <td style="padding:8px; font-size:12px; font-weight:700;">Shares purchased (value ÷ price)</td>
                    <td style="padding:8px; text-align:right; font-size:12px; font-weight:700;">${fmt.amount(data.shares_purchased)}</td>
                </tr>
            </tbody>
        </table>
    </div>` : ''}

    <div class="section">
        <div class="section-title">Shareholding Before &amp; After This Contribution</div>
        <table style="width:100%; border-collapse:collapse; margin-top:8px;">
            <thead>
                <tr style="background:#f3f4f6;">
                    <th style="padding:8px; text-align:left; font-size:11px; color:#6b7280;"></th>
                    <th style="padding:8px; text-align:right; font-size:11px; color:#6b7280;">Shares Held</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td style="padding:8px; border-bottom:1px solid #e5e7eb; font-size:12px;">Previously owned (before this contribution)</td>
                    <td style="padding:8px; border-bottom:1px solid #e5e7eb; text-align:right; font-size:12px;">${whole ? data.shares_before : fmt.amount(data.shares_before)}</td>
                </tr>
                <tr>
                    <td style="padding:8px; border-bottom:1px solid #e5e7eb; font-size:12px;">Purchased in this contribution</td>
                    <td style="padding:8px; border-bottom:1px solid #e5e7eb; text-align:right; font-size:12px; color:#059669; font-weight:700;">+${whole ? data.shares_purchased : fmt.amount(data.shares_purchased)}</td>
                </tr>
                <tr>
                    <td style="padding:8px; font-size:12px; font-weight:700;">New total shareholding</td>
                    <td style="padding:8px; text-align:right; font-size:12px; font-weight:700;">
                        ${whole ? data.shares_after : fmt.amount(data.shares_after)}
                        ${data.percentage_after != null ? ` (${fmt.amount(data.percentage_after)}% of the company)` : ''}
                    </td>
                </tr>
            </tbody>
        </table>
    </div>

    ${data.notes ? `
    <div class="section">
        <div class="section-title">Notes</div>
        <p style="font-size:11px;color:#6b7280;line-height:1.7;">${data.notes}</p>
    </div>` : ''}

    ${documentTrail([
        { role: 'Recorded By', name: data.recorded_by_name, date: data.contribution_date },
        { role: 'Prepared By', name: data.treasurer_name,   date: data.generated_date },
    ])}

    <div class="signature-section">
        <div class="signature-block">
            Treasurer: ${data.treasurer_name || '_______________'}<br>
            Signature: ${data.treasurer_signature_url
                ? `<img src="${resolveUploadUrl(data.treasurer_signature_url)}" alt="Signature" style="height:32px;display:block;margin-top:2px;" />`
                : '_______________'}<br>
            Date: ${data.signed_at ? fmt.date(data.signed_at) : '_______________'}
        </div>
    </div>

    <p style="margin-top:24px; font-size:9.5px; color:#9ca3af; text-align:center; line-height:1.5;">
        This receipt confirms the capital contribution and shares recorded above as of the date shown.
        It is issued for record-keeping and transparency purposes based on the company's internal
        shareholding register and does not, of itself, constitute a negotiable or transferable instrument.
    </p>

    ${footer()}
</div>
</body>
</html>`;
};

// ============================================================
// SHARE CAPITAL NOTICE TO SHAREHOLDERS (v1.69.0)
// Auto-generated when a share capital change (issue price, nominal
// value — a split or consolidation — or registered shares) is approved
// by two people under a board resolution. Stored as a documents row
// with audience = 'ALL_SHAREHOLDERS' (every shareholder's My
// Documents), template_data.notice_kind = 'SHARE_CAPITAL_CHANGE'.
// Shows the change, who authorised it, and the full history of the
// issue price and the nominal value / registered shares.
// ============================================================
export const shareCapitalNoticeTemplate = (data) => {
    const cur = data.currency_code || '';
    const s = data.summary || {};
    const cell = 'padding:6px 8px; border-bottom:1px solid #e5e7eb; font-size:11px;';
    const num0 = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-GB', { maximumFractionDigits: 2 }));
    let body = '';
    if (data.change_type === 'ISSUE_PRICE') {
        body = `
        <p>The issue price of one new ordinary share changes from <strong>${cur} ${num0(s.issuePriceBefore ?? data.current_value)}</strong>
        to <strong>${cur} ${num0(s.issuePriceAfter ?? data.proposed_value)}</strong>, effective <strong>${fmt.date(data.effective_date)}</strong>.</p>
        <p>This is the price at which shares are allotted for contributions dated on or after that date. Shares already allotted are
        <strong>not</strong> affected. The nominal (registered) value of a share does not change; any amount paid above it is recorded
        as share premium.</p>`;
    } else if (data.change_type === 'NOMINAL_VALUE') {
        const split = s.kind === 'SPLIT';
        body = `
        <p>The nominal (par) value of one ordinary share changes from <strong>${cur} ${num0(s.nominalBefore)}</strong> to
        <strong>${cur} ${num0(s.nominalAfter)}</strong>, effective <strong>${fmt.date(data.effective_date)}</strong> —
        a share <strong>${split ? 'split' : 'consolidation'}</strong>: ${s.ratioText || ''}.</p>
        <p>Every shareholder's holding has been converted by the same ratio, so the value of each holding is unchanged.
        ${split ? '' : 'Where a holding could not be divided exactly, the leftover old share(s) were cancelled and their nominal value returned to that shareholder\'s share credit, to be used at their next contribution or refunded.'}</p>
        <table style="width:100%; border-collapse:collapse; margin:8px 0;">
            <tbody>
                <tr><td style="${cell}">Shares in issue</td><td style="${cell} text-align:right;">${num0(s.sharesBefore)} → <strong>${num0(s.sharesAfter)}</strong></td></tr>
                <tr><td style="${cell}">Issue price per share</td><td style="${cell} text-align:right;">${cur} ${num0(s.issuePriceBefore)} → <strong>${cur} ${num0(s.issuePriceAfter)}</strong></td></tr>
                <tr><td style="${cell}">Registered shares</td><td style="${cell} text-align:right;">${num0(s.registeredBefore)} → <strong>${num0(s.registeredAfter)}</strong>${s.registeredNotExact ? ' (rounded down)' : ''}</td></tr>
                ${s.membersAffected ? `<tr><td style="${cell}">Shareholders whose holdings were converted</td><td style="${cell} text-align:right;">${s.membersAffected}</td></tr>` : ''}
            </tbody>
        </table>
        <p>Your own holding before and after is shown on the Share Capital page (My Shares).</p>`;
    } else {
        body = `
        <p>The number of ordinary shares registered with the Registrar of Companies (authorised share capital) changes from
        <strong>${num0(s.registeredBefore ?? data.current_value)}</strong> to <strong>${num0(s.registeredAfter ?? data.proposed_value)}</strong>
        shares, effective <strong>${fmt.date(data.effective_date)}</strong>.</p>
        ${s.sharesInIssue !== undefined ? `<p>Shares in issue at the time: ${num0(s.sharesInIssue)}${s.sharesBeyondRegistered ? ` — ${num0(s.sharesBeyondRegistered)} still beyond the registered number` : ' — all covered'}.</p>` : ''}`;
    }

    // A row that starts and ends on the same day was replaced the same
    // day (e.g. converted by a split) — kept in the database, left out here.
    const live = (h) => !h.effective_to || h.effective_to > h.effective_from;
    const priceRows = (data.issue_price_history || []).filter(live).map(h => `
        <tr><td style="${cell}">${fmt.date(h.effective_from)}</td><td style="${cell}">${h.effective_to ? fmt.date(h.effective_to) : 'current'}</td>
        <td style="${cell} text-align:right;">${cur} ${num0(h.price_per_share)}</td></tr>`).join('');
    const nominalRows = (data.nominal_history || []).filter(live).map(h => `
        <tr><td style="${cell}">${fmt.date(h.effective_from)}</td><td style="${cell}">${h.effective_to ? fmt.date(h.effective_to) : 'current'}</td>
        <td style="${cell} text-align:right;">${cur} ${num0(h.nominal_value)}</td><td style="${cell} text-align:right;">${h.registered_shares ?? '—'}</td></tr>`).join('');
    const th = 'padding:6px 8px; text-align:left; font-size:10px; color:#6b7280;';

    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Notice to Shareholders</title>
    <style>${getBaseStyles()}</style>
</head>
<body>
<div class="page">
    ${letterhead('Notice to Shareholders', data.reference || '', data.generated_date ? new Date(data.generated_date) : new Date())}
    <div class="doc-title">NOTICE TO SHAREHOLDERS</div>
    <div class="doc-subtitle">${data.title || 'Change of Share Capital'}</div>

    <div class="meta-box cols-3">
        <div class="meta-item"><div class="meta-label">Change Reference</div><div class="meta-value">${data.change_reference || '—'}</div></div>
        <div class="meta-item"><div class="meta-label">Effective Date</div><div class="meta-value">${fmt.date(data.effective_date)}</div></div>
        <div class="meta-item"><div class="meta-label">Board Resolution</div><div class="meta-value">${data.resolution?.reference || '—'}</div>
            <div style="font-size:10px;color:#6b7280;">${data.resolution?.title || ''}</div></div>
    </div>

    <div class="section">
        <div class="section-title">The Change</div>
        <div style="font-size:12px; line-height:1.7; color:#374151;">${body}</div>
        ${data.reason ? `<p style="font-size:11px;color:#6b7280;margin-top:6px;"><strong>Reason:</strong> ${data.reason}</p>` : ''}
    </div>

    <div class="section">
        <div class="section-title">Authorised By</div>
        <table style="width:100%; border-collapse:collapse; margin-top:6px;">
            <tbody>
                <tr><td style="${cell}">Proposed (first approval)</td><td style="${cell}">${data.requested_by?.name || '—'} — ${data.requested_by?.capacity || ''}</td><td style="${cell} text-align:right;">${fmt.date(data.requested_by?.at)}</td></tr>
                <tr><td style="${cell}">Approved (second approval)</td><td style="${cell}">${data.approved_by?.name || '—'} — ${data.approved_by?.capacity || ''}</td><td style="${cell} text-align:right;">${fmt.date(data.approved_by?.at)}</td></tr>
            </tbody>
        </table>
        <p style="font-size:10px;color:#6b7280;margin-top:6px;">Changes to the share capital require an approved board resolution and two different approvers: two Directors, or a Director and the Treasurer.</p>
    </div>

    <div class="section">
        <div class="section-title">History — Issue Price Per Share</div>
        <table style="width:100%; border-collapse:collapse; margin-top:6px;">
            <thead><tr style="background:#f3f4f6;"><th style="${th}">From</th><th style="${th}">To</th><th style="${th} text-align:right;">Issue price</th></tr></thead>
            <tbody>${priceRows}</tbody>
        </table>
    </div>

    <div class="section">
        <div class="section-title">History — Nominal Value &amp; Registered Shares</div>
        <table style="width:100%; border-collapse:collapse; margin-top:6px;">
            <thead><tr style="background:#f3f4f6;"><th style="${th}">From</th><th style="${th}">To</th><th style="${th} text-align:right;">Nominal value</th><th style="${th} text-align:right;">Registered shares</th></tr></thead>
            <tbody>${nominalRows}</tbody>
        </table>
    </div>

    <p style="margin-top:24px; font-size:9.5px; color:#9ca3af; text-align:center; line-height:1.5;">
        This notice is issued to all shareholders for information and record. It was generated automatically when the change
        was approved and is kept in Documents for future reference.
    </p>

    ${footer()}
</div>
</body>
</html>`;
};

// ============================================================
// TAX DOCUMENTS (v1.70.0) — all auto-generated by the tax module and
// stored as documents rows (template_data.notice_kind):
//   WHT_CERTIFICATE  — Withholding Tax Deduction Certificate, one per
//                      withholding; in the payee's My Documents
//                      (owner_user_id). Updated with the PRN once paid.
//   WHT_AGENT_STATUS — notice to ALL members of a change in the
//                      company's withholding agent status.
//   TAX_COMPUTATION  — the approved corporate income tax computation.
// ============================================================
const taxMoney = (n, dp = 2) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp }));
const taxCell = 'padding:6px 8px; border-bottom:1px solid #e5e7eb; font-size:11px;';
const taxDoc = (title, reference, date, body) => `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>${title}</title>
    <style>${getBaseStyles()}</style>
</head>
<body>
<div class="page">
    ${letterhead(title, reference || '', date ? new Date(date) : new Date())}
    ${body}
    ${footer()}
</div>
</body>
</html>`;

export const whtCertificateTemplate = (data) => {
    const c = data.company || {};
    const cur = data.currency_code || '';
    const rem = data.remittance;
    return taxDoc('Withholding Tax Deduction Certificate', data.reference, data.generated_date, `
    <div class="doc-title">WITHHOLDING TAX DEDUCTION CERTIFICATE</div>
    <div class="doc-subtitle">${data.payment_label || ''}</div>
    <div class="meta-box cols-3">
        <div class="meta-item"><div class="meta-label">Withholding agent</div><div class="meta-value">${c.name || '—'}</div>
            <div style="font-size:10px;color:#6b7280;">TIN ${c.tin || '— (not set)'}${c.registration_number ? ` · Reg. ${c.registration_number}` : ''}</div></div>
        <div class="meta-item"><div class="meta-label">Payee</div><div class="meta-value">${data.payee?.name || '—'}</div>
            <div style="font-size:10px;color:#6b7280;">TIN ${data.payee?.tin || '— (not provided)'} · ${data.payee?.residency === 'NON_RESIDENT' ? 'Non-resident' : 'Resident'}</div></div>
        <div class="meta-item"><div class="meta-label">Date of deduction</div><div class="meta-value">${fmt.date(data.date)}</div></div>
    </div>
    <div class="section">
        <div class="section-title">The Deduction</div>
        <table style="width:100%; border-collapse:collapse; margin-top:6px;">
            <tbody>
                <tr><td style="${taxCell}">Gross amount of the payment</td><td style="${taxCell} text-align:right;">${cur} ${taxMoney(data.gross)}</td></tr>
                <tr><td style="${taxCell}">Rate${data.rate_name ? ` (${data.rate_name})` : ''}</td><td style="${taxCell} text-align:right;">${taxMoney(data.rate, 2)}%</td></tr>
                <tr><td style="${taxCell}"><strong>Tax withheld</strong></td><td style="${taxCell} text-align:right;"><strong>${cur} ${taxMoney(data.tax)}</strong></td></tr>
                <tr><td style="${taxCell}">Net amount paid to the payee</td><td style="${taxCell} text-align:right;">${cur} ${taxMoney(data.net)}</td></tr>
                ${cur !== data.functional_currency_code ? `<tr><td style="${taxCell}">Tax in ${data.functional_currency_code} (rate ${taxMoney(data.functional_rate, 4)})</td><td style="${taxCell} text-align:right;">${data.functional_currency_code} ${taxMoney(data.tax_functional)}</td></tr>` : ''}
            </tbody>
        </table>
    </div>
    <div class="section">
        <div class="section-title">Payment to the Uganda Revenue Authority</div>
        <p style="font-size:11px; color:#374151;">${data.status === 'REVERSED'
            ? '<strong>This deduction was reversed</strong> together with the payment it was taken from.'
            : rem
                ? `Paid to URA on <strong>${fmt.date(rem.paid_date)}</strong>${rem.prn ? `, PRN <strong>${rem.prn}</strong>` : ''} (${rem.reference || ''}).`
                : 'Not yet paid to URA. It is due by the 15th of the month after the deduction; this certificate is updated when it is paid.'}</p>
    </div>
    <p style="margin-top:24px; font-size:9.5px; color:#9ca3af; text-align:center; line-height:1.5;">
        Issued by the company's system as a record of tax deducted and paid on the payee's behalf. The payee may claim it against
        their own tax where the law allows (it is final tax for some payments). The official e-certificate can be obtained from the URA portal.
    </p>`);
};

export const whtAgentNoticeTemplate = (data) => {
    const c = data.company || {};
    const rows = (data.history || []).map(h => `<tr><td style="${taxCell}">${fmt.date(h.effective_date)}</td><td style="${taxCell}">${h.designated ? 'Designated' : 'Not designated'}</td></tr>`).join('');
    return taxDoc('Notice to Members', data.reference, data.generated_date, `
    <div class="doc-title">NOTICE TO MEMBERS</div>
    <div class="doc-subtitle">Withholding Tax Agent Status</div>
    <div class="meta-box cols-3">
        <div class="meta-item"><div class="meta-label">New status</div><div class="meta-value">${data.designated ? 'DESIGNATED' : 'NOT DESIGNATED'}</div></div>
        <div class="meta-item"><div class="meta-label">Effective from</div><div class="meta-value">${fmt.date(data.effective_date)}</div></div>
        <div class="meta-item"><div class="meta-label">Company TIN</div><div class="meta-value">${c.tin || '—'}</div></div>
    </div>
    <div class="section">
        <div class="section-title">What this means</div>
        <div style="font-size:12px; line-height:1.7; color:#374151;">
        ${data.designated
            ? `<p>The Uganda Revenue Authority has designated the company as a <strong>withholding tax agent</strong>. From ${fmt.date(data.effective_date)},
               6% is withheld from payments above UGX 1,000,000 for goods and services supplied to the company, paid to URA by the 15th of the following
               month, and a certificate is issued to each supplier.</p>`
            : `<p>With effect from ${fmt.date(data.effective_date)} the company is recorded as <strong>not</strong> a designated withholding tax agent. The 6%
               withholding on payments for goods and services continues to be <em>tracked</em> in the system for reference, but no money is held back.</p>`}
        <p>Nothing already recorded changes. Withholding tax on dividends, on interest paid to members and on payments to non-residents does not depend on
        this status and continues as before.</p>
        ${data.notes ? `<p><strong>Notes:</strong> ${data.notes}</p>` : ''}
        </div>
    </div>
    <div class="section">
        <div class="section-title">Recorded by</div>
        <p style="font-size:11px;">${data.changed_by?.name || '—'} (${data.changed_by?.capacity || ''}) on ${fmt.date(data.changed_by?.at)}</p>
    </div>
    <div class="section">
        <div class="section-title">History</div>
        <table style="width:100%; border-collapse:collapse; margin-top:6px;"><tbody>${rows}</tbody></table>
    </div>`);
};

export const taxComputationTemplate = (data) => {
    const w = data.worksheet || {};
    const y = w.year || {};
    const co = w.company || {};
    const line = (label, v, opts = {}) => `<tr><td style="${taxCell}${opts.indent ? ' padding-left:20px; color:#4b5563;' : ''}${opts.bold ? ' font-weight:700;' : ''}">${label}</td>
        <td style="${taxCell} text-align:right;${opts.bold ? ' font-weight:700;' : ''}">${opts.neg ? `(${taxMoney(v, 0)})` : taxMoney(v, 0)}</td></tr>`;
    const inc = (w.incomeStatement?.revenue || []).map(r => line(r.name, r.amount, { indent: true })).join('');
    const exp = (w.incomeStatement?.expenses || []).map(r => line(r.name, r.amount, { indent: true, neg: true })).join('');
    const adds = (w.addBacks || []).map(a => line(a.label, a.amount, { indent: true })).join('') || line('None', 0, { indent: true });
    const deds = (w.deductions || []).map(a => line(a.label, a.amount, { indent: true, neg: true })).join('') || line('None', 0, { indent: true });
    return taxDoc('Corporate Income Tax Computation', data.reference, data.generated_date, `
    <div class="doc-title">CORPORATE INCOME TAX COMPUTATION</div>
    <div class="doc-subtitle">${y.label || ''} — ${fmt.date(y.startDate)} to ${fmt.date(y.endDate)}</div>
    <div class="meta-box cols-3">
        <div class="meta-item"><div class="meta-label">Company</div><div class="meta-value">${co.name || '—'}</div><div style="font-size:10px;color:#6b7280;">TIN ${co.tin || '—'}</div></div>
        <div class="meta-item"><div class="meta-label">Prepared by</div><div class="meta-value">${data.prepared_by?.name || '—'}</div><div style="font-size:10px;color:#6b7280;">${fmt.date(data.prepared_by?.at)}</div></div>
        <div class="meta-item"><div class="meta-label">Approved by</div><div class="meta-value">${data.approved_by?.name || '—'}</div><div style="font-size:10px;color:#6b7280;">${fmt.date(data.approved_by?.at)}</div></div>
    </div>
    <div class="section"><div class="section-title">Profit before tax (from the books, ${w.currency || 'UGX'})</div>
        <table style="width:100%; border-collapse:collapse;"><tbody>
            ${inc}${line('Total income', w.incomeStatement?.totalRevenue, { bold: true })}
            ${exp}${line('Total expenses', w.incomeStatement?.totalExpenses, { bold: true, neg: true })}
            ${line('Profit / (loss) before tax', w.profitBeforeTax, { bold: true })}
        </tbody></table></div>
    <div class="section"><div class="section-title">Computation</div>
        <table style="width:100%; border-collapse:collapse;"><tbody>
            ${line('Profit / (loss) before tax', w.profitBeforeTax)}
            <tr><td colspan="2" style="${taxCell} font-weight:600; color:#6b7280;">Add back</td></tr>${adds}
            <tr><td colspan="2" style="${taxCell} font-weight:600; color:#6b7280;">Deduct</td></tr>${deds}
            ${line('Chargeable income / (loss)', w.chargeableIncome, { bold: true })}
            ${line(`Loss brought forward used (of ${taxMoney(w.lossBroughtForward, 0)})`, w.lossUtilised, { indent: true, neg: true })}
            ${line('Taxable income', w.taxableIncome, { bold: true })}
            ${line(`Tax at ${w.taxRate}%`, w.grossTax, { bold: true })}
            ${line('Less: creditable withholding tax', w.totalWhtCredits, { indent: true, neg: true })}
            ${line('Less: provisional tax paid', w.provisionalPaid, { indent: true, neg: true })}
            ${line(w.balanceDue >= 0 ? 'Balance of tax payable' : 'Tax overpaid (refundable)', Math.abs(w.balanceDue || 0), { bold: true })}
            ${line('Loss carried forward', w.lossCarriedForward)}
        </tbody></table></div>
    <p style="font-size:10px;color:#6b7280;">Return and balance due by ${fmt.date(w.deadlines?.returnDue)}. ${(w.warnings || []).map(x => `<br/>⚠ ${x}`).join('')}</p>`);
};

// ============================================================
// PAYMENT ACKNOWLEDGEMENT TEMPLATE (v1.30.0, Section 4.35)
// A two-party printable record for money paid OUT to an individual
// (dividends, service fee payments, expense reimbursements) — the
// mirror image of receiptTemplate above (which is money coming IN to
// the company). Both the payer (Treasury/Director) and the recipient
// are named, and the document trail shows all three steps: disbursed,
// acknowledged by the recipient, and finally approved.
//
// `data` shape (matches paymentAcknowledgementsController's
// getAcknowledgementById response):
//   { reference, public_id, source_label, amount, currency_code,
//     purpose, status, payer_name, recipient_name, created_at,
//     acknowledged_at, acknowledgement_note, final_approver_name,
//     final_approved_at }
// ============================================================
export const paymentAcknowledgementTemplate = (data) => `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Payment Acknowledgement</title>
    <style>${getBaseStyles()}</style>
</head>
<body>
<div class="page">
    ${letterhead('Payment Acknowledgement', data.reference || '', new Date())}
    <div class="doc-title">PAYMENT ACKNOWLEDGEMENT</div>
    <div class="doc-subtitle">${data.source_label || ''}</div>

    <div class="meta-box cols-3">
        <div class="meta-item">
            <div class="meta-label">Paid By</div>
            <div class="meta-value">${data.payer_name || '—'}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Amount</div>
            <div class="meta-value large green">
                ${data.currency_code || ''} ${fmt.amount(data.amount)}
            </div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Received By</div>
            <div class="meta-value">${data.recipient_name || '—'}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Payment Date</div>
            <div class="meta-value">${fmt.date(data.created_at)}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Status</div>
            <div class="meta-value">${(data.status || '').replace(/_/g, ' ')}</div>
        </div>
    </div>

    <div class="section">
        <div class="section-title">Purpose</div>
        <p style="font-size:12px;line-height:1.7;">${data.purpose || '—'}</p>
    </div>

    ${data.acknowledgement_note ? `
    <div class="section">
        <div class="section-title">Recipient's Note</div>
        <p style="font-size:11px;color:#6b7280;line-height:1.7;">${data.acknowledgement_note}</p>
    </div>` : ''}

    ${documentTrail([
        { role: 'Disbursed By',       name: data.payer_name,           date: data.created_at },
        { role: 'Acknowledged By',    name: data.recipient_name,       date: data.acknowledged_at },
        { role: 'Final Approved By',  name: data.final_approver_name,  date: data.final_approved_at },
    ])}

    <div class="signature-section">
        <div class="signature-block">
            Paid By: ${data.payer_name || '_______________'}<br>
            Signature: _______________<br>
            Date: _______________
        </div>
        <div class="signature-block">
            Received By: ${data.recipient_name || '_______________'}<br>
            Signature: _______________<br>
            Date: _______________
        </div>
    </div>

    ${footer()}
</div>
</body>
</html>`;

// ============================================================
// BOARD RESOLUTION TEMPLATE
// A formal resolution passed at a Board/Directors/AGM meeting —
// structured similarly to meetingMinutesTemplate (numbered items,
// Chairperson/Secretary sign-off) since resolutions follow the same
// governance convention, but focused on the resolved clause(s) and
// vote outcome rather than a full discussion record.
// ============================================================
export const resolutionTemplate = (data) => `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Board Resolution</title>
    <style>${getBaseStyles()}
    .resolution-item { margin-bottom:14px; padding:14px;
        background:#f9fafb; border-left:4px solid ${PRIMARY_COLOR};
        border-radius:0 6px 6px 0; font-size:11px; line-height:1.7;
        color:#374151; }
    .resolution-item strong { color:${PRIMARY_COLOR}; }
    </style>
</head>
<body>
<div class="page">
    ${letterhead('Board Resolution', data.reference || '', new Date())}
    <div class="doc-title">RESOLUTION</div>
    <div class="doc-subtitle">${data.resolution_title || ''}</div>

    <div class="meta-box cols-3">
        <div class="meta-item">
            <div class="meta-label">Meeting</div>
            <div class="meta-value">${data.meeting_type || '—'}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Meeting Date</div>
            <div class="meta-value">${fmt.date(data.meeting_date)}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Resolution Date</div>
            <div class="meta-value">${fmt.date(data.resolution_date)}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Proposed By</div>
            <div class="meta-value">${data.proposed_by || '—'}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Seconded By</div>
            <div class="meta-value">${data.seconded_by || '—'}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Outcome</div>
            <div class="meta-value green">${data.vote_result || '—'}</div>
        </div>
    </div>

    <div class="section">
        <div class="section-title">Resolved</div>
        ${(data.resolution_clauses || []).map(item => `
        <div class="resolution-item">
            <strong>${item.number}.</strong> RESOLVED THAT ${item.text}
        </div>`).join('')}
    </div>

    ${data.additional_notes ? `
    <div class="section">
        <div class="section-title">Additional Notes</div>
        <p style="font-size:11px;color:#6b7280;line-height:1.7;">${data.additional_notes}</p>
    </div>` : ''}

    ${documentTrail([
        { role: 'Proposed By', name: data.proposed_by, date: data.meeting_date },
        { role: 'Seconded By', name: data.seconded_by, date: data.meeting_date },
        { role: 'Prepared By', name: data.prepared_by, date: data.generated_date },
    ])}

    <div class="stamp-overlay-wrap">
        <div class="signature-section">
            ${signatureBlock(data, 'Chairperson', personName(data, 'chairperson'), 'Chairman')}
            ${signatureBlock(data, 'Secretary', personName(data, 'secretary'), 'Secretary')}
        </div>
        ${stampOverlay(data)}
    </div>

    ${footer()}
</div>
</body>
</html>`;

// ============================================================
// MEMBER PORTFOLIO SUMMARY TEMPLATE (v1.34.0)
// The printable/document-type render of the Member Portfolio page
// (usersAPI.getPortfolio) — everything about one member's standing
// in the company: shareholding, contributions, savings, dividends
// received, side fund standing, payments received, and recent
// transactions. `data` is the portfolio object as returned by
// GET /users/:id/portfolio, plus the standard generated_date/
// prepared_by fields every generated document carries.
// ============================================================
export const memberPortfolioTemplate = (data) => {
    const p = data.profile || {};
    const s = data.summary || {};
    const sh = data.shareholding || {};
    const sv = data.savings || {};
    const dv = data.dividends || {};
    const sf = data.sideFund || {};
    const pay = data.payments || {};
    const tx = data.transactionsInvolved || {};

    const contributionRows = (sh.contributions || []).slice(0, 30).map(c => `
        <tr>
            <td>${fmt.date(c.contribution_date)}</td>
            <td>${c.reference_code || '—'}</td>
            <td>${c.account_name || '—'}</td>
            <td>${c.category_name || '—'}</td>
            <td style="text-align:right;">${c.currency_code} ${fmt.amount(c.amount)}</td>
            <td>${c.status}</td>
        </tr>`).join('');

    const duesRows = (sf.dues || []).slice(0, 24).map(d => `
        <tr>
            <td>${d.period}</td>
            <td style="text-align:right;">${fmt.amount(d.amount_due)}</td>
            <td style="text-align:right;">${fmt.amount(d.amount_paid)}</td>
            <td>${d.status}</td>
        </tr>`).join('');

    const dividendRows = (dv.distributions || []).map(d => `
        <tr>
            <td>${d.period_label || fmt.date(d.declaration_date)}</td>
            <td style="text-align:right;">${d.currency_code} ${fmt.amount(d.credited_amount || d.amount)}</td>
            <td>${d.status}</td>
            <td>${d.paid_at ? fmt.date(d.paid_at) : '—'}</td>
        </tr>`).join('');

    const paymentRows = (pay.payments || []).slice(0, 30).map(pp => `
        <tr>
            <td>${pp.source_type.replace(/_/g, ' ')}</td>
            <td style="text-align:right;">${pp.currency_code} ${fmt.amount(pp.amount)}</td>
            <td>${pp.status.replace(/_/g, ' ')}</td>
            <td>${fmt.date(pp.created_at)}</td>
        </tr>`).join('');

    const txRows = (tx.transactions || []).slice(0, 40).map(t => {
        const roles = [
            t.as_beneficiary && 'Beneficiary',
            t.as_creator && 'Recorded By',
            t.as_approver && 'Approved By',
        ].filter(Boolean).join(', ');
        return `
        <tr>
            <td>${fmt.date(t.value_date)}</td>
            <td>${t.reference_code || '—'}</td>
            <td>${(t.description || '').slice(0, 60)}</td>
            <td style="text-align:right;">${t.currency_code} ${fmt.amount(t.amount)}</td>
            <td>${roles}</td>
        </tr>`;
    }).join('');

    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Member Portfolio Summary</title>
    <style>${getBaseStyles()}</style>
</head>
<body>
<div class="page">
    ${letterhead('Member Portfolio Summary', data.reference || '', new Date())}
    <div class="doc-title">MEMBER PORTFOLIO SUMMARY</div>
    <div class="doc-subtitle">${p.first_name || ''} ${p.last_name || ''}</div>

    <div class="meta-box cols-4">
        <div class="meta-item">
            <div class="meta-label">Member Since</div>
            <div class="meta-value">${fmt.date(s.memberSince)}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Roles</div>
            <div class="meta-value">${(s.roles || []).join(', ') || '—'}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Status</div>
            <div class="meta-value">${p.is_active ? 'Active' : 'Inactive'}${p.is_email_verified ? '' : ' — Unverified'}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Email</div>
            <div class="meta-value">${p.email || '—'}</div>
        </div>
    </div>

    <div class="meta-box cols-4">
        <div class="meta-item">
            <div class="meta-label">Shares Held</div>
            <div class="meta-value large">${fmt.num(s.sharesHeld)}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Shareholding %</div>
            <div class="meta-value large">${fmt.num(s.percentage)}%</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Current Value</div>
            <div class="meta-value large green">
                ${sh.currentPrice ? `${sh.currentPrice.currency_code} ${fmt.amount(s.currentValue)}` : '—'}
            </div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Total Contributed (Approved)</div>
            <div class="meta-value large">${fmt.amount(s.totalContributed)}</div>
        </div>
    </div>

    <div class="meta-box cols-3">
        <div class="meta-item">
            <div class="meta-label">Savings Balance</div>
            <div class="meta-value">${sv.currencyCode || ''} ${fmt.amount(s.savingsBalance)}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Dividends Received (All-Time)</div>
            <div class="meta-value">${fmt.amount(s.dividendsReceived)}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Side Fund</div>
            <div class="meta-value">
                ${s.sideFundIn ? 'Member' : 'Not a member'}
                ${s.sideFundOverdue > 0 ? `<span style="color:#dc2626;"> — Overdue ${fmt.amount(s.sideFundOverdue)}</span>` : ''}
            </div>
        </div>
    </div>

    <div class="section">
        <div class="section-title">Contribution History</div>
        <table>
            <thead>
                <tr>
                    <th>Date</th><th>Reference</th><th>Account</th>
                    <th>Category</th><th style="text-align:right;">Amount</th><th>Status</th>
                </tr>
            </thead>
            <tbody>${contributionRows || '<tr><td colspan="6" style="text-align:center;">No contributions on record</td></tr>'}</tbody>
        </table>
    </div>

    ${(sf.dues || []).length > 0 ? `
    <div class="section">
        <div class="section-title">Side Fund Dues History</div>
        <table>
            <thead>
                <tr><th>Period</th><th style="text-align:right;">Due</th><th style="text-align:right;">Paid</th><th>Status</th></tr>
            </thead>
            <tbody>${duesRows}</tbody>
        </table>
    </div>` : ''}

    ${(dv.distributions || []).length > 0 ? `
    <div class="section">
        <div class="section-title">Dividends Received</div>
        <table>
            <thead>
                <tr><th>Period</th><th style="text-align:right;">Amount</th><th>Status</th><th>Paid Date</th></tr>
            </thead>
            <tbody>${dividendRows}</tbody>
        </table>
    </div>` : ''}

    ${(pay.payments || []).length > 0 ? `
    <div class="section">
        <div class="section-title">Payments Received (All Types)</div>
        <table>
            <thead>
                <tr><th>Type</th><th style="text-align:right;">Amount</th><th>Status</th><th>Date</th></tr>
            </thead>
            <tbody>${paymentRows}</tbody>
        </table>
    </div>` : ''}

    <div class="section">
        <div class="section-title">
            Transactions Involved In ${tx.totalCount ? `(${tx.totalCount} total, most recent shown)` : ''}
        </div>
        <table>
            <thead>
                <tr><th>Date</th><th>Reference</th><th>Description</th><th style="text-align:right;">Amount</th><th>Role</th></tr>
            </thead>
            <tbody>${txRows || '<tr><td colspan="5" style="text-align:center;">No transactions on record</td></tr>'}</tbody>
        </table>
    </div>

    ${documentTrail([
        { role: 'Prepared By', name: data.prepared_by, date: data.generated_date },
    ])}

    ${footer()}
</div>
</body>
</html>`;
};

// ============================================================
// CERTIFICATE OF SHARES TEMPLATE
// Same format for both MONTHLY and ANNUAL — only the label and
// period shown differ. `data` is the response from downloading a
// certificate (certificatesAPI.issue — v1.65.0: now always the most
// recently SIGNED batch certificate, never a fresh live one; see
// certificateService.getLatestSignedCertificate): reference_code,
// user, shares_held, percentage, price_per_share, currency_code/
// symbol, share_value, certificate_type, period_label, issued_at,
// as_of_date, signatures, stamps.
//
// v1.65.0 — `data.signatures` (getSignatureStatus's own shape, same
// as the server-side Puppeteer renderer certificateService.
// renderCertificateHtml already used for the emailed PDF) is now
// rendered as real signature images here too, dynamically by however
// many roles were actually configured — replacing the old always-
// blank "Company Secretary / Treasurer / Director" placeholder lines,
// which never reflected whether anyone had actually signed. Falls
// back to those same three blank labels only when no signatures are
// supplied at all (shouldn't happen via the on-demand download path
// any more, since that path now refuses to return an unsigned
// certificate).
// ============================================================
export const shareCertificateTemplate = (data) => {
    const label = data.certificate_type === 'ANNUAL' ? 'Annual' : 'Monthly';
    const periodDisplay = data.certificate_type === 'ANNUAL'
        ? data.period_label
        : `${String(data.period_label).slice(0, 4)}-${String(data.period_label).slice(4, 6)}`;
    const shareValueDisplay = data.share_value != null
        ? `${data.currency_symbol || data.currency_code || ''} ${fmt.amount(data.share_value)}`
        : '—';
    const asOfDisplay = data.as_of_date ? fmt.date(data.as_of_date) : null;

    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Certificate of Shares</title>
    <style>${getBaseStyles()}
    .cert-statement { font-size: 13px; line-height: 2; color: #1f2937; margin: 24px 0; text-align: center; }
    </style>
</head>
<body>
<div class="page">
    ${letterhead('Certificate of Shares', data.reference_code, data.issued_at || new Date())}

    <div class="doc-title" style="text-align:center;">CERTIFICATE OF SHARES</div>
    <div class="doc-subtitle" style="text-align:center;">${label} Certificate — ${periodDisplay}</div>

    <p class="cert-statement">
        This is to certify that <strong>${data.user?.first_name || ''} ${data.user?.last_name || ''}</strong>
        is the registered holder of <strong>${fmt.num(data.shares_held)}</strong> shares of
        <strong>${COMPANY_NAME}</strong>, representing
        <strong>${data.percentage != null ? fmt.num(data.percentage) : '—'}%</strong>
        of the total issued shares, as recorded in the company's shareholding register${asOfDisplay ? ` as of ${asOfDisplay}` : ''}.
    </p>

    <div class="meta-box cols-3">
        <div class="meta-item">
            <div class="meta-label">Shares Held</div>
            <div class="meta-value large">${fmt.num(data.shares_held)}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Percentage of Issued Shares</div>
            <div class="meta-value large">${data.percentage != null ? fmt.num(data.percentage) : '—'}%</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Share Value</div>
            <div class="meta-value large">${shareValueDisplay}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Price Per Share</div>
            <div class="meta-value">${data.price_per_share != null
                ? `${data.currency_symbol || data.currency_code || ''} ${fmt.amount(data.price_per_share)}`
                : '—'}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Certificate Type</div>
            <div class="meta-value">${label}</div>
        </div>
        ${asOfDisplay ? `
        <div class="meta-item">
            <div class="meta-label">Shareholding As Of</div>
            <div class="meta-value">${asOfDisplay}</div>
        </div>` : ''}
        <div class="meta-item">
            <div class="meta-label">Date Issued</div>
            <div class="meta-value">${fmt.date(data.issued_at || new Date())}</div>
        </div>
    </div>

    <div class="stamp-overlay-wrap">
        <div class="signature-section">
            ${(data.signatures && data.signatures.length > 0)
                ? data.signatures.map(sig => `
                    <div class="signature-block">
                        ${sig.status === 'SIGNED' && sig.signature_url
                            ? `<img src="${resolveUploadUrl(sig.signature_url)}" alt="Signature" style="height:32px;display:block;margin:0 auto 4px;" />`
                            : ''}
                        ${sig.role_name}
                        ${sig.signer_name ? `<br><span style="font-size:10px;">${sig.signer_name}</span>` : ''}
                    </div>`).join('')
                : `
                    <div class="signature-block">Company Secretary</div>
                    <div class="signature-block">Treasurer</div>
                    <div class="signature-block">Director</div>`
            }
        </div>
        ${stampOverlay(data)}
    </div>

    <p class="confidential">
        This certificate is issued for record-keeping and transparency purposes based on the
        company's internal shareholding register as of the date above. It does not, of itself,
        constitute a negotiable or transferable instrument.
    </p>

    ${footer()}
</div>
</body>
</html>`;
};

// ============================================================
// SYSTEM MANUAL TEMPLATE
// Compiles the full About page (manual steps, module guide, role
// guide) into one printable/downloadable document with the same
// letterhead as every other export — used by the "Download Manual"
// button on the About page.
// ============================================================
export const systemManualTemplate = ({ steps = [], modules = [], roles = [] } = {}) => `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>System Manual</title>
    <style>${getBaseStyles()}
    .manual-step { display:flex; gap:14px; padding:12px 0;
        border-bottom:1px dotted #e5e7eb; }
    .manual-step:last-child { border-bottom:none; }
    .step-num { flex-shrink:0; width:26px; height:26px; border-radius:50%;
        background:${PRIMARY_COLOR}; color:white; font-size:12px; font-weight:700;
        display:flex; align-items:center; justify-content:center; }
    .module-row { padding:10px 0; border-bottom:1px dotted #e5e7eb; }
    .module-row:last-child { border-bottom:none; }
    .module-name { font-weight:700; color:${PRIMARY_COLOR}; font-size:11px;
        text-transform:uppercase; letter-spacing:0.5px; margin-bottom:3px; }
    .toc { background:#f8fafc; border:1px solid #e5e7eb; border-radius:8px;
        padding:16px 20px; margin-bottom:24px; }
    .toc-title { font-size:10px; font-weight:700; color:#9ca3af;
        text-transform:uppercase; letter-spacing:0.5px; margin-bottom:8px; }
    .toc ol { margin-left:18px; font-size:11px; color:#374151; line-height:1.9; }
    </style>
</head>
<body>
<div class="page">
    ${letterhead('System Manual', '', new Date())}
    <div class="doc-title">System Manual</div>
    <div class="doc-subtitle">A complete guide to using ${COMPANY_NAME}'s company management system</div>

    <div class="toc">
        <div class="toc-title">Contents</div>
        <ol>
            <li>Getting Started &amp; Step-by-Step Guide</li>
            <li>Module-by-Module Guide</li>
            <li>Role Guide — who can do what</li>
        </ol>
    </div>

    <div class="section">
        <div class="section-title">1. Getting Started &amp; Step-by-Step Guide</div>
        ${steps.map(item => `
        <div class="manual-step">
            <div class="step-num">${item.step}</div>
            <div>
                <strong style="font-size:12px;">${item.title}</strong>
                <p style="margin-top:4px;color:#374151;font-size:11px;line-height:1.6;">
                    ${item.content}
                </p>
            </div>
        </div>`).join('')}
    </div>

    <div class="section">
        <div class="section-title">2. Module-by-Module Guide</div>
        ${modules.map(item => `
        <div class="module-row">
            <div class="module-name">${item.module}</div>
            <p style="font-size:11px;color:#374151;line-height:1.6;">${item.description}</p>
        </div>`).join('')}
    </div>

    <div class="section">
        <div class="section-title">3. Role Guide</div>
        <table>
            <thead>
                <tr><th>Role</th><th>Description</th><th>Typical Permissions</th></tr>
            </thead>
            <tbody>
                ${roles.map(r => `
                <tr>
                    <td class="font-bold">${r.role}</td>
                    <td>${r.description}</td>
                    <td>${r.permissions.join(', ')}</td>
                </tr>`).join('')}
            </tbody>
        </table>
    </div>

    ${footer()}
</div>
</body>
</html>`;

// ============================================================
// EXTERNAL AUDIT SUMMARY TEMPLATE
// One self-contained document for an external auditor to download:
// engagement details, an opening/closing balance summary per
// account, a breakdown by category, and the full transaction ledger
// for the audited period — everything already scoped server-side to
// what that auditor's engagement grants, so nothing extra needs
// filtering here.
// ============================================================
export const auditSummaryTemplate = (data) => {
    const { engagement, accounts = [], categories = [], transactions = [] } = data;

    const totalIn = transactions
        .filter(t => t.transaction_type === 'CREDIT' || t.transaction_type === 'REVERSAL_CREDIT')
        .reduce((s, t) => s + parseFloat(t.amount || 0), 0);
    const totalOut = transactions
        .filter(t => t.transaction_type === 'DEBIT' || t.transaction_type === 'REVERSAL_DEBIT')
        .reduce((s, t) => s + parseFloat(t.amount || 0), 0);

    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Audit Summary — ${engagement.name}</title>
    <style>${getBaseStyles()}</style>
</head>
<body>
<div class="page">
    ${letterhead('External Audit Summary', engagement.name, new Date())}
    <div class="doc-title">External Audit Summary</div>
    <div class="doc-subtitle">
        ${engagement.name} — Period: ${fmt.date(engagement.period_start)} to ${fmt.date(engagement.period_end)}
    </div>

    <div class="meta-box cols-3">
        <div class="meta-item">
            <div class="meta-label">Accounts in Scope</div>
            <div class="meta-value large">${accounts.length}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Total In</div>
            <div class="meta-value large green">+${fmt.amount(totalIn)}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Total Out</div>
            <div class="meta-value large red">-${fmt.amount(totalOut)}</div>
        </div>
    </div>

    <div class="section">
        <div class="section-title">Account Summary</div>
        <table>
            <thead>
                <tr>
                    <th>Account</th>
                    <th>Opening Balance</th>
                    <th>Total In</th>
                    <th>Total Out</th>
                    <th>Closing Balance</th>
                    <th class="text-right">Transactions</th>
                </tr>
            </thead>
            <tbody>
                ${accounts.map(a => `
                <tr>
                    <td>${a.name} <span class="text-gray">(${a.account_type})</span></td>
                    <td>${a.currency_code} ${a.opening_balance != null ? fmt.amount(a.opening_balance) : '—'}</td>
                    <td class="text-green">+${fmt.amount(a.total_in)}</td>
                    <td class="text-red">-${fmt.amount(a.total_out)}</td>
                    <td>${a.currency_code} ${a.closing_balance != null ? fmt.amount(a.closing_balance) : '—'}</td>
                    <td class="text-right">${a.transaction_count}</td>
                </tr>`).join('')}
            </tbody>
        </table>
    </div>

    ${categories.length > 0 ? `
    <div class="section">
        <div class="section-title">Breakdown by Category</div>
        <table>
            <thead>
                <tr>
                    <th>Category</th>
                    <th class="text-right">Total In</th>
                    <th class="text-right">Total Out</th>
                    <th class="text-right">Transactions</th>
                </tr>
            </thead>
            <tbody>
                ${categories.map(c => `
                <tr>
                    <td>${c.category_trail || c.category_name}</td>
                    <td class="text-right text-green">+${fmt.amount(c.total_in)}</td>
                    <td class="text-right text-red">-${fmt.amount(c.total_out)}</td>
                    <td class="text-right">${c.transaction_count}</td>
                </tr>`).join('')}
            </tbody>
        </table>
    </div>` : ''}

    <div class="section">
        <div class="section-title">Full Transaction Ledger (${transactions.length} records)</div>
        <table>
            <thead>
                <tr>
                    <th>Reference</th>
                    <th>Account</th>
                    <th>Description</th>
                    <th>Category</th>
                    <th>Date</th>
                    <th class="text-right">Amount</th>
                    <th class="text-right">Balance After</th>
                </tr>
            </thead>
            <tbody>
                ${transactions.map(t => {
                    const isCredit = t.transaction_type === 'CREDIT' || t.transaction_type === 'REVERSAL_CREDIT';
                    return `
                    <tr>
                        <td class="font-mono text-blue">${t.reference_code}</td>
                        <td>${t.account_name}</td>
                        <td>${t.description || '—'}</td>
                        <td class="text-gray">${t.category_trail || t.category_name || '—'}</td>
                        <td>${fmt.date(t.value_date)}</td>
                        <td class="text-right font-bold ${isCredit ? 'text-green' : 'text-red'}">
                            ${isCredit ? '+' : '-'}${t.currency_code} ${fmt.amount(t.amount)}
                        </td>
                        <td class="text-right">${t.currency_code} ${fmt.amount(t.balance_after)}</td>
                    </tr>`;
                }).join('')}
                ${transactions.length > 0 ? `
                <tr class="total-row">
                    <td colspan="5">TOTALS</td>
                    <td class="text-right">
                        <span class="text-green">+${fmt.amount(totalIn)}</span> /
                        <span class="text-red">-${fmt.amount(totalOut)}</span>
                    </td>
                    <td></td>
                </tr>` : ''}
            </tbody>
        </table>
    </div>

    ${footer()}
</div>
</body>
</html>`;
};

// ============================================================
// AUDITOR FEEDBACK TEMPLATE
// SYSTEM_GENERATED — created once by approveSubmission() the moment
// both a Director and Secretary have signed off (see auditController.js
// finalize step). `data` is the documents.template_data payload that
// gets persisted then, and re-rendered here on every subsequent
// preview/download — same pattern as every other generated document.
// ============================================================
export const auditorFeedbackTemplate = (data) => {
    const comments = data.comments || [];
    const files     = data.files || [];

    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Auditor Feedback — ${data.engagement_name || ''}</title>
    <style>${getBaseStyles()}
    .comment-item { margin-bottom:12px; padding:12px 14px;
        background:#f9fafb; border-left:4px solid ${PRIMARY_COLOR};
        border-radius:0 6px 6px 0; font-size:11px; line-height:1.6;
        color:#374151; }
    .comment-date { font-size:9px; color:#9ca3af; margin-bottom:4px; }
    </style>
</head>
<body>
<div class="page">
    ${letterhead('Auditor Feedback', data.reference_code || '', new Date())}
    <div class="doc-title">AUDITOR FEEDBACK</div>
    <div class="doc-subtitle">${data.engagement_name || ''}</div>

    <div class="meta-box cols-3">
        <div class="meta-item">
            <div class="meta-label">Auditor</div>
            <div class="meta-value">${data.auditor_name || '—'}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Auditing Firm</div>
            <div class="meta-value">${data.auditor_company || '—'} (${data.auditor_initials || '—'})</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Contact</div>
            <div class="meta-value">${data.auditor_phone || '—'}<br>${data.auditor_email || '—'}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Submitted</div>
            <div class="meta-value">${fmt.date(data.submitted_at)}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Director Approval</div>
            <div class="meta-value green">${fmt.date(data.director_approved_at)}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Secretary Approval</div>
            <div class="meta-value green">${fmt.date(data.secretary_approved_at)}</div>
        </div>
    </div>

    <div class="section">
        <div class="section-title">Auditor Comments</div>
        ${comments.length === 0
            ? '<p style="font-size:11px;color:#9ca3af;">No comments were recorded.</p>'
            : comments.map(c => `
        <div class="comment-item">
            <div class="comment-date">${fmt.date(c.created_at)}</div>
            ${c.comment_text}
        </div>`).join('')}
    </div>

    <div class="section">
        <div class="section-title">Accompanying Report Files</div>
        ${files.length === 0
            ? '<p style="font-size:11px;color:#9ca3af;">No files were attached.</p>'
            : `<table>
                <thead><tr><th>File Name</th></tr></thead>
                <tbody>${files.map(f => `<tr><td>${f.file_name}</td></tr>`).join('')}</tbody>
            </table>`}
    </div>

    ${documentTrail([
        { role: 'Submitted By', name: data.auditor_name, date: data.submitted_at },
    ])}

    ${footer()}
</div>
</body>
</html>`;
};

// ============================================================
// SERVICE FEE AGREEMENT STATEMENT (v1.47.0)
// Downloadable/printable summary for a single service fee agreement's
// detail page — mirrors loanTemplate's shape: recipient details,
// agreement terms, the full payment history, and (new) the amendment
// history with each change's effective date and reason, so a reader
// sees exactly when and why the monthly amount ever changed without
// needing the amount ever being silently overwritten.
// ============================================================
export const serviceFeeAgreementTemplate = (agreement, payments = [], amendments = []) => {
    const totalPaid = payments.reduce((s, p) => s + parseFloat(p.amount || 0), 0);

    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Service Fee Agreement Statement</title>
    <style>${getBaseStyles()}</style>
</head>
<body>
<div class="page">
    ${letterhead('Service Fee Agreement Statement', `AGR-${agreement.id}`, new Date())}

    <div class="doc-title">Service Fee Agreement Statement</div>
    <div class="doc-subtitle">Contracted Person: ${agreement.user_name}</div>

    <div class="meta-box cols-4">
        <div class="meta-item">
            <div class="meta-label">Contracted Person</div>
            <div class="meta-value">${agreement.user_name}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Status</div>
            <div class="meta-value">${badge(agreement.status)}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Current Monthly Amount</div>
            <div class="meta-value large">
                ${agreement.currency_code} ${fmt.amount(agreement.monthly_amount)}
            </div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Total Paid To Date</div>
            <div class="meta-value large green">
                ${agreement.currency_code} ${fmt.amount(totalPaid)}
            </div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Paying Account</div>
            <div class="meta-value">${agreement.account_name || '—'}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Start Date</div>
            <div class="meta-value">${fmt.date(agreement.start_date)}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">End Date</div>
            <div class="meta-value">${agreement.end_date ? fmt.date(agreement.end_date) : '—'}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Notes</div>
            <div class="meta-value">${agreement.notes || '—'}</div>
        </div>
    </div>

    ${payments.length > 0 ? `
    <div class="section">
        <div class="section-title">Payment History</div>
        <table>
            <thead>
                <tr>
                    <th>#</th>
                    <th>Date</th>
                    <th>Reference</th>
                    <th class="text-right">Amount</th>
                    <th>Paid By</th>
                </tr>
            </thead>
            <tbody>
                ${payments.map((p, i) => `
                <tr>
                    <td>${i + 1}</td>
                    <td>${fmt.date(p.payment_date)}</td>
                    <td class="font-mono">${p.reference_code || '—'}</td>
                    <td class="text-right font-bold text-green">
                        ${agreement.currency_code} ${fmt.amount(p.amount)}
                    </td>
                    <td class="text-gray">${p.paid_by_name || '—'}</td>
                </tr>`).join('')}
                <tr class="total-row">
                    <td colspan="3">TOTAL PAID</td>
                    <td class="text-right text-green">
                        ${agreement.currency_code} ${fmt.amount(totalPaid)}
                    </td>
                    <td></td>
                </tr>
            </tbody>
        </table>
    </div>
    ` : '<p style="color:#9ca3af;font-size:11px;">No payments recorded yet.</p>'}

    ${amendments.length > 0 ? `
    <div class="section">
        <div class="section-title">Monthly Amount Change History</div>
        <table>
            <thead>
                <tr>
                    <th>Effective From</th>
                    <th class="text-right">Previous Amount</th>
                    <th class="text-right">New Amount</th>
                    <th>Reason</th>
                    <th>Amended By</th>
                </tr>
            </thead>
            <tbody>
                ${amendments.map(a => `
                <tr>
                    <td>${fmt.date(a.effective_from)}</td>
                    <td class="text-right">${agreement.currency_code} ${fmt.amount(a.previous_amount)}</td>
                    <td class="text-right font-bold">${agreement.currency_code} ${fmt.amount(a.new_amount)}</td>
                    <td class="text-gray">${a.reason || '—'}</td>
                    <td class="text-gray">${a.amended_by_name || '—'}</td>
                </tr>`).join('')}
            </tbody>
        </table>
    </div>
    ` : ''}

    ${documentTrail([
        { role: 'Created By', name: agreement.created_by_name, date: agreement.created_at },
    ])}

    ${footer()}
</div>
</body>
</html>`;
};

// ============================================================
// PRINT / EXPORT FUNCTION
// Opens document in new tab and triggers print dialog
// ============================================================
export const printDocument = (html, title = 'Document') => {
    const win = window.open('', '_blank');
    if (!win) {
        alert('Please allow popups for this site to export documents.');
        return;
    }
    win.document.title = title;
    win.document.write(html);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 800);
};

// ============================================================
// PREVIEW FUNCTION
// Same as printDocument but does NOT auto-trigger the print
// dialog — just opens the rendered document in a new tab for the
// user to look at. They can still print/save as PDF from there
// (Ctrl/Cmd+P) whenever they want.
// ============================================================
export const previewDocument = (html, title = 'Document') => {
    const win = window.open('', '_blank');
    if (!win) {
        alert('Please allow popups for this site to preview documents.');
        return;
    }
    win.document.title = title;
    win.document.write(html);
    win.document.close();
    win.focus();
};

// ============================================================
// DOWNLOAD BLOB (v1.50.0)
// Triggers a browser download for a Blob already fetched via axios
// with `responseType: 'blob'` (same pattern documentsAPI.download
// already uses) — used by the new Transactions/Transfers CSV
// exports. A transient off-screen <a download> is the standard way
// to do this without navigating the page away.
// ============================================================
export const downloadBlob = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
};