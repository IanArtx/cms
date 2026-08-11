// ============================================================
// ACCOUNTS PAGE
// Clickable account tiles with detailed ledger view,
// charts, and floor limit management.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { accountsAPI, transactionsAPI, sharesAPI, exchangeRatesAPI, categoriesAPI } from '../../api/endpoints';
import { formatCurrency, formatDate, getErrorMessage } from '../../utils/helpers';
import PageHeader from '../../components/common/PageHeader';
import LoadingSpinner from '../../components/common/LoadingSpinner';
import ErrorMessage from '../../components/common/ErrorMessage';
import StatusBadge from '../../components/common/StatusBadge';
import { useAuth } from '../../contexts/AuthContext';
import {
    PlusIcon,
    BuildingLibraryIcon,
    ShieldCheckIcon,
    ArrowLeftIcon,
    ArrowUpIcon,
    ArrowDownIcon,
    ArrowsRightLeftIcon,
    TagIcon,
    PencilSquareIcon,
} from '@heroicons/react/24/outline';
import {
    AreaChart, Area, XAxis, YAxis, CartesianGrid,
    Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend,
} from 'recharts';

// ============================================================
// CREATE ACCOUNT MODAL (Secondary or, one-time, the SAVINGS account)
// ============================================================
const CreateAccountModal = ({ isOpen, onClose, onSuccess, currencies, hasSavingsAccount }) => {
    const [accountType, setAccountType] = useState('SECONDARY');
    const [form, setForm]       = useState({
        name: '', currency_id: '', description: '', reference_prefix: '',
        is_virtual: false, bank_name: '', bank_branch: '', bank_account_number: '', swift_routing_code: '',
    });
    const [loading, setLoading] = useState(false);
    const [error,   setError]   = useState(null);

    if (!isOpen) return null;

    const isSavings = accountType === 'SAVINGS';

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            if (isSavings) {
                await accountsAPI.createSavings(form);
            } else {
                await accountsAPI.createSecondary({
                    ...form,
                    reference_prefix: form.reference_prefix.trim() || undefined,
                });
            }
            onSuccess();
            onClose();
            setForm({
                name: '', currency_id: '', description: '', reference_prefix: '',
                is_virtual: false, bank_name: '', bank_branch: '', bank_account_number: '', swift_routing_code: '',
            });
            setAccountType('SECONDARY');
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
                    <h2 className="text-lg font-semibold text-gray-900 mb-4">
                        {isSavings ? 'Set Up Savings Account' : 'Create Secondary Account'}
                    </h2>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    {!hasSavingsAccount && (
                        <div className="flex items-center gap-2 mb-4 border border-gray-200 rounded-lg p-1">
                            <button type="button"
                                onClick={() => setAccountType('SECONDARY')}
                                className={`flex-1 text-sm font-medium py-1.5 rounded-md transition-colors ${
                                    !isSavings ? 'bg-primary-600 text-white' : 'text-gray-500'
                                }`}>
                                Secondary Account
                            </button>
                            <button type="button"
                                onClick={() => setAccountType('SAVINGS')}
                                className={`flex-1 text-sm font-medium py-1.5 rounded-md transition-colors ${
                                    isSavings ? 'bg-amber-600 text-white' : 'text-gray-500'
                                }`}>
                                Savings Account
                            </button>
                        </div>
                    )}
                    {isSavings && (
                        <p className="text-xs text-gray-500 mb-4 bg-amber-50 border border-amber-100 rounded-lg p-2.5">
                            One-time setup. This is the single dedicated account every member
                            savings deposit/handout will be posted against instead of Primary.
                            It can never take part in a transfer and is always exempt from
                            floor limits.
                        </p>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">Account Name *</label>
                            <input type="text" className="input" value={form.name}
                                onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                                required />
                        </div>
                        <div>
                            <label className="label">Currency *</label>
                            <select className="input" value={form.currency_id}
                                onChange={e => setForm(p => ({ ...p, currency_id: e.target.value }))}
                                required>
                                <option value="">Select currency...</option>
                                {currencies.map(c => (
                                    <option key={c.id} value={c.id}>
                                        {c.code} — {c.name}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label className="label">Description</label>
                            <textarea className="input" rows={2} value={form.description}
                                onChange={e => setForm(p => ({
                                    ...p, description: e.target.value }))} />
                        </div>
                        {!isSavings && (
                            <div>
                                <label className="label">Reference Prefix</label>
                                <input type="text" className="input" maxLength={10}
                                    value={form.reference_prefix}
                                    onChange={e => setForm(p => ({
                                        ...p,
                                        reference_prefix: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''),
                                    }))}
                                    placeholder="e.g. IRF (auto-generated from name if left blank)" />
                                <p className="text-xs text-gray-400 mt-1">
                                    This account's transactions will be referenced like
                                    {' '}{form.reference_prefix || 'SA'}-EXP-202607-00001
                                    {' '}instead of the generic SA prefix. Letters/numbers only, max 10 characters.
                                </p>
                            </div>
                        )}

                        <div className="flex items-center justify-between border border-gray-200 rounded-lg px-3 py-2.5">
                            <div>
                                <span className="text-sm font-medium text-gray-700">Virtual account</span>
                                <p className="text-xs text-gray-400">No real bank behind it — an internal tracking account</p>
                            </div>
                            <button type="button"
                                onClick={() => setForm(p => ({ ...p, is_virtual: !p.is_virtual }))}
                                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 ${
                                    form.is_virtual ? 'bg-primary-600' : 'bg-gray-300'
                                }`}>
                                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                                    form.is_virtual ? 'translate-x-6' : 'translate-x-1'
                                }`} />
                            </button>
                        </div>

                        {!form.is_virtual && (
                            <div className="space-y-4 border border-gray-100 rounded-lg p-3 bg-gray-50">
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                    <div>
                                        <label className="label">Bank Name *</label>
                                        <input type="text" className="input" value={form.bank_name}
                                            onChange={e => setForm(p => ({ ...p, bank_name: e.target.value }))}
                                            required={!form.is_virtual} />
                                    </div>
                                    <div>
                                        <label className="label">Branch</label>
                                        <input type="text" className="input" value={form.bank_branch}
                                            onChange={e => setForm(p => ({ ...p, bank_branch: e.target.value }))} />
                                    </div>
                                </div>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                    <div>
                                        <label className="label">Account Number *</label>
                                        <input type="text" className="input" value={form.bank_account_number}
                                            onChange={e => setForm(p => ({ ...p, bank_account_number: e.target.value }))}
                                            required={!form.is_virtual} />
                                    </div>
                                    <div>
                                        <label className="label">SWIFT / Routing Code</label>
                                        <input type="text" className="input" value={form.swift_routing_code}
                                            onChange={e => setForm(p => ({ ...p, swift_routing_code: e.target.value }))} />
                                    </div>
                                </div>
                                <p className="text-xs text-gray-400">
                                    Accounts can share the same currency, and even the same bank, as long as
                                    their branch/account number are different.
                                </p>
                            </div>
                        )}

                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose}
                                className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading}
                                className="btn-primary">
                                {loading ? 'Creating...' : 'Create Account'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// FLOOR LIMIT MODAL
// ============================================================
const FloorLimitModal = ({ isOpen, account, onClose, onSuccess }) => {
    const [form, setForm]       = useState({ floor_amount: '', notes: '' });
    const [loading, setLoading] = useState(false);
    const [error,   setError]   = useState(null);

    if (!isOpen || !account) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await accountsAPI.updateFloorLimit(account.id, form);
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
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">
                        Update Floor Limit
                    </h2>
                    <p className="text-sm text-gray-500 mb-4">
                        {account.name} — Floor limits can only be updated every 6 months.
                    </p>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">
                                New Floor Amount ({account.currency_code}) *
                            </label>
                            <input type="number" className="input"
                                value={form.floor_amount}
                                onChange={e => setForm(p => ({
                                    ...p, floor_amount: e.target.value }))}
                                min="0" step="0.01" required />
                        </div>
                        <div>
                            <label className="label">Notes</label>
                            <textarea className="input" rows={2} value={form.notes}
                                onChange={e => setForm(p => ({
                                    ...p, notes: e.target.value }))}
                                placeholder="Reason for floor limit change..." />
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose}
                                className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading}
                                className="btn-primary">
                                {loading ? 'Updating...' : 'Update Floor Limit'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// EDIT ACCOUNT MODAL — bank details, virtual flag, reference prefix
// ============================================================
const EditAccountModal = ({ isOpen, account, onClose, onSuccess }) => {
    const [form, setForm] = useState({
        name: '', description: '', reference_prefix: '',
        is_virtual: false, bank_name: '', bank_branch: '', bank_account_number: '', swift_routing_code: '',
    });
    const [loading, setLoading] = useState(false);
    const [error,   setError]   = useState(null);

    useEffect(() => {
        if (isOpen && account) {
            setForm({
                name: account.name || '',
                description: account.description || '',
                reference_prefix: account.reference_prefix || '',
                is_virtual: !!account.is_virtual,
                bank_name: account.bank_name || '',
                bank_branch: account.bank_branch || '',
                bank_account_number: account.bank_account_number || '',
                swift_routing_code: account.swift_routing_code || '',
            });
        }
    }, [isOpen, account]);

    if (!isOpen || !account) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await accountsAPI.updateAccount(account.id, {
                ...form,
                reference_prefix: form.reference_prefix.trim() || null,
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
                <div className="relative bg-white rounded-xl shadow-xl max-w-md w-full p-6 max-h-screen overflow-y-auto">
                    <h2 className="text-lg font-semibold text-gray-900 mb-4">Edit Account</h2>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">Account Name *</label>
                            <input type="text" className="input" value={form.name}
                                onChange={e => setForm(p => ({ ...p, name: e.target.value }))} required />
                        </div>
                        <div>
                            <label className="label">Description</label>
                            <textarea className="input" rows={2} value={form.description}
                                onChange={e => setForm(p => ({ ...p, description: e.target.value }))} />
                        </div>
                        <div>
                            <label className="label">Reference Prefix</label>
                            <input type="text" className="input" maxLength={10}
                                value={form.reference_prefix}
                                onChange={e => setForm(p => ({
                                    ...p, reference_prefix: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''),
                                }))} />
                        </div>

                        <div className="flex items-center justify-between border border-gray-200 rounded-lg px-3 py-2.5">
                            <div>
                                <span className="text-sm font-medium text-gray-700">Virtual account</span>
                                <p className="text-xs text-gray-400">No real bank behind it</p>
                            </div>
                            <button type="button"
                                onClick={() => setForm(p => ({ ...p, is_virtual: !p.is_virtual }))}
                                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 ${
                                    form.is_virtual ? 'bg-primary-600' : 'bg-gray-300'
                                }`}>
                                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                                    form.is_virtual ? 'translate-x-6' : 'translate-x-1'
                                }`} />
                            </button>
                        </div>

                        {!form.is_virtual && (
                            <div className="space-y-4 border border-gray-100 rounded-lg p-3 bg-gray-50">
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                    <div>
                                        <label className="label">Bank Name *</label>
                                        <input type="text" className="input" value={form.bank_name}
                                            onChange={e => setForm(p => ({ ...p, bank_name: e.target.value }))}
                                            required={!form.is_virtual} />
                                    </div>
                                    <div>
                                        <label className="label">Branch</label>
                                        <input type="text" className="input" value={form.bank_branch}
                                            onChange={e => setForm(p => ({ ...p, bank_branch: e.target.value }))} />
                                    </div>
                                </div>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                    <div>
                                        <label className="label">Account Number *</label>
                                        <input type="text" className="input" value={form.bank_account_number}
                                            onChange={e => setForm(p => ({ ...p, bank_account_number: e.target.value }))}
                                            required={!form.is_virtual} />
                                    </div>
                                    <div>
                                        <label className="label">SWIFT / Routing Code</label>
                                        <input type="text" className="input" value={form.swift_routing_code}
                                            onChange={e => setForm(p => ({ ...p, swift_routing_code: e.target.value }))} />
                                    </div>
                                </div>
                            </div>
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
// ACCOUNT DETAIL VIEW
// Shows when user clicks on an account tile
// ============================================================
// ============================================================
// RECORD TRANSACTION MODAL — general Expense or Inflow, scoped to
// one specific account. type is 'EXPENSE' or 'INFLOW'.
// ============================================================
const RecordTransactionModal = ({ isOpen, onClose, onSuccess, account, type }) => {
    const [form, setForm] = useState({ amount: '', category_id: '', description: '', value_date: '' });
    const [categories, setCategories] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (isOpen) {
            categoriesAPI.getAll({ flat: true }).then(r => setCategories(r.data.data || [])).catch(() => {});
            setForm({ amount: '', category_id: '', description: '', value_date: new Date().toISOString().slice(0, 10) });
        }
    }, [isOpen]);

    if (!isOpen || !account) return null;

    const isExpense = type === 'EXPENSE';
    const financeCategories = categories.filter(c => c.module === 'FINANCE');

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            const payload = { ...form, account_id: account.id, amount: parseFloat(form.amount) };
            if (isExpense) {
                await transactionsAPI.recordExpense(payload);
            } else {
                await transactionsAPI.recordInflow(payload);
            }
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
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">
                        {isExpense ? 'Record Expense' : 'Record Inflow'}
                    </h2>
                    <p className="text-sm text-gray-400 mb-4">
                        {account.name} ({account.currency_code})
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
                                <label className="label">Date *</label>
                                <input type="date" className="input" value={form.value_date}
                                    onChange={e => setForm(p => ({ ...p, value_date: e.target.value }))} required />
                            </div>
                        </div>
                        <div>
                            <label className="label">Description *</label>
                            <textarea className="input" rows={2} value={form.description}
                                onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
                                placeholder={isExpense ? 'What was this spent on?' : 'Where did this money come from?'}
                                required />
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading}
                                className={isExpense ? 'btn-primary' : 'btn-primary'}>
                                {loading ? 'Recording...' : isExpense ? 'Record Expense' : 'Record Inflow'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

const AccountDetailView = ({ account, onBack, canEdit, onEditClick, canRecordTransactions, onTransactionRecorded }) => {
    const [transactions, setTransactions] = useState([]);
    const [loading,      setLoading]      = useState(true);
    const [page,         setPage]         = useState(1);
    const [pagination,   setPagination]   = useState(null);
    const [showExpense,  setShowExpense]  = useState(false);
    const [showInflow,   setShowInflow]   = useState(false);

    const loadTransactions = useCallback(async () => {
        try {
            setLoading(true);
            const res = await transactionsAPI.getAll({
                account_id: account.id,
                page,
                limit: 10,
            });
            setTransactions(res.data.data || []);
            setPagination(res.data.meta?.pagination);
        } catch {}  finally {
            setLoading(false);
        }
    }, [account.id, page]);

    useEffect(() => { loadTransactions(); }, [loadTransactions]);

    // Build chart data from transactions
    const chartData = [...transactions].reverse().map(tx => ({
        date:    formatDate(tx.value_date),
        balance: parseFloat(tx.balance_after),
    }));

    // Build inflow/outflow summary
    const inflows  = transactions.filter(t =>
        t.transaction_type === 'CREDIT' ||
        t.transaction_type === 'REVERSAL_CREDIT'
    );
    const outflows = transactions.filter(t =>
        t.transaction_type === 'DEBIT' ||
        t.transaction_type === 'REVERSAL_DEBIT'
    );

    const totalInflow  = inflows.reduce((s, t) => s + parseFloat(t.amount), 0);
    const totalOutflow = outflows.reduce((s, t) => s + parseFloat(t.amount), 0);

    const pieData = [
        { name: 'Inflows',  value: totalInflow  },
        { name: 'Outflows', value: totalOutflow  },
    ];
    const PIE_COLORS = ['#16a34a', '#dc2626'];

    const isPrimary = account.account_type === 'PRIMARY';
    const isSavings = account.account_type === 'SAVINGS';

    return (
        <div>
            {/* Back button */}
            <div className="flex items-center justify-between mb-6">
                <button
                    onClick={onBack}
                    className="flex items-center gap-2 text-sm text-gray-500
                        hover:text-gray-700 transition-colors"
                >
                    <ArrowLeftIcon className="h-4 w-4" />
                    Back to Accounts
                </button>
                <div className="flex items-center gap-2">
                    {isSavings && (
                        <p className="text-xs text-gray-400 max-w-xs text-right">
                            Savings transactions are recorded from the Savings page,
                            not here — deposits/handouts go through their own
                            approval flow.
                        </p>
                    )}
                    {canRecordTransactions && !isSavings && (
                        <>
                            <button
                                onClick={() => setShowInflow(true)}
                                className="btn-secondary flex items-center gap-2 text-sm"
                            >
                                <ArrowDownIcon className="h-4 w-4 text-green-600" />
                                Record Inflow
                            </button>
                            <button
                                onClick={() => setShowExpense(true)}
                                className="btn-secondary flex items-center gap-2 text-sm"
                            >
                                <ArrowUpIcon className="h-4 w-4 text-red-600" />
                                Record Expense
                            </button>
                        </>
                    )}
                    {canEdit && (
                        <button
                            onClick={() => onEditClick(account)}
                            className="btn-secondary flex items-center gap-2 text-sm"
                        >
                            <PencilSquareIcon className="h-4 w-4" />
                            Edit Account
                        </button>
                    )}
                </div>
            </div>

            {/* Bank Details */}
            <div className="card mb-6">
                <h3 className="section-title mb-3">Bank Details</h3>
                {account.is_virtual ? (
                    <p className="text-sm text-gray-400">
                        Virtual account — no real bank behind it.
                    </p>
                ) : (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                        <div>
                            <p className="text-xs text-gray-400">Bank</p>
                            <p className="text-sm font-medium text-gray-900">{account.bank_name || '—'}</p>
                        </div>
                        <div>
                            <p className="text-xs text-gray-400">Branch</p>
                            <p className="text-sm font-medium text-gray-900">{account.bank_branch || '—'}</p>
                        </div>
                        <div>
                            <p className="text-xs text-gray-400">Account Number</p>
                            <p className="text-sm font-medium text-gray-900 font-mono">{account.bank_account_number || '—'}</p>
                        </div>
                        <div>
                            <p className="text-xs text-gray-400">SWIFT / Routing</p>
                            <p className="text-sm font-medium text-gray-900 font-mono">{account.swift_routing_code || '—'}</p>
                        </div>
                    </div>
                )}
            </div>

            {/* Account Header */}
            <div className={`rounded-xl p-6 mb-6 text-white ${
                isPrimary
                    ? 'bg-gradient-to-r from-primary-900 to-primary-700'
                    : 'bg-gradient-to-r from-green-800 to-green-600'
            }`}>
                <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                        <BuildingLibraryIcon className="h-8 w-8 opacity-80" />
                        <div>
                            <p className="text-sm opacity-70">
                                {account.account_type} ACCOUNT
                            </p>
                            <h2 className="text-2xl font-bold mt-0.5">
                                {account.name}
                            </h2>
                        </div>
                    </div>
                    <div className="text-right">
                        <p className="text-sm opacity-70">Current Balance</p>
                        <p className="text-3xl font-bold mt-0.5">
                            {account.currency_code}{' '}
                            {parseFloat(account.current_balance).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                        </p>
                        {account.floor_limit && (
                            <p className="text-sm opacity-70 mt-1">
                                Floor: {account.currency_code}{' '}
                                {parseFloat(account.floor_limit).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                            </p>
                        )}
                        {account.side_fund_allocation > 0 && (
                            <p className="text-sm opacity-70 mt-1">
                                + {account.currency_code}{' '}
                                {parseFloat(account.side_fund_allocation).toLocaleString('en-US', { maximumFractionDigits: 2 })}{' '}
                                held in Side Fund
                            </p>
                        )}
                    </div>
                </div>

                {/* Stats Row */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-6">
                    <div className="bg-white bg-opacity-10 rounded-lg p-3">
                        <p className="text-xs opacity-70">Available</p>
                        <p className="text-lg font-bold mt-1">
                            {account.currency_code}{' '}
                            {parseFloat(account.available_balance ||
                                account.current_balance).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                        </p>
                    </div>
                    <div className="bg-white bg-opacity-10 rounded-lg p-3">
                        <p className="text-xs opacity-70">Total Inflows</p>
                        <p className="text-lg font-bold mt-1 text-green-300">
                            +{account.currency_code}{' '}
                            {totalInflow.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                        </p>
                    </div>
                    <div className="bg-white bg-opacity-10 rounded-lg p-3">
                        <p className="text-xs opacity-70">Total Outflows</p>
                        <p className="text-lg font-bold mt-1 text-red-300">
                            -{account.currency_code}{' '}
                            {totalOutflow.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                        </p>
                    </div>
                </div>
            </div>

            {/* Charts */}
            {chartData.length > 1 && (
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
                    {/* Balance Over Time */}
                    <div className="card lg:col-span-2">
                        <h3 className="section-title mb-4">Balance Over Time</h3>
                        <ResponsiveContainer width="100%" height={200}>
                            <AreaChart data={chartData}>
                                <defs>
                                    <linearGradient id="balanceGrad"
                                        x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor="#1e3a5f"
                                            stopOpacity={0.15} />
                                        <stop offset="95%" stopColor="#1e3a5f"
                                            stopOpacity={0} />
                                    </linearGradient>
                                </defs>
                                <CartesianGrid strokeDasharray="3 3"
                                    stroke="#f0f0f0" />
                                <XAxis dataKey="date" tick={{ fontSize: 11 }}
                                    tickLine={false} />
                                <YAxis tick={{ fontSize: 11 }} tickLine={false}
                                    axisLine={false}
                                    tickFormatter={v => v.toLocaleString('en-US', { maximumFractionDigits: 2 })} />
                                <Tooltip
                                    formatter={(v) => [
                                        `${account.currency_code} ${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`,
                                        'Balance'
                                    ]}
                                />
                                <Area type="monotone" dataKey="balance"
                                    stroke="#1e3a5f" strokeWidth={2}
                                    fill="url(#balanceGrad)" />
                            </AreaChart>
                        </ResponsiveContainer>
                    </div>

                    {/* Inflow vs Outflow */}
                    <div className="card">
                        <h3 className="section-title mb-4">Flow Breakdown</h3>
                        {totalInflow + totalOutflow > 0 ? (
                            <ResponsiveContainer width="100%" height={200}>
                                <PieChart>
                                    <Pie data={pieData} cx="50%" cy="50%"
                                        innerRadius={50} outerRadius={80}
                                        dataKey="value">
                                        {pieData.map((entry, index) => (
                                            <Cell key={index}
                                                fill={PIE_COLORS[index]} />
                                        ))}
                                    </Pie>
                                    <Tooltip
                                        formatter={(v) => [
                                            `${account.currency_code} ${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`,
                                        ]}
                                    />
                                    <Legend />
                                </PieChart>
                            </ResponsiveContainer>
                        ) : (
                            <div className="flex items-center justify-center h-48
                                text-gray-300 text-sm">
                                No transactions yet
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Transaction Ledger */}
            <div className="card">
                <h3 className="section-title mb-4">Transaction Ledger</h3>
                {loading ? (
                    <LoadingSpinner size="sm" text="Loading transactions..." />
                ) : transactions.length === 0 ? (
                    <p className="text-sm text-gray-400 text-center py-8">
                        No transactions on this account yet
                    </p>
                ) : (
                    <>
                        <div className="overflow-x-auto">
                            <table className="min-w-full">
                                <thead>
                                    <tr className="border-b border-gray-200">
                                        <th className="table-header">Reference</th>
                                        <th className="table-header">Description</th>
                                        <th className="table-header">Type</th>
                                        <th className="table-header">Date</th>
                                        <th className="table-header text-right">
                                            Amount
                                        </th>
                                        <th className="table-header text-right">
                                            Balance After
                                        </th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-100">
                                    {transactions.map((tx, i) => {
                                        const isCredit =
                                            tx.transaction_type === 'CREDIT' ||
                                            tx.transaction_type === 'REVERSAL_CREDIT';
                                        return (
                                            <tr key={i}
                                                className="hover:bg-gray-50">
                                                <td className="table-cell">
                                                    <span className="font-mono
                                                        text-xs text-primary-700">
                                                        {tx.reference_code}
                                                    </span>
                                                </td>
                                                <td className="table-cell
                                                    max-w-xs">
                                                    <p className="text-sm
                                                        text-gray-900 truncate">
                                                        {tx.description}
                                                    </p>
                                                    <p className="text-xs
                                                        text-gray-400">
                                                        {tx.category_trail ||
                                                            tx.category_name}
                                                    </p>
                                                </td>
                                                <td className="table-cell">
                                                    <span className="text-xs
                                                        text-gray-500">
                                                        {tx.inflow_type
                                                            ?.replace(/_/g, ' ')}
                                                    </span>
                                                </td>
                                                <td className="table-cell
                                                    text-sm text-gray-500">
                                                    {formatDate(tx.value_date)}
                                                </td>
                                                <td className="table-cell
                                                    text-right">
                                                    <span className={`text-sm
                                                        font-semibold ${
                                                        isCredit
                                                            ? 'text-green-600'
                                                            : 'text-red-600'
                                                    }`}>
                                                        {isCredit ? '+' : '-'}
                                                        {tx.currency_code}{' '}
                                                        {parseFloat(tx.amount)
                                                            .toLocaleString('en-US', { maximumFractionDigits: 2 })}
                                                    </span>
                                                </td>
                                                <td className="table-cell
                                                    text-right text-sm
                                                    text-gray-600">
                                                    {tx.currency_code}{' '}
                                                    {parseFloat(tx.balance_after)
                                                        .toLocaleString('en-US', { maximumFractionDigits: 2 })}
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>

                        {/* Pagination */}
                        {pagination && pagination.totalPages > 1 && (
                            <div className="flex justify-between items-center
                                mt-4 pt-4 border-t border-gray-100">
                                <p className="text-sm text-gray-500">
                                    Page {pagination.page} of {pagination.totalPages}
                                </p>
                                <div className="flex gap-2">
                                    <button
                                        onClick={() => setPage(p => p - 1)}
                                        disabled={!pagination.hasPrevPage}
                                        className="btn-secondary text-sm py-1 px-3
                                            disabled:opacity-50"
                                    >
                                        Previous
                                    </button>
                                    <button
                                        onClick={() => setPage(p => p + 1)}
                                        disabled={!pagination.hasNextPage}
                                        className="btn-secondary text-sm py-1 px-3
                                            disabled:opacity-50"
                                    >
                                        Next
                                    </button>
                                </div>
                            </div>
                        )}
                    </>
                )}
            </div>

            <RecordTransactionModal
                isOpen={showInflow}
                onClose={() => setShowInflow(false)}
                onSuccess={() => { loadTransactions(); onTransactionRecorded?.(); }}
                account={account}
                type="INFLOW"
            />
            <RecordTransactionModal
                isOpen={showExpense}
                onClose={() => setShowExpense(false)}
                onSuccess={() => { loadTransactions(); onTransactionRecorded?.(); }}
                account={account}
                type="EXPENSE"
            />
        </div>
    );
};

// ============================================================
// ACCOUNT TILE
// Clickable card on the main accounts list
// ============================================================
const AccountTile = ({ account, onClick, onFloorLimitClick }) => {
    const isPrimary = account.account_type === 'PRIMARY';
    const isSavings = account.account_type === 'SAVINGS';
    // Floor limits can be set on any account except SAVINGS (v1.14.0),
    // which is permanently exempt and may sit at zero at any time.
    const canHaveFloorLimit = !isSavings;
    const balancePercent = account.floor_limit
        ? Math.min(100, (parseFloat(account.current_balance) /
          (parseFloat(account.current_balance) +
           parseFloat(account.floor_limit))) * 100)
        : null;

    return (
        <div
            onClick={() => onClick(account)}
            className={`card cursor-pointer hover:shadow-md transition-all
                border-l-4 group ${
                isPrimary
                    ? 'border-l-primary-700 hover:border-l-primary-900'
                    : isSavings
                    ? 'border-l-amber-500 hover:border-l-amber-700'
                    : 'border-l-green-500 hover:border-l-green-700'
            }`}
        >
            <div className="flex items-start justify-between mb-4">
                <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg ${
                        isPrimary ? 'bg-primary-50' : isSavings ? 'bg-amber-50' : 'bg-green-50'
                    }`}>
                        <BuildingLibraryIcon className={`h-6 w-6 ${
                            isPrimary ? 'text-primary-700' : isSavings ? 'text-amber-600' : 'text-green-600'
                        }`} />
                    </div>
                    <div>
                        <h3 className="font-semibold text-gray-900">
                            {account.name}
                        </h3>
                        <span className={`text-xs font-medium px-2 py-0.5
                            rounded-full ${
                            isPrimary
                                ? 'bg-primary-100 text-primary-700'
                                : isSavings
                                ? 'bg-amber-100 text-amber-700'
                                : 'bg-green-100 text-green-700'
                        }`}>
                            {account.account_type}
                        </span>
                        {account.reference_prefix && (
                            <span className="ml-1 text-xs font-mono font-medium
                                px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                                {account.reference_prefix}
                            </span>
                        )}
                    </div>
                </div>
                {canHaveFloorLimit && onFloorLimitClick && (
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onFloorLimitClick(account);
                        }}
                        className="text-xs text-primary-600 hover:text-primary-700
                            font-medium flex items-center gap-1 opacity-0
                            group-hover:opacity-100 transition-opacity"
                    >
                        <ShieldCheckIcon className="h-4 w-4" />
                        Floor Limit
                    </button>
                )}
            </div>

            {/* Balance */}
            <p className="text-3xl font-bold text-gray-900 mb-1">
                {account.currency_code}{' '}
                {parseFloat(account.current_balance).toLocaleString('en-US', { maximumFractionDigits: 2 })}
            </p>
            {account.side_fund_allocation > 0 && (
                <p className="text-xs text-amber-600 mb-1">
                    + {account.currency_code}{' '}
                    {parseFloat(account.side_fund_allocation).toLocaleString('en-US', { maximumFractionDigits: 2 })}{' '}
                    held in Side Fund (shown separately)
                </p>
            )}

            {canHaveFloorLimit && account.floor_limit && (
                <>
                    <div className="flex justify-between text-xs text-gray-400 mb-1">
                        <span>Floor: {account.currency_code}{' '}
                            {parseFloat(account.floor_limit).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                        </span>
                        <span>Available: {account.currency_code}{' '}
                            {parseFloat(account.available_balance).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                        </span>
                    </div>
                    <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                        <div
                            className="h-full bg-primary-600 rounded-full"
                            style={{ width: `${balancePercent}%` }}
                        />
                    </div>
                </>
            )}

            <p className="text-xs text-primary-500 mt-3 group-hover:text-primary-700
                transition-colors">
                Click to view details →
            </p>
        </div>
    );
};

// ============================================================
// SET SHARE PRICE MODAL
// ============================================================
const SetSharePriceModal = ({ isOpen, onClose, onSuccess, currencies, currentPrice }) => {
    const [form, setForm] = useState({
        price_per_share: '',
        currency_id: currentPrice?.currency_code
            ? currencies.find(c => c.code === currentPrice.currency_code)?.id || ''
            : '',
        effective_from: new Date().toISOString().split('T')[0],
        notes: '',
    });
    const [loading, setLoading] = useState(false);
    const [error,   setError]   = useState(null);

    if (!isOpen) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await sharesAPI.setPrice(form);
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
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">
                        Set Share Price
                    </h2>
                    <p className="text-sm text-gray-500 mb-4">
                        Every active shareholder will be notified of the new price.
                    </p>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">Price Per Share *</label>
                            <input type="number" className="input" step="0.0001" min="0.0001"
                                value={form.price_per_share}
                                onChange={e => setForm(p => ({ ...p, price_per_share: e.target.value }))}
                                required />
                        </div>
                        <div>
                            <label className="label">Currency *</label>
                            <select className="input" value={form.currency_id}
                                onChange={e => setForm(p => ({ ...p, currency_id: e.target.value }))}
                                required>
                                <option value="">Select currency...</option>
                                {currencies.map(c => (
                                    <option key={c.id} value={c.id}>
                                        {c.code} — {c.name}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label className="label">Effective From *</label>
                            <input type="date" className="input"
                                value={form.effective_from}
                                onChange={e => setForm(p => ({ ...p, effective_from: e.target.value }))}
                                required />
                        </div>
                        <div>
                            <label className="label">Notes</label>
                            <textarea className="input" rows={2} value={form.notes}
                                onChange={e => setForm(p => ({ ...p, notes: e.target.value }))}
                                placeholder="Reason for the price change..." />
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose}
                                className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading}
                                className="btn-primary">
                                {loading ? 'Saving...' : 'Set Price'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// SHARE PRICE CARD
// ============================================================
const SharePriceCard = ({ sharePrice, canEdit, onEditClick }) => (
    <div className="card mb-6">
        <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
                <div className="p-3 rounded-xl bg-purple-50 text-purple-700">
                    <TagIcon className="h-6 w-6" />
                </div>
                <div>
                    <p className="text-sm font-medium text-gray-500">
                        Current Share Price
                    </p>
                    <p className="text-2xl font-bold text-gray-900">
                        {sharePrice?.price_per_share
                            ? `${sharePrice.currency_symbol || sharePrice.currency_code} ${parseFloat(sharePrice.price_per_share).toLocaleString('en-US', { maximumFractionDigits: 2 })}`
                            : 'Not set'
                        }
                    </p>
                    {sharePrice?.effective_from && (
                        <p className="text-xs text-gray-400 mt-1">
                            Effective from {formatDate(sharePrice.effective_from)}
                            {sharePrice.set_by_name && ` — set by ${sharePrice.set_by_name}`}
                        </p>
                    )}
                </div>
            </div>
            {canEdit && (
                <button
                    onClick={onEditClick}
                    className="btn-secondary flex items-center gap-2"
                >
                    <PencilSquareIcon className="h-4 w-4" />
                    {sharePrice?.price_per_share ? 'Update Price' : 'Set Price'}
                </button>
            )}
        </div>
    </div>
);

// ============================================================
// SET EXCHANGE RATE MODAL
// Display-only conversion rate: 1 unit of base currency = rate
// units of target currency. Does not affect contributions or
// transactions — used only to show the share price/value in
// other currencies.
// ============================================================
const SetExchangeRateModal = ({ isOpen, onClose, onSuccess, currencies }) => {
    const [form, setForm] = useState({
        base_currency_id: '',
        target_currency_id: '',
        rate: '',
        effective_from: new Date().toISOString().split('T')[0],
        notes: '',
    });
    const [loading, setLoading] = useState(false);
    const [error,   setError]   = useState(null);

    if (!isOpen) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await exchangeRatesAPI.setRate(form);
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
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">
                        Set Exchange Rate
                    </h2>
                    <p className="text-sm text-gray-500 mb-4">
                        Used only to display the share price/value in another
                        currency — it does not change any recorded amount.
                    </p>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div>
                                <label className="label">From Currency *</label>
                                <select className="input" value={form.base_currency_id}
                                    onChange={e => setForm(p => ({ ...p, base_currency_id: e.target.value }))}
                                    required>
                                    <option value="">Select...</option>
                                    {currencies.map(c => (
                                        <option key={c.id} value={c.id}>{c.code}</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className="label">To Currency *</label>
                                <select className="input" value={form.target_currency_id}
                                    onChange={e => setForm(p => ({ ...p, target_currency_id: e.target.value }))}
                                    required>
                                    <option value="">Select...</option>
                                    {currencies.map(c => (
                                        <option key={c.id} value={c.id}>{c.code}</option>
                                    ))}
                                </select>
                            </div>
                        </div>
                        <div>
                            <label className="label">Rate *</label>
                            <input type="number" className="input" step="0.000001" min="0.000001"
                                value={form.rate}
                                onChange={e => setForm(p => ({ ...p, rate: e.target.value }))}
                                placeholder="e.g. 1 unit of From Currency = this many of To Currency"
                                required />
                        </div>
                        <div>
                            <label className="label">Effective From *</label>
                            <input type="date" className="input"
                                value={form.effective_from}
                                onChange={e => setForm(p => ({ ...p, effective_from: e.target.value }))}
                                required />
                        </div>
                        <div>
                            <label className="label">Notes</label>
                            <textarea className="input" rows={2} value={form.notes}
                                onChange={e => setForm(p => ({ ...p, notes: e.target.value }))}
                                placeholder="Source of this rate..." />
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose}
                                className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading}
                                className="btn-primary">
                                {loading ? 'Saving...' : 'Set Rate'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// EXCHANGE RATES CARD
// ============================================================
const ExchangeRatesCard = ({ rates, canEdit, onEditClick }) => (
    <div className="card mb-6">
        <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
                <div className="p-3 rounded-xl bg-teal-50 text-teal-700">
                    <ArrowsRightLeftIcon className="h-6 w-6" />
                </div>
                <div>
                    <p className="text-sm font-medium text-gray-500">
                        Currency Exchange Rates
                    </p>
                    <p className="text-xs text-gray-400">
                        Monthly rates — used only to show values in other currencies
                    </p>
                </div>
            </div>
            {canEdit && (
                <button
                    onClick={onEditClick}
                    className="btn-secondary flex items-center gap-2"
                >
                    <PencilSquareIcon className="h-4 w-4" />
                    Set Rate
                </button>
            )}
        </div>
        {rates.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-4">
                No exchange rates set yet
            </p>
        ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {rates.map(r => (
                    <div key={r.id} className="bg-gray-50 rounded-lg p-3">
                        <p className="text-xs text-gray-400">
                            {r.base_currency_code} → {r.target_currency_code}
                        </p>
                        <p className="text-sm font-bold text-gray-900">
                            1 = {parseFloat(r.rate).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                        </p>
                        <p className="text-xs text-gray-400">
                            since {formatDate(r.effective_from)}
                        </p>
                    </div>
                ))}
            </div>
        )}
    </div>
);

// ============================================================
// MAIN ACCOUNTS PAGE
// ============================================================
const AccountsPage = () => {
    const { hasPermission, hasRole, isTreasurer } = useAuth();
    const [accounts,      setAccounts]      = useState([]);
    const [currencies,    setCurrencies]    = useState([]);
    const [sharePrice,    setSharePrice]    = useState(null);
    const [exchangeRates, setExchangeRates] = useState([]);
    const [loading,       setLoading]       = useState(true);
    const [error,         setError]         = useState(null);
    const [showCreate,    setShowCreate]    = useState(false);
    const [floorAccount,  setFloorAccount]  = useState(null);
    const [showPriceModal, setShowPriceModal] = useState(false);
    const [showRateModal,  setShowRateModal]  = useState(false);
    const [selectedAccount, setSelectedAccount] = useState(null);
    const [editingAccount, setEditingAccount] = useState(null);

    const canEditRates = hasRole(['Treasurer', 'Assistant Treasurer', 'Admin']);

    const loadData = async () => {
        try {
            setLoading(true);
            const [accountsRes, currenciesRes, sharePriceRes, exchangeRatesRes] = await Promise.all([
                accountsAPI.getAll(),
                accountsAPI.getCurrencies(),
                sharesAPI.getCurrentPrice().catch(() => ({ data: { data: null } })),
                exchangeRatesAPI.getCurrent().catch(() => ({ data: { data: [] } })),
            ]);
            const fullAccounts = await Promise.all(
                accountsRes.data.data.map(a => accountsAPI.getById(a.id))
            );
            const loadedAccounts = fullAccounts.map(r => r.data.data);
            setAccounts(loadedAccounts);
            setCurrencies(currenciesRes.data.data);
            setSharePrice(sharePriceRes.data.data);
            setExchangeRates(exchangeRatesRes.data.data || []);
            // Keep the open detail view in sync with any edits just made
            setSelectedAccount(prev => prev ? (loadedAccounts.find(a => a.id === prev.id) || prev) : null);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { loadData(); }, []);

    if (loading) return <LoadingSpinner fullPage text="Loading accounts..." />;

    // Show account detail view if an account is selected
    if (selectedAccount) {
        return (
            <>
                <AccountDetailView
                    account={selectedAccount}
                    onBack={() => setSelectedAccount(null)}
                    canEdit={hasPermission('SYSTEM_CONFIG')}
                    onEditClick={setEditingAccount}
                    canRecordTransactions={hasRole(['Treasurer', 'Assistant Treasurer'])}
                    onTransactionRecorded={loadData}
                />
                <EditAccountModal
                    isOpen={!!editingAccount}
                    account={editingAccount}
                    onClose={() => setEditingAccount(null)}
                    onSuccess={loadData}
                />
            </>
        );
    }

    const hasSavingsAccount = accounts.some(a => a.account_type === 'SAVINGS');

    return (
        <div>
            <PageHeader
                title="Accounts"
                subtitle="Company account balances and financial overview"
                actions={
                    hasPermission('SYSTEM_CONFIG') && (
                        <button
                            onClick={() => setShowCreate(true)}
                            className="btn-primary flex items-center gap-2"
                        >
                            <PlusIcon className="h-4 w-4" />
                            New Account
                        </button>
                    )
                }
            />

            {error && (
                <div className="mb-6">
                    <ErrorMessage message={error}
                        onDismiss={() => setError(null)} />
                </div>
            )}

            {!hasSavingsAccount && hasPermission('SYSTEM_CONFIG') && (
                <div className="mb-6 flex items-center justify-between gap-4
                    bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
                    <p className="text-sm text-amber-800">
                        No savings account has been set up yet. Member savings deposits
                        will be rejected until one exists.
                    </p>
                    <button onClick={() => setShowCreate(true)}
                        className="btn-secondary text-sm whitespace-nowrap">
                        Set Up Savings Account
                    </button>
                </div>
            )}

            {/* Share Price */}
            <SharePriceCard
                sharePrice={sharePrice}
                canEdit={isTreasurer()}
                onEditClick={() => setShowPriceModal(true)}
            />

            {/* Exchange Rates */}
            <ExchangeRatesCard
                rates={exchangeRates}
                canEdit={canEditRates}
                onEditClick={() => setShowRateModal(true)}
            />

            {/* Account Tiles */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {accounts.map(account => (
                    <AccountTile
                        key={account.id}
                        account={account}
                        onClick={setSelectedAccount}
                        onFloorLimitClick={
                            hasPermission('FINANCE_FLOOR_LIMIT_UPDATE')
                                ? setFloorAccount
                                : null
                        }
                    />
                ))}
            </div>

            {/* Modals */}
            <CreateAccountModal
                isOpen={showCreate}
                onClose={() => setShowCreate(false)}
                onSuccess={loadData}
                currencies={currencies}
                hasSavingsAccount={hasSavingsAccount}
            />
            <FloorLimitModal
                isOpen={!!floorAccount}
                account={floorAccount}
                onClose={() => setFloorAccount(null)}
                onSuccess={loadData}
            />
            <SetSharePriceModal
                isOpen={showPriceModal}
                onClose={() => setShowPriceModal(false)}
                onSuccess={loadData}
                currencies={currencies}
                currentPrice={sharePrice}
            />
            <SetExchangeRateModal
                isOpen={showRateModal}
                onClose={() => setShowRateModal(false)}
                onSuccess={loadData}
                currencies={currencies}
            />
        </div>
    );
};

export default AccountsPage;