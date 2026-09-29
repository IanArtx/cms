// ============================================================
// TAX CONTROLLER (v1.70.0)
// HTTP layer over taxService.js — see that file's header for the whole
// model (tax deducted from the company, tax the company withholds, the
// corporate income tax computation, payments to URA, deadlines).
// Role checks are also enforced inside the service against the database.
// ============================================================

const { query, withTransaction } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess, sendCreated } = require('../utils/response');
const { notifyMany } = require('../services/notificationService');
const { wrapEmail } = require('../services/emailTemplates');
const tax = require('../services/taxService');

const id = (req, name = 'id') => parseInt(req.params[name], 10);

// ---- overview, registration, agent status -------------------
const getOverview = asyncHandler(async (req, res) => {
    sendSuccess(res, await tax.getOverview());
});

const getRegistration = asyncHandler(async (req, res) => {
    sendSuccess(res, await tax.getRegistration());
});

const saveRegistration = asyncHandler(async (req, res) => {
    const { tin, registration_number, incorporation_date, tax_office } = req.body;
    const result = await withTransaction(client => tax.saveRegistration(client, {
        tin, registrationNumber: registration_number, incorporationDate: incorporation_date || null,
        taxOffice: tax_office, userId: req.user.id,
    }));
    sendSuccess(res, result, 'Registration and tax details saved');
});

const setAgentStatus = asyncHandler(async (req, res) => {
    const { designated, effective_date, notes } = req.body;
    const result = await withTransaction(client => tax.setAgentStatus(client, {
        designated: designated === true || designated === 'true', effectiveDate: effective_date, notes, userId: req.user.id,
    }));

    // Every active member is told, by notification and email; the notice
    // itself is in everyone's My Documents.
    const members = await query(`
        SELECT DISTINCT u.id, u.email, u.first_name, u.last_name
        FROM   users u JOIN user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
        WHERE  u.is_active = TRUE
    `);
    const statusText = result.designated
        ? `The company has been DESIGNATED by URA as a withholding tax agent with effect from ${result.effectiveDate}. From that date 6% is withheld from payments above UGX 1,000,000 for goods and services, and paid to URA.`
        : `The company is recorded as NOT a designated withholding tax agent with effect from ${result.effectiveDate}. The 6% withholding on payments for goods and services continues to be tracked for reference, but no money is held back.`;
    const html = await wrapEmail(`
        <p>Dear member,</p>
        <p>${statusText}</p>
        <p>The formal notice (${result.referenceCode}) is in <strong>Documents &gt; My Documents</strong>. Withholding tax on dividends and on
        interest paid to members is not affected by this status and continues as before.</p>
    `, { preheader: 'Change of the company\'s withholding tax agent status' });
    notifyMany(members.rows, 'TAX_AGENT_STATUS', () => ({
        title: `Withholding tax agent status: ${result.designated ? 'DESIGNATED' : 'NOT DESIGNATED'}`,
        body: statusText,
        link: '/documents',
        module: 'FINANCE',
        recordType: 'documents',
        recordId: result.documentId,
        email: { subject: `Notice to members — withholding tax agent status (${result.referenceCode})`, html },
    })).catch(() => {});

    sendSuccess(res, result, `Status changed and notice ${result.referenceCode} issued to all members`);
});

// ---- rates --------------------------------------------------
const getRates = asyncHandler(async (req, res) => {
    sendSuccess(res, await tax.listRates());
});

const addRate = asyncHandler(async (req, res) => {
    const { code, rate, treatment, threshold_amount, effective_from, legal_reference, notes } = req.body;
    const result = await withTransaction(client => tax.addRate(client, {
        code, rate: parseFloat(rate), treatment, thresholdAmount: threshold_amount, effectiveFrom: effective_from,
        legalReference: legal_reference, notes, userId: req.user.id,
    }));
    sendCreated(res, result, 'New rate saved');
});

// ---- withholdings / remittances -----------------------------
const getWithholdings = asyncHandler(async (req, res) => {
    const { status, month, payment_type } = req.query;
    sendSuccess(res, await tax.listWithholdings({ status: status || null, month: month || null, paymentType: payment_type || null }));
});

const getRemittances = asyncHandler(async (req, res) => {
    sendSuccess(res, await tax.getRemittanceSummary());
});

const remitMonth = asyncHandler(async (req, res) => {
    const { month, account_id, paid_date, prn, return_reference, notes } = req.body;
    const result = await withTransaction(client => tax.remitMonth(client, {
        month, accountId: parseInt(account_id, 10), paidDate: paid_date, prn, returnReference: return_reference, notes, userId: req.user.id,
    }));
    sendCreated(res, result, `Withholding tax for ${month} recorded as paid to URA (${result.referenceCode})` +
        (result.late ? ` — paid after the due date ${result.dueDate}; late payment interest may apply` : ''));
});

const previewWithholding = asyncHandler(async (req, res) => {
    const { payment_type, gross, currency_id, currency_code, date, residency } = req.query;
    await tax.assertMigrated();
    let currencyId = currency_id ? parseInt(currency_id, 10) : null;
    if (!currencyId && currency_code) {
        const c = await query(`SELECT id FROM currencies WHERE code = $1`, [String(currency_code).toUpperCase()]);
        currencyId = c.rows[0]?.id || null;
    }
    if (!currencyId) throw createError.badRequest('currency_id or currency_code is required');
    const result = await tax.computeWithholding(null, {
        paymentType: payment_type, residency: residency || 'RESIDENT', gross: parseFloat(gross),
        currencyId, date: date || new Date().toISOString().slice(0, 10),
    });
    sendSuccess(res, result);
});

// ---- tax deducted from the company --------------------------
const getAtSource = asyncHandler(async (req, res) => {
    const { from, to, treatment } = req.query;
    sendSuccess(res, await tax.listTaxAtSource({ from: from || null, to: to || null, treatment: treatment || null }));
});

// Tax the payer kept back from income that was already recorded GROSS
// (e.g. a bank statement showing interest and the tax on it): posts the
// tax as its own leg on the account and adds it to the register.
const recordAtSource = asyncHandler(async (req, res) => {
    const { account_id, source_type, payer_name, payer_tin, gross_amount, tax_amount, treatment, deduction_date,
        certificate_number, income_transaction_id, notes } = req.body;
    const result = await withTransaction(async (client) => {
        const roles = await tax.getActiveRoleNames(client, req.user.id);
        if (!roles.some(r => tax.ROLES.PREPARE.includes(r))) throw createError.forbidden('Only the Treasurer or Assistant Treasurer can record tax deducted at source.');
        const acc = await client.query(`SELECT id, currency_id FROM accounts WHERE id = $1 AND is_active = TRUE`, [account_id]);
        if (!acc.rows.length) throw createError.notFound('Account not found');
        if (parseFloat(tax_amount) >= parseFloat(gross_amount)) throw createError.badRequest('The tax must be less than the gross income.');
        const categoryId = await tax.getTaxCategoryId(client, 'AT_SOURCE', req.user.id);
        const leg = await tax.postTaxLeg(client, {
            accountId: acc.rows[0].id, currencyId: acc.rows[0].currency_id, amount: tax_amount, date: deduction_date,
            treatment, categoryId, userId: req.user.id,
            description: `Tax deducted at source by ${payer_name || 'the payer'} (${String(treatment).toLowerCase()})`,
        });
        const rec = await tax.recordTaxAtSource(client, {
            sourceType: source_type || 'OTHER', payerName: payer_name || null, payerTin: payer_tin || null,
            incomeTransactionId: income_transaction_id || null, taxTransactionId: leg.transactionId, cashLeg: true,
            rate: Math.round((parseFloat(tax_amount) / parseFloat(gross_amount)) * 1000000) / 10000,
            treatment, gross: gross_amount, tax: tax_amount, currencyId: acc.rows[0].currency_id, date: deduction_date,
            certificateNumber: certificate_number || null, notes: notes || null, userId: req.user.id,
        });
        return { ...rec, transactionReference: leg.referenceCode };
    });
    sendCreated(res, result, `Tax deducted at source recorded (${result.referenceCode})`);
});

const updateAtSource = asyncHandler(async (req, res) => {
    const { treatment, certificate_number, certificate_received_at, payer_tin, payer_name, notes } = req.body;
    await withTransaction(client => tax.updateTaxAtSource(client, {
        id: id(req), treatment, certificateNumber: certificate_number, certificateReceivedAt: certificate_received_at,
        payerTin: payer_tin, payerName: payer_name, notes, userId: req.user.id,
    }));
    sendSuccess(res, { id: id(req) }, 'Updated');
});

// ---- tax years ----------------------------------------------
const getYears = asyncHandler(async (req, res) => {
    sendSuccess(res, await tax.listTaxYears());
});

const getWorksheet = asyncHandler(async (req, res) => {
    await tax.assertMigrated();
    const year = await tax.getTaxYear(null, id(req));
    const live = await tax.computeWorksheet(year);
    // For a prepared/approved/filed year, the frozen snapshot is the
    // official one; the live figures are returned beside it so any later
    // change stands out.
    sendSuccess(res, { live, snapshot: year.computation || null, status: year.status });
});

const updateYearOptions = asyncHandler(async (req, res) => {
    const { include_pre_incorporation, fx_revaluation_taxable, notes } = req.body;
    await withTransaction(client => tax.updateYearOptions(client, {
        taxYearId: id(req), includePreIncorporation: include_pre_incorporation, fxRevaluationTaxable: fx_revaluation_taxable,
        notes, userId: req.user.id,
    }));
    sendSuccess(res, null, 'Options saved');
});

const setProvisional = asyncHandler(async (req, res) => {
    const result = await withTransaction(client => tax.setProvisionalEstimate(client, {
        taxYearId: id(req), estimate: req.body.estimate, userId: req.user.id,
    }));
    sendSuccess(res, result, 'Provisional estimate saved');
});

const addAdjustment = asyncHandler(async (req, res) => {
    const { kind, description, amount, legal_reference } = req.body;
    const result = await withTransaction(client => tax.addAdjustment(client, {
        taxYearId: id(req), kind, description, amount, legalReference: legal_reference, userId: req.user.id,
    }));
    sendCreated(res, result, 'Adjustment added');
});

const removeAdjustment = asyncHandler(async (req, res) => {
    await withTransaction(client => tax.removeAdjustment(client, { adjustmentId: id(req), userId: req.user.id }));
    sendSuccess(res, null, 'Adjustment removed');
});

const prepareYear = asyncHandler(async (req, res) => {
    const w = await withTransaction(client => tax.prepareYear(client, { taxYearId: id(req), userId: req.user.id }));
    sendSuccess(res, w, `Computation prepared — a Director now approves it`);
});

const returnYear = asyncHandler(async (req, res) => {
    await withTransaction(client => tax.returnYear(client, { taxYearId: id(req), reason: req.body.reason, userId: req.user.id }));
    sendSuccess(res, null, 'Sent back to the Treasurer');
});

const approveYear = asyncHandler(async (req, res) => {
    const w = await withTransaction(client => tax.approveYear(client, { taxYearId: id(req), userId: req.user.id }));
    sendSuccess(res, w, 'Computation approved — the corporate tax is now in the books');
});

const fileYear = asyncHandler(async (req, res) => {
    const { filing_date, return_reference } = req.body;
    const r = await withTransaction(client => tax.fileYear(client, {
        taxYearId: id(req), filingDate: filing_date, returnReference: return_reference, userId: req.user.id,
    }));
    sendSuccess(res, r, r.late ? 'Marked as filed — after the due date; a late filing penalty may apply' : 'Marked as filed');
});

// ---- payments -----------------------------------------------
const recordPayment = asyncHandler(async (req, res) => {
    const { tax_year_id, kind, instalment_no, amount, account_id, paid_date, prn, notes } = req.body;
    const r = await withTransaction(client => tax.recordTaxPayment(client, {
        taxYearId: tax_year_id ? parseInt(tax_year_id, 10) : null, kind, instalmentNo: instalment_no,
        amount, accountId: parseInt(account_id, 10), paidDate: paid_date, prn, notes, userId: req.user.id,
    }));
    sendCreated(res, r, `Payment recorded (${r.referenceCode})`);
});

// ---- calendar, members' own view ----------------------------
const getCalendar = asyncHandler(async (req, res) => {
    sendSuccess(res, await tax.getCalendar());
});

const getMyWithholdings = asyncHandler(async (req, res) => {
    if (!(await tax.isMigrated())) return sendSuccess(res, []);
    sendSuccess(res, await tax.getMyWithholdings(req.user.id));
});

module.exports = {
    getOverview, getRegistration, saveRegistration, setAgentStatus,
    getRates, addRate,
    getWithholdings, getRemittances, remitMonth, previewWithholding,
    getAtSource, recordAtSource, updateAtSource,
    getYears, getWorksheet, updateYearOptions, setProvisional, addAdjustment, removeAdjustment,
    prepareYear, returnYear, approveYear, fileYear,
    recordPayment, getCalendar, getMyWithholdings,
};
