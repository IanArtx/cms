// ============================================================
// AUDIT MANAGEMENT PAGE (Admin only)
// Create and manage external audit engagements — each one is a
// named, scoped, revocable grant of read-only access for an
// external auditor: which accounts they can see transactions for,
// what date range, which specific documents they can preview, and
// which login(s) belong to the engagement. Nothing here grants
// broad access — every engagement starts empty and an Admin
// explicitly adds each piece.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { auditAPI, accountsAPI, documentsAPI } from '../../api/endpoints';
import { formatDate, getErrorMessage } from '../../utils/helpers';
import PageHeader from '../../components/common/PageHeader';
import ErrorMessage from '../../components/common/ErrorMessage';
import StatusBadge from '../../components/common/StatusBadge';
import LoadingSpinner from '../../components/common/LoadingSpinner';
import { PlusIcon, TrashIcon, NoSymbolIcon, PencilIcon } from '@heroicons/react/24/outline';

const emptyForm = {
    name: '', description: '', period_start: '', period_end: '',
    access_expires_at: '', account_ids: [],
};

// Backend dates come back as full ISO timestamps (e.g.
// "2025-01-01T00:00:00.000Z") even for DATE columns — a date input
// only accepts the first 10 characters ("YYYY-MM-DD").
const toDateInputValue = (value) => value ? value.slice(0, 10) : '';

const AuditManagementPage = () => {
    const [engagements, setEngagements] = useState([]);
    const [accounts, setAccounts]       = useState([]);
    const [loading, setLoading]         = useState(true);
    const [error, setError]             = useState(null);

    const [selectedId, setSelectedId]     = useState(null);
    const [detail, setDetail]             = useState(null);
    const [detailLoading, setDetailLoading] = useState(false);

    const [showForm, setShowForm] = useState(false);
    const [form, setForm]         = useState(emptyForm);
    const [saving, setSaving]     = useState(false);

    const [showEditForm, setShowEditForm] = useState(false);
    const [editForm, setEditForm]         = useState(emptyForm);
    const [editSaving, setEditSaving]     = useState(false);

    const [addEmail, setAddEmail]   = useState('');
    const [addingUser, setAddingUser] = useState(false);

    const [documents, setDocuments]     = useState([]);
    const [pickDocumentId, setPickDocumentId] = useState('');
    const [addingDoc, setAddingDoc]     = useState(false);

    const loadEngagements = useCallback(async () => {
        try {
            const res = await auditAPI.listEngagements();
            setEngagements(res.data.data);
        } catch (err) {
            setError(getErrorMessage(err));
        }
    }, []);

    useEffect(() => {
        (async () => {
            setLoading(true);
            try {
                const [engRes, acctRes] = await Promise.all([
                    auditAPI.listEngagements(),
                    accountsAPI.getAll(),
                ]);
                setEngagements(engRes.data.data);
                setAccounts(acctRes.data.data);
            } catch (err) {
                setError(getErrorMessage(err));
            } finally {
                setLoading(false);
            }
        })();
    }, []);

    const loadDetail = useCallback(async (id) => {
        setDetailLoading(true);
        try {
            const res = await auditAPI.getEngagement(id);
            setDetail(res.data.data);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setDetailLoading(false);
        }
    }, []);

    const selectEngagement = (id) => {
        setSelectedId(id);
        setError(null);
        setShowEditForm(false);
        loadDetail(id);
        if (documents.length === 0) {
            documentsAPI.getAll({ limit: 100 })
                .then(res => setDocuments(res.data.data))
                .catch(() => {});
        }
    };

    const toggleAccount = (id) => {
        setForm(prev => ({
            ...prev,
            account_ids: prev.account_ids.includes(id)
                ? prev.account_ids.filter(a => a !== id)
                : [...prev.account_ids, id],
        }));
    };

    const toggleEditAccount = (id) => {
        setEditForm(prev => ({
            ...prev,
            account_ids: prev.account_ids.includes(id)
                ? prev.account_ids.filter(a => a !== id)
                : [...prev.account_ids, id],
        }));
    };

    const openEditForm = () => {
        if (!detail) return;
        setShowForm(false);
        setEditForm({
            name:               detail.name,
            description:        detail.description || '',
            period_start:       toDateInputValue(detail.period_start),
            period_end:         toDateInputValue(detail.period_end),
            access_expires_at:  toDateInputValue(detail.access_expires_at),
            account_ids:        detail.accounts.map(a => a.id),
        });
        setShowEditForm(true);
    };

    const handleCreate = async (e) => {
        e.preventDefault();
        setError(null);
        setSaving(true);
        try {
            await auditAPI.createEngagement({
                ...form,
                access_expires_at: form.access_expires_at || undefined,
            });
            setForm(emptyForm);
            setShowForm(false);
            await loadEngagements();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setSaving(false);
        }
    };

    const handleUpdate = async (e) => {
        e.preventDefault();
        setError(null);
        setEditSaving(true);
        try {
            await auditAPI.updateEngagement(selectedId, {
                ...editForm,
                access_expires_at: editForm.access_expires_at || undefined,
            });
            setShowEditForm(false);
            await loadDetail(selectedId);
            await loadEngagements();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setEditSaving(false);
        }
    };

    const handleRevoke = async (id) => {
        if (!window.confirm('Revoke this engagement? The auditor(s) attached to it will immediately lose access.')) return;
        setError(null);
        try {
            await auditAPI.revokeEngagement(id);
            await loadEngagements();
            if (selectedId === id) loadDetail(id);
        } catch (err) {
            setError(getErrorMessage(err));
        }
    };

    const handleAddUser = async (e) => {
        e.preventDefault();
        setError(null);
        setAddingUser(true);
        try {
            await auditAPI.addUser(selectedId, { email: addEmail.trim() });
            setAddEmail('');
            await loadDetail(selectedId);
            await loadEngagements();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setAddingUser(false);
        }
    };

    const handleRemoveUser = async (userId) => {
        setError(null);
        try {
            await auditAPI.removeUser(selectedId, userId);
            await loadDetail(selectedId);
            await loadEngagements();
        } catch (err) {
            setError(getErrorMessage(err));
        }
    };

    const handleAddDocument = async (e) => {
        e.preventDefault();
        if (!pickDocumentId) return;
        setError(null);
        setAddingDoc(true);
        try {
            await auditAPI.addDocument(selectedId, { document_id: parseInt(pickDocumentId) });
            setPickDocumentId('');
            await loadDetail(selectedId);
            await loadEngagements();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setAddingDoc(false);
        }
    };

    const handleRemoveDocument = async (documentId) => {
        setError(null);
        try {
            await auditAPI.removeDocument(selectedId, documentId);
            await loadDetail(selectedId);
            await loadEngagements();
        } catch (err) {
            setError(getErrorMessage(err));
        }
    };

    if (loading) {
        return <LoadingSpinner fullPage text="Loading audit engagements..." />;
    }

    return (
        <div>
            <PageHeader
                title="External Audit"
                subtitle="Give an external auditor a dedicated, scoped, revocable login — nothing here is visible to them until you explicitly add it."
                actions={
                    <button className="btn-primary flex items-center gap-2" onClick={() => setShowForm(s => !s)}>
                        <PlusIcon className="h-4 w-4" /> New Engagement
                    </button>
                }
            />

            {error && (
                <div className="mb-4">
                    <ErrorMessage message={error} onDismiss={() => setError(null)} />
                </div>
            )}

            {showForm && (
                <div className="card mb-6">
                    <h3 className="section-title mb-4">New Audit Engagement</h3>
                    <form onSubmit={handleCreate} className="space-y-4">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="label">Name *</label>
                                <input type="text" className="input" required
                                    placeholder="e.g. 2025 Annual Audit — Firm X"
                                    value={form.name}
                                    onChange={e => setForm(p => ({ ...p, name: e.target.value }))} />
                            </div>
                            <div>
                                <label className="label">Description</label>
                                <input type="text" className="input"
                                    value={form.description}
                                    onChange={e => setForm(p => ({ ...p, description: e.target.value }))} />
                            </div>
                            <div>
                                <label className="label">Audit Period Start *</label>
                                <input type="date" className="input" required
                                    value={form.period_start}
                                    onChange={e => setForm(p => ({ ...p, period_start: e.target.value }))} />
                            </div>
                            <div>
                                <label className="label">Audit Period End *</label>
                                <input type="date" className="input" required
                                    value={form.period_end}
                                    onChange={e => setForm(p => ({ ...p, period_end: e.target.value }))} />
                            </div>
                            <div>
                                <label className="label">Access Expires (optional)</label>
                                <input type="date" className="input"
                                    value={form.access_expires_at}
                                    onChange={e => setForm(p => ({ ...p, access_expires_at: e.target.value }))} />
                                <p className="mt-1 text-xs text-gray-400">
                                    Login stops working after this date. Leave blank to control access
                                    manually via Revoke instead.
                                </p>
                            </div>
                        </div>

                        <div>
                            <label className="label">Accounts visible to this engagement *</label>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-1">
                                {accounts.map(a => (
                                    <label key={a.id} className="flex items-center gap-2 text-sm text-gray-700
                                        border border-gray-200 rounded-lg px-3 py-2">
                                        <input type="checkbox"
                                            checked={form.account_ids.includes(a.id)}
                                            onChange={() => toggleAccount(a.id)} />
                                        {a.name} <span className="text-gray-400">({a.account_type})</span>
                                    </label>
                                ))}
                            </div>
                        </div>

                        <div className="flex justify-end gap-2">
                            <button type="button" className="btn-secondary text-sm" onClick={() => setShowForm(false)}>Cancel</button>
                            <button type="submit" disabled={saving} className="btn-primary text-sm">
                                {saving ? 'Creating...' : 'Create Engagement'}
                            </button>
                        </div>
                    </form>
                </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Engagement list */}
                <div className="lg:col-span-1 card p-0 overflow-hidden">
                    {engagements.length === 0 ? (
                        <p className="p-6 text-sm text-gray-500">No audit engagements yet.</p>
                    ) : (
                        <ul className="divide-y divide-gray-200">
                            {engagements.map(e => (
                                <li key={e.id}>
                                    <button
                                        onClick={() => selectEngagement(e.id)}
                                        className={`w-full text-left px-4 py-3 hover:bg-gray-50 transition-colors
                                            ${selectedId === e.id ? 'bg-gray-50' : ''}`}
                                    >
                                        <div className="flex items-center justify-between gap-2">
                                            <span className="text-sm font-medium text-gray-900">{e.name}</span>
                                            <StatusBadge status={e.status} />
                                        </div>
                                        <p className="text-xs text-gray-500 mt-0.5">
                                            {formatDate(e.period_start)} – {formatDate(e.period_end)}
                                        </p>
                                        <p className="text-xs text-gray-400 mt-0.5">
                                            {e.account_count} account{e.account_count === '1' ? '' : 's'} ·{' '}
                                            {e.user_count} auditor{e.user_count === '1' ? '' : 's'} ·{' '}
                                            {e.document_count} document{e.document_count === '1' ? '' : 's'}
                                        </p>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>

                {/* Detail / management panel */}
                <div className="lg:col-span-2">
                    {!selectedId && (
                        <div className="card flex items-center justify-center py-16 text-sm text-gray-500">
                            Select an engagement to manage its accounts, auditors, and documents.
                        </div>
                    )}

                    {selectedId && detailLoading && (
                        <div className="card flex items-center justify-center py-16">
                            <LoadingSpinner size="md" text="Loading..." />
                        </div>
                    )}

                    {selectedId && !detailLoading && detail && (
                        <div className="space-y-6">
                            <div className="card">
                                <div className="flex items-start justify-between">
                                    <div>
                                        <h3 className="text-lg font-semibold text-gray-900">{detail.name}</h3>
                                        {detail.description && (
                                            <p className="text-sm text-gray-500 mt-1">{detail.description}</p>
                                        )}
                                        <p className="text-sm text-gray-500 mt-1">
                                            Audit period: {formatDate(detail.period_start)} – {formatDate(detail.period_end)}
                                        </p>
                                        {detail.access_expires_at && (
                                            <p className="text-sm text-gray-500">
                                                Access expires: {formatDate(detail.access_expires_at)}
                                            </p>
                                        )}
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <StatusBadge status={detail.status} />
                                        {detail.status === 'ACTIVE' && (
                                            <>
                                                <button
                                                    onClick={openEditForm}
                                                    className="btn-secondary text-xs flex items-center gap-1"
                                                >
                                                    <PencilIcon className="h-4 w-4" /> Edit
                                                </button>
                                                <button
                                                    onClick={() => handleRevoke(detail.id)}
                                                    className="btn-danger text-xs flex items-center gap-1"
                                                >
                                                    <NoSymbolIcon className="h-4 w-4" /> Revoke
                                                </button>
                                            </>
                                        )}
                                    </div>
                                </div>

                                {showEditForm && (
                                    <form onSubmit={handleUpdate} className="space-y-4 mt-5 pt-5 border-t border-gray-200">
                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                            <div>
                                                <label className="label">Name *</label>
                                                <input type="text" className="input" required
                                                    value={editForm.name}
                                                    onChange={e => setEditForm(p => ({ ...p, name: e.target.value }))} />
                                            </div>
                                            <div>
                                                <label className="label">Description</label>
                                                <input type="text" className="input"
                                                    value={editForm.description}
                                                    onChange={e => setEditForm(p => ({ ...p, description: e.target.value }))} />
                                            </div>
                                            <div>
                                                <label className="label">Audit Period Start *</label>
                                                <input type="date" className="input" required
                                                    value={editForm.period_start}
                                                    onChange={e => setEditForm(p => ({ ...p, period_start: e.target.value }))} />
                                            </div>
                                            <div>
                                                <label className="label">Audit Period End *</label>
                                                <input type="date" className="input" required
                                                    value={editForm.period_end}
                                                    onChange={e => setEditForm(p => ({ ...p, period_end: e.target.value }))} />
                                            </div>
                                            <div>
                                                <label className="label">Access Expires (optional)</label>
                                                <input type="date" className="input"
                                                    value={editForm.access_expires_at}
                                                    onChange={e => setEditForm(p => ({ ...p, access_expires_at: e.target.value }))} />
                                            </div>
                                        </div>

                                        <div>
                                            <label className="label">Accounts visible to this engagement *</label>
                                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-1">
                                                {accounts.map(a => (
                                                    <label key={a.id} className="flex items-center gap-2 text-sm text-gray-700
                                                        border border-gray-200 rounded-lg px-3 py-2">
                                                        <input type="checkbox"
                                                            checked={editForm.account_ids.includes(a.id)}
                                                            onChange={() => toggleEditAccount(a.id)} />
                                                        {a.name} <span className="text-gray-400">({a.account_type})</span>
                                                    </label>
                                                ))}
                                            </div>
                                        </div>

                                        <div className="flex justify-end gap-2">
                                            <button type="button" className="btn-secondary text-sm" onClick={() => setShowEditForm(false)}>Cancel</button>
                                            <button type="submit" disabled={editSaving} className="btn-primary text-sm">
                                                {editSaving ? 'Saving...' : 'Save Changes'}
                                            </button>
                                        </div>
                                    </form>
                                )}
                            </div>

                            {/* Accounts */}
                            <div className="card">
                                <h4 className="section-title mb-3">Accounts in scope</h4>
                                {detail.accounts.length === 0 ? (
                                    <p className="text-sm text-gray-500">No accounts attached.</p>
                                ) : (
                                    <ul className="text-sm text-gray-700 space-y-1">
                                        {detail.accounts.map(a => (
                                            <li key={a.id}>{a.name} <span className="text-gray-400">({a.account_type})</span></li>
                                        ))}
                                    </ul>
                                )}
                            </div>

                            {/* Auditor users */}
                            <div className="card">
                                <h4 className="section-title mb-3">Auditor logins</h4>
                                {detail.users.length === 0 ? (
                                    <p className="text-sm text-gray-500 mb-3">No auditors attached yet.</p>
                                ) : (
                                    <ul className="text-sm text-gray-700 space-y-2 mb-3">
                                        {detail.users.map(u => (
                                            <li key={u.id} className="flex items-center justify-between">
                                                <span>{u.first_name} {u.last_name} <span className="text-gray-400">({u.email})</span></span>
                                                {detail.status === 'ACTIVE' && (
                                                    <button onClick={() => handleRemoveUser(u.id)}
                                                        className="text-red-500 hover:text-red-700">
                                                        <TrashIcon className="h-4 w-4" />
                                                    </button>
                                                )}
                                            </li>
                                        ))}
                                    </ul>
                                )}
                                {detail.status === 'ACTIVE' && (
                                    <form onSubmit={handleAddUser} className="flex gap-2">
                                        <input
                                            type="email"
                                            className="input flex-1"
                                            placeholder="auditor@firm.com — must already have an account"
                                            value={addEmail}
                                            onChange={e => setAddEmail(e.target.value)}
                                            required
                                        />
                                        <button type="submit" disabled={addingUser} className="btn-primary text-sm whitespace-nowrap">
                                            {addingUser ? 'Adding...' : 'Add'}
                                        </button>
                                    </form>
                                )}
                            </div>

                            {/* Documents */}
                            <div className="card">
                                <h4 className="section-title mb-3">Documents shared with this engagement</h4>
                                {detail.documents.length === 0 ? (
                                    <p className="text-sm text-gray-500 mb-3">No documents shared yet.</p>
                                ) : (
                                    <ul className="text-sm text-gray-700 space-y-2 mb-3">
                                        {detail.documents.map(d => (
                                            <li key={d.id} className="flex items-center justify-between">
                                                <span>{d.title} <span className="text-gray-400">({d.document_type.replace(/_/g, ' ')})</span></span>
                                                {detail.status === 'ACTIVE' && (
                                                    <button onClick={() => handleRemoveDocument(d.id)}
                                                        className="text-red-500 hover:text-red-700">
                                                        <TrashIcon className="h-4 w-4" />
                                                    </button>
                                                )}
                                            </li>
                                        ))}
                                    </ul>
                                )}
                                {detail.status === 'ACTIVE' && (
                                    <form onSubmit={handleAddDocument} className="flex gap-2">
                                        <select className="input flex-1" value={pickDocumentId}
                                            onChange={e => setPickDocumentId(e.target.value)}>
                                            <option value="">Select a document to share...</option>
                                            {documents
                                                .filter(d => !detail.documents.some(dd => dd.id === d.id))
                                                .map(d => (
                                                    <option key={d.id} value={d.id}>{d.title}</option>
                                                ))}
                                        </select>
                                        <button type="submit" disabled={addingDoc || !pickDocumentId} className="btn-primary text-sm whitespace-nowrap">
                                            {addingDoc ? 'Adding...' : 'Add'}
                                        </button>
                                    </form>
                                )}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default AuditManagementPage;
