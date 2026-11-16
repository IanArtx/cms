// ============================================================
// MEETINGS — CORRECTIONS AND WHO SIGNS (v1.88.0)
//
// "i am able to record and edit the meetings despite the fact that the
// meeting was in past and also be able to appoint proxies and signature
// staff"
//
//   CorrectionBar    — shown while a CLOSED meeting is being corrected:
//                      the reason is typed once and goes with every change
//                      (details, register, proxies, resolutions, votes).
//   AmendmentHistory — every correction made after the meeting closed:
//                      when, who, what, why.
//   SignatoriesCard  — who signs this meeting's minutes, resolutions,
//                      register, notice and certified copies. Documents
//                      generated from then on use them.
// ============================================================

import { useState } from 'react';
import { meetingsAPI } from '../../api/endpoints';
import { formatDateTime, getErrorMessage } from '../../utils/helpers';
import { useDirectory } from './meetingUi';
import { PencilSquareIcon, ClockIcon } from '@heroicons/react/24/outline';

export const CorrectionBar = ({ reason, setReason, onDone }) => {
    const ok = reason.trim().length >= 5;
    return (
        <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 p-4">
            <div className="flex items-start gap-3 flex-wrap">
                <PencilSquareIcon className="h-5 w-5 text-amber-700 mt-0.5 flex-shrink-0" />
                <div className="flex-1 min-w-[16rem]">
                    <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">Correcting a closed meeting</p>
                    <p className="text-xs text-amber-800 dark:text-amber-300 mb-2">
                        Say why it is being corrected. While this bar is open you can change the details, the register, proxies,
                        resolutions and votes; each change is kept in the meeting's history with this reason. Documents already
                        generated stay as they are — generate them again afterwards.
                    </p>
                    <input className="input" value={reason} onChange={e => setReason(e.target.value)} maxLength={1000}
                        placeholder="e.g. Attendance taken from the signed paper register; Mary was present" />
                    {!ok && <p className="text-[11px] text-amber-700 mt-1">At least 5 characters — the editing buttons appear once the reason is given.</p>}
                </div>
                <button type="button" className="btn-secondary text-sm" onClick={onDone}>Done</button>
            </div>
        </div>
    );
};

export const AmendmentHistory = ({ items }) => {
    if (!items || !items.length) return null;
    return (
        <div className="card mt-6">
            <h3 className="section-title mb-3 flex items-center gap-2"><ClockIcon className="h-5 w-5 text-gray-400" />Corrections after the meeting closed</h3>
            <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                {items.map(a => (
                    <li key={a.id} className="py-2 text-sm">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                            <span className="font-medium text-gray-900 dark:text-gray-100">{a.what}</span>
                            <span className="text-xs text-gray-400">{formatDateTime(a.changed_at)} · {a.changed_by_name || '—'}</span>
                        </div>
                        <p className="text-xs text-gray-600 dark:text-gray-300 mt-0.5">Reason: {a.reason}</p>
                        <Details d={a.details} />
                    </li>
                ))}
            </ul>
        </div>
    );
};

const show = (v) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const Details = ({ d }) => {
    if (!d || typeof d !== 'object') return null;
    if (d.before && d.after && typeof d.before === 'object') {
        const keys = Object.keys(d.after).filter(k => show(d.before[k]) !== show(d.after[k]));
        if (!keys.length) return null;
        return (
            <p className="text-[11px] text-gray-400 mt-0.5">
                {keys.map(k => `${k.replace(/_/g, ' ')}: ${show(d.before[k])} → ${show(d.after[k])}`).join(' · ')}
            </p>
        );
    }
    if (d.before !== undefined && d.after !== undefined) {
        return <p className="text-[11px] text-gray-400 mt-0.5">{d.name ? `${d.name}: ` : ''}{show(d.before)} → {show(d.after)}</p>;
    }
    const parts = Object.entries(d).filter(([k]) => !['changes'].includes(k)).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${show(v)}`);
    return parts.length ? <p className="text-[11px] text-gray-400 mt-0.5">{parts.join(' · ')}</p> : null;
};

const DOC_LABEL = { MINUTES: 'Minutes', RESOLUTION: 'Resolutions', REGISTER: 'Register of attendance', NOTICE: 'Notice', CERTIFIED: 'Certified copies' };

export const SignatoriesCard = ({ v, reload, setNotice, setError }) => {
    const people = useDirectory();
    const rows = v.signatories || [];
    const [edit, setEdit] = useState(false);
    const [draft, setDraft] = useState({});
    const [busy, setBusy] = useState(false);
    if (!rows.length) return null;
    const general = v.meeting.meeting_type !== 'BOARD';
    const start = () => {
        const d = {};
        for (const r of rows) d[r.role] = r.chosen ? String(r.user_id) : '';
        setDraft(d); setEdit(true);
    };
    const save = async () => {
        setBusy(true);
        try {
            const sig = {};
            for (const r of rows) sig[r.role] = draft[r.role] ? Number(draft[r.role]) : null;
            const res = await meetingsAPI.setSignatories(v.meeting.id, { signatories: sig });
            setNotice(res.data.message); setEdit(false); await reload();
        } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
    };
    const groups = [...new Set(rows.map(r => r.doc))];
    return (
        <div className="card mb-6">
            <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
                <div>
                    <h3 className="section-title mb-0">Who signs this meeting's documents</h3>
                    <p className="text-xs text-gray-500">
                        Used when the documents are generated (they can still be changed for one document). Left as default:
                        the meeting's chairperson and secretary.{general ? ' A certified copy is certified by a director.' : ''}
                    </p>
                </div>
                {!edit
                    ? <button type="button" className="btn-secondary text-sm" onClick={start}>Choose signers</button>
                    : <div className="flex gap-2"><button type="button" className="btn-secondary text-sm" onClick={() => setEdit(false)}>Cancel</button><button type="button" className="btn-primary text-sm" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></div>}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3">
                {groups.map(g => (
                    <div key={g}>
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-1">{DOC_LABEL[g] || g}</p>
                        {rows.filter(r => r.doc === g).map(r => (
                            <div key={r.role} className="flex items-center justify-between gap-2 py-1 text-sm">
                                <span className="text-gray-600 dark:text-gray-300 min-w-0">{r.label.replace(/^[^—]+—\s*/, '')}</span>
                                {edit ? (
                                    <select className="input py-1 text-sm max-w-[13rem]" value={draft[r.role] || ''}
                                        onChange={e => setDraft(d => ({ ...d, [r.role]: e.target.value }))}>
                                        <option value="">{r.as === 'director' ? '— choose when generating —' : '— default —'}</option>
                                        {people.map(p => <option key={p.id} value={p.id}>{`${p.first_name || ''} ${p.last_name || ''}`.trim() || p.name}</option>)}
                                    </select>
                                ) : (
                                    <span className={`text-right ${r.chosen ? 'font-medium text-gray-900 dark:text-gray-100' : 'text-gray-400'}`}>
                                        {r.name || '—'}{!r.chosen && r.name ? ' (default)' : ''}
                                    </span>
                                )}
                            </div>
                        ))}
                    </div>
                ))}
            </div>
        </div>
    );
};
