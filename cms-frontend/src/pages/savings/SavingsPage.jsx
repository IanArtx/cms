// ============================================================
// MEMBER SAVINGS PAGE
// Two entry types under the hood:
//   FLEXIBLE   — an ongoing balance built from many deposits, earning
//                interest automatically. Deposits need Treasurer/Assistant
//                approval; payouts ("handouts") are entered by the
//                Treasurer/Assistant Treasurer but only actually move
//                once the receiving member confirms them.
//   FIXED_TERM — legacy lump-sum deposit with an agreed rate and a
//                fixed maturity date, withdrawn in full at maturity.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { savingsAPI, usersAPI, categoriesAPI } from '../../api/endpoints';
import { formatDate, formatNumber, getErrorMessage } from '../../utils/helpers';
import PageHeader from '../../components/common/PageHeader';
import DataTable from '../../components/common/DataTable';
import ErrorMessage from '../../components/common/ErrorMessage';
import StatusBadge from '../../components/common/StatusBadge';
import { useAuth } from '../../contexts/AuthContext';
import { PlusIcon, CheckIcon, XMarkIcon, Cog6ToothIcon, ArrowDownTrayIcon } from '@heroicons/react/24/outline';
import { txFromRow, transactionTemplate, printDocument } from '../../utils/exportUtils';
import DocumentPreviewModal from '../../components/common/DocumentPreviewModal';

// ============================================================
// RECORD DEPOSIT MODAL (Treasurer/Assistant Treasurer)
// ============================================================
const RecordDepositModal = ({ isOpen, onClose, onSuccess, members, categories }) => {
    const [form, setForm] = useState({
        user_id: '', category_id: '', amount: '', deposit_date: '', notes: '',
    });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    if (!isOpen) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await savingsAPI.create({ ...form, amount: parseFloat(form.amount) });
            onSuccess();
            onClose();
            setForm({ user_id: '', category_id: '', amount: '', deposit_date: '', notes: '' });
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
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">Record Savings Deposit</h2>
                    <p className="text-sm text-gray-400 mb-4">
                        Sits with the Treasurer/Assistant Treasurer for approval before it's added to the member's balance.
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
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="label">Amount *</label>
                                <input type="number" className="input" value={form.amount}
                                    onChange={e => setForm(p => ({ ...p, amount: e.target.value }))}
                                    min="0.01" step="0.01" required />
                            </div>
                            <div>
                                <label className="label">Deposit Date *</label>
                                <input type="date" className="input" value={form.deposit_date}
                                    max={new Date().toISOString().slice(0, 10)}
                                    onChange={e => setForm(p => ({ ...p, deposit_date: e.target.value }))} required />
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
                                {loading ? 'Recording...' : 'Record Deposit'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// RECORD HANDOUT MODAL (Treasurer/Assistant Treasurer)
// ============================================================
const RecordHandoutModal = ({ isOpen, onClose, onSuccess, members, categories }) => {
    const [form, setForm] = useState({
        user_id: '', category_id: '', principal_amount: '',
        interest_amount: '', handout_date: '', notes: '',
    });
    const [memberBalance, setMemberBalance] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (form.user_id) {
            savingsAPI.getBalanceForUser(form.user_id)
                .then(r => {
                    setMemberBalance(r.data.data);
                    setForm(p => ({ ...p, interest_amount: r.data.data.accrued_interest || '' }));
                })
                .catch(() => setMemberBalance(null));
        } else {
            setMemberBalance(null);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [form.user_id]);

    if (!isOpen) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await savingsAPI.createHandout({
                ...form,
                principal_amount: parseFloat(form.principal_amount),
                interest_amount: form.interest_amount ? parseFloat(form.interest_amount) : 0,
            });
            onSuccess();
            onClose();
            setForm({ user_id: '', category_id: '', principal_amount: '', interest_amount: '', handout_date: '', notes: '' });
            setMemberBalance(null);
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
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">Record Savings Handout</h2>
                    <p className="text-sm text-gray-400 mb-4">
                        Always paid out of the Savings account — nothing moves yet, the member must
                        confirm they received it before this posts.
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
                        {memberBalance && (
                            <div className="bg-primary-50 border border-primary-200 rounded-lg p-3 text-sm">
                                <p className="text-primary-700">
                                    Available principal: <span className="font-bold">{formatNumber(memberBalance.principal_balance)}</span>
                                    {' · '}Accrued interest: <span className="font-bold">{formatNumber(memberBalance.accrued_interest)}</span>
                                </p>
                            </div>
                        )}
                        <div>
                            <label className="label">Category *</label>
                            <select className="input" value={form.category_id}
                                onChange={e => setForm(p => ({ ...p, category_id: e.target.value }))} required>
                                <option value="">Select category...</option>
                                {categories.filter(c => c.module === 'FINANCE').map(c => (
                                    <option key={c.id} value={c.id}>{c.full_path || c.name}</option>
                                ))}
                            </select>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="label">Principal Amount *</label>
                                <input type="number" className="input" value={form.principal_amount}
                                    onChange={e => setForm(p => ({ ...p, principal_amount: e.target.value }))}
                                    min="0.01" step="0.01" required />
                            </div>
                            <div>
                                <label className="label">Interest Amount</label>
                                <input type="number" className="input" value={form.interest_amount}
                                    onChange={e => setForm(p => ({ ...p, interest_amount: e.target.value }))}
                                    min="0" step="0.01" />
                                <p className="text-xs text-gray-400 mt-1">Pre-filled from accrued interest — adjust if needed</p>
                            </div>
                        </div>
                        <div>
                            <label className="label">Handout Date *</label>
                            <input type="date" className="input" value={form.handout_date}
                                max={new Date().toISOString().slice(0, 10)}
                                onChange={e => setForm(p => ({ ...p, handout_date: e.target.value }))} required />
                        </div>
                        <div>
                            <label className="label">Notes</label>
                            <textarea className="input" rows={2} value={form.notes}
                                onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} />
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading} className="btn-primary">
                                {loading ? 'Recording...' : 'Record Handout'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// RECORD POOL INFLOW MODAL (Treasurer/Assistant Treasurer)
// A non-member credit into the savings pool — e.g. the fund was
// invested and paid a profit back. NOT a member deposit — doesn't
// touch any member's balance. Sits PENDING_APPROVAL, same pipeline
// as a member deposit.
// ============================================================
const RecordPoolInflowModal = ({ isOpen, onClose, onSuccess, categories }) => {
    const [form, setForm] = useState({
        category_id: '', amount: '', value_date: '', description: '',
    });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    if (!isOpen) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await savingsAPI.createPoolInflow({ ...form, amount: parseFloat(form.amount) });
            onSuccess();
            onClose();
            setForm({ category_id: '', amount: '', value_date: '', description: '' });
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
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">Record Savings Pool Inflow</h2>
                    <p className="text-sm text-gray-400 mb-4">
                        A non-member credit into the pool — e.g. profit from investing the fund.
                        This is not a member deposit. Sits with the Treasurer/Assistant Treasurer
                        for approval, same as a deposit.
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
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="label">Amount *</label>
                                <input type="number" className="input" value={form.amount}
                                    onChange={e => setForm(p => ({ ...p, amount: e.target.value }))}
                                    min="0.01" step="0.01" required />
                            </div>
                            <div>
                                <label className="label">Date *</label>
                                <input type="date" className="input" value={form.value_date}
                                    max={new Date().toISOString().slice(0, 10)}
                                    onChange={e => setForm(p => ({ ...p, value_date: e.target.value }))} required />
                            </div>
                        </div>
                        <div>
                            <label className="label">Description *</label>
                            <textarea className="input" rows={2} value={form.description}
                                onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
                                placeholder="e.g. Profit from Q2 investment payout" required />
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading} className="btn-primary">
                                {loading ? 'Recording...' : 'Record Inflow'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// SETTINGS MODAL (Admin/Treasurer)
// ============================================================
const SettingsModal = ({ isOpen, onClose, onSuccess }) => {
    const [form, setForm] = useState({ interest_rate: '', interest_period: 'ANNUALLY', interest_calculation: 'SIMPLE' });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (isOpen) {
            savingsAPI.getSettings().then(r => {
                const s = r.data.data;
                setForm({
                    interest_rate: s.interest_rate ?? '',
                    interest_period: s.interest_period || 'ANNUALLY',
                    interest_calculation: s.interest_calculation || 'SIMPLE',
                });
            }).catch(() => {});
        }
    }, [isOpen]);

    if (!isOpen) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await savingsAPI.updateSettings({
                ...form,
                interest_rate: parseFloat(form.interest_rate || 0),
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
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">Savings Interest Settings</h2>
                    <p className="text-sm text-gray-400 mb-4">
                        A single company-wide rate applied to every member's savings balance, accrued daily.
                    </p>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">Interest Rate (%) *</label>
                            <input type="number" className="input" value={form.interest_rate}
                                onChange={e => setForm(p => ({ ...p, interest_rate: e.target.value }))}
                                min="0" step="0.01" required />
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="label">Period</label>
                                <select className="input" value={form.interest_period}
                                    onChange={e => setForm(p => ({ ...p, interest_period: e.target.value }))}>
                                    {['DAILY', 'WEEKLY', 'MONTHLY', 'ANNUALLY'].map(p => (
                                        <option key={p} value={p}>{p}</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className="label">Calculation</label>
                                <select className="input" value={form.interest_calculation}
                                    onChange={e => setForm(p => ({ ...p, interest_calculation: e.target.value }))}>
                                    <option value="SIMPLE">Simple</option>
                                    <option value="COMPOUND">Compound</option>
                                </select>
                            </div>
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading} className="btn-primary">
                                {loading ? 'Saving...' : 'Save Settings'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// MAIN SAVINGS PAGE
// ============================================================
const SavingsPage = () => {
    const { hasPermission } = useAuth();
    const [myBalance, setMyBalance] = useState(null);
    const [mySavings, setMySavings] = useState([]);
    const [myHandouts, setMyHandouts] = useState([]);
    const [pendingDeposits, setPendingDeposits] = useState([]);
    const [pendingPoolInflows, setPendingPoolInflows] = useState([]);
    const [allSavings, setAllSavings] = useState([]);
    const [allHandouts, setAllHandouts] = useState([]);
    const [members, setMembers] = useState([]);
    const [categories, setCategories] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [activeTab, setActiveTab] = useState('mine');
    const [showDeposit, setShowDeposit] = useState(false);
    const [showHandout, setShowHandout] = useState(false);
    const [showPoolInflow, setShowPoolInflow] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [actionLoading, setActionLoading] = useState(null);
    const [preview, setPreview] = useState(null);

    const canCreate   = hasPermission('SAVINGS_CREATE');
    const canApprove  = hasPermission('SAVINGS_APPROVE');
    const canHandout  = hasPermission('SAVINGS_HANDOUT_CREATE');
    const canView     = hasPermission('SAVINGS_VIEW');
    const canSettings = hasPermission('SAVINGS_SETTINGS_MANAGE');

    const loadMine = useCallback(async () => {
        try {
            setLoading(true);
            const [balRes, savRes, hoRes] = await Promise.all([
                savingsAPI.getMyBalance(),
                savingsAPI.getMySavings(),
                savingsAPI.getMyHandouts(),
            ]);
            setMyBalance(balRes.data.data);
            setMySavings(savRes.data.data || []);
            setMyHandouts(hoRes.data.data || []);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, []);

    const loadApprovals = useCallback(async () => {
        if (!canApprove) return;
        try {
            const [depRes, poolRes] = await Promise.all([
                savingsAPI.getAll({ status: 'PENDING_APPROVAL', entry_type: 'FLEXIBLE' }),
                savingsAPI.getPoolInflows({ status: 'PENDING_APPROVAL' }),
            ]);
            setPendingDeposits(depRes.data.data || []);
            setPendingPoolInflows(poolRes.data.data || []);
        } catch (err) {
            setError(getErrorMessage(err));
        }
    }, [canApprove]);

    const loadManage = useCallback(async () => {
        if (!canView) return;
        try {
            const [savRes, hoRes] = await Promise.all([
                savingsAPI.getAll({ limit: 50 }),
                savingsAPI.getAllHandouts({ limit: 50 }),
            ]);
            setAllSavings(savRes.data.data || []);
            setAllHandouts(hoRes.data.data || []);
        } catch (err) {
            setError(getErrorMessage(err));
        }
    }, [canView]);

    useEffect(() => {
        loadMine();
        loadApprovals();
        loadManage();
        if (canCreate || canHandout) {
            usersAPI.getAllUsers({ is_active: true, limit: 500 }).then(r => setMembers(r.data.data || [])).catch(() => {});
            categoriesAPI.getAll({ flat: true }).then(r => setCategories(r.data.data || [])).catch(() => {});
        }
    }, [loadMine, loadApprovals, loadManage, canCreate, canHandout]);

    const refreshAll = () => { loadMine(); loadApprovals(); loadManage(); };

    const handleApproveDeposit = async (id) => {
        setActionLoading(id);
        try {
            await savingsAPI.approve(id, {});
            refreshAll();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setActionLoading(null);
        }
    };

    const handleRejectDeposit = async (id) => {
        const review_notes = window.prompt('Reason for rejecting this deposit:');
        if (!review_notes) return;
        setActionLoading(id);
        try {
            await savingsAPI.reject(id, { review_notes });
            refreshAll();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setActionLoading(null);
        }
    };

    const handleApprovePoolInflow = async (id) => {
        setActionLoading(id);
        try {
            await savingsAPI.approvePoolInflow(id, {});
            refreshAll();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setActionLoading(null);
        }
    };

    const handleRejectPoolInflow = async (id) => {
        const review_notes = window.prompt('Reason for rejecting this pool inflow:');
        if (!review_notes) return;
        setActionLoading(id);
        try {
            await savingsAPI.rejectPoolInflow(id, { review_notes });
            refreshAll();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setActionLoading(null);
        }
    };

    const handleConfirmHandout = async (id) => {
        if (!window.confirm('Confirm you received this savings handout? This cannot be undone.')) return;
        setActionLoading(id);
        try {
            await savingsAPI.confirmHandout(id);
            refreshAll();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setActionLoading(null);
        }
    };

    const handleRejectHandout = async (id) => {
        const reason = window.prompt('What\'s wrong with this handout?');
        if (!reason) return;
        setActionLoading(id);
        try {
            await savingsAPI.rejectHandout(id, { reason });
            refreshAll();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setActionLoading(null);
        }
    };

    const handleWithdrawFixedTerm = async (id) => {
        if (!window.confirm('Process this fixed-term savings withdrawal? This cannot be undone.')) return;
        setActionLoading(id);
        try {
            await savingsAPI.withdraw(id);
            refreshAll();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setActionLoading(null);
        }
    };

    // Shared "Transaction" column (v1.32.0) — preview/download the
    // linked transaction as a proper statement, reused on both My
    // Savings (deposits) and My Handouts below. Hidden (—) on rows
    // with no linked transaction yet (a still-pending deposit/handout).
    const transactionColumn = {
        header: 'Transaction',
        render: row => {
            const tx = txFromRow(row);
            if (!tx) return <span className="text-xs text-gray-300">—</span>;
            return (
                <div className="flex items-center gap-2">
                    <button onClick={() => setPreview({ html: transactionTemplate(tx), title: tx.reference_code })}
                        className="font-mono text-xs font-medium text-primary-700 hover:underline" title="Preview">
                        {tx.reference_code}
                    </button>
                    <button onClick={() => printDocument(transactionTemplate(tx), tx.reference_code)}
                        className="text-gray-400 hover:text-gray-600" title="Download">
                        <ArrowDownTrayIcon className="h-4 w-4" />
                    </button>
                </div>
            );
        },
    };

    // Columns — My Savings
    const mySavingsColumns = [
        { header: 'Reference', render: row => <span className="font-mono text-xs font-medium text-primary-700">{row.reference_code}</span> },
        { header: 'Type', render: row => <span className="text-xs text-gray-500">{row.entry_type === 'FIXED_TERM' ? 'Fixed-Term' : 'Flexible'}</span> },
        { header: 'Amount', render: row => (
            <span className="text-sm font-bold text-gray-900">
                {row.currency_code} {formatNumber(row.principal_amount)}
            </span>
        ) },
        { header: 'Deposit Date', render: row => <span className="text-sm text-gray-500">{formatDate(row.deposit_date)}</span> },
        { header: 'Maturity', render: row => row.maturity_date ? (
            <div>
                <p className="text-sm text-gray-700">{formatDate(row.maturity_date)}</p>
                {row.status === 'ACTIVE' && (
                    <p className="text-xs text-gray-400">{row.is_matured ? '✅ Ready for withdrawal' : `${row.days_to_maturity} days left`}</p>
                )}
            </div>
        ) : <span className="text-xs text-gray-300">—</span> },
        { header: 'Status', render: row => <StatusBadge status={row.status} /> },
        transactionColumn,
        { header: 'Actions', render: row => (
            row.entry_type === 'FIXED_TERM' && row.is_matured && row.status === 'ACTIVE' && hasPermission('FINANCE_TRANSACTION_CREATE') ? (
                <button onClick={() => handleWithdrawFixedTerm(row.id)} disabled={actionLoading === row.id}
                    className="text-xs text-green-600 hover:text-green-700 font-medium px-2 py-1 rounded border border-green-200 hover:bg-green-50 transition-colors">
                    Withdraw
                </button>
            ) : null
        ) },
    ];

    // Columns — My Handouts (confirm/reject)
    const myHandoutsColumns = [
        { header: 'Reference', render: row => <span className="font-mono text-xs font-medium text-primary-700">{row.reference_code}</span> },
        { header: 'Principal', render: row => <span className="text-sm text-gray-900">{row.currency_code} {formatNumber(row.principal_amount)}</span> },
        { header: 'Interest', render: row => <span className="text-sm text-green-600">{row.currency_code} {formatNumber(row.interest_amount)}</span> },
        { header: 'Total', render: row => <span className="text-sm font-bold text-primary-700">{row.currency_code} {formatNumber(row.total_amount)}</span> },
        { header: 'Date', render: row => <span className="text-sm text-gray-500">{formatDate(row.handout_date)}</span> },
        { header: 'Status', render: row => <StatusBadge status={row.status} /> },
        transactionColumn,
        { header: 'Actions', render: row => (
            row.status === 'PENDING_CONFIRMATION' ? (
                <div className="flex gap-2">
                    <button onClick={() => handleConfirmHandout(row.id)} disabled={actionLoading === row.id}
                        className="p-1.5 rounded-lg bg-green-50 text-green-600 hover:bg-green-100 transition-colors" title="Confirm I received this">
                        <CheckIcon className="h-4 w-4" />
                    </button>
                    <button onClick={() => handleRejectHandout(row.id)} disabled={actionLoading === row.id}
                        className="p-1.5 rounded-lg bg-red-50 text-red-600 hover:bg-red-100 transition-colors" title="Dispute this handout">
                        <XMarkIcon className="h-4 w-4" />
                    </button>
                </div>
            ) : null
        ) },
    ];

    // Columns — Pending Approvals
    const approvalColumns = [
        { header: 'Reference', render: row => <span className="font-mono text-xs font-medium text-primary-700">{row.reference_code}</span> },
        { header: 'Member', render: row => (
            <div><p className="text-sm font-medium text-gray-900">{row.member_name}</p><p className="text-xs text-gray-400">{row.member_email}</p></div>
        ) },
        { header: 'Amount', render: row => <span className="text-sm font-bold text-gray-900">{row.currency_code} {formatNumber(row.principal_amount)}</span> },
        { header: 'Recorded By', render: row => <span className="text-xs text-gray-500">{row.recorded_by_name}</span> },
        { header: 'Source', render: row => <span className="text-xs text-gray-500">{row.source === 'REQUISITION' ? 'Member Request' : 'Treasury Direct'}</span> },
        { header: 'Date', render: row => <span className="text-sm text-gray-500">{formatDate(row.deposit_date)}</span> },
        { header: 'Actions', render: row => (
            <div className="flex gap-2">
                <button onClick={() => handleApproveDeposit(row.id)} disabled={actionLoading === row.id}
                    className="p-1.5 rounded-lg bg-green-50 text-green-600 hover:bg-green-100 transition-colors" title="Approve">
                    <CheckIcon className="h-4 w-4" />
                </button>
                <button onClick={() => handleRejectDeposit(row.id)} disabled={actionLoading === row.id}
                    className="p-1.5 rounded-lg bg-red-50 text-red-600 hover:bg-red-100 transition-colors" title="Reject">
                    <XMarkIcon className="h-4 w-4" />
                </button>
            </div>
        ) },
    ];

    // Columns — Pending Pool Inflows
    const poolInflowColumns = [
        { header: 'Reference', render: row => <span className="font-mono text-xs font-medium text-amber-700">{row.reference_code}</span> },
        { header: 'Description', render: row => <p className="text-sm text-gray-700">{row.description}</p> },
        { header: 'Amount', render: row => <span className="text-sm font-bold text-gray-900">{row.currency_code} {formatNumber(row.amount)}</span> },
        { header: 'Recorded By', render: row => <span className="text-xs text-gray-500">{row.recorded_by_name}</span> },
        { header: 'Date', render: row => <span className="text-sm text-gray-500">{formatDate(row.value_date)}</span> },
        { header: 'Actions', render: row => (
            <div className="flex gap-2">
                <button onClick={() => handleApprovePoolInflow(row.id)} disabled={actionLoading === row.id}
                    className="p-1.5 rounded-lg bg-green-50 text-green-600 hover:bg-green-100 transition-colors" title="Approve">
                    <CheckIcon className="h-4 w-4" />
                </button>
                <button onClick={() => handleRejectPoolInflow(row.id)} disabled={actionLoading === row.id}
                    className="p-1.5 rounded-lg bg-red-50 text-red-600 hover:bg-red-100 transition-colors" title="Reject">
                    <XMarkIcon className="h-4 w-4" />
                </button>
            </div>
        ) },
    ];

    // Columns — All Deposits (manage view)
    const allSavingsColumns = [
        { header: 'Reference', render: row => <span className="font-mono text-xs font-medium text-primary-700">{row.reference_code}</span> },
        { header: 'Member', render: row => <p className="text-sm font-medium text-gray-900">{row.member_name}</p> },
        { header: 'Type', render: row => <span className="text-xs text-gray-500">{row.entry_type === 'FIXED_TERM' ? 'Fixed-Term' : 'Flexible'}</span> },
        { header: 'Amount', render: row => <span className="text-sm font-bold text-gray-900">{row.currency_code} {formatNumber(row.principal_amount)}</span> },
        { header: 'Date', render: row => <span className="text-sm text-gray-500">{formatDate(row.deposit_date)}</span> },
        { header: 'Status', render: row => <StatusBadge status={row.status} /> },
    ];

    const allHandoutsColumns = [
        { header: 'Reference', render: row => <span className="font-mono text-xs font-medium text-primary-700">{row.reference_code}</span> },
        { header: 'Member', render: row => <p className="text-sm font-medium text-gray-900">{row.member_name}</p> },
        { header: 'Total', render: row => <span className="text-sm font-bold text-gray-900">{row.currency_code} {formatNumber(row.total_amount)}</span> },
        { header: 'Entered By', render: row => <span className="text-xs text-gray-500">{row.entered_by_name}</span> },
        { header: 'Date', render: row => <span className="text-sm text-gray-500">{formatDate(row.handout_date)}</span> },
        { header: 'Status', render: row => <StatusBadge status={row.status} /> },
    ];

    return (
        <div>
            <PageHeader
                title="Savings"
                subtitle="Personal savings balances, deposits and handouts"
                actions={
                    <div className="flex gap-2">
                        {canSettings && (
                            <button onClick={() => setShowSettings(true)} className="btn-secondary flex items-center gap-2">
                                <Cog6ToothIcon className="h-4 w-4" />
                                Settings
                            </button>
                        )}
                        {canHandout && (
                            <button onClick={() => setShowHandout(true)} className="btn-secondary flex items-center gap-2">
                                <PlusIcon className="h-4 w-4" />
                                New Handout
                            </button>
                        )}
                        {canCreate && (
                            <button onClick={() => setShowPoolInflow(true)} className="btn-secondary flex items-center gap-2">
                                <PlusIcon className="h-4 w-4" />
                                Pool Inflow
                            </button>
                        )}
                        {canCreate && (
                            <button onClick={() => setShowDeposit(true)} className="btn-primary flex items-center gap-2">
                                <PlusIcon className="h-4 w-4" />
                                New Deposit
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

            {/* My Balance Summary */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
                <div className="card">
                    <p className="text-sm text-gray-400">My Savings Balance</p>
                    <p className="text-2xl font-bold text-primary-700 mt-1">
                        {myBalance ? formatNumber(myBalance.principal_balance) : '0.00'}
                    </p>
                </div>
                <div className="card">
                    <p className="text-sm text-gray-400">Accrued Interest</p>
                    <p className="text-2xl font-bold text-green-600 mt-1">
                        {myBalance ? formatNumber(myBalance.accrued_interest) : '0.00'}
                    </p>
                </div>
                <div className="card">
                    <p className="text-sm text-gray-400">Awaiting You</p>
                    <p className="text-2xl font-bold text-gray-900 mt-1">
                        {(myBalance?.pending_deposits || 0) + (myBalance?.pending_handouts || 0)}
                    </p>
                    <p className="text-xs text-gray-400 mt-1">
                        {myBalance?.pending_deposits || 0} deposit(s) pending · {myBalance?.pending_handouts || 0} handout(s) to confirm
                    </p>
                </div>
            </div>

            {/* Tabs */}
            <div className="flex gap-2 mb-6 flex-wrap">
                <button onClick={() => setActiveTab('mine')}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === 'mine' ? 'bg-primary-700 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                    My Savings
                </button>
                {canApprove && (
                    <button onClick={() => setActiveTab('approvals')}
                        className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === 'approvals' ? 'bg-primary-700 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                        Pending Approvals
                        {(pendingDeposits.length + pendingPoolInflows.length) > 0 && (
                            <span className={`text-xs px-1.5 py-0.5 rounded-full font-bold ${activeTab === 'approvals' ? 'bg-white text-primary-700' : 'bg-red-500 text-white'}`}>
                                {pendingDeposits.length + pendingPoolInflows.length}
                            </span>
                        )}
                    </button>
                )}
                {canView && (
                    <button onClick={() => setActiveTab('manage')}
                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === 'manage' ? 'bg-primary-700 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                        All Members
                    </button>
                )}
            </div>

            {activeTab === 'mine' && (
                <>
                    {myHandouts.some(h => h.status === 'PENDING_CONFIRMATION') && (
                        <div className="mb-6">
                            <h3 className="text-sm font-semibold text-gray-700 mb-2">Handouts Awaiting Your Confirmation</h3>
                            <DataTable
                                columns={myHandoutsColumns}
                                data={myHandouts.filter(h => h.status === 'PENDING_CONFIRMATION')}
                                loading={false}
                                emptyMessage="Nothing to confirm"
                            />
                        </div>
                    )}
                    <h3 className="text-sm font-semibold text-gray-700 mb-2">Deposit History</h3>
                    <DataTable
                        columns={mySavingsColumns}
                        data={mySavings}
                        loading={loading}
                        emptyMessage="You have no savings deposits yet"
                        searchable
                        searchPlaceholder="Search my savings..."
                    />
                </>
            )}

            {activeTab === 'approvals' && canApprove && (
                <>
                    <h3 className="text-sm font-semibold text-gray-700 mb-2">Member Deposits</h3>
                    <DataTable
                        columns={approvalColumns}
                        data={pendingDeposits}
                        loading={loading}
                        emptyMessage="No deposits awaiting approval"
                        searchable
                        searchPlaceholder="Search pending deposits..."
                    />
                    <h3 className="text-sm font-semibold text-gray-700 mt-6 mb-2">Pool Inflows (non-member)</h3>
                    <DataTable
                        columns={poolInflowColumns}
                        data={pendingPoolInflows}
                        loading={loading}
                        emptyMessage="No pool inflows awaiting approval"
                    />
                </>
            )}

            {activeTab === 'manage' && canView && (
                <>
                    <h3 className="text-sm font-semibold text-gray-700 mb-2">All Deposits</h3>
                    <DataTable
                        columns={allSavingsColumns}
                        data={allSavings}
                        loading={loading}
                        emptyMessage="No savings deposits found"
                        searchable
                        searchPlaceholder="Search all deposits..."
                    />
                    <h3 className="text-sm font-semibold text-gray-700 mt-6 mb-2">All Handouts</h3>
                    <DataTable
                        columns={allHandoutsColumns}
                        data={allHandouts}
                        loading={loading}
                        emptyMessage="No savings handouts found"
                        searchable
                        searchPlaceholder="Search all handouts..."
                    />
                </>
            )}

            <RecordDepositModal
                isOpen={showDeposit}
                onClose={() => setShowDeposit(false)}
                onSuccess={refreshAll}
                members={members}
                categories={categories}
            />
            <RecordHandoutModal
                isOpen={showHandout}
                onClose={() => setShowHandout(false)}
                onSuccess={refreshAll}
                members={members}
                categories={categories}
            />
            <RecordPoolInflowModal
                isOpen={showPoolInflow}
                onClose={() => setShowPoolInflow(false)}
                onSuccess={refreshAll}
                categories={categories}
            />
            <SettingsModal
                isOpen={showSettings}
                onClose={() => setShowSettings(false)}
                onSuccess={refreshAll}
            />
            <DocumentPreviewModal preview={preview} onClose={() => setPreview(null)} />
        </div>
    );
};

export default SavingsPage;
