// ============================================================
// TRANSACTIONS ↔ DOCUMENTS (v1.78.0)
// Requested directly: "transactions can be connected to a specific
// document at the point of entry or later. a transaction can be
// connected to more than one document and vice versa but after one,
// the system shows alert that the transaction is already connected.
// documents should show connected transactions and the other way round
// including count. Connecting transactions shouldn't be mandatory. the
// transaction connected shows the reference of the connected
// document(s) on the printable version of the transaction".
// Confirmed: "Pick existing + upload new".
//
// Pieces:
//   • DocumentPicker        choose existing documents (search) and/or
//                           upload a new one — on the Contribution,
//                           Expense and Inflow forms (optional), and when
//                           connecting later
//   • connectWithAlert()    sends a connection; if the server answers
//                           "already connected" (409), asks "Connect
//                           anyway?" and sends again only on Yes
//   • TransactionDetailModal one transaction with its connected documents
//                           (connect / disconnect / print)
//   • DocumentTransactionsBlock the transactions connected to a document
//                           (used in the Documents page's detail window)
//   • LinkCount             the small 🔗 count shown in both lists
// ============================================================

import { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { documentsAPI, transactionsAPI, categoriesAPI } from '../../api/endpoints';
import { formatDate, formatDateTime, getErrorMessage } from '../../utils/helpers';
import ErrorMessage from '../common/ErrorMessage';
import StatusBadge from '../common/StatusBadge';
import { useAuth } from '../../contexts/AuthContext';
import { useConfirm } from '../../contexts/ConfirmContext';
import {
    LinkIcon, PaperClipIcon, XMarkIcon, ArrowUpTrayIcon, MagnifyingGlassIcon, PrinterIcon,
} from '@heroicons/react/24/outline';

const DOC_TYPES = [
    'RECEIPT', 'CONTRACT', 'INVESTMENT_PROPOSAL', 'LOAN_AGREEMENT', 'GRANT_AGREEMENT',
    'MEETING_MINUTES', 'FINANCIAL_REPORT_GENERAL', 'OTHER',
];

const money = (v, code) => `${code ? `${code} ` : ''}${parseFloat(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Who may connect / disconnect (the server checks the same).
export const useCanConnect = () => {
    const { hasPermission } = useAuth();
    return hasPermission('FINANCE_VIEW_ALL') && (hasPermission('DOCUMENT_UPLOAD') || hasPermission('FINANCE_TRANSACTION_CREATE'));
};

// ------------------------------------------------------------
// The "already connected" alert
// ------------------------------------------------------------
export const connectWithAlert = async (confirm, send) => {
    try {
        return await send(false);
    } catch (err) {
        const body = err && err.response && err.response.data;
        if (err && err.response && err.response.status === 409 && body && body.error === 'ALREADY_CONNECTED') {
            const ok = await confirm({
                title: 'Already connected',
                message: body.message || 'This is already connected. Connect another?',
                confirmLabel: 'Connect anyway',
            });
            if (!ok) return null;
            return send(true);
        }
        throw err;
    }
};

// ------------------------------------------------------------
// 🔗 count
// ------------------------------------------------------------
export const LinkCount = ({ count, title, onClick = null }) => {
    const n = parseInt(count || 0, 10);
    const cls = `inline-flex items-center gap-1 text-xs rounded-full px-2 py-0.5 whitespace-nowrap ${
        n > 0 ? 'bg-primary-50 text-primary-700' : 'text-gray-300'}`;
    if (onClick) {
        return (
            <button type="button" onClick={onClick} className={`${cls} hover:underline`} title={title}>
                <LinkIcon className="h-3.5 w-3.5" />{n}
            </button>
        );
    }
    return <span className={cls} title={title}><LinkIcon className="h-3.5 w-3.5" />{n}</span>;
};

// ------------------------------------------------------------
// DOCUMENT PICKER
//   value: [{ id, reference_code, title, transaction_count }]
// ------------------------------------------------------------
export const DocumentPicker = ({ value, onChange, label = 'Supporting documents', optional = true, exclude = [] }) => {
    const { hasPermission } = useAuth();
    const canUpload = hasPermission('DOCUMENT_UPLOAD');
    const [search, setSearch] = useState('');
    const [results, setResults] = useState([]);
    const [searching, setSearching] = useState(false);
    const [open, setOpen] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [showUpload, setShowUpload] = useState(false);
    const [categories, setCategories] = useState([]);
    const [up, setUp] = useState({ title: '', document_type: 'RECEIPT', category_id: '' });
    const [file, setFile] = useState(null);
    const [error, setError] = useState(null);
    const timer = useRef(null);
    const fileRef = useRef(null);

    const chosenIds = value.map(d => d.id);

    const runSearch = useCallback((q) => {
        setSearching(true);
        documentsAPI.getAll({ search: q || undefined, limit: 8 })
            .then(r => setResults(r.data.data || []))
            .catch(() => setResults([]))
            .finally(() => setSearching(false));
    }, []);

    useEffect(() => {
        if (!open) return undefined;
        clearTimeout(timer.current);
        timer.current = setTimeout(() => runSearch(search.trim()), 250);
        return () => clearTimeout(timer.current);
    }, [search, open, runSearch]);

    useEffect(() => {
        if (!showUpload || categories.length) return;
        categoriesAPI.getAll({ flat: true }).then(r => {
            const docs = (r.data.data || []).filter(c => c.module === 'DOCUMENT');
            setCategories(docs);
            const fin = docs.find(c => /^financ/i.test(c.full_path || c.name));
            if (fin) setUp(p => (p.category_id ? p : { ...p, category_id: String(fin.id) }));
        }).catch(() => {});
    }, [showUpload, categories.length]);

    const add = (doc) => {
        if (chosenIds.includes(doc.id)) return;
        onChange([...value, {
            id: doc.id, reference_code: doc.reference_code, title: doc.title,
            transaction_count: parseInt(doc.transaction_count || 0, 10),
        }]);
    };
    const remove = (id) => onChange(value.filter(d => d.id !== id));

    const doUpload = async () => {
        if (!file) { setError('Choose a file to upload.'); return; }
        if (!up.title.trim()) { setError('Give the document a title.'); return; }
        if (!up.category_id) { setError('Choose a category for the document.'); return; }
        setUploading(true);
        setError(null);
        try {
            const fd = new FormData();
            fd.append('document', file);
            fd.append('title', up.title.trim());
            fd.append('document_type', up.document_type);
            fd.append('category_id', up.category_id);
            const r = await documentsAPI.upload(fd);
            const d = r.data.data;
            add({ id: d.document_id, reference_code: d.reference, title: d.title, transaction_count: 0 });
            setUp(p => ({ ...p, title: '' }));
            setFile(null);
            if (fileRef.current) fileRef.current.value = '';
            setShowUpload(false);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setUploading(false);
        }
    };

    const shown = results.filter(d => !exclude.includes(d.id));

    return (
        <div className="rounded-lg border border-gray-200 p-3 space-y-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
                <p className="text-sm font-medium text-gray-700 flex items-center gap-1.5">
                    <PaperClipIcon className="h-4 w-4 text-gray-400" />
                    {label}{optional && <span className="text-xs font-normal text-gray-400">(optional)</span>}
                </p>
                <div className="flex gap-2">
                    <button type="button" onClick={() => { setOpen(o => !o); setShowUpload(false); }}
                        className="text-xs text-primary-700 hover:underline flex items-center gap-1">
                        <MagnifyingGlassIcon className="h-3.5 w-3.5" /> Pick existing
                    </button>
                    {canUpload && (
                        <button type="button" onClick={() => { setShowUpload(s => !s); setOpen(false); }}
                            className="text-xs text-primary-700 hover:underline flex items-center gap-1">
                            <ArrowUpTrayIcon className="h-3.5 w-3.5" /> Upload new
                        </button>
                    )}
                </div>
            </div>

            {value.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                    {value.map(d => (
                        <span key={d.id} className="inline-flex items-center gap-1 text-xs bg-primary-50 text-primary-800 rounded-full pl-2 pr-1 py-0.5 max-w-full">
                            <span className="font-mono">{d.reference_code}</span>
                            <span className="truncate max-w-[10rem]">— {d.title}</span>
                            <button type="button" onClick={() => remove(d.id)} aria-label={`Remove ${d.reference_code}`}
                                className="p-0.5 rounded-full hover:bg-primary-100">
                                <XMarkIcon className="h-3.5 w-3.5" />
                            </button>
                        </span>
                    ))}
                </div>
            )}
            {value.some(d => d.transaction_count > 0) && (
                <p className="text-[11px] text-amber-700 bg-amber-50 rounded px-2 py-1">
                    {value.filter(d => d.transaction_count > 0).map(d => `${d.reference_code} is already connected to ${d.transaction_count} transaction${d.transaction_count === 1 ? '' : 's'}`).join('; ')}
                    {' '}— it will be connected to this one as well.
                </p>
            )}
            {value.length === 0 && !open && !showUpload && (
                <p className="text-xs text-gray-400">No document connected. You can also connect documents later.</p>
            )}

            {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}

            {open && (
                <div className="space-y-1.5">
                    <input type="search" className="input text-sm" placeholder="Search by title or reference (DOC-…)" autoFocus
                        value={search} onChange={e => setSearch(e.target.value)} />
                    <div className="max-h-48 overflow-y-auto divide-y divide-gray-100 rounded border border-gray-100">
                        {searching && shown.length === 0 && <p className="text-xs text-gray-400 p-2">Searching…</p>}
                        {!searching && shown.length === 0 && <p className="text-xs text-gray-400 p-2">No documents found.</p>}
                        {shown.map(d => {
                            const chosen = chosenIds.includes(d.id);
                            const n = parseInt(d.transaction_count || 0, 10);
                            return (
                                <button key={d.id} type="button" disabled={chosen} onClick={() => add(d)}
                                    className={`w-full text-left px-2 py-1.5 flex items-start justify-between gap-2 ${chosen ? 'opacity-50' : 'hover:bg-gray-50'}`}>
                                    <span className="min-w-0">
                                        <span className="block text-sm text-gray-800 truncate">{d.title}</span>
                                        <span className="block text-[11px] text-gray-400">
                                            <span className="font-mono">{d.reference_code}</span> · {(d.document_type || '').replace(/_/g, ' ').toLowerCase()} · {formatDate(d.created_at)}
                                        </span>
                                    </span>
                                    <span className="flex-shrink-0 text-[11px] text-gray-500 flex items-center gap-1">
                                        {n > 0 && <LinkCount count={n} title={`Connected to ${n} transaction(s)`} />}
                                        {chosen ? 'Added' : 'Add'}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}

            {showUpload && canUpload && (
                <div className="space-y-2 bg-gray-50 rounded-lg p-2.5">
                    <input type="text" className="input text-sm" placeholder="Document title *"
                        value={up.title} onChange={e => setUp(p => ({ ...p, title: e.target.value }))} />
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <select className="input text-sm" value={up.document_type}
                            onChange={e => setUp(p => ({ ...p, document_type: e.target.value }))}>
                            {DOC_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ').toLowerCase()}</option>)}
                        </select>
                        <select className="input text-sm" value={up.category_id}
                            onChange={e => setUp(p => ({ ...p, category_id: e.target.value }))}>
                            <option value="">Category *</option>
                            {categories.map(c => <option key={c.id} value={c.id}>{c.full_path || c.name}</option>)}
                        </select>
                    </div>
                    <input ref={fileRef} type="file" className="input text-sm py-1.5"
                        accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png"
                        onChange={e => setFile(e.target.files[0] || null)} />
                    <div className="flex justify-end gap-2">
                        <button type="button" onClick={() => setShowUpload(false)} className="btn-secondary text-xs">Cancel</button>
                        <button type="button" onClick={doUpload} disabled={uploading} className="btn-primary text-xs">
                            {uploading ? 'Uploading…' : 'Upload & add'}
                        </button>
                    </div>
                    <p className="text-[11px] text-gray-400">The file is saved in Documents straight away (PDF, Word, Excel, JPEG, PNG — max 20 MB).</p>
                </div>
            )}
        </div>
    );
};

// The ids to send with a form.
export const documentIdsOf = (docs) => (docs && docs.length ? docs.map(d => d.id) : undefined);

// ------------------------------------------------------------
// CONNECTED DOCUMENTS OF ONE TRANSACTION (list + connect + disconnect)
// ------------------------------------------------------------
export const TransactionDocumentsBlock = ({ transactionId, documents, onChanged }) => {
    const confirm = useConfirm();
    const canConnect = useCanConnect();
    const [adding, setAdding] = useState(false);
    const [picked, setPicked] = useState([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    const connect = async () => {
        if (!picked.length) return;
        setBusy(true);
        setError(null);
        try {
            const r = await connectWithAlert(confirm, (confirmAdditional) => transactionsAPI.linkDocuments(transactionId, {
                document_ids: picked.map(d => d.id), confirm_additional: confirmAdditional || undefined,
            }));
            if (r) {
                setPicked([]);
                setAdding(false);
                onChanged(r.data.data.documents);
            }
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setBusy(false);
        }
    };

    const disconnect = async (doc) => {
        const ok = await confirm({
            title: 'Disconnect document',
            message: `Disconnect ${doc.reference_code} from this transaction? Neither the document nor the transaction is changed — only the connection is removed (and recorded in the audit trail).`,
            confirmLabel: 'Disconnect',
            danger: true,
        });
        if (!ok) return;
        try {
            const r = await transactionsAPI.unlinkDocument(transactionId, doc.document_id);
            onChanged(r.data.data.documents);
        } catch (err) {
            setError(getErrorMessage(err));
        }
    };

    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-gray-800 flex items-center gap-1.5">
                    <LinkIcon className="h-4 w-4 text-gray-400" /> Connected documents ({documents.length})
                </h3>
                {canConnect && !adding && (
                    <button type="button" onClick={() => setAdding(true)} className="text-xs text-primary-700 hover:underline">
                        + Connect document
                    </button>
                )}
            </div>
            {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
            {documents.length === 0 ? (
                <p className="text-xs text-gray-400">No document is connected to this transaction.</p>
            ) : (
                <div className="divide-y divide-gray-100 rounded-lg border border-gray-100">
                    {documents.map(d => (
                        <div key={d.link_id} className="flex items-start justify-between gap-2 px-2.5 py-2">
                            <div className="min-w-0">
                                {d.can_open ? (
                                    <Link to={`/documents?doc=${d.document_id}`} className="text-sm text-primary-700 hover:underline break-words">
                                        {d.title}
                                    </Link>
                                ) : (
                                    <span className="text-sm text-gray-500">{d.title}</span>
                                )}
                                <p className="text-[11px] text-gray-400">
                                    <span className="font-mono">{d.reference_code}</span>
                                    {d.document_type ? ` · ${d.document_type.replace(/_/g, ' ').toLowerCase()}` : ''}
                                    {` · connected ${d.linked_via === 'AT_ENTRY' ? 'when recorded' : 'later'} by ${d.linked_by_name}, ${formatDateTime(d.linked_at)}`}
                                </p>
                            </div>
                            {canConnect && (
                                <button type="button" onClick={() => disconnect(d)} title="Disconnect"
                                    className="p-1 rounded text-gray-400 hover:text-red-600 hover:bg-red-50 flex-shrink-0">
                                    <XMarkIcon className="h-4 w-4" />
                                </button>
                            )}
                        </div>
                    ))}
                </div>
            )}
            {adding && (
                <div className="space-y-2">
                    <DocumentPicker value={picked} onChange={setPicked} label="Documents to connect" optional={false}
                        exclude={documents.map(d => d.document_id)} />
                    <div className="flex justify-end gap-2">
                        <button type="button" onClick={() => { setAdding(false); setPicked([]); }} className="btn-secondary text-xs">Cancel</button>
                        <button type="button" onClick={connect} disabled={busy || !picked.length} className="btn-primary text-xs">
                            {busy ? 'Connecting…' : `Connect ${picked.length || ''}`}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};

// ------------------------------------------------------------
// ONE TRANSACTION — detail window
// ------------------------------------------------------------
export const TransactionDetailModal = ({ transactionId, onClose, onPrint = null, onChanged = null }) => {
    const [tx, setTx] = useState(null);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (!transactionId) return;
        setTx(null);
        setError(null);
        transactionsAPI.getById(transactionId).then(r => setTx(r.data.data)).catch(err => setError(getErrorMessage(err)));
    }, [transactionId]);

    if (!transactionId) return null;

    const Row = ({ label, children }) => (
        <div className="flex justify-between gap-4 py-1.5 text-sm">
            <span className="text-gray-500 flex-shrink-0">{label}</span>
            <span className="text-gray-900 text-right break-words min-w-0">{children}</span>
        </div>
    );

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            <div className="fixed inset-0 bg-black bg-opacity-40" onClick={onClose} />
            <div className="flex min-h-full items-center justify-center p-4">
                <div className="relative bg-white rounded-xl shadow-xl max-w-lg w-full p-5 sm:p-6">
                    <div className="flex items-start justify-between gap-3 mb-3">
                        <div className="min-w-0">
                            <h2 className="text-lg font-semibold text-gray-900">Transaction</h2>
                            {tx && <p className="font-mono text-xs text-primary-700 break-all">{tx.reference_code}</p>}
                        </div>
                        <button type="button" onClick={onClose} aria-label="Close" className="p-1 rounded hover:bg-gray-100">
                            <XMarkIcon className="h-5 w-5 text-gray-500" />
                        </button>
                    </div>
                    {error && <ErrorMessage message={error} />}
                    {!tx && !error && <p className="text-sm text-gray-400">Loading…</p>}
                    {tx && (
                        <>
                            <div className="divide-y divide-gray-50 mb-4">
                                <Row label="Amount">
                                    <span className={`font-semibold ${tx.transaction_type === 'CREDIT' ? 'text-green-600' : 'text-red-600'}`}>
                                        {tx.transaction_type === 'CREDIT' ? '+' : '−'}{money(tx.amount, tx.currency_code)}
                                    </span>
                                </Row>
                                <Row label="Account">{tx.account_name}</Row>
                                <Row label="Value date">{formatDate(tx.value_date)}</Row>
                                <Row label="Type">{(tx.inflow_type || tx.transaction_type || '').replace(/_/g, ' ').toLowerCase()}</Row>
                                <Row label="Category">{tx.category_trail || tx.category_name || '—'}</Row>
                                {tx.description && <Row label="Description">{tx.description}</Row>}
                                <Row label="Recorded by">{tx.created_by_name}{tx.posted_at ? `, ${formatDateTime(tx.posted_at)}` : ''}</Row>
                                <Row label="Status">
                                    <StatusBadge status={tx.is_reversed ? 'REVERSED' : tx.status} />
                                </Row>
                                {tx.public_id && <Row label="Public ID"><span className="font-mono text-xs">{tx.public_id}</span></Row>}
                            </div>
                            <TransactionDocumentsBlock transactionId={tx.id} documents={tx.documents || []}
                                onChanged={(docs) => {
                                    setTx(p => ({ ...p, documents: docs, document_count: docs.length }));
                                    if (onChanged) onChanged(tx.id, docs);
                                }} />
                            <div className="flex justify-end gap-2 pt-4">
                                {onPrint && (
                                    <button type="button" onClick={() => onPrint(tx)} className="btn-secondary flex items-center gap-2 text-sm">
                                        <PrinterIcon className="h-4 w-4" /> Print
                                    </button>
                                )}
                                <button type="button" onClick={onClose} className="btn-primary text-sm">Done</button>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};

// ------------------------------------------------------------
// TRANSACTIONS CONNECTED TO ONE DOCUMENT
//   data: { count, transactions, restricted }
// ------------------------------------------------------------
export const DocumentTransactionsBlock = ({ documentId, data, onChanged }) => {
    const confirm = useConfirm();
    const canConnect = useCanConnect();
    const [adding, setAdding] = useState(false);
    const [search, setSearch] = useState('');
    const [results, setResults] = useState([]);
    const [picked, setPicked] = useState([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const timer = useRef(null);

    useEffect(() => {
        if (!adding) return undefined;
        clearTimeout(timer.current);
        timer.current = setTimeout(() => {
            transactionsAPI.getAll({ search: search.trim() || undefined, limit: 10 })
                .then(r => setResults(r.data.data || [])).catch(() => setResults([]));
        }, 250);
        return () => clearTimeout(timer.current);
    }, [adding, search]);

    const connected = data.transactions || [];
    const connectedIds = connected.map(t => t.transaction_id);

    const connect = async () => {
        if (!picked.length) return;
        setBusy(true);
        setError(null);
        try {
            const r = await connectWithAlert(confirm, (confirmAdditional) => documentsAPI.linkTransactions(documentId, {
                transaction_ids: picked.map(t => t.id), confirm_additional: confirmAdditional || undefined,
            }));
            if (r) {
                setPicked([]);
                setAdding(false);
                onChanged({ count: r.data.data.count, transactions: r.data.data.transactions, restricted: r.data.data.restricted });
            }
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setBusy(false);
        }
    };

    const disconnect = async (t) => {
        const ok = await confirm({
            title: 'Disconnect transaction',
            message: `Disconnect ${t.reference_code} from this document? Only the connection is removed (and recorded in the audit trail).`,
            confirmLabel: 'Disconnect',
            danger: true,
        });
        if (!ok) return;
        try {
            const r = await documentsAPI.unlinkTransaction(documentId, t.transaction_id);
            onChanged(r.data.data);
        } catch (err) {
            setError(getErrorMessage(err));
        }
    };

    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-gray-800 flex items-center gap-1.5">
                    <LinkIcon className="h-4 w-4 text-gray-400" /> Connected transactions ({data.count || 0})
                </h3>
                {canConnect && !data.restricted && !adding && (
                    <button type="button" onClick={() => setAdding(true)} className="text-xs text-primary-700 hover:underline">
                        + Connect transaction
                    </button>
                )}
            </div>
            {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
            {data.restricted ? (
                <p className="text-xs text-gray-500">
                    {data.count ? `This document is connected to ${data.count} transaction${data.count === 1 ? '' : 's'}.` : 'No transaction is connected to this document.'}
                    {' '}Transaction details are visible to people with access to company finances.
                </p>
            ) : connected.length === 0 ? (
                <p className="text-xs text-gray-400">No transaction is connected to this document.</p>
            ) : (
                <div className="divide-y divide-gray-100 rounded-lg border border-gray-100">
                    {connected.map(t => (
                        <div key={t.link_id} className="flex items-start justify-between gap-2 px-2.5 py-2">
                            <div className="min-w-0">
                                <p className="text-sm text-gray-800">
                                    <span className="font-mono text-xs text-primary-700">{t.reference_code}</span>
                                    <span className={`ml-2 font-semibold ${t.transaction_type === 'CREDIT' ? 'text-green-600' : 'text-red-600'}`}>
                                        {t.transaction_type === 'CREDIT' ? '+' : '−'}{money(t.amount, t.currency_code)}
                                    </span>
                                    {t.is_reversed && <span className="ml-2 badge-gray">Reversed</span>}
                                </p>
                                <p className="text-[11px] text-gray-400 break-words">
                                    {formatDate(t.value_date)} · {t.account_name}{t.description ? ` · ${t.description}` : ''}
                                </p>
                            </div>
                            {canConnect && (
                                <button type="button" onClick={() => disconnect(t)} title="Disconnect"
                                    className="p-1 rounded text-gray-400 hover:text-red-600 hover:bg-red-50 flex-shrink-0">
                                    <XMarkIcon className="h-4 w-4" />
                                </button>
                            )}
                        </div>
                    ))}
                </div>
            )}
            {adding && (
                <div className="rounded-lg border border-gray-200 p-3 space-y-2">
                    <input type="search" className="input text-sm" placeholder="Search by reference or description" autoFocus
                        value={search} onChange={e => setSearch(e.target.value)} />
                    {picked.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                            {picked.map(t => (
                                <span key={t.id} className="inline-flex items-center gap-1 text-xs bg-primary-50 text-primary-800 rounded-full pl-2 pr-1 py-0.5">
                                    <span className="font-mono">{t.reference_code}</span>
                                    <button type="button" onClick={() => setPicked(p => p.filter(x => x.id !== t.id))} className="p-0.5 rounded-full hover:bg-primary-100">
                                        <XMarkIcon className="h-3.5 w-3.5" />
                                    </button>
                                </span>
                            ))}
                        </div>
                    )}
                    <div className="max-h-56 overflow-y-auto divide-y divide-gray-100 rounded border border-gray-100">
                        {results.filter(t => !connectedIds.includes(t.id)).map(t => {
                            const chosen = picked.some(p => p.id === t.id);
                            return (
                                <button key={t.id} type="button" disabled={chosen}
                                    onClick={() => setPicked(p => [...p, { id: t.id, reference_code: t.reference_code }])}
                                    className={`w-full text-left px-2 py-1.5 flex items-start justify-between gap-2 ${chosen ? 'opacity-50' : 'hover:bg-gray-50'}`}>
                                    <span className="min-w-0">
                                        <span className="block text-xs font-mono text-primary-700">{t.reference_code}</span>
                                        <span className="block text-[11px] text-gray-500 truncate">
                                            {formatDate(t.value_date)} · {money(t.amount, t.currency_code)} · {t.account_name}{t.description ? ` · ${t.description}` : ''}
                                        </span>
                                    </span>
                                    <span className="flex-shrink-0 text-[11px] text-gray-500 flex items-center gap-1">
                                        {parseInt(t.document_count || 0, 10) > 0 && <LinkCount count={t.document_count} title={`Connected to: ${t.document_refs}`} />}
                                        {chosen ? 'Added' : 'Add'}
                                    </span>
                                </button>
                            );
                        })}
                        {results.length === 0 && <p className="text-xs text-gray-400 p-2">No transactions found.</p>}
                    </div>
                    <div className="flex justify-end gap-2">
                        <button type="button" onClick={() => { setAdding(false); setPicked([]); }} className="btn-secondary text-xs">Cancel</button>
                        <button type="button" onClick={connect} disabled={busy || !picked.length} className="btn-primary text-xs">
                            {busy ? 'Connecting…' : `Connect ${picked.length || ''}`}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};


