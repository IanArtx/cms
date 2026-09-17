// ============================================================
// FINES PAGE (v1.37.0)
// Treasury assigns fines/penalties to shareholders — special income
// to the company, tracked in the member's outstanding balances.
// Two audiences on one page: "My Fines" (any member, self-scoped, no
// permission needed — mirrors Side Fund's "My Dues") and "All Fines"
// (Treasury oversight, FINE_VIEW) + "Assign Fine" (FINE_MANAGE).
// A member can either request the Treasurer acknowledge a payment
// they've already made (via a FINE_PAYMENT requisition — see
// requisitionsController.js), or the Treasurer can clear it directly.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { finesAPI, savingsAPI, requisitionsAPI, usersAPI, accountsAPI, categoriesAPI } from '../../api/endpoints';
import { formatDate, formatNumber, getErrorMessage } from '../../utils/helpers';
import PageHeader from '../../components/common/PageHeader';
import DataTable from '../../components/common/DataTable';
import ErrorMessage from '../../components/common/ErrorMessage';
import StatusBadge from '../../components/common/StatusBadge';
import { useAuth } from '../../contexts/AuthContext';
import { useConfirm } from '../../contexts/ConfirmContext';
import { PlusIcon, ExclamationTriangleIcon, CheckIcon, XMarkIcon, BanknotesIcon, EyeIcon } from '@heroicons/react/24/outline';

const REASONS = [
    { value: 'CONTRIBUTION_FAILURE', label: 'Contribution Failure' },
    { value: 'MEETING_VIOLATION', label: 'Meeting Violation' },
    { value: 'GENERAL', label: 'General' },
];

const reasonLabel = (r) => REASONS.find(x => x.value === r)?.label || r;

// ============================================================
// ASSIGN FINE MODAL — Treasurer/Assistant Treasurer/Admin (FINE_MANAGE)
// ============================================================
const BLANK_ASSIGN_FORM = {
    user_id: '', reason: 'GENERAL', currency_id: '', description: '',
    amount: '', default_deadline: '', defaulted_amount: '', fine_percentage: '',
};

const AssignFineModal = ({ isOpen, onClose, onSuccess, members, currencies }) => {
    const [form, setForm] = useState(BLANK_ASSIGN_FORM);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => { if (isOpen) { setForm(BLANK_ASSIGN_FORM); setError(null); } }, [isOpen]);

    if (!isOpen) return null;

    const isContributionFailure = form.reason === 'CONTRIBUTION_FAILURE';
    const computedAmount = isContributionFailure && form.defaulted_amount && form.fine_percentage
        ? (parseFloat(form.defaulted_amount) * (parseFloat(form.fine_percentage) / 100))
        : null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            const payload = {
                user_id: parseInt(form.user_id),
                reason: form.reason,
                currency_id: parseInt(form.currency_id),
                description: form.description || undefined,
            };
            if (isContributionFailure) {
                payload.default_deadline = form.default_deadline;
                payload.defaulted_amount = parseFloat(form.defaulted_amount);
                payload.fine_percentage = parseFloat(form.fine_percentage);
            } else {
                payload.amount = parseFloat(form.amount);
            }
            await finesAPI.create(payload);
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
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">Assign a Fine</h2>
                    <p className="text-sm text-gray-400 mb-4">
                        Posted as special income to the company. The member can pay it into any account,
                        as long as it's in the same currency the fine was posted in.
                    </p>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">Member *</label>
                            <select className="input" value={form.user_id}
                                onChange={e => setForm(p => ({ ...p, user_id: e.target.value }))} required>
                                <option value="">Select member...</option>
                                {members.map(m => (
                                    <option key={m.id} value={m.id}>{m.first_name} {m.last_name}</option>
                                ))}
                            </select>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="label">Reason of Default *</label>
                                <select className="input" value={form.reason}
                                    onChange={e => setForm(p => ({ ...p, reason: e.target.value }))} required>
                                    {REASONS.map(r => (
                                        <option key={r.value} value={r.value}>{r.label}</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className="label">Currency *</label>
                                <select className="input" value={form.currency_id}
                                    onChange={e => setForm(p => ({ ...p, currency_id: e.target.value }))} required>
                                    <option value="">Select currency...</option>
                                    {currencies.map(c => (
                                        <option key={c.id} value={c.id}>{c.code} — {c.name}</option>
                                    ))}
                                </select>
                            </div>
                        </div>

                        {isContributionFailure ? (
                            <div className="bg-gray-50 rounded-lg p-3 space-y-3">
                                <p className="text-xs text-gray-500">
                                    The fine amount is calculated automatically from what was defaulted on and
                                    the percentage — e.g. failure to pay 150 by 15.08.2026 at 8% posts a 12 fine.
                                </p>
                                <div>
                                    <label className="label">Deadline of Default *</label>
                                    <input type="date" className="input" value={form.default_deadline}
                                        onChange={e => setForm(p => ({ ...p, default_deadline: e.target.value }))} required />
                                </div>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                    <div>
                                        <label className="label">Amount Defaulted On *</label>
                                        <input type="number" className="input" value={form.defaulted_amount}
                                            onChange={e => setForm(p => ({ ...p, defaulted_amount: e.target.value }))}
                                            min="0.01" step="0.01" required />
                                    </div>
                                    <div>
                                        <label className="label">Fine Percentage *</label>
                                        <input type="number" className="input" value={form.fine_percentage}
                                            onChange={e => setForm(p => ({ ...p, fine_percentage: e.target.value }))}
                                            min="0.01" max="99.99" step="0.01" required />
                                    </div>
                                </div>
                                {computedAmount !== null && (
                                    <p className="text-sm font-bold text-primary-700">
                                        Fine to be posted: {formatNumber(computedAmount)}
                                    </p>
                                )}
                            </div>
                        ) : (
                            <div>
                                <label className="label">Fine Amount *</label>
                                <input type="number" className="input" value={form.amount}
                                    onChange={e => setForm(p => ({ ...p, amount: e.target.value }))}
                                    min="0.01" step="0.01" required />
                            </div>
                        )}

                        <div>
                            <label className="label">Description</label>
                            <textarea className="input" rows={2} value={form.description}
                                onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
                                placeholder="More detail about this fine..." />
                        </div>

                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading} className="btn-primary">
                                {loading ? 'Assigning...' : 'Assign Fine'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// CLEAR FINE MODAL — Treasurer/Assistant Treasurer/Admin (FINE_MANAGE)
// Only a receiving account, paid date, and description are needed —
// currency-matching and the actual transaction are handled server-side.
// ============================================================
const ClearFineModal = ({ isOpen, onClose, onSuccess, fine, accounts }) => {
    const [form, setForm] = useState({ account_id: '', paid_date: '', description: '' });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (isOpen && fine) {
            setForm({ account_id: '', paid_date: new Date().toISOString().slice(0, 10), description: '' });
            setError(null);
        }
    }, [isOpen, fine]);

    if (!isOpen || !fine) return null;

    const matchingAccounts = accounts.filter(a => a.currency_code === fine.currency_code);
    const otherAccounts = accounts.filter(a => a.currency_code !== fine.currency_code);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await finesAPI.clear(fine.id, {
                account_id: parseInt(form.account_id),
                paid_date: form.paid_date,
                description: form.description || undefined,
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
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">Clear Fine</h2>
                    <p className="text-sm text-gray-400 mb-4">
                        {fine.member_name} — {reasonLabel(fine.reason)}. Amount: {formatNumber(fine.amount)} {fine.currency_code}
                    </p>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">Receiving Account *</label>
                            <select className="input" value={form.account_id}
                                onChange={e => setForm(p => ({ ...p, account_id: e.target.value }))} required>
                                <option value="">Select account...</option>
                                {matchingAccounts.map(a => (
                                    <option key={a.id} value={a.id}>{a.name} ({a.currency_code})</option>
                                ))}
                                {otherAccounts.length > 0 && (
                                    <optgroup label="Different currency — will be rejected">
                                        {otherAccounts.map(a => (
                                            <option key={a.id} value={a.id} disabled>{a.name} ({a.currency_code})</option>
                                        ))}
                                    </optgroup>
                                )}
                            </select>
                            <p className="text-xs text-gray-400 mt-1">
                                Must be an account in {fine.currency_code} — the same currency the fine was posted in.
                            </p>
                        </div>
                        <div>
                            <label className="label">Date Paid *</label>
                            <input type="date" className="input" value={form.paid_date}
                                max={new Date().toISOString().slice(0, 10)}
                                onChange={e => setForm(p => ({ ...p, paid_date: e.target.value }))} required />
                        </div>
                        <div>
                            <label className="label">Description</label>
                            <textarea className="input" rows={2} value={form.description}
                                onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
                                placeholder="Optional payment details..." />
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading} className="btn-primary">
                                {loading ? 'Clearing...' : 'Clear Fine'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// REQUEST ACKNOWLEDGEMENT MODAL — member requesting the Treasurer
// acknowledge a fine payment already made externally. Creates a
// FINE_PAYMENT requisition scoped to this specific fine.
// ============================================================
const RequestAckModal = ({ isOpen, onClose, onSuccess, fine, categories }) => {
    const [form, setForm] = useState({ category_id: '', contribution_date: '', purpose: '' });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (isOpen && fine) {
            setForm({
                category_id: '',
                contribution_date: new Date().toISOString().slice(0, 10),
                purpose: '',
            });
            setError(null);
        }
    }, [isOpen, fine]);

    if (!isOpen || !fine) return null;

    const financeCategories = categories.filter(c => c.module === 'FINANCE');

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await requisitionsAPI.create({
                requisition_type: 'FINE_PAYMENT',
                fine_id: fine.id,
                category_id: parseInt(form.category_id),
                title: `Fine payment — ${fine.reference_code}`,
                amount_requested: parseFloat(fine.amount),
                purpose: form.purpose,
                contribution_date: form.contribution_date,
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
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">Request Acknowledgement</h2>
                    <p className="text-sm text-gray-400 mb-4">
                        Tell the Treasurer you've already paid this fine ({formatNumber(fine.amount)} {fine.currency_code},
                        reference {fine.reference_code}). It stays outstanding until they review and confirm it.
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
                        <div>
                            <label className="label">Date Paid *</label>
                            <input type="date" className="input" value={form.contribution_date}
                                max={new Date().toISOString().slice(0, 10)}
                                onChange={e => setForm(p => ({ ...p, contribution_date: e.target.value }))} required />
                        </div>
                        <div>
                            <label className="label">How Did You Pay? *</label>
                            <textarea className="input" rows={3} value={form.purpose}
                                onChange={e => setForm(p => ({ ...p, purpose: e.target.value }))}
                                placeholder="e.g. Cash handed to the Treasurer on 15 July" required />
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading} className="btn-primary">
                                {loading ? 'Submitting...' : 'Submit for Acknowledgement'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// SETTLE FINES WITH SAVINGS MODAL (v1.59.0)
// Dual entry point, same shared modal — mode='entry' is the
// Treasurer/Assistant Treasurer acting on a member's behalf (sits
// PENDING_CONFIRMATION until the member confirms); mode='request' is
// a member requesting it themselves (sits PENDING_APPROVAL until a
// Treasurer/Assistant Treasurer approves). Either way: pick individual
// outstanding fines (not exceeding the Savings balance), with the
// savings balance and running deduction total updating live as fines
// are selected.
// ============================================================
const SettleFinesModal = ({ isOpen, onClose, onSuccess, mode, members, allFines, myOutstanding, accounts }) => {
    const [userId, setUserId] = useState('');
    const [selected, setSelected] = useState({}); // fineId -> bool
    const [settlementDate, setSettlementDate] = useState('');
    const [notes, setNotes] = useState('');
    const [balance, setBalance] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (isOpen) {
            setUserId('');
            setSelected({});
            setSettlementDate(new Date().toISOString().slice(0, 10));
            setNotes('');
            setError(null);
            setBalance(null);
            if (mode === 'request') {
                savingsAPI.getMyBalance().then(r => setBalance(r.data.data)).catch(() => setBalance(null));
            }
        }
    }, [isOpen, mode]);

    useEffect(() => {
        if (mode === 'entry') {
            setSelected({});
            if (userId) {
                savingsAPI.getBalanceForUser(userId).then(r => setBalance(r.data.data)).catch(() => setBalance(null));
            } else {
                setBalance(null);
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [userId, mode]);

    if (!isOpen) return null;

    const outstandingFines = mode === 'request'
        ? myOutstanding
        : (userId ? allFines.filter(f => String(f.user_id) === String(userId) && f.status === 'OUTSTANDING') : []);

    const selectedFines = outstandingFines.filter(f => selected[f.id]);
    const selectedTotal = selectedFines.reduce((sum, f) => sum + parseFloat(f.amount), 0);
    const principalBalance = balance ? parseFloat(balance.principal_balance) : 0;
    const remainingAfter = principalBalance - selectedTotal;
    const overBalance = selectedTotal > principalBalance;
    // savings_balances carries no currency of its own — the Savings
    // account is a system-wide singleton, so its currency is looked up
    // from the accounts list (same source FinesPage already loads for
    // Clear Fine's own currency-matching UI).
    const savingsCurrency = accounts?.find(a => a.account_type === 'SAVINGS')?.currency_code;

    const toggleFine = (fine) => {
        if (savingsCurrency && fine.currency_code !== savingsCurrency) return;
        setSelected(p => ({ ...p, [fine.id]: !p[fine.id] }));
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (selectedFines.length === 0 || overBalance) return;
        setLoading(true);
        setError(null);
        try {
            const payload = {
                fine_ids: selectedFines.map(f => f.id),
                settlement_date: settlementDate,
                notes: notes || undefined,
            };
            if (mode === 'entry') {
                await finesAPI.createSettlement({ ...payload, user_id: parseInt(userId) });
            } else {
                await finesAPI.requestSettlement(payload);
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
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">Settle Fines With Savings</h2>
                    <p className="text-sm text-gray-400 mb-4">
                        {mode === 'entry'
                            ? "Pays one or more of the member's outstanding fines straight out of their savings principal. Nothing moves until the member confirms."
                            : 'Pays one or more of your outstanding fines straight out of your own savings principal. Nothing moves until the Treasurer/Assistant Treasurer approves.'}
                    </p>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        {mode === 'entry' && (
                            <div>
                                <label className="label">Member *</label>
                                <select className="input" value={userId}
                                    onChange={e => setUserId(e.target.value)} required>
                                    <option value="">Select member...</option>
                                    {members.map(m => (
                                        <option key={m.id} value={m.id}>{m.first_name} {m.last_name}</option>
                                    ))}
                                </select>
                            </div>
                        )}

                        {balance && (
                            <div className="bg-primary-50 border border-primary-200 rounded-lg p-3 text-sm space-y-1">
                                <p className="text-primary-700">
                                    Savings balance: <span className="font-bold">{formatNumber(principalBalance)} {savingsCurrency}</span>
                                </p>
                                {selectedTotal > 0 && (
                                    <>
                                        <p className="text-gray-600">
                                            Selected to settle: <span className="font-bold">{formatNumber(selectedTotal)} {savingsCurrency}</span>
                                        </p>
                                        <p className={overBalance ? 'text-red-600 font-bold' : 'text-gray-600'}>
                                            Balance after settlement: {formatNumber(remainingAfter)} {savingsCurrency}
                                        </p>
                                    </>
                                )}
                            </div>
                        )}

                        {(mode === 'request' || userId) && (
                            <div>
                                <label className="label">Outstanding Fines *</label>
                                {outstandingFines.length === 0 ? (
                                    <p className="text-sm text-gray-400 italic">
                                        {mode === 'request' ? "You have no outstanding fines." : 'This member has no outstanding fines.'}
                                    </p>
                                ) : (
                                    <div className="border border-gray-200 rounded-lg divide-y max-h-56 overflow-y-auto">
                                        {outstandingFines.map(f => {
                                            const mismatched = savingsCurrency && f.currency_code !== savingsCurrency;
                                            return (
                                                <label key={f.id}
                                                    className={`flex items-center justify-between gap-3 px-3 py-2 text-sm ${mismatched ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer hover:bg-gray-50'}`}>
                                                    <span className="flex items-center gap-2">
                                                        <input type="checkbox" checked={!!selected[f.id]} disabled={mismatched}
                                                            onChange={() => toggleFine(f)} />
                                                        <span>
                                                            <span className="font-mono text-xs text-primary-700">{f.reference_code}</span>
                                                            {' — '}{reasonLabel(f.reason)}
                                                            {mismatched && <span className="text-xs text-red-500 ml-1">(different currency)</span>}
                                                        </span>
                                                    </span>
                                                    <span className="font-bold text-gray-900">{formatNumber(f.amount)} {f.currency_code}</span>
                                                </label>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        )}

                        <div>
                            <label className="label">Settlement Date *</label>
                            <input type="date" className="input" value={settlementDate}
                                max={new Date().toISOString().slice(0, 10)}
                                onChange={e => setSettlementDate(e.target.value)} required />
                        </div>
                        <div>
                            <label className="label">Notes</label>
                            <textarea className="input" rows={2} value={notes}
                                onChange={e => setNotes(e.target.value)} />
                        </div>

                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading || selectedFines.length === 0 || overBalance}
                                className="btn-primary">
                                {loading ? 'Submitting...' : mode === 'entry' ? 'Record Settlement' : 'Request Settlement'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// SETTLEMENT ITEMS MODAL — shows exactly which fines a given
// settlement covers (both "mine" and "all" history views use this).
// ============================================================
const SettlementItemsModal = ({ isOpen, onClose, settlement }) => {
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (isOpen && settlement) {
            setLoading(true);
            setError(null);
            finesAPI.getSettlementItems(settlement.id)
                .then(r => setItems(r.data.data || []))
                .catch(err => setError(getErrorMessage(err)))
                .finally(() => setLoading(false));
        }
    }, [isOpen, settlement]);

    if (!isOpen || !settlement) return null;

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            <div className="fixed inset-0 bg-black bg-opacity-40" onClick={onClose} />
            <div className="flex min-h-full items-center justify-center p-4">
                <div className="relative bg-white rounded-xl shadow-xl max-w-md w-full p-6">
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">Settlement Items</h2>
                    <p className="text-sm text-gray-400 mb-4">
                        {settlement.reference_code} — {formatNumber(settlement.total_amount)} {settlement.currency_code} across {settlement.fine_count} fine(s)
                    </p>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    {loading ? (
                        <p className="text-sm text-gray-400">Loading...</p>
                    ) : (
                        <div className="border border-gray-200 rounded-lg divide-y">
                            {items.map(item => (
                                <div key={item.id} className="flex items-center justify-between px-3 py-2 text-sm">
                                    <div>
                                        <p className="text-gray-900">{reasonLabel(item.reason)}</p>
                                        {item.fine_description && <p className="text-xs text-gray-400">{item.fine_description}</p>}
                                    </div>
                                    <span className="font-bold text-gray-900">{formatNumber(item.amount)} {settlement.currency_code}</span>
                                </div>
                            ))}
                        </div>
                    )}
                    <div className="flex justify-end pt-4">
                        <button type="button" onClick={onClose} className="btn-secondary">Close</button>
                    </div>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// MAIN FINES PAGE
// ============================================================
const FinesPage = () => {
    const { hasPermission } = useAuth();
    const confirm = useConfirm();
    const [myFines, setMyFines] = useState([]);
    const [allFines, setAllFines] = useState([]);
    const [mySettlements, setMySettlements] = useState([]);
    const [allSettlements, setAllSettlements] = useState([]);
    const [members, setMembers] = useState([]);
    const [accounts, setAccounts] = useState([]);
    const [categories, setCategories] = useState([]);
    const [currencies, setCurrencies] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [activeTab, setActiveTab] = useState('mine');
    const [showAssign, setShowAssign] = useState(false);
    const [clearingFine, setClearingFine] = useState(null);
    const [ackFine, setAckFine] = useState(null);
    const [showSettleEntry, setShowSettleEntry] = useState(false);
    const [showSettleRequest, setShowSettleRequest] = useState(false);
    const [viewingSettlement, setViewingSettlement] = useState(null);
    const [settlementActionLoading, setSettlementActionLoading] = useState(null);

    const canView = hasPermission('FINE_VIEW');
    const canManage = hasPermission('FINE_MANAGE');

    const loadMine = useCallback(async () => {
        try {
            const res = await finesAPI.getMine();
            setMyFines(res.data.data || []);
        } catch (err) {
            setError(getErrorMessage(err));
        }
    }, []);

    const loadAll = useCallback(async () => {
        if (!canView) return;
        try {
            const res = await finesAPI.getAll({ limit: 200 });
            setAllFines(res.data.data || []);
        } catch (err) {
            setError(getErrorMessage(err));
        }
    }, [canView]);

    // Settle Fines With Savings (v1.59.0) — settlement history, both
    // directions. "Mine" covers every settlement concerning this
    // member (whichever side it came from); "All" is Treasurer
    // oversight, same FINE_VIEW gate as All Fines.
    const loadMySettlements = useCallback(async () => {
        try {
            const res = await finesAPI.getMySettlements();
            setMySettlements(res.data.data || []);
        } catch (err) {
            setError(getErrorMessage(err));
        }
    }, []);

    const loadAllSettlements = useCallback(async () => {
        if (!canView) return;
        try {
            const res = await finesAPI.getAllSettlements({ limit: 200 });
            setAllSettlements(res.data.data || []);
        } catch (err) {
            setError(getErrorMessage(err));
        }
    }, [canView]);

    useEffect(() => {
        (async () => {
            setLoading(true);
            await Promise.all([loadMine(), loadAll(), loadMySettlements(), loadAllSettlements()]);
            setLoading(false);
        })();
        if (canManage) {
            usersAPI.getAllUsers({ is_active: true, limit: 500 }).then(r => setMembers(r.data.data || [])).catch(() => {});
            accountsAPI.getCurrencies().then(r => setCurrencies(r.data.data || [])).catch(() => {});
        }
        if (canManage || canView) {
            accountsAPI.getAll().then(r => setAccounts(r.data.data || [])).catch(() => {});
        }
        categoriesAPI.getAll({ flat: true }).then(r => setCategories(r.data.data || [])).catch(() => {});
    }, [loadMine, loadAll, loadMySettlements, loadAllSettlements, canManage, canView]);

    const refreshAll = () => { loadMine(); loadAll(); loadMySettlements(); loadAllSettlements(); };

    // --- Settle Fines With Savings actions ---
    const handleConfirmSettlement = async (id) => {
        const ok = await confirm({
            title: 'Confirm Settlement',
            message: 'Confirm settling these fine(s) from your savings? This cannot be undone.',
        });
        if (!ok) return;
        setSettlementActionLoading(id);
        try {
            await finesAPI.confirmSettlement(id);
            refreshAll();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setSettlementActionLoading(null);
        }
    };

    const handleRejectSettlement = async (id) => {
        const reason = await confirm({
            title: 'Reject Settlement', message: "What's wrong with this settlement?",
            requireInput: true, inputLabel: 'Reason', confirmLabel: 'Reject', danger: true,
        });
        if (!reason) return;
        setSettlementActionLoading(id);
        try {
            await finesAPI.rejectSettlement(id, { reason });
            refreshAll();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setSettlementActionLoading(null);
        }
    };

    const handleApproveSettlement = async (id) => {
        const ok = await confirm({
            title: 'Approve Settlement',
            message: "Approve settling these fine(s) out of the member's savings? This cannot be undone.",
        });
        if (!ok) return;
        setSettlementActionLoading(id);
        try {
            await finesAPI.approveSettlement(id);
            refreshAll();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setSettlementActionLoading(null);
        }
    };

    const handleDenySettlement = async (id) => {
        const reason = await confirm({
            title: 'Deny Settlement', message: "Why are you denying this request?",
            requireInput: true, inputLabel: 'Reason', confirmLabel: 'Deny', danger: true,
        });
        if (!reason) return;
        setSettlementActionLoading(id);
        try {
            await finesAPI.denySettlement(id, { reason });
            refreshAll();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setSettlementActionLoading(null);
        }
    };

    const myOutstanding = myFines.filter(f => f.status === 'OUTSTANDING');
    const myOutstandingTotal = myOutstanding.reduce((acc, f) => {
        const key = f.currency_code;
        acc[key] = (acc[key] || 0) + parseFloat(f.amount);
        return acc;
    }, {});

    const myFinesColumns = [
        { header: 'Reference', render: row => <span className="font-mono text-xs font-medium text-primary-700">{row.reference_code}</span> },
        { header: 'Reason', render: row => (
            <div>
                <p className="text-sm text-gray-900">{reasonLabel(row.reason)}</p>
                {row.description && <p className="text-xs text-gray-400">{row.description}</p>}
            </div>
        ) },
        { header: 'Amount', render: row => (
            <span className="text-sm font-bold text-gray-900">{formatNumber(row.amount)} {row.currency_code}</span>
        ) },
        { header: 'Status', render: row => <StatusBadge status={row.status} /> },
        { header: 'Assigned', render: row => <span className="text-sm text-gray-500">{formatDate(row.created_at)}</span> },
        { header: 'Paid Date', render: row => <span className="text-sm text-gray-500">{row.paid_date ? formatDate(row.paid_date) : '—'}</span> },
        { header: 'Actions', render: row => (
            row.status === 'OUTSTANDING' ? (
                <button onClick={() => setAckFine(row)}
                    className="text-xs text-primary-700 hover:text-primary-800 font-medium px-2 py-1 rounded border border-primary-200 hover:bg-primary-50 transition-colors">
                    Request Acknowledgement
                </button>
            ) : null
        ) },
    ];

    const allFinesColumns = [
        { header: 'Reference', render: row => <span className="font-mono text-xs font-medium text-primary-700">{row.reference_code}</span> },
        { header: 'Member', render: row => (
            <div><p className="text-sm font-medium text-gray-900">{row.member_name}</p><p className="text-xs text-gray-400">{row.member_email}</p></div>
        ) },
        { header: 'Reason', render: row => <span className="text-sm text-gray-900">{reasonLabel(row.reason)}</span> },
        { header: 'Amount', render: row => (
            <span className="text-sm font-bold text-gray-900">{formatNumber(row.amount)} {row.currency_code}</span>
        ) },
        { header: 'Status', render: row => <StatusBadge status={row.status} /> },
        { header: 'Assigned By', render: row => <span className="text-xs text-gray-500">{row.assigned_by_name}</span> },
        { header: 'Actions', render: row => (
            row.status === 'OUTSTANDING' && canManage ? (
                <button onClick={() => setClearingFine(row)}
                    className="text-xs text-primary-700 hover:text-primary-800 font-medium px-2 py-1 rounded border border-primary-200 hover:bg-primary-50 transition-colors">
                    Clear Fine
                </button>
            ) : null
        ) },
    ];

    // Columns — My Savings Fine Settlements (confirm/reject a
    // Treasury-direct entry; a request I made just shows its status).
    const mySettlementsColumns = [
        { header: 'Reference', render: row => <span className="font-mono text-xs font-medium text-primary-700">{row.reference_code}</span> },
        { header: 'Fines', render: row => <span className="text-sm text-gray-500">{row.fine_count}</span> },
        { header: 'Amount', render: row => <span className="text-sm font-bold text-gray-900">{formatNumber(row.total_amount)} {row.currency_code}</span> },
        { header: 'Source', render: row => <span className="text-xs text-gray-500">{row.source === 'TREASURY_DIRECT' ? 'Treasury Direct' : 'My Request'}</span> },
        { header: 'Date', render: row => <span className="text-sm text-gray-500">{formatDate(row.settlement_date)}</span> },
        { header: 'Status', render: row => <StatusBadge status={row.status} /> },
        { header: 'Actions', render: row => (
            <div className="flex items-center gap-2">
                {row.source === 'TREASURY_DIRECT' && row.status === 'PENDING_CONFIRMATION' && (
                    <>
                        <button onClick={() => handleConfirmSettlement(row.id)} disabled={settlementActionLoading === row.id}
                            className="p-1.5 rounded-lg bg-green-50 text-green-600 hover:bg-green-100 transition-colors" title="Confirm">
                            <CheckIcon className="h-4 w-4" />
                        </button>
                        <button onClick={() => handleRejectSettlement(row.id)} disabled={settlementActionLoading === row.id}
                            className="p-1.5 rounded-lg bg-red-50 text-red-600 hover:bg-red-100 transition-colors" title="Reject">
                            <XMarkIcon className="h-4 w-4" />
                        </button>
                    </>
                )}
                <button onClick={() => setViewingSettlement(row)}
                    className="p-1.5 rounded-lg bg-gray-50 text-gray-500 hover:bg-gray-100 transition-colors" title="View fines covered">
                    <EyeIcon className="h-4 w-4" />
                </button>
            </div>
        ) },
    ];

    // Columns — All Savings Fine Settlements (Treasurer oversight;
    // approve/deny a member's own request).
    const allSettlementsColumns = [
        { header: 'Reference', render: row => <span className="font-mono text-xs font-medium text-primary-700">{row.reference_code}</span> },
        { header: 'Member', render: row => <p className="text-sm font-medium text-gray-900">{row.member_name}</p> },
        { header: 'Fines', render: row => <span className="text-sm text-gray-500">{row.fine_count}</span> },
        { header: 'Amount', render: row => <span className="text-sm font-bold text-gray-900">{formatNumber(row.total_amount)} {row.currency_code}</span> },
        { header: 'Source', render: row => <span className="text-xs text-gray-500">{row.source === 'TREASURY_DIRECT' ? 'Treasury Direct' : 'Member Request'}</span> },
        { header: 'Initiated By', render: row => <span className="text-xs text-gray-500">{row.initiated_by_name}</span> },
        { header: 'Date', render: row => <span className="text-sm text-gray-500">{formatDate(row.settlement_date)}</span> },
        { header: 'Status', render: row => <StatusBadge status={row.status} /> },
        { header: 'Actions', render: row => (
            <div className="flex items-center gap-2">
                {row.source === 'MEMBER_REQUEST' && row.status === 'PENDING_APPROVAL' && canManage && (
                    <>
                        <button onClick={() => handleApproveSettlement(row.id)} disabled={settlementActionLoading === row.id}
                            className="p-1.5 rounded-lg bg-green-50 text-green-600 hover:bg-green-100 transition-colors" title="Approve">
                            <CheckIcon className="h-4 w-4" />
                        </button>
                        <button onClick={() => handleDenySettlement(row.id)} disabled={settlementActionLoading === row.id}
                            className="p-1.5 rounded-lg bg-red-50 text-red-600 hover:bg-red-100 transition-colors" title="Deny">
                            <XMarkIcon className="h-4 w-4" />
                        </button>
                    </>
                )}
                <button onClick={() => setViewingSettlement(row)}
                    className="p-1.5 rounded-lg bg-gray-50 text-gray-500 hover:bg-gray-100 transition-colors" title="View fines covered">
                    <EyeIcon className="h-4 w-4" />
                </button>
            </div>
        ) },
    ];

    return (
        <div>
            <PageHeader
                title="Fines"
                subtitle="Fines and penalties assigned to shareholders — special income to the company"
                actions={
                    canManage ? (
                        <div className="flex gap-2">
                            <button onClick={() => setShowSettleEntry(true)} className="btn-secondary flex items-center gap-2">
                                <BanknotesIcon className="h-4 w-4" />
                                Settle With Savings
                            </button>
                            <button onClick={() => setShowAssign(true)} className="btn-primary flex items-center gap-2">
                                <PlusIcon className="h-4 w-4" />
                                Assign Fine
                            </button>
                        </div>
                    ) : null
                }
            />

            {error && (
                <div className="mb-4">
                    <ErrorMessage message={error} onDismiss={() => setError(null)} />
                </div>
            )}

            {myOutstanding.length > 0 && (
                <div className="card flex items-start gap-4 mb-6 bg-red-50 border-red-100">
                    <ExclamationTriangleIcon className="h-6 w-6 text-red-500 flex-shrink-0 mt-0.5" />
                    <div className="flex-1">
                        <p className="text-sm font-medium text-red-800">
                            You have {myOutstanding.length} outstanding fine{myOutstanding.length > 1 ? 's' : ''}
                        </p>
                        <p className="text-xs text-red-700 mt-0.5">
                            {Object.entries(myOutstandingTotal).map(([code, amt]) => `${formatNumber(amt)} ${code}`).join(', ')}
                        </p>
                    </div>
                    <button onClick={() => setShowSettleRequest(true)}
                        className="text-xs text-primary-700 hover:text-primary-800 font-medium px-3 py-1.5 rounded border border-primary-200 hover:bg-primary-50 transition-colors flex items-center gap-1.5 flex-shrink-0">
                        <BanknotesIcon className="h-4 w-4" />
                        Settle With My Savings
                    </button>
                </div>
            )}

            <div className="flex gap-2 mb-6 flex-wrap">
                <button onClick={() => setActiveTab('mine')}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === 'mine' ? 'bg-primary-700 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                    My Fines
                </button>
                {canView && (
                    <button onClick={() => setActiveTab('all')}
                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === 'all' ? 'bg-primary-700 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                        All Fines
                    </button>
                )}
            </div>

            {activeTab === 'mine' && (
                <>
                    <DataTable
                        columns={myFinesColumns}
                        data={myFines}
                        loading={loading}
                        emptyMessage="No fines on your account"
                        searchable
                        searchPlaceholder="Search my fines..."
                    />
                    {mySettlements.length > 0 && (
                        <div className="mt-8">
                            <h3 className="text-sm font-semibold text-gray-700 mb-3">My Savings Fine Settlements</h3>
                            <DataTable
                                columns={mySettlementsColumns}
                                data={mySettlements}
                                loading={loading}
                                emptyMessage="No settlements yet"
                            />
                        </div>
                    )}
                </>
            )}

            {activeTab === 'all' && canView && (
                <>
                    <DataTable
                        columns={allFinesColumns}
                        data={allFines}
                        loading={loading}
                        emptyMessage="No fines assigned yet"
                        searchable
                        searchPlaceholder="Search all fines..."
                    />
                    {allSettlements.length > 0 && (
                        <div className="mt-8">
                            <h3 className="text-sm font-semibold text-gray-700 mb-3">Savings Fine Settlements</h3>
                            <DataTable
                                columns={allSettlementsColumns}
                                data={allSettlements}
                                loading={loading}
                                emptyMessage="No settlements yet"
                            />
                        </div>
                    )}
                </>
            )}

            <AssignFineModal
                isOpen={showAssign}
                onClose={() => setShowAssign(false)}
                onSuccess={refreshAll}
                members={members}
                currencies={currencies}
            />
            <ClearFineModal
                isOpen={!!clearingFine}
                onClose={() => setClearingFine(null)}
                onSuccess={refreshAll}
                fine={clearingFine}
                accounts={accounts}
            />
            <RequestAckModal
                isOpen={!!ackFine}
                onClose={() => setAckFine(null)}
                onSuccess={refreshAll}
                fine={ackFine}
                categories={categories}
            />
            <SettleFinesModal
                isOpen={showSettleEntry}
                onClose={() => setShowSettleEntry(false)}
                onSuccess={refreshAll}
                mode="entry"
                members={members}
                allFines={allFines}
                accounts={accounts}
            />
            <SettleFinesModal
                isOpen={showSettleRequest}
                onClose={() => setShowSettleRequest(false)}
                onSuccess={refreshAll}
                mode="request"
                myOutstanding={myOutstanding}
                accounts={accounts}
            />
            <SettlementItemsModal
                isOpen={!!viewingSettlement}
                onClose={() => setViewingSettlement(null)}
                settlement={viewingSettlement}
            />
        </div>
    );
};

export default FinesPage;
