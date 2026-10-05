// ============================================================
// NAVIGATION MAP (v1.71.0 "Harbour")
// The ONE place that says which pages exist, which group they belong
// to, who may see them, and what they are called in the breadcrumb.
// Sidebar.jsx, TopBar.jsx (breadcrumb, "+ New" menu), GlobalSearch.jsx
// (page results) and MobileNav.jsx all read from here, so a page added
// here appears consistently everywhere.
//
// Six groups replace the old flat list of ~26 links:
//   Home · Money · Members' funds · Investments · Compliance · Office
//
// Visibility rules are the SAME rules the old Sidebar used (copied
// item by item) — this file changes where a link sits, never who can
// see it. The backend still enforces every permission on its own.
//
//   ctx = { hasPermission, hasRole, hasFinancialAccess,
//           isAdminOfficer, capitalGoalTrackingEnabled }
// ============================================================

import {
    HomeIcon,
    BanknotesIcon,
    ArrowsRightLeftIcon,
    GiftIcon,
    CreditCardIcon,
    ChartBarIcon,
    CalendarDaysIcon,
    DocumentTextIcon,
    ChartPieIcon,
    UsersIcon,
    Cog6ToothIcon,
    BuildingLibraryIcon,
    InformationCircleIcon,
    ClipboardDocumentListIcon,
    WalletIcon,
    ShieldCheckIcon,
    FlagIcon,
    CheckBadgeIcon,
    ExclamationTriangleIcon,
    ArchiveBoxIcon,
    ScaleIcon,
    ReceiptPercentIcon,
    UserGroupIcon,
    ArrowTrendingUpIcon,
    BriefcaseIcon,
    CircleStackIcon,
    DocumentMagnifyingGlassIcon,
    CurrencyDollarIcon,
    ClockIcon,
    BuildingOffice2Icon,
} from '@heroicons/react/24/outline';

// v1.73.0 — permissions that let someone record money straight away
// (their entries wait for the Treasurer/Admin), so they see "Awaiting approval".
const MONEY_ENTRY_PERMISSIONS = [
    'FINANCE_TRANSACTION_CREATE', 'GRANT_APPROVE', 'LOAN_REPAYMENT_RECORD', 'INVESTMENT_MANAGE',
    'MMF_MANAGE', 'SIDE_FUND_EXPENSE_RECORD', 'SIDE_FUND_CONTRIBUTION_RECORD', 'SIDE_FUND_MANAGE',
    'DEPOSIT_MANAGE', 'FINE_MANAGE',
];

// ------------------------------------------------------------
// GROUPS — `color` is the icon colour on the navy sidebar (both modes).
// ------------------------------------------------------------
export const NAV_GROUPS = [
    { id: 'money',       label: 'Money',          icon: WalletIcon,          color: '#60a5fa' },
    { id: 'members',     label: "Members' funds", icon: UserGroupIcon,       color: '#2dd4bf' },
    { id: 'investments', label: 'Investments',    icon: ArrowTrendingUpIcon, color: '#fbbf24' },
    { id: 'compliance',  label: 'Compliance',     icon: ShieldCheckIcon,     color: '#f472b6' },
    { id: 'office',      label: 'Office',         icon: BriefcaseIcon,       color: '#a78bfa' },
];

// ------------------------------------------------------------
// PAGES
//   href   — where the link goes
//   match  — extra path prefixes that count as "this page" (detail
//            pages, sub-pages) for highlighting and the breadcrumb
//   group  — one of NAV_GROUPS ids, or 'home'
//   keywords — extra words the search box matches on
// ------------------------------------------------------------
export const NAV_ITEMS = [
    { id: 'dashboard', label: 'Dashboard', href: '/', group: 'home', icon: HomeIcon,
      show: () => true, keywords: 'home overview start' },

    // ---- Money ------------------------------------------------
    { id: 'accounts', label: 'Accounts', href: '/accounts', group: 'money', icon: BuildingLibraryIcon,
      show: (c) => c.hasPermission('FINANCE_VIEW_ALL') && !c.isAdminOfficer, keywords: 'balances bank primary operational currency' },
    { id: 'transactions', label: 'Transactions', href: '/transactions', group: 'money', icon: BanknotesIcon,
      show: (c) => c.hasPermission('FINANCE_VIEW_ALL') && !c.isAdminOfficer, keywords: 'income expense inflow payment contribution' },
    { id: 'transfers', label: 'Transfers', href: '/transfers', group: 'money', icon: ArrowsRightLeftIcon,
      show: (c) => c.hasPermission('FINANCE_VIEW_ALL') && !c.isAdminOfficer, keywords: 'exchange rate eur ugx move money' },
    { id: 'requisitions', label: 'Requisitions', href: '/requisitions', group: 'money', icon: ClipboardDocumentListIcon,
      show: (c) => !c.isAdminOfficer, keywords: 'request funds spending approval' },
    // v1.73.0 — money entries by anyone who is not the Treasurer/Admin wait here
    { id: 'money-approvals', label: 'Awaiting approval', href: '/money-approvals', group: 'money', icon: ClockIcon,
      show: (c) => !c.isAdminOfficer && (c.hasRole(['Treasurer', 'Admin', 'Assistant Treasurer', 'Director'])
          || MONEY_ENTRY_PERMISSIONS.some(p => c.hasPermission(p))),
      keywords: 'approve approval pending held waiting four eyes money entry' },
    { id: 'acknowledgements', label: 'Acknowledgements', href: '/payment-acknowledgements', group: 'money', icon: CheckBadgeIcon,
      show: () => true, keywords: 'payment acknowledgement confirm received receipt' },

    // ---- Members' funds ---------------------------------------
    { id: 'savings', label: 'Savings', href: '/savings', group: 'members', icon: CircleStackIcon,
      show: (c) => c.hasFinancialAccess('SAVINGS_VIEW') && !c.isAdminOfficer, keywords: 'deposit handout interest' },
    { id: 'side-fund', label: 'Side fund', href: '/side-fund', group: 'members', icon: WalletIcon,
      show: (c) => c.hasFinancialAccess('SIDE_FUND_VIEW') && !c.isAdminOfficer, keywords: 'welfare pool' },
    { id: 'deposits', label: 'Deposits', href: '/deposits', group: 'members', icon: ArchiveBoxIcon,
      show: (c) => c.hasFinancialAccess('DEPOSIT_VIEW') && !c.isAdminOfficer, keywords: 'security deposit held' },
    { id: 'fines', label: 'Fines', href: '/fines', group: 'members', icon: ExclamationTriangleIcon,
      show: (c) => c.hasFinancialAccess('FINE_VIEW') && !c.isAdminOfficer, keywords: 'penalty late' },
    { id: 'share-capital', label: 'Share capital', href: '/share-capital', group: 'members', icon: ScaleIcon,
      show: (c) => c.hasFinancialAccess('FINANCE_VIEW_ALL') && !c.isAdminOfficer, keywords: 'shares allotment nominal value shareholder' },
    { id: 'dividends', label: 'Dividends', href: '/dividends', group: 'members', icon: CurrencyDollarIcon,
      show: (c) => c.hasPermission('FINANCE_VIEW_ALL') && !c.isAdminOfficer, keywords: 'profit distribution payout' },
    { id: 'capital-goals', label: 'Capital goals', href: '/capital-goals', group: 'members', icon: FlagIcon,
      show: (c) => c.hasPermission('CAPITAL_GOAL_VIEW') && !c.isAdminOfficer && c.capitalGoalTrackingEnabled,
      keywords: 'capital call monthly target contribution' },

    // ---- Investments ------------------------------------------
    { id: 'portfolio', label: 'Portfolio', href: '/investments', match: ['/mmf'], group: 'investments', icon: ChartBarIcon,
      show: (c) => (c.hasPermission('INVESTMENT_VIEW') || c.hasPermission('MMF_VIEW')) && !c.isAdminOfficer,
      keywords: 'investments money market mmf fixed deposit bond treasury bill t-bill' },
    { id: 'loans', label: 'Loans', href: '/loans', group: 'investments', icon: CreditCardIcon,
      show: (c) => c.hasPermission('LOAN_VIEW') && !c.isAdminOfficer, keywords: 'borrow lend repayment interest' },
    { id: 'grants', label: 'Grants', href: '/grants', group: 'investments', icon: GiftIcon,
      show: (c) => c.hasPermission('GRANT_VIEW') && !c.isAdminOfficer, keywords: 'funding donor' },

    // ---- Compliance -------------------------------------------
    { id: 'tax', label: 'Tax', href: '/tax', group: 'compliance', icon: ReceiptPercentIcon,
      show: (c) => !c.isAdminOfficer, keywords: 'withholding wht ura corporate income tax return' },
    { id: 'reports', label: 'Reports & ledger', href: '/reports', group: 'compliance', icon: ChartPieIcon,
      show: (c) => !c.isAdminOfficer, keywords: 'report general ledger trial balance balance sheet chart of accounts cash flow records check reconcile corrections' },
    { id: 'audit-management', label: 'External audit', href: '/audit-management', group: 'compliance', icon: DocumentMagnifyingGlassIcon,
      show: (c) => c.hasRole('Admin'), keywords: 'auditor engagement' },
    { id: 'audit-review', label: 'Audit review', href: '/audit-review', group: 'compliance', icon: ShieldCheckIcon,
      show: (c) => c.hasRole(['Director', 'Secretary']), keywords: 'auditor submissions extensions' },

    // ---- Office -----------------------------------------------
    { id: 'events', label: 'Events', href: '/events', group: 'office', icon: CalendarDaysIcon,
      show: (c) => c.hasPermission('EVENT_VIEW'), keywords: 'meeting calendar agm board' },
    // v1.79.0 — AGM / EGM / board meetings, register of attendance, resolutions
    { id: 'meetings', label: 'Meetings & resolutions', href: '/meetings', group: 'office', icon: BuildingOffice2Icon,
      show: (c) => !c.isAdminOfficer && (c.hasPermission('MEETING_VIEW') || c.hasPermission('MEETING_MANAGE')
          || c.hasRole(['Admin', 'Director', 'Secretary', 'Assistant Secretary', 'Shareholder'])),
      keywords: 'agm egm annual general meeting board minutes resolution special ordinary written proxy register attendance quorum ursb filing notice' },
    { id: 'documents', label: 'Documents', href: '/documents', group: 'office', icon: DocumentTextIcon,
      show: (c) => c.hasPermission('DOCUMENT_VIEW'), keywords: 'files minutes letters certificates templates' },
    { id: 'service-fees', label: 'Service fees', href: '/service-fees', group: 'office', icon: BriefcaseIcon,
      show: () => true, keywords: 'agreement fee staff contractor' },
    { id: 'members', label: 'Members', href: '/users', group: 'office', icon: UsersIcon,
      show: (c) => c.hasPermission('USER_VIEW_ALL'), keywords: 'users roles people shareholders' },
    { id: 'settings', label: 'Settings', href: '/settings', group: 'office', icon: Cog6ToothIcon,
      show: (c) => c.hasRole('Admin'), keywords: 'configuration currencies categories company' },
    { id: 'about', label: 'About', href: '/about', group: 'office', icon: InformationCircleIcon,
      show: () => true, keywords: 'help version' },
];

// Pages reached from the profile menu / user card rather than the menu.
export const PERSONAL_ITEMS = [
    { id: 'my-portfolio', label: 'My portfolio', href: '/portfolio', group: 'home', icon: ChartBarIcon, show: () => true,
      keywords: 'my shares my savings my standing' },
    { id: 'profile', label: 'My profile', href: '/profile', group: 'home', icon: UsersIcon, show: () => true,
      keywords: 'my details password tin signature' },
];

// The Auditor sees only their own page.
export const AUDITOR_ITEMS = [
    { id: 'audit', label: 'Audit', href: '/audit', group: 'home', icon: ShieldCheckIcon, show: () => true },
];

// ------------------------------------------------------------
// SHORTCUTS — pinned pages at the top of the sidebar. Up to 6.
// The defaults (chosen at the v1.71 design review) are shown until a
// person edits their own; anything they cannot see is skipped.
// ------------------------------------------------------------
export const DEFAULT_SHORTCUTS = ['transactions', 'tax', 'capital-goals'];
export const MAX_SHORTCUTS = 6;

// ------------------------------------------------------------
// "+ New" quick actions (top bar and phone bottom bar). Each opens the
// page with ?new=<kind>; the page opens its own form when it sees it.
// ------------------------------------------------------------
export const QUICK_ACTIONS = [
    { id: 'contribution', label: 'Record a contribution', href: '/transactions?new=contribution', needs: 'transactions',
      show: (c) => c.hasPermission('FINANCE_TRANSACTION_CREATE') && !c.isAdminOfficer },
    { id: 'expense', label: 'Record an expense', href: '/transactions?new=expense', needs: 'transactions',
      show: (c) => c.hasPermission('FINANCE_TRANSACTION_CREATE') && !c.isAdminOfficer },
    { id: 'transfer', label: 'Transfer between accounts', href: '/transfers?new=1', needs: 'transfers',
      show: (c) => c.hasPermission('FINANCE_TRANSFER_CREATE') && !c.isAdminOfficer },
    { id: 'requisition', label: 'New requisition', href: '/requisitions?new=1', needs: 'requisitions', show: (c) => !c.isAdminOfficer },
    { id: 'meeting', label: 'Convene a meeting', href: '/meetings?new=1', needs: 'meetings',
      show: (c) => !c.isAdminOfficer && (c.hasPermission('MEETING_MANAGE') || c.hasRole(['Admin', 'Director', 'Secretary', 'Assistant Secretary'])) },
    { id: 'event', label: 'New event', href: '/events?new=1', needs: 'events',
      show: (c) => c.hasPermission('EVENT_CREATE') },
    { id: 'document', label: 'Upload a document', href: '/documents?new=1', needs: 'documents',
      show: (c) => c.hasPermission('DOCUMENT_UPLOAD') },
    { id: 'generate', label: 'Generate a document', href: '/documents/generate', needs: 'documents',
      show: (c) => c.hasPermission('DOCUMENT_CREATE') },
];

// ------------------------------------------------------------
// Sub-pages that are not in the menu but deserve their own name in
// the breadcrumb (level 3). Detail pages with a record name set it
// themselves through PageHeader / useBreadcrumbTitle.
// ------------------------------------------------------------
export const SUB_PAGE_LABELS = [
    { pattern: /^\/reports\/chart-of-accounts/, label: 'Chart of accounts' },
    { pattern: /^\/reports\/general-ledger/,    label: 'General ledger' },
    { pattern: /^\/reports\/record-checks/,     label: 'Records check' }, // v1.72.0
    { pattern: /^\/documents\/generate/,        label: 'Generate document' },
    { pattern: /^\/meetings\/resolutions\/\d+/, label: 'Resolution' }, // v1.79.0
    { pattern: /^\/meetings\/\d+/,             label: 'Meeting' },
    { pattern: /^\/capital-goals\/my-calls/,    label: 'My capital calls' },
    { pattern: /^\/capital-goals\/monthly-calls\//, label: 'Monthly call' },
    { pattern: /^\/capital-goals\/\d+/,         label: 'Goal' },
    { pattern: /^\/investments\/\d+/,           label: 'Investment' },
    { pattern: /^\/mmf\/\d+/,                   label: 'Money market fund' },
    { pattern: /^\/loans\/received\/\d+/,       label: 'Loan received' },
    { pattern: /^\/loans\/given\/\d+/,          label: 'Loan given' },
    { pattern: /^\/users\/\d+\/portfolio/,      label: 'Member portfolio' },
    { pattern: /^\/service-fees\/agreements\//, label: 'Agreement' },
];

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
const pathMatches = (item, pathname) => {
    if (item.href === '/') return pathname === '/';
    const prefixes = [item.href, ...(item.match || [])];
    return prefixes.some(p => pathname === p || pathname.startsWith(p + '/'));
};

/** The menu item a path belongs to (the deepest match wins). */
export const findItemForPath = (pathname, items = [...NAV_ITEMS, ...PERSONAL_ITEMS, ...AUDITOR_ITEMS]) => {
    const hits = items.filter(i => pathMatches(i, pathname));
    hits.sort((a, b) => b.href.length - a.href.length);
    return hits[0] || null;
};

export const isItemActive = (item, pathname) => pathMatches(item, pathname);

export const groupById = (id) => NAV_GROUPS.find(g => g.id === id) || null;

/**
 * Breadcrumb trail for a path:
 *   [{ label: 'Investments' }, { label: 'Portfolio', href: '/investments' }, { label: 'Investment' }]
 * `detailTitle` (from the page itself) replaces the generic level-3 label.
 */
export const buildBreadcrumb = (pathname, detailTitle) => {
    const item = findItemForPath(pathname);
    if (!item) return [{ label: detailTitle || 'Page' }];
    const crumbs = [];
    const group = groupById(item.group);
    crumbs.push({ label: group ? group.label : 'Home', href: group ? null : '/' });
    const isExact = pathname === item.href;
    crumbs.push({ label: item.label, href: isExact ? null : item.href });
    if (!isExact) {
        const sub = SUB_PAGE_LABELS.find(s => s.pattern.test(pathname));
        crumbs.push({ label: detailTitle || (sub ? sub.label : 'Details') });
    }
    if (item.id === 'dashboard') return [{ label: 'Home', href: null }, { label: 'Dashboard' }];
    return crumbs;
};
