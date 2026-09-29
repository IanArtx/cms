// ============================================================
// useTabParam (v1.71.0)
// Drop-in replacement for `useState('<tab>')` on pages with tabs.
// The open tab is kept in the page address (?tab=approvals), so:
//   • refreshing the page keeps you on the same tab,
//   • going into a record and pressing Back returns you to the tab
//     you came from,
//   • a link (e.g. from a notification) can open a page on a tab.
//
//   const [activeTab, setActiveTab] = useTabParam('mine');
//
// Other query values on the page (filters, ?new=…) are left alone.
// Switching tabs replaces the address instead of adding a history
// step, so Back leaves the page rather than stepping through tabs.
// ============================================================

import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

export const useTabParam = (defaultTab, key = 'tab') => {
    const [searchParams, setSearchParams] = useSearchParams();
    const current = searchParams.get(key) || defaultTab;

    const setTab = useCallback((next) => {
        setSearchParams(prev => {
            const params = new URLSearchParams(prev);
            const value = typeof next === 'function' ? next(prev.get(key) || defaultTab) : next;
            if (!value || value === defaultTab) params.delete(key);
            else params.set(key, value);
            return params;
        }, { replace: true });
    }, [setSearchParams, key, defaultTab]);

    return [current, setTab];
};

export default useTabParam;
