// ============================================================
// INVESTMENT TOTALS OVER TIME (v1.83.1)
// Requested: the investment charts should "only use totals over time of
// invested money and returns instead of individual investments".
// One smooth gradient-area chart for the whole portfolio (investments,
// bonds, treasury bills and MMF together): money invested so far and
// returns so far, month by month, in the books' currency (UGX). The
// last point equals the "Total Invested" / "Total Returns" figures
// (GET /api/investments/totals-over-time explains how each is built).
// Same look as the other trend charts: monotone line, no dots,
// gradient fill.
//
//   <InvestmentTotalsChart height={240} idPrefix="invPage" />
// `idPrefix` keeps the SVG gradient ids unique on a page.
// v1.84.0 — a currency switch: the books' currency by default; any other
// currency with a current rate shows the same totals converted at the
// rate set today (stated under the chart). The choice is remembered on
// this device.
// ============================================================

import { useEffect, useState } from 'react';
import {
    ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { investmentsAPI } from '../../api/endpoints';
import { compactNumber, useChartTheme } from '../../hooks/useChartTheme';

const money = (v) => Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 });

const InvestmentTotalsChart = ({ height = 240, idPrefix = 'invTotals', compact = false }) => {
    const theme = useChartTheme();
    const [data, setData] = useState(null);
    const [currency, setCurrency] = useState(() => {
        try { return localStorage.getItem('cms-inv-chart-currency') || ''; } catch { return ''; }
    });

    useEffect(() => {
        let alive = true;
        investmentsAPI.getTotalsOverTime(currency ? { currency } : undefined)
            .then(r => { if (alive) setData(r.data.data); })
            .catch(() => {
                if (!alive) return;
                if (currency) { setCurrency(''); return; } // the remembered currency no longer has a rate: back to default
                setData({ series: [], failed: true });
            });
        return () => { alive = false; };
    }, [currency]);

    const choose = (code) => {
        const v = code === data?.functionalCode ? '' : code;
        try { if (v) localStorage.setItem('cms-inv-chart-currency', v); else localStorage.removeItem('cms-inv-chart-currency'); } catch { /* ignore */ }
        setCurrency(v);
    };
    const switcher = data && (data.currencies || []).length > 1 ? (
        <div className="inline-flex rounded-lg border border-gray-200 dark:border-gray-700 p-0.5 text-xs" role="group" aria-label="Show in currency">
            {data.currencies.map(c => (
                <button key={c.id} type="button" onClick={() => choose(c.code)}
                    aria-pressed={c.code === data.currencyCode}
                    className={`px-2.5 py-1 rounded-md font-semibold ${c.code === data.currencyCode
                        ? 'bg-primary-600 text-white'
                        : 'text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-100'}`}>
                    {c.code}
                </button>
            ))}
        </div>
    ) : null;

    if (!data) return <div className="flex items-center justify-center text-gray-300 text-sm" style={{ height }}>Loading…</div>;
    const series = data.series || [];
    if (series.length === 0) {
        return (
            <div className="flex items-center justify-center text-gray-300 text-sm" style={{ height }}>
                {data.failed ? 'The chart could not be loaded' : 'Nothing funded yet'}
            </div>
        );
    }
    const cur = data.currencyCode || '';
    const inv = `${idPrefix}InvestedGrad`;
    const ret = `${idPrefix}ReturnedGrad`;

    return (
        <div data-testid="investment-totals-chart">
            <div className="flex flex-wrap items-start justify-between gap-2 mb-2">
                {!compact ? (
                    <p className="text-xs text-gray-500 dark:text-gray-400 flex-1 min-w-[12rem]">
                        Running totals for the whole portfolio, in {cur}: invested so far{' '}
                        <span className="font-semibold text-gray-700 dark:text-gray-200">{cur} {money(data.totals.invested)}</span>,
                        returns so far{' '}
                        <span className="font-semibold text-gray-700 dark:text-gray-200">{cur} {money(data.totals.returned)}</span>.
                    </p>
                ) : <span />}
                {switcher}
            </div>
            <ResponsiveContainer width="100%" height={height}>
                <AreaChart data={series} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                    <defs>
                        <linearGradient id={inv} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor={theme.primary} stopOpacity={0.35} />
                            <stop offset="95%" stopColor={theme.primary} stopOpacity={0} />
                        </linearGradient>
                        <linearGradient id={ret} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor={theme.success} stopOpacity={0.35} />
                            <stop offset="95%" stopColor={theme.success} stopOpacity={0} />
                        </linearGradient>
                    </defs>
                    <CartesianGrid {...theme.gridProps} />
                    <XAxis dataKey="label" tick={{ fontSize: 11, ...theme.axisTick }} tickLine={false} minTickGap={16} />
                    <YAxis tick={{ fontSize: 11, ...theme.axisTick }} tickLine={false} axisLine={false} tickFormatter={compactNumber} />
                    <Tooltip {...theme.tooltipProps} formatter={(v, name) => [`${cur} ${money(v)}`, name]} />
                    <Legend {...theme.legendProps} />
                    <Area type="monotone" dataKey="invested" name="Invested (total)"
                        stroke={theme.primary} strokeWidth={2} fill={`url(#${inv})`} dot={false} activeDot={{ r: 4 }} />
                    <Area type="monotone" dataKey="returned" name="Returns (total)"
                        stroke={theme.success} strokeWidth={2} fill={`url(#${ret})`} dot={false} activeDot={{ r: 4 }} />
                </AreaChart>
            </ResponsiveContainer>
            {data.rateUsed && (
                <p className="text-[11px] text-gray-400 mt-1">
                    Shown in {cur} for reading only, at today's rate on file (1 {data.functionalCode} = {Number(data.rateUsed).toLocaleString('en-US', { maximumSignificantDigits: 6 })} {cur}
                    {data.rateUsed < 1 ? `; 1 ${cur} = ${(1 / data.rateUsed).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${data.functionalCode}` : ''}). The books stay in {data.functionalCode}.
                </p>
            )}
            {data.unconverted > 0 && (
                <p className="text-[11px] text-amber-700 dark:text-amber-300 mt-1">
                    {data.unconverted} entr{data.unconverted === 1 ? 'y' : 'ies'} in another currency had no exchange rate for their date and {data.unconverted === 1 ? 'is' : 'are'} not included.
                </p>
            )}
        </div>
    );
};

export default InvestmentTotalsChart;
