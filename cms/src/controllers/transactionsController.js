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

// ============================================================
// INTERNAL HELPER — GET CURRENT FLOOR LIMIT
// Returns the current floor limit for the given account, if one has
// ever been set (0 otherwise — no floor limit configured behaves
// exactly like before, i.e. no restriction beyond zero).
// The SAVINGS account is a permanent, hard-coded exception: it must
// always be allowed to sit at exactly zero, so no floor limit is ever
// looked up or enforced for it, even if a row somehow exists.
// ============================================================
const getFloorLimit = async (client, accountId, accountType) => {
    if (accountType === 'SAVINGS') return 0;

    const result = await client.query(`
        SELECT floor_amount
        FROM   primary_account_floor_limits
        WHERE  account_id = $1
        AND    effective_to IS NULL
        ORDER  BY effective_from DESC
        LIMIT  1
    `, [accountId]);

    return result.rows.length > 0 ? parseFloat(result.rows[0].floor_amount) : 0;
};

// ============================================================
// INTERNAL HELPER — POST A TRANSACTION
// This is the core function that actually moves money.
// It is called by contributions, expenses, and transfers.
// It enforces all balance rules before committing.
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
    const balanceBefore = parseFloat(account.current_balance);
    const transactionAmount = parseFloat(amount);

    // Calculate new balance
    let balanceAfter;
    if (transactionType === 'CREDIT' || transactionType === 'REVERSAL_CREDIT') {
        balanceAfter = balanceBefore + transactionAmount;
    } else {
        balanceAfter = balanceBefore - transactionAmount;
    }

    // RULE 1: No account can go below zero
    if (balanceAfter < 0) {
        throw createError.badRequest(
            `Insufficient funds. Current balance: ${balanceBefore}. ` +
            `Transaction amount: ${transactionAmount}.`
        );
    }

    // RULE 2: An account with a floor limit set cannot go below it.
    // Any account type can have a floor limit (v1.14.0) except SAVINGS,
    // which is permanently exempt — getFloorLimit returns 0 for it (and
    // for any account with no floor limit configured), so this check is
    // a safe no-op in both of those cases.
    if (account.account_type !== 'SAVINGS') {
        const floorLimit = await getFloorLimit(client, accountId, account.account_type);
        if (balanceAfter < floorLimit) {
            throw createError.badRequest(
                `This transaction would bring this account below its floor limit ` +
                `of ${floorLimit}. Current balance: ${balanceBefore}. ` +
                `Available to spend: ${balanceBefore - floorLimit}.`
            );
        }
    }

    // Insert the transaction record
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
            $20, $20, NOW(), NOW()
        )
        RETURNING id
    `, [
        referenceId, accountId, transactionType, inflowType,
        transactionAmount, currencyId, balanceBefore, balanceAfter,
        categoryId, description, valueDate,
        transferId, contributionId, loanReceivedId,
        loanGivenId, investmentId, grantTrancheId,
        reversalOf, isReversal,
        createdBy,
    ]);

    const transactionId = txResult.rows[0].id;

    // Update the account balance
    await client.query(`
        UPDATE accounts
        SET    current_balance = $1
        WHERE  id = $2
    `, [balanceAfter, accountId]);

    return { transactionId, balanceBefore, balanceAfter };
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
const recalculateShareholding = async (client, { recordedByUserId }) => {
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

    // Auto-recalculate every shareholder's shares_held/percentage from
    // the current shareholder_contributions ledger — see
    // recalculateShareholding() below for the full explanation.
    await recalculateShareholding(client, { recordedByUserId });

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
            `, { preheader: 'Your contribution has been recorded' }),
        },
    });

    return {
        transactionId, balanceBefore, balanceAfter,
        referenceCode, contributor, account,
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
    userId, amount, contributionDate, categoryId, recordedByUserId,
}) => {
    const memberResult = await client.query(
        'SELECT id, first_name, last_name, email FROM users WHERE id = $1 AND is_active = TRUE',
        [userId]
    );
    if (memberResult.rows.length === 0) {
        throw createError.notFound('Contributing member not found');
    }
    const member = memberResult.rows[0];

    const savingsAccount = await getSavingsAccount(client);

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
               currency_id = COALESCE(currency_id, $2),
               updated_at = NOW()
        WHERE  user_id = $3
    `, [amount, savingsAccount.currency_id, userId]);

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
            savings = await creditSavingsContribution(client, {
                userId:            contributorId,
                amount:            savingsAmount,
                contributionDate:  contribution_date,
                categoryId:        category_id,
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
    } = req.body;

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

        const { transactionId, balanceBefore, balanceAfter } = await postTransaction(client, {
            accountId:       account_id,
            transactionType: 'CREDIT',
            inflowType:      'OTHER_INCOME',
            amount,
            currencyId:      account.currency_id,
            categoryId:      category_id,
            description,
            valueDate:       value_date,
            createdBy:       req.user.id,
            referenceId,
        });

        await linkReferenceToRecord(client, referenceId, transactionId);

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
            balance_before: balanceBefore,
            balance_after:  balanceAfter,
        }, `Inflow recorded successfully. Reference: ${referenceCode}`);
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
    } = req.body;

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

        // Post the transaction
        const { transactionId, balanceBefore, balanceAfter } = await postTransaction(client, {
            accountId:       account_id,
            transactionType: 'DEBIT',
            inflowType:      'EXPENSE',
            amount,
            currencyId:      account.currency_id,
            categoryId:      category_id,
            description,
            valueDate:       value_date,
            createdBy:       req.user.id,
            referenceId,
        });

        await linkReferenceToRecord(client, referenceId, transactionId);

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
            balance_before: balanceBefore,
            balance_after:  balanceAfter,
        }, `Expense recorded successfully. Reference: ${referenceCode}`);
    });
});

// ============================================================
// REVERSE A TRANSACTION
// POST /api/transactions/:id/reverse
// Creates a new reversal entry linked to the original.
// The original transaction is never modified.
// ============================================================
const reverseTransaction = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;

    await withTransaction(async (client) => {
        // Get the original transaction
        const original = await client.query(`
            SELECT t.*, a.account_type, a.currency_id, a.reference_prefix
            FROM   transactions t
            JOIN   accounts a ON a.id = t.account_id
            WHERE  t.id = $1
        `, [id]);

        if (original.rows.length === 0) {
            throw createError.notFound('Transaction not found');
        }

        const tx = original.rows[0];

        // Cannot reverse an already reversed transaction
        if (tx.is_reversed) {
            throw createError.badRequest('This transaction has already been reversed');
        }

        // Cannot reverse a reversal
        if (tx.is_reversal) {
            throw createError.badRequest('Cannot reverse a reversal entry');
        }

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
            req.user.id
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
            createdBy:       req.user.id,
            referenceId,
            reversalOf:      tx.id,
            isReversal:      true,
        });

        await linkReferenceToRecord(client, referenceId, transactionId);

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
            await recalculateShareholding(client, { recordedByUserId: req.user.id });
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
                `, [req.user.id, entry.id]);

                await logAction(req.user.id, ACTIONS.DEPOSIT_ENTRY_REVERSED, MODULES.FINANCE, {
                    ipAddress:   req.ip,
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
                    `, [req.user.id, app.id]);
                }

                await logAction(req.user.id, ACTIONS.SIDE_FUND_PAYMENT_REVERSED, MODULES.FINANCE, {
                    ipAddress:   req.ip,
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
                    const balanceResult = await client.query(
                        'SELECT principal_balance FROM savings_balances WHERE user_id = $1 FOR UPDATE',
                        [entry.user_id]
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
                        WHERE  user_id = $2
                    `, [entryAmount, entry.user_id]);
                }
                // FIXED_TERM: never credited savings_balances, so nothing to undo there.

                await client.query(`
                    UPDATE member_savings
                    SET    status = 'REVERSED', reversed_at = NOW(), reversed_by = $1
                    WHERE  id = $2
                `, [req.user.id, entry.id]);

                await logAction(req.user.id, ACTIONS.SAVINGS_ENTRY_REVERSED, MODULES.FINANCE, {
                    ipAddress:   req.ip,
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
                    WHERE  user_id = $3
                `, [principalAmount, interestAmount, handout.user_id]);

                await client.query(`
                    UPDATE savings_handouts
                    SET    status = 'REVERSED', reversed_at = NOW(), reversed_by = $1
                    WHERE  id = $2
                `, [req.user.id, handout.id]);

                await logAction(req.user.id, ACTIONS.SAVINGS_HANDOUT_REVERSED, MODULES.FINANCE, {
                    ipAddress:   req.ip,
                    recordType:  'savings_handouts',
                    recordId:    handout.id,
                    description: `Savings handout reversed alongside transaction ${referenceCode}: user #${handout.user_id}`,
                    client,
                });

                savingsReversed = true;
            }
        }

        await logAction(req.user.id, ACTIONS.TRANSACTION_REVERSED, MODULES.FINANCE, {
            ipAddress:   req.ip,
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

        sendCreated(res, {
            reversal_reference: referenceCode,
            reversal_id:        transactionId,
            original_id:        tx.id,
            balance_before:     balanceBefore,
            balance_after:      balanceAfter,
            warning:            sideFundWarning || undefined,
        }, `Transaction reversed successfully. Reference: ${referenceCode}`);
    });
});

// ============================================================
// GET TRANSACTION LEDGER
// GET /api/transactions?account_id=1&page=1&limit=20
// Returns paginated transaction history for an account.
// ============================================================
const getTransactions = asyncHandler(async (req, res) => {
    const { account_id, inflow_type, from_date, to_date } = req.query;
    const { page, limit, offset } = getPagination(req.query);

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

    const where = conditions.length > 0
        ? 'WHERE ' + conditions.join(' AND ')
        : '';

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
        ORDER BY t.posted_at DESC
        LIMIT $${p + 1} OFFSET $${p + 2}
    `, params);

    sendPaginated(res, result.rows, total, page, limit);
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
    creditSideFundContribution,
    creditDepositContribution,
    recordExpense,
    recordInflow,
    reverseTransaction,
    getTransactions,
    getTransactionById,
    postTransaction,
};