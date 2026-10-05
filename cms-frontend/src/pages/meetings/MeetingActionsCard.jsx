// ============================================================
// MEETING ACTIONS CARD (v1.79.0)
// "What needs me" for company meetings — shown on the dashboard and at
// the top of the Meetings page. Renders nothing when there is nothing
// to do, so it never takes space for people with no meetings.
//   • confirm my attendance (meeting day / open meeting)
//   • sign a written resolution
//   • meetings I have been called to (notice issued)
//   • special resolutions to file with URSB (people who run meetings)
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { meetingsAPI } from '../../api/endpoints';
import { formatDate, getErrorMessage } from '../../utils/helpers';
import { UserGroupIcon } from '@heroicons/react/24/outline';
import { hhmm } from './meetingUi';

export const MeetingActionsCard = ({ compact = false }) => {
    const [data, setData] = useState(null);
    const [busy, setBusy] = useState(null);
    const [msg, setMsg] = useState(null);

    const load = useCallback(() => {
        meetingsAPI.getMyActions().then(r => setData(r.data.data)).catch(() => setData(null));
    }, []);
    useEffect(() => { load(); }, [load]);

    if (!data) return null;
    const confirm = data.confirm_attendance || [];
    const sign = data.sign_resolutions || [];
    const upcoming = (data.upcoming || []).filter(u => !confirm.some(c => c.id === u.id));
    const filings = data.filings_due || [];
    if (!confirm.length && !sign.length && !upcoming.length && !filings.length) return null;

    const confirmNow = async (m, how) => {
        setBusy(m.id);
        setMsg(null);
        try {
            const r = await meetingsAPI.confirmAttendance(m.id, { attendance: how });
            setMsg({ ok: true, text: r.data.message });
            load();
        } catch (err) {
            setMsg({ ok: false, text: getErrorMessage(err) });
        } finally {
            setBusy(null);
        }
    };

    return (
        <div className={`card ${compact ? 'mb-6' : ''}`}>
            <div className="flex items-center gap-2 mb-3">
                <UserGroupIcon className="h-5 w-5 text-primary-600" />
                <h3 className="section-title mb-0">Company meetings</h3>
            </div>
            {msg && <p className={`text-sm rounded px-3 py-2 mb-3 ${msg.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>{msg.text}</p>}
            <div className="divide-y divide-gray-100">
                {confirm.map(m => (
                    <div key={`c${m.id}`} className="py-2.5 flex items-center justify-between gap-3 flex-wrap">
                        <div className="min-w-0">
                            <p className="text-sm font-medium text-gray-900">Confirm your attendance — <Link to={`/meetings/${m.id}`} className="text-primary-700 hover:underline">{m.title}</Link></p>
                            <p className="text-xs text-gray-500">{formatDate(m.meeting_date)} at {hhmm(m.start_time)}{m.status === 'CLOSED' ? ' · the secretary recorded you as present — please confirm' : ''}</p>
                        </div>
                        <div className="flex gap-2">
                            {m.status === 'CLOSED' ? (
                                <button type="button" className="btn-primary text-sm" disabled={busy === m.id} onClick={() => confirmNow(m, 'IN_PERSON')}>Confirm</button>
                            ) : (
                                <>
                                    <button type="button" className="btn-primary text-sm" disabled={busy === m.id} onClick={() => confirmNow(m, 'IN_PERSON')}>I'm here in person</button>
                                    <button type="button" className="btn-secondary text-sm" disabled={busy === m.id} onClick={() => confirmNow(m, 'ONLINE')}>I've joined online</button>
                                </>
                            )}
                        </div>
                    </div>
                ))}
                {sign.map(r => (
                    <div key={`s${r.id}`} className="py-2.5 flex items-center justify-between gap-3 flex-wrap">
                        <div className="min-w-0">
                            <p className="text-sm font-medium text-gray-900">Your signature is needed — {r.resolution_number}</p>
                            <p className="text-xs text-gray-500">{r.title}</p>
                        </div>
                        <Link to={`/meetings/resolutions/${r.id}`} className="btn-primary text-sm">Read and sign</Link>
                    </div>
                ))}
                {upcoming.map(m => (
                    <div key={`u${m.id}`} className="py-2.5 flex items-center justify-between gap-3 flex-wrap">
                        <div className="min-w-0">
                            <p className="text-sm text-gray-900">You are called to <Link to={`/meetings/${m.id}`} className="font-medium text-primary-700 hover:underline">{m.title}</Link></p>
                            <p className="text-xs text-gray-500">{formatDate(m.meeting_date)} at {hhmm(m.start_time)} · {m.mode === 'VIRTUAL' ? 'online' : (m.venue || '')}</p>
                        </div>
                    </div>
                ))}
                {filings.map(r => (
                    <div key={`f${r.id}`} className="py-2.5 flex items-center justify-between gap-3 flex-wrap">
                        <div className="min-w-0">
                            <p className={`text-sm font-medium ${r.overdue ? 'text-red-700' : 'text-gray-900'}`}>
                                {r.overdue ? 'Overdue: ' : ''}File {r.resolution_number} with URSB by {formatDate(r.filing_due_date)}
                            </p>
                            <p className="text-xs text-gray-500">{r.title}</p>
                        </div>
                        <Link to={`/meetings/resolutions/${r.id}`} className="btn-secondary text-sm">Open</Link>
                    </div>
                ))}
            </div>
        </div>
    );
};

export default MeetingActionsCard;
