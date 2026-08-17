// ============================================================
// MMF DETAIL PAGE
// Dedicated page for one Money Market Fund sub-account: balance,
// principal/withdrawn/interest/fee totals, ROI, a funding/return
// chart, and every top-up/withdrawal/interest/fee entry.
// v1.28.0, Section 4.31.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { mmfAPI, categoriesAPI } from '../../api/endpoints';
import { formatDate, getErrorMessage } from '../../utils/helpers';
import PageHeader from '../../components/common/PageHeader';
import LoadingSpinner from '../../components/common/LoadingSpinner';
import ErrorMessage from '../../components/common/ErrorMessage';
import StatusBadge from '../../components/common/StatusBadge';
import { useAuth } from '../../contexts/AuthContext';
import {
    ArrowUpCircleIcon,
    ArrowDownCircleIcon,
    BanknotesIcon,
    ReceiptPercentIcon,
    LockClosedIcon,
    CircleStackIcon,
} from '@heroicons/react/24/outline';
import {
    LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
    Tooltip, ResponsiveContainer, Legend,
} from 'recharts';

// ============================================================
// SHARED MODAL SHELL — amount + date (+ optional category) form,
// used by Top Up, Withdraw, Interest and Fee (each just supplies
// its own title, extra fields, and submit handler).
// ============================================================
const MmfActionModal = ({ isOpen, onClose, title, children, onSubmit, loading, error, setError, submitLabel }) => {
    if (!isOpen) return null;
    return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            <div className="fixed inset-0 bg-black bg-opacity-40" onClick={onClose} />
            <div className="flex min-h-full items-center justify-center p-4">
                <div className="relative bg-white rounded-xl shadow-xl max-w-lg w-full p-6">
                    <h2 className="text-lg font-semibold text-gray-900 mb-4">{title}</h2>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={onSubmit} className="space-y-4">
                        {children}
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose}
                                className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading}
                                className="btn-primary">
                                {loading ? 'Saving...' : submitLabel}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// TOP UP / WITHDRAW MODAL (shared shape — amount, category, date)
// ============================================================
const MoveMoneyModal = ({ isOpen, onClose, onSuccess, mmf, categories, mode }) => {
    const [form, setForm] = useState({ amount: '', category_id: '', entry_date: '', description: '' });
    const [loading, setLoading] = useState(false);
    const [error,   setError]   = useState(null);
    const isWithdraw = mode === 'withdraw';
    const mmfCategories = categories.filter(c => c.module === 'INVESTMENT');

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            const payload = { ...form, amount: parseFloat(form.amount) };
            if (isWithdraw) await mmfAPI.withdraw(mmf.id, payload);
            else await mmfAPI.topUp(mmf.id, payload);
            onSuccess();
            onClose();
            setForm({ amount: '', category_id: '', entry_date: '', description: '' });
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    return (
        <MmfActionModal
            isOpen={isOpen} onClose={onClose} onSubmit={handleSubmit}
            loading={loading} error={error} setError={setError}
            title={isWithdraw ? 'Withdraw from MMF' : 'Top Up MMF'}
            submitLabel={isWithdraw ? 'Withdraw' : 'Top Up'}
        >
            <div>
                <label className="label">Amount {mmf.currency_code} *</label>
                <input type="number" className="input" value={form.amount}
                    onChange={e => setForm(p => ({ ...p, amount: e.target.value }))}
                    min="0.01" step="0.01" required />
                {isWithdraw && (
                    <p className="text-xs text-gray-400 mt-1">
                        MMF currently holds {mmf.currency_code}{' '}
                        {parseFloat(mmf.current_balance).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                    </p>
                )}
            </div>
            <div>
                <label className="label">Category *</label>
                <select className="input" value={form.category_id}
                    onChange={e => setForm(p => ({ ...p, category_id: e.target.value }))}
                    required>
                    <option value="">Select category...</option>
                    {mmfCategories.map(c => (
                        <option key={c.id} value={c.id}>{c.full_path || c.name}</option>
                    ))}
                </select>
            </div>
            <div>
                <label className="label">Date *</label>
                <input type="date" className="input" value={form.entry_date}
                    max={new Date().toISOString().slice(0, 10)}
                    onChange={e => setForm(p => ({ ...p, entry_date: e.target.value }))}
                    required />
            </div>
            <div>
                <label className="label">Description</label>
                <input type="text" className="input" value={form.description}
                    onChange={e => setForm(p => ({ ...p, description: e.target.value }))} />
            </div>
        </MmfActionModal>
    );
};

// ============================================================
// RECORD INTEREST MODAL — manual monthly entry
// ============================================================
const RecordInterestModal = ({ isOpen, onClose, onSuccess, mmf }) => {
    const [form, setForm] = useState({ amount: '', interest_period: '', entry_date: '', description: '' });
    const [loading, setLoading] = useState(false);
    const [error,   setError]   = useState(null);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await mmfAPI.recordInterest(mmf.id, { ...form, amount: parseFloat(form.amount) });
            onSuccess();
            onClose();
            setForm({ amount: '', interest_period: '', entry_date: '', description: '' });
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    return (
        <MmfActionModal
            isOpen={isOpen} onClose={onClose} onSubmit={handleSubmit}
            loading={loading} error={error} setError={setError}
            title="Record Monthly Interest" submitLabel="Record Interest"
        >
            <p className="text-xs text-gray-500 -mt-1">
                The MMF provider credits interest daily but it's accounted for once a
                month — enter the actual amount credited for the month selected below.
                Only one entry is allowed per calendar month.
            </p>
            <div>
                <label className="label">Amount {mmf.currency_code} *</label>
                <input type="number" className="input" value={form.amount}
                    onChange={e => setForm(p => ({ ...p, amount: e.target.value }))}
                    min="0.01" step="0.01" required />
            </div>
            <div>
                <label className="label">For Month *</label>
                <input type="month" className="input"
                    value={form.interest_period ? form.interest_period.slice(0, 7) : ''}
                    onChange={e => setForm(p => ({ ...p, interest_period: `${e.target.value}-01` }))}
                    required />
            </div>
            <div>
                <label className="label">Entry Date *</label>
                <input type="date" className="input" value={form.entry_date}
                    max={new Date().toISOString().slice(0, 10)}
                    onChange={e => setForm(p => ({ ...p, entry_date: e.target.value }))}
                    required />
            </div>
            <div>
                <label className="label">Notes</label>
                <input type="text" className="input" value={form.description}
                    onChange={e => setForm(p => ({ ...p, description: e.target.value }))} />
            </div>
        </MmfActionModal>
    );
};

// ============================================================
// RECORD MANAGEMENT FEE MODAL — the one allowed expense
// ============================================================
const RecordFeeModal = ({ isOpen, onClose, onSuccess, mmf }) => {
    const [form, setForm] = useState({ amount: '', entry_date: '', description: '' });
    const [loading, setLoading] = useState(false);
    const [error,   setError]   = useState(null);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await mmfAPI.recordFee(mmf.id, { ...form, amount: parseFloat(form.amount) });
            onSuccess();
            onClose();
            setForm({ amount: '', entry_date: '', description: '' });
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    return (
        <MmfActionModal
            isOpen={isOpen} onClose={onClose} onSubmit={handleSubmit}
            loading={loading} error={error} setError={setError}
            title="Record Management Fee" submitLabel="Record Fee"
        >
            <p className="text-xs text-gray-500 -mt-1">
                Deducted straight from this MMF's own balance — the only expense this
                sub-account can have, whether paid at withdrawal or at a regular interval.
            </p>
            <div>
                <label className="label">Amount {mmf.currency_code} *</label>
                <input type="number" className="input" value={form.amount}
                    onChange={e => setForm(p => ({ ...p, amount: e.target.value }))}
                    min="0.01" step="0.01" required />
            </div>
            <div>
                <label className="label">Date *</label>
                <input type="date" className="input" value={form.entry_date}
                    max={new Date().toISOString().slice(0, 10)}
                    onChange={e => setForm(p => ({ ...p, entry_date: e.target.value }))}
                    required />
            </div>
            <div>
                <label className="label">Notes</label>
                <input type="text" className="input" value={form.description}
                    onChange={e => setForm(p => ({ ...p, description: e.target.value }))} />
            </div>
        </MmfActionModal>
    );
};

const ENTRY_META = {
    TOPUP:           { label: 'Top Up',          badge: 'badge-blue',   sign: '+' },
    WITHDRAWAL:      { label: 'Withdrawal',       badge: 'badge-red',    sign: '-' },
    INTEREST:        { label: 'Interest',         badge: 'badge-green', sign: '+' },
    MANAGEMENT_FEE:  { label: 'Management Fee',   badge: 'badge-yellow', sign: '-' },
};

// ============================================================
// MAIN MMF DETAIL PAGE
// ============================================================
const MmfDetailPage = () => {
    const { id } = useParams();
    const { hasPermission } = useAuth();

    const [mmf,        setMmf]        = useState(null);
    const [categories, setCategories] = useState([]);
    const [loading,    setLoading]    = useState(true);
    const [error,      setError]      = useState(null);
    const [showTopUp,    setShowTopUp]    = useState(false);
    const [showWithdraw, setShowWithdraw] = useState(false);
    const [showInterest, setShowInterest] = useState(false);
    const [showFee,      setShowFee]      = useState(false);
    const [closing,      setClosing]      = useState(false);

    const loadMmf = useCallback(async () => {
        try {
            setLoading(true);
            const res = await mmfAPI.getById(id);
            setMmf(res.data.data);
            setError(null);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, [id]);

    useEffect(() => {
        loadMmf();
        categoriesAPI.getAll({ flat: true }).then(r => setCategories(r.data.data)).catch(() => {});
    }, [loadMmf]);

    const handleClose = async () => {
        setClosing(true);
        setError(null);
        try {
            await mmfAPI.close(id);
            loadMmf();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setClosing(false);
        }
    };

    if (loading) {
        return <LoadingSpinner fullPage text="Loading MMF sub-account..." />;
    }

    if (error || !mmf) {
        return (
            <div>
                <PageHeader title="Money Market Fund" showBack backTo="/mmf" />
                <ErrorMessage message={error || 'MMF sub-account not found'} />
            </div>
        );
    }

    const currency = mmf.currency_code;
    const transactions = mmf.transactions || [];
    const canManage = hasPermission('MMF_MANAGE');
    const canClose = canManage && mmf.status === 'ACTIVE' && parseFloat(mmf.current_balance) === 0;

    // ---- Running balance over time (funding chart) ----
    let running = 0;
    const balanceChartData = transactions.map(t => {
        const isCredit = t.entry_type === 'TOPUP' || t.entry_type === 'INTEREST';
        running += isCredit ? parseFloat(t.amount) : -parseFloat(t.amount);
        return { date: formatDate(t.entry_date), balance: running };
    });

    // ---- Interest vs Management Fee by month (return chart) ----
    const monthTotals = {};
    transactions.forEach(t => {
        if (t.entry_type !== 'INTEREST' && t.entry_type !== 'MANAGEMENT_FEE') return;
        const monthKey = (t.interest_period || t.entry_date).slice(0, 7);
        if (!monthTotals[monthKey]) monthTotals[monthKey] = { month: monthKey, Interest: 0, Fees: 0 };
        if (t.entry_type === 'INTEREST') monthTotals[monthKey].Interest += parseFloat(t.amount);
        else monthTotals[monthKey].Fees += parseFloat(t.amount);
    });
    const returnChartData = Object.values(monthTotals).sort((a, b) => a.month.localeCompare(b.month));

    return (
        <div>
            <PageHeader
                title={mmf.name}
                subtitle={`${mmf.reference_code} • ${mmf.parent_account_name} (${mmf.parent_account_type})`}
                showBack backTo="/mmf"
                actions={<StatusBadge status={mmf.status} />}
            />

            {/* Stats banner */}
            <div className="card-gradient mb-6 p-6 text-white">
                <div className="flex items-start justify-between flex-wrap gap-4">
                    <div className="flex items-center gap-3">
                        <CircleStackIcon className="h-8 w-8 opacity-80" />
                        <div>
                            <p className="text-sm opacity-70">{mmf.provider || 'No provider set'}</p>
                            <p className="text-2xl font-bold mt-0.5">
                                {currency} {parseFloat(mmf.current_balance).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                            </p>
                            <p className="text-xs opacity-70 mt-0.5">Current MMF Balance</p>
                        </div>
                    </div>
                    <div className="text-right">
                        <p className="text-sm opacity-70">Return on Investment</p>
                        <p className={`text-3xl font-bold mt-0.5 ${
                            parseFloat(mmf.roi_percentage) >= 0 ? 'text-green-300' : 'text-red-300'
                        }`}>
                            {mmf.roi_percentage}%
                        </p>
                    </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-6">
                    <div className="bg-white bg-opacity-10 rounded-lg p-3">
                        <p className="text-xs opacity-70">Principal In</p>
                        <p className="text-lg font-bold mt-1">
                            {currency} {parseFloat(mmf.total_principal_in).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                        </p>
                    </div>
                    <div className="bg-white bg-opacity-10 rounded-lg p-3">
                        <p className="text-xs opacity-70">Withdrawn</p>
                        <p className="text-lg font-bold mt-1">
                            {currency} {parseFloat(mmf.total_withdrawn).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                        </p>
                    </div>
                    <div className="bg-white bg-opacity-10 rounded-lg p-3">
                        <p className="text-xs opacity-70">Interest Earned</p>
                        <p className="text-lg font-bold mt-1 text-green-300">
                            {currency} {parseFloat(mmf.total_interest).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                        </p>
                    </div>
                    <div className="bg-white bg-opacity-10 rounded-lg p-3">
                        <p className="text-xs opacity-70">Management Fees</p>
                        <p className="text-lg font-bold mt-1 text-red-300">
                            {currency} {parseFloat(mmf.total_management_fees).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                        </p>
                    </div>
                </div>
            </div>

            {/* Actions */}
            {canManage && mmf.status === 'ACTIVE' && (
                <div className="flex items-center gap-3 mb-6 flex-wrap">
                    <button onClick={() => setShowTopUp(true)} className="btn-primary flex items-center gap-2">
                        <ArrowUpCircleIcon className="h-4 w-4" />
                        Top Up
                    </button>
                    <button onClick={() => setShowWithdraw(true)} className="btn-secondary flex items-center gap-2">
                        <ArrowDownCircleIcon className="h-4 w-4" />
                        Withdraw
                    </button>
                    <button onClick={() => setShowInterest(true)} className="btn-secondary flex items-center gap-2">
                        <BanknotesIcon className="h-4 w-4" />
                        Record Interest
                    </button>
                    <button onClick={() => setShowFee(true)} className="btn-secondary flex items-center gap-2">
                        <ReceiptPercentIcon className="h-4 w-4" />
                        Record Management Fee
                    </button>
                    {canClose && (
                        <button onClick={handleClose} disabled={closing}
                            className="btn-secondary flex items-center gap-2 ml-auto">
                            <LockClosedIcon className="h-4 w-4" />
                            {closing ? 'Closing...' : 'Close MMF'}
                        </button>
                    )}
                </div>
            )}

            {/* Charts */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
                <div className="card">
                    <h3 className="section-title mb-4">Funding Chart — Balance Over Time</h3>
                    {balanceChartData.length > 0 ? (
                        <ResponsiveContainer width="100%" height={220}>
                            <LineChart data={balanceChartData}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                                <XAxis dataKey="date" tick={{ fontSize: 11 }} tickLine={false} />
                                <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false}
                                    tickFormatter={v => v.toLocaleString('en-US', { maximumFractionDigits: 0 })} />
                                <Tooltip
                                    formatter={(v) => [`${currency} ${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`, 'Balance']}
                                />
                                <Line type="monotone" dataKey="balance" stroke="#2563eb" strokeWidth={2} dot={{ r: 3 }} />
                            </LineChart>
                        </ResponsiveContainer>
                    ) : (
                        <div className="flex items-center justify-center h-48 text-gray-300 text-sm">
                            No activity recorded yet
                        </div>
                    )}
                </div>

                <div className="card">
                    <h3 className="section-title mb-4">Return Chart — Interest vs Fees by Month</h3>
                    {returnChartData.length > 0 ? (
                        <ResponsiveContainer width="100%" height={220}>
                            <BarChart data={returnChartData}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                                <XAxis dataKey="month" tick={{ fontSize: 11 }} tickLine={false} />
                                <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false}
                                    tickFormatter={v => v.toLocaleString('en-US', { maximumFractionDigits: 0 })} />
                                <Tooltip
                                    formatter={(v) => [`${currency} ${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`]}
                                />
                                <Legend />
                                <Bar dataKey="Interest" fill="#16a34a" radius={[4, 4, 0, 0]} />
                                <Bar dataKey="Fees" fill="#dc2626" radius={[4, 4, 0, 0]} />
                            </BarChart>
                        </ResponsiveContainer>
                    ) : (
                        <div className="flex items-center justify-center h-48 text-gray-300 text-sm">
                            No interest or fees recorded yet
                        </div>
                    )}
                </div>
            </div>

            {/* Transaction history */}
            <div className="card mb-6">
                <h3 className="section-title mb-4">
                    Transaction History ({transactions.length})
                </h3>
                {transactions.length === 0 ? (
                    <p className="text-sm text-gray-400 text-center py-8">
                        No transactions recorded yet
                    </p>
                ) : (
                    <div className="overflow-x-auto -mx-2">
                        <table className="min-w-full text-sm">
                            <thead>
                                <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                                    <th className="px-2 py-2 font-medium">Date</th>
                                    <th className="px-2 py-2 font-medium">Type</th>
                                    <th className="px-2 py-2 font-medium">Reference</th>
                                    <th className="px-2 py-2 font-medium">Description</th>
                                    <th className="px-2 py-2 font-medium text-right">Amount</th>
                                    <th className="px-2 py-2 font-medium">Recorded By</th>
                                </tr>
                            </thead>
                            <tbody>
                                {[...transactions].reverse().map(t => {
                                    const meta = ENTRY_META[t.entry_type] || {};
                                    return (
                                        <tr key={t.id} className="border-b border-gray-50 last:border-0">
                                            <td className="px-2 py-2 text-gray-700">{formatDate(t.entry_date)}</td>
                                            <td className="px-2 py-2">
                                                <span className={`text-xs ${meta.badge || 'badge-gray'}`}>
                                                    {meta.label || t.entry_type}
                                                </span>
                                            </td>
                                            <td className="px-2 py-2 font-mono text-xs text-gray-500">
                                                {t.reference_code}
                                            </td>
                                            <td className="px-2 py-2 text-gray-600">{t.description || '—'}</td>
                                            <td className={`px-2 py-2 text-right font-medium ${
                                                meta.sign === '+' ? 'text-green-600' : 'text-red-600'
                                            }`}>
                                                {meta.sign}{currency} {parseFloat(t.amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                                            </td>
                                            <td className="px-2 py-2 text-gray-500">{t.recorded_by_name}</td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* Details footer */}
            <div className="card">
                <h3 className="section-title mb-4">Details</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
                    <div>
                        <p className="text-gray-400 text-xs">Parent Account</p>
                        <p className="text-gray-900 font-medium mt-0.5">
                            {mmf.parent_account_name} ({mmf.parent_account_type})
                        </p>
                    </div>
                    <div>
                        <p className="text-gray-400 text-xs">Opened</p>
                        <p className="text-gray-900 font-medium mt-0.5">{formatDate(mmf.opened_date)}</p>
                    </div>
                    <div>
                        <p className="text-gray-400 text-xs">Closed</p>
                        <p className="text-gray-900 font-medium mt-0.5">
                            {mmf.closed_date ? formatDate(mmf.closed_date) : '—'}
                        </p>
                    </div>
                    <div>
                        <p className="text-gray-400 text-xs">Created By</p>
                        <p className="text-gray-900 font-medium mt-0.5">{mmf.created_by_name}</p>
                    </div>
                </div>
                {mmf.description && (
                    <p className="text-sm text-gray-500 mt-4 pt-4 border-t border-gray-100">
                        {mmf.description}
                    </p>
                )}
            </div>

            <MoveMoneyModal isOpen={showTopUp} onClose={() => setShowTopUp(false)}
                onSuccess={loadMmf} mmf={mmf} categories={categories} mode="topup" />
            <MoveMoneyModal isOpen={showWithdraw} onClose={() => setShowWithdraw(false)}
                onSuccess={loadMmf} mmf={mmf} categories={categories} mode="withdraw" />
            <RecordInterestModal isOpen={showInterest} onClose={() => setShowInterest(false)}
                onSuccess={loadMmf} mmf={mmf} />
            <RecordFeeModal isOpen={showFee} onClose={() => setShowFee(false)}
                onSuccess={loadMmf} mmf={mmf} />
        </div>
    );
};

export default MmfDetailPage;
