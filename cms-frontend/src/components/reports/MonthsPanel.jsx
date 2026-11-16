// ============================================================
// MONTHS — closing the books month by month (v1.90.0)
// General Ledger page › "Months".
//
// Confirmed with the owner (13 Nov 2026):
//   • the Treasurer closes each month once it has ended and its checklist
//     is clear — nothing dated in a closed month can be added, changed
//     or removed after that (the database itself refuses it);
//   • an Admin may reopen the newest closed month, with a reason, only
//     until that year's income tax return is approved;
//   • once a Director approves the URA confirmation of the filed return
//     (Tax › Years), every month of that year is LOCKED for good.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { reportsAPI } from '../../api/endpoints';
import { getErrorMessage } from '../../utils/helpers';
import { useAuth } from '../../contexts/AuthContext';
import ErrorMessage from '../common/ErrorMessage';
import LoadingSpinner from '../common/LoadingSpinner';
import {
    CheckCircleIcon, XCircleIcon, LockClosedIcon, LockOpenIcon, CalendarDaysIcon, InformationCircleIcon,
} from '@heroicons/react/24/outline';

const STATUS = {
    OPEN: { label: 'Open', cls: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-200 dark:border-blue-800' },
    CLOSED: { label: 'Closed', cls: 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-200 dark:border-amber-800' },
    LOCKED: { label: 'Locked for good', cls: 'bg-gray-100 text-gray-700 border-gray-300 dark:bg-gray-800 dark:text-gray-200 dark:border-gray-600' },
};
const ACTION = { CLOSE: 'Closed', REOPEN: 'Reopened', LOCK: 'Locked' };
const ugx = (n) => (n === null || n === undefined ? '—' : `UGX ${Math.round(Number(n)).toLocaleString('en-US')}`);
const when = (d) => (d ? new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

const Badge = ({ status }) => {
    const s = STATUS[status] || STATUS.OPEN;
    return <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border ${s.cls}`}>
        {status === 'LOCKED' && <LockClosedIcon className="h-3 w-3" />}{s.label}
    </span>;
};

const MonthsPanel = () => {
    const { hasRole } = useAuth();
    const isTreasurer = hasRole('Treasurer');
    const isAdmin = hasRole('Admin');
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null);
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState('');
    const [reason, setReason] = useState('');
    const [showAll, setShowAll] = useState(false);

    const load = useCallback(() => {
        setLoading(true);
        reportsAPI.getMonths()
            .then(r => setData(r.data.data))
            .catch(err => setError(getErrorMessage(err)))
            .finally(() => setLoading(false));
    }, []);
    useEffect(() => { load(); }, [load]);

    const run = async (fn) => {
        setBusy(true); setError(null); setNotice(null);
        try {
            const r = await fn();
            setNotice(r.data.message); setNote(''); setReason(''); load();
        } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
    };

    if (loading && !data) return <LoadingSpinner />;
    if (!data) return <ErrorMessage message={error || 'Could not load the months.'} />;
    if (!data.ready) {
        return <div className="card p-5 text-sm text-gray-600 dark:text-gray-300">
            Month closing needs the v1.90.0 database update. Run <code>npm run update-db</code> (see the update steps), then reload this page.
        </div>;
    }

    const next = data.next_to_close;
    const reopenable = data.reopenable ? data.months.find(m => m.month === data.reopenable) : null;
    const months = showAll ? data.months : data.months.slice(0, 13);
    const counts = data.months.reduce((c, m) => ({ ...c, [m.status]: (c[m.status] || 0) + 1 }), {});

    return (
        <div className="space-y-4">
            <div className="card p-4 sm:p-5">
                <div className="flex items-start gap-3">
                    <CalendarDaysIcon className="h-6 w-6 text-primary-600 shrink-0" />
                    <div className="text-sm text-gray-600 dark:text-gray-300 space-y-1">
                        <p><strong>Closing a month</strong> freezes it: nothing dated in a closed month can be added, changed or removed — not from any page, and not even directly in the database.
                            Close each month once it has ended and its checklist is clear, oldest first.</p>
                        <p>Only the <strong>Treasurer</strong> closes months. An <strong>Admin</strong> may reopen the newest closed month, with a reason, until that year’s tax return is approved.
                            When a Director approves the URA confirmation of the filed return (Tax › Years), every month of that year is <strong>locked for good</strong>.</p>
                        <p className="text-xs text-gray-500">{counts.OPEN || 0} open · {counts.CLOSED || 0} closed · {counts.LOCKED || 0} locked</p>
                    </div>
                </div>
            </div>

            {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
            {notice && <div className="bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg p-3 dark:bg-green-900/30 dark:border-green-800 dark:text-green-200">{notice}</div>}

            <div className="grid gap-4 lg:grid-cols-2">
                <div className="card p-4 sm:p-5 space-y-3">
                    <h3 className="text-base font-semibold">{next ? `Next to close: ${next.label}` : 'Nothing to close'}</h3>
                    {!next && <p className="text-sm text-gray-500">Every month that has ended is closed. The current month can be closed after it ends.</p>}
                    {next && (
                        <>
                            <ul className="space-y-2">
                                {next.items.map(i => (
                                    <li key={i.key} className="flex gap-2 text-sm">
                                        {i.warning
                                            ? <InformationCircleIcon className="h-5 w-5 text-amber-500 shrink-0" />
                                            : (i.ok ? <CheckCircleIcon className="h-5 w-5 text-green-600 shrink-0" /> : <XCircleIcon className="h-5 w-5 text-red-500 shrink-0" />)}
                                        <span>
                                            <span className={i.ok ? 'text-gray-700 dark:text-gray-200' : 'font-medium'}>{i.label}</span>
                                            {i.detail && <span className="block text-xs text-gray-500">{i.detail}</span>}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                            {isTreasurer ? (
                                <>
                                    <label className="label" htmlFor="month-close-note">Note (optional)</label>
                                    <input id="month-close-note" className="input text-sm" value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. bank statement reconciled" />
                                    <button type="button" className="btn-primary w-full inline-flex items-center justify-center gap-2" disabled={busy || !next.canClose}
                                        onClick={() => run(() => reportsAPI.closeMonth(next.month, { note: note.trim() || undefined }))}>
                                        <LockClosedIcon className="h-5 w-5" />Close {next.label}
                                    </button>
                                    {!next.canClose && <p className="text-xs text-gray-500">Clear the items marked ✗ first.</p>}
                                </>
                            ) : <p className="text-xs text-gray-500">Only the Treasurer closes months.</p>}
                        </>
                    )}
                </div>

                <div className="card p-4 sm:p-5 space-y-3">
                    <h3 className="text-base font-semibold">Reopen a month</h3>
                    {!reopenable && <p className="text-sm text-gray-500">No month can be reopened: only the newest closed month can, and only before its year’s tax return is approved.</p>}
                    {reopenable && (
                        <>
                            <p className="text-sm text-gray-600 dark:text-gray-300">
                                <strong>{reopenable.label}</strong> is the newest closed month{reopenable.closed_by ? ` (closed by ${reopenable.closed_by}, ${when(reopenable.closed_at)})` : ''}.
                                Reopening lets entries dated in it be changed again; the Treasurer then closes it again. If its year’s tax computation was already prepared, it goes back to be prepared again.
                            </p>
                            {isAdmin ? (
                                <>
                                    <label className="label" htmlFor="month-reopen-reason">Reason (required)</label>
                                    <textarea id="month-reopen-reason" className="input min-h-[4rem] text-sm" value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. a supplier invoice dated in this month arrived late" />
                                    <button type="button" className="btn-secondary w-full inline-flex items-center justify-center gap-2" disabled={busy || reason.trim().length < 5}
                                        onClick={() => run(() => reportsAPI.reopenMonth(reopenable.month, { reason: reason.trim() }))}>
                                        <LockOpenIcon className="h-5 w-5" />Reopen {reopenable.label}
                                    </button>
                                </>
                            ) : <p className="text-xs text-gray-500">Only an Admin reopens a month.</p>}
                        </>
                    )}
                </div>
            </div>

            <div className="card overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="min-w-full text-sm">
                        <thead className="bg-gray-50 dark:bg-gray-800/60 text-xs text-gray-500">
                            <tr>
                                <th className="text-left font-medium px-3 py-2">Month</th>
                                <th className="text-left font-medium px-3 py-2">Status</th>
                                <th className="text-left font-medium px-3 py-2 hidden md:table-cell">Closed</th>
                                <th className="text-right font-medium px-3 py-2 hidden sm:table-cell">Entries</th>
                                <th className="text-right font-medium px-3 py-2 hidden lg:table-cell">Money in</th>
                                <th className="text-right font-medium px-3 py-2 hidden lg:table-cell">Money out</th>
                                <th className="text-left font-medium px-3 py-2 hidden md:table-cell">Tax year</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                            {months.map(m => (
                                <tr key={m.month}>
                                    <td className="px-3 py-2 font-medium whitespace-nowrap">{m.label}{!m.ended && <span className="block text-xs font-normal text-gray-400">current month</span>}</td>
                                    <td className="px-3 py-2"><Badge status={m.status} />
                                        {m.status === 'LOCKED' && m.locked_by && <span className="block text-xs text-gray-400 mt-0.5">by {m.locked_by}</span>}
                                    </td>
                                    <td className="px-3 py-2 text-xs text-gray-500 hidden md:table-cell">
                                        {m.closed_by ? <>{m.closed_by}<span className="block">{when(m.closed_at)}</span></> : '—'}
                                        {m.close_note && <span className="block italic">{m.close_note}</span>}
                                    </td>
                                    <td className="px-3 py-2 text-right tabular-nums hidden sm:table-cell">{m.figures ? m.figures.entries : '—'}</td>
                                    <td className="px-3 py-2 text-right tabular-nums hidden lg:table-cell">{m.figures ? ugx(m.figures.money_in_ugx) : '—'}</td>
                                    <td className="px-3 py-2 text-right tabular-nums hidden lg:table-cell">{m.figures ? ugx(m.figures.money_out_ugx) : '—'}</td>
                                    <td className="px-3 py-2 text-xs text-gray-500 hidden md:table-cell">{m.tax_year || '—'}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
                {data.months.length > 13 && (
                    <button type="button" className="w-full text-xs text-primary-700 dark:text-primary-300 py-2 border-t border-gray-100 dark:border-gray-800" onClick={() => setShowAll(v => !v)}>
                        {showAll ? 'Show the last 13 months only' : `Show all ${data.months.length} months`}
                    </button>
                )}
            </div>

            {data.events.length > 0 && (
                <details className="card p-4 sm:p-5">
                    <summary className="cursor-pointer text-sm font-semibold">History — who closed, reopened and locked which month</summary>
                    <ul className="mt-3 space-y-1.5 text-sm">
                        {data.events.map(e => (
                            <li key={e.id} className="flex flex-wrap gap-x-2">
                                <span className="font-medium">{ACTION[e.action] || e.action}</span>
                                <span>{e.month}</span>
                                <span className="text-gray-500">— {e.by_name || 'system'}, {when(e.at)}</span>
                                {e.reason && <span className="w-full text-xs text-gray-500">{e.reason}</span>}
                            </li>
                        ))}
                    </ul>
                </details>
            )}
        </div>
    );
};

export default MonthsPanel;
