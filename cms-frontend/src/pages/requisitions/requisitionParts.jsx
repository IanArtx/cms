// ============================================================
// REQUISITIONS — v1.80.0 pieces
// Requested: "requisitions have a functional reversal functionality and
// before a requisition is approved fully to make a transactional post a
// few prerequisites like linking / connecting to a document and or an
// investment". Confirmed: a supporting document always; the investment
// and purpose when it is for one; a reversed requisition is REVERSED.
//
//   • INVESTMENT_PURPOSES / PurposeBadge — buying / running / maintenance
//   • InvestmentFields       the "for an investment" part of the form
//   • RequisitionDocuments   list / upload / pick / remove documents
//   • PrerequisiteList       what is still missing before approval
//   • ReversalModal          ask for the reversal of a paid requisition
// ============================================================

import { useState, useEffect, useCallback, useRef } from 'react';
import { requisitionsAPI, transactionsAPI } from '../../api/endpoints';
import { getErrorMessage, formatDate } from '../../utils/helpers';
import { DocumentPicker } from '../../components/documents/TransactionDocuments';
import { useAuth } from '../../contexts/AuthContext';
import { PaperClipIcon, ArrowUpTrayIcon, XMarkIcon, CheckCircleIcon, ExclamationCircleIcon } from '@heroicons/react/24/outline';

export const INVESTMENT_PURPOSES = [
    { value: 'OPERATING', label: 'Running it', hint: 'Feed, wages, fuel, utilities, transport — an expense of the investment.' },
    { value: 'MAINTENANCE', label: 'Maintenance & repairs', hint: 'Repairs and upkeep that keep it running — an expense of the investment.' },
    { value: 'CAPITAL', label: 'Buying / expanding it', hint: 'Land, buildings, equipment, more stock — added to what the investment is worth.' },
];
export const PURPOSE_LABEL = Object.fromEntries(INVESTMENT_PURPOSES.map(p => [p.value, p.label]));

export const PurposeBadge = ({ value }) => {
    if (!value) return null;
    const cls = value === 'CAPITAL' ? 'bg-indigo-50 text-indigo-700' : value === 'MAINTENANCE' ? 'bg-amber-50 text-amber-700' : 'bg-teal-50 text-teal-700';
    return <span className={`inline-flex text-[10px] font-semibold rounded-full px-1.5 py-0.5 ${cls}`}>{PURPOSE_LABEL[value]}</span>;
};

// ------------------------------------------------------------
// The "for an investment" part of the requisition form
// value: { for_investment, investment_id, investment_purpose }
// ------------------------------------------------------------
export const InvestmentFields = ({ value, onChange }) => {
    const [options, setOptions] = useState([]);
    useEffect(() => {
        requisitionsAPI.investmentOptions().then(r => setOptions(r.data.data || [])).catch(() => setOptions([]));
    }, []);
    const set = (k, v) => onChange({ ...value, [k]: v });
    return (
        <div className="rounded-lg border border-gray-200 p-3 space-y-3">
            <label className="flex items-start gap-2 text-sm text-gray-800">
                <input type="checkbox" className="mt-1" checked={!!value.for_investment}
                    onChange={e => onChange({ ...value, for_investment: e.target.checked, investment_id: e.target.checked ? value.investment_id : '', investment_purpose: e.target.checked ? value.investment_purpose : '' })} />
                <span><strong>This money is for one of the company's investments</strong>
                    <span className="block text-xs text-gray-500">It is then booked against that investment, under Expense › Investments.</span></span>
            </label>
            {value.for_investment && (
                <>
                    <div>
                        <label className="label">Investment *</label>
                        <select className="input" value={value.investment_id || ''} onChange={e => set('investment_id', e.target.value)} required>
                            <option value="">Choose the investment…</option>
                            {options.map(o => <option key={o.id} value={o.id}>{o.name} — {o.reference_code} ({o.currency_code}){o.status !== 'ACTIVE' ? ` · ${o.status.toLowerCase().replace(/_/g, ' ')}` : ''}</option>)}
                        </select>
                    </div>
                    <div>
                        <label className="label">What is the money for? *</label>
                        <div className="space-y-1.5">
                            {INVESTMENT_PURPOSES.map(p => (
                                <label key={p.value} className={`flex items-start gap-2 rounded-lg border px-3 py-2 cursor-pointer ${value.investment_purpose === p.value ? 'border-primary-500 bg-primary-50' : 'border-gray-200'}`}>
                                    <input type="radio" name="investment_purpose" className="mt-1" checked={value.investment_purpose === p.value}
                                        onChange={() => set('investment_purpose', p.value)} />
                                    <span><span className="text-sm font-medium text-gray-900">{p.label}</span>
                                        <span className="block text-xs text-gray-500">{p.hint}</span></span>
                                </label>
                            ))}
                        </div>
                    </div>
                </>
            )}
        </div>
    );
};

// ------------------------------------------------------------
// Files chosen on the NEW requisition form (uploaded right after it is
// created, because a document is attached to an existing requisition).
// ------------------------------------------------------------
export const PendingFiles = ({ files, onChange }) => {
    const ref = useRef(null);
    return (
        <div className="rounded-lg border border-gray-200 p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-gray-700 flex items-center gap-1.5">
                    <PaperClipIcon className="h-4 w-4 text-gray-400" /> Supporting documents
                    <span className="text-xs font-normal text-gray-400">(quotation, invoice, receipt — needed before it can be paid)</span>
                </p>
                <button type="button" className="text-xs text-primary-700 hover:underline flex items-center gap-1" onClick={() => ref.current && ref.current.click()}>
                    <ArrowUpTrayIcon className="h-3.5 w-3.5" /> Add file
                </button>
            </div>
            <input ref={ref} type="file" multiple className="hidden" accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png"
                onChange={e => { onChange([...files, ...Array.from(e.target.files || [])]); e.target.value = ''; }} />
            {files.length === 0 ? (
                <p className="text-xs text-gray-400">No file added yet. You can also add documents after submitting.</p>
            ) : (
                <div className="flex flex-wrap gap-1.5">
                    {files.map((f, i) => (
                        <span key={`${f.name}-${i}`} className="inline-flex items-center gap-1 text-xs bg-gray-100 text-gray-700 rounded-full pl-2 pr-1 py-0.5">
                            {f.name}
                            <button type="button" aria-label={`Remove ${f.name}`} className="p-0.5 rounded-full hover:bg-gray-200" onClick={() => onChange(files.filter((_, k) => k !== i))}>
                                <XMarkIcon className="h-3.5 w-3.5" />
                            </button>
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
};

export const uploadFiles = async (requisitionId, files) => {
    for (const f of files) {
        const fd = new FormData();
        fd.append('document', f);
        fd.append('title', f.name.replace(/\.[^.]+$/, ''));
        fd.append('document_type', /receipt/i.test(f.name) ? 'RECEIPT' : 'OTHER');
        await requisitionsAPI.uploadDocument(requisitionId, fd);
    }
};

// ------------------------------------------------------------
// Documents connected to one requisition
// ------------------------------------------------------------
export const RequisitionDocuments = ({ requisition, onCount = null }) => {
    const { hasRole, user } = useAuth();
    const isTreasury = hasRole(['Treasurer', 'Assistant Treasurer', 'Admin']);
    const editable = requisition.status === 'PENDING' && (isTreasury || requisition.requested_by === user?.id);
    const [docs, setDocs] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const [picked, setPicked] = useState([]);
    const fileRef = useRef(null);

    const load = useCallback(async () => {
        try {
            const r = await requisitionsAPI.getDocuments(requisition.id);
            setDocs(r.data.data || []);
            if (onCount) onCount((r.data.data || []).length);
        } catch (err) { setError(getErrorMessage(err)); } finally { setLoading(false); }
    }, [requisition.id, onCount]);
    useEffect(() => { load(); }, [load]);

    const upload = async (files) => {
        setBusy(true); setError(null);
        try { await uploadFiles(requisition.id, files); await load(); } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
    };
    const connectPicked = async () => {
        if (!picked.length) return;
        setBusy(true); setError(null);
        try { await requisitionsAPI.linkDocuments(requisition.id, picked.map(d => d.id)); setPicked([]); await load(); } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
    };
    const remove = async (d) => {
        setBusy(true); setError(null);
        try { await requisitionsAPI.unlinkDocument(requisition.id, d.document_id); await load(); } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
    };

    return (
        <div className="rounded-lg border border-gray-200 p-3 space-y-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
                <p className="text-sm font-medium text-gray-700 flex items-center gap-1.5">
                    <PaperClipIcon className="h-4 w-4 text-gray-400" /> Supporting documents ({docs.length})
                </p>
                {editable && (
                    <button type="button" disabled={busy} className="text-xs text-primary-700 hover:underline flex items-center gap-1" onClick={() => fileRef.current && fileRef.current.click()}>
                        <ArrowUpTrayIcon className="h-3.5 w-3.5" /> {busy ? 'Working…' : 'Upload file'}
                    </button>
                )}
            </div>
            <input ref={fileRef} type="file" multiple className="hidden" accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png"
                onChange={e => { const f = Array.from(e.target.files || []); e.target.value = ''; if (f.length) upload(f); }} />
            {error && <p className="text-xs text-red-700 bg-red-50 rounded px-2 py-1">{error}</p>}
            {loading ? <p className="text-xs text-gray-400">Loading…</p> : docs.length === 0 ? (
                <p className="text-xs text-gray-400">No document connected yet.</p>
            ) : (
                <ul className="divide-y divide-gray-100">
                    {docs.map(d => (
                        <li key={d.document_id} className="py-1.5 flex items-center justify-between gap-2">
                            <span className="text-sm text-gray-800 min-w-0 truncate">
                                <span className="font-mono text-xs text-primary-700 mr-1.5">{d.reference_code}</span>{d.title}
                                <span className="block text-[11px] text-gray-400">added by {d.linked_by_name}, {formatDate(d.linked_at)}</span>
                            </span>
                            {editable && (
                                <button type="button" className="text-xs text-red-600 hover:underline flex-shrink-0" disabled={busy} onClick={() => remove(d)}>Remove</button>
                            )}
                        </li>
                    ))}
                </ul>
            )}
            {editable && isTreasury && (
                <div className="pt-1 space-y-1.5">
                    <DocumentPicker value={picked} onChange={setPicked} label="Or connect documents already in the system" optional />
                    {picked.length > 0 && (
                        <div className="flex justify-end"><button type="button" className="btn-secondary text-xs" disabled={busy} onClick={connectPicked}>Connect {picked.length} document(s)</button></div>
                    )}
                </div>
            )}
        </div>
    );
};

// ------------------------------------------------------------
// What is still missing before a money-out requisition can be paid
// ------------------------------------------------------------
export const PrerequisiteList = ({ requisition, documentCount }) => {
    if (requisition.requisition_type !== 'EXPENSE') return null;
    const items = [
        { ok: documentCount > 0, text: 'At least one supporting document is connected' },
    ];
    if (requisition.investment_id) {
        items.push({ ok: !!requisition.investment_purpose, text: `Investment: ${requisition.investment_name || '—'} — ${PURPOSE_LABEL[requisition.investment_purpose] || 'purpose missing'}` });
    }
    return (
        <ul className="space-y-1">
            {items.map((it, i) => (
                <li key={i} className={`text-xs flex items-center gap-1.5 ${it.ok ? 'text-green-700' : 'text-amber-700'}`}>
                    {it.ok ? <CheckCircleIcon className="h-4 w-4" /> : <ExclamationCircleIcon className="h-4 w-4" />}{it.text}
                </li>
            ))}
        </ul>
    );
};

// ------------------------------------------------------------
// Ask for the reversal of a PAID requisition (Treasurer). A second
// person approves it on Transactions › Reversals; the requisition is
// then marked REVERSED.
// ------------------------------------------------------------
export const ReversalModal = ({ requisition, onClose, onDone }) => {
    const [reason, setReason] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    if (!requisition) return null;
    const submit = async () => {
        setBusy(true); setError(null);
        try {
            const r = await transactionsAPI.reverse(requisition.transaction_id, { reason: `${reason.trim()} (requisition ${requisition.reference_code})` });
            onDone(r.data.message);
            onClose();
        } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
    };
    return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            <div className="fixed inset-0 bg-black bg-opacity-40" onClick={onClose} />
            <div className="flex min-h-full items-center justify-center p-4">
                <div className="relative bg-white rounded-xl shadow-xl max-w-md w-full p-6">
                    <h2 className="text-lg font-semibold text-gray-900">Reverse this requisition</h2>
                    <p className="text-sm text-gray-500 mt-1">
                        {requisition.reference_code} — {requisition.title}. The payment {requisition.transaction_reference ? `(${requisition.transaction_reference}) ` : ''}is
                        put back into the account by an equal and opposite entry{requisition.investment_name ? `, and ${requisition.investment_name}'s records are corrected` : ''}.
                        Someone else (Treasurer, Assistant Treasurer, Director or Admin) must approve it; the requisition is then marked <strong>Reversed</strong>.
                        To pay again, raise a new requisition.
                    </p>
                    {error && <p className="text-sm text-red-700 bg-red-50 rounded px-3 py-2 mt-3">{error}</p>}
                    <label className="label mt-4">Reason *</label>
                    <textarea className="input" rows={3} value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. The supplier cancelled the order and refunded the money" />
                    <div className="flex justify-end gap-3 mt-5">
                        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
                        <button type="button" className="btn-danger" disabled={busy || !reason.trim()} onClick={submit}>{busy ? 'Sending…' : 'Ask for the reversal'}</button>
                    </div>
                </div>
            </div>
        </div>
    );
};
