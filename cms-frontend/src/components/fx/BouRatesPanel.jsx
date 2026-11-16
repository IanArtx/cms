// ============================================================
// BANK OF UGANDA RATES PANEL (v1.83.0) — Money › Accounts
//
// Every weekday the system reads Bank of Uganda's daily rates (since v1.87.1 the "Daily Exchange Rate Cards" file; before, the "OPENING RATES" table)
// (bou.or.ug) and SUGGESTS that day's rate for each of the company's
// currencies. Nothing enters the books by itself: the Treasurer,
// Assistant Treasurer or an Admin approves (or rejects, with a reason)
// each suggestion here. An approved rate is recorded with its source —
// "Bank of Uganda, approved by …".
//
// A rate entered by hand is never replaced: if a rate is already on
// file for that date the suggestion is closed as "hand-entered rate
// kept" (it stays visible for comparison).
//
// Flagged suggestions (moved more than the jump limit from the rate on
// file, disagree with the backup source, or the table is old) need the
// "I have checked this rate" tick before they can be approved, and are
// never included in "Approve all".
//
// Opened directly by notifications through /accounts?fx=bou.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import {
    ArrowPathIcon, BuildingLibraryIcon, CheckIcon, ChevronDownIcon, ChevronUpIcon,
    ExclamationTriangleIcon, XMarkIcon,
} from '@heroicons/react/24/outline';
import { exchangeRatesAPI } from '../../api/endpoints';
import { getErrorMessage } from '../../utils/helpers';
import ErrorMessage from '../common/ErrorMessage';

const n = (v, d = 2) => (v === null || v === undefined || v === '' ? '—'
    : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const when = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};
const SOURCE = { BOU: 'Bank of Uganda', ALLRATESTODAY: 'AllRatesToday (BoU table)' };
const STATUS = {
    PENDING: { label: 'Waiting', cls: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200' },
    APPROVED: { label: 'Approved', cls: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200' },
    REJECTED: { label: 'Rejected', cls: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200' },
    KEPT_MANUAL: { label: 'Hand-entered rate kept', cls: 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-200' },
    SUPERSEDED: { label: 'Superseded', cls: 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-200' },
};
const RUN = {
    NEW_SUGGESTIONS: 'new rates to approve', NOTHING_NEW: 'nothing new', FAILED: 'could not read the rates', SWITCHED_OFF: 'switched off',
};

const Badge = ({ status }) => (
    <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS[status]?.cls || ''}`}>{STATUS[status]?.label || status}</span>
);

// ------------------------------------------------------------
// v1.88.0 — the history, quieter: decisions as a tidy rate list (date,
// rate, change, who), checks grouped by day with a coloured dot per
// check; "nothing new" checks are one faint line, the details on hover.
// ------------------------------------------------------------
const DOT = { NEW_SUGGESTIONS: 'bg-emerald-500', NOTHING_NEW: 'bg-gray-300 dark:bg-gray-600', FAILED: 'bg-red-500', SWITCHED_OFF: 'bg-amber-400' };
const dayLabel = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString([], { weekday: 'short', day: '2-digit', month: 'short' });
};
const timeLabel = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};
const shortDate = (ymd) => {
    const d = new Date(`${String(ymd).slice(0, 10)}T12:00:00`);
    return Number.isNaN(d.getTime()) ? ymd : d.toLocaleDateString([], { day: '2-digit', month: 'short', year: '2-digit' });
};
const firstName = (full) => String(full || '').trim().split(/\s+/)[0] || '';

const FxHistory = ({ recent, runs }) => {
    const days = [];
    for (const r of runs) {
        const key = dayLabel(r.run_at);
        let g = days.find(x => x.key === key);
        if (!g) { g = { key, items: [] }; days.push(g); }
        g.items.push(r);
    }
    return (
        <div className="mt-3 grid grid-cols-1 lg:grid-cols-2 gap-6 text-xs">
            <section aria-label="Decisions">
                <p className="text-[11px] uppercase tracking-wide text-gray-400 mb-2">Decisions</p>
                {recent.length === 0 ? <p className="text-gray-400">None yet.</p> : (
                    <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                        {recent.map(s => {
                            const ch = s.change_pct === null || s.change_pct === undefined ? null : Number(s.change_pct);
                            const other = s.status !== 'APPROVED';
                            return (
                                <li key={s.id} className="py-1.5">
                                    <div className="flex items-baseline gap-3">
                                        <span className="w-20 shrink-0 text-gray-500 dark:text-gray-400 tabular-nums">{shortDate(s.rate_date)}</span>
                                        <span className="flex-1 min-w-0 font-medium text-gray-800 dark:text-gray-100 tabular-nums">
                                            {s.base_currency_code} {n(s.rate, 4)}
                                        </span>
                                        {ch !== null && Number.isFinite(ch) && (
                                            <span className={`w-14 text-right tabular-nums ${ch > 0 ? 'text-emerald-600 dark:text-emerald-400' : ch < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-gray-400'}`}>
                                                {ch > 0 ? '▲' : ch < 0 ? '▼' : ''}{Math.abs(ch).toFixed(2)}%
                                            </span>
                                        )}
                                        <span className="w-24 text-right truncate text-gray-400" title={s.decided_by_name || ''}>
                                            {other ? <Badge status={s.status} /> : firstName(s.decided_by_name)}
                                        </span>
                                    </div>
                                    {s.decision_note && <p className="ml-[5.75rem] mt-0.5 text-[11px] text-gray-400 leading-snug">{s.decision_note}</p>}
                                </li>
                            );
                        })}
                    </ul>
                )}
            </section>
            <section aria-label="Checks">
                <p className="text-[11px] uppercase tracking-wide text-gray-400 mb-2">Checks</p>
                {days.length === 0 ? <p className="text-gray-400">None yet.</p> : (
                    <div className="space-y-2.5">
                        {days.map(g => (
                            <div key={g.key}>
                                <p className="text-gray-500 dark:text-gray-400 mb-1">{g.key}</p>
                                <ul className="space-y-1 border-l border-gray-100 dark:border-gray-800 ml-1 pl-3">
                                    {g.items.map(r => (
                                        <li key={r.id} className="flex items-start gap-2" title={r.message || ''}>
                                            <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${DOT[r.status] || 'bg-gray-300'}`} />
                                            <span className="w-11 shrink-0 tabular-nums text-gray-400">{timeLabel(r.run_at)}</span>
                                            <span className={`min-w-0 ${r.status === 'NOTHING_NEW' ? 'text-gray-400' : 'text-gray-700 dark:text-gray-200'}`}>
                                                {r.status === 'NEW_SUGGESTIONS' ? (r.message || RUN[r.status]).replace(/^Bank of Uganda rates for [0-9-]+: /, 'New: ') : RUN[r.status] || r.status}
                                                {r.trigger === 'BY_HAND' && <span className="text-gray-400"> · by {firstName(r.run_by_name) || 'hand'}</span>}
                                                {r.status === 'FAILED' && r.message && <span className="block text-[11px] text-rose-500/80 leading-snug">{r.message}</span>}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        ))}
                    </div>
                )}
            </section>
        </div>
    );
};

// ---- one waiting suggestion ----
const SuggestionCard = ({ s, canDecide, onDone }) => {
    const [checked, setChecked] = useState(false);
    const [rejecting, setRejecting] = useState(false);
    const [reason, setReason] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    const approve = async () => {
        setBusy(true); setError(null);
        try {
            const r = await exchangeRatesAPI.approveSuggestion(s.id, { confirm_flagged: s.flagged ? checked : undefined });
            onDone(r.data.message);
        } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
    };
    const reject = async () => {
        setBusy(true); setError(null);
        try {
            const r = await exchangeRatesAPI.rejectSuggestion(s.id, { reason });
            onDone(r.data.message);
        } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
    };
    const change = s.change_pct !== null && s.change_pct !== undefined ? parseFloat(s.change_pct) : null;

    return (
        <div className={`rounded-lg border p-3 ${s.flagged ? 'border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-900/20' : 'border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900'}`}
            data-testid="bou-suggestion">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm text-gray-500 dark:text-gray-400">
                    <span className="font-semibold text-gray-900 dark:text-gray-100">{s.base_currency_code} → {s.target_currency_code}</span>
                    {' '}· {s.rate_date}
                </p>
                <Badge status={s.status} />
            </div>
            <p className="mt-1 text-xl font-bold text-gray-900 dark:text-gray-100">
                1 {s.base_currency_code} = {n(s.rate, 4)} {s.target_currency_code}
                <span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">middle rate</span>
            </p>
            <div className="mt-1 grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-1 text-xs text-gray-600 dark:text-gray-300">
                <span>Buying: {n(s.buying_rate, 2)}</span>
                <span>Selling: {n(s.selling_rate, 2)}</span>
                <span>On file before: {n(s.previous_rate, 2)}</span>
                <span className={change !== null && Math.abs(change) > 0 ? (change > 0 ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400') : ''}>
                    Change: {change === null ? '—' : `${change >= 0 ? '+' : ''}${n(change, 2)} %`}
                </span>
                {s.cross_check_rate && <span className="col-span-2 sm:col-span-4">Cross-check (AllRatesToday): {n(s.cross_check_rate, 4)}</span>}
            </div>
            <p className="mt-1 text-[11px] text-gray-400">Source: {SOURCE[s.source] || s.source} — {s.source_detail}</p>
            {s.flagged && (
                <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-900 dark:text-amber-100">
                    <ExclamationTriangleIcon className="h-4 w-4 flex-shrink-0" />
                    <span><strong>Please check:</strong> {s.flag_reason}.</span>
                </p>
            )}
            {error && <div className="mt-2"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}
            {canDecide && !rejecting && (
                <div className="mt-3 flex flex-wrap items-center gap-3">
                    {s.flagged && (
                        <label className="flex items-center gap-2 text-sm">
                            <input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} />
                            I have checked this rate
                        </label>
                    )}
                    <button type="button" className="btn-primary text-sm flex items-center gap-1.5"
                        disabled={busy || (s.flagged && !checked)} onClick={approve}>
                        <CheckIcon className="h-4 w-4" /> Approve
                    </button>
                    <button type="button" className="btn-secondary text-sm flex items-center gap-1.5" disabled={busy} onClick={() => setRejecting(true)}>
                        <XMarkIcon className="h-4 w-4" /> Reject
                    </button>
                </div>
            )}
            {canDecide && rejecting && (
                <div className="mt-3 space-y-2">
                    <input className="input text-sm" value={reason} onChange={e => setReason(e.target.value)}
                        placeholder="Why is this rate rejected? (e.g. the bank used another rate)" autoFocus />
                    <div className="flex gap-3">
                        <button type="button" className="btn-danger text-sm" disabled={busy || reason.trim().length < 3} onClick={reject}>Reject rate</button>
                        <button type="button" className="btn-secondary text-sm" onClick={() => { setRejecting(false); setReason(''); }}>Cancel</button>
                    </div>
                </div>
            )}
        </div>
    );
};

const BouRatesPanel = ({ canDecide, onRatesChanged, focus = false }) => {
    const [feed, setFeed] = useState(null);
    const [pending, setPending] = useState([]);
    const [recent, setRecent] = useState([]);
    const [showMore, setShowMore] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null);
    const ref = useRef(null);

    const load = useCallback(async () => {
        try {
            const [f, p, r] = await Promise.all([
                exchangeRatesAPI.getFeed(),
                exchangeRatesAPI.getSuggestions({ status: 'PENDING' }),
                exchangeRatesAPI.getSuggestions({ status: 'ALL', limit: 20 }),
            ]);
            setFeed(f.data.data);
            setPending(p.data.data || []);
            setRecent((r.data.data || []).filter(x => x.status !== 'PENDING'));
        } catch (err) {
            // An older server without the feed: show nothing.
            if (err?.response?.status === 404) setFeed(false); else setError(getErrorMessage(err));
        }
    }, []);

    useEffect(() => { load(); }, [load]);
    useEffect(() => {
        if (focus && feed && ref.current) ref.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, [focus, feed]);

    if (feed === false) return null;

    const done = (message) => { setNotice(message); load(); if (onRatesChanged) onRatesChanged(); };
    // v1.86.2 — the server tries BoU up to 3 times (5 and 10 s apart) if its website hiccups
    const runNow = async () => {
        setBusy('check'); setError(null); setNotice(null);
        try { const r = await exchangeRatesAPI.runFeed(); done(r.data.message || 'Checked.'); } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
    };
    const approveAll = async () => {
        setBusy(true); setError(null); setNotice(null);
        try { const r = await exchangeRatesAPI.approveAll(); done(r.data.message); } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
    };
    const lastRun = feed?.runs?.[0];
    const unflagged = pending.filter(s => !s.flagged).length;

    return (
        <div className="card mb-6" ref={ref} id="bou-rates" data-tour="bou-rates">
            <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
                <div className="flex items-center gap-3">
                    <div className="p-3 rounded-xl bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
                        <BuildingLibraryIcon className="h-6 w-6" />
                    </div>
                    <div>
                        <p className="text-sm font-medium text-gray-500 dark:text-gray-400">Bank of Uganda daily rates</p>
                        <p className="text-xs text-gray-400">
                            Suggested from bou.or.ug, approved by a person. Rates entered by hand are never replaced.
                        </p>
                    </div>
                </div>
                {canDecide && (
                    <div className="flex flex-wrap gap-2">
                        {unflagged > 1 && (
                            <button type="button" className="btn-primary text-sm flex items-center gap-1.5" disabled={!!busy} onClick={approveAll}>
                                <CheckIcon className="h-4 w-4" /> Approve all not flagged ({unflagged})
                            </button>
                        )}
                        <button type="button" className="btn-secondary text-sm flex items-center gap-1.5" disabled={!!busy} onClick={runNow}>
                            <ArrowPathIcon className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} />
                            {busy === 'check' ? 'Checking… (up to a minute if BoU is slow)' : 'Check BoU now'}
                        </button>
                    </div>
                )}
            </div>

            {error && <div className="mb-3"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}
            {notice && (
                <p className="mb-3 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-800 dark:bg-green-900/30 dark:text-green-200">
                    {notice}
                </p>
            )}

            {feed && (
                <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
                    {feed.settings.enabled ? `Checked ${feed.schedule}.` : 'The daily check is switched off (Settings › Currencies) — "Check BoU now" still works.'}
                    {lastRun && <> Last check {when(lastRun.run_at)}{lastRun.run_by_name ? ` by ${lastRun.run_by_name}` : ''}: {RUN[lastRun.status] || lastRun.status}.</>}
                    {feed.settings.backupConfigured ? ' Backup source: AllRatesToday (cross-check).' : ''}
                </p>
            )}
            {lastRun && lastRun.status === 'FAILED' && (
                <p className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-800 dark:bg-red-900/30 dark:text-red-200">
                    {lastRun.message}
                </p>
            )}

            {pending.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-3">No rates waiting for approval.</p>
            ) : (
                <div className="space-y-3">
                    {pending.map(s => <SuggestionCard key={s.id} s={s} canDecide={canDecide} onDone={done} />)}
                </div>
            )}

            {(recent.length > 0 || (feed?.runs || []).length > 0) && (
                <div className="mt-4">
                    <button type="button" className="flex items-center gap-1 text-xs font-semibold text-gray-500 dark:text-gray-400"
                        onClick={() => setShowMore(v => !v)} aria-expanded={showMore}>
                        {showMore ? <ChevronUpIcon className="h-4 w-4" /> : <ChevronDownIcon className="h-4 w-4" />}
                        Earlier decisions and check log
                    </button>
                    {showMore && <FxHistory recent={recent} runs={feed?.runs || []} />}
                </div>
            )}
        </div>
    );
};

export default BouRatesPanel;
