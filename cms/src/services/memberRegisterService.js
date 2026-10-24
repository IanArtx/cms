// ============================================================
// REGISTER OF MEMBERS AND OFFICERS (v1.86.1)
//
// Requested: "i would like that the system keeps an up to date
// downloadable register of the active members and their roles and
// information at all times".
//
// Nothing is stored for it: every download is built at that moment from
// the live records (accounts, roles, consents, shares), so the register
// can never be out of date or disagree with the rest of the system.
//
//   current  — every active account that holds at least one role
//              (declined / deactivated / role-less accounts are not
//              members): personal details, roles with the date each was
//              given, member since, Membership Agreement, shares held in
//              the company's register and shares registered with URSB,
//              sign-in security.
//   roles    — each role and who holds it now.
//   former   — people who held a role and no longer do (role removed,
//              or account deactivated): every role they held, from–to,
//              and when they ceased to be a member / officer.
//
// Who may download it: see routes/memberRegister.js. Every download is
// written to the audit log (MEMBER_REGISTER_DOWNLOADED).
// ============================================================

const { query } = require('../config/database');

const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

// Shares from the share register (held) and from URSB (registered). Both
// are optional: a database without the share tables simply shows none.
const sharesByMember = async () => {
    const out = new Map();
    try {
        const reg = require('./registeredSharesService');
        if (await reg.tableReady()) {
            const r = await reg.getRegister();
            for (const m of r.members) out.set(m.user_id, { held: m.shares_held, registered: m.registered });
            return { map: out, total: r.totals.held };
        }
    } catch (_) { /* fall through */ }
    try {
        const r = await query(`SELECT user_id, shares_held FROM shareholding_registry WHERE effective_to IS NULL`);
        let total = 0;
        for (const x of r.rows) {
            const held = parseInt(Math.round(parseFloat(x.shares_held || 0)), 10);
            total += held;
            out.set(x.user_id, { held, registered: null });
        }
        return { map: out, total };
    } catch (_) {
        return { map: out, total: 0 };
    }
};

const build = async () => {
    const generatedAt = new Date();
    const declinedCol = await query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'rejected_at'`);
    const notDeclined = declinedCol.rows.length ? 'AND u.rejected_at IS NULL' : '';

    // every role assignment ever made (current and past), with who gave / removed it
    const roleRows = (await query(`
        SELECT ur.user_id, r.name AS role, ur.assigned_at, ur.revoked_at,
               ab.first_name || ' ' || ab.last_name AS assigned_by_name,
               rb.first_name || ' ' || rb.last_name AS revoked_by_name
        FROM   user_roles ur
        JOIN   roles r       ON r.id = ur.role_id
        LEFT JOIN users ab   ON ab.id = ur.assigned_by
        LEFT JOIN users rb   ON rb.id = ur.revoked_by
        ORDER  BY ur.assigned_at, r.name`)).rows;
    const rolesOf = new Map();
    for (const x of roleRows) {
        if (!rolesOf.has(x.user_id)) rolesOf.set(x.user_id, []);
        rolesOf.get(x.user_id).push(x);
    }

    const consent = new Map();
    try {
        const c = await query(`SELECT user_id, MAX(consented_at) AS at, (array_agg(agreement_version ORDER BY consented_at DESC))[1] AS version
                               FROM member_consents GROUP BY user_id`);
        for (const x of c.rows) consent.set(x.user_id, x);
    } catch (_) { /* table missing on a very old database */ }

    const shares = await sharesByMember();

    const users = (await query(`
        SELECT u.id, u.first_name, u.last_name, u.email, u.phone, u.address, u.nationality, u.id_number,
               u.date_of_birth, u.gender, u.tin, u.tax_residency,
               u.emergency_contact_name, u.emergency_contact_phone,
               u.is_active, u.is_email_verified, u.two_factor_enabled,
               u.created_at, u.last_login_at, u.updated_at,
               (SELECT MAX(a.created_at) FROM audit_log a
                WHERE a.action = 'USER_DEACTIVATED' AND a.record_type = 'users' AND a.record_id = u.id) AS deactivated_at
        FROM   users u
        WHERE  EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id) ${notDeclined}
        ORDER  BY u.last_name, u.first_name`)).rows;

    const current = [];
    const former = [];
    let no = 0;
    for (const u of users) {
        const all = rolesOf.get(u.id) || [];
        const active = all.filter(x => !x.revoked_at);
        const name = `${u.first_name} ${u.last_name}`.trim();
        const memberSince = all.length ? iso(all[0].assigned_at) : null;
        if (u.is_active && active.length) {
            const s = shares.map.get(u.id) || { held: 0, registered: null };
            const c = consent.get(u.id);
            no += 1;
            current.push({
                no,
                user_id: u.id,
                name,
                first_name: u.first_name,
                last_name: u.last_name,
                roles: active.map(x => x.role),
                roles_detail: active.map(x => ({ role: x.role, since: iso(x.assigned_at), by: x.assigned_by_name || null })),
                member_since: memberSince,
                email: u.email,
                phone: u.phone || null,
                address: u.address || null,
                nationality: u.nationality || null,
                id_number: u.id_number || null,
                date_of_birth: iso(u.date_of_birth),
                gender: u.gender || null,
                tin: u.tin || null,
                tax_residency: u.tax_residency || null,
                emergency_contact: [u.emergency_contact_name, u.emergency_contact_phone].filter(Boolean).join(' — ') || null,
                shares_held: s.held || 0,
                shares_registered: s.registered,
                share_percent: shares.total > 0 ? Math.round(((s.held || 0) / shares.total) * 10000) / 100 : 0,
                agreement_signed: c ? iso(c.at) : null,
                agreement_version: c ? c.version : null,
                email_verified: !!u.is_email_verified,
                two_factor: !!u.two_factor_enabled,
                last_sign_in: u.last_login_at ? new Date(u.last_login_at).toISOString() : null,
                account_created: iso(u.created_at),
                details_updated: iso(u.updated_at),
            });
        } else {
            // held a role once, not a member now
            const ceased = u.is_active
                ? iso(all.reduce((m, x) => (x.revoked_at && (!m || x.revoked_at > m) ? x.revoked_at : m), null))
                : iso(u.deactivated_at || u.updated_at);
            former.push({
                user_id: u.id,
                name,
                email: u.email,
                phone: u.phone || null,
                roles_held: all.map(x => ({
                    role: x.role, from: iso(x.assigned_at), to: iso(x.revoked_at) || (u.is_active ? null : ceased),
                    removed_by: x.revoked_by_name || null,
                })),
                member_since: memberSince,
                ceased,
                how: u.is_active ? 'Roles removed' : 'Account deactivated',
                shares_held: (shares.map.get(u.id) || {}).held || 0,
            });
        }
    }
    former.sort((a, b) => String(b.ceased || '').localeCompare(String(a.ceased || '')));

    // roles summary
    const byRole = new Map();
    for (const m of current) {
        for (const d of m.roles_detail) {
            if (!byRole.has(d.role)) byRole.set(d.role, []);
            byRole.get(d.role).push({ name: m.name, since: d.since });
        }
    }
    const roles = [...byRole.entries()]
        .map(([role, holders]) => ({ role, count: holders.length, holders: holders.sort((a, b) => a.name.localeCompare(b.name)) }))
        .sort((a, b) => a.role.localeCompare(b.role));

    const company = (await query(`SELECT company_name FROM company_settings WHERE id = 1`).catch(() => ({ rows: [] }))).rows[0];

    return {
        generated_at: generatedAt.toISOString(),
        company_name: company?.company_name || process.env.COMPANY_NAME || 'Company',
        summary: {
            members: current.length,
            shareholders: current.filter(m => m.roles.includes('Shareholder')).length,
            officers: current.filter(m => m.roles.some(r => r !== 'Shareholder')).length,
            former: former.length,
            shares_total: shares.total,
            missing_details: current.filter(m => !m.phone || !m.address || !m.id_number).length,
        },
        current,
        roles,
        former,
    };
};

// ------------------------------------------------------------
// Excel workbook — sheets: Members, Roles, Former members, About
// ------------------------------------------------------------
const toWorkbook = async (reg, { generatedBy }) => {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = generatedBy || 'Company Management System';
    wb.created = new Date(reg.generated_at);
    const stamp = new Date(reg.generated_at).toLocaleString('en-GB', { timeZone: 'Africa/Kampala', dateStyle: 'long', timeStyle: 'short' });

    const header = (ws, title, cols) => {
        ws.mergeCells(1, 1, 1, cols.length);
        ws.getCell(1, 1).value = `${reg.company_name} — ${title}`;
        ws.getCell(1, 1).font = { bold: true, size: 14 };
        ws.mergeCells(2, 1, 2, cols.length);
        ws.getCell(2, 1).value = `As at ${stamp} (Kampala time) — generated by ${generatedBy || 'the system'} from the live records. Confidential: personal data.`;
        ws.getCell(2, 1).font = { italic: true, size: 9, color: { argb: 'FF555555' } };
        const row = ws.getRow(4);
        cols.forEach((c, i) => {
            const cell = row.getCell(i + 1);
            cell.value = c.header;
            cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
            cell.alignment = { vertical: 'middle', wrapText: true };
            ws.getColumn(i + 1).width = c.width || 16;
        });
        row.height = 30;
        ws.views = [{ state: 'frozen', ySplit: 4, xSplit: 2 }];
        ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: cols.length } };
    };
    const fill = (ws, cols, rows) => {
        rows.forEach((r, i) => {
            const row = ws.getRow(5 + i);
            cols.forEach((c, j) => {
                const v = c.value(r);
                row.getCell(j + 1).value = v === null || v === undefined ? '' : v;
                row.getCell(j + 1).alignment = { vertical: 'top', wrapText: !!c.wrap };
                if (c.numFmt) row.getCell(j + 1).numFmt = c.numFmt;
            });
        });
    };

    const memberCols = [
        { header: 'No.', width: 6, value: m => m.no },
        { header: 'Name', width: 24, value: m => m.name },
        { header: 'Roles (since)', width: 34, wrap: true, value: m => m.roles_detail.map(d => `${d.role} (${d.since})`).join('\n') },
        { header: 'Member since', width: 13, value: m => m.member_since },
        { header: 'Email', width: 28, value: m => m.email },
        { header: 'Phone', width: 16, value: m => m.phone },
        { header: 'Address', width: 28, wrap: true, value: m => m.address },
        { header: 'Nationality', width: 13, value: m => m.nationality },
        { header: 'ID / Passport No.', width: 18, value: m => m.id_number },
        { header: 'Date of birth', width: 12, value: m => m.date_of_birth },
        { header: 'Gender', width: 9, value: m => m.gender },
        { header: 'TIN', width: 13, value: m => m.tin },
        { header: 'Tax residency', width: 13, value: m => m.tax_residency },
        { header: 'Emergency contact', width: 24, wrap: true, value: m => m.emergency_contact },
        { header: 'Shares held (company register)', width: 14, numFmt: '#,##0', value: m => m.shares_held },
        { header: '% of shares', width: 9, numFmt: '0.00', value: m => m.share_percent },
        { header: 'Shares registered (URSB)', width: 14, numFmt: '#,##0', value: m => m.shares_registered },
        { header: 'Membership Agreement signed', width: 14, value: m => m.agreement_signed || 'Not yet' },
        { header: 'Email verified', width: 9, value: m => (m.email_verified ? 'Yes' : 'No') },
        { header: 'Two-factor sign-in', width: 10, value: m => (m.two_factor ? 'On' : 'Off') },
        { header: 'Last sign-in', width: 13, value: m => (m.last_sign_in ? m.last_sign_in.slice(0, 10) : 'Never') },
        { header: 'Details last updated', width: 13, value: m => m.details_updated },
    ];
    const ws1 = wb.addWorksheet('Members', { pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 } });
    header(ws1, 'Register of members and officers', memberCols);
    fill(ws1, memberCols, reg.current);

    const ws2 = wb.addWorksheet('Roles');
    const roleCols = [
        { header: 'Role', width: 24, value: r => r.role },
        { header: 'Holders', width: 9, value: r => r.count },
        { header: 'Held by (since)', width: 70, wrap: true, value: r => r.holders.map(h => `${h.name} (${h.since})`).join('\n') },
    ];
    header(ws2, 'Roles and who holds them', roleCols);
    fill(ws2, roleCols, reg.roles);

    const ws3 = wb.addWorksheet('Former members');
    const formerCols = [
        { header: 'Name', width: 24, value: f => f.name },
        { header: 'Email', width: 28, value: f => f.email },
        { header: 'Roles held (from – to)', width: 46, wrap: true, value: f => f.roles_held.map(x => `${x.role} (${x.from} – ${x.to || 'now'})`).join('\n') },
        { header: 'Member since', width: 13, value: f => f.member_since },
        { header: 'Ceased', width: 12, value: f => f.ceased },
        { header: 'How', width: 20, value: f => f.how },
        { header: 'Shares still held', width: 12, numFmt: '#,##0', value: f => f.shares_held },
    ];
    header(ws3, 'Former members and officers', formerCols);
    fill(ws3, formerCols, reg.former);

    const ws4 = wb.addWorksheet('About');
    ws4.getColumn(1).width = 30; ws4.getColumn(2).width = 90;
    [
        ['Register', `Register of members and officers — ${reg.company_name}`],
        ['As at', stamp + ' (Kampala time)'],
        ['Generated by', generatedBy || ''],
        ['Members now', reg.summary.members],
        ['  of whom shareholders', reg.summary.shareholders],
        ['  of whom officers / staff (any other role)', reg.summary.officers],
        ['Former members and officers', reg.summary.former],
        ['Shares in the company register', reg.summary.shares_total],
        ['Members with missing details', `${reg.summary.missing_details} (phone, address or ID number empty — ask them to complete My profile)`],
        ['Who is a member', 'Every active account holding at least one role. Accounts waiting for a role, declined or deactivated are not members.'],
        ['Shares', 'Held = the company\'s own share register (basis of ownership and dividends). Registered = the shares registered with URSB (empty if no URSB figure is recorded yet).'],
        ['Keeping it current', 'Nothing is stored: each download is made from the live records at that moment. Download again whenever you need the latest register.'],
        ['Confidential', 'Contains personal data (ID numbers, dates of birth, addresses). Store it securely and share it only with those entitled to see it. Every download is recorded in the audit log.'],
    ].forEach((r, i) => {
        ws4.getCell(i + 1, 1).value = r[0]; ws4.getCell(i + 1, 1).font = { bold: true };
        ws4.getCell(i + 1, 2).value = r[1]; ws4.getCell(i + 1, 2).alignment = { wrapText: true, vertical: 'top' };
    });

    return wb.xlsx.writeBuffer();
};

module.exports = { build, toWorkbook };
