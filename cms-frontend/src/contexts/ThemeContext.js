// ============================================================
// THEME CONTEXT (v1.71.0)
// Each person chooses how the system looks on THIS device:
//   'light'  — always light
//   'dark'   — always dark
//   'system' — follow the device's own light/dark setting (default,
//              exactly how the app behaved before v1.71)
//
// The choice is remembered in this browser (localStorage key
// `cms-theme`). It is a display preference only — nothing about it is
// sent to the server, and it never affects documents or emails.
//
// How it works: when dark is in effect the class `dark` is put on the
// <html> element. Tailwind is configured with darkMode: 'class' and
// index.css writes every dark rule as `.dark …`, so the whole app
// switches at once. public/index.html runs the same check BEFORE React
// loads, so the page never flashes white when dark is chosen.
//
// Charts (recharts) need colours as plain values, so useChartTheme
// reads `isDark` from here.
// ============================================================

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const STORAGE_KEY = 'cms-theme';
const MODES = ['light', 'dark', 'system'];

const readStoredMode = () => {
    try {
        const v = window.localStorage.getItem(STORAGE_KEY);
        return MODES.includes(v) ? v : 'system';
    } catch {
        return 'system';
    }
};

const systemPrefersDark = () =>
    typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-color-scheme: dark)').matches === true;

const ThemeContext = createContext({
    mode: 'system', isDark: false, setMode: () => {}, toggle: () => {},
});

export const ThemeProvider = ({ children }) => {
    const [mode, setModeState] = useState(readStoredMode);
    const [systemDark, setSystemDark] = useState(systemPrefersDark);

    // Follow live changes of the device setting (only matters in 'system').
    useEffect(() => {
        if (!window.matchMedia) return undefined;
        const mql = window.matchMedia('(prefers-color-scheme: dark)');
        const onChange = (e) => setSystemDark(e.matches);
        if (mql.addEventListener) mql.addEventListener('change', onChange);
        else mql.addListener(onChange);
        return () => {
            if (mql.removeEventListener) mql.removeEventListener('change', onChange);
            else mql.removeListener(onChange);
        };
    }, []);

    const isDark = mode === 'dark' || (mode === 'system' && systemDark);

    useEffect(() => {
        const root = document.documentElement;
        root.classList.toggle('dark', isDark);
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', isDark ? '#08111f' : '#0b1f3a');
    }, [isDark]);

    const setMode = useCallback((next) => {
        if (!MODES.includes(next)) return;
        setModeState(next);
        try { window.localStorage.setItem(STORAGE_KEY, next); } catch { /* private window */ }
    }, []);

    // The top-bar button: flips between light and dark (leaving 'system').
    const toggle = useCallback(() => setMode(isDark ? 'light' : 'dark'), [isDark, setMode]);

    const value = useMemo(() => ({ mode, isDark, setMode, toggle }), [mode, isDark, setMode, toggle]);
    return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export const useTheme = () => useContext(ThemeContext);

export default ThemeContext;
