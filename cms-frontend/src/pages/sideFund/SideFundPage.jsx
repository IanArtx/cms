// ============================================================
// SIDE FUND PAGE
// An optional shared petty-cash-style pool that lives inside an
// existing Primary/Secondary account. Members owe a monthly due
// (auto-generated, can go unpaid/"defaulted"); Treasury records
// payments and expenses against the pool.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { sideFundAPI, accountsAPI, categoriesAPI } from '../../api/endpoints';
import { formatDate, formatNumber, getErrorMessage } from '../../utils/helpers';
import PageHeader from '../../components/common/PageHeader';
import DataTable from '../../components/common/DataTable';
import ErrorMessage from '../../components/common/ErrorMessage';
import StatusBadge from '../../components/common/StatusBadge';
import { useAuth } from '../../contexts/AuthContext';
import { PlusIcon, Cog6ToothIcon, BanknotesIcon, CheckCircleIcon } from '@heroicons/react/24/outline';

// ============================================================
// SETTINGS / ACTIVATION MODAL — Admin/Treasurer
// ============================================================
const SettingsModal = ({ isOpen, onClose, onSuccess, config, accounts }) => {
    const [form, setForm] = useState({ is_active: false, parent_account_id: '', monthly_amount: '' });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (isOpen && config) {
            setForm({
                is_active: !!config.is_active,
                parent_account_id: config.parent_account_id || '',
                monthly_amount: config.monthly_amount || '',
            });
        }
    }, [isOpen, config]);

    if (!isOpen) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await sideFundAPI.updateSettings({
                is_active: form.is_active,
                parent_account_id: form.parent_account_id ? parseInt(form.parent_account_id) : undefined,
                monthly_amount: form.monthly_amount !== '' ? parseFloat(form.monthly_amount) : undefined,
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
                <div className="relative bg-white rounded-xl shadow-xl max-w-md w-full p-6">
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">Side Fund Settings</h2>
                    <p className="text-sm text-gray-400 mb-4">
                        The side fund lives inside an existing account — it's an earmarked balance, not a
                        separate bank account. Changing the parent account is only possible while the fund is empty.
                    </p>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div className="flex items-center justify-between border border-gray-200 rounded-lg px-3 py-2.5">
                            <span className="text-sm font-medium text-gray-700">Side fund active</span>
                            <button type="button"
                                onClick={() => setForm(p => ({ ...p, is_active: !p.is_active }))}
                                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                                    form.is_active ? 'bg-primary-600' : 'bg-gray-300'
                                }`}>
                                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                                    form.is_active ? 'translate-x-6' : 'translate-x-1'
                                }`} />
                            </button>
                        </div>
                        <div>
                            <label className="label">Parent Account {form.is_active ? '*' : ''}</label>
                            <select className="input" value={form.parent_account_id}
                                onChange={e => setForm(p => ({ ...p, parent_account_id: e.target.value }))}
                                required={form.is_active}>
                                <option value="">Select account...</option>
                                {accounts.map(a => (
                                    <option key={a.id} value={a.id}>{a.name} ({a.account_type})</option>
                                ))}
                            </select>
                            {parseFloat(config?.current_balance || 0) > 0 && (
                                <p className="text-xs text-amber-600 mt-1">
                                    The fund currently holds a balance — spend it to zero before changing accounts.
                                </p>
                            )}
                        </div>
                        <div>
                            <label className="label">Monthly Due Per Member *</label>
                            <input type="number" className="input" value={form.monthly_amount}
                                onChange={e => setForm(p => ({ ...p, monthly_amount: e.target.value }))}
                                min="0" step="0.01" required />
                            <p className="text-xs text-gray-400 mt-1">
                                Changing this only affects dues generated from next month onward.
                            </p>
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading} className="btn-primary">
                                {loading ? 'Saving...' : 'Save Settings'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// RECORD DUE PAYMENT MODAL — Treasurer/Assistant Treasurer
// ============================================================
const PayDueModal = ({ isOpen, onClose, onSuccess, due, categories }) => {
    const [form, setForm] = useState({ amount: '', category_id: '', paid_date: '', notes: '' });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [result, setResult] = useState(null);

    useEffect(() => {
        if (isOpen && due) {
            const outstanding = parseFloat(due.amount_due) - parseFloat(due.amount_paid);
            setForm({
                amount: outstanding > 0 ? outstanding.toFixed(2) : '',
                category_id: '',
                paid_date: new Date().toISOString().slice(0, 10),
                notes: '',
            });
            setResult(null);
        }
    }, [isOpen, due]);

    if (!isOpen || !due) return null;

    const outstanding = parseFloat(due.amount_due) - parseFloat(due.amount_paid);
    const financeCategories = categories.filter(c => c.module === 'FINANCE');

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            const res = await sideFundAPI.payDue(due.id, { ...form, amount: parseFloat(form.amount) });
            // Paying more than the outstanding amount for this one period is
            // allowed — the backend cascades any extra to this member's
            // other unpaid periods (oldest first) and banks whatever's left
            // as credit toward future months. Show that outcome here rather
            // than closing silently, since it can affect several periods.
            setResult(res.data.data);
            onSuccess();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    const handleDone = () => {
        setResult(null);
        onClose();
    };

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            <div className="fixed inset-0 bg-black bg-opacity-40" onClick={result ? handleDone : onClose} />
            <div className="flex min-h-full items-center justify-center p-4">
                <div className="relative bg-white rounded-xl shadow-xl max-w-md w-full p-6">
                    {result ? (
                        <>
                            <h2 className="text-lg font-semibold text-gray-900 mb-1">Payment Recorded</h2>
                            <p className="text-sm text-gray-400 mb-4">Reference: {result.reference}</p>
                            <div className="space-y-2 mb-4">
                                {result.settled?.map((s, i) => (
                                    <div key={i} className="flex justify-between text-sm bg-gray-50 rounded-lg px-3 py-2">
                                        <span className="text-gray-700">{s.period}{s.new_status === 'PAID' ? ' — cleared' : ` — ${s.new_status.toLowerCase()}`}</span>
                                        <span className="font-medium text-gray-900">{formatNumber(s.amount_applied)}</span>
                                    </div>
                                ))}
                                {parseFloat(result.credit_banked || 0) > 0 && (
                                    <div className="flex justify-between text-sm bg-green-50 rounded-lg px-3 py-2">
                                        <span className="text-green-700">Banked as credit for future months</span>
                                        <span className="font-medium text-green-700">{formatNumber(result.credit_banked)}</span>
                                    </div>
                                )}
                            </div>
                            {result.settled?.length > 1 && (
                                <p className="text-xs text-gray-400 mb-4">
                                    The extra amount was applied to this member's oldest unpaid periods first.
                                </p>
                            )}
                            <div className="flex justify-end pt-2">
                                <button onClick={handleDone} className="btn-primary">Done</button>
                            </div>
                        </>
                    ) : (
                        <>
                            <h2 className="text-lg font-semibold text-gray-900 mb-1">Record Side Fund Payment</h2>
                            <p className="text-sm text-gray-400 mb-1">
                                {due.member_name} — {due.period}. Outstanding: {formatNumber(outstanding)}
                            </p>
                            <p className="text-xs text-gray-400 mb-4">
                                Paying more than the outstanding amount is fine — the extra first clears any of
                                this member's other unpaid periods (oldest first), then anything left over is
                                banked as credit toward their future months' dues.
                            </p>
                            {error && (
                                <div className="mb-4">
                                    <ErrorMessage message={error} onDismiss={() => setError(null)} />
                                </div>
                            )}
                            <form onSubmit={handleSubmit} className="space-y-4">
                                <div>
                                    <label className="label">Category *</label>
                                    <select className="input" value={form.category_id}
                                        onChange={e => setForm(p => ({ ...p, category_id: e.target.value }))} required>
                                        <option value="">Select category...</option>
                                        {financeCategories.map(c => (
                                            <option key={c.id} value={c.id}>{c.full_path || c.name}</option>
                                        ))}
                                    </select>
                                </div>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                    <div>
                                        <label className="label">Amount *</label>
                                        <input type="number" className="input" value={form.amount}
                                            onChange={e => setForm(p => ({ ...p, amount: e.target.value }))}
                                            min="0.01" step="0.01" required />
                                    </div>
                                    <div>
                                        <label className="label">Date Paid *</label>
                                        <input type="date" className="input" value={form.paid_date}
                                            max={new Date().toISOString().slice(0, 10)}
                                            onChange={e => setForm(p => ({ ...p, paid_date: e.target.value }))} required />
                                    </div>
                                </div>
                                <div>
                                    <label className="label">Notes</label>
                                    <textarea className="input" rows={2} value={form.notes}
                                        onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} />
                                </div>
                                <div className="flex justify-end gap-3 pt-2">
                                    <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                                    <button type="submit" disabled={loading} className="btn-primary">
                                        {loading ? 'Recording...' : 'Record Payment'}
                                    </button>
                                </div>
                            </form>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};

// ============================================================
// BULK PAY DUES MODAL — Treasurer/Assistant Treasurer (v1.26.0)
// For the common case where most/all members paid their monthly due
// on time: lists everyone with an outstanding due for the selected
// period, pre-checked with their full outstanding amount, but each
// row's amount can be edited before submitting (per the treasurer's
// choice — this isn't locked to "exactly what's owed").
// ============================================================
const currentPeriod = () => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
};

const BulkPayModal = ({ isOpen, onClose, onSuccess, categories }) => {
    const { hasPermission } = useAuth();
    const canManage = hasPermission('SIDE_FUND_MANAGE');
    const [period, setPeriod] = useState(currentPeriod());
    const [candidates, setCandidates] = useState([]);
    const [selected, setSelected] = useState({});   // user_id -> bool
    const [amounts, setAmounts] = useState({});      // user_id -> string
    const [categoryId, setCategoryId] = useState('');
    const [paidDate, setPaidDate] = useState(new Date().toISOString().slice(0, 10));
    const [loadingList, setLoadingList] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [result, setResult] = useState(null);
    // v1.28.3 — dues only exist as rows once generated (automatically
    // by the 1st-of-month cron job, or manually below). A brand new
    // deployment/activation after the 1st, or a member who joined
    // mid-month, can otherwise leave this list looking empty even
    // though dues are genuinely owed.
    const [generating, setGenerating] = useState(false);

    const loadCandidates = useCallback(async () => {
        setLoadingList(true);
        setError(null);
        try {
            const res = await sideFundAPI.getAllDues({ period, limit: 500 });
            const rows = (res.data.data || []).filter(r => r.status !== 'PAID');
            setCandidates(rows);
            const sel = {}; const amt = {};
            rows.forEach(r => {
                sel[r.user_id] = true;
                amt[r.user_id] = (parseFloat(r.amount_due) - parseFloat(r.amount_paid)).toFixed(2);
            });
            setSelected(sel);
            setAmounts(amt);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoadingList(false);
        }
    }, [period]);

    useEffect(() => {
        if (isOpen) {
            setResult(null);
            loadCandidates();
        }
    }, [isOpen, loadCandidates]);

    const handleGenerate = async () => {
        setGenerating(true);
        setError(null);
        try {
            const res = await sideFundAPI.generateDues({ period });
            const { created, total } = res.data.data;
            if (created === 0 && total === 0) {
                setError('No active shareholders found — nothing to generate.');
            } else if (created === 0) {
                setError('Dues for this period already exist for every active shareholder.');
            }
            await loadCandidates();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setGenerating(false);
        }
    };

    if (!isOpen) return null;

    const financeCategories = categories.filter(c => c.module === 'FINANCE');
    const selectedRows = candidates.filter(r => selected[r.user_id] && parseFloat(amounts[r.user_id] || 0) > 0);
    const totalAmount = selectedRows.reduce((sum, r) => sum + (parseFloat(amounts[r.user_id]) || 0), 0);

    const toggleAll = (checked) => {
        const sel = {};
        candidates.forEach(r => { sel[r.user_id] = checked; });
        setSelected(sel);
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (selectedRows.length === 0) {
            setError('Select at least one member with an amount greater than zero');
            return;
        }
        if (!categoryId) {
            setError('Select a category');
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const res = await sideFundAPI.bulkPayDues({
                category_id: categoryId,
                paid_date: paidDate,
                payments: selectedRows.map(r => ({ user_id: r.user_id, amount: parseFloat(amounts[r.user_id]) })),
            });
            setResult(res.data.data);
            onSuccess();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    const handleDone = () => {
        setResult(null);
        onClose();
    };

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            <div className="fixed inset-0 bg-black bg-opacity-40" onClick={result ? handleDone : onClose} />
            <div className="flex min-h-full items-center justify-center p-4">
                <div className="relative bg-white rounded-xl shadow-xl max-w-2xl w-full p-6 max-h-screen overflow-y-auto">
                    {result ? (
                        <>
                            <h2 className="text-lg font-semibold text-gray-900 mb-1">Bulk Payment Recorded</h2>
                            <p className="text-sm text-gray-400 mb-4">
                                Reference: {result.reference} — {result.results.length} member(s), total {formatNumber(result.total_amount)}
                            </p>
                            <div className="space-y-2 mb-4">
                                {result.results.map((r, i) => {
                                    const candidate = candidates.find(c => c.user_id === r.user_id);
                                    return (
                                        <div key={i} className="flex justify-between text-sm bg-gray-50 rounded-lg px-3 py-2">
                                            <span className="text-gray-700">{candidate?.member_name || `Member #${r.user_id}`}</span>
                                            <span className="font-medium text-gray-900">
                                                {formatNumber(r.amount)}
                                                {parseFloat(r.credit_banked || 0) > 0 && (
                                                    <span className="text-green-600 text-xs ml-1">
                                                        (+{formatNumber(r.credit_banked)} credit)
                                                    </span>
                                                )}
                                            </span>
                                        </div>
                                    );
                                })}
                            </div>
                            <div className="flex justify-end pt-2">
                                <button onClick={handleDone} className="btn-primary">Done</button>
                            </div>
                        </>
                    ) : (
                        <>
                            <h2 className="text-lg font-semibold text-gray-900 mb-1">Bulk Pay Dues</h2>
                            <p className="text-sm text-gray-400 mb-4">
                                Mark several members' monthly due as paid in one entry. Each amount is editable —
                                untick anyone who didn't pay, or adjust an amount before submitting.
                            </p>
                            {error && (
                                <div className="mb-4">
                                    <ErrorMessage message={error} onDismiss={() => setError(null)} />
                                </div>
                            )}
                            <form onSubmit={handleSubmit} className="space-y-4">
                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                                    <div>
                                        <label className="label">Period</label>
                                        <input type="month" className="input" value={period}
                                            max={currentPeriod()}
                                            onChange={e => setPeriod(e.target.value)} />
                                    </div>
                                    <div>
                                        <label className="label">Category *</label>
                                        <select className="input" value={categoryId}
                                            onChange={e => setCategoryId(e.target.value)} required>
                                            <option value="">Select category...</option>
                                            {financeCategories.map(c => (
                                                <option key={c.id} value={c.id}>{c.full_path || c.name}</option>
                                            ))}
                                        </select>
                                    </div>
                                    <div>
                                        <label className="label">Date Paid *</label>
                                        <input type="date" className="input" value={paidDate}
                                            max={new Date().toISOString().slice(0, 10)}
                                            onChange={e => setPaidDate(e.target.value)} required />
                                    </div>
                                </div>

                                <div className="border border-gray-200 rounded-lg overflow-hidden">
                                    <div className="flex items-center justify-between bg-gray-50 px-3 py-2 border-b border-gray-200">
                                        <label className="flex items-center gap-2 text-xs font-medium text-gray-500">
                                            <input type="checkbox"
                                                checked={candidates.length > 0 && candidates.every(r => selected[r.user_id])}
                                                onChange={e => toggleAll(e.target.checked)} />
                                            Select all
                                        </label>
                                        <span className="text-xs text-gray-400">
                                            {selectedRows.length} selected — total {formatNumber(totalAmount)}
                                        </span>
                                    </div>
                                    <div className="max-h-72 overflow-y-auto divide-y divide-gray-100">
                                        {loadingList ? (
                                            <p className="text-sm text-gray-400 text-center py-6">Loading...</p>
                                        ) : candidates.length === 0 ? (
                                            <div className="text-center py-6 px-4">
                                                <p className="text-sm text-gray-400">
                                                    No outstanding dues for {period}
                                                </p>
                                                {canManage && (
                                                    <>
                                                        <p className="text-xs text-gray-400 mt-1">
                                                            If members genuinely owe this month's due, it may just
                                                            not have been generated yet.
                                                        </p>
                                                        <button type="button" onClick={handleGenerate}
                                                            disabled={generating}
                                                            className="btn-secondary mt-3 text-sm">
                                                            {generating ? 'Generating...' : `Generate dues for ${period}`}
                                                        </button>
                                                    </>
                                                )}
                                            </div>
                                        ) : candidates.map(row => (
                                            <div key={row.user_id} className="flex items-center gap-3 px-3 py-2">
                                                <input type="checkbox" checked={!!selected[row.user_id]}
                                                    onChange={e => setSelected(p => ({ ...p, [row.user_id]: e.target.checked }))} />
                                                <div className="flex-1 min-w-0">
                                                    <p className="text-sm font-medium text-gray-900 truncate">{row.member_name}</p>
                                                    <p className="text-xs text-gray-400">
                                                        Owes {formatNumber(parseFloat(row.amount_due) - parseFloat(row.amount_paid))} — <StatusBadge status={row.status} />
                                                    </p>
                                                </div>
                                                <input type="number" className="input w-28" min="0" step="0.01"
                                                    value={amounts[row.user_id] || ''}
                                                    disabled={!selected[row.user_id]}
                                                    onChange={e => setAmounts(p => ({ ...p, [row.user_id]: e.target.value }))} />
                                            </div>
                                        ))}
                                    </div>
                                </div>

                                <div className="flex justify-end gap-3 pt-2">
                                    <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                                    <button type="submit" disabled={loading || selectedRows.length === 0} className="btn-primary">
                                        {loading ? 'Recording...' : `Record ${selectedRows.length} Payment(s)`}
                                    </button>
                                </div>
                            </form>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};

// ============================================================
// RECORD EXPENSE MODAL — Treasurer/Assistant Treasurer
// ============================================================
const RecordExpenseModal = ({ isOpen, onClose, onSuccess, categories, currentBalance }) => {
    const [form, setForm] = useState({ amount: '', category_id: '', description: '', expense_date: '' });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    if (!isOpen) return null;

    const financeCategories = categories.filter(c => c.module === 'FINANCE');

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await sideFundAPI.recordExpense({ ...form, amount: parseFloat(form.amount) });
            onSuccess();
            onClose();
            setForm({ amount: '', category_id: '', description: '', expense_date: '' });
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
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">Record Side Fund Expense</h2>
                    <p className="text-sm text-gray-400 mb-4">
                        Posted as a normal expense on the parent account. Available in the fund: {formatNumber(currentBalance || 0)}
                    </p>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">Category *</label>
                            <select className="input" value={form.category_id}
                                onChange={e => setForm(p => ({ ...p, category_id: e.target.value }))} required>
                                <option value="">Select category...</option>
                                {financeCategories.map(c => (
                                    <option key={c.id} value={c.id}>{c.full_path || c.name}</option>
                                ))}
                            </select>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="label">Amount *</label>
                                <input type="number" className="input" value={form.amount}
                                    onChange={e => setForm(p => ({ ...p, amount: e.target.value }))}
                                    min="0.01" step="0.01" required />
                            </div>
                            <div>
                                <label className="label">Expense Date *</label>
                                <input type="date" className="input" value={form.expense_date}
                                    max={new Date().toISOString().slice(0, 10)}
                                    onChange={e => setForm(p => ({ ...p, expense_date: e.target.value }))} required />
                            </div>
                        </div>
                        <div>
                            <label className="label">Description *</label>
                            <textarea className="input" rows={2} value={form.description}
                                onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
                                placeholder="What was this spent on?" required />
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading} className="btn-primary">
                                {loading ? 'Recording...' : 'Record Expense'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// PER-MEMBER OVERRIDES PANEL — Admin/Treasurer (v1.25.0)
// Every active shareholder pays the company default monthly amount
// unless they have their own override here. Setting/clearing an
// override only affects dues generated from next month onward — the
// same "forward-only" rule as the company-wide default.
// ============================================================
const OverridesPanel = ({ config }) => {
    const [rows, setRows] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [success, setSuccess] = useState(null);
    const [editingUserId, setEditingUserId] = useState(null);
    const [editAmount, setEditAmount] = useState('');
    const [saving, setSaving] = useState(false);

    const load = useCallback(async () => {
        try {
            setLoading(true);
            const res = await sideFundAPI.getOverrides();
            setRows(res.data.data || []);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    const startEdit = (row) => {
        setEditingUserId(row.user_id);
        setEditAmount(row.monthly_amount != null ? String(row.monthly_amount) : '');
        setSuccess(null);
        setError(null);
    };

    const cancelEdit = () => {
        setEditingUserId(null);
        setEditAmount('');
    };

    const handleSave = async (userId) => {
        if (editAmount === '' || isNaN(parseFloat(editAmount))) {
            setError('Enter a valid amount');
            return;
        }
        setSaving(true);
        setError(null);
        try {
            await sideFundAPI.setOverride(userId, { monthly_amount: parseFloat(editAmount) });
            setSuccess("Override saved — applies from next month's due onward.");
            setEditingUserId(null);
            setEditAmount('');
            await load();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setSaving(false);
        }
    };

    const handleClear = async (userId) => {
        if (!window.confirm("Clear this member's override? They'll go back to the company default from next month.")) return;
        setSaving(true);
        setError(null);
        try {
            await sideFundAPI.clearOverride(userId);
            setSuccess('Override cleared — back to the company default.');
            await load();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="card">
            <p className="text-sm text-gray-400 mb-4">
                Every shareholder pays the company default of {formatNumber(config?.monthly_amount || 0)} per
                month unless they have their own override below. Changes only affect dues generated from next
                month onward.
            </p>
            {error && <div className="mb-4"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}
            {success && (
                <div className="mb-4 text-sm text-green-700 bg-green-50 border border-green-100 rounded-lg px-3 py-2">
                    {success}
                </div>
            )}
            {loading ? (
                <p className="text-sm text-gray-400">Loading...</p>
            ) : (
                <div className="divide-y divide-gray-100">
                    {rows.map(row => {
                        const isEditing = editingUserId === row.user_id;
                        return (
                            <div key={row.user_id} className="flex items-center justify-between py-3 gap-4">
                                <div className="min-w-0">
                                    <p className="text-sm font-medium text-gray-900">{row.member_name}</p>
                                    <p className="text-xs text-gray-400">
                                        {row.monthly_amount != null
                                            ? `Override: ${formatNumber(row.monthly_amount)}`
                                            : `Default: ${formatNumber(config?.monthly_amount || 0)}`}
                                        {row.set_by_name ? ` — set by ${row.set_by_name}` : ''}
                                    </p>
                                </div>
                                {isEditing ? (
                                    <div className="flex items-center gap-2 flex-shrink-0">
                                        <input type="number" className="input w-28" value={editAmount}
                                            onChange={e => setEditAmount(e.target.value)} min="0" step="0.01" autoFocus />
                                        <button onClick={() => handleSave(row.user_id)} disabled={saving}
                                            className="text-xs text-primary-700 font-medium px-2 py-1 rounded border border-primary-200 hover:bg-primary-50">
                                            {saving ? 'Saving...' : 'Save'}
                                        </button>
                                        <button onClick={cancelEdit} className="text-xs text-gray-500 px-2 py-1">Cancel</button>
                                    </div>
                                ) : (
                                    <div className="flex items-center gap-2 flex-shrink-0">
                                        <button onClick={() => startEdit(row)}
                                            className="text-xs text-primary-700 hover:text-primary-800 font-medium px-2 py-1 rounded border border-primary-200 hover:bg-primary-50 transition-colors">
                                            {row.monthly_amount != null ? 'Edit' : 'Set Override'}
                                        </button>
                                        {row.monthly_amount != null && (
                                            <button onClick={() => handleClear(row.user_id)} disabled={saving}
                                                className="text-xs text-red-600 hover:text-red-700 font-medium px-2 py-1 rounded border border-red-200 hover:bg-red-50 transition-colors">
                                                Clear
                                            </button>
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                    {rows.length === 0 && (
                        <p className="text-sm text-gray-400 py-4 text-center">No active shareholders found</p>
                    )}
                </div>
            )}
        </div>
    );
};

// ============================================================
// MEMBER CREDIT PANEL — Treasurer/Admin (v1.25.0)
// Members currently sitting on banked credit — money paid ahead of
// what was owed, held back to auto-cover future months' dues as
// they're generated.
// ============================================================
const CreditPanel = () => {
    const [rows, setRows] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    useEffect(() => {
        (async () => {
            try {
                const res = await sideFundAPI.getAllCredit();
                setRows(res.data.data || []);
            } catch (err) {
                setError(getErrorMessage(err));
            } finally {
                setLoading(false);
            }
        })();
    }, []);

    return (
        <div className="card">
            <p className="text-sm text-gray-400 mb-4">
                Money members have paid ahead of what they owed. It's held back and automatically applied to
                their own future months' dues as they're generated — no action needed from Treasury.
            </p>
            {error && <div className="mb-4"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}
            {loading ? (
                <p className="text-sm text-gray-400">Loading...</p>
            ) : rows.length === 0 ? (
                <p className="text-sm text-gray-400 py-4 text-center">No members currently hold side fund credit</p>
            ) : (
                <div className="divide-y divide-gray-100">
                    {rows.map(row => (
                        <div key={row.user_id} className="flex items-center justify-between py-3">
                            <p className="text-sm font-medium text-gray-900">{row.member_name}</p>
                            <p className="text-sm font-bold text-green-700">{formatNumber(row.credit_balance)}</p>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

// ============================================================
// MAIN SIDE FUND PAGE
// ============================================================
const SideFundPage = () => {
    const { hasPermission } = useAuth();
    const [config, setConfig] = useState(null);
    const [myDues, setMyDues] = useState([]);
    const [myCredit, setMyCredit] = useState(null);
    const [myOverdue, setMyOverdue] = useState(null);
    const [allDues, setAllDues] = useState([]);
    const [allOverdue, setAllOverdue] = useState([]);
    const [expenses, setExpenses] = useState([]);
    const [accounts, setAccounts] = useState([]);
    const [categories, setCategories] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [activeTab, setActiveTab] = useState('mine');
    const [showSettings, setShowSettings] = useState(false);
    const [showExpense, setShowExpense] = useState(false);
    const [showBulkPay, setShowBulkPay] = useState(false);
    const [payingDue, setPayingDue] = useState(null);

    const canManage      = hasPermission('SIDE_FUND_MANAGE');
    const canView         = hasPermission('SIDE_FUND_VIEW');
    const canRecordDue    = hasPermission('SIDE_FUND_CONTRIBUTION_RECORD');
    const canRecordExpense = hasPermission('SIDE_FUND_EXPENSE_RECORD');

    const loadConfig = useCallback(async () => {
        try {
            setLoading(true);
            const res = await sideFundAPI.getSettings();
            setConfig(res.data.data);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, []);

    const loadMine = useCallback(async () => {
        try {
            const [duesRes, creditRes, overdueRes] = await Promise.all([
                sideFundAPI.getMyDues(),
                sideFundAPI.getMyCredit(),
                sideFundAPI.getMyOverdue(),
            ]);
            setMyDues(duesRes.data.data || []);
            setMyCredit(creditRes.data.data || null);
            setMyOverdue(overdueRes.data.data || null);
        } catch (err) {
            setError(getErrorMessage(err));
        }
    }, []);

    const loadAll = useCallback(async () => {
        if (!canView) return;
        try {
            const [duesRes, expRes, overdueRes] = await Promise.all([
                sideFundAPI.getAllDues({ limit: 100 }),
                sideFundAPI.getExpenses({ limit: 100 }),
                sideFundAPI.getAllOverdue(),
            ]);
            setAllDues(duesRes.data.data || []);
            setExpenses(expRes.data.data || []);
            setAllOverdue(overdueRes.data.data || []);
        } catch (err) {
            setError(getErrorMessage(err));
        }
    }, [canView]);

    useEffect(() => {
        loadConfig();
        loadMine();
        loadAll();
        if (canManage || canRecordDue || canRecordExpense) {
            accountsAPI.getAll().then(r => setAccounts(r.data.data || [])).catch(() => {});
            categoriesAPI.getAll({ flat: true }).then(r => setCategories(r.data.data || [])).catch(() => {});
        }
    }, [loadConfig, loadMine, loadAll, canManage, canRecordDue, canRecordExpense]);

    const refreshAll = () => { loadConfig(); loadMine(); loadAll(); };

    const isActive = config?.is_active;

    const myDuesColumns = [
        { header: 'Period', render: row => <span className="text-sm font-medium text-gray-900">{row.period}</span> },
        { header: 'Amount Due', render: row => <span className="text-sm text-gray-900">{formatNumber(row.amount_due)}</span> },
        { header: 'Amount Paid', render: row => <span className="text-sm text-green-600">{formatNumber(row.amount_paid)}</span> },
        { header: 'Status', render: row => <StatusBadge status={row.status} /> },
        { header: 'Paid Date', render: row => <span className="text-sm text-gray-500">{row.paid_date ? formatDate(row.paid_date) : '—'}</span> },
    ];

    const allDuesColumns = [
        { header: 'Period', render: row => <span className="text-sm font-medium text-gray-900">{row.period}</span> },
        { header: 'Member', render: row => (
            <div><p className="text-sm font-medium text-gray-900">{row.member_name}</p><p className="text-xs text-gray-400">{row.member_email}</p></div>
        ) },
        { header: 'Due / Paid', render: row => (
            <span className="text-sm text-gray-900">
                {formatNumber(row.amount_due)}
                {' / '}
                <span className="text-green-600">{formatNumber(row.amount_paid)}</span>
            </span>
        ) },
        { header: 'Status', render: row => <StatusBadge status={row.status} /> },
        { header: 'Actions', render: row => (
            row.status !== 'PAID' && canRecordDue ? (
                <button onClick={() => setPayingDue(row)}
                    className="text-xs text-primary-700 hover:text-primary-800 font-medium px-2 py-1 rounded border border-primary-200 hover:bg-primary-50 transition-colors">
                    Record Payment
                </button>
            ) : null
        ) },
    ];

    const expenseColumns = [
        { header: 'Reference', render: row => <span className="font-mono text-xs font-medium text-primary-700">{row.reference_code}</span> },
        { header: 'Description', render: row => <span className="text-sm text-gray-900">{row.description}</span> },
        { header: 'Category', render: row => <span className="text-xs text-gray-500">{row.category_name || '—'}</span> },
        { header: 'Amount', render: row => <span className="text-sm font-bold text-red-600">{formatNumber(row.amount)}</span> },
        { header: 'Date', render: row => <span className="text-sm text-gray-500">{formatDate(row.expense_date)}</span> },
        { header: 'Recorded By', render: row => <span className="text-xs text-gray-500">{row.recorded_by_name}</span> },
    ];

    return (
        <div>
            <PageHeader
                title="Side Fund"
                subtitle="Shared pool for day-to-day activities, funded by members' monthly dues"
                actions={
                    <div className="flex gap-2">
                        {canManage && (
                            <button onClick={() => setShowSettings(true)} className="btn-secondary flex items-center gap-2">
                                <Cog6ToothIcon className="h-4 w-4" />
                                Settings
                            </button>
                        )}
                        {isActive && canRecordDue && (
                            <button onClick={() => setShowBulkPay(true)} className="btn-secondary flex items-center gap-2">
                                <CheckCircleIcon className="h-4 w-4" />
                                Bulk Pay Dues
                            </button>
                        )}
                        {isActive && canRecordExpense && (
                            <button onClick={() => setShowExpense(true)} className="btn-primary flex items-center gap-2">
                                <PlusIcon className="h-4 w-4" />
                                Record Expense
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

            {!loading && !isActive && (
                <div className="card flex items-start gap-4 mb-6">
                    <BanknotesIcon className="h-8 w-8 text-gray-300 flex-shrink-0" />
                    <div>
                        <p className="text-sm font-medium text-gray-700">The side fund isn't active yet</p>
                        <p className="text-sm text-gray-400 mt-1">
                            {canManage
                                ? 'Choose a parent account and a monthly due amount in Settings to activate it.'
                                : 'Ask an Admin or Treasurer to activate it from Settings.'}
                        </p>
                    </div>
                </div>
            )}

            {isActive && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
                    <div className="card">
                        <p className="text-sm text-gray-400">Fund Balance</p>
                        <p className="text-2xl font-bold text-primary-700 mt-1">
                            {formatNumber(config.current_balance)}
                            {config.currency_code ? ` ${config.currency_code}` : ''}
                        </p>
                    </div>
                    <div className="card">
                        <p className="text-sm text-gray-400">Monthly Due</p>
                        <p className="text-2xl font-bold text-gray-900 mt-1">
                            {formatNumber(config.monthly_amount)}
                        </p>
                    </div>
                    <div className="card">
                        <p className="text-sm text-gray-400">Held Inside</p>
                        <p className="text-lg font-bold text-gray-900 mt-1">{config.parent_account_name || '—'}</p>
                        <p className="text-xs text-gray-400">{config.parent_account_type}</p>
                    </div>
                </div>
            )}

            {isActive && parseFloat(myOverdue?.overdue_amount || 0) > 0 && (
                <div className="card flex items-center justify-between mb-6 bg-red-50 border-red-100">
                    <div>
                        <p className="text-sm font-medium text-red-800">
                            You have {myOverdue.overdue_count} overdue month{myOverdue.overdue_count > 1 ? 's' : ''}
                        </p>
                        <p className="text-xs text-red-700 mt-0.5">
                            Past due date and still unpaid — pay the oldest first to clear arrears.
                        </p>
                    </div>
                    <p className="text-xl font-bold text-red-700">{formatNumber(myOverdue.overdue_amount)}</p>
                </div>
            )}

            {isActive && parseFloat(myCredit?.credit_balance || 0) > 0 && (
                <div className="card flex items-center justify-between mb-6 bg-green-50 border-green-100">
                    <div>
                        <p className="text-sm font-medium text-green-800">You have banked side fund credit</p>
                        <p className="text-xs text-green-700 mt-0.5">
                            This is applied automatically to your future months' dues as they're generated.
                        </p>
                    </div>
                    <p className="text-xl font-bold text-green-700">{formatNumber(myCredit.credit_balance)}</p>
                </div>
            )}

            <div className="flex gap-2 mb-6 flex-wrap">
                <button onClick={() => setActiveTab('mine')}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === 'mine' ? 'bg-primary-700 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                    My Dues
                </button>
                {canView && (
                    <>
                        <button onClick={() => setActiveTab('all')}
                            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === 'all' ? 'bg-primary-700 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                            All Members
                        </button>
                        <button onClick={() => setActiveTab('expenses')}
                            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === 'expenses' ? 'bg-primary-700 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                            Spending History
                        </button>
                        <button onClick={() => setActiveTab('credit')}
                            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === 'credit' ? 'bg-primary-700 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                            Member Credit
                        </button>
                    </>
                )}
                {canManage && (
                    <button onClick={() => setActiveTab('overrides')}
                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === 'overrides' ? 'bg-primary-700 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                        Member Overrides
                    </button>
                )}
            </div>

            {activeTab === 'mine' && (
                <DataTable
                    columns={myDuesColumns}
                    data={myDues}
                    loading={loading}
                    emptyMessage="No side fund dues yet"
                    searchable
                    searchPlaceholder="Search my dues..."
                />
            )}

            {activeTab === 'all' && canView && (
                <>
                    {allOverdue.length > 0 && (
                        <div className="card mb-4 bg-red-50 border-red-100">
                            <p className="text-sm font-medium text-red-800 mb-2">
                                {allOverdue.length} member{allOverdue.length > 1 ? 's' : ''} currently overdue
                            </p>
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                                {allOverdue.map(o => (
                                    <div key={o.user_id} className="flex items-center justify-between bg-white rounded-lg px-3 py-2 border border-red-100">
                                        <div className="min-w-0">
                                            <p className="text-sm font-medium text-gray-900 truncate">{o.member_name}</p>
                                            <p className="text-xs text-gray-400">{o.overdue_count} month{o.overdue_count > 1 ? 's' : ''} overdue</p>
                                        </div>
                                        <p className="text-sm font-bold text-red-700 flex-shrink-0 ml-2">{formatNumber(o.overdue_amount)}</p>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                    <DataTable
                        columns={allDuesColumns}
                        data={allDues}
                        loading={loading}
                        emptyMessage="No side fund dues found"
                        searchable
                        searchPlaceholder="Search all dues..."
                    />
                </>
            )}

            {activeTab === 'expenses' && canView && (
                <DataTable
                    columns={expenseColumns}
                    data={expenses}
                    loading={loading}
                    emptyMessage="No side fund expenses recorded"
                    searchable
                    searchPlaceholder="Search expenses..."
                />
            )}

            {activeTab === 'credit' && canView && <CreditPanel />}

            {activeTab === 'overrides' && canManage && <OverridesPanel config={config} />}

            <SettingsModal
                isOpen={showSettings}
                onClose={() => setShowSettings(false)}
                onSuccess={refreshAll}
                config={config}
                accounts={accounts}
            />
            <RecordExpenseModal
                isOpen={showExpense}
                onClose={() => setShowExpense(false)}
                onSuccess={refreshAll}
                categories={categories}
                currentBalance={config?.current_balance}
            />
            <PayDueModal
                isOpen={!!payingDue}
                onClose={() => setPayingDue(null)}
                onSuccess={refreshAll}
                due={payingDue}
                categories={categories}
            />
            <BulkPayModal
                isOpen={showBulkPay}
                onClose={() => setShowBulkPay(false)}
                onSuccess={refreshAll}
                categories={categories}
            />
        </div>
    );
};

export default SideFundPage;
