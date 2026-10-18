// ============================================================
// CURRENCY EXCHANGE RATES CONTROLLER
// Company-set exchange rates, one history per currency pair
// (base -> target), each row covering effective_from up to (but not
// including) effective_to — the same pattern as share_price_history.
//
// v1.66.0 — THESE RATES NOW DRIVE THE BOOKS. They were originally
// display-only (showing the share price in other currencies). Since
// v1.66.0 they are also the rates the financial statements use to
// value every foreign-currency transaction in UGX (except transfers,
// which use their own actual rate) and to revalue foreign-currency
// balances at each month end. So:
//   - Enter the Bank of Uganda rate for each month (at least one row
//     per month, effective the 1st), or more often if you want.
//   - A rate can now be entered for a PAST date and it slots into
//     the history correctly (it used to always be treated as "the
//     newest rate", which scrambled the history if entered out of
//     order). Two rates for the same pair can't start on the same day.
//   - Saving a rate immediately re-values the affected transactions
//     (see fxService.recomputeFunctionalAmounts): any transaction
//     still missing a UGX value, and any transaction on/after the
//     rate's date that is NOT inside a month already revalued and
//     closed. Closed months keep their values — that's what makes
//     them final.
// v1.83.0 — every rate records its SOURCE: entered by hand, or a
// Bank of Uganda rate suggested by the daily feed and approved by a
// person. Hand-entered rates are never overwritten by the feed.
// ============================================================

const { query, withTransaction } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess, sendCreated, sendPaginated, getPagination } = require('../utils/response');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');
const fxService = require('../services/fxService');
const exchangeRateService = require('../services/exchangeRateService');
const fxFeedService = require('../services/fxFeedService');

// ============================================================
// GET CURRENT EXCHANGE RATES
// GET /api/exchange-rates/current
// Any authenticated user. Returns every currently-active rate,
// each showing the base currency it was entered against and the
// target currency it converts to.
// ============================================================
const getCurrentRates = asyncHandler(async (req, res) => {
    const result = await query(`
        SELECT cer.id, cer.rate, cer.effective_from, cer.notes,
               COALESCE(to_jsonb(cer)->>'source', 'MANUAL') AS source, to_jsonb(cer)->>'source_detail' AS source_detail,
               bc.id AS base_currency_id, bc.code AS base_currency_code,
               tc.id AS target_currency_id, tc.code AS target_currency_code, tc.symbol AS target_currency_symbol,
               u.first_name || ' ' || u.last_name AS set_by_name
        FROM   currency_exchange_rates cer
        JOIN   currencies bc ON bc.id = cer.base_currency_id
        JOIN   currencies tc ON tc.id = cer.target_currency_id
        JOIN   users u       ON u.id = cer.set_by
        WHERE  cer.effective_to IS NULL
        ORDER  BY bc.code, tc.code
    `);

    sendSuccess(res, result.rows);
});

// ============================================================
// SET AN EXCHANGE RATE (current or historical)
// POST /api/exchange-rates
// Treasurer / Assistant Treasurer / Admin only. The new rate is
// slotted into this pair's history at effective_from: the rate that
// was covering that date now ends there, and the new rate runs until
// the next later rate starts (or stays open-ended if it's the newest).
// ============================================================
const setExchangeRate = asyncHandler(async (req, res) => {
    const { base_currency_id, target_currency_id, rate, effective_from, notes } = req.body;

    // v1.83.0 — the rules now live in exchangeRateService.setRate, shared
    // with approving a Bank of Uganda suggestion. A rate typed here is
    // recorded as "entered by hand" (source MANUAL), and any BoU
    // suggestion still waiting for the same pair and date is closed —
    // the hand-entered rate is never replaced by the daily feed.
    const newRate = await withTransaction((client) => exchangeRateService.setRate(client, {
        baseCurrencyId: base_currency_id, targetCurrencyId: target_currency_id, rate,
        effectiveDate: effective_from, userId: req.user.id, notes,
        source: 'MANUAL', ipAddress: req.ip,
    }));

    let message = `Exchange rate set to ${rate}, effective ${newRate.effective_from}`;
    message += exchangeRateService.describeRevaluation(newRate);
    if (newRate.fx.realisedTransfers > 0) message += `; exchange results of ${newRate.fx.realisedTransfers} transfer leg(s) recalculated`;
    sendCreated(res, newRate, message + '.');
});

// ============================================================
// GET EXCHANGE RATE HISTORY
// GET /api/exchange-rates/history
// ============================================================
const getRateHistory = asyncHandler(async (req, res) => {
    const { page, limit, offset } = getPagination(req.query);

    const countResult = await query('SELECT COUNT(*) AS total FROM currency_exchange_rates');
    const total = parseInt(countResult.rows[0].total);

    const result = await query(`
        SELECT cer.id, cer.rate, cer.effective_from, cer.effective_to,
               cer.notes, cer.created_at,
               COALESCE(to_jsonb(cer)->>'source', 'MANUAL') AS source, to_jsonb(cer)->>'source_detail' AS source_detail,
               bc.code AS base_currency_code,
               tc.code AS target_currency_code,
               u.first_name || ' ' || u.last_name AS set_by_name
        FROM   currency_exchange_rates cer
        JOIN   currencies bc ON bc.id = cer.base_currency_id
        JOIN   currencies tc ON tc.id = cer.target_currency_id
        JOIN   users u       ON u.id = cer.set_by
        ORDER  BY cer.effective_from DESC
        LIMIT  $1 OFFSET $2
    `, [limit, offset]);

    sendPaginated(res, result.rows, total, page, limit);
});

// ============================================================
// FIXED-RATE RULES (v1.76.0)
// GET /api/exchange-rates/fixed — the company's fixed-rate decisions
// (e.g. 1 EUR = 4,000 UGX before 20 Aug 2025), shown on the Accounts
// page next to the current rates.
// ============================================================
const getFixedRates = asyncHandler(async (req, res) => {
    const rules = await fxService.listFixedRateRules();
    sendSuccess(res, rules.map(f => ({
        id: f.id, base_currency_id: f.base_currency_id, base_currency_code: f.base_code,
        target_currency_id: f.target_currency_id, target_currency_code: f.target_code,
        rate: f.rate, valid_before: f.valid_before, reason: f.reason,
        applied: !!f.applied_at, applied_at: f.applied_at, description: fxService.describeFixedRule(f),
    })));
});

// ============================================================
// DAILY BANK OF UGANDA RATES (v1.83.0)
// The feed only SUGGESTS rates; a Treasurer, Assistant Treasurer or
// Admin approves each one (a person stays in the loop). Approved rates
// are recorded with their source ("Bank of Uganda"). A rate already on
// file for that date — above all one entered by hand — is never
// replaced.
// ============================================================
const listSuggestions = asyncHandler(async (req, res) => {
    sendSuccess(res, await fxFeedService.listSuggestions({ status: req.query.status || 'PENDING', limit: req.query.limit }));
});

const approveSuggestion = asyncHandler(async (req, res) => {
    const out = await fxFeedService.approveSuggestion({
        id: parseInt(req.params.id, 10), userId: req.user.id,
        confirmFlagged: req.body.confirm_flagged === true || req.body.confirm_flagged === 'true', ipAddress: req.ip,
    });
    sendSuccess(res, out, out.message);
});

// Approve every waiting suggestion that is NOT flagged. Flagged ones
// are left for a person to look at one by one.
const approveAllSuggestions = asyncHandler(async (req, res) => {
    const waiting = await fxFeedService.listSuggestions({ status: 'PENDING', limit: 200 });
    const results = [];
    for (const s of waiting.filter(x => !x.flagged)) {
        try {
            const out = await fxFeedService.approveSuggestion({ id: s.id, userId: req.user.id, ipAddress: req.ip });
            results.push({ id: s.id, currency: s.base_currency_code, ok: true, kept: out.kept, message: out.message });
        } catch (e) {
            results.push({ id: s.id, currency: s.base_currency_code, ok: false, message: e.message });
        }
    }
    const approved = results.filter(r => r.ok && !r.kept).length;
    const kept = results.filter(r => r.ok && r.kept).length;
    const failed = results.filter(r => !r.ok).length;
    const flaggedLeft = waiting.filter(x => x.flagged).length;
    let message = `${approved} rate(s) approved`;
    if (kept) message += `; ${kept} kept the rate already on file`;
    if (failed) message += `; ${failed} could not be approved`;
    if (flaggedLeft) message += `; ${flaggedLeft} flagged rate(s) still need checking one by one`;
    sendSuccess(res, { results, approved, kept, failed, flaggedLeft }, message + '.');
});

const rejectSuggestion = asyncHandler(async (req, res) => {
    const row = await fxFeedService.rejectSuggestion({ id: parseInt(req.params.id, 10), userId: req.user.id, reason: req.body.reason, ipAddress: req.ip });
    sendSuccess(res, row, 'Suggested rate rejected — nothing was changed in the books.');
});

const getFeedStatus = asyncHandler(async (req, res) => {
    sendSuccess(res, await fxFeedService.feedStatus());
});

const runFeedNow = asyncHandler(async (req, res) => {
    const out = await fxFeedService.runFeed({ trigger: 'BY_HAND', userId: req.user.id });
    sendSuccess(res, out, out.message);
});

const updateFeedSettings = asyncHandler(async (req, res) => {
    const { enabled, jump_limit_pct, transfer_warn_pct } = req.body;
    const settings = await fxFeedService.updateFeedSettings({
        enabled, jumpLimitPct: jump_limit_pct, transferWarnPct: transfer_warn_pct, userId: req.user.id,
    });
    sendSuccess(res, settings, 'Daily rate settings saved.');
});

// GET /api/exchange-rates/reference?from=&to=&date= — the rate on file
// for a date (used by the transfer form to compare the bank's rate).
const getReferenceRate = asyncHandler(async (req, res) => {
    // Either a currency id or its code (the account lists carry codes).
    const resolve = async (v) => {
        if (/^\d+$/.test(String(v || ''))) return parseInt(v, 10);
        const r = await query('SELECT id FROM currencies WHERE UPPER(code) = UPPER($1)', [String(v || '')]);
        return r.rows[0]?.id || null;
    };
    const from = await resolve(req.query.from);
    const to = await resolve(req.query.to);
    if (!from || !to) throw createError.badRequest('from and to must be known currencies');
    sendSuccess(res, await fxFeedService.referenceRate({ fromCurrencyId: from, toCurrencyId: to, date: req.query.date }));
});

module.exports = {
    getCurrentRates,
    setExchangeRate,
    getRateHistory,
    getFixedRates,
    listSuggestions,
    approveSuggestion,
    approveAllSuggestions,
    rejectSuggestion,
    getFeedStatus,
    runFeedNow,
    updateFeedSettings,
    getReferenceRate,
};
