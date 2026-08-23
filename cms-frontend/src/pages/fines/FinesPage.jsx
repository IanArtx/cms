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
import { finesAPI, requisitionsAPI, usersAPI, accountsAPI, categoriesAPI } from '../../api/endpoints';
import { formatDate, formatNumber, getErrorMessage } from '../../utils/helpers';
import PageHeader from '../../components/common/PageHeader';
import DataTable from '../../components/common/DataTable';
import ErrorMessage from '../../components/common/ErrorMessage';
import StatusBadge from '../../components/common/StatusBadge';
import { useAuth } from '../../contexts/AuthContext';
import { PlusIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';

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
// MAIN FINES PAGE
// ============================================================
const FinesPage = () => {
    const { hasPermission } = useAuth();
    const [myFines, setMyFines] = useState([]);
    const [allFines, setAllFines] = useState([]);
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

    useEffect(() => {
        (async () => {
            setLoading(true);
            await Promise.all([loadMine(), loadAll()]);
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
    }, [loadMine, loadAll, canManage, canView]);

    const refreshAll = () => { loadMine(); loadAll(); };

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

    return (
        <div>
            <PageHeader
                title="Fines"
                subtitle="Fines and penalties assigned to shareholders — special income to the company"
                actions={
                    canManage ? (
                        <button onClick={() => setShowAssign(true)} className="btn-primary flex items-center gap-2">
                            <PlusIcon className="h-4 w-4" />
                            Assign Fine
                        </button>
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
                    <div>
                        <p className="text-sm font-medium text-red-800">
                            You have {myOutstanding.length} outstanding fine{myOutstanding.length > 1 ? 's' : ''}
                        </p>
                        <p className="text-xs text-red-700 mt-0.5">
                            {Object.entries(myOutstandingTotal).map(([code, amt]) => `${formatNumber(amt)} ${code}`).join(', ')}
                        </p>
                    </div>
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
                <DataTable
                    columns={myFinesColumns}
                    data={myFines}
                    loading={loading}
                    emptyMessage="No fines on your account"
                    searchable
                    searchPlaceholder="Search my fines..."
                />
            )}

            {activeTab === 'all' && canView && (
                <DataTable
                    columns={allFinesColumns}
                    data={allFines}
                    loading={loading}
                    emptyMessage="No fines assigned yet"
                    searchable
                    searchPlaceholder="Search all fines..."
                />
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
        </div>
    );
};

export default FinesPage;
