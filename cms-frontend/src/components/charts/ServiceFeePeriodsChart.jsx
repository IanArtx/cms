// ============================================================
// SERVICE FEE MONTHS CHART (v1.88.0)
// One chart for both service-fee pages (the member's own card and the
// agreement page): paid / outstanding / excluded per month, stacked.
// A fee is due per month, so it groups by Months or Years only.
// An EXCLUDED month (v1.54.0) is never "outstanding" and never "paid":
// it shows as its own neutral segment.
// ============================================================

import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { compactNumber, useChartTheme } from '../../hooks/useChartTheme';
import GroupBy, { useGrouping } from './GroupBy';
import { groupSeries, MONTHLY_ONLY } from '../../utils/timeGrouping';

export const serviceFeeChartRows = (periods) => (periods || []).map(p => ({
    period: p.period,
    paid: p.status === 'EXCLUDED' ? 0 : parseFloat(p.amount_paid || 0),
    outstanding: p.status === 'EXCLUDED' ? 0 : Math.max(0, parseFloat(p.amount_due || 0) - parseFloat(p.amount_paid || 0)),
    excluded: p.status === 'EXCLUDED' ? parseFloat(p.amount_due || 0) : 0,
}));

const ServiceFeePeriodsChart = ({ periods, heightClass = 'h-48', storageKey = 'service-fee-months' }) => {
    const theme = useChartTheme();
    const [group, setGroup] = useGrouping(storageKey, 'month', MONTHLY_ONLY);
    const data = groupSeries(serviceFeeChartRows(periods), {
        granularity: group, date: 'period', fields: { paid: 'sum', outstanding: 'sum', excluded: 'sum' },
    });
    if (!data.length) return null;
    return (
        <div>
            <div className="flex justify-end mb-2">
                <GroupBy value={group} onChange={setGroup} options={MONTHLY_ONLY} />
            </div>
            <div className={heightClass}>
                <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data}>
                        <CartesianGrid {...theme.gridProps} />
                        <XAxis dataKey="label" tick={{ fontSize: 11, ...theme.axisTick }} tickLine={false} minTickGap={16} />
                        <YAxis tickFormatter={compactNumber} tick={{ fontSize: 11, ...theme.axisTick }} tickLine={false} axisLine={false} />
                        <Tooltip {...theme.tooltipProps} labelFormatter={(l, p) => p?.[0]?.payload?.title || l}
                            formatter={(v, name) => [Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 }), name]} />
                        <Bar dataKey="paid" stackId="a" name="Paid" fill={theme.success} />
                        <Bar dataKey="outstanding" stackId="a" name="Outstanding" fill={theme.danger} />
                        <Bar dataKey="excluded" stackId="a" name="Excluded" fill={theme.neutral} radius={[4, 4, 0, 0]} />
                    </BarChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
};

export default ServiceFeePeriodsChart;
