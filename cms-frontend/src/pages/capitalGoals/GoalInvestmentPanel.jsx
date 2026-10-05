// ============================================================
// GOAL → INVESTMENT (v1.78.0)
// Requested directly: "secondary goals can be tailored towards a
// proposed investments and money collected can already be invested
// into that investment it is attached to."
// Confirmed: "Guided transfer through a selected account (apply Fx if
// necessary), then invest" and "Pick existing or create new".
//
// This file holds:
//   • InvestmentTieFields — "Tie to an investment": none / an existing
//     pending-or-active investment / a new proposal. Used when a
//     secondary goal is created and on the goal's Investment tab.
//   • tiePayload()        — turns those fields into what the server takes.
//   • GoalInvestmentPanel — the goal's Investment tab:
//       Collected → Moved → Invested → Available, then two guided steps
//       1. Move the money to the investment's operational account
//          (an ordinary Primary → operational transfer, with the
//          exchange rate when the currencies differ; the Treasurer
//          approves it as every transfer)
//       2. Invest it (an ordinary investment funding — held for
//          approval unless entered by the Treasurer or an Admin)
//     Nothing here can move more than the goal actually collected:
//     the server checks every step against the goal's own figures.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
    capitalGoalsAPI, investmentsAPI, accountsAPI, transfersAPI, categoriesAPI, exchangeRatesAPI,
} from '../../api/endpoints';
import { formatDate, getErrorMessage } from '../../utils/helpers';
import ErrorMessage from '../../components/common/ErrorMessage';
import StatusBadge from '../../components/common/StatusBadge';
import { useAuth } from '../../contexts/AuthContext';
import { useConfirm } from '../../contexts/ConfirmContext';
import { money, StatTile } from './capitalGoalUi';
import {
    ArrowRightIcon, BanknotesIcon, BriefcaseIcon, CheckCircleIcon, ArrowsRightLeftIcon, LinkSlashIcon,
} from '@heroicons/react/24/outline';

const todayStr = () => {
    const d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

// ============================================================
// TIE FIELDS
// ============================================================
export const BLANK_TIE = { mode: 'none', investment_id: '', name: '', planned_budget: '', funding_account_id: '', description: '' };

export const tiePayload = (tie) => {
    if (!tie || tie.mode === 'none') return {};
    if (tie.mode === 'existing') return tie.investment_id ? { investment_id: parseInt(tie.investment_id, 10) } : {};
    return {
        new_investment: {
            name: tie.name.trim(),
            planned_budget: parseFloat(tie.planned_budget),
            funding_account_id: parseInt(tie.funding_account_id, 10),
            description: tie.description.trim() || undefined,
        },
    };
};

// Loads what the fields need (open investments, operational accounts).
export const useTieOptions = (enabled) => {
    const [investments, setInvestments] = useState([]);
    const [accounts, setAccounts] = useState([]);
    useEffect(() => {
        if (!enabled) return;
        Promise.all(['PENDING', 'ACTIVE'].map(status =>
            investmentsAPI.getAll({ status, limit: 100 }).then(r => r.data.data || []).catch(() => [])))
            .then(([a, b]) => setInvestments([...a, ...b]));
        accountsAPI.getAll()
            .then(r => setAccounts((r.data.data || []).filter(x => x.account_type === 'SECONDARY' && x.is_active !== false)))
            .catch(() => {});
    }, [enabled]);
    return { investments, accounts };
};

export const InvestmentTieFields = ({ value, onChange, investments, accounts, canCreate }) => {
    const set = (patch) => onChange({ ...value, ...patch });
    const account = accounts.find(a => String(a.id) === String(value.funding_account_id));
    return (
        <div className="rounded-lg border border-gray-200 p-3 space-y-3">
            <div>
                <p className="label mb-1">Tie this goal to an investment</p>
                <p className="text-xs text-gray-400">
                    Optional. Money collected for the goal can then be moved to the investment's operational account
                    and invested in it — never more than the goal has actually collected.
                </p>
            </div>
            <div className="flex gap-2 flex-wrap">
                {[
                    ['none', 'Not tied'],
                    ['existing', 'Existing investment'],
                    ...(canCreate ? [['new', 'New proposal']] : []),
                ].map(([k, label]) => (
                    <button key={k} type="button" onClick={() => set({ mode: k })}
                        className={`chip-filter ${value.mode === k ? 'chip-filter-active' : ''}`}>
                        {label}
                    </button>
                ))}
            </div>

            {value.mode === 'existing' && (
                <div>
                    <label className="label">Investment *</label>
                    <select className="input" value={value.investment_id} required
                        onChange={e => set({ investment_id: e.target.value })}>
                        <option value="">Select a pending or active investment...</option>
                        {investments.map(i => (
                            <option key={i.id} value={i.id}>
                                {i.reference_code} — {i.name} ({(i.status || '').toLowerCase()})
                            </option>
                        ))}
                    </select>
                    {investments.length === 0 && (
                        <p className="text-xs text-amber-700 mt-1">No pending or active investments found — create a new proposal instead.</p>
                    )}
                </div>
            )}

            {value.mode === 'new' && (
                <div className="space-y-3">
                    <div>
                        <label className="label">Proposed investment name *</label>
                        <input type="text" className="input" value={value.name} required
                            placeholder="e.g. Poultry house 2"
                            onChange={e => set({ name: e.target.value })} />
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                            <label className="label">Paid from (operational account) *</label>
                            <select className="input" value={value.funding_account_id} required
                                onChange={e => set({ funding_account_id: e.target.value })}>
                                <option value="">Select account...</option>
                                {accounts.map(a => (
                                    <option key={a.id} value={a.id}>{a.name} ({a.currency_code})</option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label className="label">Planned budget{account ? ` (${account.currency_code})` : ''} *</label>
                            <input type="number" className="input" value={value.planned_budget} required
                                min="0.01" step="0.01"
                                onChange={e => set({ planned_budget: e.target.value })} />
                        </div>
                    </div>
                    <div>
                        <label className="label">Short description</label>
                        <input type="text" className="input" value={value.description}
                            onChange={e => set({ description: e.target.value })} />
                    </div>
                    <p className="text-xs text-gray-400">
                        The proposal is created as a <strong>pending</strong> investment and goes through the usual
                        investment approval. Money can be moved towards it straight away, but can only be invested
                        once it is approved.
                    </p>
                </div>
            )}
        </div>
    );
};

// ============================================================
// STEP 1 — MOVE GOAL MONEY TO THE OPERATIONAL ACCOUNT
// ============================================================
const MoveModal = ({ isOpen, onClose, onSuccess, funds }) => {
    const inv = funds.investment;
    const fromOptions = funds.accounts.filter(a => a.account_type === 'PRIMARY' && a.available > 0.004);
    const canSwitch = inv.status === 'PENDING' && parseInt(inv.funding_count || 0, 10) === 0;
    const toOptions = canSwitch
        ? (funds.all_accounts || []).filter(a => a.account_type === 'SECONDARY')
        : (funds.all_accounts || []).filter(a => a.id === inv.funding_account_id);

    const [form, setForm] = useState(null);
    const [categories, setCategories] = useState([]);
    const [rates, setRates] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (!isOpen) return;
        setError(null);
        setForm({
            from_account_id: fromOptions[0] ? String(fromOptions[0].account_id) : '',
            to_account_id: String(inv.funding_account_id || ''),
            amount_sent: fromOptions[0] ? String(fromOptions[0].available) : '',
            exchange_rate: '', sending_bank_charge: '', receiving_bank_charge: '',
            category_id: '', value_date: todayStr(),
            description: `Capital goal ${funds.goal.reference_code} — ${funds.goal.title} → ${inv.name}`,
        });
        categoriesAPI.getAll({ flat: true }).then(r => {
            const fin = (r.data.data || []).filter(c => c.module === 'FINANCE');
            setCategories(fin);
            const transfer = fin.find(c => /^transfer/i.test(c.full_path || c.name));
            if (transfer) setForm(p => (p && !p.category_id ? { ...p, category_id: String(transfer.id) } : p));
        }).catch(() => {});
        exchangeRatesAPI.getCurrent().then(r => setRates(r.data.data || [])).catch(() => {});
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen]);

    const from = form && fromOptions.find(a => String(a.account_id) === String(form.from_account_id));
    const to = form && (funds.all_accounts || []).find(a => String(a.id) === String(form.to_account_id));
    const sameCurrency = !!(from && to && from.currency_id === to.currency_id);

    // Suggest the current rate when the currencies differ (editable).
    useEffect(() => {
        if (!form || !from || !to || sameCurrency || form.exchange_rate) return;
        const direct = rates.find(r => r.base_currency_id === from.currency_id && r.target_currency_id === to.currency_id);
        const inverse = rates.find(r => r.base_currency_id === to.currency_id && r.target_currency_id === from.currency_id);
        const suggested = direct ? parseFloat(direct.rate) : inverse ? 1 / parseFloat(inverse.rate) : null;
        if (suggested) setForm(p => ({ ...p, exchange_rate: String(+suggested.toFixed(8)) }));
    }, [form, from, to, sameCurrency, rates]);

    if (!isOpen || !form) return null;

    const amount = parseFloat(form.amount_sent) || 0;
    const sendCharge = parseFloat(form.sending_bank_charge) || 0;
    const recvCharge = parseFloat(form.receiving_bank_charge) || 0;
    const rate = sameCurrency ? 1 : parseFloat(form.exchange_rate) || 0;
    const available = from ? from.available : 0;
    const overLimit = amount + sendCharge > available + 0.0001;
    const arrives = amount * rate - recvCharge;

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (overLimit) { setError(`Only ${money(available, from ? from.currency_code : '')} of this goal's money is left in that account.`); return; }
        setLoading(true);
        setError(null);
        try {
            await transfersAPI.initiate({
                from_account_id: parseInt(form.from_account_id, 10),
                to_account_id: parseInt(form.to_account_id, 10),
                amount_sent: amount,
                exchange_rate: sameCurrency ? undefined : rate,
                sending_bank_charge: sendCharge || undefined,
                receiving_bank_charge: recvCharge || undefined,
                category_id: parseInt(form.category_id, 10),
                value_date: form.value_date,
                description: form.description || undefined,
                capital_goal_id: funds.goal.id,
            });
            onSuccess('Transfer started. The Treasurer approves it as every transfer — until then the amount is set aside so it cannot be moved twice.');
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
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">Step 1 — Move goal money</h2>
                    <p className="text-sm text-gray-400 mb-4">
                        From the account the goal's money was collected in, to the operational account
                        {` ${inv.name}`} is paid from.
                    </p>
                    {error && <div className="mb-4"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}
                    {fromOptions.length === 0 ? (
                        <p className="text-sm text-gray-500">There is no collected goal money left to move.</p>
                    ) : (
                        <form onSubmit={handleSubmit} className="space-y-4">
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <div>
                                    <label className="label">From *</label>
                                    <select className="input" value={form.from_account_id} required
                                        onChange={e => setForm(p => ({ ...p, from_account_id: e.target.value }))}>
                                        {fromOptions.map(a => (
                                            <option key={a.account_id} value={a.account_id}>
                                                {a.account_name} — {money(a.available, a.currency_code)} available
                                            </option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <label className="label">To (operational account) *</label>
                                    <select className="input" value={form.to_account_id} required disabled={!canSwitch}
                                        onChange={e => setForm(p => ({ ...p, to_account_id: e.target.value, exchange_rate: '' }))}>
                                        {toOptions.map(a => (
                                            <option key={a.id} value={a.id}>{a.name} ({a.currency_code})</option>
                                        ))}
                                    </select>
                                    <p className="text-xs text-gray-400 mt-1">
                                        {canSwitch
                                            ? 'The proposal has not been funded yet, so you may choose another operational account — it will then be paid from that account.'
                                            : `${inv.name} is paid from this account.`}
                                    </p>
                                </div>
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <div>
                                    <label className="label">Amount to send{from ? ` (${from.currency_code})` : ''} *</label>
                                    <input type="number" className={`input ${overLimit ? 'border-red-400' : ''}`} value={form.amount_sent}
                                        min="0.01" step="0.01" required
                                        onChange={e => setForm(p => ({ ...p, amount_sent: e.target.value }))} />
                                    <p className={`text-xs mt-1 ${overLimit ? 'text-red-600' : 'text-gray-400'}`}>
                                        Up to {money(available, from ? from.currency_code : '')} (including the sending bank charge)
                                    </p>
                                </div>
                                <div>
                                    <label className="label">Exchange rate {sameCurrency ? '' : '*'}</label>
                                    {sameCurrency ? (
                                        <input type="text" className="input bg-gray-50 text-gray-400" value="1 (same currency)" disabled />
                                    ) : (
                                        <>
                                            <input type="number" className="input" value={form.exchange_rate}
                                                min="0.00000001" step="0.00000001" required
                                                onChange={e => setForm(p => ({ ...p, exchange_rate: e.target.value }))} />
                                            <p className="text-xs text-gray-400 mt-1">
                                                1 {from ? from.currency_code : ''} = ? {to ? to.currency_code : ''}. Filled with the current
                                                rate — change it to the rate the bank actually used.
                                            </p>
                                        </>
                                    )}
                                </div>
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="label">Sending bank charge</label>
                                    <input type="number" className="input" value={form.sending_bank_charge} min="0" step="0.01" placeholder="0.00"
                                        onChange={e => setForm(p => ({ ...p, sending_bank_charge: e.target.value }))} />
                                </div>
                                <div>
                                    <label className="label">Receiving bank charge</label>
                                    <input type="number" className="input" value={form.receiving_bank_charge} min="0" step="0.01" placeholder="0.00"
                                        onChange={e => setForm(p => ({ ...p, receiving_bank_charge: e.target.value }))} />
                                </div>
                            </div>
                            {amount > 0 && rate > 0 && to && (
                                <div className="bg-blue-50 rounded-lg p-3 text-sm text-blue-800">
                                    Arrives in {to.name}: <strong>{money(arrives, to.currency_code)}</strong>
                                    {recvCharge > 0 && <span className="text-xs"> (after the receiving charge)</span>}
                                </div>
                            )}
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <div>
                                    <label className="label">Category *</label>
                                    <select className="input" value={form.category_id} required
                                        onChange={e => setForm(p => ({ ...p, category_id: e.target.value }))}>
                                        <option value="">Select category...</option>
                                        {categories.map(c => <option key={c.id} value={c.id}>{c.full_path || c.name}</option>)}
                                    </select>
                                </div>
                                <div>
                                    <label className="label">Value date *</label>
                                    <input type="date" className="input" value={form.value_date} max={todayStr()} required
                                        onChange={e => setForm(p => ({ ...p, value_date: e.target.value }))} />
                                </div>
                            </div>
                            <div>
                                <label className="label">Description</label>
                                <input type="text" className="input" value={form.description}
                                    onChange={e => setForm(p => ({ ...p, description: e.target.value }))} />
                            </div>
                            <div className="flex justify-end gap-3 pt-2">
                                <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                                <button type="submit" disabled={loading || overLimit} className="btn-primary">
                                    {loading ? 'Starting...' : 'Start transfer'}
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
// STEP 2 — INVEST
// ============================================================
const InvestModal = ({ isOpen, onClose, onSuccess, funds }) => {
    const inv = funds.investment;
    const t = funds.totals;
    const [form, setForm] = useState({ amount: '', value_date: todayStr(), description: '' });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (!isOpen) return;
        setError(null);
        setForm({
            amount: t.available_to_invest > 0 ? String(t.available_to_invest) : '',
            value_date: todayStr(),
            description: `Invested from capital goal ${funds.goal.reference_code} — ${funds.goal.title}`,
        });
    }, [isOpen, t.available_to_invest, funds.goal]);

    if (!isOpen) return null;
    const amount = parseFloat(form.amount) || 0;
    const overLimit = amount > t.available_to_invest + 0.0001;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            const res = await investmentsAPI.fund(inv.id, {
                amount, value_date: form.value_date, description: form.description || undefined,
                capital_goal_id: funds.goal.id,
            });
            onSuccess(res.status === 202 ? null : `${money(amount, inv.currency_code)} invested into ${inv.name}.`);
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
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">Step 2 — Invest</h2>
                    <p className="text-sm text-gray-400 mb-4">
                        Pays goal money from {inv.funding_account_name} into {inv.name}.
                    </p>
                    {error && <div className="mb-4"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">Amount ({inv.currency_code}) *</label>
                            <input type="number" className={`input ${overLimit ? 'border-red-400' : ''}`} value={form.amount}
                                min="0.01" step="0.01" required
                                onChange={e => setForm(p => ({ ...p, amount: e.target.value }))} />
                            <p className={`text-xs mt-1 ${overLimit ? 'text-red-600' : 'text-gray-400'}`}>
                                Up to {money(t.available_to_invest, inv.currency_code)} — the goal money that has arrived
                                in {inv.funding_account_name} and is not invested yet.
                            </p>
                        </div>
                        <div>
                            <label className="label">Value date *</label>
                            <input type="date" className="input" value={form.value_date} max={todayStr()} required
                                onChange={e => setForm(p => ({ ...p, value_date: e.target.value }))} />
                        </div>
                        <div>
                            <label className="label">Description</label>
                            <input type="text" className="input" value={form.description}
                                onChange={e => setForm(p => ({ ...p, description: e.target.value }))} />
                        </div>
                        <p className="text-xs text-gray-400">
                            Entered by anyone other than the Treasurer or an Admin, this is held until the Treasurer
                            or an Admin approves it — no money moves before then.
                        </p>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading || overLimit} className="btn-primary">
                                {loading ? 'Saving...' : 'Invest'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// THE TAB
// ============================================================
const FlowStep = ({ label, value, sub, active }) => (
    <div className={`flex-1 min-w-[8rem] rounded-lg p-3 ${active ? 'bg-primary-50' : 'bg-gray-50'}`}>
        <p className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">{label}</p>
        <p className="text-base font-bold text-gray-900 mt-0.5 break-words">{value}</p>
        {sub && <p className="text-[11px] text-gray-500 mt-0.5">{sub}</p>}
    </div>
);

const GoalInvestmentPanel = ({ goal, onChanged }) => {
    const { hasPermission } = useAuth();
    const confirm = useConfirm();
    const canManage = hasPermission('CAPITAL_GOAL_MANAGE');
    const canMove = hasPermission('FINANCE_TRANSFER_CREATE');
    const canInvest = hasPermission('INVESTMENT_MANAGE');

    const [funds, setFunds] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null);
    const [showMove, setShowMove] = useState(false);
    const [showInvest, setShowInvest] = useState(false);
    const [tie, setTie] = useState(BLANK_TIE);
    const [saving, setSaving] = useState(false);
    const tieOptions = useTieOptions(canManage && funds && !funds.tied);

    const load = useCallback(async () => {
        try {
            setLoading(true);
            const r = await capitalGoalsAPI.getFunds(goal.id);
            setFunds(r.data.data);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, [goal.id]);
    useEffect(() => { load(); }, [load]);

    const done = (message) => {
        if (message) setNotice(message);
        load();
        if (onChanged) onChanged();
    };

    const saveTie = async (e) => {
        e.preventDefault();
        const payload = tiePayload(tie);
        if (!payload.investment_id && !payload.new_investment) { setError('Choose an investment or describe the new proposal.'); return; }
        setSaving(true);
        setError(null);
        try {
            const r = await capitalGoalsAPI.setInvestment(goal.id, payload);
            setTie(BLANK_TIE);
            done(r.data.message);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setSaving(false);
        }
    };

    const untie = async () => {
        const ok = await confirm({
            title: 'Untie the investment',
            message: 'This goal will no longer be tied to the investment. It is only possible while none of the goal\'s money has been moved or invested for it.',
            confirmLabel: 'Untie',
            danger: true,
        });
        if (!ok) return;
        try {
            const r = await capitalGoalsAPI.setInvestment(goal.id, { investment_id: null });
            done(r.data.message);
        } catch (err) {
            setError(getErrorMessage(err));
        }
    };

    if (loading && !funds) return <div className="card text-sm text-gray-400">Loading...</div>;
    if (!funds) return error ? <ErrorMessage message={error} /> : null;

    // ---------- Database not updated yet ----------
    if (funds.ready === false) {
        return (
            <div className="card text-sm text-gray-500">
                Tying a goal to an investment needs the v1.78.0 database update (migration_v1.78.0.sql).
                Ask the Admin to run it.
            </div>
        );
    }

    // ---------- Not tied ----------
    if (!funds.tied) {
        return (
            <div className="card space-y-4">
                <div className="flex items-start gap-3">
                    <BriefcaseIcon className="h-6 w-6 text-gray-300 flex-shrink-0" />
                    <div>
                        <h3 className="section-title">Not tied to an investment</h3>
                        <p className="text-sm text-gray-500 mt-1">
                            A secondary goal can raise money for one particular investment. Once tied, the money
                            collected can be moved to that investment's operational account and invested in it —
                            step by step, from this tab.
                        </p>
                    </div>
                </div>
                {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
                {notice && <div className="rounded-lg bg-green-50 border border-green-100 p-3 text-sm text-green-800">{notice}</div>}
                {canManage && goal.status === 'ACTIVE' && (
                    <form onSubmit={saveTie} className="space-y-3">
                        <InvestmentTieFields value={tie} onChange={setTie}
                            investments={tieOptions.investments} accounts={tieOptions.accounts}
                            canCreate={hasPermission('INVESTMENT_CREATE')} />
                        {tie.mode !== 'none' && (
                            <div className="flex justify-end">
                                <button type="submit" disabled={saving} className="btn-primary">
                                    {saving ? 'Saving...' : 'Tie investment'}
                                </button>
                            </div>
                        )}
                    </form>
                )}
            </div>
        );
    }

    // ---------- Tied ----------
    const inv = funds.investment;
    const t = funds.totals;
    const gc = t.currency_code;
    const ic = t.invested_currency_code || inv.currency_code;
    const approved = inv.status === 'ACTIVE';
    const moving = t.moving > 0;
    // Shares of what was collected (in goal currency) for the bar.
    const base = t.collected > 0 ? t.collected : 1;
    const investedShare = Math.min(100, (t.invested_goal_value / base) * 100);
    const arrivedShare = Math.min(100 - investedShare, (t.available_to_invest_goal_value / base) * 100);
    const movingShare = Math.min(100 - investedShare - arrivedShare, (t.moving / base) * 100);

    return (
        <div className="space-y-6">
            {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
            {notice && (
                <div className="rounded-lg bg-green-50 border border-green-100 p-3 text-sm text-green-800 flex items-start gap-2">
                    <CheckCircleIcon className="h-5 w-5 flex-shrink-0" /> <span>{notice}</span>
                </div>
            )}

            {/* The investment */}
            <div className="card">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="flex items-start gap-3 min-w-0">
                        <div className="p-2.5 rounded-lg bg-teal-50 text-teal-600 flex-shrink-0">
                            <BriefcaseIcon className="h-6 w-6" />
                        </div>
                        <div className="min-w-0">
                            <Link to={`/investments/${inv.id}`} className="text-base font-semibold text-gray-900 hover:text-primary-700 hover:underline">
                                {inv.name}
                            </Link>
                            <p className="text-xs text-gray-400 font-mono">{inv.reference_code}</p>
                            <p className="text-xs text-gray-500 mt-1">
                                Paid from {inv.funding_account_name} · planned budget {money(inv.planned_budget, inv.currency_code)}
                                {' · '}spent so far {money(inv.actual_expenditure, inv.currency_code)}
                            </p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <StatusBadge status={inv.status} />
                        {canManage && goal.status === 'ACTIVE' && t.moved === 0 && t.moving === 0 && t.invested === 0 && (
                            <button type="button" onClick={untie} className="btn-secondary text-xs flex items-center gap-1">
                                <LinkSlashIcon className="h-4 w-4" /> Untie
                            </button>
                        )}
                    </div>
                </div>
                {inv.status === 'PENDING' && (
                    <p className="mt-3 text-xs text-amber-800 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                        This investment is still a proposal waiting for approval. Goal money can already be moved to
                        {` ${inv.funding_account_name}`}, but it can only be invested once the investment is approved
                        (Investments → open it → Approve).
                    </p>
                )}
            </div>

            {/* Collected → Moved → Invested → Available */}
            <div className="card">
                <h3 className="section-title mb-3">Where the goal's money is</h3>
                <div className="flex gap-2 items-stretch flex-wrap">
                    <FlowStep label="Collected" value={money(t.collected, gc)} sub="pledge payments approved" />
                    <ArrowRightIcon className="h-4 w-4 text-gray-300 self-center hidden sm:block" />
                    <FlowStep label="Moved" value={money(t.moved, gc)}
                        sub={moving ? `+ ${money(t.moving, gc)} waiting for approval` : 'to the operational account'} />
                    <ArrowRightIcon className="h-4 w-4 text-gray-300 self-center hidden sm:block" />
                    <FlowStep label="Invested" value={money(t.invested, ic)} sub={`worth ${money(t.invested_goal_value, gc)} at the transfer rates`} active />
                </div>
                <div className="mt-4">
                    <div className="w-full h-3 bg-gray-100 rounded-full overflow-hidden flex">
                        <div className="h-full bg-green-500" style={{ width: `${investedShare}%` }} title="Invested" />
                        <div className="h-full bg-teal-400" style={{ width: `${arrivedShare}%` }} title="Arrived, not invested" />
                        <div className="h-full bg-amber-400" style={{ width: `${movingShare}%` }} title="Waiting for approval" />
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px] text-gray-500">
                        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-green-500" />Invested</span>
                        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-teal-400" />Arrived, not yet invested</span>
                        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-amber-400" />Transfer waiting for approval</span>
                        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-gray-200" />Still where it was collected</span>
                    </div>
                </div>
            </div>

            {/* Available + the two steps */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="card flex flex-col gap-3">
                    <div className="flex items-center gap-2">
                        <span className="w-6 h-6 rounded-full bg-primary-600 text-white text-xs font-bold flex items-center justify-center">1</span>
                        <h3 className="section-title">Move to the operational account</h3>
                    </div>
                    <StatTile label="Available to move" value={money(t.available_to_move, gc)}
                        sub="collected and not moved or waiting to be moved" icon={ArrowsRightLeftIcon} flat />
                    <p className="text-xs text-gray-500">
                        A normal Primary → operational transfer, marked with this goal. When the currencies differ you
                        enter the exchange rate. A Director starts it and the Treasurer approves it.
                    </p>
                    {canMove ? (
                        <button type="button" onClick={() => setShowMove(true)}
                            disabled={goal.status !== 'ACTIVE' || t.available_to_move <= 0.004}
                            className="btn-primary self-start">
                            Move goal money
                        </button>
                    ) : (
                        <p className="text-xs text-gray-400">Moving money is done by a Director.</p>
                    )}
                </div>
                <div className="card flex flex-col gap-3">
                    <div className="flex items-center gap-2">
                        <span className="w-6 h-6 rounded-full bg-primary-600 text-white text-xs font-bold flex items-center justify-center">2</span>
                        <h3 className="section-title">Invest</h3>
                    </div>
                    <StatTile label="Available to invest" value={money(t.available_to_invest, ic)}
                        sub={`arrived in ${inv.funding_account_name} · worth ${money(t.available_to_invest_goal_value, gc)}`} icon={BanknotesIcon} flat />
                    <p className="text-xs text-gray-500">
                        Pays the arrived goal money into the investment. Only possible once the investment is approved.
                    </p>
                    {canInvest ? (
                        <button type="button" onClick={() => setShowInvest(true)}
                            disabled={!approved || t.available_to_invest <= 0.004}
                            className="btn-primary self-start">
                            Invest goal money
                        </button>
                    ) : (
                        <p className="text-xs text-gray-400">Investing is done by the Treasurer or an investment manager.</p>
                    )}
                    {!approved && <p className="text-xs text-amber-700">Waiting for the investment to be approved.</p>}
                </div>
            </div>

            {/* Account by account */}
            <div className="card">
                <h3 className="section-title mb-3">Account by account</h3>
                <div className="cms-table-scroll overflow-x-auto">
                    <table className="min-w-full text-sm">
                        <thead>
                            <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                                <th className="py-2 pr-4">Account</th>
                                <th className="py-2 pr-4 text-right">Collected</th>
                                <th className="py-2 pr-4 text-right">Moved out</th>
                                <th className="py-2 pr-4 text-right">Received</th>
                                <th className="py-2 pr-4 text-right">Invested</th>
                                <th className="py-2 text-right">Available</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-50">
                            {funds.accounts.map(a => (
                                <tr key={a.account_id}>
                                    <td className="py-2 pr-4 text-gray-800 whitespace-nowrap">{a.account_name} <span className="text-xs text-gray-400">{a.currency_code}</span></td>
                                    <td className="py-2 pr-4 text-right whitespace-nowrap">{money(a.collected)}</td>
                                    <td className="py-2 pr-4 text-right whitespace-nowrap">
                                        {money(a.sent)}{a.sending > 0 && <span className="block text-[11px] text-amber-700">+{money(a.sending)} waiting</span>}
                                    </td>
                                    <td className="py-2 pr-4 text-right whitespace-nowrap">{money(a.received)}</td>
                                    <td className="py-2 pr-4 text-right whitespace-nowrap">{money(a.invested)}</td>
                                    <td className="py-2 text-right font-semibold whitespace-nowrap">{money(a.available)}</td>
                                </tr>
                            ))}
                            {funds.accounts.length === 0 && (
                                <tr><td colSpan={6} className="py-4 text-center text-sm text-gray-400">No goal money collected yet</td></tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Movements */}
            {(funds.transfers.length > 0 || funds.fundings.length > 0) && (
                <div className="card">
                    <h3 className="section-title mb-3">Movements</h3>
                    <div className="divide-y divide-gray-100">
                        {funds.transfers.map(x => (
                            <div key={`t${x.id}`} className="py-2 flex items-start justify-between gap-3 flex-wrap">
                                <div className="min-w-0">
                                    <p className="text-sm text-gray-800">
                                        Transfer {x.from_account_name} → {x.to_account_name}
                                    </p>
                                    <p className="text-[11px] text-gray-400">
                                        <span className="font-mono">{x.reference_code}</span> · {formatDate(x.value_date)} · by {x.created_by_name}
                                        {x.currency_sent_id !== x.currency_received_id && ` · rate ${parseFloat(x.exchange_rate).toLocaleString('en-US')}`}
                                    </p>
                                </div>
                                <div className="text-right">
                                    <p className="text-sm font-medium text-gray-900">
                                        {money(x.amount_sent, x.currency_sent_code)} → {money(x.amount_received, x.currency_received_code)}
                                    </p>
                                    <StatusBadge status={x.status} />
                                </div>
                            </div>
                        ))}
                        {funds.fundings.map(f => (
                            <div key={`f${f.id}`} className="py-2 flex items-start justify-between gap-3 flex-wrap">
                                <div className="min-w-0">
                                    <p className="text-sm text-gray-800">Invested into {f.investment_name}</p>
                                    <p className="text-[11px] text-gray-400">
                                        <span className="font-mono">{f.reference_code}</span> · {formatDate(f.value_date)} · from {f.account_name}
                                        {f.created_by_name ? ` · by ${f.created_by_name}` : ''}
                                    </p>
                                </div>
                                <div className="text-right">
                                    <p className={`text-sm font-medium ${f.is_reversed ? 'text-gray-400 line-through' : 'text-gray-900'}`}>
                                        {money(f.amount, f.currency_code)}
                                    </p>
                                    {f.is_reversed && <span className="badge-gray">Reversed</span>}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            <MoveModal isOpen={showMove} onClose={() => setShowMove(false)} onSuccess={done} funds={funds} />
            <InvestModal isOpen={showInvest} onClose={() => setShowInvest(false)} onSuccess={done} funds={funds} />
        </div>
    );
};

export default GoalInvestmentPanel;
