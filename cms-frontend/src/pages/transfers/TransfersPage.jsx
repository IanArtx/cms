// ============================================================
// TRANSFERS PAGE
// Shows all transfers between accounts with approval status.
// Allows initiating new transfers and approving/rejecting.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { transfersAPI, accountsAPI, categoriesAPI } from '../../api/endpoints';
import { formatCurrency, formatDate, getErrorMessage } from '../../utils/helpers';
import PageHeader from '../../components/common/PageHeader';
import DataTable from '../../components/common/DataTable';
import ErrorMessage from '../../components/common/ErrorMessage';
import StatusBadge from '../../components/common/StatusBadge';
import { useAuth } from '../../contexts/AuthContext';
import { useChartTheme } from '../../hooks/useChartTheme';
import { PlusIcon, CheckIcon, XMarkIcon, ArrowDownTrayIcon, PencilIcon, FunnelIcon } from '@heroicons/react/24/outline';
import { transferTemplate, printDocument, downloadBlob } from '../../utils/exportUtils';
import DocumentPreviewModal from '../../components/common/DocumentPreviewModal';
import {
    BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
    ResponsiveContainer,
} from 'recharts';

// Reads an axios error whose response body is a Blob (because the
// request used responseType: 'blob') and tries to recover the JSON
// error message the backend actually sent, instead of showing a
// generic failure. Same pattern as DocumentsPage/TransactionsPage.
const getBlobErrorMessage = async (err) => {
    const blob = err?.response?.data;
    if (blob instanceof Blob && blob.type === 'application/json') {
        try {
            const text = await blob.text();
            const parsed = JSON.parse(text);
            if (parsed?.message) return parsed.message;
        } catch {
            // fall through to generic message below
        }
    }
    return getErrorMessage(err);
};

// ============================================================
// TRANSFER ANALYTICS CHARTS (v1.50.0)
// One card per currency actually being sent — kept strictly
// separate (never converted/summed) — showing monthly transfer
// volume plus the most/least active quarter (fiscal, falling back
// to calendar), the largest/smallest completed transfer, and total
// bank charges. Only POSTED transfers count (see backend comment).
// A second row plots the exchange rate actually used over time, one
// line per currency pair. Honors whatever filters are applied.
// ============================================================
const QuarterCallout = ({ label, quarter, tone }) => (
    <div className={`rounded-lg p-3 ${tone === 'good' ? 'bg-green-50 dark:bg-green-950' : 'bg-red-50 dark:bg-red-950'}`}>
        <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
        {quarter ? (
            <>
                <p className="text-sm font-bold text-gray-900 dark:text-gray-100 mt-0.5">{quarter.label}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                    {parseFloat(quarter.amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                </p>
            </>
        ) : (
            <p className="text-xs text-gray-400 mt-0.5">Not enough data</p>
        )}
    </div>
);

const TransferAnalyticsCharts = ({ analytics, loading }) => {
    const theme = useChartTheme();

    if (loading) return null;
    const volumeByCurrency = analytics?.volume_by_currency || {};
    const rateByPair = analytics?.rate_by_pair || {};
    const largestSmallest = analytics?.largest_smallest_by_currency || {};
    const chargesByCurrency = analytics?.total_charges_by_currency || {};
    const currencies = Object.keys(volumeByCurrency);
    const pairs = Object.keys(rateByPair);
    if (currencies.length === 0 && pairs.length === 0) return null;

    return (
        <div className="mb-6">
            <h3 className="section-title mb-3">Transfer Volume & Charges</h3>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {currencies.map(currency => {
                    const c = volumeByCurrency[currency];
                    const ls = largestSmallest[currency];
                    const charges = chargesByCurrency[currency];
                    return (
                        <div className="card" key={currency}>
                            <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-3">
                                {currency}
                            </h4>
                            <ResponsiveContainer width="100%" height={200}>
                                <BarChart data={c.monthly}>
                                    <CartesianGrid {...theme.gridProps} />
                                    <XAxis dataKey="period" tick={{ fontSize: 11, ...theme.axisTick }} tickLine={false} />
                                    <YAxis tick={{ fontSize: 11, ...theme.axisTick }} tickLine={false} axisLine={false}
                                        tickFormatter={v => v.toLocaleString('en-US', { maximumFractionDigits: 0 })} />
                                    <Tooltip {...theme.tooltipProps}
                                        formatter={(v) => [`${currency} ${parseFloat(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}`, 'Volume']} />
                                    <Bar dataKey="expense" name="Volume" fill={theme.primary} radius={[4, 4, 0, 0]} />
                                </BarChart>
                            </ResponsiveContainer>
                            <div className="grid grid-cols-2 gap-2 mt-3">
                                <QuarterCallout label="Most Active Quarter" quarter={c.most_expense_quarter} tone="good" />
                                <QuarterCallout label="Least Active Quarter" quarter={c.least_expense_quarter} tone="bad" />
                            </div>
                            <div className="mt-3 text-xs text-gray-500 dark:text-gray-400 space-y-1">
                                {ls?.largest && (
                                    <p>
                                        Largest transfer: <span className="font-medium text-gray-700 dark:text-gray-200">
                                            {currency} {ls.largest.amount.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                                        </span> — {ls.largest.reference_code} ({formatDate(ls.largest.date)})
                                    </p>
                                )}
                                {ls?.smallest && (
                                    <p>
                                        Smallest transfer: <span className="font-medium text-gray-700 dark:text-gray-200">
                                            {currency} {ls.smallest.amount.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                                        </span> — {ls.smallest.reference_code} ({formatDate(ls.smallest.date)})
                                    </p>
                                )}
                                {!!charges && (
                                    <p>
                                        Total bank charges: <span className="font-medium text-gray-700 dark:text-gray-200">
                                            {currency} {charges.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                                        </span>
                                    </p>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>

            {pairs.length > 0 && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
                    {pairs.map((pair, idx) => (
                        <div className="card" key={pair}>
                            <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-3">
                                Exchange Rate — {pair}
                            </h4>
                            <ResponsiveContainer width="100%" height={180}>
                                <LineChart data={rateByPair[pair]}>
                                    <CartesianGrid {...theme.gridProps} />
                                    <XAxis dataKey="date" tick={{ fontSize: 10, ...theme.axisTick }} tickLine={false} />
                                    <YAxis tick={{ fontSize: 11, ...theme.axisTick }} tickLine={false} axisLine={false}
                                        domain={['auto', 'auto']}
                                        tickFormatter={v => v.toLocaleString('en-US', { maximumFractionDigits: 4 })} />
                                    <Tooltip {...theme.tooltipProps}
                                        formatter={(v) => [parseFloat(v).toLocaleString('en-US', { maximumFractionDigits: 4 }), 'Rate']} />
                                    <Line type="monotone" dataKey="rate" stroke={theme.series[idx % theme.series.length]}
                                        strokeWidth={2} dot={false} />
                                </LineChart>
                            </ResponsiveContainer>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

const BLANK_TRANSFER_FORM = {
    from_account_id: '', to_account_id: '', amount_sent: '',
    exchange_rate: '', category_id: '', description: '', value_date: '',
    sending_bank_charge: '', receiving_bank_charge: ''
};

// ============================================================
// INITIATE / EDIT TRANSFER MODAL
// ============================================================
const TransferModal = ({ isOpen, onClose, onSuccess, accounts, categories, editingRecord }) => {
    const [form, setForm] = useState(BLANK_TRANSFER_FORM);
    const [loading, setLoading] = useState(false);
    const [error,   setError]   = useState(null);
    const isEdit = !!editingRecord;

    useEffect(() => {
        if (editingRecord) {
            setForm({
                from_account_id: editingRecord.from_account_id || '',
                to_account_id: editingRecord.to_account_id || '',
                amount_sent: editingRecord.amount_sent || '',
                exchange_rate: editingRecord.exchange_rate || '',
                category_id: editingRecord.category_id || '',
                description: editingRecord.description || '',
                value_date: editingRecord.value_date ? editingRecord.value_date.slice(0, 10) : '',
                sending_bank_charge: editingRecord.sending_bank_charge || '',
                receiving_bank_charge: editingRecord.receiving_bank_charge || '',
            });
        } else {
            setForm(BLANK_TRANSFER_FORM);
        }
    }, [editingRecord, isOpen]);

    if (!isOpen) return null;

    const fromAccount = accounts.find(a => a.id === parseInt(form.from_account_id));
    const toAccount   = accounts.find(a => a.id === parseInt(form.to_account_id));
    // Two accounts sharing the same currency never have an exchange rate
    // between them — the backend locks it to 1 regardless of what's sent.
    // Bank charges still apply independently.
    const sameCurrency = !!(fromAccount && toAccount && fromAccount.currency_code === toAccount.currency_code);
    const effectiveRate = sameCurrency ? 1 : form.exchange_rate;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            const payload = { ...form, exchange_rate: sameCurrency ? undefined : form.exchange_rate };
            if (isEdit) {
                const { from_account_id, to_account_id, ...editable } = payload;
                await transfersAPI.update(editingRecord.id, editable);
            } else {
                await transfersAPI.initiate(payload);
            }
            onSuccess();
            onClose();
            setForm(BLANK_TRANSFER_FORM);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    const amountReceived = form.amount_sent && effectiveRate
        ? (parseFloat(form.amount_sent) * parseFloat(effectiveRate)).toLocaleString('en-US', { maximumFractionDigits: 2 })
        : null;

    const financeCategories = categories.filter(c => c.module === 'FINANCE');

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            <div className="fixed inset-0 bg-black bg-opacity-40" onClick={onClose} />
            <div className="flex min-h-full items-center justify-center p-4">
                <div className="relative bg-white rounded-xl shadow-xl max-w-lg w-full p-6">
                    <h2 className="text-lg font-semibold text-gray-900 mb-4">
                        {isEdit ? 'Edit Transfer' : 'Initiate Transfer'}
                    </h2>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="label">From Account *</label>
                                <select className="input" value={form.from_account_id}
                                    disabled={isEdit}
                                    onChange={e => setForm(p => ({
                                        ...p, from_account_id: e.target.value }))}
                                    required>
                                    <option value="">Select...</option>
                                    {accounts.map(a => (
                                        <option key={a.id} value={a.id}>
                                            {a.name}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className="label">To Account *</label>
                                <select className="input" value={form.to_account_id}
                                    disabled={isEdit}
                                    onChange={e => setForm(p => ({
                                        ...p, to_account_id: e.target.value }))}
                                    required>
                                    <option value="">Select...</option>
                                    {accounts.filter(a =>
                                        a.id !== parseInt(form.from_account_id)
                                    ).map(a => (
                                        <option key={a.id} value={a.id}>
                                            {a.name}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        </div>
                        {isEdit && (
                            <p className="text-xs text-gray-400 -mt-2">
                                Accounts cannot be changed once initiated. Reject and recreate the transfer to change accounts.
                            </p>
                        )}

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="label">
                                    Amount Sent
                                    {fromAccount ? ` (${fromAccount.currency_code})` : ''} *
                                </label>
                                <input type="number" className="input"
                                    value={form.amount_sent}
                                    onChange={e => setForm(p => ({
                                        ...p, amount_sent: e.target.value }))}
                                    min="0.01" step="0.01" required />
                            </div>
                            <div>
                                <label className="label">Exchange Rate {sameCurrency ? '' : '*'}</label>
                                {sameCurrency ? (
                                    <>
                                        <input type="text" className="input bg-gray-50 text-gray-400" value="1 (same currency)" disabled />
                                        <p className="text-xs text-gray-400 mt-1">
                                            Both accounts use {fromAccount.currency_code} — no exchange rate applies.
                                        </p>
                                    </>
                                ) : (
                                    <input type="number" className="input"
                                        value={form.exchange_rate}
                                        onChange={e => setForm(p => ({
                                            ...p, exchange_rate: e.target.value }))}
                                        min="0.00000001" step="0.00000001" required />
                                )}
                            </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="label">Sending Bank Charge</label>
                                <input type="number" className="input"
                                    value={form.sending_bank_charge}
                                    onChange={e => setForm(p => ({
                                        ...p, sending_bank_charge: e.target.value }))}
                                    min="0" step="0.01"
                                    placeholder="0.00" />
                                <p className="text-xs text-gray-400 mt-1">
                                    Charged by the sending bank
                                </p>
                            </div>
                            <div>
                                <label className="label">Receiving Bank Charge</label>
                                <input type="number" className="input"
                                    value={form.receiving_bank_charge}
                                    onChange={e => setForm(p => ({
                                        ...p, receiving_bank_charge: e.target.value }))}
                                    min="0" step="0.01"
                                    placeholder="0.00" />
                                <p className="text-xs text-gray-400 mt-1">
                                    Charged by the receiving bank
                                </p>
                            </div>
                        </div>

                        {/* Amount preview */}
                        {amountReceived && toAccount && (
                            <div className="bg-blue-50 rounded-lg p-3 text-sm">
                                <p className="text-blue-700">
                                    Amount to be received:{' '}
                                    <span className="font-bold">
                                        {toAccount.currency_code} {amountReceived}
                                    </span>
                                </p>
                            </div>
                        )}

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
                            <label className="label">Description</label>
                            <input type="text" className="input"
                                value={form.description}
                                onChange={e => setForm(p => ({
                                    ...p, description: e.target.value }))} />
                        </div>

                        <div>
                            <label className="label">Value Date *</label>
                            <input type="date" className="input"
                                value={form.value_date}
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
                                {loading ? 'Saving...' : (isEdit ? 'Save Changes' : 'Initiate Transfer')}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// MAIN TRANSFERS PAGE
// ============================================================
const TransfersPage = () => {
    const { hasPermission, hasRole, user } = useAuth();
    const [transfers,  setTransfers]  = useState([]);
    const [accounts,   setAccounts]   = useState([]);
    const [categories, setCategories] = useState([]);
    const [pagination, setPagination] = useState(null);
    const [loading,    setLoading]    = useState(true);
    const [error,      setError]      = useState(null);
    const [page,       setPage]       = useState(1);
    const [showModal,  setShowModal]  = useState(false);
    const [editingRecord, setEditingRecord] = useState(null);
    const [actionLoading, setActionLoading] = useState(null);
    const [preview, setPreview] = useState(null);
    const [analytics,        setAnalytics]        = useState(null);
    const [analyticsLoading, setAnalyticsLoading] = useState(true);
    const [exportingCsv,     setExportingCsv]     = useState(false);

    // Filters — v1.50.0, same shape as Transactions (account_id +
    // date range); feeds both the ledger table and the analytics/CSV
    // endpoints below.
    const [filters, setFilters] = useState({
        account_id: '', from_date: '', to_date: ''
    });

    const canEdit = (row) =>
        row.status === 'AWAITING_APPROVAL' &&
        (row.created_by === user?.id || hasPermission('FINANCE_TRANSFER_APPROVE'));

    // v1.36.0 — mirrors transfersController.approveTransfer's own role
    // check exactly: Treasurer approves Primary→Secondary, Director
    // approves Secondary→Primary. Previously the Approve button showed
    // for ANY FINANCE_TRANSFER_APPROVE holder regardless of which
    // specific role that transfer actually needs, so e.g. a Director
    // saw (and could click) Approve on a P2S transfer only to have the
    // backend reject it — CMS_BIBLE.md Section 7.3's known issue.
    // (Reject is intentionally NOT narrowed the same way — the backend's
    // rejectTransfer has no type-specific role check of its own, so any
    // FINANCE_TRANSFER_APPROVE holder can reject either direction.)
    const canApprove = (row) =>
        hasPermission('FINANCE_TRANSFER_APPROVE') &&
        hasRole(row.transfer_type === 'PRIMARY_TO_SECONDARY' ? 'Treasurer' : 'Director');

    const openEditModal = (row) => {
        setEditingRecord(row);
        setShowModal(true);
    };

    const closeModal = () => {
        setShowModal(false);
        setEditingRecord(null);
    };

    const loadTransfers = useCallback(async () => {
        try {
            setLoading(true);
            const params = { page, limit: 20, ...filters };
            Object.keys(params).forEach(k => !params[k] && delete params[k]);
            const res = await transfersAPI.getAll(params);
            setTransfers(res.data.data);
            setPagination(res.data.meta?.pagination);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, [page, filters]);

    useEffect(() => {
        loadTransfers();
        accountsAPI.getAll().then(r => setAccounts(r.data.data)).catch(() => {});
        categoriesAPI.getAll({ flat: true }).then(r => setCategories(r.data.data)).catch(() => {});
    }, [loadTransfers]);

    // Analytics (volume/rate/charges charts) — depends only on filters,
    // never on `page`, since it summarizes every matching POSTED
    // transfer, not just the visible page of 20.
    useEffect(() => {
        setAnalyticsLoading(true);
        const params = { ...filters };
        Object.keys(params).forEach(k => !params[k] && delete params[k]);
        transfersAPI.getAnalytics(params)
            .then(res => setAnalytics(res.data.data))
            .catch(() => setAnalytics(null))
            .finally(() => setAnalyticsLoading(false));
    }, [filters]);

    const handleExportCsv = async () => {
        setExportingCsv(true);
        try {
            const params = { ...filters };
            Object.keys(params).forEach(k => !params[k] && delete params[k]);
            const res = await transfersAPI.exportCsv(params);
            downloadBlob(res.data, `transfers-${new Date().toISOString().slice(0, 10)}.csv`);
        } catch (err) {
            setError(await getBlobErrorMessage(err));
        } finally {
            setExportingCsv(false);
        }
    };

    const handleApprove = async (id) => {
        setActionLoading(id);
        try {
            await transfersAPI.approve(id, {});
            loadTransfers();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setActionLoading(null);
        }
    };

    const handleReject = async (id) => {
        const reason = window.prompt('Enter reason for rejection:');
        if (!reason) return;
        setActionLoading(id);
        try {
            await transfersAPI.reject(id, { reason });
            loadTransfers();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setActionLoading(null);
        }
    };

    const columns = [
        {
            header: 'Reference',
            render: row => (
                <div>
                    <button
                        onClick={() => setPreview({
                            html: transferTemplate(row),
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
            header: 'From → To',
            render: row => (
                <div>
                    <p className="text-sm font-medium text-gray-900">
                        {row.from_account} → {row.to_account}
                    </p>
                    <p className="text-xs text-gray-400">
                        {row.transfer_type === 'PRIMARY_TO_SECONDARY'
                            ? 'Primary → Secondary'
                            : 'Secondary → Primary'}
                    </p>
                </div>
            ),
        },
        {
            header: 'Amount Sent',
            render: row => (
                <span className="text-sm font-semibold text-red-600">
                    -{row.from_currency} {parseFloat(row.amount_sent).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                </span>
            ),
        },
        {
            header: 'Amount Received',
            render: row => (
                <span className="text-sm font-semibold text-green-600">
                    +{row.to_currency} {parseFloat(row.amount_received).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                </span>
            ),
        },
        {
            header: 'Rate',
            render: row => (
                <span className="text-sm text-gray-600">
                    {parseFloat(row.exchange_rate).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                </span>
            ),
        },
        {
            header: 'Charges',
            render: row => {
                const sending   = parseFloat(row.sending_bank_charge || 0);
                const receiving = parseFloat(row.receiving_bank_charge || 0);
                if (sending === 0 && receiving === 0) {
                    return <span className="text-xs text-gray-300">—</span>;
                }
                return (
                    <div className="text-xs text-gray-500 space-y-0.5">
                        {sending > 0 && (
                            <p>Send: {row.from_currency} {sending.toLocaleString('en-US', { maximumFractionDigits: 2 })}</p>
                        )}
                        {receiving > 0 && (
                            <p>Recv: {row.to_currency} {receiving.toLocaleString('en-US', { maximumFractionDigits: 2 })}</p>
                        )}
                    </div>
                );
            },
        },
        {
            header: 'Approvals',
            render: row => (
                <span className="text-sm text-gray-600">
                    {row.current_approvals || 0}/{row.required_approvals || 1}
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
            header: 'Actions',
            render: row => (
                <div className="flex gap-2">
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
                    {/* Approve — v1.36.0: gated by canApprove(row), which
                        matches the backend's exact rule (Treasurer for
                        P2S, Director for S2P), not just the general
                        FINANCE_TRANSFER_APPROVE permission. Reject stays
                        on the general permission — the backend's own
                        rejectTransfer has no type-specific role check,
                        any approver can reject either direction. */}
                    {row.status === 'AWAITING_APPROVAL' && canApprove(row) && (
                        <button
                            onClick={() => handleApprove(row.id)}
                            disabled={actionLoading === row.id}
                            className="p-1.5 rounded-lg bg-green-50 text-green-600
                                hover:bg-green-100 transition-colors"
                            title="Approve"
                        >
                            <CheckIcon className="h-4 w-4" />
                        </button>
                    )}
                    {row.status === 'AWAITING_APPROVAL' &&
                    hasPermission('FINANCE_TRANSFER_APPROVE') && (
                        <button
                            onClick={() => handleReject(row.id)}
                            disabled={actionLoading === row.id}
                            className="p-1.5 rounded-lg bg-red-50 text-red-600
                                hover:bg-red-100 transition-colors"
                            title="Reject"
                        >
                            <XMarkIcon className="h-4 w-4" />
                        </button>
                    )}
                </div>
            ),
        },
        {
            header: '',
            render: row => (
                <button
                    onClick={() => printDocument(transferTemplate(row), row.reference_code)}
                    className="p-1.5 rounded-lg bg-gray-50 text-gray-500
                        hover:bg-gray-100 transition-colors"
                    title="Export this transfer"
                >
                    <ArrowDownTrayIcon className="h-4 w-4" />
                </button>
            ),
        },
    ];

    return (
        <div>
            <PageHeader
                title="Transfers"
                subtitle="Inter-account transfers with approval workflows"
                actions={
                    <div className="flex gap-2">
                        <button
                            onClick={handleExportCsv}
                            disabled={exportingCsv}
                            className="btn-secondary flex items-center gap-2"
                            title="Download every transfer matching the current filters as a CSV file — clear all filters first for the complete ledger"
                        >
                            <ArrowDownTrayIcon className="h-4 w-4" />
                            {exportingCsv ? 'Exporting...' : 'Export CSV'}
                        </button>
                        {hasPermission('FINANCE_TRANSFER_CREATE') && (
                            <button
                                onClick={() => { setEditingRecord(null); setShowModal(true); }}
                                className="btn-primary flex items-center gap-2"
                            >
                                <PlusIcon className="h-4 w-4" />
                                New Transfer
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

            <TransferAnalyticsCharts analytics={analytics} loading={analyticsLoading} />

            {/* Filters */}
            <div className="card mb-6">
                <div className="flex items-center gap-2 mb-3">
                    <FunnelIcon className="h-4 w-4 text-gray-400" />
                    <span className="text-sm font-medium text-gray-600">Filters</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <select className="input" value={filters.account_id}
                        onChange={e => setFilters(p => ({
                            ...p, account_id: e.target.value }))}>
                        <option value="">All Accounts</option>
                        {accounts.map(a => (
                            <option key={a.id} value={a.id}>{a.name}</option>
                        ))}
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
                            setFilters({ account_id: '', from_date: '', to_date: '' });
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
                data={transfers}
                loading={loading}
                emptyMessage="No transfers found"
                searchable
                searchPlaceholder="Search transfers..."
                pagination={pagination}
                onPageChange={setPage}
            />

            <TransferModal
                isOpen={showModal}
                onClose={closeModal}
                onSuccess={loadTransfers}
                accounts={accounts}
                categories={categories}
                editingRecord={editingRecord}
            />

            <DocumentPreviewModal preview={preview} onClose={() => setPreview(null)} />
        </div>
    );
};

export default TransfersPage;