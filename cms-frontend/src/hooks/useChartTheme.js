// ============================================================
// USE CHART THEME (v1.49.0)
// A shared, dark-mode-aware color/style palette for every recharts
// chart in the system (Investments, Accounts, MMF, Loans, Capital
// Goal Calls). Reported directly: charts had poor contrast and a
// dated look in dark mode — dashed grid lines and axis text were
// colored for a white card (`stroke="#f0f0f0"`, unstyled tick text),
// so on a dark card they either vanished (near-invisible axis
// labels) or turned into a harsh bright box (the default white
// recharts Tooltip, and CartesianGrid's boundary lines reading as a
// stark white rectangle).
//
// WHY THIS HAS TO BE A JS HOOK, NOT JUST CSS:
// The rest of this app follows the OS theme purely via Tailwind's
// `darkMode: 'media'` and `dark:` utility classes (see index.css) —
// no JS dark-mode detection existed anywhere before this. But
// recharts renders plain SVG with color values passed as JS props
// (`stroke="#2563eb"`, `<Tooltip contentStyle={{...}}>`) — there is
// no `dark:` class equivalent for an SVG `stroke` attribute or an
// inline style object, so those values have to be picked in JS,
// which means knowing the current color scheme in JS. Hence
// `useIsDarkMode()` below, the one place in the app that reads
// `prefers-color-scheme` directly.
//
// USAGE:
//   const theme = useChartTheme();
//   <CartesianGrid stroke={theme.gridStroke} vertical={false} />
//   <XAxis tick={{ fontSize: 11, fill: theme.axisText }} tickLine={false} />
//   <Tooltip {...theme.tooltipProps} formatter={...} />
//   <Bar dataKey="amount" fill={theme.success} radius={[4, 4, 0, 0]} />
//   <Legend wrapperStyle={theme.legendStyle} />
// ============================================================

import { useEffect, useState } from 'react';

// ------------------------------------------------------------
// useIsDarkMode — mirrors the OS/browser color scheme exactly the
// way Tailwind's own `darkMode: 'media'` does, via a live
// `matchMedia` listener (not just a one-time read) so a chart
// already on screen re-themes itself immediately if the user
// switches their system theme without reloading the page.
// ------------------------------------------------------------
export const useIsDarkMode = () => {
    const [isDark, setIsDark] = useState(
        () => typeof window !== 'undefined'
            && window.matchMedia?.('(prefers-color-scheme: dark)').matches === true
    );

    useEffect(() => {
        if (typeof window === 'undefined' || !window.matchMedia) return;
        const mql = window.matchMedia('(prefers-color-scheme: dark)');
        const onChange = (e) => setIsDark(e.matches);
        // addEventListener is the modern API; addListener is the
        // Safari-pre-14 fallback some earlier code in this app
        // similarly guards against (mirrors idle-logout's own
        // defensive-support style).
        if (mql.addEventListener) mql.addEventListener('change', onChange);
        else mql.addListener(onChange);
        return () => {
            if (mql.removeEventListener) mql.removeEventListener('change', onChange);
            else mql.removeListener(onChange);
        };
    }, []);

    return isDark;
};

// ------------------------------------------------------------
// Palette — a modern, moderately saturated set that reads clearly
// on both a white card and a dark-gray (#1f2937, this app's own
// dark `.card` background) card. Dark-mode variants are shifted a
// step lighter/brighter than their light-mode counterpart (e.g.
// emerald-600 -> emerald-400) rather than reused as-is — a flat
// `#16a34a` green that looks great on white reads noticeably muddy
// and low-contrast against a dark background, which was a big part
// of the reported "not well represented" complaint.
// ------------------------------------------------------------
const PALETTE = {
    light: {
        primary:   '#2563eb', // blue-600  — primary line/bar accent
        success:   '#16a34a', // green-600 — inflows, interest, spent-well
        danger:    '#dc2626', // red-600   — outflows, fees, over budget
        warning:   '#d97706', // amber-600 — secondary highlight
        accent:    '#7c3aed', // violet-600 — tertiary series
        neutral:   '#94a3b8', // slate-400 — baseline/remaining/muted series
        gridStroke: '#e5e7eb', // gray-200
        axisText:   '#6b7280', // gray-500
        cardStroke: '#ffffff', // pie-slice separators match a light card
        tooltipBg:     '#ffffff',
        tooltipBorder: '#e5e7eb',
        tooltipText:   '#111827',
        cursorFill:    'rgba(15, 23, 42, 0.04)',
    },
    dark: {
        primary:   '#60a5fa', // blue-400
        success:   '#34d399', // emerald-400
        danger:    '#f87171', // red-400
        warning:   '#fbbf24', // amber-400
        accent:    '#a78bfa', // violet-400
        neutral:   '#94a3b8', // slate-400 (already light enough to hold up)
        gridStroke: '#374151', // gray-700 — visible but not harsh against #1f2937
        axisText:   '#9ca3af', // gray-400
        cardStroke: '#1f2937', // pie-slice separators match the dark card
        tooltipBg:     '#1f2937',
        tooltipBorder: '#374151',
        tooltipText:   '#f3f4f6',
        cursorFill:    'rgba(248, 250, 252, 0.06)',
    },
};

// A colorblind-friendlier, brand-neutral rotation for charts with 3+
// series that aren't strictly "good/bad" (e.g. a multi-slice pie) —
// [primary, success, warning, accent, danger, neutral].
const SERIES_ORDER = ['primary', 'success', 'warning', 'accent', 'danger', 'neutral'];

// ------------------------------------------------------------
// useChartTheme — the one hook every chart-bearing page should call.
// Returns resolved colors plus ready-to-spread prop bundles for the
// two recharts primitives (Tooltip, Legend) that need the most
// boilerplate to theme correctly.
// ------------------------------------------------------------
export const useChartTheme = () => {
    const isDark = useIsDarkMode();
    const p = isDark ? PALETTE.dark : PALETTE.light;

    const series = SERIES_ORDER.map(key => p[key]);

    return {
        isDark,
        ...p,
        series,
        // Spread directly onto <CartesianGrid {...theme.gridProps} /> —
        // horizontal-only lines read as a cleaner, more modern grid than
        // the previous full box (which is what read as a stray white
        // rectangle around the whole chart in dark mode).
        gridProps: {
            stroke: p.gridStroke,
            strokeDasharray: '3 3',
            vertical: false,
        },
        // Spread onto axis `tick` — e.g. tick={{ fontSize: 11, ...theme.axisTick }}
        axisTick: { fill: p.axisText },
        // Spread directly onto <Tooltip {...theme.tooltipProps} formatter={...} />
        tooltipProps: {
            contentStyle: {
                backgroundColor: p.tooltipBg,
                border: `1px solid ${p.tooltipBorder}`,
                borderRadius: 8,
                boxShadow: '0 4px 12px rgba(0, 0, 0, 0.12)',
                padding: '8px 12px',
                fontSize: 12,
            },
            labelStyle: { color: p.tooltipText, fontWeight: 600, marginBottom: 2 },
            itemStyle: { color: p.tooltipText },
            cursor: { fill: p.cursorFill },
        },
        // Spread onto <Legend {...theme.legendProps} />
        legendProps: {
            wrapperStyle: { fontSize: 12, color: p.axisText },
            iconType: 'circle',
        },
    };
};

export default useChartTheme;
