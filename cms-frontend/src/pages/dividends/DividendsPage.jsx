// ============================================================
// DIVIDENDS & AUTHORITY PAYMENTS PAGE
// Two tabs:
//   1. Dividends — declare and pay shareholder dividends
//   2. Authority Payments — URA, URSB, Banks, NSSF
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { dividendsAPI, accountsAPI, categoriesAPI } from '../../api/endpoints';
import { formatDate, getErrorMessage } from '../../utils/helpers';
import PageHeader from '../../components/common/PageHeader';
import DataTable from '../../components/common/DataTable';
import ErrorMessage from '../../components/common/ErrorMessage';
import StatusBadge from '../../components/common/StatusBadge';
import { useAuth } from '../../contexts/AuthContext';
import { PlusIcon, CheckIcon, PencilIcon } from '@heroicons/react/24/outline';

const BLANK_DIVIDEND_FORM = {
    account_id: '', category_id: '', total_amount: '',
    period_label: '', declaration_date: '', notes: '',
};

// ============================================================
// DECLARE / EDIT DIVIDEND MODAL
// ============================================================
const DeclareDividendModal = ({ isOpen, onClose, onSuccess, accounts, categories, editingRecord }) => {
    const [form, setForm] = useState(BLANK_DIVIDEND_FORM);
    const [loading, setLoading] = useState(false);
    const [error,   setError]   = useState(null);
    const isEdit = !!editingRecord;

    useEffect(() => {
        if (editingRecord) {
            setForm({
                account_id: editingRecord.account_id || '',
                category_id: editingRecord.category_id || '',
                total_amount: editingRecord.total_amount || '',
                period_label: editingRecord.period_label || '',
                declaration_date: editingRecord.declaration_date ? editingRecord.declaration_date.slice(0, 10) : '',
                notes: editingRecord.notes || '',
            });
        } else {
            setForm(BLANK_DIVIDEND_FORM);
        }
    }, [editingRecord, isOpen]);

    if (!isOpen) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            const payload = { ...form, total_amount: parseFloat(form.total_amount) };
            if (isEdit) {
                await dividendsAPI.update(editingRecord.id, payload);
            } else {
                await dividendsAPI.declare(payload);
            }
            onSuccess();
            onClose();
            setForm(BLANK_DIVIDEND_FORM);
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
                <div className="relative bg-white rounded-xl shadow-xl max-w-lg w-full p-6">
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">
                        {isEdit ? 'Edit Dividend' : 'Declare Dividend'}
                    </h2>
                    <p className="text-sm text-gray-400 mb-4">
                        The total amount is split automatically based on each
                        shareholder's registered percentage. Once approved, each
                        share is credited directly to that shareholder's own
                        Savings balance.
                    </p>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="label">Source Account *</label>
                                <select className="input" value={form.account_id}
                                    onChange={e => setForm(p => ({ ...p, account_id: e.target.value }))}
                                    required>
                                    <option value="">Select account...</option>
                                    {accounts.map(a => (
                                        <option key={a.id} value={a.id}>{a.name}</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className="label">Category *</label>
                                <select className="input" value={form.category_id}
                                    onChange={e => setForm(p => ({ ...p, category_id: e.target.value }))}
                                    required>
                                    <option value="">Select category...</option>
                                    {financeCategories.map(c => (
                                        <option key={c.id} value={c.id}>
                                            {c.full_path || c.name}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        </div>
                        <div>
                            <label className="label">Total Dividend Amount *</label>
                            <input type="number" className="input" value={form.total_amount}
                                onChange={e => setForm(p => ({ ...p, total_amount: e.target.value }))}
                                min="0.01" step="0.01" required />
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="label">Period Label</label>
                                <input type="text" className="input" value={form.period_label}
                                    onChange={e => setForm(p => ({ ...p, period_label: e.target.value }))}
                                    placeholder="e.g. Q2 2026" />
                            </div>
                            <div>
                                <label className="label">Declaration Date *</label>
                                <input type="date" className="input" value={form.declaration_date}
                                    max={new Date().toISOString().slice(0, 10)}
                                    onChange={e => setForm(p => ({ ...p, declaration_date: e.target.value }))}
                                    required />
                            </div>
                        </div>
                        <div>
                            <label className="label">Notes</label>
                            <textarea className="input" rows={2} value={form.notes}
                                onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} />
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose} className="btn-secondary">
                                Cancel
                            </button>
                            <button type="submit" disabled={loading} className="btn-primary">
                                {loading ? 'Saving...' : (isEdit ? 'Save Changes' : 'Declare Dividend')}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// APPROVE DIVIDEND MODAL
// Approving now credits every shareholder's own Savings balance
// with their share (Section 4.12) — this replaced a single lump
// company-account debit with no per-shareholder crediting. If the
// dividend's currency differs from the single Savings account's
// currency, a Treasurer must enter the actual conversion rate here;
// this system's stored exchange rates are display-only and are
// deliberately never used for real money movements (same rule
// cross-currency Transfers already follow), so there is no
// auto-filled rate to fall back on.
// ============================================================
const ApproveDividendModal = ({ isOpen, dividend, onClose, onSuccess }) => {
    const [rate, setRate] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => { setRate(''); setError(null); }, [dividend, isOpen]);

    if (!isOpen || !dividend) return null;

    const needsRate = !!dividend.needs_exchange_rate;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            // Always send a real object, even when there's nothing to fill
            // in — axios sends no request body at all for `undefined`, which
            // means no Content-Type header goes out either, so Express's
            // JSON body parser never runs and req.body arrives as
            // `undefined` server-side instead of `{}` (v1.26.2 bug fix).
            await dividendsAPI.approve(dividend.id, needsRate ? { exchange_rate: parseFloat(rate) } : {});
            onSuccess();
            onClose();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    const converted = needsRate && rate
        ? (parseFloat(dividend.total_amount) * parseFloat(rate)).toLocaleString('en-US', { maximumFractionDigits: 2 })
        : null;

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            <div className="fixed inset-0 bg-black bg-opacity-40" onClick={onClose} />
            <div className="flex min-h-full items-center justify-center p-4">
                <div className="relative bg-white rounded-xl shadow-xl max-w-md w-full p-6">
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">Approve &amp; Pay Dividend</h2>
                    <p className="text-sm text-gray-400 mb-4">
                        {dividend.reference_code} — {dividend.shareholder_count} shareholder{dividend.shareholder_count === 1 ? '' : 's'}.
                        Each share will be credited to that member's own Savings balance.
                    </p>
                    {error && <div className="mb-4"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}

                    <div className="bg-gray-50 rounded-lg p-3 mb-4 text-sm">
                        <div className="flex justify-between">
                            <span className="text-gray-500">Total declared</span>
                            <span className="font-bold text-gray-900">
                                {dividend.currency_code} {parseFloat(dividend.total_amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                            </span>
                        </div>
                        {needsRate ? (
                            <div className="flex justify-between mt-1">
                                <span className="text-gray-500">Will credit (Savings, {dividend.savings_currency_code})</span>
                                <span className="font-bold text-primary-700">{converted ?? '—'}</span>
                            </div>
                        ) : (
                            <div className="flex justify-between mt-1">
                                <span className="text-gray-500">Savings currency</span>
                                <span className="font-medium text-gray-700">{dividend.currency_code} (matches)</span>
                            </div>
                        )}
                    </div>

                    <form onSubmit={handleSubmit} className="space-y-4">
                        {needsRate && (
                            <div>
                                <label className="label">
                                    Exchange rate — 1 {dividend.currency_code} = ? {dividend.savings_currency_code} *
                                </label>
                                <input type="number" className="input" min="0.00000001" step="any"
                                    value={rate} onChange={e => setRate(e.target.value)} required
                                    placeholder="e.g. 3800" />
                                <p className="text-xs text-gray-400 mt-1">
                                    This dividend was declared in {dividend.currency_code}, but the Savings account
                                    holds {dividend.savings_currency_code}. Enter today's actual rate — the system
                                    doesn't apply one automatically.
                                </p>
                            </div>
                        )}
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading} className="btn-primary">
                                {loading ? 'Approving...' : 'Approve & Credit Savings'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// DIVIDEND DETAIL MODAL
// ============================================================
const DividendDetailModal = ({ isOpen, dividend, onClose }) => {
    if (!isOpen || !dividend) return null;

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            <div className="fixed inset-0 bg-black bg-opacity-40" onClick={onClose} />
            <div className="flex min-h-full items-center justify-center p-4">
                <div className="relative bg-white rounded-xl shadow-xl max-w-lg w-full p-6">
                    <div className="flex justify-between items-start mb-4">
                        <div>
                            <h2 className="text-lg font-semibold text-gray-900">
                                Dividend Distribution
                            </h2>
                            <p className="text-sm text-gray-400 font-mono">
                                {dividend.reference_code}
                            </p>
                        </div>
                        <StatusBadge status={dividend.status} />
                    </div>

                    <div className="bg-gray-50 rounded-lg p-3 mb-4">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
                            <div>
                                <p className="text-gray-400 text-xs">Total Amount</p>
                                <p className="font-bold text-gray-900">
                                    {dividend.currency_code}{' '}
                                    {parseFloat(dividend.total_amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                                </p>
                            </div>
                            <div>
                                <p className="text-gray-400 text-xs">Period</p>
                                <p className="font-medium text-gray-700">
                                    {dividend.period_label || '—'}
                                </p>
                            </div>
                            <div>
                                <p className="text-gray-400 text-xs">Declared</p>
                                <p className="text-gray-700">
                                    {formatDate(dividend.declaration_date)}
                                </p>
                            </div>
                            <div>
                                <p className="text-gray-400 text-xs">Account</p>
                                <p className="text-gray-700">{dividend.account_name}</p>
                            </div>
                        </div>
                    </div>

                    <h3 className="text-sm font-semibold text-gray-700 mb-3">
                        Shareholder Distributions
                    </h3>
                    <div className="space-y-2 max-h-64 overflow-y-auto">
                        {(dividend.distributions || []).map((d, i) => (
                            <div key={i} className="flex items-center justify-between
                                py-2 border-b border-gray-100 last:border-0">
                                <div>
                                    <p className="text-sm font-medium text-gray-900">
                                        {d.member_name}
                                    </p>
                                    <p className="text-xs text-gray-400">
                                        {d.percentage_at_time}% shareholding
                                    </p>
                                </div>
                                <div className="text-right">
                                    <p className="text-sm font-bold text-primary-700">
                                        {dividend.currency_code}{' '}
                                        {parseFloat(d.amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                                    </p>
                                    {d.status === 'PAID' && d.credited_amount != null && (
                                        <p className="text-xs text-green-600">
                                            Credited: {dividend.savings_currency_code || ''}{' '}
                                            {parseFloat(d.credited_amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                                        </p>
                                    )}
                                    <StatusBadge status={d.status} />
                                </div>
                            </div>
                        ))}
                    </div>

                    <div className="flex justify-end mt-4">
                        <button onClick={onClose} className="btn-secondary">Close</button>
                    </div>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// AUTHORITY PAYMENT MODAL
// ============================================================
const AuthorityPaymentModal = ({ isOpen, onClose, onSuccess, accounts, categories }) => {
    const [form, setForm] = useState({
        account_id: '', category_id: '', authority_type: 'URA',
        authority_name: '', payment_type: '', authority_ref: '',
        amount: '', payment_date: '', notes: '',
    });
    const [loading, setLoading] = useState(false);
    const [error,   setError]   = useState(null);

    if (!isOpen) return null;

    const authorityNames = {
        URA:   ['URA', 'Uganda Revenue Authority'],
        URSB:  ['URSB', 'Uganda Registration Services Bureau'],
        BANK:  ['Stanbic Bank', 'Centenary Bank', 'DFCU Bank', 'Other Bank'],
        NSSF:  ['NSSF', 'National Social Security Fund'],
        OTHER: ['Other Authority'],
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await dividendsAPI.recordAuthorityPayment({
                ...form,
                amount: parseFloat(form.amount),
            });
            onSuccess();
            onClose();
            setForm({ account_id: '', category_id: '', authority_type: 'URA',
                authority_name: '', payment_type: '', authority_ref: '',
                amount: '', payment_date: '', notes: '' });
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
                <div className="relative bg-white rounded-xl shadow-xl max-w-lg w-full p-6">
                    <h2 className="text-lg font-semibold text-gray-900 mb-4">
                        Record Authority Payment
                    </h2>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="label">Account *</label>
                                <select className="input" value={form.account_id}
                                    onChange={e => setForm(p => ({ ...p, account_id: e.target.value }))}
                                    required>
                                    <option value="">Select account...</option>
                                    {accounts.map(a => (
                                        <option key={a.id} value={a.id}>{a.name}</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className="label">Category *</label>
                                <select className="input" value={form.category_id}
                                    onChange={e => setForm(p => ({ ...p, category_id: e.target.value }))}
                                    required>
                                    <option value="">Select category...</option>
                                    {financeCategories.map(c => (
                                        <option key={c.id} value={c.id}>
                                            {c.full_path || c.name}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="label">Authority Type *</label>
                                <select className="input" value={form.authority_type}
                                    onChange={e => {
                                        setForm(p => ({
                                            ...p,
                                            authority_type: e.target.value,
                                            authority_name: '',
                                        }));
                                    }}>
                                    {['URA', 'URSB', 'BANK', 'NSSF', 'OTHER'].map(t => (
                                        <option key={t} value={t}>{t}</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className="label">Authority Name *</label>
                                <select className="input" value={form.authority_name}
                                    onChange={e => setForm(p => ({ ...p, authority_name: e.target.value }))}
                                    required>
                                    <option value="">Select...</option>
                                    {(authorityNames[form.authority_type] || []).map(n => (
                                        <option key={n} value={n}>{n}</option>
                                    ))}
                                </select>
                            </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="label">Payment Type</label>
                                <input type="text" className="input" value={form.payment_type}
                                    onChange={e => setForm(p => ({ ...p, payment_type: e.target.value }))}
                                    placeholder="e.g. PAYE, VAT, Stamp Duty" />
                            </div>
                            <div>
                                <label className="label">Authority Reference</label>
                                <input type="text" className="input" value={form.authority_ref}
                                    onChange={e => setForm(p => ({ ...p, authority_ref: e.target.value }))}
                                    placeholder="e.g. TIN, PRN number" />
                            </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="label">Amount *</label>
                                <input type="number" className="input" value={form.amount}
                                    onChange={e => setForm(p => ({ ...p, amount: e.target.value }))}
                                    min="0.01" step="0.01" required />
                            </div>
                            <div>
                                <label className="label">Payment Date *</label>
                                <input type="date" className="input" value={form.payment_date}
                                    max={new Date().toISOString().slice(0, 10)}
                                    onChange={e => setForm(p => ({ ...p, payment_date: e.target.value }))}
                                    required />
                            </div>
                        </div>

                        <div>
                            <label className="label">Notes</label>
                            <textarea className="input" rows={2} value={form.notes}
                                onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} />
                        </div>

                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose} className="btn-secondary">
                                Cancel
                            </button>
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
// MAIN DIVIDENDS PAGE
// ============================================================
const DividendsPage = () => {
    const { hasPermission, hasRole, user } = useAuth();
    const [activeTab,     setActiveTab]     = useState('dividends');
    const [dividends,     setDividends]     = useState([]);
    const [authPayments,  setAuthPayments]  = useState([]);
    const [accounts,      setAccounts]      = useState([]);
    const [categories,    setCategories]    = useState([]);
    const [pagination1,   setPagination1]   = useState(null);
    const [pagination2,   setPagination2]   = useState(null);
    const [loading1,      setLoading1]      = useState(true);
    const [loading2,      setLoading2]      = useState(true);
    const [error,         setError]         = useState(null);
    const [page1,         setPage1]         = useState(1);
    const [page2,         setPage2]         = useState(1);
    const [showDeclare,   setShowDeclare]   = useState(false);
    const [showAuthPay,   setShowAuthPay]   = useState(false);
    const [viewDividend,  setViewDividend]  = useState(null);
    const [editingRecord, setEditingRecord] = useState(null);
    const [approvingDividend, setApprovingDividend] = useState(null);

    const isTreasurer = hasRole(['Treasurer', 'Admin']);

    const canEdit = (row) =>
        row.status === 'PENDING' &&
        (row.created_by === user?.id || isTreasurer);

    const openEditModal = (row) => {
        setEditingRecord(row);
        setShowDeclare(true);
    };

    const closeDeclareModal = () => {
        setShowDeclare(false);
        setEditingRecord(null);
    };

    const loadDividends = useCallback(async () => {
        try {
            setLoading1(true);
            const res = await dividendsAPI.getAll({ page: page1, limit: 20 });
            setDividends(res.data.data);
            setPagination1(res.data.meta?.pagination);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading1(false);
        }
    }, [page1]);

    const loadAuthPayments = useCallback(async () => {
        try {
            setLoading2(true);
            const res = await dividendsAPI.getAllAuthorityPayments({ page: page2, limit: 20 });
            setAuthPayments(res.data.data);
            setPagination2(res.data.meta?.pagination);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading2(false);
        }
    }, [page2]);

    useEffect(() => {
        loadDividends();
        loadAuthPayments();
        accountsAPI.getAll().then(r => setAccounts(r.data.data)).catch(() => {});
        categoriesAPI.getAll({ flat: true }).then(r => setCategories(r.data.data)).catch(() => {});
    }, [loadDividends, loadAuthPayments]);

    const handleViewDividend = async (id) => {
        try {
            const res = await dividendsAPI.getById(id);
            setViewDividend(res.data.data);
        } catch (err) {
            setError(getErrorMessage(err));
        }
    };

    const dividendColumns = [
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
            header: 'Period',
            render: row => (
                <div>
                    <p className="text-sm font-medium text-gray-900">
                        {row.period_label || '—'}
                    </p>
                    <p className="text-xs text-gray-400">
                        Declared: {formatDate(row.declaration_date)}
                    </p>
                </div>
            ),
        },
        {
            header: 'Total Amount',
            render: row => (
                <div>
                    <span className="text-sm font-bold text-gray-900">
                        {row.currency_code}{' '}
                        {parseFloat(row.total_amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                    </span>
                    {row.status === 'PENDING' && row.needs_exchange_rate && (
                        <p className="text-[11px] text-amber-600 mt-0.5">Rate needed to credit savings</p>
                    )}
                </div>
            ),
        },
        {
            header: 'Shareholders',
            render: row => (
                <span className="text-sm text-gray-600">
                    {row.shareholder_count}
                </span>
            ),
        },
        {
            header: 'Account',
            render: row => (
                <span className="text-xs text-gray-500">{row.account_name}</span>
            ),
        },
        {
            header: 'Status',
            render: row => <StatusBadge status={row.status} />,
        },
        {
            header: 'Actions',
            render: row => (
                <div className="flex gap-2">
                    <button
                        onClick={() => handleViewDividend(row.id)}
                        className="text-xs text-primary-600 hover:text-primary-700
                            font-medium px-2 py-1 rounded border border-primary-200
                            hover:bg-primary-50 transition-colors"
                    >
                        View
                    </button>
                    {canEdit(row) && (
                        <button
                            onClick={() => openEditModal(row)}
                            className="p-1.5 rounded-lg bg-blue-50 text-blue-600
                                hover:bg-blue-100 transition-colors"
                            title="Edit"
                        >
                            <PencilIcon className="h-4 w-4" />
                        </button>
                    )}
                    {row.status === 'PENDING' && isTreasurer && (
                        <button
                            onClick={() => setApprovingDividend(row)}
                            className="p-1.5 rounded-lg bg-green-50 text-green-600
                                hover:bg-green-100 transition-colors"
                            title="Approve and Pay"
                        >
                            <CheckIcon className="h-4 w-4" />
                        </button>
                    )}
                </div>
            ),
        },
    ];

    const authPaymentColumns = [
        {
            header: 'Reference',
            render: row => (
                <span className="font-mono text-xs font-medium text-primary-700">
                    {row.reference_code}
                </span>
            ),
        },
        {
            header: 'Authority',
            render: row => (
                <div>
                    <p className="text-sm font-medium text-gray-900">
                        {row.authority_name}
                    </p>
                    <p className="text-xs text-gray-400">
                        {row.authority_type}
                        {row.payment_type && ` • ${row.payment_type}`}
                    </p>
                </div>
            ),
        },
        {
            header: 'Reference No.',
            render: row => (
                <span className="text-sm text-gray-600">
                    {row.authority_ref || '—'}
                </span>
            ),
        },
        {
            header: 'Amount',
            render: row => (
                <span className="text-sm font-bold text-red-600">
                    -{row.currency_code}{' '}
                    {parseFloat(row.amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                </span>
            ),
        },
        {
            header: 'Account',
            render: row => (
                <span className="text-xs text-gray-500">{row.account_name}</span>
            ),
        },
        {
            header: 'Date',
            render: row => (
                <span className="text-sm text-gray-500">
                    {formatDate(row.payment_date)}
                </span>
            ),
        },
        {
            header: 'Recorded By',
            render: row => (
                <span className="text-xs text-gray-500">
                    {row.created_by_name}
                </span>
            ),
        },
    ];

    return (
        <div>
            <PageHeader
                title="Dividends & Authority Payments"
                subtitle="Shareholder dividend distributions and regulatory payments"
                actions={
                    <div className="flex gap-2">
                        {activeTab === 'dividends' && isTreasurer && (
                            <button
                                onClick={() => { setEditingRecord(null); setShowDeclare(true); }}
                                className="btn-primary flex items-center gap-2"
                            >
                                <PlusIcon className="h-4 w-4" />
                                Declare Dividend
                            </button>
                        )}
                        {activeTab === 'authority' &&
                         hasPermission('FINANCE_TRANSACTION_CREATE') && (
                            <button
                                onClick={() => setShowAuthPay(true)}
                                className="btn-primary flex items-center gap-2"
                            >
                                <PlusIcon className="h-4 w-4" />
                                Record Payment
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

            {/* Tabs */}
            <div className="flex gap-2 mb-6">
                <button
                    onClick={() => setActiveTab('dividends')}
                    className={`px-4 py-2 rounded-lg text-sm font-medium
                        transition-colors ${activeTab === 'dividends'
                            ? 'bg-primary-700 text-white'
                            : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                        }`}
                >
                    Dividends
                    <span className="ml-2 text-xs opacity-70">
                        ({dividends.length})
                    </span>
                </button>
                <button
                    onClick={() => setActiveTab('authority')}
                    className={`px-4 py-2 rounded-lg text-sm font-medium
                        transition-colors ${activeTab === 'authority'
                            ? 'bg-primary-700 text-white'
                            : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                        }`}
                >
                    Authority Payments
                    <span className="ml-2 text-xs opacity-70">
                        ({authPayments.length})
                    </span>
                </button>
            </div>

            {/* Dividends Tab */}
            {activeTab === 'dividends' && (
                <DataTable
                    columns={dividendColumns}
                    data={dividends}
                    loading={loading1}
                    emptyMessage="No dividends declared yet"
                    searchable
                    searchPlaceholder="Search dividends..."
                    pagination={pagination1}
                    onPageChange={setPage1}
                />
            )}

            {/* Authority Payments Tab */}
            {activeTab === 'authority' && (
                <DataTable
                    columns={authPaymentColumns}
                    data={authPayments}
                    loading={loading2}
                    emptyMessage="No authority payments recorded yet"
                    searchable
                    searchPlaceholder="Search authority payments..."
                    pagination={pagination2}
                    onPageChange={setPage2}
                />
            )}

            {/* Modals */}
            <DeclareDividendModal
                isOpen={showDeclare}
                onClose={closeDeclareModal}
                onSuccess={loadDividends}
                accounts={accounts}
                categories={categories}
                editingRecord={editingRecord}
            />
            <AuthorityPaymentModal
                isOpen={showAuthPay}
                onClose={() => setShowAuthPay(false)}
                onSuccess={loadAuthPayments}
                accounts={accounts}
                categories={categories}
            />
            <DividendDetailModal
                isOpen={!!viewDividend}
                dividend={viewDividend}
                onClose={() => setViewDividend(null)}
            />
            <ApproveDividendModal
                isOpen={!!approvingDividend}
                dividend={approvingDividend}
                onClose={() => setApprovingDividend(null)}
                onSuccess={loadDividends}
            />
        </div>
    );
};

export default DividendsPage;