// ============================================================
// USER MANUAL — ONE SOURCE (v1.82.0)
// Joins the general chapters (manualChapters.js) and the pages
// (manualModules.js), and answers the questions the About page, the
// PDF and the guided tours ask:
//
//   modulesFor(navCtx, { complete, isAuditor })  the pages in the manual
//   chaptersFor({ complete, isAuditor })          the general chapters
//   whereToFind(navCtx, { complete, isAuditor })  "I want to…" → where
//   pageTourFor(pathname)                          the page tour here, if any
//   moduleById(id)
// ============================================================

import { NAV_ITEMS } from '../components/layout/navConfig';
import { GENERAL_CHAPTERS, ROLES, PERMISSION_NOTE } from './manualChapters';
import { MODULES, MODULE_GROUPS } from './manualModules';

export { GENERAL_CHAPTERS, ROLES, PERMISSION_NOTE, MODULES, MODULE_GROUPS };

export const MANUAL_EDITION = '1.82.0';

// ------------------------------------------------------------
// "I want to …" — the quick map (Part 4). `page` is a module id.
// ------------------------------------------------------------
const WANTS = [
    { want: 'See the company\'s balances', where: 'Top bar › Balances, or Money › Accounts', page: 'accounts' },
    { want: 'Record a shareholder\'s capital contribution', where: 'Money › Transactions › Record › Record Contribution (or + New)', page: 'transactions' },
    { want: 'Record an expense', where: 'Money › Transactions › Record › Record Expense (or + New)', page: 'transactions' },
    { want: 'Correct a wrong money entry', where: 'Money › Transactions › open the entry › Request reversal', page: 'transactions' },
    { want: 'Move money from the Euro account to the UGX account', where: 'Money › Transfers › New Transfer', page: 'transfers' },
    { want: 'Set an exchange rate or the share price', where: 'Money › Accounts › Set Rate / Set Price (Propose a Change)', page: 'accounts' },
    { want: 'Change an account\'s floor limit', where: 'Money › Accounts › open the account › Update Floor Limit', page: 'accounts' },
    { want: 'Ask the company for money', where: 'Money › Requisitions › New Requisition › Money Request', page: 'requisitions' },
    { want: 'Have a payment I made recorded', where: 'Money › Requisitions › New Requisition › Acknowledge My Contribution', page: 'requisitions' },
    { want: 'Approve money entries someone else recorded', where: 'Money › Awaiting approval › Approve and post', page: 'money-approvals' },
    { want: 'Confirm money the company paid me', where: 'Money › Acknowledgements › My Acknowledgements › Acknowledge', page: 'acknowledgements' },
    { want: 'See or add to my savings', where: "Members' funds › Savings › My Savings", page: 'savings' },
    { want: 'Pay my side fund dues', where: "Members' funds › Side fund › My Dues", page: 'side-fund' },
    { want: 'See my deposit', where: "Members' funds › Deposits › My Deposit", page: 'deposits' },
    { want: 'See or settle my fines', where: "Members' funds › Fines › My Fines / Settle With My Savings", page: 'fines' },
    { want: 'See my shares', where: "Members' funds › Share capital › My Shares, or My portfolio", page: 'share-capital' },
    { want: 'Declare a dividend', where: "Members' funds › Dividends › Declare Dividend", page: 'dividends' },
    { want: 'Pledge to a capital goal', where: "Members' funds › Capital goals › Overview › Pledge", page: 'capital-goals' },
    { want: 'Add an investment, bond, treasury bill or money market fund', where: 'Investments › Portfolio › New Investment', page: 'portfolio' },
    { want: 'Record income from an investment', where: 'Investments › Portfolio › open it › Record Return', page: 'portfolio' },
    { want: 'Record a loan repayment', where: 'Investments › Loans › open the loan', page: 'loans' },
    { want: 'Pay withheld tax to URA', where: 'Compliance › Tax › Withheld & returns › Record payment', page: 'tax' },
    { want: 'See the monthly report', where: 'Compliance › Reports & ledger › General Report / My Report', page: 'reports' },
    { want: 'See the balance sheet or trial balance', where: 'Compliance › Reports & ledger › Financial Statements', page: 'reports' },
    { want: 'Create an event and email people', where: 'Office › Events › New Event', page: 'events' },
    { want: 'Call a meeting and take minutes', where: 'Office › Meetings & resolutions › Convene a meeting', page: 'meetings' },
    { want: 'Sign a written resolution', where: 'Dashboard › Read and sign, or Office › Meetings & resolutions', page: 'meetings' },
    { want: 'Upload or find a document', where: 'Office › Documents › Library (tiles) or Upload', page: 'documents' },
    { want: 'Make a document from a template', where: 'Office › Documents › Generate', page: 'documents' },
    { want: 'Sign documents waiting for me', where: 'Office › Documents › Pending My Signature', page: 'documents' },
    { want: 'Claim back money I spent', where: 'Office › Service fees › Request Reimbursement', page: 'service-fees' },
    { want: 'Approve a new member / give a role', where: 'Office › Members › Role Requests / Manage Roles', page: 'members' },
    { want: 'Decide what a role may do', where: 'Office › Settings › Roles', page: 'settings' },
    { want: 'Change my password, email or switch on 2FA', where: 'Your picture › My profile › Password & Email / Security', page: 'profile' },
    { want: 'Draw or redraw my signature', where: 'Your picture › My profile › Signature', page: 'profile' },
    { want: 'Go back to a form I did not finish', where: 'Your picture › Unfinished forms', page: 'drafts' },
    { want: 'Print my statement', where: 'My portfolio › Print / Save as PDF', page: 'my-portfolio' },
    { want: 'Take the guided tour again', where: 'Your picture › Take the guided tour, or the (?) button', page: 'about' },
    { want: 'Download this manual', where: 'Office › About › Download manual', page: 'about' },
];

const navById = new Map(NAV_ITEMS.map(i => [i.id, i]));

export const moduleById = (id) => MODULES.find(m => m.id === id) || null;

/** Can this person open the page a manual entry describes? */
export const moduleVisible = (m, navCtx, { isAuditor = false } = {}) => {
    if (isAuditor) return !!m.auditorOnly;
    if (m.auditorOnly) return false;
    if (m.always) return true;
    const item = navById.get(m.navId);
    if (!item) return false;
    try { return !!item.show(navCtx); } catch (_) { return false; }
};

export const modulesFor = (navCtx, { complete = false, isAuditor = false } = {}) =>
    (complete ? MODULES : MODULES.filter(m => moduleVisible(m, navCtx, { isAuditor })));

export const chaptersFor = ({ complete = false, isAuditor = false } = {}) =>
    (complete || !isAuditor ? GENERAL_CHAPTERS : GENERAL_CHAPTERS.filter(c => c.auditor));

export const whereToFind = (navCtx, opts = {}) => {
    const ids = new Set(modulesFor(navCtx, opts).map(m => m.id));
    return WANTS.filter(w => ids.has(w.page));
};

// ------------------------------------------------------------
// Page tours
// ------------------------------------------------------------
const pathMatches = (path, pathname) => (path === '/' ? pathname === '/' : (pathname === path || pathname.startsWith(`${path}/`)));

/**
 * The tour for the page at `pathname`: { id, title, module, steps } or null.
 * A detail page (one investment, one meeting …) has its own tour when one
 * is written; otherwise the parent page's tour is used only on the parent.
 */
export const pageTourFor = (pathname) => {
    for (const m of MODULES) {
        for (const d of (m.details || [])) {
            if ((d.match || []).some(rx => rx.test(pathname)) && d.tour?.length) {
                return { id: `page:${d.id}`, title: d.title, module: m, summary: m.summary, steps: d.tour };
            }
        }
    }
    const hit = MODULES.find(m => m.path === pathname || (m.match || []).some(rx => rx.test(pathname)));
    if (hit?.tour?.length) return { id: `page:${hit.id}`, title: hit.title, module: hit, summary: hit.summary, steps: hit.tour };
    return null;
};

/** The manual entry for the page at `pathname` (for "Manual for this page"). */
export const moduleForPath = (pathname) => {
    let best = null;
    MODULES.forEach(m => {
        if ((m.path && pathMatches(m.path, pathname)) || (m.match || []).some(rx => rx.test(pathname))
            || (m.details || []).some(d => (d.match || []).some(rx => rx.test(pathname)))) {
            if (!best || (m.path || '').length > (best.path || '').length) best = m;
        }
    });
    return best;
};

export const groupLabel = (id) => MODULE_GROUPS.find(g => g.id === id)?.label || id;
