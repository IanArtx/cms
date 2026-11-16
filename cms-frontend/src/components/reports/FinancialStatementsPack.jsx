// ============================================================
// ANNUAL FINANCIAL STATEMENTS PACK (v1.88.0)
// General Ledger page › "Annual pack".
// "now i would like to finish the financial statements and books and i
//  would like to them be downlaodable with the notes" (13 Nov 2026).
//
//   Statements — statement of financial position (current / non-current),
//                profit or loss, changes in equity, cash flows; this year
//                and last year side by side.
//   Notes & wording — the directors' report, accounting policies and the
//                note behind each figure. Treasurer / Assistant Treasurer /
//                Admin can change the wording; figures always come from
//                the books.
//   Approval — each director approves (their blue signature is printed on
//                the pack). If the books change afterwards the pack says so.
//   Settings — which accounts are non-current, auditors / bankers /
//                lawyers, how many directors must approve.
//   Downloads — the pack as PDF or Excel (with trial balance, general
//                ledger and cash book), and the books for any dates.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { reportsAPI } from '../../api/endpoints';
import { getErrorMessage } from '../../utils/helpers';
import { downloadBlob } from '../../utils/exportUtils';
import ErrorMessage from '../common/ErrorMessage';
import LoadingSpinner from '../common/LoadingSpinner';
import {
    ArrowDownTrayIcon, CheckBadgeIcon, ExclamationTriangleIcon, PencilSquareIcon, DocumentTextIcon, TableCellsIcon,
} from '@heroicons/react/24/outline';

const fmt = (n) => {
    const v = Math.round(Number(n) || 0);
    if (v === 0) return '–';
    const s = Math.abs(v).toLocaleString('en-US');
    return v < 0 ? `(${s})` : s;
};
const STATUS = {
    APPROVED: { label: 'Approved', cls: 'bg-green-50 text-green-700 border-green-200' },
    DRAFT: { label: 'Draft — awaiting directors’ approval', cls: 'bg-amber-50 text-amber-800 border-amber-200' },
    CHANGED: { label: 'Books changed after approval', cls: 'bg-red-50 text-red-700 border-red-200' },
    IN_PROGRESS: { label: 'Year not finished — figures to date', cls: 'bg-blue-50 text-blue-700 border-blue-200' },
};
const VIEWS = [
    { key: 'statements', label: 'Statements' },
    { key: 'notes', label: 'Notes & wording' },
    { key: 'approval', label: 'Approval' },
    { key: 'settings', label: 'Settings' },
];

// ------------------------------------------------------------
// Small table pieces
// ------------------------------------------------------------
const Head = ({ pack, note = true }) => (
    <thead>
        <tr className="text-xs text-gray-500 border-b border-gray-200 dark:border-gray-700">
            <th className="text-left font-medium py-1.5" />
            {note && <th className="w-12 text-center font-medium">Note</th>}
            <th className="w-32 text-right font-medium">{pack.year.to.slice(0, 4)}<span className="block font-normal">{pack.currency}</span></th>
            <th className="w-32 text-right font-medium">{pack.prior.end.slice(0, 4)}<span className="block font-normal">{pack.currency}</span></th>
        </tr>
    </thead>
);
const Line = ({ r, note }) => (
    <tr className="text-sm">
        <td className="py-1 pr-2 text-gray-700 dark:text-gray-300">{r.name}</td>
        {note !== undefined && <td className="text-center text-xs text-gray-400">{note}</td>}
        <td className="text-right tabular-nums">{fmt(r.cur)}</td>
        <td className="text-right tabular-nums text-gray-500">{fmt(r.prev)}</td>
    </tr>
);
const Total = ({ label, t, strong = false, note = true }) => (
    <tr className={`text-sm font-semibold ${strong ? 'border-y-2 border-gray-400 dark:border-gray-500' : 'border-t border-gray-300 dark:border-gray-600'}`}>
        <td className="py-1.5">{label}</td>
        {note && <td />}
        <td className="text-right tabular-nums">{fmt(t.cur)}</td>
        <td className="text-right tabular-nums">{fmt(t.prev)}</td>
    </tr>
);
const Sub = ({ label, cols = 4 }) => (
    <tr><td colSpan={cols} className="pt-3 pb-1 text-xs font-semibold uppercase tracking-wide text-primary-700 dark:text-primary-300">{label}</td></tr>
);
const Italic = ({ label, cols = 4 }) => <tr><td colSpan={cols} className="pt-1 text-xs italic text-gray-500">{label}</td></tr>;

const Card = ({ title, period, children }) => (
    <section className="card p-4 sm:p-5">
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
        {period && <p className="text-xs text-gray-500 mb-3">{period}</p>}
        <div className="overflow-x-auto">{children}</div>
    </section>
);

const NOTE_FOR = (code) => {
    if (code === '1000' || code === '1050') return 8;
    if (code === '1300' || code === '1400') return 9;
    if (code === '1100' || code === '1200') return 10;
    if (['1500', '1510', '2500', '2510', '5700', '5710'].includes(code)) return 7;
    if (code === '4600' || code === '5600') return 6;
    if (code === 'RE') return 13;
    if (/^30/.test(code)) return 12;
    if (/^2/.test(code)) return 11;
    if (/^4/.test(code)) return 4;
    if (/^5/.test(code)) return 5;
    return '';
};

const Statements = ({ pack }) => {
    const s = pack.sofp; const p = pack.pl; const cf = pack.cashFlows;
    const end = `${pack.year.inProgress ? 'To' : 'For the year ended'} ${pack.year.to}`;
    return (
        <div className="grid gap-4 xl:grid-cols-2">
            <Card title="Statement of financial position" period={`As at ${pack.year.to}`}>
                <table className="w-full"><Head pack={pack} /><tbody>
                    <Sub label="Assets" />
                    {s.nonCurrentAssets.length > 0 && <><Italic label="Non-current assets" />{s.nonCurrentAssets.map(r => <Line key={r.code} r={r} note={NOTE_FOR(r.code)} />)}<Total label="Total non-current assets" t={s.totalNonCurrentAssets} /></>}
                    <Italic label="Current assets" />{s.currentAssets.map(r => <Line key={r.code} r={r} note={NOTE_FOR(r.code)} />)}<Total label="Total current assets" t={s.totalCurrentAssets} />
                    <Total label="Total assets" t={s.totalAssets} strong />
                    <Sub label="Equity and liabilities" />
                    <Italic label="Equity" />{s.equity.map(r => <Line key={r.code} r={r} note={NOTE_FOR(r.code)} />)}<Total label="Total equity" t={s.totalEquity} />
                    {s.nonCurrentLiabilities.length > 0 && <><Italic label="Non-current liabilities" />{s.nonCurrentLiabilities.map(r => <Line key={r.code} r={r} note={NOTE_FOR(r.code)} />)}<Total label="Total non-current liabilities" t={s.totalNonCurrentLiabilities} /></>}
                    {s.currentLiabilities.length > 0 && <><Italic label="Current liabilities" />{s.currentLiabilities.map(r => <Line key={r.code} r={r} note={NOTE_FOR(r.code)} />)}<Total label="Total current liabilities" t={s.totalCurrentLiabilities} /></>}
                    <Total label="Total equity and liabilities" t={s.totalEquityAndLiabilities} strong />
                </tbody></table>
            </Card>
            <div className="space-y-4">
                <Card title="Profit or loss" period={end}>
                    <table className="w-full"><Head pack={pack} /><tbody>
                        <Sub label="Income" />{p.revenue.map(r => <Line key={r.code} r={r} note={NOTE_FOR(r.code)} />)}<Total label="Total income" t={p.totalRevenue} />
                        <Sub label="Expenses" />{p.expenses.map(r => <Line key={r.code} r={r} note={NOTE_FOR(r.code)} />)}<Total label="Total expenses" t={p.totalExpenses} />
                        <Total label="Profit / (loss) before tax" t={p.profitBeforeTax} />
                        {p.incomeTax.map(r => <Line key={r.code} r={r} note={NOTE_FOR(r.code)} />)}
                        <Total label="Profit / (loss) for the year" t={p.profit} strong />
                    </tbody></table>
                </Card>
                <Card title="Cash flows" period={`${end} — direct method`}>
                    <table className="w-full"><Head pack={pack} note={false} /><tbody>
                        {[['Operating activities', cf.operating], ['Investing activities', cf.investing], ['Financing activities', cf.financing]].map(([l, sec]) => (
                            <FragmentRows key={l} label={l} sec={sec} />
                        ))}
                        <Total label="Net increase / (decrease) in cash" t={cf.netChange} note={false} />
                        <Line r={{ name: 'Cash at the start of the year', ...cf.opening }} />
                        <Line r={{ name: 'Effect of exchange rate changes', ...cf.fxEffect }} />
                        <Total label="Cash at the end of the year" t={cf.closing} strong note={false} />
                    </tbody></table>
                </Card>
            </div>
            <div className="xl:col-span-2">
                <Card title="Changes in equity" period={end}>
                    <table className="w-full text-sm">
                        <thead><tr className="text-xs text-gray-500 border-b border-gray-200 dark:border-gray-700">
                            <th />{pack.soce.columns.map(c => <th key={c.key} className="text-right font-medium px-2 py-1.5">{c.name}</th>)}<th className="text-right font-medium px-2">Total</th>
                        </tr></thead>
                        <tbody>{pack.soce.rows.map((r, i) => (
                            <tr key={i} className={r.strong ? 'font-semibold border-t border-gray-300 dark:border-gray-600' : ''}>
                                <td className="py-1 pr-2">{r.label}</td>
                                {pack.soce.columns.map(c => <td key={c.key} className="text-right tabular-nums px-2">{fmt(r.values[c.key])}</td>)}
                                <td className="text-right tabular-nums px-2">{fmt(r.total)}</td>
                            </tr>
                        ))}</tbody>
                    </table>
                </Card>
            </div>
        </div>
    );
};
const FragmentRows = ({ label, sec }) => (
    <>
        <Sub label={label} cols={3} />
        {sec.rows.map((r, i) => <Line key={i} r={r} />)}
        <Total label={`Net cash from ${label.toLowerCase()}`} t={sec.total} note={false} />
    </>
);

// ------------------------------------------------------------
// Notes & wording
// ------------------------------------------------------------
const NotesEditor = ({ pack, onSaved }) => {
    const [drafts, setDrafts] = useState({});
    const [editing, setEditing] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null);
    const groups = useMemo(() => {
        const g = [];
        for (const t of pack.texts) {
            let last = g[g.length - 1];
            if (!last || last.name !== t.group) { last = { name: t.group, items: [] }; g.push(last); }
            last.items.push(t);
        }
        return g;
    }, [pack.texts]);
    const dirty = Object.keys(drafts).length > 0;
    const save = async () => {
        setBusy(true); setError(null); setNotice(null);
        try {
            const r = await reportsAPI.saveFsTexts(pack.year.endYear, drafts);
            setNotice(r.data.message); setDrafts({}); setEditing(null); onSaved();
        } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
    };
    return (
        <div className="space-y-4">
            <div className="card p-4 text-sm text-gray-600 dark:text-gray-300">
                The wording below is printed in the pack for <strong>{pack.year.label}</strong>. Figures are never typed here — they always come from the books.
                {pack.can.edit
                    ? <> Words in curly brackets are filled in automatically: {pack.placeholders.map(p => <code key={p} className="mx-0.5 text-xs bg-gray-100 dark:bg-gray-800 px-1 rounded">{`{${p}}`}</code>)}. Leave a note to the figures empty if it needs no comment.</>
                    : <> Only the Treasurer, Assistant Treasurer or Admin can change it.</>}
                {pack.textsUpdatedAt && <span className="block mt-1 text-xs text-gray-500">Last changed {new Date(pack.textsUpdatedAt).toLocaleString()} by {pack.textsUpdatedBy}.</span>}
            </div>
            {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
            {notice && <div className="bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg p-3">{notice}</div>}
            {groups.map(g => (
                <section key={g.name} className="card divide-y divide-gray-100 dark:divide-gray-800">
                    <h3 className="px-4 py-3 text-sm font-semibold text-gray-900 dark:text-gray-100">{g.name}</h3>
                    {g.items.map(t => {
                        const value = t.key in drafts ? (drafts[t.key] ?? t.standard) : t.raw;
                        const isEditing = editing === t.key;
                        return (
                            <div key={t.key} className="px-4 py-3">
                                <div className="flex items-center gap-2">
                                    <p className="text-sm font-medium text-gray-800 dark:text-gray-200 flex-1">{t.title}
                                        {(t.changed || t.key in drafts) && <span className="ml-2 text-[11px] font-normal text-primary-600">changed for this year</span>}
                                    </p>
                                    {pack.can.edit && !isEditing && (
                                        <button type="button" className="text-xs text-primary-600 hover:underline inline-flex items-center gap-1" onClick={() => setEditing(t.key)}>
                                            <PencilSquareIcon className="h-4 w-4" />Edit
                                        </button>
                                    )}
                                </div>
                                {isEditing ? (
                                    <div className="mt-2 space-y-2">
                                        <textarea className="input min-h-[7rem] text-sm" value={value}
                                            onChange={e => setDrafts(d => ({ ...d, [t.key]: e.target.value }))} />
                                        <div className="flex gap-3 text-xs">
                                            <button type="button" className="text-gray-600 hover:underline" onClick={() => setEditing(null)}>Done</button>
                                            {t.standard && <button type="button" className="text-gray-600 hover:underline" onClick={() => setDrafts(d => ({ ...d, [t.key]: null }))}>Use the standard wording</button>}
                                        </div>
                                    </div>
                                ) : (
                                    <p className="mt-1 text-sm text-gray-600 dark:text-gray-400 whitespace-pre-line">
                                        {t.key in drafts ? <em>{value || '(empty)'}</em> : (t.text || <span className="italic text-gray-400">No comment</span>)}
                                    </p>
                                )}
                            </div>
                        );
                    })}
                </section>
            ))}
            {pack.can.edit && (
                <div className="sticky bottom-3 flex justify-end">
                    <button type="button" className="btn-primary shadow-lg" disabled={!dirty || busy} onClick={save}>
                        {busy ? 'Saving…' : dirty ? `Save ${Object.keys(drafts).length} change${Object.keys(drafts).length === 1 ? '' : 's'}` : 'No changes'}
                    </button>
                </div>
            )}
        </div>
    );
};

// ------------------------------------------------------------
// Approval
// ------------------------------------------------------------
const Approval = ({ pack, onChanged }) => {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null);
    const [reason, setReason] = useState('');
    const active = pack.approvals.filter(a => !a.withdrawn_at);
    const run = async (fn) => {
        setBusy(true); setError(null); setNotice(null);
        try { const r = await fn(); setNotice(r.data.message); setReason(''); onChanged(); } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
    };
    return (
        <div className="grid gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2 card p-4 sm:p-5 space-y-3">
                <h3 className="text-base font-semibold">Directors’ approval — {active.length} of {pack.approvalsRequired} needed</h3>
                <p className="text-sm text-gray-600 dark:text-gray-400">
                    When a director approves, their signature (blue) is printed on the directors’ report, the statement of responsibilities and the approval page,
                    and the key totals are recorded. If the books change afterwards, the pack shows a warning until the directors approve again.
                </p>
                {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
                {notice && <div className="bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg p-3">{notice}</div>}
                <ul className="divide-y divide-gray-100 dark:divide-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
                    {pack.company.directors.length === 0 && <li className="p-3 text-sm text-gray-500">No one holds the Director role.</li>}
                    {pack.company.directors.map(d => {
                        const a = active.find(x => x.user_id === d.id);
                        return (
                            <li key={d.id} className="p-3 flex items-center gap-3">
                                <span className={`h-2.5 w-2.5 rounded-full ${a ? 'bg-green-500' : 'bg-gray-300'}`} />
                                <span className="flex-1 text-sm">{d.name}</span>
                                <span className="text-xs text-gray-500">{a ? `Approved ${new Date(a.approved_at).toLocaleDateString()}` : 'Not yet'}</span>
                            </li>
                        );
                    })}
                </ul>
                {pack.approvals.some(a => a.withdrawn_at) && (
                    <details className="text-xs text-gray-500"><summary className="cursor-pointer">Withdrawn approvals</summary>
                        <ul className="mt-1 space-y-1">{pack.approvals.filter(a => a.withdrawn_at).map(a => (
                            <li key={a.id}>{a.name} — approved {new Date(a.approved_at).toLocaleDateString()}, withdrawn {new Date(a.withdrawn_at).toLocaleDateString()}: {a.withdrawn_reason}</li>
                        ))}</ul>
                    </details>
                )}
            </div>
            <div className="card p-4 sm:p-5 space-y-3">
                <h3 className="text-sm font-semibold">Your approval</h3>
                {pack.year.inProgress && <p className="text-sm text-gray-500">The year ends on {pack.year.end}; it can be approved after that.</p>}
                {!pack.year.inProgress && !pack.can.approve && !pack.can.myApproval && <p className="text-sm text-gray-500">Only directors approve the financial statements.</p>}
                {pack.can.approve && !pack.can.myApproval && (
                    <>
                        <p className="text-sm text-gray-600 dark:text-gray-400">Read the statements and notes first. Your saved signature (My Profile › Signature) will be used.</p>
                        <button type="button" className="btn-primary w-full inline-flex items-center justify-center gap-2" disabled={busy}
                            onClick={() => run(() => reportsAPI.approveFs(pack.year.endYear))}>
                            <CheckBadgeIcon className="h-5 w-5" />Approve the {pack.year.label} statements
                        </button>
                    </>
                )}
                {pack.can.myApproval && (
                    <>
                        <p className="text-sm text-green-700">You approved on {new Date(pack.can.myApproval.approved_at).toLocaleString()}.</p>
                        <label className="label" htmlFor="fs-withdraw">Withdraw — reason</label>
                        <textarea id="fs-withdraw" className="input min-h-[4rem] text-sm" value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. a late invoice must be added" />
                        <button type="button" className="btn-secondary w-full" disabled={busy || reason.trim().length < 5}
                            onClick={() => run(() => reportsAPI.withdrawFsApproval(pack.year.endYear, reason.trim()))}>Withdraw my approval</button>
                    </>
                )}
            </div>
        </div>
    );
};

// ------------------------------------------------------------
// Settings
// ------------------------------------------------------------
const Settings = ({ pack, glAccounts, onSaved }) => {
    const [form, setForm] = useState(() => ({ ...pack.settings }));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null);
    const bsAccounts = (glAccounts || []).filter(a => a.account_type === 'ASSET' || a.account_type === 'LIABILITY');
    const save = async () => {
        setBusy(true); setError(null); setNotice(null);
        try {
            const r = await reportsAPI.saveFsSettings({
                classification: form.classification, auditors: form.auditors, bankers: form.bankers, lawyers: form.lawyers,
                approvals_required: Number(form.approvals_required) || 2,
            });
            setNotice(r.data.message); onSaved();
        } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
    };
    const ro = !pack.can.edit;
    return (
        <div className="grid gap-4 lg:grid-cols-2">
            <section className="card p-4 sm:p-5">
                <h3 className="text-base font-semibold mb-1">Current or non-current</h3>
                <p className="text-sm text-gray-500 mb-3">Non-current = not expected to be received or paid within 12 months of the year end. This changes only how the statement of financial position is grouped, never an amount.</p>
                <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                    {bsAccounts.map(a => (
                        <li key={a.code} className="py-2 flex items-center gap-3 text-sm">
                            <span className="w-12 text-gray-400 tabular-nums">{a.code}</span>
                            <span className="flex-1">{a.name}</span>
                            <select className="input max-w-[10rem] py-1 text-sm" disabled={ro} value={form.classification[a.code] || 'CURRENT'}
                                onChange={e => setForm(f => ({ ...f, classification: { ...f.classification, [a.code]: e.target.value } }))}>
                                <option value="CURRENT">Current</option>
                                <option value="NON_CURRENT">Non-current</option>
                            </select>
                        </li>
                    ))}
                </ul>
            </section>
            <section className="card p-4 sm:p-5 space-y-3">
                <h3 className="text-base font-semibold">Company information page</h3>
                {[['auditors', 'Auditors', 'Leave empty if the statements are not audited'], ['bankers', 'Bankers', ''], ['lawyers', 'Lawyers', '']].map(([k, l, ph]) => (
                    <div key={k}>
                        <label className="label" htmlFor={`fs-${k}`}>{l}</label>
                        <textarea id={`fs-${k}`} className="input min-h-[3.5rem] text-sm" disabled={ro} placeholder={ph} value={form[k] || ''} onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))} />
                    </div>
                ))}
                <div>
                    <label className="label" htmlFor="fs-needed">Director approvals needed</label>
                    <input id="fs-needed" type="number" min="1" max="10" className="input max-w-[6rem]" disabled={ro} value={form.approvals_required}
                        onChange={e => setForm(f => ({ ...f, approvals_required: e.target.value }))} />
                </div>
                <p className="text-xs text-gray-500">Company name, registration number, TIN and addresses come from Settings › Company.</p>
                {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
                {notice && <div className="bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg p-3">{notice}</div>}
                {!ro && <div className="flex justify-end"><button type="button" className="btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save settings'}</button></div>}
            </section>
        </div>
    );
};

// ------------------------------------------------------------
// The tab
// ------------------------------------------------------------
const FinancialStatementsPack = ({ glAccounts = [] }) => {
    const [year, setYear] = useState(null);
    const [pack, setPack] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [view, setView] = useState('statements');
    const [downloading, setDownloading] = useState(null);
    const [books, setBooks] = useState({ from: '', to: '' });

    const load = useCallback(async (y) => {
        setLoading(true); setError(null);
        try {
            const r = await reportsAPI.getFsPack(y);
            const d = r.data.data;
            setPack(d); setYear(d.year.endYear);
            setBooks(b => (b.from ? b : { from: d.year.start, to: d.year.to }));
        } catch (err) { setError(getErrorMessage(err)); } finally { setLoading(false); }
    }, []);
    useEffect(() => { load(null); }, [load]);

    const download = async (kind) => {
        setDownloading(kind); setError(null);
        try {
            const safe = (pack.company.name || 'Company').replace(/[^A-Za-z0-9]+/g, '_');
            const lbl = pack.year.label.replace('/', '-');
            if (kind === 'pdf') downloadBlob((await reportsAPI.downloadFsPdf(year)).data, `${safe}_Financial_Statements_${lbl}.pdf`);
            if (kind === 'xlsx') downloadBlob((await reportsAPI.downloadFsXlsx(year)).data, `${safe}_Financial_Statements_${lbl}.xlsx`);
            if (kind === 'books') downloadBlob((await reportsAPI.downloadBooks({ from_date: books.from, to_date: books.to })).data, `${safe}_Books_${books.from}_to_${books.to}.xlsx`);
        } catch (err) {
            let msg = getErrorMessage(err);
            try { if (err.response && err.response.data instanceof Blob) msg = JSON.parse(await err.response.data.text()).message || msg; } catch (_) { /* keep msg */ }
            setError(msg);
        } finally { setDownloading(null); }
    };

    if (loading && !pack) return <LoadingSpinner />;
    if (!pack) return <ErrorMessage message={error || 'Could not load the financial statements.'} />;
    const st = STATUS[pack.status] || STATUS.DRAFT;
    const active = pack.approvals.filter(a => !a.withdrawn_at).length;

    return (
        <div className="space-y-4">
            <div className="card p-4 flex flex-col lg:flex-row lg:items-center gap-3">
                <div className="flex items-center gap-3 flex-wrap flex-1">
                    <label className="text-sm text-gray-600 dark:text-gray-300" htmlFor="fs-year">Financial year</label>
                    <select id="fs-year" className="input max-w-[14rem]" value={year || ''} onChange={e => load(Number(e.target.value))}>
                        {pack.years.map(y => <option key={y.endYear} value={y.endYear}>{y.label}{y.inProgress ? ' (in progress)' : ''}</option>)}
                    </select>
                    <span className={`text-xs border rounded-full px-2.5 py-1 ${st.cls}`}>{st.label}</span>
                    {pack.status !== 'IN_PROGRESS' && <span className="text-xs text-gray-500">{active}/{pack.approvalsRequired} director approvals</span>}
                </div>
                <div className="flex gap-2 flex-wrap">
                    <button type="button" className="btn-primary inline-flex items-center gap-1.5" disabled={!!downloading} onClick={() => download('pdf')}>
                        <DocumentTextIcon className="h-4 w-4" />{downloading === 'pdf' ? 'Preparing…' : 'PDF'}
                    </button>
                    <button type="button" className="btn-secondary inline-flex items-center gap-1.5" disabled={!!downloading} onClick={() => download('xlsx')}>
                        <TableCellsIcon className="h-4 w-4" />{downloading === 'xlsx' ? 'Preparing…' : 'Excel'}
                    </button>
                </div>
            </div>

            {!pack.ready && <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">The pack can be viewed and downloaded, but editing the wording, settings and approvals needs the v1.88.0 database update.</div>}
            {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
            {pack.warnings.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-800 p-3 text-sm text-amber-900 dark:text-amber-200 flex gap-2">
                    <ExclamationTriangleIcon className="h-5 w-5 flex-shrink-0" />
                    <ul className="space-y-1">{pack.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
                </div>
            )}

            <div className="flex gap-1 border-b border-gray-200 dark:border-gray-700 overflow-x-auto">
                {VIEWS.map(v => (
                    <button key={v.key} type="button" onClick={() => setView(v.key)}
                        className={`px-3 py-2 text-sm whitespace-nowrap border-b-2 -mb-px ${view === v.key ? 'border-primary-600 text-primary-700 dark:text-primary-300 font-medium' : 'border-transparent text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'}`}>
                        {v.label}
                    </button>
                ))}
            </div>

            {loading ? <LoadingSpinner /> : (
                <>
                    {view === 'statements' && <Statements pack={pack} />}
                    {view === 'notes' && <NotesEditor key={pack.year.endYear} pack={pack} onSaved={() => load(year)} />}
                    {view === 'approval' && <Approval pack={pack} onChanged={() => load(year)} />}
                    {view === 'settings' && <Settings key={pack.year.endYear} pack={pack} glAccounts={glAccounts} onSaved={() => load(year)} />}
                </>
            )}

            <section className="card p-4 flex flex-col md:flex-row md:items-end gap-3">
                <div className="flex-1">
                    <h3 className="text-sm font-semibold">Download the books</h3>
                    <p className="text-xs text-gray-500">Trial balance at the end date, general ledger and a cash book for each account (in its own currency), for any dates — Excel.</p>
                </div>
                <div className="flex items-end gap-2 flex-wrap">
                    <div><label className="label" htmlFor="bk-from">From</label><input id="bk-from" type="date" className="input" value={books.from} onChange={e => setBooks(b => ({ ...b, from: e.target.value }))} /></div>
                    <div><label className="label" htmlFor="bk-to">To</label><input id="bk-to" type="date" className="input" value={books.to} onChange={e => setBooks(b => ({ ...b, to: e.target.value }))} /></div>
                    <button type="button" className="btn-secondary inline-flex items-center gap-1.5" disabled={!!downloading || !books.from || !books.to || books.from > books.to} onClick={() => download('books')}>
                        <ArrowDownTrayIcon className="h-4 w-4" />{downloading === 'books' ? 'Preparing…' : 'Books (Excel)'}
                    </button>
                </div>
            </section>
        </div>
    );
};

export default FinancialStatementsPack;
