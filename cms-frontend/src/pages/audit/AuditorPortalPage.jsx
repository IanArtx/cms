// ============================================================
// AUDITOR PORTAL PAGE
// The ONLY page an "Auditor" role user ever sees (enforced in
// AppLayout.jsx, which redirects that role to this route no matter
// what URL they try). Scoped entirely server-side — every filter
// here can narrow what's shown, never widen it past what an Admin
// attached to this engagement.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { auditAPI } from '../../api/endpoints';
import { formatDate, formatNumber, getErrorMessage } from '../../utils/helpers';
import {
    meetingAgendaTemplate, meetingMinutesTemplate, receiptTemplate, resolutionTemplate,
    auditSummaryTemplate, previewDocument, printDocument,
} from '../../utils/exportUtils';
import PageHeader from '../../components/common/PageHeader';
import ErrorMessage from '../../components/common/ErrorMessage';
import DataTable from '../../components/common/DataTable';
import LoadingSpinner from '../../components/common/LoadingSpinner';
import { ArrowDownTrayIcon, EyeIcon } from '@heroicons/react/24/outline';

// Same renderers DocumentsPage.jsx uses for SYSTEM_GENERATED documents
// — keep in sync with that file's GENERATED_RENDERERS if a new
// generated document type is ever added.
const GENERATED_RENDERERS = {
    MEETING_AGENDA:  meetingAgendaTemplate,
    MEETING_MINUTES: meetingMinutesTemplate,
    RECEIPT:         receiptTemplate,
    RESOLUTION:      resolutionTemplate,
};

const AuditorPortalPage = () => {
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

    const engagement = engagements.find(e => e.id === engagementId) || null;

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
                const text = await blob.text();
                const payload = JSON.parse(text);
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
        </div>
    );
};

export default AuditorPortalPage;
