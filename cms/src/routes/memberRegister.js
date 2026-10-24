// ============================================================
// REGISTER OF MEMBERS AND OFFICERS (v1.86.1) — prefix /api/member-register
//   GET /            the register (JSON) — for the page and its PDF
//   GET /download    ?format=xlsx (default) | csv — the file
// Who: anyone with the members permission (USER_MANAGE), or the Admin,
// Secretary, Assistant Secretary or a Director (the register of members
// is the company secretary's statutory record; directors are entitled to
// it). It holds personal data, so every view and download is audited.
// ============================================================

const router = require('express').Router();
const { authenticate, requireAssignedRole, requireConsent } = require('../middleware/auth');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess } = require('../utils/response');
const { rowsToCsv, sendCsv } = require('../utils/csv');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');
const register = require('../services/memberRegisterService');

const REGISTER_ROLES = ['Admin', 'Secretary', 'Assistant Secretary', 'Director'];

const canSeeRegister = (req, res, next) => {
    const perms = req.user?.permissions || [];
    const roles = req.user?.roles || [];
    if (perms.includes('USER_MANAGE') || roles.some(r => REGISTER_ROLES.includes(r))) return next();
    return next(createError.forbidden('The register of members is open to the Admin, the Secretary, the Assistant Secretary and Directors.'));
};

const audit = (req, what) => logAction(req.user.id, ACTIONS.MEMBER_REGISTER_DOWNLOADED, MODULES.USERS, {
    ipAddress: req.ip, recordType: 'users', description: `Register of members ${what}`,
}).catch(() => {});

const byName = (req) => `${req.user.first_name} ${req.user.last_name}`.trim();

router.use(authenticate, requireAssignedRole, requireConsent, canSeeRegister);

router.get('/', asyncHandler(async (req, res) => {
    const reg = await register.build();
    await audit(req, req.query.purpose === 'pdf' ? 'printed / saved as PDF' : 'viewed');
    sendSuccess(res, { ...reg, generated_by: byName(req) });
}));

router.get('/download', asyncHandler(async (req, res) => {
    const format = req.query.format === 'csv' ? 'csv' : 'xlsx';
    const reg = await register.build();
    const day = reg.generated_at.slice(0, 10);
    const slug = String(reg.company_name || 'company').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'company';
    await audit(req, `downloaded (${format.toUpperCase()}, ${reg.current.length} members)`);
    if (format === 'csv') {
        const csv = rowsToCsv([
            { key: 'no', header: 'No.' },
            { key: 'name', header: 'Name' },
            { key: 'roles_detail', header: 'Roles (since)', format: v => v.map(d => `${d.role} (${d.since})`).join('; ') },
            { key: 'member_since', header: 'Member since' },
            { key: 'email', header: 'Email' },
            { key: 'phone', header: 'Phone' },
            { key: 'address', header: 'Address' },
            { key: 'nationality', header: 'Nationality' },
            { key: 'id_number', header: 'ID / Passport No.' },
            { key: 'date_of_birth', header: 'Date of birth' },
            { key: 'gender', header: 'Gender' },
            { key: 'tin', header: 'TIN' },
            { key: 'tax_residency', header: 'Tax residency' },
            { key: 'emergency_contact', header: 'Emergency contact' },
            { key: 'shares_held', header: 'Shares held (company register)' },
            { key: 'share_percent', header: '% of shares' },
            { key: 'shares_registered', header: 'Shares registered (URSB)' },
            { key: 'agreement_signed', header: 'Membership Agreement signed', format: v => v || 'Not yet' },
            { key: 'email_verified', header: 'Email verified', format: v => (v ? 'Yes' : 'No') },
            { key: 'two_factor', header: 'Two-factor sign-in', format: v => (v ? 'On' : 'Off') },
            { key: 'last_sign_in', header: 'Last sign-in', format: v => (v ? v.slice(0, 10) : 'Never') },
        ], reg.current);
        return sendCsv(res, `register-of-members-${slug}-${day}.csv`, csv);
    }
    const buf = await register.toWorkbook(reg, { generatedBy: byName(req) });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="register-of-members-${slug}-${day}.xlsx"`);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(Buffer.from(buf));
}));

module.exports = router;
