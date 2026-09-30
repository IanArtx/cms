// ============================================================
// TAX PAGE (v1.70.0)
//
// Tabs:
//   Overview            — what is owed to URA now, this year's estimated
//                         corporate tax, tax deducted from the company,
//                         upcoming deadlines, and how it all works.
//   Deducted from us    — tax kept back by whoever paid the company
//                         (bond coupons, treasury bills, bank interest):
//                         FINAL or CREDITABLE, certificates.
//   Withheld & returns  — tax the company keeps back when it pays others
//                         (dividends, members' savings interest, foreign
//                         lender interest, suppliers / service fees), the
//                         monthly payments to URA (due the 15th), and the
//                         SHADOW 6% records while not a designated agent.
//   Corporate tax       — one year of income at a time: the computation
//                         (worksheet), provisional estimate and
//                         instalments, adjustments, prepare (Treasurer) →
//                         approve (Director) → filed, and payments.
//   Calendar            — every tax deadline and whether it is done.
//   Settings            — TIN, registration number, incorporation date,
//                         withholding agent status (+ notice to members)
//                         and the dated tax rates.
// A member who is not tax staff sees only "My withholding tax".
//
// Backend: /api/tax (taxController / taxService).
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { taxAPI, accountsAPI } from '../../api/endpoints';
import { formatDate, getErrorMessage } from '../../utils/helpers';
import PageHeader from '../../components/common/PageHeader';
import LoadingSpinner from '../../components/common/LoadingSpinner';
import ErrorMessage from '../../components/common/ErrorMessage';
import { useAuth } from '../../contexts/AuthContext';
import { useConfirm } from '../../contexts/ConfirmContext';
import {
    ReceiptPercentIcon,
    ExclamationTriangleIcon,
    InformationCircleIcon,
    CheckCircleIcon,
    TrashIcon,
} from '@heroicons/react/24/outline';

export const money = (n, dp = 0) => (n === null || n === undefined || Number.isNaN(Number(n))
    ? '—'
    : Number(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }));
const money2 = (n) => money(n, 2);
const today = () => new Date().toISOString().slice(0, 10);

const TAX_STAFF = ['Treasurer', 'Assistant Treasurer', 'Director', 'Admin', 'Secretary'];
const PREPARERS = ['Treasurer', 'Assistant Treasurer'];
const APPROVERS = ['Director'];
const SETTINGS_EDITORS = ['Admin', 'Director', 'Treasurer'];
const AGENT_TOGGLERS = ['Director', 'Treasurer'];

const PAYMENT_TYPE_LABELS = {
    DIVIDEND: 'Dividend',
    SAVINGS_INTEREST: 'Interest on savings',
    LOAN_INTEREST: 'Interest on a loan',
    SERVICE_FEE: 'Service fee',
    SUPPLIER: 'Supplier',
    NON_RESIDENT_SERVICE: 'Fee to non-resident',
    OTHER: 'Other',
};
const SOURCE_LABELS = {
    BOND_COUPON: 'Bond coupon',
    TREASURY_BILL: 'Treasury bill',
    INVESTMENT_RETURN: 'Investment return',
    INVESTMENT_TAX_ENTRY: 'Investment tax entry',
    BANK_INTEREST: 'Bank interest',
    MMF: 'Money market fund',
    DIVIDEND_RECEIVED: 'Dividend received',
    OTHER_INCOME: 'Other income',
    OTHER: 'Other',
};
const STATUS_TONE = {
    PENDING: 'bg-amber-100 text-amber-800',
    REMITTED: 'bg-green-100 text-green-800',
    SHADOW: 'bg-gray-100 text-gray-600',
    REVERSED: 'bg-red-100 text-red-700',
    OPEN: 'bg-gray-100 text-gray-700',
    PREPARED: 'bg-blue-100 text-blue-800',
    APPROVED: 'bg-indigo-100 text-indigo-800',
    FILED: 'bg-green-100 text-green-800',
    ACTIVE: 'bg-green-100 text-green-800',
    FINAL: 'bg-purple-100 text-purple-800',
    CREDITABLE: 'bg-teal-100 text-teal-800',
};
const Pill = ({ value, label }) => (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_TONE[value] || 'bg-gray-100 text-gray-700'}`}>{label || value}</span>
);

const Tabs = ({ tabs, active, onChange }) => (
    <div className="tab-bar" role="tablist">
        {tabs.map(t => (
            <button key={t.key} onClick={() => onChange(t.key)}
                className={`tab ${active === t.key ? 'tab-active' : ''}`}>
                {t.label}
                {t.count > 0 && <span className="tab-count-alert">{t.count}</span>}
            </button>
        ))}
    </div>
);

const Stat = ({ label, value, sub, tone = 'default' }) => (
    <div className={`card ${tone === 'warn' ? 'border border-amber-300 bg-amber-50' : ''}`}>
        <p className="text-sm font-medium text-gray-500">{label}</p>
        <p className="text-2xl font-bold text-gray-900 mt-1">{value}</p>
        {sub && <p className="text-xs text-gray-500 mt-1">{sub}</p>}
    </div>
);

const Note = ({ children, tone = 'info' }) => (
    <div className={`flex gap-2 p-3 rounded-lg text-sm mb-4 ${tone === 'warn'
        ? 'bg-amber-50 text-amber-900 border border-amber-200'
        : tone === 'ok' ? 'bg-green-50 text-green-900 border border-green-200'
            : 'bg-blue-50 text-blue-900 border border-blue-100'}`}>
        {tone === 'warn' ? <ExclamationTriangleIcon className="h-5 w-5 flex-shrink-0" />
            : tone === 'ok' ? <CheckCircleIcon className="h-5 w-5 flex-shrink-0" />
                : <InformationCircleIcon className="h-5 w-5 flex-shrink-0" />}
        <div>{children}</div>
    </div>
);

const Success = ({ message, onDismiss }) => (message ? (
    <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm text-green-700 mb-4 flex justify-between">
        <span>{message}</span>
        <button onClick={onDismiss} className="text-green-700 ml-4">×</button>
    </div>
) : null);

const Table = ({ head, children, empty }) => (
    <div className="overflow-hidden rounded-lg border border-gray-200">
        <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                    <tr>{head.map((h, i) => <th key={i} className={`table-header ${h.right ? 'text-right' : ''}`}>{h.label || h}</th>)}</tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-100">
                    {children && (Array.isArray(children) ? children.length > 0 : true) ? children : (
                        <tr><td colSpan={head.length} className="px-6 py-6 text-center text-sm text-gray-400">{empty || 'Nothing yet'}</td></tr>
                    )}
                </tbody>
            </table>
        </div>
    </div>
);

const useUgxAccounts = () => {
    const [accounts, setAccounts] = useState([]);
    useEffect(() => {
        accountsAPI.getAll()
            .then(res => setAccounts((res.data.data || []).filter(a => a.is_active !== false && a.currency_code === 'UGX' && a.account_type !== 'SAVINGS')))
            .catch(() => setAccounts([]));
    }, []);
    return accounts;
};
const useAllAccounts = () => {
    const [accounts, setAccounts] = useState([]);
    useEffect(() => {
        accountsAPI.getAll().then(res => setAccounts((res.data.data || []).filter(a => a.is_active !== false))).catch(() => setAccounts([]));
    }, []);
    return accounts;
};

// ============================================================
// OVERVIEW
// ============================================================
const OverviewTab = ({ overview, onGo }) => {
    const reg = overview.registration || {};
    const cy = overview.currentYear;
    return (
        <div className="space-y-6">
            {!overview.setupComplete && (
                <Note tone="warn">
                    The company's tax registration details are not complete ({[!reg.tin && 'TIN', !reg.registration_number && 'registration number', !reg.incorporation_date && 'incorporation date'].filter(Boolean).join(', ')}).
                    Enter them on the <button className="underline font-medium" onClick={() => onGo('settings')}>Settings</button> tab — the tax years start from the incorporation date.
                </Note>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <Stat label="Withheld tax owed to URA" value={`UGX ${money(overview.whtPayable)}`}
                    tone={overview.whtPendingMonths.some(m => m.overdue) ? 'warn' : 'default'}
                    sub={overview.whtPendingMonths.length
                        ? overview.whtPendingMonths.map(m => `${m.month}: due ${formatDate(m.dueDate)}${m.overdue ? ' (OVERDUE)' : ''}`).join(' · ')
                        : 'Nothing waiting to be paid'} />
                <Stat label={`Corporate tax so far — ${cy?.label || 'current year'}`} value={cy && !cy.error ? `UGX ${money(cy.grossTax)}` : '—'}
                    sub={cy && !cy.error ? `On chargeable income of UGX ${money(cy.chargeableIncome)} (profit before tax ${money(cy.profitBeforeTax)}); still to pay ${money(cy.balanceDue)} after credits and provisional tax` : (cy?.error || 'Set the incorporation date first')} />
                <Stat label="Tax deducted from the company (this financial year)"
                    value={`UGX ${money(overview.deductedFromUs.final.tax + overview.deductedFromUs.creditable.tax)}`}
                    sub={`Final: ${money(overview.deductedFromUs.final.tax)} · Creditable (set off against corporate tax): ${money(overview.deductedFromUs.creditable.tax)}`} />
                <Stat label="Withheld by the company (this financial year)" value={`UGX ${money(overview.withheldByUs.real)}`}
                    sub={`Shadow 6% (not designated, not held back): ${money(overview.withheldByUs.shadow)}`} />
            </div>

            <div className="card">
                <div className="flex items-center justify-between mb-3">
                    <h3 className="section-title">Coming up</h3>
                    <button className="text-sm text-primary-700 underline" onClick={() => onGo('calendar')}>Full calendar</button>
                </div>
                {overview.upcoming.length === 0 ? <p className="text-sm text-gray-400">No open deadlines.</p> : (
                    <ul className="divide-y divide-gray-100">
                        {overview.upcoming.map(d => (
                            <li key={d.key} className="py-2 flex justify-between gap-4 text-sm min-w-0">
                                <span>{d.title}{d.detail ? <span className="block text-xs text-gray-400">{d.detail}</span> : null}</span>
                                <span className={`text-right sm:whitespace-nowrap ${d.overdue ? 'text-red-600 font-semibold' : d.daysLeft <= 7 ? 'text-amber-600 font-medium' : 'text-gray-600'}`}>
                                    {formatDate(d.dueDate)}{d.amount ? ` · UGX ${money(d.amount)}` : ''}{d.overdue ? ' · OVERDUE' : d.daysLeft >= 0 ? ` · ${d.daysLeft} day(s)` : ''}
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            <div className="card text-sm text-gray-700 space-y-2">
                <h3 className="section-title mb-1">How the system keeps track</h3>
                <p><strong>1. Tax deducted from the company.</strong> When Bank of Uganda pays a bond coupon or a treasury bill matures, or a bank pays
                    interest, it may keep part as tax. The income is recorded GROSS and the tax as its own entry: <em>final</em> tax (government
                    securities) is part of the income tax charge and that income is left out of the corporate tax computation;
                    <em> creditable</em> tax is a prepayment (account 1500) set off against the year's corporate tax.</p>
                <p><strong>2. Tax the company withholds.</strong> Dividends and interest paid to members, interest to a lender outside Uganda — and
                    6% of payments above UGX 1,000,000 for goods and services once URA designates the company — are paid NET. The tax stays in the
                    company's account as a debt to URA (account 2500) until it is paid, by the 15th of the next month.
                    {reg.wht_agent_designated ? ' The company IS currently a designated withholding agent.' : ' The company is NOT currently designated, so the 6% is recorded as shadow only (nothing held back).'}</p>
                <p><strong>3. Corporate income tax.</strong> For each year of income (1 July – 30 June) the computation starts from the profit before tax
                    in the books, adds back what is not deductible, takes out income already taxed as final tax, deducts losses brought forward,
                    applies 30%, and subtracts credits and provisional tax. The Treasurer prepares it; a Director approves it (which books the tax);
                    it is then marked filed.</p>
                <p><strong>4. Every payment to URA</strong> is a real transaction from a UGX account, so the tax owed in the balance sheet always equals
                    what is still unpaid.</p>
            </div>
        </div>
    );
};

// ============================================================
// DEDUCTED FROM US
// ============================================================
const EditAtSource = ({ row, onDone, onCancel }) => {
    const [form, setForm] = useState({ treatment: row.treatment, certificate_number: row.certificate_number || '', certificate_received_at: row.certificate_received_at || '', payer_tin: row.payer_tin || '' });
    const [error, setError] = useState(null);
    const save = async () => {
        try { await taxAPI.updateAtSource(row.id, form); onDone(); } catch (err) { setError(getErrorMessage(err)); }
    };
    return (
        <tr><td colSpan={9} className="bg-gray-50 px-4 py-3">
            {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                <div><label className="label">Treatment</label>
                    <select className="input" value={form.treatment} onChange={e => setForm(f => ({ ...f, treatment: e.target.value }))}>
                        <option value="FINAL">Final tax</option><option value="CREDITABLE">Creditable</option>
                    </select></div>
                <div><label className="label">Certificate number</label>
                    <input className="input" value={form.certificate_number} onChange={e => setForm(f => ({ ...f, certificate_number: e.target.value }))} /></div>
                <div><label className="label">Certificate received on</label>
                    <input type="date" className="input" value={form.certificate_received_at} onChange={e => setForm(f => ({ ...f, certificate_received_at: e.target.value }))} /></div>
                <div><label className="label">Payer TIN</label>
                    <input className="input" value={form.payer_tin} onChange={e => setForm(f => ({ ...f, payer_tin: e.target.value }))} /></div>
            </div>
            <div className="flex justify-end gap-2 mt-3">
                <button className="btn-secondary text-sm" onClick={onCancel}>Cancel</button>
                <button className="btn-primary text-sm" onClick={save}>Save</button>
            </div>
        </td></tr>
    );
};

const RecordAtSourceForm = ({ onDone }) => {
    const accounts = useAllAccounts();
    const [form, setForm] = useState({ account_id: '', source_type: 'BANK_INTEREST', payer_name: '', payer_tin: '', gross_amount: '', tax_amount: '', treatment: 'CREDITABLE', deduction_date: today(), certificate_number: '', notes: '' });
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));
    const submit = async (e) => {
        e.preventDefault(); setBusy(true); setError(null);
        try { const res = await taxAPI.recordAtSource(form); onDone(res.data.message); } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
    };
    return (
        <form onSubmit={submit} className="bg-gray-50 border border-gray-200 rounded-lg p-4 mb-4">
            <h4 className="text-sm font-semibold text-gray-700 mb-1">Record tax deducted at source</h4>
            <p className="text-xs text-gray-500 mb-3">Use this when the income itself was already recorded GROSS (e.g. from a bank statement) and the payer kept back tax.
                It posts the tax as its own entry on the account and adds it to this register. Bond coupons, treasury bills and investment returns record their tax automatically.</p>
            {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div><label className="label">Account the income went into *</label>
                    <select className="input" value={form.account_id} onChange={set('account_id')} required>
                        <option value="">Choose…</option>
                        {accounts.map(a => <option key={a.id} value={a.id}>{a.name} ({a.currency_code})</option>)}
                    </select></div>
                <div><label className="label">Kind of income</label>
                    <select className="input" value={form.source_type} onChange={set('source_type')}>
                        {['BANK_INTEREST', 'MMF', 'DIVIDEND_RECEIVED', 'OTHER_INCOME', 'OTHER'].map(k => <option key={k} value={k}>{SOURCE_LABELS[k]}</option>)}
                    </select></div>
                <div><label className="label">Paid by (payer)</label><input className="input" value={form.payer_name} onChange={set('payer_name')} /></div>
                <div><label className="label">Gross income (before tax) *</label><input type="number" step="0.01" className="input" value={form.gross_amount} onChange={set('gross_amount')} required /></div>
                <div><label className="label">Tax kept back *</label><input type="number" step="0.01" className="input" value={form.tax_amount} onChange={set('tax_amount')} required /></div>
                <div><label className="label">Treatment *</label>
                    <select className="input" value={form.treatment} onChange={set('treatment')}>
                        <option value="CREDITABLE">Creditable — set off against corporate tax</option>
                        <option value="FINAL">Final — no further tax on this income</option>
                    </select></div>
                <div><label className="label">Date deducted *</label><input type="date" className="input" value={form.deduction_date} max={today()} onChange={set('deduction_date')} required /></div>
                <div><label className="label">Certificate number</label><input className="input" value={form.certificate_number} onChange={set('certificate_number')} /></div>
                <div><label className="label">Payer TIN</label><input className="input" value={form.payer_tin} onChange={set('payer_tin')} /></div>
            </div>
            <div className="flex justify-end mt-3"><button className="btn-primary text-sm" disabled={busy}>{busy ? 'Saving…' : 'Record'}</button></div>
        </form>
    );
};

const DeductedTab = ({ canRecord }) => {
    const [rows, setRows] = useState(null);
    const [error, setError] = useState(null);
    const [success, setSuccess] = useState(null);
    const [editId, setEditId] = useState(null);
    const [showForm, setShowForm] = useState(false);
    const load = useCallback(() => {
        taxAPI.getAtSource().then(res => setRows(res.data.data)).catch(err => setError(getErrorMessage(err)));
    }, []);
    useEffect(() => { load(); }, [load]);
    if (!rows) return error ? <ErrorMessage message={error} /> : <LoadingSpinner size="md" text="Loading…" />;
    const active = rows.filter(r => r.status === 'ACTIVE');
    const sum = (t) => active.filter(r => r.treatment === t).reduce((s, r) => s + (r.tax_functional || 0), 0);
    return (
        <div>
            {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
            <Success message={success} onDismiss={() => setSuccess(null)} />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                <Stat label="Final tax deducted (all time)" value={`UGX ${money(sum('FINAL'))}`} sub="Part of the income tax charge (account 5700); the income is not taxed again." />
                <Stat label="Creditable tax deducted (all time)" value={`UGX ${money(sum('CREDITABLE'))}`} sub="A prepayment (account 1500), set off against the corporate tax when the year is filed." />
            </div>
            {canRecord && (
                <div className="flex justify-end mb-3">
                    <button className="btn-primary text-sm" onClick={() => setShowForm(s => !s)}>{showForm ? 'Close' : 'Record tax deducted at source'}</button>
                </div>
            )}
            {showForm && <RecordAtSourceForm onDone={(m) => { setShowForm(false); setSuccess(m); load(); }} />}
            <Table head={['Date', 'Reference', 'Source', 'Gross', { label: 'Tax', right: true }, { label: 'UGX value', right: true }, 'Treatment', 'Certificate', '']} empty="No tax has been deducted from the company yet.">
                {rows.map(r => ([
                    <tr key={r.id} className={r.status === 'REVERSED' ? 'opacity-50' : ''}>
                        <td className="table-cell text-sm">{formatDate(r.deduction_date)}</td>
                        <td className="table-cell font-mono text-xs">{r.reference_code || '—'}{r.is_backfilled && <span className="block text-[10px] text-gray-400">added by v1.70.0</span>}</td>
                        <td className="table-cell text-sm">{r.source_label}{r.coupon_number ? ` #${r.coupon_number}` : ''}<span className="block text-xs text-gray-400">{r.payer_name || r.investment_name || ''}</span></td>
                        <td className="table-cell text-sm">{r.currency_code} {money2(r.gross_amount)}</td>
                        <td className="table-cell text-sm text-right">{r.currency_code} {money2(r.tax_amount)}{r.rate ? <span className="block text-xs text-gray-400">{Number(r.rate)}%</span> : null}</td>
                        <td className="table-cell text-sm text-right">{money(r.tax_functional)}</td>
                        <td className="table-cell"><Pill value={r.treatment} />{r.status === 'REVERSED' && <Pill value="REVERSED" />}{r.claimed_in && <span className="block text-xs text-gray-400">claimed in {r.claimed_in}</span>}</td>
                        <td className="table-cell text-xs">{r.certificate_number || <span className="text-amber-600">not recorded</span>}</td>
                        <td className="table-cell">{canRecord && r.status === 'ACTIVE' && <button className="text-xs text-primary-700 underline" onClick={() => setEditId(editId === r.id ? null : r.id)}>Edit</button>}</td>
                    </tr>,
                    editId === r.id ? <EditAtSource key={`e${r.id}`} row={r} onCancel={() => setEditId(null)} onDone={() => { setEditId(null); setSuccess('Updated'); load(); }} /> : null,
                ]))}
            </Table>
        </div>
    );
};

// ============================================================
// WITHHELD & RETURNS
// ============================================================
const RemitForm = ({ month, onDone, onCancel }) => {
    const accounts = useUgxAccounts();
    const [form, setForm] = useState({ month: month.month, account_id: '', paid_date: today(), prn: '', return_reference: '', notes: '' });
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));
    const submit = async (e) => {
        e.preventDefault(); setBusy(true); setError(null);
        try { const res = await taxAPI.remitMonth(form); onDone(res.data.message); } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
    };
    return (
        <form onSubmit={submit} className="bg-gray-50 border border-gray-200 rounded-lg p-4 my-3">
            <h4 className="text-sm font-semibold text-gray-700 mb-1">Record the payment to URA for {month.month} — UGX {money(month.total)}</h4>
            <p className="text-xs text-gray-500 mb-3">File the monthly withholding tax return on the URA portal, pay with the Payment Registration Number (PRN) it gives you,
                then record it here. All {month.items} deduction(s) of that month are marked paid and their certificates updated.</p>
            {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div><label className="label">Paid from (UGX account) *</label>
                    <select className="input" value={form.account_id} onChange={set('account_id')} required>
                        <option value="">Choose…</option>
                        {accounts.map(a => <option key={a.id} value={a.id}>{a.name} — balance {money(a.current_balance)}</option>)}
                    </select></div>
                <div><label className="label">Date paid *</label><input type="date" className="input" value={form.paid_date} max={today()} onChange={set('paid_date')} required /></div>
                <div><label className="label">PRN</label><input className="input" value={form.prn} onChange={set('prn')} placeholder="Payment Registration Number" /></div>
                <div><label className="label">Return reference</label><input className="input" value={form.return_reference} onChange={set('return_reference')} /></div>
                <div className="sm:col-span-2"><label className="label">Notes</label><input className="input" value={form.notes} onChange={set('notes')} /></div>
            </div>
            <div className="flex justify-end gap-2 mt-3">
                <button type="button" className="btn-secondary text-sm" onClick={onCancel}>Cancel</button>
                <button className="btn-primary text-sm" disabled={busy}>{busy ? 'Saving…' : 'Record payment'}</button>
            </div>
        </form>
    );
};

const WithheldTab = ({ canRecord }) => {
    const [summary, setSummary] = useState(null);
    const [rows, setRows] = useState([]);
    const [status, setStatus] = useState('');
    const [error, setError] = useState(null);
    const [success, setSuccess] = useState(null);
    const [remitMonth, setRemitMonth] = useState(null);
    const load = useCallback(() => {
        Promise.all([taxAPI.getRemittances(), taxAPI.getWithholdings(status ? { status } : {})])
            .then(([s, w]) => { setSummary(s.data.data); setRows(w.data.data); })
            .catch(err => setError(getErrorMessage(err)));
    }, [status]);
    useEffect(() => { load(); }, [load]);
    if (!summary) return error ? <ErrorMessage message={error} /> : <LoadingSpinner size="md" text="Loading…" />;
    return (
        <div className="space-y-6">
            {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
            <Success message={success} onDismiss={() => setSuccess(null)} />
            <div className="card">
                <h3 className="section-title mb-3">Waiting to be paid to URA</h3>
                {summary.pending.length === 0 ? <p className="text-sm text-gray-400">Nothing is waiting — every tax withheld has been paid over.</p> : (
                    <div className="divide-y divide-gray-100">
                        {summary.pending.map(m => (
                            <div key={m.month} className="py-2">
                                <div className="flex flex-wrap justify-between gap-2 text-sm items-center">
                                    <span><strong>{m.month}</strong> — {m.items} deduction(s)</span>
                                    <span>UGX <strong>{money(m.total)}</strong></span>
                                    <span className={m.overdue ? 'text-red-600 font-semibold' : 'text-gray-600'}>due {formatDate(m.dueDate)}{m.overdue ? ' — OVERDUE (late payment interest applies)' : ` — ${m.daysLeft} day(s) left`}</span>
                                    {canRecord && <button className="btn-primary text-xs" onClick={() => setRemitMonth(m)}>Record payment</button>}
                                </div>
                                {remitMonth && remitMonth.month === m.month && (
                                    <RemitForm month={m} onCancel={() => setRemitMonth(null)} onDone={(msg) => { setRemitMonth(null); setSuccess(msg); load(); }} />
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>

            <div>
                <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
                    <h3 className="section-title">Every withholding</h3>
                    <select className="input w-auto text-sm" value={status} onChange={e => setStatus(e.target.value)}>
                        <option value="">All</option><option value="PENDING">Waiting to be paid</option><option value="REMITTED">Paid to URA</option>
                        <option value="SHADOW">Shadow (not designated)</option><option value="REVERSED">Reversed</option>
                    </select>
                </div>
                <Table head={['Date', 'Reference', 'Paid to', 'Kind', { label: 'Gross', right: true }, { label: 'Tax', right: true }, { label: 'UGX owed', right: true }, 'Status']} empty="Nothing withheld yet.">
                    {rows.map(w => (
                        <tr key={w.id} className={w.status === 'REVERSED' ? 'opacity-50' : ''}>
                            <td className="table-cell text-sm">{formatDate(w.withholding_date)}</td>
                            <td className="table-cell font-mono text-xs">{w.reference_code}</td>
                            <td className="table-cell text-sm">{w.payee_name}<span className="block text-xs text-gray-400">{w.payee_tin ? `TIN ${w.payee_tin}` : 'no TIN'} · {w.payee_residency === 'NON_RESIDENT' ? 'non-resident' : 'resident'}</span></td>
                            <td className="table-cell text-sm">{w.payment_label}</td>
                            <td className="table-cell text-sm text-right">{w.currency_code} {money2(w.gross_amount)}</td>
                            <td className="table-cell text-sm text-right">{w.currency_code} {money2(w.tax_amount)}<span className="block text-xs text-gray-400">{Number(w.rate)}%</span></td>
                            <td className="table-cell text-sm text-right">{w.is_shadow ? <span className="text-gray-400">({money(w.tax_functional)})</span> : money(w.tax_functional)}</td>
                            <td className="table-cell"><Pill value={w.status} label={w.status === 'REMITTED' ? 'PAID TO URA' : w.status} />
                                {w.remittance_reference && <span className="block text-xs text-gray-400">{w.remittance_reference}{w.prn ? ` · PRN ${w.prn}` : ''}</span>}</td>
                        </tr>
                    ))}
                </Table>
                <p className="text-xs text-gray-400 mt-2">Shadow rows show what 6% withholding would have been if the company were a designated agent. No money was held back and they are not in the books.</p>
            </div>

            <div>
                <h3 className="section-title mb-2">Payments to URA</h3>
                <Table head={['Month', 'Reference', 'Paid on', 'Due', { label: 'Amount (UGX)', right: true }, 'PRN', 'From']} empty="No payments recorded yet.">
                    {summary.remittances.map(r => (
                        <tr key={r.id}>
                            <td className="table-cell text-sm">{r.month}</td>
                            <td className="table-cell font-mono text-xs">{r.reference_code}</td>
                            <td className="table-cell text-sm">{formatDate(r.paid_date)}{r.late && <span className="block text-xs text-red-600">late</span>}</td>
                            <td className="table-cell text-sm">{formatDate(r.due_date)}</td>
                            <td className="table-cell text-sm text-right">{money(r.total_tax_functional)}</td>
                            <td className="table-cell text-xs">{r.prn || '—'}</td>
                            <td className="table-cell text-xs">{r.account_name}</td>
                        </tr>
                    ))}
                </Table>
            </div>
        </div>
    );
};

// ============================================================
// CORPORATE TAX
// ============================================================
const Line = ({ label, value, bold, indent, negative, sub }) => (
    <div className={`flex justify-between py-1 text-sm ${bold ? 'font-semibold border-t border-gray-200 mt-1 pt-2' : ''}`}>
        <span className={indent ? 'pl-4 text-gray-600' : ''}>{label}{sub && <span className="block text-xs text-gray-400">{sub}</span>}</span>
        <span className={negative ? 'text-red-600' : ''}>{negative ? `(${money(value)})` : money(value)}</span>
    </div>
);

const Worksheet = ({ w }) => {
    const [open, setOpen] = useState({});
    const toggle = (k) => setOpen(o => ({ ...o, [k]: !o[k] }));
    const DetailList = ({ item }) => (item.detail && open[item.key] ? (
        <div className="ml-6 mb-2 text-xs text-gray-500 space-y-0.5">
            {item.detail.map((d, i) => (
                <div key={i} className="flex justify-between gap-2"><span>{formatDate(d.date)} · {d.reference || ''} · {d.description}{d.account ? ` · ${d.account}` : ''}</span><span>{money(d.amount)}</span></div>
            ))}
        </div>
    ) : null);
    return (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="card">
                <h4 className="section-title mb-2">From the books (UGX)</h4>
                <p className="text-xs text-gray-400 mb-2">{w.range.from ? `${formatDate(w.range.from)} – ` : 'From the first transaction – '}{formatDate(w.range.to)}</p>
                {w.incomeStatement.revenue.map(r => <Line key={r.code} label={r.name} value={r.amount} indent />)}
                <Line label="Total income" value={w.incomeStatement.totalRevenue} bold />
                {w.incomeStatement.expenses.map(r => <Line key={r.code} label={r.name} value={r.amount} indent negative />)}
                <Line label="Total expenses" value={w.incomeStatement.totalExpenses} negative bold />
                <Line label="Profit / (loss) before tax" value={w.profitBeforeTax} bold />
                {w.preIncorporation && (
                    <Note tone="warn">Before incorporation (up to {formatDate(w.preIncorporation.to)}): income {money(w.preIncorporation.totalRevenue)}, expenses {money(w.preIncorporation.totalExpenses)}
                        — {w.preIncorporation.included ? 'INCLUDED in this year (option below).' : 'NOT included (tick the option below to include it).'}</Note>
                )}
            </div>
            <div className="card">
                <h4 className="section-title mb-2">Tax computation (UGX)</h4>
                <Line label="Profit / (loss) before tax" value={w.profitBeforeTax} />
                <p className="text-xs font-semibold text-gray-500 mt-2">Add back</p>
                {w.addBacks.length === 0 && <p className="text-xs text-gray-400 pl-4">Nothing to add back</p>}
                {w.addBacks.map(a => (
                    <div key={a.key}>
                        <div className="flex justify-between py-1 text-sm pl-4 text-gray-600">
                            <span>{a.label}{!a.auto && <span className="text-xs text-gray-400"> (manual{a.legalReference ? `, ${a.legalReference}` : ''})</span>}
                                {a.detail && <button className="ml-2 text-xs underline text-primary-700" onClick={() => toggle(a.key)}>{open[a.key] ? 'hide' : 'details'}</button>}</span>
                            <span>{money(a.amount)}</span>
                        </div>
                        <DetailList item={a} />
                    </div>
                ))}
                <p className="text-xs font-semibold text-gray-500 mt-2">Deduct</p>
                {w.deductions.length === 0 && <p className="text-xs text-gray-400 pl-4">Nothing to deduct</p>}
                {w.deductions.map(a => (
                    <div key={a.key}>
                        <div className="flex justify-between py-1 text-sm pl-4 text-gray-600">
                            <span>{a.label}{!a.auto && <span className="text-xs text-gray-400"> (manual{a.legalReference ? `, ${a.legalReference}` : ''})</span>}
                                {a.detail && <button className="ml-2 text-xs underline text-primary-700" onClick={() => toggle(a.key)}>{open[a.key] ? 'hide' : 'details'}</button>}</span>
                            <span>({money(a.amount)})</span>
                        </div>
                        <DetailList item={a} />
                    </div>
                ))}
                <Line label="Chargeable income / (loss)" value={w.chargeableIncome} bold />
                <Line label="Less: loss brought forward used" value={w.lossUtilised} indent negative sub={`Loss brought forward ${money(w.lossBroughtForward)}`} />
                <Line label="Taxable income" value={w.taxableIncome} bold />
                <Line label={`Tax at ${w.taxRate}%`} value={w.grossTax} bold />
                <Line label="Less: creditable withholding tax" value={w.totalWhtCredits} indent negative />
                <Line label="Less: provisional tax paid" value={w.provisionalPaid} indent negative />
                <Line label={w.balanceDue >= 0 ? 'Balance of tax to pay' : 'Tax overpaid (refundable)'} value={Math.abs(w.balanceDue)} bold />
                {w.balancePaid > 0 && <Line label="Balance already paid" value={w.balancePaid} indent />}
                <Line label="Loss carried forward to next year" value={w.lossCarriedForward} />
            </div>
        </div>
    );
};

const YearPanel = ({ yearId, roles, onChanged }) => {
    const confirm = useConfirm();
    const accounts = useUgxAccounts();
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [success, setSuccess] = useState(null);
    const [estimate, setEstimate] = useState('');
    const [adj, setAdj] = useState({ kind: 'DEDUCTION', description: '', amount: '', legal_reference: '' });
    const [pay, setPay] = useState(null);
    const [file, setFile] = useState({ filing_date: today(), return_reference: '' });
    const [busy, setBusy] = useState(false);
    const isPreparer = roles.some(r => PREPARERS.includes(r));
    const isApprover = roles.some(r => APPROVERS.includes(r));

    const load = useCallback(() => {
        setData(null);
        taxAPI.getWorksheet(yearId).then(res => {
            setData(res.data.data);
            setEstimate(res.data.data.live.year.provisionalEstimate ?? '');
        }).catch(err => setError(getErrorMessage(err)));
    }, [yearId]);
    useEffect(() => { load(); }, [load]);

    const act = async (fn, msg) => {
        setBusy(true); setError(null);
        try { const res = await fn(); setSuccess(res?.data?.message || msg); load(); onChanged(); } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
    };
    if (!data) return error ? <ErrorMessage message={error} /> : <LoadingSpinner size="md" text="Computing…" />;
    const w = data.live;
    const y = w.year;
    const snap = data.snapshot;
    const open = y.status === 'OPEN';
    const changedSinceSnapshot = snap && ['chargeableIncome', 'grossTax', 'totalWhtCredits', 'provisionalPaid'].some(k => Math.abs((snap[k] || 0) - (w[k] || 0)) >= 1);
    const ended = y.endDate < today();

    return (
        <div className="space-y-4">
            {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
            <Success message={success} onDismiss={() => setSuccess(null)} />
            <div className="card flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h3 className="text-lg font-semibold">{y.label} <Pill value={y.status} /></h3>
                    <p className="text-sm text-gray-500">{formatDate(y.startDate)} – {formatDate(y.endDate)}{y.isFirstYear ? ' · first year (from incorporation)' : ''}</p>
                    <p className="text-xs text-gray-400">
                        Provisional tax due {formatDate(w.deadlines.provisional1)} and {formatDate(w.deadlines.provisional2)} · return and balance due {formatDate(w.deadlines.returnDue)}
                    </p>
                    {y.preparedBy && <p className="text-xs text-gray-500">Prepared by {y.preparedBy} · {formatDate(y.preparedAt)}</p>}
                    {y.approvedBy && <p className="text-xs text-gray-500">Approved by {y.approvedBy} · {formatDate(y.approvedAt)}</p>}
                    {y.filingDate && <p className="text-xs text-gray-500">Filed {formatDate(y.filingDate)}{y.returnReference ? ` · ${y.returnReference}` : ''}</p>}
                    {y.returnedReason && open && <p className="text-xs text-amber-700">Sent back: {y.returnedReason}</p>}
                </div>
                <div className="flex flex-wrap gap-2">
                    {open && isPreparer && !ended && (
                        <span className="text-xs text-gray-500 self-center">Can be prepared for approval after {formatDate(y.endDate)} — the figures below are the year so far.</span>
                    )}
                    {open && isPreparer && ended && (
                        <button className="btn-primary text-sm" disabled={busy}
                            onClick={async () => {
                                if (await confirm({ title: `Prepare ${y.label}`, message: 'This freezes the computation below and sends it to a Director for approval. Adjustments can no longer be changed unless it is sent back.', confirmLabel: 'Prepare' })) {
                                    act(() => taxAPI.prepareYear(yearId));
                                }
                            }}>Prepare for approval</button>
                    )}
                    {y.status === 'PREPARED' && isApprover && (
                        <button className="btn-primary text-sm" disabled={busy}
                            onClick={async () => {
                                if (await confirm({ title: `Approve ${y.label}`, message: `Approving books the corporate income tax of UGX ${money(snap?.grossTax)} (expense 5710, payable 2510) and creates the computation document. You cannot approve a computation you prepared.`, confirmLabel: 'Approve' })) {
                                    act(() => taxAPI.approveYear(yearId));
                                }
                            }}>Approve</button>
                    )}
                    {y.status === 'PREPARED' && (isApprover || isPreparer) && (
                        <button className="btn-secondary text-sm" disabled={busy} onClick={() => act(() => taxAPI.returnYear(yearId, { reason: window.prompt('Why is it being sent back?') || '' }))}>Send back</button>
                    )}
                </div>
            </div>

            {changedSinceSnapshot && (
                <Note tone="warn">The figures in the books have changed since this computation was {y.status === 'PREPARED' ? 'prepared' : 'approved'}
                    (the frozen computation shows tax {money(snap.grossTax)}; now {money(w.grossTax)}).
                    {y.status === 'PREPARED' ? ' Send it back and prepare it again before approval.' : ' A late entry was made in a closed year — discuss with the Director whether an amended return is needed.'}</Note>
            )}
            {w.warnings.map((m, i) => <Note key={i} tone="warn">{m}</Note>)}

            <Worksheet w={snap && !open ? snap : w} />

            {open && isPreparer && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <div className="card space-y-3">
                        <h4 className="section-title">Options</h4>
                        {y.isFirstYear && (
                            <label className="flex items-start gap-2 text-sm">
                                <input type="checkbox" checked={y.includePreIncorporation}
                                    onChange={e => act(() => taxAPI.updateYearOptions(yearId, { include_pre_incorporation: e.target.checked }), 'Saved')} />
                                <span>Include transactions dated before the incorporation date in this first year (pre-incorporation costs the company took over).</span>
                            </label>
                        )}
                        <label className="flex items-start gap-2 text-sm">
                            <input type="checkbox" checked={y.fxRevaluationTaxable}
                                onChange={e => act(() => taxAPI.updateYearOptions(yearId, { fx_revaluation_taxable: e.target.checked }), 'Saved')} />
                            <span>Treat foreign exchange gains and losses (revaluation) as taxable / deductible. Untick to leave the net FX result out of this year's computation.</span>
                        </label>
                        <h4 className="section-title pt-2">Add an adjustment</h4>
                        <p className="text-xs text-gray-500">E.g. capital allowances (wear and tear) on assets bought, exempt income, or an expense not deductible that the categories did not catch. In UGX.</p>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <select className="input" value={adj.kind} onChange={e => setAdj(a => ({ ...a, kind: e.target.value }))}>
                                <option value="DEDUCTION">Deduction (reduces the taxable figure)</option>
                                <option value="ADD_BACK">Add back (increases it)</option>
                            </select>
                            <input className="input" type="number" step="0.01" placeholder="Amount (UGX)" value={adj.amount} onChange={e => setAdj(a => ({ ...a, amount: e.target.value }))} />
                            <input className="input sm:col-span-2" placeholder="Description" value={adj.description} onChange={e => setAdj(a => ({ ...a, description: e.target.value }))} />
                            <input className="input sm:col-span-2" placeholder="Legal reference (optional, e.g. ITA s.27)" value={adj.legal_reference} onChange={e => setAdj(a => ({ ...a, legal_reference: e.target.value }))} />
                        </div>
                        <div className="flex justify-end">
                            <button className="btn-primary text-sm" disabled={busy || !adj.description || !adj.amount}
                                onClick={() => act(() => taxAPI.addAdjustment(yearId, adj)).then(() => setAdj({ kind: 'DEDUCTION', description: '', amount: '', legal_reference: '' }))}>Add</button>
                        </div>
                        {w.addBacks.concat(w.deductions).filter(a => !a.auto).length > 0 && (
                            <ul className="text-sm divide-y divide-gray-100">
                                {w.addBacks.concat(w.deductions).filter(a => !a.auto).map(a => (
                                    <li key={a.key} className="py-1 flex justify-between items-center">
                                        <span>{a.label} — {money(a.amount)}</span>
                                        <button title="Remove" onClick={() => act(() => taxAPI.removeAdjustment(a.id), 'Removed')}><TrashIcon className="h-4 w-4 text-red-500" /></button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                    <div className="card space-y-3">
                        <h4 className="section-title">Provisional tax (paid during the year)</h4>
                        <p className="text-xs text-gray-500">Estimate the year's chargeable income; the tax on it is paid in two halves — by {formatDate(w.deadlines.provisional1)} and {formatDate(w.deadlines.provisional2)}.
                            Revise the estimate if the year turns out differently (an estimate far below the final figure can attract a penalty).</p>
                        <div className="flex gap-2">
                            <input className="input" type="number" step="0.01" value={estimate} onChange={e => setEstimate(e.target.value)} placeholder="Estimated chargeable income (UGX)" />
                            <button className="btn-primary text-sm" disabled={busy || estimate === ''} onClick={() => act(() => taxAPI.setProvisional(yearId, { estimate }))}>Save</button>
                        </div>
                        {y.provisionalTaxEstimate !== null && (
                            <p className="text-sm">Estimated tax <strong>UGX {money(y.provisionalTaxEstimate)}</strong> — two instalments of <strong>{money(y.provisionalTaxEstimate / 2)}</strong>.</p>
                        )}
                    </div>
                </div>
            )}

            {y.status === 'APPROVED' && (isPreparer || isApprover) && (
                <div className="card">
                    <h4 className="section-title mb-2">Mark the return as filed</h4>
                    <p className="text-xs text-gray-500 mb-2">After submitting the return on the URA portal. The creditable withholding tax and provisional tax are then set off against this year's tax in the books.</p>
                    <div className="flex flex-wrap gap-2">
                        <input type="date" className="input w-auto" max={today()} value={file.filing_date} onChange={e => setFile(f => ({ ...f, filing_date: e.target.value }))} />
                        <input className="input w-auto" placeholder="Return / acknowledgement number" value={file.return_reference} onChange={e => setFile(f => ({ ...f, return_reference: e.target.value }))} />
                        <button className="btn-primary text-sm" disabled={busy} onClick={() => act(() => taxAPI.fileYear(yearId, file))}>Mark filed</button>
                    </div>
                </div>
            )}

            <div className="card">
                <div className="flex justify-between items-center mb-2">
                    <h4 className="section-title">Payments for {y.label}</h4>
                    {isPreparer && <button className="btn-primary text-xs" onClick={() => setPay(p => (p ? null : { kind: 'PROVISIONAL', instalment_no: 1, amount: '', account_id: '', paid_date: today(), prn: '', notes: '' }))}>{pay ? 'Close' : 'Record a payment'}</button>}
                </div>
                {pay && (
                    <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 mb-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
                        <select className="input" value={pay.kind} onChange={e => setPay(p => ({ ...p, kind: e.target.value }))}>
                            <option value="PROVISIONAL">Provisional tax instalment</option>
                            <option value="INCOME_TAX_BALANCE">Balance of tax (with the return)</option>
                            <option value="LATE_INTEREST">Late payment interest / penalty</option>
                            <option value="REFUND_RECEIVED">Refund received from URA</option>
                        </select>
                        {pay.kind === 'PROVISIONAL' && (
                            <select className="input" value={pay.instalment_no} onChange={e => setPay(p => ({ ...p, instalment_no: e.target.value }))}>
                                <option value={1}>1st instalment</option><option value={2}>2nd instalment</option>
                            </select>
                        )}
                        <input className="input" type="number" step="0.01" placeholder="Amount (UGX)" value={pay.amount} onChange={e => setPay(p => ({ ...p, amount: e.target.value }))} />
                        <select className="input" value={pay.account_id} onChange={e => setPay(p => ({ ...p, account_id: e.target.value }))}>
                            <option value="">{pay.kind === 'REFUND_RECEIVED' ? 'Received into (UGX)…' : 'Paid from (UGX)…'}</option>
                            {accounts.map(a => <option key={a.id} value={a.id}>{a.name} — {money(a.current_balance)}</option>)}
                        </select>
                        <input className="input" type="date" max={today()} value={pay.paid_date} onChange={e => setPay(p => ({ ...p, paid_date: e.target.value }))} />
                        <input className="input" placeholder="PRN" value={pay.prn} onChange={e => setPay(p => ({ ...p, prn: e.target.value }))} />
                        <div className="sm:col-span-3 flex justify-end">
                            <button className="btn-primary text-sm" disabled={busy || !pay.amount || !pay.account_id}
                                onClick={() => act(() => taxAPI.recordPayment({ ...pay, tax_year_id: yearId })).then(() => setPay(null))}>Save payment</button>
                        </div>
                    </div>
                )}
                <Table head={['Date', 'Reference', 'Kind', { label: 'Amount (UGX)', right: true }, 'PRN', 'Account']} empty="No payments recorded for this year.">
                    {w.payments.map(p => (
                        <tr key={p.id}>
                            <td className="table-cell text-sm">{formatDate(p.paid_date)}</td>
                            <td className="table-cell font-mono text-xs">{p.reference_code}</td>
                            <td className="table-cell text-sm">{{ PROVISIONAL: `Provisional #${p.instalment_no}`, INCOME_TAX_BALANCE: 'Balance of tax', LATE_INTEREST: 'Late interest / penalty', REFUND_RECEIVED: 'Refund received' }[p.payment_kind]}</td>
                            <td className="table-cell text-sm text-right">{money(p.amount)}</td>
                            <td className="table-cell text-xs">{p.prn || '—'}</td>
                            <td className="table-cell text-xs">{p.account_name}</td>
                        </tr>
                    ))}
                </Table>
            </div>
        </div>
    );
};

const CorporateTab = ({ roles, onChanged }) => {
    const [years, setYears] = useState(null);
    const [selected, setSelected] = useState(null);
    const [error, setError] = useState(null);
    const load = useCallback(() => {
        taxAPI.getYears().then(res => {
            const ys = res.data.data.years;
            setYears(res.data.data);
            setSelected(s => s || (ys.find(y => y.status !== 'FILED' && y.end_date < today()) || ys[0] || {}).id || null);
        }).catch(err => setError(getErrorMessage(err)));
    }, []);
    useEffect(() => { load(); }, [load]);
    if (!years) return error ? <ErrorMessage message={error} /> : <LoadingSpinner size="md" text="Loading…" />;
    if (!years.registration.incorporation_date) {
        return <Note tone="warn">Enter the company's incorporation date on the Settings tab first — the first year of income starts on that date.</Note>;
    }
    return (
        <div className="space-y-4">
            <div className="flex gap-2 flex-wrap">
                {years.years.map(y => (
                    <button key={y.id} onClick={() => setSelected(y.id)}
                        className={`px-3 py-2 rounded-lg text-sm border ${selected === y.id ? 'border-primary-700 bg-primary-50 text-primary-800' : 'border-gray-200 bg-white text-gray-700'}`}>
                        {y.label} <Pill value={y.status} />
                    </button>
                ))}
            </div>
            {selected && <YearPanel key={selected} yearId={selected} roles={roles} onChanged={() => { load(); onChanged(); }} />}
        </div>
    );
};

// ============================================================
// CALENDAR
// ============================================================
const CalendarTab = () => {
    const [items, setItems] = useState(null);
    const [error, setError] = useState(null);
    useEffect(() => { taxAPI.getCalendar().then(res => setItems(res.data.data)).catch(err => setError(getErrorMessage(err))); }, []);
    if (!items) return error ? <ErrorMessage message={error} /> : <LoadingSpinner size="md" text="Loading…" />;
    return (
        <div>
            <Note>Reminders are sent to the Treasurer, Assistant Treasurer and Directors 7 days before each deadline, on the day, and every week after it while it is still open.</Note>
            <Table head={['Due', 'Deadline', { label: 'Amount (UGX)', right: true }, 'Status']} empty="No deadlines yet.">
                {items.map(i => (
                    <tr key={i.key}>
                        <td className="table-cell text-sm whitespace-nowrap">{formatDate(i.dueDate)}</td>
                        <td className="table-cell text-sm">{i.title}{i.detail && <span className="block text-xs text-gray-400">{i.detail}</span>}</td>
                        <td className="table-cell text-sm text-right">{i.amount ? money(i.amount) : '—'}</td>
                        <td className="table-cell text-sm">{i.done ? <span className="text-green-700">Done</span> : i.overdue ? <span className="text-red-600 font-semibold">OVERDUE</span> : `${i.daysLeft} day(s)`}</td>
                    </tr>
                ))}
            </Table>
        </div>
    );
};

// ============================================================
// SETTINGS — registration details, agent status, rates.
// TaxRegistrationCard is also shown on Settings > Registration & Tax.
// ============================================================
export const TaxRegistrationCard = ({ canEdit }) => {
    const [reg, setReg] = useState(null);
    const [form, setForm] = useState(null);
    const [error, setError] = useState(null);
    const [success, setSuccess] = useState(null);
    const [busy, setBusy] = useState(false);
    const load = useCallback(() => {
        taxAPI.getRegistration().then(res => {
            const r = res.data.data;
            setReg(r);
            setForm({ tin: r.tin || '', registration_number: r.registration_number || '', incorporation_date: r.incorporation_date || '', tax_office: r.tax_office || '' });
        }).catch(err => setError(getErrorMessage(err)));
    }, []);
    useEffect(() => { load(); }, [load]);
    if (!form) return error ? <ErrorMessage message={error} /> : <LoadingSpinner size="md" text="Loading…" />;
    const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));
    const save = async (e) => {
        e.preventDefault(); setBusy(true); setError(null);
        try { await taxAPI.saveRegistration(form); setSuccess('Saved'); load(); } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
    };
    return (
        <form onSubmit={save} className="card space-y-3">
            <h3 className="section-title">Company registration and tax details</h3>
            <p className="text-xs text-gray-500">Printed on withholding tax certificates and the tax computation. The incorporation date is where the first tax year starts.</p>
            {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
            <Success message={success} onDismiss={() => setSuccess(null)} />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div><label className="label">TIN (10 digits)</label><input className="input" value={form.tin} onChange={set('tin')} disabled={!canEdit} placeholder="1000123456" /></div>
                <div><label className="label">Company registration number (URSB)</label><input className="input" value={form.registration_number} onChange={set('registration_number')} disabled={!canEdit} /></div>
                <div><label className="label">Date of incorporation</label><input type="date" className="input" value={form.incorporation_date} onChange={set('incorporation_date')} max={today()} disabled={!canEdit} /></div>
                <div><label className="label">URA tax office</label><input className="input" value={form.tax_office} onChange={set('tax_office')} disabled={!canEdit} placeholder="e.g. Kampala — Medium Taxpayers" /></div>
            </div>
            {reg.tax_settings_updated_at && <p className="text-xs text-gray-400">Last changed {formatDate(reg.tax_settings_updated_at)} by {reg.tax_settings_updated_by_name}</p>}
            {canEdit && <div className="flex justify-end"><button className="btn-primary text-sm" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></div>}
        </form>
    );
};

export const AgentStatusCard = ({ canToggle }) => {
    const confirm = useConfirm();
    const [reg, setReg] = useState(null);
    const [form, setForm] = useState({ effective_date: today(), notes: '' });
    const [error, setError] = useState(null);
    const [success, setSuccess] = useState(null);
    const load = useCallback(() => { taxAPI.getRegistration().then(res => setReg(res.data.data)).catch(err => setError(getErrorMessage(err))); }, []);
    useEffect(() => { load(); }, [load]);
    if (!reg) return null;
    const next = !reg.wht_agent_designated;
    const toggle = async () => {
        const ok = await confirm({
            title: next ? 'Record designation as withholding agent' : 'Record that the company is NOT a withholding agent',
            message: next
                ? `From ${form.effective_date}, 6% will actually be withheld from payments above UGX 1,000,000 for goods and services, and paid to URA monthly. A notice goes to every member.`
                : `From ${form.effective_date}, the 6% will only be tracked (shadow) — no money held back. Nothing already recorded changes. A notice goes to every member.`,
            confirmLabel: 'Confirm',
        });
        if (!ok) return;
        try { const res = await taxAPI.setAgentStatus({ designated: next, ...form }); setSuccess(res.data.message); load(); } catch (err) { setError(getErrorMessage(err)); }
    };
    return (
        <div className="card space-y-3">
            <h3 className="section-title">Withholding tax agent status</h3>
            {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
            <Success message={success} onDismiss={() => setSuccess(null)} />
            <div className={`p-3 rounded-lg text-sm ${reg.wht_agent_designated ? 'bg-green-50 text-green-900' : 'bg-gray-50 text-gray-700'}`}>
                The company is currently <strong>{reg.wht_agent_designated ? 'DESIGNATED' : 'NOT designated'}</strong> by URA as a withholding tax agent
                {reg.wht_agent_effective_date ? ` (since ${formatDate(reg.wht_agent_effective_date)})` : ''}.
                {reg.wht_agent_designated
                    ? ' 6% is withheld from payments above UGX 1,000,000 for goods and services.'
                    : ' The 6% is recorded as shadow ("as if designated") — no money is held back.'}
                <span className="block text-xs mt-1">Withholding on dividends, interest to members and payments to non-residents does not depend on this status.</span>
            </div>
            {canToggle && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 items-end">
                    <div><label className="label">Effective from</label><input type="date" className="input" value={form.effective_date} onChange={e => setForm(f => ({ ...f, effective_date: e.target.value }))} /></div>
                    <div className="sm:col-span-2"><label className="label">Notes (e.g. URA letter reference)</label><input className="input" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} /></div>
                    <div className="sm:col-span-3 flex justify-end">
                        <button className={next ? 'btn-primary text-sm' : 'btn-secondary text-sm'} onClick={toggle}>
                            {next ? 'Turn ON — company is designated' : 'Turn OFF — company is not designated'}
                        </button>
                    </div>
                </div>
            )}
            {reg.agentHistory.length > 0 && (
                <div>
                    <p className="text-xs font-semibold text-gray-500 mb-1">History (each change sent a notice to all members)</p>
                    <ul className="text-xs text-gray-600 space-y-0.5">
                        {reg.agentHistory.map(h => (
                            <li key={h.id}>{formatDate(h.effective_date)} — {h.designated ? 'DESIGNATED' : 'NOT designated'} · by {h.changed_by_name}{h.notes ? ` · ${h.notes}` : ''}</li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
};

const RatesCard = ({ canEdit }) => {
    const [rates, setRates] = useState(null);
    const [edit, setEdit] = useState(null);
    const [error, setError] = useState(null);
    const [success, setSuccess] = useState(null);
    const load = useCallback(() => { taxAPI.getRates().then(res => setRates(res.data.data)).catch(err => setError(getErrorMessage(err))); }, []);
    useEffect(() => { load(); }, [load]);
    if (!rates) return null;
    const current = rates.filter(r => r.is_current || !rates.some(o => o.code === r.code && o.is_current && o.id !== r.id));
    const byCode = [];
    current.forEach(r => { if (!byCode.some(x => x.code === r.code)) byCode.push(r); });
    const save = async () => {
        try { await taxAPI.addRate(edit); setSuccess(`New ${edit.code} rate saved from ${edit.effective_from}`); setEdit(null); load(); } catch (err) { setError(getErrorMessage(err)); }
    };
    return (
        <div className="card">
            <h3 className="section-title mb-1">Tax rates</h3>
            <p className="text-xs text-gray-500 mb-3">Seeded from the published Uganda rates (reviewed January 2026). <strong>Check them against the current law before the first filing.</strong> A change is saved
                as a new dated rate — figures already recorded keep the rate of their own date.</p>
            {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
            <Success message={success} onDismiss={() => setSuccess(null)} />
            <Table head={['Rate', { label: '%', right: true }, 'Treatment', 'Threshold (UGX)', 'Since', 'Law', '']}>
                {byCode.map(r => ([
                    <tr key={r.id}>
                        <td className="table-cell text-sm">{r.name}<span className="block text-[10px] font-mono text-gray-400">{r.code}</span></td>
                        <td className="table-cell text-sm text-right font-semibold">{Number(r.rate)}</td>
                        <td className="table-cell text-xs">{r.treatment || '—'}</td>
                        <td className="table-cell text-xs">{r.threshold_amount ? money(r.threshold_amount) : '—'}</td>
                        <td className="table-cell text-xs">{r.effective_from === '2000-01-01' ? 'as seeded' : formatDate(r.effective_from)}</td>
                        <td className="table-cell text-xs text-gray-500">{r.legal_reference}</td>
                        <td className="table-cell">{canEdit && <button className="text-xs text-primary-700 underline" onClick={() => setEdit({ code: r.code, rate: r.rate, treatment: r.treatment || '', threshold_amount: r.threshold_amount ?? '', effective_from: today(), legal_reference: r.legal_reference || '', notes: '' })}>Change</button>}</td>
                    </tr>,
                    edit && edit.code === r.code ? (
                        <tr key={`e${r.id}`}><td colSpan={7} className="bg-gray-50 px-4 py-3">
                            <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
                                <div><label className="label">New rate (%)</label><input className="input" type="number" step="0.01" value={edit.rate} onChange={e => setEdit(x => ({ ...x, rate: e.target.value }))} /></div>
                                <div><label className="label">From</label><input className="input" type="date" value={edit.effective_from} onChange={e => setEdit(x => ({ ...x, effective_from: e.target.value }))} /></div>
                                <div><label className="label">Threshold (UGX)</label><input className="input" type="number" value={edit.threshold_amount} onChange={e => setEdit(x => ({ ...x, threshold_amount: e.target.value }))} /></div>
                                <div><label className="label">Law / reference</label><input className="input" value={edit.legal_reference} onChange={e => setEdit(x => ({ ...x, legal_reference: e.target.value }))} /></div>
                            </div>
                            <div className="flex justify-end gap-2 mt-2">
                                <button className="btn-secondary text-sm" onClick={() => setEdit(null)}>Cancel</button>
                                <button className="btn-primary text-sm" onClick={save}>Save new rate</button>
                            </div>
                        </td></tr>
                    ) : null,
                ]))}
            </Table>
        </div>
    );
};

const SettingsTab = ({ roles }) => (
    <div className="space-y-6">
        <TaxRegistrationCard canEdit={roles.some(r => SETTINGS_EDITORS.includes(r))} />
        <AgentStatusCard canToggle={roles.some(r => AGENT_TOGGLERS.includes(r))} />
        <RatesCard canEdit={roles.some(r => PREPARERS.concat(APPROVERS).includes(r))} />
    </div>
);

// ============================================================
// A MEMBER'S OWN WITHHOLDING TAX
// ============================================================
export const MyWithholdingsCard = () => {
    const [rows, setRows] = useState(null);
    useEffect(() => { taxAPI.getMyWithholdings().then(res => setRows(res.data.data)).catch(() => setRows([])); }, []);
    if (!rows) return null;
    return (
        <div className="card">
            <h3 className="section-title mb-1">My withholding tax</h3>
            <p className="text-xs text-gray-500 mb-3">Tax kept back from dividends, interest or fees paid to you and paid to URA in your name. Each has a
                deduction certificate in Documents &gt; My Documents — keep it for your own tax return.</p>
            <Table head={['Date', 'Kind', { label: 'Gross', right: true }, { label: 'Tax', right: true }, { label: 'You received', right: true }, 'Status']} empty="No tax has been withheld from payments to you.">
                {rows.map(w => (
                    <tr key={w.id}>
                        <td className="table-cell text-sm">{formatDate(w.withholding_date)}</td>
                        <td className="table-cell text-sm">{w.payment_label}</td>
                        <td className="table-cell text-sm text-right">{w.currency_code} {money2(w.gross_amount)}</td>
                        <td className="table-cell text-sm text-right">{w.currency_code} {money2(w.tax_amount)} ({Number(w.rate)}%)</td>
                        <td className="table-cell text-sm text-right">{w.currency_code} {money2(w.net_amount)}</td>
                        <td className="table-cell"><Pill value={w.status} label={w.status === 'REMITTED' ? 'PAID TO URA' : w.status === 'PENDING' ? 'TO BE PAID TO URA' : w.status} /></td>
                    </tr>
                ))}
            </Table>
        </div>
    );
};

// ============================================================
// PAGE
// ============================================================
const TaxPage = () => {
    const { user, hasRole } = useAuth();
    const [searchParams, setSearchParams] = useSearchParams();
    const [overview, setOverview] = useState(null);
    const [error, setError] = useState(null);
    const roles = (user?.roles || []).map(r => (typeof r === 'string' ? r : r.name));
    const isStaff = hasRole(TAX_STAFF);

    const load = useCallback(() => {
        if (!isStaff) return;
        taxAPI.getOverview().then(res => setOverview(res.data.data)).catch(err => setError(getErrorMessage(err)));
    }, [isStaff]);
    useEffect(() => { load(); }, [load]);

    if (!isStaff) {
        return (
            <div>
                <PageHeader title="Tax" subtitle="Withholding tax on payments made to you" actions={<ReceiptPercentIcon className="h-8 w-8 text-white/80" />} />
                <MyWithholdingsCard />
            </div>
        );
    }
    const tabs = [
        { key: 'overview', label: 'Overview' },
        { key: 'deducted', label: 'Deducted from us' },
        { key: 'withheld', label: 'Withheld & returns', count: overview ? overview.whtPendingMonths.filter(m => m.overdue).length : 0 },
        { key: 'corporate', label: 'Corporate tax' },
        { key: 'calendar', label: 'Calendar', count: overview ? overview.upcoming.filter(u => u.overdue).length : 0 },
        { key: 'settings', label: 'Settings' },
    ];
    const active = tabs.some(t => t.key === searchParams.get('tab')) ? searchParams.get('tab') : 'overview';
    const setTab = (k) => setSearchParams(k === 'overview' ? {} : { tab: k });
    const canRecord = roles.some(r => PREPARERS.includes(r));

    if (error && !overview) return <div className="p-6"><ErrorMessage message={error} /></div>;
    if (!overview) return <LoadingSpinner fullPage text="Loading tax..." />;
    return (
        <div>
            <PageHeader title="Tax" subtitle="Withholding tax, corporate income tax, payments to URA and deadlines"
                actions={<ReceiptPercentIcon className="h-8 w-8 text-white/80" />} />
            <Tabs tabs={tabs} active={active} onChange={setTab} />
            {active === 'overview' && <OverviewTab overview={overview} onGo={setTab} />}
            {active === 'deducted' && <DeductedTab canRecord={canRecord} />}
            {active === 'withheld' && <WithheldTab canRecord={canRecord} />}
            {active === 'corporate' && <CorporateTab roles={roles} onChanged={load} />}
            {active === 'calendar' && <CalendarTab />}
            {active === 'settings' && <SettingsTab roles={roles} />}
        </div>
    );
};

export default TaxPage;
