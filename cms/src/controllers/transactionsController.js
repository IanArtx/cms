// ============================================================
// TRANSACTIONS CONTROLLER
// Handles all money movements on any account.
//
// RULES ENFORCED HERE:
//   - Every transaction is immutable once posted
//   - Primary account cannot go below floor limit
//   - No account can go below zero
//   - Corrections are reversal entries only
//   - Every transaction gets a unique auto-generated reference
//   - Running balance is recorded on every transaction
// ============================================================

const { query, withTransaction } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess, sendCreated, sendPaginated, getPagination } = require('../utils/response');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');
const { generateReference, linkReferenceToRecord, MODULE_CODES, resolveModuleCode } = require('../services/referenceService');
const { notify } = require('../services/notificationService');
const { wrapEmail } = require('../services/emailTemplates');
const { applySideFundPayment } = require('../services/sideFundService');
const { getOrCreateSavingsBalance, getSavingsAccount } = require('../services/savingsService');
const { convertToShareCurrency, getExchangeRateOn } = require('../services/sharePricingService');
const { loadFiscalQuarters, bucketAndSummarize } = require('../services/quarterAnalyticsService');
const { rowsToCsv, sendCsv } = require('../utils/csv');
const { normalizeDateInput } = require('../utils/dateUtils');
const { getOrCreateCategory } = require('../services/categoryService');
const { copyObject, generateKey, toKey } = require('../services/storageService');
// v1.69.0 — whole-share allotments, members' share credit, nominal value.
const shareCapitalService = require('../services/shareCapitalService');
const taxService = require('../services/taxService');
const reversalLinks = require('../services/reversalLinksService'); // v1.72.0
const moneyApprovalContext = require('../services/moneyApprovalContext'); // v1.73.0
const { assertNotOwnApproval } = require('../services/approvalGuard'); // v1.72.0

// v1.70.0 — a tax amount as a percentage of the gross (for the register).
const round2Pct = (tax, gross) => {
    const g = parseFloat(gross);
    return g > 0 ? Math.round((parseFloat(tax) / g) * 1000000) / 10000 : null;
};

// ============================================================
// INTERNAL HELPER — GET THE FLOOR LIMIT IN EFFECT AS OF A GIVEN DATE
// Floor limits are already tracked as a dated history
// (primary_account_floor_limits.effective_from/effective_to), so a
// transaction dated for the past is checked against whichever limit
// was actually in force back then — not today's — the same
// point-in-time principle applied to the balance check right below
// (v1.62.0). For an ordinary present-dated transaction this returns
// exactly what the old "current only" lookup did.
// The SAVINGS account is a permanent, hard-coded exception: it must
// always be allowed to sit at exactly zero, so no floor limit is ever
// looked up or enforced for it, even if a row somehow exists.
// ============================================================
const getFloorLimit = async (client, accountId, accountType, asOfDate) => {
    if (accountType === 'SAVINGS') return 0;

    const result = await client.query(`
        SELECT floor_amount
        FROM   primary_account_floor_limits
        WHERE  account_id = $1
        AND    effective_from <= $2
        AND    (effective_to IS NULL OR effective_to >= $2)
        ORDER  BY effective_from DESC
        LIMIT  1
    `, [accountId, asOfDate]);

    return result.rows.length > 0 ? parseFloat(result.rows[0].floor_amount) : 0;
};

// ============================================================
// INTERNAL HELPER — POST A TRANSACTION
// This is the core function that actually moves money.
// It is called by contributions, expenses, and transfers.
// It enforces all balance rules before committing.
//
// v1.62.0 — POINT-IN-TIME BALANCE VALIDATION. Every transaction
// carries its own business date (valueDate), independent of when it
// was actually entered (posted_at/transaction_date) — many forms in
// this app already let a Treasurer pick a past date. Previously the
// "can this account afford it" check compared against
// accounts.current_balance, i.e. today's running total including
// everything ever posted regardless of date — so backdating a debit
// to, say, last Tuesday was silently validated against MONEY THAT
// HADN'T ARRIVED YET on that Tuesday, as long as it existed by today.
// Requested directly: "if the transaction of UGX 4M was made then but
// the balance at the time was two million then the system should not
// accept it."
//
// Fixed by computing the account's balance strictly AS OF this
// transaction's own value_date — the sum of every already-POSTED
// transaction on this account dated on/before it — and validating
// against THAT instead. Same-day ties are broken by insertion order
// (id): a backdated entry sharing a date with existing rows is always
// treated as having happened after whatever was already on record for
// that day. For an ordinary present-dated transaction (the overwhelming
// common case) this number is always identical to
// accounts.current_balance, since no date picker in this app allows a
// future date, so every existing transaction's value_date is already
// <= today — the two only diverge when a transaction is genuinely
// being backdated ahead of something entered earlier but dated later.
//
// This is a "point-in-time" check, not a full-timeline one: it
// verifies THIS transaction's own moment, not every day between then
// and now. accounts.current_balance itself is unaffected — it's a
// simple order-independent arithmetic aggregate (sum of every posted
// amount, any date) and is still just incremented/decremented as
// before.
//
// Because this transaction's stored balance_before/balance_after now
// reflect the point-in-time chronological balance rather than
// "whatever the aggregate happened to be at insert time," inserting a
// backdated entry also shifts every OTHER already-posted transaction
// on this account that falls chronologically after it — see the
// cascade UPDATE below. This keeps the ledger's stored running-balance
// column internally consistent no matter what order transactions are
// actually entered in, so it can be trusted to display in transaction-
// date order (see getTransactions and friends) rather than entry order.
// ============================================================
const postTransaction = async (client, {
    accountId,
    transactionType,
    inflowType,
    amount,
    currencyId,
    categoryId,
    description,
    valueDate,
    createdBy,
    referenceId,
    transferId = null,
    contributionId = null,
    loanReceivedId = null,
    loanGivenId = null,
    investmentId = null,
    grantTrancheId = null,
    reversalOf = null,
    isReversal = false,
    // v1.70.0 — optional: the ledger account this entry posts to instead
    // of the one its inflow_type maps to (tax legs -> 5700 / 1500, bond
    // principal -> 1400), and the expense's own tax treatment
    // (DEDUCTIBLE / NOT_DEDUCTIBLE / CAPITAL; NULL = its category's).
    glOverrideAccountCode = null,
    taxTreatment = null,
}) => {
    // Lock the account row to prevent concurrent balance updates
    const accountResult = await client.query(`
        SELECT id, account_type, current_balance, currency_id
        FROM   accounts
        WHERE  id = $1
        FOR UPDATE
    `, [accountId]);

    if (accountResult.rows.length === 0) {
        throw createError.notFound('Account not found');
    }

    const account = accountResult.rows[0];
    const transactionAmount = parseFloat(amount);
    const isCredit = (transactionType === 'CREDIT' || transactionType === 'REVERSAL_CREDIT');

    // Point-in-time balance — everything already POSTED on this
    // account dated on/before this transaction's own value_date.
    const asOfResult = await client.query(`
        SELECT COALESCE(SUM(
            CASE WHEN transaction_type IN ('CREDIT', 'REVERSAL_CREDIT') THEN amount
                 ELSE -amount END
        ), 0) AS balance
        FROM   transactions
        WHERE  account_id = $1 AND status = 'POSTED' AND value_date <= $2
    `, [accountId, valueDate]);
    const balanceAsOfDate = parseFloat(asOfResult.rows[0].balance);
    const balanceAfterAsOfDate = isCredit
        ? balanceAsOfDate + transactionAmount
        : balanceAsOfDate - transactionAmount;

    // RULE 1: No account can have been below zero on this transaction's
    // own date — checked against that date's balance, not today's.
    if (balanceAfterAsOfDate < 0) {
        throw createError.badRequest(
            `Insufficient funds as of ${valueDate}. This account's balance on that date was ` +
            `${balanceAsOfDate.toFixed(2)} — a transaction of ${transactionAmount} would have ` +
            `taken it negative back then, even if the account holds more today.`
        );
    }

    // RULE 2: An account with a floor limit set cannot have been below
    // it on this transaction's own date, using whichever limit was
    // actually in effect then. Any account type can have a floor limit
    // (v1.14.0) except SAVINGS, which is permanently exempt —
    // getFloorLimit returns 0 for it (and for any account with no
    // floor limit configured), so this check is a safe no-op in both
    // of those cases.
    if (account.account_type !== 'SAVINGS') {
        const floorLimit = await getFloorLimit(client, accountId, account.account_type, valueDate);
        if (balanceAfterAsOfDate < floorLimit) {
            throw createError.badRequest(
                `This transaction would have brought this account below its floor limit of ` +
                `${floorLimit} as of ${valueDate}. Balance on that date: ${balanceAsOfDate.toFixed(2)}. ` +
                `Available to spend then: ${(balanceAsOfDate - floorLimit).toFixed(2)}.`
            );
        }
    }

    const approvalCtx = moneyApprovalContext.get(); // v1.73.0

    // Insert the transaction record — balance_before/balance_after
    // store the POINT-IN-TIME running balance (this row's real place
    // in the chronological ledger), not necessarily today's total.
    const txResult = await client.query(`
        INSERT INTO transactions (
            reference_id, account_id, transaction_type, inflow_type,
            amount, currency_id, balance_before, balance_after,
            category_id, description, value_date,
            transfer_id, contribution_id, loan_received_id,
            loan_given_id, investment_id, grant_tranche_id,
            reversal_of, is_reversal, status,
            created_by, approved_by, approved_at, posted_at
        ) VALUES (
            $1, $2, $3, $4,
            $5, $6, $7, $8,
            $9, $10, $11,
            $12, $13, $14,
            $15, $16, $17,
            $18, $19, 'POSTED',
            $20, $21, NOW(), NOW()
        )
        RETURNING id
    `, [
        referenceId, accountId, transactionType, inflowType,
        transactionAmount, currencyId, balanceAsOfDate, balanceAfterAsOfDate,
        categoryId, description, valueDate,
        transferId, contributionId, loanReceivedId,
        loanGivenId, investmentId, grantTrancheId,
        reversalOf, isReversal,
        createdBy,
        // v1.73.0 — when this posting is the approval of a held money
        // entry, the approver is recorded here (created_by stays the
        // person who recorded it). Otherwise approval = posting, as before.
        approvalCtx?.approvedBy || createdBy,
    ]);

    const transactionId = txResult.rows[0].id;
    if (approvalCtx) approvalCtx.postedIds.push(transactionId); // v1.73.0

    // v1.70.0 — set separately (and only when given) so a database that
    // has not run migration_v1.70.0.sql yet keeps posting normally.
    if (glOverrideAccountCode || taxTreatment) {
        await client.query(`
            UPDATE transactions
            SET    gl_override_account_code = COALESCE($1, gl_override_account_code),
                   tax_treatment            = COALESCE($2, tax_treatment)
            WHERE  id = $3
        `, [glOverrideAccountCode || null, taxTreatment || null, transactionId]);
    }

    // Cascade: shift every OTHER already-posted transaction on this
    // account that sits chronologically AFTER this one (by value_date,
    // then id as the same-day tie-break) by this transaction's own
    // signed amount, so their stored balance_before/balance_after stay
    // correct now that this entry has taken an earlier place in the
    // timeline. A single delta UPDATE, not a per-row recompute — every
    // later row's running balance moves by exactly the same amount, in
    // the same direction. A no-op for the ordinary present-dated case,
    // since nothing already on record can be dated after "today".
    const delta = isCredit ? transactionAmount : -transactionAmount;
    await client.query(`
        UPDATE transactions
        SET    balance_before = balance_before + $1,
               balance_after  = balance_after  + $1
        WHERE  account_id = $2
        AND    status = 'POSTED'
        AND    (value_date > $3 OR (value_date = $3 AND id > $4))
    `, [delta, accountId, valueDate, transactionId]);

    // Update the account's real, present-day balance — a simple
    // order-independent arithmetic aggregate (sum of every posted
    // amount, regardless of date), unaffected by how this transaction
    // is dated.
    const balanceBeforeTotal = parseFloat(account.current_balance);
    const balanceAfterTotal = isCredit
        ? balanceBeforeTotal + transactionAmount
        : balanceBeforeTotal - transactionAmount;
    await client.query(`
        UPDATE accounts
        SET    current_balance = $1
        WHERE  id = $2
    `, [balanceAfterTotal, accountId]);

    return { transactionId, balanceBefore: balanceAsOfDate, balanceAfter: balanceAfterAsOfDate };
};

// ============================================================
// COMPUTE SHARE UNITS PER USER (v1.33.0)
// Pure computation, no writes — shared by recalculateShareholding()
// below (which commits the result) and the recalculate-preview
// endpoint (shareholdingController.js), so a Treasurer can see exactly
// what a recompute WOULD change before it actually overwrites anyone's
// real shares_held. Guarantees preview and commit can never disagree,
// the same shared-computation pattern already used for Side Fund exit
// payouts (sideFundController.computeExitPayout).
//
// For each APPROVED contribution: convert its amount into whatever
// currency the share price was denominated in AS OF that contribution's
// own date (a no-op if it was already in that currency), then divide by
// the price per share effective on that same date. Units accumulate
// per user across every contribution they've ever had approved,
// regardless of what the price/exchange rate is TODAY — a contribution
// made in the past always buys the same number of units it bought back
// then; only its current VALUE (units x today's price) moves with the
// market, never the unit count itself. See sharePricingService.js for
// the date-aware price/rate lookups this relies on.
//
// Replaces the pre-v1.33.0 model, where shares_held was simply the raw
// SUM of contributed money with no unit conversion at all — see
// migration_v1.33.0.sql and CMS_BIBLE Section 14 for the full
// before/after explanation and the one-time historical recompute this
// enabled.
//
// Price/rate lookups are memoized per (date) / (from,to,date) within a
// single call — many contributions share the same currency and nearby
// dates, and this is called on every future contribution besides the
// one-time historical recompute.
// ============================================================
const computeShareUnitsPerUser = async (client) => {
    const contributions = await client.query(`
        SELECT id, user_id, amount, currency_id, contribution_date
        FROM   shareholder_contributions
        WHERE  status = 'APPROVED'
        ORDER  BY contribution_date ASC, id ASC
    `);

    const conversionCache = new Map();
    const unitsByUser = {};
    const breakdownByContribution = [];

    for (const c of contributions.rows) {
        const cacheKey = `${c.currency_id}|${c.contribution_date}`;
        let conversion = conversionCache.get(cacheKey);
        if (!conversion) {
            conversion = await convertToShareCurrency(client, 1, c.currency_id, c.contribution_date);
            conversionCache.set(cacheKey, conversion);
        }
        // conversion was computed for amount=1, so scale it up rather
        // than re-querying — same rate/price, just a different amount.
        const convertedAmount = parseFloat(c.amount) * conversion.rateUsed;
        const units = convertedAmount / conversion.sharePricePerUnit;

        unitsByUser[c.user_id] = (unitsByUser[c.user_id] || 0) + units;
        breakdownByContribution.push({
            contributionId:  c.id,
            userId:          c.user_id,
            amount:          parseFloat(c.amount),
            currencyId:      c.currency_id,
            contributionDate: c.contribution_date,
            rateUsed:        conversion.rateUsed,
            sharePricePerUnit: conversion.sharePricePerUnit,
            units,
        });
    }

    return { unitsByUser, breakdownByContribution };
};

// ============================================================
// RECALCULATE SHAREHOLDING (v1.30.1 — extracted from
// creditShareholderContribution so reverseTransaction can call it too;
// v1.33.0 — rewritten to use computeShareUnitsPerUser's real per-
// contribution unit calculation instead of a raw money SUM; see that
// function's comment above for the full explanation).
//
// Shares_held/percentage are always DERIVED, never directly edited —
// this is the one place that ever writes shareholding_registry.
// percentage = that member's units divided by everyone's combined
// units. Runs as a full recompute across every shareholder on every
// call — O(number of contributions), fine at this club's current scale
// (see CMS_BIBLE Section 14.6).
//
// v1.30.1 fix (still true under the new calculation): previously, a
// member whose LAST remaining APPROVED contribution stopped being
// APPROVED (e.g. reversed) would simply drop out of the loop entirely,
// leaving their shares_held/percentage stale at their old (now wrong)
// values. The second UPDATE below closes that gap.
// ============================================================
const legacyRecalculateShareholding = async (client, { recordedByUserId }) => {
    const { unitsByUser } = await computeShareUnitsPerUser(client);

    const grandTotal = Object.values(unitsByUser).reduce((sum, u) => sum + u, 0);

    for (const [userId, units] of Object.entries(unitsByUser)) {
        const percentage = grandTotal > 0
            ? ((units / grandTotal) * 100).toFixed(4)
            : '0.0000';

        await client.query(`
            UPDATE shareholding_registry
            SET
                shares_held    = $1,
                percentage     = $2,
                updated_by     = $3,
                notes          = 'Auto-calculated from contributions (unit-price method, v1.33.0)'
            WHERE user_id = $4
            AND   effective_to IS NULL
        `, [
            units.toFixed(4),
            percentage,
            recordedByUserId,
            userId,
        ]);
    }

    // Zero out anyone who currently has a shareholding_registry row but
    // no longer has ANY approved contribution (e.g. their only
    // contribution was just reversed) — otherwise they'd keep showing
    // their old, now-incorrect shares/percentage forever, since the
    // loop above only ever touches users who still appear in unitsByUser.
    await client.query(`
        UPDATE shareholding_registry
        SET    shares_held = 0,
               percentage  = 0,
               updated_by  = $1,
               notes       = 'Auto-calculated from contributions (unit-price method, v1.33.0)'
        WHERE  effective_to IS NULL
        AND    user_id NOT IN (
            SELECT DISTINCT user_id FROM shareholder_contributions WHERE status = 'APPROVED'
        )
        AND    (shares_held <> 0 OR percentage <> 0 OR percentage IS NULL)
    `, [recordedByUserId]);
};

// ============================================================
// RECALCULATE SHAREHOLDING (v1.69.0 entry point)
// Once the v1.69.0 opening conversion has run, shares_held is the sum
// of each member's ACTIVE whole-share allotments (share_allotments —
// see shareCapitalService.recalculateShareholding). Before that, the
// legacy fractional-unit recompute above still applies, so nothing
// changes for a database that has not been converted yet.
// ============================================================
const recalculateShareholding = async (client, { recordedByUserId }) => {
    if (await shareCapitalService.isOpeningConverted(client)) {
        return shareCapitalService.recalculateShareholding(client, { recordedByUserId });
    }
    return legacyRecalculateShareholding(client, { recordedByUserId });
};

// ============================================================
// SHARE PURCHASE RECEIPT — auto-generated document (v1.65.0)
// A "Financial" category (see isFinanceCategoryAbbrev,
// documentsController.js) reusing the abbreviation-prefix trick —
// FIN- is a single top-level segment here, not a real child of an
// existing "Financial" category tree, but full_abbreviation still
// starts with 'FIN-' so the existing Administrative-Officer finance
// restriction picks it up unchanged, without needing real category
// nesting for one narrow, always-auto-created category.
// ============================================================
const SHARE_RECEIPT_CATEGORY = {
    module:      'DOCUMENT',
    name:        'Share Purchase Receipts',
    abbreviation: 'FIN-SHR',
    description: 'Auto-generated receipts issued to shareholders when a capital contribution is recorded, showing shares held before/after.',
};

// ============================================================
// ISSUE A SHARE PURCHASE RECEIPT (v1.65.0)
// Called once, right after recalculateShareholding, from inside the
// same transaction that just recorded the contribution — so the
// before/after figures below are a true point-in-time snapshot, not
// subject to any other contribution landing in between. Requested
// directly: "at the time a contribution is made a reciept of
// purchased shares showing details of previously owned, bought and
// date should be issued along with the email that acknowledges one
// capital contribution with the treasures signature and date of
// signature."
//
// The Treasurer's (or Assistant Treasurer's) own currently-saved
// signature is snapshotted into a dedicated file the moment this
// runs — same "copy, don't just reference" pattern signSlot()
// (signatureService.js) uses for certificate/document signatures —
// so a later change to their stored signature image never alters a
// receipt already issued. This is deliberately NOT the multi-role
// document_signatures/signing-round mechanism the monthly share
// certificates use (Section 13.3): one receipt is issued per
// contribution, immediately, signed by whoever is actually recording
// it right then — a pending multi-signatory approval on something
// this frequent would be the wrong tool.
//
// Stored as an ordinary `documents` row (document_type 'RECEIPT',
// same enum value the generic receiptTemplate already uses) so it
// folds into the existing Documents module rather than needing its
// own table — distinguished from a plain receipt by
// `template_data.receipt_kind === 'SHARE_PURCHASE'` and by
// `related_record_type = 'shareholder_contributions'` /
// `related_record_id = contributionId`, which is also what powers
// both "My Documents" (member) and "Shareholding Receipts" (Treasury)
// — see documentsController.getMyDocuments / getAllDocuments.
// Best-effort: never throws — a receipt-generation hiccup must never
// fail or roll back an otherwise ordinary, already-recorded
// contribution (same discipline as the capital-goal auto-attribution
// block above).
// ============================================================
// ============================================================
// DESCRIBE A CONTRIBUTION IN THE SHARE PRICE'S CURRENCY (v1.67.0)
// Shared by issueSharePurchaseReceipt and
// backfill_v1.67.0_share_receipts.js. Uses the SAME rate and price the
// share-unit calculation used for this contribution (computeShareUnits
// PerUser's breakdown entry, when given), so the receipt's figures can
// never disagree with the shares it reports. Falls back to a fresh
// lookup as of the contribution date if no entry is passed.
// Returns { pricePerShare, shareCurrencyId, shareCurrencyCode,
// shareCurrencySymbol, rate, rateDate, amountInShareCurrency } — any of
// them null if no price/rate is configured (the receipt still issues).
// ============================================================
const describeShareValuation = async (client, { amount, currencyId, contributionDate, entry = null }) => {
    const out = {
        pricePerShare: null, shareCurrencyId: null, shareCurrencyCode: null, shareCurrencySymbol: null,
        rate: null, rateDate: null, amountInShareCurrency: null,
    };
    try {
        const conv = await convertToShareCurrency(client, 1, currencyId, contributionDate);
        out.shareCurrencyId = conv.shareCurrencyId;
        out.pricePerShare = entry ? entry.sharePricePerUnit : conv.sharePricePerUnit;
        out.rate = entry ? entry.rateUsed : conv.rateUsed;
    } catch (err) {
        return out;
    }
    if (out.shareCurrencyId) {
        const cur = await client.query(`SELECT code, symbol FROM currencies WHERE id = $1`, [out.shareCurrencyId]);
        out.shareCurrencyCode = cur.rows[0]?.code || null;
        out.shareCurrencySymbol = cur.rows[0]?.symbol || null;
    }
    out.rateDate = contributionDate instanceof Date
        ? `${contributionDate.getFullYear()}-${String(contributionDate.getMonth() + 1).padStart(2, '0')}-${String(contributionDate.getDate()).padStart(2, '0')}`
        : String(contributionDate).slice(0, 10);
    out.amountInShareCurrency = Math.round(parseFloat(amount) * out.rate * 100) / 100;
    return out;
};

const issueSharePurchaseReceipt = async (client, {
    contributor, contributionId, amount, currencyId,
    contributionDate, recordedByUserId, contributionReferenceCode,
    allotment, // v1.69.0 — shareCapitalService.allotForContribution's result
}) => {
    const currencyResult = await client.query(
        `SELECT code, symbol FROM currencies WHERE id = $1`,
        [currencyId]
    );
    const currencyCode = currencyResult.rows[0]?.code || null;
    const currencySymbol = currencyResult.rows[0]?.symbol || null;

    // v1.69.0 — whole shares from the allotment itself; whatever did not
    // buy a whole share is carried as the member's share credit.
    const sharesPurchased = allotment ? allotment.sharesAllotted : 0;

    // v1.67.0 — the receipt is expressed in the SHARE PRICE'S currency
    // (UGX), not the contribution's (EUR): the price per share is a UGX
    // figure, and the contribution is shown converted into UGX at the
    // exact rate the share calculation itself used (the rate effective
    // on the contribution date — Settings > Exchange Rates), with the
    // original EUR amount and that rate stated alongside it. v1.65.0
    // printed the UGX price with the contribution's € symbol.
    const shareValuation = await describeShareValuation(client, {
        amount, currencyId, contributionDate,
        entry: allotment ? { sharePricePerUnit: allotment.issuePrice, rateUsed: allotment.rateUsed } : null,
    });
    if (allotment) shareValuation.amountInShareCurrency = allotment.contributionValue;

    const holdingResult = await client.query(
        `SELECT shares_held, percentage FROM shareholding_registry WHERE user_id = $1 AND effective_to IS NULL`,
        [contributor.id]
    );
    const sharesAfter = parseFloat(holdingResult.rows[0]?.shares_held || 0);
    const percentageAfter = holdingResult.rows[0]?.percentage != null ? parseFloat(holdingResult.rows[0].percentage) : null;
    const sharesBefore = round4(sharesAfter - sharesPurchased);

    const pricePerShare = shareValuation.pricePerShare;

    const treasurerResult = await client.query(
        `SELECT first_name, last_name, signature_path FROM users WHERE id = $1`,
        [recordedByUserId]
    );
    const treasurer = treasurerResult.rows[0] || null;
    const treasurerName = treasurer ? `${treasurer.first_name} ${treasurer.last_name}` : null;

    let signatureSnapshotUrl = null;
    if (treasurer?.signature_path) {
        try {
            const sourceKey = toKey(treasurer.signature_path);
            const snapshotKey = generateKey('signature-snapshots', `share-receipt-${contributionId}.png`);
            await copyObject(sourceKey, snapshotKey);
            signatureSnapshotUrl = `/uploads/${snapshotKey}`;
        } catch (err) {
            signatureSnapshotUrl = treasurer.signature_path; // fallback — source file missing
        }
    }

    const signedAt = new Date();
    const categoryId = await getOrCreateCategory(client, { ...SHARE_RECEIPT_CATEGORY, createdBy: recordedByUserId });

    const { referenceId, referenceCode } = await generateReference(
        client, MODULE_CODES.DOCUMENT, 'SHCREC', 'DOCUMENT', recordedByUserId
    );

    const templateData = {
        reference:          referenceCode,
        receipt_kind:       'SHARE_PURCHASE',
        member_name:        `${contributor.first_name} ${contributor.last_name}`,
        member_email:       contributor.email,
        contribution_date:  contributionDate,
        contribution_reference: contributionReferenceCode,
        amount:             parseFloat(amount),
        currency_code:      currencyCode,
        currency_symbol:    currencySymbol,
        // v1.67.0 — the receipt's own currency (the share price's), the
        // contribution converted into it, and the rate that did it.
        member_user_id:          contributor.id,
        share_currency_code:     shareValuation.shareCurrencyCode,
        share_currency_symbol:   shareValuation.shareCurrencySymbol,
        amount_in_share_currency: shareValuation.amountInShareCurrency,
        exchange_rate:           shareValuation.rate,
        exchange_rate_date:      shareValuation.rateDate,
        shares_purchased:   round4(sharesPurchased),
        shares_before:      sharesBefore,
        shares_after:       round4(sharesAfter),
        percentage_after:   percentageAfter,
        price_per_share:    pricePerShare,
        // v1.69.0 — whole shares + share credit.
        whole_shares:       !!allotment,
        nominal_value:      allotment ? allotment.nominalValue : null,
        credit_before:      allotment ? allotment.creditBefore : null,
        credit_available:   allotment ? allotment.creditAvailable : null,
        credit_used:        allotment ? allotment.creditUsed : null,
        credit_after:       allotment ? allotment.creditAfter : null,
        allotment_reference: allotment && allotment.allotment ? allotment.allotment.referenceCode : null,
        share_capital_amount: allotment && allotment.allotment ? allotment.allotment.shareCapitalAmount : null,
        share_premium_amount: allotment && allotment.allotment ? allotment.allotment.sharePremiumAmount : null,
        recorded_by_name:   treasurerName,
        treasurer_name:     treasurerName,
        treasurer_signature_url: signatureSnapshotUrl,
        signed_at:          signedAt.toISOString(),
        generated_date:     signedAt.toISOString(),
    };

    const docResult = await client.query(`
        INSERT INTO documents (
            reference_id, category_id, title, document_type, source,
            template_data, version, related_record_type, related_record_id,
            status, created_by, approved_by, approved_at, fully_signed, fully_signed_at,
            owner_user_id
        ) VALUES (
            $1, $2, $3, 'RECEIPT', 'SYSTEM_GENERATED',
            $4, 1, 'shareholder_contributions', $5,
            'FINAL', $6, $6, $7, TRUE, $7,
            $8
        )
        RETURNING id
    `, [
        referenceId, categoryId,
        `Share Purchase Receipt — ${contributor.first_name} ${contributor.last_name}`,
        JSON.stringify(templateData), contributionId, recordedByUserId, signedAt,
        // v1.67.0 — a PERSONAL document: only this shareholder (My
        // Documents) and Treasury (Shareholding Receipts) ever see it;
        // it never appears in the shared All Documents list.
        contributor.id,
    ]);

    await linkReferenceToRecord(client, referenceId, docResult.rows[0].id);

    return { documentId: docResult.rows[0].id, referenceCode };
};

const round4 = (n) => Math.round((n + Number.EPSILON) * 10000) / 10000;

// ============================================================
// CREDIT SHAREHOLDER CONTRIBUTION (shared core logic)
// Money coming INTO the primary account from a shareholder.
// Used by two entry points:
//   1. recordContribution below — Treasurer/Assistant Treasurer
//      recording a contribution directly.
//   2. requisitionsController.approveRequisition — when a member's
//      CONTRIBUTION_ACKNOWLEDGEMENT requisition is approved, this
//      same logic runs so both paths stay perfectly consistent
//      (same shareholding recalculation, same audit trail shape).
// Must be called from inside an existing `withTransaction` block —
// it does not open its own transaction.
// ============================================================
const creditShareholderContribution = async (client, {
    contributorId,
    amount,
    contributionDate,
    categoryId,
    notes,
    recordedByUserId, // who is performing this action (Treasurer/Assistant Treasurer)
    accountId, // v1.33.0, optional — which account the money actually goes into.
    // Defaults to Primary (the original, only-ever behaviour before
    // v1.33.0) if omitted, so every existing caller keeps working
    // unchanged. When a different account is chosen, the money stays
    // there in its own currency — there is no automatic transfer into
    // Primary. Share units are computed separately (recalculateShareholding,
    // via sharePricingService) by converting into whatever currency the
    // share price itself is denominated in, as of this contribution's
    // own date — this is what makes contributing through a
    // different-currency account meaningful rather than a mismatch.
    // v1.51.0 — "any capital contribution recorded outside the pledges
    // also contributes to the capital goals (primary)": every ordinary
    // contribution recorded through here auto-attributes into the
    // contributor's PRIMARY-goal capital call for this month, UNLESS
    // it's already the settlement of one (capitalGoalCallService's own
    // approvePledgePayment passes this as true to avoid double-counting
    // the exact same money it's already attributing itself).
    skipCapitalGoalAutoAttribution = false,
}) => {
    // Get the contributor's details
    const contributorResult = await client.query(`
        SELECT id, first_name, last_name, email
        FROM   users
        WHERE  id = $1 AND is_active = TRUE
    `, [contributorId]);

    if (contributorResult.rows.length === 0) {
        throw createError.notFound('Contributing member not found');
    }
    const contributor = contributorResult.rows[0];

    // v1.69.0 — shares are allotted as whole shares from here on; the
    // one-off opening conversion must have run first.
    await shareCapitalService.assertOpeningConverted(client);

    // Verify contributor is a shareholder
    const shareholding = await client.query(`
        SELECT id FROM shareholding_registry
        WHERE  user_id = $1 AND effective_to IS NULL
    `, [contributorId]);

    if (shareholding.rows.length === 0) {
        // Auto-create shareholding record if not exists
        await client.query(`
            INSERT INTO shareholding_registry
                (user_id, shares_held, effective_from, updated_by, notes)
            VALUES ($1, 0, $2, $3, 'Auto-created on first contribution')
            ON CONFLICT DO NOTHING
        `, [contributorId, contributionDate, recordedByUserId]);
    }

    // Get the account this contribution is actually paid into — the
    // Primary account by default (unchanged from before v1.33.0), or
    // whichever active account was explicitly chosen. SAVINGS is
    // excluded here the same way it's excluded from transfers — a
    // capital contribution has no business landing in the dedicated
    // savings account.
    const accountResult = accountId
        ? await client.query(`
            SELECT id, currency_id, account_type, reference_prefix
            FROM   accounts
            WHERE  id = $1 AND is_active = TRUE AND account_type != 'SAVINGS'
        `, [accountId])
        : await client.query(`
            SELECT id, currency_id, account_type, reference_prefix
            FROM   accounts
            WHERE  account_type = 'PRIMARY'
            AND    is_active = TRUE
        `);
    if (accountResult.rows.length === 0) {
        throw createError.badRequest(
            accountId
                ? 'The selected account was not found, is inactive, or is a Savings account'
                : 'Primary account has not been set up yet'
        );
    }
    const account = accountResult.rows[0];

    // FX-coverage pre-check (v1.33.0) — fail fast with a clear error
    // BEFORE inserting anything, rather than letting a contribution
    // with no valid conversion path get recorded and only discovering
    // that deep inside the next recalculateShareholding() call. See
    // sharePricingService.getExchangeRateOn for why this throws rather
    // than guessing when a currency pair has never had a rate entered
    // in either direction.
    await convertToShareCurrency(client, amount, account.currency_id, contributionDate);

    // Generate reference: PA-CONTRIB-YYYYMM-00001 (or the primary
    // account's own reference_prefix, if one has been set)
    const { referenceId, referenceCode } = await generateReference(
        client,
        resolveModuleCode(account),
        'CONTRIB',
        'TRANSACTION',
        recordedByUserId
    );

    // Record the contribution details
    const contribResult = await client.query(`
        INSERT INTO shareholder_contributions
            (reference_id, user_id, account_id, amount, currency_id,
             contribution_date, category_id, notes, status, created_by)
        VALUES
            ($1, $2, $3, $4, $5, $6, $7, $8, 'APPROVED', $9)
        RETURNING id
    `, [
        referenceId,
        contributorId,
        account.id,
        amount,
        account.currency_id,
        contributionDate,
        categoryId,
        notes || null,
        recordedByUserId,
    ]);

    const contributionId = contribResult.rows[0].id;

    // Post the transaction — includes contributed_by for traceability
    const { transactionId, balanceBefore, balanceAfter } =
        await postTransaction(client, {
            accountId:       account.id,
            transactionType: 'CREDIT',
            inflowType:      'CONTRIBUTION',
            amount,
            currencyId:      account.currency_id,
            categoryId,
            description:     `Capital contribution — ${contributor.first_name} ${contributor.last_name}${notes ? ` (${notes})` : ''}`,
            valueDate:       contributionDate,
            createdBy:       recordedByUserId,
            referenceId,
            contributionId,
            contributedBy:   contributorId,
        });

    // Store contributed_by on the transaction record
    await client.query(`
        UPDATE transactions
        SET contributed_by = $1
        WHERE id = $2
    `, [contributorId, transactionId]);

    // Link reference to the transaction
    await linkReferenceToRecord(client, referenceId, transactionId);

    // v1.69.0 — allot WHOLE shares at the issue price in force on the
    // contribution date, using the member's share credit first; what is
    // left over stays as credit (shareCapitalService.allotForContribution
    // also re-derives every member's shares_held/percentage).
    const allotment = await shareCapitalService.allotForContribution(client, {
        userId: contributorId,
        contributionId,
        contributionDate,
        amount,
        currencyId: account.currency_id,
        transactionId,
        createdBy: recordedByUserId,
    });

    // --------------------------------------------------------
    // SHARE PURCHASE RECEIPT (v1.65.0) — best-effort, never blocks or
    // rolls back the contribution itself. See issueSharePurchaseReceipt
    // above for the full explanation. v1.69.0 — inside a SAVEPOINT, so a
    // failed receipt query cannot leave the whole transaction aborted.
    // --------------------------------------------------------
    let receipt = null;
    await client.query('SAVEPOINT share_purchase_receipt');
    try {
        receipt = await issueSharePurchaseReceipt(client, {
            contributor,
            contributionId,
            amount,
            currencyId: account.currency_id,
            contributionDate,
            recordedByUserId,
            contributionReferenceCode: referenceCode,
            allotment,
        });
        await client.query('RELEASE SAVEPOINT share_purchase_receipt');
    } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT share_purchase_receipt').catch(() => {});
        // eslint-disable-next-line no-console
        console.error('Share purchase receipt generation failed (contribution itself still recorded):', err);
    }

    // --------------------------------------------------------
    // AUTO-ATTRIBUTE TO THE PRIMARY CAPITAL GOAL (v1.51.0)
    // Lazy require — capitalGoalCallService.js itself top-level-
    // requires this file (for creditShareholderContribution), so a
    // top-level require here would create a circular require and risk
    // capitalGoalCallService resolving to an incomplete module
    // depending on load order. Requiring it lazily, inside the
    // function body, sidesteps that entirely since by the time this
    // line actually runs both modules have long since finished
    // loading. Wrapped in try/catch — a capital-goal bookkeeping
    // hiccup must never fail or roll back an otherwise ordinary,
    // already-recorded contribution.
    // --------------------------------------------------------
    if (!skipCapitalGoalAutoAttribution) {
        await client.query('SAVEPOINT capital_goal_attribution');
        try {
            const capitalGoalCallService = require('../services/capitalGoalCallService');
            await capitalGoalCallService.attributeDirectContributionToPrimaryGoal(client, {
                contributorId,
                amount,
                contributionDate,
                accountId: account.id,
                accountCurrencyId: account.currency_id,
                transactionId,
                contributionId,
                approvedByUserId: recordedByUserId,
            });
            await client.query('RELEASE SAVEPOINT capital_goal_attribution');
        } catch (err) {
            await client.query('ROLLBACK TO SAVEPOINT capital_goal_attribution').catch(() => {});
            // eslint-disable-next-line no-console
            console.error('Capital goal auto-attribution failed (contribution itself still recorded):', err);
        }
    }

    // --------------------------------------------------------
    // NOTIFY THE CONTRIBUTOR
    // Bell notification + auto-email confirming their contribution
    // was recorded — the flagship example the notifications system
    // was built for. Best-effort: never blocks or rolls back the
    // transaction above if the email/notification insert fails.
    // --------------------------------------------------------
    notify({
        userId:     contributorId,
        type:       'CONTRIBUTION_RECORDED',
        title:      'Contribution recorded',
        body:       `Your contribution of ${amount} on ${contributionDate} was recorded. Reference: ${referenceCode}.`,
        // v1.41.0 fix: there is no /transactions/:id detail route —
        // TransactionsPage.jsx is list-only — so this used to silently
        // bounce to the dashboard.
        link:       `/transactions`,
        module:     'FINANCE',
        recordType: 'transactions',
        recordId:   transactionId,
        email: {
            to:      contributor.email,
            subject: `Contribution recorded — ${referenceCode}`,
            html:    await wrapEmail(`
                <p>Dear ${contributor.first_name},</p>
                <p>Your contribution has been recorded on your account:</p>
                <table style="width:100%; border-collapse:collapse; margin:12px 0;">
                    <tr><td style="padding:4px 0; color:#6b7280;">Amount</td><td style="padding:4px 0; text-align:right; font-weight:700;">${amount}</td></tr>
                    <tr><td style="padding:4px 0; color:#6b7280;">Date</td><td style="padding:4px 0; text-align:right;">${contributionDate}</td></tr>
                    <tr><td style="padding:4px 0; color:#6b7280;">Reference</td><td style="padding:4px 0; text-align:right;">${referenceCode}</td></tr>
                </table>
                <p>You can view this in your account statement at any time.</p>
                <p><strong>Shares allotted:</strong> ${allotment.sharesAllotted} whole share(s) at ${allotment.issuePrice.toLocaleString('en-US')} per share.
                ${allotment.creditAfter !== 0 ? `Your share credit carried forward to your next contribution is ${allotment.creditAfter.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.` : ''}</p>
                ${receipt ? `
                <p>A Share Purchase Receipt for this contribution (${receipt.referenceCode}), signed by the Treasurer,
                is available any time under <strong>My Documents</strong>.</p>` : ''}
            `, { preheader: 'Your contribution has been recorded' }),
        },
    });

    return {
        transactionId, balanceBefore, balanceAfter,
        referenceCode, contributor, account,
        // v1.69.0 — whole shares allotted and the member's share credit.
        allotment,
        // v1.43.0 — added so callers that need to link back to the
        // exact shareholder_contributions row (e.g. a capital goal
        // call payment tranche) don't have to re-query for it.
        contributionId,
    };
};

// ============================================================
// CREDIT SIDE FUND CONTRIBUTION (shared core logic, v1.26.0)
// The side-fund slice of a Transactions contribution — a completely
// separate ledger transaction (posted to the side fund's OWN parent
// account, not the primary account) so the two envelopes never mix,
// then applied to that member's own dues oldest-unpaid-first via the
// same applySideFundPayment every other side fund payment path uses.
// Must be called from inside an existing `withTransaction` block.
// ============================================================
const creditSideFundContribution = async (client, {
    userId, amount, contributionDate, categoryId, recordedByUserId,
}) => {
    const configResult = await client.query('SELECT * FROM side_fund_config WHERE id = 1 FOR UPDATE');
    const config = configResult.rows[0];
    if (!config || !config.is_active) {
        throw createError.badRequest('The side fund is not currently active — remove the side fund portion or activate it first');
    }
    if (!config.parent_account_id) {
        throw createError.badRequest('The side fund has no parent account configured');
    }

    const memberResult = await client.query(
        'SELECT id, first_name, last_name, email FROM users WHERE id = $1 AND is_active = TRUE',
        [userId]
    );
    if (memberResult.rows.length === 0) {
        throw createError.notFound('Contributing member not found');
    }
    const member = memberResult.rows[0];

    const account = await client.query(
        'SELECT id, currency_id, account_type, reference_prefix FROM accounts WHERE id = $1',
        [config.parent_account_id]
    );
    const parentAccount = account.rows[0];

    const { referenceId, referenceCode } = await generateReference(
        client, resolveModuleCode(parentAccount), 'SF-IN', 'TRANSACTION', recordedByUserId
    );

    const { transactionId, balanceBefore, balanceAfter } = await postTransaction(client, {
        accountId:       config.parent_account_id,
        transactionType: 'CREDIT',
        inflowType:      'SIDE_FUND_CONTRIBUTION_IN',
        amount,
        currencyId:      parentAccount.currency_id,
        categoryId,
        description:     `Side fund portion of contribution — ${member.first_name} ${member.last_name}`,
        valueDate:       contributionDate,
        createdBy:       recordedByUserId,
        referenceId,
    });
    await linkReferenceToRecord(client, referenceId, transactionId);

    const { settled, creditBanked } = await applySideFundPayment(client, {
        userId,
        amount,
        transactionId,
        referenceCode,
        paidDate:   contributionDate,
        recordedBy: recordedByUserId,
    });

    await client.query(`
        UPDATE side_fund_config
        SET    current_balance = current_balance + $1, updated_at = NOW()
        WHERE  id = 1
    `, [amount]);

    await logAction(recordedByUserId, ACTIONS.SIDE_FUND_DUE_PAID, MODULES.FINANCE, {
        recordType:  'side_fund_dues',
        newValues:   { referenceCode, amount, settled, creditBanked, balanceBefore, balanceAfter },
        description: `Side fund portion of contribution: ${member.first_name} ${member.last_name} — ${amount} (${referenceCode})`,
        client,
    });

    notify({
        userId,
        type:       'SIDE_FUND_DUE_PAID',
        title:      'Side fund contribution recorded',
        body:       `Your side fund payment of ${amount} was recorded (reference ${referenceCode}).` +
            (settled.length > 1 ? ` It settled ${settled.length} months' dues.` : '') +
            (creditBanked > 0 ? ` ${creditBanked} was banked as credit toward future months.` : ''),
        link:       `/side-fund`,
        module:     'FINANCE',
        recordType: 'side_fund_dues',
        recordId:   settled.length > 0 ? settled[0].due_id : null,
    });

    return { transactionId, balanceBefore, balanceAfter, referenceCode, settled, creditBanked, member };
};

// ============================================================
// CREDIT SAVINGS CONTRIBUTION (shared core logic, v1.31.0)
// The savings slice of a Transactions contribution — mirrors
// creditSideFundContribution exactly, but for Savings: posted as its
// own ledger transaction into the dedicated SAVINGS account, then
// credited straight to that member's savings_balances.principal_balance.
// This deliberately bypasses the normal member_savings /
// PENDING_APPROVAL / approveSavingsDeposit two-step flow — the
// Treasurer already has authority by virtue of personally recording
// the contribution, exactly the same reasoning already established
// for the side fund slice (and the same pattern dividendsController's
// approveDividend already uses to credit savings directly). Must be
// called from inside an existing `withTransaction` block.
// ============================================================
const creditSavingsContribution = async (client, {
    userId, amount, contributionDate, categoryId, recordedByUserId, currencyId,
}) => {
    const memberResult = await client.query(
        'SELECT id, first_name, last_name, email FROM users WHERE id = $1 AND is_active = TRUE',
        [userId]
    );
    if (memberResult.rows.length === 0) {
        throw createError.notFound('Contributing member not found');
    }
    const member = memberResult.rows[0];

    // v1.61.0 — which currency's Savings account this slice goes into;
    // a company can now have more than one.
    const savingsAccount = await getSavingsAccount(client, currencyId);

    const { referenceId, referenceCode } = await generateReference(
        client, resolveModuleCode(savingsAccount), 'SAV-IN', 'TRANSACTION', recordedByUserId
    );

    const { transactionId, balanceBefore, balanceAfter } = await postTransaction(client, {
        accountId:       savingsAccount.id,
        transactionType: 'CREDIT',
        inflowType:      'SAVINGS_DEPOSIT_IN',
        amount,
        currencyId:      savingsAccount.currency_id,
        categoryId,
        description:     `Savings portion of contribution — ${member.first_name} ${member.last_name}`,
        valueDate:       contributionDate,
        createdBy:       recordedByUserId,
        referenceId,
    });
    await linkReferenceToRecord(client, referenceId, transactionId);

    await getOrCreateSavingsBalance(client, userId, savingsAccount.currency_id);
    await client.query(`
        UPDATE savings_balances
        SET    principal_balance = principal_balance + $1,
               updated_at = NOW()
        WHERE  user_id = $2 AND currency_id = $3
    `, [amount, userId, savingsAccount.currency_id]);

    // v1.41.0 — also write a member_savings row (already ACTIVE, no
    // approval step needed since the Treasurer already has authority by
    // virtue of personally recording the contribution — same reasoning
    // as the direct-credit design itself). Previously this path updated
    // ONLY the aggregate savings_balances with no per-entry record at
    // all, which meant a reversal had no way to know which member's
    // balance to undo, or by how much. Mirrors approveSavingsDeposit's
    // own member_savings shape exactly, just pre-approved.
    const { referenceId: savingsRefId } = await generateReference(
        client, (MODULE_CODES.SAVINGS || 'SAV'), 'SAV', 'SAVINGS', recordedByUserId
    );
    const savingsEntryResult = await client.query(`
        INSERT INTO member_savings (
            reference_id, user_id, account_id, currency_id, category_id,
            principal_amount, deposit_date, entry_type, source,
            recorded_by, status, transaction_id, secretary_approved_by,
            secretary_approved_at, created_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'FLEXIBLE', 'TREASURY_DIRECT',
            $8, 'ACTIVE', $9, $8, NOW(), $8)
        RETURNING id
    `, [
        savingsRefId, userId, savingsAccount.id, savingsAccount.currency_id,
        categoryId, amount, contributionDate, recordedByUserId, transactionId,
    ]);
    await linkReferenceToRecord(client, savingsRefId, savingsEntryResult.rows[0].id);

    await logAction(recordedByUserId, ACTIONS.SAVINGS_CONTRIBUTION_CREDITED, MODULES.FINANCE, {
        recordType:  'savings_balances',
        newValues:   { referenceCode, amount, balanceBefore, balanceAfter },
        description: `Savings portion of contribution: ${member.first_name} ${member.last_name} — ${amount} (${referenceCode})`,
        client,
    });

    notify({
        userId,
        type:       'SAVINGS_CONTRIBUTION_CREDITED',
        title:      'Savings contribution recorded',
        body:       `${amount} of your contribution was credited directly to your savings balance (reference ${referenceCode}).`,
        link:       `/savings`,
        module:     'FINANCE',
        recordType: 'savings_balances',
        recordId:   null,
    });

    return { transactionId, balanceBefore, balanceAfter, referenceCode, member };
};

// ============================================================
// CREDIT DEPOSIT CONTRIBUTION (shared core logic, v1.38.0; tied to an
// activatable parent account v1.38.1)
// The deposit slice of a Transactions contribution, OR a standalone
// deposit entry (depositsController.createStandaloneDeposit) — two
// entry points sharing one core, the same "one core, two entry
// points" shape as creditShareholderContribution/creditSideFundContribution
// above. Like the Side Fund, deposits are an optional feature (off by
// default) "parented" to one specific account, chosen when activating
// it in Settings — NOT chosen per entry. UNLIKE the Side Fund, that
// parent account is not a separate envelope (no current_balance
// counter) — every deposit is a completely normal transaction into
// that one account, fully spendable/commingled from that moment on.
// This function only tracks a running per-member total
// (deposit_balances), normalized into deposit_config's own currency
// (derived from the parent account) at credit time so it's comparable
// against the single company-wide target regardless of which currency
// it was actually posted in. Deliberately does NOT touch
// shareholding_registry — deposits never count toward shareholding.
// Must be called from inside an existing `withTransaction` block.
// ============================================================
const creditDepositContribution = async (client, {
    userId, amount, entryDate, categoryId, source, recordedByUserId,
}) => {
    const memberResult = await client.query(
        'SELECT id, first_name, last_name, email FROM users WHERE id = $1 AND is_active = TRUE',
        [userId]
    );
    if (memberResult.rows.length === 0) {
        throw createError.notFound('Depositing member not found');
    }
    const member = memberResult.rows[0];

    const configResult = await client.query('SELECT * FROM deposit_config WHERE id = 1');
    const config = configResult.rows[0];
    if (!config || !config.is_active || !config.parent_account_id) {
        throw createError.badRequest(
            'Deposits are not active for this company yet — an Admin/Treasurer must activate it and choose a parent account in Settings > Deposits first.'
        );
    }

    const accountResult = await client.query(
        'SELECT id, currency_id, account_type, reference_prefix FROM accounts WHERE id = $1 AND is_active = TRUE',
        [config.parent_account_id]
    );
    if (accountResult.rows.length === 0) {
        throw createError.badRequest('The configured deposit parent account was not found or is inactive');
    }
    const account = accountResult.rows[0];

    // Never guess at money — same "hard stop, not a silent guess" rule
    // as sharePricingService's own FX-coverage guard. In practice this
    // is always a same-currency conversion (rate 1) since currency_id
    // is derived from the parent account when it's set — this only
    // does real work if the parent account is ever changed later.
    const rateUsed = await getExchangeRateOn(client, account.currency_id, config.currency_id, entryDate);
    const normalizedAmount = parseFloat((parseFloat(amount) * rateUsed).toFixed(4));

    const { referenceId, referenceCode } = await generateReference(
        client, resolveModuleCode(account), 'DEP-IN', 'TRANSACTION', recordedByUserId
    );

    const { transactionId, balanceBefore, balanceAfter } = await postTransaction(client, {
        accountId:       account.id,
        transactionType: 'CREDIT',
        inflowType:      'DEPOSIT_CONTRIBUTION_IN',
        amount,
        currencyId:      account.currency_id,
        categoryId,
        description:     `Deposit — ${member.first_name} ${member.last_name}`,
        valueDate:       entryDate,
        createdBy:       recordedByUserId,
        referenceId,
    });
    await linkReferenceToRecord(client, referenceId, transactionId);

    await client.query(
        'INSERT INTO deposit_balances (user_id, balance) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING',
        [userId]
    );
    await client.query(`
        UPDATE deposit_balances
        SET    balance = balance + $1, updated_at = NOW()
        WHERE  user_id = $2
    `, [normalizedAmount, userId]);

    await client.query(`
        INSERT INTO deposit_entries (
            user_id, source, account_id, transaction_id, amount, currency_id,
            normalized_amount, exchange_rate_used, entry_date, recorded_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `, [
        userId, source, account.id, transactionId, amount, account.currency_id,
        normalizedAmount, rateUsed, entryDate, recordedByUserId,
    ]);

    await logAction(recordedByUserId, ACTIONS.DEPOSIT_CREDITED, MODULES.FINANCE, {
        recordType:  'deposit_balances',
        recordId:    userId,
        newValues:   { referenceCode, amount, normalizedAmount, balanceBefore, balanceAfter },
        description: `Deposit credited: ${member.first_name} ${member.last_name} — ${amount} (${referenceCode})`,
        client,
    });

    notify({
        userId,
        type:       'DEPOSIT_CREDITED',
        title:      'Deposit recorded',
        body:       `${amount} was credited to your deposit (reference ${referenceCode}).`,
        link:       `/deposits`,
        module:     'FINANCE',
        recordType: 'deposit_balances',
        recordId:   null,
    });

    return { transactionId, balanceBefore, balanceAfter, referenceCode, member, account, normalizedAmount };
};

// ============================================================
// RECORD SHAREHOLDER CONTRIBUTION
// POST /api/transactions/contributions
// Treasurer/Assistant Treasurer only. contributed_by: the member
// making the contribution — defaults to the logged-in user if not
// provided, or can be set to record on behalf of any member.
// Shareholding % is auto-recalculated after every contribution.
//
// v1.26.0 — an optional side_fund_amount can be sliced out of the
// total: that portion is auto-credited to the side fund (tied to
// this same member's own dues), and only the REMAINDER is recorded
// as the capital contribution. This is now the only way a Side Fund
// payment can ride along with a Transactions entry — the old
// standalone "Add Funds Directly" side fund feature is gone.
//
// v1.31.0 — a second, independent optional savings_amount can ALSO
// be sliced out of the same total, following the identical pattern:
// that portion is credited straight to the member's own Savings
// balance (see creditSavingsContribution above), and whatever is left
// after BOTH slices are removed is what actually gets recorded as the
// capital contribution. The two slices are independent of each other
// (a contribution can include a side fund portion, a savings portion,
// both, or neither) and together must not exceed the total amount.
//
// v1.38.0 — a third, independent optional deposit_amount can ALSO be
// sliced out of the same total, following the identical side-fund/
// savings pattern: that portion is credited straight into the
// deposit feature's own account, and whatever is left after all
// slices are removed is what actually gets recorded as the capital
// contribution.
//
// v1.38.1 — like the side fund, deposits are an optional feature
// (off by default) "parented" to one specific account chosen when
// activating it in Settings, NOT chosen per entry. creditDepositContribution
// resolves that account itself from deposit_config, so this handler
// no longer needs to pre-resolve or pass an account into it — it just
// hands off the amount, exactly like the side-fund slice already does.
// ============================================================
const recordContribution = asyncHandler(async (req, res) => {
    const {
        amount,
        contribution_date,
        category_id,
        notes,
        contributed_by, // user_id of the contributing member
        side_fund_amount,
        savings_amount,
        savings_currency_id, // v1.61.0, optional — which of the member's
                    // Savings currencies the savings_amount slice is
                    // credited into; defaults to the Primary account's
                    // own currency (same default creditShareholderContribution
                    // itself uses) if omitted.
        deposit_amount,
        account_id, // v1.33.0, optional — which account the contribution
                    // portion is actually paid into; defaults to Primary
                    // inside creditShareholderContribution if omitted.
    } = req.body;

    await withTransaction(async (client) => {
        const contributorId = contributed_by
            ? parseInt(contributed_by)
            : req.user.id;

        const totalAmount = parseFloat(amount);
        const sideFundAmount = side_fund_amount ? parseFloat(side_fund_amount) : 0;
        const savingsAmount = savings_amount ? parseFloat(savings_amount) : 0;
        const depositAmount = deposit_amount ? parseFloat(deposit_amount) : 0;

        if (sideFundAmount < 0) {
            throw createError.badRequest('The side fund portion cannot be negative');
        }
        if (savingsAmount < 0) {
            throw createError.badRequest('The savings portion cannot be negative');
        }
        if (depositAmount < 0) {
            throw createError.badRequest('The deposit portion cannot be negative');
        }
        if (sideFundAmount + savingsAmount + depositAmount > totalAmount) {
            throw createError.badRequest('The side fund, savings, and deposit portions together cannot exceed the total amount');
        }
        const contributionAmount = parseFloat((totalAmount - sideFundAmount - savingsAmount - depositAmount).toFixed(4));

        // v1.69.1 — the whole amount is in the currency of the account it
        // was paid into (the chosen account, or Primary). Capital can be
        // paid into any account in any currency (shares are valued by
        // converting to the share price's currency at the rate on the
        // contribution date — see shareCapitalService); the savings slice
        // goes to the Savings account in THAT currency; the side fund and
        // deposit slices are refused if their account is in a different
        // currency, instead of being posted as if the amount were in
        // theirs.
        const paidAccountResult = account_id
            ? await client.query(`
                SELECT a.id, a.currency_id, c.code AS currency_code
                FROM accounts a JOIN currencies c ON c.id = a.currency_id
                WHERE a.id = $1 AND a.is_active = TRUE AND a.account_type <> 'SAVINGS'`, [parseInt(account_id)])
            : await client.query(`
                SELECT a.id, a.currency_id, c.code AS currency_code
                FROM accounts a JOIN currencies c ON c.id = a.currency_id
                WHERE a.account_type = 'PRIMARY' AND a.is_active = TRUE`);
        if (paidAccountResult.rows.length === 0) {
            throw createError.badRequest(account_id
                ? 'The selected account was not found, is inactive, or is a Savings account'
                : 'Primary account has not been set up yet');
        }
        const paidAccount = paidAccountResult.rows[0];
        const assertSliceCurrency = async (label, table) => {
            const r = await client.query(`
                SELECT c.code, cfg.parent_account_id FROM ${table} cfg
                JOIN accounts a ON a.id = cfg.parent_account_id
                JOIN currencies c ON c.id = a.currency_id
                WHERE cfg.id = 1`);
            const code = r.rows[0]?.code;
            if (code && code !== paidAccount.currency_code) {
                throw createError.badRequest(
                    `The ${label} is kept in ${code}, but this payment is in ${paidAccount.currency_code}. ` +
                    `Record the ${label} part separately as a ${code} amount, or pay this one into a ${code} account.`
                );
            }
        };
        if (sideFundAmount > 0) await assertSliceCurrency('side fund', 'side_fund_config');
        if (depositAmount > 0) await assertSliceCurrency('deposit', 'deposit_config');

        let sideFund = null;
        if (sideFundAmount > 0) {
            sideFund = await creditSideFundContribution(client, {
                userId:            contributorId,
                amount:            sideFundAmount,
                contributionDate:  contribution_date,
                categoryId:        category_id,
                recordedByUserId:  req.user.id,
            });
        }

        let savings = null;
        if (savingsAmount > 0) {
            // v1.61.0 — a company can now have more than one Savings
            // account (one per currency); default to Primary's own
            // currency, same default creditShareholderContribution
            // itself uses below, if the caller didn't specify one.
            // v1.69.1 — defaults to the currency the payment was made in
            // (was always Primary's), so a UGX payment's savings slice lands
            // in the UGX Savings account.
            let savingsCurrencyId = savings_currency_id ? parseInt(savings_currency_id) : null;
            if (!savingsCurrencyId) savingsCurrencyId = paidAccount.currency_id;
            if (savingsCurrencyId !== paidAccount.currency_id) {
                throw createError.badRequest(
                    `The savings part must be in the same currency as the payment (${paidAccount.currency_code}). ` +
                    'To move savings between currencies, use Convert Currency on the Savings page.'
                );
            }
            savings = await creditSavingsContribution(client, {
                userId:            contributorId,
                amount:            savingsAmount,
                contributionDate:  contribution_date,
                categoryId:        category_id,
                currencyId:        savingsCurrencyId,
                recordedByUserId:  req.user.id,
            });
        }

        let deposit = null;
        if (depositAmount > 0) {
            deposit = await creditDepositContribution(client, {
                userId:            contributorId,
                amount:            depositAmount,
                entryDate:         contribution_date,
                categoryId:        category_id,
                source:            'CONTRIBUTION_SLICE',
                recordedByUserId:  req.user.id,
            });
        }

        let contribution = null;
        if (contributionAmount > 0) {
            contribution = await creditShareholderContribution(client, {
                contributorId,
                amount: contributionAmount,
                contributionDate: contribution_date,
                categoryId:       category_id,
                notes,
                recordedByUserId: req.user.id,
                accountId:        account_id ? parseInt(account_id) : undefined,
            });
        }

        if (!contribution && !sideFund && !savings && !deposit) {
            throw createError.badRequest('Amount must be greater than zero');
        }

        const contributorName = contribution
            ? `${contribution.contributor.first_name} ${contribution.contributor.last_name}`
            : sideFund
                ? `${sideFund.member.first_name} ${sideFund.member.last_name}`
                : savings
                    ? `${savings.member.first_name} ${savings.member.last_name}`
                    : `${deposit.member.first_name} ${deposit.member.last_name}`;

        if (contribution) {
            await logAction(req.user.id, ACTIONS.CONTRIBUTION_CREATED, MODULES.FINANCE, {
                ipAddress:   req.ip,
                recordType:  'transactions',
                recordId:    contribution.transactionId,
                newValues:   {
                    amount: contributionAmount, referenceCode: contribution.referenceCode,
                    balanceBefore: contribution.balanceBefore, balanceAfter: contribution.balanceAfter,
                    contributorId, contributorName,
                },
                description: `Contribution: ${contribution.referenceCode} — ${contributorName}: ${contributionAmount}`,
                client,
            });
        }

        sendCreated(res, {
            reference:            contribution ? contribution.referenceCode : null,
            transaction_id:       contribution ? contribution.transactionId : null,
            contributor_name:     contributorName,
            amount:               contributionAmount,
            balance_before:       contribution ? contribution.balanceBefore : null,
            balance_after:        contribution ? contribution.balanceAfter : null,
            side_fund_amount:     sideFundAmount,
            side_fund_reference:  sideFund ? sideFund.referenceCode : null,
            side_fund_settled:    sideFund ? sideFund.settled : [],
            side_fund_credit_banked: sideFund ? sideFund.creditBanked : 0,
            savings_amount:       savingsAmount,
            savings_reference:    savings ? savings.referenceCode : null,
            deposit_amount:       depositAmount,
            deposit_reference:    deposit ? deposit.referenceCode : null,
        }, `Contribution recorded for ${contributorName}` +
            (contribution ? `. Reference: ${contribution.referenceCode}` : '') +
            (sideFund ? ` — ${sideFundAmount} side fund portion recorded (${sideFund.referenceCode})` : '') +
            (savings ? ` — ${savingsAmount} savings portion recorded (${savings.referenceCode})` : '') +
            (deposit ? ` — ${depositAmount} deposit portion recorded (${deposit.referenceCode})` : ''));
    });
});

// ============================================================
// RECORD GENERAL INFLOW
// POST /api/transactions/inflows
// Money coming INTO any account that isn't one of the dedicated
// inflow types (contribution, grant, loan, savings deposit, etc) —
// e.g. miscellaneous income recorded directly from an account's own
// detail page. Posted with inflow_type 'OTHER_INCOME'.
// ============================================================
const recordInflow = asyncHandler(async (req, res) => {
    const {
        account_id,
        amount,
        category_id,
        description,
        value_date,
        // v1.70.0 — optional: the income was received NET of tax the payer
        // kept back (e.g. a bank paying interest). `amount` is then the
        // GROSS income; the tax is posted as its own leg (5700 FINAL or
        // 1500 CREDITABLE) and recorded in the register of tax deducted
        // from the company.
        income_type,
        tax_deducted,
        tax_treatment,
        tax_source_type,
        payer_name,
        payer_tin,
        tax_certificate_number,
    } = req.body;
    const taxDeducted = tax_deducted ? parseFloat(tax_deducted) : 0;
    if (taxDeducted > 0 && !(taxDeducted < parseFloat(amount))) {
        throw createError.badRequest('The tax deducted must be less than the gross amount.');
    }
    const inflowType = income_type === 'INTEREST_IN' ? 'INTEREST_IN' : 'OTHER_INCOME';

    await withTransaction(async (client) => {
        const accountResult = await client.query(`
            SELECT id, currency_id, account_type, reference_prefix
            FROM   accounts
            WHERE  id = $1 AND is_active = TRUE
        `, [account_id]);

        if (accountResult.rows.length === 0) {
            throw createError.notFound('Account not found');
        }
        const account = accountResult.rows[0];

        const moduleCode = resolveModuleCode(account);

        const { referenceId, referenceCode } = await generateReference(
            client,
            moduleCode,
            'INFLOW',
            'TRANSACTION',
            req.user.id
        );

        const { transactionId, balanceBefore, balanceAfter: grossBalanceAfter } = await postTransaction(client, {
            accountId:       account_id,
            transactionType: 'CREDIT',
            inflowType,
            amount,
            currencyId:      account.currency_id,
            categoryId:      category_id,
            description,
            valueDate:       value_date,
            createdBy:       req.user.id,
            referenceId,
        });
        let balanceAfter = grossBalanceAfter;

        await linkReferenceToRecord(client, referenceId, transactionId);

        let taxRecord = null;
        if (taxDeducted > 0) {
            const treatment = tax_treatment === 'FINAL' ? 'FINAL' : 'CREDITABLE';
            const leg = await taxService.postTaxLeg(client, {
                accountId: account_id, currencyId: account.currency_id, amount: taxDeducted, date: value_date,
                treatment, categoryId: category_id,
                description: `Tax deducted at source by ${payer_name || 'the payer'} (${treatment.toLowerCase()}) — ${description}`,
                userId: req.user.id,
            });
            balanceAfter = leg.balanceAfter;
            taxRecord = await taxService.recordTaxAtSource(client, {
                sourceType: tax_source_type || (inflowType === 'INTEREST_IN' ? 'BANK_INTEREST' : 'OTHER_INCOME'),
                payerName: payer_name || null, payerTin: payer_tin || null,
                incomeTransactionId: transactionId, taxTransactionId: leg.transactionId, cashLeg: true,
                rateCode: null, rate: round2Pct(taxDeducted, amount), treatment,
                gross: amount, tax: taxDeducted, currencyId: account.currency_id, date: value_date,
                certificateNumber: tax_certificate_number || null, userId: req.user.id,
            });
        }

        await logAction(req.user.id, ACTIONS.TRANSACTION_CREATED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'transactions',
            recordId:    transactionId,
            newValues:   { amount, referenceCode, balanceBefore, balanceAfter },
            description: `Inflow recorded: ${referenceCode} — ${description}`,
            client,
        });

        sendCreated(res, {
            reference:      referenceCode,
            transaction_id: transactionId,
            amount,
            tax_deducted:   taxDeducted || 0,
            tax_record:     taxRecord ? taxRecord.referenceCode : null,
            balance_before: balanceBefore,
            balance_after:  balanceAfter,
        }, `Inflow recorded successfully. Reference: ${referenceCode}` +
           (taxRecord ? ` (tax deducted at source recorded: ${taxRecord.referenceCode})` : ''));
    });
});

// ============================================================
// RECORD DIRECT EXPENSE
// POST /api/transactions/expenses
// Money going OUT of any account for operational expenses.
// Primary account enforces floor limit.
// ============================================================
const recordExpense = asyncHandler(async (req, res) => {
    const {
        account_id,
        amount,
        category_id,
        description,
        value_date,
        // v1.70.0 — optional per-expense tax treatment (DEDUCTIBLE /
        // NOT_DEDUCTIBLE / CAPITAL; empty = the category's setting), and
        // for a payment to a supplier: who was paid and whether the 6%
        // agent withholding applies. While the company is not a
        // designated withholding agent that 6% is recorded as SHADOW only
        // — the full amount is paid, nothing is held back.
        tax_treatment,
        payee_name,
        payee_tin,
        payee_residency,
        apply_wht,
    } = req.body;
    if (tax_treatment && !taxService.EXPENSE_TREATMENTS.includes(tax_treatment)) {
        throw createError.badRequest('tax_treatment must be DEDUCTIBLE, NOT_DEDUCTIBLE or CAPITAL');
    }
    const wantsWht = apply_wht === true || apply_wht === 'true';
    if (wantsWht && !(payee_name && String(payee_name).trim())) {
        throw createError.badRequest('Enter who was paid (the supplier) to apply withholding tax.');
    }

    await withTransaction(async (client) => {
        // Get the account
        const accountResult = await client.query(`
            SELECT id, currency_id, account_type, reference_prefix
            FROM   accounts
            WHERE  id = $1 AND is_active = TRUE
        `, [account_id]);

        if (accountResult.rows.length === 0) {
            throw createError.notFound('Account not found');
        }
        const account = accountResult.rows[0];

        // Determine module code for reference — the account's own
        // reference_prefix if it has one, else the generic PA/SA code
        const moduleCode = resolveModuleCode(account);

        // Generate reference: PA-EXPENSE-YYYYMM-00001 (or tailored prefix)
        const { referenceId, referenceCode } = await generateReference(
            client,
            moduleCode,
            'EXPENSE',
            'TRANSACTION',
            req.user.id
        );

        // v1.70.0 — withholding on a supplier payment. Worked out BEFORE
        // posting: when it is real (the company is a designated agent, or
        // the supplier is not resident), only the NET amount leaves the
        // account now; the tax stays until it is paid to URA.
        let wht = null;
        if (wantsWht) {
            wht = await taxService.computeWithholding(client, {
                paymentType: payee_residency === 'NON_RESIDENT' ? 'NON_RESIDENT_SERVICE' : 'SUPPLIER',
                residency: payee_residency === 'NON_RESIDENT' ? 'NON_RESIDENT' : 'RESIDENT',
                gross: amount, currencyId: account.currency_id, date: value_date,
            });
            if (!wht.applies) wht = null;
        }
        const cashAmount = wht && !wht.isShadow ? wht.net : parseFloat(amount);

        // Post the transaction
        const { transactionId, balanceBefore, balanceAfter } = await postTransaction(client, {
            accountId:       account_id,
            transactionType: 'DEBIT',
            inflowType:      'EXPENSE',
            amount:          cashAmount,
            currencyId:      account.currency_id,
            categoryId:      category_id,
            description:     wht && !wht.isShadow
                ? `${description} — ${payee_name}: gross ${amount}, WHT ${wht.rate}% ${wht.tax} withheld, net paid ${wht.net}`
                : (payee_name ? `${description} — ${payee_name}` : description),
            valueDate:       value_date,
            createdBy:       req.user.id,
            referenceId,
            taxTreatment:    tax_treatment || null,
        });

        await linkReferenceToRecord(client, referenceId, transactionId);

        let whtRecord = null;
        if (wht) {
            whtRecord = await taxService.recordWithholding(client, {
                paymentType: payee_residency === 'NON_RESIDENT' ? 'NON_RESIDENT_SERVICE' : 'SUPPLIER',
                payeeName: String(payee_name).trim(), payeeTin: payee_tin || null,
                payeeResidency: payee_residency === 'NON_RESIDENT' ? 'NON_RESIDENT' : 'RESIDENT',
                rateCode: wht.rateCode, rate: wht.rate, gross: amount, tax: wht.tax,
                currencyId: account.currency_id, date: value_date, debitGlCode: '5000',
                sourceTransactionId: transactionId, isShadow: wht.isShadow, shadowReason: wht.shadowReason,
                userId: req.user.id,
            });
        }

        await logAction(req.user.id, ACTIONS.TRANSACTION_CREATED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'transactions',
            recordId:    transactionId,
            newValues:   { amount, referenceCode, balanceBefore, balanceAfter },
            description: `Expense recorded: ${referenceCode} — ${description}`,
            client,
        });

        sendCreated(res, {
            reference:      referenceCode,
            transaction_id: transactionId,
            amount,
            amount_paid:    cashAmount,
            withholding:    whtRecord ? { reference: whtRecord.referenceCode, tax: wht.tax, rate: wht.rate, shadow: wht.isShadow } : null,
            balance_before: balanceBefore,
            balance_after:  balanceAfter,
        }, `Expense recorded successfully. Reference: ${referenceCode}` +
           (whtRecord ? (wht.isShadow
               ? ` — 6% withholding of ${wht.tax} recorded as SHADOW (the company is not a designated withholding agent on that date — full amount paid)`
               : ` — ${wht.tax} withheld (${whtRecord.referenceCode}); pay it to URA by the 15th of next month`) : ''));
    });
});

// ============================================================
// REVERSALS (reworked in v1.72.0)
//
// A reversal is now a REQUEST that a second person approves:
//   POST /api/transactions/:id/reverse                       (Treasurer) — ask
//   GET  /api/transactions/reversal-requests                 — list
//   POST /api/transactions/reversal-requests/:id/approve     — approve & post
//   POST /api/transactions/reversal-requests/:id/reject      — refuse
// The person who asked cannot approve their own request (an Admin can).
//
// When a request is made, the whole reversal is rehearsed inside a
// savepoint and rolled back, so any reason it would fail (already
// reversed, a closed fund, money already withdrawn, tax already paid to
// URA …) is shown to the person asking straight away — not days later
// to the approver.
//
// executeReversal() does the actual work, in one database transaction:
//   1. refuses entries of modules whose own records are not unwound
//      yet (reversalLinksService.findUnsupportedLink);
//   2. finds every ledger entry that belongs to the same event (an MMF
//      top-up, an investment funding, a coupon = interest + tax (+ face
//      value), a treasury-bill maturity = proceeds + tax, a return + its
//      tax) and reverses them all;
//   3. brings the MMF / investment records into line
//      (reversalLinksService.applySubledger).
// Each individual ledger entry is reversed by performSingleReversal —
// the pre-v1.72 logic, unchanged (contributions, deposits, side fund,
// savings and tax records are still unwound exactly as before).
// ============================================================

// ------------------------------------------------------------
// One ledger entry. `tx` = the original row joined with its account
// (account_type, currency_id, reference_prefix).
// ------------------------------------------------------------
const performSingleReversal = async (client, tx, { reason, userId, ip }) => {
    // Determine the reversal type — opposite of original
    const reversalType = tx.transaction_type === 'CREDIT'
        ? 'REVERSAL_DEBIT'
        : 'REVERSAL_CREDIT';

    // Generate reversal reference — uses the account's own tailored
    // prefix if it has one, else falls back to the generic PA/SA code
    const { referenceId, referenceCode } = await generateReference(
        client,
        resolveModuleCode(tx),
        'REV',
        'TRANSACTION',
        userId
    );

    // Post the reversal transaction
    const { transactionId, balanceBefore, balanceAfter } = await postTransaction(client, {
        accountId:       tx.account_id,
        transactionType: reversalType,
        inflowType:      tx.inflow_type,
        amount:          tx.amount,
        currencyId:      tx.currency_id,
        categoryId:      tx.category_id,
        description:     `REVERSAL of ${tx.description} — Reason: ${reason}`,
        valueDate:       new Date().toISOString().split('T')[0],
        createdBy:       userId,
        referenceId,
        reversalOf:      tx.id,
        isReversal:      true,
        // v1.70.0 — the reversal posts to exactly the same ledger
        // account as the original (glService also makes a reversal
        // inherit the original's investment / side fund treatment).
        glOverrideAccountCode: tx.gl_override_account_code || null,
        taxTreatment:          tx.tax_treatment || null,
    });

    await linkReferenceToRecord(client, referenceId, transactionId);

    // v1.70.0 — tax recorded against this transaction (tax withheld
    // from the payee, or tax deducted at source from income) is
    // reversed with it; refused if that tax was already paid to URA
    // or claimed in a filed return.
    await taxService.reverseForTransaction(client, {
        transactionId: tx.id,
        reversalDate: new Date().toISOString().split('T')[0],
        userId: userId,
    });

    // Mark the original as reversed
    await client.query(`
        UPDATE transactions
        SET    is_reversed = TRUE
        WHERE  id = $1
    `, [tx.id]);

    // v1.30.1 — if the transaction being reversed was a shareholder
    // capital contribution (tx.contribution_id is only ever
    // populated for inflow_type = 'CONTRIBUTION' transactions — see
    // creditShareholderContribution), flip that contribution's own
    // status to REVERSED and re-run the shareholding recompute so
    // it stops counting toward that member's shares_held/percentage.
    // Gated specifically on contribution_id (not just inflow_type)
    // since this route reverses ANY transaction in the ledger, not
    // just contributions — everything else must be left untouched.
    let contributionReversed = false;
    if (tx.contribution_id) {
        await client.query(`
            UPDATE shareholder_contributions
            SET    status = 'REVERSED'
            WHERE  id = $1 AND status = 'APPROVED'
        `, [tx.contribution_id]);
        // v1.69.0 — cancel the whole shares this contribution bought
        // and take its value back out of the member's share credit
        // (which may go negative; their next contribution fills it).
        if (await shareCapitalService.isOpeningConverted(client)) {
            await shareCapitalService.reverseContribution(client, {
                contributionId: tx.contribution_id,
                reversalDate: new Date().toISOString().split('T')[0],
                reason,
                reversedBy: userId,
            });
        } else {
            await recalculateShareholding(client, { recordedByUserId: userId });
        }
        contributionReversed = true;
    }

    // v1.40.1 — fixed: reversing a deposit's transaction previously
    // left deposit_balances/deposit_entries completely untouched
    // ("the deposit amount remains unchanged even when a reversal
    // is initiated"). Deposits have no dedicated linking column on
    // `transactions` (unlike contribution_id above) — they're only
    // identifiable via inflow_type — so this is matched the same
    // way creditDepositContribution always sets it.
    let depositReversed = false;
    if (tx.inflow_type === 'DEPOSIT_CONTRIBUTION_IN') {
        const entryResult = await client.query(`
            SELECT * FROM deposit_entries
            WHERE  transaction_id = $1 AND is_reversed = FALSE
            FOR UPDATE
        `, [tx.id]);

        if (entryResult.rows.length > 0) {
            const entry = entryResult.rows[0];

            const balanceResult = await client.query(
                'SELECT balance FROM deposit_balances WHERE user_id = $1 FOR UPDATE',
                [entry.user_id]
            );
            const currentBalance = parseFloat(balanceResult.rows[0]?.balance || 0);
            const entryAmount = parseFloat(entry.normalized_amount);

            // Guard against the non_negative_deposit_balance CHECK —
            // this only fires if some of this member's balance was
            // already paid out via an exit refund in the meantime,
            // which a plain decrement would violate.
            if (currentBalance < entryAmount) {
                throw createError.badRequest(
                    `Cannot reverse this deposit — the member's current deposit balance ` +
                    `(${currentBalance}) is lower than this entry's amount (${entryAmount}), ` +
                    `most likely because some or all of it has already been paid out via an exit refund.`
                );
            }

            await client.query(`
                UPDATE deposit_balances
                SET    balance = balance - $1, updated_at = NOW()
                WHERE  user_id = $2
            `, [entryAmount, entry.user_id]);

            await client.query(`
                UPDATE deposit_entries
                SET    is_reversed = TRUE, reversed_at = NOW(), reversed_by = $1
                WHERE  id = $2
            `, [userId, entry.id]);

            await logAction(userId, ACTIONS.DEPOSIT_ENTRY_REVERSED, MODULES.FINANCE, {
                ipAddress:   ip,
                recordType:  'deposit_entries',
                recordId:    entry.id,
                oldValues:   { balance_before: currentBalance },
                newValues:   { balance_after: currentBalance - entryAmount, reversed_amount: entryAmount },
                description: `Deposit entry reversed alongside transaction ${referenceCode}: ` +
                             `user #${entry.user_id}, ${entryAmount} removed from their deposit balance`,
                client,
            });

            depositReversed = true;
        }
    }

    // v1.41.0 — Side Fund contributions cascade oldest-unpaid-due-
    // first and can bank any leftover as running credit (see
    // applySideFundPayment) — side_fund_payment_applications is the
    // append-only record of exactly what THIS transaction did,
    // written since v1.41.0, which lets a reversal undo it precisely
    // regardless of how many dues/members were touched (this also
    // correctly covers bulkPayDues — one transaction, many members).
    // side_fund_config.current_balance is a clean 1:1 mirror of the
    // ledger for this feature, so it's always decremented here
    // regardless of whether the due/credit detail can be recovered.
    let sideFundReversed = false;
    let sideFundWarning = null;
    if (tx.inflow_type === 'SIDE_FUND_CONTRIBUTION_IN') {
        const configResult = await client.query(
            'SELECT current_balance FROM side_fund_config WHERE id = 1 FOR UPDATE'
        );
        const currentEnvelope = parseFloat(configResult.rows[0]?.current_balance || 0);
        const txAmount = parseFloat(tx.amount);

        if (currentEnvelope < txAmount) {
            throw createError.badRequest(
                `Cannot reverse — the side fund's envelope balance (${currentEnvelope}) is lower than ` +
                `this transaction's amount (${txAmount}), most likely because it has already been spent ` +
                `via a side fund expense.`
            );
        }

        await client.query(`
            UPDATE side_fund_config
            SET    current_balance = current_balance - $1, updated_at = NOW()
            WHERE  id = 1
        `, [txAmount]);

        const applications = await client.query(`
            SELECT * FROM side_fund_payment_applications
            WHERE  transaction_id = $1 AND is_reversed = FALSE
            FOR UPDATE
        `, [tx.id]);

        if (applications.rows.length > 0) {
            for (const app of applications.rows) {
                const appAmount = parseFloat(app.amount);

                if (app.application_type === 'DUE_PAYMENT') {
                    const dueResult = await client.query(
                        'SELECT * FROM side_fund_dues WHERE id = $1 FOR UPDATE',
                        [app.due_id]
                    );
                    const due = dueResult.rows[0];
                    if (due) {
                        const newPaid = Math.max(0, parseFloat(due.amount_paid) - appAmount);
                        const newStatus = newPaid <= 0 ? 'PENDING'
                            : newPaid < parseFloat(due.amount_due) ? 'PARTIAL' : 'PAID';
                        await client.query(`
                            UPDATE side_fund_dues
                            SET    amount_paid = $1, status = $2, updated_at = NOW(),
                                   transaction_id = CASE WHEN transaction_id = $3 THEN NULL ELSE transaction_id END
                            WHERE  id = $4
                        `, [newPaid, newStatus, tx.id, due.id]);
                    }
                } else if (app.application_type === 'CREDIT_BANKED') {
                    const creditResult = await client.query(
                        'SELECT credit_balance FROM side_fund_member_credit WHERE user_id = $1 FOR UPDATE',
                        [app.user_id]
                    );
                    const currentCredit = parseFloat(creditResult.rows[0]?.credit_balance || 0);

                    if (currentCredit < appAmount) {
                        throw createError.badRequest(
                            `Cannot reverse — user #${app.user_id}'s banked side fund credit (${currentCredit}) ` +
                            `is lower than the ${appAmount} this transaction banked, most likely because it has ` +
                            `already been drawn down against a later month's due.`
                        );
                    }

                    await client.query(`
                        UPDATE side_fund_member_credit
                        SET    credit_balance = credit_balance - $1, updated_at = NOW()
                        WHERE  user_id = $2
                    `, [appAmount, app.user_id]);

                    await client.query(`
                        INSERT INTO side_fund_credit_ledger (user_id, delta, reason, related_due_id)
                        VALUES ($1, $2, $3, NULL)
                    `, [app.user_id, -appAmount, `Reversed — transaction ${referenceCode} was reversed`]);
                }

                await client.query(`
                    UPDATE side_fund_payment_applications
                    SET    is_reversed = TRUE, reversed_at = NOW(), reversed_by = $1
                    WHERE  id = $2
                `, [userId, app.id]);
            }

            await logAction(userId, ACTIONS.SIDE_FUND_PAYMENT_REVERSED, MODULES.FINANCE, {
                ipAddress:   ip,
                recordType:  'side_fund_payment_applications',
                recordId:    tx.id,
                newValues:   { applications_reversed: applications.rows.length },
                description: `Side fund payment reversed alongside transaction ${referenceCode}: ` +
                             `${applications.rows.length} application(s) undone`,
                client,
            });

            sideFundReversed = true;
        } else {
            // Predates side_fund_payment_applications (added v1.41.0) —
            // the envelope balance above was still corrected, but there's
            // no reliable record of which due(s)/credit this specific
            // transaction affected, so that part can't be safely undone.
            sideFundWarning =
                'This transaction predates side fund reversal tracking — the envelope balance was ' +
                'corrected, but no linked dues/credit record was found to roll back automatically. ' +
                'Please review side_fund_dues for this member manually if needed.';
        }
    }

    // v1.41.0 — Savings. member_savings (written by approveSavingsDeposit,
    // createFixedTermSavings, and — as of v1.41.0 — creditSavingsContribution
    // too) is the per-entry link; a FLEXIBLE entry credited savings_balances
    // and needs it decremented back, a FIXED_TERM entry never touched
    // savings_balances at all so only its own status flips. The two rare
    // "exit payout" legs (Side Fund/Deposit exit refunds crediting Savings)
    // write no entry row and have no user-identifying column on
    // `transactions` itself, so they're intentionally out of scope here —
    // same reasoning as leaving Side Fund's own removeMember exit flow
    // out of scope for the Side Fund branch above.
    let savingsReversed = false;
    if (tx.inflow_type === 'SAVINGS_DEPOSIT_IN') {
        const entryResult = await client.query(`
            SELECT * FROM member_savings WHERE transaction_id = $1 FOR UPDATE
        `, [tx.id]);

        if (entryResult.rows.length > 0 && entryResult.rows[0].status !== 'REVERSED') {
            const entry = entryResult.rows[0];

            if (entry.entry_type === 'FLEXIBLE') {
                // v1.61.0 — a member can hold several currencies'
                // worth of savings_balances rows now, so this must
                // target the SPECIFIC (user, currency) row this
                // deposit actually credited, not just user_id alone.
                const balanceResult = await client.query(
                    'SELECT principal_balance FROM savings_balances WHERE user_id = $1 AND currency_id = $2 FOR UPDATE',
                    [entry.user_id, entry.currency_id]
                );
                const currentPrincipal = parseFloat(balanceResult.rows[0]?.principal_balance || 0);
                const entryAmount = parseFloat(entry.principal_amount);

                if (currentPrincipal < entryAmount) {
                    throw createError.badRequest(
                        `Cannot reverse this savings deposit — the member's current savings principal ` +
                        `(${currentPrincipal}) is lower than this deposit's amount (${entryAmount}), most ` +
                        `likely because some of it has already been paid out via a handout.`
                    );
                }

                await client.query(`
                    UPDATE savings_balances
                    SET    principal_balance = principal_balance - $1, updated_at = NOW()
                    WHERE  user_id = $2 AND currency_id = $3
                `, [entryAmount, entry.user_id, entry.currency_id]);
            }
            // FIXED_TERM: never credited savings_balances, so nothing to undo there.

            await client.query(`
                UPDATE member_savings
                SET    status = 'REVERSED', reversed_at = NOW(), reversed_by = $1
                WHERE  id = $2
            `, [userId, entry.id]);

            await logAction(userId, ACTIONS.SAVINGS_ENTRY_REVERSED, MODULES.FINANCE, {
                ipAddress:   ip,
                recordType:  'member_savings',
                recordId:    entry.id,
                description: `Savings entry reversed alongside transaction ${referenceCode}: user #${entry.user_id}`,
                client,
            });

            savingsReversed = true;
        }
    } else if (tx.inflow_type === 'SAVINGS_HANDOUT_OUT') {
        const handoutResult = await client.query(`
            SELECT * FROM savings_handouts WHERE transaction_id = $1 FOR UPDATE
        `, [tx.id]);

        if (handoutResult.rows.length > 0 && handoutResult.rows[0].status !== 'REVERSED') {
            const handout = handoutResult.rows[0];
            const principalAmount = parseFloat(handout.principal_amount);
            const interestAmount = parseFloat(handout.interest_amount) || 0;

            await client.query(`
                UPDATE savings_balances
                SET    principal_balance   = principal_balance + $1,
                       accrued_interest    = accrued_interest + $2,
                       total_interest_paid = GREATEST(0, total_interest_paid - $2),
                       updated_at = NOW()
                WHERE  user_id = $3 AND currency_id = $4
            `, [principalAmount, interestAmount, handout.user_id, handout.currency_id]);

            await client.query(`
                UPDATE savings_handouts
                SET    status = 'REVERSED', reversed_at = NOW(), reversed_by = $1
                WHERE  id = $2
            `, [userId, handout.id]);

            await logAction(userId, ACTIONS.SAVINGS_HANDOUT_REVERSED, MODULES.FINANCE, {
                ipAddress:   ip,
                recordType:  'savings_handouts',
                recordId:    handout.id,
                description: `Savings handout reversed alongside transaction ${referenceCode}: user #${handout.user_id}`,
                client,
            });

            savingsReversed = true;
        }
    }

    await logAction(userId, ACTIONS.TRANSACTION_REVERSED, MODULES.FINANCE, {
        ipAddress:   ip,
        recordType:  'transactions',
        recordId:    transactionId,
        oldValues:   { original_transaction_id: tx.id },
        newValues:   {
            referenceCode, reason, balanceBefore, balanceAfter,
            contributionReversed, depositReversed, sideFundReversed, savingsReversed,
        },
        description: `Transaction reversed: ${referenceCode} — Reason: ${reason}` +
                     `${contributionReversed ? ' (linked shareholder contribution marked REVERSED and shareholding recalculated)' : ''}` +
                     `${depositReversed ? ' (linked deposit entry reversed and deposit balance decremented)' : ''}` +
                     `${sideFundReversed ? ' (linked side fund due/credit applications reversed)' : ''}` +
                     `${savingsReversed ? ' (linked savings entry reversed and balance adjusted)' : ''}`,
        client,
    });

    return { transactionId, referenceCode, balanceBefore, balanceAfter, sideFundWarning };
};

const loadTransactionForReversal = async (client, id) => {
    const original = await client.query(`
        SELECT t.*, a.account_type, a.currency_id AS account_currency_id, a.reference_prefix
        FROM   transactions t
        JOIN   accounts a ON a.id = t.account_id
        WHERE  t.id = $1
        FOR UPDATE OF t
    `, [id]);
    return original.rows[0] || null;
};

// ------------------------------------------------------------
// The whole event — see the header above.
// ------------------------------------------------------------
const executeReversal = async (client, { transactionId, reason, userId, ip }) => {
    const tx = await loadTransactionForReversal(client, transactionId);
    if (!tx) throw createError.notFound('Transaction not found');
    if (tx.is_reversed) throw createError.badRequest('This transaction has already been reversed');
    if (tx.is_reversal) throw createError.badRequest('Cannot reverse a reversal entry');

    const blocked = await reversalLinks.findUnsupportedLink(client, tx);
    if (blocked) {
        throw createError.badRequest(
            `This entry is part of ${blocked.label}. Reversing it here would leave the ${blocked.page} records ` +
            'out of step with the ledger, so it is not allowed yet — correct it from the ' +
            `${blocked.page} page, or ask the administrator.`);
    }

    const group = await reversalLinks.resolveGroup(client, tx);
    await reversalLinks.precheck(client, group);

    // Every ledger entry of the event; money going back OUT is posted
    // after money coming back IN, so an account never dips below its
    // limit halfway through.
    const legIds = group ? group.legs : [tx.id];
    const legs = [];
    for (const legId of legIds) {
        const leg = legId === tx.id ? tx : await loadTransactionForReversal(client, legId);
        if (!leg || leg.is_reversed || leg.is_reversal) continue;
        legs.push(leg);
    }
    legs.sort((a, b) => (a.transaction_type === 'DEBIT' ? 0 : 1) - (b.transaction_type === 'DEBIT' ? 0 : 1));

    const results = [];
    const reversalOf = new Map();
    for (const leg of legs) {
        const r = await performSingleReversal(client, leg, {
            reason: leg.id === tx.id ? reason : `${reason} (part of the same event as the reversed entry)`,
            userId, ip,
        });
        reversalOf.set(leg.id, r.transactionId);
        results.push({ original_id: leg.id, ...r });
    }
    const sub = await reversalLinks.applySubledger(client, group, { userId, reversalOf });
    return { tx, group, results, subledger: sub };
};

// ------------------------------------------------------------
// POST /api/transactions/:id/reverse — ask for a reversal
// ------------------------------------------------------------
const reverseTransaction = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;

    await withTransaction(async (client) => {
        const pending = await client.query(
            `SELECT id FROM reversal_requests WHERE transaction_id = $1 AND status = 'PENDING'`, [id]);
        if (pending.rows.length) {
            throw createError.badRequest('A reversal of this transaction has already been requested and is waiting for approval.');
        }

        // Rehearse — then undo — so problems show up now.
        let preview;
        await client.query('SAVEPOINT reversal_preview');
        try {
            preview = await executeReversal(client, { transactionId: id, reason, userId: req.user.id, ip: req.ip });
        } finally {
            await client.query('ROLLBACK TO SAVEPOINT reversal_preview');
        }

        const legCount = preview.results.length;
        const summary = [
            legCount > 1 ? `${legCount} linked ledger entries will be reversed together` : null,
            preview.subledger?.summary || null,
        ].filter(Boolean).join('; ');

        const ins = await client.query(`
            INSERT INTO reversal_requests (transaction_id, reason, requested_by, effect_summary, linked_count)
            VALUES ($1, $2, $3, $4, $5) RETURNING id
        `, [id, reason, req.user.id, summary || null, legCount]);

        await logAction(req.user.id, ACTIONS.TRANSACTION_REVERSED, MODULES.FINANCE, {
            ipAddress: req.ip, recordType: 'reversal_requests', recordId: ins.rows[0].id,
            newValues: { transaction_id: parseInt(id), reason, linked_count: legCount, summary },
            description: `Reversal requested for transaction #${id} — waiting for a second person to approve. Reason: ${reason}`,
            client,
        });

        await notifyReversalApprovers(client, { requestId: ins.rows[0].id, requesterId: req.user.id, tx: preview.tx, reason });

        sendCreated(res, {
            request_id: ins.rows[0].id,
            status: 'PENDING',
            linked_count: legCount,
            effect_summary: summary || null,
        }, 'Reversal requested. Someone else (Treasurer, Assistant Treasurer, Director or Admin) must approve it before it is posted.');
    });
});

// Who may approve a reversal (never the person who asked, unless Admin).
const REVERSAL_APPROVER_ROLES = ['Treasurer', 'Assistant Treasurer', 'Director', 'Admin'];

const notifyReversalApprovers = async (client, { requestId, requesterId, tx, reason }) => {
    try {
        const approvers = await client.query(`
            SELECT DISTINCT u.id FROM users u
            JOIN   user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
            JOIN   roles r ON r.id = ur.role_id
            WHERE  r.name = ANY($1) AND u.is_active = TRUE AND u.id <> $2
        `, [REVERSAL_APPROVER_ROLES, requesterId]);
        for (const a of approvers.rows) {
            notify({
                userId: a.id, type: 'REVERSAL_REQUESTED',
                title: 'Reversal waiting for your approval',
                body: `${tx.description || 'A transaction'} — reason: ${reason}`,
                link: '/transactions?tab=reversals', module: 'FINANCE',
                recordType: 'reversal_requests', recordId: requestId,
            });
        }
    } catch (e) { /* notifications are best-effort */ }
};

// ------------------------------------------------------------
// GET /api/transactions/reversal-requests?status=PENDING
// ------------------------------------------------------------
const listReversalRequests = asyncHandler(async (req, res) => {
    const status = (req.query.status || '').toUpperCase();
    const params = [];
    let where = '';
    if (['PENDING', 'APPROVED', 'REJECTED'].includes(status)) { params.push(status); where = 'WHERE rr.status = $1'; }
    const r = await query(`
        SELECT rr.id, rr.transaction_id, rr.reason, rr.status, rr.effect_summary, rr.linked_count,
               rr.requested_at, rr.decided_at, rr.decision_note, rr.requested_by, rr.decided_by,
               req.first_name || ' ' || req.last_name AS requested_by_name,
               dec.first_name || ' ' || dec.last_name AS decided_by_name,
               t.amount, t.transaction_type, t.inflow_type, t.description, t.value_date,
               c.code AS currency_code, a.name AS account_name, ref.reference_code,
               revref.reference_code AS reversal_reference
        FROM   reversal_requests rr
        JOIN   transactions t ON t.id = rr.transaction_id
        JOIN   accounts a ON a.id = t.account_id
        JOIN   currencies c ON c.id = t.currency_id
        JOIN   references_registry ref ON ref.id = t.reference_id
        JOIN   users req ON req.id = rr.requested_by
        LEFT JOIN users dec ON dec.id = rr.decided_by
        LEFT JOIN transactions rev ON rev.id = rr.reversal_transaction_id
        LEFT JOIN references_registry revref ON revref.id = rev.reference_id
        ${where}
        ORDER BY (rr.status = 'PENDING') DESC, rr.requested_at DESC
        LIMIT 200
    `, params);
    sendSuccess(res, r.rows);
});

const loadRequestForDecision = async (client, id, req) => {
    const r = await client.query('SELECT * FROM reversal_requests WHERE id = $1 FOR UPDATE', [id]);
    if (!r.rows.length) throw createError.notFound('Reversal request not found');
    const rr = r.rows[0];
    if (rr.status !== 'PENDING') throw createError.badRequest('This reversal request has already been decided');
    const roles = req.user.roles || [];
    if (!roles.some(x => REVERSAL_APPROVER_ROLES.includes(x))) {
        throw createError.forbidden('Only the Treasurer, Assistant Treasurer, a Director or an Admin can decide reversal requests');
    }
    assertNotOwnApproval(req, [rr.requested_by], 'reversal request');
    return rr;
};

// POST /api/transactions/reversal-requests/:id/approve
const approveReversalRequest = asyncHandler(async (req, res) => {
    const { id } = req.params;
    await withTransaction(async (client) => {
        const rr = await loadRequestForDecision(client, id, req);
        const reason = `${rr.reason} (requested by user #${rr.requested_by}, approved by user #${req.user.id})`;
        const done = await executeReversal(client, { transactionId: rr.transaction_id, reason, userId: rr.requested_by, ip: req.ip });
        const main = done.results.find(x => x.original_id === rr.transaction_id) || done.results[0];
        await client.query(`
            UPDATE reversal_requests
            SET    status = 'APPROVED', decided_by = $1, decided_at = NOW(), reversal_transaction_id = $2,
                   effect_summary = COALESCE($3, effect_summary)
            WHERE  id = $4
        `, [req.user.id, main ? main.transactionId : null, done.subledger?.summary || null, id]);
        await logAction(req.user.id, ACTIONS.TRANSACTION_REVERSED, MODULES.FINANCE, {
            ipAddress: req.ip, recordType: 'reversal_requests', recordId: parseInt(id),
            newValues: { reversals: done.results.map(x => x.referenceCode), subledger: done.subledger?.summary || null },
            description: `Reversal request #${id} approved — ${done.results.map(x => x.referenceCode).join(', ')}`,
            client,
        });
        notify({
            userId: rr.requested_by, type: 'REVERSAL_APPROVED', title: 'Your reversal was approved',
            body: `Posted: ${done.results.map(x => x.referenceCode).join(', ')}`,
            link: '/transactions?tab=reversals', module: 'FINANCE', recordType: 'reversal_requests', recordId: parseInt(id),
        });
        sendSuccess(res, {
            reversal_references: done.results.map(x => x.referenceCode),
            subledger: done.subledger?.summary || null,
            warning: done.results.map(x => x.sideFundWarning).filter(Boolean)[0] || undefined,
        }, `Reversal approved and posted: ${done.results.map(x => x.referenceCode).join(', ')}`);
    });
});

// POST /api/transactions/reversal-requests/:id/reject
const rejectReversalRequest = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { note } = req.body;
    await withTransaction(async (client) => {
        const r = await client.query('SELECT * FROM reversal_requests WHERE id = $1 FOR UPDATE', [id]);
        if (!r.rows.length) throw createError.notFound('Reversal request not found');
        const rr = r.rows[0];
        if (rr.status !== 'PENDING') throw createError.badRequest('This reversal request has already been decided');
        const roles = req.user.roles || [];
        // The person who asked may withdraw their own request.
        if (rr.requested_by !== req.user.id && !roles.some(x => REVERSAL_APPROVER_ROLES.includes(x))) {
            throw createError.forbidden('Only the requester or an approver can refuse this reversal request');
        }
        await client.query(`
            UPDATE reversal_requests SET status = 'REJECTED', decided_by = $1, decided_at = NOW(), decision_note = $2
            WHERE id = $3
        `, [req.user.id, note || null, id]);
        await logAction(req.user.id, ACTIONS.TRANSACTION_REVERSED, MODULES.FINANCE, {
            ipAddress: req.ip, recordType: 'reversal_requests', recordId: parseInt(id),
            description: `Reversal request #${id} ${rr.requested_by === req.user.id ? 'withdrawn' : 'refused'}${note ? ` — ${note}` : ''}`,
            client,
        });
        sendSuccess(res, null, rr.requested_by === req.user.id ? 'Reversal request withdrawn' : 'Reversal request refused');
    });
});

// ============================================================
// SHARED FILTER BUILDER (v1.50.0) — factored out of getTransactions
// so the new analytics/export endpoints below filter identically
// (same account_id/inflow_type/from_date/to_date query params,
// same WHERE clause) without a second, driftable copy of this logic.
// ============================================================
const buildTransactionFilters = (reqQuery) => {
    const { account_id, inflow_type, from_date, to_date } = reqQuery;
    const conditions = [];
    const params = [];
    let p = 0;

    if (account_id) {
        p++; conditions.push(`t.account_id = $${p}`);
        params.push(account_id);
    }
    if (inflow_type) {
        p++; conditions.push(`t.inflow_type = $${p}`);
        params.push(inflow_type.toUpperCase());
    }
    if (from_date) {
        p++; conditions.push(`t.value_date >= $${p}`);
        params.push(from_date);
    }
    if (to_date) {
        p++; conditions.push(`t.value_date <= $${p}`);
        params.push(to_date);
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    return { where, params, paramCount: p };
};

// ============================================================
// GET TRANSACTION LEDGER
// GET /api/transactions?account_id=1&page=1&limit=20
// Returns paginated transaction history for an account.
// v1.62.0: ordered by value_date (the transaction's own business
// date), not posted_at (when it was entered) — so a backdated entry
// shows up chronologically where it belongs, same tie-break (id) the
// point-in-time balance check in postTransaction itself uses.
// ============================================================
const getTransactions = asyncHandler(async (req, res) => {
    const { page, limit, offset } = getPagination(req.query);
    const { where, params, paramCount: p } = buildTransactionFilters(req.query);

    // Count total
    const countResult = await query(
        `SELECT COUNT(*) AS total FROM transactions t ${where}`,
        params
    );
    const total = parseInt(countResult.rows[0].total);

    // Fetch page
    params.push(limit, offset);
    const result = await query(`
        SELECT
            t.id,
            t.transaction_type,
            t.inflow_type,
            t.amount,
            t.balance_before,
            t.balance_after,
            t.description,
            t.value_date,
            t.is_reversal,
            t.is_reversed,
            t.status,
            t.posted_at,
            -- v1.72.0 — a reversal asked for but not yet approved
            EXISTS (SELECT 1 FROM reversal_requests rrq
                    WHERE rrq.transaction_id = t.id AND rrq.status = 'PENDING') AS reversal_pending,
            r.reference_code,
            r.public_id,
            c.code   AS currency_code,
            c.symbol AS currency_symbol,
            cat.name AS category_name,
            cp.full_path AS category_trail,
            u.first_name || ' ' || u.last_name AS created_by_name,
            a.name AS account_name
        FROM  transactions t
        JOIN  references_registry r  ON r.id  = t.reference_id
        JOIN  currencies c           ON c.id  = t.currency_id
        JOIN  categories cat         ON cat.id = t.category_id
        JOIN  category_paths cp      ON cp.category_id = t.category_id
        JOIN  users u                ON u.id  = t.created_by
        JOIN  accounts a             ON a.id  = t.account_id
        ${where}
        ORDER BY t.value_date DESC, t.id DESC
        LIMIT $${p + 1} OFFSET $${p + 2}
    `, params);

    sendPaginated(res, result.rows, total, page, limit);
});

// ============================================================
// TRANSACTION ANALYTICS (v1.50.0) — Income vs Expense by currency,
// plus which quarter (fiscal if configured, else calendar —
// quarterAnalyticsService) saw the most/least of each, for the
// Transactions page's new top-of-page chart section. Honors the
// exact same filters as the ledger itself (account_id/inflow_type/
// from_date/to_date) so "what you're looking at" and "what the chart
// summarizes" always match. Currencies are kept separate rather than
// converted to one display currency — a EUR total and a UGX total
// are never added together, by design (exact historical figures,
// no FX-conversion assumptions baked into the analytics).
// GET /api/transactions/analytics
// ============================================================
// A single request pulling every matching row for a potentially
// long-lived ledger could be huge — 20,000 is generous for this
// system's real scale (a single company's shareholder/member base)
// while still bounding worst-case memory/response size. A ledger
// past this size should filter by date range first, same as any
// other "export everything" operation in this app.
const ANALYTICS_ROW_CAP = 20000;

const getTransactionAnalytics = asyncHandler(async (req, res) => {
    const { where, params } = buildTransactionFilters(req.query);

    const result = await query(`
        SELECT t.value_date, t.transaction_type, t.amount, c.code AS currency_code
        FROM   transactions t
        JOIN   currencies c ON c.id = t.currency_id
        ${where}
        ORDER  BY t.value_date ASC
        LIMIT  ${ANALYTICS_ROW_CAP}
    `, params);

    const rows = result.rows.map(r => ({
        date: r.value_date,
        currency: r.currency_code,
        amount: r.amount,
        direction: (r.transaction_type === 'CREDIT' || r.transaction_type === 'REVERSAL_CREDIT') ? 'IN' : 'OUT',
    }));

    const fiscalQuarters = await loadFiscalQuarters();
    const byCurrency = bucketAndSummarize(rows, fiscalQuarters);

    sendSuccess(res, {
        by_currency: byCurrency,
        row_count: rows.length,
        truncated: rows.length >= ANALYTICS_ROW_CAP,
    });
});

// ============================================================
// EXPORT TRANSACTIONS AS CSV (v1.50.0)
// GET /api/transactions/export — same filters as the ledger, but
// returns every matching row (not just the current page) as a CSV
// download. This doubles as the "general ledger" export: clear every
// filter first and it exports the complete ledger.
// ============================================================
const exportTransactionsCsv = asyncHandler(async (req, res) => {
    const { where, params } = buildTransactionFilters(req.query);

    const result = await query(`
        SELECT
            r.reference_code, r.public_id, t.description,
            t.transaction_type, t.inflow_type,
            c.code AS currency_code, t.amount, t.balance_after,
            t.value_date, t.status, a.name AS account_name,
            cp.full_path AS category_trail, cat.name AS category_name,
            u.first_name || ' ' || u.last_name AS created_by_name
        FROM  transactions t
        JOIN  references_registry r  ON r.id  = t.reference_id
        JOIN  currencies c           ON c.id  = t.currency_id
        JOIN  categories cat         ON cat.id = t.category_id
        JOIN  category_paths cp      ON cp.category_id = t.category_id
        JOIN  users u                ON u.id  = t.created_by
        JOIN  accounts a             ON a.id  = t.account_id
        ${where}
        ORDER BY t.value_date ASC, t.posted_at ASC
        LIMIT ${ANALYTICS_ROW_CAP}
    `, params);

    const isCredit = (row) => row.transaction_type === 'CREDIT' || row.transaction_type === 'REVERSAL_CREDIT';

    const csv = rowsToCsv([
        { key: 'reference_code', header: 'Reference' },
        { key: 'public_id',      header: 'Public ID' },
        { key: 'value_date',     header: 'Date', format: v => normalizeDateInput(v) || '' },
        { key: 'description',    header: 'Description' },
        { key: 'account_name',   header: 'Account' },
        { key: 'category_trail', header: 'Category', format: (v, row) => v || row.category_name },
        { key: 'transaction_type', header: 'Direction', format: (_v, row) => (isCredit(row) ? 'Income' : 'Expense') },
        { key: 'inflow_type',    header: 'Type' },
        { key: 'currency_code',  header: 'Currency' },
        { key: 'amount',         header: 'Amount', format: (v, row) => (isCredit(row) ? '' : '-') + parseFloat(v).toFixed(2) },
        { key: 'balance_after',  header: 'Balance After', format: v => parseFloat(v).toFixed(2) },
        { key: 'status',         header: 'Status' },
        { key: 'created_by_name', header: 'Recorded By' },
    ], result.rows);

    const stamp = new Date().toISOString().slice(0, 10);
    sendCsv(res, `transactions-${stamp}.csv`, csv);
});

// ============================================================
// GET SINGLE TRANSACTION
// GET /api/transactions/:id
// ============================================================
const getTransactionById = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const result = await query(`
        SELECT
            t.*,
            r.reference_code,
            r.public_id,
            c.code   AS currency_code,
            c.symbol AS currency_symbol,
            cat.name AS category_name,
            cp.full_path AS category_trail,
            u.first_name || ' ' || u.last_name AS created_by_name,
            a.name AS account_name,
            a.account_type
        FROM  transactions t
        JOIN  references_registry r  ON r.id  = t.reference_id
        JOIN  currencies c           ON c.id  = t.currency_id
        JOIN  categories cat         ON cat.id = t.category_id
        JOIN  category_paths cp      ON cp.category_id = t.category_id
        JOIN  users u                ON u.id  = t.created_by
        JOIN  accounts a             ON a.id  = t.account_id
        WHERE t.id = $1
    `, [id]);

    if (result.rows.length === 0) {
        throw createError.notFound('Transaction not found');
    }

    sendSuccess(res, result.rows[0]);
});

module.exports = {
    recordContribution,
    creditShareholderContribution,
    recalculateShareholding,
    computeShareUnitsPerUser,
    describeShareValuation,
    creditSideFundContribution,
    creditDepositContribution,
    recordExpense,
    recordInflow,
    reverseTransaction,
    executeReversal,
    listReversalRequests,
    approveReversalRequest,
    rejectReversalRequest,
    getTransactions,
    getTransactionAnalytics,
    exportTransactionsCsv,
    getTransactionById,
    postTransaction,
};