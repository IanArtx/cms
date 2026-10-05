// ============================================================
// CAPITAL GOAL FUNDS — goal money on its way into an investment (v1.78.0)
//
// Requested directly: "secondary goals can be tailored towards a
// proposed investments and money collected can already be invested
// into that investment it is attached to".
// Confirmed: the money goes through a selected operational account (a
// normal transfer, with an exchange rate when the currencies differ),
// then into the investment — never more than the goal collected.
//
// Nothing here moves money by itself. The two steps are the system's
// ordinary, approved operations, marked with the goal:
//   1. a TRANSFER (Primary → operational account) with
//      transfers.capital_goal_id — started by a Director, approved by
//      the Treasurer as every transfer is; the exchange rate is the
//      transfer's own;
//   2. an INVESTMENT FUNDING from the investment's own (operational)
//      funding account with investment_funding.capital_goal_id — held
//      for approval unless Treasurer/Admin, as every funding is.
//
// THE GOAL'S MONEY, ACCOUNT BY ACCOUNT (each in that account's currency):
//   + collected  pledge payments the Treasurer approved into it
//   − sent       goal transfers out of it (posted or still awaiting
//                approval — waiting ones are reserved so the same money
//                can't be moved twice) and their sending bank charges
//   + received   goal transfers into it that are POSTED, less the
//                receiving bank charge
//   − invested   goal fundings from it that were not reversed
//   = available  what the goal may still move / invest from that account
// Rejected and reversed transfers, and reversed fundings, count for nothing.
//
// The checks (assertTransferAllowed / assertFundingAllowed) lock the
// goal row (SELECT … FOR UPDATE), so two people moving the same goal
// money at the same moment are handled one after the other.
// ============================================================

const { createError } = require('../utils/errors');
const { getExchangeRateOn } = require('./sharePricingService');

const round = (n, dp = 2) => Math.round((Number(n) + Number.EPSILON) * 10 ** dp) / 10 ** dp;
const num = (v) => (v === null || v === undefined ? 0 : parseFloat(v));
const LIVE_TRANSFER = ['PENDING', 'AWAITING_APPROVAL', 'APPROVED', 'POSTED'];

const columnsReady = async (client) => {
    const r = await client.query(`
        SELECT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_schema = 'public' AND table_name = 'transfers' AND column_name = 'capital_goal_id') AS ok`);
    return !!r.rows[0].ok;
};

const loadGoal = async (client, goalId, { lock = false } = {}) => {
    const r = await client.query(`
        SELECT g.id, g.title, g.goal_type, g.status, g.currency_id, g.investment_id,
               gc.code AS currency_code, rr.reference_code
        FROM   capital_goals g
        JOIN   currencies gc ON gc.id = g.currency_id
        JOIN   references_registry rr ON rr.id = g.reference_id
        WHERE  g.id = $1 ${lock ? 'FOR UPDATE OF g' : ''}
    `, [goalId]);
    if (!r.rows.length) throw createError.notFound('Capital goal not found');
    return r.rows[0];
};

const loadInvestment = async (client, investmentId) => {
    if (!investmentId) return null;
    const r = await client.query(`
        SELECT i.id, i.name, i.status, i.funding_account_id, i.currency_id, i.planned_budget,
               i.actual_expenditure, i.investment_type,
               a.name AS funding_account_name, a.account_type AS funding_account_type,
               c.code AS currency_code, rr.reference_code,
               (SELECT COUNT(*)::int FROM investment_funding f WHERE f.investment_id = i.id AND NOT f.is_reversed) AS funding_count
        FROM   investments i
        JOIN   accounts a   ON a.id = i.funding_account_id
        JOIN   currencies c ON c.id = i.currency_id
        JOIN   references_registry rr ON rr.id = i.reference_id
        WHERE  i.id = $1
    `, [investmentId]);
    return r.rows[0] || null;
};

// Value of 1 unit of `fromCurrencyId` in the goal's currency on a date
// (1 for the same currency; null if no rate is known).
const toGoalRate = async (client, fromCurrencyId, goalCurrencyId, date) => {
    if (fromCurrencyId === goalCurrencyId) return 1;
    try { return await getExchangeRateOn(client, fromCurrencyId, goalCurrencyId, date); } catch (_) { return null; }
};

// ------------------------------------------------------------
// The full picture for one goal.
// ------------------------------------------------------------
const computeGoalFunds = async (client, goalId, { lock = false } = {}) => {
    const goal = await loadGoal(client, goalId, { lock });
    const investment = await loadInvestment(client, goal.investment_id);
    const ready = await columnsReady(client);

    const accounts = new Map();
    const acc = (row) => {
        if (!accounts.has(row.account_id)) {
            accounts.set(row.account_id, {
                account_id: row.account_id, account_name: row.account_name, account_type: row.account_type,
                currency_id: row.currency_id, currency_code: row.currency_code,
                collected: 0, sent: 0, sending: 0, received: 0, invested: 0,
                // goal-currency value of the money that came into this account
                inflow_amount: 0, inflow_goal_value: 0,
            });
        }
        return accounts.get(row.account_id);
    };

    // + collected (pledge payments approved into each account)
    const collected = await client.query(`
        SELECT pp.account_id, a.name AS account_name, a.account_type, a.currency_id, c.code AS currency_code,
               SUM(pp.amount) AS amount, SUM(pp.converted_amount_goal_currency) AS goal_value
        FROM   capital_goal_pledge_payments pp
        JOIN   capital_goal_pledges p        ON p.id = pp.pledge_id
        JOIN   capital_goal_monthly_calls mc ON mc.id = p.monthly_call_id
        JOIN   accounts a   ON a.id = pp.account_id
        JOIN   currencies c ON c.id = a.currency_id
        WHERE  mc.capital_goal_id = $1
        GROUP  BY pp.account_id, a.name, a.account_type, a.currency_id, c.code
    `, [goalId]);
    for (const row of collected.rows) {
        const a = acc(row);
        a.collected += num(row.amount);
        a.inflow_amount += num(row.amount);
        a.inflow_goal_value += num(row.goal_value);
    }

    let transfers = [];
    let fundings = [];
    if (ready) {
        transfers = (await client.query(`
            SELECT t.id, t.status, t.value_date::text AS value_date, t.created_at, t.description,
                   t.from_account_id, fa.name AS from_account_name, fa.account_type AS from_account_type,
                   t.to_account_id, ta.name AS to_account_name, ta.account_type AS to_account_type,
                   t.amount_sent, t.currency_sent_id, sc.code AS currency_sent_code,
                   t.amount_received, t.currency_received_id, rc.code AS currency_received_code,
                   t.exchange_rate, t.sending_bank_charge, t.receiving_bank_charge,
                   rr.reference_code, u.first_name || ' ' || u.last_name AS created_by_name
            FROM   transfers t
            JOIN   accounts fa ON fa.id = t.from_account_id
            JOIN   accounts ta ON ta.id = t.to_account_id
            JOIN   currencies sc ON sc.id = t.currency_sent_id
            JOIN   currencies rc ON rc.id = t.currency_received_id
            JOIN   references_registry rr ON rr.id = t.reference_id
            JOIN   users u ON u.id = t.created_by
            WHERE  t.capital_goal_id = $1
            ORDER  BY t.value_date, t.id
        `, [goalId])).rows;

        fundings = (await client.query(`
            SELECT f.id, f.amount, f.is_reversed, f.created_at, f.transaction_id,
                   t.value_date::text AS value_date, rr.reference_code,
                   i.id AS investment_id, i.name AS investment_name, i.funding_account_id,
                   a.name AS account_name, a.account_type, a.currency_id, c.code AS currency_code,
                   u.first_name || ' ' || u.last_name AS created_by_name
            FROM   investment_funding f
            JOIN   investments i ON i.id = f.investment_id
            JOIN   transactions t ON t.id = f.transaction_id
            JOIN   references_registry rr ON rr.id = t.reference_id
            JOIN   accounts a ON a.id = i.funding_account_id
            JOIN   currencies c ON c.id = a.currency_id
            JOIN   users u ON u.id = f.created_by
            WHERE  f.capital_goal_id = $1
            ORDER  BY t.value_date, f.id
        `, [goalId])).rows;
    }

    let moving = 0;   // goal currency, transfers awaiting approval
    let moved = 0;    // goal currency, posted transfers
    for (const t of transfers) {
        const live = LIVE_TRANSFER.includes(t.status);
        const rate = await toGoalRate(client, t.currency_sent_id, goal.currency_id, t.value_date);
        t.goal_value = rate === null ? null : round(num(t.amount_sent) * rate);
        if (!live) continue;
        const from = acc({ account_id: t.from_account_id, account_name: t.from_account_name, account_type: t.from_account_type, currency_id: t.currency_sent_id, currency_code: t.currency_sent_code });
        from.sent += num(t.amount_sent) + num(t.sending_bank_charge);
        if (t.status === 'POSTED') {
            moved += t.goal_value || 0;
            const to = acc({ account_id: t.to_account_id, account_name: t.to_account_name, account_type: t.to_account_type, currency_id: t.currency_received_id, currency_code: t.currency_received_code });
            const net = num(t.amount_received) - num(t.receiving_bank_charge);
            to.received += net;
            to.inflow_amount += net;
            to.inflow_goal_value += t.goal_value || 0;
        } else {
            moving += t.goal_value || 0;
            from.sending += num(t.amount_sent);
        }
    }

    for (const f of fundings) {
        if (f.is_reversed) continue;
        const a = acc({ account_id: f.funding_account_id, account_name: f.account_name, account_type: f.account_type, currency_id: f.currency_id, currency_code: f.currency_code });
        a.invested += num(f.amount);
    }

    const list = [...accounts.values()].map(a => {
        const available = round(a.collected - a.sent + a.received - a.invested, 4);
        const unit = a.inflow_amount > 0 ? a.inflow_goal_value / a.inflow_amount : null; // goal value of 1 unit here
        return {
            ...a,
            collected: round(a.collected), sent: round(a.sent), sending: round(a.sending),
            received: round(a.received), invested: round(a.invested),
            available: round(available),
            available_goal_value: unit === null ? null : round(available * unit),
            invested_goal_value: unit === null ? null : round(a.invested * unit),
            goal_value_per_unit: unit,
        };
    });

    const totalCollected = round(collected.rows.reduce((s, r) => s + num(r.goal_value), 0));
    const investedGoal = round(list.reduce((s, a) => s + (a.invested_goal_value || 0), 0));
    const fundingAccount = investment ? list.find(a => a.account_id === investment.funding_account_id) : null;
    const availableToMove = round(list.filter(a => !investment || a.account_id !== investment.funding_account_id)
        .reduce((s, a) => s + Math.max(0, a.available_goal_value || 0), 0));

    return {
        goal, investment,
        accounts: list,
        transfers, fundings,
        totals: {
            currency_code: goal.currency_code,
            collected: totalCollected,
            moving: round(moving),
            moved: round(moved),
            invested_goal_value: investedGoal,
            invested: fundingAccount ? fundingAccount.invested : 0,
            invested_currency_code: investment ? investment.currency_code : null,
            available_to_move: availableToMove,
            available_to_invest: fundingAccount ? Math.max(0, fundingAccount.available) : 0,
            available_to_invest_goal_value: fundingAccount ? Math.max(0, fundingAccount.available_goal_value || 0) : 0,
        },
        ready,
    };
};

const assertGoalCanFund = (goal, investment) => {
    if (goal.goal_type !== 'SECONDARY' || !goal.investment_id || !investment) {
        throw createError.badRequest(`${goal.reference_code} is not tied to an investment — only a secondary goal tied to one can move money this way.`);
    }
    if (goal.status === 'CANCELLED') throw createError.badRequest('This goal is cancelled.');
    if (['CANCELLED', 'COMPLETED', 'TERMINATED', 'PENDING_TERMINATION'].includes(investment.status)) {
        throw createError.badRequest(`The investment ${investment.reference_code} is ${investment.status.toLowerCase().replace('_', ' ')} — it can't receive goal money.`);
    }
};

// Called from initiateTransfer (inside its database transaction) when
// the transfer carries capital_goal_id. Returns the investment, after
// moving a not-yet-funded proposal onto the chosen account if needed.
const assertTransferAllowed = async (client, { goalId, fromAccountId, toAccountId, amountSent, sendingCharge = 0, excludeTransferId = null }) => {
    if (!(await columnsReady(client))) {
        throw createError.badRequest('Moving goal money needs the v1.78.0 database update (migration_v1.78.0.sql).');
    }
    const funds = await computeGoalFunds(client, goalId, { lock: true });
    const { goal, investment } = funds;
    assertGoalCanFund(goal, investment);

    const from = funds.accounts.find(a => a.account_id === Number(fromAccountId));
    let available = from ? from.available : 0;
    if (excludeTransferId) {
        const t = funds.transfers.find(x => x.id === Number(excludeTransferId));
        if (t && LIVE_TRANSFER.includes(t.status) && t.from_account_id === Number(fromAccountId)) {
            available += num(t.amount_sent) + num(t.sending_bank_charge);
        }
    }
    const needed = num(amountSent) + num(sendingCharge);
    if (needed > available + 0.0001) {
        throw createError.badRequest(
            `${goal.reference_code} has only ${round(available).toLocaleString('en-US')} ${from ? from.currency_code : ''} of collected money left in that account` +
            ` (money already moved or waiting to be moved is set aside). You asked to move ${needed.toLocaleString('en-US')}.`);
    }

    // The money has to arrive where the investment is paid from.
    if (Number(toAccountId) !== investment.funding_account_id) {
        if (investment.status === 'PENDING' && investment.funding_count === 0) {
            const acct = await client.query(`SELECT id, account_type, currency_id, name FROM accounts WHERE id = $1 AND is_active = TRUE`, [toAccountId]);
            if (!acct.rows.length || acct.rows[0].account_type !== 'SECONDARY') {
                throw createError.badRequest('Goal money for an investment must go to an operational (secondary) account.');
            }
            await client.query(`
                UPDATE investments SET funding_account_id = $1, returns_account_id = $1, currency_id = $2 WHERE id = $3
            `, [acct.rows[0].id, acct.rows[0].currency_id, investment.id]);
            investment.funding_account_id = acct.rows[0].id;
            investment.funding_account_name = acct.rows[0].name;
            investment.switched_account = true;
        } else {
            throw createError.badRequest(
                `${investment.reference_code} is paid from ${investment.funding_account_name} — move the goal money to that account.`);
        }
    }
    return { goal, investment };
};

// Called from fundInvestment when the funding carries capital_goal_id.
const assertFundingAllowed = async (client, { goalId, investmentId, amount }) => {
    if (!(await columnsReady(client))) {
        throw createError.badRequest('Investing goal money needs the v1.78.0 database update (migration_v1.78.0.sql).');
    }
    const funds = await computeGoalFunds(client, goalId, { lock: true });
    const { goal, investment } = funds;
    assertGoalCanFund(goal, investment);
    if (investment.id !== Number(investmentId)) {
        throw createError.badRequest(`${goal.reference_code} is tied to ${investment.reference_code}, not to this investment.`);
    }
    const available = funds.totals.available_to_invest;
    if (num(amount) > available + 0.0001) {
        throw createError.badRequest(
            `Only ${round(available).toLocaleString('en-US')} ${investment.currency_code} of ${goal.reference_code}'s money has reached ${investment.funding_account_name}` +
            ' and not been invested yet. Move more of the collected money first (approved transfers only).');
    }
    return { goal, investment };
};

module.exports = { computeGoalFunds, assertTransferAllowed, assertFundingAllowed, loadInvestment, columnsReady };
