// ============================================================
// GENERAL LEDGER PAGE (v1.55.0)
//
// The professional accounting reports suite — Trial Balance, General
// Ledger, Balance Sheet, Income Statement, and Cash Flow Statement —
// all derived on demand from the existing transactions ledger via
// glService.js on the backend. See that file's own header comment
// for the full double-entry derivation rules.
//
// Deliberately a SEPARATE page from the older ChartOfAccountsPage.jsx
// (a live snapshot of every money pool) — "GL Accounts" here refers
// to the formal Asset/Liability/Equity/Revenue/Expense classification
// layer, a different concept that happens to share a similar name.
//
// Every report supports an account filter (All Accounts = company-
// wide, or one specific Primary/Secondary/Savings account) and a
// date range or as-of date. The Ledger Accounts tab is where every
// transaction type's classification can be reviewed and, if needed,
// corrected — visible only to SYSTEM_CONFIG holders, since
// reclassifying is an accounting-policy decision.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { reportsAPI, accountsAPI } from '../../api/endpoints';
import { getErrorMessage } from '../../utils/helpers';
import PageHeader from '../../components/common/PageHeader';
import LoadingSpinner from '../../components/common/LoadingSpinner';
import ErrorMessage from '../../components/common/ErrorMessage';
import { useAuth } from '../../contexts/AuthContext';
import {
    ScaleIcon,
    BookOpenIcon,
    BuildingLibraryIcon,
    ArrowTrendingUpIcon,
    BanknotesIcon,
    Cog6ToothIcon,
    ArrowPathIcon,
    CheckCircleIcon,
    ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';

const fmt = (n) => parseFloat(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const todayStr = () => new Date().toISOString().split('T')[0];
const startOfYearStr = () => `${new Date().getFullYear()}-01-01`;

// ============================================================
// SHARED FILTER BAR — account picker + date controls, its exact
// shape depends on which report is active.
// ============================================================
const FilterBar = ({ accounts, accountId, setAccountId, mode, asOfDate, setAsOfDate, fromDate, setFromDate, toDate, setToDate, onRun, loading }) => (
    <div className="card mb-6">
        <div className="flex flex-wrap items-end gap-4">
            <div>
                <label className="label">Account</label>
                <select className="input w-56" value={accountId} onChange={e => setAccountId(e.target.value)}>
                    <option value="">All Accounts (company-wide)</option>
                    {accounts.map(a => (
                        <option key={a.id} value={a.id}>{a.name} ({a.account_type})</option>
                    ))}
                </select>
            </div>
            {mode === 'asOf' ? (
                <div>
                    <label className="label">As of date</label>
                    <input type="date" className="input" value={asOfDate} onChange={e => setAsOfDate(e.target.value)} />
                </div>
            ) : (
                <>
                    <div>
                        <label className="label">From</label>
                        <input type="date" className="input" value={fromDate} onChange={e => setFromDate(e.target.value)} />
                    </div>
                    <div>
                        <label className="label">To</label>
                        <input type="date" className="input" value={toDate} onChange={e => setToDate(e.target.value)} />
                    </div>
                </>
            )}
            <button onClick={onRun} disabled={loading} className="btn-primary flex items-center gap-2">
                {loading ? <ArrowPathIcon className="h-4 w-4 animate-spin" /> : null}
                {loading ? 'Generating...' : 'Generate'}
            </button>
        </div>
    </div>
);

const ReconciliationBadge = ({ ok, okLabel, badLabel }) => (
    <div className={`flex items-center gap-2 text-sm font-medium px-3 py-2 rounded-lg ${ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
        {ok ? <CheckCircleIcon className="h-5 w-5" /> : <ExclamationTriangleIcon className="h-5 w-5" />}
        {ok ? okLabel : badLabel}
    </div>
);

// ============================================================
// TAB: LEDGER ACCOUNTS (chart of accounts + editable mapping)
// ============================================================
const LedgerAccountsTab = () => {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [editingType, setEditingType] = useState(null);
    const [pendingAccountId, setPendingAccountId] = useState('');
    const [saving, setSaving] = useState(false);

    const load = useCallback(async () => {
        try {
            setLoading(true);
            const res = await reportsAPI.getGLAccounts();
            setData(res.data.data);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, []);
    useEffect(() => { load(); }, [load]);

    const startEdit = (m) => { setEditingType(m.inflow_type); setPendingAccountId(String(m.gl_account_id)); };

    const saveEdit = async () => {
        setSaving(true);
        setError(null);
        try {
            await reportsAPI.updateGLMapping(editingType, { gl_account_id: parseInt(pendingAccountId) });
            setEditingType(null);
            await load();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setSaving(false);
        }
    };

    if (loading) return <LoadingSpinner text="Loading chart of accounts..." />;
    if (error) return <ErrorMessage message={error} onDismiss={() => setError(null)} />;
    if (!data) return null;

    const byType = { ASSET: [], LIABILITY: [], EQUITY: [], REVENUE: [], EXPENSE: [] };
    for (const a of data.accounts) byType[a.account_type].push(a);

    return (
        <div className="space-y-6">
            <div className="card">
                <h3 className="section-title mb-1">Chart of Accounts</h3>
                <p className="text-xs text-gray-400 mb-4">
                    Every GL account these reports use, grouped by type. Codes follow the standard
                    1000s Asset / 2000s Liability / 3000s Equity / 4000s Revenue / 5000s Expense numbering.
                </p>
                {Object.entries(byType).map(([type, rows]) => rows.length > 0 && (
                    <div key={type} className="mb-4 last:mb-0">
                        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{type}</p>
                        <div className="space-y-1">
                            {rows.map(a => (
                                <div key={a.id} className="flex items-center justify-between text-sm py-1.5 border-b border-gray-50 last:border-0">
                                    <span><span className="font-mono text-xs text-gray-400 mr-2">{a.code}</span>{a.name}</span>
                                    <span className="text-xs text-gray-400">{a.statement_section}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                ))}
            </div>

            <div className="card">
                <h3 className="section-title mb-1">Transaction Classification</h3>
                <p className="text-xs text-gray-400 mb-4">
                    Which GL account each kind of transaction (its "inflow type") posts against. This is an
                    accounting-policy decision, not a technical setting — reclassifying one here changes how it
                    appears on every report above from that point forward.
                </p>
                <div className="space-y-1">
                    {data.mappings.map(m => (
                        <div key={m.inflow_type} className="flex items-center justify-between text-sm py-2 border-b border-gray-50 last:border-0">
                            <div>
                                <p className="text-gray-900">{m.inflow_type.replace(/_/g, ' ')}</p>
                                {m.notes && <p className="text-xs text-gray-400">{m.notes}</p>}
                            </div>
                            {editingType === m.inflow_type ? (
                                <div className="flex items-center gap-2">
                                    <select className="input text-sm" value={pendingAccountId} onChange={e => setPendingAccountId(e.target.value)}>
                                        {data.accounts.map(a => (
                                            <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
                                        ))}
                                    </select>
                                    <button onClick={saveEdit} disabled={saving} className="btn-primary text-xs">
                                        {saving ? 'Saving...' : 'Save'}
                                    </button>
                                    <button onClick={() => setEditingType(null)} className="btn-secondary text-xs">Cancel</button>
                                </div>
                            ) : (
                                <button onClick={() => startEdit(m)} className="text-xs text-primary-700 hover:text-primary-800 hover:underline">
                                    {m.gl_account_code} — {m.gl_account_name}
                                </button>
                            )}
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
};

// ============================================================
// TAB: TRIAL BALANCE
// ============================================================
const TrialBalanceTab = ({ accounts }) => {
    const [accountId, setAccountId] = useState('');
    const [asOfDate, setAsOfDate] = useState(todayStr());
    const [report, setReport] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    const run = async () => {
        setLoading(true); setError(null);
        try {
            const res = await reportsAPI.getTrialBalance({ account_id: accountId || undefined, as_of_date: asOfDate });
            setReport(res.data.data);
        } catch (err) { setError(getErrorMessage(err)); } finally { setLoading(false); }
    };
    useEffect(() => { run(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

    return (
        <div>
            <FilterBar accounts={accounts} accountId={accountId} setAccountId={setAccountId} mode="asOf"
                asOfDate={asOfDate} setAsOfDate={setAsOfDate} onRun={run} loading={loading} />
            {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
            {report && (
                <div className="card">
                    <div className="flex items-center justify-between mb-4">
                        <h3 className="section-title mb-0">Trial Balance as of {report.asOfDate}</h3>
                        <ReconciliationBadge ok={report.balanced} okLabel="Debits = Credits" badLabel="Out of balance — please review" />
                    </div>
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-left text-xs text-gray-400 border-b border-gray-200">
                                <th className="py-2">Code</th><th>Account</th><th>Type</th>
                                <th className="text-right">Debit</th><th className="text-right">Credit</th><th className="text-right">Balance</th>
                            </tr>
                        </thead>
                        <tbody>
                            {report.rows.map(r => (
                                <tr key={r.code} className="border-b border-gray-50 last:border-0">
                                    <td className="py-2 font-mono text-xs text-gray-400">{r.code}</td>
                                    <td>{r.name}</td>
                                    <td className="text-xs text-gray-400">{r.accountType}</td>
                                    <td className="text-right">{r.totalDebit ? fmt(r.totalDebit) : '—'}</td>
                                    <td className="text-right">{r.totalCredit ? fmt(r.totalCredit) : '—'}</td>
                                    <td className="text-right font-medium">{fmt(r.balance)}</td>
                                </tr>
                            ))}
                        </tbody>
                        <tfoot>
                            <tr className="border-t-2 border-gray-200 font-semibold">
                                <td colSpan={3} className="py-2">Totals</td>
                                <td className="text-right">{fmt(report.totalDebit)}</td>
                                <td className="text-right">{fmt(report.totalCredit)}</td>
                                <td></td>
                            </tr>
                        </tfoot>
                    </table>
                </div>
            )}
        </div>
    );
};

// ============================================================
// TAB: GENERAL LEDGER
// ============================================================
const GeneralLedgerTab = ({ accounts, glAccounts }) => {
    const [accountId, setAccountId] = useState('');
    const [glAccountId, setGlAccountId] = useState('');
    const [fromDate, setFromDate] = useState(startOfYearStr());
    const [toDate, setToDate] = useState(todayStr());
    const [report, setReport] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    const run = async () => {
        setLoading(true); setError(null);
        try {
            const res = await reportsAPI.getGeneralLedger({
                account_id: accountId || undefined, gl_account_id: glAccountId || undefined,
                from_date: fromDate, to_date: toDate,
            });
            setReport(res.data.data);
        } catch (err) { setError(getErrorMessage(err)); } finally { setLoading(false); }
    };
    useEffect(() => { run(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

    return (
        <div>
            <div className="card mb-6">
                <div className="flex flex-wrap items-end gap-4">
                    <div>
                        <label className="label">Account</label>
                        <select className="input w-56" value={accountId} onChange={e => setAccountId(e.target.value)}>
                            <option value="">All Accounts (company-wide)</option>
                            {accounts.map(a => <option key={a.id} value={a.id}>{a.name} ({a.account_type})</option>)}
                        </select>
                    </div>
                    <div>
                        <label className="label">GL Account</label>
                        <select className="input w-56" value={glAccountId} onChange={e => setGlAccountId(e.target.value)}>
                            <option value="">All GL Accounts</option>
                            {glAccounts.map(a => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
                        </select>
                    </div>
                    <div><label className="label">From</label><input type="date" className="input" value={fromDate} onChange={e => setFromDate(e.target.value)} /></div>
                    <div><label className="label">To</label><input type="date" className="input" value={toDate} onChange={e => setToDate(e.target.value)} /></div>
                    <button onClick={run} disabled={loading} className="btn-primary flex items-center gap-2">
                        {loading ? <ArrowPathIcon className="h-4 w-4 animate-spin" /> : null}
                        {loading ? 'Generating...' : 'Generate'}
                    </button>
                </div>
            </div>
            {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
            {report && report.sections.length === 0 && (
                <p className="text-sm text-gray-400 text-center py-6">No activity in this range.</p>
            )}
            {report && report.sections.map(section => (
                <div key={section.code} className="card mb-4">
                    <div className="flex items-center justify-between mb-3">
                        <h4 className="font-semibold text-gray-900">{section.code} — {section.name}</h4>
                        <span className="text-sm font-medium text-gray-700">Ending balance: {fmt(section.endingBalance)}</span>
                    </div>
                    {section.lines.length === 0 ? (
                        <p className="text-sm text-gray-400">No activity in this range.</p>
                    ) : (
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-left text-xs text-gray-400 border-b border-gray-200">
                                    <th className="py-2">Date</th><th>Description</th><th>Reference</th>
                                    <th className="text-right">Debit</th><th className="text-right">Credit</th><th className="text-right">Running Balance</th>
                                </tr>
                            </thead>
                            <tbody>
                                {section.lines.map((l, i) => (
                                    <tr key={i} className="border-b border-gray-50 last:border-0">
                                        <td className="py-2">{l.date}</td>
                                        <td>{l.description}{l.categoryTrail && <span className="text-xs text-gray-400 block">{l.categoryTrail}</span>}</td>
                                        <td className="font-mono text-xs text-gray-400">{l.referenceCode || (l.sourceType !== 'TRANSACTION' ? 'Adjusting entry' : '—')}</td>
                                        <td className="text-right">{l.debit ? fmt(l.debit) : '—'}</td>
                                        <td className="text-right">{l.credit ? fmt(l.credit) : '—'}</td>
                                        <td className="text-right font-medium">{fmt(l.runningBalance)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            ))}
        </div>
    );
};

// ============================================================
// TAB: BALANCE SHEET
// ============================================================
const BalanceSheetTab = ({ accounts }) => {
    const [accountId, setAccountId] = useState('');
    const [asOfDate, setAsOfDate] = useState(todayStr());
    const [report, setReport] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    const run = async () => {
        setLoading(true); setError(null);
        try {
            const res = await reportsAPI.getBalanceSheet({ account_id: accountId || undefined, as_of_date: asOfDate });
            setReport(res.data.data);
        } catch (err) { setError(getErrorMessage(err)); } finally { setLoading(false); }
    };
    useEffect(() => { run(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

    const Row = ({ r }) => (
        <div className="flex justify-between text-sm py-1.5 border-b border-gray-50 last:border-0">
            <span>{r.name}</span><span className="font-medium">{fmt(r.balance)}</span>
        </div>
    );

    return (
        <div>
            <FilterBar accounts={accounts} accountId={accountId} setAccountId={setAccountId} mode="asOf"
                asOfDate={asOfDate} setAsOfDate={setAsOfDate} onRun={run} loading={loading} />
            {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
            {report && (
                <div className="space-y-4">
                    <ReconciliationBadge ok={report.balanced} okLabel="Assets = Liabilities + Equity" badLabel={`Out of balance by ${fmt(report.difference)} — please review`} />
                    {!report.cashReconciliation.matches && (
                        <ReconciliationBadge ok={false} badLabel={`Ledger cash (${fmt(report.cashReconciliation.ledgerCash)}) does not match live account balances (${fmt(report.cashReconciliation.actualCash)})`} />
                    )}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div className="card">
                            <h3 className="section-title mb-3">Assets</h3>
                            {report.assets.map(r => <Row key={r.code} r={r} />)}
                            <div className="flex justify-between text-sm font-bold pt-2 mt-2 border-t border-gray-200">
                                <span>Total Assets</span><span>{fmt(report.totalAssets)}</span>
                            </div>
                        </div>
                        <div className="space-y-4">
                            <div className="card">
                                <h3 className="section-title mb-3">Liabilities</h3>
                                {report.liabilities.length === 0 ? <p className="text-sm text-gray-400">None</p> : report.liabilities.map(r => <Row key={r.code} r={r} />)}
                                <div className="flex justify-between text-sm font-bold pt-2 mt-2 border-t border-gray-200">
                                    <span>Total Liabilities</span><span>{fmt(report.totalLiabilities)}</span>
                                </div>
                            </div>
                            <div className="card">
                                <h3 className="section-title mb-3">Equity</h3>
                                {report.equity.map(r => <Row key={r.code} r={r} />)}
                                <div className="flex justify-between text-sm py-1.5 border-b border-gray-50">
                                    <span>Net Income to Date</span><span className="font-medium">{fmt(report.netIncomeToDate)}</span>
                                </div>
                                <div className="flex justify-between text-sm font-bold pt-2 mt-2 border-t border-gray-200">
                                    <span>Total Equity</span><span>{fmt(report.totalEquity)}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

// ============================================================
// TAB: INCOME STATEMENT (P&L)
// ============================================================
const IncomeStatementTab = ({ accounts }) => {
    const [accountId, setAccountId] = useState('');
    const [fromDate, setFromDate] = useState(startOfYearStr());
    const [toDate, setToDate] = useState(todayStr());
    const [report, setReport] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    const run = async () => {
        setLoading(true); setError(null);
        try {
            const res = await reportsAPI.getIncomeStatement({ account_id: accountId || undefined, from_date: fromDate, to_date: toDate });
            setReport(res.data.data);
        } catch (err) { setError(getErrorMessage(err)); } finally { setLoading(false); }
    };
    useEffect(() => { run(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

    return (
        <div>
            <FilterBar accounts={accounts} accountId={accountId} setAccountId={setAccountId} mode="range"
                fromDate={fromDate} setFromDate={setFromDate} toDate={toDate} setToDate={setToDate} onRun={run} loading={loading} />
            {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
            {report && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="card">
                        <h3 className="section-title mb-3">Revenue</h3>
                        {report.revenue.length === 0 ? <p className="text-sm text-gray-400">None this period</p> : report.revenue.map(r => (
                            <div key={r.code} className="flex justify-between text-sm py-1.5 border-b border-gray-50 last:border-0">
                                <span>{r.name}</span><span className="font-medium text-green-600">{fmt(r.amount)}</span>
                            </div>
                        ))}
                        <div className="flex justify-between text-sm font-bold pt-2 mt-2 border-t border-gray-200">
                            <span>Total Revenue</span><span>{fmt(report.totalRevenue)}</span>
                        </div>
                    </div>
                    <div className="card">
                        <h3 className="section-title mb-3">Expenses</h3>
                        {report.expenses.length === 0 ? <p className="text-sm text-gray-400">None this period</p> : report.expenses.map(r => (
                            <div key={r.code} className="flex justify-between text-sm py-1.5 border-b border-gray-50 last:border-0">
                                <span>{r.name}</span><span className="font-medium text-red-600">{fmt(r.amount)}</span>
                            </div>
                        ))}
                        <div className="flex justify-between text-sm font-bold pt-2 mt-2 border-t border-gray-200">
                            <span>Total Expenses</span><span>{fmt(report.totalExpenses)}</span>
                        </div>
                    </div>
                    <div className="card md:col-span-2">
                        <div className="flex justify-between text-lg font-bold">
                            <span>Net Income</span>
                            <span className={report.netIncome >= 0 ? 'text-green-600' : 'text-red-600'}>{fmt(report.netIncome)}</span>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

// ============================================================
// TAB: CASH FLOW STATEMENT
// ============================================================
const CashFlowTab = ({ accounts }) => {
    const [accountId, setAccountId] = useState('');
    const [fromDate, setFromDate] = useState(startOfYearStr());
    const [toDate, setToDate] = useState(todayStr());
    const [report, setReport] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    const run = async () => {
        setLoading(true); setError(null);
        try {
            const res = await reportsAPI.getCashFlowStatement({ account_id: accountId || undefined, from_date: fromDate, to_date: toDate });
            setReport(res.data.data);
        } catch (err) { setError(getErrorMessage(err)); } finally { setLoading(false); }
    };
    useEffect(() => { run(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

    return (
        <div>
            <FilterBar accounts={accounts} accountId={accountId} setAccountId={setAccountId} mode="range"
                fromDate={fromDate} setFromDate={setFromDate} toDate={toDate} setToDate={setToDate} onRun={run} loading={loading} />
            {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
            {report && (
                <div className="space-y-4">
                    <ReconciliationBadge ok={report.reconciles}
                        okLabel="Net cash change reconciles with the ledger's own cash balances"
                        badLabel={`Reconciliation gap: expected ${fmt(report.expectedChange)}, computed ${fmt(report.netChangeInCash)}`} />
                    <div className="card">
                        <div className="flex justify-between text-sm py-2 border-b border-gray-100">
                            <span>Operating Activities</span><span className="font-medium">{fmt(report.operatingNet)}</span>
                        </div>
                        <div className="flex justify-between text-sm py-2 border-b border-gray-100">
                            <span>Investing Activities</span><span className="font-medium">{fmt(report.investingNet)}</span>
                        </div>
                        <div className="flex justify-between text-sm py-2 border-b border-gray-100">
                            <span>Financing Activities</span><span className="font-medium">{fmt(report.financingNet)}</span>
                        </div>
                        <div className="flex justify-between text-sm font-bold pt-2 mt-2 border-t border-gray-200">
                            <span>Net Change in Cash</span><span>{fmt(report.netChangeInCash)}</span>
                        </div>
                        <p className="text-xs text-gray-400 mt-4">
                            Opening cash {fmt(report.openingCash)} → Closing cash {fmt(report.closingCash)}.
                            Internal transfers between the club's own accounts ({fmt(report.internalTransfersNet)}) are excluded above,
                            since they don't change the club's total cash position.
                        </p>
                    </div>
                </div>
            )}
        </div>
    );
};

// ============================================================
// MAIN PAGE
// ============================================================
const TABS = [
    { key: 'trial-balance',  label: 'Trial Balance',       icon: ScaleIcon },
    { key: 'general-ledger', label: 'General Ledger',      icon: BookOpenIcon },
    { key: 'balance-sheet',  label: 'Balance Sheet',        icon: BuildingLibraryIcon },
    { key: 'income-statement', label: 'Income Statement',  icon: ArrowTrendingUpIcon },
    { key: 'cash-flow',      label: 'Cash Flow Statement', icon: BanknotesIcon },
    { key: 'ledger-accounts', label: 'Ledger Accounts',    icon: Cog6ToothIcon, adminOnly: true },
];

const GeneralLedgerPage = () => {
    const { hasPermission } = useAuth();
    const [activeTab, setActiveTab] = useState('trial-balance');
    const [accounts, setAccounts] = useState([]);
    const [glAccounts, setGlAccounts] = useState([]);

    useEffect(() => {
        accountsAPI.getAll().then(res => setAccounts(res.data.data || [])).catch(() => {});
        reportsAPI.getGLAccounts().then(res => setGlAccounts(res.data.data?.accounts || [])).catch(() => {});
    }, []);

    const visibleTabs = TABS.filter(t => !t.adminOnly || hasPermission('SYSTEM_CONFIG'));

    return (
        <div>
            <PageHeader
                title="Financial Statements"
                subtitle="Trial Balance, General Ledger, Balance Sheet, Income Statement, and Cash Flow Statement — generated on demand"
                showBack backTo="/reports"
            />

            <div className="flex flex-wrap gap-2 mb-6 border-b border-gray-200">
                {visibleTabs.map(t => (
                    <button
                        key={t.key}
                        onClick={() => setActiveTab(t.key)}
                        className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                            activeTab === t.key
                                ? 'border-primary-600 text-primary-700'
                                : 'border-transparent text-gray-500 hover:text-gray-700'
                        }`}
                    >
                        <t.icon className="h-4 w-4" />
                        {t.label}
                    </button>
                ))}
            </div>

            {activeTab === 'trial-balance' && <TrialBalanceTab accounts={accounts} />}
            {activeTab === 'general-ledger' && <GeneralLedgerTab accounts={accounts} glAccounts={glAccounts} />}
            {activeTab === 'balance-sheet' && <BalanceSheetTab accounts={accounts} />}
            {activeTab === 'income-statement' && <IncomeStatementTab accounts={accounts} />}
            {activeTab === 'cash-flow' && <CashFlowTab accounts={accounts} />}
            {activeTab === 'ledger-accounts' && hasPermission('SYSTEM_CONFIG') && <LedgerAccountsTab />}
        </div>
    );
};

export default GeneralLedgerPage;
