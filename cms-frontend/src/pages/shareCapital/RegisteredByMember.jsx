// ============================================================
// SHARES REGISTERED WITH URSB, MEMBER BY MEMBER (v1.81.0)
// Requested: "the registered shares for each shareholder can be recorded
// and the excess also tracked in individual portfolio and generally by
// the administration and treasury".
// Confirmed: the URSB figure is entered once (as at a date); every later
// allotment whose return of allotment is marked filed is added by the
// system. Excess = shares held in the system − shares registered.
//
//   RegisteredByMemberTab  — Share capital › Registered (URSB): everyone
//   MemberRegisteredCard   — a member's portfolio: their own figures
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { shareCapitalAPI } from '../../api/endpoints';
import { formatDate, getErrorMessage } from '../../utils/helpers';
import ErrorMessage from '../../components/common/ErrorMessage';
import { ExclamationTriangleIcon, CheckCircleIcon, BuildingLibraryIcon } from '@heroicons/react/24/outline';

const n = (v) => Number(v || 0).toLocaleString('en-US');

const ExcessBadge = ({ excess }) => {
    if (excess > 0) return <span className="text-xs font-semibold rounded-full px-2 py-0.5 bg-amber-50 text-amber-800">{n(excess)} not yet registered</span>;
    if (excess < 0) return <span className="text-xs font-semibold rounded-full px-2 py-0.5 bg-red-50 text-red-700">URSB shows {n(-excess)} more — check</span>;
    return <span className="text-xs font-semibold rounded-full px-2 py-0.5 bg-emerald-50 text-emerald-700">Matches</span>;
};

// ---- enter / correct a member's URSB figure --------------------------
const SetFigureModal = ({ row, onClose, onSaved }) => {
    const today = new Date().toISOString().slice(0, 10);
    const [form, setForm] = useState({
        shares: row.opening ? String(row.opening.shares) : '',
        as_at: row.opening?.as_at || today,
        note: row.opening?.note || '',
        change_reason: '',
    });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));
    const submit = async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            await shareCapitalAPI.setRegisteredForMember(row.user_id, {
                shares: parseInt(form.shares, 10), as_at: form.as_at, note: form.note || undefined,
                change_reason: row.opening ? form.change_reason : undefined,
            });
            onSaved();
        } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
    };
    return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            <div className="fixed inset-0 bg-black/40" onClick={onClose} />
            <div className="flex min-h-full items-center justify-center p-4">
                <form onSubmit={submit} className="relative bg-white dark:bg-gray-900 rounded-xl shadow-xl max-w-md w-full p-6 space-y-4">
                    <div>
                        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Shares registered with URSB — {row.name}</h2>
                        <p className="text-sm text-gray-500 mt-1">
                            Enter the number of shares URSB holds in this member's name (from the register of members, the latest annual
                            return or a URSB search) and the date that figure is as at. Allotments after that date are added automatically
                            once their return of allotment is marked as filed. This changes nothing in the company's own share register.
                        </p>
                    </div>
                    {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
                    <div className="grid grid-cols-2 gap-3">
                        <div><label className="label">Shares registered *</label>
                            <input type="number" min="0" step="1" className="input" value={form.shares} onChange={set('shares')} required /></div>
                        <div><label className="label">As at *</label>
                            <input type="date" className="input" max={today} value={form.as_at} onChange={set('as_at')} required /></div>
                    </div>
                    <div><label className="label">Where the figure comes from</label>
                        <input className="input" maxLength={300} value={form.note} onChange={set('note')} placeholder="e.g. Annual return 2025, filed 30 Jan 2026" /></div>
                    {row.opening && (
                        <div><label className="label">Why is it being changed? *</label>
                            <textarea className="input" rows={2} value={form.change_reason} onChange={set('change_reason')} required
                                placeholder="e.g. Corrected after a URSB search" />
                            <p className="text-xs text-gray-400 mt-1">The current figure ({n(row.opening.shares)} as at {formatDate(row.opening.as_at)}) is kept in the history.</p>
                        </div>
                    )}
                    <div className="flex justify-end gap-2">
                        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
                        <button type="submit" className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
                    </div>
                </form>
            </div>
        </div>
    );
};

// ---- the whole company -------------------------------------------------
export const RegisteredByMemberTab = ({ canEdit }) => {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [editing, setEditing] = useState(null);
    const load = useCallback(async () => {
        try { setData((await shareCapitalAPI.getRegisteredByMember()).data.data); } catch (err) { setError(getErrorMessage(err)); }
    }, []);
    useEffect(() => { load(); }, [load]);
    if (!data) return <div className="card"><p className="text-sm text-gray-400">{error || 'Loading…'}</p></div>;
    const t = data.totals;
    const tiles = [
        ['Shares held (company register)', n(t.held)],
        ['Registered with URSB (members)', n(t.registered)],
        ['Not yet registered', n(t.excess), t.excess > 0 ? 'text-amber-700' : ''],
        ['Awaiting a return of allotment', n(t.awaiting_filing), t.overdue_returns ? 'text-red-700' : ''],
    ];
    return (
        <div className="space-y-4">
            {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                {tiles.map(([label, v, cls]) => (
                    <div key={label} className="card !p-4">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{label}</p>
                        <p className={`text-2xl font-bold tabular-nums ${cls || 'text-gray-900 dark:text-gray-100'}`}>{v}</p>
                    </div>
                ))}
            </div>
            {data.company_registered != null && data.company_difference !== 0 && (
                <p className="text-sm text-amber-800 bg-amber-50 rounded-lg px-3 py-2 flex gap-2">
                    <ExclamationTriangleIcon className="h-5 w-5 flex-shrink-0" />
                    <span>The members' registered shares add up to {n(t.registered)}, but the company's registered shares (Overview › Registered values)
                        are {n(data.company_registered)} — a difference of {n(Math.abs(data.company_difference))}.
                        {t.missing_opening ? ` ${t.missing_opening} member(s) have no URSB figure entered yet.` : ''}</span>
                </p>
            )}
            {t.overdue_returns > 0 && (
                <p className="text-sm text-red-700 bg-red-50 rounded-lg px-3 py-2">
                    {t.overdue_returns} return(s) of allotment are past their URSB filing date — Allotments &amp; Returns.
                </p>
            )}
            <div className="card !p-0 overflow-x-auto">
                <table className="min-w-full text-sm">
                    <thead>
                        <tr className="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-gray-200 dark:border-gray-700">
                            <th className="px-4 py-3">Member</th>
                            <th className="px-4 py-3 text-right">Held</th>
                            <th className="px-4 py-3 text-right">Registered</th>
                            <th className="px-4 py-3">Excess</th>
                            <th className="px-4 py-3">URSB figure</th>
                            <th className="px-4 py-3">Awaiting filing</th>
                            {canEdit && <th className="px-4 py-3" />}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                        {data.members.map(r => (
                            <tr key={r.user_id} className={r.is_active ? '' : 'opacity-60'}>
                                <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100">{r.name}</td>
                                <td className="px-4 py-3 text-right tabular-nums">{n(r.shares_held)}</td>
                                <td className="px-4 py-3 text-right tabular-nums">{n(r.registered)}</td>
                                <td className="px-4 py-3"><ExcessBadge excess={r.excess} /></td>
                                <td className="px-4 py-3 text-xs text-gray-500">
                                    {r.opening
                                        ? <>{n(r.opening.shares)} as at {formatDate(r.opening.as_at)}{r.added_since ? ` + ${n(r.added_since)} filed since` : ''}{r.opening.note && <span className="block text-gray-400">{r.opening.note}</span>}</>
                                        : <span className="text-amber-700">Not entered yet{r.added_since ? ` (${n(r.added_since)} filed)` : ''}</span>}
                                </td>
                                <td className="px-4 py-3 text-xs">
                                    {r.awaiting_filing
                                        ? <span className={r.overdue_returns ? 'text-red-700 font-semibold' : 'text-gray-600'}>{n(r.awaiting_filing)} shares{r.next_return_due ? ` · due ${formatDate(r.next_return_due)}` : ''}{r.overdue_returns ? ' · overdue' : ''}</span>
                                        : <span className="text-gray-400">—</span>}
                                </td>
                                {canEdit && (
                                    <td className="px-4 py-3 text-right">
                                        <button type="button" className="text-sm text-primary-700 hover:underline whitespace-nowrap" onClick={() => setEditing(r)}>
                                            {r.opening ? 'Correct' : 'Enter URSB figure'}
                                        </button>
                                    </td>
                                )}
                            </tr>
                        ))}
                        {data.members.length === 0 && <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-400">No shareholders yet.</td></tr>}
                    </tbody>
                </table>
            </div>
            <p className="text-xs text-gray-400">
                Registered = the URSB figure as at its date + allotments after that date whose return of allotment is marked filed
                (Allotments &amp; Returns). Excess = shares held in the company's own register − registered.
            </p>
            {editing && <SetFigureModal row={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
        </div>
    );
};

// ---- one member's portfolio ---------------------------------------------
export const MemberRegisteredCard = ({ userId }) => {
    const [d, setD] = useState(null);
    const [hidden, setHidden] = useState(false);
    useEffect(() => {
        if (!userId) return;
        shareCapitalAPI.getRegisteredForMember(userId)
            .then(r => setD(r.data.data))
            .catch(() => setHidden(true)); // not available (older database / no access) — leave it out
    }, [userId]);
    if (hidden || !d) return null;
    if (!d.shares_held && !d.registered) return null;
    return (
        <div className="card mb-6">
            <div className="flex items-center gap-2 mb-3">
                <BuildingLibraryIcon className="h-5 w-5 text-primary-700" />
                <h3 className="section-title mb-0">Shares registered with URSB</h3>
            </div>
            <div className="grid grid-cols-3 gap-3">
                <div><p className="text-xs text-gray-400">Held</p><p className="text-xl font-bold tabular-nums">{n(d.shares_held)}</p></div>
                <div><p className="text-xs text-gray-400">Registered</p><p className="text-xl font-bold tabular-nums">{n(d.registered)}</p></div>
                <div><p className="text-xs text-gray-400">Excess</p><p className={`text-xl font-bold tabular-nums ${d.excess > 0 ? 'text-amber-700' : d.excess < 0 ? 'text-red-700' : 'text-emerald-700'}`}>{n(d.excess)}</p></div>
            </div>
            <p className="text-xs text-gray-500 mt-3 flex items-start gap-1.5">
                {d.excess === 0 ? <CheckCircleIcon className="h-4 w-4 text-emerald-600 flex-shrink-0" /> : <ExclamationTriangleIcon className="h-4 w-4 text-amber-600 flex-shrink-0" />}
                <span>
                    {d.excess > 0 && `${n(d.excess)} of your shares are not yet registered with URSB${d.awaiting_filing ? ` — ${n(d.awaiting_filing)} are waiting for the company to file the return of allotment${d.next_return_due ? ` (due ${formatDate(d.next_return_due)})` : ''}` : ''}. They are fully yours in the company's register meanwhile.`}
                    {d.excess === 0 && 'All your shares are registered with URSB.'}
                    {d.excess < 0 && 'URSB shows more shares in your name than the company\'s register — the Secretary will check this.'}
                    {!d.opening_recorded && ' (The URSB figure for you has not been entered yet; filed allotments only.)'}
                </span>
            </p>
        </div>
    );
};
