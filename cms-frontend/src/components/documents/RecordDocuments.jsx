// ============================================================
// DOCUMENTS ON A PROJECT / INVESTMENT PAGE (v1.85.0)
// Requested: "From the proposal to other related documents can be
// directly uploaded on the project or investment page. (like bond
// certificates)".
//
//   <RecordDocuments recordType="projects" recordId={7} />
//   <RecordDocuments recordType="investments" recordId={3} />
//
// • lists the documents that belong to the page
// • "Upload" — a new file straight onto the page (title, type, category)
// • "Add existing" — a document already in Documents that belongs to
//   nothing yet (one that belongs to a meeting, a contribution or the
//   archive stays there)
// • "Take off" — the document leaves the page but stays in Documents
// • "Open" — the document in Documents (preview, signatures, versions)
// Upload / add / take off: whoever may upload documents.
// v1.88.0 — on an INVESTMENT page the documents are shown in groups:
// Buying & expanding, Running costs, Maintenance & repairs, Taxes, Returns
// & income, Agreements/titles/certificates, Proposals & reports, Other.
// Documents put on the page go in the group chosen (it can be changed);
// documents attached to the investment's payments and returns appear in
// the group of that payment automatically, marked "from a payment".
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { documentsAPI, categoriesAPI, investmentsAPI } from '../../api/endpoints';
import { formatDate, getErrorMessage } from '../../utils/helpers';
import ErrorMessage from '../common/ErrorMessage';
import StatusBadge from '../common/StatusBadge';
import { useAuth } from '../../contexts/AuthContext';
import { useConfirm } from '../../contexts/ConfirmContext';
import { PaperClipIcon, ArrowUpTrayIcon, MagnifyingGlassIcon, XMarkIcon } from '@heroicons/react/24/outline';

export const PAGE_DOC_TYPES = [
    ['PROJECT_PROPOSAL', 'Project proposal'],
    ['PROJECT_REPORT', 'Project report'],
    ['INVESTMENT_PROPOSAL', 'Investment proposal'],
    ['BOND_CERTIFICATE', 'Bond / security certificate'],
    ['CONTRACT', 'Contract'],
    ['RECEIPT', 'Receipt / invoice'],
    ['FINANCIAL_REPORT_GENERAL', 'Financial report'],
    ['OTHER', 'Other'],
];
export const DOC_GROUPS = [
    ['BUYING', 'Buying & expanding'], ['RUNNING', 'Running costs'], ['MAINTENANCE', 'Maintenance & repairs'],
    ['TAX', 'Taxes'], ['RETURNS', 'Returns & income'], ['LEGAL', 'Agreements, titles & certificates'],
    ['PLANNING', 'Proposals & reports'], ['OTHER', 'Other'],
];
const typeLabel = (t) => (PAGE_DOC_TYPES.find(x => x[0] === t) || [t, String(t || '').replace(/_/g, ' ').toLowerCase()])[1];

const RecordDocuments = ({ recordType, recordId, title = 'Documents', readOnly = false }) => {
    const { hasPermission } = useAuth();
    const confirm = useConfirm();
    const canEdit = !readOnly && hasPermission('DOCUMENT_UPLOAD');
    const noun = recordType === 'projects' ? 'project' : 'investment';
    const grouped = recordType === 'investments'; // v1.88.0
    const [docs, setDocs] = useState(null);
    const [groups, setGroups] = useState(null); // v1.88.0
    const [canGroup, setCanGroup] = useState(false);
    const [closed, setClosed] = useState({}); // folded groups
    const [error, setError] = useState(null);
    const [msg, setMsg] = useState(null);
    const [mode, setMode] = useState(null); // 'upload' | 'pick'
    const [categories, setCategories] = useState([]);
    const [up, setUp] = useState({ title: '', document_type: recordType === 'projects' ? 'PROJECT_PROPOSAL' : 'INVESTMENT_PROPOSAL', category_id: '', record_section: '' });
    const [file, setFile] = useState(null);
    const [busy, setBusy] = useState(false);
    const [search, setSearch] = useState('');
    const [results, setResults] = useState([]);
    const fileRef = useRef(null);
    const timer = useRef(null);

    const load = useCallback(() => {
        if (grouped) {
            investmentsAPI.getDocuments(recordId)
                .then(r => {
                    const d = r.data.data;
                    setGroups(d.groups || []);
                    setCanGroup(!!d.can_choose_group);
                    setDocs((d.groups || []).flatMap(g => g.documents));
                })
                .catch(() => {
                    // an older server: the plain list
                    documentsAPI.getAll({ related_record_type: recordType, related_record_id: recordId, limit: 100 })
                        .then(r => { setGroups(null); setDocs(r.data.data || []); })
                        .catch(err => { setDocs([]); setError(getErrorMessage(err)); });
                });
            return;
        }
        documentsAPI.getAll({ related_record_type: recordType, related_record_id: recordId, limit: 100 })
            .then(r => setDocs(r.data.data || []))
            .catch(err => { setDocs([]); setError(getErrorMessage(err)); });
    }, [recordType, recordId, grouped]);
    useEffect(() => { load(); }, [load]);

    useEffect(() => {
        if (mode !== 'upload' || categories.length) return;
        categoriesAPI.getAll({ flat: true }).then(r => {
            const list = (r.data.data || []).filter(c => c.module === 'DOCUMENT');
            setCategories(list);
            const guess = list.find(c => /invest|project/i.test(c.full_path || c.name)) || list[0];
            if (guess) setUp(p => (p.category_id ? p : { ...p, category_id: String(guess.id) }));
        }).catch(() => {});
    }, [mode, categories.length]);

    useEffect(() => {
        if (mode !== 'pick') return undefined;
        clearTimeout(timer.current);
        timer.current = setTimeout(() => {
            documentsAPI.getAll({ search: search.trim() || undefined, limit: 15 })
                .then(r => setResults((r.data.data || []).filter(d => !d.related_record_type)))
                .catch(() => setResults([]));
        }, 250);
        return () => clearTimeout(timer.current);
    }, [search, mode]);

    const doUpload = async (e) => {
        e.preventDefault();
        if (!file) { setError('Choose a file.'); return; }
        setBusy(true); setError(null); setMsg(null);
        try {
            const fd = new FormData();
            fd.append('document', file);
            fd.append('title', up.title.trim());
            fd.append('document_type', up.document_type);
            fd.append('category_id', up.category_id);
            fd.append('related_record_type', recordType);
            fd.append('related_record_id', String(recordId));
            if (grouped && up.record_section) fd.append('record_section', up.record_section); // v1.88.0
            const r = await documentsAPI.upload(fd);
            setMsg(r.data.message || 'Uploaded.');
            setUp(p => ({ ...p, title: '' })); setFile(null);
            if (fileRef.current) fileRef.current.value = '';
            setMode(null); load();
        } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
    };

    const attach = async (doc) => {
        setBusy(true); setError(null); setMsg(null);
        try {
            const r = await documentsAPI.attachToRecord(doc.id, recordType, recordId);
            setMsg(r.data.message); setMode(null); setSearch(''); load();
        } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
    };

    const detach = async (doc) => {
        const ok = await confirm({
            title: 'Take the document off this page?',
            message: `${doc.reference_code} — ${doc.title} leaves this ${noun}'s page. The document itself stays in Documents.`,
            confirmLabel: 'Take off',
        });
        if (!ok) return;
        setError(null); setMsg(null);
        try {
            const r = await documentsAPI.detachFromRecord(doc.id, recordType, recordId);
            setMsg(r.data.message); load();
        } catch (err) { setError(getErrorMessage(err)); }
    };

    // v1.88.0 — move a document put on the page to another group
    const move = async (doc, section) => {
        setError(null); setMsg(null);
        try { await documentsAPI.setRecordSection(doc.id, section || null); load(); } catch (err) { setError(getErrorMessage(err)); }
    };
    const row = (d) => (
        <li key={`${d.via || 'PAGE'}-${d.id}`} className="py-2.5 flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{d.title}</p>
                <p className="text-xs text-gray-400">
                    <span className="font-mono">{d.reference_code}</span> · {typeLabel(d.document_type)} · {formatDate(d.created_at)}
                    {d.via === 'PAYMENT' && <> · from payment <span className="font-mono">{d.transaction_reference || `#${d.transaction_id}`}</span></>}
                </p>
            </div>
            <div className="flex items-center gap-3">
                {grouped && canGroup && canEdit && d.via === 'PAGE' && (
                    <select className="input py-0.5 text-xs w-auto" value={d.group_chosen ? d.group : ''} aria-label="Group"
                        title="Move to another group" onChange={e => move(d, e.target.value)}>
                        <option value="">Group: from the type</option>
                        {DOC_GROUPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                )}
                <StatusBadge status={d.status} />
                <Link to={`/documents?doc=${d.id}`} className="text-sm text-primary-700 hover:underline">Open</Link>
                {canEdit && d.via !== 'PAYMENT' && (
                    <button type="button" onClick={() => detach(d)} title="Take off this page (the document stays in Documents)"
                        className="text-gray-400 hover:text-red-600"><XMarkIcon className="h-4 w-4" /></button>
                )}
            </div>
        </li>
    );

    return (
        <div className="card" data-testid={`record-documents-${recordType}`}>
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <h3 className="section-title mb-0 flex items-center gap-2">
                    <PaperClipIcon className="h-5 w-5 text-gray-400" />
                    {title} {docs ? `(${docs.length})` : ''}
                </h3>
                {canEdit && (
                    <div className="flex gap-2">
                        <button type="button" className="btn-secondary text-sm flex items-center gap-1"
                            onClick={() => setMode(m => (m === 'pick' ? null : 'pick'))}>
                            <MagnifyingGlassIcon className="h-4 w-4" /> Add existing
                        </button>
                        <button type="button" className="btn-primary text-sm flex items-center gap-1"
                            onClick={() => setMode(m => (m === 'upload' ? null : 'upload'))}>
                            <ArrowUpTrayIcon className="h-4 w-4" /> Upload
                        </button>
                    </div>
                )}
            </div>
            {error && <div className="mb-3"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}
            {msg && <p className="mb-3 text-sm text-green-700 dark:text-green-400">{msg}</p>}

            {mode === 'upload' && (
                <form onSubmit={doUpload} className="mb-4 rounded-lg border border-gray-200 dark:border-gray-700 p-3 space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div className="sm:col-span-2">
                            <label className="label">Title *</label>
                            <input className="input" required maxLength={255} value={up.title}
                                onChange={e => setUp(p => ({ ...p, title: e.target.value }))}
                                placeholder={recordType === 'projects' ? 'e.g. Borehole proposal and budget' : 'e.g. Bond certificate — GoU 2-year'} />
                        </div>
                        <div>
                            <label className="label">Type *</label>
                            <select className="input" value={up.document_type} onChange={e => setUp(p => ({ ...p, document_type: e.target.value }))}>
                                {PAGE_DOC_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                            </select>
                        </div>
                        {grouped && canGroup && (
                            <div>
                                <label className="label">Group on this page</label>
                                <select className="input" value={up.record_section} onChange={e => setUp(p => ({ ...p, record_section: e.target.value }))}>
                                    <option value="">From the type (default)</option>
                                    {DOC_GROUPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                                </select>
                            </div>
                        )}
                        <div>
                            <label className="label">Category *</label>
                            <select className="input" required value={up.category_id} onChange={e => setUp(p => ({ ...p, category_id: e.target.value }))}>
                                <option value="">Choose…</option>
                                {categories.map(c => <option key={c.id} value={c.id}>{c.full_path || c.name}</option>)}
                            </select>
                        </div>
                        <div className="sm:col-span-2">
                            <label className="label">File *</label>
                            <input ref={fileRef} type="file" className="input" required onChange={e => setFile(e.target.files[0] || null)} />
                        </div>
                    </div>
                    <p className="text-xs text-gray-500">It is saved in Documents as a draft and appears on this page. Approval and signatures work as for every document.</p>
                    <div className="flex justify-end gap-2">
                        <button type="button" className="btn-secondary text-sm" onClick={() => setMode(null)}>Cancel</button>
                        <button type="submit" className="btn-primary text-sm" disabled={busy}>{busy ? 'Uploading…' : 'Upload'}</button>
                    </div>
                </form>
            )}

            {mode === 'pick' && (
                <div className="mb-4 rounded-lg border border-gray-200 dark:border-gray-700 p-3 space-y-2">
                    <input className="input" placeholder="Search documents by title or reference…" value={search} onChange={e => setSearch(e.target.value)} autoFocus />
                    <p className="text-xs text-gray-500">Only documents that do not belong to another record yet are listed.</p>
                    <ul className="divide-y divide-gray-100 dark:divide-gray-800 max-h-64 overflow-y-auto">
                        {results.map(d => (
                            <li key={d.id} className="py-2 flex items-center justify-between gap-2 text-sm">
                                <span className="min-w-0">
                                    <span className="font-mono text-xs text-gray-500">{d.reference_code}</span>{' '}
                                    <span className="text-gray-800 dark:text-gray-100">{d.title}</span>
                                    <span className="text-xs text-gray-400"> · {typeLabel(d.document_type)}</span>
                                </span>
                                <button type="button" className="text-primary-700 hover:underline text-sm whitespace-nowrap" disabled={busy} onClick={() => attach(d)}>Add here</button>
                            </li>
                        ))}
                        {results.length === 0 && <li className="py-3 text-sm text-gray-400 text-center">Nothing found.</li>}
                    </ul>
                </div>
            )}

            {!docs ? <p className="text-sm text-gray-400">Loading…</p>
                : docs.length === 0 ? (
                    <p className="text-sm text-gray-400 text-center py-6">
                        No documents on this {noun} yet{canEdit ? ' — upload the proposal, agreements, certificates or reports here.' : '.'}
                    </p>
                ) : grouped && groups ? (
                    // v1.88.0 — in groups; empty groups are left out
                    <div className="space-y-3">
                        {groups.filter(g => g.documents.length).map(g => (
                            <div key={g.key} className="rounded-lg border border-gray-100 dark:border-gray-800">
                                <button type="button" onClick={() => setClosed(c => ({ ...c, [g.key]: !c[g.key] }))} aria-expanded={!closed[g.key]}
                                    className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left bg-gray-50 dark:bg-gray-800/50 rounded-t-lg">
                                    <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">{g.label}</span>
                                    <span className="text-xs text-gray-500">{g.documents.length} {closed[g.key] ? '▸' : '▾'}</span>
                                </button>
                                {!closed[g.key] && <ul className="divide-y divide-gray-100 dark:divide-gray-800 px-3">{g.documents.map(row)}</ul>}
                            </div>
                        ))}
                        <p className="text-[11px] text-gray-400">Receipts and other documents attached to this investment's payments and returns appear in the group of that payment.</p>
                    </div>
                ) : (
                    <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                        {docs.map(row)}
                    </ul>
                )}
        </div>
    );
};

export default RecordDocuments;
