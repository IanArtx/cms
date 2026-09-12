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
import { Link } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { serviceFeesAPI, accountsAPI, categoriesAPI, usersAPI } from '../../api/endpoints';
import { formatDate, getErrorMessage } from '../../utils/helpers';
import PageHeader from '../../components/common/PageHeader';
import DataTable from '../../components/common/DataTable';
import ErrorMessage from '../../components/common/ErrorMessage';
import StatusBadge from '../../components/common/StatusBadge';
import { useAuth } from '../../contexts/AuthContext';
import useChartTheme from '../../hooks/useChartTheme';
import { PlusIcon, CheckIcon, XMarkIcon, BanknotesIcon, ArrowDownTrayIcon, PencilIcon, NoSymbolIcon, HandRaisedIcon, ClockIcon } from '@heroicons/react/24/outline';

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
export const CreateAgreementModal = ({ isOpen, onClose, onSuccess, users, accounts, categories, editingAgreement }) => {
    const isEdit = !!editingAgreement;
    const [form, setForm] = useState({
        user_id: '', monthly_amount: '', account_id: '',
        category_id: '', start_date: '', notes: '', payment_day: '',
        reason: '', effective_from: '',
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
                payment_day: String(editingAgreement.payment_day || ''),
                reason: '', effective_from: '',
            });
        } else {
            setForm({ user_id: '', monthly_amount: '', account_id: '', category_id: '', start_date: '', notes: '', payment_day: '', reason: '', effective_from: '' });
        }
    }, [editingAgreement, isOpen]);

    if (!isOpen) return null;

    const selectedAccount = accounts.find(a => String(a.id) === String(form.account_id));
    // Only ask for a reason/effective date when the monthly amount is
    // actually being changed — matches the backend, which only requires
    // (and only records an amendment-history row for) a real change.
    const amountIsChanging = isEdit &&
        parseFloat(form.monthly_amount || '0') !== parseFloat(editingAgreement?.monthly_amount || '0');

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
                    payment_day: form.payment_day ? parseInt(form.payment_day) : undefined,
                    ...(amountIsChanging ? { reason: form.reason, effective_from: form.effective_from } : {}),
                });
            } else {
                await serviceFeesAPI.createAgreement({
                    user_id: parseInt(form.user_id),
                    monthly_amount: parseFloat(form.monthly_amount),
                    account_id: parseInt(form.account_id),
                    category_id: parseInt(form.category_id),
                    start_date: form.start_date,
                    notes: form.notes,
                    payment_day: form.payment_day ? parseInt(form.payment_day) : undefined,
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
                        {amountIsChanging && (
                            <div className="rounded-lg bg-amber-50 border border-amber-100 p-3 space-y-3">
                                <p className="text-xs text-amber-700">
                                    Changing the monthly amount from {editingAgreement.monthly_amount} — this is
                                    recorded in the agreement's change history, never overwritten.
                                </p>
                                <div>
                                    <label className="label">Reason for Change *</label>
                                    <input type="text" className="input" value={form.reason}
                                        onChange={e => setForm(p => ({ ...p, reason: e.target.value }))} required />
                                </div>
                                <div>
                                    <label className="label">Effective From *</label>
                                    <input type="date" className="input" value={form.effective_from}
                                        onChange={e => setForm(p => ({ ...p, effective_from: e.target.value }))} required />
                                </div>
                            </div>
                        )}
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
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
                                <label className="label">Payment Day of Month</label>
                                <input type="number" className="input" min="1" max="28" placeholder="e.g. 5"
                                    value={form.payment_day}
                                    onChange={e => setForm(p => ({ ...p, payment_day: e.target.value }))} />
                                <p className="text-xs text-gray-400 mt-1">
                                    When each month's fee is due (1-28). Defaults to the start date's own day if left blank.
                                </p>
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
export const TerminateAgreementModal = ({ isOpen, agreement, onClose, onSuccess }) => {
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
// v1.39.0 — recording a payment no longer posts it immediately. It
// creates a pending payment confirmation entry, stating how it was
// actually paid (Cash / Bank Transfer / Mobile Money) — the real
// transaction only posts once the recipient confirms it from
// Payment Acknowledgements > Payment Confirmations.
export const RecordPaymentModal = ({ isOpen, agreement, onClose, onSuccess }) => {
    const BLANK = {
        amount: '', payment_date: '', notes: '',
        payment_method: 'CASH', mobile_money_provider: '', external_reference: '',
    };
    const [form, setForm] = useState(BLANK);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (isOpen) { setForm(BLANK); setError(null); }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen]);

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
                payment_method: form.payment_method,
                mobile_money_provider: form.payment_method === 'MOBILE_MONEY' ? form.mobile_money_provider : undefined,
                external_reference: form.payment_method !== 'CASH' ? form.external_reference : undefined,
            });
            onSuccess();
            onClose();
            setForm(BLANK);
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
                    <p className="text-xs text-amber-600 mb-4">
                        This creates a pending entry — {agreement.user_name} must confirm they received it before
                        it's posted as a real transaction.
                    </p>
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
                            <label className="label">How was it paid? *</label>
                            <div className="flex gap-2">
                                {['CASH', 'BANK_TRANSFER', 'MOBILE_MONEY'].map(m => (
                                    <button key={m} type="button"
                                        onClick={() => setForm(p => ({ ...p, payment_method: m, mobile_money_provider: '', external_reference: '' }))}
                                        className={`flex-1 px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${
                                            form.payment_method === m ? 'border-primary-600 bg-primary-50 text-primary-700' : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                                        }`}>
                                        {m === 'CASH' ? 'Cash' : m === 'BANK_TRANSFER' ? 'Bank Transfer' : 'Mobile Money'}
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
// SETTLE PAST MONTHS MODAL (Treasurer/Admin, v1.52.0)
// "issue to settle all past months" — a single lump-sum payment
// across every outstanding month, auto-filled per the agreement's own
// outstanding balance for each, but editable before submitting (per
// the confirmed answer: auto-filled, editable, not a black box).
// ============================================================
export const SettlePastMonthsModal = ({ isOpen, agreement, onClose, onSuccess }) => {
    const [periods, setPeriods] = useState([]);
    const [amounts, setAmounts] = useState({});
    const [loadingPeriods, setLoadingPeriods] = useState(false);
    const [form, setForm] = useState({
        payment_date: '', notes: '', payment_method: 'CASH', mobile_money_provider: '', external_reference: '',
    });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (isOpen && agreement) {
            setError(null);
            setForm({ payment_date: '', notes: '', payment_method: 'CASH', mobile_money_provider: '', external_reference: '' });
            setLoadingPeriods(true);
            serviceFeesAPI.getOutstandingPeriods(agreement.id)
                .then(res => {
                    const rows = res.data.data || [];
                    setPeriods(rows);
                    const initial = {};
                    rows.forEach(r => { initial[r.period_id] = String(parseFloat(r.amount_remaining).toFixed(2)); });
                    setAmounts(initial);
                })
                .catch(err => setError(getErrorMessage(err)))
                .finally(() => setLoadingPeriods(false));
        }
    }, [isOpen, agreement]);

    if (!isOpen || !agreement) return null;

    const total = Object.values(amounts).reduce((s, v) => s + (parseFloat(v) || 0), 0);

    const handleSubmit = async (e) => {
        e.preventDefault();
        const breakdown = periods
            .map(p => ({ period_id: p.period_id, period: p.period, amount: parseFloat(amounts[p.period_id] || 0) }))
            .filter(l => l.amount > 0);
        if (breakdown.length === 0) {
            setError('At least one month with a positive amount is required');
            return;
        }
        setLoading(true);
        setError(null);
        try {
            await serviceFeesAPI.settlePastMonths(agreement.id, {
                breakdown,
                payment_date: form.payment_date || undefined,
                notes: form.notes || undefined,
                payment_method: form.payment_method,
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
                <div className="relative bg-white rounded-xl shadow-xl max-w-lg w-full p-6 max-h-screen overflow-y-auto">
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">Settle Past Months</h2>
                    <p className="text-sm text-gray-400 mb-4">
                        {agreement.user_name} — one payment covering every month below. Each figure is auto-filled from
                        what's still owed for that month, but you can edit any of them before submitting.
                    </p>
                    <p className="text-xs text-amber-600 mb-4">
                        This creates a pending entry — {agreement.user_name} must confirm receipt before it posts as a real transaction.
                    </p>
                    {error && <div className="mb-4"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}
                    {loadingPeriods ? (
                        <p className="text-sm text-gray-400 text-center py-6">Loading outstanding months...</p>
                    ) : periods.length === 0 ? (
                        <p className="text-sm text-gray-400 text-center py-6">No outstanding months — everything is fully paid.</p>
                    ) : (
                        <form onSubmit={handleSubmit} className="space-y-4">
                            <div className="space-y-2 max-h-56 overflow-y-auto border border-gray-100 rounded-lg p-3">
                                {periods.map(p => (
                                    <div key={p.period_id} className="flex items-center justify-between gap-3 text-sm">
                                        <div>
                                            <p className="font-medium text-gray-900">{p.period}</p>
                                            <p className="text-xs text-gray-400">Due {formatDate(p.due_date)} · owed {parseFloat(p.amount_remaining).toLocaleString('en-US', { maximumFractionDigits: 2 })}</p>
                                        </div>
                                        <input type="number" className="input w-28 text-right" min="0" step="0.01"
                                            value={amounts[p.period_id] ?? ''}
                                            onChange={e => setAmounts(prev => ({ ...prev, [p.period_id]: e.target.value }))} />
                                    </div>
                                ))}
                            </div>
                            <div className="flex justify-between items-center text-sm font-semibold text-gray-900 border-t border-gray-100 pt-3">
                                <span>Total</span>
                                <span>{total.toLocaleString('en-US', { maximumFractionDigits: 2 })} {agreement.currency_code}</span>
                            </div>
                            <div>
                                <label className="label">Payment Date</label>
                                <input type="date" className="input" value={form.payment_date}
                                    max={new Date().toISOString().slice(0, 10)}
                                    onChange={e => setForm(p => ({ ...p, payment_date: e.target.value }))} />
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
                                            {m === 'CASH' ? 'Cash' : m === 'BANK_TRANSFER' ? 'Bank Transfer' : 'Mobile Money'}
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
                                <label className="label">Notes</label>
                                <textarea className="input" rows={2} value={form.notes}
                                    onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} />
                            </div>
                            <div className="flex justify-end gap-3 pt-2">
                                <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                                <button type="submit" disabled={loading || total <= 0} className="btn-primary">
                                    {loading ? 'Submitting...' : 'Settle These Months'}
                                </button>
                            </div>
                        </form>
                    )}
                </div>
            </div>
        </div>
    );
};

// ============================================================
// OVERRIDE PERIOD MODAL (Treasurer/Admin, v1.52.0)
// Changes ONE historical month's amount_due — deliberately separate
// from Amend Agreement (which is a going-forward change to the
// ongoing monthly_amount).
// ============================================================
export const OverridePeriodModal = ({ isOpen, agreement, period, onClose, onSuccess }) => {
    const [amountDue, setAmountDue] = useState('');
    const [reason, setReason] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (isOpen && period) {
            setAmountDue(String(period.amount_due ?? ''));
            setReason('');
            setError(null);
        }
    }, [isOpen, period]);

    if (!isOpen || !agreement || !period) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await serviceFeesAPI.overridePeriod(agreement.id, period.id, {
                amount_due: parseFloat(amountDue), reason,
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
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">Override {period.period}</h2>
                    <p className="text-sm text-gray-400 mb-4">
                        Changes what's owed for {period.period} only — the agreement's ongoing monthly amount is untouched.
                    </p>
                    {error && <div className="mb-4"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">Amount Due *</label>
                            <input type="number" className="input" min="0" step="0.01"
                                value={amountDue} onChange={e => setAmountDue(e.target.value)} required />
                        </div>
                        <div>
                            <label className="label">Reason *</label>
                            <textarea className="input" rows={2} value={reason}
                                onChange={e => setReason(e.target.value)} required />
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading} className="btn-primary">
                                {loading ? 'Saving...' : 'Save Override'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// EXCLUDE MONTH MODAL (Treasurer/Admin, v1.54.0)
// Cancels a month's obligation entirely — separate from
// OverridePeriodModal above, which changes what a month is WORTH.
// An excluded month is never counted as outstanding/overdue, but is
// also deliberately never shown as PAID, since no money moved.
// Notifies the agreement holder once submitted.
// ============================================================
export const ExcludePeriodModal = ({ isOpen, agreement, period, onClose, onSuccess }) => {
    const [reason, setReason] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (isOpen) { setReason(''); setError(null); }
    }, [isOpen]);

    if (!isOpen || !agreement || !period) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await serviceFeesAPI.excludePeriod(agreement.id, period.id, { reason });
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
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">Exclude {period.period}</h2>
                    <p className="text-sm text-gray-400 mb-4">
                        {agreement.user_name} won't owe anything for {period.period}, and it won't count toward their
                        outstanding balance or overdue reminders — but it also won't show as paid, since no money
                        actually moved. They'll be notified. This can be reversed later.
                    </p>
                    {error && <div className="mb-4"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">Reason *</label>
                            <textarea className="input" rows={3} value={reason}
                                onChange={e => setReason(e.target.value)} required />
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading} className="btn-primary">
                                {loading ? 'Excluding...' : 'Exclude Month'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// INCLUDE (UN-EXCLUDE) MONTH MODAL (Treasurer/Admin, v1.54.0)
// Reverses ExcludePeriodModal above — restores a previously excluded
// month to a normal obligation. Also notifies the agreement holder.
// ============================================================
export const IncludePeriodModal = ({ isOpen, agreement, period, onClose, onSuccess }) => {
    const [reason, setReason] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (isOpen) { setReason(''); setError(null); }
    }, [isOpen]);

    if (!isOpen || !agreement || !period) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await serviceFeesAPI.includePeriod(agreement.id, period.id, { reason });
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
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">Restore {period.period}</h2>
                    <p className="text-sm text-gray-400 mb-4">
                        {period.period} will go back to counting toward {agreement.user_name}'s obligations
                        (its exact status will be recomputed from what's already been paid for it). They'll be notified.
                    </p>
                    {error && <div className="mb-4"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">Reason *</label>
                            <textarea className="input" rows={3} value={reason}
                                onChange={e => setReason(e.target.value)} required />
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading} className="btn-primary">
                                {loading ? 'Restoring...' : 'Restore Month'}
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
// REQUEST PAYMENT MODAL (self-service, v1.53.0)
// "request payment for any unpaid month or a couple of months unpaid
// in a lumpsum" — the person picks which of their own outstanding
// months to request, always for that month's own full remaining
// balance (never an arbitrary figure — that's still the Treasurer's
// call at approval). Uses the periods already loaded onto the
// agreement itself (from getMyAgreement) rather than the Treasurer-only
// outstanding-periods endpoint, since a plain staffer without
// SERVICE_FEE_VIEW can't call that one.
// ============================================================
const RequestPaymentModal = ({ isOpen, agreement, onClose, onSuccess }) => {
    const [selected, setSelected] = useState({});
    const [notes, setNotes] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    const outstanding = (agreement?.periods || []).filter(p => p.status === 'UNPAID' || p.status === 'PARTIAL');

    useEffect(() => {
        if (isOpen) { setSelected({}); setNotes(''); setError(null); }
    }, [isOpen]);

    if (!isOpen || !agreement) return null;

    const toggle = (periodId) => setSelected(prev => ({ ...prev, [periodId]: !prev[periodId] }));
    const selectedIds = Object.keys(selected).filter(id => selected[id]);
    const total = outstanding
        .filter(p => selected[p.id])
        .reduce((s, p) => s + Math.max(0, parseFloat(p.amount_due) - parseFloat(p.amount_paid)), 0);

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (selectedIds.length === 0) {
            setError('Select at least one month to request payment for');
            return;
        }
        setLoading(true);
        setError(null);
        try {
            await serviceFeesAPI.requestPayment(agreement.id, {
                period_ids: selectedIds.map(id => parseInt(id)),
                notes: notes || undefined,
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
                <div className="relative bg-white rounded-xl shadow-xl max-w-lg w-full p-6 max-h-screen overflow-y-auto">
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">Request Payment</h2>
                    <p className="text-sm text-gray-400 mb-4">
                        Pick one or more unpaid months — a Treasurer will review and approve before it's paid out.
                        Selecting several months requests them together as one lump sum.
                    </p>
                    {error && <div className="mb-4"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}
                    {outstanding.length === 0 ? (
                        <p className="text-sm text-gray-400 text-center py-6">You have no unpaid or partially paid months.</p>
                    ) : (
                        <form onSubmit={handleSubmit} className="space-y-4">
                            <div className="space-y-2 max-h-56 overflow-y-auto border border-gray-100 rounded-lg p-3">
                                {outstanding.map(p => {
                                    const remaining = Math.max(0, parseFloat(p.amount_due) - parseFloat(p.amount_paid));
                                    return (
                                        <label key={p.id} className="flex items-center justify-between gap-3 text-sm cursor-pointer">
                                            <span className="flex items-center gap-2">
                                                <input type="checkbox" checked={!!selected[p.id]} onChange={() => toggle(p.id)} />
                                                <span>
                                                    <span className="font-medium text-gray-900">{p.period}</span>
                                                    <span className="text-xs text-gray-400 block">{p.status === 'PARTIAL' ? 'Partially paid' : 'Unpaid'}</span>
                                                </span>
                                            </span>
                                            <span className="font-medium text-gray-700">{remaining.toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>
                                        </label>
                                    );
                                })}
                            </div>
                            <div className="flex justify-between items-center text-sm font-semibold text-gray-900 border-t border-gray-100 pt-3">
                                <span>Total Requested</span>
                                <span>{total.toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>
                            </div>
                            <div>
                                <label className="label">Notes <span className="text-gray-400 font-normal">(optional)</span></label>
                                <textarea className="input" rows={2} value={notes} onChange={e => setNotes(e.target.value)} />
                            </div>
                            <div className="flex justify-end gap-3 pt-2">
                                <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                                <button type="submit" disabled={loading || selectedIds.length === 0} className="btn-primary">
                                    {loading ? 'Submitting...' : 'Submit Request'}
                                </button>
                            </div>
                        </form>
                    )}
                </div>
            </div>
        </div>
    );
};

// ============================================================
// REQUEST ADVANCE MODAL (self-service, v1.53.0)
// Once approved and its disbursement confirmed received, this is
// recovered in full from the very next unpaid month(s), automatically
// — the recovery breakdown is decided (and still editable) by the
// Treasurer at approval time, not by the person requesting it.
// ============================================================
const RequestAdvanceModal = ({ isOpen, agreement, onClose, onSuccess }) => {
    const [amount, setAmount] = useState('');
    const [reason, setReason] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (isOpen) { setAmount(''); setReason(''); setError(null); }
    }, [isOpen]);

    if (!isOpen || !agreement) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await serviceFeesAPI.requestAdvance(agreement.id, { amount: parseFloat(amount), reason });
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
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">Request Advance</h2>
                    <p className="text-sm text-gray-400 mb-4">
                        If approved and you confirm receiving it, this amount is automatically recovered from your
                        next month(s) of service fee — you'll see exactly which months when it's approved.
                    </p>
                    {error && <div className="mb-4"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">Amount *</label>
                            <input type="number" className="input" min="0.01" step="0.01"
                                value={amount} onChange={e => setAmount(e.target.value)} required />
                        </div>
                        <div>
                            <label className="label">Reason *</label>
                            <textarea className="input" rows={3} value={reason}
                                onChange={e => setReason(e.target.value)} required />
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
// SHARED — HOW WAS/WILL THIS BE PAID picker, factored out of
// RecordPaymentModal/SettlePastMonthsModal so the two new Treasurer
// approval modals below (payment requests, advances) don't repeat it
// a third and fourth time.
// ============================================================
const PaymentMethodFields = ({ form, setForm }) => (
    <>
        <div>
            <label className="label">How was it paid? *</label>
            <div className="flex gap-2">
                {['CASH', 'BANK_TRANSFER', 'MOBILE_MONEY'].map(m => (
                    <button key={m} type="button"
                        onClick={() => setForm(p => ({ ...p, payment_method: m, mobile_money_provider: '', external_reference: '' }))}
                        className={`flex-1 px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${
                            form.payment_method === m ? 'border-primary-600 bg-primary-50 text-primary-700' : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                        }`}>
                        {m === 'CASH' ? 'Cash' : m === 'BANK_TRANSFER' ? 'Bank Transfer' : 'Mobile Money'}
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
    </>
);

// ============================================================
// APPROVE PAYMENT REQUEST MODAL (Treasurer, v1.53.0)
// breakdown is auto-filled from the request's own periods (each
// month's own requested amount) but editable before submitting — same
// convention as Settle Past Months.
// ============================================================
export const ApprovePaymentRequestModal = ({ isOpen, request, onClose, onSuccess }) => {
    const [amounts, setAmounts] = useState({});
    const [form, setForm] = useState({
        payment_date: '', payment_method: 'CASH', mobile_money_provider: '', external_reference: '',
    });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (isOpen && request) {
            setError(null);
            setForm({ payment_date: '', payment_method: 'CASH', mobile_money_provider: '', external_reference: '' });
            const initial = {};
            (request.periods || []).forEach(p => { initial[p.period_id] = String(parseFloat(p.amount).toFixed(2)); });
            setAmounts(initial);
        }
    }, [isOpen, request]);

    if (!isOpen || !request) return null;

    const total = Object.values(amounts).reduce((s, v) => s + (parseFloat(v) || 0), 0);

    const handleSubmit = async (e) => {
        e.preventDefault();
        const breakdown = (request.periods || [])
            .map(p => ({ period_id: p.period_id, amount: parseFloat(amounts[p.period_id] || 0) }))
            .filter(l => l.amount > 0);
        if (breakdown.length === 0) {
            setError('At least one month with a positive amount is required');
            return;
        }
        setLoading(true);
        setError(null);
        try {
            await serviceFeesAPI.approvePaymentRequest(request.id, {
                breakdown,
                payment_date: form.payment_date || undefined,
                payment_method: form.payment_method,
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
                <div className="relative bg-white rounded-xl shadow-xl max-w-lg w-full p-6 max-h-screen overflow-y-auto">
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">Approve Payment Request</h2>
                    <p className="text-sm text-gray-400 mb-4">
                        {request.user_name} — each month is auto-filled from what they requested, but you can edit any of them before approving.
                    </p>
                    <p className="text-xs text-amber-600 mb-4">
                        This creates a pending entry — {request.user_name} must confirm receipt before it posts as a real transaction.
                    </p>
                    {error && <div className="mb-4"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div className="space-y-2 max-h-56 overflow-y-auto border border-gray-100 rounded-lg p-3">
                            {(request.periods || []).map(p => (
                                <div key={p.period_id} className="flex items-center justify-between gap-3 text-sm">
                                    <span className="font-medium text-gray-900">{p.period}</span>
                                    <input type="number" className="input w-28 text-right" min="0" step="0.01"
                                        value={amounts[p.period_id] ?? ''}
                                        onChange={e => setAmounts(prev => ({ ...prev, [p.period_id]: e.target.value }))} />
                                </div>
                            ))}
                        </div>
                        <div className="flex justify-between items-center text-sm font-semibold text-gray-900 border-t border-gray-100 pt-3">
                            <span>Total</span>
                            <span>{total.toLocaleString('en-US', { maximumFractionDigits: 2 })} {request.currency_code}</span>
                        </div>
                        <div>
                            <label className="label">Payment Date</label>
                            <input type="date" className="input" value={form.payment_date}
                                max={new Date().toISOString().slice(0, 10)}
                                onChange={e => setForm(p => ({ ...p, payment_date: e.target.value }))} />
                        </div>
                        <PaymentMethodFields form={form} setForm={setForm} />
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading || total <= 0} className="btn-primary">
                                {loading ? 'Approving...' : 'Approve'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// APPROVE ADVANCE MODAL (Treasurer, v1.53.0)
// Fetches the auto-computed recovery schedule (oldest-future-first)
// on open, shows it fully editable before approving — same "auto-
// filled, editable" convention used throughout this module.
// ============================================================
export const ApproveAdvanceModal = ({ isOpen, advance, onClose, onSuccess }) => {
    const [schedule, setSchedule] = useState([]);
    const [amounts, setAmounts] = useState({});
    const [loadingSchedule, setLoadingSchedule] = useState(false);
    const [form, setForm] = useState({
        payment_date: '', payment_method: 'CASH', mobile_money_provider: '', external_reference: '',
    });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (isOpen && advance) {
            setError(null);
            setForm({ payment_date: '', payment_method: 'CASH', mobile_money_provider: '', external_reference: '' });
            setLoadingSchedule(true);
            serviceFeesAPI.getAdvanceRecoveryPreview(advance.id)
                .then(res => {
                    const rows = res.data.data?.breakdown || [];
                    setSchedule(rows);
                    const initial = {};
                    rows.forEach(r => { initial[r.period_id] = String(parseFloat(r.amount).toFixed(2)); });
                    setAmounts(initial);
                })
                .catch(err => setError(getErrorMessage(err)))
                .finally(() => setLoadingSchedule(false));
        }
    }, [isOpen, advance]);

    if (!isOpen || !advance) return null;

    const total = Object.values(amounts).reduce((s, v) => s + (parseFloat(v) || 0), 0);

    const handleSubmit = async (e) => {
        e.preventDefault();
        const recovery_breakdown = schedule
            .map(p => ({ period_id: p.period_id, amount: parseFloat(amounts[p.period_id] || 0) }))
            .filter(l => l.amount > 0);
        if (recovery_breakdown.length === 0) {
            setError('At least one recovery month with a positive amount is required');
            return;
        }
        setLoading(true);
        setError(null);
        try {
            await serviceFeesAPI.approveAdvance(advance.id, {
                recovery_breakdown,
                payment_date: form.payment_date || undefined,
                payment_method: form.payment_method,
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
                <div className="relative bg-white rounded-xl shadow-xl max-w-lg w-full p-6 max-h-screen overflow-y-auto">
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">Approve Advance</h2>
                    <div className="bg-gray-50 rounded-lg p-3 mb-4">
                        <p className="text-sm font-medium text-gray-900">{advance.user_name}</p>
                        <p className="text-xs text-gray-500 mt-0.5">{advance.reason}</p>
                        <p className="text-sm font-bold text-primary-700 mt-2">
                            {parseFloat(advance.amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                        </p>
                    </div>
                    <p className="text-sm text-gray-400 mb-4">
                        Recovered automatically from the month(s) below, oldest first, once {advance.user_name} confirms
                        receiving this advance — auto-computed, but you can edit any month before approving.
                    </p>
                    <p className="text-xs text-amber-600 mb-4">
                        This creates a pending entry — {advance.user_name} must confirm receipt before it posts as a real transaction.
                    </p>
                    {error && <div className="mb-4"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}
                    {loadingSchedule ? (
                        <p className="text-sm text-gray-400 text-center py-6">Computing recovery schedule...</p>
                    ) : (
                        <form onSubmit={handleSubmit} className="space-y-4">
                            <div className="space-y-2 max-h-56 overflow-y-auto border border-gray-100 rounded-lg p-3">
                                {schedule.map(p => (
                                    <div key={p.period_id} className="flex items-center justify-between gap-3 text-sm">
                                        <span className="font-medium text-gray-900">{p.period}</span>
                                        <input type="number" className="input w-28 text-right" min="0" step="0.01"
                                            value={amounts[p.period_id] ?? ''}
                                            onChange={e => setAmounts(prev => ({ ...prev, [p.period_id]: e.target.value }))} />
                                    </div>
                                ))}
                            </div>
                            <div className="flex justify-between items-center text-sm font-semibold text-gray-900 border-t border-gray-100 pt-3">
                                <span>Total To Recover</span>
                                <span>{total.toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>
                            </div>
                            <div>
                                <label className="label">Payment Date</label>
                                <input type="date" className="input" value={form.payment_date}
                                    max={new Date().toISOString().slice(0, 10)}
                                    onChange={e => setForm(p => ({ ...p, payment_date: e.target.value }))} />
                            </div>
                            <PaymentMethodFields form={form} setForm={setForm} />
                            <div className="flex justify-end gap-3 pt-2">
                                <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                                <button type="submit" disabled={loading} className="btn-primary">
                                    {loading ? 'Approving...' : 'Approve'}
                                </button>
                            </div>
                        </form>
                    )}
                </div>
            </div>
        </div>
    );
};

// ============================================================
// REJECT PAYMENT REQUEST / REJECT ADVANCE MODALS (Treasurer, v1.53.0)
// Same reason-only shape as RejectReimbursementModal above; kept as
// two thin components (rather than one generic one) so each calls its
// own distinct API endpoint without an extra "which kind" prop.
// ============================================================
export const RejectPaymentRequestModal = ({ isOpen, request, onClose, onSuccess }) => {
    const [reason, setReason] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    if (!isOpen || !request) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await serviceFeesAPI.rejectPaymentRequest(request.id, { review_notes: reason });
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
                    <h2 className="text-lg font-semibold text-gray-900 mb-4">Reject Payment Request</h2>
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

export const RejectAdvanceModal = ({ isOpen, advance, onClose, onSuccess }) => {
    const [reason, setReason] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    if (!isOpen || !advance) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await serviceFeesAPI.rejectAdvance(advance.id, { review_notes: reason });
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
                    <h2 className="text-lg font-semibold text-gray-900 mb-4">Reject Advance Request</h2>
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
// PERSONAL SERVICE FEE CHART (v1.52.0) — "My Service Fee" tab.
// Shows this person's own monthly paid/outstanding breakdown and a
// small stats summary (paid/unpaid months, most/least paid, total
// earned), fed by getMyAgreement's periods/stats.
// ============================================================
const ServiceFeePersonalChart = ({ agreement }) => {
    const theme = useChartTheme();
    const periods = agreement?.periods || [];
    const stats = agreement?.stats || null;
    if (periods.length === 0) return null;

    // v1.54.0 — an EXCLUDED month must never show as "outstanding"
    // (nothing is owed for it), so its bar is a distinct neutral
    // segment instead of red — and, being excluded, it also never
    // shows a "paid" segment, since no money actually moved.
    const chartData = periods.map(p => ({
        period: p.period,
        paid: p.status === 'EXCLUDED' ? 0 : parseFloat(p.amount_paid || 0),
        outstanding: p.status === 'EXCLUDED' ? 0 : Math.max(0, parseFloat(p.amount_due || 0) - parseFloat(p.amount_paid || 0)),
        excluded: p.status === 'EXCLUDED' ? parseFloat(p.amount_due || 0) : 0,
    }));

    return (
        <div className="mt-4">
            {stats && (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-4">
                    <div className="bg-gray-50 rounded-lg p-3">
                        <p className="text-xs text-gray-400">Paid Months</p>
                        <p className="text-lg font-bold text-green-600 mt-0.5">{stats.paid_months}</p>
                    </div>
                    <div className="bg-gray-50 rounded-lg p-3">
                        <p className="text-xs text-gray-400">Unpaid / Partial</p>
                        <p className="text-lg font-bold text-red-500 mt-0.5">{stats.unpaid_months + stats.partial_months}</p>
                    </div>
                    <div className="bg-gray-50 rounded-lg p-3">
                        <p className="text-xs text-gray-400">Excluded Months</p>
                        <p className="text-lg font-bold text-blue-500 mt-0.5">{stats.excluded_months || 0}</p>
                    </div>
                    <div className="bg-gray-50 rounded-lg p-3">
                        <p className="text-xs text-gray-400">Most Paid Month</p>
                        <p className="text-sm font-semibold text-gray-900 mt-0.5">
                            {stats.most_paid_month ? stats.most_paid_month.period : '—'}
                        </p>
                    </div>
                    <div className="bg-gray-50 rounded-lg p-3">
                        <p className="text-xs text-gray-400">Total Earned</p>
                        <p className="text-lg font-bold text-primary-700 mt-0.5">
                            {stats.total_earned.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                        </p>
                    </div>
                </div>
            )}
            <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData}>
                        <CartesianGrid {...theme.gridProps} />
                        <XAxis dataKey="period" tick={{ fontSize: 11, ...theme.axisTick }} tickLine={false} />
                        <YAxis tick={{ fontSize: 11, ...theme.axisTick }} tickLine={false} axisLine={false} />
                        <Tooltip {...theme.tooltipProps} />
                        <Bar dataKey="paid" stackId="a" name="Paid" fill={theme.success} />
                        <Bar dataKey="outstanding" stackId="a" name="Outstanding" fill={theme.danger} />
                        <Bar dataKey="excluded" stackId="a" name="Excluded" fill={theme.neutral} radius={[4, 4, 0, 0]} />
                    </BarChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
};

// ============================================================
// TREASURY OVERVIEW (v1.52.0) — treasury-wide aggregate across every
// agreement, for SERVICE_FEE_VIEW holders.
// ============================================================
const TreasuryOverview = () => {
    const theme = useChartTheme();
    const [stats, setStats] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    useEffect(() => {
        serviceFeesAPI.getTreasuryStats()
            .then(res => setStats(res.data.data))
            .catch(err => setError(getErrorMessage(err)))
            .finally(() => setLoading(false));
    }, []);

    if (loading) return <p className="text-sm text-gray-400 text-center py-6">Loading treasury overview...</p>;
    if (error) return <ErrorMessage message={error} />;
    if (!stats) return null;

    const { totals, per_agreement: perAgreement } = stats;
    const chartData = (perAgreement || []).map(a => ({
        name: `${a.first_name} ${a.last_name}`,
        paid: parseFloat(a.total_paid || 0),
        outstanding: parseFloat(a.total_outstanding || 0),
    }));

    return (
        <div className="space-y-6">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
                <div className="card py-3">
                    <p className="text-xs text-gray-400">Paid Periods</p>
                    <p className="text-lg font-bold text-green-600 mt-0.5">{totals.paid_periods}</p>
                </div>
                <div className="card py-3">
                    <p className="text-xs text-gray-400">Partial / Unpaid Periods</p>
                    <p className="text-lg font-bold text-red-500 mt-0.5">{parseInt(totals.partial_periods) + parseInt(totals.unpaid_periods)}</p>
                </div>
                <div className="card py-3">
                    <p className="text-xs text-gray-400">Excluded Periods</p>
                    <p className="text-lg font-bold text-blue-500 mt-0.5">{totals.excluded_periods || 0}</p>
                </div>
                <div className="card py-3">
                    <p className="text-xs text-gray-400">Total Paid</p>
                    <p className="text-lg font-bold text-primary-700 mt-0.5">{parseFloat(totals.total_paid).toLocaleString('en-US', { maximumFractionDigits: 2 })}</p>
                </div>
                <div className="card py-3">
                    <p className="text-xs text-gray-400">Total Outstanding</p>
                    <p className="text-lg font-bold text-red-500 mt-0.5">{parseFloat(totals.total_outstanding).toLocaleString('en-US', { maximumFractionDigits: 2 })}</p>
                </div>
            </div>

            {chartData.length > 0 && (
                <div className="card">
                    <h3 className="section-title mb-4">Paid vs Outstanding by Person</h3>
                    <div className="h-64">
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={chartData} layout="vertical" margin={{ left: 24 }}>
                                <CartesianGrid {...theme.gridProps} />
                                <XAxis type="number" tick={{ fontSize: 11, ...theme.axisTick }} tickLine={false} />
                                <YAxis type="category" dataKey="name" tick={{ fontSize: 11, ...theme.axisTick }} tickLine={false} width={120} />
                                <Tooltip {...theme.tooltipProps} />
                                <Bar dataKey="paid" stackId="a" name="Paid" fill={theme.success} />
                                <Bar dataKey="outstanding" stackId="a" name="Outstanding" fill={theme.danger} radius={[0, 4, 4, 0]} />
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                </div>
            )}
        </div>
    );
};

// ============================================================
// MAIN SERVICE FEES PAGE
// ============================================================
const ServiceFeesPage = () => {
    const { hasPermission } = useAuth();
    // v1.47.0 — converted from hardcoded hasRole(...) checks to the
    // permission system, matching the backend's requirePermissions
    // split in routes/serviceFees.js. VIEW flags guarantee full
    // monitoring visibility (an Admin/Treasurer can see every
    // agreement and reimbursement request even without rights to act
    // on them); MANAGE flags gate the actual action buttons —
    // Record Payment/Amend/Terminate/New Agreement and
    // Approve/Reject Reimbursement — unchanged from what those
    // buttons required before.
    const canViewAgreements = hasPermission('SERVICE_FEE_VIEW');
    const canManageAgreements = hasPermission('SERVICE_FEE_MANAGE');
    const canViewReimbursements = hasPermission('SERVICE_FEE_VIEW');
    const canManageReimbursements = hasPermission('SERVICE_FEE_MANAGE');

    const [activeTab, setActiveTab] = useState('mine');
    const [myAgreement, setMyAgreement] = useState(null);
    const [myReimbursements, setMyReimbursements] = useState([]);
    const [myPaymentRequests, setMyPaymentRequests] = useState([]);
    const [myAdvances, setMyAdvances] = useState([]);
    const [agreements, setAgreements] = useState([]);
    const [reimbursements, setReimbursements] = useState([]);
    const [paymentRequests, setPaymentRequests] = useState([]);
    const [advances, setAdvances] = useState([]);
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

    // v1.53.0 — self-service request modals + Treasurer approval modals
    const [showRequestPayment, setShowRequestPayment] = useState(false);
    const [showRequestAdvance, setShowRequestAdvance] = useState(false);
    const [approvingPaymentRequest, setApprovingPaymentRequest] = useState(null);
    const [rejectingPaymentRequest, setRejectingPaymentRequest] = useState(null);
    const [approvingAdvance, setApprovingAdvance] = useState(null);
    const [rejectingAdvance, setRejectingAdvance] = useState(null);

    const loadMine = useCallback(async () => {
        try {
            setLoading(true);
            const [agRes, reimbRes, reqRes, advRes] = await Promise.all([
                serviceFeesAPI.getMyAgreement(),
                serviceFeesAPI.getMyReimbursements(),
                serviceFeesAPI.getMyPaymentRequests(),
                serviceFeesAPI.getMyAdvances(),
            ]);
            setMyAgreement(agRes.data.data);
            setMyReimbursements(reimbRes.data.data || []);
            setMyPaymentRequests(reqRes.data.data || []);
            setMyAdvances(advRes.data.data || []);
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
        if (!canViewReimbursements) return;
        try {
            const res = await serviceFeesAPI.listReimbursements();
            setReimbursements(res.data.data || []);
        } catch (err) {
            setError(getErrorMessage(err));
        }
    }, [canViewReimbursements]);

    // v1.53.0 — Treasurer-side "Requests" tab data (payment requests +
    // advances awaiting review, mirroring loadReimbursements above).
    const loadRequests = useCallback(async () => {
        if (!canViewAgreements) return;
        try {
            const [reqRes, advRes] = await Promise.all([
                serviceFeesAPI.listPaymentRequests(),
                serviceFeesAPI.listAdvances(),
            ]);
            setPaymentRequests(reqRes.data.data || []);
            setAdvances(advRes.data.data || []);
        } catch (err) {
            setError(getErrorMessage(err));
        }
    }, [canViewAgreements]);

    useEffect(() => {
        loadMine();
        loadAgreements();
        loadReimbursements();
        loadRequests();
        accountsAPI.getAll().then(r => setAccounts(r.data.data || [])).catch(() => {});
        accountsAPI.getCurrencies().then(r => setCurrencies(r.data.data || [])).catch(() => {});
        categoriesAPI.getAll({ flat: true }).then(r => setCategories(r.data.data || [])).catch(() => {});
        if (canManageAgreements) {
            usersAPI.getAllUsers({ is_active: true, limit: 500 }).then(r => setUsers(r.data.data || [])).catch(() => {});
        }
    }, [loadMine, loadAgreements, loadReimbursements, loadRequests, canManageAgreements]);

    const handleSuccess = () => {
        loadMine();
        loadAgreements();
        loadReimbursements();
        loadRequests();
    };

    const pendingReimbCount = reimbursements.filter(r => r.status === 'PENDING').length;
    const pendingRequestsCount = paymentRequests.filter(r => r.status === 'PENDING').length
        + advances.filter(a => a.status === 'PENDING').length;

    const myPaymentRequestColumns = [
        { header: 'Month(s)', render: row => <span className="text-sm text-gray-700">{(row.periods || []).map(p => p.period).join(', ') || '—'}</span> },
        { header: 'Amount', render: row => <span className="text-sm font-bold text-gray-900">{(row.periods || []).reduce((s, p) => s + parseFloat(p.amount || 0), 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}</span> },
        { header: 'Status', render: row => <StatusBadge status={row.confirmation_status === 'PENDING_CONFIRMATION' ? 'AWAITING CONFIRMATION' : row.status} /> },
        { header: 'Notes', render: row => <span className="text-xs text-gray-500">{row.review_notes || row.notes || '—'}</span> },
    ];

    const myAdvanceColumns = [
        { header: 'Amount', render: row => <span className="text-sm font-bold text-gray-900">{parseFloat(row.amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}</span> },
        { header: 'Reason', render: row => <span className="text-sm text-gray-700">{row.reason}</span> },
        { header: 'Status', render: row => <StatusBadge status={row.confirmation_status === 'PENDING_CONFIRMATION' ? 'AWAITING CONFIRMATION' : row.status} /> },
        { header: 'Outstanding', render: row => <span className="text-sm text-gray-500">{row.disbursed_at ? parseFloat(row.outstanding_balance).toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—'}</span> },
        { header: 'Notes', render: row => <span className="text-xs text-gray-500">{row.review_notes || '—'}</span> },
    ];

    const paymentRequestColumns = [
        { header: 'Person', render: row => <span className="text-sm font-medium text-gray-900">{row.user_name}</span> },
        { header: 'Month(s)', render: row => <span className="text-sm text-gray-700">{(row.periods || []).map(p => p.period).join(', ') || '—'}</span> },
        { header: 'Amount', render: row => <span className="text-sm font-bold text-gray-900">{(row.periods || []).reduce((s, p) => s + parseFloat(p.amount || 0), 0).toLocaleString('en-US', { maximumFractionDigits: 2 })} {row.currency_code}</span> },
        { header: 'Status', render: row => <StatusBadge status={row.status} /> },
        {
            header: 'Actions',
            render: row => row.status === 'PENDING' && canManageAgreements && (
                <div className="flex gap-2">
                    <button onClick={() => setApprovingPaymentRequest(row)}
                        className="p-1.5 rounded-lg bg-green-50 text-green-600 hover:bg-green-100 transition-colors" title="Approve">
                        <CheckIcon className="h-4 w-4" />
                    </button>
                    <button onClick={() => setRejectingPaymentRequest(row)}
                        className="p-1.5 rounded-lg bg-red-50 text-red-600 hover:bg-red-100 transition-colors" title="Reject">
                        <XMarkIcon className="h-4 w-4" />
                    </button>
                </div>
            ),
        },
    ];

    const advanceColumns = [
        { header: 'Person', render: row => <span className="text-sm font-medium text-gray-900">{row.user_name}</span> },
        { header: 'Amount', render: row => <span className="text-sm font-bold text-gray-900">{parseFloat(row.amount).toLocaleString('en-US', { maximumFractionDigits: 2 })} {row.currency_code}</span> },
        { header: 'Reason', render: row => <span className="text-sm text-gray-700">{row.reason}</span> },
        { header: 'Status', render: row => <StatusBadge status={row.status} /> },
        {
            header: 'Actions',
            render: row => row.status === 'PENDING' && canManageAgreements && (
                <div className="flex gap-2">
                    <button onClick={() => setApprovingAdvance(row)}
                        className="p-1.5 rounded-lg bg-green-50 text-green-600 hover:bg-green-100 transition-colors" title="Approve">
                        <CheckIcon className="h-4 w-4" />
                    </button>
                    <button onClick={() => setRejectingAdvance(row)}
                        className="p-1.5 rounded-lg bg-red-50 text-red-600 hover:bg-red-100 transition-colors" title="Reject">
                        <XMarkIcon className="h-4 w-4" />
                    </button>
                </div>
            ),
        },
    ];

    const myReimbColumns = [
        { header: 'Reference', render: row => <span className="font-mono text-xs">{row.reference_code}</span> },
        { header: 'Description', render: row => <span className="text-sm text-gray-700">{row.description}</span> },
        { header: 'Amount', render: row => <span className="text-sm font-bold text-gray-900">{parseFloat(row.amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}</span> },
        { header: 'Expense Date', render: row => <span className="text-sm text-gray-500">{formatDate(row.expense_date)}</span> },
        { header: 'Status', render: row => <StatusBadge status={row.status} /> },
        { header: 'Notes', render: row => <span className="text-xs text-gray-500">{row.review_notes || '—'}</span> },
    ];

    const agreementColumns = [
        {
            header: 'Person',
            render: row => (
                <Link
                    to={`/service-fees/agreements/${row.id}`}
                    className="text-sm font-medium text-primary-700 hover:text-primary-800 hover:underline"
                >
                    {row.user_name}
                </Link>
            ),
        },
        { header: 'Monthly Fee', render: row => <span className="text-sm font-bold text-gray-900">{parseFloat(row.monthly_amount).toLocaleString('en-US', { maximumFractionDigits: 2 })} {row.currency_code}</span> },
        { header: 'Account', render: row => <span className="text-sm text-gray-500">{row.account_name}</span> },
        { header: 'Last Paid', render: row => <span className="text-sm text-gray-500">{row.last_paid_date ? formatDate(row.last_paid_date) : 'Never'}</span> },
        { header: 'Status', render: row => <StatusBadge status={row.status} /> },
        {
            header: 'Actions',
            render: row => (
                <div className="flex gap-2">
                    {row.status === 'ACTIVE' && canManageAgreements && (
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
                    {canManageReimbursements && (
                        <>
                            <button onClick={() => setApprovingReimbursement(row)}
                                className="p-1.5 rounded-lg bg-green-50 text-green-600 hover:bg-green-100 transition-colors" title="Approve">
                                <CheckIcon className="h-4 w-4" />
                            </button>
                            <button onClick={() => setRejectingReimbursement(row)}
                                className="p-1.5 rounded-lg bg-red-50 text-red-600 hover:bg-red-100 transition-colors" title="Reject">
                                <XMarkIcon className="h-4 w-4" />
                            </button>
                        </>
                    )}
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
                {canViewAgreements && (
                    <button onClick={() => setActiveTab('treasury')}
                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                            activeTab === 'treasury' ? 'bg-primary-700 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                        }`}>
                        Treasury Overview
                    </button>
                )}
                {canViewReimbursements && (
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
                {canViewAgreements && (
                    <button onClick={() => setActiveTab('requests')}
                        className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                            activeTab === 'requests' ? 'bg-primary-700 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                        }`}>
                        Payment &amp; Advance Requests
                        {pendingRequestsCount > 0 && (
                            <span className={`text-xs px-1.5 py-0.5 rounded-full font-bold ${
                                activeTab === 'requests' ? 'bg-white text-primary-700' : 'bg-red-500 text-white'
                            }`}>{pendingRequestsCount}</span>
                        )}
                    </button>
                )}
            </div>

            {activeTab === 'mine' && (
                <div className="space-y-6">
                    <div className="card">
                        <div className="flex items-start justify-between gap-3 mb-3">
                            <h3 className="text-sm font-semibold text-gray-900">My Service Fee Agreement</h3>
                            {myAgreement && myAgreement.status === 'ACTIVE' && (
                                <div className="flex gap-2 shrink-0">
                                    <button onClick={() => setShowRequestPayment(true)}
                                        className="btn-secondary flex items-center gap-1.5 text-xs px-3 py-1.5">
                                        <BanknotesIcon className="h-3.5 w-3.5" /> Request Payment
                                    </button>
                                    <button onClick={() => setShowRequestAdvance(true)}
                                        className="btn-secondary flex items-center gap-1.5 text-xs px-3 py-1.5">
                                        <HandRaisedIcon className="h-3.5 w-3.5" /> Request Advance
                                    </button>
                                </div>
                            )}
                        </div>
                        {myAgreement ? (
                            <div>
                                <p className="text-2xl font-bold text-primary-700">
                                    {parseFloat(myAgreement.monthly_amount).toLocaleString('en-US', { maximumFractionDigits: 2 })} {myAgreement.currency_code}
                                    <span className="text-sm font-normal text-gray-400"> / month</span>
                                </p>
                                <p className="text-xs text-gray-400 mt-1">
                                    Since {formatDate(myAgreement.start_date)} · <StatusBadge status={myAgreement.status} />
                                </p>
                                <ServiceFeePersonalChart agreement={myAgreement} />
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

                    {myAgreement && (myPaymentRequests.length > 0 || myAdvances.length > 0) && (
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                            <div>
                                <h3 className="text-sm font-semibold text-gray-900 mb-3 flex items-center gap-1.5">
                                    <ClockIcon className="h-4 w-4 text-gray-400" /> My Payment Requests
                                </h3>
                                <DataTable
                                    columns={myPaymentRequestColumns}
                                    data={myPaymentRequests}
                                    loading={loading}
                                    emptyMessage="You have no payment requests yet"
                                />
                            </div>
                            <div>
                                <h3 className="text-sm font-semibold text-gray-900 mb-3 flex items-center gap-1.5">
                                    <HandRaisedIcon className="h-4 w-4 text-gray-400" /> My Advances
                                </h3>
                                <DataTable
                                    columns={myAdvanceColumns}
                                    data={myAdvances}
                                    loading={loading}
                                    emptyMessage="You have no advance requests yet"
                                />
                            </div>
                        </div>
                    )}

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

            {activeTab === 'treasury' && canViewAgreements && <TreasuryOverview />}

            {activeTab === 'reimbursements' && canViewReimbursements && (
                <DataTable
                    columns={reimbColumns}
                    data={reimbursements}
                    loading={loading}
                    emptyMessage="No reimbursement requests found"
                    searchable
                    searchPlaceholder="Search reimbursement requests..."
                />
            )}

            {activeTab === 'requests' && canViewAgreements && (
                <div className="space-y-8">
                    <div>
                        <h3 className="section-title mb-3">Payment Requests</h3>
                        <DataTable
                            columns={paymentRequestColumns}
                            data={paymentRequests}
                            loading={loading}
                            emptyMessage="No payment requests found"
                            searchable
                            searchPlaceholder="Search payment requests..."
                        />
                    </div>
                    <div>
                        <h3 className="section-title mb-3">Advance Requests</h3>
                        <DataTable
                            columns={advanceColumns}
                            data={advances}
                            loading={loading}
                            emptyMessage="No advance requests found"
                            searchable
                            searchPlaceholder="Search advance requests..."
                        />
                    </div>
                </div>
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
            <RequestPaymentModal
                isOpen={showRequestPayment}
                agreement={myAgreement}
                onClose={() => setShowRequestPayment(false)}
                onSuccess={handleSuccess}
            />
            <RequestAdvanceModal
                isOpen={showRequestAdvance}
                agreement={myAgreement}
                onClose={() => setShowRequestAdvance(false)}
                onSuccess={handleSuccess}
            />
            <ApprovePaymentRequestModal
                isOpen={!!approvingPaymentRequest}
                request={approvingPaymentRequest}
                onClose={() => setApprovingPaymentRequest(null)}
                onSuccess={handleSuccess}
            />
            <RejectPaymentRequestModal
                isOpen={!!rejectingPaymentRequest}
                request={rejectingPaymentRequest}
                onClose={() => setRejectingPaymentRequest(null)}
                onSuccess={handleSuccess}
            />
            <ApproveAdvanceModal
                isOpen={!!approvingAdvance}
                advance={approvingAdvance}
                onClose={() => setApprovingAdvance(null)}
                onSuccess={handleSuccess}
            />
            <RejectAdvanceModal
                isOpen={!!rejectingAdvance}
                advance={rejectingAdvance}
                onClose={() => setRejectingAdvance(null)}
                onSuccess={handleSuccess}
            />
        </div>
    );
};

export default ServiceFeesPage;
