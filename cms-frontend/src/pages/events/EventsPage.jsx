// ============================================================
// EVENTS PAGE
// Shows all company events with approval and notification.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { eventsAPI, categoriesAPI } from '../../api/endpoints';
import { formatDateTime, formatDate, getErrorMessage } from '../../utils/helpers';
import PageHeader from '../../components/common/PageHeader';
import DataTable from '../../components/common/DataTable';
import ErrorMessage from '../../components/common/ErrorMessage';
import StatusBadge from '../../components/common/StatusBadge';
import { useAuth } from '../../contexts/AuthContext';
import { PlusIcon, CheckIcon, XMarkIcon, ArrowDownTrayIcon, PencilIcon, ClockIcon, FlagIcon } from '@heroicons/react/24/outline';
import { eventTemplate, printDocument } from '../../utils/exportUtils';
import DocumentPreviewModal from '../../components/common/DocumentPreviewModal';

const BLANK_EVENT_FORM = {
    event_type_id: '', category_id: '', title: '',
    description: '', location: '', event_date: '',
    end_date: '', recurrence: 'NONE',
};

// ============================================================
// CREATE / EDIT EVENT MODAL
// ============================================================
const CreateEventModal = ({ isOpen, onClose, onSuccess, categories, eventTypes, editingRecord }) => {
    const [form, setForm] = useState(BLANK_EVENT_FORM);
    const [loading, setLoading] = useState(false);
    const [error,   setError]   = useState(null);
    const isEdit = !!editingRecord;

    useEffect(() => {
        if (editingRecord) {
            setForm({
                event_type_id: editingRecord.event_type_id || '',
                category_id: editingRecord.category_id || '',
                title: editingRecord.title || '',
                description: editingRecord.description || '',
                location: editingRecord.location || '',
                event_date: editingRecord.event_date ? editingRecord.event_date.slice(0, 16) : '',
                end_date: editingRecord.end_date ? editingRecord.end_date.slice(0, 16) : '',
                recurrence: editingRecord.recurrence || 'NONE',
            });
        } else {
            setForm(BLANK_EVENT_FORM);
        }
    }, [editingRecord, isOpen]);

    if (!isOpen) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            if (isEdit) {
                await eventsAPI.update(editingRecord.id, form);
            } else {
                await eventsAPI.create(form);
            }
            onSuccess();
            onClose();
            setForm(BLANK_EVENT_FORM);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    const eventCategories = categories.filter(c => c.module === 'EVENT');

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            <div className="fixed inset-0 bg-black bg-opacity-40" onClick={onClose} />
            <div className="flex min-h-full items-center justify-center p-4">
                <div className="relative bg-white rounded-xl shadow-xl
                    max-w-lg w-full p-6">
                    <h2 className="text-lg font-semibold text-gray-900 mb-4">
                        {isEdit ? 'Edit Event' : 'Create Event'}
                    </h2>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="label">Event Type *</label>
                                <select className="input" value={form.event_type_id}
                                    onChange={e => setForm(p => ({
                                        ...p, event_type_id: e.target.value }))}
                                    required>
                                    <option value="">Select type...</option>
                                    {eventTypes.map(t => (
                                        <option key={t.id} value={t.id}>{t.name}</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className="label">Category *</label>
                                <select className="input" value={form.category_id}
                                    onChange={e => setForm(p => ({
                                        ...p, category_id: e.target.value }))}
                                    required>
                                    <option value="">Select category...</option>
                                    {eventCategories.map(c => (
                                        <option key={c.id} value={c.id}>
                                            {c.full_path || c.name}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        </div>

                        <div>
                            <label className="label">Title *</label>
                            <input type="text" className="input" value={form.title}
                                onChange={e => setForm(p => ({
                                    ...p, title: e.target.value }))}
                                required />
                        </div>

                        <div>
                            <label className="label">Location</label>
                            <input type="text" className="input" value={form.location}
                                onChange={e => setForm(p => ({
                                    ...p, location: e.target.value }))} />
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="label">Event Date *</label>
                                <input type="datetime-local" className="input"
                                    value={form.event_date}
                                    onChange={e => setForm(p => ({
                                        ...p, event_date: e.target.value }))}
                                    required />
                            </div>
                            <div>
                                <label className="label">End Date</label>
                                <input type="datetime-local" className="input"
                                    value={form.end_date}
                                    onChange={e => setForm(p => ({
                                        ...p, end_date: e.target.value }))} />
                            </div>
                        </div>

                        <div>
                            <label className="label">Recurrence</label>
                            <select className="input" value={form.recurrence}
                                onChange={e => setForm(p => ({
                                    ...p, recurrence: e.target.value }))}>
                                {['NONE','DAILY','WEEKLY','MONTHLY','ANNUALLY'].map(r => (
                                    <option key={r} value={r}>{r}</option>
                                ))}
                            </select>
                        </div>

                        <div>
                            <label className="label">Description</label>
                            <textarea className="input" rows={2}
                                value={form.description}
                                onChange={e => setForm(p => ({
                                    ...p, description: e.target.value }))} />
                        </div>

                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose}
                                className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading}
                                className="btn-primary">
                                {loading ? 'Saving...' : (isEdit ? 'Save Changes' : 'Create Event')}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// EXTEND EVENT MODAL (v1.28.3)
// Pushes an already-approved event's date(s) further out. Dates can
// only move later than what's already set — this extends the event,
// it doesn't reschedule it.
// ============================================================
const ExtendEventModal = ({ isOpen, onClose, onSuccess, event }) => {
    const [eventDate, setEventDate] = useState('');
    const [endDate, setEndDate] = useState('');
    const [reason, setReason] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (isOpen && event) {
            setEventDate(event.event_date ? event.event_date.slice(0, 16) : '');
            setEndDate(event.end_date ? event.end_date.slice(0, 16) : '');
            setReason('');
            setError(null);
        }
    }, [isOpen, event]);

    if (!isOpen || !event) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await eventsAPI.extend(event.id, {
                event_date: eventDate ? new Date(eventDate).toISOString() : undefined,
                end_date: endDate ? new Date(endDate).toISOString() : undefined,
                reason: reason || undefined,
            });
            onSuccess();
            onClose();
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
                <div className="relative bg-white rounded-xl shadow-xl max-w-lg w-full p-6">
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">Extend Event</h2>
                    <p className="text-sm text-gray-400 mb-4">
                        Push "{event.title}" further out. New dates can only be later than
                        what's currently set — everyone originally notified will be told
                        about the change.
                    </p>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="label">New Event Date</label>
                                <input type="datetime-local" className="input"
                                    min={event.event_date ? event.event_date.slice(0, 16) : undefined}
                                    value={eventDate}
                                    onChange={e => setEventDate(e.target.value)} />
                            </div>
                            <div>
                                <label className="label">New End Date</label>
                                <input type="datetime-local" className="input"
                                    min={(event.end_date || event.event_date || '').slice(0, 16)}
                                    value={endDate}
                                    onChange={e => setEndDate(e.target.value)} />
                            </div>
                        </div>
                        <div>
                            <label className="label">Reason (optional)</label>
                            <input type="text" className="input" value={reason}
                                placeholder="e.g. venue became unavailable"
                                onChange={e => setReason(e.target.value)} />
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading} className="btn-primary">
                                {loading ? 'Extending...' : 'Extend Event'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// MAIN EVENTS PAGE
// ============================================================
const EventsPage = () => {
    const { hasPermission, user } = useAuth();
    const [events,      setEvents]      = useState([]);
    const [categories,  setCategories]  = useState([]);
    const [eventTypes,  setEventTypes]  = useState([]);
    const [pagination,  setPagination]  = useState(null);
    const [loading,     setLoading]     = useState(true);
    const [error,       setError]       = useState(null);
    const [page,        setPage]        = useState(1);
    const [showCreate,  setShowCreate]  = useState(false);
    const [editingRecord, setEditingRecord] = useState(null);
    const [actionLoading, setActionLoading] = useState(null);
    const [preview, setPreview] = useState(null);
    const [extendingRecord, setExtendingRecord] = useState(null);

    const canEdit = (row) =>
        row.status === 'DRAFT' &&
        (row.created_by === user?.id || hasPermission('EVENT_APPROVE'));

    const openEditModal = (row) => {
        setEditingRecord(row);
        setShowCreate(true);
    };

    const closeModal = () => {
        setShowCreate(false);
        setEditingRecord(null);
    };

    // Filter state
    const [statusFilter, setStatusFilter] = useState('');

    const loadEvents = useCallback(async () => {
        try {
            setLoading(true);
            const params = { page, limit: 20 };
            if (statusFilter) params.status = statusFilter;
            const res = await eventsAPI.getAll(params);
            setEvents(res.data.data);
            setPagination(res.data.meta?.pagination);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, [page, statusFilter]);

    useEffect(() => {
        loadEvents();
        categoriesAPI.getAll({ flat: true }).then(r => setCategories(r.data.data)).catch(() => {});
        eventsAPI.getTypes().then(r => setEventTypes(r.data.data)).catch(() => {});
    }, [loadEvents]);

    const handleApprove = async (id) => {
        setActionLoading(id);
        try {
            await eventsAPI.approve(id);
            loadEvents();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setActionLoading(null);
        }
    };

    const handleCancel = async (id) => {
        const reason = window.prompt('Enter reason for cancellation:');
        if (!reason) return;
        setActionLoading(id);
        try {
            await eventsAPI.cancel(id, { reason });
            loadEvents();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setActionLoading(null);
        }
    };

    const handleComplete = async (id) => {
        if (!window.confirm('Mark this event as completed?')) return;
        setActionLoading(id);
        try {
            await eventsAPI.complete(id);
            loadEvents();
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
                            html: eventTemplate(row),
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
            header: 'Event',
            render: row => (
                <div>
                    <p className="text-sm font-medium text-gray-900">{row.title}</p>
                    <p className="text-xs text-gray-400">
                        {row.event_type}
                        {row.location && ` • ${row.location}`}
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
            header: 'Date',
            render: row => (
                <div>
                    <p className="text-sm text-gray-900">
                        {formatDateTime(row.event_date)}
                    </p>
                    {row.end_date && (
                        <p className="text-xs text-gray-400">
                            Until {formatDateTime(row.end_date)}
                        </p>
                    )}
                </div>
            ),
        },
        {
            header: 'Days Until',
            render: row => (
                <span className={`text-sm font-medium ${
                    row.days_until_event !== null && row.days_until_event <= 7
                        ? 'text-red-600'
                        : row.days_until_event !== null && row.days_until_event <= 30
                        ? 'text-yellow-600'
                        : 'text-gray-600'
                }`}>
                    {row.days_until_event !== null
                        ? `${row.days_until_event} days`
                        : '—'
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
                    {['DRAFT','PENDING_APPROVAL'].includes(row.status) &&
                     hasPermission('EVENT_APPROVE') && (
                        <button
                            onClick={() => handleApprove(row.id)}
                            disabled={actionLoading === row.id}
                            className="p-1.5 rounded-lg bg-green-50 text-green-600
                                hover:bg-green-100 transition-colors"
                            title="Approve & Send Notifications"
                        >
                            <CheckIcon className="h-4 w-4" />
                        </button>
                    )}
                    {row.status === 'APPROVED' && hasPermission('EVENT_MANAGE') && (
                        <button
                            onClick={() => setExtendingRecord(row)}
                            disabled={actionLoading === row.id}
                            className="p-1.5 rounded-lg bg-yellow-50 text-yellow-600
                                hover:bg-yellow-100 transition-colors"
                            title="Extend Event"
                        >
                            <ClockIcon className="h-4 w-4" />
                        </button>
                    )}
                    {row.status === 'APPROVED' && hasPermission('EVENT_MANAGE') && (
                        <button
                            onClick={() => handleComplete(row.id)}
                            disabled={actionLoading === row.id}
                            className="p-1.5 rounded-lg bg-purple-50 text-purple-600
                                hover:bg-purple-100 transition-colors"
                            title="Mark as Completed"
                        >
                            <FlagIcon className="h-4 w-4" />
                        </button>
                    )}
                    {!['CANCELLED','COMPLETED'].includes(row.status) &&
                     hasPermission('EVENT_MANAGE') && (
                        <button
                            onClick={() => handleCancel(row.id)}
                            disabled={actionLoading === row.id}
                            className="p-1.5 rounded-lg bg-red-50 text-red-600
                                hover:bg-red-100 transition-colors"
                            title="Cancel Event"
                        >
                            <XMarkIcon className="h-4 w-4" />
                        </button>
                    )}
                    <button
                        onClick={() => printDocument(eventTemplate(row), row.reference_code)}
                        className="p-1.5 rounded-lg bg-gray-50 text-gray-500
                            hover:bg-gray-100 transition-colors"
                        title="Export this event notice"
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
                title="Events"
                subtitle="Company calendar — meetings, deadlines and anniversaries"
                actions={
                    hasPermission('EVENT_CREATE') && (
                        <button
                            onClick={() => { setEditingRecord(null); setShowCreate(true); }}
                            className="btn-primary flex items-center gap-2"
                        >
                            <PlusIcon className="h-4 w-4" />
                            New Event
                        </button>
                    )
                }
            />

            {error && (
                <div className="mb-4">
                    <ErrorMessage message={error} onDismiss={() => setError(null)} />
                </div>
            )}

            {/* Status Filter */}
            <div className="card mb-6">
                <div className="flex gap-2 flex-wrap">
                    {['', 'DRAFT', 'APPROVED', 'CANCELLED', 'COMPLETED'].map(s => (
                        <button
                            key={s}
                            onClick={() => { setStatusFilter(s); setPage(1); }}
                            className={`px-3 py-1.5 rounded-lg text-sm font-medium
                                transition-colors ${statusFilter === s
                                    ? 'bg-primary-700 text-white'
                                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                                }`}
                        >
                            {s || 'All'}
                        </button>
                    ))}
                </div>
            </div>

            <DataTable
                columns={columns}
                data={events}
                loading={loading}
                emptyMessage="No events found"
                searchable
                searchPlaceholder="Search events..."
                pagination={pagination}
                onPageChange={setPage}
            />

            <CreateEventModal
                isOpen={showCreate}
                onClose={closeModal}
                onSuccess={loadEvents}
                categories={categories}
                eventTypes={eventTypes}
                editingRecord={editingRecord}
            />

            <ExtendEventModal
                isOpen={!!extendingRecord}
                onClose={() => setExtendingRecord(null)}
                onSuccess={loadEvents}
                event={extendingRecord}
            />

            <DocumentPreviewModal preview={preview} onClose={() => setPreview(null)} />
        </div>
    );
};

export default EventsPage;