// ============================================================
// FINANCIAL STATEMENTS PACK — PDF and Excel (v1.88.0)
// Turns the pack built by financialStatementsService into:
//   • renderPackHtml(pack, images) — one HTML document printed to PDF by
//     pdfService (cover, contents, company information, directors' report,
//     statement of responsibilities, the four statements, notes, approval
//     page with the directors' blue signatures).
//   • buildPackWorkbook(pack) — an Excel workbook with the same statements
//     and notes (totals as SUM formulas so they can be checked), plus the
//     books for the year: trial balance, general ledger and cash book.
//   • addBooksSheets(wb, range) — the books alone (General Ledger page ›
//     "Download the books").
// Nothing here calculates a figure of its own except the Excel SUMs,
// which add up exactly the lines shown (the pack's totals are themselves
// sums of the rounded lines, so the two always agree).
// ============================================================

const glService = require('./glService');
const { query } = require('../config/database');

const { BASIS } = glService;

const esc = (s) => String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = (n) => {
    const v = Math.round(Number(n) || 0);
    if (v === 0) return '&ndash;';
    const s = Math.abs(v).toLocaleString('en-US');
    return v < 0 ? `(${s})` : s;
};
const paras = (t) => String(t || '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
    .map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = (s) => {
    if (!s) return '';
    const d = typeof s === 'string' ? s.slice(0, 10) : new Date(s).toISOString().slice(0, 10);
    const [y, m, dd] = d.split('-').map(Number);
    return `${dd} ${MONTHS[m - 1]} ${y}`;
};

// Which note explains which line.
const noteNumbers = () => {
    const order = ['revenue', 'expenses', 'fx', 'tax', 'cash', 'investments', 'receivables', 'liabilities', 'shareCapital', 'retained', 'related', 'events'];
    const n = {};
    order.forEach((k, i) => { n[k] = i + 4; }); // 1-3 are general, basis, policies
    return n;
};
const noteForCode = (code, N) => {
    if (code === '1000' || code === '1050') return N.cash;
    if (code === '1300' || code === '1400') return N.investments;
    if (code === '1100' || code === '1200') return N.receivables;
    if (['1500', '1510', '2500', '2510', '5700', '5710'].includes(code)) return N.tax;
    if (code === '4600' || code === '5600') return N.fx;
    if (code === 'RE') return N.retained;
    if (/^30/.test(code)) return N.shareCapital;
    if (/^2/.test(code)) return N.liabilities;
    if (/^4/.test(code)) return N.revenue;
    if (/^5/.test(code)) return N.expenses;
    return '';
};

const textOf = (pack, key) => (pack.texts.find(t => t.key === key) || { text: '' }).text;

const STATUS_LABEL = {
    APPROVED: 'Approved', DRAFT: 'Draft — not yet approved', CHANGED: 'Draft — the books changed after approval', IN_PROGRESS: 'Draft — the year is not finished',
};

// ------------------------------------------------------------
// HTML (for the PDF)
// ------------------------------------------------------------
const renderPackHtml = (pack, images = {}) => {
    const N = noteNumbers();
    const c = pack.company;
    const y = pack.year;
    const cur = pack.currency;
    const yearEnd = longDate(y.to);
    const priorEnd = longDate(pack.prior.end);
    const isDraft = pack.status !== 'APPROVED';
    const head2 = `<tr class="colhead"><th></th><th class="note">Note</th><th class="num">${esc(y.to.slice(0, 4))}<br><span>${cur}</span></th><th class="num">${esc(pack.prior.end.slice(0, 4))}<br><span>${cur}</span></th></tr>`;
    const row = (r, opts = {}) => `<tr class="${opts.cls || ''}"><td>${esc(r.name)}</td><td class="note">${opts.note === false ? '' : (noteForCode(r.code, N) || '')}</td><td class="num">${fmt(r.cur)}</td><td class="num">${fmt(r.prev)}</td></tr>`;
    const total = (label, t, cls = 'total') => `<tr class="${cls}"><td>${esc(label)}</td><td></td><td class="num">${fmt(t.cur)}</td><td class="num">${fmt(t.prev)}</td></tr>`;
    const sub = (label) => `<tr class="sub"><td colspan="4">${esc(label)}</td></tr>`;
    const s = pack.sofp; const p = pack.pl; const cf = pack.cashFlows; const nt = pack.notes;

    const twoColTable = (rows, tot, totalLabel = 'Total') => `<table class="fig">${head2.replace('<th class="note">Note</th>', '<th class="note"></th>')}${rows.map(r => row(r, { note: false })).join('')}${total(totalLabel, tot)}</table>`;
    const reconTable = (list) => list.map(x => `
        <h4>${esc(x.name)}</h4>
        <table class="fig">${head2.replace('<th class="note">Note</th>', '<th class="note"></th>')}
            ${['opening', 'increases', 'decreases', 'closing'].map(k => `<tr class="${k === 'closing' ? 'total' : ''}"><td>${{ opening: 'At the start of the year', increases: 'Increases during the year', decreases: 'Decreases during the year', closing: 'At the end of the year' }[k]}</td><td></td>
                <td class="num">${k === 'decreases' ? fmt(-x.cur[k]) : fmt(x.cur[k])}</td><td class="num">${k === 'decreases' ? fmt(-x.prev[k]) : fmt(x.prev[k])}</td></tr>`).join('')}
        </table>`).join('');
    const comment = (key) => { const t = textOf(pack, key); return t ? `<div class="comment">${paras(t)}</div>` : ''; };

    const signer = (d) => {
        const a = pack.approvals.find(x => x.user_id === d.id && !x.withdrawn_at);
        const img = a && images[`sig-${a.id}`];
        return `<div class="sign">
            <div class="sigspace">${img ? `<img src="${img}" alt="">` : ''}</div>
            <div class="sigline">${esc(d.name)}<br><span>Director${a ? ` · approved ${esc(longDate(a.approved_at))}` : ''}</span></div>
        </div>`;
    };
    const signBlock = () => `<div class="signs">${(pack.company.directors.length ? pack.company.directors : [{ id: 0, name: '' }, { id: -1, name: '' }]).map(signer).join('')}</div>`;

    const policies = pack.texts.filter(t => t.group === 'Notes — accounting policies');
    const contents = [
        ['Company information', 'p-info'], ['Directors’ report', 'p-dr'], ['Statement of directors’ responsibilities', 'p-resp'],
        ['Statement of financial position', 'p-sofp'], ['Statement of profit or loss', 'p-pl'], ['Statement of changes in equity', 'p-soce'],
        ['Statement of cash flows', 'p-cf'], ['Notes to the financial statements', 'p-notes'], ['Approval of the financial statements', 'p-approval'],
    ];

    const soceHead = `<tr class="colhead"><th></th>${pack.soce.columns.map(col => `<th class="num">${esc(col.name)}<br><span>${cur}</span></th>`).join('')}<th class="num">Total<br><span>${cur}</span></th></tr>`;
    const soceRows = pack.soce.rows.map(r => `<tr class="${r.strong ? 'total' : ''}"><td>${esc(r.label)}</td>${pack.soce.columns.map(col => `<td class="num">${fmt(r.values[col.key])}</td>`).join('')}<td class="num">${fmt(r.total)}</td></tr>`).join('');

    const cfSec = (label, sec) => `${sub(label)}${sec.rows.map(r => row(r, { note: false })).join('')}${total(`Net cash from ${label.toLowerCase()}`, sec.total, 'subtotal')}`;
    const infoRow = (k, v) => (v ? `<tr><th>${esc(k)}</th><td>${v}</td></tr>` : '');

    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(c.name)} — Financial statements ${esc(y.label)}</title>
<style>
  @page { size: A4; }
  * { box-sizing: border-box; }
  body { font-family: Georgia, 'Times New Roman', serif; color: #1f2937; font-size: 10.5pt; line-height: 1.45; margin: 0; }
  h1, h2, h3, h4 { font-family: 'Helvetica Neue', Arial, sans-serif; color: ${esc(c.primary_color)}; }
  h2 { font-size: 15pt; margin: 0 0 4px; }
  h2 + .period { color: #6b7280; font-size: 9.5pt; margin: 0 0 14px; font-family: Arial, sans-serif; }
  h3 { font-size: 11.5pt; margin: 18px 0 6px; }
  h4 { font-size: 10pt; margin: 12px 0 4px; color: #374151; }
  p { margin: 0 0 8px; text-align: justify; }
  .page { page-break-after: always; position: relative; }
  .page:last-child { page-break-after: auto; }
  .cover { height: 250mm; display: flex; flex-direction: column; justify-content: center; text-align: center; }
  .cover img { max-height: 32mm; max-width: 70mm; margin: 0 auto 14mm; }
  .cover h1 { font-size: 24pt; margin: 0 0 6mm; }
  .cover .sub { font-family: Arial, sans-serif; font-size: 13pt; color: #374151; }
  .cover .reg { margin-top: 10mm; font-family: Arial, sans-serif; font-size: 9.5pt; color: #6b7280; }
  .badge { display: inline-block; margin-top: 12mm; padding: 4px 12px; border: 1px solid #b45309; color: #b45309; border-radius: 999px; font-family: Arial, sans-serif; font-size: 9pt; }
  .badge.ok { border-color: #047857; color: #047857; }
  .watermark { position: fixed; top: 40%; left: 0; right: 0; text-align: center; font-size: 90pt; color: rgba(180, 83, 9, 0.07); transform: rotate(-30deg); font-family: Arial, sans-serif; z-index: 0; pointer-events: none; }
  table { width: 100%; border-collapse: collapse; }
  table.fig { font-family: Arial, sans-serif; font-size: 9.5pt; margin-bottom: 6px; }
  table.fig td, table.fig th { padding: 3px 6px; vertical-align: top; }
  table.fig th { font-weight: 600; color: #374151; }
  table.fig .num { text-align: right; width: 23mm; white-space: nowrap; font-variant-numeric: tabular-nums; }
  table.fig .note { text-align: center; width: 12mm; color: #6b7280; }
  table.fig tr.colhead th { border-bottom: 1px solid #9ca3af; font-size: 8.5pt; }
  table.fig tr.colhead th span { font-weight: 400; color: #6b7280; }
  table.fig tr.sub td { font-weight: 700; padding-top: 10px; color: ${esc(c.primary_color)}; }
  table.fig tr.subtotal td { border-top: 1px solid #d1d5db; font-weight: 600; }
  table.fig tr.total td { border-top: 1px solid #6b7280; font-weight: 700; }
  table.fig tr.grand td { border-top: 1px solid #374151; border-bottom: 3px double #374151; font-weight: 700; }
  table.soce .num { width: auto; }
  table.info { font-family: Arial, sans-serif; font-size: 10pt; }
  table.info th { text-align: left; width: 48mm; padding: 6px 8px 6px 0; vertical-align: top; color: #6b7280; font-weight: 600; }
  table.info td { padding: 6px 0; }
  .contents a { color: inherit; text-decoration: none; display: flex; justify-content: space-between; border-bottom: 1px dotted #d1d5db; padding: 6px 0; font-family: Arial, sans-serif; }
  .comment { font-size: 9.5pt; color: #374151; margin: 4px 0 10px; }
  .signs { display: flex; flex-wrap: wrap; gap: 10mm 16mm; margin-top: 14mm; }
  .sign { width: 70mm; }
  .sigspace { height: 22mm; display: flex; align-items: flex-end; margin-bottom: 2px; }
  .sigspace img { max-height: 22mm; max-width: 66mm; mix-blend-mode: multiply; }
  .sigline { border-top: 1px solid #374151; padding-top: 3px; font-family: Arial, sans-serif; font-size: 9.5pt; }
  .sigline span { color: #6b7280; font-size: 8.5pt; }
  .warn { border: 1px solid #f59e0b; background: #fffbeb; padding: 8px 10px; font-family: Arial, sans-serif; font-size: 9pt; margin-bottom: 12px; }
  .muted { color: #6b7280; font-family: Arial, sans-serif; font-size: 9pt; }
</style></head><body>
${isDraft ? '<div class="watermark">DRAFT</div>' : ''}

<section class="page cover">
  ${images.logo ? `<img src="${images.logo}" alt="">` : ''}
  <h1>${esc(c.name)}</h1>
  <div class="sub">Financial statements<br>for the year ended ${esc(yearEnd)}</div>
  <div class="reg">${c.registration_number ? `Registration number ${esc(c.registration_number)}` : ''}${c.tin ? `${c.registration_number ? ' · ' : ''}TIN ${esc(c.tin)}` : ''}</div>
  <div><span class="badge ${isDraft ? '' : 'ok'}">${esc(STATUS_LABEL[pack.status] || pack.status)}</span></div>
</section>

<section class="page">
  <h2>Contents</h2><div class="period">&nbsp;</div>
  <div class="contents">${contents.map(([t, id]) => `<a href="#${id}"><span>${esc(t)}</span></a>`).join('')}</div>
  ${pack.warnings.length ? `<div class="warn" style="margin-top:12mm"><strong>Before relying on these statements:</strong><ul>${pack.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
</section>

<section class="page" id="p-info">
  <h2>Company information</h2><div class="period">&nbsp;</div>
  <table class="info">
    ${infoRow('Company', esc(c.name))}
    ${infoRow('Registration number', esc(c.registration_number))}
    ${infoRow('Date of incorporation', esc(longDate(c.incorporation_date)))}
    ${infoRow('Tax identification number', esc(c.tin))}
    ${infoRow('Directors', c.directors.map(d => esc(d.name)).join('<br>') || '<span class="muted">No directors recorded</span>')}
    ${infoRow('Company secretary', c.secretaries.map(d => esc(d.name)).join('<br>'))}
    ${infoRow('Registered office', esc(c.registered_office).replace(/\n/g, '<br>'))}
    ${infoRow('Postal address', esc(c.postal_address))}
    ${infoRow('Email / telephone', [c.email, c.phone].filter(Boolean).map(esc).join(' · '))}
    ${infoRow('Auditors', esc(c.auditors).replace(/\n/g, '<br>') || '<span class="muted">Not audited</span>')}
    ${infoRow('Bankers', esc(c.bankers).replace(/\n/g, '<br>'))}
    ${infoRow('Lawyers', esc(c.lawyers).replace(/\n/g, '<br>'))}
    ${infoRow('Functional and presentation currency', `Uganda Shillings (${esc(cur)})`)}
  </table>
</section>

<section class="page" id="p-dr">
  <h2>Directors’ report</h2><div class="period">For the year ended ${esc(yearEnd)}</div>
  ${paras(textOf(pack, 'dr_intro'))}
  <h3>Principal activities</h3>${paras(textOf(pack, 'dr_activities'))}
  <h3>Results</h3>${paras(textOf(pack, 'dr_results'))}
  <h3>Dividends</h3>${paras(textOf(pack, 'dr_dividends'))}
  <h3>Directors</h3><p>The directors who held office during the year and up to the date of this report were:</p>
  <p>${c.directors.map(d => esc(d.name)).join('<br>') || '<span class="muted">No directors recorded in the system.</span>'}</p>
  <h3>Auditors</h3>${paras(textOf(pack, 'dr_auditors'))}
  <p style="margin-top:10mm">By order of the board</p>
  ${signBlock()}
</section>

<section class="page" id="p-resp">
  <h2>Statement of directors’ responsibilities</h2><div class="period">For the year ended ${esc(yearEnd)}</div>
  ${paras(textOf(pack, 'responsibilities'))}
  ${signBlock()}
</section>

<section class="page" id="p-sofp">
  <h2>Statement of financial position</h2><div class="period">As at ${esc(yearEnd)}</div>
  <table class="fig">${head2}
    ${sub('Assets')}
    ${s.nonCurrentAssets.length ? `<tr><td colspan="4"><em>Non-current assets</em></td></tr>${s.nonCurrentAssets.map(r => row(r)).join('')}${total('Total non-current assets', s.totalNonCurrentAssets, 'subtotal')}` : ''}
    <tr><td colspan="4"><em>Current assets</em></td></tr>${s.currentAssets.map(r => row(r)).join('')}${total('Total current assets', s.totalCurrentAssets, 'subtotal')}
    ${total('Total assets', s.totalAssets, 'grand')}
    ${sub('Equity and liabilities')}
    <tr><td colspan="4"><em>Equity</em></td></tr>${s.equity.map(r => row(r)).join('')}${total('Total equity', s.totalEquity, 'subtotal')}
    ${s.nonCurrentLiabilities.length ? `<tr><td colspan="4"><em>Non-current liabilities</em></td></tr>${s.nonCurrentLiabilities.map(r => row(r)).join('')}${total('Total non-current liabilities', s.totalNonCurrentLiabilities, 'subtotal')}` : ''}
    ${s.currentLiabilities.length ? `<tr><td colspan="4"><em>Current liabilities</em></td></tr>${s.currentLiabilities.map(r => row(r)).join('')}${total('Total current liabilities', s.totalCurrentLiabilities, 'subtotal')}` : ''}
    ${total('Total liabilities', s.totalLiabilities, 'subtotal')}
    ${total('Total equity and liabilities', s.totalEquityAndLiabilities, 'grand')}
  </table>
  <p class="muted">The notes on the following pages form part of these financial statements.</p>
</section>

<section class="page" id="p-pl">
  <h2>Statement of profit or loss and other comprehensive income</h2><div class="period">For the year ended ${esc(yearEnd)}</div>
  <table class="fig">${head2}
    ${sub('Income')}${p.revenue.map(r => row(r)).join('')}${total('Total income', p.totalRevenue, 'subtotal')}
    ${sub('Expenses')}${p.expenses.map(r => row(r)).join('')}${total('Total expenses', p.totalExpenses, 'subtotal')}
    ${total('Profit / (loss) before tax', p.profitBeforeTax)}
    ${p.incomeTax.map(r => row(r)).join('')}
    ${total('Profit / (loss) for the year', p.profit, 'grand')}
    <tr><td>Other comprehensive income</td><td></td><td class="num">&ndash;</td><td class="num">&ndash;</td></tr>
    ${total('Total comprehensive income for the year', p.profit, 'grand')}
  </table>
</section>

<section class="page" id="p-soce">
  <h2>Statement of changes in equity</h2><div class="period">For the year ended ${esc(yearEnd)}</div>
  <table class="fig soce">${soceHead}${soceRows}</table>
</section>

<section class="page" id="p-cf">
  <h2>Statement of cash flows</h2><div class="period">For the year ended ${esc(yearEnd)} — direct method</div>
  <table class="fig">${head2.replace('<th class="note">Note</th>', '<th class="note"></th>')}
    ${cfSec('Operating activities', cf.operating)}
    ${cfSec('Investing activities', cf.investing)}
    ${cfSec('Financing activities', cf.financing)}
    ${total('Net increase / (decrease) in cash', cf.netChange)}
    <tr><td>Cash and cash equivalents at the start of the year</td><td></td><td class="num">${fmt(cf.opening.cur)}</td><td class="num">${fmt(cf.opening.prev)}</td></tr>
    <tr><td>Effect of exchange rate changes on cash</td><td></td><td class="num">${fmt(cf.fxEffect.cur)}</td><td class="num">${fmt(cf.fxEffect.prev)}</td></tr>
    ${total('Cash and cash equivalents at the end of the year', cf.closing, 'grand')}
  </table>
  <p class="muted">Transfers between the company’s own accounts are not cash flows and are left out. Cash at the end of the year is analysed in note ${N.cash}.</p>
</section>

<section class="page" id="p-notes">
  <h2>Notes to the financial statements</h2><div class="period">For the year ended ${esc(yearEnd)}</div>
  <h3>1. General information</h3>${paras(textOf(pack, 'general_info'))}
  <h3>2. Basis of preparation</h3>${paras(textOf(pack, 'basis_of_preparation'))}
  <h3>3. Significant accounting policies</h3>
  ${policies.map((t, i) => `<h4>3.${i + 1} ${esc(t.title)}</h4>${paras(t.text)}`).join('')}

  <h3>${N.revenue}. Income</h3>${twoColTable(nt.revenue.rows, nt.revenue.total, 'Total income')}${comment('note_revenue')}
  <h3>${N.expenses}. Expenses</h3>${twoColTable(nt.expenses.rows, nt.expenses.total, 'Total expenses')}
  ${nt.expenses.byCategory.length ? `<h4>Expenses by category</h4>${twoColTable(nt.expenses.byCategory, { cur: nt.expenses.byCategory.reduce((a, r) => a + r.cur, 0), prev: nt.expenses.byCategory.reduce((a, r) => a + r.prev, 0) }, 'Total (excluding exchange differences)')}` : ''}${comment('note_expenses')}
  <h3>${N.fx}. Net foreign exchange gain / (loss)</h3>${nt.fx.any ? twoColTable(nt.fx.rows, nt.fx.total, 'Net gain / (loss)') : '<p class="muted">There were no exchange differences.</p>'}${comment('note_fx')}
  <h3>${N.tax}. Income tax</h3>${nt.tax.rows.length ? twoColTable(nt.tax.rows, nt.tax.total, 'Income tax for the year') : '<p class="muted">No income tax was charged.</p>'}${reconTable(nt.tax.reconciliation)}${comment('note_tax')}
  <h3>${N.cash}. Cash and cash equivalents</h3>${twoColTable(nt.cash.rows, nt.cash.total, 'Total cash and cash equivalents')}${comment('note_cash')}
  <h3>${N.investments}. Investments</h3>${nt.investments.rows.length ? twoColTable(nt.investments.rows, nt.investments.total, 'Total investments') : '<p class="muted">The company held no investments.</p>'}${reconTable(nt.investments.reconciliation)}${comment('note_investments')}
  <h3>${N.receivables}. Loans, advances and other receivables</h3>${nt.receivables.reconciliation.length ? reconTable(nt.receivables.reconciliation) : '<p class="muted">There were none.</p>'}${comment('note_receivables')}
  <h3>${N.liabilities}. Liabilities</h3>${nt.liabilities.reconciliation.length ? reconTable(nt.liabilities.reconciliation) : '<p class="muted">There were none.</p>'}
  <p class="muted">Non-current liabilities are those not due within twelve months of the year end.</p>${comment('note_liabilities')}
  <h3>${N.shareCapital}. Share capital</h3>
  ${nt.shareCapital.sharesInIssue ? `<table class="fig">${head2.replace('<th class="note">Note</th>', '<th class="note"></th>').replace(/<span>[A-Z]{3}<\/span>/g, '<span>Number</span>')}<tr><td>Ordinary shares registered at the year end</td><td></td><td class="num">${fmt(nt.shareCapital.sharesInIssue.cur)}</td><td class="num">${fmt(nt.shareCapital.sharesInIssue.prev)}</td></tr></table>` : ''}
  ${reconTable(nt.shareCapital.reconciliation)}${comment('note_share_capital')}
  <h3>${N.retained}. Retained earnings</h3>${twoColTable(nt.retained.rows, nt.retained.total, 'At the end of the year')}${comment('note_retained')}
  <h3>${N.related}. Related party transactions</h3>${paras(textOf(pack, 'related_parties'))}
  <h3>${N.events}. Events after the reporting period</h3>${paras(textOf(pack, 'events_after'))}
</section>

<section class="page" id="p-approval">
  <h2>Approval of the financial statements</h2><div class="period">For the year ended ${esc(yearEnd)}</div>
  ${paras(textOf(pack, 'approval_text'))}
  ${signBlock()}
  <p class="muted" style="margin-top:12mm">${pack.status === 'APPROVED'
        ? `Approved in the system by ${pack.approvals.filter(a => !a.withdrawn_at).map(a => `${esc(a.name)} on ${esc(longDate(a.approved_at))}`).join(', ')}.`
        : `Not yet approved: ${pack.approvals.filter(a => !a.withdrawn_at).length} of ${pack.approvalsRequired} director approvals recorded.`} Comparative figures are for the year ended ${esc(priorEnd)}.</p>
</section>
</body></html>`;
};

// ------------------------------------------------------------
// Excel
// ------------------------------------------------------------
const NUM = '#,##0;(#,##0);"–"';

const styleHeader = (row) => { row.font = { bold: true }; row.border = { bottom: { style: 'thin' } }; };

// Writes [label, note, cur, prev] statement rows; returns the sheet row numbers.
const writeLines = (ws, rows, { note = true, N } = {}) => {
    const first = ws.rowCount + 1;
    for (const r of rows) {
        const x = ws.addRow([r.name, note ? (noteForCode(r.code, N) || '') : '', r.cur, r.prev]);
        x.getCell(3).numFmt = NUM; x.getCell(4).numFmt = NUM;
    }
    return { first, last: ws.rowCount };
};
const writeSum = (ws, label, ranges, t, { bold = true, double = false } = {}) => {
    const f = (col) => ranges.filter(rg => rg && rg.last >= rg.first).map(rg => `SUM(${col}${rg.first}:${col}${rg.last})`).join('+') || '0';
    const x = ws.addRow([label, '', { formula: f('C'), result: t.cur }, { formula: f('D'), result: t.prev }]);
    x.font = { bold };
    for (const i of [3, 4]) {
        x.getCell(i).numFmt = NUM;
        x.getCell(i).border = double ? { top: { style: 'thin' }, bottom: { style: 'double' } } : { top: { style: 'thin' } };
    }
    return { first: x.number, last: x.number };
};
const writeCellsRef = (ws, label, refs, t, opts = {}) => {
    const f = (col) => refs.map(r => (r.neg ? `-${col}${r.row}` : `${col}${r.row}`)).join('+').replace(/\+-/g, '-') || '0';
    const x = ws.addRow([label, '', { formula: f('C'), result: t.cur }, { formula: f('D'), result: t.prev }]);
    x.font = { bold: true };
    for (const i of [3, 4]) {
        x.getCell(i).numFmt = NUM;
        x.getCell(i).border = opts.double ? { top: { style: 'thin' }, bottom: { style: 'double' } } : { top: { style: 'thin' } };
    }
    return x.number;
};
const sheetStart = (wb, name, title, pack, period) => {
    const ws = wb.addWorksheet(name, { views: [{ showGridLines: false }] });
    ws.columns = [{ width: 52 }, { width: 7 }, { width: 18 }, { width: 18 }];
    ws.addRow([pack.company.name]).font = { bold: true, size: 13 };
    ws.addRow([title]).font = { bold: true, size: 12 };
    ws.addRow([period]).font = { italic: true, color: { argb: 'FF6B7280' } };
    ws.addRow([]);
    const h = ws.addRow(['', 'Note', `${pack.year.to.slice(0, 4)} ${pack.currency}`, `${pack.prior.end.slice(0, 4)} ${pack.currency}`]);
    styleHeader(h); h.getCell(3).alignment = { horizontal: 'right' }; h.getCell(4).alignment = { horizontal: 'right' };
    return ws;
};
const label = (ws, text, italic = false) => { const r = ws.addRow([text]); r.font = italic ? { italic: true } : { bold: true }; };

const buildPackWorkbook = async (pack) => {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = pack.company.name;
    wb.created = new Date();
    const N = noteNumbers();
    const yEnd = longDate(pack.year.to);

    // Contents / company information
    const info = wb.addWorksheet('Contents', { views: [{ showGridLines: false }] });
    info.columns = [{ width: 36 }, { width: 70 }];
    info.addRow([pack.company.name]).font = { bold: true, size: 14 };
    info.addRow([`Financial statements for the year ended ${yEnd}`]).font = { size: 12 };
    info.addRow([STATUS_LABEL[pack.status] || pack.status]).font = { italic: true, color: { argb: pack.status === 'APPROVED' ? 'FF047857' : 'FFB45309' } };
    info.addRow([]);
    const c = pack.company;
    [
        ['Registration number', c.registration_number], ['Date of incorporation', longDate(c.incorporation_date)], ['TIN', c.tin],
        ['Directors', c.directors.map(d => d.name).join(', ')], ['Company secretary', c.secretaries.map(d => d.name).join(', ')],
        ['Registered office', c.registered_office], ['Auditors', c.auditors || 'Not audited'], ['Bankers', c.bankers], ['Lawyers', c.lawyers],
        ['Currency', `Uganda Shillings (${pack.currency}), whole shillings`],
    ].filter(x => x[1]).forEach(([k, v]) => { const r = info.addRow([k, v]); r.getCell(1).font = { bold: true }; r.getCell(2).alignment = { wrapText: true }; });
    info.addRow([]);
    info.addRow(['Sheets in this workbook']).font = { bold: true };
    ['Directors’ report', 'Financial position', 'Profit or loss', 'Changes in equity', 'Cash flows', 'Notes', 'Trial balance', 'General ledger', 'Cash book'].forEach(n => info.addRow(['', n]));
    if (pack.warnings.length) {
        info.addRow([]);
        info.addRow(['Before relying on these statements']).font = { bold: true, color: { argb: 'FFB45309' } };
        pack.warnings.forEach(w => { const r = info.addRow(['', w]); r.getCell(2).alignment = { wrapText: true }; });
    }

    // Directors' report (wording)
    const dr = wb.addWorksheet('Directors report', { views: [{ showGridLines: false }] });
    dr.columns = [{ width: 110 }];
    dr.addRow([pack.company.name]).font = { bold: true, size: 13 };
    dr.addRow([`Directors’ report for the year ended ${yEnd}`]).font = { bold: true, size: 12 };
    for (const t of pack.texts.filter(x => x.group === 'Directors’ report' || x.group === 'Directors’ responsibilities')) {
        dr.addRow([]);
        dr.addRow([t.title]).font = { bold: true };
        const r = dr.addRow([t.text]); r.alignment = { wrapText: true, vertical: 'top' };
    }
    dr.addRow([]); dr.addRow(['Directors']).font = { bold: true };
    c.directors.forEach(d => {
        const a = pack.approvals.find(x => x.user_id === d.id && !x.withdrawn_at);
        dr.addRow([`${d.name}${a ? ` — approved ${longDate(a.approved_at)}` : ''}`]);
    });

    // Statement of financial position
    const s = pack.sofp;
    let ws = sheetStart(wb, 'Financial position', 'Statement of financial position', pack, `As at ${yEnd}`);
    label(ws, 'Assets');
    let nca = null;
    if (s.nonCurrentAssets.length) { label(ws, 'Non-current assets', true); const r = writeLines(ws, s.nonCurrentAssets, { N }); nca = writeSum(ws, 'Total non-current assets', [r], s.totalNonCurrentAssets); }
    label(ws, 'Current assets', true);
    const caLines = writeLines(ws, s.currentAssets, { N });
    const ca = writeSum(ws, 'Total current assets', [caLines], s.totalCurrentAssets);
    const ta = writeCellsRef(ws, 'Total assets', [nca && { row: nca.first }, { row: ca.first }].filter(Boolean), s.totalAssets, { double: true });
    ws.addRow([]);
    label(ws, 'Equity and liabilities');
    label(ws, 'Equity', true);
    const eqLines = writeLines(ws, s.equity, { N });
    const te = writeSum(ws, 'Total equity', [eqLines], s.totalEquity);
    let ncl = null; let cl = null;
    if (s.nonCurrentLiabilities.length) { label(ws, 'Non-current liabilities', true); const r = writeLines(ws, s.nonCurrentLiabilities, { N }); ncl = writeSum(ws, 'Total non-current liabilities', [r], s.totalNonCurrentLiabilities); }
    if (s.currentLiabilities.length) { label(ws, 'Current liabilities', true); const r = writeLines(ws, s.currentLiabilities, { N }); cl = writeSum(ws, 'Total current liabilities', [r], s.totalCurrentLiabilities); }
    const tl = writeCellsRef(ws, 'Total liabilities', [ncl && { row: ncl.first }, cl && { row: cl.first }].filter(Boolean), s.totalLiabilities);
    writeCellsRef(ws, 'Total equity and liabilities', [{ row: te.first }, { row: tl }], s.totalEquityAndLiabilities, { double: true });
    const chk = ws.addRow(['Check: total assets less total equity and liabilities (must be –)', '', { formula: `C${ta}-C${ws.rowCount}`, result: 0 }, { formula: `D${ta}-D${ws.rowCount}`, result: 0 }]);
    chk.font = { italic: true, color: { argb: 'FF6B7280' } }; chk.getCell(3).numFmt = NUM; chk.getCell(4).numFmt = NUM;

    // Profit or loss
    const p = pack.pl;
    ws = sheetStart(wb, 'Profit or loss', 'Statement of profit or loss and other comprehensive income', pack, `For the year ended ${yEnd}`);
    label(ws, 'Income'); const rv = writeSum(ws, 'Total income', [writeLines(ws, p.revenue, { N })], p.totalRevenue, { bold: true });
    label(ws, 'Expenses'); const ex = writeSum(ws, 'Total expenses', [writeLines(ws, p.expenses, { N })], p.totalExpenses, { bold: true });
    const pbt = writeCellsRef(ws, 'Profit / (loss) before tax', [{ row: rv.first }, { row: ex.first, neg: true }], p.profitBeforeTax);
    const taxLines = writeLines(ws, p.incomeTax, { N });
    const taxRefs = [];
    for (let i = taxLines.first; i <= taxLines.last; i++) taxRefs.push({ row: i, neg: true });
    writeCellsRef(ws, 'Profit / (loss) for the year', [{ row: pbt }, ...taxRefs], p.profit, { double: true });

    // Changes in equity
    const ce = wb.addWorksheet('Changes in equity', { views: [{ showGridLines: false }] });
    ce.columns = [{ width: 46 }, ...pack.soce.columns.map(() => ({ width: 20 })), { width: 18 }];
    ce.addRow([pack.company.name]).font = { bold: true, size: 13 };
    ce.addRow(['Statement of changes in equity']).font = { bold: true, size: 12 };
    ce.addRow([`For the year ended ${yEnd} (${pack.currency})`]).font = { italic: true, color: { argb: 'FF6B7280' } };
    ce.addRow([]);
    styleHeader(ce.addRow(['', ...pack.soce.columns.map(col => col.name), 'Total']));
    const nCols = pack.soce.columns.length;
    const colL = (i) => String.fromCharCode(66 + i); // B, C, …
    for (const r of pack.soce.rows) {
        const x = ce.addRow([r.label, ...pack.soce.columns.map(col => r.values[col.key]), { formula: `SUM(B${ce.rowCount + 1}:${colL(nCols - 1)}${ce.rowCount + 1})`, result: r.total }]);
        for (let i = 2; i <= nCols + 2; i++) x.getCell(i).numFmt = NUM;
        if (r.strong) x.font = { bold: true };
    }

    // Cash flows
    const cf = pack.cashFlows;
    ws = sheetStart(wb, 'Cash flows', 'Statement of cash flows (direct method)', pack, `For the year ended ${yEnd}`);
    const secs = [];
    for (const [title, sec] of [['Operating activities', cf.operating], ['Investing activities', cf.investing], ['Financing activities', cf.financing]]) {
        label(ws, title);
        secs.push(writeSum(ws, `Net cash from ${title.toLowerCase()}`, [writeLines(ws, sec.rows, { note: false, N })], sec.total));
    }
    const net = writeCellsRef(ws, 'Net increase / (decrease) in cash', secs.map(x => ({ row: x.first })), cf.netChange);
    const op = writeLines(ws, [{ name: 'Cash at the start of the year', cur: cf.opening.cur, prev: cf.opening.prev }, { name: 'Effect of exchange rate changes on cash', cur: cf.fxEffect.cur, prev: cf.fxEffect.prev }], { note: false, N });
    writeCellsRef(ws, 'Cash at the end of the year', [{ row: net }, { row: op.first }, { row: op.last }], cf.closing, { double: true });

    // Notes (figures + wording)
    const nw = wb.addWorksheet('Notes', { views: [{ showGridLines: false }] });
    nw.columns = [{ width: 60 }, { width: 18 }, { width: 18 }];
    nw.addRow([pack.company.name]).font = { bold: true, size: 13 };
    nw.addRow([`Notes to the financial statements for the year ended ${yEnd}`]).font = { bold: true, size: 12 };
    const nt = pack.notes;
    const para = (text) => { if (text) { const r = nw.addRow([text]); r.alignment = { wrapText: true, vertical: 'top' }; nw.mergeCells(`A${r.number}:C${r.number}`); r.height = Math.min(400, 15 * Math.ceil(String(text).length / 95)); } };
    const head = (t) => { nw.addRow([]); nw.addRow([t]).font = { bold: true, size: 11 }; };
    const tbl = (rows, tot, totLabel) => {
        styleHeader(nw.addRow(['', `${pack.year.to.slice(0, 4)} ${pack.currency}`, `${pack.prior.end.slice(0, 4)} ${pack.currency}`]));
        const first = nw.rowCount + 1;
        rows.forEach(r => { const x = nw.addRow([r.name, r.cur, r.prev]); x.getCell(2).numFmt = NUM; x.getCell(3).numFmt = NUM; });
        const last = nw.rowCount;
        if (tot) {
            const x = nw.addRow([totLabel, { formula: last >= first ? `SUM(B${first}:B${last})` : '0', result: tot.cur }, { formula: last >= first ? `SUM(C${first}:C${last})` : '0', result: tot.prev }]);
            x.font = { bold: true }; x.getCell(2).numFmt = NUM; x.getCell(3).numFmt = NUM;
            x.getCell(2).border = { top: { style: 'thin' } }; x.getCell(3).border = { top: { style: 'thin' } };
        }
    };
    const recon = (list) => list.forEach(x => {
        nw.addRow([x.name]).font = { italic: true };
        tbl([
            { name: 'At the start of the year', cur: x.cur.opening, prev: x.prev.opening },
            { name: 'Increases during the year', cur: x.cur.increases, prev: x.prev.increases },
            { name: 'Decreases during the year', cur: -x.cur.decreases, prev: -x.prev.decreases },
        ], { cur: x.cur.closing, prev: x.prev.closing }, 'At the end of the year');
    });
    const comment = (key) => para(textOf(pack, key));
    head('1. General information'); para(textOf(pack, 'general_info'));
    head('2. Basis of preparation'); para(textOf(pack, 'basis_of_preparation'));
    head('3. Significant accounting policies');
    pack.texts.filter(t => t.group === 'Notes — accounting policies').forEach((t, i) => { nw.addRow([`3.${i + 1} ${t.title}`]).font = { italic: true }; para(t.text); });
    head(`${N.revenue}. Income`); tbl(nt.revenue.rows, nt.revenue.total, 'Total income'); comment('note_revenue');
    head(`${N.expenses}. Expenses`); tbl(nt.expenses.rows, nt.expenses.total, 'Total expenses');
    if (nt.expenses.byCategory.length) { nw.addRow(['Expenses by category']).font = { italic: true }; tbl(nt.expenses.byCategory, { cur: nt.expenses.byCategory.reduce((a, r) => a + r.cur, 0), prev: nt.expenses.byCategory.reduce((a, r) => a + r.prev, 0) }, 'Total (excluding exchange differences)'); }
    comment('note_expenses');
    head(`${N.fx}. Net foreign exchange gain / (loss)`); tbl(nt.fx.rows, nt.fx.total, 'Net gain / (loss)'); comment('note_fx');
    head(`${N.tax}. Income tax`); tbl(nt.tax.rows, nt.tax.total, 'Income tax for the year'); recon(nt.tax.reconciliation); comment('note_tax');
    head(`${N.cash}. Cash and cash equivalents`); tbl(nt.cash.rows, nt.cash.total, 'Total cash and cash equivalents'); comment('note_cash');
    head(`${N.investments}. Investments`); tbl(nt.investments.rows, nt.investments.total, 'Total investments'); recon(nt.investments.reconciliation); comment('note_investments');
    head(`${N.receivables}. Loans, advances and other receivables`); recon(nt.receivables.reconciliation); comment('note_receivables');
    head(`${N.liabilities}. Liabilities`); recon(nt.liabilities.reconciliation); comment('note_liabilities');
    head(`${N.shareCapital}. Share capital`);
    if (nt.shareCapital.sharesInIssue) { const r = nw.addRow(['Ordinary shares registered at the year end (number)', nt.shareCapital.sharesInIssue.cur, nt.shareCapital.sharesInIssue.prev]); r.getCell(2).numFmt = NUM; r.getCell(3).numFmt = NUM; }
    recon(nt.shareCapital.reconciliation); comment('note_share_capital');
    head(`${N.retained}. Retained earnings`); tbl(nt.retained.rows, nt.retained.total, 'At the end of the year'); comment('note_retained');
    head(`${N.related}. Related party transactions`); para(textOf(pack, 'related_parties'));
    head(`${N.events}. Events after the reporting period`); para(textOf(pack, 'events_after'));

    await addBooksSheets(wb, { fromDate: pack.year.start, toDate: pack.year.to });
    return wb;
};

// ------------------------------------------------------------
// The books: trial balance, general ledger, cash book
// ------------------------------------------------------------
const addBooksSheets = async (wb, { fromDate, toDate }) => {
    const MONEY = '#,##0.00;(#,##0.00);"–"';
    const [tb, gl] = await Promise.all([
        glService.computeTrialBalance({ asOfDate: toDate, basis: BASIS.FUNCTIONAL }),
        glService.computeGeneralLedger({ fromDate, toDate, basis: BASIS.FUNCTIONAL }),
    ]);
    const cur = (tb.meta && tb.meta.functionalCurrency && tb.meta.functionalCurrency.code) || 'UGX';

    // Trial balance
    const t = wb.addWorksheet('Trial balance', { views: [{ state: 'frozen', ySplit: 4, showGridLines: false }] });
    t.columns = [{ width: 9 }, { width: 46 }, { width: 13 }, { width: 18 }, { width: 18 }];
    t.addRow([`Trial balance as at ${longDate(toDate)} (${cur})`]).font = { bold: true, size: 12 };
    t.addRow(['Cumulative balances since the books began, in the functional currency.']).font = { italic: true, color: { argb: 'FF6B7280' } };
    t.addRow([]);
    styleHeader(t.addRow(['Code', 'Account', 'Type', 'Debit', 'Credit']));
    const b = tb.byCurrency[0];
    const first = t.rowCount + 1;
    for (const r of (b ? b.rows : [])) {
        const debit = r.balance >= 0 === (['ASSET', 'EXPENSE'].includes(r.accountType)) ? Math.abs(r.balance) : 0;
        const credit = debit ? 0 : Math.abs(r.balance);
        const x = t.addRow([r.code, r.name, r.accountType, debit || null, credit || null]);
        x.getCell(4).numFmt = MONEY; x.getCell(5).numFmt = MONEY;
    }
    const last = t.rowCount;
    const tot = t.addRow(['', 'Total', '', { formula: `SUM(D${first}:D${last})` }, { formula: `SUM(E${first}:E${last})` }]);
    tot.font = { bold: true }; tot.getCell(4).numFmt = MONEY; tot.getCell(5).numFmt = MONEY;

    // General ledger
    const g = wb.addWorksheet('General ledger', { views: [{ state: 'frozen', ySplit: 3 }] });
    g.columns = [{ width: 12 }, { width: 22 }, { width: 50 }, { width: 34 }, { width: 16 }, { width: 16 }, { width: 18 }, { width: 22 }];
    g.addRow([`General ledger ${longDate(fromDate)} – ${longDate(toDate)} (${cur})`]).font = { bold: true, size: 12 };
    g.addRow([]);
    styleHeader(g.addRow(['Date', 'Reference', 'Description', 'Category', 'Debit', 'Credit', 'Balance', 'Original amount']));
    for (const sec of ((gl.byCurrency[0] || {}).sections || [])) {
        const h = g.addRow([`${sec.code} ${sec.name}`]); h.font = { bold: true, color: { argb: 'FF1E3A5F' } };
        const o = g.addRow(['', '', 'Balance brought forward', '', null, null, sec.openingBalance]); o.font = { italic: true }; o.getCell(7).numFmt = MONEY;
        for (const l of sec.lines) {
            const x = g.addRow([l.date, l.referenceCode || '', l.description || '', l.categoryTrail || '', l.debit || null, l.credit || null, l.runningBalance,
                l.original && l.original.amount ? `${l.original.currencyCode} ${Number(l.original.amount).toLocaleString('en-US', { minimumFractionDigits: 2 })} @ ${l.original.rate}` : '']);
            for (const i of [5, 6, 7]) x.getCell(i).numFmt = MONEY;
        }
        const e = g.addRow(['', '', 'Balance carried forward', '', null, null, sec.endingBalance]); e.font = { bold: true }; e.getCell(7).numFmt = MONEY;
        g.addRow([]);
    }

    // Cash book — each bank / cash account in its own currency
    const cb = wb.addWorksheet('Cash book', { views: [{ state: 'frozen', ySplit: 3 }] });
    cb.columns = [{ width: 12 }, { width: 22 }, { width: 50 }, { width: 34 }, { width: 16 }, { width: 16 }, { width: 18 }];
    cb.addRow([`Cash book ${longDate(fromDate)} – ${longDate(toDate)} — each account in its own currency`]).font = { bold: true, size: 12 };
    cb.addRow([]);
    styleHeader(cb.addRow(['Date', 'Reference', 'Description', 'Category', 'Money in', 'Money out', 'Balance']));
    const cashGl = (await query("SELECT id FROM gl_accounts WHERE code = '1000'")).rows[0];
    const accounts = (await query(`SELECT a.id, a.name, a.bank_name, a.bank_account_number, cur.code AS currency_code
                                   FROM accounts a JOIN currencies cur ON cur.id = a.currency_id ORDER BY a.id`)).rows;
    for (const a of accounts) {
        if (!cashGl) break;
        const book = await glService.computeGeneralLedger({ glAccountId: cashGl.id, accountId: a.id, fromDate, toDate, basis: BASIS.CURRENCY });
        const sec = ((book.byCurrency[0] || {}).sections || [])[0];
        if (!sec) continue;
        const h = cb.addRow([`${a.name}${a.bank_name ? ` — ${a.bank_name}` : ''}${a.bank_account_number ? ` ${a.bank_account_number}` : ''} (${a.currency_code})`]);
        h.font = { bold: true, color: { argb: 'FF1E3A5F' } };
        const o = cb.addRow(['', '', 'Balance brought forward', '', null, null, sec.openingBalance]); o.font = { italic: true }; o.getCell(7).numFmt = MONEY;
        for (const l of sec.lines) {
            const x = cb.addRow([l.date, l.referenceCode || '', l.description || '', l.categoryTrail || '', l.debit || null, l.credit || null, l.runningBalance]);
            for (const i of [5, 6, 7]) x.getCell(i).numFmt = MONEY;
        }
        const e = cb.addRow(['', '', 'Balance carried forward', '', null, null, sec.endingBalance]); e.font = { bold: true }; e.getCell(7).numFmt = MONEY;
        cb.addRow([]);
    }
    return wb;
};

module.exports = { renderPackHtml, buildPackWorkbook, addBooksSheets, longDate };
