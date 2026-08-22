// ============================================================
// TRANSACTIONS PAGE
// Shows the full transaction ledger with filtering.
// Allows recording contributions and expenses.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { transactionsAPI, accountsAPI, categoriesAPI, usersAPI, sideFundAPI } from '../../api/endpoints';
import { formatDate, getErrorMessage, getInflowTypeLabel } from '../../utils/helpers';
import PageHeader from '../../components/common/PageHeader';
import DataTable from '../../components/common/DataTable';
import ErrorMessage from '../../components/common/ErrorMessage';
import StatusBadge from '../../components/common/StatusBadge';
import { useAuth } from '../../contexts/AuthContext';
import { PlusIcon, FunnelIcon, ArrowDownTrayIcon, ArrowUturnLeftIcon } from '@heroicons/react/24/outline';
import { transactionTemplate, printDocument } from '../../utils/exportUtils';
import DocumentPreviewModal from '../../components/common/DocumentPreviewModal';

// ============================================================
// RECORD CONTRIBUTION MODAL
// ============================================================
// ============================================================
// RECORD CONTRIBUTION MODAL
// ============================================================
const ContributionModal = ({ isOpen, onClose, onSuccess, categories, shareholders, accounts }) => {
    const { user, hasPermission } = useAuth();
    const [form, setForm] = useState({
        amount: '', contribution_date: '', category_id: '',
        notes: '', contributed_by: '', side_fund_amount: '', savings_amount: '',
        account_id: '',
    });
    const [loading, setLoading] = useState(false);
    const [error,   setError]   = useState(null);
    const [sideFundActive, setSideFundActive] = useState(false);
    // v1.31.0 — both slice fields are now checkbox-gated: the amount
    // input only appears once its own checkbox is explicitly checked.
    // Unchecking a box also clears its stored amount, so a hidden,
    // stale value can never be silently submitted.
    const [includeSideFund, setIncludeSideFund] = useState(false);
    const [includeSavings,  setIncludeSavings]  = useState(false);

    useEffect(() => {
        if (!isOpen) return;
        sideFundAPI.getSettings()
            .then(res => setSideFundActive(!!res.data.data?.is_active))
            .catch(() => setSideFundActive(false));
    }, [isOpen]);

    if (!isOpen) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await transactionsAPI.recordContribution({
                ...form,
                contributed_by: form.contributed_by || user.id,
                account_id: form.account_id || undefined,
                side_fund_amount: includeSideFund ? (form.side_fund_amount || undefined) : undefined,
                savings_amount:   includeSavings  ? (form.savings_amount  || undefined) : undefined,
            });
            onSuccess();
            onClose();
            setForm({ amount: '', contribution_date: '', category_id: '',
                notes: '', contributed_by: '', side_fund_amount: '', savings_amount: '',
                account_id: '' });
            setIncludeSideFund(false);
            setIncludeSavings(false);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    const financeCategories = categories.filter(c => c.module === 'FINANCE');
    const canRecordForOthers = hasPermission('FINANCE_VIEW_ALL');
    const sideFundPortion = includeSideFund ? (parseFloat(form.side_fund_amount) || 0) : 0;
    const savingsPortion  = includeSavings  ? (parseFloat(form.savings_amount)  || 0) : 0;
    const totalAmount     = parseFloat(form.amount) || 0;
    const contributionRemainder = Math.max(0, totalAmount - sideFundPortion - savingsPortion);

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            <div className="fixed inset-0 bg-black bg-opacity-40" onClick={onClose} />
            <div className="flex min-h-full items-center justify-center p-4">
                <div className="relative bg-white rounded-xl shadow-xl max-w-md w-full p-6">
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">
                        Record Contribution
                    </h2>
                    <p className="text-sm text-gray-400 mb-4">
                        Capital contribution to the primary account.
                        Shareholding percentages are automatically recalculated.
                    </p>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        {/* Member selector — only for Treasurer/Admin */}
                        {canRecordForOthers && (
                            <div>
                                <label className="label">Contributing Member *</label>
                                <select className="input" value={form.contributed_by}
                                    onChange={e => setForm(p => ({
                                        ...p, contributed_by: e.target.value }))}
                                    required>
                                    <option value="">Select member...</option>
                                    {shareholders.map(s => (
                                        <option key={s.id} value={s.id}>
                                            {s.first_name} {s.last_name}
                                            {s.percentage
                                                ? ` — ${s.percentage}% shareholding`
                                                : ''}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        )}
                        <div>
                            <label className="label">Amount (EUR) *</label>
                            <input type="number" className="input" value={form.amount}
                                onChange={e => setForm(p => ({
                                    ...p, amount: e.target.value }))}
                                min="0.01" step="0.01" required />
                        </div>
                        <div>
                            <label className="label">Account</label>
                            <select className="input" value={form.account_id}
                                onChange={e => setForm(p => ({
                                    ...p, account_id: e.target.value }))}>
                                <option value="">Primary Account (default)</option>
                                {accounts.filter(a => a.account_type !== 'SAVINGS').map(a => (
                                    <option key={a.id} value={a.id}>
                                        {a.name} ({a.currency_code})
                                    </option>
                                ))}
                            </select>
                            <p className="text-xs text-gray-400 mt-1">
                                Which account this contribution is paid into. The money
                                stays there — shares are still calculated by converting
                                this account's currency into the share price's currency
                                at the rate in effect on the contribution date.
                            </p>
                        </div>
                        {sideFundActive && (
                            <div>
                                <label className="flex items-center gap-2 text-sm text-gray-700">
                                    <input type="checkbox" checked={includeSideFund}
                                        onChange={e => {
                                            const checked = e.target.checked;
                                            setIncludeSideFund(checked);
                                            if (!checked) setForm(p => ({ ...p, side_fund_amount: '' }));
                                        }} />
                                    This contribution includes a side fund portion
                                </label>
                                {includeSideFund && (
                                    <div className="mt-2">
                                        <label className="label">Side Fund Portion</label>
                                        <input type="number" className="input" value={form.side_fund_amount}
                                            onChange={e => setForm(p => ({
                                                ...p, side_fund_amount: e.target.value }))}
                                            min="0" step="0.01" max={form.amount || undefined}
                                            placeholder="0.00" />
                                        <p className="text-xs text-gray-400 mt-1">
                                            Sliced out of the total above and credited to this member's own side fund dues.
                                        </p>
                                    </div>
                                )}
                            </div>
                        )}
                        <div>
                            <label className="flex items-center gap-2 text-sm text-gray-700">
                                <input type="checkbox" checked={includeSavings}
                                    onChange={e => {
                                        const checked = e.target.checked;
                                        setIncludeSavings(checked);
                                        if (!checked) setForm(p => ({ ...p, savings_amount: '' }));
                                    }} />
                                This contribution includes a savings portion
                            </label>
                            {includeSavings && (
                                <div className="mt-2">
                                    <label className="label">Savings Portion</label>
                                    <input type="number" className="input" value={form.savings_amount}
                                        onChange={e => setForm(p => ({
                                            ...p, savings_amount: e.target.value }))}
                                        min="0" step="0.01" max={form.amount || undefined}
                                        placeholder="0.00" />
                                    <p className="text-xs text-gray-400 mt-1">
                                        Sliced out of the total above and credited directly to this member's own savings balance.
                                    </p>
                                </div>
                            )}
                        </div>
                        {(includeSideFund || includeSavings) && (
                            <p className="text-xs text-gray-400 -mt-2">
                                Contribution recorded: <strong>{contributionRemainder.toFixed(2)}</strong>
                            </p>
                        )}
                        <div>
                            <label className="label">Contribution Date *</label>
                            <input type="date" className="input"
                                value={form.contribution_date}
                                max={new Date().toISOString().slice(0, 10)}
                                onChange={e => setForm(p => ({
                                    ...p, contribution_date: e.target.value }))}
                                required />
                        </div>
                        <div>
                            <label className="label">Category *</label>
                            <select className="input" value={form.category_id}
                                onChange={e => setForm(p => ({
                                    ...p, category_id: e.target.value }))}
                                required>
                                <option value="">Select category...</option>
                                {financeCategories.map(c => (
                                    <option key={c.id} value={c.id}>
                                        {c.full_path || c.name}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label className="label">Notes</label>
                            <textarea className="input" rows={2} value={form.notes}
                                onChange={e => setForm(p => ({
                                    ...p, notes: e.target.value }))} />
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose}
                                className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading}
                                className="btn-primary">
                                {loading ? 'Recording...' : 'Record Contribution'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// RECORD EXPENSE MODAL
// ============================================================
const ExpenseModal = ({ isOpen, onClose, onSuccess, categories, accounts }) => {
    const [form, setForm] = useState({
        account_id: '', amount: '', category_id: '',
        description: '', value_date: ''
    });
    const [loading, setLoading] = useState(false);
    const [error,   setError]   = useState(null);

    if (!isOpen) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await transactionsAPI.recordExpense(form);
            onSuccess();
            onClose();
            setForm({ account_id: '', amount: '', category_id: '',
                description: '', value_date: '' });
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    const financeCategories = categories.filter(c => c.module === 'FINANCE');

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            <div className="fixed inset-0 bg-black bg-opacity-40" onClick={onClose} />
            <div className="flex min-h-full items-center justify-center p-4">
                <div className="relative bg-white rounded-xl shadow-xl max-w-md w-full p-6">
                    <h2 className="text-lg font-semibold text-gray-900 mb-4">
                        Record Expense
                    </h2>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">Account *</label>
                            <select className="input" value={form.account_id}
                                onChange={e => setForm(p => ({
                                    ...p, account_id: e.target.value }))}
                                required>
                                <option value="">Select account...</option>
                                {accounts.map(a => (
                                    <option key={a.id} value={a.id}>
                                        {a.name} ({a.currency_code})
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label className="label">Amount *</label>
                            <input type="number" className="input" value={form.amount}
                                onChange={e => setForm(p => ({
                                    ...p, amount: e.target.value }))}
                                min="0.01" step="0.01" required />
                        </div>
                        <div>
                            <label className="label">Category *</label>
                            <select className="input" value={form.category_id}
                                onChange={e => setForm(p => ({
                                    ...p, category_id: e.target.value }))}
                                required>
                                <option value="">Select category...</option>
                                {financeCategories.map(c => (
                                    <option key={c.id} value={c.id}>
                                        {c.full_path || c.name}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label className="label">Description *</label>
                            <input type="text" className="input" value={form.description}
                                onChange={e => setForm(p => ({
                                    ...p, description: e.target.value }))}
                                required />
                        </div>
                        <div>
                            <label className="label">Date *</label>
                            <input type="date" className="input" value={form.value_date}
                                max={new Date().toISOString().slice(0, 10)}
                                onChange={e => setForm(p => ({
                                    ...p, value_date: e.target.value }))}
                                required />
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose}
                                className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading}
                                className="btn-primary">
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
// REVERSE TRANSACTION MODAL
// Treasurer only (matches the backend's requireRoles(['Treasurer'])
// gate on POST /transactions/:id/reverse). Posts an equal-and-
// opposite entry rather than deleting/editing the original —
// nothing in this system's ledger is ever silently altered.
// ============================================================
const ReverseTransactionModal = ({ transaction, onClose, onSuccess }) => {
    const [reason, setReason]   = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError]     = useState(null);

    if (!transaction) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await transactionsAPI.reverse(transaction.id, { reason });
            onSuccess();
            onClose();
            setReason('');
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
                        Reverse Transaction
                    </h2>
                    <p className="text-sm text-gray-400 mb-4">
                        This posts a new, equal-and-opposite entry — the original
                        transaction ({transaction.reference_code}) is never deleted or
                        edited. This cannot be undone once posted.
                    </p>
                    <div className="bg-gray-50 rounded-lg p-3 mb-4 text-sm">
                        <p className="text-gray-500">{transaction.description}</p>
                        <p className="font-semibold text-gray-900 mt-1">
                            {transaction.currency_code} {parseFloat(transaction.amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                        </p>
                    </div>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">Reason for Reversal *</label>
                            <textarea className="input" rows={3} value={reason}
                                onChange={e => setReason(e.target.value)}
                                placeholder="Why is this transaction being reversed?"
                                required />
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose}
                                className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading || !reason.trim()}
                                className="btn-danger">
                                {loading ? 'Reversing...' : 'Reverse Transaction'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// MAIN TRANSACTIONS PAGE
// ============================================================
const TransactionsPage = () => {
    const { hasPermission, hasRole } = useAuth();
    const [transactions, setTransactions] = useState([]);
    const [accounts,     setAccounts]     = useState([]);
    const [categories,   setCategories]   = useState([]);
    const [pagination,   setPagination]   = useState(null);
    const [loading,      setLoading]      = useState(true);
    const [error,        setError]        = useState(null);
    const [page,         setPage]         = useState(1);
    const [showContrib,  setShowContrib]  = useState(false);
    const [showExpense,  setShowExpense]  = useState(false);
    const [showMenu,     setShowMenu]     = useState(false);
    const [shareholders, setShareholders] = useState([]);
    const [preview,      setPreview]      = useState(null);
    const [reversing,    setReversing]    = useState(null);

    // Filters
    const [filters, setFilters] = useState({
        account_id: '', inflow_type: '', from_date: '', to_date: ''
    });

    const loadTransactions = useCallback(async () => {
        try {
            setLoading(true);
            const params = { page, limit: 20, ...filters };
            Object.keys(params).forEach(k => !params[k] && delete params[k]);
            const res = await transactionsAPI.getAll(params);
            setTransactions(res.data.data);
            setPagination(res.data.meta?.pagination);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, [page, filters]);

    useEffect(() => {
        loadTransactions();
        accountsAPI.getAll().then(r => setAccounts(r.data.data)).catch(() => {});
        categoriesAPI.getAll({ flat: true }).then(r => setCategories(r.data.data)).catch(() => {});
        usersAPI.getShareholders().then(r => setShareholders(r.data.data || [])).catch(() => {});
    }, [loadTransactions]);

    // --------------------------------------------------------
    // EXPORT FUNCTIONS — must be inside TransactionsPage
    // --------------------------------------------------------
    const handleExportAll = () => {
        const html = transactionTemplate(transactions, {
            accountName: filters.account_id
                ? accounts.find(a => String(a.id) === filters.account_id)?.name || 'All Accounts'
                : 'All Accounts',
            period: filters.from_date && filters.to_date
                ? `${filters.from_date} to ${filters.to_date}`
                : new Date().toLocaleDateString('en-GB'),
        });
        printDocument(html, 'Transaction Ledger');
    };

    const handleExportSingle = (tx) => {
        const html = transactionTemplate(tx);
        printDocument(html, tx.reference_code);
    };

    const columns = [
        {
            header: 'Reference',
            render: row => (
                <div>
                    <button
                        onClick={() => setPreview({
                            html: transactionTemplate(row),
                            title: row.reference_code,
                        })}
                        className="font-mono text-xs font-medium text-primary-700
                            hover:underline"
                        title="Preview document"
                    >
                        {row.reference_code}
                    </button>
                    {row.public_id && (
                        <div className="font-mono text-[10px] text-gray-400" title="Public ID — searchable">
                            {row.public_id}
                        </div>
                    )}
                </div>
            ),
        },
        {
            header: 'Description',
            render: row => (
                <div>
                    <p className="text-sm font-medium text-gray-900 truncate max-w-xs">
                        {row.description}
                    </p>
                    <p className="text-xs text-gray-400">{row.account_name}</p>
                </div>
            ),
        },
        {
            header: 'Type',
            render: row => (
                <span className="text-xs text-gray-600">
                    {getInflowTypeLabel(row.inflow_type)}
                </span>
            ),
        },
        {
            header: 'Category',
            render: row => (
                <span className="text-xs text-gray-500">
                    {row.category_trail || row.category_name}
                </span>
            ),
        },
        {
            header: 'Amount',
            render: row => (
                <span className={`font-semibold text-sm ${
                    row.transaction_type === 'CREDIT' ||
                    row.transaction_type === 'REVERSAL_CREDIT'
                        ? 'text-green-600' : 'text-red-600'
                }`}>
                    {row.transaction_type === 'CREDIT' ||
                     row.transaction_type === 'REVERSAL_CREDIT' ? '+' : '-'}
                    {row.currency_code} {parseFloat(row.amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                </span>
            ),
        },
        {
            header: 'Balance After',
            render: row => (
                <span className="text-sm text-gray-600">
                    {row.currency_code} {parseFloat(row.balance_after).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                </span>
            ),
        },
        {
            header: 'Date',
            render: row => (
                <span className="text-sm text-gray-500">
                    {formatDate(row.value_date)}
                </span>
            ),
        },
        {
            header: 'Status',
            render: row => <StatusBadge status={row.status} />,
        },
        {
            header: '',
            render: row => (
                <div className="flex items-center gap-1.5">
                    <button
                        onClick={() => handleExportSingle(row)}
                        className="p-1.5 rounded-lg bg-gray-50 text-gray-500
                            hover:bg-gray-100 transition-colors"
                        title="Export this transaction"
                    >
                        <ArrowDownTrayIcon className="h-4 w-4" />
                    </button>
                    {hasRole('Treasurer') && !row.is_reversal && !row.is_reversed && (
                        <button
                            onClick={() => setReversing(row)}
                            className="p-1.5 rounded-lg bg-red-50 text-red-600
                                hover:bg-red-100 transition-colors"
                            title="Reverse this transaction"
                        >
                            <ArrowUturnLeftIcon className="h-4 w-4" />
                        </button>
                    )}
                </div>
            ),
        },
    ];

    return (
        <div>
            <PageHeader
                title="Transactions"
                subtitle="Complete financial transaction ledger"
                actions={
                    <div className="flex gap-2">
                        <button
                            onClick={handleExportAll}
                            className="btn-secondary flex items-center gap-2"
                        >
                            <ArrowDownTrayIcon className="h-4 w-4" />
                            Export
                        </button>
                        {hasPermission('FINANCE_TRANSACTION_CREATE') && (
                            <div style={{ position: 'relative' }}>
                                <button
                                    onClick={() => setShowMenu(!showMenu)}
                                    className="btn-primary flex items-center gap-2"
                                >
                                    <PlusIcon className="h-4 w-4" />
                                    Record
                                </button>
                                {showMenu && (
                                    <>
                                        <div
                                            style={{
                                                position: 'fixed', inset: 0, zIndex: 10
                                            }}
                                            onClick={() => setShowMenu(false)}
                                        />
                                        <div style={{
                                            position: 'absolute', right: 0, top: '100%',
                                            marginTop: '4px', backgroundColor: 'white',
                                            borderRadius: '8px', boxShadow:
                                                '0 4px 20px rgba(0,0,0,0.12)',
                                            border: '1px solid #e5e7eb',
                                            zIndex: 20, minWidth: '160px',
                                            overflow: 'hidden',
                                        }}>
                                            <button
                                                onClick={() => {
                                                    setShowContrib(true);
                                                    setShowMenu(false);
                                                }}
                                                style={{
                                                    display: 'block', width: '100%',
                                                    padding: '10px 16px', textAlign: 'left',
                                                    fontSize: '13px', color: '#374151',
                                                    background: 'none', border: 'none',
                                                    cursor: 'pointer',
                                                }}
                                                onMouseEnter={e => {
                                                    e.currentTarget.style.backgroundColor = '#f9fafb';
                                                }}
                                                onMouseLeave={e => {
                                                    e.currentTarget.style.backgroundColor = 'transparent';
                                                }}
                                            >
                                                Record Contribution
                                            </button>
                                            <button
                                                onClick={() => {
                                                    setShowExpense(true);
                                                    setShowMenu(false);
                                                }}
                                                style={{
                                                    display: 'block', width: '100%',
                                                    padding: '10px 16px', textAlign: 'left',
                                                    fontSize: '13px', color: '#374151',
                                                    background: 'none', border: 'none',
                                                    cursor: 'pointer',
                                                }}
                                                onMouseEnter={e => {
                                                    e.currentTarget.style.backgroundColor = '#f9fafb';
                                                }}
                                                onMouseLeave={e => {
                                                    e.currentTarget.style.backgroundColor = 'transparent';
                                                }}
                                            >
                                                Record Expense
                                            </button>
                                        </div>
                                    </>
                                )}
                            </div>
                        )}
                    </div>
                }
            />

            {error && (
                <div className="mb-4">
                    <ErrorMessage message={error} onDismiss={() => setError(null)} />
                </div>
            )}

            {/* Filters */}
            <div className="card mb-6">
                <div className="flex items-center gap-2 mb-3">
                    <FunnelIcon className="h-4 w-4 text-gray-400" />
                    <span className="text-sm font-medium text-gray-600">Filters</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                    <select className="input" value={filters.account_id}
                        onChange={e => setFilters(p => ({
                            ...p, account_id: e.target.value }))}>
                        <option value="">All Accounts</option>
                        {accounts.map(a => (
                            <option key={a.id} value={a.id}>{a.name}</option>
                        ))}
                    </select>
                    <select className="input" value={filters.inflow_type}
                        onChange={e => setFilters(p => ({
                            ...p, inflow_type: e.target.value }))}>
                        <option value="">All Types</option>
                        <option value="CONTRIBUTION">Contribution</option>
                        <option value="EXPENSE">Expense</option>
                        <option value="TRANSFER_IN">Transfer In</option>
                        <option value="TRANSFER_OUT">Transfer Out</option>
                        <option value="GRANT">Grant</option>
                        <option value="LOAN_RECEIVED">Loan Received</option>
                        <option value="INVESTMENT_RETURN">Investment Return</option>
                    </select>
                    <input type="date" className="input" value={filters.from_date}
                        onChange={e => setFilters(p => ({
                            ...p, from_date: e.target.value }))} />
                    <input type="date" className="input" value={filters.to_date}
                        onChange={e => setFilters(p => ({
                            ...p, to_date: e.target.value }))} />
                </div>
                <div className="flex justify-end mt-3">
                    <button
                        onClick={() => {
                            setFilters({ account_id: '', inflow_type: '',
                                from_date: '', to_date: '' });
                            setPage(1);
                        }}
                        className="text-sm text-gray-500 hover:text-gray-700"
                    >
                        Clear filters
                    </button>
                </div>
            </div>

            <DataTable
                columns={columns}
                data={transactions}
                loading={loading}
                emptyMessage="No transactions found"
                searchable
                searchPlaceholder="Search transactions..."
                pagination={pagination}
                onPageChange={setPage}
            />

            <ContributionModal
                isOpen={showContrib}
                onClose={() => setShowContrib(false)}
                onSuccess={loadTransactions}
                categories={categories}
                shareholders={shareholders}
                accounts={accounts}
            />
            
            <ExpenseModal
                isOpen={showExpense}
                onClose={() => setShowExpense(false)}
                onSuccess={loadTransactions}
                categories={categories}
                accounts={accounts}
            />

            <DocumentPreviewModal preview={preview} onClose={() => setPreview(null)} />

            <ReverseTransactionModal
                transaction={reversing}
                onClose={() => setReversing(null)}
                onSuccess={loadTransactions}
            />
        </div>
    );
};

export default TransactionsPage;