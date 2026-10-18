// ============================================================
// PROJECTS CONTROLLER (v1.85.0)
// Requested: "Projects can stand independently or with in or added
// later to an investment. From the proposal to other related documents
// can be directly uploaded on the project or investment page."
//
// A project is one of:
//   • ON ITS OWN        investment_id empty. Money spent on it is recorded
//                       with Record Expense (project chosen) — an ordinary
//                       expense in the books, listed in project_spending.
//   • INSIDE AN         investment_id set. Money for it is investment
//     INVESTMENT        funding with the project chosen (investment_funding
//                       .project_id) — capital of that investment.
//   • ADDED LATER       an "on its own" project moved under an investment
//                       (linked_to_investment_at / linked_by). What was
//                       spent before stays an expense (closed months and
//                       posted entries are never rewritten); from then on
//                       money goes through the investment.
//
// Spending always = investment funding for it (not reversed)
//                 + expenses recorded for it while on its own (not reversed).
// projects.actual_expenditure is kept equal to that; every project read
// also recomputes it from the records and shows a warning if they differ.
//
// Routes: src/routes/projects.js (prefix /api/projects). The older
// /api/investments/:id/projects… routes still work.
// ============================================================

const { query, withTransaction } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess, sendCreated } = require('../utils/response');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');
const { generateReference, linkReferenceToRecord, MODULE_CODES } = require('../services/referenceService');
const { getOrCreateCategory } = require('../services/categoryService');

const STATUSES = ['PENDING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED'];
const CLOSED = ['COMPLETED', 'CANCELLED'];
// investments a project may be added to
const LINKABLE_INVESTMENT = ['PENDING', 'ACTIVE', 'ON_HOLD', 'PENDING_TERMINATION'];

const round2 = (n) => Math.round((parseFloat(n || 0) + Number.EPSILON) * 100) / 100;
const todayStr = () => new Date().toISOString().slice(0, 10);
const A = (k, fallback) => ACTIONS[k] || fallback;

// ------------------------------------------------------------
// Spending of one or more projects, from the records
// ------------------------------------------------------------
const SPENT_SQL = `
    COALESCE((SELECT SUM(f.amount) FROM investment_funding f
              WHERE f.project_id = p.id AND COALESCE(f.is_reversed, FALSE) = FALSE), 0)
  + COALESCE((SELECT SUM(s.amount) FROM project_spending s
              WHERE s.project_id = p.id AND s.is_reversed = FALSE), 0)`;

const loadProject = async (db, id, { lock = false } = {}) => {
    const r = await db.query(`
        SELECT p.*, p.start_date::text AS start_date, p.expected_end_date::text AS expected_end_date,
               p.actual_end_date::text AS actual_end_date, r.reference_code, c.code AS currency_code
        FROM   projects p
        JOIN   references_registry r ON r.id = p.reference_id
        LEFT JOIN currencies c ON c.id = p.currency_id
        WHERE  p.id = $1 ${lock ? 'FOR UPDATE OF p' : ''}`, [id]);
    if (!r.rows.length) throw createError.notFound('Project not found');
    return r.rows[0];
};

const loadInvestmentForProject = async (db, investmentId) => {
    const r = await db.query(`
        SELECT i.id, i.name, i.status, a.currency_id, c.code AS currency_code, ir.reference_code
        FROM   investments i
        JOIN   accounts a ON a.id = i.funding_account_id
        JOIN   currencies c ON c.id = a.currency_id
        JOIN   references_registry ir ON ir.id = i.reference_id
        WHERE  i.id = $1`, [investmentId]);
    if (!r.rows.length) throw createError.notFound('Investment not found');
    return r.rows[0];
};

const defaultCategory = (client, userId) => getOrCreateCategory(client, {
    module: 'INVESTMENT', name: 'Projects', abbreviation: 'PRJ',
    description: 'Projects — on their own or inside an investment (v1.85.0)', createdBy: userId,
});

const assertCategory = async (db, categoryId) => {
    const r = await db.query('SELECT id FROM categories WHERE id = $1 AND is_active = TRUE', [categoryId]);
    if (!r.rows.length) throw createError.badRequest('Choose a valid category.');
};

const assertUser = async (db, userId) => {
    if (!userId) return;
    const r = await db.query('SELECT id FROM users WHERE id = $1', [userId]);
    if (!r.rows.length) throw createError.badRequest('The responsible person was not found.');
};

const checkDates = (start, end) => {
    if (start && end && String(end) < String(start)) {
        throw createError.badRequest('The expected end date cannot be before the start date.');
    }
};

// ============================================================
// LIST — GET /api/projects?status=&investment_id=&standalone=1&search=
// ============================================================
const listProjects = asyncHandler(async (req, res) => {
    const cond = [];
    const params = [];
    const { status, investment_id, standalone, search } = req.query;
    if (status && STATUSES.includes(status)) { params.push(status); cond.push(`p.status = $${params.length}`); }
    if (standalone === '1' || standalone === 'true') cond.push('p.investment_id IS NULL');
    else if (investment_id && /^\d+$/.test(String(investment_id))) { params.push(parseInt(investment_id, 10)); cond.push(`p.investment_id = $${params.length}`); }
    if (search && String(search).trim()) {
        params.push(`%${String(search).trim()}%`);
        cond.push(`(p.name ILIKE $${params.length} OR r.reference_code ILIKE $${params.length})`);
    }
    const r = await query(`
        SELECT p.id, p.name, p.status, p.planned_budget, p.actual_expenditure,
               (${SPENT_SQL}) AS spent,
               p.start_date::text AS start_date, p.expected_end_date::text AS expected_end_date,
               p.actual_end_date::text AS actual_end_date, p.created_at,
               p.investment_id, i.name AS investment_name, ir.reference_code AS investment_reference,
               r.reference_code, c.code AS currency_code, cp.full_path AS category_trail,
               ru.first_name || ' ' || ru.last_name AS responsible_name,
               (SELECT COUNT(*) FROM project_milestones m WHERE m.project_id = p.id)::int AS total_milestones,
               (SELECT COUNT(*) FROM project_milestones m WHERE m.project_id = p.id AND m.status = 'COMPLETED')::int AS completed_milestones,
               (SELECT COUNT(*) FROM documents d WHERE d.related_record_type = 'projects' AND d.related_record_id = p.id
                    AND d.status NOT IN ('DELETED', 'SUPERSEDED'))::int AS document_count
        FROM   projects p
        JOIN   references_registry r ON r.id = p.reference_id
        LEFT JOIN currencies c ON c.id = p.currency_id
        LEFT JOIN category_paths cp ON cp.category_id = p.category_id
        LEFT JOIN investments i ON i.id = p.investment_id
        LEFT JOIN references_registry ir ON ir.id = i.reference_id
        LEFT JOIN users ru ON ru.id = p.responsible_user_id
        ${cond.length ? `WHERE ${cond.join(' AND ')}` : ''}
        ORDER  BY CASE WHEN p.status IN ('COMPLETED', 'CANCELLED') THEN 1 ELSE 0 END, p.created_at DESC
        LIMIT  500`, params);
    const rows = r.rows.map(x => ({ ...x, mismatch: round2(x.spent) !== round2(x.actual_expenditure) }));
    sendSuccess(res, rows);
});

// ============================================================
// OPTIONS for forms — GET /api/projects/options?standalone=1&currency_id=
// Open projects (not completed / cancelled).
// ============================================================
const projectOptions = asyncHandler(async (req, res) => {
    const params = [];
    const cond = [`p.status NOT IN ('COMPLETED', 'CANCELLED')`];
    if (req.query.standalone === '1') cond.push('p.investment_id IS NULL');
    if (req.query.currency_id && /^\d+$/.test(String(req.query.currency_id))) {
        params.push(parseInt(req.query.currency_id, 10)); cond.push(`p.currency_id = $${params.length}`);
    }
    const r = await query(`
        SELECT p.id, p.name, r.reference_code, p.investment_id, p.currency_id, c.code AS currency_code, p.status
        FROM   projects p
        JOIN   references_registry r ON r.id = p.reference_id
        LEFT JOIN currencies c ON c.id = p.currency_id
        WHERE  ${cond.join(' AND ')}
        ORDER  BY p.name`, params);
    sendSuccess(res, r.rows);
});

// ============================================================
// ONE PROJECT — GET /api/projects/:id
// ============================================================
const getProject = asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const r = await query(`
        SELECT p.*, p.start_date::text AS start_date, p.expected_end_date::text AS expected_end_date,
               p.actual_end_date::text AS actual_end_date,
               (${SPENT_SQL}) AS spent,
               r.reference_code, r.public_id, c.code AS currency_code,
               cat.name AS category_name, cp.full_path AS category_trail,
               cu.first_name || ' ' || cu.last_name AS created_by_name,
               ru.first_name || ' ' || ru.last_name AS responsible_name,
               lu.first_name || ' ' || lu.last_name AS linked_by_name,
               i.name AS investment_name, i.status AS investment_status, ir.reference_code AS investment_reference
        FROM   projects p
        JOIN   references_registry r ON r.id = p.reference_id
        LEFT JOIN currencies c ON c.id = p.currency_id
        LEFT JOIN categories cat ON cat.id = p.category_id
        LEFT JOIN category_paths cp ON cp.category_id = p.category_id
        LEFT JOIN users cu ON cu.id = p.created_by
        LEFT JOIN users ru ON ru.id = p.responsible_user_id
        LEFT JOIN users lu ON lu.id = p.linked_by
        LEFT JOIN investments i ON i.id = p.investment_id
        LEFT JOIN references_registry ir ON ir.id = i.reference_id
        WHERE  p.id = $1`, [id]);
    if (!r.rows.length) throw createError.notFound('Project not found');
    const p = r.rows[0];

    const milestones = await query(`
        SELECT id, name, description, due_date::text AS due_date, status, completed_at::text AS completed_at, created_at
        FROM   project_milestones WHERE project_id = $1
        ORDER  BY due_date, id`, [id]);
    // every ledger entry for the project: investment funding and expenses
    const entries = await query(`
        SELECT 'INVESTMENT_FUNDING' AS kind, f.amount, COALESCE(f.is_reversed, FALSE) AS is_reversed,
               t.id AS transaction_id, tr.reference_code AS transaction_reference, t.value_date::text AS value_date,
               t.description, a.name AS account_name
        FROM   investment_funding f
        JOIN   transactions t ON t.id = f.transaction_id
        JOIN   references_registry tr ON tr.id = t.reference_id
        JOIN   accounts a ON a.id = t.account_id
        WHERE  f.project_id = $1
        UNION ALL
        SELECT 'EXPENSE', s.amount, s.is_reversed,
               t.id, tr.reference_code, t.value_date::text, t.description, a.name
        FROM   project_spending s
        JOIN   transactions t ON t.id = s.transaction_id
        JOIN   references_registry tr ON tr.id = t.reference_id
        JOIN   accounts a ON a.id = t.account_id
        WHERE  s.project_id = $1
        ORDER  BY value_date DESC, transaction_id DESC`, [id]);

    const spent = round2(p.spent);
    const beforeLink = entries.rows
        .filter(e => e.kind === 'EXPENSE' && !e.is_reversed)
        .reduce((s, e) => s + parseFloat(e.amount), 0);
    sendSuccess(res, {
        ...p,
        spent,
        remaining: round2(parseFloat(p.planned_budget) - spent),
        spent_as_expenses: round2(beforeLink),
        mismatch: spent !== round2(p.actual_expenditure),
        milestones: milestones.rows,
        entries: entries.rows,
    });
});

// ============================================================
// CREATE — POST /api/projects
// ============================================================
const createProject = asyncHandler(async (req, res) => {
    const {
        name, description, category_id, planned_budget, currency_id, investment_id,
        start_date, expected_end_date, responsible_user_id, status,
    } = req.body;
    checkDates(start_date, expected_end_date);

    await withTransaction(async (client) => {
        let investment = null;
        let currencyId = currency_id ? parseInt(currency_id, 10) : null;
        if (investment_id) {
            investment = await loadInvestmentForProject(client, parseInt(investment_id, 10));
            if (!LINKABLE_INVESTMENT.includes(investment.status)) {
                throw createError.badRequest(`Projects cannot be added to an investment that is ${investment.status.toLowerCase().replace(/_/g, ' ')}.`);
            }
            if (currencyId && currencyId !== investment.currency_id) {
                throw createError.badRequest(`A project inside ${investment.name} is counted in ${investment.currency_code}, the investment's currency.`);
            }
            currencyId = investment.currency_id;
        }
        if (!currencyId) throw createError.badRequest('Choose the currency the project\'s budget is in.');
        const cur = await client.query('SELECT id FROM currencies WHERE id = $1', [currencyId]);
        if (!cur.rows.length) throw createError.badRequest('Currency not found.');

        const categoryId = category_id ? parseInt(category_id, 10) : await defaultCategory(client, req.user.id);
        await assertCategory(client, categoryId);
        await assertUser(client, responsible_user_id);
        const startStatus = status === 'ACTIVE' ? 'ACTIVE' : 'PENDING';

        const { referenceId, referenceCode } = await generateReference(client, MODULE_CODES.PROJECT, 'PROJ', 'PROJECT', req.user.id);
        const ins = await client.query(`
            INSERT INTO projects (reference_id, investment_id, name, description, category_id, planned_budget,
                                  actual_expenditure, status, start_date, expected_end_date, responsible_user_id,
                                  created_by, currency_id, linked_to_investment_at, linked_by)
            VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8, $9, $10, $11, $12, $13, $14)
            RETURNING id`,
        [referenceId, investment ? investment.id : null, String(name).trim(), description || null, categoryId,
            planned_budget, startStatus, start_date || null, expected_end_date || null, responsible_user_id || null,
            req.user.id, currencyId, investment ? new Date() : null, investment ? req.user.id : null]);
        const projectId = ins.rows[0].id;
        await linkReferenceToRecord(client, referenceId, projectId);

        await logAction(req.user.id, ACTIONS.PROJECT_CREATED, MODULES.INVESTMENTS, {
            ipAddress: req.ip, recordType: 'projects', recordId: projectId,
            newValues: { referenceCode, name, planned_budget, investment_id: investment ? investment.id : null, currency_id: currencyId },
            description: `Project created: ${referenceCode} — ${name}${investment ? ` (inside ${investment.reference_code})` : ' (on its own)'}`,
            client,
        });

        sendCreated(res, { project_id: projectId, reference: referenceCode, name, status: startStatus },
            `Project created. Reference: ${referenceCode}`);
    });
});

// ============================================================
// EDIT — PUT /api/projects/:id
// ============================================================
const updateProject = asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    await withTransaction(async (client) => {
        const p = await loadProject(client, id, { lock: true });
        const b = req.body;
        const next = {
            name: b.name !== undefined ? String(b.name).trim() : p.name,
            description: b.description !== undefined ? (b.description || null) : p.description,
            category_id: b.category_id ? parseInt(b.category_id, 10) : p.category_id,
            planned_budget: b.planned_budget !== undefined ? parseFloat(b.planned_budget) : parseFloat(p.planned_budget),
            start_date: b.start_date !== undefined ? (b.start_date || null) : p.start_date,
            expected_end_date: b.expected_end_date !== undefined ? (b.expected_end_date || null) : p.expected_end_date,
            responsible_user_id: b.responsible_user_id !== undefined ? (b.responsible_user_id || null) : p.responsible_user_id,
            currency_id: b.currency_id ? parseInt(b.currency_id, 10) : p.currency_id,
        };
        if (!next.name) throw createError.badRequest('The project needs a name.');
        if (!(next.planned_budget > 0)) throw createError.badRequest('The planned budget must be more than zero.');
        checkDates(next.start_date, next.expected_end_date);
        if (next.category_id !== p.category_id) await assertCategory(client, next.category_id);
        if (next.responsible_user_id !== p.responsible_user_id) await assertUser(client, next.responsible_user_id);

        if (next.currency_id !== p.currency_id) {
            if (p.investment_id) throw createError.badRequest('A project inside an investment is counted in the investment\'s currency.');
            const any = await client.query(`
                SELECT 1 FROM project_spending WHERE project_id = $1
                UNION ALL SELECT 1 FROM investment_funding WHERE project_id = $1 LIMIT 1`, [id]);
            if (any.rows.length) throw createError.badRequest('The currency cannot change once money has been recorded for the project.');
        }

        await client.query(`
            UPDATE projects SET name = $1, description = $2, category_id = $3, planned_budget = $4,
                   start_date = $5, expected_end_date = $6, responsible_user_id = $7, currency_id = $8,
                   updated_at = NOW(), updated_by = $9
            WHERE  id = $10`,
        [next.name, next.description, next.category_id, next.planned_budget, next.start_date, next.expected_end_date,
            next.responsible_user_id, next.currency_id, req.user.id, id]);

        await logAction(req.user.id, A('PROJECT_UPDATED', 'PROJECT_UPDATED'), MODULES.INVESTMENTS, {
            ipAddress: req.ip, recordType: 'projects', recordId: id,
            oldValues: { name: p.name, planned_budget: p.planned_budget, start_date: p.start_date, expected_end_date: p.expected_end_date, responsible_user_id: p.responsible_user_id, category_id: p.category_id, currency_id: p.currency_id },
            newValues: next,
            description: `Project edited: ${p.reference_code} — ${next.name}`,
            client,
        });
        sendSuccess(res, { id }, 'Project saved.');
    });
});

// ============================================================
// STATUS — POST /api/projects/:id/status { status, note, date }
//   COMPLETED → actual end date (given or today)
//   ON_HOLD / CANCELLED / re-opening → a note is required
// ============================================================
const setStatus = asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { status, note, date } = req.body;
    if (!STATUSES.includes(status)) throw createError.badRequest('Invalid project status.');
    await withTransaction(async (client) => {
        const p = await loadProject(client, id, { lock: true });
        if (p.status === status) throw createError.badRequest(`The project is already ${status.toLowerCase().replace(/_/g, ' ')}.`);
        const reopening = CLOSED.includes(p.status);
        const needsNote = ['ON_HOLD', 'CANCELLED'].includes(status) || reopening;
        if (needsNote && !(note && String(note).trim())) {
            throw createError.badRequest(reopening ? 'Say why the project is being re-opened.' : 'Say why (a short note).');
        }
        if (status === 'PENDING' && p.status !== 'PENDING' && !reopening) {
            throw createError.badRequest('A project that has started cannot go back to pending — put it on hold instead.');
        }
        const endDate = status === 'COMPLETED' ? (date || todayStr()) : (reopening ? null : p.actual_end_date);
        if (status === 'COMPLETED' && endDate > todayStr()) throw createError.badRequest('The completion date cannot be in the future.');
        await client.query(`
            UPDATE projects SET status = $1::varchar, status_note = $2, actual_end_date = $3::date,
                   start_date = COALESCE(start_date, CASE WHEN $1::varchar = 'ACTIVE' THEN CURRENT_DATE END),
                   updated_at = NOW(), updated_by = $4
            WHERE  id = $5`,
        [status, note ? String(note).trim() : null, endDate, req.user.id, id]);
        await logAction(req.user.id, A('PROJECT_STATUS_CHANGED', 'PROJECT_STATUS_CHANGED'), MODULES.INVESTMENTS, {
            ipAddress: req.ip, recordType: 'projects', recordId: id,
            oldValues: { status: p.status }, newValues: { status, note: note || null, actual_end_date: endDate },
            description: `Project ${p.reference_code}: ${p.status} → ${status}${note ? ` — ${String(note).trim()}` : ''}`,
            client,
        });
        sendSuccess(res, { id, status }, `Project is now ${status.toLowerCase().replace(/_/g, ' ')}.`);
    });
});

// ============================================================
// ADD TO AN INVESTMENT — POST /api/projects/:id/investment { investment_id }
// ============================================================
const linkInvestment = asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    await withTransaction(async (client) => {
        const p = await loadProject(client, id, { lock: true });
        if (p.investment_id) throw createError.badRequest('This project is already inside an investment.');
        if (CLOSED.includes(p.status)) throw createError.badRequest('A completed or cancelled project cannot be added to an investment.');
        const inv = await loadInvestmentForProject(client, parseInt(req.body.investment_id, 10));
        if (!LINKABLE_INVESTMENT.includes(inv.status)) {
            throw createError.badRequest(`Projects cannot be added to an investment that is ${inv.status.toLowerCase().replace(/_/g, ' ')}.`);
        }
        if (p.currency_id && p.currency_id !== inv.currency_id) {
            throw createError.badRequest(`The project is counted in ${p.currency_code} but ${inv.name} is in ${inv.currency_code} — they must be the same currency.`);
        }
        await client.query(`
            UPDATE projects SET investment_id = $1, currency_id = $2, linked_to_investment_at = NOW(), linked_by = $3,
                   updated_at = NOW(), updated_by = $3
            WHERE  id = $4`, [inv.id, inv.currency_id, req.user.id, id]);
        const spent = await client.query(`SELECT COALESCE(SUM(amount), 0) AS s FROM project_spending WHERE project_id = $1 AND is_reversed = FALSE`, [id]);
        const before = round2(spent.rows[0].s);
        await logAction(req.user.id, A('PROJECT_LINKED', 'PROJECT_LINKED'), MODULES.INVESTMENTS, {
            ipAddress: req.ip, recordType: 'projects', recordId: id,
            newValues: { investment_id: inv.id, spent_before_as_expenses: before },
            description: `Project ${p.reference_code} added to investment ${inv.reference_code} — ${inv.name}`,
            client,
        });
        sendSuccess(res, { id, investment_id: inv.id, spent_before_as_expenses: before },
            `Project added to ${inv.name}.` + (before > 0
                ? ` The ${inv.currency_code} ${before.toLocaleString('en-US', { minimumFractionDigits: 2 })} already spent stays recorded as expenses; money from now on is recorded as funding of the investment.`
                : ''));
    });
});

// ============================================================
// TAKE OUT OF AN INVESTMENT — POST /api/projects/:id/investment/remove { reason }
// Only while no investment money has been recorded for it.
// ============================================================
const unlinkInvestment = asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const reason = req.body.reason && String(req.body.reason).trim();
    if (!reason) throw createError.badRequest('Say why the project is being taken out of the investment.');
    await withTransaction(async (client) => {
        const p = await loadProject(client, id, { lock: true });
        if (!p.investment_id) throw createError.badRequest('This project is not inside an investment.');
        const funded = await client.query(`SELECT COUNT(*)::int AS n FROM investment_funding WHERE project_id = $1 AND COALESCE(is_reversed, FALSE) = FALSE`, [id]);
        if (funded.rows[0].n > 0) {
            throw createError.badRequest(`${funded.rows[0].n} investment funding entr${funded.rows[0].n === 1 ? 'y is' : 'ies are'} recorded for this project — it stays inside the investment (reverse those entries first if they were wrong).`);
        }
        await client.query(`
            UPDATE projects SET investment_id = NULL, linked_to_investment_at = NULL, linked_by = NULL,
                   updated_at = NOW(), updated_by = $1
            WHERE  id = $2`, [req.user.id, id]);
        await logAction(req.user.id, A('PROJECT_UNLINKED', 'PROJECT_UNLINKED'), MODULES.INVESTMENTS, {
            ipAddress: req.ip, recordType: 'projects', recordId: id,
            oldValues: { investment_id: p.investment_id }, newValues: { investment_id: null, reason },
            description: `Project ${p.reference_code} taken out of its investment — ${reason}`,
            client,
        });
        sendSuccess(res, { id }, 'The project is now on its own.');
    });
});

// ============================================================
// MILESTONES
//   POST  /api/projects/:id/milestones            { name, due_date, description }
//   PATCH /api/projects/:id/milestones/:mid       { name?, due_date?, description?, status?, completed_at? }
// ============================================================
const MILESTONE_STATUSES = ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'MISSED'];

const addMilestone = asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { name, description, due_date } = req.body;
    const p = await loadProject({ query }, id);
    if (CLOSED.includes(p.status)) throw createError.badRequest('The project is closed — re-open it to add milestones.');
    const r = await query(`
        INSERT INTO project_milestones (project_id, name, description, due_date, status, created_by)
        VALUES ($1, $2, $3, $4, 'PENDING', $5) RETURNING id`,
    [id, String(name).trim(), description || null, due_date, req.user.id]);
    await logAction(req.user.id, ACTIONS.MILESTONE_UPDATED, MODULES.INVESTMENTS, {
        ipAddress: req.ip, recordType: 'project_milestones', recordId: r.rows[0].id,
        newValues: { project_id: id, name, due_date }, description: `Milestone added to ${p.reference_code}: ${name}`,
    });
    sendCreated(res, { id: r.rows[0].id }, 'Milestone added.');
});

const updateMilestone = asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const mid = parseInt(req.params.mid, 10);
    const cur = await query('SELECT * FROM project_milestones WHERE id = $1 AND project_id = $2', [mid, id]);
    if (!cur.rows.length) throw createError.notFound('Milestone not found');
    const m = cur.rows[0];
    const b = req.body;
    const status = b.status || m.status;
    if (!MILESTONE_STATUSES.includes(status)) throw createError.badRequest('Invalid milestone status.');
    let completedAt = m.completed_at;
    if (status === 'COMPLETED') completedAt = b.completed_at || m.completed_at || todayStr();
    else completedAt = null;
    if (completedAt && String(completedAt) > todayStr()) throw createError.badRequest('The completion date cannot be in the future.');
    const r = await query(`
        UPDATE project_milestones SET name = $1, description = $2, due_date = $3, status = $4, completed_at = $5
        WHERE  id = $6 RETURNING id`,
    [b.name ? String(b.name).trim() : m.name, b.description !== undefined ? (b.description || null) : m.description,
        b.due_date || m.due_date, status, completedAt, mid]);
    await logAction(req.user.id, ACTIONS.MILESTONE_UPDATED, MODULES.INVESTMENTS, {
        ipAddress: req.ip, recordType: 'project_milestones', recordId: mid,
        oldValues: { status: m.status, due_date: m.due_date }, newValues: { status, completed_at: completedAt },
        description: `Milestone ${m.name}: ${m.status} → ${status}`,
    });
    sendSuccess(res, { id: r.rows[0].id }, 'Milestone saved.');
});

// ============================================================
// Used by Record Expense (transactionsController.recordExpense) when a
// project is chosen: checks it and records the spending. Inside the
// caller's transaction.
// ============================================================
const recordExpenseForProject = async (client, { projectId, transactionId, amount, accountCurrencyId, userId }) => {
    const p = await loadProject(client, projectId, { lock: true });
    if (p.investment_id) {
        throw createError.badRequest(`${p.name} is inside an investment — record its money as funding of that investment (Investments › the investment › Fund), choosing the project there.`);
    }
    if (CLOSED.includes(p.status)) throw createError.badRequest(`${p.name} is ${p.status.toLowerCase()} — re-open it to record spending.`);
    if (p.currency_id && accountCurrencyId !== p.currency_id) {
        throw createError.badRequest(`${p.name} is counted in ${p.currency_code} — pay it from an account in ${p.currency_code}.`);
    }
    await client.query(`UPDATE transactions SET project_id = $1 WHERE id = $2`, [projectId, transactionId]);
    await client.query(`
        INSERT INTO project_spending (project_id, transaction_id, amount, created_by) VALUES ($1, $2, $3, $4)`,
    [projectId, transactionId, round2(amount), userId]);
    await client.query(`
        UPDATE projects SET actual_expenditure = actual_expenditure + $1,
               status = CASE WHEN status = 'PENDING' THEN 'ACTIVE' ELSE status END,
               start_date = COALESCE(start_date, $3::date)
        WHERE  id = $2`, [round2(amount), projectId, todayStr()]);
    return p;
};

// Used by investment funding when a project is chosen.
const assertFundingProject = async (client, { projectId, investmentId }) => {
    const p = await loadProject(client, projectId, { lock: true });
    if (p.investment_id !== investmentId) {
        throw createError.badRequest(`${p.name} is not a project of this investment${p.investment_id ? '' : ' (it is on its own — add it to this investment first, on the project page)'}.`);
    }
    if (CLOSED.includes(p.status)) throw createError.badRequest(`${p.name} is ${p.status.toLowerCase()} — re-open it to record money for it.`);
    return p;
};

// Used by a reversal: an expense for a project on its own is reversed.
const reverseProjectSpending = async (client, { reversalOf, userId }) => {
    const ids = [...reversalOf.keys()];
    if (!ids.length) return null;
    const ok = await client.query(`SELECT to_regclass('public.project_spending') IS NOT NULL AS ok`);
    if (!ok.rows[0].ok) return null;
    const rows = await client.query(`
        SELECT s.id, s.project_id, s.amount, r.reference_code
        FROM   project_spending s
        JOIN   projects p ON p.id = s.project_id
        JOIN   references_registry r ON r.id = p.reference_id
        WHERE  s.transaction_id = ANY($1::int[]) AND s.is_reversed = FALSE`, [ids]);
    const notes = [];
    for (const s of rows.rows) {
        await client.query(`UPDATE project_spending SET is_reversed = TRUE, reversed_at = NOW(), reversed_by = $1 WHERE id = $2`, [userId, s.id]);
        await client.query(`UPDATE projects SET actual_expenditure = GREATEST(0, actual_expenditure - $1) WHERE id = $2`, [s.amount, s.project_id]);
        notes.push(`project ${s.reference_code} spending reduced by ${parseFloat(s.amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
    }
    return notes.length ? notes.join('; ') : null;
};

module.exports = {
    listProjects, projectOptions, getProject, createProject, updateProject, setStatus,
    linkInvestment, unlinkInvestment, addMilestone, updateMilestone,
    recordExpenseForProject, assertFundingProject, reverseProjectSpending,
};
