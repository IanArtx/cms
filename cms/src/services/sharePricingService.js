// ============================================================
// SHARE PRICING SERVICE (v1.33.0)
//
// Shared, date-aware lookups used to turn a contribution's raw money
// amount into a real number of SHARE UNITS — the missing piece that
// let shares_held mean "units actually bought," not just "money
// contributed." Two things vary over time and must be looked up AS OF
// the contribution's own date, never "whatever's current right now":
//   1. price_per_share (share_price_history) — what one share cost
//      on that date, and what currency it was priced in.
//   2. The FX rate (currency_exchange_rates) converting the
//      contribution's own currency into the shares' currency, if they
//      differ, as of that same date.
//
// FOUNDING VALUES: share_price_history/currency_exchange_rates have no
// seeded starting row (see migration_v1.33.0.sql, which backfills one
// of each, effective from this database's own earliest approved
// contribution). Both lookups below fall back to the EARLIEST row on
// file if a contribution predates everything recorded, purely as a
// defensive safety net — with the migration's seed rows in place this
// fallback should never actually be needed for real data, but it means
// a contribution can never be silently skipped/zeroed just because it's
// older than the price history happens to reach.
// ============================================================

const { createError } = require('../utils/errors');

// ============================================================
// GET THE SHARE PRICE (and its currency) EFFECTIVE ON A GIVEN DATE
// Returns { price_per_share, currency_id } or throws if no price has
// EVER been configured at all (a genuinely unconfigured system —
// different from "predates the price history," which falls back
// instead of throwing).
// ============================================================
const getSharePriceOn = async (client, date) => {
    const exact = await client.query(`
        SELECT price_per_share, currency_id
        FROM   share_price_history
        WHERE  effective_from <= $1
        AND    (effective_to IS NULL OR effective_to > $1)
        ORDER  BY effective_from DESC
        LIMIT  1
    `, [date]);
    if (exact.rows.length > 0) return exact.rows[0];

    // Predates every recorded price — fall back to the earliest one on
    // file rather than treating an old contribution as priceless.
    const earliest = await client.query(`
        SELECT price_per_share, currency_id
        FROM   share_price_history
        ORDER  BY effective_from ASC
        LIMIT  1
    `);
    if (earliest.rows.length > 0) return earliest.rows[0];

    throw createError.badRequest(
        'No share price has ever been configured (Settings > Shares) — cannot compute share units.'
    );
};

// ============================================================
// GET THE FX RATE CONVERTING fromCurrencyId -> toCurrencyId, EFFECTIVE
// ON A GIVEN DATE. currency_exchange_rates only ever stores ONE
// direction per pair (base -> target); if only the inverse direction
// is on file, this returns 1/rate instead of requiring both directions
// to be entered separately.
// Returns 1 if the two currencies are the same (no conversion needed —
// this is what makes Formula 1 and Formula 2 the same code path).
// Throws if the pair has no coverage AT ALL, in either direction, at
// any date — silently assuming a rate here would misvalue real
// ownership, so this is a hard stop rather than a guess.
// ============================================================
const getExchangeRateOn = async (client, fromCurrencyId, toCurrencyId, date) => {
    if (fromCurrencyId === toCurrencyId) return 1;

    const lookup = async (baseId, targetId) => {
        const exact = await client.query(`
            SELECT rate FROM currency_exchange_rates
            WHERE  base_currency_id = $1 AND target_currency_id = $2
            AND    effective_from <= $3
            AND    (effective_to IS NULL OR effective_to > $3)
            ORDER  BY effective_from DESC
            LIMIT  1
        `, [baseId, targetId, date]);
        if (exact.rows.length > 0) return parseFloat(exact.rows[0].rate);

        const earliest = await client.query(`
            SELECT rate FROM currency_exchange_rates
            WHERE  base_currency_id = $1 AND target_currency_id = $2
            ORDER  BY effective_from ASC
            LIMIT  1
        `, [baseId, targetId]);
        return earliest.rows.length > 0 ? parseFloat(earliest.rows[0].rate) : null;
    };

    const direct = await lookup(fromCurrencyId, toCurrencyId);
    if (direct !== null) return direct;

    const inverse = await lookup(toCurrencyId, fromCurrencyId);
    if (inverse !== null) return 1 / inverse;

    throw createError.badRequest(
        'No exchange rate (in either direction) has ever been configured between these two currencies (Settings > Exchange Rates) — cannot compute share units for a contribution in this currency.'
    );
};

// ============================================================
// CONVERT amount FROM fromCurrencyId INTO WHATEVER CURRENCY THE
// SHARE PRICE (as of `date`) IS DENOMINATED IN. This is the single
// entry point recalculateShareholding() (and the contribution
// recording FX-coverage guard) actually call.
// Returns { convertedAmount, sharePricePerUnit, shareCurrencyId,
// rateUsed } — the full breakdown, not just the final number, so
// callers (and the recalculate preview endpoint) can show their work.
// ============================================================
const convertToShareCurrency = async (client, amount, fromCurrencyId, date) => {
    const { price_per_share, currency_id: shareCurrencyId } = await getSharePriceOn(client, date);
    const rateUsed = await getExchangeRateOn(client, fromCurrencyId, shareCurrencyId, date);
    const convertedAmount = parseFloat(amount) * rateUsed;
    return {
        convertedAmount,
        sharePricePerUnit: parseFloat(price_per_share),
        shareCurrencyId,
        rateUsed,
    };
};

module.exports = {
    getSharePriceOn,
    getExchangeRateOn,
    convertToShareCurrency,
};
