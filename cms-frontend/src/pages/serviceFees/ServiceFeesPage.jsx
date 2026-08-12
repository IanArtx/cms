// ============================================================
// SERVICE FEES PAGE (v1.21.0)
//
// One page, two very different views depending on who's looking:
//   - Everyone (self-service): their own service fee agreement,
//     payment history, and a way to request/track expense
//     reimbursements. Most people will simply see an empty state
//     here — this is specifically for contracted staff like the
//     Administrative Officer role, not every member.
//   - Admin: create/edit service fee agreements for a contracted
//     person, and record monthly payments.
//   - Treasurer/Assistant Treasurer: review and approve/reject
//     reimbursement requests (the actual money movement).
//
// Deliberately called "service fee", never "salary"/"payroll" — see
// serviceFeesController.js's header comment for why.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { serviceFeesAPI, accountsAPI, categoriesAPI, usersAPI } from '../../api/endpoints';
import { formatDate, getErrorMessage } from '../../utils/helpers';
import PageHeader from '../../components/common/PageHeader';
import DataTable from '../../components/common/DataTable';
import ErrorMessage from '../../components/common/ErrorMessage';
import StatusBadge from '../../components/common/StatusBadge';
import { useAuth } from '../../contexts/AuthContext';
import { PlusIcon, CheckIcon, XMarkIcon, BanknotesIcon, ArrowDownTrayIcon, PencilIcon, NoSymbolIcon } from '@heroicons/react/24/outline';

const SERVICE_FEE_CATEGORY_HINT = 'Service Fees';

// ============================================================
// CREATE / AMEND AGREEMENT MODAL (Admin)
// Doubles as both "New Agreement" (editingAgreement is null) and
// "Amend Agreement" (editingAgreement set) — the two forms are
// nearly identical, and updateAgreement on the backend accepts the
// same fields create does (minus who it's for and when it started,
// which don't change once an agreement exists).
//
// No currency field — an account can only ever hold one currency,
// so the paying account you pick IS the currency, shown read-only
// underneath the account select. The backend derives currency_id
// from account_id itself; nothing here needs to send it.
// ============================================================
const CreateAgreementModal = ({ isOpen, onClose, onSuccess, users, accounts, categories, editingAgreement }) => {
    const isEdit = !!editingAgreement;
    const [form, setForm] = useState({
        user_id: '', monthly_amount: '', account_id: '',
        category_id: '', start_date: '', notes: '',
    });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (editingAgreement) {
            setForm({
                user_id: String(editingAgreement.user_id || ''),
                monthly_amount: String(editingAgreement.monthly_amount || ''),
                account_id: String(editingAgreement.account_id || ''),
                category_id: String(editingAgreement.category_id || ''),
                start_date: editingAgreement.start_date ? editingAgreement.start_date.slice(0, 10) : '',
                notes: editingAgreement.notes || '',
            });
        } else {
            setForm({ user_id: '', monthly_amount: '', account_id: '', category_id: '', start_date: '', notes: '' });
        }
    }, [editingAgreement, isOpen]);

    if (!isOpen) return null;

    const selectedAccount = accounts.find(a => String(a.id) === String(form.account_id));

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            if (isEdit) {
                await serviceFeesAPI.updateAgreement(editingAgreement.id, {
                    monthly_amount: parseFloat(form.monthly_amount),
                    account_id: parseInt(form.account_id),
                    category_id: parseInt(form.category_id),
                    notes: form.notes,
                });
            } else {
                await serviceFeesAPI.createAgreement({
                    user_id: parseInt(form.user_id),
                    monthly_amount: parseFloat(form.monthly_amount),
                    account_id: parseInt(form.account_id),
                    category_id: parseInt(form.category_id),
                    start_date: form.start_date,
                    notes: form.notes,
                });
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
                <div className="relative bg-white rounded-xl shadow-xl max-w-lg w-full p-6 max-h-screen overflow-y-auto">
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">
                        {isEdit ? 'Amend Service Fee Agreement' : 'New Service Fee Agreement'}
                    </h2>
                    <p className="text-sm text-gray-400 mb-4">
                        {isEdit
                            ? `${editingAgreement.user_name} — changes apply from your next save, past payments are untouched.`
                            : 'Sets up a recurring monthly service fee for a contracted person — not payroll, a contracted-service arrangement.'}
                    </p>
                    {error && <div className="mb-4"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        {isEdit ? (
                            <div>
                                <label className="label">Contracted Person</label>
                                <p className="text-sm text-gray-700 bg-gray-50 rounded-lg px-3 py-2">{editingAgreement.user_name}</p>
                            </div>
                        ) : (
                            <div>
                                <label className="label">Contracted Person *</label>
                                <select className="input" value={form.user_id}
                                    onChange={e => setForm(p => ({ ...p, user_id: e.target.value }))} required>
                                    <option value="">Select person...</option>
                                    {users.map(u => (
                                        <option key={u.id} value={u.id}>{u.first_name} {u.last_name} ({u.email})</option>
                                    ))}
                                </select>
                            </div>
                        )}
                        <div>
                            <label className="label">Monthly Amount *</label>
                            <input type="number" className="input" min="0.01" step="0.01"
                                value={form.monthly_amount}
                                onChange={e => setForm(p => ({ ...p, monthly_amount: e.target.value }))} required />
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="label">Paying Account *</label>
                                <select className="input" value={form.account_id}
                                    onChange={e => setForm(p => ({ ...p, account_id: e.target.value }))} required>
                                    <option value="">Select account...</option>
                                    {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                                </select>
                                <p className="text-xs text-gray-400 mt-1">
                                    Currency: {selectedAccount ? selectedAccount.currency_code : 'select an account'}
                                </p>
                            </div>
                            <div>
                                <label className="label">Category *</label>
                                <select className="input" value={form.category_id}
                                    onChange={e => setForm(p => ({ ...p, category_id: e.target.value }))} required>
                                    <option value="">Select...</option>
                                    {categories.filter(c => c.module === 'FINANCE').map(c => (
                                        <option key={c.id} value={c.id}>{c.full_path || c.name}</option>
                                    ))}
                                </select>
                            </div>
                        </div>
                        {isEdit ? (
                            <div>
                                <label className="label">Start Date</label>
                                <p className="text-sm text-gray-700 bg-gray-50 rounded-lg px-3 py-2">{formatDate(editingAgreement.start_date)}</p>
                            </div>
                        ) : (
                            <div>
                                <label className="label">Start Date *</label>
                                <input type="date" className="input" value={form.start_date}
                                    onChange={e => setForm(p => ({ ...p, start_date: e.target.value }))} required />
                            </div>
                        )}
                        <div>
                            <label className="label">Notes</label>
                            <textarea className="input" rows={2} value={form.notes}
                                onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} />
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading} className="btn-primary">
                                {loading ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Agreement'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// TERMINATE AGREEMENT MODAL (Admin)
// A focused action rather than routing termination through the
// general amend form — ending an agreement needs exactly one extra
// fact (the end date) and should read as a deliberate, distinct step.
// ============================================================
const TerminateAgreementModal = ({ isOpen, agreement, onClose, onSuccess }) => {
    const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 10));
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    if (!isOpen || !agreement) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await serviceFeesAPI.updateAgreement(agreement.id, { status: 'ENDED', end_date: endDate });
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
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">Terminate Agreement</h2>
                    <p className="text-sm text-gray-400 mb-4">
                        {agreement.user_name} — no further monthly payments can be recorded against this agreement once ended.
                    </p>
                    {error && <div className="mb-4"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">End Date *</label>
                            <input type="date" className="input" value={endDate}
                                onChange={e => setEndDate(e.target.value)} required />
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading} className="btn-danger">
                                {loading ? 'Terminating...' : 'Terminate Agreement'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// RECORD PAYMENT MODAL (Treasurer/Admin)
// ============================================================
const RecordPaymentModal = ({ isOpen, agreement, onClose, onSuccess }) => {
    const [form, setForm] = useState({ amount: '', payment_date: '', notes: '' });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    if (!isOpen || !agreement) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await serviceFeesAPI.recordPayment(agreement.id, {
                amount: form.amount ? parseFloat(form.amount) : undefined,
                payment_date: form.payment_date || undefined,
                notes: form.notes || undefined,
            });
            onSuccess();
            onClose();
            setForm({ amount: '', payment_date: '', notes: '' });
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
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">Record Payment</h2>
                    <p className="text-sm text-gray-400 mb-4">{agreement.user_name} — {agreement.monthly_amount} {agreement.currency_code}/month</p>
                    {error && <div className="mb-4"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">Amount <span className="text-gray-400 font-normal">(leave blank for the standard monthly amount)</span></label>
                            <input type="number" className="input" min="0.01" step="0.01"
                                placeholder={agreement.monthly_amount}
                                value={form.amount} onChange={e => setForm(p => ({ ...p, amount: e.target.value }))} />
                        </div>
                        <div>
                            <label className="label">Payment Date</label>
                            <input type="date" className="input" value={form.payment_date}
                                max={new Date().toISOString().slice(0, 10)}
                                onChange={e => setForm(p => ({ ...p, payment_date: e.target.value }))} />
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
// REQUEST REIMBURSEMENT MODAL (self-service)
// ============================================================
const RequestReimbursementModal = ({ isOpen, onClose, onSuccess, currencies, categories }) => {
    const [form, setForm] = useState({ amount: '', currency_id: '', category_id: '', description: '', expense_date: '' });
    const [receipt, setReceipt] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    if (!isOpen) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            const data = new FormData();
            data.append('amount', form.amount);
            data.append('currency_id', form.currency_id);
            data.append('category_id', form.category_id);
            data.append('description', form.description);
            data.append('expense_date', form.expense_date);
            if (receipt) data.append('receipt', receipt);
            await serviceFeesAPI.requestReimbursement(data);
            onSuccess();
            onClose();
            setForm({ amount: '', currency_id: '', category_id: '', description: '', expense_date: '' });
            setReceipt(null);
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
                <div className="relative bg-white rounded-xl shadow-xl max-w-lg w-full p-6 max-h-screen overflow-y-auto">
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">Request Expense Reimbursement</h2>
                    <p className="text-sm text-gray-400 mb-4">
                        For expenses tied to company matters that needed financing — a Treasurer will review and pay this once approved.
                    </p>
                    {error && <div className="mb-4"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="label">Amount *</label>
                                <input type="number" className="input" min="0.01" step="0.01"
                                    value={form.amount} onChange={e => setForm(p => ({ ...p, amount: e.target.value }))} required />
                            </div>
                            <div>
                                <label className="label">Currency *</label>
                                <select className="input" value={form.currency_id}
                                    onChange={e => setForm(p => ({ ...p, currency_id: e.target.value }))} required>
                                    <option value="">Select...</option>
                                    {currencies.map(c => <option key={c.id} value={c.id}>{c.code}</option>)}
                                </select>
                            </div>
                        </div>
                        <div>
                            <label className="label">Category *</label>
                            <select className="input" value={form.category_id}
                                onChange={e => setForm(p => ({ ...p, category_id: e.target.value }))} required>
                                <option value="">Select...</option>
                                {categories.filter(c => c.module === 'FINANCE').map(c => (
                                    <option key={c.id} value={c.id}>{c.full_path || c.name}</option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label className="label">Expense Date *</label>
                            <input type="date" className="input" value={form.expense_date}
                                max={new Date().toISOString().slice(0, 10)}
                                onChange={e => setForm(p => ({ ...p, expense_date: e.target.value }))} required />
                        </div>
                        <div>
                            <label className="label">Description *</label>
                            <textarea className="input" rows={3} value={form.description}
                                placeholder="What was this expense for?"
                                onChange={e => setForm(p => ({ ...p, description: e.target.value }))} required />
                        </div>
                        <div>
                            <label className="label">Receipt <span className="text-gray-400 font-normal">(optional)</span></label>
                            <input type="file" className="input" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                                onChange={e => setReceipt(e.target.files?.[0] || null)} />
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading} className="btn-primary">
                                {loading ? 'Submitting...' : 'Submit Request'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// APPROVE REIMBURSEMENT MODAL (Treasurer)
// ============================================================
const ApproveReimbursementModal = ({ isOpen, reimbursement, onClose, onSuccess, accounts }) => {
    const [accountId, setAccountId] = useState('');
    const [notes, setNotes] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    if (!isOpen || !reimbursement) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await serviceFeesAPI.approveReimbursement(reimbursement.id, {
                account_id: parseInt(accountId), review_notes: notes || undefined,
            });
            onSuccess();
            onClose();
            setAccountId(''); setNotes('');
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
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">Approve Reimbursement</h2>
                    <div className="bg-gray-50 rounded-lg p-3 mb-4">
                        <p className="text-sm font-medium text-gray-900">{reimbursement.user_name}</p>
                        <p className="text-xs text-gray-500 mt-0.5">{reimbursement.description}</p>
                        <p className="text-sm font-bold text-primary-700 mt-2">
                            {parseFloat(reimbursement.amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                        </p>
                    </div>
                    {error && <div className="mb-4"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">Pay From Account *</label>
                            <select className="input" value={accountId}
                                onChange={e => setAccountId(e.target.value)} required>
                                <option value="">Select account...</option>
                                {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                            </select>
                        </div>
                        <div>
                            <label className="label">Notes</label>
                            <textarea className="input" rows={2} value={notes} onChange={e => setNotes(e.target.value)} />
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading} className="btn-primary">
                                {loading ? 'Processing...' : 'Approve & Pay'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// REJECT REIMBURSEMENT MODAL (Treasurer)
// ============================================================
const RejectReimbursementModal = ({ isOpen, reimbursement, onClose, onSuccess }) => {
    const [reason, setReason] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    if (!isOpen || !reimbursement) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await serviceFeesAPI.rejectReimbursement(reimbursement.id, { review_notes: reason });
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
                    <h2 className="text-lg font-semibold text-gray-900 mb-4">Reject Reimbursement</h2>
                    {error && <div className="mb-4"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">Reason *</label>
                            <textarea className="input" rows={3} value={reason}
                                onChange={e => setReason(e.target.value)} required />
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading} className="btn-danger">
                                {loading ? 'Rejecting...' : 'Reject'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// MAIN SERVICE FEES PAGE
// ============================================================
const ServiceFeesPage = () => {
    const { hasRole } = useAuth();
    // Viewing the Agreements tab and recording a monthly payment is a
    // Treasurer duty too (same as everywhere else money moves) — only
    // creating/editing the agreement itself is Admin-only, matching the
    // backend's own requireRoles split in routes/serviceFees.js.
    const canViewAgreements = hasRole(['Admin', 'Treasurer', 'Assistant Treasurer']);
    const canManageAgreements = hasRole('Admin');
    const canReviewReimbursements = hasRole(['Treasurer', 'Assistant Treasurer']);

    const [activeTab, setActiveTab] = useState('mine');
    const [myAgreement, setMyAgreement] = useState(null);
    const [myReimbursements, setMyReimbursements] = useState([]);
    const [agreements, setAgreements] = useState([]);
    const [reimbursements, setReimbursements] = useState([]);
    const [users, setUsers] = useState([]);
    const [accounts, setAccounts] = useState([]);
    const [currencies, setCurrencies] = useState([]);
    const [categories, setCategories] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    const [showCreateAgreement, setShowCreateAgreement] = useState(false);
    const [editingAgreement, setEditingAgreement] = useState(null);
    const [terminatingAgreement, setTerminatingAgreement] = useState(null);
    const [payingAgreement, setPayingAgreement] = useState(null);
    const [showRequestReimbursement, setShowRequestReimbursement] = useState(false);
    const [approvingReimbursement, setApprovingReimbursement] = useState(null);
    const [rejectingReimbursement, setRejectingReimbursement] = useState(null);

    const loadMine = useCallback(async () => {
        try {
            setLoading(true);
            const [agRes, reimbRes] = await Promise.all([
                serviceFeesAPI.getMyAgreement(),
                serviceFeesAPI.getMyReimbursements(),
            ]);
            setMyAgreement(agRes.data.data);
            setMyReimbursements(reimbRes.data.data || []);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, []);

    const loadAgreements = useCallback(async () => {
        if (!canViewAgreements) return;
        try {
            const res = await serviceFeesAPI.listAgreements();
            setAgreements(res.data.data || []);
        } catch (err) {
            setError(getErrorMessage(err));
        }
    }, [canViewAgreements]);

    const loadReimbursements = useCallback(async () => {
        if (!canReviewReimbursements) return;
        try {
            const res = await serviceFeesAPI.listReimbursements();
            setReimbursements(res.data.data || []);
        } catch (err) {
            setError(getErrorMessage(err));
        }
    }, [canReviewReimbursements]);

    useEffect(() => {
        loadMine();
        loadAgreements();
        loadReimbursements();
        accountsAPI.getAll().then(r => setAccounts(r.data.data || [])).catch(() => {});
        accountsAPI.getCurrencies().then(r => setCurrencies(r.data.data || [])).catch(() => {});
        categoriesAPI.getAll({ flat: true }).then(r => setCategories(r.data.data || [])).catch(() => {});
        if (canManageAgreements) {
            usersAPI.getAllUsers().then(r => setUsers(r.data.data || [])).catch(() => {});
        }
    }, [loadMine, loadAgreements, loadReimbursements, canManageAgreements]);

    const handleSuccess = () => {
        loadMine();
        loadAgreements();
        loadReimbursements();
    };

    const pendingReimbCount = reimbursements.filter(r => r.status === 'PENDING').length;

    const myReimbColumns = [
        { header: 'Reference', render: row => <span className="font-mono text-xs">{row.reference_code}</span> },
        { header: 'Description', render: row => <span className="text-sm text-gray-700">{row.description}</span> },
        { header: 'Amount', render: row => <span className="text-sm font-bold text-gray-900">{parseFloat(row.amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}</span> },
        { header: 'Expense Date', render: row => <span className="text-sm text-gray-500">{formatDate(row.expense_date)}</span> },
        { header: 'Status', render: row => <StatusBadge status={row.status} /> },
        { header: 'Notes', render: row => <span className="text-xs text-gray-500">{row.review_notes || '—'}</span> },
    ];

    const agreementColumns = [
        { header: 'Person', render: row => <span className="text-sm font-medium text-gray-900">{row.user_name}</span> },
        { header: 'Monthly Fee', render: row => <span className="text-sm font-bold text-gray-900">{parseFloat(row.monthly_amount).toLocaleString('en-US', { maximumFractionDigits: 2 })} {row.currency_code}</span> },
        { header: 'Account', render: row => <span className="text-sm text-gray-500">{row.account_name}</span> },
        { header: 'Last Paid', render: row => <span className="text-sm text-gray-500">{row.last_paid_date ? formatDate(row.last_paid_date) : 'Never'}</span> },
        { header: 'Status', render: row => <StatusBadge status={row.status} /> },
        {
            header: 'Actions',
            render: row => (
                <div className="flex gap-2">
                    {row.status === 'ACTIVE' && (
                        <button onClick={() => setPayingAgreement(row)}
                            className="p-1.5 rounded-lg bg-green-50 text-green-600 hover:bg-green-100 transition-colors"
                            title="Record Payment">
                            <BanknotesIcon className="h-4 w-4" />
                        </button>
                    )}
                    {canManageAgreements && (
                        <button onClick={() => { setEditingAgreement(row); setShowCreateAgreement(true); }}
                            className="p-1.5 rounded-lg bg-blue-50 text-blue-600 hover:bg-blue-100 transition-colors"
                            title="Amend Agreement">
                            <PencilIcon className="h-4 w-4" />
                        </button>
                    )}
                    {canManageAgreements && row.status === 'ACTIVE' && (
                        <button onClick={() => setTerminatingAgreement(row)}
                            className="p-1.5 rounded-lg bg-red-50 text-red-600 hover:bg-red-100 transition-colors"
                            title="Terminate Agreement">
                            <NoSymbolIcon className="h-4 w-4" />
                        </button>
                    )}
                </div>
            ),
        },
    ];

    const reimbColumns = [
        { header: 'Reference', render: row => <span className="font-mono text-xs">{row.reference_code}</span> },
        { header: 'Person', render: row => <span className="text-sm font-medium text-gray-900">{row.user_name}</span> },
        { header: 'Description', render: row => <span className="text-sm text-gray-700">{row.description}</span> },
        { header: 'Amount', render: row => <span className="text-sm font-bold text-gray-900">{parseFloat(row.amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}</span> },
        { header: 'Expense Date', render: row => <span className="text-sm text-gray-500">{formatDate(row.expense_date)}</span> },
        { header: 'Status', render: row => <StatusBadge status={row.status} /> },
        {
            header: 'Actions',
            render: row => row.status === 'PENDING' && (
                <div className="flex gap-2">
                    <button onClick={() => setApprovingReimbursement(row)}
                        className="p-1.5 rounded-lg bg-green-50 text-green-600 hover:bg-green-100 transition-colors" title="Approve">
                        <CheckIcon className="h-4 w-4" />
                    </button>
                    <button onClick={() => setRejectingReimbursement(row)}
                        className="p-1.5 rounded-lg bg-red-50 text-red-600 hover:bg-red-100 transition-colors" title="Reject">
                        <XMarkIcon className="h-4 w-4" />
                    </button>
                    {row.receipt_file_name && (
                        <a href={`/api/service-fees/reimbursements/${row.id}/receipt`} target="_blank" rel="noreferrer"
                            className="p-1.5 rounded-lg bg-gray-50 text-gray-500 hover:bg-gray-100 transition-colors" title="View Receipt">
                            <ArrowDownTrayIcon className="h-4 w-4" />
                        </a>
                    )}
                </div>
            ),
        },
    ];

    return (
        <div>
            <PageHeader
                title="Service Fees"
                subtitle="Contracted-staff monthly fees and expense reimbursements"
                actions={
                    activeTab === 'mine' ? (
                        <button onClick={() => setShowRequestReimbursement(true)} className="btn-primary flex items-center gap-2">
                            <PlusIcon className="h-4 w-4" /> Request Reimbursement
                        </button>
                    ) : activeTab === 'agreements' && canManageAgreements ? (
                        <button onClick={() => { setEditingAgreement(null); setShowCreateAgreement(true); }} className="btn-primary flex items-center gap-2">
                            <PlusIcon className="h-4 w-4" /> New Agreement
                        </button>
                    ) : null
                }
            />

            {error && <div className="mb-4"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}

            <div className="flex gap-2 mb-6 flex-wrap">
                <button onClick={() => setActiveTab('mine')}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                        activeTab === 'mine' ? 'bg-primary-700 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}>
                    My Service Fee
                </button>
                {canViewAgreements && (
                    <button onClick={() => setActiveTab('agreements')}
                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                            activeTab === 'agreements' ? 'bg-primary-700 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                        }`}>
                        Agreements
                    </button>
                )}
                {canReviewReimbursements && (
                    <button onClick={() => setActiveTab('reimbursements')}
                        className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                            activeTab === 'reimbursements' ? 'bg-primary-700 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                        }`}>
                        Reimbursement Requests
                        {pendingReimbCount > 0 && (
                            <span className={`text-xs px-1.5 py-0.5 rounded-full font-bold ${
                                activeTab === 'reimbursements' ? 'bg-white text-primary-700' : 'bg-red-500 text-white'
                            }`}>{pendingReimbCount}</span>
                        )}
                    </button>
                )}
            </div>

            {activeTab === 'mine' && (
                <div className="space-y-6">
                    <div className="card">
                        <h3 className="text-sm font-semibold text-gray-900 mb-3">My Service Fee Agreement</h3>
                        {myAgreement ? (
                            <div>
                                <p className="text-2xl font-bold text-primary-700">
                                    {parseFloat(myAgreement.monthly_amount).toLocaleString('en-US', { maximumFractionDigits: 2 })} {myAgreement.currency_code}
                                    <span className="text-sm font-normal text-gray-400"> / month</span>
                                </p>
                                <p className="text-xs text-gray-400 mt-1">
                                    Since {formatDate(myAgreement.start_date)} · <StatusBadge status={myAgreement.status} />
                                </p>
                                {myAgreement.payments?.length > 0 && (
                                    <div className="mt-4">
                                        <p className="text-xs font-semibold text-gray-500 mb-2">Payment History</p>
                                        <ul className="space-y-1">
                                            {myAgreement.payments.map((p, i) => (
                                                <li key={i} className="text-sm text-gray-600 flex justify-between">
                                                    <span>{formatDate(p.payment_date)} {p.reference_code && `— ${p.reference_code}`}</span>
                                                    <span className="font-medium">{parseFloat(p.amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                )}
                            </div>
                        ) : (
                            <p className="text-sm text-gray-400">No service fee agreement is set up for your account.</p>
                        )}
                    </div>

                    <div>
                        <h3 className="text-sm font-semibold text-gray-900 mb-3">My Reimbursement Requests</h3>
                        <DataTable
                            columns={myReimbColumns}
                            data={myReimbursements}
                            loading={loading}
                            emptyMessage="You have no reimbursement requests yet"
                        />
                    </div>
                </div>
            )}

            {activeTab === 'agreements' && canViewAgreements && (
                <DataTable
                    columns={agreementColumns}
                    data={agreements}
                    loading={loading}
                    emptyMessage="No service fee agreements yet"
                    searchable
                    searchPlaceholder="Search agreements..."
                />
            )}

            {activeTab === 'reimbursements' && canReviewReimbursements && (
                <DataTable
                    columns={reimbColumns}
                    data={reimbursements}
                    loading={loading}
                    emptyMessage="No reimbursement requests found"
                    searchable
                    searchPlaceholder="Search reimbursement requests..."
                />
            )}

            <CreateAgreementModal
                isOpen={showCreateAgreement}
                onClose={() => { setShowCreateAgreement(false); setEditingAgreement(null); }}
                onSuccess={handleSuccess}
                users={users} accounts={accounts} categories={categories}
                editingAgreement={editingAgreement}
            />
            <TerminateAgreementModal
                isOpen={!!terminatingAgreement}
                agreement={terminatingAgreement}
                onClose={() => setTerminatingAgreement(null)}
                onSuccess={handleSuccess}
            />
            <RecordPaymentModal
                isOpen={!!payingAgreement}
                agreement={payingAgreement}
                onClose={() => setPayingAgreement(null)}
                onSuccess={handleSuccess}
            />
            <RequestReimbursementModal
                isOpen={showRequestReimbursement}
                onClose={() => setShowRequestReimbursement(false)}
                onSuccess={handleSuccess}
                currencies={currencies} categories={categories}
            />
            <ApproveReimbursementModal
                isOpen={!!approvingReimbursement}
                reimbursement={approvingReimbursement}
                onClose={() => setApprovingReimbursement(null)}
                onSuccess={handleSuccess}
                accounts={accounts}
            />
            <RejectReimbursementModal
                isOpen={!!rejectingReimbursement}
                reimbursement={rejectingReimbursement}
                onClose={() => setRejectingReimbursement(null)}
                onSuccess={handleSuccess}
            />
        </div>
    );
};

export default ServiceFeesPage;
