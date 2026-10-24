// ============================================================
// PROXY FORMS FILLED IN THE SYSTEM (v1.87.0) — general meetings
//
// "the proxy form be fillable within the system for members who need it
// (e.g. absent) where they can appoint members in the system or just type
// the name of the appointee".
//
//   ProxySection   — on the meeting page:
//     • a member on the register sees their proxy (if any) and can appoint
//       one, change it or withdraw it until the deadline (48 hours before
//       the meeting by default);
//     • the Secretary sees every proxy lodged and can record one for a
//       member from a paper form — after the deadline only with the reason.
//   ProxyFormModal — the form itself: the proxy (someone in the system or a
//     typed name, with their address), an alternate, the member's address,
//     how to vote on each item, and the member's signature.
// Each form lodged is filed in Documents as a Form of Proxy; the register
// shows the member "By proxy"; attending in person revokes it.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { meetingsAPI } from '../../api/endpoints';
import { formatDateTime, getErrorMessage } from '../../utils/helpers';
import ErrorMessage from '../../components/common/ErrorMessage';
import { Modal } from './meetingUi';
import { UserGroupIcon } from '@heroicons/react/24/outline';

const VOTES = [['FOR', 'For'], ['AGAINST', 'Against'], ['ABSTAIN', 'Abstain'], ['', 'Proxy decides']];
const kampala = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { timeZone: 'Africa/Kampala', dateStyle: 'medium', timeStyle: 'short' }) : '—');

// one person: chosen from the system, or a typed name
const PersonChoice = ({ label, people, value, onChange, required = false }) => (
    <div className="space-y-2">
        <label className="label">{label}{required ? ' *' : ''}</label>
        <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-1.5">
                <input type="radio" checked={value.mode === 'user'} onChange={() => onChange({ ...value, mode: 'user' })} /> Someone in the system
            </label>
            <label className="flex items-center gap-1.5">
                <input type="radio" checked={value.mode === 'name'} onChange={() => onChange({ ...value, mode: 'name' })} /> Type a name
            </label>
        </div>
        {value.mode === 'user' ? (
            <select className="input" value={value.user_id || ''} onChange={e => onChange({ ...value, user_id: e.target.value })} required={required}>
                <option value="">{required ? 'Choose a person…' : '— none —'}</option>
                {people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
        ) : (
            <input className="input" value={value.name || ''} onChange={e => onChange({ ...value, name: e.target.value })} maxLength={200}
                placeholder="Full name" required={required} />
        )}
        <input className="input" value={value.address || ''} onChange={e => onChange({ ...value, address: e.target.value })}
            placeholder="Of (address / town) — optional" maxLength={300} />
    </div>
);

export const ProxyFormModal = ({ meetingId, memberUserId = null, members = [], onClose, onDone }) => {
    const [info, setInfo] = useState(null);
    const [member, setMember] = useState(memberUserId || '');
    const [proxy, setProxy] = useState({ mode: 'user', user_id: '', name: '', address: '' });
    const [alt, setAlt] = useState({ mode: 'name', user_id: '', name: '', address: '' });
    const [memberAddress, setMemberAddress] = useState('');
    const [votes, setVotes] = useState({});
    const [confirm, setConfirm] = useState(false);
    const [lateReason, setLateReason] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const forSomeoneElse = !!(members.length);

    const load = useCallback(async () => {
        setError(null);
        try {
            const r = await meetingsAPI.getProxy(meetingId, member ? { member_user_id: member } : {});
            const d = r.data.data;
            setInfo(d);
            setMemberAddress(d.member?.address || '');
            const a = d.active;
            if (a) {
                setProxy({ mode: a.proxy_user_id ? 'user' : 'name', user_id: a.proxy_user_id || '', name: a.proxy_user_id ? '' : a.proxy_name, address: a.proxy_address || '' });
                setAlt({ mode: a.alternate_user_id ? 'user' : 'name', user_id: a.alternate_user_id || '', name: a.alternate_user_id ? '' : (a.alternate_name || ''), address: a.alternate_address || '' });
                setVotes(a.instructions || {});
                if (a.member_address) setMemberAddress(a.member_address);
            }
        } catch (err) { setError(getErrorMessage(err)); }
    }, [meetingId, member]);
    useEffect(() => { if (!forSomeoneElse || member) load(); }, [load, forSomeoneElse, member]);

    const past = info ? !info.open : false;
    const submit = async (e) => {
        e.preventDefault();
        setBusy(true); setError(null);
        try {
            const r = await meetingsAPI.lodgeProxy(meetingId, {
                ...(forSomeoneElse ? { member_user_id: Number(member) } : { confirm }),
                proxy_user_id: proxy.mode === 'user' && proxy.user_id ? Number(proxy.user_id) : undefined,
                proxy_name: proxy.mode === 'name' ? proxy.name : undefined,
                proxy_address: proxy.address || undefined,
                alternate_user_id: alt.mode === 'user' && alt.user_id ? Number(alt.user_id) : undefined,
                alternate_name: alt.mode === 'name' && alt.name ? alt.name : undefined,
                alternate_address: alt.address || undefined,
                member_address: memberAddress || undefined,
                instructions: Object.fromEntries(Object.entries(votes).filter(([, v]) => v)),
                late_reason: forSomeoneElse && lateReason ? lateReason : undefined,
            });
            onDone(r.data.message);
            onClose();
        } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
    };

    return (
        <Modal isOpen onClose={onClose} wide title={forSomeoneElse ? 'Record a proxy for a member' : 'Appoint a proxy'}
            subtitle={forSomeoneElse
                ? 'From the member\'s signed paper form (or their instruction). It is filed in Documents and the register shows them "By proxy".'
                : 'Someone who attends and votes for you. They need not be a member. You can change or withdraw it until the deadline; attending yourself cancels it.'}>
            {error && <div className="mb-3"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}
            <form onSubmit={submit} className="space-y-4 text-sm">
                {forSomeoneElse && (
                    <div>
                        <label className="label">Member *</label>
                        <select className="input" value={member} onChange={e => setMember(e.target.value)} required>
                            <option value="">Choose the member…</option>
                            {members.map(a => <option key={a.user_id} value={a.user_id}>{a.name}</option>)}
                        </select>
                    </div>
                )}
                {info && (
                    <p className={`rounded-lg p-2 text-xs ${past ? 'bg-amber-50 text-amber-800' : 'bg-gray-50 text-gray-600'}`}>
                        Proxy forms close {info.deadline_hours} hours before the meeting: <strong>{kampala(info.deadline)}</strong> (Kampala time).
                        {past && (forSomeoneElse ? ' The deadline has passed — give the reason this one is accepted late.' : ' The deadline has passed.')}
                    </p>
                )}
                {info && (
                    <>
                        <PersonChoice label="I appoint as my proxy" people={info.people} value={proxy} onChange={setProxy} required />
                        <PersonChoice label="or, failing him/her (alternate — optional)" people={info.people} value={alt} onChange={setAlt} />
                        <div>
                            <label className="label">{forSomeoneElse ? 'Member\'s address' : 'My address'} (printed on the form)</label>
                            <input className="input" value={memberAddress} onChange={e => setMemberAddress(e.target.value)} maxLength={300} />
                        </div>
                        {info.matters.length > 0 && (
                            <div>
                                <p className="label">How the proxy votes</p>
                                <div className="divide-y divide-gray-100 rounded-lg border border-gray-200">
                                    {info.matters.map(x => (
                                        <div key={x.key} className="p-2 flex flex-wrap items-center justify-between gap-2">
                                            <span className="min-w-0">{x.label}{x.kind === 'SPECIAL' && <span className="text-xs text-gray-500"> (special)</span>}</span>
                                            <span className="flex gap-3">
                                                {VOTES.map(([val, lab]) => (
                                                    <label key={lab} className="flex items-center gap-1 text-xs">
                                                        <input type="radio" name={x.key} checked={(votes[x.key] || '') === val}
                                                            onChange={() => setVotes(vv => ({ ...vv, [x.key]: val }))} />{lab}
                                                    </label>
                                                ))}
                                            </span>
                                        </div>
                                    ))}
                                </div>
                                <p className="text-xs text-gray-500 mt-1">"Proxy decides": your proxy votes or abstains as he/she thinks fit.</p>
                            </div>
                        )}
                        {forSomeoneElse ? (
                            past && (
                                <div>
                                    <label className="label">Why it is accepted after the deadline *</label>
                                    <textarea className="input" rows={2} value={lateReason} onChange={e => setLateReason(e.target.value)} required
                                        placeholder="e.g. Paper form handed in at the office on 24 October; the chairperson agreed" />
                                </div>
                            )
                        ) : (
                            <label className="flex items-start gap-2">
                                <input type="checkbox" className="mt-1" checked={confirm} onChange={e => setConfirm(e.target.checked)} />
                                <span>I sign this form of proxy. My saved signature (My profile › Signature) is printed on it.</span>
                            </label>
                        )}
                    </>
                )}
                <div className="flex justify-end gap-3">
                    <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
                    <button type="submit" className="btn-primary" disabled={busy || !info || (!forSomeoneElse && (!confirm || past))}>
                        {busy ? 'Saving…' : forSomeoneElse ? 'Record the proxy' : 'Lodge my proxy'}
                    </button>
                </div>
            </form>
        </Modal>
    );
};

export const ProxySection = ({ v, canManage, reload, setNotice }) => {
    const m = v.meeting;
    const [open, setOpen] = useState(null); // 'self' | 'member'
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    if (m.meeting_type === 'BOARD' || !['NOTICE_ISSUED', 'IN_PROGRESS', 'CLOSED'].includes(m.status) || !v.proxy_deadline) return null;
    const mineAsMember = (v.my_attendance || []).find(a => a.capacity === 'MEMBER');
    const beforeDeadline = m.status === 'NOTICE_ISSUED' && new Date() < new Date(v.proxy_deadline);
    const active = (v.proxies || []).filter(p => p.status === 'ACTIVE');
    const members = (v.attendance || []).filter(a => a.capacity === 'MEMBER' && a.user_id && !a.confirmed_at && !['PRESENT', 'PRESENT_VIRTUAL'].includes(a.status));
    if (!mineAsMember && !canManage) return null;

    const withdraw = async (memberUserId = null) => {
        setBusy(true); setError(null);
        try {
            const r = await meetingsAPI.withdrawProxy(m.id, memberUserId ? { member_user_id: memberUserId } : {});
            setNotice(r.data.message); await reload();
        } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
    };
    const done = async (msg) => { setNotice(msg); await reload(); };

    return (
        <div className="mb-4 card">
            <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="flex items-start gap-2 min-w-0">
                    <UserGroupIcon className="h-5 w-5 text-primary-600 mt-0.5 flex-shrink-0" />
                    <div className="min-w-0">
                        <p className="text-sm font-semibold text-gray-900">Proxies</p>
                        <p className="text-xs text-gray-500">Forms close {kampala(v.proxy_deadline)} (Kampala time).</p>
                    </div>
                </div>
                <div className="flex gap-2 flex-wrap">
                    {mineAsMember && beforeDeadline && !mineAsMember.confirmed_at && (
                        <button type="button" className="btn-primary text-sm" onClick={() => setOpen('self')}>{v.my_proxy ? 'Change my proxy' : 'Appoint a proxy'}</button>
                    )}
                    {mineAsMember && beforeDeadline && v.my_proxy && (
                        <button type="button" className="btn-secondary text-sm" disabled={busy} onClick={() => withdraw()}>Withdraw my proxy</button>
                    )}
                    {canManage && ['NOTICE_ISSUED', 'IN_PROGRESS'].includes(m.status) && members.length > 0 && (
                        <button type="button" className="btn-secondary text-sm" onClick={() => setOpen('member')}>Record a proxy for a member</button>
                    )}
                </div>
            </div>
            {error && <div className="mt-3"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}
            {mineAsMember && (
                <p className="mt-3 text-sm text-gray-700">
                    {v.my_proxy
                        ? <>Your proxy: <strong>{v.my_proxy.proxy_name}</strong>{v.my_proxy.alternate_name ? <> (or {v.my_proxy.alternate_name})</> : null} — lodged {formatDateTime(v.my_proxy.lodged_at)}{v.my_proxy.document_reference ? <>, filed as <span className="font-mono">{v.my_proxy.document_reference}</span></> : null}.</>
                        : beforeDeadline ? 'If you cannot attend, you can appoint someone to attend and vote for you.' : 'You have no proxy for this meeting.'}
                </p>
            )}
            {canManage && active.length > 0 && (
                <div className="mt-3 divide-y divide-gray-100 border-t border-gray-100">
                    {active.map(p => (
                        <div key={p.id} className="py-2 flex flex-wrap items-start justify-between gap-2 text-sm">
                            <div className="min-w-0">
                                <p><strong>{p.member_name}</strong> → {p.proxy_name}{p.alternate_name ? ` (or ${p.alternate_name})` : ''}</p>
                                <p className="text-xs text-gray-500">
                                    {p.lodged_by === p.member_user_id ? 'Lodged by the member, signed' : `Recorded by ${p.lodged_by_name}`} · {formatDateTime(p.lodged_at)}
                                    {p.document_reference ? ` · ${p.document_reference}` : ''}
                                    {p.lodged_late ? ` · late: ${p.late_reason}` : ''}
                                </p>
                            </div>
                            {['NOTICE_ISSUED', 'IN_PROGRESS'].includes(m.status) && (
                                <button type="button" className="text-xs text-red-600 hover:underline" disabled={busy} onClick={() => withdraw(p.member_user_id)}>Withdraw</button>
                            )}
                        </div>
                    ))}
                </div>
            )}
            {canManage && active.length === 0 && <p className="mt-3 text-xs text-gray-400">No proxies lodged yet.</p>}
            {open === 'self' && <ProxyFormModal meetingId={m.id} onClose={() => setOpen(null)} onDone={done} />}
            {open === 'member' && <ProxyFormModal meetingId={m.id} members={members} onClose={() => setOpen(null)} onDone={done} />}
        </div>
    );
};
