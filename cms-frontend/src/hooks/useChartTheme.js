// ============================================================
// USE CHART THEME (v1.49.0, re-coloured in v1.71.0 "Harbour")
// One shared colour/style set for every recharts chart in the system,
// in light and dark mode.
//
// v1.71.0 changes:
//   • Dark mode is no longer read from the operating system here — it
//     comes from ThemeContext, which knows the person's own choice
//     (Light / Dark / Same as my device).
//   • `series` is now the fixed 8-colour chart palette. Every chart
//     with several series uses the colours IN THIS ORDER, so the same
//     position always means the same colour across the system:
//       light: blue, teal, amber, pink, violet, green, orange, cyan
//       dark : the same hues, one step brighter so they stay vivid and
//              readable on the dark cards.
//   • Grid, axis text and tooltip colours match the new surfaces.
//
// USAGE (unchanged):
//   const theme = useChartTheme();
//   <CartesianGrid {...theme.gridProps} />
//   <XAxis tick={{ fontSize: 11, ...theme.axisTick }} tickLine={false} />
//   <Tooltip {...theme.tooltipProps} formatter={...} />
//   <Bar dataKey="amount" fill={theme.success} radius={[6, 6, 0, 0]} />
//   <Legend {...theme.legendProps} />
// ============================================================

import { useTheme } from '../contexts/ThemeContext';

// Kept for any older import — now simply the person's current choice.
export const useIsDarkMode = () => useTheme().isDark;

export const CHART_SERIES = {
    light: ['#2563eb', '#0d9488', '#f59e0b', '#db2777', '#7c3aed', '#16a34a', '#ea580c', '#0891b2'],
    dark:  ['#60a5fa', '#2dd4bf', '#fbbf24', '#f472b6', '#a78bfa', '#4ade80', '#fb923c', '#22d3ee'],
};

const PALETTE = {
    light: {
        primary:   '#2563eb', // money in / main series
        success:   '#16a34a', // positive (interest, inflows, on budget)
        danger:    '#dc2626', // negative (outflows, fees, over budget)
        warning:   '#f59e0b',
        accent:    '#7c3aed',
        teal:      '#0d9488',
        neutral:   '#94a3b8', // baseline / remaining
        gridStroke: '#e3e8f0',
        axisText:   '#475569',
        cardStroke: '#ffffff',
        tooltipBg:     '#ffffff',
        tooltipBorder: '#e3e8f0',
        tooltipText:   '#0f172a',
        cursorFill:    'rgba(37, 99, 235, 0.06)',
    },
    dark: {
        primary:   '#60a5fa',
        success:   '#4ade80',
        danger:    '#f87171',
        warning:   '#fbbf24',
        accent:    '#a78bfa',
        teal:      '#2dd4bf',
        neutral:   '#8d9bb4',
        gridStroke: '#24324f',
        axisText:   '#a9b6cc',
        cardStroke: '#111a2e',
        tooltipBg:     '#16213a',
        tooltipBorder: '#334766',
        tooltipText:   '#e6ecf5',
        cursorFill:    'rgba(96, 165, 250, 0.08)',
    },
};

export const useChartTheme = () => {
    const { isDark } = useTheme();
    const p = isDark ? PALETTE.dark : PALETTE.light;
    const series = isDark ? CHART_SERIES.dark : CHART_SERIES.light;

    return {
        isDark,
        ...p,
        series,
        gridProps: {
            stroke: p.gridStroke,
            strokeDasharray: '4 4',
            vertical: false,
        },
        axisTick: { fill: p.axisText },
        tooltipProps: {
            contentStyle: {
                backgroundColor: p.tooltipBg,
                border: `1px solid ${p.tooltipBorder}`,
                borderRadius: 10,
                boxShadow: isDark ? '0 8px 24px rgba(0,0,0,0.45)' : '0 8px 24px rgba(15,23,42,0.12)',
                padding: '8px 12px',
                fontSize: 12,
                fontFamily: '"Plus Jakarta Sans", system-ui, sans-serif',
            },
            labelStyle: { color: p.tooltipText, fontWeight: 700, marginBottom: 2 },
            itemStyle: { color: p.tooltipText },
            cursor: { fill: p.cursorFill },
        },
        legendProps: {
            wrapperStyle: { fontSize: 12, color: p.axisText },
            iconType: 'circle',
        },
    };
};

export default useChartTheme;

// ------------------------------------------------------------
// compactNumber (v1.71.0) — axis labels that always fit:
//   85,471,625 → 85.5M   ·   733,000 → 733K   ·   9,500 → 9,500
// Used for chart axes only; tooltips still show the full figure.
// ------------------------------------------------------------
export const compactNumber = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return v;
    const abs = Math.abs(n);
    const fmt = (x, s) => `${parseFloat(x.toFixed(1))}${s}`;
    if (abs >= 1e9) return fmt(n / 1e9, 'B');
    if (abs >= 1e6) return fmt(n / 1e6, 'M');
    if (abs >= 1e4) return fmt(n / 1e3, 'K');
    return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
};
