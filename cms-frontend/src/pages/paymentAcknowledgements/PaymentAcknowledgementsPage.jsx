// ============================================================
// PAYMENT ACKNOWLEDGEMENTS PAGE (v1.30.0, Section 4.35; Payment
// Confirmations tab added v1.39.0)
//
// One page, three views, same "everyone (self-service) + Treasury
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
//
// v1.39.0 — the "Payment Confirmations" tab is the opposite order:
// Treasury posts an entry FIRST (who was paid, how much, and how —
// Cash/Bank Transfer/Mobile Money), and the real transaction is only
// posted once the recipient confirms it. See
// paymentConfirmationsController.js for the full flow.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { paymentAcknowledgementsAPI, paymentConfirmationsAPI, usersAPI, accountsAPI, categoriesAPI } from '../../api/endpoints';
import { formatDate, getErrorMessage } from '../../utils/helpers';
import { paymentAcknowledgementTemplate, printDocument, previewDocument } from '../../utils/exportUtils';
import PageHeader from '../../components/common/PageHeader';
import DataTable from '../../components/common/DataTable';
import ErrorMessage from '../../components/common/ErrorMessage';
import StatusBadge from '../../components/common/StatusBadge';
import ConfirmModal from '../../components/common/ConfirmModal';
import { useAuth } from '../../contexts/AuthContext';
import { CheckIcon, XMarkIcon, PrinterIcon, ArrowPathIcon, EyeIcon, PlusIcon, NoSymbolIcon } from '@heroicons/react/24/outline';

const SOURCE_LABELS = {
    DIVIDEND:            'Dividend Payment',
    SERVICE_FEE_PAYMENT: 'Service Fee Payment',
    REIMBURSEMENT:       'Expense Reimbursement',
    SAVINGS_HANDOUT:     'Savings Handout',
    SIDE_FUND_PAYOUT:    'Side Fund Exit Payout',
};

const CONFIRMATION_SOURCE_LABELS = {
    GENERAL_PAYMENT:     'General Payment',
    SERVICE_FEE_PAYMENT: 'Service Fee Payment',
};

const PAYMENT_METHOD_LABELS = {
    CASH:          'Cash',
    BANK_TRANSFER: 'Bank Transfer',
    MOBILE_MONEY:  'Mobile Money',
};

const methodDetail = (row) => {
    if (row.payment_method === 'CASH') return 'Cash';
    if (row.payment_method === 'MOBILE_MONEY') return `Mobile Money (${row.mobile_money_provider}) — ${row.external_reference}`;
    return `Bank Transfer — ${row.external_reference}`;
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
// CREATE PAYMENT CONFIRMATION MODAL — Treasury/Admin (PAYMENT_ACK_MANAGE)
// General ad hoc payments only (GENERAL_PAYMENT) — service fee
// payments are created from ServiceFeesPage's own Record Payment
// modal instead, which uses this same payment-method shape.
// ============================================================
const CreatePaymentConfirmationModal = ({ isOpen, onClose, onSuccess, members, accounts, categories }) => {
    const BLANK = {
        recipient_id: '', account_id: '', category_id: '', amount: '', entry_date: '',
        payment_method: 'CASH', mobile_money_provider: '', external_reference: '', purpose: '',
    };
    const [form, setForm] = useState(BLANK);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (isOpen) {
            setForm({ ...BLANK, entry_date: new Date().toISOString().slice(0, 10) });
            setError(null);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen]);

    if (!isOpen) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await paymentConfirmationsAPI.create({
                ...form,
                amount: parseFloat(form.amount),
                mobile_money_provider: form.payment_method === 'MOBILE_MONEY' ? form.mobile_money_provider : undefined,
                external_reference: form.payment_method !== 'CASH' ? form.external_reference : undefined,
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
                <div className="relative bg-white rounded-xl shadow-xl max-w-lg w-full p-6">
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">Record a Payment</h2>
                    <p className="text-sm text-gray-400 mb-4">
                        Nothing posts to the ledger yet — the recipient must confirm they received this before
                        it becomes a real transaction.
                    </p>
                    {error && <div className="mb-4"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">Recipient *</label>
                            <select className="input" value={form.recipient_id}
                                onChange={e => setForm(p => ({ ...p, recipient_id: e.target.value }))} required>
                                <option value="">Select person...</option>
                                {members.map(m => (
                                    <option key={m.id} value={m.id}>{m.first_name} {m.last_name}</option>
                                ))}
                            </select>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="label">Account *</label>
                                <select className="input" value={form.account_id}
                                    onChange={e => setForm(p => ({ ...p, account_id: e.target.value }))} required>
                                    <option value="">Select account...</option>
                                    {accounts.map(a => (
                                        <option key={a.id} value={a.id}>{a.name} ({a.currency_code})</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className="label">Category *</label>
                                <select className="input" value={form.category_id}
                                    onChange={e => setForm(p => ({ ...p, category_id: e.target.value }))} required>
                                    <option value="">Select category...</option>
                                    {categories.map(c => (
                                        <option key={c.id} value={c.id}>{c.name}</option>
                                    ))}
                                </select>
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
                                <label className="label">Date *</label>
                                <input type="date" className="input" value={form.entry_date}
                                    max={new Date().toISOString().slice(0, 10)}
                                    onChange={e => setForm(p => ({ ...p, entry_date: e.target.value }))} required />
                            </div>
                        </div>
                        <div>
                            <label className="label">How was it paid? *</label>
                            <div className="flex gap-2">
                                {['CASH', 'BANK_TRANSFER', 'MOBILE_MONEY'].map(m => (
                                    <button key={m} type="button"
                                        onClick={() => setForm(p => ({ ...p, payment_method: m, mobile_money_provider: '', external_reference: '' }))}
                                        className={`flex-1 px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${
                                            form.payment_method === m ? 'border-primary-600 bg-primary-50 text-primary-700' : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                                        }`}>
                                        {PAYMENT_METHOD_LABELS[m]}
                                    </button>
                                ))}
                            </div>
                        </div>
                        {form.payment_method === 'MOBILE_MONEY' && (
                            <div>
                                <label className="label">Provider *</label>
                                <select className="input" value={form.mobile_money_provider}
                                    onChange={e => setForm(p => ({ ...p, mobile_money_provider: e.target.value }))} required>
                                    <option value="">Select provider...</option>
                                    <option value="MTN">MTN</option>
                                    <option value="AIRTEL">Airtel</option>
                                    <option value="OTHER">Other</option>
                                </select>
                            </div>
                        )}
                        {form.payment_method !== 'CASH' && (
                            <div>
                                <label className="label">Transaction ID *</label>
                                <input type="text" className="input" value={form.external_reference}
                                    onChange={e => setForm(p => ({ ...p, external_reference: e.target.value }))}
                                    placeholder="The reference/transaction ID from the transfer or mobile money receipt" required />
                            </div>
                        )}
                        <div>
                            <label className="label">Purpose *</label>
                            <textarea className="input" rows={2} value={form.purpose}
                                onChange={e => setForm(p => ({ ...p, purpose: e.target.value }))} required />
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
// CONFIRM PAYMENT MODAL (self-service — recipient confirms they were
// actually paid, exactly as stated)
// ============================================================
const ConfirmPaymentModal = ({ isOpen, entry, onClose, onSuccess }) => {
    const [note, setNote] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    if (!isOpen || !entry) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await paymentConfirmationsAPI.confirm(entry.id, { note: note || undefined });
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
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">Confirm You Received This</h2>
                    <div className="bg-gray-50 rounded-lg p-3 mb-4">
                        <p className="text-xs text-gray-400">{CONFIRMATION_SOURCE_LABELS[entry.source_type] || entry.source_type}</p>
                        <p className="text-lg font-bold text-primary-700">
                            {entry.currency_code} {parseFloat(entry.amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                        </p>
                        <p className="text-sm text-gray-600 mt-1">{entry.purpose}</p>
                        <p className="text-xs text-gray-500 mt-1">Paid via {methodDetail(entry)}</p>
                    </div>
                    <p className="text-sm text-gray-400 mb-4">
                        Confirming posts this as a real transaction immediately — only confirm if you actually
                        received it exactly as described above.
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
// DISPUTE PAYMENT MODAL (self-service — recipient flags a pending
// entry as wrong/never received; no transaction is ever posted)
// ============================================================
const DisputePaymentModal = ({ isOpen, entry, onClose, onSuccess }) => {
    const [reason, setReason] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    if (!isOpen || !entry) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await paymentConfirmationsAPI.dispute(entry.id, { reason });
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
                        No transaction is posted while this is disputed. Treasury will cancel this entry and
                        reissue a corrected one once it's sorted out.
                    </p>
                    {error && <div className="mb-4"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">Reason *</label>
                            <textarea className="input" rows={3} value={reason}
                                placeholder="What's wrong — never received it, wrong amount, something else?"
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

    // v1.39.0 — Payment Confirmations tab state
    const [myConfirmations, setMyConfirmations] = useState([]);
    const [allConfirmations, setAllConfirmations] = useState([]);
    const [confirmationStatusFilter, setConfirmationStatusFilter] = useState('');
    const [members, setMembers] = useState([]);
    const [accounts, setAccounts] = useState([]);
    const [categories, setCategories] = useState([]);
    const [showCreateConfirmation, setShowCreateConfirmation] = useState(false);
    const [confirming, setConfirming] = useState(null);
    const [disputingConfirmation, setDisputingConfirmation] = useState(null);
    const [cancelling, setCancelling] = useState(null);

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

    const loadMyConfirmations = useCallback(async () => {
        try {
            const res = await paymentConfirmationsAPI.getMine();
            setMyConfirmations(res.data.data || []);
        } catch (err) {
            setError(getErrorMessage(err));
        }
    }, []);

    const loadAllConfirmations = useCallback(async () => {
        if (!canViewAll) return;
        try {
            const params = {};
            if (confirmationStatusFilter) params.status = confirmationStatusFilter;
            const res = await paymentConfirmationsAPI.getAll(params);
            setAllConfirmations(res.data.data || []);
        } catch (err) {
            setError(getErrorMessage(err));
        }
    }, [canViewAll, confirmationStatusFilter]);

    useEffect(() => { loadMine(); }, [loadMine]);
    useEffect(() => { loadAll(); }, [loadAll]);
    useEffect(() => { loadMyConfirmations(); }, [loadMyConfirmations]);
    useEffect(() => { loadAllConfirmations(); }, [loadAllConfirmations]);

    useEffect(() => {
        if (canManage) {
            usersAPI.getAllUsers({ is_active: true, limit: 500 }).then(r => setMembers(r.data.data || [])).catch(() => {});
            accountsAPI.getAll().then(r => setAccounts(r.data.data || [])).catch(() => {});
            categoriesAPI.getAll({ module: 'FINANCE' }).then(r => setCategories(r.data.data || [])).catch(() => {});
        }
    }, [canManage]);

    const handleSuccess = () => { loadMine(); loadAll(); };
    const handleConfirmationSuccess = () => { loadMyConfirmations(); loadAllConfirmations(); };

    const handleCancelConfirmation = async () => {
        if (!cancelling) return;
        setActionLoading(true);
        try {
            await paymentConfirmationsAPI.cancel(cancelling.id, {});
            handleConfirmationSuccess();
            setCancelling(null);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setActionLoading(false);
        }
    };

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

    const myConfirmationColumns = [
        { header: 'Reference', render: row => <span className="font-mono text-xs">{row.reference_code}</span> },
        { header: 'Type', render: row => <span className="text-sm text-gray-700">{CONFIRMATION_SOURCE_LABELS[row.source_type] || row.source_type}</span> },
        { header: 'From', render: row => <span className="text-sm text-gray-500">{row.payer_name}</span> },
        { header: 'Paid Via', render: row => <span className="text-sm text-gray-600">{methodDetail(row)}</span> },
        { header: 'Purpose', render: row => <span className="text-sm text-gray-600 max-w-xs block truncate" title={row.purpose}>{row.purpose}</span> },
        { header: 'Amount', render: row => <span className="text-sm font-bold text-gray-900">{amountStr(row.amount, row.currency_code)}</span> },
        { header: 'Date', render: row => <span className="text-sm text-gray-500">{formatDate(row.entry_date)}</span> },
        { header: 'Status', render: row => <StatusBadge status={row.status} /> },
        {
            header: 'Actions',
            render: row => (
                <div className="flex gap-2">
                    {row.status === 'PENDING_CONFIRMATION' && (
                        <>
                            <button onClick={() => setConfirming(row)}
                                className="p-1.5 rounded-lg bg-green-50 text-green-600 hover:bg-green-100 transition-colors" title="Confirm">
                                <CheckIcon className="h-4 w-4" />
                            </button>
                            <button onClick={() => setDisputingConfirmation(row)}
                                className="p-1.5 rounded-lg bg-red-50 text-red-600 hover:bg-red-100 transition-colors" title="Dispute">
                                <XMarkIcon className="h-4 w-4" />
                            </button>
                        </>
                    )}
                </div>
            ),
        },
    ];

    const allConfirmationColumns = [
        { header: 'Reference', render: row => <span className="font-mono text-xs">{row.reference_code}</span> },
        { header: 'Type', render: row => <span className="text-sm text-gray-700">{CONFIRMATION_SOURCE_LABELS[row.source_type] || row.source_type}</span> },
        { header: 'Recipient', render: row => <span className="text-sm font-medium text-gray-900">{row.recipient_name}</span> },
        { header: 'Paid Via', render: row => <span className="text-sm text-gray-600">{methodDetail(row)}</span> },
        { header: 'Amount', render: row => <span className="text-sm font-bold text-gray-900">{amountStr(row.amount, row.currency_code)}</span> },
        { header: 'Date', render: row => <span className="text-sm text-gray-500">{formatDate(row.entry_date)}</span> },
        { header: 'Status', render: row => <StatusBadge status={row.status} /> },
        {
            header: 'Actions',
            render: row => (
                <div className="flex gap-2">
                    {(row.status === 'PENDING_CONFIRMATION' || row.status === 'DISPUTED') && canManage && (
                        <button onClick={() => setCancelling(row)}
                            className="p-1.5 rounded-lg bg-gray-50 text-gray-500 hover:bg-gray-100 transition-colors" title="Cancel entry">
                            <NoSymbolIcon className="h-4 w-4" />
                        </button>
                    )}
                </div>
            ),
        },
    ];

    const pendingMineCount = mine.filter(m => m.status === 'PENDING_ACK').length;
    const needsApprovalCount = all.filter(a => a.status === 'ACKNOWLEDGED').length;
    const pendingMyConfirmationsCount = myConfirmations.filter(m => m.status === 'PENDING_CONFIRMATION').length;

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
                <button onClick={() => setActiveTab('confirmations')}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                        activeTab === 'confirmations' ? 'bg-primary-700 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}>
                    Payment Confirmations
                    {pendingMyConfirmationsCount > 0 && (
                        <span className={`text-xs px-1.5 py-0.5 rounded-full font-bold ${
                            activeTab === 'confirmations' ? 'bg-white text-primary-700' : 'bg-red-500 text-white'
                        }`}>{pendingMyConfirmationsCount}</span>
                    )}
                </button>
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

            {activeTab === 'confirmations' && (
                <>
                    <div className="flex justify-between items-center mb-4">
                        <h2 className="text-sm font-semibold text-gray-700">Awaiting My Confirmation / My History</h2>
                        {canManage && (
                            <button onClick={() => setShowCreateConfirmation(true)} className="btn-primary flex items-center gap-2">
                                <PlusIcon className="h-4 w-4" />
                                New Payment
                            </button>
                        )}
                    </div>
                    <DataTable
                        columns={myConfirmationColumns}
                        data={myConfirmations}
                        loading={loading}
                        emptyMessage="You have no payment entries yet"
                        searchable
                        searchPlaceholder="Search my payment entries..."
                    />

                    {canViewAll && (
                        <div className="mt-8">
                            <h2 className="text-sm font-semibold text-gray-700 mb-4">All Payment Entries (Treasury)</h2>
                            <div className="card mb-6">
                                <div className="flex gap-2 flex-wrap">
                                    {['', 'PENDING_CONFIRMATION', 'CONFIRMED', 'DISPUTED', 'CANCELLED'].map(s => (
                                        <button key={s}
                                            onClick={() => setConfirmationStatusFilter(s)}
                                            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                                                confirmationStatusFilter === s
                                                    ? 'bg-primary-700 text-white'
                                                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                                            }`}>
                                            {s ? s.replace(/_/g, ' ') : 'All'}
                                        </button>
                                    ))}
                                </div>
                            </div>
                            <DataTable
                                columns={allConfirmationColumns}
                                data={allConfirmations}
                                loading={loading}
                                emptyMessage="No payment entries found"
                                searchable
                                searchPlaceholder="Search all payment entries..."
                            />
                        </div>
                    )}
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

            <CreatePaymentConfirmationModal
                isOpen={showCreateConfirmation}
                onClose={() => setShowCreateConfirmation(false)}
                onSuccess={handleConfirmationSuccess}
                members={members}
                accounts={accounts}
                categories={categories}
            />
            <ConfirmPaymentModal
                isOpen={!!confirming}
                entry={confirming}
                onClose={() => setConfirming(null)}
                onSuccess={handleConfirmationSuccess}
            />
            <DisputePaymentModal
                isOpen={!!disputingConfirmation}
                entry={disputingConfirmation}
                onClose={() => setDisputingConfirmation(null)}
                onSuccess={handleConfirmationSuccess}
            />
            <ConfirmModal
                isOpen={!!cancelling}
                title="Cancel this payment entry?"
                message={cancelling ? `Cancels the ${amountStr(cancelling.amount, cancelling.currency_code)} entry to ${cancelling.recipient_name}. It will never become a transaction — record a fresh corrected entry if needed.` : ''}
                confirmLabel="Cancel Entry"
                loading={actionLoading}
                onConfirm={handleCancelConfirmation}
                onCancel={() => setCancelling(null)}
            />
        </div>
    );
};

export default PaymentAcknowledgementsPage;
