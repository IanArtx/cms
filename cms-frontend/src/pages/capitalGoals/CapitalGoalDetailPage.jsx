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
    PencilIcon, XMarkIcon, FlagIcon, TrophyIcon,
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
    useEffect(() => {
        if (!isCallBased) return;
        capitalGoalCallsAPI.listMonthlyCallsForGoal(id).then(r => setMonthlyCalls(r.data.data || [])).catch(() => {});
        capitalGoalCallsAPI.getGoalContributionStats(id).then(r => setStats(r.data.data)).catch(() => {});
    }, [id, isCallBased]);

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
