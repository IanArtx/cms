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
import { PlusIcon, CheckIcon, XMarkIcon, ArrowDownTrayIcon, PencilIcon } from '@heroicons/react/24/outline';
import { transferTemplate, printDocument } from '../../utils/exportUtils';
import DocumentPreviewModal from '../../components/common/DocumentPreviewModal';

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
    const { hasPermission, user } = useAuth();
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

    const canEdit = (row) =>
        row.status === 'AWAITING_APPROVAL' &&
        (row.created_by === user?.id || hasPermission('FINANCE_TRANSFER_APPROVE'));

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
            const res = await transfersAPI.getAll({ page, limit: 20 });
            setTransfers(res.data.data);
            setPagination(res.data.meta?.pagination);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, [page]);

    useEffect(() => {
        loadTransfers();
        accountsAPI.getAll().then(r => setAccounts(r.data.data)).catch(() => {});
        categoriesAPI.getAll({ flat: true }).then(r => setCategories(r.data.data)).catch(() => {});
    }, [loadTransfers]);

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
                    {row.status === 'AWAITING_APPROVAL' &&
                    hasPermission('FINANCE_TRANSFER_APPROVE') && (
                        <>
                            <button
                                onClick={() => handleApprove(row.id)}
                                disabled={actionLoading === row.id}
                                className="p-1.5 rounded-lg bg-green-50 text-green-600
                                    hover:bg-green-100 transition-colors"
                                title="Approve"
                            >
                                <CheckIcon className="h-4 w-4" />
                            </button>
                            <button
                                onClick={() => handleReject(row.id)}
                                disabled={actionLoading === row.id}
                                className="p-1.5 rounded-lg bg-red-50 text-red-600
                                    hover:bg-red-100 transition-colors"
                                title="Reject"
                            >
                                <XMarkIcon className="h-4 w-4" />
                            </button>
                        </>
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
                    hasPermission('FINANCE_TRANSFER_CREATE') && (
                        <button
                            onClick={() => { setEditingRecord(null); setShowModal(true); }}
                            className="btn-primary flex items-center gap-2"
                        >
                            <PlusIcon className="h-4 w-4" />
                            New Transfer
                        </button>
                    )
                }
            />

            {error && (
                <div className="mb-4">
                    <ErrorMessage message={error} onDismiss={() => setError(null)} />
                </div>
            )}

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