// ============================================================
// GENERATE DOCUMENT PAGE
// Uses the exportUtils templates to render professional
// documents with company letterhead.
// ============================================================

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { documentsAPI, categoriesAPI, usersAPI } from '../../api/endpoints';
import { getErrorMessage } from '../../utils/helpers';
import { useAuth } from '../../contexts/AuthContext';
import PageHeader from '../../components/common/PageHeader';
import ErrorMessage from '../../components/common/ErrorMessage';
import LoadingSpinner from '../../components/common/LoadingSpinner';
import { DocumentTextIcon, ArrowLeftIcon, EyeIcon } from '@heroicons/react/24/outline';
import {
    meetingAgendaTemplate,
    meetingMinutesTemplate,
    receiptTemplate,
    resolutionTemplate,
    printDocument,
} from '../../utils/exportUtils';

// ============================================================
// FIELD DEFINITIONS PER TEMPLATE TYPE
// ============================================================
const TEMPLATE_FIELDS = {
    MEETING_AGENDA: {
        label: 'Meeting Agenda',
        fields: [
            { key: 'meeting_title',    label: 'Meeting Title',      type: 'text',     required: true },
            { key: 'meeting_date',     label: 'Meeting Date',       type: 'date',     required: true },
            { key: 'meeting_time',     label: 'Meeting Time',       type: 'time',     required: true },
            { key: 'venue',            label: 'Venue / Location',   type: 'text',       required: true },
            { key: 'chairperson',      label: 'Chairperson',        type: 'person',     required: true },
            { key: 'secretary',        label: 'Secretary',          type: 'person',     required: true },
            { key: 'attendees',        label: 'Expected Attendees', type: 'personList', required: false },
            { key: 'additional_notes', label: 'Additional Notes',   type: 'textarea', required: false },
        ],
        dynamicSections: [
            {
                key: 'agenda_items',
                label: 'Agenda Items',
                addLabel: 'Add Item',
                fields: [
                    { key: 'number',      label: 'No.',         type: 'number', width: 'w-16' },
                    { key: 'title',       label: 'Item Title',  type: 'text',   width: 'flex-1' },
                    { key: 'description', label: 'Description', type: 'text',   width: 'flex-1' },
                    { key: 'duration',    label: 'Duration',    type: 'text',   width: 'w-24',
                      placeholder: 'e.g. 15 min' },
                ],
                defaultItem: { number: '', title: '', description: '', duration: '' },
            },
        ],
        renderer: (data) => meetingAgendaTemplate(data),
    },

    MEETING_MINUTES: {
        label: 'Meeting Minutes',
        fields: [
            { key: 'meeting_title', label: 'Meeting Title',     type: 'text',     required: true },
            { key: 'meeting_date',  label: 'Meeting Date',      type: 'date',     required: true },
            { key: 'meeting_time',  label: 'Meeting Time',      type: 'time',     required: true },
            { key: 'venue',         label: 'Venue',             type: 'text',       required: true },
            { key: 'chairperson',   label: 'Chairperson',       type: 'person',     required: true },
            { key: 'secretary',     label: 'Secretary',         type: 'person',     required: true },
            { key: 'present',       label: 'Members Present',   type: 'personList', required: false },
            { key: 'apologies',     label: 'Apologies',         type: 'textarea', required: false },
            { key: 'closure_notes', label: 'Closure Notes',     type: 'textarea', required: false },
            { key: 'close_time',    label: 'Meeting Closed At', type: 'time',     required: false },
            { key: 'next_meeting',  label: 'Next Meeting',      type: 'text',     required: false },
        ],
        dynamicSections: [
            {
                key: 'minute_items',
                label: 'Agenda Items & Discussion',
                addLabel: 'Add Item',
                fields: [
                    { key: 'number',  label: 'No.',     type: 'number',   width: 'w-16' },
                    { key: 'title',   label: 'Topic',   type: 'text',     width: 'w-48' },
                    { key: 'content', label: 'Minutes', type: 'textarea', width: 'flex-1' },
                ],
                defaultItem: { number: '', title: '', content: '' },
            },
            {
                key: 'action_points',
                label: 'Action Points',
                addLabel: 'Add Action',
                fields: [
                    { key: 'number',      label: 'No.',         type: 'number', width: 'w-16' },
                    { key: 'action',      label: 'Action',      type: 'text',   width: 'flex-1' },
                    { key: 'responsible', label: 'Responsible', type: 'text',   width: 'w-36' },
                    { key: 'deadline',    label: 'Deadline',    type: 'date',   width: 'w-36' },
                ],
                defaultItem: { number: '', action: '', responsible: '', deadline: '' },
            },
        ],
        renderer: (data) => meetingMinutesTemplate(data),
    },

    RECEIPT: {
        label: 'Receipt',
        fields: [
            { key: 'received_from', label: 'Received From',  type: 'text',     required: true },
            { key: 'amount',        label: 'Amount',         type: 'number',   required: true },
            { key: 'currency_code', label: 'Currency Code',  type: 'text',     required: false,
              placeholder: 'e.g. EUR' },
            { key: 'payment_method', label: 'Payment Method', type: 'select',  required: true,
              options: ['Cash', 'Bank Transfer', 'Cheque', 'Mobile Money', 'Other'] },
            { key: 'receipt_date',  label: 'Receipt Date',   type: 'date',     required: true },
            { key: 'received_by',   label: 'Received By',    type: 'text',     required: true },
            { key: 'purpose',       label: 'Purpose',        type: 'textarea', required: true,
              placeholder: 'What is this payment for?' },
            { key: 'notes',         label: 'Notes',          type: 'textarea', required: false },
        ],
        renderer: (data) => receiptTemplate(data),
    },

    RESOLUTION: {
        label: 'Board Resolution',
        fields: [
            { key: 'resolution_title', label: 'Resolution Title', type: 'text', required: true },
            { key: 'meeting_type',     label: 'Meeting Type',     type: 'text', required: true,
              placeholder: 'e.g. Board Meeting, AGM' },
            { key: 'meeting_date',     label: 'Meeting Date',     type: 'date', required: true },
            { key: 'resolution_date',  label: 'Resolution Date',  type: 'date',   required: true },
            { key: 'chairperson',      label: 'Chairperson',      type: 'person', required: true },
            { key: 'secretary',        label: 'Secretary',        type: 'person', required: true },
            { key: 'proposed_by',      label: 'Proposed By',      type: 'text', required: true },
            { key: 'seconded_by',      label: 'Seconded By',      type: 'text', required: false },
            { key: 'vote_result',      label: 'Vote Outcome',     type: 'text', required: true,
              placeholder: 'e.g. Passed unanimously' },
            { key: 'additional_notes', label: 'Additional Notes', type: 'textarea', required: false },
        ],
        dynamicSections: [
            {
                key: 'resolution_clauses',
                label: 'Resolved Clauses',
                addLabel: 'Add Clause',
                fields: [
                    { key: 'number', label: 'No.',              type: 'number',   width: 'w-16' },
                    { key: 'text',   label: 'RESOLVED THAT...',  type: 'textarea', width: 'flex-1' },
                ],
                defaultItem: { number: '', text: '' },
            },
        ],
        renderer: (data) => resolutionTemplate(data),
    },
};

// ============================================================
// DYNAMIC SECTION COMPONENT
// ============================================================
const DynamicSection = ({ section, values, onChange }) => {
    const addRow = () => onChange([...values, { ...section.defaultItem }]);

    const removeRow = (index) => onChange(values.filter((_, i) => i !== index));

    const updateRow = (index, field, value) =>
        onChange(values.map((row, i) =>
            i === index ? { ...row, [field]: value } : row
        ));

    return (
        <div className="border border-gray-200 rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
                <p className="text-sm font-semibold text-gray-700">{section.label}</p>
                <button type="button" onClick={addRow}
                    className="text-sm text-primary-600 hover:text-primary-700 font-medium">
                    + {section.addLabel}
                </button>
            </div>
            {values.length === 0 && (
                <p className="text-sm text-gray-400 text-center py-4">
                    No items yet. Click "{section.addLabel}" to add.
                </p>
            )}
            {values.map((row, rowIndex) => (
                <div key={rowIndex} className="flex gap-2 mb-2 items-start">
                    {section.fields.map(field => (
                        <div key={field.key} className={field.width || 'flex-1'}>
                            {field.type === 'textarea' ? (
                                <textarea className="input text-sm" rows={2}
                                    placeholder={field.label}
                                    value={row[field.key] || ''}
                                    onChange={e => updateRow(rowIndex, field.key, e.target.value)} />
                            ) : (
                                <input type={field.type} className="input text-sm"
                                    placeholder={field.placeholder || field.label}
                                    value={row[field.key] || ''}
                                    onChange={e => updateRow(rowIndex, field.key, e.target.value)} />
                            )}
                        </div>
                    ))}
                    <button type="button" onClick={() => removeRow(rowIndex)}
                        className="mt-2 text-red-400 hover:text-red-600 text-sm flex-shrink-0"
                        title="Remove">✕</button>
                </div>
            ))}
        </div>
    );
};

// ============================================================
// PERSON PICKER (v1.45.0)
// A dropdown of active system users, or — toggled by the link below
// it — a plain free-text name for someone who isn't in the system
// (e.g. a guest chairing a meeting). Only the dropdown case resolves
// to a real user_id; documentsController.js only turns a Chairperson/
// Secretary field into a required digital-signature slot when a real
// user_id came through, so typing a free name is always safe and
// never blocks the document.
// ============================================================
const PersonPicker = ({ users, userId, name, onChange, required, placeholder }) => {
    const [typing, setTyping] = useState(!userId && !!name);

    return (
        <div>
            {typing ? (
                <input type="text" className="input"
                    value={name || ''}
                    onChange={e => onChange({ userId: '', name: e.target.value })}
                    placeholder={placeholder || 'Type a name'}
                    required={required} />
            ) : (
                <select className="input" value={userId || ''}
                    onChange={e => {
                        const id = e.target.value;
                        const u = users.find(x => String(x.id) === id);
                        onChange({ userId: id, name: u ? `${u.first_name} ${u.last_name}` : '' });
                    }}
                    required={required}>
                    <option value="">Select person...</option>
                    {users.map(u => (
                        <option key={u.id} value={u.id}>{u.first_name} {u.last_name}</option>
                    ))}
                </select>
            )}
            <button type="button"
                onClick={() => { setTyping(t => !t); onChange({ userId: '', name: '' }); }}
                className="text-xs text-primary-600 hover:text-primary-700 mt-1">
                {typing ? 'Choose from list instead' : "Not in the list? Type a name instead"}
            </button>
        </div>
    );
};

// ============================================================
// PERSON LIST FIELD (v1.45.0)
// A repeatable list of PersonPicker rows — used for "attendees"/
// "present" fields, which can mix system users and free-typed names.
// Purely for the printed record (no signature implications), unlike
// the single Chairperson/Secretary PersonPicker fields above.
// ============================================================
const PersonListField = ({ users, values, onChange, addLabel = 'Add Person' }) => {
    const addRow = () => onChange([...values, { user_id: '', name: '' }]);
    const removeRow = (index) => onChange(values.filter((_, i) => i !== index));
    const updateRow = (index, patch) =>
        onChange(values.map((row, i) => (i === index ? { ...row, ...patch } : row)));

    return (
        <div className="border border-gray-200 rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
                <p className="text-sm font-semibold text-gray-700">{addLabel}</p>
                <button type="button" onClick={addRow}
                    className="text-sm text-primary-600 hover:text-primary-700 font-medium">
                    + {addLabel}
                </button>
            </div>
            {values.length === 0 && (
                <p className="text-sm text-gray-400 text-center py-4">
                    No one added yet. Click "{addLabel}" to add.
                </p>
            )}
            {values.map((row, index) => (
                <div key={index} className="flex gap-2 mb-2 items-start">
                    <div className="flex-1">
                        <PersonPicker users={users} userId={row.user_id} name={row.name}
                            onChange={({ userId, name }) => updateRow(index, { user_id: userId, name })} />
                    </div>
                    <button type="button" onClick={() => removeRow(index)}
                        className="mt-2 text-red-400 hover:text-red-600 text-sm flex-shrink-0"
                        title="Remove">✕</button>
                </div>
            ))}
        </div>
    );
};

// ============================================================
// MAIN GENERATE DOCUMENT PAGE
// ============================================================
const GenerateDocumentPage = () => {
    const navigate = useNavigate();
    const { user } = useAuth();

    const [templates,        setTemplates]        = useState([]);
    const [categories,       setCategories]       = useState([]);
    const [users,            setUsers]            = useState([]);
    const [selectedTemplate, setSelectedTemplate] = useState(null);
    const [loading,          setLoading]          = useState(false);
    const [loadingTemplates, setLoadingTemplates] = useState(true);
    const [error,            setError]            = useState(null);
    const [success,          setSuccess]          = useState(null);
    const [previewHtml,      setPreviewHtml]      = useState(null);
    const [title,            setTitle]            = useState('');
    const [categoryId,       setCategoryId]       = useState('');
    const [fieldValues,      setFieldValues]      = useState({});
    const [dynamicValues,    setDynamicValues]    = useState({});
    // v1.46.0 — previewing (local render, nothing saved) is now a
    // separate step from actually generating (saving to the Documents
    // library). pendingPayload holds exactly what would be POSTed,
    // built once at Preview time; generated flags that it's already
    // been saved, so Confirm can't be clicked twice into two identical
    // documents — the bug this was built to fix.
    const [pendingPayload,   setPendingPayload]   = useState(null);
    const [generated,        setGenerated]        = useState(false);

    useEffect(() => {
        Promise.all([
            documentsAPI.getTemplates(),
            categoriesAPI.getAll({ flat: true }),
            usersAPI.getAllUsers({ is_active: true, limit: 500 }),
        ]).then(([tRes, cRes, uRes]) => {
            setTemplates(tRes.data.data || []);
            setCategories(cRes.data.data || []);
            setUsers(uRes.data.data || []);
        }).catch(() => {})
          .finally(() => setLoadingTemplates(false));
    }, []);

    const handleTemplateSelect = (template) => {
        setSelectedTemplate(template);
        setFieldValues({});
        setDynamicValues({});
        setTitle('');
        setCategoryId('');
        setError(null);
        setSuccess(null);
        setPreviewHtml(null);
        setPendingPayload(null);
        setGenerated(false);
        const config = TEMPLATE_FIELDS[template.template_type];
        const initial = {};
        (config?.dynamicSections || []).forEach(s => { initial[s.key] = []; });
        (config?.fields || []).filter(f => f.type === 'personList').forEach(f => { initial[f.key] = []; });
        setDynamicValues(initial);
    };

    // --------------------------------------------------------
    // PREVIEW (v1.46.0) — renders locally from the local template
    // engine ONLY. Nothing is sent to the backend and nothing is
    // saved yet, so previewing (or re-previewing after changing a
    // field) any number of times can never create a duplicate
    // document — that only happens in handleConfirmGenerate below,
    // and only once per click.
    // --------------------------------------------------------
    const handlePreview = (e) => {
        e.preventDefault();
        if (!selectedTemplate) return;
        setError(null);
        setSuccess(null);
        setGenerated(false);

        const config = TEMPLATE_FIELDS[selectedTemplate.template_type];
        const templateData = {
            // NOTE: company name/address are deliberately NOT included here —
            // every exportUtils template pulls them live from Settings > Company
            // (via setBranding()) at render time, so persisting a stale
            // snapshot here would only be misleading, never actually used.
            generated_date:  new Date().toLocaleDateString('en-GB'),
            prepared_by:     user ? `${user.first_name} ${user.last_name}` : '',
            ...fieldValues,
            ...dynamicValues,
        };

        const docCategory = categories.find(c => c.module === 'DOCUMENT');

        const payload = {
            template_id:   selectedTemplate.id,
            category_id:   categoryId || docCategory?.id,
            title:         title ||
                `${config?.label} — ${new Date().toLocaleDateString('en-GB')}`,
            document_type: selectedTemplate.template_type,
            template_data: templateData,
        };

        if (!payload.category_id) {
            setError('Please select a document category');
            return;
        }

        // Render using the local template engine — read-only, no
        // backend call. Keep the exact payload we'd save, for Confirm
        // below, so Confirm never has to re-read form state (which
        // could have changed again by the time it's clicked).
        setPreviewHtml(config.renderer(templateData));
        setPendingPayload(payload);
    };

    // --------------------------------------------------------
    // CONFIRM & SAVE (v1.46.0) — the one and only place that actually
    // calls documentsAPI.generate(). Guarded by `loading`/`generated`
    // so the button can't fire twice for the same preview; the only
    // way to save a second time is to deliberately change a field and
    // preview again, which is a genuinely new document, not a
    // duplicate click.
    // --------------------------------------------------------
    const handleConfirmGenerate = async () => {
        if (!pendingPayload || loading || generated) return;
        setLoading(true);
        setError(null);
        try {
            await documentsAPI.generate(pendingPayload);
            setGenerated(true);
            setSuccess(
                'Document generated and saved to library. ' +
                'Use "Print / Save as PDF" to download.'
            );
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    if (loadingTemplates) return <LoadingSpinner fullPage text="Loading templates..." />;

    const config = selectedTemplate
        ? TEMPLATE_FIELDS[selectedTemplate.template_type]
        : null;

    const docCategories = categories.filter(c => c.module === 'DOCUMENT');

    return (
        <div className="max-w-6xl mx-auto">
            <PageHeader
                title="Generate Document"
                subtitle="Fill in the form to generate a professional document"
                showBack
                backTo="/documents"
                actions={
                    <button onClick={() => navigate('/documents')}
                        className="btn-secondary flex items-center gap-2">
                        <ArrowLeftIcon className="h-4 w-4" />
                        Back to Documents
                    </button>
                }
            />

            {error && (
                <div className="mb-4">
                    <ErrorMessage message={error} onDismiss={() => setError(null)} />
                </div>
            )}
            {success && (
                <div className="mb-4 bg-green-50 border border-green-200
                    rounded-lg p-4 text-sm text-green-700">
                    {success}
                </div>
            )}

            {/* Step 1 */}
            <div className="card mb-6">
                <h3 className="section-title mb-4">Step 1 — Select Template</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {templates.map(template => {
                        const cfg = TEMPLATE_FIELDS[template.template_type];
                        if (!cfg) return null;
                        const isSelected = selectedTemplate?.id === template.id;
                        return (
                            <button key={template.id} type="button"
                                onClick={() => handleTemplateSelect(template)}
                                className={`flex items-start gap-3 p-4 rounded-lg
                                    border-2 text-left transition-all ${isSelected
                                        ? 'border-primary-600 bg-primary-50'
                                        : 'border-gray-200 hover:border-primary-300'
                                    }`}>
                                <DocumentTextIcon className={`h-6 w-6 mt-0.5 flex-shrink-0 ${
                                    isSelected ? 'text-primary-600' : 'text-gray-400'}`} />
                                <div>
                                    <p className={`text-sm font-semibold ${
                                        isSelected ? 'text-primary-700' : 'text-gray-900'}`}>
                                        {cfg.label}
                                    </p>
                                    <p className="text-xs text-gray-400 mt-0.5">
                                        {template.description}
                                    </p>
                                </div>
                            </button>
                        );
                    })}
                </div>
            </div>

            {selectedTemplate && config && (
                <form onSubmit={handlePreview}>
                    {/* Step 2 */}
                    <div className="card mb-6">
                        <h3 className="section-title mb-4">Step 2 — Document Details</h3>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="label">Document Title</label>
                                <input type="text" className="input" value={title}
                                    onChange={e => setTitle(e.target.value)}
                                    placeholder={`${config.label} — ${
                                        new Date().toLocaleDateString('en-GB')}`} />
                            </div>
                            <div>
                                <label className="label">Category *</label>
                                <select className="input" value={categoryId}
                                    onChange={e => setCategoryId(e.target.value)} required>
                                    <option value="">Select category...</option>
                                    {docCategories.map(c => (
                                        <option key={c.id} value={c.id}>
                                            {c.full_path || c.name}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        </div>
                    </div>

                    {/* Step 3 */}
                    <div className="card mb-6">
                        <h3 className="section-title mb-4">Step 3 — Fill in Content</h3>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
                            {config.fields.map(field => (
                                <div key={field.key}
                                    className={(field.type === 'textarea' || field.type === 'personList')
                                        ? 'sm:col-span-2' : ''}>
                                    <label className="label">
                                        {field.label}
                                        {field.required && (
                                            <span className="text-red-500 ml-1">*</span>
                                        )}
                                    </label>
                                    {field.type === 'textarea' ? (
                                        <textarea className="input" rows={3}
                                            value={fieldValues[field.key] || ''}
                                            onChange={e => setFieldValues(p => ({
                                                ...p, [field.key]: e.target.value }))}
                                            required={field.required} />
                                    ) : field.type === 'select' ? (
                                        <select className="input"
                                            value={fieldValues[field.key] || ''}
                                            onChange={e => setFieldValues(p => ({
                                                ...p, [field.key]: e.target.value }))}
                                            required={field.required}>
                                            <option value="">Select...</option>
                                            {(field.options || []).map(opt => (
                                                <option key={opt} value={opt}>{opt}</option>
                                            ))}
                                        </select>
                                    ) : field.type === 'person' ? (
                                        <PersonPicker users={users}
                                            userId={fieldValues[`${field.key}_user_id`]}
                                            name={fieldValues[`${field.key}_name`]}
                                            required={field.required}
                                            onChange={({ userId, name }) => setFieldValues(p => ({
                                                ...p, [`${field.key}_user_id`]: userId, [`${field.key}_name`]: name }))} />
                                    ) : field.type === 'personList' ? (
                                        <PersonListField users={users}
                                            values={dynamicValues[field.key] || []}
                                            addLabel={field.label}
                                            onChange={vals => setDynamicValues(p => ({
                                                ...p, [field.key]: vals }))} />
                                    ) : (
                                        <input type={field.type} className="input"
                                            value={fieldValues[field.key] || ''}
                                            onChange={e => setFieldValues(p => ({
                                                ...p, [field.key]: e.target.value }))}
                                            placeholder={field.placeholder || ''}
                                            required={field.required} />
                                    )}
                                </div>
                            ))}
                        </div>
                        {(config.dynamicSections || []).map(section => (
                            <div key={section.key} className="mb-4">
                                <DynamicSection
                                    section={section}
                                    values={dynamicValues[section.key] || []}
                                    onChange={vals => setDynamicValues(p => ({
                                        ...p, [section.key]: vals }))}
                                />
                            </div>
                        ))}
                    </div>

                    <div className="flex justify-end gap-3 mb-6">
                        <button type="button" onClick={() => navigate('/documents')}
                            className="btn-secondary">Cancel</button>
                        <button type="submit"
                            className="btn-primary flex items-center gap-2">
                            <EyeIcon className="h-4 w-4" />
                            {previewHtml ? 'Update Preview' : 'Preview'}
                        </button>
                    </div>
                </form>
            )}

            {/* Preview — v1.46.0: local render only, nothing saved yet.
                Review it, change a field above and preview again if
                something needs fixing, then Confirm to actually save
                it to the Documents library. This is also what stops
                the old bug where clicking Generate more than once
                created the same document multiple times — saving now
                only ever happens from the single Confirm button below,
                which disables itself the moment it succeeds. */}
            {previewHtml && (
                <div className="card mt-6">
                    <div className="flex items-center justify-between mb-4">
                        <div>
                            <h3 className="section-title">Document Preview</h3>
                            <p className="text-xs text-gray-400 mt-0.5">
                                {generated
                                    ? 'Saved to the Documents library.'
                                    : 'Not saved yet — review it, then confirm below.'}
                            </p>
                        </div>
                        <div className="flex gap-2">
                            <button
                                onClick={() => {
                                    const iframe = document.getElementById('doc-preview');
                                    iframe.contentWindow.print();
                                }}
                                className="btn-secondary flex items-center gap-2"
                            >
                                <DocumentTextIcon className="h-4 w-4" />
                                Print / Save as PDF
                            </button>
                            {generated ? (
                                <button onClick={() => navigate('/documents')}
                                    className="btn-primary flex items-center gap-2">
                                    <DocumentTextIcon className="h-4 w-4" />
                                    Done — Go to Documents
                                </button>
                            ) : (
                                <button onClick={handleConfirmGenerate} disabled={loading}
                                    className="btn-primary flex items-center gap-2">
                                    <DocumentTextIcon className="h-4 w-4" />
                                    {loading ? 'Saving...' : 'Confirm & Save to Library'}
                                </button>
                            )}
                        </div>
                    </div>
                    <div className="border border-gray-200 rounded-lg overflow-hidden">
                        <iframe id="doc-preview" srcDoc={previewHtml}
                            style={{ width: '100%', height: '750px', border: 'none' }}
                            title="Document Preview" />
                    </div>
                </div>
            )}
        </div>
    );
};

export default GenerateDocumentPage;