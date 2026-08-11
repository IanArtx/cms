// ============================================================
// REQUISITIONS PAGE
// Any member can submit a money request.
// Treasurer/Directors approve or reject.
// Approval automatically posts a transaction.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { requisitionsAPI, accountsAPI, categoriesAPI } from '../../api/endpoints';
import { formatDate, getErrorMessage } from '../../utils/helpers';
import PageHeader from '../../components/common/PageHeader';
import DataTable from '../../components/common/DataTable';
import ErrorMessage from '../../components/common/ErrorMessage';
import StatusBadge from '../../components/common/StatusBadge';
import { useAuth } from '../../contexts/AuthContext';
import { PlusIcon, CheckIcon, XMarkIcon, ArrowDownTrayIcon, PencilIcon } from '@heroicons/react/24/outline';
import { requisitionTemplate, printDocument } from '../../utils/exportUtils';
import DocumentPreviewModal from '../../components/common/DocumentPreviewModal';

// ============================================================
// PRIORITY BADGE
// ============================================================
const PriorityBadge = ({ priority }) => {
    const styles = {
        URGENT: 'bg-red-100 text-red-800',
        HIGH:   'bg-orange-100 text-orange-800',
        NORMAL: 'bg-blue-100 text-blue-800',
        LOW:    'bg-gray-100 text-gray-600',
    };
    return (
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full
            text-xs font-medium ${styles[priority] || styles.NORMAL}`}>
            {priority}
        </span>
    );
};

// ============================================================
// CREATE REQUISITION MODAL
// ============================================================
const BLANK_REQ_FORM = {
    category_id: '', title: '', description: '',
    amount_requested: '', purpose: '',
    required_by_date: '', priority: 'NORMAL',
    requisition_type: 'EXPENSE', contribution_date: '',
};

const CreateRequisitionModal = ({ isOpen, onClose, onSuccess, categories, editingRecord }) => {
    const [form, setForm] = useState(BLANK_REQ_FORM);
    const [loading, setLoading] = useState(false);
    const [error,   setError]   = useState(null);
    const isEdit = !!editingRecord;

    useEffect(() => {
        if (editingRecord) {
            setForm({
                category_id: editingRecord.category_id || '',
                title: editingRecord.title || '',
                description: editingRecord.description || '',
                amount_requested: editingRecord.amount_requested || '',
                purpose: editingRecord.purpose || '',
                required_by_date: editingRecord.required_by_date ? editingRecord.required_by_date.slice(0, 10) : '',
                priority: editingRecord.priority || 'NORMAL',
                requisition_type: editingRecord.requisition_type || 'EXPENSE',
                contribution_date: editingRecord.contribution_date ? editingRecord.contribution_date.slice(0, 10) : '',
            });
        } else {
            setForm(BLANK_REQ_FORM);
        }
    }, [editingRecord, isOpen]);

    if (!isOpen) return null;

    const isContribution = form.requisition_type === 'CONTRIBUTION_ACKNOWLEDGEMENT';
    const isSavingsDeposit = form.requisition_type === 'SAVINGS_DEPOSIT';
    const isSideFund = form.requisition_type === 'SIDE_FUND_CONTRIBUTION';
    const needsDate = isContribution || isSavingsDeposit || isSideFund;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            const payload = {
                ...form,
                amount_requested: parseFloat(form.amount_requested),
                contribution_date: needsDate ? form.contribution_date : undefined,
            };
            if (isEdit) {
                await requisitionsAPI.update(editingRecord.id, payload);
            } else {
                await requisitionsAPI.create(payload);
            }
            onSuccess();
            onClose();
            setForm(BLANK_REQ_FORM);
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
                <div className="relative bg-white rounded-xl shadow-xl
                    max-w-lg w-full p-6 max-h-screen overflow-y-auto">
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">
                        {isEdit ? 'Edit Requisition' : 'Submit Requisition'}
                    </h2>
                    <p className="text-sm text-gray-400 mb-4">
                        {isContribution
                            ? 'Ask the Treasurer to acknowledge and record capital you\'ve already contributed to the company.'
                            : isSavingsDeposit
                            ? 'Ask the Treasurer to record a savings deposit on your behalf. It will still need a Treasurer/Assistant Treasurer\'s approval before it\'s added to your balance.'
                            : isSideFund
                            ? 'Ask the Treasurer to record a side fund payment you\'ve already made. It will be applied to your oldest unpaid dues first.'
                            : 'Request money for a specific purpose. A Treasurer or Assistant Treasurer will review and approve or reject your request.'}
                    </p>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error}
                                onDismiss={() => setError(null)} />
                        </div>
                    )}

                    <div className="mb-4">
                        <label className="label">Request Type *</label>
                        <div className="flex gap-2 flex-wrap">
                            <button type="button"
                                onClick={() => setForm(p => ({ ...p, requisition_type: 'EXPENSE' }))}
                                className={`flex-1 px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${
                                    !isContribution && !isSavingsDeposit && !isSideFund
                                        ? 'border-primary-600 bg-primary-50 text-primary-700'
                                        : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                                }`}>
                                Money Request
                            </button>
                            <button type="button"
                                onClick={() => setForm(p => ({ ...p, requisition_type: 'CONTRIBUTION_ACKNOWLEDGEMENT' }))}
                                className={`flex-1 px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${
                                    isContribution
                                        ? 'border-primary-600 bg-primary-50 text-primary-700'
                                        : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                                }`}>
                                Acknowledge My Contribution
                            </button>
                            <button type="button"
                                onClick={() => setForm(p => ({ ...p, requisition_type: 'SAVINGS_DEPOSIT' }))}
                                className={`flex-1 px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${
                                    isSavingsDeposit
                                        ? 'border-primary-600 bg-primary-50 text-primary-700'
                                        : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                                }`}>
                                Request Savings Deposit
                            </button>
                            <button type="button"
                                onClick={() => setForm(p => ({ ...p, requisition_type: 'SIDE_FUND_CONTRIBUTION' }))}
                                className={`flex-1 px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${
                                    isSideFund
                                        ? 'border-primary-600 bg-primary-50 text-primary-700'
                                        : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                                }`}>
                                Acknowledge Side Fund Payment
                            </button>
                        </div>
                    </div>

                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">Title *</label>
                            <input type="text" className="input" value={form.title}
                                onChange={e => setForm(p => ({
                                    ...p, title: e.target.value }))}
                                placeholder={isContribution
                                    ? 'e.g. Capital contribution — July 2026'
                                    : isSavingsDeposit
                                    ? 'e.g. Savings deposit — July 2026'
                                    : isSideFund
                                    ? 'e.g. Side fund payment — July 2026'
                                    : 'Brief title for the request'}
                                required />
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="label">Category *</label>
                                <select className="input" value={form.category_id}
                                    onChange={e => setForm(p => ({
                                        ...p, category_id: e.target.value }))}
                                    required>
                                    <option value="">Select category...</option>
                                    {categories.filter(c => c.module === 'FINANCE').map(c => (
                                        <option key={c.id} value={c.id}>
                                            {c.full_path || c.name}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            {!needsDate && (
                                <div>
                                    <label className="label">Priority</label>
                                    <select className="input" value={form.priority}
                                        onChange={e => setForm(p => ({
                                            ...p, priority: e.target.value }))}>
                                        <option value="LOW">Low</option>
                                        <option value="NORMAL">Normal</option>
                                        <option value="HIGH">High</option>
                                        <option value="URGENT">Urgent</option>
                                    </select>
                                </div>
                            )}
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="label">
                                    {isContribution ? 'Amount Contributed *' : isSavingsDeposit ? 'Amount Deposited *' : isSideFund ? 'Amount Paid *' : 'Amount Requested *'}
                                </label>
                                <input type="number" className="input"
                                    value={form.amount_requested}
                                    onChange={e => setForm(p => ({
                                        ...p, amount_requested: e.target.value }))}
                                    min="0.01" step="0.01" required />
                            </div>
                            <div>
                                <label className="label">
                                    {isContribution ? 'Date Contributed *' : isSavingsDeposit ? 'Date Deposited *' : isSideFund ? 'Date Paid *' : 'Required By'}
                                </label>
                                <input type="date" className="input"
                                    value={needsDate ? form.contribution_date : form.required_by_date}
                                    max={needsDate ? new Date().toISOString().slice(0, 10) : undefined}
                                    onChange={e => setForm(p => (needsDate
                                        ? { ...p, contribution_date: e.target.value }
                                        : { ...p, required_by_date: e.target.value }))}
                                    required={needsDate} />
                            </div>
                        </div>

                        <div>
                            <label className="label">
                                {isContribution ? 'How Did You Pay? *' : isSavingsDeposit ? 'Deposit Details *' : isSideFund ? 'How Did You Pay? *' : 'Purpose *'}
                            </label>
                            <textarea className="input" rows={3}
                                value={form.purpose}
                                onChange={e => setForm(p => ({
                                    ...p, purpose: e.target.value }))}
                                placeholder={isContribution
                                    ? 'e.g. Bank transfer to the company account on 15 July, ref #123456 — or cash handed to the Treasurer'
                                    : isSavingsDeposit
                                    ? 'e.g. Cash handed to the Treasurer on 15 July for my savings'
                                    : isSideFund
                                    ? 'e.g. Cash handed to the Treasurer on 15 July for my side fund due'
                                    : 'Explain clearly what the money will be used for...'}
                                required />
                        </div>

                        <div>
                            <label className="label">Additional Details</label>
                            <textarea className="input" rows={2}
                                value={form.description}
                                onChange={e => setForm(p => ({
                                    ...p, description: e.target.value }))}
                                placeholder="Any additional information..." />
                        </div>

                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose}
                                className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading}
                                className="btn-primary">
                                {loading
                                    ? 'Saving...'
                                    : isEdit ? 'Save Changes'
                                    : isContribution ? 'Submit for Acknowledgement'
                                    : isSavingsDeposit ? 'Submit Deposit Request'
                                    : isSideFund ? 'Submit for Acknowledgement'
                                    : 'Submit Requisition'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// APPROVE REQUISITION MODAL
// ============================================================
const ApproveModal = ({ isOpen, requisition, onClose, onSuccess, accounts }) => {
    const [form, setForm] = useState({
        account_id:     '',
        amount_approved: '',
        review_notes:   '',
    });
    const [loading, setLoading] = useState(false);
    const [error,   setError]   = useState(null);

    if (!isOpen || !requisition) return null;

    const isContribution = requisition.requisition_type === 'CONTRIBUTION_ACKNOWLEDGEMENT';
    const isSideFund = requisition.requisition_type === 'SIDE_FUND_CONTRIBUTION';
    const noAccountNeeded = isContribution || isSideFund;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await requisitionsAPI.approve(requisition.id, {
                account_id: noAccountNeeded
                    ? undefined
                    : parseInt(form.account_id),
                amount_approved: form.amount_approved
                    ? parseFloat(form.amount_approved)
                    : undefined,
                review_notes:   form.review_notes || undefined,
            });
            onSuccess();
            onClose();
            setForm({ account_id: '', amount_approved: '', review_notes: '' });
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
                <div className="relative bg-white rounded-xl shadow-xl
                    max-w-md w-full p-6">
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">
                        {isContribution ? 'Acknowledge Contribution' : isSideFund ? 'Acknowledge Side Fund Payment' : 'Approve Requisition'}
                    </h2>
                    <div className="bg-gray-50 rounded-lg p-3 mb-4">
                        <p className="text-sm font-medium text-gray-900">
                            {requisition.title}
                        </p>
                        <p className="text-xs text-gray-500 mt-0.5">
                            {noAccountNeeded ? 'Contributed by' : 'Requested by'}{' '}
                            {requisition.requested_by_name} •{' '}
                            {requisition.category_trail}
                        </p>
                        <p className="text-sm font-bold text-primary-700 mt-2">
                            {isContribution ? 'Amount Contributed: ' : isSideFund ? 'Amount Paid: ' : 'Amount Requested: '}
                            {parseFloat(requisition.amount_requested).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                        </p>
                        {noAccountNeeded && requisition.contribution_date && (
                            <p className="text-xs text-gray-500 mt-1">
                                Date paid: {requisition.contribution_date}
                            </p>
                        )}
                        <p className="text-xs text-gray-500 mt-1">
                            {noAccountNeeded ? 'How they paid: ' : 'Purpose: '}
                            {requisition.purpose}
                        </p>
                    </div>
                    {isContribution && (
                        <div className="bg-blue-50 border border-blue-100 rounded-lg p-3 mb-4 text-xs text-blue-700">
                            Approving this will credit the primary account and update this
                            member's shareholding automatically — no account selection needed.
                        </div>
                    )}
                    {isSideFund && (
                        <div className="bg-blue-50 border border-blue-100 rounded-lg p-3 mb-4 text-xs text-blue-700">
                            Approving this will credit the side fund and apply it to this member's
                            oldest unpaid dues first — no account selection needed.
                        </div>
                    )}
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error}
                                onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        {!noAccountNeeded && (
                            <div>
                                <label className="label">Pay From Account *</label>
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
                        )}
                        <div>
                            <label className="label">
                                {noAccountNeeded ? 'Amount to Acknowledge' : 'Amount to Approve'}
                                <span className="text-gray-400 font-normal ml-1">
                                    (leave blank to approve full amount)
                                </span>
                            </label>
                            <input type="number" className="input"
                                value={form.amount_approved}
                                onChange={e => setForm(p => ({
                                    ...p, amount_approved: e.target.value }))}
                                placeholder={requisition.amount_requested}
                                min="0.01" step="0.01" />
                        </div>
                        <div>
                            <label className="label">Notes</label>
                            <textarea className="input" rows={2}
                                value={form.review_notes}
                                onChange={e => setForm(p => ({
                                    ...p, review_notes: e.target.value }))}
                                placeholder="Optional notes..." />
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose}
                                className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading}
                                className="btn-primary">
                                {loading
                                    ? 'Processing...'
                                    : isContribution ? 'Approve & Record Contribution'
                                    : isSideFund ? 'Approve & Record Side Fund Payment'
                                    : 'Approve & Pay'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// REJECT MODAL
// ============================================================
const RejectModal = ({ isOpen, requisition, onClose, onSuccess }) => {
    const [reason,  setReason]  = useState('');
    const [loading, setLoading] = useState(false);
    const [error,   setError]   = useState(null);

    if (!isOpen || !requisition) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await requisitionsAPI.reject(requisition.id, { review_notes: reason });
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
                <div className="relative bg-white rounded-xl shadow-xl
                    max-w-md w-full p-6">
                    <h2 className="text-lg font-semibold text-gray-900 mb-4">
                        Reject Requisition
                    </h2>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error}
                                onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">Reason for Rejection *</label>
                            <textarea className="input" rows={3}
                                value={reason}
                                onChange={e => setReason(e.target.value)}
                                placeholder="Explain why this requisition is being rejected..."
                                required />
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose}
                                className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading}
                                className="btn-danger">
                                {loading ? 'Rejecting...' : 'Reject Requisition'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// MAIN REQUISITIONS PAGE
// ============================================================
const RequisitionsPage = () => {
    const { hasPermission, hasRole, user } = useAuth();
    const [allReqs,    setAllReqs]    = useState([]);
    const [myReqs,     setMyReqs]     = useState([]);
    const [accounts,   setAccounts]   = useState([]);
    const [categories, setCategories] = useState([]);
    const [pagination, setPagination] = useState(null);
    const [loading,    setLoading]    = useState(true);
    const [error,      setError]      = useState(null);
    const [page,       setPage]       = useState(1);
    const [activeTab,  setActiveTab]  = useState('mine');
    const [showCreate, setShowCreate] = useState(false);
    const [editingRecord, setEditingRecord] = useState(null);
    const [approveReq, setApproveReq] = useState(null);
    const [rejectReq,  setRejectReq]  = useState(null);
    const [statusFilter, setStatusFilter] = useState('');
    const [preview, setPreview] = useState(null);

    const canApprove = hasPermission('FINANCE_TRANSACTION_CREATE') &&
                       hasPermission('FINANCE_VIEW_ALL');
    const isTreasuryRole = hasRole(['Treasurer', 'Assistant Treasurer']);

    const canEdit = (row) =>
        row.status === 'PENDING' &&
        (row.requested_by === user?.id || isTreasuryRole);

    const openEditModal = (row) => {
        setEditingRecord(row);
        setShowCreate(true);
    };

    const closeCreateModal = () => {
        setShowCreate(false);
        setEditingRecord(null);
    };

    const loadMyReqs = useCallback(async () => {
        try {
            setLoading(true);
            const res = await requisitionsAPI.getMine();
            setMyReqs(res.data.data || []);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, []);

    const loadAllReqs = useCallback(async () => {
        try {
            setLoading(true);
            const params = { page, limit: 20 };
            if (statusFilter) params.status = statusFilter;
            const res = await requisitionsAPI.getAll(params);
            setAllReqs(res.data.data || []);
            setPagination(res.data.meta?.pagination);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, [page, statusFilter]);

    useEffect(() => {
        loadMyReqs();
        if (canApprove) loadAllReqs();
        accountsAPI.getAll().then(r => setAccounts(r.data.data)).catch(() => {});
        categoriesAPI.getAll({ flat: true }).then(r => setCategories(r.data.data)).catch(() => {});
    }, [loadMyReqs, loadAllReqs, canApprove]);

    const handleSuccess = () => {
        loadMyReqs();
        if (canApprove) loadAllReqs();
    };

    // Columns for My Requisitions
    const myColumns = [
        {
            header: 'Reference',
            render: row => (
                <div>
                    <button
                        onClick={() => setPreview({
                            html: requisitionTemplate(row),
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
            header: 'Title',
            render: row => (
                <div>
                    <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-gray-900">{row.title}</p>
                        {row.requisition_type === 'CONTRIBUTION_ACKNOWLEDGEMENT' && (
                            <span className="badge-blue text-[10px] px-1.5 py-0.5">Contribution</span>
                        )}
                        {row.requisition_type === 'SAVINGS_DEPOSIT' && (
                            <span className="badge-blue text-[10px] px-1.5 py-0.5">Savings</span>
                        )}
                        {row.requisition_type === 'SIDE_FUND_CONTRIBUTION' && (
                            <span className="badge-blue text-[10px] px-1.5 py-0.5">Side Fund</span>
                        )}
                    </div>
                    <p className="text-xs text-gray-400">{row.category_trail}</p>
                </div>
            ),
        },
        {
            header: 'Amount',
            render: row => (
                <div>
                    <p className="text-sm font-bold text-gray-900">
                        {parseFloat(row.amount_requested).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                        {row.requisition_type === 'CONTRIBUTION_ACKNOWLEDGEMENT' ? ' contributed'
                            : row.requisition_type === 'SAVINGS_DEPOSIT' ? ' deposited'
                            : row.requisition_type === 'SIDE_FUND_CONTRIBUTION' ? ' paid' : ' requested'}
                    </p>
                    {row.amount_approved && (
                        <p className="text-xs text-green-600 font-medium">
                            {parseFloat(row.amount_approved).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                            {row.requisition_type === 'CONTRIBUTION_ACKNOWLEDGEMENT' ? ' acknowledged'
                                : row.requisition_type === 'SAVINGS_DEPOSIT' ? ' forwarded to Treasurer'
                                : row.requisition_type === 'SIDE_FUND_CONTRIBUTION' ? ' acknowledged' : ' approved'}
                        </p>
                    )}
                </div>
            ),
        },
        {
            header: 'Priority',
            render: row => <PriorityBadge priority={row.priority} />,
        },
        {
            header: 'Date',
            render: row => (
                <span className="text-sm text-gray-500">
                    {['CONTRIBUTION_ACKNOWLEDGEMENT', 'SAVINGS_DEPOSIT', 'SIDE_FUND_CONTRIBUTION'].includes(row.requisition_type)
                        ? (row.contribution_date ? formatDate(row.contribution_date) : '—')
                        : (row.required_by_date ? formatDate(row.required_by_date) : '—')}
                </span>
            ),
        },
        {
            header: 'Status',
            render: row => <StatusBadge status={row.status} />,
        },
        {
            header: 'Review Notes',
            render: row => (
                <span className="text-xs text-gray-500">
                    {row.review_notes || '—'}
                </span>
            ),
        },
        {
            header: '',
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
                    <button
                        onClick={() => printDocument(requisitionTemplate(row), row.reference_code)}
                        className="p-1.5 rounded-lg bg-gray-50 text-gray-500
                            hover:bg-gray-100 transition-colors"
                        title="Export this requisition"
                    >
                        <ArrowDownTrayIcon className="h-4 w-4" />
                    </button>
                </div>
            ),
        },
    ];

    // Columns for All Requisitions (approver view)
    const allColumns = [
        {
            header: 'Reference',
            render: row => (
                <div>
                    <button
                        onClick={() => setPreview({
                            html: requisitionTemplate(row),
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
            header: 'Requested By',
            render: row => (
                <div>
                    <p className="text-sm font-medium text-gray-900">
                        {row.requested_by_name}
                    </p>
                    <p className="text-xs text-gray-400">{row.requested_by_email}</p>
                </div>
            ),
        },
        {
            header: 'Title & Category',
            render: row => (
                <div>
                    <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-gray-900">{row.title}</p>
                        {row.requisition_type === 'CONTRIBUTION_ACKNOWLEDGEMENT' && (
                            <span className="badge-blue text-[10px] px-1.5 py-0.5">Contribution</span>
                        )}
                        {row.requisition_type === 'SAVINGS_DEPOSIT' && (
                            <span className="badge-blue text-[10px] px-1.5 py-0.5">Savings</span>
                        )}
                        {row.requisition_type === 'SIDE_FUND_CONTRIBUTION' && (
                            <span className="badge-blue text-[10px] px-1.5 py-0.5">Side Fund</span>
                        )}
                    </div>
                    <p className="text-xs text-gray-400">{row.category_trail}</p>
                </div>
            ),
        },
        {
            header: 'Amount',
            render: row => (
                <span className="text-sm font-bold text-gray-900">
                    {parseFloat(row.amount_requested).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                </span>
            ),
        },
        {
            header: 'Priority',
            render: row => <PriorityBadge priority={row.priority} />,
        },
        {
            header: 'Required By',
            render: row => (
                <span className="text-sm text-gray-500">
                    {row.required_by_date ? formatDate(row.required_by_date) : '—'}
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
                    {row.status === 'PENDING' && canApprove && (
                        <>
                            <button
                                onClick={() => setApproveReq(row)}
                                className="p-1.5 rounded-lg bg-green-50 text-green-600
                                    hover:bg-green-100 transition-colors"
                                title={['CONTRIBUTION_ACKNOWLEDGEMENT', 'SIDE_FUND_CONTRIBUTION'].includes(row.requisition_type)
                                    ? 'Acknowledge' : 'Approve'}
                            >
                                <CheckIcon className="h-4 w-4" />
                            </button>
                            <button
                                onClick={() => setRejectReq(row)}
                                className="p-1.5 rounded-lg bg-red-50 text-red-600
                                    hover:bg-red-100 transition-colors"
                                title="Reject"
                            >
                                <XMarkIcon className="h-4 w-4" />
                            </button>
                        </>
                    )}
                    <button
                        onClick={() => printDocument(requisitionTemplate(row), row.reference_code)}
                        className="p-1.5 rounded-lg bg-gray-50 text-gray-500
                            hover:bg-gray-100 transition-colors"
                        title="Export this requisition"
                    >
                        <ArrowDownTrayIcon className="h-4 w-4" />
                    </button>
                </div>
            ),
        },
    ];

    const pendingCount = allReqs.filter(r => r.status === 'PENDING').length;

    return (
        <div>
            <PageHeader
                title="Requisitions"
                subtitle="Money requests — submit, review and approve"
                actions={
                    <button
                        onClick={() => { setEditingRecord(null); setShowCreate(true); }}
                        className="btn-primary flex items-center gap-2"
                    >
                        <PlusIcon className="h-4 w-4" />
                        New Requisition
                    </button>
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
                    onClick={() => setActiveTab('mine')}
                    className={`px-4 py-2 rounded-lg text-sm font-medium
                        transition-colors ${activeTab === 'mine'
                            ? 'bg-primary-700 text-white'
                            : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                        }`}
                >
                    My Requests
                    <span className="ml-2 text-xs opacity-70">
                        ({myReqs.length})
                    </span>
                </button>
                {canApprove && (
                    <button
                        onClick={() => setActiveTab('all')}
                        className={`flex items-center gap-2 px-4 py-2 rounded-lg
                            text-sm font-medium transition-colors ${
                            activeTab === 'all'
                                ? 'bg-primary-700 text-white'
                                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                        }`}
                    >
                        All Requests
                        {pendingCount > 0 && (
                            <span className={`text-xs px-1.5 py-0.5 rounded-full
                                font-bold ${activeTab === 'all'
                                    ? 'bg-white text-primary-700'
                                    : 'bg-red-500 text-white'
                                }`}>
                                {pendingCount}
                            </span>
                        )}
                    </button>
                )}
            </div>

            {/* My Requests Tab */}
            {activeTab === 'mine' && (
                <>
                    {myReqs.length === 0 && !loading ? (
                        <div className="card text-center py-12">
                            <p className="text-gray-400 font-medium mb-2">
                                No requisitions yet
                            </p>
                            <p className="text-sm text-gray-300">
                                Click "New Requisition" to submit a money request
                            </p>
                        </div>
                    ) : (
                        <DataTable
                            columns={myColumns}
                            data={myReqs}
                            loading={loading}
                            emptyMessage="You have no requisitions yet"
                            searchable
                            searchPlaceholder="Search my requisitions..."
                        />
                    )}
                </>
            )}

            {/* All Requests Tab */}
            {activeTab === 'all' && canApprove && (
                <>
                    {/* Status Filter */}
                    <div className="card mb-4">
                        <div className="flex gap-2 flex-wrap">
                            {['', 'PENDING', 'APPROVED', 'REJECTED'].map(s => (
                                <button
                                    key={s}
                                    onClick={() => {
                                        setStatusFilter(s);
                                        setPage(1);
                                    }}
                                    className={`px-3 py-1.5 rounded-lg text-sm
                                        font-medium transition-colors ${
                                        statusFilter === s
                                            ? 'bg-primary-700 text-white'
                                            : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                                    }`}
                                >
                                    {s || 'All'}
                                </button>
                            ))}
                        </div>
                    </div>

                    <DataTable
                        columns={allColumns}
                        data={allReqs}
                        loading={loading}
                        emptyMessage="No requisitions found"
                        searchable
                        searchPlaceholder="Search requisitions..."
                        pagination={pagination}
                        onPageChange={setPage}
                    />
                </>
            )}

            {/* Modals */}
            <CreateRequisitionModal
                isOpen={showCreate}
                onClose={closeCreateModal}
                onSuccess={handleSuccess}
                categories={categories}
                editingRecord={editingRecord}
            />
            <ApproveModal
                isOpen={!!approveReq}
                requisition={approveReq}
                onClose={() => setApproveReq(null)}
                onSuccess={handleSuccess}
                accounts={accounts}
            />
            <RejectModal
                isOpen={!!rejectReq}
                requisition={rejectReq}
                onClose={() => setRejectReq(null)}
                onSuccess={handleSuccess}
            />

            <DocumentPreviewModal preview={preview} onClose={() => setPreview(null)} />
        </div>
    );
};

export default RequisitionsPage;