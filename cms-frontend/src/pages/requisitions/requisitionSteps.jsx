// ============================================================
// REQUISITION STEPS (v1.87.0) — request › approval › release › acknowledgement
//
// "the flow should follow: requisition > approval > release >
//  acknowledgement - all recorded and put in the respective document
//  showing all parties involved and what they did."
//
//   StepTrail        — the four steps under a requisition's status: who
//                      did each and when, or what it is waiting for.
//   ReleaseModal     — Treasury pays an approved money request (never the
//                      person who approved it, never the requester): from
//                      which account, on which date, how, the payment
//                      reference, notes, and proof of payment.
//   AcknowledgeModal — the requester confirms receiving the money and
//                      signs (their saved signature), or reports a problem.
//                      Acknowledging files the Requisition Form in Documents.
// ============================================================

import { useState } from 'react';
import { requisitionsAPI } from '../../api/endpoints';
import { formatDate, getErrorMessage } from '../../utils/helpers';
import ErrorMessage from '../../components/common/ErrorMessage';
import { useAuth } from '../../contexts/AuthContext';
import { RequisitionDocuments, PurposeBadge } from './requisitionParts';
import { CheckCircleIcon, ClockIcon, XCircleIcon } from '@heroicons/react/24/outline';

export const RELEASE_METHODS = [
    { value: 'BANK_TRANSFER', label: 'Bank transfer' },
    { value: 'MOBILE_MONEY', label: 'Mobile money' },
    { value: 'CASH', label: 'Cash' },
    { value: 'CHEQUE', label: 'Cheque' },
    { value: 'OTHER', label: 'Other' },
];
const METHOD_LABEL = Object.fromEntries(RELEASE_METHODS.map(m => [m.value, m.label]));
const money = (v) => (v === null || v === undefined || v === '' ? '—' : parseFloat(v).toLocaleString('en-US', { maximumFractionDigits: 2 }));
const today = () => new Date().toISOString().slice(0, 10);

const Modal = ({ title, children, onClose }) => (
    <div className="fixed inset-0 z-50 overflow-y-auto">
        <div className="fixed inset-0 bg-black bg-opacity-40" onClick={onClose} />
        <div className="flex min-h-full items-center justify-center p-4">
            <div className="relative bg-white rounded-xl shadow-xl max-w-lg w-full p-6">
                <h2 className="text-lg font-semibold text-gray-900 mb-3">{title}</h2>
                {children}
            </div>
        </div>
    </div>
);

const Summary = ({ r }) => (
    <div className="bg-gray-50 rounded-lg p-3 mb-4 text-sm">
        <p className="font-medium text-gray-900">{r.title} <span className="font-mono text-xs text-gray-500">{r.reference_code}</span></p>
        <p className="text-xs text-gray-500 mt-0.5">Requested by {r.requested_by_name} · {r.category_trail}</p>
        {r.investment_name && <p className="text-xs text-gray-700 mt-1">For {r.investment_name} <PurposeBadge value={r.investment_purpose} /></p>}
        <p className="text-sm font-bold text-primary-700 mt-2">Approved: {money(r.amount_approved)} <span className="font-normal text-xs text-gray-500">(asked {money(r.amount_requested)})</span></p>
        {r.reviewed_by_name && <p className="text-xs text-gray-500">Approved by {r.reviewed_by_name}{r.reviewed_by_position ? ` (${r.reviewed_by_position})` : ''} on {formatDate(r.reviewed_at)}</p>}
    </div>
);

// ------------------------------------------------------------
// The four steps, compact (under the status in the tables)
// ------------------------------------------------------------
export const StepTrail = ({ r }) => {
    if (r.requisition_type !== 'EXPENSE' || r.status === 'CANCELLED') return null;
    const rejected = r.status === 'REJECTED';
    const steps = [
        { label: 'Requested', done: true, who: r.requested_by_name, at: r.created_at },
        { label: rejected ? 'Rejected' : 'Approved', done: !!r.reviewed_by_name, bad: rejected, who: r.reviewed_by_name, at: r.reviewed_at },
    ];
    if (!rejected) {
        steps.push({ label: 'Released', done: !!r.released_by_name, who: r.released_by_name, at: r.release_date || r.released_at });
        steps.push({ label: 'Received', done: !!r.acknowledged_at, who: r.acknowledged_at ? r.requested_by_name : null, at: r.acknowledged_date || r.acknowledged_at });
    }
    return (
        <div className="mt-1 space-y-0.5">
            {steps.map(s => (
                <div key={s.label} className={`flex items-center gap-1 text-[11px] ${s.bad ? 'text-red-700' : s.done ? 'text-green-700' : 'text-gray-400'}`}
                    title={s.who ? `${s.label} by ${s.who}${s.at ? ` on ${formatDate(s.at)}` : ''}` : `Not ${s.label.toLowerCase()} yet`}>
                    {s.bad ? <XCircleIcon className="h-3.5 w-3.5" /> : s.done ? <CheckCircleIcon className="h-3.5 w-3.5" /> : <ClockIcon className="h-3.5 w-3.5" />}
                    <span>{s.label}{s.who ? ` · ${s.who}` : ''}</span>
                </div>
            ))}
            {r.ack_issue_note && r.status === 'RELEASED' && (
                <p className="text-[11px] text-amber-700" title={r.ack_issue_note}>Problem reported: {r.ack_issue_note}</p>
            )}
            {r.legacy_one_step && <p className="text-[10px] text-gray-400">approved and paid in one step (before v1.87.0)</p>}
        </div>
    );
};

// ------------------------------------------------------------
// RELEASE — Treasury pays an approved money request
// ------------------------------------------------------------
export const ReleaseModal = ({ requisition, accounts, onClose, onSuccess }) => {
    const { user } = useAuth();
    const forInvestment = !!requisition?.investment_id;
    const [form, setForm] = useState({ account_id: '', release_date: today(), release_method: 'BANK_TRANSFER', release_reference: '', release_notes: '' });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    if (!requisition) return null;
    const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));
    const needsRef = ['BANK_TRANSFER', 'MOBILE_MONEY', 'CHEQUE'].includes(form.release_method);
    const blocked = requisition.reviewed_by === user?.id
        ? 'You approved this requisition — a different person in Treasury must release the money.'
        : requisition.requested_by === user?.id ? 'You asked for this money — someone else in Treasury must release it.' : null;

    const submit = async (e) => {
        e.preventDefault();
        setLoading(true); setError(null);
        try {
            const res = await requisitionsAPI.release(requisition.id, {
                account_id: form.account_id ? parseInt(form.account_id, 10) : undefined,
                release_date: form.release_date,
                release_method: form.release_method,
                release_reference: form.release_reference || undefined,
                release_notes: form.release_notes || undefined,
            });
            onSuccess(res.data.message);
            onClose();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    return (
        <Modal title="Release the money" onClose={onClose}>
            <Summary r={requisition} />
            {blocked && <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{blocked}</div>}
            {error && <div className="mb-3"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}
            <form onSubmit={submit} className="space-y-4">
                <div>
                    <label className="label" htmlFor="rel-acc">Paid from account {forInvestment ? '' : '*'}</label>
                    <select id="rel-acc" className="input" value={form.account_id} onChange={set('account_id')} required={!forInvestment}>
                        <option value="">{forInvestment ? "The investment's own account (default)" : 'Select account…'}</option>
                        {(accounts || []).filter(a => a.account_type !== 'SAVINGS' && (!forInvestment || a.currency_id === requisition.investment_currency_id)).map(a => (
                            <option key={a.id} value={a.id}>{a.name} ({a.currency_code})</option>
                        ))}
                    </select>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                        <label className="label" htmlFor="rel-date">Date released *</label>
                        <input id="rel-date" type="date" className="input" value={form.release_date} max={today()} onChange={set('release_date')} required />
                    </div>
                    <div>
                        <label className="label" htmlFor="rel-method">How it was paid *</label>
                        <select id="rel-method" className="input" value={form.release_method} onChange={set('release_method')}>
                            {RELEASE_METHODS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                        </select>
                    </div>
                </div>
                <div>
                    <label className="label" htmlFor="rel-ref">Payment reference {needsRef ? '*' : '(optional)'}</label>
                    <input id="rel-ref" className="input" value={form.release_reference} onChange={set('release_reference')} maxLength={120}
                        required={needsRef} placeholder={form.release_method === 'CHEQUE' ? 'Cheque number' : 'Bank / mobile money transaction number'} />
                </div>
                <div>
                    <label className="label" htmlFor="rel-notes">Notes</label>
                    <textarea id="rel-notes" className="input" rows={2} value={form.release_notes} onChange={set('release_notes')}
                        placeholder="e.g. paid straight to the supplier's account" />
                </div>
                <RequisitionDocuments requisition={requisition} />
                <p className="text-xs text-gray-500">
                    Attach the proof of payment above if you have it. Releasing records the payment in the books
                    ({money(requisition.amount_approved)}) and asks {requisition.requested_by_name} to confirm receiving it.
                </p>
                <div className="flex justify-end gap-3">
                    <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
                    <button type="submit" className="btn-primary" disabled={loading || !!blocked}>{loading ? 'Releasing…' : 'Release the money'}</button>
                </div>
            </form>
        </Modal>
    );
};

// ------------------------------------------------------------
// ACKNOWLEDGE — the requester confirms receiving the money
// ------------------------------------------------------------
export const AcknowledgeModal = ({ requisition, onClose, onSuccess }) => {
    const [mode, setMode] = useState('ack'); // ack | problem
    const [receivedDate, setReceivedDate] = useState(today());
    const [note, setNote] = useState('');
    const [confirm, setConfirm] = useState(false);
    const [problem, setProblem] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    if (!requisition) return null;
    const r = requisition;

    const acknowledge = async (e) => {
        e.preventDefault();
        setLoading(true); setError(null);
        try {
            const res = await requisitionsAPI.acknowledge(r.id, { received_date: receivedDate, note: note || undefined, confirm });
            onSuccess(res.data.message);
            onClose();
        } catch (err) { setError(getErrorMessage(err)); } finally { setLoading(false); }
    };
    const report = async (e) => {
        e.preventDefault();
        setLoading(true); setError(null);
        try {
            const res = await requisitionsAPI.reportIssue(r.id, problem);
            onSuccess(res.data.message);
            onClose();
        } catch (err) { setError(getErrorMessage(err)); } finally { setLoading(false); }
    };

    return (
        <Modal title={mode === 'ack' ? 'Acknowledge receipt' : 'Report a problem'} onClose={onClose}>
            <div className="bg-gray-50 rounded-lg p-3 mb-4 text-sm space-y-0.5">
                <p className="font-medium text-gray-900">{r.title} <span className="font-mono text-xs text-gray-500">{r.reference_code}</span></p>
                <p className="text-lg font-bold text-primary-700">{money(r.amount_approved)} {r.currency_code || ''}</p>
                <p className="text-xs text-gray-600">
                    Released {r.release_date ? formatDate(r.release_date) : ''} by {r.released_by_name || '—'}{r.released_by_position ? ` (${r.released_by_position})` : ''}
                    {r.release_method ? ` · ${METHOD_LABEL[r.release_method] || r.release_method}` : ''}{r.release_reference ? ` · ref. ${r.release_reference}` : ''}
                </p>
                {r.account_name && <p className="text-xs text-gray-500">From {r.account_name}</p>}
                {r.release_notes && <p className="text-xs text-gray-500">{r.release_notes}</p>}
            </div>
            {error && <div className="mb-3"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}
            {mode === 'ack' ? (
                <form onSubmit={acknowledge} className="space-y-4">
                    <div>
                        <label className="label" htmlFor="ack-date">Date you received it *</label>
                        <input id="ack-date" type="date" className="input" value={receivedDate} max={today()} onChange={e => setReceivedDate(e.target.value)} required />
                    </div>
                    <div>
                        <label className="label" htmlFor="ack-note">Note (optional)</label>
                        <textarea id="ack-note" className="input" rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. received in full on my mobile money" />
                    </div>
                    <label className="flex items-start gap-2 text-sm">
                        <input type="checkbox" className="mt-1" checked={confirm} onChange={e => setConfirm(e.target.checked)} />
                        <span>I confirm I received <strong>{money(r.amount_approved)} {r.currency_code || ''}</strong> for this requisition. My saved signature is printed on the requisition form.</span>
                    </label>
                    <div className="flex flex-wrap justify-between gap-3">
                        <button type="button" className="text-sm text-amber-700 hover:underline" onClick={() => { setMode('problem'); setError(null); }}>Something is wrong — report a problem</button>
                        <div className="flex gap-3">
                            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
                            <button type="submit" className="btn-primary" disabled={loading || !confirm}>{loading ? 'Saving…' : 'Acknowledge receipt'}</button>
                        </div>
                    </div>
                </form>
            ) : (
                <form onSubmit={report} className="space-y-4">
                    <p className="text-sm text-gray-600">Treasury is told straight away. The requisition stays open; acknowledge it once the problem is sorted out.</p>
                    <textarea className="input" rows={3} value={problem} onChange={e => setProblem(e.target.value)} required minLength={3} maxLength={1000}
                        placeholder="e.g. I received 1,300,000 instead of 1,400,000 / nothing has arrived yet" />
                    <div className="flex justify-between gap-3">
                        <button type="button" className="text-sm text-gray-600 hover:underline" onClick={() => setMode('ack')}>Back</button>
                        <button type="submit" className="btn-danger" disabled={loading || problem.trim().length < 3}>{loading ? 'Sending…' : 'Report the problem'}</button>
                    </div>
                </form>
            )}
        </Modal>
    );
};
