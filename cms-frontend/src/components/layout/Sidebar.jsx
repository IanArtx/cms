// ============================================================
// SIDEBAR
// Main navigation sidebar.
// Desktop (md and up): always visible, static, pushes content.
// Mobile (below md): off-canvas drawer — hidden by translating
// off-screen, slides in over a dark backdrop when `isOpen` is
// true, and closes on backdrop click or on picking a nav item.
// Branding color is still applied via inline style since it's a
// runtime value from the database, not something Tailwind can
// express as a class.
// ============================================================

import { NavLink } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useBranding } from '../../contexts/BrandingContext';
import Avatar from '../common/Avatar';
import {
    HomeIcon,
    BanknotesIcon,
    ArrowsRightLeftIcon,
    GiftIcon,
    CreditCardIcon,
    ChartBarIcon,
    CircleStackIcon,
    CalendarDaysIcon,
    DocumentTextIcon,
    ChartPieIcon,
    UsersIcon,
    Cog6ToothIcon,
    BuildingLibraryIcon,
    InformationCircleIcon,
    ClipboardDocumentListIcon,
    WalletIcon,
    XMarkIcon,
    ShieldCheckIcon,
    ArrowRightOnRectangleIcon,
    FlagIcon,
    CheckBadgeIcon,
} from '@heroicons/react/24/outline';

const Sidebar = ({ isOpen, onClose, onLogoutClick }) => {
    const { user, hasPermission, hasRole } = useAuth();
    const { branding } = useBranding();
    const initials = (branding.company_name || 'CMS')
        .split(' ').filter(Boolean).slice(0, 2)
        .map(w => w[0]).join('').toUpperCase() ||
        (process.env.REACT_APP_COMPANY_INITIALS || 'CMS');

    // The Auditor role sees nothing but its own page — every other
    // nav item below would just bounce them straight back to /audit
    // anyway (enforced centrally in AppLayout.jsx), so showing them
    // here would only be confusing. This short-circuits the whole
    // list rather than relying on permission checks alone, since a
    // few items (Dashboard, Savings, Reports, About, etc.) are
    // intentionally "show: true" for every normal member/staff role.
    const isAuditorOnly = hasRole('Auditor');

    // Administrative Officer (v1.21.0): a hired/contracted staff role
    // that, unlike the Auditor, keeps a normal multi-page sidebar —
    // just with every finance-adjacent item removed. The backend
    // already hard-blocks these routes for this role
    // (blockFinanceRestricted, middleware/auth.js), so this is about
    // not showing a link that would only ever lead to a 403, not the
    // actual security boundary.
    const isAdminOfficer = hasRole('Administrative Officer');

    const navItems = isAuditorOnly ? [
        { label: 'Audit', href: '/audit', icon: ShieldCheckIcon, show: true },
    ] : [
        { label: 'Dashboard',    href: '/',             icon: HomeIcon,            show: true },
        { label: 'Accounts',     href: '/accounts',     icon: BuildingLibraryIcon, show: hasPermission('FINANCE_VIEW_ALL') && !isAdminOfficer },
        { label: 'Transactions', href: '/transactions', icon: BanknotesIcon,       show: hasPermission('FINANCE_VIEW_ALL') && !isAdminOfficer },
        { label: 'Transfers',    href: '/transfers',    icon: ArrowsRightLeftIcon, show: hasPermission('FINANCE_VIEW_ALL') && !isAdminOfficer },
        { label: 'Requisitions', href:  '/requisitions',icon:  ClipboardDocumentListIcon,  show:  !isAdminOfficer,},
        { label: 'Grants',       href: '/grants',       icon: GiftIcon,            show: hasPermission('GRANT_VIEW') && !isAdminOfficer },
        { label: 'Loans',        href: '/loans',        icon: CreditCardIcon,      show: hasPermission('LOAN_VIEW') && !isAdminOfficer },
        { label: 'Investments',  href: '/investments',  icon: ChartBarIcon,        show: hasPermission('INVESTMENT_VIEW') && !isAdminOfficer },
        { label: 'Money Market Funds', href: '/mmf',     icon: CircleStackIcon,     show: hasPermission('MMF_VIEW') && !isAdminOfficer },
        { label: 'Capital Goals', href: '/capital-goals', icon: FlagIcon,           show: hasPermission('CAPITAL_GOAL_VIEW') && !isAdminOfficer },
        { label: 'Dividends',    href:  '/dividends',   icon:  BanknotesIcon,      show:  hasPermission('FINANCE_VIEW_ALL') && !isAdminOfficer,},
        { label: 'Savings',     href:  '/savings',      icon:  BanknotesIcon,      show:  !isAdminOfficer,},
        { label: 'Side Fund',   href:  '/side-fund',    icon:  WalletIcon,         show:  !isAdminOfficer,},
        { label: 'Service Fees', href: '/service-fees', icon: WalletIcon,          show: true },
        { label: 'Payment Acknowledgements', href: '/payment-acknowledgements', icon: CheckBadgeIcon, show: true },
        { label: 'Events',       href: '/events',       icon: CalendarDaysIcon,    show: hasPermission('EVENT_VIEW') },
        { label: 'Documents',    href: '/documents',    icon: DocumentTextIcon,    show: hasPermission('DOCUMENT_VIEW') },
        { label: 'Reports',      href: '/reports',      icon: ChartPieIcon,        show: !isAdminOfficer },
        { label: 'Members',      href: '/users',        icon: UsersIcon,           show: hasPermission('USER_VIEW_ALL') },
        { label: 'External Audit', href: '/audit-management', icon: ShieldCheckIcon, show: hasRole('Admin') },
        { label: 'Audit Review', href: '/audit-review', icon: ShieldCheckIcon, show: hasRole(['Director', 'Secretary']) },
        { label: 'Settings',     href: '/settings',     icon: Cog6ToothIcon,       show: hasRole('Admin') },
        { label: 'About',        href:  '/about',       icon:  InformationCircleIcon,    show:  true,},
    ];

    const visibleItems = navItems.filter(item => item.show);

    const roles = Array.isArray(user?.roles)
        ? user.roles.map(r => typeof r === 'object' ? r.name : r).join(', ')
        : 'Member';

    return (
        <>
            {/* Mobile backdrop — only rendered (and only blocks clicks) while open */}
            {isOpen && (
                <div
                    className="fixed inset-0 bg-black/50 z-30 md:hidden"
                    onClick={onClose}
                    aria-hidden="true"
                />
            )}

            <aside
                className={`fixed md:static inset-y-0 left-0 z-40 w-64 min-w-[256px]
                    h-screen flex flex-col overflow-y-auto scrollbar-hidden flex-shrink-0
                    transition-transform duration-200 ease-in-out
                    ${isOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`}
                style={{ backgroundColor: branding.primary_color, color: 'white' }}
            >
                {/* Logo */}
                <div style={{
                    padding: '20px 24px',
                    borderBottom: '1px solid rgba(255,255,255,0.1)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '12px',
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', overflow: 'hidden' }}>
                        <div style={{
                            width: '40px',
                            height: '40px',
                            borderRadius: '8px',
                            overflow: 'hidden',
                            flexShrink: 0,
                            backgroundColor: 'white',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                        }}>
                            {/* Falls back to the bundled /logo.png if the admin hasn't
                                uploaded a custom logo via Settings > Company yet */}
                            <img
                                src={branding.logo_url || '/logo.png'}
                                alt="Company Logo"
                                style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                                onError={(e) => {
                                    e.target.style.display = 'none';
                                    e.target.parentElement.innerHTML =
                                        `<span style="color:${branding.primary_color};font-weight:bold;font-size:12px">
                                            ${initials}
                                        </span>`;
                                }}
                            />
                        </div>
                        <div style={{ overflow: 'hidden' }}>
                            <p style={{
                                fontWeight: '600',
                                fontSize: '13px',
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                            }}>
                                {branding.company_name}
                            </p>
                            <p style={{ fontSize: '11px', color: '#93c5fd' }}>
                                Management System
                            </p>
                        </div>
                    </div>

                    {/* Close button — mobile only, lets a thumb close the drawer
                        without having to tap the backdrop */}
                    <button
                        onClick={onClose}
                        className="md:hidden flex-shrink-0"
                        style={{ padding: '4px', color: '#bfdbfe', background: 'none', border: 'none', cursor: 'pointer' }}
                        aria-label="Close menu"
                    >
                        <XMarkIcon style={{ width: '20px', height: '20px' }} />
                    </button>
                </div>

                {/* User info */}
                <div style={{
                    padding: '16px 24px',
                    borderBottom: '1px solid rgba(255,255,255,0.1)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                }}>
                    <Avatar user={user} size={36} />
                    <div style={{ overflow: 'hidden' }}>
                        <p style={{ fontSize: '13px', fontWeight: '500',
                            whiteSpace: 'nowrap', overflow: 'hidden',
                            textOverflow: 'ellipsis' }}>
                            {user?.first_name} {user?.last_name}
                        </p>
                        <p style={{ fontSize: '11px', color: '#93c5fd',
                            whiteSpace: 'nowrap', overflow: 'hidden',
                            textOverflow: 'ellipsis' }}>
                            {roles}
                        </p>
                    </div>
                </div>

                {/* Navigation */}
                <nav className="scrollbar-hidden" style={{ flex: 1, padding: '12px', overflowY: 'auto' }}>
                    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                        {visibleItems.map((item) => (
                            <li key={item.href} style={{ marginBottom: '2px' }}>
                                <NavLink
                                    to={item.href}
                                    end={item.href === '/'}
                                    onClick={onClose}
                                    style={({ isActive }) => ({
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '12px',
                                        padding: '10px 12px',
                                        borderRadius: '8px',
                                        textDecoration: 'none',
                                        fontSize: '14px',
                                        fontWeight: '500',
                                        color: isActive ? 'white' : '#bfdbfe',
                                        backgroundColor: isActive
                                            ? 'rgba(255,255,255,0.15)'
                                            : 'transparent',
                                        transition: 'all 0.15s',
                                    })}
                                >
                                    <item.icon style={{ width: '18px', height: '18px',
                                        flexShrink: 0 }} />
                                    {item.label}
                                </NavLink>
                            </li>
                        ))}
                    </ul>
                </nav>

                {/* Logout */}
                <div style={{ padding: '12px', borderTop: '1px solid rgba(255,255,255,0.1)' }}>
                    <button
                        onClick={onLogoutClick}
                        style={{
                            width: '100%', display: 'flex', alignItems: 'center',
                            gap: '12px', padding: '10px 12px', borderRadius: '8px',
                            border: 'none', background: 'none', cursor: 'pointer',
                            fontSize: '14px', fontWeight: '500', color: '#fca5a5',
                            transition: 'background-color 0.15s',
                        }}
                        onMouseEnter={e => { e.currentTarget.style.backgroundColor = 'rgba(220,38,38,0.15)'; }}
                        onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent'; }}
                    >
                        <ArrowRightOnRectangleIcon style={{ width: '18px', height: '18px', flexShrink: 0 }} />
                        Log Out
                    </button>
                </div>

                {/* Version */}
                <div style={{
                    padding: '12px 24px 16px',
                    borderTop: '1px solid rgba(255,255,255,0.1)',
                }}>
                    <p style={{ fontSize: '11px', color: '#60a5fa' }}>
                        Version {process.env.REACT_APP_VERSION || '1.9.0'}
                    </p>
                </div>
            </aside>
        </>
    );
};

export default Sidebar;
