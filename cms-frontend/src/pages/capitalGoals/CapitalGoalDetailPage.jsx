// ============================================================
// CAPITAL GOAL DETAIL PAGE
// One fundraising goal: target vs actual stats, the expected-vs-
// actual dual-line chart (cumulative, month by month), and Edit/
// Cancel/Mark Completed actions. v1.29.0, Section 4.33.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { capitalGoalsAPI, accountsAPI } from '../../api/endpoints';
import { formatDate, getErrorMessage } from '../../utils/helpers';
import PageHeader from '../../components/common/PageHeader';
import LoadingSpinner from '../../components/common/LoadingSpinner';
import ErrorMessage from '../../components/common/ErrorMessage';
import StatusBadge from '../../components/common/StatusBadge';
import ConfirmModal from '../../components/common/ConfirmModal';
import { useAuth } from '../../contexts/AuthContext';
import {
    PencilIcon, XMarkIcon, FlagIcon,
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
            await capitalGoalsAPI.update(goal.id, {
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
                    <h2 className="text-lg font-semibold text-gray-900 mb-4">Edit Capital Goal</h2>
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
