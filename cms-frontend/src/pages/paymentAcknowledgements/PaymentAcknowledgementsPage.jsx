// ============================================================
// PAYMENT ACKNOWLEDGEMENTS PAGE (v1.30.0, Section 4.35)
//
// One page, two views, same "everyone (self-service) + Treasury
// (oversight)" split ServiceFeesPage already uses:
//   - Everyone: their own payments (dividends, service fee payments,
//     reimbursements) that need reviewing, plus the history of ones
//     already acted on. Acknowledge or dispute a pending one; print
//     the two-party document once it's fully approved.
//   - Treasury (PAYMENT_ACK_VIEW / PAYMENT_ACK_MANAGE): every
//     acknowledgement in the system, final-approve an acknowledged
//     one, reopen a disputed one after sorting it out off-system.
//
// A record is never created here — it's auto-generated the moment a
// dividend/service fee payment/reimbursement is actually paid out
// (see paymentAcknowledgementsController.createPaymentAcknowledgement,
// called from dividendsController/serviceFeesController).
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { paymentAcknowledgementsAPI } from '../../api/endpoints';
import { formatDate, getErrorMessage } from '../../utils/helpers';
import { paymentAcknowledgementTemplate, printDocument, previewDocument } from '../../utils/exportUtils';
import PageHeader from '../../components/common/PageHeader';
import DataTable from '../../components/common/DataTable';
import ErrorMessage from '../../components/common/ErrorMessage';
import StatusBadge from '../../components/common/StatusBadge';
import ConfirmModal from '../../components/common/ConfirmModal';
import { useAuth } from '../../contexts/AuthContext';
import { CheckIcon, XMarkIcon, PrinterIcon, ArrowPathIcon, EyeIcon } from '@heroicons/react/24/outline';

const SOURCE_LABELS = {
    DIVIDEND:            'Dividend Payment',
    SERVICE_FEE_PAYMENT: 'Service Fee Payment',
    REIMBURSEMENT:       'Expense Reimbursement',
};

const amountStr = (amount, currencyCode) =>
    `${currencyCode || ''} ${parseFloat(amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

// ============================================================
// ACKNOWLEDGE MODAL (self-service — recipient confirms)
// ============================================================
const AcknowledgeModal = ({ isOpen, ack, onClose, onSuccess }) => {
    const [note, setNote] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    if (!isOpen || !ack) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await paymentAcknowledgementsAPI.acknowledge(ack.id, { note: note || undefined });
            onSuccess();
            onClose();
            setNote('');
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
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">Confirm Receipt</h2>
                    <div className="bg-gray-50 rounded-lg p-3 mb-4">
                        <p className="text-xs text-gray-400">{SOURCE_LABELS[ack.source_type] || ack.source_type}</p>
                        <p className="text-lg font-bold text-primary-700">{amountStr(ack.amount, ack.currency_code)}</p>
                        <p className="text-sm text-gray-600 mt-1">{ack.purpose}</p>
                    </div>
                    <p className="text-sm text-gray-400 mb-4">
                        Confirm that you received this payment for the purpose stated above.
                    </p>
                    {error && <div className="mb-4"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">Note <span className="text-gray-400 font-normal">(optional)</span></label>
                            <textarea className="input" rows={2} value={note}
                                onChange={e => setNote(e.target.value)} />
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading} className="btn-primary">
                                {loading ? 'Confirming...' : 'Confirm Receipt'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// DISPUTE MODAL (self-service — recipient flags an issue)
// ============================================================
const DisputeModal = ({ isOpen, ack, onClose, onSuccess }) => {
    const [reason, setReason] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    if (!isOpen || !ack) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await paymentAcknowledgementsAPI.dispute(ack.id, { reason });
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
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">Dispute This Payment</h2>
                    <p className="text-sm text-gray-400 mb-4">
                        This flags it for Treasury's attention — it does not reverse or change the payment itself.
                    </p>
                    {error && <div className="mb-4"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">Reason *</label>
                            <textarea className="input" rows={3} value={reason}
                                placeholder="What's wrong — the amount, the stated purpose, something else?"
                                onChange={e => setReason(e.target.value)} required />
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading} className="btn-danger">
                                {loading ? 'Submitting...' : 'Submit Dispute'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// MAIN PAGE
// ============================================================
const PaymentAcknowledgementsPage = () => {
    const { user, hasPermission } = useAuth();
    const canViewAll = hasPermission('PAYMENT_ACK_VIEW');
    const canManage = hasPermission('PAYMENT_ACK_MANAGE');

    const [activeTab, setActiveTab] = useState('mine');
    const [mine, setMine] = useState([]);
    const [all, setAll] = useState([]);
    const [statusFilter, setStatusFilter] = useState('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    const [acknowledging, setAcknowledging] = useState(null);
    const [disputing, setDisputing] = useState(null);
    const [approving, setApproving] = useState(null);
    const [reopening, setReopening] = useState(null);
    const [actionLoading, setActionLoading] = useState(false);

    const loadMine = useCallback(async () => {
        try {
            setLoading(true);
            const res = await paymentAcknowledgementsAPI.getMine();
            setMine(res.data.data || []);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, []);

    const loadAll = useCallback(async () => {
        if (!canViewAll) return;
        try {
            const params = {};
            if (statusFilter) params.status = statusFilter;
            const res = await paymentAcknowledgementsAPI.getAll(params);
            setAll(res.data.data || []);
        } catch (err) {
            setError(getErrorMessage(err));
        }
    }, [canViewAll, statusFilter]);

    useEffect(() => { loadMine(); }, [loadMine]);
    useEffect(() => { loadAll(); }, [loadAll]);

    const handleSuccess = () => { loadMine(); loadAll(); };

    const handleFinalApprove = async () => {
        if (!approving) return;
        setActionLoading(true);
        try {
            await paymentAcknowledgementsAPI.finalApprove(approving.id);
            handleSuccess();
            setApproving(null);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setActionLoading(false);
        }
    };

    const handleReopen = async () => {
        if (!reopening) return;
        setActionLoading(true);
        try {
            await paymentAcknowledgementsAPI.reopen(reopening.id);
            handleSuccess();
            setReopening(null);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setActionLoading(false);
        }
    };

    const printAck = (row, recipientName) => {
        const html = paymentAcknowledgementTemplate({
            reference:            row.reference_code,
            public_id:            row.public_id,
            source_label:         SOURCE_LABELS[row.source_type] || row.source_type,
            amount:               row.amount,
            currency_code:        row.currency_code,
            purpose:              row.purpose,
            status:               row.status,
            payer_name:           row.payer_name,
            recipient_name:       recipientName || row.recipient_name,
            created_at:           row.created_at,
            acknowledged_at:      row.acknowledged_at,
            acknowledgement_note: row.acknowledgement_note,
            final_approver_name:  row.final_approver_name,
            final_approved_at:    row.final_approved_at,
        });
        printDocument(html, row.reference_code || 'Payment Acknowledgement');
    };

    const previewAck = (row, recipientName) => {
        const html = paymentAcknowledgementTemplate({
            reference: row.reference_code, public_id: row.public_id,
            source_label: SOURCE_LABELS[row.source_type] || row.source_type,
            amount: row.amount, currency_code: row.currency_code, purpose: row.purpose,
            status: row.status, payer_name: row.payer_name,
            recipient_name: recipientName || row.recipient_name,
            created_at: row.created_at, acknowledged_at: row.acknowledged_at,
            acknowledgement_note: row.acknowledgement_note,
            final_approver_name: row.final_approver_name, final_approved_at: row.final_approved_at,
        });
        previewDocument(html, row.reference_code || 'Payment Acknowledgement');
    };

    const myColumns = [
        { header: 'Reference', render: row => <span className="font-mono text-xs">{row.reference_code}</span> },
        { header: 'Type', render: row => <span className="text-sm text-gray-700">{SOURCE_LABELS[row.source_type] || row.source_type}</span> },
        { header: 'From', render: row => <span className="text-sm text-gray-500">{row.payer_name}</span> },
        { header: 'Purpose', render: row => <span className="text-sm text-gray-600 max-w-xs block truncate" title={row.purpose}>{row.purpose}</span> },
        { header: 'Amount', render: row => <span className="text-sm font-bold text-gray-900">{amountStr(row.amount, row.currency_code)}</span> },
        { header: 'Date', render: row => <span className="text-sm text-gray-500">{formatDate(row.created_at)}</span> },
        { header: 'Status', render: row => <StatusBadge status={row.status} /> },
        {
            header: 'Actions',
            render: row => (
                <div className="flex gap-2">
                    {row.status === 'PENDING_ACK' && (
                        <>
                            <button onClick={() => setAcknowledging(row)}
                                className="p-1.5 rounded-lg bg-green-50 text-green-600 hover:bg-green-100 transition-colors" title="Acknowledge">
                                <CheckIcon className="h-4 w-4" />
                            </button>
                            <button onClick={() => setDisputing(row)}
                                className="p-1.5 rounded-lg bg-red-50 text-red-600 hover:bg-red-100 transition-colors" title="Dispute">
                                <XMarkIcon className="h-4 w-4" />
                            </button>
                        </>
                    )}
                    {row.status === 'FINAL_APPROVED' && (
                        <>
                            <button onClick={() => previewAck(row, `${user.first_name} ${user.last_name}`)}
                                className="p-1.5 rounded-lg bg-gray-50 text-gray-500 hover:bg-gray-100 transition-colors" title="Preview">
                                <EyeIcon className="h-4 w-4" />
                            </button>
                            <button onClick={() => printAck(row, `${user.first_name} ${user.last_name}`)}
                                className="p-1.5 rounded-lg bg-blue-50 text-blue-600 hover:bg-blue-100 transition-colors" title="Print">
                                <PrinterIcon className="h-4 w-4" />
                            </button>
                        </>
                    )}
                </div>
            ),
        },
    ];

    const allColumns = [
        { header: 'Reference', render: row => <span className="font-mono text-xs">{row.reference_code}</span> },
        { header: 'Type', render: row => <span className="text-sm text-gray-700">{SOURCE_LABELS[row.source_type] || row.source_type}</span> },
        { header: 'Recipient', render: row => <span className="text-sm font-medium text-gray-900">{row.recipient_name}</span> },
        { header: 'Paid By', render: row => <span className="text-sm text-gray-500">{row.payer_name}</span> },
        { header: 'Amount', render: row => <span className="text-sm font-bold text-gray-900">{amountStr(row.amount, row.currency_code)}</span> },
        { header: 'Date', render: row => <span className="text-sm text-gray-500">{formatDate(row.created_at)}</span> },
        { header: 'Status', render: row => <StatusBadge status={row.status} /> },
        {
            header: 'Actions',
            render: row => (
                <div className="flex gap-2">
                    {row.status === 'ACKNOWLEDGED' && canManage && (
                        <button onClick={() => setApproving(row)}
                            className="p-1.5 rounded-lg bg-green-50 text-green-600 hover:bg-green-100 transition-colors" title="Final Approve">
                            <CheckIcon className="h-4 w-4" />
                        </button>
                    )}
                    {row.status === 'DISPUTED' && canManage && (
                        <button onClick={() => setReopening(row)}
                            className="p-1.5 rounded-lg bg-yellow-50 text-yellow-600 hover:bg-yellow-100 transition-colors" title="Reopen for recipient">
                            <ArrowPathIcon className="h-4 w-4" />
                        </button>
                    )}
                    {row.status === 'FINAL_APPROVED' && (
                        <>
                            <button onClick={() => previewAck(row)}
                                className="p-1.5 rounded-lg bg-gray-50 text-gray-500 hover:bg-gray-100 transition-colors" title="Preview">
                                <EyeIcon className="h-4 w-4" />
                            </button>
                            <button onClick={() => printAck(row)}
                                className="p-1.5 rounded-lg bg-blue-50 text-blue-600 hover:bg-blue-100 transition-colors" title="Print">
                                <PrinterIcon className="h-4 w-4" />
                            </button>
                        </>
                    )}
                </div>
            ),
        },
    ];

    const pendingMineCount = mine.filter(m => m.status === 'PENDING_ACK').length;
    const needsApprovalCount = all.filter(a => a.status === 'ACKNOWLEDGED').length;

    return (
        <div>
            <PageHeader
                title="Payment Acknowledgements"
                subtitle="Confirm money you've received — dividends, service fee payments, and reimbursements"
            />

            {error && <div className="mb-4"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}

            <div className="flex gap-2 mb-6 flex-wrap">
                <button onClick={() => setActiveTab('mine')}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                        activeTab === 'mine' ? 'bg-primary-700 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}>
                    My Acknowledgements
                    {pendingMineCount > 0 && (
                        <span className={`text-xs px-1.5 py-0.5 rounded-full font-bold ${
                            activeTab === 'mine' ? 'bg-white text-primary-700' : 'bg-red-500 text-white'
                        }`}>{pendingMineCount}</span>
                    )}
                </button>
                {canViewAll && (
                    <button onClick={() => setActiveTab('all')}
                        className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                            activeTab === 'all' ? 'bg-primary-700 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                        }`}>
                        All (Treasury)
                        {needsApprovalCount > 0 && (
                            <span className={`text-xs px-1.5 py-0.5 rounded-full font-bold ${
                                activeTab === 'all' ? 'bg-white text-primary-700' : 'bg-red-500 text-white'
                            }`}>{needsApprovalCount}</span>
                        )}
                    </button>
                )}
            </div>

            {activeTab === 'mine' && (
                <DataTable
                    columns={myColumns}
                    data={mine}
                    loading={loading}
                    emptyMessage="You have no payment acknowledgements yet"
                    searchable
                    searchPlaceholder="Search my acknowledgements..."
                />
            )}

            {activeTab === 'all' && canViewAll && (
                <>
                    <div className="card mb-6">
                        <div className="flex gap-2 flex-wrap">
                            {['', 'PENDING_ACK', 'ACKNOWLEDGED', 'DISPUTED', 'FINAL_APPROVED'].map(s => (
                                <button key={s}
                                    onClick={() => setStatusFilter(s)}
                                    className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                                        statusFilter === s
                                            ? 'bg-primary-700 text-white'
                                            : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                                    }`}>
                                    {s ? s.replace(/_/g, ' ') : 'All'}
                                </button>
                            ))}
                        </div>
                    </div>
                    <DataTable
                        columns={allColumns}
                        data={all}
                        loading={loading}
                        emptyMessage="No payment acknowledgements found"
                        searchable
                        searchPlaceholder="Search all acknowledgements..."
                    />
                </>
            )}

            <AcknowledgeModal
                isOpen={!!acknowledging}
                ack={acknowledging}
                onClose={() => setAcknowledging(null)}
                onSuccess={handleSuccess}
            />
            <DisputeModal
                isOpen={!!disputing}
                ack={disputing}
                onClose={() => setDisputing(null)}
                onSuccess={handleSuccess}
            />
            <ConfirmModal
                isOpen={!!approving}
                title="Give final approval?"
                message={approving ? `Confirms ${amountStr(approving.amount, approving.currency_code)} to ${approving.recipient_name} as fully acknowledged. A printable document becomes available.` : ''}
                confirmLabel="Final Approve"
                loading={actionLoading}
                onConfirm={handleFinalApprove}
                onCancel={() => setApproving(null)}
            />
            <ConfirmModal
                isOpen={!!reopening}
                title="Reopen this disputed acknowledgement?"
                message={reopening ? `Puts it back to Pending so ${reopening.recipient_name} can review and acknowledge it again. Only do this once the issue in their dispute reason has actually been sorted out.` : ''}
                confirmLabel="Reopen"
                loading={actionLoading}
                onConfirm={handleReopen}
                onCancel={() => setReopening(null)}
            />
        </div>
    );
};

export default PaymentAcknowledgementsPage;
