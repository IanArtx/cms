// ============================================================
// GENERATE DOCUMENT PAGE
// Uses the exportUtils templates to render professional
// documents with company letterhead.
// ============================================================

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { documentsAPI, categoriesAPI } from '../../api/endpoints';
import { getErrorMessage } from '../../utils/helpers';
import { useAuth } from '../../contexts/AuthContext';
import PageHeader from '../../components/common/PageHeader';
import ErrorMessage from '../../components/common/ErrorMessage';
import LoadingSpinner from '../../components/common/LoadingSpinner';
import { DocumentTextIcon, ArrowLeftIcon } from '@heroicons/react/24/outline';
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
            { key: 'venue',            label: 'Venue / Location',   type: 'text',     required: true },
            { key: 'chairperson',      label: 'Chairperson',        type: 'text',     required: true },
            { key: 'secretary',        label: 'Secretary',          type: 'text',     required: true },
            { key: 'attendees',        label: 'Expected Attendees', type: 'textarea', required: true },
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
            { key: 'venue',         label: 'Venue',             type: 'text',     required: true },
            { key: 'chairperson',   label: 'Chairperson',       type: 'text',     required: true },
            { key: 'secretary',     label: 'Secretary',         type: 'text',     required: true },
            { key: 'present',       label: 'Members Present',   type: 'textarea', required: true },
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
            { key: 'resolution_date',  label: 'Resolution Date',  type: 'date', required: true },
            { key: 'chairperson',      label: 'Chairperson',      type: 'text', required: true },
            { key: 'secretary',        label: 'Secretary',        type: 'text', required: true },
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
// MAIN GENERATE DOCUMENT PAGE
// ============================================================
const GenerateDocumentPage = () => {
    const navigate = useNavigate();
    const { user } = useAuth();

    const [templates,        setTemplates]        = useState([]);
    const [categories,       setCategories]       = useState([]);
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

    useEffect(() => {
        Promise.all([
            documentsAPI.getTemplates(),
            categoriesAPI.getAll({ flat: true }),
        ]).then(([tRes, cRes]) => {
            setTemplates(tRes.data.data || []);
            setCategories(cRes.data.data || []);
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
        const config = TEMPLATE_FIELDS[template.template_type];
        if (config?.dynamicSections) {
            const initial = {};
            config.dynamicSections.forEach(s => { initial[s.key] = []; });
            setDynamicValues(initial);
        }
    };

    const handleGenerate = async (e) => {
        e.preventDefault();
        if (!selectedTemplate) return;
        setLoading(true);
        setError(null);
        setPreviewHtml(null);

        try {
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
                throw new Error('Please select a document category');
            }

            // Save to document library
            await documentsAPI.generate(payload);

            // Render using the local template engine
            const rendered = config.renderer(templateData);
            setPreviewHtml(rendered);
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
        <div className="max-w-4xl">
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
                <form onSubmit={handleGenerate}>
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
                                    className={field.type === 'textarea' ? 'sm:col-span-2' : ''}>
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
                        <button type="submit" disabled={loading}
                            className="btn-primary flex items-center gap-2">
                            <DocumentTextIcon className="h-4 w-4" />
                            {loading ? 'Generating...' : 'Generate Document'}
                        </button>
                    </div>
                </form>
            )}

            {/* Preview */}
            {previewHtml && (
                <div className="card mt-6">
                    <div className="flex items-center justify-between mb-4">
                        <h3 className="section-title">Document Preview</h3>
                        <div className="flex gap-2">
                            <button
                                onClick={() => {
                                    const iframe = document.getElementById('doc-preview');
                                    iframe.contentWindow.print();
                                }}
                                className="btn-primary flex items-center gap-2"
                            >
                                <DocumentTextIcon className="h-4 w-4" />
                                Print / Save as PDF
                            </button>
                            <button onClick={() => setPreviewHtml(null)}
                                className="btn-secondary">
                                Close
                            </button>
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