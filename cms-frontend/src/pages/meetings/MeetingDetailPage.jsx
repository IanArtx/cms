// ============================================================
// MEETING PAGE (v1.79.0) — /meetings/:id
// One AGM / EGM / board meeting from start to finish:
//   1. Details & notice — check the notice period, issue the notice
//      (members are told by notification and email)
//   2. Attendance       — the register: everyone entitled is listed;
//      the secretary marks each person and every attendee confirms
//      digitally from his or her own account; quorum shown live
//   3. Resolutions      — propose, then record the show of hands
//   4. Minutes          — written per agenda item
//   5. Documents        — notice, proxy form, register, minutes,
//      resolutions and certified copies in the standard form
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { meetingsAPI } from '../../api/endpoints';
import { formatDate, formatDateTime, getErrorMessage, getUploadUrl } from '../../utils/helpers';
import { useTabParam } from '../../hooks/useTabParam';
import PageHeader from '../../components/common/PageHeader';
import ErrorMessage from '../../components/common/ErrorMessage';
import {
    MeetingStatus, ResultBadge, FilingBadge, Modal, MeetingFormModal, ResolutionFormModal, StatutoryDocButtons,
    PersonSelect, useDirectory, MEETING_TYPE_LABEL, KIND_LABEL, ATTENDANCE_LABEL, hhmm,
} from './meetingUi';
import { CheckCircleIcon, ExclamationTriangleIcon, ArrowPathIcon } from '@heroicons/react/24/outline';

const nowHHMM = () => {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const todayStr = () => {
    const d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

// Earliest meeting date if the notice went out today.
const earliestDate = (days) => {
    const d = new Date();
    d.setDate(d.getDate() + Number(days || 0));
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

const Kv = ({ label, children }) => (
    <div>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{label}</p>
        <p className="text-sm text-gray-900 mt-0.5">{children || '—'}</p>
    </div>
);

// ------------------------------------------------------------
// Details & notice
// ------------------------------------------------------------
const OverviewTab = ({ v }) => {
    const m = v.meeting;
    const n = v.notice;
    const t = v.tally;
    return (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="card lg:col-span-2">
                <h3 className="section-title mb-4">Details</h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                    <Kv label="Type">{MEETING_TYPE_LABEL[m.meeting_type]}</Kv>
                    <Kv label="Date">{formatDate(m.meeting_date)}</Kv>
                    <Kv label="Time">{hhmm(m.start_time)}{m.end_time ? ` – ${hhmm(m.end_time)}` : ''}</Kv>
                    <Kv label="Venue">{m.mode === 'VIRTUAL' ? 'Online' : m.venue}{m.mode === 'HYBRID' ? ' + online' : ''}</Kv>
                    <Kv label="Chairperson">{m.chairperson_name}</Kv>
                    <Kv label="Secretary">{m.secretary_name}</Kv>
                    {m.financial_year && <Kv label="Accounts for">{m.financial_year}</Kv>}
                    <Kv label="Reference"><span className="font-mono text-xs">{m.reference_code}</span></Kv>
                    {m.virtual_link && <Kv label="Online link"><a href={m.virtual_link} target="_blank" rel="noreferrer" className="text-primary-700 underline break-all">{m.virtual_link}</a></Kv>}
                </div>
                <h3 className="section-title mt-6 mb-3">Agenda</h3>
                <ol className="list-decimal ml-5 space-y-1.5">
                    {(m.agenda || []).map(a => (
                        <li key={a.no} className="text-sm text-gray-800">
                            {a.title}
                            {a.business === 'SPECIAL' && <span className="badge badge-purple ml-2">special business</span>}
                        </li>
                    ))}
                </ol>
            </div>
            <div className="space-y-6">
                <div className="card">
                    <h3 className="section-title mb-3">Notice</h3>
                    <div className="space-y-2 text-sm">
                        <p>Required: <strong>{n.required} days</strong>{m.has_special_business && m.meeting_type !== 'BOARD' ? ' (special business)' : ''}</p>
                        {n.issued ? (
                            <p>Issued {formatDateTime(m.notice_issued_at)} — <strong>{m.notice_days_given ?? n.given} days</strong> before the meeting</p>
                        ) : (
                            <p>Not issued yet. To give full notice, issue it on or before <strong>{formatDate(n.latest_issue_date)}</strong>.</p>
                        )}
                        {n.short_notice_consent && <p className="text-xs bg-yellow-50 text-yellow-800 rounded px-2 py-1">Short notice by consent: {m.short_notice_note}</p>}
                        <p className="flex items-center gap-1.5">
                            {n.compliant ? <CheckCircleIcon className="h-5 w-5 text-green-600" /> : <ExclamationTriangleIcon className="h-5 w-5 text-amber-500" />}
                            {n.compliant ? 'Notice requirement met' : 'Notice period not met'}
                        </p>
                    </div>
                </div>
                <div className="card">
                    <h3 className="section-title mb-3">Quorum</h3>
                    <p className="text-3xl font-bold text-gray-900">{t.present}<span className="text-base font-normal text-gray-400"> / {t.quorum_required} needed</span></p>
                    <p className={`text-sm mt-1 ${t.quorum_met ? 'text-green-700' : 'text-amber-700'}`}>{t.quorum_met ? 'Quorum present' : 'No quorum yet'}</p>
                    <p className="text-xs text-gray-500 mt-2">{t.in_person} in person · {t.online} online · {t.by_proxy} by proxy · {t.apologies} apologies · {t.entitled} entitled</p>
                    {m.meeting_type !== 'BOARD' && t.shares_total > 0 && <p className="text-xs text-gray-500 mt-1">{t.shares_present_pct}% of the shares represented</p>}
                    <p className="text-xs text-gray-500 mt-1">{t.voters} may vote on a show of hands</p>
                </div>
            </div>
        </div>
    );
};

// ------------------------------------------------------------
// Attendance (the register)
// ------------------------------------------------------------
const AttendanceTab = ({ v, canManage, reload, setError }) => {
    const m = v.meeting;
    const people = useDirectory();
    const [busy, setBusy] = useState(null);
    const [proxyFor, setProxyFor] = useState(null);
    const [proxyName, setProxyName] = useState('');
    const [guest, setGuest] = useState({ name: '', designation: '', user_id: null });
    const [extraPerson, setExtraPerson] = useState({ user_id: null, shares_held: '' });
    const editable = canManage && ['NOTICE_ISSUED', 'IN_PROGRESS'].includes(m.status);
    const general = m.meeting_type !== 'BOARD';
    const past = !!m.recorded_after_event;
    const saveShares = async (a, value) => {
        if (String(value) === String(a.shares_held ?? '')) return;
        setBusy(a.id);
        try { await meetingsAPI.markAttendance(m.id, a.id, { status: a.status, shares_held: value }); await reload(); } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(null); }
    };
    const addPerson = async (e) => {
        e.preventDefault();
        try {
            await meetingsAPI.addAttendee(m.id, { user_id: extraPerson.user_id, capacity: general ? 'MEMBER' : 'DIRECTOR', shares_held: extraPerson.shares_held });
            setExtraPerson({ user_id: null, shares_held: '' });
            await reload();
        } catch (err) { setError(getErrorMessage(err)); }
    };

    const mark = async (a, status, extra = {}) => {
        if (status === 'BY_PROXY' && !extra.proxy_name) { setProxyFor(a); setProxyName(a.proxy_name || ''); return; }
        setBusy(a.id);
        try { await meetingsAPI.markAttendance(m.id, a.id, { status, ...extra }); await reload(); } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(null); }
    };
    const addGuest = async (e) => {
        e.preventDefault();
        try {
            await meetingsAPI.addAttendee(m.id, { name: guest.name, designation: guest.designation, user_id: guest.user_id });
            setGuest({ name: '', designation: '', user_id: null });
            await reload();
        } catch (err) { setError(getErrorMessage(err)); }
    };
    const remove = async (a) => {
        try { await meetingsAPI.removeAttendee(m.id, a.id); await reload(); } catch (err) { setError(getErrorMessage(err)); }
    };
    const refresh = async () => {
        try { await meetingsAPI.refreshRegister(m.id); await reload(); } catch (err) { setError(getErrorMessage(err)); }
    };

    const rows = v.attendance;
    const counted = rows.filter(a => a.capacity !== 'IN_ATTENDANCE');
    const inAtt = rows.filter(a => a.capacity === 'IN_ATTENDANCE');

    const table = (list, isCounted) => (
        <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
                <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-gray-200">
                        <th className="py-2 pr-3">Name</th>
                        <th className="py-2 pr-3">Capacity</th>
                        {isCounted && general && <th className="py-2 pr-3 text-right">Shares</th>}
                        <th className="py-2 pr-3">Attendance</th>
                        <th className="py-2 pr-3">Signature (by the person)</th>
                        {editable && (!isCounted || past) && <th className="py-2" />}
                    </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                    {list.map(a => (
                        <tr key={a.id}>
                            <td className="py-2 pr-3 font-medium text-gray-900">{a.name}</td>
                            <td className="py-2 pr-3 text-gray-600">{a.designation}</td>
                            {isCounted && general && (
                                <td className="py-2 pr-3 text-right tabular-nums">
                                    {editable && past && !a.confirmed_at ? (
                                        <input type="number" min="0" className="input py-1 text-sm w-24 text-right" defaultValue={a.shares_held ?? ''}
                                            title="Shares held on the day of the meeting" disabled={busy === a.id}
                                            onBlur={e => saveShares(a, e.target.value)} />
                                    ) : (a.shares_held != null ? Number(a.shares_held).toLocaleString('en-GB') : '—')}
                                </td>
                            )}
                            <td className="py-2 pr-3">
                                {editable && !a.confirmed_at ? (
                                    <select className="input py-1 text-sm w-auto" value={a.status} disabled={busy === a.id}
                                        onChange={e => mark(a, e.target.value)}>
                                        {Object.entries(ATTENDANCE_LABEL)
                                            .filter(([k]) => k !== 'BY_PROXY' || (general && a.capacity === 'MEMBER'))
                                            .map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                                    </select>
                                ) : (
                                    <span>{ATTENDANCE_LABEL[a.status]}</span>
                                )}
                                {a.status === 'BY_PROXY' && <p className="text-xs text-gray-500 mt-0.5">Proxy: {a.proxy_name}</p>}
                            </td>
                            <td className="py-2 pr-3">
                                {a.confirmed_at ? (
                                    <span className="text-xs text-green-700 block">
                                        {a.signature_snapshot_path
                                            ? <img src={getUploadUrl(a.signature_snapshot_path)} alt={`Signature of ${a.name}`} className="h-8 max-w-[140px] object-contain bg-white" />
                                            : <CheckCircleIcon className="h-4 w-4 inline -mt-0.5 mr-1" />}
                                        {formatDateTime(a.confirmed_at)}
                                        <span className="font-mono text-gray-500 ml-1.5">{a.confirmation_code}</span>
                                    </span>
                                ) : <span className="text-xs text-gray-400">{['PRESENT', 'PRESENT_VIRTUAL'].includes(a.status) ? 'Not yet — recorded by the secretary' : '—'}</span>}
                            </td>
                            {editable && (!isCounted || past) && (
                                <td className="py-2 text-right">
                                    {!a.confirmed_at && <button type="button" className="text-xs text-red-600 hover:underline" onClick={() => remove(a)}>Remove</button>}
                                </td>
                            )}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );

    return (
        <div className="space-y-6">
            <div className="card">
                <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
                    <h3 className="section-title mb-0">{general ? 'Members' : 'Directors'} — register of attendance</h3>
                    {canManage && ['DRAFT', 'NOTICE_ISSUED'].includes(m.status) && (
                        <button type="button" className="btn-secondary text-sm" onClick={refresh}>
                            <ArrowPathIcon className="h-4 w-4 inline mr-1" />Refresh from the {general ? 'share register' : 'directors'}
                        </button>
                    )}
                </div>
                <p className="text-xs text-gray-500 mb-3">
                    {past ? (
                        <>
                            This meeting is being recorded after it took place. {general ? 'Members are listed with the shares they held on that day (from the share register) — correct the number if needed, and add anyone missing.' : 'Add or remove directors to match who was entitled to attend.'}{' '}
                            Mark who attended; each person marked present can then confirm it from their own account, and their captured signature is printed on the register.
                        </>
                    ) : (
                        <>
                            {general ? 'Everyone holding shares (and every shareholder) is listed with the shares they hold today.' : 'Every director is listed.'}{' '}
                            On the day, each person presses <strong>Confirm my attendance</strong> on this page or the dashboard — their captured
                            signature, the time and a verification code are printed on the register. The secretary can also mark people.
                        </>
                    )}
                    {m.status === 'DRAFT' && ' Attendance can be marked once the notice has been issued.'}
                </p>
                {table(counted, true)}
                {editable && past && (
                    <form onSubmit={addPerson} className="grid grid-cols-1 sm:grid-cols-[1fr_140px_auto] gap-2 mt-3">
                        <PersonSelect value={extraPerson.user_id} people={people} placeholder={`Add a ${general ? 'member' : 'director'} not listed…`}
                            onChange={id => setExtraPerson(x => ({ ...x, user_id: id }))} />
                        {general ? <input type="number" min="0" className="input" placeholder="Shares held" value={extraPerson.shares_held}
                            onChange={e => setExtraPerson(x => ({ ...x, shares_held: e.target.value }))} /> : <span />}
                        <button type="submit" className="btn-secondary" disabled={!extraPerson.user_id}>Add</button>
                    </form>
                )}
                <p className="text-sm mt-3 text-gray-700">
                    <strong>{v.tally.present}</strong> present (quorum {v.tally.quorum_required}) ·
                    {general && v.tally.shares_total > 0 ? ` ${v.tally.shares_present_pct}% of shares ·` : ''} {v.tally.voters} may vote on a show of hands
                </p>
            </div>
            <div className="card">
                <h3 className="section-title mb-3">In attendance (not counted, no vote)</h3>
                {inAtt.length ? table(inAtt, false) : <p className="text-sm text-gray-400">Nobody yet.</p>}
                {editable && (
                    <form onSubmit={addGuest} className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_1fr_auto] gap-2 mt-4">
                        <PersonSelect value={guest.user_id} people={people} placeholder="A system user…" onChange={id => setGuest(g => ({ ...g, user_id: id }))} />
                        <input className="input" placeholder="…or type a name" value={guest.name} disabled={!!guest.user_id} onChange={e => setGuest(g => ({ ...g, name: e.target.value }))} />
                        <input className="input" placeholder="Capacity, e.g. External auditor" value={guest.designation} onChange={e => setGuest(g => ({ ...g, designation: e.target.value }))} />
                        <button type="submit" className="btn-secondary">Add</button>
                    </form>
                )}
            </div>
            <Modal isOpen={!!proxyFor} onClose={() => setProxyFor(null)} title={`Proxy for ${proxyFor?.name}`}
                subtitle="The person named in the proxy form deposited at the registered office.">
                <input className="input" value={proxyName} onChange={e => setProxyName(e.target.value)} placeholder="Name of the proxy" />
                <div className="flex justify-end gap-3 mt-4">
                    <button type="button" className="btn-secondary" onClick={() => setProxyFor(null)}>Cancel</button>
                    <button type="button" className="btn-primary" disabled={!proxyName.trim()}
                        onClick={async () => { const a = proxyFor; setProxyFor(null); await mark(a, 'BY_PROXY', { proxy_name: proxyName.trim() }); }}>
                        Save
                    </button>
                </div>
            </Modal>
        </div>
    );
};

// ------------------------------------------------------------
// Resolutions and the show of hands
// ------------------------------------------------------------
const VoteModal = ({ r, voters, onClose, onDone }) => {
    const [f, setF] = useState({ votes_for: '', votes_against: '', votes_abstain: '0', chair_casting_vote: '' });
    const [error, setError] = useState(null);
    const [saving, setSaving] = useState(false);
    useEffect(() => { setF({ votes_for: '', votes_against: '', votes_abstain: '0', chair_casting_vote: '' }); setError(null); }, [r]);
    if (!r) return null;
    const tie = f.votes_for !== '' && f.votes_for === f.votes_against && r.kind !== 'SPECIAL';
    const submit = async (e) => {
        e.preventDefault();
        setSaving(true);
        setError(null);
        try {
            const res = await meetingsAPI.vote(r.id, {
                votes_for: Number(f.votes_for), votes_against: Number(f.votes_against), votes_abstain: Number(f.votes_abstain || 0),
                chair_casting_vote: tie ? (f.chair_casting_vote || null) : null,
            });
            onDone(res.data.message);
            onClose();
        } catch (err) { setError(getErrorMessage(err)); } finally { setSaving(false); }
    };
    return (
        <Modal isOpen onClose={onClose} title={`Show of hands — ${r.resolution_number}`}
            subtitle={`${voters} people present may vote. ${r.kind === 'SPECIAL' ? 'A special resolution needs at least 75% of the votes cast (abstentions are not votes cast).' : 'Carried if more votes for than against.'}`}>
            <form onSubmit={submit} className="space-y-3">
                {error && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-3">{error}</div>}
                <p className="text-sm font-medium text-gray-900">{r.title}</p>
                <div className="grid grid-cols-3 gap-3">
                    {[['votes_for', 'For'], ['votes_against', 'Against'], ['votes_abstain', 'Abstained']].map(([k, l]) => (
                        <div key={k}>
                            <label className="label">{l}</label>
                            <input type="number" min="0" className="input" value={f[k]} onChange={e => setF(x => ({ ...x, [k]: e.target.value }))} required={k !== 'votes_abstain'} />
                        </div>
                    ))}
                </div>
                {tie && (
                    <div>
                        <label className="label">The votes are equal — chairperson's casting vote</label>
                        <select className="input" value={f.chair_casting_vote} onChange={e => setF(x => ({ ...x, chair_casting_vote: e.target.value }))} required>
                            <option value="">Choose…</option>
                            <option value="FOR">For</option>
                            <option value="AGAINST">Against</option>
                        </select>
                    </div>
                )}
                <div className="flex justify-end gap-3 pt-2">
                    <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
                    <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Record the vote'}</button>
                </div>
            </form>
        </Modal>
    );
};

const ResolutionsTab = ({ v, canManage, reload, setError, setNotice }) => {
    const m = v.meeting;
    const [adding, setAdding] = useState(false);
    const [editing, setEditing] = useState(null);
    const [voting, setVoting] = useState(null);
    const canPropose = canManage && ['DRAFT', 'NOTICE_ISSUED', 'IN_PROGRESS'].includes(m.status);
    const withdraw = async (r) => {
        try { await meetingsAPI.withdraw(r.id); await reload(); } catch (err) { setError(getErrorMessage(err)); }
    };
    return (
        <div className="space-y-4">
            {canPropose && (
                <div className="flex justify-end">
                    <button type="button" className="btn-primary" onClick={() => setAdding(true)}>Propose a resolution</button>
                </div>
            )}
            {!v.resolutions.length && <div className="card"><p className="text-sm text-gray-400">No resolutions for this meeting yet.</p></div>}
            {v.resolutions.map(r => (
                <div key={r.id} className="card">
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                        <div className="min-w-0">
                            <p className="text-xs font-mono font-semibold text-primary-700">{r.resolution_number} · {KIND_LABEL[r.kind]}{r.agenda_no ? ` · agenda item ${r.agenda_no}` : ''}</p>
                            <Link to={`/meetings/resolutions/${r.id}`} className="text-base font-semibold text-gray-900 hover:underline">{r.title}</Link>
                        </div>
                        <div className="flex gap-2 items-center flex-wrap">
                            <ResultBadge result={r.result} />
                            <FilingBadge state={r.filing_state} due={r.filing_due_date} />
                        </div>
                    </div>
                    {r.preamble && <p className="text-sm text-gray-600 mt-2 italic">{r.preamble}</p>}
                    <ol className="mt-2 space-y-1">
                        {(r.clauses || []).map((c, i) => <li key={i} className="text-sm text-gray-800 font-medium">{/^that\b/i.test(c) ? c : `THAT ${c}`}</li>)}
                    </ol>
                    <p className="text-xs text-gray-500 mt-2">
                        {r.proposed_by_name ? `Proposed by ${r.proposed_by_name}` : ''}{r.seconded_by_name ? `, seconded by ${r.seconded_by_name}` : ''}
                        {r.votes_for != null ? `${r.proposed_by_name ? ' · ' : ''}${r.votes_for} for, ${r.votes_against} against, ${r.votes_abstain} abstaining${r.chair_casting_vote ? ` · casting vote ${r.chair_casting_vote.toLowerCase()}` : ''}` : ''}
                    </p>
                    {canManage && r.result === 'PENDING' && (
                        <div className="flex gap-2 mt-3 flex-wrap">
                            {m.status === 'IN_PROGRESS' && <button type="button" className="btn-primary text-sm" onClick={() => setVoting(r)}>Record the vote</button>}
                            <button type="button" className="btn-secondary text-sm" onClick={() => setEditing(r)}>Edit</button>
                            <button type="button" className="btn-secondary text-sm" onClick={() => withdraw(r)}>Withdraw</button>
                        </div>
                    )}
                </div>
            ))}
            <ResolutionFormModal isOpen={adding} mode="meeting" meeting={m} onClose={() => setAdding(false)}
                onSaved={async (_, msg) => { setNotice(msg); await reload(); }} />
            <ResolutionFormModal isOpen={!!editing} mode="edit" meeting={m} resolution={editing} onClose={() => setEditing(null)}
                onSaved={async (_, msg) => { setNotice(msg); await reload(); }} />
            {voting && <VoteModal r={voting} voters={v.tally.voters} onClose={() => setVoting(null)} onDone={async (msg) => { setNotice(msg); await reload(); }} />}
        </div>
    );
};

// ------------------------------------------------------------
// Minutes
// ------------------------------------------------------------
const MinutesTab = ({ v, canManage, reload, setError, setNotice }) => {
    const m = v.meeting;
    const editable = canManage && ['IN_PROGRESS', 'CLOSED'].includes(m.status);
    const [mins, setMins] = useState({});
    const [saving, setSaving] = useState(false);
    useEffect(() => {
        const saved = m.minutes || {};
        const items = (m.agenda || []).map(a => {
            const s = (saved.items || []).find(x => Number(x.no) === Number(a.no)) || {};
            return { no: a.no, title: a.title, discussion: s.discussion || '', decision: s.decision || '', action_by: s.action_by || '', action_due: s.action_due || '' };
        });
        setMins({ ...saved, items });
    }, [m]);

    if (!['IN_PROGRESS', 'CLOSED'].includes(m.status)) {
        return <div className="card"><p className="text-sm text-gray-500">The minutes are written once the meeting has opened.</p></div>;
    }
    const setField = (k) => (e) => setMins(x => ({ ...x, [k]: e.target.value }));
    const setItem = (i, k) => (e) => setMins(x => ({ ...x, items: x.items.map((it, j) => (j === i ? { ...it, [k]: e.target.value } : it)) }));
    const save = async () => {
        setSaving(true);
        try {
            const r = await meetingsAPI.saveMinutes(m.id, mins);
            setNotice(r.data.message);
            await reload();
        } catch (err) { setError(getErrorMessage(err)); } finally { setSaving(false); }
    };
    const area = (value, onChange, placeholder, rows = 2) => (
        editable
            ? <textarea className="input" rows={rows} value={value || ''} onChange={onChange} placeholder={placeholder} />
            : <p className="text-sm text-gray-800 whitespace-pre-wrap">{value || <span className="text-gray-400">—</span>}</p>
    );
    const board = m.meeting_type === 'BOARD';
    return (
        <div className="space-y-4">
            <div className="card space-y-4">
                <p className="text-xs text-gray-500">
                    The register (present, proxies, in attendance, apologies), the notice and quorum statement and every resolution with its
                    vote are added to the minutes automatically. Write here what was discussed and decided. Leave the opening empty to use the
                    standard sentence.
                </p>
                <div><label className="label">Opening</label>{area(mins.opening, setField('opening'), 'e.g. The Chairperson welcomed members and called the meeting to order at 10.05 a.m.')}</div>
                {board && <div><label className="label">Declarations of interest</label>{area(mins.declarations, setField('declarations'), 'e.g. None declared.')}</div>}
                <div><label className="label">Minutes of the previous meeting</label>{area(mins.previous_minutes, setField('previous_minutes'), 'e.g. The minutes of the meeting held on … were read and confirmed as a true record.')}</div>
            </div>
            {(mins.items || []).map((it, i) => (
                <div key={it.no} className="card space-y-3">
                    <p className="text-sm font-semibold text-gray-900">{it.no}. {it.title}</p>
                    <div><label className="label">Discussion</label>{area(it.discussion, setItem(i, 'discussion'), 'What was presented and discussed', 3)}</div>
                    <div><label className="label">Decision</label>{area(it.decision, setItem(i, 'decision'), 'What was agreed (resolutions are added automatically)')}</div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div><label className="label">Action by</label>{editable ? <input className="input" value={it.action_by} onChange={setItem(i, 'action_by')} /> : <p className="text-sm">{it.action_by || '—'}</p>}</div>
                        <div><label className="label">By when</label>{editable ? <input className="input" value={it.action_due} onChange={setItem(i, 'action_due')} placeholder="e.g. 30 November 2026" /> : <p className="text-sm">{it.action_due || '—'}</p>}</div>
                    </div>
                </div>
            ))}
            <div className="card space-y-4">
                <div><label className="label">Any other business</label>{area(mins.aob, setField('aob'), 'Anything raised under AOB')}</div>
                <div><label className="label">Closing</label>{area(mins.closing, setField('closing'), 'Leave empty for: "There being no other business, the Chairperson declared the meeting closed at …"')}</div>
                <div><label className="label">Next meeting</label>{area(mins.next_meeting, setField('next_meeting'), 'e.g. The next meeting will be held on …')}</div>
            </div>
            {editable && (
                <div className="flex justify-end"><button type="button" className="btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save minutes'}</button></div>
            )}
        </div>
    );
};

// ------------------------------------------------------------
// Documents
// ------------------------------------------------------------
const DocumentsTab = ({ v, canManage }) => {
    const m = v.meeting;
    const general = m.meeting_type !== 'BOARD';
    const held = ['IN_PROGRESS', 'CLOSED'].includes(m.status);
    const carried = v.resolutions.filter(r => r.result === 'CARRIED');
    const today = todayStr();
    const chair = { key: 'chairperson', label: 'Chairperson', defaultId: m.chairperson_user_id };
    const sec = { key: 'secretary', label: 'Secretary', defaultId: m.secretary_user_id };
    const noticeDay = m.notice_issued_at ? String(m.notice_issued_at).slice(0, 10) : today;
    return (
        <div className="space-y-4">
            <div className="card space-y-3">
                <h3 className="section-title mb-1">Meeting documents</h3>
                <p className="text-xs text-gray-500">
                    Each document is built from what is recorded here, on the company letterhead with the registration number, TIN and
                    registered office, and "Page x of y" on every page. Choose who signs and the date the document carries, then
                    <strong> Save to Documents</strong>: it is filed as a draft under Statutory Records; approving it there asks the people
                    named to sign with their captured signature, and the company stamp is added once everyone has signed.
                </p>
                <StatutoryDocButtons docKind="NOTICE" label="Notice of the meeting" params={{ meeting_id: m.id }} canSave={canManage}
                    signers={[sec]} defaultDate={noticeDay}
                    description={`Agenda, the full text of every resolution to be proposed${general ? ', proxy statement' : ''} and the notes. Signed by the secretary "by order of the board".`}
                    disabledReason={m.status === 'DRAFT' ? 'Available once the notice has been issued.' : null} />
                {general && (
                    <StatutoryDocButtons docKind="PROXY" label="Form of proxy" params={{ meeting_id: m.id }} canSave={canManage}
                        description="Blank form for members, listing every resolution with For / Against / Abstain boxes." />
                )}
                <StatutoryDocButtons docKind="REGISTER" label="Register of attendance" params={{ meeting_id: m.id }} canSave={canManage}
                    signers={[chair, sec]} defaultDate={m.meeting_date}
                    description="Every person entitled, shares held, attendance, each attendee's captured signature with time and code, and the quorum statement. Certified by the chairperson and secretary."
                    disabledReason={!held ? 'Available once the meeting has opened.' : null} />
                <StatutoryDocButtons docKind="MINUTES" label="Minutes" params={{ meeting_id: m.id }} canSave={canManage}
                    signers={[chair, sec]} defaultDate={m.meeting_date}
                    description="Numbered minutes (MIN 01/…) with present / proxies / in attendance / apologies, notice and quorum, each resolution with its vote, signed by the chairperson and secretary."
                    disabledReason={!held ? 'Available once the meeting has opened.' : null} />
            </div>
            {carried.length > 0 && (
                <div className="card space-y-3">
                    <h3 className="section-title mb-1">Resolutions passed</h3>
                    {carried.map(r => (
                        <div key={r.id} className="space-y-2">
                            <StatutoryDocButtons docKind="RESOLUTION" label={`${r.resolution_number} — ${r.title}`} params={{ resolution_id: r.id }} canSave={canManage}
                                signers={[chair, sec]} defaultDate={r.passed_on || m.meeting_date}
                                description={`${KIND_LABEL[r.kind]} resolution in the standard form, signed by the chairperson and secretary.`} />
                            {(r.kind === 'SPECIAL' || r.filing_required) && (
                                <StatutoryDocButtons docKind="CERTIFIED" label={`Certified true copy of ${r.resolution_number} for URSB`}
                                    params={{ resolution_id: r.id }} canSave={canManage}
                                    signers={[{ key: 'director', label: 'Director', required: true }, sec]} defaultDate={today}
                                    description="Certified by a director and the secretary, with the filing deadline and the lodging details." />
                            )}
                        </div>
                    ))}
                </div>
            )}
            <div className="card">
                <h3 className="section-title mb-3">Saved documents</h3>
                {v.documents.length ? (
                    <ul className="divide-y divide-gray-100">
                        {v.documents.map(d => (
                            <li key={d.id} className="py-2 flex items-center justify-between gap-3 flex-wrap">
                                <div className="min-w-0">
                                    <p className="text-sm text-gray-900">{d.title}</p>
                                    <p className="text-xs text-gray-400 font-mono">{d.reference_code} · {formatDate(d.created_at)}</p>
                                </div>
                                <span className={`badge ${d.status === 'FINAL' ? 'badge-green' : 'badge-blue'}`}>{d.status}</span>
                            </li>
                        ))}
                    </ul>
                ) : <p className="text-sm text-gray-400">Nothing saved yet.</p>}
                <Link to="/documents" className="text-sm text-primary-700 underline mt-3 inline-block">Go to Documents</Link>
            </div>
        </div>
    );
};

// ============================================================
// PAGE
// ============================================================
const MeetingDetailPage = () => {
    const { id } = useParams();
    const [v, setV] = useState(null);
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null);
    const [tab, setTab] = useTabParam('overview');
    const [editing, setEditing] = useState(false);
    const [modal, setModal] = useState(null); // notice | open | close | cancel
    const [form, setForm] = useState({});
    const [busy, setBusy] = useState(false);

    const reload = useCallback(async () => {
        try {
            const r = await meetingsAPI.getById(id);
            setV(r.data.data);
        } catch (err) {
            setError(getErrorMessage(err));
        }
    }, [id]);
    useEffect(() => { reload(); }, [reload]);

    if (!v) {
        return (
            <div>
                <PageHeader title="Meeting" showBack backTo="/meetings" />
                {error ? <ErrorMessage message={error} /> : <p className="text-sm text-gray-400">Loading…</p>}
            </div>
        );
    }
    const m = v.meeting;
    const canManage = v.can_manage;
    const mine = (v.my_attendance || []).find(a => a.capacity !== 'IN_ATTENDANCE') || (v.my_attendance || [])[0];
    const past = !!m.recorded_after_event;
    const markedPresent = mine && ['PRESENT', 'PRESENT_VIRTUAL'].includes(mine.status);
    const checkInOpen = mine && !mine.confirmed_at && mine.status !== 'BY_PROXY'
        && (past
            ? (markedPresent && ['NOTICE_ISSUED', 'IN_PROGRESS', 'CLOSED'].includes(m.status))
            : (m.status === 'IN_PROGRESS' || (m.status === 'NOTICE_ISSUED' && m.meeting_date === todayStr())
                || (m.status === 'CLOSED' && markedPresent)));
    const lateConfirm = past || m.status === 'CLOSED';

    const act = async (fn, after = null) => {
        setBusy(true);
        setError(null);
        try {
            const r = await fn();
            setNotice(r.data.message);
            setModal(null);
            await reload();
            if (after) after();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setBusy(false);
        }
    };

    const actions = canManage ? (
        <>
            {['DRAFT', 'NOTICE_ISSUED'].includes(m.status) && <button type="button" className="btn-secondary" onClick={() => setEditing(true)}>Edit</button>}
            {m.status === 'DRAFT' && <button type="button" className="btn-primary" onClick={() => { setForm({ short_notice_consent: !!m.short_notice_consent, short_notice_note: m.short_notice_note || '', notice_date: '' }); setModal('notice'); }}>{past ? 'Record the notice' : 'Issue the notice'}</button>}
            {m.status === 'NOTICE_ISSUED' && <button type="button" className="btn-primary" onClick={() => setModal('open')}>{past ? 'Record the opening' : 'Open the meeting'}</button>}
            {m.status === 'IN_PROGRESS' && <button type="button" className="btn-primary" onClick={() => { setForm({ closing_time: past ? (m.end_time ? String(m.end_time).slice(0, 5) : '') : nowHHMM() }); setModal('close'); }}>{past ? 'Record the closing' : 'Close the meeting'}</button>}
            {['DRAFT', 'NOTICE_ISSUED'].includes(m.status) && <button type="button" className="btn-secondary" onClick={() => { setForm({ reason: '' }); setModal('cancel'); }}>Cancel</button>}
        </>
    ) : null;

    const tabs = [
        ['overview', 'Details & notice'], ['attendance', 'Attendance'], ['resolutions', `Resolutions (${v.resolutions.length})`],
        ['minutes', 'Minutes'], ['documents', 'Documents'],
    ];

    return (
        <div>
            <PageHeader
                title={m.title}
                subtitle={`${MEETING_TYPE_LABEL[m.meeting_type]} · ${formatDate(m.meeting_date)} at ${hhmm(m.start_time)} · ${m.mode === 'VIRTUAL' ? 'online' : (m.venue || 'venue to be set')}`}
                showBack backTo="/meetings"
                actions={actions}
            />
            <div className="flex items-center gap-3 mb-4 flex-wrap">
                <MeetingStatus status={m.status} />
                {past && <span className="badge badge-purple">Recorded after the meeting</span>}
                <span className="text-xs font-mono text-gray-500">{m.reference_code}</span>
                {m.status === 'CANCELLED' && <span className="text-sm text-gray-500">Cancelled: {m.cancelled_reason}</span>}
            </div>
            {error && <div className="mb-4"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}
            {notice && <div className="mb-4 bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg p-3 flex justify-between gap-3"><span>{notice}</span><button type="button" onClick={() => setNotice(null)} className="text-green-700">×</button></div>}
            {v.warnings.length > 0 && m.status !== 'CANCELLED' && (
                <div className="mb-4 bg-amber-50 border border-amber-200 rounded-lg p-3 space-y-1">
                    {v.warnings.map((w, i) => <p key={i} className="text-sm text-amber-800 flex gap-2"><ExclamationTriangleIcon className="h-5 w-5 flex-shrink-0" />{w}</p>)}
                </div>
            )}
            {checkInOpen && (
                <div className="mb-4 card border-2 border-primary-200 flex items-center justify-between gap-3 flex-wrap">
                    <div>
                        <p className="text-sm font-semibold text-gray-900">Confirm your attendance</p>
                        <p className="text-xs text-gray-500">
                            {lateConfirm ? 'The secretary recorded you as present. ' : ''}Your captured signature (My Profile › Signature) is placed on the register of attendance with the time and a verification code.
                        </p>
                    </div>
                    <div className="flex gap-2">
                        <button type="button" className="btn-primary text-sm" disabled={busy} onClick={() => act(() => meetingsAPI.confirmAttendance(m.id, { attendance: 'IN_PERSON' }))}>
                            {lateConfirm ? 'Confirm and sign' : "I'm here in person"}
                        </button>
                        {!lateConfirm && (
                            <button type="button" className="btn-secondary text-sm" disabled={busy} onClick={() => act(() => meetingsAPI.confirmAttendance(m.id, { attendance: 'ONLINE' }))}>I've joined online</button>
                        )}
                    </div>
                </div>
            )}
            {mine && mine.confirmed_at && (
                <p className="mb-4 text-sm text-green-700 flex items-center gap-1.5"><CheckCircleIcon className="h-5 w-5" />You confirmed your attendance on {formatDateTime(mine.confirmed_at)} — code <span className="font-mono">{mine.confirmation_code}</span></p>
            )}

            <div className="tab-bar mb-6" role="tablist">
                {tabs.map(([k, l]) => (
                    <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`tab ${tab === k ? 'tab-active' : ''}`}>{l}</button>
                ))}
            </div>
            {tab === 'overview' && <OverviewTab v={v} />}
            {tab === 'attendance' && <AttendanceTab v={v} canManage={canManage} reload={reload} setError={setError} />}
            {tab === 'resolutions' && <ResolutionsTab v={v} canManage={canManage} reload={reload} setError={setError} setNotice={setNotice} />}
            {tab === 'minutes' && <MinutesTab v={v} canManage={canManage} reload={reload} setError={setError} setNotice={setNotice} />}
            {tab === 'documents' && <DocumentsTab v={v} canManage={canManage} />}

            <MeetingFormModal isOpen={editing} meeting={m} settings={v.settings} onClose={() => setEditing(false)}
                onSaved={async (_, msg) => { setNotice(msg); await reload(); }} />

            <Modal isOpen={modal === 'notice'} onClose={() => setModal(null)} title={past ? 'Record the notice' : 'Issue the notice'}
                subtitle={past
                    ? 'This meeting has already taken place. Enter the date its notice was given — nobody is emailed now.'
                    : 'Everyone on the register gets a notification and an email with the date, place and agenda.'}>
                {(() => {
                    const issueDay = past ? form.notice_date : todayStr();
                    const given = issueDay ? Math.round((Date.parse(`${m.meeting_date}T00:00:00Z`) - Date.parse(`${issueDay}T00:00:00Z`)) / 86400000) : null;
                    const enough = given !== null && given >= v.notice.required;
                    return (
                        <div className="space-y-3 text-sm">
                            {past && (
                                <div>
                                    <label className="label">Date the notice was given *</label>
                                    <input type="date" className="input w-48" max={m.meeting_date} value={form.notice_date || ''}
                                        onChange={e => setForm(f => ({ ...f, notice_date: e.target.value }))} />
                                </div>
                            )}
                            <p>Notice required: <strong>{v.notice.required} days</strong>.{given !== null && <> {past ? 'That notice gave' : 'Issued today it gives'} <strong>{given} days</strong>.</>}</p>
                            {given !== null && !enough && (
                                <>
                                    <p className="bg-amber-50 text-amber-800 rounded p-2">
                                        {past
                                            ? `That is shorter than required. Record it only if the ${m.meeting_type === 'BOARD' ? 'directors' : `members holding at least ${v.settings.short_notice_consent_pct}% of the voting rights`} agreed to short notice.`
                                            : <>That is shorter than required. Go ahead only if the {m.meeting_type === 'BOARD' ? 'directors' : `members holding at least ${v.settings.short_notice_consent_pct}% of the voting rights`} have agreed to short notice — otherwise move the meeting to {formatDate(earliestDate(v.notice.required))} or later.</>}
                                    </p>
                                    <label className="flex items-start gap-2">
                                        <input type="checkbox" className="mt-1" checked={!!form.short_notice_consent} onChange={e => setForm(f => ({ ...f, short_notice_consent: e.target.checked }))} />
                                        <span>Consent to short notice was given</span>
                                    </label>
                                    {form.short_notice_consent && (
                                        <textarea className="input" rows={2} value={form.short_notice_note || ''} onChange={e => setForm(f => ({ ...f, short_notice_note: e.target.value }))}
                                            placeholder="Who agreed and how, e.g. All members agreed in writing on 4 October 2026" />
                                    )}
                                </>
                            )}
                            <div className="flex justify-end gap-3 pt-2">
                                <button type="button" className="btn-secondary" onClick={() => setModal(null)}>Cancel</button>
                                <button type="button" className="btn-primary" disabled={busy || (past && !form.notice_date)}
                                    onClick={() => act(() => meetingsAPI.issueNotice(m.id, {
                                        ...(past ? { notice_date: form.notice_date } : {}),
                                        ...(enough ? {} : { short_notice_consent: !!form.short_notice_consent, short_notice_note: form.short_notice_note || null }),
                                    }))}>
                                    {busy ? 'Saving…' : past ? 'Record the notice' : 'Issue and send'}
                                </button>
                            </div>
                        </div>
                    );
                })()}
            </Modal>

            <Modal isOpen={modal === 'open'} onClose={() => setModal(null)} title="Open the meeting"
                subtitle="The chairperson declares the meeting open once the quorum is present.">
                <p className="text-sm">Present now: <strong>{v.tally.present}</strong> of the <strong>{v.tally.quorum_required}</strong> needed for a quorum.
                    {!v.tally.quorum_met && ' Mark the attendance first (or ask people to confirm their attendance).'}</p>
                <div className="flex justify-end gap-3 mt-5">
                    <button type="button" className="btn-secondary" onClick={() => setModal(null)}>Cancel</button>
                    <button type="button" className="btn-primary" disabled={busy} onClick={() => act(() => meetingsAPI.open(m.id))}>Open the meeting</button>
                </div>
            </Modal>

            <Modal isOpen={modal === 'close'} onClose={() => setModal(null)} title="Close the meeting"
                subtitle="Anyone not marked becomes absent. Every resolution must have a result first.">
                <label className="label">Time the meeting closed</label>
                <input type="time" className="input w-40" value={form.closing_time || ''} onChange={e => setForm(f => ({ ...f, closing_time: e.target.value }))} />
                <div className="flex justify-end gap-3 mt-5">
                    <button type="button" className="btn-secondary" onClick={() => setModal(null)}>Cancel</button>
                    <button type="button" className="btn-primary" disabled={busy} onClick={() => act(() => meetingsAPI.close(m.id, { closing_time: form.closing_time || null }))}>Close the meeting</button>
                </div>
            </Modal>

            <Modal isOpen={modal === 'cancel'} onClose={() => setModal(null)} title="Cancel this meeting"
                subtitle={m.status === 'NOTICE_ISSUED' ? 'Everyone who received the notice is told it is cancelled.' : null}>
                <textarea className="input" rows={2} value={form.reason || ''} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} placeholder="Reason" />
                <div className="flex justify-end gap-3 mt-5">
                    <button type="button" className="btn-secondary" onClick={() => setModal(null)}>Keep it</button>
                    <button type="button" className="btn-danger" disabled={busy || !(form.reason || '').trim()} onClick={() => act(() => meetingsAPI.cancel(m.id, { reason: form.reason }))}>Cancel the meeting</button>
                </div>
            </Modal>
        </div>
    );
};

export default MeetingDetailPage;
