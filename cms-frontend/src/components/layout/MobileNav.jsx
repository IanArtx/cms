// ============================================================
// PHONE BOTTOM BAR (v1.71.0)
// Shown only below 768 px. Five thumb-sized buttons:
//   Home · Shortcuts · + New · Alerts · Menu
// "Shortcuts" and "+ New" open a sheet from the bottom; "Alerts" opens
// the same notifications panel as the bell; "Menu" opens the drawer.
// ============================================================

import { useEffect, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useLayout } from './LayoutContext';
import {
    HomeIcon,
    PlusIcon,
    BellIcon,
    Bars3Icon,
    StarIcon,
    XMarkIcon,
} from '@heroicons/react/24/outline';
import { StarIcon as StarSolid } from '@heroicons/react/24/solid';

const Sheet = ({ title, onClose, children }) => (
    <div className="fixed inset-0 z-[55] md:hidden" role="dialog" aria-modal="true" aria-label={title}>
        <div className="absolute inset-0 bg-black/55" onClick={onClose} />
        <div className="absolute left-0 right-0 bottom-0 rounded-t-2xl border-t p-3 pb-[calc(12px+env(safe-area-inset-bottom))]"
            style={{ backgroundColor: 'var(--cms-surface)', borderColor: 'var(--cms-border)' }}>
            <div className="flex items-center justify-between px-2 pb-2">
                <p className="text-base font-bold" style={{ color: 'var(--cms-text-primary)' }}>{title}</p>
                <button type="button" onClick={onClose} aria-label="Close" className="w-11 h-11 flex items-center justify-center rounded-lg" style={{ color: 'var(--cms-text-muted)' }}>
                    <XMarkIcon className="w-6 h-6" />
                </button>
            </div>
            {children}
        </div>
    </div>
);

const MobileNav = () => {
    const { shortcuts, quickActions, setMobileOpen, setNotifOpen, isAuditor } = useLayout();
    const [sheet, setSheet] = useState(null); // 'shortcuts' | 'new' | null
    const navigate = useNavigate();
    const location = useLocation();

    useEffect(() => { setSheet(null); }, [location.pathname]);

    if (isAuditor) return null;

    const item = 'flex flex-col items-center justify-center gap-0.5 w-16 h-14 rounded-xl text-[11px] font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500';

    return (
        <>
            <nav
                aria-label="Quick navigation"
                className="md:hidden fixed bottom-0 inset-x-0 z-30 flex items-center justify-around border-t px-1 pb-[env(safe-area-inset-bottom)]"
                style={{ backgroundColor: 'var(--cms-surface)', borderColor: 'var(--cms-border)', height: 'calc(64px + env(safe-area-inset-bottom))' }}
            >
                <NavLink to="/" end className={({ isActive }) => `${item} ${isActive ? 'text-primary-700' : ''}`}
                    style={({ isActive }) => (isActive ? undefined : { color: 'var(--cms-text-muted)' })}>
                    <HomeIcon className="w-6 h-6" />Home
                </NavLink>
                <button type="button" onClick={() => setSheet('shortcuts')} className={item} style={{ color: 'var(--cms-text-muted)' }}>
                    <StarIcon className="w-6 h-6 text-amber-500" />Shortcuts
                </button>
                {quickActions.length > 0 ? (
                    <button type="button" onClick={() => setSheet('new')} aria-label="New"
                        className="w-14 h-14 -mt-5 rounded-full bg-primary-700 text-white flex items-center justify-center shadow-lg shadow-primary-700/30 focus:outline-none focus-visible:ring-4 focus-visible:ring-primary-300">
                        <PlusIcon className="w-7 h-7" strokeWidth={2.2} />
                    </button>
                ) : <span className="w-14" />}
                <button type="button" onClick={() => setNotifOpen(true)} className={item} style={{ color: 'var(--cms-text-muted)' }}>
                    <BellIcon className="w-6 h-6" />Alerts
                </button>
                <button type="button" onClick={() => setMobileOpen(true)} className={item} style={{ color: 'var(--cms-text-muted)' }}>
                    <Bars3Icon className="w-6 h-6" />Menu
                </button>
            </nav>

            {sheet === 'shortcuts' && (
                <Sheet title="Your shortcuts" onClose={() => setSheet(null)}>
                    <div className="grid grid-cols-2 gap-2">
                        {shortcuts.map(s => (
                            <button key={s.id} type="button" onClick={() => navigate(s.href)}
                                className="flex items-center gap-2.5 h-14 px-3 rounded-xl border text-left text-sm font-semibold"
                                style={{ borderColor: 'var(--cms-border)', color: 'var(--cms-text-primary)', backgroundColor: 'var(--cms-surface-2)' }}>
                                <StarSolid className="w-5 h-5 text-amber-400 flex-shrink-0" />
                                <span className="truncate">{s.label}</span>
                            </button>
                        ))}
                    </div>
                    <p className="px-2 pt-3 text-xs" style={{ color: 'var(--cms-text-muted)' }}>
                        To change them: Menu → Edit beside SHORTCUTS → tap ★ beside a page.
                    </p>
                </Sheet>
            )}

            {sheet === 'new' && (
                <Sheet title="Create" onClose={() => setSheet(null)}>
                    <div className="flex flex-col gap-1">
                        {quickActions.map(a => (
                            <button key={a.id} type="button" onClick={() => navigate(a.href)}
                                className="flex items-center gap-3 h-12 px-3 rounded-xl text-left text-[15px]"
                                style={{ color: 'var(--cms-text-primary)' }}>
                                <span className="w-8 h-8 rounded-lg bg-primary-50 text-primary-700 flex items-center justify-center"><PlusIcon className="w-4 h-4" /></span>
                                {a.label}
                            </button>
                        ))}
                    </div>
                </Sheet>
            )}
        </>
    );
};

export default MobileNav;
