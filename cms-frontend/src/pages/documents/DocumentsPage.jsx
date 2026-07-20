// ============================================================
// DOCUMENTS PAGE
// Shows all documents with upload, approval and archive management.
// Special archive section for foundational company documents.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { documentsAPI, categoriesAPI } from '../../api/endpoints';
import { formatDate, formatFileSize, getErrorMessage, truncate } from '../../utils/helpers';
import {
    meetingAgendaTemplate, meetingMinutesTemplate, receiptTemplate, resolutionTemplate,
    auditorFeedbackTemplate, previewDocument, printDocument,
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
        // SYSTEM_GENERATED — re-render client-side from saved field values
        const text = await blob.text();
        const payload = JSON.parse(text);
        const renderer = GENERATED_RENDERERS[payload.document_type];
        if (!renderer) {
            throw new Error(
                'This document type can\'t be reconstructed for preview/download.'
            );
        }
        const html = renderer(payload.template_data);
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
// MAIN DOCUMENTS PAGE
// ============================================================
const DocumentsPage = () => {
    const { hasPermission } = useAuth();
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

            {/* Tabs */}
            <div className="flex gap-2 mb-6">
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
        </div>
    );
};

export default DocumentsPage;