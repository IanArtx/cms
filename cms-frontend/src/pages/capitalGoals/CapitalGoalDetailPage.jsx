// ============================================================
// CAPITAL GOAL DETAIL PAGE
// One fundraising goal: target vs actual stats, the expected-vs-
// actual dual-line chart (cumulative, month by month), and Edit/
// Cancel/Mark Completed actions. v1.29.0, Section 4.33.
//
// v1.78.0 — tabs (kept in the address, ?tab=…):
//   Summary     the figures that matter: progress, this month, pace and
//               forecast, participation, pledge statistics, my part,
//               top contributors and the chart
//   Months      month by month: expected vs collected, and each call
//   Pledgers    every member BY NAME with what they pledged and paid
//               (requested: "make the names of the pledgers shown")
//   Investment  secondary goals: the investment the goal raises money
//               for, and the guided Move → Invest steps
//   Activity    what happened, newest first
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { capitalGoalsAPI, capitalGoalCallsAPI, accountsAPI } from '../../api/endpoints';
import { formatDate, formatDateTime, getErrorMessage } from '../../utils/helpers';
import PageHeader from '../../components/common/PageHeader';
import LoadingSpinner from '../../components/common/LoadingSpinner';
import ErrorMessage from '../../components/common/ErrorMessage';
import StatusBadge from '../../components/common/StatusBadge';
import ConfirmModal from '../../components/common/ConfirmModal';
import { useAuth } from '../../contexts/AuthContext';
import { useConfirm } from '../../contexts/ConfirmContext';
import { compactNumber, useChartTheme } from '../../hooks/useChartTheme';
import { useTabParam } from '../../hooks/useTabParam';
import {
    GoalCard, PledgeModal, pledgeTargetFor, money, pct, periodLabel, StatTile, ProgressBar, MemberStatus,
} from './capitalGoalUi';
import GoalInvestmentPanel from './GoalInvestmentPanel';
import {
    PencilIcon, XMarkIcon, FlagIcon, TrophyIcon, BoltIcon, HandRaisedIcon, UsersIcon, ChartBarIcon,
    ClockIcon, BanknotesIcon, ArrowsRightLeftIcon, BriefcaseIcon, ExclamationTriangleIcon, CheckCircleIcon,
} from '@heroicons/react/24/outline';
import {
    LineChart, Line, XAxis, YAxis, CartesianGrid,
    Tooltip, ResponsiveContainer, Legend, BarChart, Bar,
} from 'recharts';

// ============================================================
// EDIT GOAL MODAL — same fields as creation, ACTIVE goals only
// (enforced server-side; this form is only ever opened for one).
// ============================================================
const EditGoalModal = ({ isOpen, onClose, onSuccess, goal, currencies }) => {
    const [form, setForm] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    // v1.43.0 — a call-based goal (goal_type set) has already had its
    // entire monthly call schedule fixed at creation, possibly with
    // real pledges/payments against it — the target, currency and
    // dates can no longer be changed, only title/description.
    const isCallBased = goal && goal.goal_type != null;

    useEffect(() => {
        if (isOpen && goal) {
            setForm({
                title: goal.title,
                description: goal.description || '',
                target_amount: goal.target_amount,
                currency_id: goal.currency_id,
                start_date: goal.start_date.slice(0, 10),
                end_date: goal.end_date.slice(0, 10),
            });
        }
    }, [isOpen, goal]);

    if (!isOpen || !form) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await capitalGoalsAPI.update(goal.id, isCallBased ? {
                title: form.title,
                description: form.description || undefined,
            } : {
                title: form.title,
                description: form.description || undefined,
                target_amount: parseFloat(form.target_amount),
                currency_id: form.currency_id,
                start_date: form.start_date,
                end_date: form.end_date,
            });
            onSuccess();
            onClose();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            <div className="fixed inset-0 bg-black bg-opacity-40" onClick={onClose} />
            <div className="flex min-h-full items-center justify-center p-4">
                <div className="relative bg-white rounded-xl shadow-xl max-w-lg w-full p-6">
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">Edit Capital Goal</h2>
                    {isCallBased && (
                        <p className="text-sm text-gray-400 mb-4">
                            This goal's monthly call schedule is already generated — the target amount, currency
                            and date range can no longer be changed. Only the title and description are editable.
                        </p>
                    )}
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">Title *</label>
                            <input type="text" className="input" value={form.title}
                                onChange={e => setForm(p => ({ ...p, title: e.target.value }))} required />
                        </div>
                        <div>
                            <label className="label">Description</label>
                            <textarea className="input" rows={2} value={form.description}
                                onChange={e => setForm(p => ({ ...p, description: e.target.value }))} />
                        </div>
                        {!isCallBased && (
                            <>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                    <div>
                                        <label className="label">Target Amount *</label>
                                        <input type="number" className="input" value={form.target_amount}
                                            onChange={e => setForm(p => ({ ...p, target_amount: e.target.value }))}
                                            min="0.01" step="0.01" required />
                                    </div>
                                    <div>
                                        <label className="label">Currency *</label>
                                        <select className="input" value={form.currency_id}
                                            onChange={e => setForm(p => ({ ...p, currency_id: e.target.value }))} required>
                                            {currencies.map(c => (
                                                <option key={c.id} value={c.id}>{c.code} — {c.name}</option>
                                            ))}
                                        </select>
                                    </div>
                                </div>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                    <div>
                                        <label className="label">Start Date *</label>
                                        <input type="date" className="input" value={form.start_date}
                                            onChange={e => setForm(p => ({ ...p, start_date: e.target.value }))} required />
                                    </div>
                                    <div>
                                        <label className="label">End Date *</label>
                                        <input type="date" className="input" value={form.end_date}
                                            min={form.start_date}
                                            onChange={e => setForm(p => ({ ...p, end_date: e.target.value }))} required />
                                    </div>
                                </div>
                            </>
                        )}
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading} className="btn-primary">
                                {loading ? 'Saving...' : 'Save Changes'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// ACTIVATE CALL SCHEDULE MODAL (v1.48.0)
// Requested directly: "the capital calling system isn't active yet
// as planned... I would like that the capital system starts
// functioning immediately." A goal created before this feature
// existed (goal_type NULL — see schema.sql's comment on
// capital_goals.goal_type) was deliberately never retrofitted
// automatically, since its numbers/history shouldn't silently change
// shape. This is the explicit, one-time, opt-in action: turn this
// goal into a call-based one (or regenerate a call-based goal's
// missing schedule, if that's somehow all this is) starting now.
// ============================================================
const ActivateCallScheduleModal = ({ isOpen, onClose, onSuccess, goal }) => {
    const isLegacy = goal && goal.goal_type == null;
    const [form, setForm] = useState({ goal_type: 'PRIMARY', fiscal_year: '', call_deadline_day: '20', effective_from: '' });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [result, setResult] = useState(null);

    useEffect(() => {
        if (isOpen && goal) {
            setForm({
                goal_type: 'PRIMARY',
                fiscal_year: String(new Date(goal.start_date).getUTCFullYear()),
                call_deadline_day: '20',
                effective_from: '',
            });
            setResult(null);
            setError(null);
        }
    }, [isOpen, goal]);

    if (!isOpen || !goal) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            const res = await capitalGoalsAPI.activateCallSchedule(goal.id, {
                ...(isLegacy ? {
                    goal_type: form.goal_type,
                    fiscal_year: parseInt(form.fiscal_year),
                    call_deadline_day: parseInt(form.call_deadline_day),
                } : {}),
                effective_from: form.effective_from || undefined,
            });
            setResult(res.data);
            onSuccess();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            <div className="fixed inset-0 bg-black bg-opacity-40" onClick={onClose} />
            <div className="flex min-h-full items-center justify-center p-4">
                <div className="relative bg-white rounded-xl shadow-xl max-w-lg w-full p-6">
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">Activate Capital Calls</h2>
                    <p className="text-sm text-gray-400 mb-4">
                        {isLegacy
                            ? 'This goal was created before the capital call (pledge) system existed, so it never got a monthly schedule. This turns it into a call-based goal starting now — its target, currency and date range stay exactly as they are.'
                            : "This goal is call-based but has no monthly calls yet — this generates its schedule now."}
                    </p>
                    {error && (
                        <div className="mb-4"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>
                    )}
                    {result ? (
                        <div className="space-y-4">
                            <div className="rounded-lg bg-green-50 border border-green-100 p-3 text-sm text-green-800">
                                {result.message}
                            </div>
                            <div className="flex justify-end">
                                <button type="button" onClick={onClose} className="btn-primary">Done</button>
                            </div>
                        </div>
                    ) : (
                        <form onSubmit={handleSubmit} className="space-y-4">
                            {isLegacy && (
                                <>
                                    <div>
                                        <label className="label">Goal Type *</label>
                                        <select className="input" value={form.goal_type}
                                            onChange={e => setForm(p => ({ ...p, goal_type: e.target.value }))} required>
                                            <option value="PRIMARY">Primary (the year's general capital goal)</option>
                                            <option value="SECONDARY">Secondary (an extra goal alongside the primary)</option>
                                        </select>
                                    </div>
                                    <div className="grid grid-cols-2 gap-4">
                                        <div>
                                            <label className="label">Fiscal Year *</label>
                                            <input type="number" className="input" value={form.fiscal_year}
                                                onChange={e => setForm(p => ({ ...p, fiscal_year: e.target.value }))} required />
                                        </div>
                                        <div>
                                            <label className="label">Call Deadline Day *</label>
                                            <input type="number" className="input" min="1" max="28" value={form.call_deadline_day}
                                                onChange={e => setForm(p => ({ ...p, call_deadline_day: e.target.value }))} required />
                                            <p className="text-xs text-gray-400 mt-1">Day of each month iteration 1 closes on (1–28).</p>
                                        </div>
                                    </div>
                                </>
                            )}
                            <div>
                                <label className="label">Effective Date of Adoption</label>
                                <input type="date" className="input" value={form.effective_from}
                                    min={goal.start_date.slice(0, 10)}
                                    max={goal.end_date.slice(0, 10)}
                                    onChange={e => setForm(p => ({ ...p, effective_from: e.target.value }))} />
                                <p className="text-xs text-gray-400 mt-1">
                                    Optional — leave blank to make every month live. If pledging should only start
                                    partway through (adopting mid-year), set this to the 1st of that month. Earlier
                                    months are shown read-only using contributions already recorded — no pledging,
                                    no fines.
                                </p>
                            </div>
                            <div className="flex justify-end gap-3 pt-2">
                                <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                                <button type="submit" disabled={loading} className="btn-primary">
                                    {loading ? 'Activating...' : 'Activate Now'}
                                </button>
                            </div>
                        </form>
                    )}
                </div>
            </div>
        </div>
    );
};


// ============================================================
// SUMMARY TAB
// ============================================================
const Metric = ({ label, value, tone }) => (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
        <span className="text-xs text-gray-500">{label}</span>
        <span className={`text-sm font-semibold text-right ${
            tone === 'good' ? 'text-green-600' : tone === 'bad' ? 'text-red-600' : tone === 'warn' ? 'text-amber-600' : 'text-gray-900'
        }`}>{value}</span>
    </div>
);

const SummaryPanel = ({ goal, insights, glance, stats, onPledge, onTab }) => {
    const theme = useChartTheme();
    const { hasRole } = useAuth();
    const code = goal.currency_code;
    const ins = insights;
    const isCallBased = goal.goal_type != null;

    return (
        <div className="space-y-6">
            {/* Headline figures */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <StatTile label="Target" value={money(goal.target_amount, code)} icon={FlagIcon}
                    sub={`${formatDate(goal.start_date)} – ${formatDate(goal.end_date)}`} />
                <StatTile label="Collected so far" value={money(goal.total_collected, code)} icon={BanknotesIcon}
                    sub={`${pct(goal.percent_of_target)} of the target`} tone={goal.percent_of_target >= 100 ? 'good' : 'default'} />
                <StatTile label="Expected by now" value={money(goal.expected_to_date, code)} icon={ClockIcon}
                    sub={ins ? `${ins.gap_to_expected >= 0 ? 'ahead by' : 'behind by'} ${money(Math.abs(ins.gap_to_expected), code)}` : null}
                    tone={goal.status === 'ACTIVE' ? (goal.progress_status === 'BEHIND' ? 'bad' : 'good') : 'default'} />
                <StatTile label="Still to raise" value={money(ins ? ins.pace.remaining : Math.max(0, goal.target_amount - goal.total_collected), code)}
                    icon={ChartBarIcon}
                    sub={ins && ins.pace.remaining > 0 ? `${money(ins.pace.needed_per_month, code)} a month needed` : 'target reached'}
                    tone={ins && ins.pace.remaining <= 0 ? 'good' : 'default'} />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* This month + me */}
                {glance ? (
                    <GoalCard goal={glance} onPledge={onPledge} isShareholder={hasRole('Shareholder')} />
                ) : (
                    <div className="card text-sm text-gray-400">
                        {goal.status === 'ACTIVE' ? 'Loading this month…' : `This goal is ${goal.status.toLowerCase()}.`}
                    </div>
                )}

                {/* Pace & forecast */}
                {ins && (
                    <div className="card">
                        <h3 className="section-title mb-2">Pace &amp; forecast</h3>
                        <div className={`rounded-lg px-3 py-2 mb-2 text-sm flex items-start gap-2 ${
                            ins.pace.on_pace ? 'bg-green-50 text-green-800' : 'bg-amber-50 text-amber-800'}`}>
                            {ins.pace.on_pace ? <CheckCircleIcon className="h-5 w-5 flex-shrink-0" /> : <ExclamationTriangleIcon className="h-5 w-5 flex-shrink-0" />}
                            <span>
                                {ins.pace.projected_finish === 'REACHED'
                                    ? 'The target has been reached.'
                                    : ins.pace.on_pace
                                        ? `At the current pace the target is reached by ${periodLabel(ins.pace.projected_finish)}.`
                                        : ins.pace.projected_finish
                                            ? `At the current pace the target would only be reached in ${periodLabel(ins.pace.projected_finish)} — after the goal ends (${periodLabel(ins.pace.last_month)}).`
                                            : 'Nothing collected yet, so no forecast is possible.'}
                            </span>
                        </div>
                        <div className="divide-y divide-gray-50">
                            <Metric label="Average collected per month so far" value={money(ins.pace.per_month, code)} />
                            <Metric label="Needed per remaining month" value={money(ins.pace.needed_per_month, code)}
                                tone={ins.pace.needed_per_month > ins.pace.per_month * 1.0001 ? 'warn' : 'good'} />
                            <Metric label="Expected total at the end, at this pace" value={money(ins.pace.projected_total_at_end, code)} />
                            <Metric label="Months" value={`${ins.months.elapsed} of ${ins.months.total} begun · ${ins.months.remaining} to come`} />
                            <Metric label="Months that met their target" value={`${ins.months.met_target} of ${ins.months.elapsed}`} />
                            <Metric label="Best month" value={ins.months.best ? `${periodLabel(ins.months.best.month)} — ${money(ins.months.best.amount, code)}` : '—'} />
                        </div>
                    </div>
                )}
            </div>

            {ins && isCallBased && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    <div className="card">
                        <div className="flex items-center justify-between gap-2 mb-2">
                            <h3 className="section-title">Participation</h3>
                            <button type="button" onClick={() => onTab('pledgers')} className="text-xs text-primary-700 hover:underline">See every member</button>
                        </div>
                        <div className="flex items-baseline gap-2">
                            <span className="text-2xl font-bold text-gray-900">{pct(ins.participation.participation_pct)}</span>
                            <span className="text-xs text-gray-500">of shareholders have pledged</span>
                        </div>
                        <ProgressBar percent={ins.participation.participation_pct} tone="info" className="h-2 mt-2 mb-2" />
                        <div className="divide-y divide-gray-50">
                            <Metric label="Shareholders" value={ins.participation.members} />
                            <Metric label="Have pledged" value={ins.participation.pledgers} />
                            <Metric label="Have paid something" value={ins.participation.contributors} />
                            <Metric label="Not pledged yet" value={ins.participation.members_without_pledge}
                                tone={ins.participation.members_without_pledge ? 'warn' : 'good'} />
                            <Metric label="Overdue on a pledge" value={ins.participation.members_overdue}
                                tone={ins.participation.members_overdue ? 'bad' : 'good'} />
                        </div>
                    </div>
                    <div className="card">
                        <h3 className="section-title mb-2">Pledges &amp; payments</h3>
                        <div className="divide-y divide-gray-50">
                            <Metric label="Pledges made" value={`${ins.pledges.count}${ins.pledges.rejected ? ` (+${ins.pledges.rejected} rejected)` : ''}`} />
                            <Metric label="Total pledged" value={money(ins.pledges.total_pledged, code)} />
                            <Metric label="Total paid against pledges" value={money(ins.pledges.total_paid, code)} />
                            <Metric label="Pledges kept (paid ÷ pledged)" value={pct(ins.pledges.fulfilment_pct)}
                                tone={ins.pledges.fulfilment_pct !== null && ins.pledges.fulfilment_pct < 80 ? 'warn' : 'default'} />
                            <Metric label="Still owed on pledges" value={money(ins.pledges.outstanding, code)} />
                            <Metric label="…of which past the deadline" value={money(ins.pledges.overdue, code)} tone={ins.pledges.overdue > 0 ? 'bad' : 'default'} />
                            <Metric label="Average pledge" value={money(ins.pledges.average_pledge, code)} />
                            <Metric label="Payments on time" value={ins.pledges.payments ? `${pct(ins.pledges.on_time_pct)} (${ins.pledges.payments - ins.pledges.late_payments} of ${ins.pledges.payments})` : '—'} />
                            <Metric label="Late fines" value={ins.pledges.fines_count ? `${ins.pledges.fines_count} · ${money(ins.pledges.fines, code)}` : 'None'} />
                        </div>
                    </div>
                </div>
            )}

            {isCallBased && (stats || (ins && ins.top_contributors.length > 0)) && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    {stats && (
                        <div className="card">
                            <h3 className="section-title mb-3">My contribution to this goal</h3>
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <p className="text-xs text-gray-400">Total so far</p>
                                    <p className="text-lg font-bold text-gray-900">{money(stats.my_stats.total, code)}</p>
                                    <p className="text-xs text-gray-400">{stats.my_stats.percentage}% of the goal</p>
                                </div>
                                <div>
                                    <p className="text-xs text-gray-400">Payments made</p>
                                    <p className="text-lg font-bold text-gray-900">{stats.my_stats.numPayments}</p>
                                </div>
                                <div>
                                    <p className="text-xs text-gray-400">Biggest single payment</p>
                                    <p className="text-sm font-medium text-green-700">{money(stats.my_stats.biggest, code)}</p>
                                </div>
                                <div>
                                    <p className="text-xs text-gray-400">Smallest single payment</p>
                                    <p className="text-sm font-medium text-gray-700">{money(stats.my_stats.smallest, code)}</p>
                                </div>
                            </div>
                        </div>
                    )}
                    {ins && (
                        <div className="card">
                            <div className="flex items-center gap-2 mb-3">
                                <TrophyIcon className="h-5 w-5 text-amber-500" />
                                <h3 className="section-title">Top contributors</h3>
                            </div>
                            {ins.top_contributors.length === 0 ? (
                                <p className="text-sm text-gray-400">No settled contributions yet.</p>
                            ) : (
                                <div className="space-y-2.5">
                                    {ins.top_contributors.map((c, i) => (
                                        <div key={c.user_id}>
                                            <div className="flex justify-between gap-2 text-sm">
                                                <span className="text-gray-800 truncate"><span className="text-gray-400 mr-1.5">{i + 1}.</span>{c.name}</span>
                                                <span className="font-semibold text-gray-900 whitespace-nowrap">{money(c.contributed, code)}</span>
                                            </div>
                                            <ProgressBar percent={c.share_of_collected_pct} tone="info" className="h-1.5 mt-1" />
                                            <p className="text-[11px] text-gray-400">{pct(c.share_of_collected_pct)} of everything collected</p>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}

            {/* Dual-line chart — expected vs actual, cumulative */}
            <div className="card">
                <h3 className="section-title mb-4">Expected vs Actual — Cumulative</h3>
                {goal.months && goal.months.length > 0 ? (
                    <ResponsiveContainer width="100%" height={280}>
                        <LineChart data={goal.months}>
                            <CartesianGrid {...theme.gridProps} />
                            <XAxis dataKey="month" tick={{ fontSize: 11, ...theme.axisTick }} tickLine={false} />
                            <YAxis tick={{ fontSize: 11, ...theme.axisTick }} tickLine={false} axisLine={false}
                                tickFormatter={compactNumber} />
                            <Tooltip
                                {...theme.tooltipProps}
                                formatter={(v, name) => [money(v, code), name]}
                            />
                            <Legend {...theme.legendProps} />
                            <Line type="monotone" dataKey="expected_cumulative" name="Expected"
                                stroke={theme.neutral} strokeWidth={2} strokeDasharray="5 4" dot={{ r: 2, fill: theme.neutral }} />
                            <Line type="monotone" dataKey="actual_cumulative" name="Actual"
                                stroke={theme.primary} strokeWidth={2} dot={{ r: 3, fill: theme.primary }} />
                        </LineChart>
                    </ResponsiveContainer>
                ) : (
                    <div className="flex items-center justify-center h-48 text-gray-300 text-sm">
                        No months in range
                    </div>
                )}
            </div>
        </div>
    );
};

// ============================================================
// MONTHS TAB
// ============================================================
const MonthsPanel = ({ goal, monthlyCalls }) => {
    const theme = useChartTheme();
    const code = goal.currency_code;
    const isCallBased = goal.goal_type != null;
    return (
        <div className="space-y-6">
            <div className="card">
                <h3 className="section-title mb-4">Each month — expected vs collected</h3>
                {(goal.months || []).length > 0 && (
                    <ResponsiveContainer width="100%" height={240}>
                        <BarChart data={goal.months}>
                            <CartesianGrid {...theme.gridProps} />
                            <XAxis dataKey="month" tick={{ fontSize: 11, ...theme.axisTick }} tickLine={false} />
                            <YAxis tick={{ fontSize: 11, ...theme.axisTick }} tickLine={false} axisLine={false} tickFormatter={compactNumber} />
                            <Tooltip {...theme.tooltipProps} formatter={(v, name) => [money(v, code), name]} />
                            <Legend {...theme.legendProps} />
                            <Bar dataKey="expected_monthly" name="Expected" fill={theme.neutral} radius={[3, 3, 0, 0]} />
                            <Bar dataKey="actual_monthly" name="Collected" fill={theme.primary} radius={[3, 3, 0, 0]} />
                        </BarChart>
                    </ResponsiveContainer>
                )}
                <div className="cms-table-scroll overflow-x-auto mt-4">
                    <table className="min-w-full text-sm">
                        <thead>
                            <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                                <th className="py-2 pr-4">Month</th>
                                <th className="py-2 pr-4">Expected</th>
                                <th className="py-2 pr-4">Actual</th>
                                <th className="py-2 pr-4">Expected Cumulative</th>
                                <th className="py-2">Actual Cumulative</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-50">
                            {(goal.months || []).map(m => (
                                <tr key={m.month} className={m.is_historical ? 'bg-gray-50' : undefined}>
                                    <td className="py-2 pr-4 text-gray-700 whitespace-nowrap">
                                        {m.month}
                                        {m.is_historical && (
                                            <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-gray-200 text-gray-500 font-medium align-middle"
                                                title="Before this goal's effective date of adoption — read-only, no pledging or fines">
                                                Historical
                                            </span>
                                        )}
                                    </td>
                                    <td className="py-2 pr-4 text-gray-500 whitespace-nowrap">{money(m.expected_monthly, code)}</td>
                                    <td className={`py-2 pr-4 font-medium whitespace-nowrap ${
                                        m.actual_monthly >= m.expected_monthly ? 'text-green-600' : 'text-gray-700'
                                    }`}>{money(m.actual_monthly, code)}</td>
                                    <td className="py-2 pr-4 text-gray-500 whitespace-nowrap">{money(m.expected_cumulative, code)}</td>
                                    <td className="py-2 text-gray-900 font-medium whitespace-nowrap">{money(m.actual_cumulative, code)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* v1.43.0 — the actual capital calls shareholders pledge
                against, one per month. Each links to its own page: who
                pledged and paid (by name, v1.78.0), plus a pledge form or
                approval queue depending on who's looking. */}
            {isCallBased && (
                <div className="card">
                    <h3 className="section-title mb-4">Monthly Capital Calls</h3>
                    <div className="cms-table-scroll overflow-x-auto">
                        <table className="min-w-full text-sm">
                            <thead>
                                <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                                    <th className="py-2 pr-4">Period</th>
                                    <th className="py-2 pr-4">Target</th>
                                    <th className="py-2 pr-4">Settled</th>
                                    <th className="py-2 pr-4">Iteration 1 Deadline</th>
                                    <th className="py-2 pr-4">Iteration 2 Deadline</th>
                                    <th className="py-2 pr-4">Status</th>
                                    <th className="py-2"></th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-50">
                                {monthlyCalls.map(mc => (
                                    <tr key={mc.id} className={mc.is_historical ? 'bg-gray-50' : undefined}>
                                        <td className="py-2 pr-4 text-gray-900 font-medium whitespace-nowrap">
                                            {mc.period}
                                            {mc.is_historical && (
                                                <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-gray-200 text-gray-500 font-medium align-middle"
                                                    title="Before this goal's effective date of adoption — read-only aggregate, no pledging or fines">
                                                    Historical
                                                </span>
                                            )}
                                        </td>
                                        <td className="py-2 pr-4 text-gray-700 whitespace-nowrap">{money(mc.monthly_target, code)}</td>
                                        <td className={`py-2 pr-4 font-medium whitespace-nowrap ${
                                            parseFloat(mc.settled) >= parseFloat(mc.monthly_target) ? 'text-green-600' : 'text-gray-700'
                                        }`}>{money(mc.settled, code)}</td>
                                        <td className="py-2 pr-4 text-gray-500 whitespace-nowrap">{formatDate(mc.iteration1_deadline)}</td>
                                        <td className="py-2 pr-4 text-gray-500 whitespace-nowrap">
                                            {mc.iteration2_deadline ? formatDate(mc.iteration2_deadline) : '—'}
                                        </td>
                                        <td className="py-2 pr-4"><StatusBadge status={mc.status} /></td>
                                        <td className="py-2">
                                            {mc.is_historical ? (
                                                <span className="text-xs text-gray-300">—</span>
                                            ) : (
                                                <Link to={`/capital-goals/monthly-calls/${mc.id}`}
                                                    className="text-xs text-primary-700 hover:text-primary-800 font-medium px-2 py-1 rounded border border-primary-200 hover:bg-primary-50 transition-colors whitespace-nowrap">
                                                    Who paid
                                                </Link>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                                {monthlyCalls.length === 0 && (
                                    <tr><td colSpan={7} className="py-6 text-center text-sm text-gray-400">No monthly calls yet</td></tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}
        </div>
    );
};

// ============================================================
// PLEDGERS TAB — every member by name
// ============================================================
const PledgersPanel = ({ goalId }) => {
    const { user } = useAuth();
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [filter, setFilter] = useState('');
    const [search, setSearch] = useState('');
    useEffect(() => {
        capitalGoalsAPI.getPledgers(goalId).then(r => setData(r.data.data)).catch(err => setError(getErrorMessage(err)));
    }, [goalId]);
    if (error) return <ErrorMessage message={error} />;
    if (!data) return <div className="card text-sm text-gray-400">Loading...</div>;

    const code = data.goal.currency_code;
    const counts = {};
    for (const m of data.members) counts[m.status] = (counts[m.status] || 0) + 1;
    const q = search.trim().toLowerCase();
    const rows = data.members.filter(m => (!filter || m.status === filter) && (!q || m.name.toLowerCase().includes(q)));
    const anyHistorical = data.members.some(m => m.historical > 0);

    return (
        <div className="space-y-4">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <StatTile label="Shareholders" value={data.totals.members} icon={UsersIcon}
                    sub={`${data.totals.pledgers} pledged · ${data.totals.contributors} paid`} />
                <StatTile label="Contributed" value={money(data.totals.contributed, code)} icon={BanknotesIcon} />
                <StatTile label="Still owed" value={money(data.totals.outstanding, code)} icon={ClockIcon} />
                <StatTile label="Past the deadline" value={money(data.totals.overdue, code)} icon={ExclamationTriangleIcon}
                    tone={data.totals.overdue > 0 ? 'bad' : 'good'} />
            </div>

            <div className="card">
                <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                    <div className="flex gap-2 flex-wrap">
                        {[['', 'Everyone'], ['UP_TO_DATE', 'Up to date'], ['OWES', 'Owes'], ['OVERDUE', 'Overdue'], ['NO_PLEDGE', 'No pledge yet']].map(([k, label]) => (
                            <button key={k} type="button" onClick={() => setFilter(k)}
                                className={`chip-filter ${filter === k ? 'chip-filter-active' : ''}`}>
                                {label}{k ? ` (${counts[k] || 0})` : ` (${data.members.length})`}
                            </button>
                        ))}
                    </div>
                    <input type="search" className="input w-full sm:w-56" placeholder="Search a name..."
                        value={search} onChange={e => setSearch(e.target.value)} />
                </div>
                <div className="cms-table-scroll overflow-x-auto">
                    <table className="min-w-full text-sm">
                        <thead>
                            <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                                <th className="py-2 pr-3">#</th>
                                <th className="py-2 pr-4">Member</th>
                                <th className="py-2 pr-4 text-right">Contributed</th>
                                <th className="py-2 pr-4 text-right">Share</th>
                                <th className="py-2 pr-4 text-right">Pledged</th>
                                <th className="py-2 pr-4 text-right">Paid</th>
                                <th className="py-2 pr-4 text-right">Still owed</th>
                                <th className="py-2 pr-4 text-right">Months</th>
                                <th className="py-2 pr-4 text-right">On time</th>
                                <th className="py-2 pr-4 text-right">Fines</th>
                                <th className="py-2">Standing</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-50">
                            {rows.map(m => (
                                <tr key={m.user_id} className={user && m.user_id === user.id ? 'bg-primary-50' : undefined}>
                                    <td className="py-2 pr-3 text-gray-400">{m.rank || '—'}</td>
                                    <td className="py-2 pr-4 text-gray-900 font-medium whitespace-nowrap">
                                        {m.rank === 1 && <TrophyIcon className="h-4 w-4 text-amber-500 inline mr-1 -mt-0.5" />}
                                        {m.name}{user && m.user_id === user.id ? ' (me)' : ''}
                                        {!m.is_shareholder && <span className="ml-1 text-[10px] text-gray-400">(no longer a shareholder)</span>}
                                    </td>
                                    <td className="py-2 pr-4 text-right font-semibold whitespace-nowrap">
                                        {money(m.contributed)}
                                        {m.historical > 0 && <span className="block text-[10px] text-gray-400 font-normal">incl. {money(m.historical)} historical</span>}
                                    </td>
                                    <td className="py-2 pr-4 text-right whitespace-nowrap text-gray-600">{pct(m.share_of_collected_pct)}</td>
                                    <td className="py-2 pr-4 text-right whitespace-nowrap">{money(m.pledged)}</td>
                                    <td className="py-2 pr-4 text-right whitespace-nowrap">
                                        {money(m.paid)}
                                        {m.fulfilment_pct !== null && <span className="block text-[10px] text-gray-400">{pct(m.fulfilment_pct)} of pledged</span>}
                                    </td>
                                    <td className={`py-2 pr-4 text-right whitespace-nowrap ${m.overdue > 0 ? 'text-red-600 font-medium' : ''}`}>
                                        {money(m.outstanding)}
                                    </td>
                                    <td className="py-2 pr-4 text-right whitespace-nowrap text-gray-600" title="months pledged / paid in full">
                                        {m.months_pledged} / {m.months_paid_in_full}
                                    </td>
                                    <td className="py-2 pr-4 text-right whitespace-nowrap text-gray-600">{m.on_time_pct === null ? '—' : pct(m.on_time_pct)}</td>
                                    <td className="py-2 pr-4 text-right whitespace-nowrap text-gray-600">{m.fines_count ? `${m.fines_count} · ${money(m.fines)}` : '—'}</td>
                                    <td className="py-2"><MemberStatus status={m.status} /></td>
                                </tr>
                            ))}
                            {rows.length === 0 && (
                                <tr><td colSpan={11} className="py-6 text-center text-sm text-gray-400">No one matches</td></tr>
                            )}
                        </tbody>
                        <tfoot>
                            <tr className="border-t border-gray-200 text-sm font-semibold">
                                <td className="py-2 pr-3" />
                                <td className="py-2 pr-4">Total ({code})</td>
                                <td className="py-2 pr-4 text-right whitespace-nowrap">{money(data.totals.contributed)}</td>
                                <td className="py-2 pr-4 text-right">100%</td>
                                <td className="py-2 pr-4 text-right whitespace-nowrap">{money(data.members.reduce((s, m) => s + m.pledged, 0))}</td>
                                <td className="py-2 pr-4 text-right whitespace-nowrap">{money(data.members.reduce((s, m) => s + m.paid, 0))}</td>
                                <td className="py-2 pr-4 text-right whitespace-nowrap">{money(data.totals.outstanding)}</td>
                                <td colSpan={4} />
                            </tr>
                        </tfoot>
                    </table>
                </div>
                <p className="text-[11px] text-gray-400 mt-3">
                    Amounts are in {code} (payments made in another currency are converted at the rate used when the
                    Treasurer approved them). “Months” = months pledged / months paid in full. “On time” = payments made by
                    the month's deadline.{anyHistorical ? ' “Historical” = contributions made in the goal\'s months before it was adopted.' : ''}
                </p>
            </div>
        </div>
    );
};

// ============================================================
// ACTIVITY TAB
// ============================================================
const ACTIVITY_ICON = {
    PLEDGE: { icon: HandRaisedIcon, cls: 'bg-blue-50 text-blue-600' },
    PLEDGE_REJECTED: { icon: XMarkIcon, cls: 'bg-red-50 text-red-600' },
    PAYMENT: { icon: BanknotesIcon, cls: 'bg-green-50 text-green-600' },
    PAYMENT_LATE: { icon: ClockIcon, cls: 'bg-amber-50 text-amber-600' },
    TRANSFER: { icon: ArrowsRightLeftIcon, cls: 'bg-violet-50 text-violet-600' },
    INVESTED: { icon: BriefcaseIcon, cls: 'bg-teal-50 text-teal-600' },
    INVESTED_REVERSED: { icon: BriefcaseIcon, cls: 'bg-gray-100 text-gray-500' },
};

const ActivityPanel = ({ goalId }) => {
    const [events, setEvents] = useState(null);
    const [error, setError] = useState(null);
    const [type, setType] = useState('');
    useEffect(() => {
        capitalGoalsAPI.getActivity(goalId, { limit: 200 }).then(r => setEvents(r.data.data || [])).catch(err => setError(getErrorMessage(err)));
    }, [goalId]);
    if (error) return <ErrorMessage message={error} />;
    if (!events) return <div className="card text-sm text-gray-400">Loading...</div>;
    const groups = { '': 'Everything', PLEDGE: 'Pledges', PAYMENT: 'Payments', MONEY: 'Moved & invested' };
    const shown = events.filter(e => !type
        || (type === 'PLEDGE' && e.type.startsWith('PLEDGE'))
        || (type === 'PAYMENT' && e.type.startsWith('PAYMENT'))
        || (type === 'MONEY' && (e.type === 'TRANSFER' || e.type.startsWith('INVESTED'))));
    return (
        <div className="card">
            <div className="flex gap-2 flex-wrap mb-3">
                {Object.entries(groups).map(([k, label]) => (
                    <button key={k} type="button" onClick={() => setType(k)}
                        className={`chip-filter ${type === k ? 'chip-filter-active' : ''}`}>{label}</button>
                ))}
            </div>
            {shown.length === 0 ? (
                <p className="text-sm text-gray-400 py-6 text-center">Nothing yet.</p>
            ) : (
                <ol className="space-y-3">
                    {shown.map((e, i) => {
                        const meta = ACTIVITY_ICON[e.type] || ACTIVITY_ICON.PLEDGE;
                        const Icon = meta.icon;
                        return (
                            <li key={`${e.type}-${e.reference_code || ''}-${i}`} className="flex items-start gap-3">
                                <span className={`p-1.5 rounded-full flex-shrink-0 ${meta.cls}`}><Icon className="h-4 w-4" /></span>
                                <div className="min-w-0">
                                    <p className="text-sm text-gray-800">{e.text}</p>
                                    <p className="text-[11px] text-gray-400">
                                        {formatDateTime(e.at)}
                                        {e.reference_code && <> · <span className="font-mono">{e.reference_code}</span></>}
                                        {e.monthly_call_id && <> · <Link to={`/capital-goals/monthly-calls/${e.monthly_call_id}`} className="text-primary-700 hover:underline">{periodLabel(e.period)}</Link></>}
                                    </p>
                                </div>
                            </li>
                        );
                    })}
                </ol>
            )}
        </div>
    );
};

// ============================================================
// MAIN DETAIL PAGE
// ============================================================
const CapitalGoalDetailPage = () => {
    const { id } = useParams();
    const { hasPermission } = useAuth();
    const confirm = useConfirm();
    const canManage = hasPermission('CAPITAL_GOAL_MANAGE');
    const [tab, setTab] = useTabParam('summary');

    const [goal, setGoal] = useState(null);
    const [currencies, setCurrencies] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [showEdit, setShowEdit] = useState(false);
    const [showActivate, setShowActivate] = useState(false);
    const [showCancelConfirm, setShowCancelConfirm] = useState(false);
    const [actionLoading, setActionLoading] = useState(false);
    const [monthlyCalls, setMonthlyCalls] = useState([]);
    const [stats, setStats] = useState(null);
    const [insights, setInsights] = useState(null);
    const [glance, setGlance] = useState(null);       // this goal as the overview sees it (this month, my pledge)
    const [pledgeTarget, setPledgeTarget] = useState(null);
    const [reloadKey, setReloadKey] = useState(0);

    const loadGoal = useCallback(async () => {
        try {
            const res = await capitalGoalsAPI.getById(id);
            setGoal(res.data.data);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, [id]);

    const loadExtras = useCallback(() => {
        capitalGoalsAPI.getInsights(id).then(r => setInsights(r.data.data)).catch(() => {});
        capitalGoalsAPI.getOverview()
            .then(r => setGlance((r.data.data.goals || []).find(g => String(g.id) === String(id)) || null))
            .catch(() => {});
    }, [id]);

    useEffect(() => {
        setLoading(true);
        loadGoal();
        loadExtras();
        accountsAPI.getCurrencies().then(r => setCurrencies(r.data.data)).catch(() => {});
    }, [loadGoal, loadExtras]);

    // v1.43.0 — monthly calls + personal contribution stats only exist
    // for call-based goals (goal_type set). Loaded once the goal itself
    // has come back so we know which kind it is.
    const isCallBased = goal && goal.goal_type != null;
    const [callsChecked, setCallsChecked] = useState(false);
    const refreshCalls = useCallback(() => {
        capitalGoalCallsAPI.listMonthlyCallsForGoal(id)
            .then(r => setMonthlyCalls(r.data.data || []))
            .catch(() => {})
            .finally(() => setCallsChecked(true));
        capitalGoalCallsAPI.getGoalContributionStats(id).then(r => setStats(r.data.data)).catch(() => {});
    }, [id]);
    useEffect(() => {
        if (!isCallBased) return;
        refreshCalls();
    }, [isCallBased, refreshCalls]);

    const refreshAll = () => {
        loadGoal();
        loadExtras();
        if (isCallBased) refreshCalls();
        setReloadKey(k => k + 1);
    };

    // Show the "Activate Capital Calls" CTA once we actually know
    // there's nothing to pledge into yet — either a legacy goal that
    // never had a schedule at all, or (defensively) a call-based goal
    // whose schedule somehow never got generated.
    const needsActivation = goal && goal.status === 'ACTIVE' &&
        (!isCallBased || (isCallBased && callsChecked && monthlyCalls.length === 0));

    const handleCancel = async () => {
        setActionLoading(true);
        try {
            await capitalGoalsAPI.cancel(id, {});
            setShowCancelConfirm(false);
            loadGoal();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setActionLoading(false);
        }
    };

    const handleComplete = async () => {
        const ok = await confirm({
            title: 'Complete Capital Goal',
            message: 'Mark this capital goal as completed?',
            confirmLabel: 'Mark Completed',
        });
        if (!ok) return;
        setActionLoading(true);
        try {
            await capitalGoalsAPI.complete(id);
            loadGoal();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setActionLoading(false);
        }
    };

    if (loading) return <LoadingSpinner fullPage text="Loading capital goal..." />;
    if (error && !goal) return <ErrorMessage message={error} />;
    if (!goal) return null;

    const isSecondary = goal.goal_type === 'SECONDARY';
    const tabs = [
        { key: 'summary', label: 'Summary' },
        { key: 'months', label: 'Months' },
        ...(isCallBased ? [{ key: 'pledgers', label: 'Pledgers', count: insights ? insights.participation.pledgers : null }] : []),
        ...(isSecondary ? [{ key: 'investment', label: 'Investment' }] : []),
        { key: 'activity', label: 'Activity' },
    ];
    const activeTab = tabs.some(t => t.key === tab) ? tab : 'summary';

    return (
        <div>
            <PageHeader
                title={goal.title}
                subtitle={`${goal.goal_type === 'PRIMARY' ? 'Primary goal' : goal.goal_type === 'SECONDARY' ? 'Secondary goal' : 'Goal'} • ${formatDate(goal.start_date)} – ${formatDate(goal.end_date)} • ${goal.reference_code}`}
                showBack
                backTo="/capital-goals?tab=goals"
                actions={
                    <div className="flex items-center gap-2 flex-wrap">
                        <StatusBadge status={goal.status} />
                        {goal.status === 'ACTIVE' && <StatusBadge status={goal.progress_status} />}
                        {glance && glance.current_call && glance.current_call.can_pledge && (
                            <button type="button" onClick={() => setPledgeTarget(pledgeTargetFor(glance))} className="btn-primary flex items-center gap-2">
                                <HandRaisedIcon className="h-4 w-4" /> Pledge
                            </button>
                        )}
                    </div>
                }
            />

            {error && (
                <div className="mb-4">
                    <ErrorMessage message={error} onDismiss={() => setError(null)} />
                </div>
            )}

            {goal.description && (
                <p className="text-sm text-gray-500 mb-4">{goal.description}</p>
            )}
            {goal.investment && (
                <button type="button" onClick={() => setTab('investment')}
                    className="mb-4 inline-flex items-center gap-2 text-sm text-teal-700 bg-teal-50 hover:bg-teal-100 rounded-lg px-3 py-1.5">
                    <BriefcaseIcon className="h-4 w-4 flex-shrink-0" />
                    <span className="text-left">
                        Raising money for <strong>{goal.investment.name}</strong> ({(goal.investment.status || '').toLowerCase()})
                    </span>
                </button>
            )}

            {/* Actions */}
            {canManage && goal.status === 'ACTIVE' && (
                <div className="flex flex-wrap gap-3 mb-4">
                    <button onClick={() => setShowEdit(true)} className="btn-secondary flex items-center gap-2">
                        <PencilIcon className="h-4 w-4" />
                        Edit
                    </button>
                    {needsActivation && (
                        <button onClick={() => setShowActivate(true)} className="btn-primary flex items-center gap-2">
                            <BoltIcon className="h-4 w-4" />
                            Activate Capital Calls
                        </button>
                    )}
                    <button onClick={handleComplete} disabled={actionLoading}
                        className="btn-secondary flex items-center gap-2">
                        <FlagIcon className="h-4 w-4" />
                        Mark Completed
                    </button>
                    <button onClick={() => setShowCancelConfirm(true)} disabled={actionLoading}
                        className="btn-secondary flex items-center gap-2 text-red-600">
                        <XMarkIcon className="h-4 w-4" />
                        Cancel Goal
                    </button>
                </div>
            )}

            {/* v1.48.0 — no shareholder can pledge into this goal at all
                until its monthly call schedule exists. */}
            {needsActivation && (
                <div className="rounded-lg bg-amber-50 border border-amber-100 p-4 mb-4 flex items-start gap-3">
                    <BoltIcon className="h-5 w-5 text-amber-500 flex-shrink-0 mt-0.5" />
                    <div>
                        <p className="text-sm font-medium text-amber-800">
                            Capital calls aren't active for this goal yet
                        </p>
                        <p className="text-xs text-amber-700 mt-0.5">
                            {isCallBased
                                ? "This goal's monthly schedule hasn't been generated yet — no one can pledge into it until it is."
                                : "This goal was created before the pledge system existed, so shareholders have no monthly call to pledge into. An Admin/Treasurer can activate it above."}
                            {!canManage && ' Ask an Admin or Treasurer to activate it.'}
                        </p>
                    </div>
                </div>
            )}

            <div className="tab-bar" role="tablist">
                {tabs.map(t => (
                    <button key={t.key} role="tab" aria-selected={activeTab === t.key}
                        onClick={() => setTab(t.key)}
                        className={`tab ${activeTab === t.key ? 'tab-active' : ''}`}>
                        {t.label}
                        {t.count != null && <span className="ml-2 text-xs opacity-70">({t.count})</span>}
                    </button>
                ))}
            </div>

            {activeTab === 'summary' && (
                <SummaryPanel goal={goal} insights={insights} glance={glance} stats={isCallBased ? stats : null}
                    onTab={setTab} onPledge={(g) => setPledgeTarget(pledgeTargetFor(g))} />
            )}
            {activeTab === 'months' && <MonthsPanel goal={goal} monthlyCalls={monthlyCalls} />}
            {activeTab === 'pledgers' && <PledgersPanel key={reloadKey} goalId={goal.id} />}
            {activeTab === 'investment' && <GoalInvestmentPanel goal={goal} onChanged={refreshAll} />}
            {activeTab === 'activity' && <ActivityPanel key={reloadKey} goalId={goal.id} />}

            <EditGoalModal
                isOpen={showEdit}
                onClose={() => setShowEdit(false)}
                onSuccess={loadGoal}
                goal={goal}
                currencies={currencies}
            />

            <ActivateCallScheduleModal
                isOpen={showActivate}
                onClose={() => setShowActivate(false)}
                onSuccess={refreshAll}
                goal={goal}
            />

            <PledgeModal
                isOpen={!!pledgeTarget}
                onClose={() => setPledgeTarget(null)}
                onSuccess={refreshAll}
                target={pledgeTarget}
                currencies={currencies}
            />

            <ConfirmModal
                isOpen={showCancelConfirm}
                title="Cancel this capital goal?"
                message="This stops tracking progress against it — it won't affect any contributions already recorded."
                confirmLabel="Cancel Goal"
                danger
                loading={actionLoading}
                onConfirm={handleCancel}
                onCancel={() => setShowCancelConfirm(false)}
            />
        </div>
    );
};

export default CapitalGoalDetailPage;
