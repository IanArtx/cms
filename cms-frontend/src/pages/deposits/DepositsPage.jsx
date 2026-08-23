// ============================================================
// DEPOSITS PAGE (v1.38.1)
// Member Deposit Tracking — a per-member running total, NOT a
// separate envelope: money posted is a normal transaction into the
// one account this feature is activated against, fully spendable
// through that account. Does not contribute to shareholding. Every
// active shareholder is expected to keep a nonzero balance unless
// excused. Funded via a Transactions contribution slice (see
// ContributionModal) or a standalone entry here.
//
// Like the Side Fund, deposits are optional (off by default) and
// "parented" to one specific account chosen when activating it in
// Settings — never chosen per entry. UNLIKE the Side Fund, that
// parent account is not a separate envelope — deposits stay ordinary,
// commingled transactions into that one account.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { depositsAPI, usersAPI, accountsAPI } from '../../api/endpoints';
import { formatDate, formatNumber, getErrorMessage } from '../../utils/helpers';
import PageHeader from '../../components/common/PageHeader';
import DataTable from '../../components/common/DataTable';
import ErrorMessage from '../../components/common/ErrorMessage';
import { useAuth } from '../../contexts/AuthContext';
import { PlusIcon, Cog6ToothIcon, ExclamationTriangleIcon, BanknotesIcon } from '@heroicons/react/24/outline';

// ============================================================
// SETTINGS / ACTIVATION MODAL — Admin/Treasurer (DEPOSIT_MANAGE)
// ============================================================
const SettingsModal = ({ isOpen, onClose, onSuccess, config, accounts }) => {
    const [form, setForm] = useState({ is_active: false, parent_account_id: '', target_amount: '' });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (isOpen && config) {
            setForm({
                is_active:         !!config.is_active,
                parent_account_id: config.parent_account_id || '',
                target_amount:     config.target_amount || 0,
            });
        }
    }, [isOpen, config]);

    if (!isOpen) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await depositsAPI.updateSettings({
                is_active:         form.is_active,
                parent_account_id: form.parent_account_id ? parseInt(form.parent_account_id) : undefined,
                target_amount:     form.target_amount !== '' ? parseFloat(form.target_amount) : undefined,
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
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">Deposit Settings</h2>
                    <p className="text-sm text-gray-400 mb-4">
                        Deposits are an optional feature tied to one account chosen here — every deposit posts
                        into that account as a normal, fully spendable transaction. The target amount is a
                        single company-wide figure every member's own deposit balance is compared against.
                    </p>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div className="flex items-center justify-between border border-gray-200 rounded-lg px-3 py-2.5">
                            <span className="text-sm font-medium text-gray-700">Deposits active</span>
                            <button type="button"
                                onClick={() => setForm(p => ({ ...p, is_active: !p.is_active }))}
                                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                                    form.is_active ? 'bg-primary-600' : 'bg-gray-300'
                                }`}>
                                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                                    form.is_active ? 'translate-x-6' : 'translate-x-1'
                                }`} />
                            </button>
                        </div>
                        <div>
                            <label className="label">Parent Account {form.is_active ? '*' : ''}</label>
                            <select className="input" value={form.parent_account_id}
                                onChange={e => setForm(p => ({ ...p, parent_account_id: e.target.value }))}
                                required={form.is_active}>
                                <option value="">Select account...</option>
                                {accounts.map(a => (
                                    <option key={a.id} value={a.id}>{a.name} ({a.account_type})</option>
                                ))}
                            </select>
                            <p className="text-xs text-gray-400 mt-1">
                                Every deposit — from a Transactions contribution slice or a standalone entry — is
                                posted straight into this account.
                            </p>
                        </div>
                        <div>
                            <label className="label">Target Amount *</label>
                            <input type="number" className="input" value={form.target_amount}
                                onChange={e => setForm(p => ({ ...p, target_amount: e.target.value }))}
                                min="0" step="0.01" required />
                            <p className="text-xs text-gray-400 mt-1">
                                Compared in the parent account's own currency — changing the account later
                                changes what this figure is measured in.
                            </p>
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
// STANDALONE DEPOSIT ENTRY MODAL — Treasurer/Admin (DEPOSIT_MANAGE)
// ============================================================
const RecordDepositModal = ({ isOpen, onClose, onSuccess, members }) => {
    const BLANK = { user_id: '', amount: '', entry_date: '', description: '' };
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
            await depositsAPI.create({ ...form, amount: parseFloat(form.amount) });
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
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">Record Deposit</h2>
                    <p className="text-sm text-gray-400 mb-4">
                        Posted as a normal inflow into the configured deposit account — it stays fully
                        spendable there. This only adds to the member's tracked deposit total.
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
                            <label className="label">Description</label>
                            <textarea className="input" rows={2} value={form.description}
                                onChange={e => setForm(p => ({ ...p, description: e.target.value }))} />
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
// EXIT REFUND MODAL — Treasurer/Admin (DEPOSIT_MANAGE)
// Fetches the same computeExitRefund() breakdown the backend actually
// uses before executing the refund, so what's shown here can never
// disagree with what gets paid out.
// ============================================================
const ExitRefundModal = ({ isOpen, onClose, onSuccess, member }) => {
    const [exitType, setExitType] = useState('MUTUAL_AGREEMENT');
    const [deductionPct, setDeductionPct] = useState('50');
    const [preview, setPreview] = useState(null);
    const [loadingPreview, setLoadingPreview] = useState(false);
    const [exchangeRate, setExchangeRate] = useState('');
    const [notes, setNotes] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState(null);

    const loadPreview = useCallback(async () => {
        if (!member) return;
        setLoadingPreview(true);
        setError(null);
        try {
            const res = await depositsAPI.getExitPreview(member.user_id, {
                exit_type: exitType,
                deduction_percentage: exitType === 'FORCED' ? deductionPct : undefined,
            });
            setPreview(res.data.data);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoadingPreview(false);
        }
    }, [member, exitType, deductionPct]);

    useEffect(() => {
        if (!isOpen || !member) return;
        setExitType('MUTUAL_AGREEMENT');
        setDeductionPct('50');
        setExchangeRate('');
        setNotes('');
        setError(null);
        setPreview(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, member]);

    useEffect(() => { if (isOpen && member) loadPreview(); }, [isOpen, member, loadPreview]);

    if (!isOpen || !member) return null;

    const payoutDue = preview && parseFloat(preview.net_payout) > 0;

    const handleConfirm = async () => {
        setSubmitting(true);
        setError(null);
        try {
            await depositsAPI.processExitRefund(member.user_id, {
                exit_type:            exitType,
                deduction_percentage: exitType === 'FORCED' ? parseFloat(deductionPct) : undefined,
                exchange_rate:        exchangeRate || undefined,
                notes:                notes || undefined,
            });
            onSuccess();
            onClose();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            <div className="fixed inset-0 bg-black bg-opacity-40" onClick={onClose} />
            <div className="flex min-h-full items-center justify-center p-4">
                <div className="relative bg-white rounded-xl shadow-xl max-w-md w-full p-6">
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">
                        Refund {member.first_name} {member.last_name}'s Deposit
                    </h2>
                    <p className="text-sm text-gray-400 mb-4">
                        Settles their deposit and pays out the net amount straight to their Savings balance.
                    </p>
                    {error && <div className="mb-4"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}

                    <div className="mb-4">
                        <label className="label">Exit Type *</label>
                        <div className="flex gap-2">
                            <button type="button" onClick={() => setExitType('MUTUAL_AGREEMENT')}
                                className={`flex-1 px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${
                                    exitType === 'MUTUAL_AGREEMENT' ? 'border-primary-600 bg-primary-50 text-primary-700' : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                                }`}>
                                Mutual Agreement (5%)
                            </button>
                            <button type="button" onClick={() => setExitType('FORCED')}
                                className={`flex-1 px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${
                                    exitType === 'FORCED' ? 'border-primary-600 bg-primary-50 text-primary-700' : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                                }`}>
                                Forced (≥ 50%)
                            </button>
                        </div>
                    </div>

                    {exitType === 'FORCED' && (
                        <div className="mb-4">
                            <label className="label">Deduction Percentage * (minimum 50%)</label>
                            <input type="number" className="input" value={deductionPct}
                                onChange={e => setDeductionPct(e.target.value)}
                                onBlur={loadPreview}
                                min="50" max="100" step="0.01" required />
                        </div>
                    )}

                    {loadingPreview ? (
                        <p className="text-sm text-gray-400 mb-4">Calculating refund...</p>
                    ) : preview && (
                        <div className="bg-gray-50 rounded-lg p-4 mb-4 space-y-1.5">
                            <div className="flex justify-between text-sm">
                                <span className="text-gray-500">Gross deposit balance</span>
                                <span className="text-gray-900 font-medium">{formatNumber(preview.gross_balance)}</span>
                            </div>
                            <div className="flex justify-between text-sm">
                                <span className="text-gray-500">Deduction ({preview.deduction_percentage || 0}%)</span>
                                <span className="text-red-600 font-medium">-{formatNumber(preview.deduction_amount)}</span>
                            </div>
                            <div className="flex justify-between text-sm pt-1.5 border-t border-gray-200">
                                <span className="text-gray-700 font-medium">Net payout to savings</span>
                                <span className="text-primary-700 font-bold">{formatNumber(preview.net_payout)}</span>
                            </div>
                        </div>
                    )}

                    {payoutDue && (
                        <div className="space-y-3 mb-4">
                            <div>
                                <label className="label">Exchange Rate</label>
                                <input type="number" className="input" value={exchangeRate}
                                    onChange={e => setExchangeRate(e.target.value)}
                                    min="0.000001" step="any" placeholder="Only if the deposit account and Savings account use different currencies" />
                            </div>
                        </div>
                    )}
                    <div>
                        <label className="label">Notes</label>
                        <textarea className="input" rows={2} value={notes}
                            onChange={e => setNotes(e.target.value)} />
                    </div>
                    <div className="flex justify-end gap-3 pt-4">
                        <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                        <button type="button" onClick={handleConfirm}
                            disabled={submitting || loadingPreview}
                            className="btn-primary">
                            {submitting ? 'Processing...' : 'Confirm Refund'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// EXCUSE MEMBER MODAL — Treasurer/Admin (DEPOSIT_MANAGE)
// ============================================================
const ExcuseModal = ({ isOpen, onClose, onSuccess, member }) => {
    const [reason, setReason] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => { if (isOpen) { setReason(''); setError(null); } }, [isOpen]);

    if (!isOpen || !member) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await depositsAPI.setExcusal(member.user_id, { reason: reason || undefined });
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
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">
                        Excuse {member.first_name} {member.last_name}
                    </h2>
                    <p className="text-sm text-gray-400 mb-4">
                        Excludes this member from the "deposit cannot be zero" flag until you clear the excusal.
                    </p>
                    {error && <div className="mb-4"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">Reason</label>
                            <textarea className="input" rows={2} value={reason}
                                onChange={e => setReason(e.target.value)} placeholder="Optional" />
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading} className="btn-primary">
                                {loading ? 'Saving...' : 'Excuse Member'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// MAIN DEPOSITS PAGE
// ============================================================
const DepositsPage = () => {
    const { hasPermission } = useAuth();
    const [config, setConfig] = useState(null);
    const [myDeposit, setMyDeposit] = useState(null);
    const [allDeposits, setAllDeposits] = useState([]);
    const [members, setMembers] = useState([]);
    const [accounts, setAccounts] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [activeTab, setActiveTab] = useState('mine');
    const [showSettings, setShowSettings] = useState(false);
    const [showRecord, setShowRecord] = useState(false);
    const [refundingMember, setRefundingMember] = useState(null);
    const [excusingMember, setExcusingMember] = useState(null);

    const canView   = hasPermission('DEPOSIT_VIEW');
    const canManage = hasPermission('DEPOSIT_MANAGE');

    const loadConfig = useCallback(async () => {
        try {
            const res = await depositsAPI.getSettings();
            setConfig(res.data.data);
        } catch (err) {
            setError(getErrorMessage(err));
        }
    }, []);

    const loadMine = useCallback(async () => {
        try {
            const res = await depositsAPI.getMine();
            setMyDeposit(res.data.data);
        } catch (err) {
            setError(getErrorMessage(err));
        }
    }, []);

    const loadAll = useCallback(async () => {
        if (!canView) return;
        try {
            const res = await depositsAPI.getAll();
            setAllDeposits(res.data.data || []);
        } catch (err) {
            setError(getErrorMessage(err));
        }
    }, [canView]);

    useEffect(() => {
        (async () => {
            setLoading(true);
            await Promise.all([loadConfig(), loadMine(), loadAll()]);
            setLoading(false);
        })();
        if (canManage) {
            usersAPI.getAllUsers({ is_active: true, limit: 500 }).then(r => setMembers(r.data.data || [])).catch(() => {});
            accountsAPI.getAll().then(r => setAccounts(r.data.data || [])).catch(() => {});
        }
    }, [loadConfig, loadMine, loadAll, canManage, canView]);

    const isActive = config?.is_active;

    const refreshAll = () => { loadConfig(); loadMine(); loadAll(); };

    const entryColumns = [
        { header: 'Date', render: row => <span className="text-sm text-gray-500">{formatDate(row.entry_date)}</span> },
        { header: 'Source', render: row => (
            <span className="text-xs text-gray-500">{row.source === 'CONTRIBUTION_SLICE' ? 'Contribution portion' : 'Standalone entry'}</span>
        ) },
        { header: 'Account', render: row => <span className="text-sm text-gray-900">{row.account_name}</span> },
        { header: 'Amount', render: row => (
            <span className="text-sm font-bold text-green-600">{formatNumber(row.amount)} {row.currency_code}</span>
        ) },
    ];

    const allDepositsColumns = [
        { header: 'Member', render: row => (
            <div><p className="text-sm font-medium text-gray-900">{row.first_name} {row.last_name}</p><p className="text-xs text-gray-400">{row.email}</p></div>
        ) },
        { header: 'Balance', render: row => (
            <span className={`text-sm font-bold ${row.below_target ? 'text-red-600' : 'text-gray-900'}`}>{formatNumber(row.balance)}</span>
        ) },
        { header: 'Status', render: row => (
            row.is_excused
                ? <span className="badge-blue text-xs">Excused</span>
                : row.below_target
                    ? <span className="badge-red text-xs">Below target</span>
                    : <span className="badge-green text-xs">On target</span>
        ) },
        { header: 'Actions', render: row => (
            canManage ? (
                <div className="flex gap-2">
                    {!row.is_excused ? (
                        <button onClick={() => setExcusingMember(row)}
                            className="text-xs text-gray-600 hover:text-gray-800 font-medium px-2 py-1 rounded border border-gray-200 hover:bg-gray-50 transition-colors">
                            Excuse
                        </button>
                    ) : (
                        <button onClick={async () => { await depositsAPI.clearExcusal(row.user_id); refreshAll(); }}
                            className="text-xs text-gray-600 hover:text-gray-800 font-medium px-2 py-1 rounded border border-gray-200 hover:bg-gray-50 transition-colors">
                            Clear Excusal
                        </button>
                    )}
                    {parseFloat(row.balance) > 0 && (
                        <button onClick={() => setRefundingMember(row)}
                            className="text-xs text-primary-700 hover:text-primary-800 font-medium px-2 py-1 rounded border border-primary-200 hover:bg-primary-50 transition-colors">
                            Exit Refund
                        </button>
                    )}
                </div>
            ) : null
        ) },
    ];

    return (
        <div>
            <PageHeader
                title="Deposits"
                subtitle="Per-member deposit tracking — held inside your ordinary accounts, not a separate pool"
                actions={
                    <div className="flex gap-2">
                        {canManage && (
                            <button onClick={() => setShowSettings(true)} className="btn-secondary flex items-center gap-2">
                                <Cog6ToothIcon className="h-4 w-4" />
                                Settings
                            </button>
                        )}
                        {canManage && isActive && (
                            <button onClick={() => setShowRecord(true)} className="btn-primary flex items-center gap-2">
                                <PlusIcon className="h-4 w-4" />
                                Record Deposit
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

            {!loading && !isActive && (
                <div className="card flex items-start gap-4 mb-6">
                    <BanknotesIcon className="h-8 w-8 text-gray-300 flex-shrink-0" />
                    <div>
                        <p className="text-sm font-medium text-gray-700">Deposits aren't active yet</p>
                        <p className="text-sm text-gray-400 mt-1">
                            {canManage
                                ? 'Choose a parent account and a target amount in Settings to activate it.'
                                : 'Ask an Admin or Treasurer to activate it from Settings.'}
                        </p>
                    </div>
                </div>
            )}

            {isActive && myDeposit && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
                    <div className="card">
                        <p className="text-sm text-gray-400">My Deposit Balance</p>
                        <p className="text-2xl font-bold text-primary-700 mt-1">
                            {formatNumber(myDeposit.balance)}
                            {myDeposit.currency_code ? ` ${myDeposit.currency_code}` : ''}
                        </p>
                    </div>
                    <div className="card">
                        <p className="text-sm text-gray-400">Company Target</p>
                        <p className="text-2xl font-bold text-gray-900 mt-1">{formatNumber(myDeposit.target_amount)}</p>
                    </div>
                    <div className="card">
                        <p className="text-sm text-gray-400">Standing</p>
                        <p className="text-lg font-bold mt-1">
                            {myDeposit.is_excused
                                ? <span className="text-blue-600">Excused</span>
                                : myDeposit.below_target
                                    ? <span className="text-red-600">Below target</span>
                                    : <span className="text-green-600">On target</span>}
                        </p>
                    </div>
                </div>
            )}

            {isActive && myDeposit && myDeposit.below_target && (
                <div className="card flex items-start gap-4 mb-6 bg-red-50 border-red-100">
                    <ExclamationTriangleIcon className="h-6 w-6 text-red-500 flex-shrink-0 mt-0.5" />
                    <div>
                        <p className="text-sm font-medium text-red-800">Your deposit is below the company target</p>
                        <p className="text-xs text-red-700 mt-0.5">
                            You need {formatNumber(Math.max(0, myDeposit.target_amount - myDeposit.balance))} more to reach it.
                        </p>
                    </div>
                </div>
            )}

            {isActive && (
                <div className="flex gap-2 mb-6 flex-wrap">
                    <button onClick={() => setActiveTab('mine')}
                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === 'mine' ? 'bg-primary-700 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                        My Deposit
                    </button>
                    {canView && (
                        <button onClick={() => setActiveTab('all')}
                            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === 'all' ? 'bg-primary-700 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                            All Members
                        </button>
                    )}
                </div>
            )}

            {isActive && activeTab === 'mine' && (
                myDeposit && myDeposit.entries && myDeposit.entries.length === 0 ? (
                    <div className="card flex items-start gap-4">
                        <BanknotesIcon className="h-8 w-8 text-gray-300 flex-shrink-0" />
                        <p className="text-sm text-gray-400">No deposits recorded yet.</p>
                    </div>
                ) : (
                    <DataTable
                        columns={entryColumns}
                        data={myDeposit?.entries || []}
                        loading={loading}
                        emptyMessage="No deposits recorded yet"
                        searchable={false}
                    />
                )
            )}

            {isActive && activeTab === 'all' && canView && (
                <DataTable
                    columns={allDepositsColumns}
                    data={allDeposits}
                    loading={loading}
                    emptyMessage="No shareholders found"
                    searchable
                    searchPlaceholder="Search members..."
                />
            )}

            <SettingsModal
                isOpen={showSettings}
                onClose={() => setShowSettings(false)}
                onSuccess={refreshAll}
                config={config}
                accounts={accounts}
            />
            <RecordDepositModal
                isOpen={showRecord}
                onClose={() => setShowRecord(false)}
                onSuccess={refreshAll}
                members={members}
            />
            <ExitRefundModal
                isOpen={!!refundingMember}
                onClose={() => setRefundingMember(null)}
                onSuccess={refreshAll}
                member={refundingMember}
            />
            <ExcuseModal
                isOpen={!!excusingMember}
                onClose={() => setExcusingMember(null)}
                onSuccess={refreshAll}
                member={excusingMember}
            />
        </div>
    );
};

export default DepositsPage;
