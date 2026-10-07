// ============================================================
// SIDEBAR (v1.71.0 "Harbour")
// Navy sidebar with six folding groups instead of one long list.
//
//   ┌ company ─────────────┐
//   │ Dashboard            │
//   │ SHORTCUTS      Edit  │  ← the person's pinned pages (★)
//   │ ★ Transactions       │
//   │ MENU                 │
//   │ ▸ Money              │  ← click to open a group (one at a time)
//   │ ▾ Members' funds     │
//   │     Savings …        │
//   │ ▸ Investments …      │
//   │ [you · role]   ‹     │  ← your portfolio, log out, shrink
//   └──────────────────────┘
//
// Three shapes, one component:
//   • Wide screens: full sidebar (248 px). The ‹ button shrinks it to
//     a 72 px icon strip; clicking a group icon there opens a small
//     panel with that group's pages. The choice is remembered.
//   • Phones and tablets (< 768 px): a drawer that slides in over the
//     page (opened from the top bar ☰ or the bottom bar "Menu").
//
// "Edit" beside SHORTCUTS opens every group and shows a ★ beside each
// page: click it to pin or unpin (up to 6). Pins are saved in this
// browser for this person.
//
// Who sees which page is decided in navConfig.js (same rules as before
// v1.71). The Auditor still sees only "Audit".
// ============================================================

import { useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useBranding } from '../../contexts/BrandingContext';
import { useLayout } from './LayoutContext';
import { NAV_GROUPS, MAX_SHORTCUTS, isItemActive } from './navConfig';
import Avatar from '../common/Avatar';
import {
    XMarkIcon,
    ChevronDownIcon,
    ChevronRightIcon,
    ChevronDoubleLeftIcon,
    ChevronDoubleRightIcon,
    ArrowRightOnRectangleIcon,
} from '@heroicons/react/24/outline';
import { StarIcon as StarSolid } from '@heroicons/react/24/solid';
import { StarIcon as StarOutline } from '@heroicons/react/24/outline';

const cx = (...c) => c.filter(Boolean).join(' ');

const Sidebar = ({ onLogoutClick }) => {
    const { user } = useAuth();
    const { branding } = useBranding();
    const location = useLocation();
    const {
        visibleItems, isAuditor, collapsed: collapsedPref, toggleCollapsed,
        mobileOpen, setMobileOpen, shortcuts, isPinned, togglePin,
    } = useLayout();

    // The icon strip only exists on wide screens; the phone drawer is
    // always the full version.
    const [isDesktop, setIsDesktop] = useState(() => window.innerWidth >= 768);
    useEffect(() => {
        const onResize = () => setIsDesktop(window.innerWidth >= 768);
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);
    const collapsed = isDesktop && collapsedPref;

    const [editing, setEditing] = useState(false);
    const [pinMessage, setPinMessage] = useState('');
    const [flyout, setFlyout] = useState(null); // { groupId, top }
    const asideRef = useRef(null);

    const pathname = location.pathname;
    const home = visibleItems.find(i => i.group === 'home');
    const groups = useMemo(() => NAV_GROUPS
        .map(g => ({ ...g, items: visibleItems.filter(i => i.group === g.id) }))
        .filter(g => g.items.length > 0), [visibleItems]);

    const activeGroupId = groups.find(g => g.items.some(i => isItemActive(i, pathname)))?.id || null;

    // One group open at a time (keeps the menu short): the group of the
    // page you are on opens by itself; opening another closes it.
    const [openId, setOpenId] = useState(activeGroupId);
    useEffect(() => { setOpenId(activeGroupId); }, [activeGroupId]);
    const toggleGroup = (id) => setOpenId(cur => (cur === id ? null : id));

    // Close the drawer / flyout whenever the page changes.
    useEffect(() => { setMobileOpen(false); setFlyout(null); }, [pathname, setMobileOpen]);

    // Close the flyout on a click outside it.
    useEffect(() => {
        if (!flyout) return undefined;
        const onDown = (e) => { if (asideRef.current && !asideRef.current.contains(e.target)) setFlyout(null); };
        const onKey = (e) => { if (e.key === 'Escape') setFlyout(null); };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
    }, [flyout]);

    const handlePin = (id) => {
        const ok = togglePin(id);
        setPinMessage(ok === false ? `You can pin up to ${MAX_SHORTCUTS} pages. Unpin one first.` : '');
    };

    const roles = Array.isArray(user?.roles)
        ? user.roles.map(r => (typeof r === 'object' ? r.name : r)).join(', ')
        : 'Member';

    const initials = (branding.company_name || 'CMS')
        .split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();

    // ------------------------------------------------------------
    // pieces
    // ------------------------------------------------------------
    const logo = (size = 34) => (
        <div
            className="flex-shrink-0 rounded-[9px] overflow-hidden flex items-center justify-center font-extrabold text-white"
            style={{ width: size, height: size, backgroundColor: branding.logo_url ? '#ffffff' : '#0f766e', fontSize: 13 }}
        >
            {branding.logo_url
                ? <img src={branding.logo_url} alt="" className="w-full h-full object-contain" />
                : initials}
        </div>
    );

    const linkBase = 'flex items-center gap-2.5 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70';

    const topLink = (item) => (
        <NavLink
            key={item.id}
            to={item.href}
            end={item.href === '/'}
            title={collapsed ? item.label : undefined}
            aria-label={collapsed ? item.label : undefined}
            className={({ isActive }) => cx(linkBase,
                collapsed ? 'justify-center w-11 h-11 mx-auto' : 'h-10 px-2.5 text-sm',
                isActive ? 'bg-primary-700 text-white font-semibold' : 'text-[#e6ecf5] hover:bg-white/10')}
        >
            <item.icon className="w-[18px] h-[18px] flex-shrink-0" />
            {!collapsed && <span className="truncate">{item.label}</span>}
        </NavLink>
    );

    const shortcutLink = (item) => (
        <NavLink
            key={item.id}
            to={item.href}
            title={collapsed ? `${item.label} (shortcut)` : undefined}
            aria-label={collapsed ? `${item.label} (shortcut)` : undefined}
            className={({ isActive }) => cx(linkBase,
                collapsed ? 'justify-center w-11 h-11 mx-auto bg-white/5' : 'h-9 px-2.5 text-sm',
                isActive ? 'bg-white/10 text-white font-bold' : 'text-[#e6ecf5] hover:bg-white/10')}
        >
            {collapsed
                ? <item.icon className="w-[18px] h-[18px] text-amber-300" />
                : <StarSolid className="w-4 h-4 text-amber-400 flex-shrink-0" aria-hidden="true" />}
            {!collapsed && <span className="truncate">{item.label}</span>}
        </NavLink>
    );

    const childLink = (item) => (
        <div key={item.id} className="flex items-center gap-1">
            <NavLink
                to={item.href}
                className={({ isActive }) => cx(linkBase, 'flex-1 min-w-0 h-8 px-2 text-[13px]',
                    isItemActive(item, pathname) || isActive
                        ? 'bg-primary-700 text-white font-semibold'
                        : 'text-[#c7d2e3] hover:bg-white/10 hover:text-white')}
            >
                <span className="truncate">{item.label}</span>
            </NavLink>
            {editing && item.id !== 'dashboard' && (
                <button
                    type="button"
                    onClick={() => handlePin(item.id)}
                    className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                    aria-label={isPinned(item.id) ? `Unpin ${item.label}` : `Pin ${item.label} to shortcuts`}
                    aria-pressed={isPinned(item.id)}
                >
                    {isPinned(item.id)
                        ? <StarSolid className="w-4 h-4 text-amber-400" />
                        : <StarOutline className="w-4 h-4 text-[#9fb0c8]" />}
                </button>
            )}
        </div>
    );

    const groupBlock = (group) => {
        const open = editing || openId === group.id;
        const hasActive = group.id === activeGroupId;
        if (collapsed) {
            return (
                <button
                    key={group.id}
                    type="button"
                    data-tour={`group-${group.id}`}
                    onClick={(e) => {
                        const r = e.currentTarget.getBoundingClientRect();
                        setFlyout(f => (f?.groupId === group.id ? null : { groupId: group.id, top: r.top }));
                    }}
                    aria-label={group.label}
                    title={group.label}
                    aria-expanded={flyout?.groupId === group.id}
                    className={cx(linkBase, 'justify-center w-11 h-11 mx-auto',
                        hasActive || flyout?.groupId === group.id ? 'bg-[#132c4f]' : 'hover:bg-white/10')}
                >
                    <group.icon className="w-5 h-5" style={{ color: group.color }} />
                </button>
            );
        }
        return (
            <div key={group.id}>
                <button
                    type="button"
                    data-tour={`group-${group.id}`}
                    onClick={() => toggleGroup(group.id)}
                    aria-expanded={open}
                    className={cx(linkBase, 'w-full h-10 px-2.5 text-sm text-left',
                        hasActive ? 'bg-[#132c4f] text-white font-semibold' : 'text-[#e6ecf5] hover:bg-white/10')}
                >
                    <group.icon className="w-[18px] h-[18px] flex-shrink-0" style={{ color: group.color }} />
                    <span className="flex-1 truncate">{group.label}</span>
                    {open
                        ? <ChevronDownIcon className="w-4 h-4 opacity-80" />
                        : <ChevronRightIcon className="w-4 h-4 opacity-80" />}
                </button>
                {open && (
                    <div className="ml-[19px] pl-3 mt-0.5 mb-1 border-l border-[#24406a] flex flex-col gap-0.5">
                        {group.items.map(item => childLink(item))}
                    </div>
                )}
            </div>
        );
    };

    const flyoutGroup = flyout ? groups.find(g => g.id === flyout.groupId) : null;

    // ------------------------------------------------------------
    return (
        <>
            {mobileOpen && (
                <div className="fixed inset-0 bg-black/55 z-40 md:hidden" onClick={() => setMobileOpen(false)} aria-hidden="true" />
            )}

            <aside
                ref={asideRef}
                aria-label="Main menu"
                className={cx(
                    'fixed md:static inset-y-0 left-0 z-50 md:z-20 h-[100dvh] md:h-screen flex flex-col flex-shrink-0',
                    'transition-[transform,width] duration-200 ease-in-out',
                    mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
                    collapsed ? 'w-[72px]' : 'w-[300px] max-w-[86vw] md:w-[248px]',
                )}
                style={{ backgroundColor: 'var(--cms-nav-bg)', color: 'var(--cms-nav-text)', borderRight: '1px solid rgba(255,255,255,0.04)' }}
            >
                {/* Company */}
                <div className={cx('flex items-center gap-2.5 pt-4 pb-3', collapsed ? 'justify-center px-2' : 'px-4')}>
                    {logo()}
                    {!collapsed && (
                        <div className="min-w-0 flex-1">
                            <p className="text-sm font-bold text-white truncate">{branding.company_name}</p>
                            <p className="text-xs text-[#9fb0c8]">Company system</p>
                        </div>
                    )}
                    <button
                        type="button"
                        onClick={() => setMobileOpen(false)}
                        className="md:hidden w-11 h-11 flex items-center justify-center rounded-lg text-[#c7d2e3] hover:bg-white/10"
                        aria-label="Close menu"
                    >
                        <XMarkIcon className="w-6 h-6" />
                    </button>
                </div>

                <nav data-tour="menu" className={cx('flex-1 overflow-y-auto scrollbar-hidden pb-3', collapsed ? 'px-2' : 'px-3')} aria-label="Pages">
                    <div className="flex flex-col gap-1">
                        {home && topLink(home)}
                    </div>

                    {/* Shortcuts */}
                    {!isAuditor && (
                        <>
                            {collapsed
                                ? <div className="h-px bg-[#24406a] mx-3 my-3" />
                                : (
                                    <div className="flex items-center justify-between px-2.5 pt-4 pb-1.5">
                                        <span className="text-[11px] font-bold tracking-[0.08em] text-[#9fb0c8]">SHORTCUTS</span>
                                        <button
                                            type="button"
                                            onClick={() => { setEditing(e => !e); setPinMessage(''); }}
                                            className="text-xs font-semibold text-[#7dd3c0] hover:text-white px-1 py-0.5 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                                            aria-pressed={editing}
                                        >
                                            {editing ? 'Done' : 'Edit'}
                                        </button>
                                    </div>
                                )}
                            <div className="flex flex-col gap-1" data-tour="shortcuts">
                                {shortcuts.map(item => shortcutLink(item))}
                                {!collapsed && shortcuts.length === 0 && (
                                    <p className="px-2.5 text-xs text-[#9fb0c8]">
                                        No shortcuts yet. Press Edit, then the ★ beside a page.
                                    </p>
                                )}
                                {!collapsed && editing && (
                                    <p className="px-2.5 pt-1 text-xs text-[#9fb0c8]" role="status">
                                        {pinMessage || `Tap ★ to pin or unpin (up to ${MAX_SHORTCUTS}).`}
                                    </p>
                                )}
                            </div>

                            {collapsed
                                ? <div className="h-px bg-[#24406a] mx-3 my-3" />
                                : <div className="px-2.5 pt-4 pb-1.5"><span className="text-[11px] font-bold tracking-[0.08em] text-[#9fb0c8]">MENU</span></div>}
                            <div className="flex flex-col gap-1">
                                {groups.map(g => groupBlock(g))}
                            </div>
                        </>
                    )}
                </nav>

                {/* You */}
                <div data-tour="user-card" className={cx('border-t border-white/5', collapsed ? 'p-2 flex flex-col items-center gap-2' : 'p-3')}>
                    {collapsed ? (
                        <>
                            <NavLink to="/portfolio" aria-label="My portfolio" title="My portfolio" className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70">
                                <Avatar user={user} size={36} />
                            </NavLink>
                            <button type="button" onClick={onLogoutClick} aria-label="Log out" title="Log out"
                                className="w-11 h-11 flex items-center justify-center rounded-lg text-[#fca5a5] hover:bg-white/10">
                                <ArrowRightOnRectangleIcon className="w-5 h-5" />
                            </button>
                            <button type="button" onClick={toggleCollapsed} aria-label="Expand the menu" title="Expand the menu"
                                className="w-11 h-11 flex items-center justify-center rounded-lg bg-[#132c4f] text-[#c7d2e3] hover:bg-white/10">
                                <ChevronDoubleRightIcon className="w-5 h-5" />
                            </button>
                        </>
                    ) : (
                        <div className="flex items-center gap-2 rounded-xl p-2" style={{ backgroundColor: 'var(--cms-nav-bg-2)' }}>
                            <NavLink to="/portfolio" className="flex items-center gap-2.5 min-w-0 flex-1 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70" title="View my portfolio">
                                <Avatar user={user} size={34} />
                                <span className="min-w-0">
                                    <span className="block text-[13px] font-semibold text-white truncate">{user?.first_name} {user?.last_name}</span>
                                    <span className="block text-xs text-[#9fb0c8] truncate">{roles}</span>
                                </span>
                            </NavLink>
                            <button type="button" onClick={onLogoutClick} aria-label="Log out" title="Log out"
                                className="w-9 h-9 flex items-center justify-center rounded-lg text-[#fca5a5] hover:bg-white/10 flex-shrink-0">
                                <ArrowRightOnRectangleIcon className="w-5 h-5" />
                            </button>
                            <button type="button" onClick={toggleCollapsed} aria-label="Shrink the menu to icons" title="Shrink the menu"
                                className="hidden md:flex w-9 h-9 items-center justify-center rounded-lg text-[#c7d2e3] hover:bg-white/10 flex-shrink-0">
                                <ChevronDoubleLeftIcon className="w-5 h-5" />
                            </button>
                        </div>
                    )}
                    {!collapsed && (
                        <p className="px-2 pt-2 text-[11px] text-[#7f93b3]">Version {process.env.REACT_APP_VERSION || '1.71.0'}</p>
                    )}
                </div>

                {/* Icon-strip flyout: the pages of one group */}
                {collapsed && flyoutGroup && (
                    <div
                        role="menu"
                        aria-label={flyoutGroup.label}
                        className="fixed z-50 w-60 rounded-xl border p-2 shadow-pop"
                        style={{
                            left: 80, top: Math.min(flyout.top, window.innerHeight - 60 - flyoutGroup.items.length * 40),
                            backgroundColor: 'var(--cms-surface)', borderColor: 'var(--cms-border)',
                        }}
                    >
                        <p className="px-2.5 pt-1 pb-2 text-[11px] font-bold tracking-[0.08em]" style={{ color: 'var(--cms-text-muted)' }}>
                            {flyoutGroup.label.toUpperCase()}
                        </p>
                        {flyoutGroup.items.map(item => (
                            <NavLink
                                key={item.id}
                                to={item.href}
                                role="menuitem"
                                className={cx('flex items-center gap-2.5 h-10 px-2.5 rounded-lg text-sm',
                                    isItemActive(item, pathname)
                                        ? 'bg-primary-50 text-primary-700 font-bold'
                                        : 'hover:bg-gray-100')}
                                style={isItemActive(item, pathname) ? undefined : { color: 'var(--cms-text-primary)' }}
                            >
                                <item.icon className="w-4 h-4 flex-shrink-0" style={{ color: flyoutGroup.color === '#fbbf24' ? '#d97706' : undefined }} />
                                {item.label}
                            </NavLink>
                        ))}
                    </div>
                )}
            </aside>
        </>
    );
};

export default Sidebar;
