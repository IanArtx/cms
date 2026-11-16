// ============================================================
// TAX FILING WORKSHEET — DT-2002 (v1.90.0)
// "the system can assist or produce an assisting document showing the
//  values to fill the tax fillings (provisional and final) using the
//  system entered data" (13 Nov 2026). Confirmed: a worksheet (PDF and
//  Excel) to copy from — the system does not fill URA's own file.
//
//   build(yearId, 'FINAL' | 'PROVISIONAL')  → the figures, ready to copy
//   renderHtml(ws)                          → printable (PDF via pdfService)
//   buildWorkbook(ws)                       → Excel
//
// FINAL (the return of income, after the year): every figure comes from
// taxService.computeWorksheet (the same computation the Treasurer prepares
// and a Director approves) and, for the balance sheet, from the
// financial statements pack — so the worksheet can never disagree with
// them. Each line shows the ledger account it comes from and the line of
// the return it belongs on. URA changes the form's section letters from
// time to time, so lines are named as on the form ("Interest income",
// "Cash and bank balances" …) — copy each figure to the line of the same
// name.
// PROVISIONAL (the estimate, during the year): the estimated chargeable
// income entered under Tax › Years, the tax on it, the creditable tax
// already deducted, and the two instalments with their due dates and
// what has been paid.
// ============================================================

const { query } = require('../config/database');
const { createError } = require('../utils/errors');
const tax = require('./taxService');

const r0 = (n) => Math.round(Number(n) || 0);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = (s) => { if (!s) return ''; const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };

// Ledger account → the line of the return it is reported on.
const PL_LINE = {
    4000: 'Interest income', 4100: 'Dividends and other investment income', 4200: 'Grants and donations received',
    4300: 'Other income', 4400: 'Other income', 4500: 'Other income',
    4600: 'Foreign exchange gains', 4610: 'Foreign exchange gains',
    5000: 'Administrative and general expenses', 5100: 'Interest expense', 5150: 'Direct operating costs',
    5160: 'Repairs and maintenance', 5200: 'Other expenses', 5300: 'Management and professional fees',
    5400: 'Other expenses', 5500: 'Other expenses', 5600: 'Foreign exchange losses', 5610: 'Foreign exchange losses',
    5720: 'Fines and penalties',
};
const BS_LINE = {
    1000: 'Cash and bank balances', 1050: 'Cash and bank balances', 1100: 'Loans and advances',
    1200: 'Other receivables and prepayments', 1300: 'Short-term investments', 1400: 'Long-term investments',
    1500: 'Tax recoverable / paid in advance', 1510: 'Tax recoverable / paid in advance',
    2000: 'Borrowings', 2100: 'Amounts due to members (savings)', 2200: 'Amounts due to members (deposits)',
    2300: 'Deferred income', 2400: 'Other payables', 2500: 'Tax payable', 2510: 'Tax payable',
    3000: 'Issued share capital', 3010: 'Share premium', 3020: 'Other reserves (capital pending allotment)', RE: 'Retained earnings / (accumulated losses)',
};

const build = async (yearId, kind = 'FINAL') => {
    const K = String(kind || 'FINAL').toUpperCase();
    if (!['FINAL', 'PROVISIONAL'].includes(K)) throw createError.badRequest('Choose FINAL or PROVISIONAL.');
    const w = await tax.computeWorksheet(Number(yearId));
    const year = w.year;
    const co = w.company;
    const warnings = [...w.warnings];
    const header = {
        kind: K, form: K === 'FINAL' ? 'DT-2002 — Income tax return for non-individuals' : 'DT-2002 — Provisional return (estimate of chargeable income)',
        company: co.name, tin: co.tin, registration_number: co.registrationNumber, tax_office: co.taxOffice,
        year_label: year.label, period_from: year.startDate, period_to: year.endDate, currency: w.currency,
        return_type: 'Original', status: year.status,
        return_due: w.deadlines.returnDue, provisional1_due: w.deadlines.provisional1, provisional2_due: w.deadlines.provisional2,
        prepared_by: year.preparedBy, approved_by: year.approvedBy, filed_on: year.filingDate, return_reference: year.returnReference,
        computed_at: w.computedAt,
    };

    if (K === 'PROVISIONAL') {
        const payments = w.payments.filter(p => p.status === 'PAID' && p.payment_kind === 'PROVISIONAL');
        const paidN = (n) => r0(payments.filter(p => Number(p.instalment_no) === n).reduce((s, p) => s + p.amount, 0));
        const estimate = year.provisionalEstimate;
        const rate = w.taxRate;
        const estTax = estimate === null ? null : r0((year.provisionalTaxEstimate !== null && year.provisionalTaxEstimate !== undefined) ? year.provisionalTaxEstimate : estimate * rate / 100);
        const credits = r0(w.totalWhtCredits);
        const payable = estTax === null ? null : Math.max(0, estTax - credits);
        const inst1 = payable === null ? null : r0(payable / 2);
        const inst2 = payable === null ? null : payable - inst1;
        if (estimate === null) warnings.unshift('No estimate is entered yet — enter the estimated chargeable income under Tax › Years › this year › Provisional estimate.');
        return {
            header, warnings,
            provisional: {
                estimate: estimate === null ? null : r0(estimate), rate, estimated_tax: estTax, creditable_wht: credits, payable,
                instalments: [
                    { no: 1, due: w.deadlines.provisional1, amount: inst1, paid: paidN(1), balance: inst1 === null ? null : inst1 - paidN(1), share: 'Half of the provisional tax' },
                    { no: 2, due: w.deadlines.provisional2, amount: inst2, paid: paidN(2), balance: inst2 === null ? null : inst2 - paidN(2), share: 'The rest' },
                ],
                payments: payments.map(p => ({ date: p.paid_date, instalment: p.instalment_no, prn: p.prn, reference: p.reference_code, amount: r0(p.amount) })),
                last_year: await lastYearFigures(year.startDate),
                filed: year.provisionalFiledOn ? { on: year.provisionalFiledOn, reference: year.provisionalReturnReference } : null,
            },
            whtCredits: w.whtCredits.map(c => ({ ...c, amount: r0(c.amount) })),
        };
    }

    // ---- FINAL --------------------------------------------------
    if (!['APPROVED', 'FILED'].includes(year.status)) {
        warnings.unshift(year.status === 'PREPARED'
            ? 'The computation is prepared but not yet approved by a Director — the figures are final only once it is approved.'
            : 'The computation has not been prepared yet — these figures are a draft. Close every month of the year, then prepare and approve it.');
    }
    const plRows = (rows, sign) => rows.map(r => ({ code: r.code, account: r.name, line: PL_LINE[r.code] || (sign > 0 ? 'Other income' : 'Other expenses'), amount: r0(r.amount) }))
        .filter(r => r.amount !== 0);
    const income = plRows(w.incomeStatement.revenue, 1);
    const expenses = plRows(w.incomeStatement.expenses, -1);
    // Summary by line of the return
    const byLine = (rows) => {
        const m = new Map();
        for (const r of rows) m.set(r.line, (m.get(r.line) || 0) + r.amount);
        return Array.from(m.entries()).map(([line, amount]) => ({ line, amount }));
    };
    const totalIncome = income.reduce((s, r) => s + r.amount, 0);
    const totalExpenses = expenses.reduce((s, r) => s + r.amount, 0);

    // Balance sheet at the end of the year (financial statements pack)
    let balance = null;
    try {
        const fs = require('./financialStatementsService');
        const pack = await fs.buildPack(Number(year.endDate.slice(0, 4)));
        if (pack.year.end === year.endDate || pack.year.to === year.endDate) {
            const s = pack.sofp;
            const rows = (list) => list.map(r => ({ code: r.code, account: r.name, line: BS_LINE[r.code] || r.name, amount: r.cur }));
            balance = {
                nonCurrentAssets: rows(s.nonCurrentAssets), currentAssets: rows(s.currentAssets),
                equity: rows(s.equity), nonCurrentLiabilities: rows(s.nonCurrentLiabilities), currentLiabilities: rows(s.currentLiabilities),
                totalAssets: s.totalAssets.cur, totalEquity: s.totalEquity.cur, totalLiabilities: s.totalLiabilities.cur,
            };
            if (pack.warnings.length) warnings.push(...pack.warnings.map(x => `Balance sheet: ${x}`));
        } else {
            warnings.push('The balance sheet could not be matched to this tax year (the financial year settings differ) — take it from the financial statements pack.');
        }
    } catch (e) {
        warnings.push(`The balance sheet could not be built: ${e.message}`);
    }

    const pbt = r0(w.profitBeforeTax);
    if (Math.abs(pbt - (totalIncome - totalExpenses)) > income.length + expenses.length + 1) {
        warnings.push(`Profit before tax (${pbt}) differs from income less expenses (${totalIncome - totalExpenses}) — check the Income Statement.`);
    }
    const computation = {
        profitBeforeTax: pbt,
        addBacks: w.addBacks.map(a => ({ label: a.label, amount: r0(a.amount), auto: a.auto })), totalAddBacks: r0(w.totalAddBacks),
        deductions: w.deductions.map(a => ({ label: a.label, amount: r0(a.amount), auto: a.auto })), totalDeductions: r0(w.totalDeductions),
        chargeableIncome: r0(w.chargeableIncome), lossBroughtForward: r0(w.lossBroughtForward), lossUtilised: r0(w.lossUtilised),
        taxableIncome: r0(w.taxableIncome), lossCarriedForward: r0(w.lossCarriedForward), taxRate: w.taxRate, grossTax: r0(w.grossTax),
        whtCredits: r0(w.totalWhtCredits), provisionalPaid: r0(w.provisionalPaid), balanceDue: r0(w.balanceDue),
    };
    return {
        header, warnings,
        incomeStatement: { income, expenses, incomeByLine: byLine(income), expensesByLine: byLine(expenses), totalIncome, totalExpenses, profitBeforeTax: pbt },
        balance, computation,
        whtCredits: w.whtCredits.map(c => ({ ...c, amount: r0(c.amount) })),
        finalTaxIncome: (w.deductions.find(d => d.key === 'FINAL_TAX_INCOME') || { detail: [] }).detail.map(d => ({ ...d, amount: r0(d.amount), tax: r0(d.tax) })),
        payments: w.payments.filter(p => p.status === 'PAID').map(p => ({ date: p.paid_date, kind: p.payment_kind, instalment: p.instalment_no, prn: p.prn, reference: p.reference_code, amount: r0(p.amount) })),
    };
};

const lastYearFigures = async (startDate) => {
    const r = await query(`SELECT label, status, chargeable_income, gross_tax FROM tax_years WHERE end_date = $1::date - 1`, [startDate]);
    if (!r.rows.length) return null;
    const y = r.rows[0];
    return { label: y.label, status: y.status, chargeable_income: y.chargeable_income === null ? null : r0(y.chargeable_income), gross_tax: y.gross_tax === null ? null : r0(y.gross_tax) };
};

// ------------------------------------------------------------
// Printable page
// ------------------------------------------------------------
const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (n) => { if (n === null || n === undefined) return '—'; const v = r0(n); const s = Math.abs(v).toLocaleString('en-US'); return v < 0 ? `(${s})` : s; };

const renderHtml = (ws) => {
    const h = ws.header;
    const row = (cells, cls = '') => `<tr class="${cls}">${cells.map((c, i) => `<td class="${i === cells.length - 1 ? 'num' : ''}">${c}</td>`).join('')}</tr>`;
    const table = (head, rows) => `<table><thead><tr>${head.map((x, i) => `<th class="${i === head.length - 1 ? 'num' : ''}">${x}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
    let body = '';
    if (h.kind === 'PROVISIONAL') {
        const p = ws.provisional;
        body += `<h2>1. Estimate of chargeable income</h2>${table(['Line of the return', `${h.currency}`], [
            row(['Estimated chargeable income for the year', fmt(p.estimate)]),
            row([`Tax on it at ${p.rate}%`, fmt(p.estimated_tax)]),
            row(['Less: creditable withholding tax already deducted this year', fmt(-p.creditable_wht)]),
            row(['Provisional tax payable for the year', fmt(p.payable)], 'total'),
        ])}`;
        if (p.last_year) body += `<p class="muted">For comparison — ${esc(p.last_year.label)} (${esc(p.last_year.status.toLowerCase())}): chargeable income ${fmt(p.last_year.chargeable_income)}, tax ${fmt(p.last_year.gross_tax)}.</p>`;
        body += `<h2>2. Instalments</h2>${table(['Instalment', 'Due by', 'Amount', 'Paid', 'Still to pay'], p.instalments.map(i =>
            `<tr><td>${i.no} — ${esc(i.share)}</td><td>${esc(longDate(i.due))}</td><td class="num">${fmt(i.amount)}</td><td class="num">${fmt(i.paid)}</td><td class="num">${fmt(i.balance)}</td></tr>`))}`;
        if (p.payments.length) body += `<h2>3. Provisional tax paid</h2>${table(['Date', 'Instalment', 'PRN', 'Reference', 'Amount'], p.payments.map(x => `<tr><td>${esc(x.date)}</td><td>${esc(x.instalment)}</td><td>${esc(x.prn || '')}</td><td>${esc(x.reference || '')}</td><td class="num">${fmt(x.amount)}</td></tr>`))}`;
        if (ws.whtCredits.length) body += `<h2>${p.payments.length ? 4 : 3}. Creditable tax deducted so far</h2>${table(['Date', 'Payer', 'Certificate', 'Tax'], ws.whtCredits.map(c => `<tr><td>${esc(c.date)}</td><td>${esc(c.description)}</td><td>${esc(c.certificate || '— missing')}</td><td class="num">${fmt(c.amount)}</td></tr>`))}`;
        if (p.filed) body += `<p class="muted">Provisional return filed on ${esc(longDate(p.filed.on))}${p.filed.reference ? ` — reference ${esc(p.filed.reference)}` : ''}.</p>`;
    } else {
        const is = ws.incomeStatement;
        body += `<h2>1. Income statement (profit and loss) — ${esc(longDate(h.period_from))} to ${esc(longDate(h.period_to))}</h2>`;
        body += `<h3>Income</h3>${table(['Line of the return', 'From the ledger', h.currency], is.income.map(r => row([esc(r.line), `${esc(r.code)} ${esc(r.account)}`, fmt(r.amount)])).concat(row(['Total income', '', fmt(is.totalIncome)], 'total')))}`;
        body += `<h3>Expenses</h3>${table(['Line of the return', 'From the ledger', h.currency], is.expenses.map(r => row([esc(r.line), `${esc(r.code)} ${esc(r.account)}`, fmt(r.amount)])).concat(row(['Total expenses', '', fmt(is.totalExpenses)], 'total')))}`;
        body += table(['', h.currency], [row(['Profit / (loss) before tax', fmt(is.profitBeforeTax)], 'grand')]);
        body += `<h3>The same, added up by line of the return</h3>${table(['Line', h.currency], is.incomeByLine.map(x => row([`Income — ${esc(x.line)}`, fmt(x.amount)])).concat(is.expensesByLine.map(x => row([`Expense — ${esc(x.line)}`, fmt(x.amount)]))))}`;
        if (ws.balance) {
            const b = ws.balance;
            const sec = (title, list) => (list.length ? [`<tr class="sub"><td colspan="3">${esc(title)}</td></tr>`, ...list.map(r => row([esc(r.line), `${esc(r.code)} ${esc(r.account)}`, fmt(r.amount)]))] : []);
            body += `<h2>2. Balance sheet at ${esc(longDate(h.period_to))}</h2>${table(['Line of the return', 'From the ledger', h.currency], [
                ...sec('Non-current assets', b.nonCurrentAssets), ...sec('Current assets', b.currentAssets), row(['Total assets', '', fmt(b.totalAssets)], 'total'),
                ...sec('Equity', b.equity), ...sec('Non-current liabilities', b.nonCurrentLiabilities), ...sec('Current liabilities', b.currentLiabilities),
                row(['Total equity and liabilities', '', fmt(b.totalEquity + b.totalLiabilities)], 'total')])}`;
        }
        const c = ws.computation;
        body += `<h2>3. Tax computation</h2>${table(['', h.currency], [
            row(['Profit / (loss) before tax per the accounts', fmt(c.profitBeforeTax)]),
            ...c.addBacks.map(a => row([`Add: ${esc(a.label)}`, fmt(a.amount)])),
            ...c.deductions.map(a => row([`Less: ${esc(a.label)}`, fmt(-a.amount)])),
            row(['Chargeable income / (loss)', fmt(c.chargeableIncome)], 'total'),
            row(['Less: losses brought forward used', fmt(-c.lossUtilised)]),
            row(['Taxable income', fmt(c.taxableIncome)], 'total'),
            row([`Tax at ${c.taxRate}%`, fmt(c.grossTax)]),
            row(['Less: creditable withholding tax (schedule 4)', fmt(-c.whtCredits)]),
            row(['Less: provisional tax paid (schedule 5)', fmt(-c.provisionalPaid)]),
            row([c.balanceDue >= 0 ? 'Tax payable with the return' : 'Refund due', fmt(c.balanceDue)], 'grand'),
            row(['Loss carried forward to next year', fmt(c.lossCarriedForward)]),
        ])}`;
        body += `<h2>4. Schedule — creditable withholding tax</h2>${ws.whtCredits.length ? table(['Date', 'Payer', 'Certificate', 'Tax'], ws.whtCredits.map(x => `<tr><td>${esc(x.date)}</td><td>${esc(x.description)}</td><td>${esc(x.certificate || '— missing')}</td><td class="num">${fmt(x.amount)}</td></tr>`)) : '<p class="muted">None.</p>'}`;
        body += `<h2>5. Schedule — tax paid to URA for the year</h2>${ws.payments.length ? table(['Date', 'Kind', 'PRN', 'Reference', 'Amount'], ws.payments.map(x => `<tr><td>${esc(x.date)}</td><td>${esc(x.kind.replace(/_/g, ' ').toLowerCase())}${x.instalment ? ` ${x.instalment}` : ''}</td><td>${esc(x.prn || '')}</td><td>${esc(x.reference || '')}</td><td class="num">${fmt(x.amount)}</td></tr>`)) : '<p class="muted">None.</p>'}`;
        if (ws.finalTaxIncome.length) body += `<h2>6. Schedule — income taxed at source as final tax (not taxed again)</h2>${table(['Date', 'Income', 'Gross', 'Tax'], ws.finalTaxIncome.map(x => `<tr><td>${esc(x.date)}</td><td>${esc(x.description)}</td><td class="num">${fmt(x.amount)}</td><td class="num">${fmt(x.tax)}</td></tr>`))}`;
    }
    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(h.form)} — ${esc(h.year_label)}</title><style>
  @page { size: A4; margin: 15mm; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 9.5pt; color: #1f2937; }
  h1 { font-size: 15pt; margin: 0 0 2px; color: #1e3a5f; } h2 { font-size: 11.5pt; margin: 16px 0 6px; color: #1e3a5f; border-bottom: 1px solid #cbd5e1; padding-bottom: 2px; }
  h3 { font-size: 10pt; margin: 10px 0 4px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 6px; } th, td { padding: 3px 6px; text-align: left; vertical-align: top; }
  th { border-bottom: 1px solid #94a3b8; font-size: 8.5pt; color: #475569; } td.num, th.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; width: 30mm; }
  tr.total td { border-top: 1px solid #64748b; font-weight: 700; } tr.grand td { border-top: 1px solid #334155; border-bottom: 3px double #334155; font-weight: 700; }
  tr.sub td { font-weight: 700; color: #1e3a5f; padding-top: 8px; }
  .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 18px; margin: 8px 0 10px; } .meta div span { color: #64748b; }
  .warn { border: 1px solid #f59e0b; background: #fffbeb; padding: 6px 9px; margin: 8px 0; } .muted { color: #64748b; font-size: 8.5pt; }
  .note { border-left: 3px solid #1e3a5f; padding: 4px 8px; background: #f8fafc; margin: 8px 0; font-size: 8.5pt; }
</style></head><body>
<h1>${esc(h.form)}</h1><div class="muted">Worksheet to fill the return on the URA portal — figures from the company's books</div>
<div class="meta">
  <div><span>Taxpayer:</span> ${esc(h.company)}</div><div><span>TIN:</span> ${esc(h.tin || '— not set (Tax › Settings)')}</div>
  <div><span>Registration no.:</span> ${esc(h.registration_number || '')}</div><div><span>Tax office:</span> ${esc(h.tax_office || '')}</div>
  <div><span>Year of income:</span> ${esc(h.year_label)} (${esc(longDate(h.period_from))} – ${esc(longDate(h.period_to))})</div><div><span>Currency:</span> Uganda Shillings (${esc(h.currency)}), whole shillings</div>
  <div><span>Return type:</span> ${esc(h.return_type)}</div><div><span>${h.kind === 'FINAL' ? 'Return due by' : 'Instalments due'}:</span> ${esc(h.kind === 'FINAL' ? longDate(h.return_due) : `${longDate(h.provisional1_due)} and ${longDate(h.provisional2_due)}`)}</div>
  <div><span>Computation:</span> ${esc(h.status.toLowerCase())}${h.prepared_by ? ` — prepared by ${esc(h.prepared_by)}` : ''}${h.approved_by ? `, approved by ${esc(h.approved_by)}` : ''}</div>
  <div><span>Made:</span> ${esc(new Date(h.computed_at).toLocaleString('en-GB'))}</div>
</div>
${ws.warnings.length ? `<div class="warn"><strong>Check before filing:</strong><ul>${ws.warnings.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
<div class="note">Copy each figure to the line of the return with the same name. URA renumbers the form's sections from time to time; the names of the lines stay the same. Amounts are in whole shillings; brackets mean a negative amount.</div>
${body}
</body></html>`;
};

// ------------------------------------------------------------
// Excel
// ------------------------------------------------------------
const buildWorkbook = async (ws) => {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const NUM = '#,##0;(#,##0);"–"';
    const h = ws.header;
    const sheet = (name, cols) => { const s = wb.addWorksheet(name, { views: [{ showGridLines: false }] }); s.columns = cols.map(w => ({ width: w })); return s; };
    const title = (s, t) => { s.addRow([t]).font = { bold: true, size: 12 }; };
    const head = (s, cells) => { const r = s.addRow(cells); r.font = { bold: true }; r.border = { bottom: { style: 'thin' } }; };
    const money = (r, cols) => cols.forEach(c => { r.getCell(c).numFmt = NUM; });

    const info = sheet('Return details', [32, 60]);
    title(info, h.form);
    [['Taxpayer', h.company], ['TIN', h.tin || 'not set'], ['Registration no.', h.registration_number], ['Tax office', h.tax_office],
        ['Year of income', `${h.year_label} (${h.period_from} – ${h.period_to})`], ['Currency', `${h.currency}, whole shillings`],
        ['Return type', h.return_type], ['Computation status', h.status], ['Return due by', h.kind === 'FINAL' ? h.return_due : `${h.provisional1_due} / ${h.provisional2_due}`]]
        .forEach(([k, v]) => { const r = info.addRow([k, v || '']); r.getCell(1).font = { bold: true }; });
    info.addRow([]);
    info.addRow(['How to use', 'Copy each figure to the line of the return with the same name (URA renumbers sections; the line names stay the same).']).getCell(2).alignment = { wrapText: true };
    if (ws.warnings.length) { info.addRow([]); info.addRow(['Check before filing']).font = { bold: true, color: { argb: 'FFB45309' } }; ws.warnings.forEach(x => { info.addRow(['', x]).getCell(2).alignment = { wrapText: true }; }); }

    if (h.kind === 'PROVISIONAL') {
        const p = ws.provisional;
        const s = sheet('Provisional', [56, 20]);
        title(s, 'Estimate of chargeable income');
        head(s, ['Line', h.currency]);
        const r1 = s.addRow(['Estimated chargeable income for the year', p.estimate]); money(r1, [2]);
        const r2 = s.addRow([`Tax on it at ${p.rate}%`, p.estimated_tax]); money(r2, [2]);
        const r3 = s.addRow(['Less: creditable withholding tax already deducted', -p.creditable_wht]); money(r3, [2]);
        const r4 = s.addRow(['Provisional tax payable', p.payable === null ? null : { formula: `MAX(0,B${r2.number}+B${r3.number})`, result: p.payable }]); money(r4, [2]); r4.font = { bold: true };
        s.addRow([]);
        title(s, 'Instalments');
        head(s, ['Instalment / due by', 'Amount', 'Paid', 'Still to pay']);
        s.columns = [{ width: 56 }, { width: 18 }, { width: 18 }, { width: 18 }];
        p.instalments.forEach(i => { const r = s.addRow([`${i.no} — ${i.share} — due ${i.due}`, i.amount, i.paid, i.balance]); money(r, [2, 3, 4]); });
    } else {
        const is = ws.incomeStatement;
        const s = sheet('Income statement', [44, 40, 18]);
        title(s, `Income statement ${h.period_from} – ${h.period_to}`);
        head(s, ['Line of the return', 'From the ledger', h.currency]);
        const f1 = s.rowCount + 1; is.income.forEach(r => money(s.addRow([r.line, `${r.code} ${r.account}`, r.amount]), [3])); const l1 = s.rowCount;
        const ti = s.addRow(['Total income', '', { formula: `SUM(C${f1}:C${l1})`, result: is.totalIncome }]); ti.font = { bold: true }; money(ti, [3]);
        const f2 = s.rowCount + 1; is.expenses.forEach(r => money(s.addRow([r.line, `${r.code} ${r.account}`, r.amount]), [3])); const l2 = s.rowCount;
        const te = s.addRow(['Total expenses', '', { formula: `SUM(C${f2}:C${l2})`, result: is.totalExpenses }]); te.font = { bold: true }; money(te, [3]);
        const pb = s.addRow(['Profit / (loss) before tax', '', { formula: `C${ti.number}-C${te.number}`, result: is.totalIncome - is.totalExpenses }]); pb.font = { bold: true }; money(pb, [3]);
        if (ws.balance) {
            const b = ws.balance;
            const bs = sheet('Balance sheet', [44, 40, 18]);
            title(bs, `Balance sheet at ${h.period_to}`);
            head(bs, ['Line of the return', 'From the ledger', h.currency]);
            const block = (label, list) => { if (!list.length) return null; bs.addRow([label]).font = { bold: true }; const f = bs.rowCount + 1; list.forEach(r => money(bs.addRow([r.line, `${r.code} ${r.account}`, r.amount]), [3])); return { f, l: bs.rowCount }; };
            const ranges = [block('Non-current assets', b.nonCurrentAssets), block('Current assets', b.currentAssets)].filter(Boolean);
            const ta = bs.addRow(['Total assets', '', { formula: ranges.map(x => `SUM(C${x.f}:C${x.l})`).join('+') || '0', result: b.totalAssets }]); ta.font = { bold: true }; money(ta, [3]);
            const ranges2 = [block('Equity', b.equity), block('Non-current liabilities', b.nonCurrentLiabilities), block('Current liabilities', b.currentLiabilities)].filter(Boolean);
            const tel = bs.addRow(['Total equity and liabilities', '', { formula: ranges2.map(x => `SUM(C${x.f}:C${x.l})`).join('+') || '0', result: b.totalEquity + b.totalLiabilities }]); tel.font = { bold: true }; money(tel, [3]);
        }
        const c = ws.computation;
        const cs = sheet('Tax computation', [70, 20]);
        title(cs, 'Tax computation');
        head(cs, ['', h.currency]);
        const add = (label, v, bold = false) => { const r = cs.addRow([label, v]); money(r, [2]); if (bold) r.font = { bold: true }; return r; };
        add('Profit / (loss) before tax per the accounts', c.profitBeforeTax);
        c.addBacks.forEach(a => add(`Add: ${a.label}`, a.amount));
        c.deductions.forEach(a => add(`Less: ${a.label}`, -a.amount));
        add('Chargeable income / (loss)', c.chargeableIncome, true);
        add('Less: losses brought forward used', -c.lossUtilised);
        add('Taxable income', c.taxableIncome, true);
        add(`Tax at ${c.taxRate}%`, c.grossTax);
        add('Less: creditable withholding tax', -c.whtCredits);
        add('Less: provisional tax paid', -c.provisionalPaid);
        add(c.balanceDue >= 0 ? 'Tax payable with the return' : 'Refund due', c.balanceDue, true);
        add('Loss carried forward', c.lossCarriedForward);
        const sc = sheet('Schedules', [14, 50, 24, 18]);
        title(sc, 'Creditable withholding tax');
        head(sc, ['Date', 'Payer', 'Certificate', 'Tax']);
        ws.whtCredits.forEach(x => money(sc.addRow([x.date, x.description, x.certificate || 'missing', x.amount]), [4]));
        sc.addRow([]);
        title(sc, 'Tax paid to URA for the year');
        head(sc, ['Date', 'Kind', 'PRN', 'Amount']);
        ws.payments.forEach(x => money(sc.addRow([x.date, `${x.kind.replace(/_/g, ' ').toLowerCase()}${x.instalment ? ` ${x.instalment}` : ''}`, x.prn || '', x.amount]), [4]));
    }
    return wb;
};

module.exports = { build, renderHtml, buildWorkbook };
