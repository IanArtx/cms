// ============================================================
// TOP BAR (v1.71.0 "Harbour")
//
//  ☰  Money › Transactions        [Search… Ctrl K]  Balances  + New  ☾  🔔  (you)
//
//  • Breadcrumb — where you are: group › page › record. Click a step
//    to go back up. On a phone only the current page name shows.
//  • Search (or Ctrl K / ⌘K anywhere) — finds pages by name and, for
//    staff, records (members, transactions, documents, investments,
//    events).
//  • Balances — the live account balances that used to sit in the
//    middle of this bar, now in a small panel so the bar stays calm.
//    Shown to the same roles as before (financial roles only).
//  • + New — quick links to the forms people use most (only the ones
//    this person is allowed to use).
//  • Sun / moon — switch light / dark. The profile menu also offers
//    "Same as my device".
//  • Bell — the same notifications as before (saved notifications plus
//    pending approvals and events in the next 7 days).
//  • (?) Help (v1.82.0) — take the guided tour, tour this page, or open
//    the manual for this page. The same tours are in the profile menu
//    (the only place on a phone).
// ============================================================

import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useTheme } from '../../contexts/ThemeContext';
import { useLayout } from './LayoutContext';
import { buildBreadcrumb } from './navConfig';
import { accountsAPI, eventsAPI, transfersAPI, grantsAPI, loansAPI, investmentsAPI, notificationsAPI, moneyApprovalsAPI } from '../../api/endpoints';
import GlobalSearch from './GlobalSearch';
import { useTour } from '../tour/TourProvider'; // v1.82.0
import { moduleForPath } from '../../guide/manualContent';
import Avatar from '../common/Avatar';
import {
    Bars3Icon,
    MagnifyingGlassIcon,
    BellIcon,
    UserIcon,
    ArrowRightOnRectangleIcon,
    CalendarDaysIcon,
    ClockIcon,
    ChevronRightIcon,
    PlusIcon,
    SunIcon,
    MoonIcon,
    ComputerDesktopIcon,
    BuildingLibraryIcon,
    ChartBarIcon,
    CheckIcon,
    PencilSquareIcon,
    QuestionMarkCircleIcon,
    MapIcon,
    BookOpenIcon,
    CursorArrowRaysIcon,
} from '@heroicons/react/24/outline';

// ============================================================
// RELATIVE TIME HELPER
// ============================================================
const timeAgo = (isoString) => {
    const seconds = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(isoString).toLocaleDateString('en-GB');
};

const fmtBalance = (n) => parseFloat(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });

// Small popover shell used by every menu in the bar.
// v1.77.0 — on a phone (narrower than 640px) the panel no longer hangs
// off the button it belongs to (which pushed it off the left edge of
// the screen): it spans the screen with a 12px margin each side, starts
// just under the top bar and stops above the bottom menu bar, scrolling
// inside itself.
const PHONE_QUERY = '(max-width: 639px)';
const Popover = ({ open, onClose, children, width = 320, align = 'right', label }) => {
    const ref = useRef(null);
    const [phone, setPhone] = useState(() => typeof window !== 'undefined' && window.matchMedia
        ? window.matchMedia(PHONE_QUERY).matches : false);
    const [top, setTop] = useState(64);
    useEffect(() => {
        if (!open) return undefined;
        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [open, onClose]);
    useEffect(() => {
        if (!window.matchMedia) return undefined;
        const mq = window.matchMedia(PHONE_QUERY);
        const onChange = () => setPhone(mq.matches);
        onChange();
        if (mq.addEventListener) mq.addEventListener('change', onChange); else mq.addListener(onChange);
        return () => { if (mq.removeEventListener) mq.removeEventListener('change', onChange); else mq.removeListener(onChange); };
    }, []);
    // Where the top bar ends — the panel starts 8px below it.
    useLayoutEffect(() => {
        if (!open || !phone || !ref.current) return;
        const bar = ref.current.closest('header') || ref.current.parentElement;
        const bottom = bar ? bar.getBoundingClientRect().bottom : 56;
        setTop(Math.max(8, Math.round(bottom + 8)));
    }, [open, phone]);
    if (!open) return null;
    const phoneStyle = {
        position: 'fixed', left: 12, right: 12, top, width: 'auto', maxWidth: 'none',
        // 88px keeps it clear of the bottom menu bar (and the phone's own home bar).
        maxHeight: `calc(100dvh - ${top}px - 88px - env(safe-area-inset-bottom, 0px))`,
    };
    const desktopStyle = {
        width, maxWidth: 'calc(100vw - 24px)', maxHeight: 'min(640px, calc(100dvh - 88px))',
    };
    return (
        <>
            <div className="fixed inset-0 z-30" onClick={onClose} aria-hidden="true" />
            <div
                ref={ref}
                role="dialog"
                aria-label={label}
                className={`${phone ? '' : `absolute top-[calc(100%+8px)] ${align === 'right' ? 'right-0' : 'left-0'}`} z-40 rounded-xl border overflow-hidden flex flex-col`}
                style={{
                    ...(phone ? phoneStyle : desktopStyle),
                    backgroundColor: 'var(--cms-surface)', borderColor: 'var(--cms-border)', boxShadow: 'var(--cms-shadow-pop)',
                }}
            >
                {children}
            </div>
        </>
    );
};

const TopBar = ({ onLogoutClick }) => {
    const { user, hasPermission, hasRole, hasFinancialAccess } = useAuth();
    const { mode, isDark, setMode, toggle: toggleTheme } = useTheme();
    const {
        setMobileOpen, detailTitle, quickActions, visibleItems,
        notifOpen, setNotifOpen, newOpen, setNewOpen,
    } = useLayout();
    // The Auditor role is external and non-member — company-wide
    // balances and the computed "upcoming events / pending approvals"
    // feed are never fetched or shown for them (the backend blocks the
    // underlying endpoints too).
    const isAuditor = hasRole('Auditor');
    // Administrative Officer (v1.21.0): no balances, no RECORD search
    // (page search is fine — it only lists pages they can already see).
    const isAdminOfficer = hasRole('Administrative Officer');
    const isFinanceBlockedRole = isAuditor || isAdminOfficer;
    // v1.36.0 — balances follow the default financial-role allow-list.
    const canSeeFinance = hasFinancialAccess('FINANCE_VIEW_ALL');
    const navigate     = useNavigate();
    const location     = useLocation();
    const [userMenuOpen,  setUserMenuOpen]  = useState(false);
    const [helpOpen,      setHelpOpen]      = useState(false); // v1.82.0
    const { startMainTour, startPageTour, pageTour } = useTour();
    const manualModule = moduleForPath(location.pathname);
    const [balancesOpen,  setBalancesOpen]  = useState(false);
    const [searchOpen,    setSearchOpen]    = useState(false);
    const [notifications, setNotifications] = useState([]);
    const [accountSummary, setAccountSummary] = useState([]);

    // Persisted, per-user notifications (bell + auto-email triggers) —
    // distinct from the computed "action items" list, which has no
    // read state.
    const [dbNotifs,       setDbNotifs]       = useState([]);
    const [dbUnreadCount,  setDbUnreadCount]  = useState(0);

    const crumbs = buildBreadcrumb(location.pathname, detailTitle);
    const current = crumbs[crumbs.length - 1];

    // Ctrl K / ⌘K opens search from anywhere (not for the Auditor).
    useEffect(() => {
        if (isAuditor) return undefined;
        const onKey = (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                setSearchOpen(true);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [isAuditor]);

    // --------------------------------------------------------
    // LOAD NOTIFICATIONS
    // Combines upcoming events + pending approvals
    // --------------------------------------------------------
    useEffect(() => {
        // Auditors never see company-wide balances or the computed
        // events/approvals feed — skip both fetches entirely instead of
        // relying on the API calls to fail quietly.
        if (isAuditor) {
            setNotifications([]);
            setAccountSummary([]);
            return;
        }

        const loadNotifications = async () => {
            const notifs = [];

            // Upcoming events (next 7 days)
            try {
                const eventsRes = await eventsAPI.getUpcoming(7);
                const events = eventsRes.data.data || [];
                events.forEach(e => {
                    notifs.push({
                        id:      `event-${e.id}`,
                        type:    'event',
                        title:   e.title,
                        message: `${e.event_type} in ${e.days_until_event} day(s)`,
                        urgent:  e.days_until_event <= 3,
                        icon:    CalendarDaysIcon,
                        link:    '/events',
                        color:   e.days_until_event <= 3 ? '#d97706' : '#2563eb',
                        bg:      e.days_until_event <= 3 ? '#fef3c7' : '#eff6ff',
                    });
                });
            } catch {}

            // v1.73.0 — money entries held for the Treasurer/Admin's approval
            if (hasRole(['Treasurer', 'Admin'])) {
                try {
                    const heldRes = await moneyApprovalsAPI.getAll({ status: 'PENDING' });
                    const held = (heldRes.data.data || []).filter(h => Number(h.created_by) !== Number(user?.id)).slice(0, 5);
                    held.forEach(h => {
                        notifs.push({
                            id:      `held-${h.id}`,
                            type:    'approval',
                            title:   `${h.label} awaiting approval`,
                            message: `${h.amount ? `${h.currency_code || ''} ${parseFloat(h.amount).toLocaleString('en-US', { maximumFractionDigits: 2 })} — ` : ''}recorded by ${h.created_by_name}`,
                            urgent:  true,
                            icon:    ClockIcon,
                            link:    '/money-approvals',
                            color:   '#7c3aed',
                            bg:      '#f5f3ff',
                        });
                    });
                } catch {}
            }

            // Pending transfers awaiting approval
            if (hasPermission('FINANCE_TRANSFER_APPROVE')) {
                try {
                    const transfersRes = await transfersAPI.getAll({
                        status: 'AWAITING_APPROVAL', limit: 5
                    });
                    const transfers = transfersRes.data.data || [];
                    transfers.forEach(t => {
                        notifs.push({
                            id:      `transfer-${t.id}`,
                            type:    'approval',
                            title:   `Transfer Awaiting Approval`,
                            message: `${t.from_currency} ${parseFloat(t.amount_sent).toLocaleString('en-US', { maximumFractionDigits: 2 })} — ${t.from_account} → ${t.to_account}`,
                            urgent:  true,
                            icon:    ClockIcon,
                            link:    '/transfers',
                            color:   '#dc2626',
                            bg:      '#fef2f2',
                        });
                    });
                } catch {}
            }

            // Pending grants
            if (hasPermission('GRANT_APPROVE')) {
                try {
                    const grantsRes = await grantsAPI.getAll({
                        status: 'PENDING', limit: 5
                    });
                    const grants = grantsRes.data.data || [];
                    grants.forEach(g => {
                        notifs.push({
                            id:      `grant-${g.id}`,
                            type:    'approval',
                            title:   `Grant Pending Approval`,
                            message: `${g.title} — ${g.grantor_name}`,
                            urgent:  false,
                            icon:    ClockIcon,
                            link:    '/grants',
                            color:   '#7c3aed',
                            bg:      '#f5f3ff',
                        });
                    });
                } catch {}
            }

            // Pending loans
            if (hasPermission('LOAN_APPROVE')) {
                try {
                    const loansRes = await loansAPI.getAllReceived({
                        status: 'PENDING', limit: 5
                    });
                    const loans = loansRes.data.data || [];
                    loans.forEach(l => {
                        notifs.push({
                            id:      `loan-${l.id}`,
                            type:    'approval',
                            title:   `Loan Pending Approval`,
                            message: `${l.lender_name} — ${l.currency_code} ${parseFloat(l.principal_amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}`,
                            urgent:  false,
                            icon:    ClockIcon,
                            link:    '/loans',
                            color:   '#059669',
                            bg:      '#ecfdf5',
                        });
                    });
                } catch {}
            }

            // Pending investments
            if (hasPermission('INVESTMENT_APPROVE')) {
                try {
                    const investRes = await investmentsAPI.getAll({
                        status: 'PENDING', limit: 5
                    });
                    const investments = investRes.data.data || [];
                    investments.forEach(i => {
                        notifs.push({
                            id:      `invest-${i.id}`,
                            type:    'approval',
                            title:   `Investment Pending Approval`,
                            message: `${i.name} — ${i.currency_code} ${parseFloat(i.planned_budget).toLocaleString('en-US', { maximumFractionDigits: 2 })}`,
                            urgent:  false,
                            icon:    ClockIcon,
                            link:    '/investments',
                            color:   '#d97706',
                            bg:      '#fffbeb',
                        });
                    });
                } catch {}
            }

            setNotifications(notifs);
        };

        loadNotifications();
        // Account balances are finance data — v1.36.0: only fetched for
        // the default financial roles (or an explicit FINANCE_VIEW_ALL
        // grant), matching the same rule now enforced on the backend's
        // GET /accounts/summary. Previously this only skipped the two
        // fully finance-restricted roles (Auditor, Administrative
        // Officer) and fetched for literally everyone else, including
        // Secretary/Assistant Secretary/Coordinator.
        if (canSeeFinance) {
            accountsAPI.getSummary()
                .then(res => setAccountSummary(res.data.data || []))
                .catch(() => {});
        } else {
            setAccountSummary([]);
        }
    }, [location.pathname, hasPermission, hasRole, user?.id, isAuditor, canSeeFinance]);

    // --------------------------------------------------------
    // LOAD & POLL PERSISTED NOTIFICATIONS
    // Fetches the bell's recent items + unread count on mount and
    // every 60 seconds, so new auto-notifications (contribution
    // recorded, requisition approved, etc.) show up without a
    // full page reload.
    // --------------------------------------------------------
    useEffect(() => {
        const loadDbNotifications = async () => {
            try {
                const [listRes, countRes] = await Promise.all([
                    notificationsAPI.getAll({ limit: 8 }),
                    notificationsAPI.getUnreadCount(),
                ]);
                setDbNotifs(listRes.data.data.notifications || []);
                setDbUnreadCount(countRes.data.data.count || 0);
            } catch {}
        };

        loadDbNotifications();
        const interval = setInterval(loadDbNotifications, 60000);
        return () => clearInterval(interval);
    }, []);

    const urgentCount = notifications.filter(n => n.urgent).length;
    const totalCount  = notifications.length;
    const badgeCount  = dbUnreadCount + totalCount;

    // --------------------------------------------------------
    // MARK ONE NOTIFICATION READ, THEN NAVIGATE
    // --------------------------------------------------------
    const handleNotifClick = async (notif) => {
        setNotifOpen(false);
        if (!notif.is_read) {
            try {
                await notificationsAPI.markAsRead(notif.id);
                setDbNotifs(prev => prev.map(n =>
                    n.id === notif.id ? { ...n, is_read: true } : n
                ));
                setDbUnreadCount(prev => Math.max(0, prev - 1));
            } catch {}
        }
        if (notif.link) navigate(notif.link);
    };

    // --------------------------------------------------------
    // MARK ALL AS READ
    // --------------------------------------------------------
    const handleMarkAllRead = async (e) => {
        e.stopPropagation();
        try {
            await notificationsAPI.markAllAsRead();
            setDbNotifs(prev => prev.map(n => ({ ...n, is_read: true })));
            setDbUnreadCount(0);
        } catch {}
    };

    const closeAll = () => { setUserMenuOpen(false); setNotifOpen(false); setBalancesOpen(false); setNewOpen(false); setHelpOpen(false); };

    // v1.82.0 — the help entries, shared by the (?) menu and the profile menu.
    const helpItems = isAuditor ? [] : [
        { id: 'tour', label: 'Take the guided tour', icon: MapIcon, run: () => startMainTour() },
        { id: 'page', label: pageTour ? `Tour this page` : 'Tour this page (none here)', icon: CursorArrowRaysIcon, disabled: !pageTour, run: () => startPageTour() },
        { id: 'manual', label: manualModule ? 'Manual for this page' : 'Open the user manual', icon: BookOpenIcon,
          run: () => navigate(manualModule ? `/about?tab=manual&section=${manualModule.id}` : '/about?tab=manual') },
    ];
    const runHelp = (h) => { closeAll(); if (!h.disabled) setTimeout(h.run, 60); };

    const iconBtn = 'relative inline-flex items-center justify-center w-10 h-10 rounded-[10px] border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500';
    const iconBtnStyle = (active) => ({
        backgroundColor: active ? 'var(--cms-surface-hover)' : 'var(--cms-surface)',
        borderColor: 'var(--cms-border)',
        color: 'var(--cms-text-secondary)',
    });

    const themeChoices = [
        { id: 'light',  label: 'Light',               icon: SunIcon },
        { id: 'dark',   label: 'Dark',                icon: MoonIcon },
        { id: 'system', label: 'Same as my device',   icon: ComputerDesktopIcon },
    ];

    return (
        <header
            className="h-16 flex-shrink-0 flex items-center gap-2 sm:gap-3 px-3 sm:px-5 lg:px-6 sticky top-0 z-30"
            style={{ backgroundColor: 'var(--cms-surface)', borderBottom: '1px solid var(--cms-border)' }}
        >
            {/* ☰ — phones and tablets */}
            <button
                type="button"
                onClick={() => setMobileOpen(true)}
                className="md:hidden inline-flex items-center justify-center w-11 h-11 -ml-1 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                style={{ color: 'var(--cms-text-primary)' }}
                aria-label="Open menu"
            >
                <Bars3Icon className="w-6 h-6" />
            </button>

            {/* Breadcrumb (full on sm+, current page only on phones) */}
            <nav aria-label="Breadcrumb" data-tour="breadcrumb" className="min-w-0 flex-1">
                <ol className="hidden sm:flex items-center gap-1.5 text-sm min-w-0" style={{ color: 'var(--cms-text-muted)' }}>
                    {crumbs.map((c, i) => {
                        const last = i === crumbs.length - 1;
                        return (
                            <li key={`${c.label}-${i}`} className={`flex items-center gap-1.5 ${last ? 'min-w-0' : 'flex-shrink-0'}`}>
                                {i > 0 && <ChevronRightIcon className="w-3.5 h-3.5 flex-shrink-0 opacity-70" aria-hidden="true" />}
                                {last
                                    ? <span aria-current="page" className="font-semibold truncate" style={{ color: 'var(--cms-text-primary)' }}>{c.label}</span>
                                    : c.href
                                        ? <Link to={c.href} className="hover:underline rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500" style={{ color: 'var(--cms-text-muted)' }}>{c.label}</Link>
                                        : <span>{c.label}</span>}
                            </li>
                        );
                    })}
                </ol>
                <p className="sm:hidden text-[17px] font-bold truncate" style={{ color: 'var(--cms-text-primary)' }}>{current?.label}</p>
            </nav>

            {/* Search */}
            {!isAuditor && (
                <>
                    <button
                        type="button"
                        data-tour="search"
                        onClick={() => setSearchOpen(true)}
                        className="hidden lg:flex items-center gap-2 w-[300px] xl:w-[360px] h-10 px-3 rounded-[10px] border text-sm text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                        style={{ backgroundColor: 'var(--cms-bg)', borderColor: 'var(--cms-border)', color: 'var(--cms-text-muted)' }}
                    >
                        <MagnifyingGlassIcon className="w-4 h-4 flex-shrink-0" />
                        <span className="flex-1 truncate">{isFinanceBlockedRole ? 'Search pages…' : 'Search pages, records, references…'}</span>
                        <kbd className="text-[11px] font-semibold rounded-md border px-1.5 py-px font-sans" style={{ borderColor: 'var(--cms-border-strong)', color: 'var(--cms-text-secondary)' }}>Ctrl K</kbd>
                    </button>
                    <button type="button" data-tour="search" onClick={() => setSearchOpen(true)} className={`${iconBtn} lg:hidden`} style={iconBtnStyle(false)} aria-label="Search">
                        <MagnifyingGlassIcon className="w-5 h-5" />
                    </button>
                </>
            )}

            {/* Balances */}
            {canSeeFinance && accountSummary.length > 0 && (
                <div className="relative hidden sm:block">
                    <button
                        type="button"
                        data-tour="balances"
                        onClick={() => { const o = !balancesOpen; closeAll(); setBalancesOpen(o); }}
                        className={`${iconBtn} xl:w-auto xl:px-3 xl:gap-2`}
                        style={iconBtnStyle(balancesOpen)}
                        aria-label="Account balances"
                        aria-expanded={balancesOpen}
                    >
                        <BuildingLibraryIcon className="w-5 h-5" />
                        <span className="hidden xl:inline text-sm font-semibold">Balances</span>
                    </button>
                    <Popover open={balancesOpen} onClose={() => setBalancesOpen(false)} width={320} label="Account balances">
                        <div className="px-4 py-3 border-b" style={{ borderColor: 'var(--cms-surface-divider)' }}>
                            <p className="text-sm font-bold" style={{ color: 'var(--cms-text-primary)' }}>Account balances</p>
                            <p className="text-xs" style={{ color: 'var(--cms-text-muted)' }}>Live, as recorded in the system</p>
                        </div>
                        <div className="p-2 overflow-y-auto">
                            {accountSummary.map((a, i) => (
                                <div key={i} className="flex items-center gap-3 px-2 py-2.5 rounded-lg">
                                    <span className="w-9 h-9 rounded-lg flex items-center justify-center text-[11px] font-bold flex-shrink-0 bg-primary-50 text-primary-700">
                                        {a.currency_code}
                                    </span>
                                    <span className="min-w-0 flex-1">
                                        <span className="block text-sm truncate" style={{ color: 'var(--cms-text-secondary)' }}>{a.name}</span>
                                        <span className="block text-base font-bold num" style={{ color: 'var(--cms-text-primary)' }}>
                                            {a.currency_code} {fmtBalance(a.current_balance)}
                                        </span>
                                    </span>
                                </div>
                            ))}
                        </div>
                        <Link to="/accounts" onClick={() => setBalancesOpen(false)} className="block text-center text-sm font-semibold py-2.5 border-t text-primary-700" style={{ borderColor: 'var(--cms-surface-divider)' }}>
                            Open Accounts
                        </Link>
                    </Popover>
                </div>
            )}

            {/* + New */}
            {quickActions.length > 0 && (
                <div className="relative hidden md:block">
                    <button
                        type="button"
                        data-tour="new"
                        onClick={() => { const o = !newOpen; closeAll(); setNewOpen(o); }}
                        className="btn-primary !px-3.5"
                        aria-expanded={newOpen}
                        aria-haspopup="menu"
                    >
                        <PlusIcon className="w-4 h-4" strokeWidth={2.4} />
                        New
                    </button>
                    <Popover open={newOpen} onClose={() => setNewOpen(false)} width={260} label="Create something new">
                        <div className="p-1.5" role="menu">
                            {quickActions.map(a => (
                                <button
                                    key={a.id}
                                    type="button"
                                    role="menuitem"
                                    onClick={() => { setNewOpen(false); navigate(a.href); }}
                                    className="w-full text-left flex items-center gap-2.5 px-3 h-10 rounded-lg text-sm hover:bg-gray-100"
                                    style={{ color: 'var(--cms-text-primary)' }}
                                >
                                    <PlusIcon className="w-4 h-4 text-primary-600" />
                                    {a.label}
                                </button>
                            ))}
                        </div>
                    </Popover>
                </div>
            )}

            {/* Light / dark */}
            <button
                type="button"
                onClick={toggleTheme}
                data-tour="theme"
                className={`${iconBtn} hidden sm:inline-flex`}
                style={{ ...iconBtnStyle(false), color: isDark ? '#fbbf24' : 'var(--cms-text-secondary)' }}
                aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
                title={isDark ? 'Light mode' : 'Dark mode'}
            >
                {isDark ? <SunIcon className="w-5 h-5" /> : <MoonIcon className="w-5 h-5" />}
            </button>

            {/* v1.82.0 — Help: guided tour, this page's tour, the manual */}
            {!isAuditor && (
                <div className="relative hidden sm:block">
                    <button
                        type="button"
                        data-tour="help"
                        onClick={() => { const o = !helpOpen; closeAll(); setHelpOpen(o); }}
                        className={iconBtn}
                        style={iconBtnStyle(helpOpen)}
                        aria-label="Help: guided tour and manual"
                        title="Help"
                        aria-expanded={helpOpen}
                        aria-haspopup="menu"
                    >
                        <QuestionMarkCircleIcon className="w-5 h-5" />
                    </button>
                    <Popover open={helpOpen} onClose={() => setHelpOpen(false)} width={270} label="Help">
                        <div className="px-4 py-3 border-b" style={{ borderColor: 'var(--cms-surface-divider)' }}>
                            <p className="text-sm font-bold" style={{ color: 'var(--cms-text-primary)' }}>Help</p>
                            <p className="text-xs" style={{ color: 'var(--cms-text-muted)' }}>{pageTour ? `On this page: ${pageTour.title}` : 'Tours and the user manual'}</p>
                        </div>
                        <div className="p-1.5" role="menu">
                            {helpItems.map(h => (
                                <button key={h.id} type="button" role="menuitem" disabled={h.disabled} onClick={() => runHelp(h)}
                                    className="w-full text-left flex items-center gap-2.5 px-3 h-10 rounded-lg text-sm hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
                                    style={{ color: 'var(--cms-text-primary)' }}>
                                    <h.icon className="w-4 h-4 text-primary-600" /> {h.label}
                                </button>
                            ))}
                        </div>
                    </Popover>
                </div>
            )}

            {/* Notifications */}
            <div className="relative">
                <button
                    type="button"
                    data-tour="bell"
                    onClick={() => { const o = !notifOpen; closeAll(); setNotifOpen(o); }}
                    className={iconBtn}
                    style={iconBtnStyle(notifOpen)}
                    aria-label={badgeCount > 0 ? `Notifications, ${badgeCount} new` : 'Notifications'}
                    aria-expanded={notifOpen}
                >
                    <BellIcon className="w-5 h-5" />
                    {badgeCount > 0 && (
                        <span className={`absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full text-[11px] font-bold flex items-center justify-center text-white ${(urgentCount > 0 || dbUnreadCount > 0) ? 'bg-rose-600' : 'bg-primary-600'}`}>
                            {badgeCount > 9 ? '9+' : badgeCount}
                        </span>
                    )}
                </button>
                <Popover open={notifOpen} onClose={() => setNotifOpen(false)} width={380} label="Notifications">
                    <div className="px-4 py-3 border-b flex items-center justify-between flex-shrink-0" style={{ borderColor: 'var(--cms-surface-divider)' }}>
                        <p className="text-sm font-bold" style={{ color: 'var(--cms-text-primary)' }}>Notifications</p>
                        <div className="flex items-center gap-2">
                            {dbUnreadCount > 0 && (
                                <button type="button" onClick={handleMarkAllRead} className="text-xs font-semibold text-primary-700 hover:underline">
                                    Mark all read
                                </button>
                            )}
                            {urgentCount > 0 && <span className="badge-red">{urgentCount} urgent</span>}
                        </div>
                    </div>
                    <div className="overflow-y-auto">
                        {dbNotifs.map(notif => (
                            <button
                                type="button"
                                key={`db-${notif.id}`}
                                onClick={() => handleNotifClick(notif)}
                                className="w-full text-left px-4 py-2.5 border-b flex items-start gap-2.5 hover:bg-gray-50"
                                style={{ borderColor: 'var(--cms-surface-divider)', backgroundColor: notif.is_read ? undefined : 'var(--cms-surface-hover)' }}
                            >
                                <span className="w-2 h-2 mt-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: notif.is_read ? 'transparent' : '#2563eb' }} />
                                <span className="flex-1 min-w-0">
                                    <span className={`block text-[13px] ${notif.is_read ? 'font-medium' : 'font-bold'}`} style={{ color: 'var(--cms-text-primary)' }}>{notif.title}</span>
                                    {notif.body && (
                                        <span className="block text-xs mt-0.5 line-clamp-2" style={{ color: 'var(--cms-text-secondary)' }}>{notif.body}</span>
                                    )}
                                    <span className="block text-[11px] mt-0.5" style={{ color: 'var(--cms-text-muted)' }}>{timeAgo(notif.created_at)}</span>
                                </span>
                            </button>
                        ))}
                        {notifications.map(notif => (
                            <button
                                type="button"
                                key={notif.id}
                                onClick={() => { navigate(notif.link); setNotifOpen(false); }}
                                className="w-full text-left px-4 py-3 border-b flex items-start gap-3 hover:bg-gray-50"
                                style={{ borderColor: 'var(--cms-surface-divider)' }}
                            >
                                <span className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style={{ backgroundColor: `${notif.color}22` }}>
                                    <notif.icon className="w-4 h-4" style={{ color: notif.color }} />
                                </span>
                                <span className="flex-1 min-w-0">
                                    <span className="flex items-center gap-1.5">
                                        <span className="text-[13px] font-semibold" style={{ color: 'var(--cms-text-primary)' }}>{notif.title}</span>
                                        {notif.urgent && <span className="badge-red !text-[10px] !px-1.5">URGENT</span>}
                                    </span>
                                    <span className="block text-xs truncate" style={{ color: 'var(--cms-text-secondary)' }}>{notif.message}</span>
                                </span>
                            </button>
                        ))}
                        {dbNotifs.length === 0 && notifications.length === 0 && (
                            <p className="px-6 py-8 text-center text-sm" style={{ color: 'var(--cms-text-muted)' }}>You're all caught up.</p>
                        )}
                    </div>
                    <p className="px-4 py-2.5 text-center text-[11px] border-t flex-shrink-0" style={{ borderColor: 'var(--cms-surface-divider)', color: 'var(--cms-text-muted)' }}>
                        {isAuditor ? 'Showing your audit submission updates' : 'Showing pending approvals and events in the next 7 days'}
                    </p>
                </Popover>
            </div>

            {/* You */}
            <div className="relative">
                <button
                    type="button"
                    data-tour="profile"
                    onClick={() => { const o = !userMenuOpen; closeAll(); setUserMenuOpen(o); }}
                    className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
                    aria-label="Your account menu"
                    aria-expanded={userMenuOpen}
                >
                    <Avatar user={user} size={40} />
                </button>
                <Popover open={userMenuOpen} onClose={() => setUserMenuOpen(false)} width={260} label="Your account">
                    <div className="px-4 py-3 border-b" style={{ borderColor: 'var(--cms-surface-divider)' }}>
                        <p className="text-sm font-bold truncate" style={{ color: 'var(--cms-text-primary)' }}>{user?.first_name} {user?.last_name}</p>
                        <p className="text-xs truncate" style={{ color: 'var(--cms-text-muted)' }}>{user?.email}</p>
                    </div>
                    <div className="p-1.5">
                        <button type="button" onClick={() => { setUserMenuOpen(false); navigate('/profile'); }}
                            className="w-full flex items-center gap-2.5 px-3 h-10 rounded-lg text-sm hover:bg-gray-100" style={{ color: 'var(--cms-text-primary)' }}>
                            <UserIcon className="w-4 h-4" style={{ color: 'var(--cms-text-muted)' }} /> My profile
                        </button>
                        {/* v1.81.0 — forms started and not yet submitted */}
                        <button type="button" onClick={() => { setUserMenuOpen(false); navigate('/drafts'); }}
                            className="w-full flex items-center gap-2.5 px-3 h-10 rounded-lg text-sm hover:bg-gray-100" style={{ color: 'var(--cms-text-primary)' }}>
                            <PencilSquareIcon className="w-4 h-4" style={{ color: 'var(--cms-text-muted)' }} /> Unfinished forms
                        </button>
                        {!isAuditor && (
                            <button type="button" onClick={() => { setUserMenuOpen(false); navigate('/portfolio'); }}
                                className="w-full flex items-center gap-2.5 px-3 h-10 rounded-lg text-sm hover:bg-gray-100" style={{ color: 'var(--cms-text-primary)' }}>
                                <ChartBarIcon className="w-4 h-4" style={{ color: 'var(--cms-text-muted)' }} /> My portfolio
                            </button>
                        )}
                    </div>
                    {/* v1.82.0 — guided tours (the only help entry point on a phone) */}
                    {helpItems.length > 0 && (
                        <>
                            <div className="px-4 pt-2 pb-1 border-t" style={{ borderColor: 'var(--cms-surface-divider)' }}>
                                <p className="text-[11px] font-bold tracking-[0.08em]" style={{ color: 'var(--cms-text-muted)' }}>HELP</p>
                            </div>
                            <div className="p-1.5 pt-0">
                                {helpItems.map(h => (
                                    <button key={h.id} type="button" disabled={h.disabled} onClick={() => runHelp(h)}
                                        className="w-full flex items-center gap-2.5 px-3 h-10 rounded-lg text-sm hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed" style={{ color: 'var(--cms-text-primary)' }}>
                                        <h.icon className="w-4 h-4" style={{ color: 'var(--cms-text-muted)' }} /> {h.label}
                                    </button>
                                ))}
                            </div>
                        </>
                    )}
                    <div className="px-4 pt-2 pb-1 border-t" style={{ borderColor: 'var(--cms-surface-divider)' }}>
                        <p className="text-[11px] font-bold tracking-[0.08em]" style={{ color: 'var(--cms-text-muted)' }}>APPEARANCE</p>
                    </div>
                    <div className="p-1.5 pt-0" role="radiogroup" aria-label="Appearance">
                        {themeChoices.map(t => (
                            <button key={t.id} type="button" role="radio" aria-checked={mode === t.id} onClick={() => setMode(t.id)}
                                className="w-full flex items-center gap-2.5 px-3 h-10 rounded-lg text-sm hover:bg-gray-100" style={{ color: 'var(--cms-text-primary)' }}>
                                <t.icon className="w-4 h-4" style={{ color: 'var(--cms-text-muted)' }} />
                                <span className="flex-1 text-left">{t.label}</span>
                                {mode === t.id && <CheckIcon className="w-4 h-4 text-primary-600" />}
                            </button>
                        ))}
                    </div>
                    <div className="p-1.5 border-t" style={{ borderColor: 'var(--cms-surface-divider)' }}>
                        <button type="button" onClick={() => { setUserMenuOpen(false); onLogoutClick?.(); }}
                            className="w-full flex items-center gap-2.5 px-3 h-10 rounded-lg text-sm font-semibold text-red-700 hover:bg-red-50">
                            <ArrowRightOnRectangleIcon className="w-4 h-4" /> Sign out
                        </button>
                    </div>
                </Popover>
            </div>

            <GlobalSearch
                isOpen={searchOpen}
                onClose={() => setSearchOpen(false)}
                pages={visibleItems}
                recordsAllowed={!isFinanceBlockedRole}
            />
        </header>
    );
};

export default TopBar;
