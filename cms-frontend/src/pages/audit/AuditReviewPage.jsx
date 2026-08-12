// ============================================================
// AUDIT SUBMISSION REVIEW PAGE (Director / Secretary only)
// Both a Director AND a Secretary must approve an audit submission
// before it is archived (dual sign-off) — a single Director or
// Secretary can reject on their own, which sends it straight back
// to the auditor. This page also handles extension-of-access
// requests, which only need one Director-or-Secretary approval.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { auditAPI } from '../../api/endpoints';
import { formatDate, formatFileSize, getErrorMessage } from '../../utils/helpers';
import PageHeader from '../../components/common/PageHeader';
import ErrorMessage from '../../components/common/ErrorMessage';
import LoadingSpinner from '../../components/common/LoadingSpinner';
import {
    CheckCircleIcon, XCircleIcon, ClockIcon, PaperClipIcon, EyeIcon,
} from '@heroicons/react/24/outline';

const statusBadgeClass = (status) => {
    if (status === 'APPROVED') return 'badge-green';
    if (status === 'REJECTED') return 'badge-red';
    return 'badge-yellow';
};

const AuditReviewPage = () => {
    const [tab, setTab] = useState('submissions'); // 'submissions' | 'extensions'

    // --- Submissions ---
    const [submissions, setSubmissions]   = useState([]);
    const [subFilter, setSubFilter]       = useState('SUBMITTED');
    const [subLoading, setSubLoading]     = useState(true);
    const [selectedId, setSelectedId]     = useState(null);
    const [detail, setDetail]             = useState(null);
    const [detailLoading, setDetailLoading] = useState(false);
    const [rejectReason, setRejectReason] = useState('');
    const [showRejectForm, setShowRejectForm] = useState(false);
    const [acting, setActing]             = useState(false);

    // --- Extension requests ---
    const [extensions, setExtensions]       = useState([]);
    const [extFilter, setExtFilter]         = useState('PENDING');
    const [extLoading, setExtLoading]       = useState(false);
    const [extNotes, setExtNotes]           = useState({});
    const [extActing, setExtActing]         = useState(null);

    const [error, setError] = useState(null);

    const loadSubmissions = useCallback(async () => {
        setSubLoading(true);
        try {
            const res = await auditAPI.listSubmissions(subFilter ? { status: subFilter } : {});
            setSubmissions(res.data.data);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setSubLoading(false);
        }
    }, [subFilter]);

    useEffect(() => { loadSubmissions(); }, [loadSubmissions]);

    const loadExtensions = useCallback(async () => {
        setExtLoading(true);
        try {
            const res = await auditAPI.listExtensionRequests(extFilter ? { status: extFilter } : {});
            setExtensions(res.data.data);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setExtLoading(false);
        }
    }, [extFilter]);

    useEffect(() => { if (tab === 'extensions') loadExtensions(); }, [tab, loadExtensions]);

    const openDetail = async (id) => {
        setSelectedId(id);
        setShowRejectForm(false);
        setRejectReason('');
        setDetailLoading(true);
        try {
            const res = await auditAPI.getSubmission(id);
            setDetail(res.data.data);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setDetailLoading(false);
        }
    };

    const handleApprove = async () => {
        if (!window.confirm('Record your approval for this submission?')) return;
        setActing(true);
        setError(null);
        try {
            await auditAPI.approveSubmission(selectedId);
            await Promise.all([loadSubmissions(), openDetail(selectedId)]);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setActing(false);
        }
    };

    const handleReject = async (e) => {
        e.preventDefault();
        if (!rejectReason.trim()) return;
        setActing(true);
        setError(null);
        try {
            await auditAPI.rejectSubmission(selectedId, { reason: rejectReason.trim() });
            setShowRejectForm(false);
            setRejectReason('');
            await Promise.all([loadSubmissions(), openDetail(selectedId)]);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setActing(false);
        }
    };

    const handlePreviewFile = async (fileId) => {
        setError(null);
        try {
            const res = await auditAPI.previewSubmissionFile(selectedId, fileId);
            const url = URL.createObjectURL(res.data);
            window.open(url, '_blank');
            setTimeout(() => URL.revokeObjectURL(url), 10000);
        } catch (err) {
            setError(getErrorMessage(err));
        }
    };

    const handleApproveExtension = async (id) => {
        setExtActing(id);
        setError(null);
        try {
            await auditAPI.approveExtensionRequest(id, { reviewer_notes: extNotes[id] || undefined });
            loadExtensions();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setExtActing(null);
        }
    };

    const handleRejectExtension = async (id) => {
        setExtActing(id);
        setError(null);
        try {
            await auditAPI.rejectExtensionRequest(id, { reviewer_notes: extNotes[id] || undefined });
            loadExtensions();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setExtActing(null);
        }
    };

    return (
        <div>
            <PageHeader
                title="Audit Submission Review"
                subtitle="Approve or reject auditor deliverables — both a Director and a Secretary must approve before a report is archived."
            />

            {error && (
                <div className="mb-4">
                    <ErrorMessage message={error} onDismiss={() => setError(null)} />
                </div>
            )}

            <div className="flex gap-2 mb-4">
                <button onClick={() => setTab('submissions')}
                    className={tab === 'submissions' ? 'btn-primary' : 'btn-secondary'}>
                    Submissions
                </button>
                <button onClick={() => setTab('extensions')}
                    className={tab === 'extensions' ? 'btn-primary' : 'btn-secondary'}>
                    Extension Requests
                </button>
            </div>

            {tab === 'submissions' && (
                <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
                    <div className="lg:col-span-2 card">
                        <div className="flex items-center justify-between mb-3">
                            <h3 className="section-title">Submissions</h3>
                            <select className="input text-sm w-auto" value={subFilter}
                                onChange={e => setSubFilter(e.target.value)}>
                                <option value="SUBMITTED">Awaiting review</option>
                                <option value="APPROVED">Approved</option>
                                <option value="REJECTED">Rejected</option>
                                <option value="">All</option>
                            </select>
                        </div>
                        {subLoading ? (
                            <LoadingSpinner size="sm" text="Loading submissions..." />
                        ) : submissions.length === 0 ? (
                            <p className="text-sm text-gray-500">No submissions here.</p>
                        ) : (
                            <ul className="divide-y divide-gray-200">
                                {submissions.map(s => (
                                    <li key={s.id}
                                        onClick={() => openDetail(s.id)}
                                        className={`py-3 px-2 cursor-pointer rounded hover:bg-gray-50 ${selectedId === s.id ? 'bg-gray-50' : ''}`}>
                                        <div className="flex items-center justify-between">
                                            <p className="text-sm font-medium text-gray-900">{s.engagement_name}</p>
                                            <span className={statusBadgeClass(s.status)}>{s.status}</span>
                                        </div>
                                        <p className="text-xs text-gray-500 mt-1">
                                            {s.auditor_name} ({s.auditor_company_name}) — {formatDate(s.submitted_at)}
                                        </p>
                                        <p className="text-xs text-gray-400">
                                            {s.comment_count} comment(s), {s.file_count} file(s)
                                        </p>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>

                    <div className="lg:col-span-3 card">
                        {!selectedId ? (
                            <p className="text-sm text-gray-500">Select a submission to review its details.</p>
                        ) : detailLoading || !detail ? (
                            <LoadingSpinner size="sm" text="Loading detail..." />
                        ) : (
                            <div>
                                <div className="flex items-center justify-between mb-3">
                                    <h3 className="section-title">{detail.engagement_name}</h3>
                                    <span className={statusBadgeClass(detail.status)}>{detail.status}</span>
                                </div>

                                <div className="grid grid-cols-2 sm:grid-cols-2 gap-4 mb-4 text-sm">
                                    <div>
                                        <p className="text-gray-400 text-xs">Auditor</p>
                                        <p>{detail.auditor_name}</p>
                                    </div>
                                    <div>
                                        <p className="text-gray-400 text-xs">Auditing Firm</p>
                                        <p>{detail.auditor_company_name} ({detail.auditor_company_initials})</p>
                                    </div>
                                    <div>
                                        <p className="text-gray-400 text-xs">Contact</p>
                                        <p>{detail.auditor_contact_phone} · {detail.auditor_email}</p>
                                    </div>
                                    <div>
                                        <p className="text-gray-400 text-xs">Submitted</p>
                                        <p>{formatDate(detail.submitted_at)}</p>
                                    </div>
                                    <div>
                                        <p className="text-gray-400 text-xs">Director Approval</p>
                                        <p className="flex items-center gap-1">
                                            {detail.director_approved_at
                                                ? <><CheckCircleIcon className="h-4 w-4 text-green-600" /> {detail.director_approved_by_name} — {formatDate(detail.director_approved_at)}</>
                                                : <><ClockIcon className="h-4 w-4 text-yellow-500" /> pending</>}
                                        </p>
                                    </div>
                                    <div>
                                        <p className="text-gray-400 text-xs">Secretary Approval</p>
                                        <p className="flex items-center gap-1">
                                            {detail.secretary_approved_at
                                                ? <><CheckCircleIcon className="h-4 w-4 text-green-600" /> {detail.secretary_approved_by_name} — {formatDate(detail.secretary_approved_at)}</>
                                                : <><ClockIcon className="h-4 w-4 text-yellow-500" /> pending</>}
                                        </p>
                                    </div>
                                </div>

                                {detail.status === 'REJECTED' && (
                                    <div className="mb-4 p-3 bg-red-50 border-l-4 border-red-400 text-sm text-red-700">
                                        Rejected by {detail.rejected_by_name} on {formatDate(detail.rejected_at)} — {detail.rejection_reason}
                                    </div>
                                )}

                                <div className="mb-4">
                                    <h4 className="text-sm font-semibold text-gray-700 mb-2">Comments</h4>
                                    {detail.comments.length === 0 ? (
                                        <p className="text-sm text-gray-500">No comments.</p>
                                    ) : (
                                        <ul className="space-y-2">
                                            {detail.comments.map(c => (
                                                <li key={c.id} className="text-sm bg-gray-50 rounded p-2">
                                                    <p className="text-xs text-gray-400">{formatDate(c.created_at)}</p>
                                                    {c.comment_text}
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </div>

                                <div className="mb-4">
                                    <h4 className="text-sm font-semibold text-gray-700 mb-2">Report Files</h4>
                                    {detail.files.length === 0 ? (
                                        <p className="text-sm text-gray-500">No files.</p>
                                    ) : (
                                        <ul className="divide-y divide-gray-200">
                                            {detail.files.map(f => (
                                                <li key={f.id} className="py-2 flex items-center justify-between">
                                                    <div className="flex items-center gap-2 text-sm">
                                                        <PaperClipIcon className="h-4 w-4 text-gray-400" />
                                                        {f.file_name}
                                                        <span className="text-xs text-gray-400">({formatFileSize(f.file_size_bytes)})</span>
                                                    </div>
                                                    <button onClick={() => handlePreviewFile(f.id)} className="btn-secondary text-xs flex items-center gap-1">
                                                        <EyeIcon className="h-4 w-4" /> Preview
                                                    </button>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </div>

                                {detail.status === 'SUBMITTED' && (
                                    <div className="border-t pt-4">
                                        {!showRejectForm ? (
                                            <div className="flex gap-2">
                                                <button onClick={handleApprove} disabled={acting} className="btn-primary flex items-center gap-1">
                                                    <CheckCircleIcon className="h-4 w-4" /> Approve
                                                </button>
                                                <button onClick={() => setShowRejectForm(true)} disabled={acting} className="btn-secondary flex items-center gap-1 text-red-600">
                                                    <XCircleIcon className="h-4 w-4" /> Reject
                                                </button>
                                            </div>
                                        ) : (
                                            <form onSubmit={handleReject} className="space-y-2">
                                                <textarea className="input" rows={3} required placeholder="Reason for rejection"
                                                    value={rejectReason} onChange={e => setRejectReason(e.target.value)} />
                                                <div className="flex gap-2">
                                                    <button type="submit" disabled={acting} className="btn-primary bg-red-600 hover:bg-red-700">
                                                        Confirm Rejection
                                                    </button>
                                                    <button type="button" onClick={() => setShowRejectForm(false)} className="btn-secondary">
                                                        Cancel
                                                    </button>
                                                </div>
                                            </form>
                                        )}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {tab === 'extensions' && (
                <div className="card">
                    <div className="flex items-center justify-between mb-3">
                        <h3 className="section-title">Extension Requests</h3>
                        <select className="input text-sm w-auto" value={extFilter}
                            onChange={e => setExtFilter(e.target.value)}>
                            <option value="PENDING">Awaiting review</option>
                            <option value="APPROVED">Approved</option>
                            <option value="REJECTED">Rejected</option>
                            <option value="">All</option>
                        </select>
                    </div>
                    {extLoading ? (
                        <LoadingSpinner size="sm" text="Loading extension requests..." />
                    ) : extensions.length === 0 ? (
                        <p className="text-sm text-gray-500">No extension requests here.</p>
                    ) : (
                        <ul className="divide-y divide-gray-200">
                            {extensions.map(x => (
                                <li key={x.id} className="py-3">
                                    <div className="flex items-center justify-between">
                                        <p className="text-sm font-medium text-gray-900">
                                            {x.engagement_name} — {x.auditor_name} ({x.auditor_company_name})
                                        </p>
                                        <span className={statusBadgeClass(x.status)}>{x.status}</span>
                                    </div>
                                    <p className="text-xs text-gray-500 mt-1">
                                        Requested {formatDate(x.created_at)} — new access date {formatDate(x.requested_new_access_expires_at)}
                                    </p>
                                    <p className="text-sm text-gray-700 mt-1">{x.reason}</p>
                                    {x.status === 'PENDING' && (
                                        <div className="mt-2 flex items-center gap-2">
                                            <input type="text" placeholder="Optional note" className="input text-sm flex-1"
                                                value={extNotes[x.id] || ''}
                                                onChange={e => setExtNotes(p => ({ ...p, [x.id]: e.target.value }))} />
                                            <button onClick={() => handleApproveExtension(x.id)} disabled={extActing === x.id}
                                                className="btn-primary text-xs">Approve</button>
                                            <button onClick={() => handleRejectExtension(x.id)} disabled={extActing === x.id}
                                                className="btn-secondary text-xs text-red-600">Reject</button>
                                        </div>
                                    )}
                                    {x.status !== 'PENDING' && x.reviewer_notes && (
                                        <p className="text-xs text-gray-400 mt-1">Reviewer note: {x.reviewer_notes}</p>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}
        </div>
    );
};

export default AuditReviewPage;
