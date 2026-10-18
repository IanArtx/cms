// ============================================================
// DAILY BANK OF UGANDA RATES (v1.83.0)
//
// Requested: "make an api that reads fx rates and fills in the
// necessary ones in the update FX rate field everyday from the BOU
// website" — "keep a person in the loop … name the source but also not
// to override hand entered input".
//
// What happens every weekday (scheduler: BouExchangeRates, 10:15,
// 13:15 and 16:15 Kampala time — BoU usually publishes its opening
// rates around 09:50; the later runs catch a late file):
//   1. Read BoU's OPENING RATES workbook (bouRatesService). If that
//      fails and the backup key is set, read AllRatesToday instead.
//      When both work, the other one is a cross-check.
//   2. For every active currency of the company (not the books'
//      own currency, UGX), make ONE suggestion for that date:
//        • nothing if a suggestion for that date already exists;
//        • a rate already entered for that date is never touched —
//          the suggestion is recorded as "hand-entered rate kept" so
//          the Treasurer can still compare;
//        • dates covered by a fixed-rate company decision are skipped;
//        • flagged when it moved more than the jump limit (3 %) from
//          the rate on file, when the cross-check disagrees by more
//          than 0.5 %, or when the file is more than 5 days old.
//   3. The Treasurer, Assistant Treasurer and Admins are told; they
//      approve (the rate then enters the rate table with its source
//      named) or reject. Nothing enters the books by itself.
//   4. If no source can be read, they are told the same day (once).
// Every run is logged in fx_feed_runs (Money › Accounts › BoU rates).
// ============================================================

const { query, withTransaction } = require('../config/database');
const { createError } = require('../utils/errors');
const logger = require('../config/logger');
const fxService = require('./fxService');
const bou = require('./bouRatesService');
const exchangeRateService = require('./exchangeRateService');
const { logAction, ACTIONS, MODULES } = require('./auditService');

const CROSS_CHECK_LIMIT_PCT = 0.5;
const STALE_DAYS = 5;
const SOURCE_NAME = { BOU: 'Bank of Uganda', ALLRATESTODAY: 'AllRatesToday (BoU table)' };

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const emailHtml = async (body) => {
    const { wrapEmail } = require('./emailTemplates');
    return wrapEmail(`<p style="margin:0 0 12px 0;">Hello {{NAME}},</p>${body}`, { preheader: 'Exchange rates — Bank of Uganda' });
};
const fmtRate = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

const getFeedSettings = async () => {
    const r = await query(`
        SELECT cs.functional_currency_id, fc.code AS functional_code,
               COALESCE((to_jsonb(cs)->>'fx_feed_enabled')::boolean, TRUE) AS enabled,
               COALESCE((to_jsonb(cs)->>'fx_feed_jump_limit_pct')::numeric, 3) AS jump_limit_pct,
               COALESCE((to_jsonb(cs)->>'fx_transfer_warn_pct')::numeric, 3) AS transfer_warn_pct
        FROM   company_settings cs
        LEFT JOIN currencies fc ON fc.id = cs.functional_currency_id
        WHERE  cs.id = 1
    `);
    const s = r.rows[0] || {};
    return {
        functionalCurrencyId: s.functional_currency_id || null,
        functionalCode: s.functional_code || null,
        enabled: s.enabled !== false,
        jumpLimitPct: parseFloat(s.jump_limit_pct || 3),
        transferWarnPct: parseFloat(s.transfer_warn_pct || 3),
        backupConfigured: bou.allRatesConfigured(),
    };
};

const treasuryRecipients = async () => {
    const r = await query(`
        SELECT DISTINCT u.id, u.email, u.first_name, u.last_name
        FROM   users u
        JOIN   user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
        JOIN   roles r       ON r.id = ur.role_id AND r.is_active = TRUE
        WHERE  r.name IN ('Treasurer', 'Assistant Treasurer', 'Admin') AND u.is_active = TRUE
    `);
    return r.rows;
};

const logRun = async ({ trigger, runBy = null, status, sourceUsed = null, rateDate = null, suggestions = 0, message, details = {} }) => {
    const r = await query(`
        INSERT INTO fx_feed_runs (trigger, run_by, status, source_used, rate_date, suggestions, message, details)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, run_at
    `, [trigger, runBy, status, sourceUsed, rateDate, suggestions, message, JSON.stringify(details)]);
    return r.rows[0];
};

// ============================================================
// RUN — read the sources and make the day's suggestions.
// ============================================================
const runFeed = async ({ trigger = 'SCHEDULE', userId = null } = {}) => {
    const settings = await getFeedSettings();
    if (!settings.enabled && trigger === 'SCHEDULE') {
        const message = 'The daily BoU rate check is switched off (Settings › Currencies).';
        await logRun({ trigger, status: 'SWITCHED_OFF', message });
        return { status: 'SWITCHED_OFF', message, suggestions: [] };
    }
    if (settings.functionalCode !== 'UGX') {
        const message = `Bank of Uganda publishes rates against the Uganda shilling; the books are kept in ${settings.functionalCode || '(not set)'}, so nothing was suggested.`;
        await logRun({ trigger, runBy: userId, status: 'FAILED', message });
        return { status: 'FAILED', message, suggestions: [] };
    }

    // ---- 1. read the sources ----
    let primary = null; let other = null;
    const errors = {};
    try { primary = await bou.fetchBouOpeningRates(); } catch (err) { errors.BOU = err.message; }
    if (settings.backupConfigured) {
        try {
            const a = await bou.fetchAllRatesToday();
            if (primary) other = a; else primary = a;
        } catch (err) { errors.ALLRATESTODAY = err.message; }
    }
    if (!primary) {
        const why = (e) => String(e || 'not tried').replace(/[.\s]+$/, '');
        const message = `The exchange rates could not be read today. Bank of Uganda: ${why(errors.BOU)}`
            + (settings.backupConfigured ? `. AllRatesToday: ${why(errors.ALLRATESTODAY)}` : ' (no backup source set)')
            + '. Enter today\'s rate by hand under Money › Accounts › Set Rate if it is needed.';
        // Tell the Treasury once a day, not at every retry.
        const already = await query(`
            SELECT 1 FROM fx_feed_runs
            WHERE  status = 'FAILED' AND run_at >= date_trunc('day', NOW() AT TIME ZONE 'Africa/Kampala') AT TIME ZONE 'Africa/Kampala'
            LIMIT 1
        `);
        await logRun({ trigger, runBy: userId, status: 'FAILED', message, details: { errors } });
        if (already.rows.length === 0 && trigger === 'SCHEDULE') {
            const { notifyMany } = require('./notificationService');
            const recipients = await treasuryRecipients();
            const html = await emailHtml(`<p style="margin:0 0 12px 0;">${esc(message)}</p>`);
            await notifyMany(recipients, 'FX_FEED_FAILED', (u) => ({
                title: 'Today\'s Bank of Uganda rates could not be read',
                body: message,
                link: '/accounts?fx=bou',
                module: 'FINANCE',
                email: { subject: 'Bank of Uganda rates could not be read today', html: html.replace('{{NAME}}', esc(u.first_name)) },
            })).catch(() => {});
        }
        return { status: 'FAILED', message, errors, suggestions: [] };
    }

    // ---- 2. make the suggestions ----
    const rateDate = primary.rateDate;
    const today = fxService.todayStr();
    if (rateDate > fxService.toDateStr(new Date(Date.now() + 2 * 86400000))) {
        const message = `The ${SOURCE_NAME[primary.source]} file is dated ${rateDate}, in the future — not used.`;
        await logRun({ trigger, runBy: userId, status: 'FAILED', sourceUsed: primary.source, rateDate, message });
        return { status: 'FAILED', message, suggestions: [] };
    }
    const stale = daysBetween(rateDate, today) > STALE_DAYS;

    const currencies = (await query(`
        SELECT id, code FROM currencies WHERE is_active = TRUE AND id <> $1 ORDER BY code
    `, [settings.functionalCurrencyId])).rows;
    const hasRateSource = await fxService.rateSourceColumnExists();

    const made = [];
    const skipped = [];
    for (const c of currencies) {
        const found = primary.rates[c.code];
        if (!found || !(found.middle > 0)) { skipped.push({ code: c.code, why: `not in the ${SOURCE_NAME[primary.source]} table` }); continue; }

        const exists = await query(`
            SELECT id FROM fx_rate_suggestions
            WHERE  rate_date = $1 AND base_currency_id = $2 AND target_currency_id = $3
        `, [rateDate, c.id, settings.functionalCurrencyId]);
        if (exists.rows.length) { skipped.push({ code: c.code, why: 'already suggested for this date' }); continue; }

        const fixedRule = await fxService.fixedRateRuleFor(c.id, settings.functionalCurrencyId, rateDate);
        if (fixedRule) { skipped.push({ code: c.code, why: `fixed by company decision (${fxService.describeFixedRule(fixedRule)})` }); continue; }

        const middle = Math.round(found.middle * 1e6) / 1e6;
        const prev = await query('SELECT fx_rate_on($1, $2, $3::date) AS rate', [c.id, settings.functionalCurrencyId, rateDate]);
        const previous = prev.rows[0].rate !== null ? parseFloat(prev.rows[0].rate) : null;
        const changePct = previous ? ((middle - previous) / previous) * 100 : null;

        const flags = [];
        if (changePct !== null && Math.abs(changePct) > settings.jumpLimitPct) {
            flags.push(`${changePct > 0 ? 'up' : 'down'} ${Math.abs(changePct).toFixed(2)} % from the rate on file (${fmtRate(previous)}) — more than the ${settings.jumpLimitPct} % limit`);
        }
        let crossCheck = null;
        if (other && other.rateDate === rateDate && other.rates[c.code]?.middle > 0) {
            crossCheck = Math.round(other.rates[c.code].middle * 1e6) / 1e6;
            const gap = Math.abs((crossCheck - middle) / middle) * 100;
            if (gap > CROSS_CHECK_LIMIT_PCT) flags.push(`${SOURCE_NAME[other.source]} says ${fmtRate(crossCheck)} — ${gap.toFixed(2)} % different`);
        }
        if (stale) flags.push(`the published table is dated ${rateDate}, ${daysBetween(rateDate, today)} days ago`);

        // A rate already starting on that date (a hand-entered one above
        // all) is never replaced — the suggestion is only recorded.
        let status = 'PENDING';
        let note = null;
        if (hasRateSource) {
            const r = await query(`
                SELECT id, rate, source FROM currency_exchange_rates
                WHERE  effective_from = $3
                AND    ((base_currency_id = $1 AND target_currency_id = $2) OR (base_currency_id = $2 AND target_currency_id = $1))
                LIMIT 1
            `, [c.id, settings.functionalCurrencyId, rateDate]);
            if (r.rows.length) {
                status = 'KEPT_MANUAL';
                note = `A rate (${r.rows[0].rate}, ${exchangeRateService.SOURCE_LABEL[r.rows[0].source] || r.rows[0].source}) was already on file for this date — kept, nothing changed.`;
            }
        }

        const detail = primary.source === 'BOU'
            ? `BoU ${primary.kind ? primary.kind.toLowerCase() : 'opening'} rates for ${rateDate}, middle rate${primary.fileUpdatedAt ? ` (file published ${String(primary.fileUpdatedAt).replace('T', ' ').slice(0, 16)} UTC)` : ''}`
            : `AllRatesToday copy of the BoU table for ${rateDate}, reference (middle) rate`;
        const ins = await query(`
            INSERT INTO fx_rate_suggestions
                (rate_date, base_currency_id, target_currency_id, rate, buying_rate, selling_rate, source, source_detail,
                 cross_check_rate, previous_rate, change_pct, flagged, flag_reason, status, decision_note, decided_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::varchar, $15, CASE WHEN $14::varchar = 'PENDING' THEN NULL ELSE NOW() END)
            ON CONFLICT (rate_date, base_currency_id, target_currency_id) DO NOTHING
            RETURNING id
        `, [rateDate, c.id, settings.functionalCurrencyId, middle, found.buying, found.selling, primary.source, detail,
            crossCheck, previous, changePct !== null ? Math.round(changePct * 10000) / 10000 : null,
            flags.length > 0, flags.length ? flags.join('; ') : null, status, note]);
        if (ins.rows.length) made.push({ id: ins.rows[0].id, code: c.code, rate: middle, changePct, flagged: flags.length > 0, status });
    }

    const pending = made.filter(m => m.status === 'PENDING');
    const runStatus = pending.length ? 'NEW_SUGGESTIONS' : 'NOTHING_NEW';
    const message = pending.length
        ? `${SOURCE_NAME[primary.source]} rates for ${rateDate}: ${pending.map(m => `${m.code} ${fmtRate(m.rate)}${m.flagged ? ' (flagged)' : ''}`).join(', ')} — waiting for approval.`
        : `Nothing new from ${SOURCE_NAME[primary.source]} (table for ${rateDate}).`;
    await logRun({
        trigger, runBy: userId, status: runStatus, sourceUsed: primary.source, rateDate, suggestions: pending.length,
        message, details: { made, skipped, errors, crossCheck: other ? other.source : null, fileUrl: primary.fileUrl || null },
    });

    if (pending.length) {
        const { notifyMany } = require('./notificationService');
        const recipients = await treasuryRecipients();
        const lines = pending.map(m => `${m.code} ${fmtRate(m.rate)}${m.changePct !== null ? ` (${m.changePct >= 0 ? '+' : ''}${m.changePct.toFixed(2)} %)` : ''}${m.flagged ? ' — please check' : ''}`);
        const html = await emailHtml(
            `<p style="margin:0 0 12px 0;">${esc(SOURCE_NAME[primary.source])} has published its rates for <strong>${esc(rateDate)}</strong>. They are waiting for your approval — nothing enters the books until someone approves them:</p>`
            + `<ul style="margin:0 0 12px 18px; padding:0;">${lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>`
            + '<p style="margin:0 0 12px 0;">Approve or reject them under Money › Accounts › Bank of Uganda daily rates. Rates already entered by hand are never replaced.</p>'
        );
        await notifyMany(recipients, 'FX_RATES_TO_APPROVE', (u) => ({
            title: `Exchange rates for ${rateDate} ready to approve`,
            body: `${SOURCE_NAME[primary.source]}: ${lines.join(', ')}. Approve or reject under Money › Accounts.`,
            link: '/accounts?fx=bou',
            module: 'FINANCE',
            email: { subject: `Exchange rates for ${rateDate} ready to approve`, html: html.replace('{{NAME}}', esc(u.first_name)) },
        })).catch(() => {});
    }
    logger.info(`BoU rates: ${message}`);
    return { status: runStatus, rateDate, source: primary.source, message, suggestions: made, skipped, errors };
};

// ============================================================
// SUGGESTIONS — list, approve, reject
// ============================================================
const listSuggestions = async ({ status = 'PENDING', limit = 60 } = {}) => {
    const params = [];
    let where = '';
    if (status && status !== 'ALL') { params.push(status); where = `WHERE s.status = $${params.length}`; }
    params.push(Math.min(parseInt(limit, 10) || 60, 200));
    const r = await query(`
        SELECT s.id, s.rate_date::text AS rate_date, s.rate, s.buying_rate, s.selling_rate, s.source, s.source_detail,
               s.cross_check_rate, s.previous_rate, s.change_pct, s.flagged, s.flag_reason, s.status,
               s.decision_note, s.decided_at, s.approved_rate_id, s.created_at,
               s.base_currency_id, bc.code AS base_currency_code, s.target_currency_id, tc.code AS target_currency_code,
               u.first_name || ' ' || u.last_name AS decided_by_name
        FROM   fx_rate_suggestions s
        JOIN   currencies bc ON bc.id = s.base_currency_id
        JOIN   currencies tc ON tc.id = s.target_currency_id
        LEFT JOIN users u ON u.id = s.decided_by
        ${where}
        ORDER  BY s.rate_date DESC, bc.code
        LIMIT  $${params.length}
    `, params);
    return r.rows;
};

const approveSuggestion = async ({ id, userId, confirmFlagged = false, ipAddress = null }) => {
    return withTransaction(async (client) => {
        const r = await client.query('SELECT * FROM fx_rate_suggestions WHERE id = $1 FOR UPDATE', [id]);
        const s = r.rows[0];
        if (!s) throw createError.notFound('Suggestion not found');
        if (s.status !== 'PENDING') throw createError.conflict(`This suggestion is already ${s.status.toLowerCase().replace('_', ' ')}.`);
        if (s.flagged && !confirmFlagged) {
            throw createError.badRequest(`Please check this rate first: ${s.flag_reason}. Tick "I have checked this rate" to approve it.`);
        }
        const rateDate = fxService.toDateStr(s.rate_date);
        const existing = await exchangeRateService.rateStartingOn(client, s.base_currency_id, s.target_currency_id, rateDate);
        if (existing) {
            await client.query(`
                UPDATE fx_rate_suggestions SET status = 'KEPT_MANUAL', decided_by = $2, decided_at = NOW(),
                       decision_note = $3 WHERE id = $1
            `, [id, userId, `A rate (${existing.rate}) was already on file for ${rateDate} — kept, nothing changed.`]);
            return { kept: true, message: `A rate (${existing.rate}) is already on file for ${rateDate}; it was kept and the suggestion closed.` };
        }
        const row = await exchangeRateService.setRate(client, {
            baseCurrencyId: s.base_currency_id, targetCurrencyId: s.target_currency_id, rate: s.rate,
            effectiveDate: rateDate, userId, ipAddress,
            notes: `${SOURCE_NAME[s.source]} middle rate for ${rateDate}${s.buying_rate ? ` (buying ${fmtRate(s.buying_rate)}, selling ${fmtRate(s.selling_rate)})` : ''}`,
            source: s.source, sourceDetail: s.source_detail, suggestionId: s.id,
        });
        await client.query(`
            UPDATE fx_rate_suggestions SET status = 'APPROVED', decided_by = $2, decided_at = NOW(), approved_rate_id = $3,
                   decision_note = $4 WHERE id = $1
        `, [id, userId, row.id, s.flagged ? `Approved after checking: ${s.flag_reason}` : null]);
        return { kept: false, rate: row, message: `Rate ${fmtRate(s.rate)} for ${rateDate} approved${exchangeRateService.describeRevaluation(row)}.` };
    });
};

const rejectSuggestion = async ({ id, userId, reason, ipAddress = null }) => {
    if (!reason || String(reason).trim().length < 3) throw createError.badRequest('Say why the rate is rejected.');
    const r = await query(`
        UPDATE fx_rate_suggestions SET status = 'REJECTED', decided_by = $2, decided_at = NOW(), decision_note = $3
        WHERE  id = $1 AND status = 'PENDING'
        RETURNING id, rate_date::text AS rate_date, rate
    `, [id, userId, String(reason).trim().slice(0, 500)]);
    if (!r.rows.length) throw createError.conflict('This suggestion is no longer waiting.');
    await logAction(userId, ACTIONS.SYSTEM_CONFIG_CHANGED, MODULES.SYSTEM, {
        ipAddress, recordType: 'fx_rate_suggestions', recordId: id,
        description: `Suggested exchange rate ${r.rows[0].rate} for ${r.rows[0].rate_date} rejected: ${reason}`,
    }).catch(() => {});
    return r.rows[0];
};

const feedStatus = async () => {
    const settings = await getFeedSettings();
    const runs = await query(`
        SELECT f.id, f.run_at, f.trigger, f.status, f.source_used, f.rate_date::text AS rate_date, f.suggestions, f.message,
               u.first_name || ' ' || u.last_name AS run_by_name
        FROM   fx_feed_runs f LEFT JOIN users u ON u.id = f.run_by
        ORDER  BY f.run_at DESC LIMIT 10
    `);
    const pending = await query(`SELECT COUNT(*)::int AS n FROM fx_rate_suggestions WHERE status = 'PENDING'`);
    return { settings, runs: runs.rows, pendingCount: pending.rows[0].n, schedule: process.env.BOU_RATES_CRON ? `custom (${process.env.BOU_RATES_CRON})` : 'Monday to Friday at 10:15, 13:15 and 16:15 (Kampala time)' };
};

const updateFeedSettings = async ({ enabled, jumpLimitPct, transferWarnPct, userId }) => {
    const sets = []; const params = [];
    if (enabled !== undefined) { params.push(!!enabled); sets.push(`fx_feed_enabled = $${params.length}`); }
    if (jumpLimitPct !== undefined) {
        const v = parseFloat(jumpLimitPct);
        if (!(v > 0 && v <= 50)) throw createError.badRequest('The jump limit must be between 0 and 50 %.');
        params.push(v); sets.push(`fx_feed_jump_limit_pct = $${params.length}`);
    }
    if (transferWarnPct !== undefined) {
        const v = parseFloat(transferWarnPct);
        if (!(v > 0 && v <= 50)) throw createError.badRequest('The transfer warning limit must be between 0 and 50 %.');
        params.push(v); sets.push(`fx_transfer_warn_pct = $${params.length}`);
    }
    if (!sets.length) return getFeedSettings();
    await query(`UPDATE company_settings SET ${sets.join(', ')} WHERE id = 1`, params);
    await logAction(userId, ACTIONS.SYSTEM_CONFIG_CHANGED, MODULES.SYSTEM, {
        recordType: 'company_settings', recordId: 1,
        description: `Daily BoU rate settings changed: ${JSON.stringify({ enabled, jumpLimitPct, transferWarnPct })}`,
    }).catch(() => {});
    return getFeedSettings();
};

// ============================================================
// The reference rate on a date (transfer form comparison).
// ============================================================
const referenceRate = async ({ fromCurrencyId, toCurrencyId, date }) => {
    const d = fxService.toDateStr(date) || fxService.todayStr();
    const r = await query('SELECT fx_rate_on($1, $2, $3::date) AS rate', [fromCurrencyId, toCurrencyId, d]);
    const rate = r.rows[0].rate !== null ? parseFloat(r.rows[0].rate) : null;
    if (rate === null) return { date: d, rate: null };
    // Which stored row it came from (either direction).
    const hasSource = await fxService.rateSourceColumnExists();
    const row = await query(`
        SELECT cer.rate, cer.base_currency_id, cer.effective_from::text AS effective_from,
               ${hasSource ? 'cer.source, cer.source_detail,' : `'MANUAL' AS source, NULL AS source_detail,`}
               u.first_name || ' ' || u.last_name AS set_by_name
        FROM   currency_exchange_rates cer JOIN users u ON u.id = cer.set_by
        WHERE  ((cer.base_currency_id = $1 AND cer.target_currency_id = $2) OR (cer.base_currency_id = $2 AND cer.target_currency_id = $1))
        AND    cer.effective_from <= $3 AND (cer.effective_to IS NULL OR cer.effective_to > $3)
        ORDER  BY (cer.base_currency_id = $1) DESC, cer.effective_from DESC, cer.id DESC LIMIT 1
    `, [fromCurrencyId, toCurrencyId, d]);
    const settings = await getFeedSettings();
    return {
        date: d, rate,
        source: row.rows[0]?.source || 'MANUAL',
        sourceLabel: exchangeRateService.SOURCE_LABEL[row.rows[0]?.source || 'MANUAL'],
        sourceDetail: row.rows[0]?.source_detail || null,
        effectiveFrom: row.rows[0]?.effective_from || null,
        setByName: row.rows[0]?.set_by_name || null,
        warnPct: settings.transferWarnPct,
    };
};

// ============================================================
// TRANSFER CHECK (v1.83.0) — the bank's rate against the rate on file.
// The bank's rate is what the books use; this only makes sure a big
// gap (typing slip, rate entered the wrong way round, a poor bank deal)
// is looked at before the transfer is saved. Returns what to store on
// the transfer. Throws when the gap is above the limit and the person
// has not ticked "I have checked the bank's rate".
// ============================================================
const checkTransferRate = async (client, { fromCurrencyId, toCurrencyId, rate, date, amountSent, confirmed }) => {
    const none = { reference_rate: null, reference_rate_source: null, rate_gap_pct: null, needsConfirm: false };
    if (!fromCurrencyId || !toCurrencyId || fromCurrencyId === toCurrencyId || !(parseFloat(rate) > 0)) return none;
    const d = fxService.toDateStr(date) || fxService.todayStr();
    const r = await client.query('SELECT fx_rate_on($1, $2, $3::date) AS rate', [fromCurrencyId, toCurrencyId, d]);
    if (r.rows[0].rate === null) return none;
    const ref = parseFloat(r.rows[0].rate);
    const hasSource = await fxService.rateSourceColumnExists(client);
    const src = hasSource ? await client.query(`
        SELECT source FROM currency_exchange_rates
        WHERE  ((base_currency_id = $1 AND target_currency_id = $2) OR (base_currency_id = $2 AND target_currency_id = $1))
        AND    effective_from <= $3 AND (effective_to IS NULL OR effective_to > $3)
        ORDER  BY (base_currency_id = $1) DESC, effective_from DESC, id DESC LIMIT 1
    `, [fromCurrencyId, toCurrencyId, d]) : { rows: [] };
    const source = src.rows[0]?.source || 'MANUAL';
    const gapPct = ((parseFloat(rate) - ref) / ref) * 100;
    const settings = await getFeedSettings();
    const needsConfirm = Math.abs(gapPct) > settings.transferWarnPct;
    if (needsConfirm && !confirmed) {
        const cur = await client.query('SELECT id, code FROM currencies WHERE id = ANY($1)', [[fromCurrencyId, toCurrencyId]]);
        const code = Object.fromEntries(cur.rows.map(x => [x.id, x.code]));
        const diff = parseFloat(amountSent || 0) * (parseFloat(rate) - ref);
        throw createError.badRequest(
            `The bank's rate (${fmtRate(rate)}) is ${Math.abs(gapPct).toFixed(2)} % ${gapPct < 0 ? 'below' : 'above'} the rate on file for ${d} ` +
            `(${fmtRate(ref)}, ${exchangeRateService.SOURCE_LABEL[source] || source})` +
            (amountSent ? ` — about ${code[toCurrencyId] || ''} ${Math.abs(diff).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${diff < 0 ? 'less' : 'more'} than at that rate` : '') +
            `. Check the rate (and that it is "${code[toCurrencyId]} per 1 ${code[fromCurrencyId]}"), then tick "I have checked the bank's rate" to save it.`,
            { code: 'RATE_GAP_NOT_CONFIRMED', reference_rate: ref, reference_source: source, gap_pct: Math.round(gapPct * 10000) / 10000, warn_pct: settings.transferWarnPct }
        );
    }
    return { reference_rate: ref, reference_rate_source: source, rate_gap_pct: Math.round(gapPct * 10000) / 10000, needsConfirm };
};

// Store the check on the transfer (columns exist from v1.83.0).
const recordTransferRateCheck = async (client, transferId, check, userId) => {
    const col = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'transfers' AND column_name = 'rate_gap_pct'`);
    if (!col.rows.length) return;
    await client.query(`
        UPDATE transfers
        SET    reference_rate = $2, reference_rate_source = $3, rate_gap_pct = $4,
               rate_gap_confirmed_by = CASE WHEN $5 THEN $6::int ELSE NULL END,
               rate_gap_confirmed_at = CASE WHEN $5 THEN NOW() ELSE NULL END
        WHERE  id = $1
    `, [transferId, check.reference_rate, check.reference_rate_source, check.rate_gap_pct, !!check.needsConfirm, userId]);
};

module.exports = {
    runFeed, listSuggestions, approveSuggestion, rejectSuggestion, feedStatus, updateFeedSettings,
    referenceRate, getFeedSettings, SOURCE_NAME, checkTransferRate, recordTransferRateCheck,
};
