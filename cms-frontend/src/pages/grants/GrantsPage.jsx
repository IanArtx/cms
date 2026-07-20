// ============================================================
// GRANTS PAGE
// Shows all grants with conditions and tranches.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { grantsAPI, accountsAPI, categoriesAPI } from '../../api/endpoints';
import { formatCurrency, formatDate, getErrorMessage } from '../../utils/helpers';
import PageHeader from '../../components/common/PageHeader';
import DataTable from '../../components/common/DataTable';
import ErrorMessage from '../../components/common/ErrorMessage';
import StatusBadge from '../../components/common/StatusBadge';
import { useAuth } from '../../contexts/AuthContext';
import { PlusIcon, CheckIcon, ArrowDownTrayIcon, PencilIcon } from '@heroicons/react/24/outline';
import { grantTemplate, printDocument } from '../../utils/exportUtils';
import DocumentPreviewModal from '../../components/common/DocumentPreviewModal';

const BLANK_GRANT_FORM = {
    account_id: '', category_id: '', grantor_name: '',
    grantor_type: 'GOVERNMENT', grantor_contact: '',
    title: '', description: '', total_amount: '',
    is_conditional: false, start_date: '', end_date: '',
};

// ============================================================
// CREATE / EDIT GRANT MODAL
// ============================================================
const CreateGrantModal = ({ isOpen, onClose, onSuccess, accounts, categories, editingRecord }) => {
    const [form, setForm] = useState(BLANK_GRANT_FORM);
    const [conditions, setConditions] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error,   setError]   = useState(null);
    const isEdit = !!editingRecord;

    useEffect(() => {
        if (editingRecord) {
            setForm({
                account_id: editingRecord.account_id || '',
                category_id: editingRecord.category_id || '',
                grantor_name: editingRecord.grantor_name || '',
                grantor_type: editingRecord.grantor_type || 'GOVERNMENT',
                grantor_contact: editingRecord.grantor_contact || '',
                title: editingRecord.title || '',
                description: editingRecord.description || '',
                total_amount: editingRecord.total_amount || '',
                is_conditional: editingRecord.is_conditional || false,
                start_date: editingRecord.start_date ? editingRecord.start_date.slice(0, 10) : '',
                end_date: editingRecord.end_date ? editingRecord.end_date.slice(0, 10) : '',
            });
        } else {
            setForm(BLANK_GRANT_FORM);
            setConditions([]);
        }
    }, [editingRecord, isOpen]);

    if (!isOpen) return null;

    const addCondition = () => {
        setConditions(p => [...p, { title: '', description: '', due_date: '' }]);
    };

    const updateCondition = (index, field, value) => {
        setConditions(p => p.map((c, i) => i === index ? { ...c, [field]: value } : c));
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            if (isEdit) {
                const { ...editable } = form;
                await grantsAPI.update(editingRecord.id, {
                    ...editable,
                    total_amount: parseFloat(editable.total_amount),
                });
            } else {
                await grantsAPI.create({
                    ...form,
                    total_amount: parseFloat(form.total_amount),
                    conditions: form.is_conditional ? conditions : [],
                });
            }
            onSuccess();
            onClose();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    const financeCategories = categories.filter(c => c.module === 'FINANCE');

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            <div className="fixed inset-0 bg-black bg-opacity-40" onClick={onClose} />
            <div className="flex min-h-full items-center justify-center p-4">
                <div className="relative bg-white rounded-xl shadow-xl max-w-2xl w-full p-6 max-h-screen overflow-y-auto">
                    <h2 className="text-lg font-semibold text-gray-900 mb-4">
                        {isEdit ? 'Edit Grant Record' : 'Create Grant Record'}
                    </h2>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="label">Account *</label>
                                <select className="input" value={form.account_id}
                                    onChange={e => setForm(p => ({ ...p, account_id: e.target.value }))}
                                    required>
                                    <option value="">Select account...</option>
                                    {accounts.map(a => (
                                        <option key={a.id} value={a.id}>{a.name}</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className="label">Category *</label>
                                <select className="input" value={form.category_id}
                                    onChange={e => setForm(p => ({ ...p, category_id: e.target.value }))}
                                    required>
                                    <option value="">Select category...</option>
                                    {financeCategories.map(c => (
                                        <option key={c.id} value={c.id}>
                                            {c.full_path || c.name}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="label">Grantor Name *</label>
                                <input type="text" className="input"
                                    value={form.grantor_name}
                                    onChange={e => setForm(p => ({ ...p, grantor_name: e.target.value }))}
                                    required />
                            </div>
                            <div>
                                <label className="label">Grantor Type *</label>
                                <select className="input" value={form.grantor_type}
                                    onChange={e => setForm(p => ({ ...p, grantor_type: e.target.value }))}>
                                    {['GOVERNMENT','NGO','BANK','INSTITUTION','INDIVIDUAL','OTHER'].map(t => (
                                        <option key={t} value={t}>{t}</option>
                                    ))}
                                </select>
                            </div>
                        </div>

                        <div>
                            <label className="label">Grant Title *</label>
                            <input type="text" className="input" value={form.title}
                                onChange={e => setForm(p => ({ ...p, title: e.target.value }))}
                                required />
                        </div>

                        <div>
                            <label className="label">Total Amount *</label>
                            <input type="number" className="input" value={form.total_amount}
                                onChange={e => setForm(p => ({ ...p, total_amount: e.target.value }))}
                                min="0.01" step="0.01" required />
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="label">Start Date</label>
                                <input type="date" className="input" value={form.start_date}
                                    onChange={e => setForm(p => ({ ...p, start_date: e.target.value }))} />
                            </div>
                            <div>
                                <label className="label">End Date</label>
                                <input type="date" className="input" value={form.end_date}
                                    onChange={e => setForm(p => ({ ...p, end_date: e.target.value }))} />
                            </div>
                        </div>

                        <div className="flex items-center gap-2">
                            <input type="checkbox" id="is_conditional"
                                checked={form.is_conditional}
                                onChange={e => setForm(p => ({
                                    ...p, is_conditional: e.target.checked }))} />
                            <label htmlFor="is_conditional" className="text-sm text-gray-700">
                                This grant has conditions
                            </label>
                        </div>

                        {form.is_conditional && !isEdit && (
                            <div className="border border-gray-200 rounded-lg p-4">
                                <div className="flex justify-between items-center mb-3">
                                    <p className="text-sm font-medium text-gray-700">
                                        Conditions
                                    </p>
                                    <button type="button" onClick={addCondition}
                                        className="text-sm text-primary-600 hover:text-primary-700">
                                        + Add Condition
                                    </button>
                                </div>
                                {conditions.map((c, i) => (
                                    <div key={i} className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-2">
                                        <input type="text" className="input" placeholder="Title"
                                            value={c.title}
                                            onChange={e => updateCondition(i, 'title', e.target.value)} />
                                        <input type="text" className="input" placeholder="Description"
                                            value={c.description}
                                            onChange={e => updateCondition(i, 'description', e.target.value)} />
                                        <input type="date" className="input" value={c.due_date}
                                            onChange={e => updateCondition(i, 'due_date', e.target.value)} />
                                    </div>
                                ))}
                            </div>
                        )}
                        {form.is_conditional && isEdit && (
                            <p className="text-xs text-gray-400">
                                Conditions can't be changed here — use "Manage Conditions" on the grant once it's active.
                            </p>
                        )}

                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose} className="btn-secondary">
                                Cancel
                            </button>
                            <button type="submit" disabled={loading} className="btn-primary">
                                {loading ? 'Saving...' : (isEdit ? 'Save Changes' : 'Create Grant')}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// RECORD TRANCHE MODAL
// ============================================================
const TrancheModal = ({ isOpen, grant, onClose, onSuccess }) => {
    const [form, setForm] = useState({ amount: '', received_date: '', notes: '' });
    const [loading, setLoading] = useState(false);
    const [error,   setError]   = useState(null);

    if (!isOpen || !grant) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await grantsAPI.recordTranche(grant.id, form);
            onSuccess();
            onClose();
            setForm({ amount: '', received_date: '', notes: '' });
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
                <div className="relative bg-white rounded-xl shadow-xl max-w-md w-full p-6">
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">
                        Record Grant Tranche
                    </h2>
                    <p className="text-sm text-gray-500 mb-4">
                        {grant.title} — Remaining: {grant.currency_code}{' '}
                        {parseFloat(grant.amount_remaining).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                    </p>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">Amount *</label>
                            <input type="number" className="input" value={form.amount}
                                onChange={e => setForm(p => ({ ...p, amount: e.target.value }))}
                                min="0.01" step="0.01"
                                max={grant.amount_remaining} required />
                        </div>
                        <div>
                            <label className="label">Date Received *</label>
                            <input type="date" className="input" value={form.received_date}
                                onChange={e => setForm(p => ({ ...p, received_date: e.target.value }))}
                                required />
                        </div>
                        <div>
                            <label className="label">Notes</label>
                            <textarea className="input" rows={2} value={form.notes}
                                onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} />
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose} className="btn-secondary">
                                Cancel
                            </button>
                            <button type="submit" disabled={loading} className="btn-primary">
                                {loading ? 'Recording...' : 'Record Tranche'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// MAIN GRANTS PAGE
// ============================================================
const GrantsPage = () => {
    const { hasPermission, user } = useAuth();
    const [grants,     setGrants]     = useState([]);
    const [accounts,   setAccounts]   = useState([]);
    const [categories, setCategories] = useState([]);
    const [pagination, setPagination] = useState(null);
    const [loading,    setLoading]    = useState(true);
    const [error,      setError]      = useState(null);
    const [page,       setPage]       = useState(1);
    const [showCreate, setShowCreate] = useState(false);
    const [editingRecord, setEditingRecord] = useState(null);
    const [trancheGrant, setTrancheGrant] = useState(null);
    const [actionLoading, setActionLoading] = useState(null);
    const [preview, setPreview] = useState(null);

    const canEdit = (row) =>
        row.status === 'PENDING' &&
        (row.created_by === user?.id || hasPermission('GRANT_APPROVE'));

    const openEditModal = async (row) => {
        try {
            const res = await grantsAPI.getById(row.id);
            setEditingRecord(res.data.data);
            setShowCreate(true);
        } catch (err) {
            setError(getErrorMessage(err));
        }
    };

    const closeModal = () => {
        setShowCreate(false);
        setEditingRecord(null);
    };

    const loadGrants = useCallback(async () => {
        try {
            setLoading(true);
            const res = await grantsAPI.getAll({ page, limit: 20 });
            setGrants(res.data.data);
            setPagination(res.data.meta?.pagination);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, [page]);

    useEffect(() => {
        loadGrants();
        accountsAPI.getAll().then(r => setAccounts(r.data.data)).catch(() => {});
        categoriesAPI.getAll({ flat: true }).then(r => setCategories(r.data.data)).catch(() => {});
    }, [loadGrants]);

    const handleApprove = async (id) => {
        setActionLoading(id);
        try {
            await grantsAPI.approve(id);
            loadGrants();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setActionLoading(null);
        }
    };

    const columns = [
        {
            header: 'Reference',
            render: row => (
                <div>
                    <button
                        onClick={() => setPreview({
                            html: grantTemplate(row),
                            title: row.reference_code,
                        })}
                        className="font-mono text-xs font-medium text-primary-700
                            hover:underline"
                        title="Preview document"
                    >
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
            header: 'Grant',
            render: row => (
                <div>
                    <p className="text-sm font-medium text-gray-900">{row.title}</p>
                    <p className="text-xs text-gray-400">{row.grantor_name} ({row.grantor_type})</p>
                </div>
            ),
        },
        {
            header: 'Total Amount',
            render: row => (
                <span className="text-sm font-semibold text-gray-900">
                    {row.currency_code} {parseFloat(row.total_amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                </span>
            ),
        },
        {
            header: 'Received',
            render: row => (
                <div>
                    <p className="text-sm text-green-600 font-medium">
                        {row.currency_code} {parseFloat(row.amount_received).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                    </p>
                    <p className="text-xs text-gray-400">
                        Remaining: {row.currency_code} {parseFloat(row.amount_remaining).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                    </p>
                </div>
            ),
        },
        {
            header: 'Conditions',
            render: row => (
                <span className="text-sm text-gray-600">
                    {row.is_conditional
                        ? `${row.conditions_met}/${row.total_conditions} met`
                        : 'None'
                    }
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
                    {canEdit(row) && (
                        <button
                            onClick={() => openEditModal(row)}
                            className="p-1.5 rounded-lg bg-blue-50 text-blue-600
                                hover:bg-blue-100 transition-colors"
                            title="Edit"
                        >
                            <PencilIcon className="h-4 w-4" />
                        </button>
                    )}
                    {row.status === 'PENDING' && hasPermission('GRANT_APPROVE') && (
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
                    {row.status !== 'PENDING' &&
                     row.status !== 'FULLY_RECEIVED' &&
                     row.status !== 'CLOSED' &&
                     hasPermission('GRANT_APPROVE') && (
                        <button
                            onClick={() => setTrancheGrant(row)}
                            className="text-xs text-primary-600 hover:text-primary-700
                                font-medium px-2 py-1 rounded border border-primary-200
                                hover:bg-primary-50 transition-colors"
                        >
                            + Tranche
                        </button>
                    )}
                    <button
                        onClick={() => printDocument(grantTemplate(row), row.reference_code)}
                        className="p-1.5 rounded-lg bg-gray-50 text-gray-500
                            hover:bg-gray-100 transition-colors"
                        title="Export this grant statement"
                    >
                        <ArrowDownTrayIcon className="h-4 w-4" />
                    </button>
                </div>
            ),
        },
    ];

    return (
        <div>
            <PageHeader
                title="Grants"
                subtitle="Grant records, conditions and disbursement tracking"
                actions={
                    hasPermission('GRANT_CREATE') && (
                        <button
                            onClick={() => { setEditingRecord(null); setShowCreate(true); }}
                            className="btn-primary flex items-center gap-2"
                        >
                            <PlusIcon className="h-4 w-4" />
                            New Grant
                        </button>
                    )
                }
            />

            {error && (
                <div className="mb-4">
                    <ErrorMessage message={error} onDismiss={() => setError(null)} />
                </div>
            )}

            <DataTable
                columns={columns}
                data={grants}
                loading={loading}
                emptyMessage="No grants found"
                searchable
                searchPlaceholder="Search grants..."
                pagination={pagination}
                onPageChange={setPage}
            />

            <CreateGrantModal
                isOpen={showCreate}
                onClose={closeModal}
                onSuccess={loadGrants}
                accounts={accounts}
                categories={categories}
                editingRecord={editingRecord}
            />

            <TrancheModal
                isOpen={!!trancheGrant}
                grant={trancheGrant}
                onClose={() => setTrancheGrant(null)}
                onSuccess={loadGrants}
            />

            <DocumentPreviewModal preview={preview} onClose={() => setPreview(null)} />
        </div>
    );
};

export default GrantsPage;