// ============================================================
// AUDITOR PORTAL PAGE
// The ONLY page an "Auditor" role user ever sees (enforced in
// AppLayout.jsx, which redirects that role to this route no matter
// what URL they try). Scoped entirely server-side — every filter
// here can narrow what's shown, never widen it past what an Admin
// attached to this engagement.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { auditAPI, usersAPI } from '../../api/endpoints';
import { useAuth } from '../../contexts/AuthContext';
import { formatDate, formatNumber, formatFileSize, getErrorMessage } from '../../utils/helpers';
import {
    meetingAgendaTemplate, meetingMinutesTemplate, receiptTemplate, resolutionTemplate,
    auditorFeedbackTemplate, auditSummaryTemplate, previewDocument, printDocument,
} from '../../utils/exportUtils';
import PageHeader from '../../components/common/PageHeader';
import ErrorMessage from '../../components/common/ErrorMessage';
import DataTable from '../../components/common/DataTable';
import LoadingSpinner from '../../components/common/LoadingSpinner';
import {
    ArrowDownTrayIcon, EyeIcon, PaperClipIcon, TrashIcon,
    PaperAirplaneIcon, ClockIcon, CheckCircleIcon, XCircleIcon,
} from '@heroicons/react/24/outline';

// Same renderers DocumentsPage.jsx uses for SYSTEM_GENERATED documents
// — keep in sync with that file's GENERATED_RENDERERS if a new
// generated document type is ever added.
const GENERATED_RENDERERS = {
    MEETING_AGENDA:   meetingAgendaTemplate,
    MEETING_MINUTES:  meetingMinutesTemplate,
    RECEIPT:          receiptTemplate,
    RESOLUTION:       resolutionTemplate,
    AUDITOR_FEEDBACK: auditorFeedbackTemplate,
};

const isProfileComplete = (user) =>
    !!(user?.auditor_company_name && user?.auditor_company_initials && user?.auditor_contact_phone);

const AuditorPortalPage = () => {
    const { user, refreshUser } = useAuth();

    const [engagements, setEngagements] = useState([]);
    const [engagementId, setEngagementId] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError]     = useState(null);

    const [accounts, setAccounts] = useState([]);
    const [filters, setFilters]   = useState({ account_id: '', from_date: '', to_date: '' });

    const [transactions, setTransactions] = useState([]);
    const [pagination, setPagination]     = useState(null);
    const [page, setPage]                 = useState(1);
    const [txLoading, setTxLoading]       = useState(false);

    const [documents, setDocuments]   = useState([]);
    const [docsLoading, setDocsLoading] = useState(false);

    const [downloading, setDownloading] = useState(false);

    // --- Profile gate (auditor_company_name/initials/phone) ---
    const [profileForm, setProfileForm] = useState({
        auditor_company_name: '', auditor_company_initials: '', auditor_contact_phone: '',
    });
    const [profileSaving, setProfileSaving] = useState(false);

    useEffect(() => {
        if (user) {
            setProfileForm({
                auditor_company_name:     user.auditor_company_name || '',
                auditor_company_initials: user.auditor_company_initials || '',
                auditor_contact_phone:    user.auditor_contact_phone || '',
            });
        }
    }, [user]);

    const handleSaveProfile = async (e) => {
        e.preventDefault();
        setError(null);
        setProfileSaving(true);
        try {
            await usersAPI.updateMyProfile(profileForm);
            await refreshUser();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setProfileSaving(false);
        }
    };

    // --- Submission workflow state ---
    const [comments, setComments]       = useState([]);
    const [newComment, setNewComment]   = useState('');
    const [commentSaving, setCommentSaving] = useState(false);

    const [reportFiles, setReportFiles] = useState([]);
    const [uploadingFile, setUploadingFile] = useState(false);

    const [submissions, setSubmissions] = useState([]);
    const [finishing, setFinishing]     = useState(false);

    const [extensionForm, setExtensionForm] = useState({ requested_new_access_expires_at: '', reason: '' });
    const [extensionRequests, setExtensionRequests] = useState([]);
    const [extensionSaving, setExtensionSaving]     = useState(false);
    const [showExtensionForm, setShowExtensionForm] = useState(false);

    const engagement = engagements.find(e => e.id === engagementId) || null;
    const profileComplete = isProfileComplete(user);
    const hasPendingSubmission = submissions.some(s => s.status === 'SUBMITTED');
    const canStage = profileComplete && !hasPendingSubmission;

    const loadWorkflowData = useCallback(() => {
        if (!engagementId) return;
        auditAPI.getComments(engagementId).then(res => setComments(res.data.data)).catch(err => setError(getErrorMessage(err)));
        auditAPI.getReportFiles(engagementId).then(res => setReportFiles(res.data.data)).catch(err => setError(getErrorMessage(err)));
        auditAPI.getEngagementSubmissions(engagementId).then(res => setSubmissions(res.data.data)).catch(err => setError(getErrorMessage(err)));
        auditAPI.getMyExtensionRequests(engagementId).then(res => setExtensionRequests(res.data.data)).catch(err => setError(getErrorMessage(err)));
    }, [engagementId]);

    useEffect(() => { loadWorkflowData(); }, [loadWorkflowData]);

    const handleAddComment = async (e) => {
        e.preventDefault();
        if (!newComment.trim()) return;
        setError(null);
        setCommentSaving(true);
        try {
            await auditAPI.addComment(engagementId, { comment_text: newComment.trim() });
            setNewComment('');
            loadWorkflowData();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setCommentSaving(false);
        }
    };

    const handleUploadFile = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setError(null);
        setUploadingFile(true);
        try {
            const formData = new FormData();
            formData.append('report', file);
            await auditAPI.uploadReportFile(engagementId, formData);
            loadWorkflowData();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setUploadingFile(false);
            e.target.value = '';
        }
    };

    const handleDeleteFile = async (fileId) => {
        setError(null);
        try {
            await auditAPI.deleteReportFile(engagementId, fileId);
            loadWorkflowData();
        } catch (err) {
            setError(getErrorMessage(err));
        }
    };

    const stagedCommentCount = comments.filter(c => !c.submission_id).length;
    const stagedFileCount    = reportFiles.filter(f => !f.submission_id).length;

    const handleFinishAudit = async () => {
        if (!window.confirm(
            `Submit ${stagedCommentCount} comment(s) and ${stagedFileCount} file(s) for Director/Secretary approval? You won't be able to add more until it's reviewed.`
        )) return;
        setError(null);
        setFinishing(true);
        try {
            await auditAPI.finishAudit(engagementId);
            loadWorkflowData();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setFinishing(false);
        }
    };

    const handleRequestExtension = async (e) => {
        e.preventDefault();
        setError(null);
        setExtensionSaving(true);
        try {
            await auditAPI.requestExtension(engagementId, extensionForm);
            setExtensionForm({ requested_new_access_expires_at: '', reason: '' });
            setShowExtensionForm(false);
            loadWorkflowData();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setExtensionSaving(false);
        }
    };

    useEffect(() => {
        (async () => {
            setLoading(true);
            try {
                const res = await auditAPI.getMyEngagements();
                setEngagements(res.data.data);
                if (res.data.data.length > 0) setEngagementId(res.data.data[0].id);
            } catch (err) {
                setError(getErrorMessage(err));
            } finally {
                setLoading(false);
            }
        })();
    }, []);

    useEffect(() => {
        if (!engagementId) return;
        setFilters({ account_id: '', from_date: '', to_date: '' });
        setPage(1);
        auditAPI.getAllowedAccounts(engagementId)
            .then(res => setAccounts(res.data.data))
            .catch(err => setError(getErrorMessage(err)));

        setDocsLoading(true);
        auditAPI.getDocuments(engagementId)
            .then(res => setDocuments(res.data.data))
            .catch(err => setError(getErrorMessage(err)))
            .finally(() => setDocsLoading(false));
    }, [engagementId]);

    const loadTransactions = useCallback(async () => {
        if (!engagementId) return;
        setTxLoading(true);
        try {
            const params = { page, limit: 20 };
            if (filters.account_id) params.account_id = filters.account_id;
            if (filters.from_date)  params.from_date  = filters.from_date;
            if (filters.to_date)    params.to_date    = filters.to_date;

            const res = await auditAPI.getTransactions(engagementId, params);
            setTransactions(res.data.data);
            setPagination(res.data.meta.pagination);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setTxLoading(false);
        }
    }, [engagementId, page, filters]);

    useEffect(() => { loadTransactions(); }, [loadTransactions]);

    const handlePreviewDocument = async (doc) => {
        setError(null);
        try {
            const res = await auditAPI.previewDocument(engagementId, doc.id);
            const blob = res.data;

            if (blob.type === 'application/json') {
                // Same envelope shape as DocumentsPage.jsx — backend wraps the
                // actual fields under `.data` (sendSuccess), so they must be
                // read from there, not off the top-level parsed object.
                const text = await blob.text();
                const envelope = JSON.parse(text);
                const payload = envelope.data || envelope;
                const renderer = GENERATED_RENDERERS[payload.document_type];
                if (!renderer) {
                    throw new Error('This document type can\'t be reconstructed for preview.');
                }
                previewDocument(renderer(payload.template_data), payload.title || doc.title);
                return;
            }

            const url = URL.createObjectURL(blob);
            window.open(url, '_blank');
            setTimeout(() => URL.revokeObjectURL(url), 10000);
        } catch (err) {
            setError(getErrorMessage(err));
        }
    };

    const handleDownloadSummary = async () => {
        setError(null);
        setDownloading(true);
        try {
            const res = await auditAPI.getSummary(engagementId);
            const html = auditSummaryTemplate(res.data.data);
            printDocument(html, `Audit Summary — ${engagement?.name || ''}`);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setDownloading(false);
        }
    };

    const columns = [
        { header: 'Reference', accessor: 'reference_code' },
        { header: 'Account',   accessor: 'account_name' },
        { header: 'Description', accessor: 'description' },
        { header: 'Category',  render: row => row.category_trail || row.category_name || '—' },
        { header: 'Date',      render: row => formatDate(row.value_date) },
        {
            header: 'Amount', render: row => {
                const isCredit = row.transaction_type === 'CREDIT' || row.transaction_type === 'REVERSAL_CREDIT';
                return (
                    <span className={isCredit ? 'text-green-600 font-semibold' : 'text-red-600 font-semibold'}>
                        {isCredit ? '+' : '-'}{row.currency_code} {formatNumber(row.amount)}
                    </span>
                );
            },
        },
    ];

    if (loading) {
        return <LoadingSpinner fullPage text="Loading your audit access..." />;
    }

    if (engagements.length === 0) {
        return (
            <div className="card flex items-center justify-center py-16">
                <div className="text-center max-w-md">
                    <h2 className="text-lg font-semibold text-gray-900 mb-2">No audit access yet</h2>
                    <p className="text-sm text-gray-500">
                        Your account has the Auditor role, but hasn't been attached to an audit
                        engagement yet. Contact the company Admin to be added.
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div>
            <PageHeader
                title="External Audit Portal"
                subtitle={engagement
                    ? `${engagement.name} — Period: ${formatDate(engagement.period_start)} to ${formatDate(engagement.period_end)}`
                    : ''}
                actions={
                    <button onClick={handleDownloadSummary} disabled={downloading} className="btn-primary flex items-center gap-2">
                        <ArrowDownTrayIcon className="h-4 w-4" />
                        {downloading ? 'Preparing...' : 'Download PDF Summary'}
                    </button>
                }
            />

            {error && (
                <div className="mb-4">
                    <ErrorMessage message={error} onDismiss={() => setError(null)} />
                </div>
            )}

            {!profileComplete && (
                <div className="card mb-4 border-l-4 border-yellow-400 bg-yellow-50">
                    <h3 className="section-title mb-1">Complete your auditor profile</h3>
                    <p className="text-sm text-gray-600 mb-3">
                        Your company name, company initials, and contact phone are required before you can
                        add comments, upload report files, or finish an audit. Your first name and these
                        company initials are used to build the reference codes on your submitted work.
                    </p>
                    <form onSubmit={handleSaveProfile} className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                        <div>
                            <label className="label">Auditing Company Name</label>
                            <input type="text" className="input" required
                                value={profileForm.auditor_company_name}
                                onChange={e => setProfileForm(p => ({ ...p, auditor_company_name: e.target.value }))} />
                        </div>
                        <div>
                            <label className="label">Company Initials</label>
                            <input type="text" className="input" required maxLength={10}
                                placeholder="e.g. KPMG"
                                value={profileForm.auditor_company_initials}
                                onChange={e => setProfileForm(p => ({ ...p, auditor_company_initials: e.target.value.toUpperCase() }))} />
                        </div>
                        <div>
                            <label className="label">Contact Phone</label>
                            <input type="text" className="input" required
                                value={profileForm.auditor_contact_phone}
                                onChange={e => setProfileForm(p => ({ ...p, auditor_contact_phone: e.target.value }))} />
                        </div>
                        <div className="sm:col-span-3">
                            <button type="submit" disabled={profileSaving} className="btn-primary">
                                {profileSaving ? 'Saving...' : 'Save Profile'}
                            </button>
                        </div>
                    </form>
                </div>
            )}

            {engagements.length > 1 && (
                <div className="card mb-4">
                    <label className="label">Engagement</label>
                    <select className="input max-w-md" value={engagementId || ''}
                        onChange={e => setEngagementId(parseInt(e.target.value))}>
                        {engagements.map(e => (
                            <option key={e.id} value={e.id}>{e.name}</option>
                        ))}
                    </select>
                </div>
            )}

            {/* Filters */}
            <div className="card mb-4">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div>
                        <label className="label">Account</label>
                        <select className="input" value={filters.account_id}
                            onChange={e => { setFilters(p => ({ ...p, account_id: e.target.value })); setPage(1); }}>
                            <option value="">All allowed accounts</option>
                            {accounts.map(a => (
                                <option key={a.id} value={a.id}>{a.name} ({a.account_type})</option>
                            ))}
                        </select>
                    </div>
                    <div>
                        <label className="label">From</label>
                        <input type="date" className="input"
                            min={engagement?.period_start?.slice(0, 10)}
                            max={engagement?.period_end?.slice(0, 10)}
                            value={filters.from_date}
                            onChange={e => { setFilters(p => ({ ...p, from_date: e.target.value })); setPage(1); }} />
                    </div>
                    <div>
                        <label className="label">To</label>
                        <input type="date" className="input"
                            min={engagement?.period_start?.slice(0, 10)}
                            max={engagement?.period_end?.slice(0, 10)}
                            value={filters.to_date}
                            onChange={e => { setFilters(p => ({ ...p, to_date: e.target.value })); setPage(1); }} />
                    </div>
                </div>
                <p className="mt-2 text-xs text-gray-400">
                    Filters can only narrow what's shown within {formatDate(engagement?.period_start)} –{' '}
                    {formatDate(engagement?.period_end)} and the accounts your engagement grants access to.
                </p>
            </div>

            <DataTable
                columns={columns}
                data={transactions}
                loading={txLoading}
                emptyMessage="No transactions in this range."
                pagination={pagination}
                onPageChange={setPage}
            />

            {/* Documents */}
            <div className="card mt-6">
                <h3 className="section-title mb-3">Shared Documents</h3>
                {docsLoading ? (
                    <LoadingSpinner size="sm" text="Loading documents..." />
                ) : documents.length === 0 ? (
                    <p className="text-sm text-gray-500">No documents have been shared with this engagement.</p>
                ) : (
                    <ul className="divide-y divide-gray-200">
                        {documents.map(d => (
                            <li key={d.id} className="py-3 flex items-center justify-between">
                                <div>
                                    <p className="text-sm font-medium text-gray-900">{d.title}</p>
                                    <p className="text-xs text-gray-400">{d.document_type.replace(/_/g, ' ')}</p>
                                </div>
                                <button onClick={() => handlePreviewDocument(d)}
                                    className="btn-secondary text-xs flex items-center gap-1">
                                    <EyeIcon className="h-4 w-4" /> Preview
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            {/* Submission status history */}
            {submissions.length > 0 && (
                <div className="card mt-6">
                    <h3 className="section-title mb-3">Submission Status</h3>
                    <ul className="divide-y divide-gray-200">
                        {submissions.map(s => (
                            <li key={s.id} className="py-3 flex items-start justify-between gap-4">
                                <div>
                                    <p className="text-sm font-medium text-gray-900 flex items-center gap-2">
                                        {s.status === 'APPROVED' && <CheckCircleIcon className="h-4 w-4 text-green-600" />}
                                        {s.status === 'REJECTED' && <XCircleIcon className="h-4 w-4 text-red-600" />}
                                        {s.status === 'SUBMITTED' && <ClockIcon className="h-4 w-4 text-yellow-500" />}
                                        Submitted {formatDate(s.submitted_at)}
                                    </p>
                                    <p className="text-xs text-gray-500 mt-1">
                                        Director approval: {s.director_approved_at ? formatDate(s.director_approved_at) : 'pending'}
                                        {' · '}Secretary approval: {s.secretary_approved_at ? formatDate(s.secretary_approved_at) : 'pending'}
                                    </p>
                                    {s.status === 'REJECTED' && s.rejection_reason && (
                                        <p className="text-xs text-red-600 mt-1">Reason: {s.rejection_reason}</p>
                                    )}
                                </div>
                                <span className={
                                    s.status === 'APPROVED' ? 'badge-green' :
                                    s.status === 'REJECTED' ? 'badge-red' : 'badge-yellow'
                                }>{s.status}</span>
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {/* Comments */}
            <div className="card mt-6">
                <h3 className="section-title mb-3">Auditor Comments</h3>
                {comments.length === 0 ? (
                    <p className="text-sm text-gray-500 mb-3">No comments added yet.</p>
                ) : (
                    <ul className="divide-y divide-gray-200 mb-3">
                        {comments.map(c => (
                            <li key={c.id} className="py-2">
                                <p className="text-xs text-gray-400">
                                    {formatDate(c.created_at)}{!c.submission_id && ' — staged, not yet submitted'}
                                </p>
                                <p className="text-sm text-gray-800">{c.comment_text}</p>
                            </li>
                        ))}
                    </ul>
                )}
                <form onSubmit={handleAddComment} className="flex items-start gap-2">
                    <textarea className="input flex-1" rows={2}
                        placeholder={canStage ? 'Add a comment...' : 'Complete your profile to add comments'}
                        disabled={!canStage}
                        value={newComment}
                        onChange={e => setNewComment(e.target.value)} />
                    <button type="submit" disabled={!canStage || commentSaving || !newComment.trim()}
                        className="btn-secondary flex items-center gap-1">
                        <PaperAirplaneIcon className="h-4 w-4" /> Add
                    </button>
                </form>
            </div>

            {/* Report files */}
            <div className="card mt-6">
                <h3 className="section-title mb-3">Report Files</h3>
                {reportFiles.length === 0 ? (
                    <p className="text-sm text-gray-500 mb-3">No files uploaded yet.</p>
                ) : (
                    <ul className="divide-y divide-gray-200 mb-3">
                        {reportFiles.map(f => (
                            <li key={f.id} className="py-2 flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <PaperClipIcon className="h-4 w-4 text-gray-400" />
                                    <div>
                                        <p className="text-sm text-gray-800">{f.file_name}</p>
                                        <p className="text-xs text-gray-400">
                                            {formatFileSize(f.file_size_bytes)} · {formatDate(f.uploaded_at)}
                                            {!f.submission_id && ' — staged, not yet submitted'}
                                        </p>
                                    </div>
                                </div>
                                {!f.submission_id && (
                                    <button onClick={() => handleDeleteFile(f.id)} className="text-red-500 hover:text-red-700">
                                        <TrashIcon className="h-4 w-4" />
                                    </button>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
                <label className={`btn-secondary inline-flex items-center gap-2 cursor-pointer ${!canStage ? 'opacity-50 cursor-not-allowed' : ''}`}>
                    <PaperClipIcon className="h-4 w-4" />
                    {uploadingFile ? 'Uploading...' : 'Upload Report File'}
                    <input type="file" className="hidden" disabled={!canStage || uploadingFile} onChange={handleUploadFile} />
                </label>
            </div>

            {/* Finish Audit */}
            <div className="card mt-6">
                <h3 className="section-title mb-2">Finish Audit</h3>
                {hasPendingSubmission ? (
                    <p className="text-sm text-yellow-700">
                        A submission is currently awaiting Director and Secretary approval. You can add more
                        comments or files once it's reviewed.
                    </p>
                ) : (
                    <>
                        <p className="text-sm text-gray-600 mb-3">
                            You currently have <strong>{stagedCommentCount}</strong> comment(s) and{' '}
                            <strong>{stagedFileCount}</strong> file(s) staged. Finishing the audit sends all of
                            them together for Director and Secretary approval — you'll get an email confirming
                            what was sent, and another once it's been reviewed.
                        </p>
                        <button onClick={handleFinishAudit}
                            disabled={!profileComplete || finishing || (stagedCommentCount === 0 && stagedFileCount === 0)}
                            className="btn-primary">
                            {finishing ? 'Submitting...' : 'Finish Audit'}
                        </button>
                    </>
                )}
            </div>

            {/* Extension requests */}
            <div className="card mt-6 mb-6">
                <h3 className="section-title mb-2">Request More Time</h3>
                {extensionRequests.some(x => x.status === 'PENDING') ? (
                    <p className="text-sm text-yellow-700">
                        Your extension request is awaiting review.
                    </p>
                ) : (
                    <>
                        {!showExtensionForm ? (
                            <button onClick={() => setShowExtensionForm(true)} className="btn-secondary">
                                Request Extension
                            </button>
                        ) : (
                            <form onSubmit={handleRequestExtension} className="space-y-3 max-w-md">
                                <div>
                                    <label className="label">New Access Expiry Date</label>
                                    <input type="date" className="input" required
                                        value={extensionForm.requested_new_access_expires_at}
                                        onChange={e => setExtensionForm(p => ({ ...p, requested_new_access_expires_at: e.target.value }))} />
                                </div>
                                <div>
                                    <label className="label">Reason</label>
                                    <textarea className="input" rows={3} required
                                        value={extensionForm.reason}
                                        onChange={e => setExtensionForm(p => ({ ...p, reason: e.target.value }))} />
                                </div>
                                <div className="flex gap-2">
                                    <button type="submit" disabled={extensionSaving} className="btn-primary">
                                        {extensionSaving ? 'Submitting...' : 'Submit Request'}
                                    </button>
                                    <button type="button" onClick={() => setShowExtensionForm(false)} className="btn-secondary">
                                        Cancel
                                    </button>
                                </div>
                            </form>
                        )}
                        {extensionRequests.length > 0 && (
                            <ul className="divide-y divide-gray-200 mt-4">
                                {extensionRequests.map(x => (
                                    <li key={x.id} className="py-2 text-sm">
                                        <span className={
                                            x.status === 'APPROVED' ? 'badge-green' :
                                            x.status === 'REJECTED' ? 'badge-red' : 'badge-yellow'
                                        }>{x.status}</span>{' '}
                                        Requested {formatDate(x.created_at)} — new date {formatDate(x.requested_new_access_expires_at)}
                                    </li>
                                ))}
                            </ul>
                        )}
                    </>
                )}
            </div>
        </div>
    );
};

export default AuditorPortalPage;
