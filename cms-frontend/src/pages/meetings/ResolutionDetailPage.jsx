// ============================================================
// RESOLUTION PAGE (v1.79.0) — /meetings/resolutions/:rid
// One resolution: its text, how it was decided, and —
//   • written resolutions: the signature table; each member / director
//     signs AGREE or DISAGREE from his or her own account
//   • special resolutions: the URSB filing deadline and the record of
//     the filing (date + URSB reference)
//   • its documents (resolution, written resolution, certified copy)
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { meetingsAPI } from '../../api/endpoints';
import { formatDate, formatDateTime, getErrorMessage, getUploadUrl } from '../../utils/helpers';
import PageHeader from '../../components/common/PageHeader';
import ErrorMessage from '../../components/common/ErrorMessage';
import {
    ResultBadge, FilingBadge, Modal, ResolutionFormModal, StatutoryDocButtons, KIND_LABEL,
} from './meetingUi';
import { CheckCircleIcon, XCircleIcon, ClockIcon } from '@heroicons/react/24/outline';

const todayStr = () => {
    const d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

const ResolutionDetailPage = () => {
    const { rid } = useParams();
    const [r, setR] = useState(null);
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null);
    const [busy, setBusy] = useState(false);
    const [signing, setSigning] = useState(null);
    const [filing, setFiling] = useState(false);
    const [filingForm, setFilingForm] = useState({ filed_on: todayStr(), filing_reference: '' });
    const [editing, setEditing] = useState(false);

    const reload = useCallback(async () => {
        try {
            const res = await meetingsAPI.getResolution(rid);
            setR(res.data.data);
        } catch (err) { setError(getErrorMessage(err)); }
    }, [rid]);
    useEffect(() => { reload(); }, [reload]);

    if (!r) {
        return (
            <div>
                <PageHeader title="Resolution" showBack backTo="/meetings?tab=resolutions" />
                {error ? <ErrorMessage message={error} /> : <p className="text-sm text-gray-400">Loading…</p>}
            </div>
        );
    }

    const written = !r.meeting_id;
    const mySig = r.my_signature;
    const act = async (fn) => {
        setBusy(true);
        setError(null);
        try {
            const res = await fn();
            setNotice(res.data.message);
            await reload();
            return true;
        } catch (err) { setError(getErrorMessage(err)); return false; } finally { setBusy(false); }
    };
    const signed = (r.signatories || []).filter(s => s.signed_at).length;

    return (
        <div>
            <PageHeader
                title={`${r.resolution_number} — ${r.title}`}
                subtitle={`${KIND_LABEL[r.kind]} resolution${r.treated_as_special ? ' in place of a special resolution' : ''}${r.meeting ? ` · ${r.meeting.title}, ${formatDate(r.meeting.meeting_date)}` : ''}`}
                showBack backTo={r.meeting_id ? `/meetings/${r.meeting_id}?tab=resolutions` : '/meetings?tab=resolutions'}
                actions={r.can_manage && r.result === 'PENDING' && (!written || signed === 0) ? (
                    <>
                        <button type="button" className="btn-secondary" onClick={() => setEditing(true)}>Edit</button>
                        <button type="button" className="btn-secondary" disabled={busy} onClick={() => act(() => meetingsAPI.withdraw(r.id))}>Withdraw</button>
                    </>
                ) : null}
            />
            {error && <div className="mb-4"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}
            {notice && <div className="mb-4 bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg p-3">{notice}</div>}

            <div className="flex items-center gap-2 mb-4 flex-wrap">
                <ResultBadge result={r.result} />
                <FilingBadge state={r.filing_state} due={r.filing_due_date} />
                <span className="text-xs font-mono text-gray-500">{r.reference_code}</span>
                {r.passed_on && <span className="text-xs text-gray-500">Passed {formatDate(r.passed_on)}</span>}
            </div>

            {written && mySig && !mySig.signed_at && r.result === 'PENDING' && (
                <div className="card border-2 border-primary-200 mb-6 flex items-center justify-between gap-3 flex-wrap">
                    <div>
                        <p className="text-sm font-semibold text-gray-900">Your signature is needed</p>
                        <p className="text-xs text-gray-500">Read the resolution below. Your decision is recorded with the time and a verification code, and cannot be changed afterwards.</p>
                    </div>
                    <div className="flex gap-2">
                        <button type="button" className="btn-primary" onClick={() => setSigning('AGREE')}>I agree</button>
                        <button type="button" className="btn-secondary" onClick={() => setSigning('DISAGREE')}>I disagree</button>
                    </div>
                </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="lg:col-span-2 space-y-6">
                    <div className="card">
                        <h3 className="section-title mb-3">The resolution</h3>
                        {r.preamble && <p className="text-sm text-gray-600 italic mb-3 whitespace-pre-wrap">{r.preamble}</p>}
                        <p className="text-sm font-semibold text-gray-900 mb-1">IT IS RESOLVED:</p>
                        <ol className="space-y-1.5">
                            {(r.clauses || []).map((c, i) => <li key={i} className="text-sm text-gray-900 font-medium">{(r.clauses.length > 1 ? `${i + 1}. ` : '')}{/^that\b/i.test(c) ? c : `THAT ${c}`}</li>)}
                        </ol>
                        {!written && r.votes_for != null && (
                            <p className="text-sm text-gray-600 mt-4">
                                Show of hands: <strong>{r.votes_for}</strong> for, <strong>{r.votes_against}</strong> against, <strong>{r.votes_abstain}</strong> abstaining
                                ({r.voters_present} entitled to vote){r.chair_casting_vote ? ` · chairperson's casting vote ${r.chair_casting_vote.toLowerCase()}` : ''}.
                                {r.kind === 'SPECIAL' && ` Needed at least ${r.majority_required_pct}% of votes cast.`}
                            </p>
                        )}
                        {!written && (r.proposed_by_name || r.seconded_by_name) && (
                            <p className="text-xs text-gray-500 mt-2">Proposed by {r.proposed_by_name || '—'} · seconded by {r.seconded_by_name || '—'}</p>
                        )}
                        {r.meeting && <Link to={`/meetings/${r.meeting_id}`} className="text-sm text-primary-700 underline mt-3 inline-block">Open the meeting</Link>}
                    </div>

                    {written && (
                        <div className="card">
                            <h3 className="section-title mb-3">Signatures — {signed} of {(r.signatories || []).length}</h3>
                            <div className="overflow-x-auto">
                                <table className="min-w-full text-sm">
                                    <thead>
                                        <tr className="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-gray-200">
                                            <th className="py-2 pr-3">Name</th>
                                            {r.kind === 'WRITTEN_MEMBERS' && <th className="py-2 pr-3 text-right">Shares</th>}
                                            <th className="py-2 pr-3">Decision</th>
                                            <th className="py-2 pr-3">Signed</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-100">
                                        {(r.signatories || []).map(s => (
                                            <tr key={s.id}>
                                                <td className="py-2 pr-3 font-medium text-gray-900">{s.name}</td>
                                                {r.kind === 'WRITTEN_MEMBERS' && <td className="py-2 pr-3 text-right tabular-nums">{s.shares_held != null ? Number(s.shares_held).toLocaleString('en-GB') : '—'}</td>}
                                                <td className="py-2 pr-3">
                                                    {s.decision === 'AGREE' && <span className="text-green-700 flex items-center gap-1"><CheckCircleIcon className="h-4 w-4" />Agree</span>}
                                                    {s.decision === 'DISAGREE' && <span className="text-red-700 flex items-center gap-1"><XCircleIcon className="h-4 w-4" />Disagree</span>}
                                                    {!s.decision && <span className="text-gray-400 flex items-center gap-1"><ClockIcon className="h-4 w-4" />Waiting</span>}
                                                </td>
                                                <td className="py-2 pr-3 text-xs text-gray-500">{s.signed_at ? <>
                                                    {s.signature_snapshot_path && <img src={getUploadUrl(s.signature_snapshot_path)} alt={`Signature of ${s.name}`} className="h-8 max-w-[140px] object-contain bg-white" />}
                                                    {formatDateTime(s.signed_at)} <span className="font-mono ml-1">{s.confirmation_code}</span></> : '—'}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                            <p className="text-xs text-gray-500 mt-3">A written resolution is passed only when every person listed signs in agreement; one disagreement means it is not passed.</p>
                        </div>
                    )}
                </div>

                <div className="space-y-6">
                    {r.filing_required && r.result === 'CARRIED' && (
                        <div className="card">
                            <h3 className="section-title mb-3">Filing with URSB</h3>
                            {r.filed_on ? (
                                <p className="text-sm text-gray-800">Filed on <strong>{formatDate(r.filed_on)}</strong>{r.filing_reference ? <> — reference <span className="font-mono">{r.filing_reference}</span></> : ''}.</p>
                            ) : (
                                <>
                                    <p className={`text-sm ${r.filing_state === 'OVERDUE' ? 'text-red-700' : 'text-gray-800'}`}>
                                        A certified copy must reach the Registrar of Companies by <strong>{formatDate(r.filing_due_date)}</strong>
                                        {' '}({r.settings?.resolution_filing_days ?? 15} days after it was passed).
                                    </p>
                                    {r.can_manage && <button type="button" className="btn-primary text-sm mt-3" onClick={() => setFiling(true)}>Record the filing</button>}
                                </>
                            )}
                        </div>
                    )}
                    <div className="card space-y-3">
                        <h3 className="section-title mb-1">Documents</h3>
                        {(() => {
                            const chair = { key: 'chairperson', label: 'Chairperson', defaultId: r.meeting?.chairperson_user_id };
                            const sec = { key: 'secretary', label: 'Secretary', defaultId: r.meeting?.secretary_user_id };
                            const today = todayStr();
                            return (
                                <>
                                    {written ? (
                                        <StatutoryDocButtons docKind="WRITTEN" label="Written resolution with signatures" params={{ resolution_id: r.id }} canSave={r.can_manage}
                                            signers={[sec]} defaultDate={r.passed_on || today}
                                            description="The resolution and the table of each signatory's captured signature with time and code." />
                                    ) : (
                                        <StatutoryDocButtons docKind="RESOLUTION" label="Resolution" params={{ resolution_id: r.id }} canSave={r.can_manage}
                                            signers={[chair, sec]} defaultDate={r.passed_on || r.meeting?.meeting_date || today}
                                            description="In the standard form, signed by the chairperson and secretary."
                                            disabledReason={r.result === 'PENDING' ? 'Shows the proposed text until the vote is recorded.' : null} />
                                    )}
                                    {r.result === 'CARRIED' && (
                                        <StatutoryDocButtons docKind="CERTIFIED" label="Certified true copy (for URSB)" params={{ resolution_id: r.id }} canSave={r.can_manage}
                                            signers={[{ key: 'director', label: 'Director', required: true }, sec]} defaultDate={today}
                                            description="Certified by a director and the company secretary." />
                                    )}
                                </>
                            );
                        })()}
                        {(r.documents || []).length > 0 && (
                            <ul className="divide-y divide-gray-100 pt-2">
                                {r.documents.map(d => (
                                    <li key={d.id} className="py-1.5 text-xs flex justify-between gap-2"><span className="text-gray-700">{d.title}</span><span className="font-mono text-gray-400">{d.reference_code}</span></li>
                                ))}
                            </ul>
                        )}
                    </div>
                </div>
            </div>

            <Modal isOpen={!!signing} onClose={() => setSigning(null)} title={signing === 'AGREE' ? 'Agree to this resolution' : 'Disagree with this resolution'}
                subtitle="Your captured signature (My Profile › Signature) is applied with the date, time and a verification code. It cannot be changed afterwards.">
                <p className="text-sm font-medium text-gray-900">{r.resolution_number} — {r.title}</p>
                <div className="flex justify-end gap-3 mt-5">
                    <button type="button" className="btn-secondary" onClick={() => setSigning(null)}>Back</button>
                    <button type="button" className={signing === 'AGREE' ? 'btn-primary' : 'btn-danger'} disabled={busy}
                        onClick={async () => { const d = signing; setSigning(null); await act(() => meetingsAPI.sign(r.id, { decision: d })); }}>
                        Sign: {signing === 'AGREE' ? 'I agree' : 'I disagree'}
                    </button>
                </div>
            </Modal>

            <Modal isOpen={filing} onClose={() => setFiling(false)} title="Record the filing with URSB">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                        <label className="label">Date filed</label>
                        <input type="date" className="input" max={todayStr()} value={filingForm.filed_on} onChange={e => setFilingForm(f => ({ ...f, filed_on: e.target.value }))} />
                    </div>
                    <div>
                        <label className="label">URSB reference / receipt</label>
                        <input className="input" value={filingForm.filing_reference} onChange={e => setFilingForm(f => ({ ...f, filing_reference: e.target.value }))} />
                    </div>
                </div>
                <div className="flex justify-end gap-3 mt-5">
                    <button type="button" className="btn-secondary" onClick={() => setFiling(false)}>Cancel</button>
                    <button type="button" className="btn-primary" disabled={busy}
                        onClick={async () => { if (await act(() => meetingsAPI.markFiled(r.id, filingForm))) setFiling(false); }}>Save</button>
                </div>
            </Modal>

            <ResolutionFormModal isOpen={editing} mode="edit" meeting={r.meeting} resolution={r} onClose={() => setEditing(false)}
                onSaved={async (_, msg) => { setNotice(msg); await reload(); }} />
        </div>
    );
};

export default ResolutionDetailPage;
