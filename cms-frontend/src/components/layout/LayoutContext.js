// ============================================================
// LAYOUT CONTEXT (v1.71.0)
// Shared state for the page frame, so the sidebar, top bar, phone
// bottom bar and pages stay in step:
//
//   visibleItems / navCtx  — which menu pages this person may see
//                            (rules in navConfig.js)
//   collapsed              — desktop sidebar shrunk to icons (saved
//                            in this browser; starts collapsed on
//                            screens narrower than 1280 px)
//   mobileOpen             — the phone/tablet menu drawer
//   shortcuts              — the person's pinned pages (saved in this
//                            browser, per person)
//   detailTitle            — the name of the record a detail page is
//                            showing, used as the last breadcrumb step
//   notifOpen / newOpen    — the bell and "+ New" menus, so the phone
//                            bottom bar can open the same menus
// ============================================================

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { capitalGoalsAPI } from '../../api/endpoints';
import {
    NAV_ITEMS, AUDITOR_ITEMS, DEFAULT_SHORTCUTS, MAX_SHORTCUTS, QUICK_ACTIONS,
} from './navConfig';

const LayoutContext = createContext(null);

const readJSON = (key, fallback) => {
    try {
        const raw = window.localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
};
const writeJSON = (key, value) => {
    try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* private window */ }
};

export const LayoutProvider = ({ children }) => {
    const { user, hasPermission, hasRole, hasFinancialAccess } = useAuth();
    const isAuditor = hasRole('Auditor');
    const isAdminOfficer = hasRole('Administrative Officer');

    // v1.51.0 behaviour kept: hide Capital goals while tracking is
    // paused. Fails open (shown) — the backend still blocks writes.
    const [capitalGoalTrackingEnabled, setCapitalGoalTrackingEnabled] = useState(true);
    useEffect(() => {
        if (!hasPermission('CAPITAL_GOAL_VIEW')) return;
        capitalGoalsAPI.getTrackingSettings()
            .then(res => setCapitalGoalTrackingEnabled(res.data.data.tracking_enabled))
            .catch(() => {});
    }, [hasPermission]);

    const navCtx = useMemo(() => ({
        hasPermission, hasRole, hasFinancialAccess, isAdminOfficer, isAuditor, capitalGoalTrackingEnabled,
    }), [hasPermission, hasRole, hasFinancialAccess, isAdminOfficer, isAuditor, capitalGoalTrackingEnabled]);

    const visibleItems = useMemo(
        () => (isAuditor ? AUDITOR_ITEMS : NAV_ITEMS.filter(i => i.show(navCtx))),
        [isAuditor, navCtx],
    );

    const quickActions = useMemo(
        () => (isAuditor ? [] : QUICK_ACTIONS.filter(a =>
            a.show(navCtx) && visibleItems.some(i => i.id === a.needs))),
        [isAuditor, navCtx, visibleItems],
    );

    // ---- desktop collapse ----------------------------------------
    const [collapsed, setCollapsed] = useState(() => {
        const saved = readJSON('cms-sidebar-collapsed', null);
        if (saved !== null) return !!saved;
        return typeof window !== 'undefined' && window.innerWidth < 1280;
    });
    const toggleCollapsed = useCallback(() => {
        setCollapsed(c => { writeJSON('cms-sidebar-collapsed', !c); return !c; });
    }, []);

    // ---- phone drawer --------------------------------------------
    const [mobileOpen, setMobileOpen] = useState(false);

    // ---- shortcuts (per person, per browser) ---------------------
    const shortcutKey = `cms-shortcuts:${user?.id || 'anon'}`;
    const [pinnedIds, setPinnedIds] = useState(() => readJSON(shortcutKey, null));
    useEffect(() => { setPinnedIds(readJSON(shortcutKey, null)); }, [shortcutKey]);

    const shortcuts = useMemo(() => {
        const ids = pinnedIds || DEFAULT_SHORTCUTS;
        return ids.map(id => visibleItems.find(i => i.id === id)).filter(Boolean).slice(0, MAX_SHORTCUTS);
    }, [pinnedIds, visibleItems]);

    const isPinned = useCallback((id) => shortcuts.some(s => s.id === id), [shortcuts]);

    const togglePin = useCallback((id) => {
        const current = shortcuts.map(s => s.id);
        let next;
        if (current.includes(id)) next = current.filter(x => x !== id);
        else if (current.length >= MAX_SHORTCUTS) return false;
        else next = [...current, id];
        setPinnedIds(next);
        writeJSON(shortcutKey, next);
        return true;
    }, [shortcuts, shortcutKey]);

    // ---- breadcrumb title from the page --------------------------
    const [detailTitle, setDetailTitle] = useState(null);

    // ---- menus the phone bar can open ----------------------------
    const [notifOpen, setNotifOpen] = useState(false);
    const [newOpen, setNewOpen] = useState(false);

    const value = useMemo(() => ({
        navCtx, visibleItems, quickActions, isAuditor, isAdminOfficer,
        collapsed, toggleCollapsed,
        mobileOpen, setMobileOpen,
        shortcuts, isPinned, togglePin,
        detailTitle, setDetailTitle,
        notifOpen, setNotifOpen, newOpen, setNewOpen,
    }), [navCtx, visibleItems, quickActions, isAuditor, isAdminOfficer, collapsed, toggleCollapsed,
        mobileOpen, shortcuts, isPinned, togglePin, detailTitle, notifOpen, newOpen]);

    return <LayoutContext.Provider value={value}>{children}</LayoutContext.Provider>;
};

export const useLayout = () => useContext(LayoutContext);

/**
 * A detail page calls this with the record's name so the breadcrumb's
 * last step reads e.g. "Investments › Portfolio › Stanbic 12-month FD".
 * Safe to call outside the layout (does nothing).
 */
export const useBreadcrumbTitle = (title) => {
    const ctx = useContext(LayoutContext);
    const setDetailTitle = ctx?.setDetailTitle;
    useEffect(() => {
        if (!setDetailTitle) return undefined;
        setDetailTitle(typeof title === 'string' && title.trim() ? title : null);
        return () => setDetailTitle(null);
    }, [title, setDetailTitle]);
};

export default LayoutContext;
