// ============================================================
// CAPITAL GOALS PAGE
// Lists every capital fundraising goal — a target amount of
// shareholder capital to raise over a date range, with a live
// on-track/behind read against actual contributions. v1.29.0,
// Section 4.33.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { capitalGoalsAPI, accountsAPI } from '../../api/endpoints';
import { formatDate, getErrorMessage } from '../../utils/helpers';
import PageHeader from '../../components/common/PageHeader';
import DataTable from '../../components/common/DataTable';
import ErrorMessage from '../../components/common/ErrorMessage';
import StatusBadge from '../../components/common/StatusBadge';
import { useAuth } from '../../contexts/AuthContext';
import { PlusIcon } from '@heroicons/react/24/outline';

const BLANK_FORM = {
    title: '', description: '', target_amount: '',
    currency_id: '', start_date: '', end_date: '',
};

// ============================================================
// CREATE GOAL MODAL
// ============================================================
const CreateGoalModal = ({ isOpen, onClose, onSuccess, currencies }) => {
    const [form, setForm] = useState(BLANK_FORM);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    if (!isOpen) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await capitalGoalsAPI.create({
                title: form.title,
                description: form.description || undefined,
                target_amount: parseFloat(form.target_amount),
                currency_id: form.currency_id,
                start_date: form.start_date,
                end_date: form.end_date,
            });
            onSuccess();
            onClose();
            setForm(BLANK_FORM);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    // Live preview of the even monthly split, so whoever's setting the
    // goal can see roughly what "on track" will mean before submitting.
    let monthlyPreview = null;
    if (form.target_amount && form.start_date && form.end_date &&
        new Date(form.end_date) >= new Date(form.start_date)) {
        const s = new Date(form.start_date);
        const e = new Date(form.end_date);
        const months = (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth()) + 1;
        if (months > 0) {
            monthlyPreview = (parseFloat(form.target_amount) / months).toLocaleString('en-US', { maximumFractionDigits: 2 });
        }
    }

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            <div className="fixed inset-0 bg-black bg-opacity-40" onClick={onClose} />
            <div className="flex min-h-full items-center justify-center p-4">
                <div className="relative bg-white rounded-xl shadow-xl max-w-lg w-full p-6">
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">New Capital Goal</h2>
                    <p className="text-sm text-gray-400 mb-4">
                        A target amount of shareholder capital to raise over a date range —
                        the system splits it evenly across the months for you and tracks
                        actual contributions against that automatically.
                    </p>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">Title *</label>
                            <input type="text" className="input" value={form.title}
                                onChange={e => setForm(p => ({ ...p, title: e.target.value }))}
                                placeholder="e.g. 2026 Capital Drive" required />
                        </div>
                        <div>
                            <label className="label">Description</label>
                            <textarea className="input" rows={2}
                                value={form.description}
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
                                    onChange={e => setForm(p => ({ ...p, currency_id: e.target.value }))}
                                    required>
                                    <option value="">Select currency...</option>
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
                                    onChange={e => setForm(p => ({ ...p, start_date: e.target.value }))}
                                    required />
                            </div>
                            <div>
                                <label className="label">End Date *</label>
                                <input type="date" className="input" value={form.end_date}
                                    min={form.start_date || undefined}
                                    onChange={e => setForm(p => ({ ...p, end_date: e.target.value }))}
                                    required />
                            </div>
                        </div>
                        {monthlyPreview && (
                            <p className="text-xs text-gray-400 bg-gray-50 rounded-lg px-3 py-2">
                                ≈ {monthlyPreview} expected per month over this range
                            </p>
                        )}
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading} className="btn-primary">
                                {loading ? 'Saving...' : 'Create Goal'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// MAIN CAPITAL GOALS PAGE
// ============================================================
const CapitalGoalsPage = () => {
    const { hasPermission } = useAuth();
    const [goals,      setGoals]      = useState([]);
    const [currencies, setCurrencies] = useState([]);
    const [pagination, setPagination] = useState(null);
    const [loading,    setLoading]    = useState(true);
    const [error,      setError]      = useState(null);
    const [page,       setPage]       = useState(1);
    const [statusFilter, setStatusFilter] = useState('');
    const [showCreate, setShowCreate] = useState(false);

    const loadGoals = useCallback(async () => {
        try {
            setLoading(true);
            const params = { page, limit: 20 };
            if (statusFilter) params.status = statusFilter;
            const res = await capitalGoalsAPI.getAll(params);
            setGoals(res.data.data);
            setPagination(res.data.meta?.pagination);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, [page, statusFilter]);

    useEffect(() => {
        loadGoals();
        accountsAPI.getCurrencies().then(r => setCurrencies(r.data.data)).catch(() => {});
    }, [loadGoals]);

    const columns = [
        {
            header: 'Reference',
            render: row => (
                <div>
                    <span className="font-mono text-xs font-medium text-primary-700">
                        {row.reference_code}
                    </span>
                    {row.public_id && (
                        <div className="font-mono text-[10px] text-gray-400" title="Public ID — searchable">
                            {row.public_id}
                        </div>
                    )}
                </div>
            ),
        },
        {
            header: 'Goal',
            render: row => (
                <div>
                    <Link to={`/capital-goals/${row.id}`}
                        className="text-sm font-medium text-primary-700 hover:text-primary-800 hover:underline">
                        {row.title}
                    </Link>
                    <p className="text-xs text-gray-400">
                        {formatDate(row.start_date)} – {formatDate(row.end_date)}
                    </p>
                </div>
            ),
        },
        {
            header: 'Target',
            render: row => (
                <span className="text-sm font-semibold text-gray-900">
                    {row.currency_code}{' '}
                    {parseFloat(row.target_amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                </span>
            ),
        },
        {
            header: 'Collected',
            render: row => (
                <div>
                    <span className="text-sm text-gray-700">
                        {row.currency_code}{' '}
                        {parseFloat(row.total_collected).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                    </span>
                    <div className="w-28 h-1.5 bg-gray-100 rounded-full mt-1 overflow-hidden">
                        <div className={`h-full rounded-full ${
                            row.progress_status === 'BEHIND' ? 'bg-red-500' : 'bg-green-500'
                        }`} style={{ width: `${Math.min(100, row.percent_of_target)}%` }} />
                    </div>
                    <p className="text-[11px] text-gray-400 mt-0.5">{row.percent_of_target}% of target</p>
                </div>
            ),
        },
        {
            header: 'Progress',
            render: row => (
                row.status === 'ACTIVE' ? (
                    <StatusBadge status={row.progress_status} />
                ) : (
                    <span className="text-gray-300 text-xs">—</span>
                )
            ),
        },
        {
            header: 'Status',
            render: row => <StatusBadge status={row.status} />,
        },
    ];

    return (
        <div>
            <PageHeader
                title="Capital Goals"
                subtitle="Fundraising targets — a monthly split is generated automatically and tracked against actual contributions"
                actions={
                    hasPermission('CAPITAL_GOAL_MANAGE') && (
                        <button onClick={() => setShowCreate(true)} className="btn-primary flex items-center gap-2">
                            <PlusIcon className="h-4 w-4" />
                            New Goal
                        </button>
                    )
                }
            />

            {error && (
                <div className="mb-4">
                    <ErrorMessage message={error} onDismiss={() => setError(null)} />
                </div>
            )}

            <div className="card mb-6">
                <div className="flex gap-2 flex-wrap">
                    {['', 'ACTIVE', 'COMPLETED', 'CANCELLED'].map(s => (
                        <button key={s}
                            onClick={() => { setStatusFilter(s); setPage(1); }}
                            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                                statusFilter === s
                                    ? 'bg-primary-700 text-white'
                                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                            }`}>
                            {s || 'All'}
                        </button>
                    ))}
                </div>
            </div>

            <DataTable
                columns={columns}
                data={goals}
                loading={loading}
                emptyMessage="No capital goals found"
                searchable
                searchPlaceholder="Search goals..."
                pagination={pagination}
                onPageChange={setPage}
            />

            <CreateGoalModal
                isOpen={showCreate}
                onClose={() => setShowCreate(false)}
                onSuccess={loadGoals}
                currencies={currencies}
            />
        </div>
    );
};

export default CapitalGoalsPage;
