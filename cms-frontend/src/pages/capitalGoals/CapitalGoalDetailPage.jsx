// ============================================================
// CAPITAL GOAL DETAIL PAGE
// One fundraising goal: target vs actual stats, the expected-vs-
// actual dual-line chart (cumulative, month by month), and Edit/
// Cancel/Mark Completed actions. v1.29.0, Section 4.33.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { capitalGoalsAPI, capitalGoalCallsAPI, accountsAPI } from '../../api/endpoints';
import { formatDate, getErrorMessage } from '../../utils/helpers';
import PageHeader from '../../components/common/PageHeader';
import LoadingSpinner from '../../components/common/LoadingSpinner';
import ErrorMessage from '../../components/common/ErrorMessage';
import StatusBadge from '../../components/common/StatusBadge';
import ConfirmModal from '../../components/common/ConfirmModal';
import { useAuth } from '../../contexts/AuthContext';
import {
    PencilIcon, XMarkIcon, FlagIcon, TrophyIcon, BoltIcon, HandRaisedIcon,
} from '@heroicons/react/24/outline';
import {
    LineChart, Line, XAxis, YAxis, CartesianGrid,
    Tooltip, ResponsiveContainer, Legend,
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
    const [form, setForm] = useState({ goal_type: 'PRIMARY', fiscal_year: '', call_deadline_day: '20' });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [result, setResult] = useState(null);

    useEffect(() => {
        if (isOpen && goal) {
            setForm({
                goal_type: 'PRIMARY',
                fiscal_year: String(new Date(goal.start_date).getUTCFullYear()),
                call_deadline_day: '20',
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
            const res = await capitalGoalsAPI.activateCallSchedule(goal.id, isLegacy ? {
                goal_type: form.goal_type,
                fiscal_year: parseInt(form.fiscal_year),
                call_deadline_day: parseInt(form.call_deadline_day),
            } : {});
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
// STAT TILE
// ============================================================
const StatTile = ({ label, value, tone = 'default' }) => (
    <div className="card">
        <p className="text-xs font-medium text-gray-500">{label}</p>
        <p className={`mt-1 text-xl font-bold ${
            tone === 'good' ? 'text-green-600' : tone === 'bad' ? 'text-red-600' : 'text-gray-900'
        }`}>
            {value}
        </p>
    </div>
);

// ============================================================
// MAIN DETAIL PAGE
// ============================================================
const CapitalGoalDetailPage = () => {
    const { id } = useParams();
    const { hasPermission } = useAuth();
    const canManage = hasPermission('CAPITAL_GOAL_MANAGE');

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

    const loadGoal = useCallback(async () => {
        try {
            setLoading(true);
            const res = await capitalGoalsAPI.getById(id);
            setGoal(res.data.data);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, [id]);

    useEffect(() => {
        loadGoal();
        accountsAPI.getCurrencies().then(r => setCurrencies(r.data.data)).catch(() => {});
    }, [loadGoal]);

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

    const handleActivateSuccess = () => {
        loadGoal();
        refreshCalls();
    };

    // The "current" open call(s) — whichever month(s) a shareholder can
    // still pledge into right now, so this is visible on the goal's
    // own page and not only buried on the separate My Capital Calls
    // page. Prefers ITERATION_1 (the normal case) but also surfaces an
    // ITERATION_2 (second-round) call if that's what's actually open.
    const openMonths = (goal?.months || []).filter(m => m.call_status === 'ITERATION_1' || m.call_status === 'ITERATION_2');

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
        if (!window.confirm('Mark this capital goal as completed?')) return;
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

    const currency = goal.currency_code || '';
    const fmt = (v) => `${currency} ${parseFloat(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

    return (
        <div>
            <PageHeader
                title={goal.title}
                subtitle={`${formatDate(goal.start_date)} – ${formatDate(goal.end_date)} • ${goal.reference_code}`}
                actions={
                    <div className="flex items-center gap-2">
                        <StatusBadge status={goal.status} />
                        {goal.status === 'ACTIVE' && <StatusBadge status={goal.progress_status} />}
                    </div>
                }
            />

            {error && (
                <div className="mb-4">
                    <ErrorMessage message={error} onDismiss={() => setError(null)} />
                </div>
            )}

            {goal.description && (
                <p className="text-sm text-gray-500 mb-6">{goal.description}</p>
            )}

            {/* Actions */}
            {canManage && goal.status === 'ACTIVE' && (
                <div className="flex flex-wrap gap-3 mb-6">
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
                until its monthly call schedule exists. Shown to anyone
                who can see the goal (not just managers) so it's obvious
                why "My Capital Calls" looks empty, rather than a silent
                dead end. */}
            {needsActivation && (
                <div className="rounded-lg bg-amber-50 border border-amber-100 p-4 mb-6 flex items-start gap-3">
                    <BoltIcon className="h-5 w-5 text-amber-500 flex-shrink-0 mt-0.5" />
                    <div>
                        <p className="text-sm font-medium text-amber-800">
                            Capital calls aren't active for this goal yet
                        </p>
                        <p className="text-xs text-amber-700 mt-0.5">
                            {isCallBased
                                ? "This goal's monthly schedule hasn't been generated yet — no one can pledge into it until it is."
                                : "This goal was created before the pledge system existed, so shareholders have no monthly call to pledge into. An Admin/Treasurer can activate it below."}
                            {!canManage && ' Ask an Admin or Treasurer to activate it.'}
                        </p>
                    </div>
                </div>
            )}

            {/* v1.48.0 — the current month's call, front and center on the
                goal's own page (not only on the separate My Capital Calls
                page), so members can see at a glance what's due and by
                when without hunting for it. */}
            {isCallBased && openMonths.length > 0 && (
                <div className="rounded-lg bg-blue-50 border border-blue-100 p-4 mb-6">
                    <div className="flex items-start gap-3">
                        <HandRaisedIcon className="h-5 w-5 text-blue-500 flex-shrink-0 mt-0.5" />
                        <div className="flex-1">
                            <p className="text-sm font-medium text-blue-900">
                                Open for pledges right now: {openMonths.map(m => m.month).join(', ')}
                            </p>
                            <div className="mt-2 space-y-1">
                                {openMonths.map(m => (
                                    <p key={m.month} className="text-xs text-blue-700">
                                        <strong>{m.month}</strong> — target {fmt(m.expected_monthly)}
                                        {m.iteration1_deadline && m.call_status === 'ITERATION_1' &&
                                            ` — due ${formatDate(m.iteration1_deadline)}`}
                                        {m.call_status === 'ITERATION_2' && ' — second-round call, no late fine applies'}
                                    </p>
                                ))}
                            </div>
                            <Link to="/capital-goals/my-calls"
                                className="inline-block mt-3 text-xs font-medium text-blue-700 hover:text-blue-800 px-3 py-1.5 rounded-lg border border-blue-200 hover:bg-blue-100 transition-colors">
                                Go to My Capital Calls to pledge
                            </Link>
                        </div>
                    </div>
                </div>
            )}

            {/* Stats */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                <StatTile label="Target" value={fmt(goal.target_amount)} />
                <StatTile label="Collected So Far" value={fmt(goal.total_collected)} />
                <StatTile label="% of Target" value={`${goal.percent_of_target}%`}
                    tone={goal.percent_of_target >= 100 ? 'good' : 'default'} />
                <StatTile label="Expected By Now" value={fmt(goal.expected_to_date)}
                    tone={goal.status === 'ACTIVE' ? (goal.progress_status === 'BEHIND' ? 'bad' : 'good') : 'default'} />
            </div>

            {/* v1.43.0 — my own contribution stats + the public top-
                contributor callout, only for call-based goals. Names are
                shown here deliberately (unlike the anonymous per-call
                status grid) — this is each member's own running total
                plus a single "who's contributed the most" fact, not a
                pledge-by-pledge breakdown of everyone's standing. */}
            {isCallBased && stats && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
                    <div className="card">
                        <h3 className="section-title mb-3">My Contribution to This Goal</h3>
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <p className="text-xs text-gray-400">Total So Far</p>
                                <p className="text-lg font-bold text-gray-900">{fmt(stats.my_stats.total)}</p>
                                <p className="text-xs text-gray-400">{stats.my_stats.percentage}% of the goal</p>
                            </div>
                            <div>
                                <p className="text-xs text-gray-400">Payments Made</p>
                                <p className="text-lg font-bold text-gray-900">{stats.my_stats.numPayments}</p>
                            </div>
                            <div>
                                <p className="text-xs text-gray-400">Biggest Single Payment</p>
                                <p className="text-sm font-medium text-green-700">{fmt(stats.my_stats.biggest)}</p>
                            </div>
                            <div>
                                <p className="text-xs text-gray-400">Smallest Single Payment</p>
                                <p className="text-sm font-medium text-gray-700">{fmt(stats.my_stats.smallest)}</p>
                            </div>
                        </div>
                    </div>
                    <div className="card flex items-center gap-4">
                        <div className="p-3 rounded-full bg-amber-50 text-amber-500 flex-shrink-0">
                            <TrophyIcon className="h-6 w-6" />
                        </div>
                        <div>
                            <p className="text-xs text-gray-400">Top Contributor</p>
                            {stats.top_contributor ? (
                                <>
                                    <p className="text-base font-bold text-gray-900">{stats.top_contributor.name}</p>
                                    <p className="text-xs text-gray-400">{fmt(stats.top_contributor.total)} contributed so far</p>
                                </>
                            ) : (
                                <p className="text-sm text-gray-400">No settled contributions yet</p>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Dual-line chart — expected vs actual, cumulative */}
            <div className="card mb-6">
                <h3 className="section-title mb-4">Expected vs Actual — Cumulative</h3>
                {goal.months && goal.months.length > 0 ? (
                    <ResponsiveContainer width="100%" height={280}>
                        <LineChart data={goal.months}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                            <XAxis dataKey="month" tick={{ fontSize: 11 }} tickLine={false} />
                            <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false}
                                tickFormatter={v => v.toLocaleString('en-US', { maximumFractionDigits: 0 })} />
                            <Tooltip
                                formatter={(v, name) => [
                                    `${currency} ${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`,
                                    name,
                                ]}
                            />
                            <Legend />
                            <Line type="monotone" dataKey="expected_cumulative" name="Expected"
                                stroke="#9ca3af" strokeWidth={2} strokeDasharray="5 4" dot={{ r: 2 }} />
                            <Line type="monotone" dataKey="actual_cumulative" name="Actual"
                                stroke="#2563eb" strokeWidth={2} dot={{ r: 3 }} />
                        </LineChart>
                    </ResponsiveContainer>
                ) : (
                    <div className="flex items-center justify-center h-48 text-gray-300 text-sm">
                        No months in range
                    </div>
                )}
            </div>

            {/* Monthly breakdown table */}
            <div className="card">
                <h3 className="section-title mb-4">Monthly Breakdown</h3>
                <div className="overflow-x-auto">
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
                                <tr key={m.month}>
                                    <td className="py-2 pr-4 text-gray-700">{m.month}</td>
                                    <td className="py-2 pr-4 text-gray-500">{fmt(m.expected_monthly)}</td>
                                    <td className={`py-2 pr-4 font-medium ${
                                        m.actual_monthly >= m.expected_monthly ? 'text-green-600' : 'text-gray-700'
                                    }`}>{fmt(m.actual_monthly)}</td>
                                    <td className="py-2 pr-4 text-gray-500">{fmt(m.expected_cumulative)}</td>
                                    <td className="py-2 text-gray-900 font-medium">{fmt(m.actual_cumulative)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* v1.43.0 — the actual capital calls shareholders pledge
                against, one per month. Each links to its own page: the
                anonymous colour-coded status grid, plus a pledge form or
                approval queue depending on who's looking. */}
            {isCallBased && (
                <div className="card mt-6">
                    <h3 className="section-title mb-4">Monthly Capital Calls</h3>
                    <div className="overflow-x-auto">
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
                                    <tr key={mc.id}>
                                        <td className="py-2 pr-4 text-gray-900 font-medium">{mc.period}</td>
                                        <td className="py-2 pr-4 text-gray-700">{fmt(mc.monthly_target)}</td>
                                        <td className={`py-2 pr-4 font-medium ${
                                            parseFloat(mc.settled) >= parseFloat(mc.monthly_target) ? 'text-green-600' : 'text-gray-700'
                                        }`}>{fmt(mc.settled)}</td>
                                        <td className="py-2 pr-4 text-gray-500">{formatDate(mc.iteration1_deadline)}</td>
                                        <td className="py-2 pr-4 text-gray-500">
                                            {mc.iteration2_deadline ? formatDate(mc.iteration2_deadline) : '—'}
                                        </td>
                                        <td className="py-2 pr-4"><StatusBadge status={mc.status} /></td>
                                        <td className="py-2">
                                            <Link to={`/capital-goals/monthly-calls/${mc.id}`}
                                                className="text-xs text-primary-700 hover:text-primary-800 font-medium px-2 py-1 rounded border border-primary-200 hover:bg-primary-50 transition-colors">
                                                View
                                            </Link>
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
                onSuccess={handleActivateSuccess}
                goal={goal}
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
