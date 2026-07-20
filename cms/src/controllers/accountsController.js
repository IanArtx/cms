// ============================================================
// ACCOUNTS CONTROLLER
// Handles: viewing accounts, creating secondary accounts,
// managing the primary account floor limit, and account balances.
//
// RULES ENFORCED HERE:
//   - Only one primary account and only one SAVINGS account can
//     exist (both enforced by DB unique indexes)
//   - Any account can have a floor limit (v1.14.0) except SAVINGS,
//     which is permanently exempt and may sit at zero at any time
//   - Floor limit changes are never overwritten — history kept
//   - Secondary accounts can be added freely by Admin
// ============================================================

const { query, withTransaction } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess, sendCreated, getPagination, sendPaginated } = require('../utils/response');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');

// ============================================================
// DERIVE A REFERENCE PREFIX FROM AN ACCOUNT NAME
// Used when the admin doesn't supply one explicitly. Strips to
// letters/digits, uppercases, and takes the first 6 characters —
// then, if that collides with an existing account's prefix,
// appends a digit until it's unique (checked by the caller, which
// already holds the row lock inside its own transaction).
// ============================================================
const deriveReferencePrefix = async (client, name) => {
    const clean = (name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    let base = clean.slice(0, 6);
    if (!base) return null;

    let candidate = base;
    let suffix = 1;
    while (true) {
        const existing = await client.query(
            'SELECT id FROM accounts WHERE reference_prefix = $1',
            [candidate]
        );
        if (existing.rows.length === 0) return candidate;
        suffix += 1;
        candidate = `${base.slice(0, 6 - String(suffix).length)}${suffix}`;
        if (suffix > 20) return null; // give up — generic SA prefix will be used
    }
};

// ============================================================
// GET ALL ACCOUNTS
// GET /api/accounts
// Returns all accounts with their current balances.
// Visible to: Treasurer, Directors, Admin
// ============================================================
const getAllAccounts = asyncHandler(async (req, res) => {
    const result = await query(`
        SELECT
            a.id,
            a.account_type,
            a.name,
            a.description,
            -- "current_balance" here is the GENERAL balance shown to users —
            -- an active side fund's allocation is deliberately excluded from
            -- it (v1.14.0). The true ledger total (what postTransaction and
            -- the account's own transaction list use) is never changed —
            -- this is a display-only split. See side_fund_allocation below.
            a.current_balance - COALESCE(sfc.current_balance, 0) AS current_balance,
            COALESCE(sfc.current_balance, 0) AS side_fund_allocation,
            a.current_balance AS ledger_balance,
            a.is_active,
            a.created_at,
            a.reference_prefix,
            a.is_virtual,
            a.bank_name,
            a.bank_branch,
            a.bank_account_number,
            a.swift_routing_code,
            c.code   AS currency_code,
            c.name   AS currency_name,
            c.symbol AS currency_symbol,
            (
                SELECT fl.floor_amount
                FROM   primary_account_floor_limits fl
                WHERE  fl.account_id = a.id
                AND    fl.effective_to IS NULL
                ORDER  BY fl.effective_from DESC
                LIMIT  1
            ) AS current_floor_limit,
            u.first_name || ' ' || u.last_name AS created_by_name
        FROM  accounts a
        JOIN  currencies c ON c.id = a.currency_id
        LEFT JOIN users u  ON u.id = a.created_by
        LEFT JOIN side_fund_config sfc
               ON sfc.parent_account_id = a.id AND sfc.is_active = TRUE
        ORDER BY a.account_type DESC, a.created_at ASC
    `);

    sendSuccess(res, result.rows);
});

// ============================================================
// GET SINGLE ACCOUNT WITH FULL DETAILS
// GET /api/accounts/:id
// ============================================================
const getAccountById = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const result = await query(`
        SELECT
            a.id,
            a.account_type,
            a.name,
            a.description,
            -- see getAllAccounts for why current_balance excludes an
            -- active side fund's allocation (display-only split)
            a.current_balance - COALESCE(sfc.current_balance, 0) AS current_balance,
            COALESCE(sfc.current_balance, 0) AS side_fund_allocation,
            a.current_balance AS ledger_balance,
            a.is_active,
            a.created_at,
            a.reference_prefix,
            a.is_virtual,
            a.bank_name,
            a.bank_branch,
            a.bank_account_number,
            a.swift_routing_code,
            c.code   AS currency_code,
            c.name   AS currency_name,
            c.symbol AS currency_symbol,
            u.first_name || ' ' || u.last_name AS created_by_name,
            (
                SELECT json_agg(fl_data ORDER BY fl_data.effective_from DESC)
                FROM (
                    SELECT
                        fl.id,
                        fl.floor_amount,
                        fl.effective_from,
                        fl.effective_to,
                        fl.notes,
                        setter.first_name || ' ' || setter.last_name AS set_by_name
                    FROM primary_account_floor_limits fl
                    JOIN users setter ON setter.id = fl.set_by
                    WHERE fl.account_id = a.id
                ) fl_data
            ) AS floor_limit_history
        FROM  accounts a
        JOIN  currencies c ON c.id = a.currency_id
        LEFT JOIN users u  ON u.id = a.created_by
        LEFT JOIN side_fund_config sfc
               ON sfc.parent_account_id = a.id AND sfc.is_active = TRUE
        WHERE a.id = $1
    `, [id]);

    if (result.rows.length === 0) {
        throw createError.notFound('Account not found');
    }

    sendSuccess(res, result.rows[0]);
});

// ============================================================
// CREATE SECONDARY ACCOUNT
// POST /api/accounts
// ============================================================
const createSecondaryAccount = asyncHandler(async (req, res) => {
    const {
        name, currency_id, description, reference_prefix,
        is_virtual, bank_name, bank_branch, bank_account_number, swift_routing_code,
    } = req.body;

    await withTransaction(async (client) => {
        const currency = await client.query(
            'SELECT id, code, name FROM currencies WHERE id = $1 AND is_active = TRUE',
            [currency_id]
        );
        if (currency.rows.length === 0) {
            throw createError.badRequest('Currency not found or inactive');
        }

        const isVirtual = !!is_virtual;
        if (!isVirtual && (!bank_name || !bank_account_number)) {
            throw createError.badRequest(
                'Bank name and account number are required unless this is marked as a virtual account'
            );
        }

        // Resolve the reference prefix: use what the admin typed (validated
        // and uppercased), or auto-derive one from the account name if left
        // blank. Either way this is optional — if it ends up null, the
        // account's transactions just use the generic 'SA' module prefix.
        let resolvedPrefix = null;
        if (reference_prefix && reference_prefix.trim()) {
            resolvedPrefix = reference_prefix.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
            if (!resolvedPrefix) {
                throw createError.badRequest('Reference prefix must contain letters or numbers');
            }
            const dup = await client.query(
                'SELECT id FROM accounts WHERE reference_prefix = $1',
                [resolvedPrefix]
            );
            if (dup.rows.length > 0) {
                throw createError.conflict(`Reference prefix '${resolvedPrefix}' is already in use by another account`);
            }
        } else {
            resolvedPrefix = await deriveReferencePrefix(client, name);
        }

        const result = await client.query(`
            INSERT INTO accounts
                (account_type, name, currency_id, description, current_balance, created_by, reference_prefix,
                 is_virtual, bank_name, bank_branch, bank_account_number, swift_routing_code)
            VALUES
                ('SECONDARY', $1, $2, $3, 0, $4, $5, $6, $7, $8, $9, $10)
            RETURNING *
        `, [
            name.trim(), currency_id, description || null, req.user.id, resolvedPrefix,
            isVirtual, isVirtual ? null : bank_name.trim(),
            bank_branch ? bank_branch.trim() : null,
            isVirtual ? null : bank_account_number.trim(),
            swift_routing_code ? swift_routing_code.trim() : null,
        ]);

        const newAccount = result.rows[0];

        await logAction(req.user.id, ACTIONS.SYSTEM_CONFIG_CHANGED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'accounts',
            recordId:    newAccount.id,
            newValues:   {
                name, currency_id, account_type: 'SECONDARY', reference_prefix: resolvedPrefix,
                is_virtual: isVirtual, bank_name: newAccount.bank_name,
            },
            description: `Secondary account created: ${name} (${currency.rows[0].code})` +
                         (resolvedPrefix ? ` — reference prefix ${resolvedPrefix}` : '') +
                         (isVirtual ? ' — virtual account' : ` — ${newAccount.bank_name}`),
            client,
        });

        sendCreated(res, {
            id:                  newAccount.id,
            account_type:        newAccount.account_type,
            name:                newAccount.name,
            currency:            currency.rows[0],
            balance:             newAccount.current_balance,
            reference_prefix:    newAccount.reference_prefix,
            is_virtual:          newAccount.is_virtual,
            bank_name:           newAccount.bank_name,
            bank_branch:         newAccount.bank_branch,
            bank_account_number: newAccount.bank_account_number,
            swift_routing_code:  newAccount.swift_routing_code,
        }, `Secondary account '${name}' created successfully`);
    });
});

// ============================================================
// UPDATE ACCOUNT (name, description, reference prefix)
// PATCH /api/accounts/:id
// Admin only. Does not allow changing account_type or currency —
// those are foundational and would break existing transaction
// history if changed after the fact.
// ============================================================
const updateAccount = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const {
        name, description, reference_prefix,
        is_virtual, bank_name, bank_branch, bank_account_number, swift_routing_code,
    } = req.body;

    await withTransaction(async (client) => {
        const existing = await client.query(
            'SELECT * FROM accounts WHERE id = $1',
            [id]
        );
        if (existing.rows.length === 0) {
            throw createError.notFound('Account not found');
        }
        const before = existing.rows[0];

        let resolvedPrefix = before.reference_prefix;
        if (reference_prefix !== undefined) {
            if (reference_prefix === null || reference_prefix.trim() === '') {
                resolvedPrefix = null;
            } else {
                resolvedPrefix = reference_prefix.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
                if (!resolvedPrefix) {
                    throw createError.badRequest('Reference prefix must contain letters or numbers');
                }
                const dup = await client.query(
                    'SELECT id FROM accounts WHERE reference_prefix = $1 AND id != $2',
                    [resolvedPrefix, id]
                );
                if (dup.rows.length > 0) {
                    throw createError.conflict(`Reference prefix '${resolvedPrefix}' is already in use by another account`);
                }
            }
        }

        // Bank details — same rule as creation: required unless virtual.
        // Only re-validated when the caller is actually touching either
        // is_virtual or one of the bank fields, so a plain rename doesn't
        // require resending the bank details.
        const resolvedIsVirtual = is_virtual !== undefined ? !!is_virtual : before.is_virtual;
        const touchingBankFields = is_virtual !== undefined || bank_name !== undefined ||
            bank_branch !== undefined || bank_account_number !== undefined || swift_routing_code !== undefined;
        const resolvedBankName    = bank_name !== undefined ? bank_name : before.bank_name;
        const resolvedBankBranch  = bank_branch !== undefined ? bank_branch : before.bank_branch;
        const resolvedBankAccount = bank_account_number !== undefined ? bank_account_number : before.bank_account_number;
        const resolvedSwift       = swift_routing_code !== undefined ? swift_routing_code : before.swift_routing_code;

        if (touchingBankFields && !resolvedIsVirtual && (!resolvedBankName || !resolvedBankAccount)) {
            throw createError.badRequest(
                'Bank name and account number are required unless this is marked as a virtual account'
            );
        }

        const result = await client.query(`
            UPDATE accounts
            SET    name                 = COALESCE($1, name),
                   description          = CASE WHEN $2::text IS NOT NULL THEN $2 ELSE description END,
                   reference_prefix     = $3,
                   is_virtual           = $4,
                   bank_name            = CASE WHEN $4 THEN NULL ELSE $5 END,
                   bank_branch          = $6,
                   bank_account_number  = CASE WHEN $4 THEN NULL ELSE $7 END,
                   swift_routing_code   = $8
            WHERE  id = $9
            RETURNING *
        `, [
            name?.trim() || null,
            description !== undefined ? description : null,
            resolvedPrefix,
            resolvedIsVirtual,
            resolvedBankName ? resolvedBankName.trim() : null,
            resolvedBankBranch ? resolvedBankBranch.trim() : null,
            resolvedBankAccount ? resolvedBankAccount.trim() : null,
            resolvedSwift ? resolvedSwift.trim() : null,
            id,
        ]);

        const updated = result.rows[0];

        await logAction(req.user.id, ACTIONS.SYSTEM_CONFIG_CHANGED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'accounts',
            recordId:    updated.id,
            oldValues:   { name: before.name, reference_prefix: before.reference_prefix, is_virtual: before.is_virtual },
            newValues:   { name: updated.name, reference_prefix: updated.reference_prefix, is_virtual: updated.is_virtual },
            description: `Account '${updated.name}' updated`,
            client,
        });

        sendSuccess(res, updated, `Account '${updated.name}' updated successfully`);
    });
});

// ============================================================
// CREATE PRIMARY ACCOUNT (one-time setup)
// POST /api/accounts/primary
// ============================================================
const createPrimaryAccount = asyncHandler(async (req, res) => {
    const {
        name, description, floor_amount,
        is_virtual, bank_name, bank_branch, bank_account_number, swift_routing_code,
    } = req.body;

    await withTransaction(async (client) => {
        const existing = await client.query(
            `SELECT id FROM accounts WHERE account_type = 'PRIMARY' AND is_active = TRUE`
        );
        if (existing.rows.length > 0) {
            throw createError.conflict(
                'A primary account already exists. Only one primary account is allowed.'
            );
        }

        const isVirtual = !!is_virtual;
        if (!isVirtual && (!bank_name || !bank_account_number)) {
            throw createError.badRequest(
                'Bank name and account number are required unless this is marked as a virtual account'
            );
        }

        const eurResult = await client.query(
            `SELECT id FROM currencies WHERE code = 'EUR' AND is_active = TRUE`
        );
        if (eurResult.rows.length === 0) {
            throw createError.internal('EUR currency not found. Please check seed data.');
        }
        const eurId = eurResult.rows[0].id;

        const accountResult = await client.query(`
            INSERT INTO accounts
                (account_type, name, currency_id, description, current_balance, created_by,
                 is_virtual, bank_name, bank_branch, bank_account_number, swift_routing_code)
            VALUES
                ('PRIMARY', $1, $2, $3, 0, $4, $5, $6, $7, $8, $9)
            RETURNING *
        `, [
            name.trim(), eurId, description || null, req.user.id,
            isVirtual, isVirtual ? null : bank_name.trim(),
            bank_branch ? bank_branch.trim() : null,
            isVirtual ? null : bank_account_number.trim(),
            swift_routing_code ? swift_routing_code.trim() : null,
        ]);

        const newAccount = accountResult.rows[0];

        if (floor_amount && floor_amount > 0) {
            await client.query(`
                INSERT INTO primary_account_floor_limits
                    (account_id, floor_amount, effective_from, set_by, notes)
                VALUES
                    ($1, $2, CURRENT_DATE, $3, $4)
            `, [
                newAccount.id,
                floor_amount,
                req.user.id,
                'Initial floor limit set at account creation',
            ]);
        }

        await logAction(req.user.id, ACTIONS.SYSTEM_CONFIG_CHANGED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'accounts',
            recordId:    newAccount.id,
            newValues:   { name, account_type: 'PRIMARY', floor_amount },
            description: `Primary account created: ${name}`,
            client,
        });

        sendCreated(res, {
            id:           newAccount.id,
            account_type: newAccount.account_type,
            name:         newAccount.name,
            currency:     'EUR',
            balance:      newAccount.current_balance,
            floor_limit:  floor_amount || 0,
        }, 'Primary account created successfully');
    });
});

// ============================================================
// CREATE SAVINGS ACCOUNT (one-time setup)
// POST /api/accounts/savings
// This is the single dedicated account every member savings
// transaction (deposits, handouts, and the non-member "pool inflow")
// is posted against instead of Primary. Same settings as any other
// account (currency, bank details/virtual flag) except it:
//   - can never take part in a transfer (transfersController only
//     ever allows PRIMARY<->SECONDARY legs, so this is automatic)
//   - is permanently exempt from floor limits (enforced in
//     updateFloorLimit / postTransaction)
//   - only ever receives CREDIT postings, never an expense
// Only one may exist at a time (idx_one_savings_account).
// ============================================================
const createSavingsAccount = asyncHandler(async (req, res) => {
    const {
        name, currency_id, description,
        is_virtual, bank_name, bank_branch, bank_account_number, swift_routing_code,
    } = req.body;

    await withTransaction(async (client) => {
        const existing = await client.query(
            `SELECT id FROM accounts WHERE account_type = 'SAVINGS' AND is_active = TRUE`
        );
        if (existing.rows.length > 0) {
            throw createError.conflict(
                'A savings account already exists. Only one savings account is allowed.'
            );
        }

        const currency = await client.query(
            'SELECT id, code, name FROM currencies WHERE id = $1 AND is_active = TRUE',
            [currency_id]
        );
        if (currency.rows.length === 0) {
            throw createError.badRequest('Currency not found or inactive');
        }

        const isVirtual = !!is_virtual;
        if (!isVirtual && (!bank_name || !bank_account_number)) {
            throw createError.badRequest(
                'Bank name and account number are required unless this is marked as a virtual account'
            );
        }

        const accountResult = await client.query(`
            INSERT INTO accounts
                (account_type, name, currency_id, description, current_balance, created_by,
                 is_virtual, bank_name, bank_branch, bank_account_number, swift_routing_code)
            VALUES
                ('SAVINGS', $1, $2, $3, 0, $4, $5, $6, $7, $8, $9)
            RETURNING *
        `, [
            name.trim(), currency_id, description || null, req.user.id,
            isVirtual, isVirtual ? null : bank_name.trim(),
            bank_branch ? bank_branch.trim() : null,
            isVirtual ? null : bank_account_number.trim(),
            swift_routing_code ? swift_routing_code.trim() : null,
        ]);

        const newAccount = accountResult.rows[0];

        await logAction(req.user.id, ACTIONS.SAVINGS_ACCOUNT_CREATED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'accounts',
            recordId:    newAccount.id,
            newValues:   { name, account_type: 'SAVINGS', currency_id },
            description: `Savings account created: ${name} (${currency.rows[0].code})`,
            client,
        });

        sendCreated(res, {
            id:           newAccount.id,
            account_type: newAccount.account_type,
            name:         newAccount.name,
            currency:     currency.rows[0],
            balance:      newAccount.current_balance,
            is_virtual:   newAccount.is_virtual,
            bank_name:    newAccount.bank_name,
        }, 'Savings account created successfully');
    });
});

// ============================================================
// UPDATE FLOOR LIMIT
// POST /api/accounts/:id/floor-limit
// ============================================================
const updateFloorLimit = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { floor_amount, notes, effective_from } = req.body;

    await withTransaction(async (client) => {
        const account = await client.query(
            `SELECT id, account_type, name FROM accounts WHERE id = $1 AND is_active = TRUE`,
            [id]
        );
        if (account.rows.length === 0) {
            throw createError.notFound('Account not found');
        }
        if (account.rows[0].account_type === 'SAVINGS') {
            throw createError.badRequest(
                'The SAVINGS account is always exempt from floor limits — it must be allowed to sit at zero at any time'
            );
        }

        const currentLimit = await client.query(`
            SELECT id, floor_amount, effective_from
            FROM   primary_account_floor_limits
            WHERE  account_id = $1
            AND    effective_to IS NULL
            ORDER  BY effective_from DESC
            LIMIT  1
        `, [id]);

        if (currentLimit.rows.length > 0) {
            const lastChange = new Date(currentLimit.rows[0].effective_from);
            const sixMonthsAgo = new Date();
            sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

            if (lastChange > sixMonthsAgo) {
                const nextAllowed = new Date(lastChange);
                nextAllowed.setMonth(nextAllowed.getMonth() + 6);
                throw createError.badRequest(
                    `Floor limit was last changed on ${lastChange.toDateString()}. ` +
                    `Next change allowed from ${nextAllowed.toDateString()}.`
                );
            }

            await client.query(`
                UPDATE primary_account_floor_limits
                SET    effective_to = $1
                WHERE  id = $2
            `, [effective_from || new Date().toISOString().split('T')[0], currentLimit.rows[0].id]);
        }

        await client.query(`
            INSERT INTO primary_account_floor_limits
                (account_id, floor_amount, effective_from, set_by, notes)
            VALUES
                ($1, $2, $3, $4, $5)
        `, [
            id,
            floor_amount,
            effective_from || new Date().toISOString().split('T')[0],
            req.user.id,
            notes || null,
        ]);

        await logAction(req.user.id, ACTIONS.FLOOR_LIMIT_UPDATED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'primary_account_floor_limits',
            recordId:    parseInt(id),
            oldValues:   currentLimit.rows[0] || null,
            newValues:   { floor_amount, effective_from },
            description: `Floor limit updated to ${floor_amount} EUR`,
            client,
        });

        sendSuccess(res, { floor_amount }, 'Floor limit updated successfully');
    });
});

// ============================================================
// GET ACCOUNT BALANCE SUMMARY
// GET /api/accounts/summary
// ============================================================
const getAccountSummary = asyncHandler(async (req, res) => {
    const result = await query(`
        SELECT
            a.id,
            a.account_type,
            a.name,
            -- General balance shown on the Dashboard etc. — an active side
            -- fund's allocation is excluded (display-only; the real ledger
            -- total is untouched). See side_fund_allocation, shown as its
            -- own figure so the Dashboard can display it separately.
            a.current_balance - COALESCE(sfc.current_balance, 0) AS current_balance,
            COALESCE(sfc.current_balance, 0) AS side_fund_allocation,
            c.code   AS currency_code,
            c.symbol AS currency_symbol,
            -- Floor limits (v1.14.0): any account can have one except
            -- SAVINGS, which is always exempt. "Available" is computed
            -- against the general (side-fund-excluded) balance, since
            -- side fund money is already earmarked and shouldn't read as
            -- spendable headroom.
            CASE
                WHEN a.account_type != 'SAVINGS' THEN
                    (a.current_balance - COALESCE(sfc.current_balance, 0)) - COALESCE((
                        SELECT fl.floor_amount
                        FROM   primary_account_floor_limits fl
                        WHERE  fl.account_id = a.id
                        AND    fl.effective_to IS NULL
                        LIMIT  1
                    ), 0)
                ELSE
                    a.current_balance - COALESCE(sfc.current_balance, 0)
            END AS available_balance,
            CASE
                WHEN a.account_type != 'SAVINGS' THEN (
                    SELECT fl.floor_amount
                    FROM   primary_account_floor_limits fl
                    WHERE  fl.account_id = a.id
                    AND    fl.effective_to IS NULL
                    LIMIT  1
                )
                ELSE NULL
            END AS floor_limit
        FROM  accounts a
        JOIN  currencies c ON c.id = a.currency_id
        LEFT JOIN side_fund_config sfc
               ON sfc.parent_account_id = a.id AND sfc.is_active = TRUE
        WHERE a.is_active = TRUE
        ORDER BY a.account_type DESC, a.name ASC
    `);

    sendSuccess(res, result.rows);
});

// ============================================================
// GET ALL CURRENCIES
// GET /api/accounts/currencies
// ============================================================
const getCurrencies = asyncHandler(async (req, res) => {
    const result = await query(
        `SELECT id, code, name, symbol FROM currencies WHERE is_active = TRUE ORDER BY code`
    );
    sendSuccess(res, result.rows);
});

// ============================================================
// ADD NEW CURRENCY (Admin only)
// POST /api/accounts/currencies
// ============================================================
const addCurrency = asyncHandler(async (req, res) => {
    const { code, name, symbol } = req.body;

    const result = await query(`
        INSERT INTO currencies (code, name, symbol, created_by)
        VALUES ($1, $2, $3, $4)
        RETURNING *
    `, [code.toUpperCase().trim(), name.trim(), symbol?.trim() || null, req.user.id]);

    sendCreated(res, result.rows[0], `Currency ${code.toUpperCase()} added successfully`);
});

// ============================================================
// UPDATE CURRENCY (Admin only)
// PATCH /api/accounts/currencies/:id
// Lets an existing currency's code/name/symbol be corrected, or
// be deactivated/reactivated. Existing accounts keep referencing
// the same currency_id, so nothing downstream breaks.
// ============================================================
const updateCurrency = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { code, name, symbol, is_active } = req.body;

    await withTransaction(async (client) => {
        const existing = await client.query(
            'SELECT * FROM currencies WHERE id = $1',
            [id]
        );
        if (existing.rows.length === 0) {
            throw createError.notFound('Currency not found');
        }
        const before = existing.rows[0];

        if (code) {
            const dup = await client.query(
                'SELECT id FROM currencies WHERE code = $1 AND id != $2',
                [code.toUpperCase().trim(), id]
            );
            if (dup.rows.length > 0) {
                throw createError.conflict(`Currency code ${code.toUpperCase()} is already in use`);
            }
        }

        const newCode     = code   !== undefined ? code.toUpperCase().trim() : before.code;
        const newName     = name   !== undefined ? name.trim()               : before.name;
        const newSymbol   = symbol !== undefined ? (symbol?.trim() || null)  : before.symbol;
        const newIsActive = is_active !== undefined ? is_active              : before.is_active;

        const result = await client.query(`
            UPDATE currencies
            SET code = $1, name = $2, symbol = $3, is_active = $4
            WHERE id = $5
            RETURNING *
        `, [newCode, newName, newSymbol, newIsActive, id]);

        const updated = result.rows[0];

        await logAction(req.user.id, ACTIONS.SYSTEM_CONFIG_CHANGED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'currencies',
            recordId:    updated.id,
            oldValues:   { code: before.code, name: before.name, symbol: before.symbol, is_active: before.is_active },
            newValues:   { code: updated.code, name: updated.name, symbol: updated.symbol, is_active: updated.is_active },
            description: `Currency ${before.code} updated`,
            client,
        });

        sendSuccess(res, updated, `Currency ${updated.code} updated successfully`);
    });
});

module.exports = {
    getAllAccounts,
    getAccountById,
    createSecondaryAccount,
    updateAccount,
    createPrimaryAccount,
    createSavingsAccount,
    updateFloorLimit,
    getAccountSummary,
    getCurrencies,
    addCurrency,
    updateCurrency,
};