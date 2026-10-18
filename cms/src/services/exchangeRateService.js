// ============================================================
// EXCHANGE RATE WRITER (v1.83.0)
// The one place a rate enters currency_exchange_rates — used by
// "Set Rate" (a person typing a rate: source MANUAL) and by approving a
// Bank of Uganda suggestion (source BOU / ALLRATESTODAY). Moved here
// unchanged from exchangeRatesController.setExchangeRate so both paths
// follow exactly the same rules:
//   - the fixed-rate company decisions (v1.76.0) are respected;
//   - two rates for the same pair can never start on the same day, so
//     a rate already used by the books — above all a hand-entered one —
//     is never overwritten;
//   - the rate slots into the pair's history at its date;
//   - every transaction it affects is re-valued in UGX (open months
//     only), and so is the realised exchange result of every transfer
//     it affects (v1.83.0).
// v1.83.0 also: a person typing a rate closes any BoU suggestion still
// waiting for the same pair and date ("hand-entered rate kept").
// ============================================================

const { createError } = require('../utils/errors');
const { logAction, ACTIONS, MODULES } = require('./auditService');
const fxService = require('./fxService');

const SOURCES = ['MANUAL', 'BOU', 'ALLRATESTODAY'];
const SOURCE_LABEL = { MANUAL: 'entered by hand', BOU: 'Bank of Uganda', ALLRATESTODAY: 'AllRatesToday (BoU table)' };

// A rate already starting on that date for the pair, in either direction.
const rateStartingOn = async (client, baseId, targetId, date) => {
    const r = await client.query(`
        SELECT id, rate, source, base_currency_id, target_currency_id
        FROM   currency_exchange_rates
        WHERE  effective_from = $3
        AND    ((base_currency_id = $1 AND target_currency_id = $2) OR (base_currency_id = $2 AND target_currency_id = $1))
        ORDER  BY id LIMIT 1
    `, [baseId, targetId, date]);
    return r.rows[0] || null;
};

// Does the realised-FX function exist yet (database at v1.83.0)?
let realisedFnKnown = null;
const recomputeTransferFx = async (client, fromDate) => {
    if (realisedFnKnown === false) return 0;
    if (realisedFnKnown === null) {
        const r = await client.query(`SELECT to_regproc('recompute_transfer_fx') IS NOT NULL AS ok`);
        realisedFnKnown = r.rows[0].ok;
        if (!realisedFnKnown) return 0;
    }
    const r = await client.query('SELECT recompute_transfer_fx($1::date) AS n', [fromDate || null]);
    return r.rows[0].n;
};

/**
 * Insert a rate inside an open transaction. Returns the new row plus
 * { fx } (the re-valuation counts).
 */
const setRate = async (client, {
    baseCurrencyId, targetCurrencyId, rate, effectiveDate, userId, notes = null,
    source = 'MANUAL', sourceDetail = null, suggestionId = null, ipAddress = null,
}) => {
    const base = parseInt(baseCurrencyId, 10);
    const target = parseInt(targetCurrencyId, 10);
    if (!base || !target) throw createError.badRequest('base_currency_id and target_currency_id are required');
    if (base === target) throw createError.badRequest('base_currency_id and target_currency_id must be different currencies');
    if (!rate || !(parseFloat(rate) > 0)) throw createError.badRequest('rate must be a positive number');
    if (!SOURCES.includes(source)) throw createError.badRequest('Unknown rate source');
    const date = effectiveDate ? String(effectiveDate).slice(0, 10) : fxService.todayStr();

    // v1.83.0 — one direction per pair. If the pair's history is kept
    // the other way round (e.g. 1 EUR = x UGX) a second history in the
    // opposite direction would compete with it (the books look up the
    // same-direction history first), so two different rates could apply
    // on one day. A typed rate is refused with the converted figure; a
    // feed rate is simply turned round.
    const dir = await client.query(`
        SELECT COUNT(*) FILTER (WHERE base_currency_id = $1 AND target_currency_id = $2)::int AS same,
               COUNT(*) FILTER (WHERE base_currency_id = $2 AND target_currency_id = $1)::int AS opposite
        FROM   currency_exchange_rates
    `, [base, target]);
    if (dir.rows[0].same === 0 && dir.rows[0].opposite > 0) {
        if (source === 'MANUAL') {
            const codes = await client.query('SELECT id, code FROM currencies WHERE id = ANY($1)', [[base, target]]);
            const code = Object.fromEntries(codes.rows.map(x => [x.id, x.code]));
            throw createError.badRequest(
                `This pair is kept as "1 ${code[target]} = … ${code[base]}". Please enter it that way: ` +
                `1 ${code[target]} = ${(1 / parseFloat(rate)).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${code[base]}.`
            );
        }
        return setRate(client, {
            baseCurrencyId: target, targetCurrencyId: base, rate: Math.round((1 / parseFloat(rate)) * 1e10) / 1e10,
            effectiveDate: date, userId, notes, source, sourceDetail, suggestionId, ipAddress,
        });
    }

    const fixedRule = await fxService.fixedRateRuleFor(base, target, date);
    if (fixedRule && !fxService.matchesFixedRule(fixedRule, base, rate)) {
        throw createError.conflict(
            `By company decision the rate is fixed at ${fxService.describeFixedRule(fixedRule)}. ` +
            `A different rate can only start on or after ${fixedRule.valid_before}.`
        );
    }

    const duplicate = await rateStartingOn(client, base, target, date);
    if (duplicate) {
        throw createError.conflict(
            `A rate for this currency pair already starts on ${date} (${duplicate.rate}, ${SOURCE_LABEL[duplicate.source] || duplicate.source}). ` +
            'Pick a different start date — rates already used by the books are never overwritten.'
        );
    }

    // The rate that was covering the date now stops there.
    await client.query(`
        UPDATE currency_exchange_rates
        SET    effective_to = $1
        WHERE  base_currency_id = $2 AND target_currency_id = $3
        AND    effective_from < $1
        AND    (effective_to IS NULL OR effective_to > $1)
    `, [date, base, target]);

    // The new rate runs until the next later rate starts, if any.
    const next = await client.query(`
        SELECT MIN(effective_from)::text AS next_from FROM currency_exchange_rates
        WHERE  base_currency_id = $1 AND target_currency_id = $2 AND effective_from > $3
    `, [base, target, date]);
    const effectiveTo = next.rows[0].next_from || null;

    const hasSource = await fxService.rateSourceColumnExists(client);
    const result = hasSource
        ? await client.query(`
            INSERT INTO currency_exchange_rates
                (base_currency_id, target_currency_id, rate, effective_from, effective_to, set_by, notes, source, source_detail, suggestion_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING id, base_currency_id, target_currency_id, rate,
                      effective_from::text AS effective_from, effective_to::text AS effective_to, notes, source, source_detail
        `, [base, target, rate, date, effectiveTo, userId, notes || null, source, sourceDetail, suggestionId])
        : await client.query(`
            INSERT INTO currency_exchange_rates
                (base_currency_id, target_currency_id, rate, effective_from, effective_to, set_by, notes)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id, base_currency_id, target_currency_id, rate,
                      effective_from::text AS effective_from, effective_to::text AS effective_to, notes
        `, [base, target, rate, date, effectiveTo, userId, notes || null]);

    await logAction(userId, ACTIONS.SYSTEM_CONFIG_CHANGED, MODULES.SYSTEM, {
        ipAddress,
        recordType:  'currency_exchange_rates',
        recordId:    result.rows[0].id,
        newValues:   result.rows[0],
        description: `Exchange rate set to ${rate} effective ${date}${effectiveTo ? ` until ${effectiveTo}` : ''} — source: ${SOURCE_LABEL[source]}${sourceDetail ? ` (${sourceDetail})` : ''}`,
        client,
    });

    // A person typed a rate: any BoU suggestion for this pair and date
    // that is still waiting is closed — the hand-entered rate is kept.
    if (source === 'MANUAL' && hasSource) {
        await client.query(`
            UPDATE fx_rate_suggestions
            SET    status = 'KEPT_MANUAL', decided_by = $4, decided_at = NOW(),
                   decision_note = 'A rate was entered by hand for this date — the hand-entered rate is kept.'
            WHERE  status = 'PENDING' AND rate_date = $3
            AND    ((base_currency_id = $1 AND target_currency_id = $2) OR (base_currency_id = $2 AND target_currency_id = $1))
        `, [base, target, date, userId]);
    }

    // Re-value what this rate affects (open months only).
    const fx = await fxService.recomputeFunctionalAmounts(client, { fromDate: date });
    fx.realisedTransfers = await recomputeTransferFx(client, date);
    return { ...result.rows[0], fx };
};

const describeRevaluation = (row) => {
    let message = '';
    if (row.effective_to) message += ` until ${row.effective_to}`;
    message += `. ${row.fx.recalculated} transaction(s) re-valued in UGX`;
    if (row.fx.keptInClosedMonths > 0) {
        message += `; ${row.fx.keptInClosedMonths} transaction(s) in months already closed (through ${row.fx.lastRevaluedPeriodEnd}) kept their existing values`;
    }
    if (row.fx.stillMissing > 0) message += `; ${row.fx.stillMissing} transaction(s) still have no rate`;
    return message;
};

module.exports = { setRate, rateStartingOn, recomputeTransferFx, describeRevaluation, SOURCE_LABEL };
