// ============================================================
// DOCUMENTS PAGE
// Shows all documents with upload, approval and archive management.
// Special archive section for foundational company documents.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { documentsAPI, categoriesAPI, staffAccessAPI, usersAPI } from '../../api/endpoints';
import { formatDate, formatFileSize, getErrorMessage, truncate } from '../../utils/helpers';
import {
    meetingAgendaTemplate, meetingMinutesTemplate, receiptTemplate, resolutionTemplate,
    auditorFeedbackTemplate, memberPortfolioTemplate, previewDocument, printDocument,
} from '../../utils/exportUtils';
import PageHeader from '../../components/common/PageHeader';
import DataTable from '../../components/common/DataTable';
import ErrorMessage from '../../components/common/ErrorMessage';
import StatusBadge from '../../components/common/StatusBadge';
import { useAuth } from '../../contexts/AuthContext';
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
} from '@heroicons/react/24/outline';

// Renderers for SYSTEM_GENERATED documents — same client-side template
// functions GenerateDocumentPage.jsx uses at creation time. Only the
// currently-supported generated types have one; anything else
// (documents generated before v1.15.0, or template types with no
// registered renderer) will show a friendly "can't be reconstructed"
// message instead of failing silently.
const GENERATED_RENDERERS = {
    MEETING_AGENDA:   meetingAgendaTemplate,
    MEETING_MINUTES:  meetingMinutesTemplate,
    RECEIPT:          receiptTemplate,
    RESOLUTION:       resolutionTemplate,
    AUDITOR_FEEDBACK: auditorFeedbackTemplate,
    // v1.34.0 — Member Portfolio Summary, generated from each member's
    // own Portfolio page rather than through this page's own Generate
    // flow, but still stored/reopened the exact same way as every
    // other SYSTEM_GENERATED document.
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
        const renderer = GENERATED_RENDERERS[payload.document_type];
        if (!renderer) {
            throw new Error(
                'This document type can\'t be reconstructed for preview/download.'
            );
        }
        // v1.24.0 — once fully approved/signed, fetch whichever
        // company stamp(s) were baked onto this document (Section
        // 4.30) so the re-rendered preview/download shows it. A
        // draft (not yet fully_signed) never carries a stamp.
        let templateData = payload.template_data;
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
    'RECEIPT', 'CONTRACT', 'LOAN_AGREEMENT', 'GRANT_AGREEMENT', 'OTHER'
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
// SIGNATURES MODAL (v1.23.0, Section 4.29)
// Shown for RESOLUTION/LOAN_AGREEMENT/GRANT_AGREEMENT documents once
// signature slots exist (i.e. an Admin has configured
// signature_requirements for that type and someone has called
// Approve at least once). Lists every required role, who — if
// anyone — has signed, and offers a Sign button to the current user
// if their role still has a pending slot.
// ============================================================
const SignaturesModal = ({ isOpen, document, onClose, onSigned }) => {
    const { hasRole } = useAuth();
    const [signatures, setSignatures] = useState([]);
    const [stamps, setStamps] = useState([]);
    const [loading, setLoading] = useState(true);
    const [signing, setSigning] = useState(false);
    const [error, setError] = useState(null);

    const load = useCallback(async () => {
        if (!document) return;
        try {
            setLoading(true);
            const [sigRes, stampRes] = await Promise.all([
                documentsAPI.getSignatures(document.id),
                documentsAPI.getStamps(document.id).catch(() => ({ data: { data: [] } })),
            ]);
            setSignatures(sigRes.data.data || []);
            setStamps(stampRes.data.data || []);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, [document]);

    useEffect(() => { if (isOpen) load(); }, [isOpen, load]);

    if (!isOpen || !document) return null;

    const myPendingSlot = signatures.find(s => s.status === 'PENDING' && hasRole(s.role_name));
    const allSigned = signatures.length > 0 && signatures.every(s => s.status === 'SIGNED');

    const handleSign = async () => {
        setError(null);
        setSigning(true);
        try {
            await documentsAPI.sign(document.id);
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
                    <h3 className="text-lg font-semibold text-gray-900">Signatures — {document.title}</h3>
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
                                        <img src={sig.signature_url} alt="Signature" className="h-8" />
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
                                    <img src={stamp.file_path} alt={stamp.name} className="h-12 w-12 object-contain" />
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
const DocumentsPage = () => {
    const { hasPermission, hasRole } = useAuth();
    const navigate = useNavigate();
    const [documents,  setDocuments]  = useState([]);
    const [categories, setCategories] = useState([]);
    const [pagination, setPagination] = useState(null);
    const [loading,    setLoading]    = useState(true);
    const [error,      setError]      = useState(null);
    const [page,       setPage]       = useState(1);
    const [showUpload, setShowUpload] = useState(false);
    const [activeTab,  setActiveTab]  = useState('documents');
    const [actionLoading, setActionLoading] = useState(null);
    const [grantingDoc, setGrantingDoc] = useState(null);
    const [signaturesDoc, setSignaturesDoc] = useState(null);
    const canGrantAccess = hasRole('Admin');
    const SIGNABLE_DOCUMENT_TYPES = ['RESOLUTION', 'LOAN_AGREEMENT', 'GRANT_AGREEMENT'];

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

    useEffect(() => {
        loadDocuments();
        categoriesAPI.getAll({ flat: true })
            .then(r => setCategories(r.data.data)).catch(() => {});
    }, [loadDocuments]);

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
                    <span className="font-mono text-xs font-medium text-primary-700">
                        {row.reference_code}
                    </span>
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
                    <p className="text-sm font-medium text-gray-900">
                        {truncate(row.title, 40)}
                    </p>
                    <p className="text-xs text-gray-400">
                        {row.document_type?.replace(/_/g, ' ')}
                        {row.source === 'SYSTEM_GENERATED' && ' • Generated'}
                    </p>
                </div>
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
                            onClick={() => setSignaturesDoc(row)}
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
            <div className="flex gap-2 mb-6 overflow-x-auto scrollbar-hidden pb-1">
                <button
                    onClick={() => setActiveTab('documents')}
                    className={`px-4 py-2 rounded-lg text-sm font-medium
                        transition-colors ${activeTab === 'documents'
                            ? 'bg-primary-700 text-white'
                            : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                        }`}
                >
                    All Documents
                </button>
                <button
                    onClick={() => setActiveTab('archive')}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg
                        text-sm font-medium transition-colors ${activeTab === 'archive'
                            ? 'bg-primary-700 text-white'
                            : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                        }`}
                >
                    <ShieldCheckIcon className="h-4 w-4" />
                    Company Archive
                </button>
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
                isOpen={!!signaturesDoc}
                document={signaturesDoc}
                onClose={() => setSignaturesDoc(null)}
                onSigned={loadDocuments}
            />
        </div>
    );
};

export default DocumentsPage;