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
import { PlusIcon, Cog6ToothIcon, BanknotesIcon } from '@heroicons/react/24/outline';

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

    useEffect(() => {
        if (isOpen && due) {
            const outstanding = parseFloat(due.amount_due) - parseFloat(due.amount_paid);
            setForm({
                amount: outstanding > 0 ? outstanding.toFixed(2) : '',
                category_id: '',
                paid_date: new Date().toISOString().slice(0, 10),
                notes: '',
            });
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
            await sideFundAPI.payDue(due.id, { ...form, amount: parseFloat(form.amount) });
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
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">Record Side Fund Payment</h2>
                    <p className="text-sm text-gray-400 mb-4">
                        {due.member_name} — {due.period}. Outstanding: {formatNumber(outstanding)}
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
                                    min="0.01" max={outstanding} step="0.01" required />
                            </div>
                            <div>
                                <label className="label">Date Paid *</label>
                                <input type="date" className="input" value={form.paid_date}
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
// RECORD DIRECT / BATCH INFLOW MODAL — Treasurer/Assistant Treasurer
// For adding money straight to the fund that isn't tied to any one
// member's due — e.g. an existing balance being brought in, or a
// lump-sum top-up.
// ============================================================
const RecordDirectInflowModal = ({ isOpen, onClose, onSuccess, categories }) => {
    const [form, setForm] = useState({ amount: '', category_id: '', value_date: '', description: '', notes: '' });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    if (!isOpen) return null;

    const financeCategories = categories.filter(c => c.module === 'FINANCE');

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await sideFundAPI.recordDirectInflow({ ...form, amount: parseFloat(form.amount) });
            onSuccess();
            onClose();
            setForm({ amount: '', category_id: '', value_date: '', description: '', notes: '' });
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
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">Add Funds Directly</h2>
                    <p className="text-sm text-gray-400 mb-4">
                        Not tied to any individual member's due — e.g. an existing balance
                        being brought in, or a lump-sum top-up. Recorded as a general ledger
                        inflow in the account the fund is held.
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
                                <label className="label">Date</label>
                                <input type="date" className="input" value={form.value_date}
                                    onChange={e => setForm(p => ({ ...p, value_date: e.target.value }))} />
                            </div>
                        </div>
                        <div>
                            <label className="label">Description</label>
                            <input type="text" className="input" value={form.description}
                                onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
                                placeholder="e.g. Existing balance brought forward" />
                        </div>
                        <div>
                            <label className="label">Notes</label>
                            <textarea className="input" rows={2} value={form.notes}
                                onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} />
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading} className="btn-primary">
                                {loading ? 'Recording...' : 'Add Funds'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
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
    const [allDues, setAllDues] = useState([]);
    const [expenses, setExpenses] = useState([]);
    const [accounts, setAccounts] = useState([]);
    const [categories, setCategories] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [activeTab, setActiveTab] = useState('mine');
    const [showSettings, setShowSettings] = useState(false);
    const [showExpense, setShowExpense] = useState(false);
    const [showDirectInflow, setShowDirectInflow] = useState(false);
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
            const res = await sideFundAPI.getMyDues();
            setMyDues(res.data.data || []);
        } catch (err) {
            setError(getErrorMessage(err));
        }
    }, []);

    const loadAll = useCallback(async () => {
        if (!canView) return;
        try {
            const [duesRes, expRes] = await Promise.all([
                sideFundAPI.getAllDues({ limit: 100 }),
                sideFundAPI.getExpenses({ limit: 100 }),
            ]);
            setAllDues(duesRes.data.data || []);
            setExpenses(expRes.data.data || []);
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
                            <button onClick={() => setShowDirectInflow(true)} className="btn-secondary flex items-center gap-2">
                                <PlusIcon className="h-4 w-4" />
                                Add Funds Directly
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
                    </>
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
                <DataTable
                    columns={allDuesColumns}
                    data={allDues}
                    loading={loading}
                    emptyMessage="No side fund dues found"
                    searchable
                    searchPlaceholder="Search all dues..."
                />
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
            <RecordDirectInflowModal
                isOpen={showDirectInflow}
                onClose={() => setShowDirectInflow(false)}
                onSuccess={refreshAll}
                categories={categories}
            />
        </div>
    );
};

export default SideFundPage;
