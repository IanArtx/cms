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
    date: (d) => d ? new Date(d).toLocaleDateString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric'
    }) : '—',
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
    return data.stamps.map(stamp =>
        `<img class="stamp-overlay" src="${stamp.file_path}" alt="${stamp.name || 'Company stamp'}" />`
    ).join('');
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
            <div class="meta-value">${data.chairperson || '—'}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Secretary</div>
            <div class="meta-value">${data.secretary || '—'}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Expected Attendees</div>
            <div class="meta-value">${data.attendees || '—'}</div>
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
        { role: 'Chairperson', name: data.chairperson, date: data.meeting_date },
        { role: 'Secretary',   name: data.secretary,   date: data.meeting_date },
        { role: 'Prepared By', name: data.prepared_by, date: data.generated_date },
    ])}

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
            <div class="meta-value">${data.chairperson || '—'}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Secretary</div>
            <div class="meta-value">${data.secretary || '—'}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Present</div>
            <div class="meta-value">${data.present || '—'}</div>
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
        { role: 'Chairperson', name: data.chairperson,  date: data.meeting_date },
        { role: 'Secretary',   name: data.secretary,    date: data.meeting_date },
        { role: 'Prepared By', name: data.prepared_by,  date: data.generated_date },
    ])}

    <div class="signature-section">
        <div class="signature-block">
            Chairperson: ${data.chairperson || '_______________'}<br>
            Signature: _______________<br>
            Date: _______________
        </div>
        <div class="signature-block">
            Secretary: ${data.secretary || '_______________'}<br>
            Signature: _______________<br>
            Date: _______________
        </div>
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
            <div class="signature-block">
                Chairperson: ${data.chairperson || '_______________'}<br>
                Signature: _______________<br>
                Date: _______________
            </div>
            <div class="signature-block">
                Secretary: ${data.secretary || '_______________'}<br>
                Signature: _______________<br>
                Date: _______________
            </div>
        </div>
        ${stampOverlay(data)}
    </div>

    ${footer()}
</div>
</body>
</html>`;

// ============================================================
// CERTIFICATE OF SHARES TEMPLATE
// Same format for both MONTHLY and ANNUAL — only the label and
// period shown differ. `data` is the response from issuing a
// certificate (certificatesAPI.issue): reference_code, user,
// shares_held, percentage, price_per_share, currency_code/symbol,
// share_value, certificate_type, period_label, issued_at.
// ============================================================
export const shareCertificateTemplate = (data) => {
    const label = data.certificate_type === 'ANNUAL' ? 'Annual' : 'Monthly';
    const periodDisplay = data.certificate_type === 'ANNUAL'
        ? data.period_label
        : `${String(data.period_label).slice(0, 4)}-${String(data.period_label).slice(4, 6)}`;
    const shareValueDisplay = data.share_value != null
        ? `${data.currency_symbol || data.currency_code || ''} ${fmt.amount(data.share_value)}`
        : '—';

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
        of the total issued shares, as recorded in the company's shareholding register.
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
        <div class="meta-item">
            <div class="meta-label">Date Issued</div>
            <div class="meta-value">${fmt.date(data.issued_at || new Date())}</div>
        </div>
    </div>

    <div class="stamp-overlay-wrap">
        <div class="signature-section">
            <div class="signature-block">Company Secretary</div>
            <div class="signature-block">Treasurer</div>
            <div class="signature-block">Director</div>
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