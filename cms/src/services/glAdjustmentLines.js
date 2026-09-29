// ============================================================
// GENERAL LEDGER — NON-CASH ADJUSTING ENTRIES added in v1.70.0
//
// glService.js derives the double-entry books from the single-leg
// `transactions` table. Some events change what is owed or earned
// without a `transactions` row of their own; glService builds those as
// synthetic ("adjusting") ledger lines. This file holds the ones added
// with the tax system (v1.70.0), each explained where it is built:
//
//   TAX (see taxService.js for how the records are made)
//    A. Tax WE withhold (wht_withholdings) — the cash transaction only
//       pays the NET amount; the tax held back is moved from where the
//       gross payment was charged into 2500 WHT Payable:
//           Dr <debit_gl_code>   Cr 2500
//    B. Tax deducted FROM us inside another amount (tax_at_source with
//       cash_leg = FALSE, e.g. a treasury bill whose tax was added to
//       the purchase price):   Dr 5700 or 1500   Cr <contra_gl_code>
//    C. Corporate income tax of an APPROVED tax year (at its end date):
//           Dr 5710   Cr 2510
//    D. At FILING, the year's creditable WHT and provisional tax are set
//       off against it:  Dr 2510 Cr 1500  and  Dr 2510 Cr 1510
//
//   ACCOUNTING CORRECTIONS the tax figures depend on (the underlying
//   records already existed; the ledger had never used them)
//    E. Members' savings interest ACCRUED (savings_interest_accrual —
//       the daily job) is an expense and a debt to the member as it
//       accrues, not only when handed out:  Dr 5100   Cr 2100
//       (one line pair per currency per month).
//    F. The INTEREST (and penalty) part of a loan repayment. Repayments
//       are posted whole to the loan account; the interest part is
//       moved to interest expense / income:
//           loan received:  Dr 5100   Cr 2000
//           loan given:     Dr 1100   Cr 4000
//    G. Money market fund interest earned (mmf_transactions INTEREST)
//       Dr 1300 Cr 4100, and management fees charged by the fund
//       (MANAGEMENT_FEE)  Dr 5000 Cr 1300 — neither moves bank cash.
//    H. Investment closed (COMPLETED or TERMINATED): whatever is left
//       of its cost in 1400 was not recovered as capital, so it is
//       taken against investment income (a credit balance — more came
//       back as capital than was paid, e.g. a bond bought at a discount
//       — is a gain):  Dr 4100 Cr 1400  (or the reverse).
//
// Every builder returns { lines, unconverted } in the requested basis:
//   FUNCTIONAL — UGX amounts (at the fixed rate stored on the record,
//     or the rate on the date); the original amount/currency ride along;
//     a missing rate puts the item in `unconverted` (never guessed).
//   CURRENCY  — the original amount in its own currency.
// Nothing here writes to the database.
// ============================================================

const { query } = require('../config/database');
const fxService = require('./fxService');

const { BASIS, round2, toDateStr } = fxService;

const tableExists = async (name) => {
    const r = await query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [name]);
    return r.rows[0].ok;
};
const columnExists = async (table, column) => {
    const r = await query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
        [table, column]
    );
    return r.rows.length > 0;
};

// ------------------------------------------------------------
// One balanced pair of lines. `amount` is in the ORIGINAL currency;
// `functionalAmount` (optional) is a fixed UGX value stored on the
// record — otherwise the rate is looked up on the date.
// A negative amount swaps the sides.
// ------------------------------------------------------------
const makePair = ({
    basis, ctx, date, drGlId, crGlId, amount, currencyId, currencyCode, currencySymbol,
    functionalAmount = null, knownRate = null, description, sourceType, sourceId = null,
    referenceCode = null, investmentId = null, lines, unconverted,
}) => {
    let orig = round2(parseFloat(amount));
    if (!drGlId || !crGlId || !(Math.abs(orig) >= 0.005)) return;
    let dr = drGlId;
    let cr = crGlId;
    let fixed = functionalAmount !== null && functionalAmount !== undefined ? parseFloat(functionalAmount) : null;
    if (orig < 0) {
        orig = -orig; [dr, cr] = [cr, dr];
        if (fixed !== null) fixed = -fixed;
    }

    let value = orig;
    let rate = null;
    let currencyFields = { currencyId, currencyCode, currencySymbol };
    if (basis === BASIS.FUNCTIONAL) {
        const f = ctx.functionalCurrency;
        if (fixed !== null && !Number.isNaN(fixed)) {
            value = round2(Math.abs(fixed));
            rate = knownRate !== null ? knownRate : (orig ? value / orig : null);
        } else {
            rate = knownRate !== null ? knownRate : ctx.rateOn(currencyId, f.id, date);
            if (rate === null || rate === undefined) {
                unconverted.push({ transactionId: null, referenceCode, date, currencyCode, amount: orig, description });
                return;
            }
            value = round2(orig * rate);
        }
        currencyFields = { currencyId: f.id, currencyCode: f.code, currencySymbol: f.symbol };
    }
    const common = {
        date, accountId: null, description, referenceCode, categoryTrail: null,
        sourceType, sourceId, investmentId,
        originalCurrencyId: currencyId, originalCurrencyCode: currencyCode,
        fxRate: basis === BASIS.FUNCTIONAL ? rate : null,
        fxRateSource: basis === BASIS.FUNCTIONAL ? (fixed !== null ? 'RECORDED' : 'RATE_TABLE') : null,
        ...currencyFields,
    };
    lines.push({ ...common, glAccountId: dr, debit: value, credit: 0, originalDebit: orig, originalCredit: 0 });
    lines.push({ ...common, glAccountId: cr, debit: 0, credit: value, originalDebit: 0, originalCredit: orig });
};

const inRangeFn = (fromDate, toDate) => {
    const fromStr = toDateStr(fromDate);
    const toStr = toDateStr(toDate);
    return (d) => !!d && (!fromStr || d >= fromStr) && (!toStr || d <= toStr);
};

// ============================================================
// A + B + C + D — the tax entries
// ============================================================
const getTaxLines = async ({ fromDate, toDate, basis, ctx, glByCode }) => {
    const lines = [];
    const unconverted = [];
    if (!(await tableExists('wht_withholdings'))) return { lines, unconverted };
    const inRange = inRangeFn(fromDate, toDate);
    const gl = (code) => glByCode.get(code);

    // A. Tax we withheld (real rows only — shadow rows never touch the books)
    const wht = await query(`
        SELECT w.id, w.payment_type, w.payee_name, w.tax_amount, w.tax_functional, w.functional_rate,
               w.withholding_date::text AS withholding_date, w.reversal_date::text AS reversal_date,
               w.status, w.debit_gl_code, w.currency_id, c.code AS currency_code, c.symbol AS currency_symbol,
               rr.reference_code
        FROM   wht_withholdings w
        JOIN   currencies c ON c.id = w.currency_id
        LEFT JOIN references_registry rr ON rr.id = w.reference_id
        WHERE  w.is_shadow = FALSE AND w.tax_amount > 0
    `);
    for (const w of wht.rows) {
        const dr = gl(w.debit_gl_code);
        const cr = gl('2500');
        if (!dr || !cr) continue;
        const label = `WHT withheld (${w.payment_type.replace(/_/g, ' ').toLowerCase()}) — ${w.payee_name}`;
        const base = {
            basis, ctx, drGlId: dr.id, crGlId: cr.id, currencyId: w.currency_id, currencyCode: w.currency_code,
            currencySymbol: w.currency_symbol, functionalAmount: w.tax_functional,
            knownRate: w.functional_rate !== null ? parseFloat(w.functional_rate) : null,
            sourceType: 'WHT_WITHHELD', sourceId: w.id, referenceCode: w.reference_code, lines, unconverted,
        };
        if (inRange(w.withholding_date)) {
            makePair({ ...base, date: w.withholding_date, amount: w.tax_amount, description: label });
        }
        if (w.status === 'REVERSED' && w.reversal_date && inRange(w.reversal_date)) {
            makePair({ ...base, date: w.reversal_date, amount: -parseFloat(w.tax_amount),
                functionalAmount: w.tax_functional !== null ? -parseFloat(w.tax_functional) : null,
                description: `REVERSAL — ${label}` });
        }
    }

    // B. Tax deducted from us inside another amount (no cash leg of its own)
    const tas = await query(`
        SELECT s.id, s.source_type, s.payer_name, s.treatment, s.tax_amount, s.tax_functional, s.functional_rate,
               s.contra_gl_code, s.investment_id, s.deduction_date::text AS deduction_date,
               s.reversed_at::text AS reversed_at, s.status,
               s.currency_id, c.code AS currency_code, c.symbol AS currency_symbol, rr.reference_code
        FROM   tax_at_source s
        JOIN   currencies c ON c.id = s.currency_id
        LEFT JOIN references_registry rr ON rr.id = s.reference_id
        WHERE  s.cash_leg = FALSE
    `);
    for (const s of tas.rows) {
        const dr = gl(s.treatment === 'FINAL' ? '5700' : '1500');
        const cr = gl(s.contra_gl_code);
        if (!dr || !cr) continue;
        const label = `Tax deducted at source (${s.treatment.toLowerCase()}) — ${s.payer_name || s.source_type}`;
        const base = {
            basis, ctx, drGlId: dr.id, crGlId: cr.id, currencyId: s.currency_id, currencyCode: s.currency_code,
            currencySymbol: s.currency_symbol, knownRate: s.functional_rate !== null ? parseFloat(s.functional_rate) : null,
            sourceType: 'TAX_AT_SOURCE', sourceId: s.id, referenceCode: s.reference_code,
            investmentId: s.investment_id, lines, unconverted,
        };
        if (inRange(s.deduction_date)) {
            makePair({ ...base, date: s.deduction_date, amount: s.tax_amount, functionalAmount: s.tax_functional, description: label });
        }
        if (s.status === 'REVERSED' && s.reversed_at && inRange(s.reversed_at)) {
            makePair({ ...base, date: s.reversed_at, amount: -parseFloat(s.tax_amount),
                functionalAmount: s.tax_functional !== null ? -parseFloat(s.tax_functional) : null,
                description: `REVERSAL — ${label}` });
        }
    }

    // C + D. Corporate income tax (UGX — the functional currency)
    const f = ctx ? ctx.functionalCurrency : (await fxService.getAccountingSettings()).functionalCurrency;
    if (f) {
        const years = await query(`
            SELECT id, label, status, end_date::text AS end_date, filing_date::text AS filing_date,
                   gross_tax, wht_credits, provisional_paid
            FROM   tax_years
            WHERE  status IN ('APPROVED', 'FILED')
        `);
        for (const y of years.rows) {
            const base = {
                basis, ctx, currencyId: f.id, currencyCode: f.code, currencySymbol: f.symbol, knownRate: 1,
                sourceType: 'CORPORATE_TAX', sourceId: y.id, lines, unconverted,
            };
            if (inRange(y.end_date) && parseFloat(y.gross_tax) > 0) {
                makePair({ ...base, date: y.end_date, drGlId: gl('5710')?.id, crGlId: gl('2510')?.id,
                    amount: y.gross_tax, description: `Corporate income tax — ${y.label}` });
            }
            if (y.status === 'FILED' && y.filing_date && inRange(y.filing_date)) {
                if (parseFloat(y.wht_credits) > 0) {
                    makePair({ ...base, date: y.filing_date, drGlId: gl('2510')?.id, crGlId: gl('1500')?.id,
                        amount: y.wht_credits, description: `Withholding tax credits set off — ${y.label}` });
                }
                if (parseFloat(y.provisional_paid) > 0) {
                    makePair({ ...base, date: y.filing_date, drGlId: gl('2510')?.id, crGlId: gl('1510')?.id,
                        amount: y.provisional_paid, description: `Provisional tax set off — ${y.label}` });
                }
            }
        }
    }
    return { lines, unconverted };
};

// ============================================================
// E — members' savings interest accrued (per currency per month)
// ============================================================
const getSavingsInterestAccrualLines = async ({ fromDate, toDate, basis, ctx, glByCode }) => {
    const lines = [];
    const unconverted = [];
    if (!(await tableExists('savings_interest_accrual'))) return { lines, unconverted };
    const params = [];
    const cond = [];
    if (fromDate) { params.push(toDateStr(fromDate)); cond.push(`a.accrual_date >= $${params.length}`); }
    if (toDate)   { params.push(toDateStr(toDate));   cond.push(`a.accrual_date <= $${params.length}`); }
    const result = await query(`
        SELECT a.currency_id, c.code AS currency_code, c.symbol AS currency_symbol,
               to_char(date_trunc('month', a.accrual_date), 'YYYY-MM') AS month,
               MAX(a.accrual_date)::text AS last_date, SUM(a.interest_accrued) AS total
        FROM   savings_interest_accrual a
        JOIN   currencies c ON c.id = a.currency_id
        ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
        GROUP  BY a.currency_id, c.code, c.symbol, date_trunc('month', a.accrual_date)
        ORDER  BY 4
    `, params);
    const dr = glByCode.get('5100');
    const cr = glByCode.get('2100');
    for (const r of result.rows) {
        makePair({
            basis, ctx, date: r.last_date, drGlId: dr?.id, crGlId: cr?.id, amount: r.total,
            currencyId: r.currency_id, currencyCode: r.currency_code, currencySymbol: r.currency_symbol,
            description: `Members' savings interest accrued — ${r.month} (${r.currency_code})`,
            sourceType: 'SAVINGS_INTEREST_ACCRUAL', lines, unconverted,
        });
    }
    return { lines, unconverted };
};

// ============================================================
// F — interest part of loan repayments (received and given)
// ============================================================
const getLoanInterestLines = async ({ fromDate, toDate, basis, ctx, glByCode }) => {
    const lines = [];
    const unconverted = [];
    const inRange = inRangeFn(fromDate, toDate);
    const specs = [
        { table: 'loan_received_repayments', loanTable: 'loans_received', fk: 'loan_received_id', nameCol: 'lender_name',
          dr: '5100', cr: '2000', label: 'Interest paid on loan received' },
        { table: 'loan_given_repayments', loanTable: 'loans_given', fk: 'loan_given_id', nameCol: null,
          dr: '1100', cr: '4000', label: 'Interest earned on loan given' },
    ];
    for (const s of specs) {
        if (!(await tableExists(s.table))) continue;
        const result = await query(`
            SELECT r.id, (COALESCE(r.interest_portion, 0) + COALESCE(r.penalty_portion, 0)) AS interest,
                   t.value_date::text AS value_date, t.functional_rate, t.is_reversed,
                   (SELECT rv.value_date::text FROM transactions rv WHERE rv.reversal_of = t.id AND rv.status = 'POSTED'
                     ORDER BY rv.id LIMIT 1) AS reversal_date,
                   t.currency_id, c.code AS currency_code, c.symbol AS currency_symbol,
                   rr.reference_code, l.id AS loan_id
                   ${s.nameCol ? `, l.${s.nameCol} AS party` : ', NULL AS party'}
            FROM   ${s.table} r
            JOIN   transactions t ON t.id = r.transaction_id AND t.status = 'POSTED'
            JOIN   ${s.loanTable} l ON l.id = r.${s.fk}
            JOIN   currencies c ON c.id = t.currency_id
            LEFT JOIN references_registry rr ON rr.id = r.reference_id
            WHERE  (COALESCE(r.interest_portion, 0) + COALESCE(r.penalty_portion, 0)) > 0
        `);
        for (const r of result.rows) {
            const label = `${s.label}${r.party ? ` — ${r.party}` : ''}`;
            const base = {
                basis, ctx, drGlId: glByCode.get(s.dr)?.id, crGlId: glByCode.get(s.cr)?.id,
                currencyId: r.currency_id, currencyCode: r.currency_code, currencySymbol: r.currency_symbol,
                knownRate: r.functional_rate !== null ? parseFloat(r.functional_rate) : null,
                sourceType: 'LOAN_INTEREST', sourceId: r.id, referenceCode: r.reference_code, lines, unconverted,
            };
            if (inRange(r.value_date)) makePair({ ...base, date: r.value_date, amount: r.interest, description: label });
            if (r.is_reversed && r.reversal_date && inRange(r.reversal_date)) {
                makePair({ ...base, date: r.reversal_date, amount: -parseFloat(r.interest), description: `REVERSAL — ${label}` });
            }
        }
    }
    return { lines, unconverted };
};

// ============================================================
// G — money market fund interest and management fees
// ============================================================
const getMmfIncomeLines = async ({ fromDate, toDate, basis, ctx, glByCode }) => {
    const lines = [];
    const unconverted = [];
    if (!(await tableExists('mmf_transactions'))) return { lines, unconverted };
    const params = [];
    const cond = [`mt.entry_type IN ('INTEREST', 'MANAGEMENT_FEE')`];
    if (fromDate) { params.push(toDateStr(fromDate)); cond.push(`mt.entry_date >= $${params.length}`); }
    if (toDate)   { params.push(toDateStr(toDate));   cond.push(`mt.entry_date <= $${params.length}`); }
    const result = await query(`
        SELECT mt.id, mt.entry_type, mt.amount, mt.entry_date::text AS entry_date,
               m.name AS fund_name, m.currency_id, c.code AS currency_code, c.symbol AS currency_symbol,
               rr.reference_code
        FROM   mmf_transactions mt
        JOIN   mmf_accounts m ON m.id = mt.mmf_account_id
        JOIN   currencies c ON c.id = m.currency_id
        LEFT JOIN references_registry rr ON rr.id = mt.reference_id
        WHERE  ${cond.join(' AND ')}
    `, params);
    for (const r of result.rows) {
        const interest = r.entry_type === 'INTEREST';
        makePair({
            basis, ctx, date: r.entry_date,
            drGlId: glByCode.get(interest ? '1300' : '5000')?.id,
            crGlId: glByCode.get(interest ? '4100' : '1300')?.id,
            amount: r.amount, currencyId: r.currency_id, currencyCode: r.currency_code, currencySymbol: r.currency_symbol,
            description: interest ? `Money market fund interest earned — ${r.fund_name}` : `Money market fund management fee — ${r.fund_name}`,
            sourceType: interest ? 'MMF_INTEREST' : 'MMF_FEE', sourceId: r.id, referenceCode: r.reference_code,
            lines, unconverted,
        });
    }
    return { lines, unconverted };
};

// ============================================================
// H — investment closed: cost left in 1400 taken to investment income
// `allLines` must be every ledger line up to the report end date (not
// only the ones inside the report's range) so the balance is complete.
// ============================================================
const getInvestmentClosureLines = async ({ fromDate, toDate, basis, ctx, glByCode, allLines }) => {
    const lines = [];
    const unconverted = [];
    const inRange = inRangeFn(fromDate, toDate);
    const invGl = glByCode.get('1400');
    const incomeGl = glByCode.get('4100');
    if (!invGl || !incomeGl) return { lines, unconverted };
    const result = await query(`
        SELECT i.id, i.name, i.status, i.investment_type, i.currency_id, c.code AS currency_code, c.symbol AS currency_symbol,
               COALESCE(i.actual_end_date, i.termination_approved_at::date)::text AS closed_on, rr.reference_code
        FROM   investments i
        JOIN   currencies c ON c.id = i.currency_id
        LEFT JOIN references_registry rr ON rr.id = i.reference_id
        WHERE  i.status IN ('COMPLETED', 'TERMINATED')
        AND    COALESCE(i.actual_end_date, i.termination_approved_at::date) IS NOT NULL
    `);
    const toStr = toDateStr(toDate);
    for (const inv of result.rows) {
        if (toStr && inv.closed_on > toStr) continue;
        // Everything booked to this investment up to the report's end
        // date — including an entry dated after it closed (e.g. a late
        // funding entry). The closure is then dated on the later of the
        // closing date and that last entry, so it always clears 1400.
        let residual = 0;
        let residualOriginal = 0;
        let closureDate = inv.closed_on;
        for (const l of allLines) {
            if (l.glAccountId !== invGl.id || l.investmentId !== inv.id) continue;
            if (toStr && l.date > toStr) continue;
            residual += (l.debit || 0) - (l.credit || 0);
            residualOriginal += (l.originalDebit || 0) - (l.originalCredit || 0);
            if (l.date > closureDate) closureDate = l.date;
        }
        residual = round2(residual);
        if (Math.abs(residual) < 0.01) continue;
        if (!inRange(closureDate)) continue;
        const loss = residual > 0;
        // The original-currency figure only rides along for display; the
        // SIGN always follows the balance being cleared.
        const originalAbs = Math.abs(round2(residualOriginal));
        makePair({
            basis, ctx, date: closureDate,
            drGlId: incomeGl.id, crGlId: invGl.id,
            amount: basis === BASIS.FUNCTIONAL ? Math.sign(residual) * (originalAbs || Math.abs(residual)) : residual,
            functionalAmount: basis === BASIS.FUNCTIONAL ? residual : null,
            currencyId: inv.currency_id, currencyCode: inv.currency_code, currencySymbol: inv.currency_symbol,
            description: loss
                ? `Investment closed — cost not recovered taken against investment income: ${inv.name}`
                : `Investment closed — amount recovered above cost (gain): ${inv.name}`,
            sourceType: 'INVESTMENT_CLOSURE', sourceId: inv.id, referenceCode: inv.reference_code,
            investmentId: inv.id, lines, unconverted,
        });
    }
    return { lines, unconverted };
};

module.exports = {
    tableExists,
    columnExists,
    getTaxLines,
    getSavingsInterestAccrualLines,
    getLoanInterestLines,
    getMmfIncomeLines,
    getInvestmentClosureLines,
};
