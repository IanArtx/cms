// ============================================================
// GENERAL LEDGER PAGE (v1.55.0; currency-aware since v1.64.0;
// UGX-consolidated with FX revaluation since v1.66.0)
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
//
// BASIS (v1.66.0) — a switch at the top of every report:
//   - "Official — consolidated in UGX" (the default): ONE set of
//     statements in the company's functional currency, every foreign-
//     currency amount valued at the rate on its own date, and
//     foreign-currency balances revalued to the month-end closing rate
//     (FX gains/losses). This is the set the law and an auditor expect.
//   - "By original currency": the v1.64.0 view, one block per
//     currency, never converted — kept as a supporting schedule.
// In the official view, "Show in EUR" re-expresses every figure at the
// report date's rate — a CONVENIENCE TRANSLATION for shareholders,
// labelled as such; the UGX figures remain the legal ones.
//
// The "FX & Revaluation" tab is where months are closed (revalued),
// reopened if something inside them had to change, and where any
// transaction still missing an exchange rate is listed and fixed.
// ============================================================

import { useState, useEffect, useCallback, Fragment } from 'react';
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
    GlobeAltIcon,
    InformationCircleIcon,
} from '@heroicons/react/24/outline';
import { useTabParam } from '../../hooks/useTabParam'; // v1.71.0 — tab kept in the address

const fmt = (n) => parseFloat(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtRate = (n) => (n === null || n === undefined ? '—' : parseFloat(n).toLocaleString('en-US', { maximumFractionDigits: 6 }));
const todayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
// Start of the financial year (1 July by default — the backend's
// company_settings.fiscal_year_start_month overrides this once the
// FX status has loaded).
const fiscalYearStartStr = (startMonth = 7) => {
    const d = new Date();
    const y = d.getMonth() + 1 >= startMonth ? d.getFullYear() : d.getFullYear() - 1;
    return `${y}-${String(startMonth).padStart(2, '0')}-01`;
};

const BASIS_OPTIONS = [
    { value: 'FUNCTIONAL', label: 'Official — consolidated in UGX' },
    { value: 'CURRENCY',   label: 'By original currency' },
];

// ============================================================
// DISPLAY HELPER — every money figure on the page goes through this,
// so the EUR convenience translation is applied consistently.
// ============================================================
const makeDisplay = (meta, showPresentation) => {
    const pres = meta && meta.presentation;
    const active = !!(showPresentation && meta && meta.basis === 'FUNCTIONAL' && pres && pres.rate);
    return {
        active,
        money: (n) => fmt(active ? parseFloat(n || 0) * pres.rate : n),
        code: (fallback) => (active ? pres.currencyCode : fallback),
        symbol: (fallback) => (active ? pres.currencySymbol : fallback),
        note: active
            ? `Convenience translation into ${pres.currencyCode} at 1 ${pres.currencyCode} = ${fmtRate(1 / pres.rate)} ${meta.functionalCurrency.code} (rate on ${pres.rateDate}). The ${meta.functionalCurrency.code} figures are the official ones.`
            : null,
    };
};

// ============================================================
// SHARED FILTER BAR — account picker + date controls + basis, its
// exact shape depends on which report is active.
// ============================================================
const FilterBar = ({
    accounts, accountId, setAccountId, mode, asOfDate, setAsOfDate, fromDate, setFromDate, toDate, setToDate,
    onRun, loading, basis, setBasis, showPresentation, setShowPresentation, presentationCode, extra = null,
}) => (
    <div className="card mb-6">
        <div className="flex flex-wrap items-end gap-4">
            <div>
                <label className="label">Basis</label>
                <select className="input w-64" value={basis} onChange={e => setBasis(e.target.value)}>
                    {BASIS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
            </div>
            <div>
                <label className="label">Account</label>
                <select className="input w-56" value={accountId} onChange={e => setAccountId(e.target.value)}>
                    <option value="">All Accounts (company-wide)</option>
                    {accounts.map(a => (
                        <option key={a.id} value={a.id}>{a.name} ({a.account_type})</option>
                    ))}
                </select>
            </div>
            {extra}
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
            {basis === 'FUNCTIONAL' && presentationCode && (
                <label className="flex items-center gap-2 text-sm text-gray-700 pb-2">
                    <input type="checkbox" checked={showPresentation} onChange={e => setShowPresentation(e.target.checked)} />
                    Show in {presentationCode}
                </label>
            )}
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
// BASIS NOTICES (v1.66.0) — what the reader must know about the
// figures below: transactions left out for want of a rate, a
// provisional (not yet closed) revaluation, the EUR translation.
// ============================================================
const BasisNotices = ({ meta, display }) => {
    if (!meta || meta.basis !== 'FUNCTIONAL') {
        return (
            <div className="flex items-start gap-2 text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-2 mb-4">
                <InformationCircleIcon className="h-4 w-4 flex-shrink-0 mt-0.5" />
                Supporting view: each currency is shown on its own and never converted. The official statements are the
                "Official — consolidated in UGX" basis.
            </div>
        );
    }
    const rv = meta.revaluation || {};
    return (
        <div className="space-y-2 mb-4">
            {meta.unconvertedCount > 0 && (
                <div className="flex items-start gap-2 text-sm bg-red-50 text-red-700 rounded-lg px-3 py-2">
                    <ExclamationTriangleIcon className="h-5 w-5 flex-shrink-0" />
                    <span>
                        <strong>{meta.unconvertedCount} transaction(s) are left out</strong> because no exchange rate covers
                        their date, so these figures are incomplete. Enter the missing rate(s) in Settings &gt; Exchange Rates,
                        or see the FX &amp; Revaluation tab.
                    </span>
                </div>
            )}
            {rv.missingRateCurrencies && rv.missingRateCurrencies.length > 0 && (
                <div className="flex items-start gap-2 text-sm bg-red-50 text-red-700 rounded-lg px-3 py-2">
                    <ExclamationTriangleIcon className="h-5 w-5 flex-shrink-0" />
                    <span>No closing rate on file for {rv.missingRateCurrencies.join(', ')} on the report date — those balances are not revalued.</span>
                </div>
            )}
            {rv.provisionalAt && (
                <div className="flex items-start gap-2 text-xs bg-amber-50 text-amber-800 rounded-lg px-3 py-2">
                    <InformationCircleIcon className="h-4 w-4 flex-shrink-0 mt-0.5" />
                    <span>
                        Foreign-currency balances are revalued <strong>provisionally</strong> to {rv.provisionalAt}
                        {rv.lastPeriodEnd ? ` (months are closed through ${rv.lastPeriodEnd})` : ' (no month has been closed yet)'}.
                        Close months on the FX &amp; Revaluation tab to make them final.
                    </span>
                </div>
            )}
            {display.note && (
                <div className="flex items-start gap-2 text-xs bg-blue-50 text-blue-800 rounded-lg px-3 py-2">
                    <GlobeAltIcon className="h-4 w-4 flex-shrink-0 mt-0.5" />
                    <span>{display.note}</span>
                </div>
            )}
        </div>
    );
};

// ============================================================
// CURRENCY SECTION HEADING — labels each block so it's never
// mistaken for a different basis.
// ============================================================
// Symbol + code, without repeating it when the symbol IS the code (e.g. "UGX UGX").
const currencyLabel = (symbol, code) => (symbol && symbol !== code ? `${symbol} ${code || ''}` : (code || symbol || 'Unknown currency'));

const CurrencyHeading = ({ code, symbol, basis, display }) => (
    <div className="flex items-center gap-2 mt-2 mb-3 first:mt-0">
        <span className="text-xs font-semibold uppercase tracking-wide text-primary-700 bg-primary-50 px-2 py-1 rounded">
            {display && display.active
                ? `${currencyLabel(display.symbol(symbol), display.code(code))} — convenience translation`
                : `${currencyLabel(symbol, code)}${basis === 'FUNCTIONAL' ? ' — official, consolidated' : ''}`}
        </span>
    </div>
);

// Shared report-tab state: basis + EUR toggle, re-running when basis changes.
const useReportState = (runFn) => {
    const [basis, setBasis] = useState('FUNCTIONAL');
    const [showPresentation, setShowPresentation] = useState(false);
    const [report, setReport] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    const run = async (basisOverride) => {
        setLoading(true); setError(null);
        try {
            const res = await runFn(basisOverride || basis);
            setReport(res.data.data);
        } catch (err) { setError(getErrorMessage(err)); } finally { setLoading(false); }
    };
    const changeBasis = (b) => { setBasis(b); run(b); };
    return { basis, setBasis: changeBasis, showPresentation, setShowPresentation, report, loading, error, setError, run };
};

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
                    "Monetary" accounts hold an amount of currency and are revalued each month end when held in a foreign currency.
                </p>
                {Object.entries(byType).map(([type, rows]) => rows.length > 0 && (
                    <div key={type} className="mb-4 last:mb-0">
                        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{type}</p>
                        <div className="space-y-1">
                            {rows.map(a => (
                                <div key={a.id} className={`flex items-center justify-between text-sm py-1.5 border-b border-gray-50 last:border-0 ${a.is_active ? '' : 'opacity-50'}`}>
                                    <span>
                                        <span className="font-mono text-xs text-gray-400 mr-2">{a.code}</span>{a.name}
                                        {a.is_monetary && <span className="ml-2 text-xs text-primary-700 bg-primary-50 px-1.5 py-0.5 rounded">monetary</span>}
                                        {!a.is_active && <span className="ml-2 text-xs text-gray-500">(inactive)</span>}
                                    </span>
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
    const st = useReportState((basis) => reportsAPI.getTrialBalance({ account_id: accountId || undefined, as_of_date: asOfDate, basis }));
    useEffect(() => { st.run(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
    const { report } = st;
    const display = makeDisplay(report && report.meta, st.showPresentation);

    return (
        <div>
            <FilterBar accounts={accounts} accountId={accountId} setAccountId={setAccountId} mode="asOf"
                asOfDate={asOfDate} setAsOfDate={setAsOfDate} onRun={() => st.run()} loading={st.loading}
                basis={st.basis} setBasis={st.setBasis} showPresentation={st.showPresentation} setShowPresentation={st.setShowPresentation}
                presentationCode={report && report.meta && report.meta.presentation && report.meta.presentation.currencyCode} />
            {st.error && <ErrorMessage message={st.error} onDismiss={() => st.setError(null)} />}
            {report && <BasisNotices meta={report.meta} display={display} />}
            {report && report.byCurrency.length === 0 && (
                <p className="text-sm text-gray-400 text-center py-6">No activity as of this date.</p>
            )}
            {report && report.byCurrency.map(cb => (
                <div key={cb.currencyCode || 'unknown'} className="card mb-4">
                    <CurrencyHeading code={cb.currencyCode} symbol={cb.currencySymbol} basis={report.basis} display={display} />
                    <div className="flex items-center justify-between mb-4">
                        <h3 className="section-title mb-0">Trial Balance as of {report.asOfDate}</h3>
                        <ReconciliationBadge ok={cb.balanced} okLabel="Debits = Credits" badLabel="Out of balance — please review" />
                    </div>
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-left text-xs text-gray-400 border-b border-gray-200">
                                <th className="py-2">Code</th><th>Account</th><th>Type</th>
                                <th className="text-right">Debit</th><th className="text-right">Credit</th><th className="text-right">Balance</th>
                            </tr>
                        </thead>
                        <tbody>
                            {cb.rows.map(r => (
                                <tr key={r.code} className="border-b border-gray-50 last:border-0">
                                    <td className="py-2 font-mono text-xs text-gray-400">{r.code}</td>
                                    <td>{r.name}</td>
                                    <td className="text-xs text-gray-400">{r.accountType}</td>
                                    <td className="text-right">{r.totalDebit ? display.money(r.totalDebit) : '—'}</td>
                                    <td className="text-right">{r.totalCredit ? display.money(r.totalCredit) : '—'}</td>
                                    <td className="text-right font-medium">{display.money(r.balance)}</td>
                                </tr>
                            ))}
                        </tbody>
                        <tfoot>
                            <tr className="border-t-2 border-gray-200 font-semibold">
                                <td colSpan={3} className="py-2">Totals</td>
                                <td className="text-right">{display.money(cb.totalDebit)}</td>
                                <td className="text-right">{display.money(cb.totalCredit)}</td>
                                <td></td>
                            </tr>
                        </tfoot>
                    </table>
                </div>
            ))}
        </div>
    );
};

// ============================================================
// TAB: GENERAL LEDGER
// ============================================================
const sourceLabel = (l) => {
    if (l.referenceCode) return l.referenceCode;
    if (l.sourceType === 'FX_REVALUATION') return 'FX revaluation';
    if (l.sourceType === 'FX_REVALUATION_PROVISIONAL') return 'FX revaluation (provisional)';
    if (l.sourceType !== 'TRANSACTION') return 'Adjusting entry';
    return '—';
};

const GeneralLedgerTab = ({ accounts, glAccounts, fyStart }) => {
    const [accountId, setAccountId] = useState('');
    const [glAccountId, setGlAccountId] = useState('');
    const [fromDate, setFromDate] = useState(fyStart);
    const [toDate, setToDate] = useState(todayStr());
    const st = useReportState((basis) => reportsAPI.getGeneralLedger({
        account_id: accountId || undefined, gl_account_id: glAccountId || undefined,
        from_date: fromDate, to_date: toDate, basis,
    }));
    useEffect(() => { st.run(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
    const { report } = st;
    const display = makeDisplay(report && report.meta, st.showPresentation);
    const isFunctional = report && report.basis === 'FUNCTIONAL';

    const glPicker = (
        <div>
            <label className="label">GL Account</label>
            <select className="input w-56" value={glAccountId} onChange={e => setGlAccountId(e.target.value)}>
                <option value="">All GL Accounts</option>
                {glAccounts.map(a => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
            </select>
        </div>
    );

    return (
        <div>
            <FilterBar accounts={accounts} accountId={accountId} setAccountId={setAccountId} mode="range"
                fromDate={fromDate} setFromDate={setFromDate} toDate={toDate} setToDate={setToDate}
                onRun={() => st.run()} loading={st.loading} extra={glPicker}
                basis={st.basis} setBasis={st.setBasis} showPresentation={st.showPresentation} setShowPresentation={st.setShowPresentation}
                presentationCode={report && report.meta && report.meta.presentation && report.meta.presentation.currencyCode} />
            {st.error && <ErrorMessage message={st.error} onDismiss={() => st.setError(null)} />}
            {report && <BasisNotices meta={report.meta} display={display} />}
            {report && report.byCurrency.every(cb => cb.sections.length === 0) && (
                <p className="text-sm text-gray-400 text-center py-6">No activity in this range.</p>
            )}
            {report && report.byCurrency.map(cb => (
                <div key={cb.currencyCode || 'unknown'} className="mb-6">
                    <CurrencyHeading code={cb.currencyCode} symbol={cb.currencySymbol} basis={report.basis} display={display} />
                    {cb.sections.length === 0 && (
                        <p className="text-sm text-gray-400 py-2">No activity in this range.</p>
                    )}
                    {cb.sections.map(section => (
                        <div key={section.code} className="card mb-4">
                            <div className="flex items-center justify-between mb-3">
                                <h4 className="font-semibold text-gray-900">{section.code} — {section.name}</h4>
                                <span className="text-sm font-medium text-gray-700">Ending balance: {display.money(section.endingBalance)}</span>
                            </div>
                            {section.openingBalance !== undefined && section.openingBalance !== 0 && (
                                <p className="text-xs text-gray-500 mb-2">Balance brought forward at {report.fromDate}: {display.money(section.openingBalance)}</p>
                            )}
                            {section.lines.length === 0 ? (
                                <p className="text-sm text-gray-400">No activity in this range.</p>
                            ) : (
                                <table className="w-full text-sm">
                                    <thead>
                                        <tr className="text-left text-xs text-gray-400 border-b border-gray-200">
                                            <th className="py-2">Date</th><th>Description</th><th>Reference</th>
                                            {isFunctional && <th className="text-right">Original</th>}
                                            <th className="text-right">Debit</th><th className="text-right">Credit</th><th className="text-right">Running Balance</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {section.lines.map((l, i) => (
                                            <tr key={i} className={`border-b border-gray-50 last:border-0 ${l.sourceType === 'FX_REVALUATION_PROVISIONAL' ? 'bg-amber-50/40' : ''}`}>
                                                <td className="py-2">{l.date}</td>
                                                <td>{l.description}{l.categoryTrail && <span className="text-xs text-gray-400 block">{l.categoryTrail}</span>}</td>
                                                <td className="font-mono text-xs text-gray-400">{sourceLabel(l)}</td>
                                                {isFunctional && (
                                                    <td className="text-right text-xs text-gray-500 whitespace-nowrap">
                                                        {l.original
                                                            ? (l.original.amount !== null
                                                                ? `${l.original.currencyCode} ${fmt(l.original.amount)} @ ${fmtRate(l.original.rate)}`
                                                                : `${l.original.currencyCode} @ ${fmtRate(l.original.rate)}`)
                                                            : ''}
                                                    </td>
                                                )}
                                                <td className="text-right">{l.debit ? display.money(l.debit) : '—'}</td>
                                                <td className="text-right">{l.credit ? display.money(l.credit) : '—'}</td>
                                                <td className="text-right font-medium">{display.money(l.runningBalance)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )}
                        </div>
                    ))}
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
    const st = useReportState((basis) => reportsAPI.getBalanceSheet({ account_id: accountId || undefined, as_of_date: asOfDate, basis }));
    useEffect(() => { st.run(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
    const { report } = st;
    const display = makeDisplay(report && report.meta, st.showPresentation);

    const Row = ({ r }) => (
        <div className="flex justify-between text-sm py-1.5 border-b border-gray-50 last:border-0">
            <span>{r.name}</span><span className="font-medium">{display.money(r.balance)}</span>
        </div>
    );

    return (
        <div>
            <FilterBar accounts={accounts} accountId={accountId} setAccountId={setAccountId} mode="asOf"
                asOfDate={asOfDate} setAsOfDate={setAsOfDate} onRun={() => st.run()} loading={st.loading}
                basis={st.basis} setBasis={st.setBasis} showPresentation={st.showPresentation} setShowPresentation={st.setShowPresentation}
                presentationCode={report && report.meta && report.meta.presentation && report.meta.presentation.currencyCode} />
            {st.error && <ErrorMessage message={st.error} onDismiss={() => st.setError(null)} />}
            {report && <BasisNotices meta={report.meta} display={display} />}
            {report && report.byCurrency.length === 0 && (
                <p className="text-sm text-gray-400 text-center py-6">No activity as of this date.</p>
            )}
            {report && report.byCurrency.map(cb => (
                <div key={cb.currencyCode || 'unknown'} className="space-y-4 mb-8">
                    <CurrencyHeading code={cb.currencyCode} symbol={cb.currencySymbol} basis={report.basis} display={display} />
                    <ReconciliationBadge ok={cb.balanced} okLabel="Assets = Liabilities + Equity" badLabel={`Out of balance by ${display.money(cb.difference)} — please review`} />
                    {cb.cashReconciliation.matches === false && (
                        <ReconciliationBadge ok={false} badLabel={`Ledger cash (${display.money(cb.cashReconciliation.ledgerCash)}) does not match live account balances (${display.money(cb.cashReconciliation.actualCash)})${report.asOfDate !== todayStr() ? ' — live balances are as of today, so this check only applies to a balance sheet dated today' : ''}`} />
                    )}
                    {cb.cashReconciliation.matches === null && (
                        <ReconciliationBadge ok={false} badLabel="Live account balances could not be converted to compare — an exchange rate is missing for the report date" />
                    )}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div className="card">
                            <h3 className="section-title mb-3">Assets</h3>
                            {cb.assets.map(r => <Row key={r.code} r={r} />)}
                            <div className="flex justify-between text-sm font-bold pt-2 mt-2 border-t border-gray-200">
                                <span>Total Assets</span><span>{display.money(cb.totalAssets)}</span>
                            </div>
                        </div>
                        <div className="space-y-4">
                            <div className="card">
                                <h3 className="section-title mb-3">Liabilities</h3>
                                {cb.liabilities.length === 0 ? <p className="text-sm text-gray-400">None</p> : cb.liabilities.map(r => <Row key={r.code} r={r} />)}
                                <div className="flex justify-between text-sm font-bold pt-2 mt-2 border-t border-gray-200">
                                    <span>Total Liabilities</span><span>{display.money(cb.totalLiabilities)}</span>
                                </div>
                            </div>
                            <div className="card">
                                <h3 className="section-title mb-3">Equity</h3>
                                {cb.equity.map(r => <Row key={r.code} r={r} />)}
                                <div className="flex justify-between text-sm py-1.5 border-b border-gray-50">
                                    <span>Net Income to Date</span><span className="font-medium">{display.money(cb.netIncomeToDate)}</span>
                                </div>
                                <div className="flex justify-between text-sm font-bold pt-2 mt-2 border-t border-gray-200">
                                    <span>Total Equity</span><span>{display.money(cb.totalEquity)}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            ))}
        </div>
    );
};

// ============================================================
// TAB: INCOME STATEMENT (P&L)
// v1.68.0 — FX gains and losses appear as ONE net line (see
// glService.computeIncomeStatement); the gross figures behind it are
// shown underneath so nothing is hidden.
// ============================================================
const FxDetailNote = ({ detail, display }) => (detail ? (
    <p className="text-xs text-gray-400 mt-0.5">
        FX gains {display.money(detail.gains)} less FX losses {display.money(detail.losses)} — revaluation of foreign-currency
        balances; gains and losses on the two sides of the same transaction (e.g. a EUR loan and the EUR cash that repaid it) offset here.
    </p>
) : null);

const IncomeStatementTab = ({ accounts, fyStart }) => {
    const [accountId, setAccountId] = useState('');
    const [fromDate, setFromDate] = useState(fyStart);
    const [toDate, setToDate] = useState(todayStr());
    const st = useReportState((basis) => reportsAPI.getIncomeStatement({ account_id: accountId || undefined, from_date: fromDate, to_date: toDate, basis }));
    useEffect(() => { st.run(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
    const { report } = st;
    const display = makeDisplay(report && report.meta, st.showPresentation);

    return (
        <div>
            <FilterBar accounts={accounts} accountId={accountId} setAccountId={setAccountId} mode="range"
                fromDate={fromDate} setFromDate={setFromDate} toDate={toDate} setToDate={setToDate} onRun={() => st.run()} loading={st.loading}
                basis={st.basis} setBasis={st.setBasis} showPresentation={st.showPresentation} setShowPresentation={st.setShowPresentation}
                presentationCode={report && report.meta && report.meta.presentation && report.meta.presentation.currencyCode} />
            {st.error && <ErrorMessage message={st.error} onDismiss={() => st.setError(null)} />}
            {report && <BasisNotices meta={report.meta} display={display} />}
            {report && report.byCurrency.length === 0 && (
                <p className="text-sm text-gray-400 text-center py-6">No activity in this range.</p>
            )}
            {report && report.byCurrency.map(cb => (
                <div key={cb.currencyCode || 'unknown'} className="mb-6">
                    <CurrencyHeading code={cb.currencyCode} symbol={cb.currencySymbol} basis={report.basis} display={display} />
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div className="card">
                            <h3 className="section-title mb-3">Revenue</h3>
                            {cb.revenue.length === 0 ? <p className="text-sm text-gray-400">None this period</p> : cb.revenue.map(r => (
                                <div key={r.code} className="py-1.5 border-b border-gray-50 last:border-0">
                                    <div className="flex justify-between text-sm">
                                        <span>{r.name}</span><span className="font-medium text-green-600">{display.money(r.amount)}</span>
                                    </div>
                                    {r.isNetFx && <FxDetailNote detail={cb.fxDetail} display={display} />}
                                </div>
                            ))}
                            <div className="flex justify-between text-sm font-bold pt-2 mt-2 border-t border-gray-200">
                                <span>Total Revenue</span><span>{display.money(cb.totalRevenue)}</span>
                            </div>
                        </div>
                        <div className="card">
                            <h3 className="section-title mb-3">Expenses</h3>
                            {cb.expenses.length === 0 ? <p className="text-sm text-gray-400">None this period</p> : cb.expenses.map(r => (
                                <div key={r.code} className="py-1.5 border-b border-gray-50 last:border-0">
                                    <div className="flex justify-between text-sm">
                                        <span>{r.name}</span><span className="font-medium text-red-600">{display.money(r.amount)}</span>
                                    </div>
                                    {r.isNetFx && <FxDetailNote detail={cb.fxDetail} display={display} />}
                                </div>
                            ))}
                            <div className="flex justify-between text-sm font-bold pt-2 mt-2 border-t border-gray-200">
                                <span>Total Expenses</span><span>{display.money(cb.totalExpenses)}</span>
                            </div>
                        </div>
                        {/* v1.70.0 — income tax is shown below profit before tax:
                            final tax deducted at source (5700) and the
                            corporate income tax of approved tax years (5710). */}
                        <div className="card md:col-span-2 space-y-2">
                            {cb.profitBeforeTax !== undefined && (
                                <>
                                    <div className="flex justify-between text-base font-semibold">
                                        <span>Profit / (Loss) Before Tax</span>
                                        <span className={cb.profitBeforeTax >= 0 ? 'text-green-600' : 'text-red-600'}>{display.money(cb.profitBeforeTax)}</span>
                                    </div>
                                    {(cb.incomeTax || []).length === 0 ? (
                                        <div className="flex justify-between text-sm text-gray-400">
                                            <span>Income tax</span><span>None booked for this period</span>
                                        </div>
                                    ) : cb.incomeTax.map(r => (
                                        <div key={r.code} className="flex justify-between text-sm">
                                            <span>Less: {r.name}</span><span className="text-red-600">({display.money(r.amount)})</span>
                                        </div>
                                    ))}
                                    <p className="text-xs text-gray-400">
                                        Corporate income tax appears here once the year's tax computation is approved (Tax page); final tax deducted at source
                                        (government securities) as it is deducted.
                                    </p>
                                </>
                            )}
                            <div className="flex justify-between text-lg font-bold pt-2 border-t border-gray-200">
                                <span>{cb.profitBeforeTax !== undefined ? 'Profit / (Loss) After Tax' : 'Net Income'}</span>
                                <span className={cb.netIncome >= 0 ? 'text-green-600' : 'text-red-600'}>{display.money(cb.netIncome)}</span>
                            </div>
                        </div>
                    </div>
                </div>
            ))}
        </div>
    );
};

// ============================================================
// TAB: CASH FLOW STATEMENT
// ============================================================
const CashFlowTab = ({ accounts, fyStart }) => {
    const [accountId, setAccountId] = useState('');
    const [fromDate, setFromDate] = useState(fyStart);
    const [toDate, setToDate] = useState(todayStr());
    const st = useReportState((basis) => reportsAPI.getCashFlowStatement({ account_id: accountId || undefined, from_date: fromDate, to_date: toDate, basis }));
    useEffect(() => { st.run(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
    const { report } = st;
    const display = makeDisplay(report && report.meta, st.showPresentation);
    const isFunctional = report && report.basis === 'FUNCTIONAL';

    return (
        <div>
            <FilterBar accounts={accounts} accountId={accountId} setAccountId={setAccountId} mode="range"
                fromDate={fromDate} setFromDate={setFromDate} toDate={toDate} setToDate={setToDate} onRun={() => st.run()} loading={st.loading}
                basis={st.basis} setBasis={st.setBasis} showPresentation={st.showPresentation} setShowPresentation={st.setShowPresentation}
                presentationCode={report && report.meta && report.meta.presentation && report.meta.presentation.currencyCode} />
            {st.error && <ErrorMessage message={st.error} onDismiss={() => st.setError(null)} />}
            {report && <BasisNotices meta={report.meta} display={display} />}
            {report && report.byCurrency.length === 0 && (
                <p className="text-sm text-gray-400 text-center py-6">No activity in this range.</p>
            )}
            {report && report.byCurrency.map(cb => (
                <div key={cb.currencyCode || 'unknown'} className="space-y-4 mb-6">
                    <CurrencyHeading code={cb.currencyCode} symbol={cb.currencySymbol} basis={report.basis} display={display} />
                    <ReconciliationBadge ok={cb.reconciles}
                        okLabel="Net cash change reconciles with the ledger's own cash balances"
                        badLabel={`Reconciliation gap: expected ${display.money(cb.expectedChange)}, computed ${display.money(cb.netChangeInCash + (cb.fxEffectOnCash || 0))}`} />
                    <div className="card">
                        <div className="flex justify-between text-sm py-2 border-b border-gray-100">
                            <span>Operating Activities</span><span className="font-medium">{display.money(cb.operatingNet)}</span>
                        </div>
                        <div className="flex justify-between text-sm py-2 border-b border-gray-100">
                            <span>Investing Activities</span><span className="font-medium">{display.money(cb.investingNet)}</span>
                        </div>
                        <div className="flex justify-between text-sm py-2 border-b border-gray-100">
                            <span>Financing Activities</span><span className="font-medium">{display.money(cb.financingNet)}</span>
                        </div>
                        <div className="flex justify-between text-sm font-bold pt-2 mt-2 border-t border-gray-200">
                            <span>Net Change in Cash</span><span>{display.money(cb.netChangeInCash)}</span>
                        </div>
                        {isFunctional && (
                            <div className="flex justify-between text-sm py-2 border-b border-gray-100">
                                <span>Effect of exchange-rate changes on cash held in foreign currency</span>
                                <span className="font-medium">{display.money(cb.fxEffectOnCash)}</span>
                            </div>
                        )}
                        <p className="text-xs text-gray-400 mt-4">
                            Opening cash {display.money(cb.openingCash)} → Closing cash {display.money(cb.closingCash)}.
                            Internal transfers between the club's own accounts ({display.money(cb.internalTransfersNet)}) are excluded above,
                            since they don't change the club's total cash position.
                        </p>
                    </div>
                </div>
            ))}
        </div>
    );
};

// ============================================================
// TAB: FX & REVALUATION (v1.66.0)
// ============================================================
const lastMonthEndStr = () => {
    const d = new Date();
    const last = new Date(d.getFullYear(), d.getMonth(), 0); // day 0 = last day of previous month
    return `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`;
};

const FxRevaluationTab = ({ onStatusChange }) => {
    const { hasPermission } = useAuth();
    const canClose = hasPermission('FINANCE_TRANSACTION_APPROVE');
    const canConfigure = hasPermission('SYSTEM_CONFIG');

    const [status, setStatus] = useState(null);
    const [runs, setRuns] = useState([]);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [message, setMessage] = useState(null);
    const [throughDate, setThroughDate] = useState(lastMonthEndStr());
    const [expandedRun, setExpandedRun] = useState(null);
    const [rateEdit, setRateEdit] = useState(null); // { id, rate, note }

    const load = useCallback(async () => {
        try {
            setLoading(true);
            const [s, r] = await Promise.all([reportsAPI.getFxStatus(), reportsAPI.getFxRevaluations()]);
            setStatus(s.data.data);
            setRuns(r.data.data || []);
            if (onStatusChange) onStatusChange(s.data.data);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, [onStatusChange]);
    useEffect(() => { load(); }, [load]);

    const act = async (fn) => {
        setBusy(true); setError(null); setMessage(null);
        try {
            const res = await fn();
            setMessage(res.data.message);
            await load();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setBusy(false);
        }
    };

    if (loading && !status) return <LoadingSpinner text="Loading FX status..." />;
    if (!status) return error ? <ErrorMessage message={error} onDismiss={() => setError(null)} /> : null;

    const fc = status.functionalCurrency ? status.functionalCurrency.code : '—';

    return (
        <div className="space-y-6">
            {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
            {message && (
                <div className="flex items-start gap-2 text-sm bg-green-50 text-green-700 rounded-lg px-3 py-2">
                    <CheckCircleIcon className="h-5 w-5 flex-shrink-0" /><span>{message}</span>
                </div>
            )}

            <div className="card">
                <h3 className="section-title mb-3">How foreign currency is handled</h3>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4 text-sm">
                    <div><p className="text-xs text-gray-400">Books kept in (functional currency)</p><p className="font-semibold">{fc}</p></div>
                    <div><p className="text-xs text-gray-400">Also shown in (presentation)</p><p className="font-semibold">{status.presentationCurrency ? status.presentationCurrency.code : '—'}</p></div>
                    <div><p className="text-xs text-gray-400">Current financial year started</p><p className="font-semibold">{status.currentFiscalYearStart}</p></div>
                    <div><p className="text-xs text-gray-400">Months closed (revalued) through</p><p className="font-semibold">{status.lastRevaluedPeriodEnd || 'None yet'}</p></div>
                </div>
                <p className="text-xs text-gray-500 mt-4">
                    Every foreign-currency transaction is valued in {fc} at the rate on its own date, and that value never changes.
                    Transfers use their own actual rate. At each month end, foreign-currency cash, savings owed to members, loans,
                    deposits and the side fund are revalued to that month's closing rate (Settings &gt; Exchange Rates); the
                    difference is an FX gain or loss. Capital, investments, income and expenses are never revalued.
                </p>
                {status.currentRates.length > 0 && (
                    <p className="text-xs text-gray-500 mt-2">
                        Current rates: {status.currentRates.map(r => `1 ${r.base} = ${fmtRate(r.rate)} ${r.target} (from ${r.effective_from})`).join(' · ')}
                    </p>
                )}
            </div>

            <div className="card">
                <h3 className="section-title mb-1">Close months (month-end revaluation)</h3>
                <p className="text-xs text-gray-400 mb-4">
                    {status.pendingMonthEnds.length === 0
                        ? 'Every month that has ended is closed.'
                        : `${status.pendingMonthEnds.length} month end(s) waiting to be closed: ${status.pendingMonthEnds.slice(0, 6).join(', ')}${status.pendingMonthEnds.length > 6 ? ', …' : ''}. They are closed oldest first; each needs a closing rate on file.`}
                </p>
                {canClose ? (
                    <div className="flex flex-wrap items-end gap-4">
                        <div>
                            <label className="label">Close every month end up to</label>
                            <input type="date" className="input" value={throughDate} max={lastMonthEndStr()} onChange={e => setThroughDate(e.target.value)} />
                        </div>
                        <button disabled={busy || status.pendingMonthEnds.length === 0} onClick={() => act(() => reportsAPI.runFxRevaluation({ through_date: throughDate }))} className="btn-primary flex items-center gap-2">
                            {busy ? <ArrowPathIcon className="h-4 w-4 animate-spin" /> : null}
                            Run revaluation
                        </button>
                    </div>
                ) : (
                    <p className="text-xs text-gray-500">Closing months needs the transaction-approval permission (Treasurer).</p>
                )}
            </div>

            {status.staleAfterClose.length > 0 && (
                <div className="card border border-amber-200">
                    <h3 className="section-title mb-1 text-amber-800">Posted after their month was closed</h3>
                    <p className="text-xs text-gray-500 mb-3">
                        These foreign-currency transactions were recorded after their month had already been revalued, so that
                        month's revaluation didn't include them. Reopen from the earliest month shown and run the revaluation again.
                    </p>
                    <table className="w-full text-sm">
                        <thead><tr className="text-left text-xs text-gray-400 border-b border-gray-200"><th className="py-2">Date</th><th>Amount</th><th>Month closed</th></tr></thead>
                        <tbody>
                            {status.staleAfterClose.map(t => (
                                <tr key={t.id} className="border-b border-gray-50 last:border-0">
                                    <td className="py-2">{t.date}</td><td>{t.currencyCode} {fmt(t.amount)}</td><td>{t.closedPeriodEnd}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            <div className="card">
                <div className="flex items-center justify-between mb-1">
                    <h3 className="section-title mb-0">Transactions without a {fc} value ({status.unconvertedCount})</h3>
                    {canConfigure && status.unconvertedCount > 0 && (
                        <button disabled={busy} onClick={() => act(() => reportsAPI.recomputeFxValues())} className="btn-secondary text-xs">
                            Re-check against current rates
                        </button>
                    )}
                </div>
                <p className="text-xs text-gray-400 mb-4">
                    No exchange rate covers these dates, so they are left out of the official statements until one does.
                    The usual fix is to enter the missing month's rate in Settings &gt; Exchange Rates (past dates are allowed).
                    For a single transaction you can instead set the exact rate from its bank proof.
                </p>
                {status.unconverted.length === 0 ? (
                    <p className="text-sm text-green-700 flex items-center gap-2"><CheckCircleIcon className="h-5 w-5" /> Every posted transaction has a {fc} value.</p>
                ) : (
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-left text-xs text-gray-400 border-b border-gray-200">
                                <th className="py-2">Date</th><th>Reference</th><th>Account</th><th>Description</th><th className="text-right">Amount</th>{canConfigure && <th></th>}
                            </tr>
                        </thead>
                        <tbody>
                            {status.unconverted.map(t => (
                                <tr key={t.id} className="border-b border-gray-50 last:border-0 align-top">
                                    <td className="py-2">{t.date}</td>
                                    <td className="font-mono text-xs text-gray-400">{t.referenceCode || `#${t.id}`}</td>
                                    <td className="text-xs">{t.accountName}</td>
                                    <td>{t.description}</td>
                                    <td className="text-right whitespace-nowrap">{t.currencyCode} {fmt(t.amount)}</td>
                                    {canConfigure && (
                                        <td className="text-right">
                                            {rateEdit && rateEdit.id === t.id ? (
                                                <div className="flex flex-col items-end gap-1">
                                                    <input className="input text-xs w-32" placeholder={`${fc} per ${t.currencyCode}`} value={rateEdit.rate} onChange={e => setRateEdit({ ...rateEdit, rate: e.target.value })} />
                                                    <input className="input text-xs w-56" placeholder="Where the rate comes from" value={rateEdit.note} onChange={e => setRateEdit({ ...rateEdit, note: e.target.value })} />
                                                    <div className="flex gap-1">
                                                        <button disabled={busy} className="btn-primary text-xs" onClick={() => act(async () => {
                                                            const r = await reportsAPI.setTransactionFxRate(t.id, { rate: rateEdit.rate, note: rateEdit.note });
                                                            setRateEdit(null);
                                                            return r;
                                                        })}>Save</button>
                                                        <button className="btn-secondary text-xs" onClick={() => setRateEdit(null)}>Cancel</button>
                                                    </div>
                                                </div>
                                            ) : (
                                                <button className="text-xs text-primary-700 hover:underline" onClick={() => setRateEdit({ id: t.id, rate: '', note: '' })}>Set rate</button>
                                            )}
                                        </td>
                                    )}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

            <div className="card">
                <h3 className="section-title mb-1">Closed months</h3>
                <p className="text-xs text-gray-400 mb-4">
                    Each closed month keeps the closing rates it used. Reopening a month also reopens every later month,
                    since each one builds on the one before.
                </p>
                {runs.length === 0 ? (
                    <p className="text-sm text-gray-400">No month has been closed yet.</p>
                ) : (
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-left text-xs text-gray-400 border-b border-gray-200">
                                <th className="py-2">Month end</th><th>Closing rate(s)</th>
                                <th className="text-right">FX gain</th><th className="text-right">FX loss</th><th className="pl-6">Closed by</th><th></th>
                            </tr>
                        </thead>
                        <tbody>
                            {runs.map(run => (
                                <Fragment key={run.id}>
                                    <tr className="border-b border-gray-50">
                                        <td className="py-2">
                                            <button className="text-primary-700 hover:underline" onClick={() => setExpandedRun(expandedRun === run.id ? null : run.id)}>{run.periodEnd}</button>
                                        </td>
                                        <td className="text-xs">{(run.ratesUsed || []).map(r => `${r.currencyCode} ${fmtRate(r.rate)}`).join(', ') || '—'}</td>
                                        <td className="text-right text-green-600">{fmt(run.totalGain)}</td>
                                        <td className="text-right text-red-600">{fmt(run.totalLoss)}</td>
                                        <td className="text-xs text-gray-500 pl-6">{run.runByName}</td>
                                        <td className="text-right">
                                            {canClose && (
                                                <button disabled={busy} className="text-xs text-red-600 hover:underline"
                                                    onClick={() => { if (window.confirm(`Reopen ${run.periodEnd} and every later closed month? They will need to be revalued again.`)) act(() => reportsAPI.reopenFxRevaluation(run.periodEnd)); }}>
                                                    Reopen from here
                                                </button>
                                            )}
                                        </td>
                                    </tr>
                                    {expandedRun === run.id && (
                                        <tr>
                                            <td colSpan={6} className="bg-gray-50 px-3 py-2">
                                                {run.lines.length === 0 ? (
                                                    <p className="text-xs text-gray-500">No foreign-currency balance needed adjusting this month.</p>
                                                ) : (
                                                    <table className="w-full text-xs">
                                                        <thead><tr className="text-left text-gray-400"><th>GL account</th><th>Bank account</th><th className="text-right">Foreign balance</th><th className="text-right">Rate</th><th className="text-right">Book value before</th><th className="text-right">Revalued</th><th className="text-right">Adjustment</th></tr></thead>
                                                        <tbody>
                                                            {run.lines.map((l, i) => (
                                                                <tr key={i}>
                                                                    <td>{l.glCode} — {l.glName}</td><td>{l.accountName || '—'}</td>
                                                                    <td className="text-right">{l.currencyCode} {fmt(l.foreignBalance)}</td><td className="text-right">{fmtRate(l.closingRate)}</td>
                                                                    <td className="text-right">{fmt(l.carryingBefore)}</td><td className="text-right">{fmt(l.revaluedBalance)}</td>
                                                                    <td className={`text-right ${l.adjustment >= 0 ? 'text-green-600' : 'text-red-600'}`}>{fmt(l.adjustment)}</td>
                                                                </tr>
                                                            ))}
                                                        </tbody>
                                                    </table>
                                                )}
                                            </td>
                                        </tr>
                                    )}
                                </Fragment>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
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
    { key: 'fx',             label: 'FX & Revaluation',    icon: GlobeAltIcon },
    { key: 'ledger-accounts', label: 'Ledger Accounts',    icon: Cog6ToothIcon, adminOnly: true },
];

const GeneralLedgerPage = () => {
    const { hasPermission } = useAuth();
    const [activeTab, setActiveTab] = useTabParam('trial-balance');
    const [accounts, setAccounts] = useState([]);
    const [glAccounts, setGlAccounts] = useState([]);
    const [fyStart, setFyStart] = useState(fiscalYearStartStr());
    const [fxStatus, setFxStatus] = useState(null);

    useEffect(() => {
        accountsAPI.getAll().then(res => setAccounts(res.data.data || [])).catch(() => {});
        reportsAPI.getGLAccounts().then(res => setGlAccounts(res.data.data?.accounts || [])).catch(() => {});
        reportsAPI.getFxStatus().then(res => {
            const s = res.data.data;
            setFxStatus(s);
            if (s && s.currentFiscalYearStart) setFyStart(s.currentFiscalYearStart);
        }).catch(() => {});
    }, []);

    const visibleTabs = TABS.filter(t => !t.adminOnly || hasPermission('SYSTEM_CONFIG'));
    const fxAlert = fxStatus && (fxStatus.unconvertedCount > 0 || fxStatus.staleAfterClose.length > 0);

    return (
        <div>
            <PageHeader
                title="Financial Statements"
                subtitle="Trial Balance, General Ledger, Balance Sheet, Income Statement, and Cash Flow Statement — official statements consolidated in the company's functional currency, with a by-currency supporting view"
                showBack backTo="/reports"
            />

            <div className="tab-bar" role="tablist">
                {visibleTabs.map(t => (
                    <button
                        key={t.key}
                        onClick={() => setActiveTab(t.key)}
                        className={`tab ${activeTab === t.key ? 'tab-active' : ''}`}
                    >
                        <t.icon className="h-4 w-4" />
                        {t.label}
                        {t.key === 'fx' && fxAlert && <span className="h-2 w-2 rounded-full bg-red-500" />}
                    </button>
                ))}
            </div>

            {/* key={fyStart} re-mounts the range tabs once the real financial-year start arrives */}
            {activeTab === 'trial-balance' && <TrialBalanceTab accounts={accounts} />}
            {activeTab === 'general-ledger' && <GeneralLedgerTab key={fyStart} accounts={accounts} glAccounts={glAccounts} fyStart={fyStart} />}
            {activeTab === 'balance-sheet' && <BalanceSheetTab accounts={accounts} />}
            {activeTab === 'income-statement' && <IncomeStatementTab key={fyStart} accounts={accounts} fyStart={fyStart} />}
            {activeTab === 'cash-flow' && <CashFlowTab key={fyStart} accounts={accounts} fyStart={fyStart} />}
            {activeTab === 'fx' && <FxRevaluationTab onStatusChange={setFxStatus} />}
            {activeTab === 'ledger-accounts' && hasPermission('SYSTEM_CONFIG') && <LedgerAccountsTab />}
        </div>
    );
};

export default GeneralLedgerPage;
