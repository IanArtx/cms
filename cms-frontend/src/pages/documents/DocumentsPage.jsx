// ============================================================
// DOCUMENTS PAGE
// Shows all documents with upload, approval and archive management.
// Special archive section for foundational company documents.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { documentsAPI, categoriesAPI, staffAccessAPI, usersAPI, certificatesAPI } from '../../api/endpoints';
import { formatDate, formatFileSize, getErrorMessage, truncate, getUploadUrl } from '../../utils/helpers';
import {
    meetingAgendaTemplate, meetingMinutesTemplate, receiptTemplate, resolutionTemplate,
    auditorFeedbackTemplate, memberPortfolioTemplate, sharePurchaseReceiptTemplate,
    shareCapitalNoticeTemplate,
    whtCertificateTemplate,
    whtAgentNoticeTemplate,
    taxComputationTemplate,
    previewDocument, printDocument,
} from '../../utils/exportUtils';
import PageHeader from '../../components/common/PageHeader';
import DataTable from '../../components/common/DataTable';
import ErrorMessage from '../../components/common/ErrorMessage';
import StatusBadge from '../../components/common/StatusBadge';
import { useAuth } from '../../contexts/AuthContext';
import { useConfirm } from '../../contexts/ConfirmContext';
import {
    PlusIcon,
    CheckIcon,
    ArchiveBoxIcon,
    DocumentTextIcon,
    ShieldCheckIcon,
    EyeIcon,
    ArrowDownTrayIcon,
    UserPlusIcon,
    XMarkIcon,
    PencilSquareIcon,
    TrashIcon,
} from '@heroicons/react/24/outline';
import { useTabParam } from '../../hooks/useTabParam'; // v1.71.0 — tab kept in the address
import { useNewParam } from '../../hooks/useNewParam'; // v1.71.0 — "+ New" menu
// v1.78.0 — transactions connected to a document
import { DocumentTransactionsBlock, LinkCount } from '../../components/documents/TransactionDocuments';
import { renderGovernanceDocument } from '../../utils/governanceTemplates'; // v1.79.0 — statutory meeting documents

// Renderers for SYSTEM_GENERATED documents — same client-side template
// functions GenerateDocumentPage.jsx uses at creation time. Only the
// currently-supported generated types have one; anything else
// (documents generated before v1.15.0, or template types with no
// registered renderer) will show a friendly "can't be reconstructed"
// message instead of failing silently.
// v1.70.0 — auto-generated tax documents, by template_data.notice_kind
const TAX_RENDERERS = {
    WHT_CERTIFICATE: whtCertificateTemplate,
    WHT_AGENT_STATUS: whtAgentNoticeTemplate,
    TAX_COMPUTATION: taxComputationTemplate,
};

const GENERATED_RENDERERS = {
    MEETING_AGENDA:   meetingAgendaTemplate,
    MEETING_MINUTES:  meetingMinutesTemplate,
    RECEIPT:          receiptTemplate,
    RESOLUTION:       resolutionTemplate,
    AUDITOR_FEEDBACK: auditorFeedbackTemplate,
    // v1.34.0 — Member Portfolio Summary. As of v1.46.0 the Portfolio
    // page's Print action no longer saves a document here at all (it
    // was never supposed to) — this renderer only exists to still
    // preview/reopen documents of this type that were generated
    // before that fix, stored the same way as every other
    // SYSTEM_GENERATED document.
    FINANCIAL_REPORT_INDIVIDUAL: memberPortfolioTemplate,
};

// Uploaded file types the browser can render inline in a new tab.
// Everything else (Word, Excel) can only be downloaded, not previewed.
const PREVIEWABLE_MIME_TYPES = [
    'application/pdf', 'image/jpeg', 'image/png', 'image/gif',
];

// Reads an axios error whose response body is a Blob (because the
// request used responseType: 'blob') and tries to recover the JSON
// error message the backend actually sent, instead of showing a
// generic failure.
const getBlobErrorMessage = async (err) => {
    const blob = err?.response?.data;
    if (blob instanceof Blob && blob.type === 'application/json') {
        try {
            const text = await blob.text();
            const parsed = JSON.parse(text);
            if (parsed?.message) return parsed.message;
        } catch {
            // fall through to generic message below
        }
    }
    return getErrorMessage(err);
};

// Shared handler for both "Preview" and "Download" — fetches the
// document, tells uploaded files apart from generated ones by the
// response's content-type, and does the right thing for each.
const openDocument = async (doc, { forceDownload }) => {
    const res = await documentsAPI.download(doc.id);
    const blob = res.data;

    if (blob.type === 'application/json') {
        // SYSTEM_GENERATED — re-render client-side from saved field values.
        // The backend wraps this in the standard { success, message, data }
        // envelope (sendSuccess), so the actual fields are under `.data` —
        // reading them off the top-level object was the bug that made every
        // generated document's preview/download report "can't be
        // reconstructed" regardless of its type.
        const text = await blob.text();
        const envelope = JSON.parse(text);
        const payload = envelope.data || envelope;
        // v1.65.0 — RECEIPT covers two different renderers now: a
        // Share Purchase Receipt (auto-generated by
        // transactionsController.issueSharePurchaseReceipt, tagged
        // via template_data.receipt_kind) uses its own dedicated
        // template instead of the generic receiptTemplate, since it
        // shows shares held before/after rather than a plain payment
        // acknowledgement.
        // v1.69.0 — the auto-generated share capital notice to all
        // shareholders (template_data.notice_kind) has its own template.
        // v1.70.0 — tax documents (certificate, agent notice, computation).
        // v1.79.0 — statutory meeting documents (notice, proxy form,
        // register of attendance, statutory minutes, resolutions, written
        // resolutions, certified copies) carry template_data.doc_kind and
        // are rendered by governanceTemplates.js — checked first, since
        // their MEETING_MINUTES / RESOLUTION types also have the older
        // generic renderers below.
        const renderer = payload.template_data?.doc_kind
            ? renderGovernanceDocument
            : payload.template_data?.receipt_kind === 'SHARE_PURCHASE'
            ? sharePurchaseReceiptTemplate
            : payload.template_data?.notice_kind === 'SHARE_CAPITAL_CHANGE'
                ? shareCapitalNoticeTemplate
                : TAX_RENDERERS[payload.template_data?.notice_kind] || GENERATED_RENDERERS[payload.document_type];
        if (!renderer) {
            throw new Error(
                'This document type can\'t be reconstructed for preview/download.'
            );
        }
        // v1.57.2 — fetch the live signature slots (role/name/status/
        // signature image/signed date) so the re-rendered preview/
        // download prints an actual signature and date once someone
        // has signed, instead of always showing blank lines
        // regardless of signing status (exportUtils.js's
        // signatureBlock() does the matching/rendering). Best-effort:
        // a document type with no signature requirement configured
        // just gets an empty array back, which signatureBlock()
        // already treats the same as "not signed yet".
        let templateData = payload.template_data;
        try {
            const sigRes = await documentsAPI.getSignatures(doc.id);
            templateData = { ...templateData, signatures: sigRes.data.data || [] };
        } catch {
            // Best-effort — a signature-lookup failure shouldn't block preview/download
        }
        // v1.24.0 — once fully approved/signed, fetch whichever
        // company stamp(s) were baked onto this document (Section
        // 4.30) so the re-rendered preview/download shows it. A
        // draft (not yet fully_signed) never carries a stamp.
        if (doc.fully_signed) {
            try {
                const stampRes = await documentsAPI.getStamps(doc.id);
                templateData = { ...templateData, stamps: stampRes.data.data || [] };
            } catch {
                // Best-effort — a stamp-lookup failure shouldn't block preview/download
            }
        }
        const html = renderer(templateData);
        if (forceDownload) {
            printDocument(html, payload.title || doc.title);
        } else {
            previewDocument(html, payload.title || doc.title);
        }
        return;
    }

    // UPLOADED — a real file
    const url = URL.createObjectURL(blob);
    if (!forceDownload && PREVIEWABLE_MIME_TYPES.includes(blob.type)) {
        window.open(url, '_blank');
    } else {
        const a = document.createElement('a');
        a.href = url;
        a.download = doc.file_name || doc.title;
        document.body.appendChild(a);
        a.click();
        a.remove();
    }
    setTimeout(() => URL.revokeObjectURL(url), 10000);
};

const DOCUMENT_TYPES = [
    'MEETING_MINUTES', 'MEETING_AGENDA', 'INVESTMENT_PROPOSAL',
    'FINANCIAL_REPORT_GENERAL', 'FINANCIAL_REPORT_INDIVIDUAL',
    'RECEIPT', 'CONTRACT', 'LOAN_AGREEMENT', 'GRANT_AGREEMENT', 'OTHER',
    // v1.79.0 — statutory meeting documents (generated from Meetings;
    // a signed paper copy can also be uploaded under these types)
    'NOTICE_OF_MEETING', 'PROXY_FORM', 'ATTENDANCE_REGISTER', 'RESOLUTION', 'WRITTEN_RESOLUTION', 'CERTIFIED_RESOLUTION',
];

const ARCHIVE_TYPES = [
    { value: 'REGISTRATION', label: 'Registration Documents' },
    { value: 'TAX_FILING', label: 'Tax Filings' },
    { value: 'MOU', label: 'MOU & MOA' },
    { value: 'ACT', label: 'Acts & Regulations' },
    { value: 'LICENSE', label: 'Licenses & Permits' },
    { value: 'COMPLIANCE', label: 'Compliance Documents' },
    { value: 'LEGAL', label: 'Legal Agreements' },
    { value: 'OTHER', label: 'Other Foundational Documents' },
];

// ============================================================
// UPLOAD DOCUMENT MODAL
// ============================================================
const UploadModal = ({ isOpen, onClose, onSuccess, categories, isArchive = false }) => {
    const [form, setForm] = useState({
        category_id: '', title: '', document_type: isArchive ? 'OTHER' : 'OTHER',
        related_record_type: '', related_record_id: '',
        archive_type: 'REGISTRATION',
    });
    const [file,    setFile]    = useState(null);
    const [loading, setLoading] = useState(false);
    const [error,   setError]   = useState(null);

    if (!isOpen) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!file) { setError('Please select a file'); return; }
        setLoading(true);
        setError(null);
        try {
            const formData = new FormData();
            formData.append('document', file);
            formData.append('category_id', form.category_id);
            formData.append('title', form.title);
            formData.append('document_type', form.document_type);
            if (isArchive) {
                formData.append('related_record_type', 'COMPANY_ARCHIVE');
                formData.append('related_record_id', '0');
            }
            await documentsAPI.upload(formData);
            onSuccess();
            onClose();
            setForm({ category_id: '', title: '', document_type: 'OTHER',
                related_record_type: '', related_record_id: '',
                archive_type: 'REGISTRATION' });
            setFile(null);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    const docCategories = categories.filter(c => c.module === 'DOCUMENT');

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            <div className="fixed inset-0 bg-black bg-opacity-40" onClick={onClose} />
            <div className="flex min-h-full items-center justify-center p-4">
                <div className="relative bg-white rounded-xl shadow-xl max-w-lg w-full p-6">
                    <h2 className="text-lg font-semibold text-gray-900 mb-4">
                        {isArchive ? 'Upload to Company Archive' : 'Upload Document'}
                    </h2>
                    {isArchive && (
                        <div className="mb-4 bg-blue-50 border border-blue-200
                            rounded-lg p-3 flex items-start gap-2">
                            <ShieldCheckIcon className="h-5 w-5 text-blue-600
                                flex-shrink-0 mt-0.5" />
                            <p className="text-xs text-blue-700">
                                Archive documents are foundational company records
                                — registration, tax filings, licenses, MOUs and
                                legal agreements. These are permanently stored.
                            </p>
                        </div>
                    )}
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">Document Title *</label>
                            <input type="text" className="input" value={form.title}
                                onChange={e => setForm(p => ({ ...p, title: e.target.value }))}
                                required />
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            {isArchive ? (
                                <div>
                                    <label className="label">Archive Type *</label>
                                    <select className="input" value={form.archive_type}
                                        onChange={e => setForm(p => ({
                                            ...p, archive_type: e.target.value }))}>
                                        {ARCHIVE_TYPES.map(t => (
                                            <option key={t.value} value={t.value}>
                                                {t.label}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            ) : (
                                <div>
                                    <label className="label">Document Type *</label>
                                    <select className="input" value={form.document_type}
                                        onChange={e => setForm(p => ({
                                            ...p, document_type: e.target.value }))}>
                                        {DOCUMENT_TYPES.map(t => (
                                            <option key={t} value={t}>
                                                {t.replace(/_/g, ' ')}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            )}
                            <div>
                                <label className="label">Category *</label>
                                <select className="input" value={form.category_id}
                                    onChange={e => setForm(p => ({
                                        ...p, category_id: e.target.value }))}
                                    required>
                                    <option value="">Select category...</option>
                                    {docCategories.map(c => (
                                        <option key={c.id} value={c.id}>
                                            {c.full_path || c.name}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        </div>
                        <div>
                            <label className="label">File *</label>
                            <input type="file" className="input py-1.5"
                                onChange={e => setFile(e.target.files[0])}
                                accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png"
                                required />
                            <p className="text-xs text-gray-400 mt-1">
                                Accepted: PDF, Word, Excel, JPEG, PNG (max 20MB)
                            </p>
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose}
                                className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading}
                                className="btn-primary">
                                {loading ? 'Uploading...' : isArchive
                                    ? 'Upload to Archive'
                                    : 'Upload Document'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// COMPANY ARCHIVE SECTION
// ============================================================
const CompanyArchive = ({ categories }) => {
    const { hasPermission } = useAuth();
    const confirm = useConfirm();
    const [documents,   setDocuments]   = useState([]);
    const [loading,     setLoading]     = useState(true);
    const [error,       setError]       = useState(null);
    const [showUpload,  setShowUpload]  = useState(false);
    const [typeFilter,  setTypeFilter]  = useState('');
    const [actionLoading, setActionLoading] = useState(null);

    const handleView = async (doc) => {
        setActionLoading(doc.id);
        try {
            await openDocument(doc, { forceDownload: false });
        } catch (err) {
            setError(await getBlobErrorMessage(err));
        } finally {
            setActionLoading(null);
        }
    };

    const handleDownload = async (doc) => {
        setActionLoading(doc.id);
        try {
            await openDocument(doc, { forceDownload: true });
        } catch (err) {
            setError(await getBlobErrorMessage(err));
        } finally {
            setActionLoading(null);
        }
    };

    // v1.46.0 — the missing "take it back out" action. Soft removal
    // (see deleteDocument in documentsController.js) — the document
    // just disappears from every list, including this one.
    const handleRemove = async (doc) => {
        const ok = await confirm({
            title: 'Remove Document',
            message: `Remove "${doc.title}" from the archive? This can't be undone from here.`,
            confirmLabel: 'Remove',
            danger: true,
        });
        if (!ok) return;
        setActionLoading(doc.id);
        try {
            await documentsAPI.remove(doc.id);
            setDocuments(prev => prev.filter(d => d.id !== doc.id));
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setActionLoading(null);
        }
    };

    const loadArchive = useCallback(async () => {
        try {
            setLoading(true);
            const res = await documentsAPI.getAll({
                related_record_type: 'COMPANY_ARCHIVE',
                limit: 100,
            });
            setDocuments(res.data.data || []);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { loadArchive(); }, [loadArchive]);

    const filtered = typeFilter
        ? documents.filter(d => d.related_record_id === typeFilter)
        : documents;

    if (loading) return (
        <div className="text-center py-8 text-gray-400 text-sm">
            Loading archive...
        </div>
    );

    return (
        <div>
            {error && (
                <div className="mb-4">
                    <ErrorMessage message={error} onDismiss={() => setError(null)} />
                </div>
            )}

            {/* Archive Header */}
            <div className="bg-gradient-to-r from-primary-900 to-primary-700
                rounded-xl p-6 mb-6 text-white">
                <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                        <ShieldCheckIcon className="h-8 w-8 text-primary-200" />
                        <div>
                            <h3 className="text-lg font-bold">Company Archive</h3>
                            <p className="text-primary-200 text-sm mt-0.5">
                                Foundational documents — permanently stored and protected
                            </p>
                        </div>
                    </div>
                    {hasPermission('DOCUMENT_UPLOAD') && (
                        <button
                            onClick={() => setShowUpload(true)}
                            className="flex items-center gap-2 px-4 py-2
                                bg-white bg-opacity-20 hover:bg-opacity-30
                                rounded-lg text-sm font-medium transition-colors"
                        >
                            <PlusIcon className="h-4 w-4" />
                            Add to Archive
                        </button>
                    )}
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-4">
                    {ARCHIVE_TYPES.slice(0, 4).map(type => {
                        const count = documents.filter(
                            d => d.document_type === type.value
                        ).length;
                        return (
                            <div key={type.value} className="bg-white bg-opacity-10
                                rounded-lg p-3">
                                <p className="text-xs text-primary-200">{type.label}</p>
                                <p className="text-xl font-bold mt-1">{count}</p>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* Archive Grid */}
            {documents.length === 0 ? (
                <div className="text-center py-12">
                    <ShieldCheckIcon className="h-12 w-12 text-gray-200
                        mx-auto mb-3" />
                    <p className="text-gray-400 font-medium">
                        No archive documents yet
                    </p>
                    <p className="text-sm text-gray-300 mt-1">
                        Upload registration documents, tax filings,
                        licenses and legal agreements
                    </p>
                </div>
            ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {documents.map(doc => (
                        <div key={doc.id} className="card hover:shadow-md
                            transition-shadow border border-gray-100">
                            <div className="flex items-start gap-3">
                                <div className="w-10 h-10 rounded-lg bg-primary-50
                                    flex items-center justify-center flex-shrink-0">
                                    <DocumentTextIcon className="h-5 w-5
                                        text-primary-700" />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm font-semibold text-gray-900
                                        truncate">
                                        {doc.title}
                                    </p>
                                    <p className="text-xs text-gray-400 mt-0.5">
                                        {doc.document_type?.replace(/_/g, ' ')}
                                    </p>
                                    <div className="flex items-center gap-2 mt-2 flex-wrap">
                                        <span className="font-mono text-xs
                                            text-primary-600">
                                            {doc.reference_code}
                                        </span>
                                        <span className="text-gray-300">·</span>
                                        <span className="text-xs text-gray-400">
                                            v{doc.version}
                                        </span>
                                        {doc.public_id && (
                                            <>
                                                <span className="text-gray-300">·</span>
                                                <span className="font-mono text-[10px] text-gray-400"
                                                    title="Public ID — searchable">
                                                    {doc.public_id}
                                                </span>
                                            </>
                                        )}
                                    </div>
                                </div>
                                <StatusBadge status={doc.status} />
                            </div>
                            <div className="mt-3 pt-3 border-t border-gray-100
                                flex items-center justify-between">
                                <span className="text-xs text-gray-400">
                                    {formatDate(doc.created_at)}
                                </span>
                                <span className="text-xs text-gray-400">
                                    {formatFileSize(doc.file_size_bytes)}
                                </span>
                            </div>
                            <div className="mt-2 flex items-center gap-2">
                                <button
                                    onClick={() => handleView(doc)}
                                    disabled={actionLoading === doc.id}
                                    className="flex-1 flex items-center justify-center gap-1.5
                                        text-xs font-medium text-primary-700 py-1.5 rounded-lg
                                        border border-primary-200 hover:bg-primary-50 transition-colors"
                                >
                                    <EyeIcon className="h-3.5 w-3.5" />
                                    Preview
                                </button>
                                <button
                                    onClick={() => handleDownload(doc)}
                                    disabled={actionLoading === doc.id}
                                    className="flex-1 flex items-center justify-center gap-1.5
                                        text-xs font-medium text-blue-700 py-1.5 rounded-lg
                                        border border-blue-200 hover:bg-blue-50 transition-colors"
                                >
                                    <ArrowDownTrayIcon className="h-3.5 w-3.5" />
                                    Download
                                </button>
                                {hasPermission('DOCUMENT_DELETE') && (
                                    <button
                                        onClick={() => handleRemove(doc)}
                                        disabled={actionLoading === doc.id}
                                        title="Remove from the archive"
                                        className="flex items-center justify-center gap-1.5
                                            text-xs font-medium text-red-600 py-1.5 px-2 rounded-lg
                                            border border-red-200 hover:bg-red-50 transition-colors"
                                    >
                                        <TrashIcon className="h-3.5 w-3.5" />
                                    </button>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            )}

            <UploadModal
                isOpen={showUpload}
                onClose={() => setShowUpload(false)}
                onSuccess={loadArchive}
                categories={categories}
                isArchive={true}
            />
        </div>
    );
};

// ============================================================
// GRANT DOCUMENT ACCESS MODAL (Admin only)
// Lets an Admin give a finance-restricted staff member (e.g. an
// Administrative Officer) access to this one specific document,
// without exposing every Financial-category document to them.
// Mirrors the Audit Portal's per-document sharing pattern, but as
// a standing grant rather than a time-boxed engagement.
// ============================================================
// ============================================================
// MY DOCUMENTS TAB (v1.65.0) — a member's own Share Purchase Receipts,
// auto-generated each time one of their contributions is recorded
// (transactionsController.issueSharePurchaseReceipt). Deliberately its
// own simple list, not the shared "documents" DataTable/openDocument
// path — GET /documents/mine needs no DOCUMENT_VIEW permission (a
// plain Shareholder doesn't hold it) and already returns template_data
// directly in the list response, so preview/print never has to call
// the permission-gated GET /:id/download at all.
// ============================================================
const MyDocuments = () => {
    const [documents, setDocuments] = useState([]);
    const [loading,   setLoading]   = useState(true);
    const [error,     setError]     = useState(null);

    const load = useCallback(async () => {
        try {
            setLoading(true);
            const res = await documentsAPI.getMine({ limit: 100 });
            setDocuments(res.data.data || []);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, []);
    useEffect(() => { load(); }, [load]);

    const handlePreview = (doc, forceDownload) => {
        // v1.69.0 — My Documents also lists company notices addressed to
        // every shareholder (documents.audience = 'ALL_SHAREHOLDERS').
        const renderer = doc.template_data?.receipt_kind === 'SHARE_PURCHASE'
            ? sharePurchaseReceiptTemplate
            : doc.template_data?.notice_kind === 'SHARE_CAPITAL_CHANGE'
                ? shareCapitalNoticeTemplate
                : TAX_RENDERERS[doc.template_data?.notice_kind] || null;
        if (!renderer) {
            setError('This document type can\'t be reconstructed for preview.');
            return;
        }
        const html = renderer(doc.template_data);
        if (forceDownload) printDocument(html, doc.title);
        else previewDocument(html, doc.title);
    };

    if (loading) return (
        <div className="text-center py-8 text-gray-400 text-sm">Loading your documents...</div>
    );

    return (
        <div>
            {error && (
                <div className="mb-4">
                    <ErrorMessage message={error} onDismiss={() => setError(null)} />
                </div>
            )}
            {documents.length === 0 ? (
                <div className="card text-center py-10">
                    <DocumentTextIcon className="h-10 w-10 text-gray-200 mx-auto mb-3" />
                    <p className="text-gray-400 font-medium">No documents yet</p>
                    <p className="text-sm text-gray-300 mt-1">
                        A Share Purchase Receipt appears here automatically each time one of your
                        contributions is recorded, signed by the Treasurer. Notices to all shareholders
                        (for example a change of the share price) appear here too.
                    </p>
                </div>
            ) : (
                <div className="card divide-y divide-gray-100">
                    {documents.map(doc => (
                        <div key={doc.id} className="flex items-center justify-between py-3 gap-4 flex-wrap">
                            <div className="min-w-0">
                                <p className="text-sm font-medium text-gray-900 truncate">{doc.title}</p>
                                <p className="text-xs text-gray-400">
                                    {doc.reference_code} · {formatDate(doc.created_at)}
                                    {doc.audience === 'ALL_SHAREHOLDERS' && (
                                        <span className="ml-2 px-1.5 py-0.5 rounded bg-blue-50 text-blue-700">Notice to all shareholders</span>
                                    )}
                                </p>
                            </div>
                            <div className="flex items-center gap-2">
                                <button onClick={() => handlePreview(doc, false)}
                                    className="btn-secondary text-xs flex items-center gap-1">
                                    <EyeIcon className="h-4 w-4" />
                                    Preview
                                </button>
                                <button onClick={() => handlePreview(doc, true)}
                                    className="btn-secondary text-xs flex items-center gap-1">
                                    <ArrowDownTrayIcon className="h-4 w-4" />
                                    Print
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

// ============================================================
// SHAREHOLDING RECEIPTS TAB (v1.65.0, Treasury; grouped by month and
// Treasury-only since v1.67.0) — every member's Share Purchase
// Receipt, company-wide, grouped by the month of the contribution
// (newest month first), with each month's count and total in the
// share price's currency. Uses GET /documents/share-receipts, which is
// restricted to Treasurer / Assistant Treasurer / Admin (not to
// DOCUMENT_VIEW, which Secretary and Directors also hold) and returns
// template_data directly, so preview/print never needs a second call.
// These receipts are personal documents (documents.owner_user_id) and
// no longer appear in the shared "All Documents" list.
// ============================================================
const monthLabel = (ym) => {
    const [y, m] = ym.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
};
const fmtMoney = (n) => parseFloat(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const ShareholdingReceipts = () => {
    const [documents, setDocuments] = useState([]);
    const [loading,   setLoading]   = useState(true);
    const [error,     setError]     = useState(null);
    const [monthFilter, setMonthFilter] = useState('');
    const [collapsed, setCollapsed] = useState({});

    const load = useCallback(async () => {
        try {
            setLoading(true);
            const res = await documentsAPI.getShareReceipts();
            setDocuments(res.data.data || []);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, []);
    useEffect(() => { load(); }, [load]);

    const handlePreview = (doc, forceDownload) => {
        const html = sharePurchaseReceiptTemplate(doc.template_data || {});
        if (forceDownload) printDocument(html, doc.title);
        else previewDocument(html, doc.title);
    };

    if (loading) return (
        <div className="text-center py-8 text-gray-400 text-sm">Loading receipts...</div>
    );

    // Group by contribution month, newest first (the API already sorts).
    const groups = [];
    const byMonth = new Map();
    for (const doc of documents) {
        if (!byMonth.has(doc.month)) {
            const g = { month: doc.month, docs: [], totals: {} };
            byMonth.set(doc.month, g);
            groups.push(g);
        }
        const g = byMonth.get(doc.month);
        g.docs.push(doc);
        const td = doc.template_data || {};
        const cur = td.share_currency_code || td.currency_code || '';
        const amt = td.amount_in_share_currency != null ? td.amount_in_share_currency : td.amount;
        g.totals[cur] = (g.totals[cur] || 0) + parseFloat(amt || 0);
    }
    const visibleGroups = monthFilter ? groups.filter(g => g.month === monthFilter) : groups;

    return (
        <div>
            {error && (
                <div className="mb-4">
                    <ErrorMessage message={error} onDismiss={() => setError(null)} />
                </div>
            )}
            {documents.length === 0 ? (
                <div className="card text-center py-10">
                    <DocumentTextIcon className="h-10 w-10 text-gray-200 mx-auto mb-3" />
                    <p className="text-gray-400 font-medium">No share purchase receipts yet</p>
                    <p className="text-sm text-gray-300 mt-1">
                        One is generated automatically each time a contribution is recorded.
                    </p>
                </div>
            ) : (
                <>
                    <div className="card mb-4 flex flex-wrap items-center gap-3">
                        <select className="input w-56" value={monthFilter} onChange={e => setMonthFilter(e.target.value)}>
                            <option value="">All months</option>
                            {groups.map(g => <option key={g.month} value={g.month}>{monthLabel(g.month)}</option>)}
                        </select>
                        <p className="text-xs text-gray-400">
                            {documents.length} receipt(s) across {groups.length} month(s). Visible to Treasury only;
                            each shareholder sees their own under My Documents.
                        </p>
                    </div>
                    {visibleGroups.map(g => (
                        <div key={g.month} className="card mb-4">
                            <button
                                className="w-full flex items-center justify-between text-left"
                                onClick={() => setCollapsed(c => ({ ...c, [g.month]: !c[g.month] }))}
                            >
                                <span className="font-semibold text-gray-900">{monthLabel(g.month)}</span>
                                <span className="text-xs text-gray-500">
                                    {g.docs.length} receipt(s) · {Object.entries(g.totals).map(([cur, t]) => `${cur} ${fmtMoney(t)}`).join(' + ')}
                                    {collapsed[g.month] ? ' ▸' : ' ▾'}
                                </span>
                            </button>
                            {!collapsed[g.month] && (
                                <div className="divide-y divide-gray-100 mt-3">
                                    {g.docs.map(doc => {
                                        const td = doc.template_data || {};
                                        const cur = td.share_currency_code || td.currency_code || '';
                                        const amt = td.amount_in_share_currency != null ? td.amount_in_share_currency : td.amount;
                                        return (
                                            <div key={doc.id} className="flex items-center justify-between py-3 gap-4 flex-wrap">
                                                <div className="min-w-0">
                                                    <p className="text-sm font-medium text-gray-900 truncate">{doc.owner_name}</p>
                                                    <p className="text-xs text-gray-400">
                                                        {doc.reference_code} · contributed {formatDate(doc.contribution_date)} ·{' '}
                                                        {cur} {fmtMoney(amt)} · {fmtMoney(td.shares_purchased)} share(s)
                                                    </p>
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    <button onClick={() => handlePreview(doc, false)}
                                                        className="btn-secondary text-xs flex items-center gap-1">
                                                        <EyeIcon className="h-4 w-4" />
                                                        Preview
                                                    </button>
                                                    <button onClick={() => handlePreview(doc, true)}
                                                        className="btn-secondary text-xs flex items-center gap-1">
                                                        <ArrowDownTrayIcon className="h-4 w-4" />
                                                        Print
                                                    </button>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    ))}
                </>
            )}
        </div>
    );
};

// ============================================================
// SIGNATURES MODAL (v1.23.0, Section 4.29; generalized v1.44.0)
// Shown once signature slots exist for a target (i.e. an Admin has
// configured signature_requirements for that document type and
// someone has called Approve/opened the round at least once). Lists
// every required role, who — if anyone — has signed, and offers a
// Sign button to the current user if their role still has a pending
// slot. Works for both a regular document (target.targetType
// 'DOCUMENT') and a share-certificate signing round
// ('CERTIFICATE_ROUND') — the two use slightly different endpoints
// under the hood (documentsAPI vs certificatesAPI) but render
// identically, since both are backed by the same document_signatures
// table server-side.
// ============================================================
const SignaturesModal = ({ isOpen, target, onClose, onSigned }) => {
    const { hasRole, user } = useAuth();
    const [signatures, setSignatures] = useState([]);
    const [stamps, setStamps] = useState([]);
    const [loading, setLoading] = useState(true);
    const [signing, setSigning] = useState(false);
    const [error, setError] = useState(null);
    const isRound = target?.targetType === 'CERTIFICATE_ROUND';

    const load = useCallback(async () => {
        if (!target) return;
        try {
            setLoading(true);
            if (isRound) {
                const roundRes = await certificatesAPI.getRoundById(target.id);
                setSignatures(roundRes.data.data.signatures || []);
                setStamps(roundRes.data.data.stamps || []);
            } else {
                const [sigRes, stampRes] = await Promise.all([
                    documentsAPI.getSignatures(target.id),
                    documentsAPI.getStamps(target.id).catch(() => ({ data: { data: [] } })),
                ]);
                setSignatures(sigRes.data.data || []);
                setStamps(stampRes.data.data || []);
            }
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, [target, isRound]);

    useEffect(() => { if (isOpen) load(); }, [isOpen, load]);

    if (!isOpen || !target) return null;

    // A PENDING slot is "mine" one of two ways: it's a role-based
    // slot and I hold that role (hasRole), OR — v1.45.0's
    // person-specific signatories (e.g. a named Chairman/Secretary on
    // a Meeting Minutes/Agenda/Resolution) — it names ME directly via
    // required_user_id, regardless of my system roles. The old check
    // only handled the role-based case, so a person-specific slot
    // like "Chairman" (never a real system role) could never show a
    // Sign button for its designated signer even though the backend
    // (signatureService.signSlot) has always allowed it.
    const myPendingSlot = signatures.find(s => s.status === 'PENDING' &&
        (s.required_user_id ? s.required_user_id === user?.id : hasRole(s.role_name)));
    const allSigned = signatures.length > 0 && signatures.every(s => s.status === 'SIGNED');

    const handleSign = async () => {
        setError(null);
        setSigning(true);
        try {
            if (isRound) {
                await certificatesAPI.signRound(target.id);
            } else {
                await documentsAPI.sign(target.id);
            }
            await load();
            if (onSigned) onSigned();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setSigning(false);
        }
    };

    return (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
                <div className="flex items-center justify-between mb-4">
                    <h3 className="text-lg font-semibold text-gray-900">Signatures — {target.title}</h3>
                    <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
                        <XMarkIcon className="h-5 w-5" />
                    </button>
                </div>

                {error && <ErrorMessage message={error} />}

                {loading ? (
                    <p className="text-sm text-gray-400">Loading...</p>
                ) : signatures.length === 0 ? (
                    <p className="text-sm text-gray-500">
                        No signature requirement is configured for this document type
                        (Settings &rarr; Signatories), or Approve hasn't been clicked yet.
                    </p>
                ) : (
                    <div className="space-y-2 mb-4">
                        {signatures.map(sig => (
                            <div key={sig.role_id} className="flex items-center justify-between
                                border border-gray-200 rounded-lg p-3">
                                <div>
                                    <p className="text-sm font-medium text-gray-900">{sig.role_name}</p>
                                    {sig.signer_name && (
                                        <p className="text-xs text-gray-500">{sig.signer_name}</p>
                                    )}
                                </div>
                                {sig.status === 'SIGNED' ? (
                                    sig.signature_url ? (
                                        <img src={getUploadUrl(sig.signature_url)} alt="Signature" className="h-8" />
                                    ) : (
                                        <CheckIcon className="h-5 w-5 text-green-600" />
                                    )
                                ) : (
                                    <span className="text-xs font-medium text-amber-600">Pending</span>
                                )}
                            </div>
                        ))}
                    </div>
                )}

                {allSigned && (
                    <p className="text-sm text-green-600 mb-3">Fully signed and finalised.</p>
                )}

                {stamps.length > 0 && (
                    <div className="border-t border-gray-100 pt-3 mb-3">
                        <p className="text-xs text-gray-500 mb-2">Company stamp applied</p>
                        <div className="flex flex-wrap gap-3">
                            {stamps.map(stamp => (
                                <div key={stamp.stamp_id} className="flex flex-col items-center gap-1">
                                    <img src={getUploadUrl(stamp.file_path)} alt={stamp.name} className="h-12 w-12 object-contain" />
                                    <span className="text-xs text-gray-500">{stamp.name}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {myPendingSlot && !allSigned && (
                    <button onClick={handleSign} disabled={signing} className="btn-primary w-full text-sm">
                        {signing ? 'Signing...' : `Sign as ${myPendingSlot.role_name}`}
                    </button>
                )}
            </div>
        </div>
    );
};

const GrantAccessModal = ({ isOpen, document, onClose }) => {
    const [grants, setGrants] = useState([]);
    const [users, setUsers] = useState([]);
    const [userId, setUserId] = useState('');
    const [loading, setLoading] = useState(false);
    const [listLoading, setListLoading] = useState(true);
    const [error, setError] = useState(null);

    const loadGrants = useCallback(async () => {
        if (!document) return;
        try {
            setListLoading(true);
            const res = await staffAccessAPI.listGrants({ document_id: document.id });
            setGrants(res.data.data || []);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setListLoading(false);
        }
    }, [document]);

    useEffect(() => {
        if (!isOpen || !document) return;
        loadGrants();
        usersAPI.getAllUsers({ is_active: true, limit: 500 }).then(r => setUsers(r.data.data || [])).catch(() => {});
    }, [isOpen, document, loadGrants]);

    if (!isOpen || !document) return null;

    const handleGrant = async (e) => {
        e.preventDefault();
        if (!userId) return;
        setLoading(true);
        setError(null);
        try {
            await staffAccessAPI.grantDocument({ document_id: document.id, user_id: parseInt(userId) });
            setUserId('');
            loadGrants();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    const handleRevoke = async (grantId) => {
        setLoading(true);
        setError(null);
        try {
            await staffAccessAPI.revokeGrant(grantId);
            loadGrants();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            <div className="fixed inset-0 bg-black bg-opacity-40" onClick={onClose} />
            <div className="flex min-h-full items-center justify-center p-4">
                <div className="relative bg-white rounded-xl shadow-xl max-w-lg w-full p-6 max-h-screen overflow-y-auto">
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">Grant Document Access</h2>
                    <p className="text-sm text-gray-400 mb-4">
                        {truncate(document.title, 60)} — grants a finance-restricted staff member (e.g. an Administrative Officer) access to this document only.
                    </p>
                    {error && <div className="mb-4"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}

                    <div className="mb-4">
                        <p className="text-xs font-semibold text-gray-500 mb-2">Currently granted to</p>
                        {listLoading ? (
                            <p className="text-sm text-gray-400">Loading...</p>
                        ) : grants.length === 0 ? (
                            <p className="text-sm text-gray-400">No one has been granted access to this document yet.</p>
                        ) : (
                            <ul className="space-y-1.5">
                                {grants.map(g => (
                                    <li key={g.id} className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2">
                                        <span className="text-sm text-gray-700">{g.user_name || g.user_email}</span>
                                        <button onClick={() => handleRevoke(g.id)} disabled={loading}
                                            className="p-1 rounded text-red-500 hover:bg-red-50 transition-colors" title="Revoke access">
                                            <XMarkIcon className="h-4 w-4" />
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>

                    <form onSubmit={handleGrant} className="flex items-end gap-2 pt-2 border-t border-gray-100">
                        <div className="flex-1">
                            <label className="label">Grant to</label>
                            <select className="input" value={userId} onChange={e => setUserId(e.target.value)}>
                                <option value="">Select person...</option>
                                {users.map(u => (
                                    <option key={u.id} value={u.id}>{u.first_name} {u.last_name} ({u.email})</option>
                                ))}
                            </select>
                        </div>
                        <button type="submit" disabled={loading || !userId} className="btn-primary">
                            {loading ? 'Granting...' : 'Grant'}
                        </button>
                    </form>

                    <div className="flex justify-end pt-4">
                        <button type="button" onClick={onClose} className="btn-secondary">Close</button>
                    </div>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// MAIN DOCUMENTS PAGE
// ============================================================
// ============================================================
// DOCUMENT DETAIL WINDOW (v1.78.0)
// One document: its details, Preview/Download, and the transactions it
// is connected to (with connect / disconnect for finance staff). Opened
// from the list (title, reference or the 🔗 count) or by address
// (/documents?doc=<id>, used by a transaction's "Connected documents").
// ============================================================
const DocumentDetailModal = ({ documentId, onClose, onChanged }) => {
    const [doc, setDoc] = useState(null);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!documentId) return;
        setDoc(null);
        setError(null);
        documentsAPI.getById(documentId).then(r => setDoc(r.data.data)).catch(err => setError(getErrorMessage(err)));
    }, [documentId]);

    if (!documentId) return null;

    const open = async (forceDownload) => {
        setBusy(true);
        try {
            await openDocument(doc, { forceDownload });
        } catch (err) {
            setError(await getBlobErrorMessage(err));
        } finally {
            setBusy(false);
        }
    };

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
                            <h2 className="text-lg font-semibold text-gray-900 break-words">{doc ? doc.title : 'Document'}</h2>
                            {doc && <p className="font-mono text-xs text-primary-700 break-all">{doc.reference_code}</p>}
                        </div>
                        <button type="button" onClick={onClose} aria-label="Close" className="p-1 rounded hover:bg-gray-100">
                            <XMarkIcon className="h-5 w-5 text-gray-500" />
                        </button>
                    </div>
                    {error && <div className="mb-3"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}
                    {!doc && !error && <p className="text-sm text-gray-400">Loading…</p>}
                    {doc && (
                        <>
                            <div className="divide-y divide-gray-50 mb-4">
                                <Row label="Type">{(doc.document_type || '').replace(/_/g, ' ').toLowerCase()}{doc.source === 'SYSTEM_GENERATED' ? ' (generated)' : ''}</Row>
                                <Row label="Category">{doc.category_trail || doc.category_name || '—'}</Row>
                                {doc.file_name && <Row label="File">{doc.file_name}{doc.file_size_bytes ? ` · ${formatFileSize(doc.file_size_bytes)}` : ''}</Row>}
                                <Row label="Version">v{doc.version}</Row>
                                <Row label="Status"><StatusBadge status={doc.status} /></Row>
                                <Row label="Created">{doc.created_by_name}, {formatDate(doc.created_at)}</Row>
                                {doc.approved_by_name && <Row label="Approved">{doc.approved_by_name}{doc.approved_at ? `, ${formatDate(doc.approved_at)}` : ''}</Row>}
                                {doc.public_id && <Row label="Public ID"><span className="font-mono text-xs">{doc.public_id}</span></Row>}
                            </div>
                            <DocumentTransactionsBlock
                                documentId={doc.id}
                                data={{ count: doc.transaction_count || 0, transactions: doc.transactions || [], restricted: !!doc.transactions_restricted }}
                                onChanged={(d) => {
                                    setDoc(p => ({ ...p, transaction_count: d.count, transactions: d.transactions || [], transactions_restricted: !!d.restricted }));
                                    if (onChanged) onChanged(doc.id, d.count);
                                }}
                            />
                            <div className="flex justify-end gap-2 pt-4 flex-wrap">
                                <button type="button" disabled={busy} onClick={() => open(false)} className="btn-secondary text-sm flex items-center gap-1.5">
                                    <EyeIcon className="h-4 w-4" /> Preview
                                </button>
                                <button type="button" disabled={busy} onClick={() => open(true)} className="btn-secondary text-sm flex items-center gap-1.5">
                                    <ArrowDownTrayIcon className="h-4 w-4" /> Download
                                </button>
                                <button type="button" onClick={onClose} className="btn-primary text-sm">Done</button>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};

const DocumentsPage = () => {
    const { hasPermission, hasRole } = useAuth();
    // v1.78.0 — /documents?doc=<id> opens that document's detail window
    const [searchParams, setSearchParams] = useSearchParams();
    const detailId = searchParams.get('doc');
    const openDetail = (id) => setSearchParams(prev => {
        const p = new URLSearchParams(prev);
        if (id) p.set('doc', String(id)); else p.delete('doc');
        return p;
    }, { replace: true });
    // v1.67.0 — who may see every member's Share Purchase Receipts.
    const isTreasury = hasRole('Treasurer') || hasRole('Assistant Treasurer') || hasRole('Admin');
    const confirm = useConfirm();
    const navigate = useNavigate();
    const [documents,  setDocuments]  = useState([]);
    const [categories, setCategories] = useState([]);
    const [pagination, setPagination] = useState(null);
    const [loading,    setLoading]    = useState(true);
    const [error,      setError]      = useState(null);
    const [page,       setPage]       = useState(1);
    const [showUpload, setShowUpload] = useState(false);
    // v1.71.0 — opened from the "+ New" menu (?new=1)
    useNewParam(() => { if (hasPermission('DOCUMENT_UPLOAD')) setShowUpload(true); });
    const [activeTab,  setActiveTab]  = useTabParam('documents');
    const [actionLoading, setActionLoading] = useState(null);
    const [grantingDoc, setGrantingDoc] = useState(null);
    const [signaturesTarget, setSignaturesTarget] = useState(null);
    const [pendingSignatures, setPendingSignatures] = useState([]);
    const [pendingLoading, setPendingLoading] = useState(true);
    const canGrantAccess = hasRole('Admin');
    // v1.44.0 — widened from the original 3 to every type a `documents`
    // row can actually take (SHARE_CERTIFICATE never appears here, since
    // certificates live in their own table/round, not this one) — the
    // pencil icon shows on any row now; the modal itself already says
    // "no signature requirement configured" when nothing's been set up
    // for that particular type in Settings -> Signatories.
    const SIGNABLE_DOCUMENT_TYPES = [
        'MEETING_MINUTES', 'MEETING_AGENDA', 'INVESTMENT_PROPOSAL',
        'FINANCIAL_REPORT_GENERAL', 'FINANCIAL_REPORT_INDIVIDUAL',
        'RECEIPT', 'RESOLUTION', 'CONTRACT', 'LOAN_AGREEMENT', 'GRANT_AGREEMENT',
        'AUDITOR_FEEDBACK', 'AUDIT_REPORT', 'OTHER',
        'NOTICE_OF_MEETING', 'PROXY_FORM', 'ATTENDANCE_REGISTER', 'WRITTEN_RESOLUTION', 'CERTIFIED_RESOLUTION', // v1.79.0
    ];

    const [typeFilter,   setTypeFilter]   = useState('');
    const [statusFilter, setStatusFilter] = useState('');

    const loadDocuments = useCallback(async () => {
        try {
            setLoading(true);
            const params = { page, limit: 20 };
            if (typeFilter)   params.document_type = typeFilter;
            if (statusFilter) params.status        = statusFilter;
            const res = await documentsAPI.getAll(params);
            setDocuments(res.data.data);
            setPagination(res.data.meta?.pagination);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, [page, typeFilter, statusFilter]);

    // v1.44.0 — everything currently awaiting my own signature, across
    // both regular documents and share-certificate signing rounds.
    // Loaded independently of the main document list/pagination so it
    // stays accurate regardless of which tab/filter is active.
    const loadPendingSignatures = useCallback(async () => {
        try {
            setPendingLoading(true);
            const res = await documentsAPI.getPendingSignatures();
            setPendingSignatures(res.data.data || []);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setPendingLoading(false);
        }
    }, []);

    useEffect(() => {
        loadDocuments();
        loadPendingSignatures();
        categoriesAPI.getAll({ flat: true })
            .then(r => setCategories(r.data.data)).catch(() => {});
    }, [loadDocuments, loadPendingSignatures]);

    const handleApprove = async (id) => {
        setActionLoading(id);
        try {
            await documentsAPI.approve(id);
            loadDocuments();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setActionLoading(null);
        }
    };

    const handleArchive = async (id) => {
        setActionLoading(id);
        try {
            await documentsAPI.archive(id);
            loadDocuments();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setActionLoading(null);
        }
    };

    // v1.46.0 — the missing "take it back out" action for a document
    // that's already ARCHIVED. Soft removal (see deleteDocument in
    // documentsController.js) — it just disappears from every list.
    const handleRemove = async (id, title) => {
        const ok = await confirm({
            title: 'Remove Document',
            message: `Remove "${title}" from the archive? This can't be undone from here.`,
            confirmLabel: 'Remove',
            danger: true,
        });
        if (!ok) return;
        setActionLoading(id);
        try {
            await documentsAPI.remove(id);
            loadDocuments();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setActionLoading(null);
        }
    };

    const handleView = async (doc) => {
        setActionLoading(doc.id);
        try {
            await openDocument(doc, { forceDownload: false });
        } catch (err) {
            setError(await getBlobErrorMessage(err));
        } finally {
            setActionLoading(null);
        }
    };

    const handleDownload = async (doc) => {
        setActionLoading(doc.id);
        try {
            await openDocument(doc, { forceDownload: true });
        } catch (err) {
            setError(await getBlobErrorMessage(err));
        } finally {
            setActionLoading(null);
        }
    };

    const columns = [
        {
            header: 'Reference',
            render: row => (
                <div>
                    <button type="button" onClick={() => openDetail(row.id)}
                        className="font-mono text-xs font-medium text-primary-700 hover:underline"
                        title="Open — details and connected transactions">
                        {row.reference_code}
                    </button>
                    {row.public_id && (
                        <div className="font-mono text-[10px] text-gray-400" title="Public ID — searchable">
                            {row.public_id}
                        </div>
                    )}
                </div>
            ),
        },
        {
            header: 'Document',
            render: row => (
                <div>
                    <button type="button" onClick={() => openDetail(row.id)}
                        className="text-sm font-medium text-gray-900 hover:text-primary-700 hover:underline text-left">
                        {truncate(row.title, 40)}
                    </button>
                    <p className="text-xs text-gray-400">
                        {row.document_type?.replace(/_/g, ' ')}
                        {row.source === 'SYSTEM_GENERATED' && ' • Generated'}
                    </p>
                </div>
            ),
        },
        {
            // v1.78.0 — how many transactions this document is connected to
            header: 'Transactions',
            render: row => (
                <LinkCount count={row.transaction_count} onClick={() => openDetail(row.id)}
                    title={parseInt(row.transaction_count || 0, 10) ? `Connected to ${row.transaction_count} transaction(s)` : 'Not connected to a transaction'} />
            ),
        },
        {
            header: 'Category',
            render: row => (
                <span className="text-xs text-gray-500">
                    {row.category_trail || row.category_name}
                </span>
            ),
        },
        {
            header: 'File',
            render: row => (
                <div>
                    <p className="text-xs text-gray-600">
                        {row.file_name ? truncate(row.file_name, 25) : 'Generated'}
                    </p>
                    <p className="text-xs text-gray-400">
                        {formatFileSize(row.file_size_bytes)}
                    </p>
                </div>
            ),
        },
        {
            header: 'Version',
            render: row => (
                <span className="text-sm text-gray-600">v{row.version}</span>
            ),
        },
        {
            header: 'Uploaded',
            render: row => (
                <span className="text-sm text-gray-500">
                    {formatDate(row.created_at)}
                </span>
            ),
        },
        {
            header: 'Status',
            render: row => <StatusBadge status={row.status} />,
        },
        {
            header: 'Actions',
            render: row => (
                <div className="flex gap-2">
                    <button
                        onClick={() => handleView(row)}
                        disabled={actionLoading === row.id}
                        className="p-1.5 rounded-lg bg-primary-50 text-primary-600
                            hover:bg-primary-100 transition-colors"
                        title="Preview"
                    >
                        <EyeIcon className="h-4 w-4" />
                    </button>
                    <button
                        onClick={() => handleDownload(row)}
                        disabled={actionLoading === row.id}
                        className="p-1.5 rounded-lg bg-blue-50 text-blue-600
                            hover:bg-blue-100 transition-colors"
                        title="Download"
                    >
                        <ArrowDownTrayIcon className="h-4 w-4" />
                    </button>
                    {row.status === 'DRAFT' && hasPermission('DOCUMENT_APPROVE') && (
                        <button
                            onClick={() => handleApprove(row.id)}
                            disabled={actionLoading === row.id}
                            className="p-1.5 rounded-lg bg-green-50 text-green-600
                                hover:bg-green-100 transition-colors"
                            title="Approve"
                        >
                            <CheckIcon className="h-4 w-4" />
                        </button>
                    )}
                    {/* v1.23.0 — multi-signatory approval (Section 4.29). Shown
                        for signable types regardless of status, so anyone can
                        check who's signed a FINAL document too, not just act
                        on a pending one. */}
                    {SIGNABLE_DOCUMENT_TYPES.includes(row.document_type) && (
                        <button
                            onClick={() => setSignaturesTarget({ id: row.id, title: row.title, targetType: 'DOCUMENT' })}
                            className={`p-1.5 rounded-lg transition-colors ${
                                row.fully_signed
                                    ? 'bg-green-50 text-green-600 hover:bg-green-100'
                                    : 'bg-amber-50 text-amber-600 hover:bg-amber-100'
                            }`}
                            title="Signatures"
                        >
                            <PencilSquareIcon className="h-4 w-4" />
                        </button>
                    )}
                    {['DRAFT','FINAL'].includes(row.status) &&
                     hasPermission('DOCUMENT_ARCHIVE') && (
                        <button
                            onClick={() => handleArchive(row.id)}
                            disabled={actionLoading === row.id}
                            className="p-1.5 rounded-lg bg-gray-50 text-gray-500
                                hover:bg-gray-100 transition-colors"
                            title="Archive"
                        >
                            <ArchiveBoxIcon className="h-4 w-4" />
                        </button>
                    )}
                    {row.status === 'ARCHIVED' && hasPermission('DOCUMENT_DELETE') && (
                        <button
                            onClick={() => handleRemove(row.id, row.title)}
                            disabled={actionLoading === row.id}
                            className="p-1.5 rounded-lg bg-red-50 text-red-600
                                hover:bg-red-100 transition-colors"
                            title="Remove from archive"
                        >
                            <TrashIcon className="h-4 w-4" />
                        </button>
                    )}
                    {canGrantAccess && (
                        <button
                            onClick={() => setGrantingDoc(row)}
                            disabled={actionLoading === row.id}
                            className="p-1.5 rounded-lg bg-purple-50 text-purple-600
                                hover:bg-purple-100 transition-colors"
                            title="Grant staff access"
                        >
                            <UserPlusIcon className="h-4 w-4" />
                        </button>
                    )}
                </div>
            ),
        },
    ];

    return (
        <div>
            <PageHeader
                title="Documents"
                subtitle="Company document library — upload, generate and manage"
                actions={
                    hasPermission('DOCUMENT_UPLOAD') && activeTab === 'documents' && (
                        <div className="flex gap-2">
                            <button
                                onClick={() => navigate('/documents/generate')}
                                className="btn-secondary flex items-center gap-2"
                            >
                                <DocumentTextIcon className="h-4 w-4" />
                                Generate
                            </button>
                            <button
                                onClick={() => setShowUpload(true)}
                                className="btn-primary flex items-center gap-2"
                            >
                                <PlusIcon className="h-4 w-4" />
                                Upload
                            </button>
                        </div>
                    )
                }
            />

            {error && (
                <div className="mb-4">
                    <ErrorMessage message={error} onDismiss={() => setError(null)} />
                </div>
            )}

            {/* Tabs — overflow-x-auto (v1.32.5) so every tab stays reachable
                by scrolling on a narrow screen instead of overflowing with
                no way to reach it. */}
            <div className="tab-bar" role="tablist">
                <button
                    onClick={() => setActiveTab('documents')}
                    className={`tab ${activeTab === 'documents' ? 'tab-active' : ''}`}
                >
                    All Documents
                </button>
                <button
                    onClick={() => setActiveTab('archive')}
                    className={`tab ${activeTab === 'archive' ? 'tab-active' : ''}`}
                >
                    <ShieldCheckIcon className="h-4 w-4" />
                    Company Archive
                </button>
                {/* v1.44.0 — everything currently awaiting my own
                    signature, spanning both documents and share
                    certificate rounds (Section 4.29). */}
                <button
                    onClick={() => setActiveTab('pending-signatures')}
                    className={`tab ${activeTab === 'pending-signatures' ? 'tab-active' : ''}`}
                >
                    <PencilSquareIcon className="h-4 w-4" />
                    Pending My Signature
                    {pendingSignatures.length > 0 && (
                        <span className={`text-xs font-bold rounded-full px-1.5 ${
                            activeTab === 'pending-signatures' ? 'bg-white/20 text-white' : 'bg-amber-100 text-amber-700'
                        }`}>
                            {pendingSignatures.length}
                        </span>
                    )}
                </button>
                {/* v1.65.0 — every member's own Share Purchase Receipts,
                    generated automatically as contributions are recorded. */}
                <button
                    onClick={() => setActiveTab('my-documents')}
                    className={`tab ${activeTab === 'my-documents' ? 'tab-active' : ''}`}
                >
                    <DocumentTextIcon className="h-4 w-4" />
                    My Documents
                </button>
                {/* v1.65.0 — Treasury-only, every member's Share Purchase
                    Receipts in one place. v1.67.0: gated on the Treasury
                    roles themselves, not DOCUMENT_VIEW (which Secretary
                    and Directors also hold). */}
                {isTreasury && (
                    <button
                        onClick={() => setActiveTab('shareholding-receipts')}
                        className={`tab ${activeTab === 'shareholding-receipts' ? 'tab-active' : ''}`}
                    >
                        <DocumentTextIcon className="h-4 w-4" />
                        Shareholding Receipts
                    </button>
                )}
            </div>

            {/* All Documents Tab */}
            {activeTab === 'documents' && (
                <>
                    <div className="card mb-6">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <select className="input" value={typeFilter}
                                onChange={e => {
                                    setTypeFilter(e.target.value);
                                    setPage(1);
                                }}>
                                <option value="">All Document Types</option>
                                {DOCUMENT_TYPES.map(t => (
                                    <option key={t} value={t}>
                                        {t.replace(/_/g, ' ')}
                                    </option>
                                ))}
                            </select>
                            <select className="input" value={statusFilter}
                                onChange={e => {
                                    setStatusFilter(e.target.value);
                                    setPage(1);
                                }}>
                                <option value="">All Statuses</option>
                                <option value="DRAFT">Draft</option>
                                <option value="FINAL">Final</option>
                                <option value="ARCHIVED">Archived</option>
                            </select>
                        </div>
                    </div>

                    <DataTable
                        columns={columns}
                        data={documents}
                        loading={loading}
                        emptyMessage="No documents found"
                        searchable
                        searchPlaceholder="Search documents..."
                        pagination={pagination}
                        onPageChange={setPage}
                    />
                </>
            )}

            {/* Company Archive Tab */}
            {activeTab === 'archive' && (
                <CompanyArchive categories={categories} />
            )}

            {/* My Documents Tab (v1.65.0) */}
            {activeTab === 'my-documents' && (
                <MyDocuments />
            )}

            {/* Shareholding Receipts Tab (v1.65.0, Treasury) */}
            {activeTab === 'shareholding-receipts' && isTreasury && (
                <ShareholdingReceipts />
            )}

            {/* Pending My Signature Tab (v1.44.0, Section 4.29) — spans
                both regular documents and share-certificate signing
                rounds, since neither the "All Documents" list nor
                anywhere else in the app shows the two side by side. */}
            {activeTab === 'pending-signatures' && (
                <div className="card">
                    {pendingLoading ? (
                        <p className="text-sm text-gray-400 py-4 text-center">Loading...</p>
                    ) : pendingSignatures.length === 0 ? (
                        <p className="text-sm text-gray-400 py-4 text-center">
                            Nothing is currently awaiting your signature.
                        </p>
                    ) : (
                        <div className="divide-y divide-gray-100">
                            {pendingSignatures.map(item => (
                                <div key={`${item.target_type}-${item.target_id}`}
                                    className="flex items-center justify-between py-3 gap-4 flex-wrap">
                                    <div className="min-w-0">
                                        <p className="text-sm font-medium text-gray-900">
                                            {item.title}
                                            {item.reference_code && (
                                                <span className="ml-2 font-mono text-xs text-primary-700">{item.reference_code}</span>
                                            )}
                                        </p>
                                        <p className="text-xs text-gray-400">
                                            {item.subtitle} — your signature needed as {item.role_names.join(' / ')}
                                        </p>
                                    </div>
                                    <button
                                        onClick={() => setSignaturesTarget({ id: item.target_id, title: item.title, targetType: item.target_type })}
                                        className="btn-primary text-sm flex-shrink-0">
                                        Review &amp; Sign
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            <UploadModal
                isOpen={showUpload}
                onClose={() => setShowUpload(false)}
                onSuccess={loadDocuments}
                categories={categories}
                isArchive={false}
            />

            <GrantAccessModal
                isOpen={!!grantingDoc}
                document={grantingDoc}
                onClose={() => setGrantingDoc(null)}
            />

            <SignaturesModal
                isOpen={!!signaturesTarget}
                target={signaturesTarget}
                onClose={() => setSignaturesTarget(null)}
                onSigned={() => { loadDocuments(); loadPendingSignatures(); }}
            />

            <DocumentDetailModal
                documentId={detailId}
                onClose={() => openDetail(null)}
                onChanged={(id, count) => setDocuments(list => list.map(d => (d.id === id ? { ...d, transaction_count: count } : d)))}
            />
        </div>
    );
};

export default DocumentsPage;