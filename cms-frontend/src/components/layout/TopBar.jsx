// ============================================================
// TOP BAR
// Shows current page title, live account balances,
// approval notifications and user menu.
// ============================================================

import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useBranding } from '../../contexts/BrandingContext';
import { accountsAPI, eventsAPI, transfersAPI, grantsAPI, loansAPI, investmentsAPI, notificationsAPI } from '../../api/endpoints';
import GlobalSearch from './GlobalSearch';
import Avatar from '../common/Avatar';
import {
    Bars3Icon,
    MagnifyingGlassIcon,
    BellIcon,
    UserIcon,
    ArrowRightOnRectangleIcon,
    CalendarDaysIcon,
    ExclamationTriangleIcon,
    ClockIcon,
    CheckCircleIcon,
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

// ============================================================
// PAGE TITLE MAP
// ============================================================
const PAGE_TITLES = {
    '/':            'Dashboard',
    '/accounts':    'Accounts',
    '/transactions':'Transactions',
    '/transfers':   'Transfers',
    '/grants':      'Grants',
    '/loans':       'Loans',
    '/investments': 'Investments',
    '/events':      'Events',
    '/documents':   'Documents',
    '/reports':     'Reports',
    '/users':       'Members',
    '/profile':     'My Profile',
    '/settings':    'Settings',
    '/dividends':   'Dividends',
};

const TopBar = ({ onMenuClick, onLogoutClick }) => {
    const { user, hasPermission, hasRole } = useAuth();
    // The Auditor role is external and non-member — the account
    // balances and the computed "upcoming events / pending approvals"
    // notifications below are company-wide, not scoped to any one
    // engagement, so they must never be fetched or shown here for an
    // Auditor (the backend also blocks the underlying endpoints for
    // this role — see middleware/auth.js blockFinanceRestricted — this
    // is the matching frontend-side guard so the UI doesn't even try).
    const isAuditor = hasRole('Auditor');
    // Administrative Officer (v1.21.0): a hired/contracted staff role
    // that also must never see company balances or company-wide
    // search — but UNLIKE the Auditor, this role legitimately manages
    // Events, so the upcoming-events fetch below stays on for them;
    // only the balance fetch and the search button are skipped.
    const isAdminOfficer = hasRole('Administrative Officer');
    const isFinanceBlockedRole = isAuditor || isAdminOfficer;
    const { branding } = useBranding();
    const navigate     = useNavigate();
    const location     = useLocation();
    const [userMenuOpen,  setUserMenuOpen]  = useState(false);
    const [notifOpen,     setNotifOpen]     = useState(false);
    const [searchOpen,    setSearchOpen]    = useState(false);
    const [notifications, setNotifications] = useState([]);
    const [accountSummary, setAccountSummary] = useState([]);

    // Persisted, per-user notifications from the generic notifications
    // system (bell + auto-email triggers wired across the app) — distinct
    // from the computed "action items" list above, which has no read state.
    const [dbNotifs,       setDbNotifs]       = useState([]);
    const [dbUnreadCount,  setDbUnreadCount]  = useState(0);

    const pageTitle = PAGE_TITLES[location.pathname] || 'Company Management System';

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
        // Account balances are finance data — skip the fetch entirely
        // for both finance-restricted roles (Auditor never reaches this
        // line at all thanks to the early return above; Administrative
        // Officer does reach it, since they still get the events fetch).
        if (isFinanceBlockedRole) {
            setAccountSummary([]);
        } else {
            accountsAPI.getSummary()
                .then(res => setAccountSummary(res.data.data || []))
                .catch(() => {});
        }
    }, [location.pathname, hasPermission, isAuditor, isFinanceBlockedRole]);

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

    // Opens the shared confirmation modal (rendered once in AppLayout,
    // alongside the sidebar's own Logout button) rather than logging
    // out immediately — v1.28.2.
    const handleLogout = () => {
        onLogoutClick?.();
    };

    return (
        <header className="px-3 sm:px-6" style={{
            backgroundColor: 'var(--cms-surface)',
            borderBottom:    '1px solid var(--cms-border)',
            height:          '64px',
            display:         'flex',
            alignItems:      'center',
            justifyContent:  'space-between',
            position:        'sticky',
            top:             0,
            zIndex:          10,
            flexShrink:      0,
        }}>

            {/* LEFT — Mobile menu (mobile only) + Page title */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
                <button
                    onClick={onMenuClick}
                    className="md:hidden flex-shrink-0"
                    style={{
                        padding: '8px', borderRadius: '8px',
                        border: 'none', background: 'none',
                        cursor: 'pointer', color: 'var(--cms-text-secondary)',
                    }}
                    aria-label="Open menu"
                >
                    <Bars3Icon style={{ width: '20px', height: '20px' }} />
                </button>

                <div style={{ minWidth: 0, overflow: 'hidden' }}>
                    <h2 style={{
                        fontSize: '16px', fontWeight: '600',
                        color: 'var(--cms-text-primary)', margin: 0,
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>
                        {pageTitle}
                    </h2>
                    <p className="hidden sm:block" style={{ fontSize: '11px', color: 'var(--cms-text-muted)', margin: 0 }}>
                        {branding.company_name}
                    </p>
                </div>
            </div>

            {/* CENTRE — Account balances (hidden on small screens — see them
                on the Accounts page instead, there's no room here). Given
                flex:1 so it's the section that gives way first if the page
                title, company name, and every account balance combined are
                wider than the window — each balance truncates with an
                ellipsis instead of the whole row silently running off the
                edge of the screen. */}
            {accountSummary.length > 0 && (
                <div className="hidden lg:flex" style={{
                    alignItems: 'center', gap: '16px',
                    flex: '1 1 auto', minWidth: 0, overflow: 'hidden',
                    justifyContent: 'center', padding: '0 12px',
                }}>
                    {accountSummary.map((account, i) => (
                        <div key={i} style={{ textAlign: 'center', minWidth: 0, maxWidth: '170px', flexShrink: 1 }}>
                            <p style={{
                                fontSize: '11px', color: 'var(--cms-text-muted)',
                                margin: 0, whiteSpace: 'nowrap',
                                overflow: 'hidden', textOverflow: 'ellipsis',
                            }}>
                                {account.name.length > 20
                                    ? account.currency_code + ' Account'
                                    : account.name}
                            </p>
                            <p style={{
                                fontSize: '14px', fontWeight: '700',
                                color: '#1e3a5f', margin: 0, whiteSpace: 'nowrap',
                                overflow: 'hidden', textOverflow: 'ellipsis',
                            }}>
                                {account.currency_code}{' '}
                                {parseFloat(account.current_balance).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                            </p>
                        </div>
                    ))}
                </div>
            )}

            {/* RIGHT — Search + Notifications + User menu. flex-shrink: 0
                so these controls are never the ones that get squeezed —
                they need to stay clickable no matter how tight space gets. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>

                {/* Global Search — searches across company-wide records,
                    which is exactly what a finance-restricted role
                    (Auditor, Administrative Officer) must never reach,
                    so it's hidden rather than shown-then-blocked — the
                    backend fully blocks /api/search for both roles. */}
                {!isFinanceBlockedRole && (
                    <button
                        onClick={() => setSearchOpen(true)}
                        style={{
                            padding: '8px', borderRadius: '8px',
                            border: 'none', background: 'none',
                            cursor: 'pointer', color: 'var(--cms-text-secondary)',
                        }}
                        aria-label="Search"
                    >
                        <MagnifyingGlassIcon style={{ width: '20px', height: '20px' }} />
                    </button>
                )}

                {/* Notifications Bell */}
                <div style={{ position: 'relative' }}>
                    <button
                        onClick={() => {
                            setNotifOpen(!notifOpen);
                            setUserMenuOpen(false);
                        }}
                        style={{
                            position: 'relative', padding: '8px',
                            borderRadius: '8px', border: 'none',
                            background: notifOpen ? 'var(--cms-surface-hover)' : 'none',
                            cursor: 'pointer', color: 'var(--cms-text-secondary)',
                        }}
                    >
                        <BellIcon style={{ width: '20px', height: '20px' }} />
                        {badgeCount > 0 && (
                            <span style={{
                                position: 'absolute', top: '4px', right: '4px',
                                width: '16px', height: '16px',
                                borderRadius: '50%',
                                backgroundColor: (urgentCount > 0 || dbUnreadCount > 0) ? '#dc2626' : '#2563eb',
                                color: 'white', fontSize: '10px', fontWeight: '700',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                            }}>
                                {badgeCount > 9 ? '9+' : badgeCount}
                            </span>
                        )}
                    </button>

                    {/* Notifications Dropdown */}
                    {notifOpen && (
                        <>
                            <div
                                style={{ position: 'fixed', inset: 0, zIndex: 10 }}
                                onClick={() => setNotifOpen(false)}
                            />
                            <div style={{
                                position: 'absolute', right: 0,
                                top: 'calc(100% + 8px)', width: '360px',
                                maxWidth: 'calc(100vw - 32px)',
                                backgroundColor: 'var(--cms-surface)', borderRadius: '12px',
                                boxShadow: '0 10px 40px rgba(0,0,0,0.12)',
                                border: '1px solid var(--cms-border)', zIndex: 20,
                                overflow: 'hidden',
                            }}>
                                {/* Header */}
                                <div style={{
                                    padding: '12px 16px',
                                    borderBottom: '1px solid var(--cms-surface-divider)',
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    alignItems: 'center',
                                }}>
                                    <p style={{
                                        fontSize: '13px', fontWeight: '600',
                                        color: 'var(--cms-text-primary)', margin: 0,
                                    }}>
                                        Notifications
                                    </p>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                        {dbUnreadCount > 0 && (
                                            <button
                                                onClick={handleMarkAllRead}
                                                style={{
                                                    fontSize: '11px', color: '#2563eb',
                                                    fontWeight: '600', background: 'none',
                                                    border: 'none', cursor: 'pointer', padding: 0,
                                                }}
                                            >
                                                Mark all read
                                            </button>
                                        )}
                                        {urgentCount > 0 && (
                                            <span style={{
                                                fontSize: '11px', color: '#dc2626',
                                                fontWeight: '600',
                                                backgroundColor: '#fef2f2',
                                                padding: '2px 8px',
                                                borderRadius: '20px',
                                            }}>
                                                {urgentCount} urgent
                                            </span>
                                        )}
                                    </div>
                                </div>

                                {/* Persisted notifications (contribution updates, approvals,
                                    event invitations, etc.) — the auto-generated feed */}
                                {dbNotifs.length > 0 && (
                                    <div style={{
                                        maxHeight: '260px', overflowY: 'auto',
                                        borderBottom: '1px solid var(--cms-surface-divider)',
                                    }}>
                                        {dbNotifs.map(notif => (
                                            <div
                                                key={`db-${notif.id}`}
                                                onClick={() => handleNotifClick(notif)}
                                                style={{
                                                    padding: '10px 16px',
                                                    borderBottom: '1px solid var(--cms-surface-divider)',
                                                    display: 'flex',
                                                    alignItems: 'flex-start',
                                                    gap: '10px',
                                                    cursor: 'pointer',
                                                    backgroundColor: notif.is_read ? 'var(--cms-surface)' : 'var(--cms-surface-hover)',
                                                    transition: 'background 0.15s',
                                                }}
                                                onMouseEnter={e => {
                                                    e.currentTarget.style.backgroundColor = 'var(--cms-surface-hover)';
                                                }}
                                                onMouseLeave={e => {
                                                    e.currentTarget.style.backgroundColor =
                                                        notif.is_read ? 'var(--cms-surface)' : 'var(--cms-surface-hover)';
                                                }}
                                            >
                                                <div style={{
                                                    width: '8px', height: '8px', borderRadius: '50%',
                                                    backgroundColor: notif.is_read ? 'transparent' : '#2563eb',
                                                    marginTop: '6px', flexShrink: 0,
                                                }} />
                                                <div style={{ flex: 1, minWidth: 0 }}>
                                                    <p style={{
                                                        fontSize: '13px',
                                                        fontWeight: notif.is_read ? '500' : '700',
                                                        color: 'var(--cms-text-primary)', margin: 0,
                                                    }}>
                                                        {notif.title}
                                                    </p>
                                                    {notif.body && (
                                                        <p style={{
                                                            fontSize: '12px', color: 'var(--cms-text-secondary)',
                                                            margin: '2px 0 0', overflow: 'hidden',
                                                            textOverflow: 'ellipsis',
                                                            display: '-webkit-box',
                                                            WebkitLineClamp: 2,
                                                            WebkitBoxOrient: 'vertical',
                                                        }}>
                                                            {notif.body}
                                                        </p>
                                                    )}
                                                    <p style={{
                                                        fontSize: '11px', color: 'var(--cms-text-muted)',
                                                        margin: '2px 0 0',
                                                    }}>
                                                        {timeAgo(notif.created_at)}
                                                    </p>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}

                                {/* Action items (computed: pending approvals, upcoming events) */}
                                {totalCount === 0 ? (
                                    dbNotifs.length === 0 && (
                                        <div style={{
                                            padding: '24px', textAlign: 'center',
                                            color: 'var(--cms-text-muted)', fontSize: '13px',
                                        }}>
                                            No pending notifications
                                        </div>
                                    )
                                ) : (
                                    <div style={{ maxHeight: '380px', overflowY: 'auto' }}>
                                        {notifications.map((notif, i) => (
                                            <div
                                                key={notif.id}
                                                onClick={() => {
                                                    navigate(notif.link);
                                                    setNotifOpen(false);
                                                }}
                                                style={{
                                                    padding: '12px 16px',
                                                    borderBottom: '1px solid var(--cms-surface-divider)',
                                                    display: 'flex',
                                                    alignItems: 'flex-start',
                                                    gap: '12px',
                                                    cursor: 'pointer',
                                                    backgroundColor: 'var(--cms-surface)',
                                                    transition: 'background 0.15s',
                                                }}
                                                onMouseEnter={e => {
                                                    e.currentTarget.style.backgroundColor = 'var(--cms-surface-hover)';
                                                }}
                                                onMouseLeave={e => {
                                                    e.currentTarget.style.backgroundColor = 'white';
                                                }}
                                            >
                                                <div style={{
                                                    width: '34px', height: '34px',
                                                    borderRadius: '8px',
                                                    backgroundColor: notif.bg,
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    flexShrink: 0,
                                                }}>
                                                    <notif.icon style={{
                                                        width: '16px', height: '16px',
                                                        color: notif.color,
                                                    }} />
                                                </div>
                                                <div style={{ flex: 1, minWidth: 0 }}>
                                                    <div style={{
                                                        display: 'flex',
                                                        alignItems: 'center',
                                                        gap: '6px',
                                                        marginBottom: '2px',
                                                    }}>
                                                        <p style={{
                                                            fontSize: '13px',
                                                            fontWeight: '600',
                                                            color: 'var(--cms-text-primary)',
                                                            margin: 0,
                                                        }}>
                                                            {notif.title}
                                                        </p>
                                                        {notif.urgent && (
                                                            <span style={{
                                                                fontSize: '10px',
                                                                color: '#dc2626',
                                                                backgroundColor: '#fef2f2',
                                                                padding: '1px 6px',
                                                                borderRadius: '20px',
                                                                fontWeight: '600',
                                                                flexShrink: 0,
                                                            }}>
                                                                URGENT
                                                            </span>
                                                        )}
                                                    </div>
                                                    <p style={{
                                                        fontSize: '12px',
                                                        color: 'var(--cms-text-secondary)',
                                                        margin: 0,
                                                        overflow: 'hidden',
                                                        textOverflow: 'ellipsis',
                                                        whiteSpace: 'nowrap',
                                                    }}>
                                                        {notif.message}
                                                    </p>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}

                                {/* Footer */}
                                <div style={{
                                    padding: '10px 16px',
                                    borderTop: '1px solid var(--cms-surface-divider)',
                                    textAlign: 'center',
                                }}>
                                    <p style={{
                                        fontSize: '11px', color: 'var(--cms-text-muted)', margin: 0,
                                    }}>
                                        {isAuditor
                                            ? 'Showing your audit submission updates'
                                            : 'Showing pending approvals and upcoming events'}
                                    </p>
                                </div>
                            </div>
                        </>
                    )}
                </div>

                {/* User Menu */}
                <div style={{ position: 'relative' }}>
                    <button
                        onClick={() => {
                            setUserMenuOpen(!userMenuOpen);
                            setNotifOpen(false);
                        }}
                        style={{
                            display: 'flex', alignItems: 'center', gap: '8px',
                            padding: '6px 10px', borderRadius: '8px',
                            border: 'none',
                            background: userMenuOpen ? 'var(--cms-surface-hover)' : 'none',
                            cursor: 'pointer',
                        }}
                    >
                        <Avatar user={user} size={32} />
                        <span className="hidden sm:inline" style={{
                            fontSize: '13px', fontWeight: '500', color: 'var(--cms-text-secondary)',
                        }}>
                            {user?.first_name} {user?.last_name}
                        </span>
                    </button>

                    {/* User Dropdown */}
                    {userMenuOpen && (
                        <>
                            <div
                                style={{ position: 'fixed', inset: 0, zIndex: 10 }}
                                onClick={() => setUserMenuOpen(false)}
                            />
                            <div style={{
                                position: 'absolute', right: 0,
                                top: 'calc(100% + 8px)', width: '220px',
                                backgroundColor: 'var(--cms-surface)', borderRadius: '12px',
                                boxShadow: '0 10px 40px rgba(0,0,0,0.12)',
                                border: '1px solid var(--cms-border)', zIndex: 20,
                                overflow: 'hidden',
                            }}>
                                <div style={{
                                    padding: '12px 16px',
                                    borderBottom: '1px solid var(--cms-surface-divider)',
                                }}>
                                    <p style={{
                                        fontSize: '13px', fontWeight: '600',
                                        color: 'var(--cms-text-primary)', margin: 0,
                                    }}>
                                        {user?.first_name} {user?.last_name}
                                    </p>
                                    <p style={{
                                        fontSize: '11px', color: 'var(--cms-text-secondary)',
                                        margin: '2px 0 0', overflow: 'hidden',
                                        textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                    }}>
                                        {user?.email}
                                    </p>
                                </div>

                                <div style={{ padding: '4px' }}>
                                    <button
                                        onClick={() => {
                                            setUserMenuOpen(false);
                                            navigate('/profile');
                                        }}
                                        style={{
                                            width: '100%', display: 'flex',
                                            alignItems: 'center', gap: '10px',
                                            padding: '8px 12px', borderRadius: '8px',
                                            border: 'none', background: 'none',
                                            cursor: 'pointer', fontSize: '13px',
                                            color: 'var(--cms-text-secondary)', textAlign: 'left',
                                        }}
                                        onMouseEnter={e => {
                                            e.currentTarget.style.backgroundColor = 'var(--cms-surface-hover)';
                                        }}
                                        onMouseLeave={e => {
                                            e.currentTarget.style.backgroundColor = 'transparent';
                                        }}
                                    >
                                        <UserIcon style={{
                                            width: '16px', height: '16px', color: 'var(--cms-text-muted)',
                                        }} />
                                        My Profile
                                    </button>

                                    <div style={{
                                        height: '1px', backgroundColor: 'var(--cms-surface-divider)', margin: '4px 0',
                                    }} />

                                    <button
                                        onClick={handleLogout}
                                        style={{
                                            width: '100%', display: 'flex',
                                            alignItems: 'center', gap: '10px',
                                            padding: '8px 12px', borderRadius: '8px',
                                            border: 'none', background: 'none',
                                            cursor: 'pointer', fontSize: '13px',
                                            color: '#dc2626', textAlign: 'left',
                                        }}
                                        onMouseEnter={e => {
                                            e.currentTarget.style.backgroundColor = '#fef2f2';
                                        }}
                                        onMouseLeave={e => {
                                            e.currentTarget.style.backgroundColor = 'transparent';
                                        }}
                                    >
                                        <ArrowRightOnRectangleIcon style={{
                                            width: '16px', height: '16px',
                                        }} />
                                        Sign Out
                                    </button>
                                </div>
                            </div>
                        </>
                    )}
                </div>
            </div>

            <GlobalSearch isOpen={searchOpen} onClose={() => setSearchOpen(false)} />
        </header>
    );
};

export default TopBar;