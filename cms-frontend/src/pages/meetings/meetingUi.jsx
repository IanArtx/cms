// ============================================================
// MEETINGS — shared pieces (v1.79.0)
// Small components used by the Meetings hub, a meeting's page, the
// resolution page, the dashboard and Settings › Governance:
//   • Modal                 — the app's standard overlay + panel
//   • MeetingStatus / ResultBadge / FilingBadge
//   • MeetingFormModal      — create / edit a meeting (agenda editor)
//   • ResolutionFormModal   — propose a resolution (meeting or written)
//   • StatutoryDocButtons   — preview / save the statutory documents
//   • GovernanceSettingsPanel — notice periods, quorum, majorities,
//     legal references, and the company's statutory details
// ============================================================

import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { meetingsAPI, settingsAPI, usersAPI } from '../../api/endpoints';
import { getErrorMessage, formatDate } from '../../utils/helpers';
import { renderGovernanceDocument } from '../../utils/governanceTemplates';
import DocumentPreviewModal from '../../components/common/DocumentPreviewModal';
import { PlusIcon, TrashIcon, ArrowUpIcon, ArrowDownIcon, EyeIcon, DocumentArrowDownIcon } from '@heroicons/react/24/outline';

export const MEETING_TYPE_LABEL = { AGM: 'Annual General Meeting', EGM: 'Extraordinary General Meeting', BOARD: 'Board meeting' };
export const MEETING_TYPE_SHORT = { AGM: 'AGM', EGM: 'EGM', BOARD: 'Board' };
export const KIND_LABEL = {
    ORDINARY: 'Ordinary', SPECIAL: 'Special', BOARD: 'Board',
    WRITTEN_MEMBERS: 'Written (members)', WRITTEN_BOARD: 'Written (directors)',
};
export const ATTENDANCE_LABEL = {
    PENDING: 'Not recorded', PRESENT: 'In person', PRESENT_VIRTUAL: 'Online',
    BY_PROXY: 'By proxy', APOLOGY: 'Apology', ABSENT: 'Absent',
};

const STATUS_STYLE = {
    DRAFT: ['badge-gray', 'Draft'],
    NOTICE_ISSUED: ['badge-blue', 'Notice issued'],
    IN_PROGRESS: ['badge-yellow', 'In progress'],
    CLOSED: ['badge-green', 'Held'],
    CANCELLED: ['badge-red', 'Cancelled'],
};
export const MeetingStatus = ({ status }) => {
    const [cls, label] = STATUS_STYLE[status] || ['badge-gray', status];
    return <span className={`badge ${cls}`}>{label}</span>;
};

const RESULT_STYLE = {
    PENDING: ['badge-purple', 'Pending'], CARRIED: ['badge-green', 'Carried'],
    LOST: ['badge-red', 'Lost'], WITHDRAWN: ['badge-gray', 'Withdrawn'],
};
export const ResultBadge = ({ result }) => {
    const [cls, label] = RESULT_STYLE[result] || ['badge-gray', result];
    return <span className={`badge ${cls}`}>{label}</span>;
};

export const FilingBadge = ({ state, due }) => {
    if (!state) return null;
    if (state === 'FILED') return <span className="badge badge-green">Filed with URSB</span>;
    if (state === 'OVERDUE') return <span className="badge badge-red">URSB filing overdue{due ? ` (was due ${formatDate(due)})` : ''}</span>;
    return <span className="badge badge-yellow">File with URSB by {formatDate(due)}</span>;
};

// "10:00:00" → "10:00"
export const hhmm = (t) => (t ? String(t).slice(0, 5) : '');

// ------------------------------------------------------------
// Modal shell — same overlay/panel as every other modal in the app
// ------------------------------------------------------------
export const Modal = ({ isOpen, onClose, title, subtitle = null, wide = false, children }) => {
    if (!isOpen) return null;
    return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            <div className="fixed inset-0 bg-black bg-opacity-40" onClick={onClose} />
            <div className="flex min-h-full items-center justify-center p-4">
                <div className={`relative bg-white rounded-xl shadow-xl w-full p-5 sm:p-6 ${wide ? 'max-w-3xl' : 'max-w-lg'}`}>
                    <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
                    {subtitle && <p className="text-sm text-gray-500 mt-1">{subtitle}</p>}
                    <div className="mt-4">{children}</div>
                </div>
            </div>
        </div>
    );
};

// People for the chair / secretary / proposer pickers (names only).
export const useDirectory = () => {
    const [people, setPeople] = useState([]);
    useEffect(() => {
        usersAPI.getDirectory().then(r => setPeople(r.data.data || [])).catch(() => {});
    }, []);
    return people;
};
const personLabel = (p) => `${p.first_name || ''} ${p.last_name || ''}`.trim() || p.name || p.email;

export const PersonSelect = ({ value, onChange, people, placeholder = 'Choose a person…', className = 'input' }) => (
    <select className={className} value={value || ''} onChange={e => onChange(e.target.value ? Number(e.target.value) : null)}>
        <option value="">{placeholder}</option>
        {people.map(p => <option key={p.id} value={p.id}>{personLabel(p)}</option>)}
    </select>
);

// ============================================================
// MEETING FORM (create / edit)
// ============================================================
const BUSINESS_OPTIONS = [
    { value: 'ROUTINE', label: 'Routine' },
    { value: 'ORDINARY', label: 'Ordinary business' },
    { value: 'SPECIAL', label: 'Special business' },
];

export const MeetingFormModal = ({ isOpen, onClose, onSaved, meeting = null, settings = null }) => {
    const people = useDirectory();
    const editing = !!meeting;
    const [form, setForm] = useState({});
    const [agenda, setAgenda] = useState([]);
    const [error, setError] = useState(null);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!isOpen) return;
        setError(null);
        setForm(meeting ? {
            meeting_type: meeting.meeting_type, title: meeting.title, financial_year: meeting.financial_year || '',
            meeting_date: meeting.meeting_date, start_time: hhmm(meeting.start_time), end_time: hhmm(meeting.end_time),
            venue: meeting.venue || '', mode: meeting.mode, virtual_link: meeting.virtual_link || '',
            chairperson_user_id: meeting.chairperson_user_id, secretary_user_id: meeting.secretary_user_id,
        } : { meeting_type: 'AGM', mode: 'PHYSICAL', start_time: '10:00', meeting_date: '', venue: '', financial_year: String(new Date().getFullYear() - 1) });
        setAgenda(meeting ? (meeting.agenda || []).map(a => ({ ...a })) : []);
    }, [isOpen, meeting]);

    const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));
    const noticeDays = settings && form.meeting_type ? (form.meeting_type === 'BOARD' ? settings.board_meeting_notice_days
        : Math.max(form.meeting_type === 'AGM' ? settings.agm_notice_days : settings.general_meeting_notice_days,
            agenda.some(a => a.business === 'SPECIAL') ? settings.special_resolution_notice_days : 0)) : null;
    const earliest = noticeDays != null ? (() => { const d = new Date(); d.setDate(d.getDate() + noticeDays); return d.toISOString().slice(0, 10); })() : null;

    const moveItem = (i, dir) => setAgenda(list => {
        const next = [...list];
        const j = i + dir;
        if (j < 0 || j >= next.length) return list;
        [next[i], next[j]] = [next[j], next[i]];
        return next;
    });

    const submit = async (e) => {
        e.preventDefault();
        setError(null);
        setSaving(true);
        try {
            const payload = {
                ...form,
                end_time: form.end_time || null,
                virtual_link: form.virtual_link || null,
            };
            if (editing || agenda.length) payload.agenda = agenda.filter(a => (a.title || '').trim());
            if (editing) delete payload.meeting_type;
            const res = editing ? await meetingsAPI.update(meeting.id, payload) : await meetingsAPI.create(payload);
            onSaved(res.data.data, res.data.message);
            onClose();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setSaving(false);
        }
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} wide
            title={editing ? 'Edit meeting' : 'Convene a meeting'}
            subtitle={editing && meeting.status === 'NOTICE_ISSUED'
                ? 'The notice has already gone out. Changing the date, time, place or agenda means a fresh notice must be issued.'
                : 'Members (or directors, for a board meeting) are listed on the register automatically.'}>
            <form onSubmit={submit} className="space-y-4">
                {error && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-3">{error}</div>}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                        <label className="label">Type of meeting *</label>
                        <select className="input" value={form.meeting_type || ''} onChange={set('meeting_type')} disabled={editing}>
                            <option value="AGM">Annual General Meeting (AGM)</option>
                            <option value="EGM">Extraordinary General Meeting (EGM)</option>
                            <option value="BOARD">Board meeting</option>
                        </select>
                    </div>
                    <div>
                        <label className="label">Title</label>
                        <input className="input" value={form.title || ''} onChange={set('title')} placeholder="Filled in automatically, e.g. 2nd Annual General Meeting" />
                    </div>
                    <div>
                        <label className="label">Date *</label>
                        <input type="date" className="input" value={form.meeting_date || ''} onChange={set('meeting_date')} required />
                        {form.meeting_date && form.meeting_date < new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10) ? (
                            <p className="text-xs text-purple-700 bg-purple-50 rounded px-2 py-1 mt-1">This date has passed — you are recording a meeting that already took place. You will enter the date its notice was given, who attended, the votes and the minutes.</p>
                        ) : earliest && <p className="text-xs text-gray-400 mt-1">{noticeDays} days' notice needed — issue today and the meeting can be on or after {formatDate(earliest)} (or record consent to short notice).</p>}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                        <div>
                            <label className="label">Starts *</label>
                            <input type="time" className="input" value={form.start_time || ''} onChange={set('start_time')} required />
                        </div>
                        <div>
                            <label className="label">Ends</label>
                            <input type="time" className="input" value={form.end_time || ''} onChange={set('end_time')} />
                        </div>
                    </div>
                    <div>
                        <label className="label">Held</label>
                        <select className="input" value={form.mode || 'PHYSICAL'} onChange={set('mode')}>
                            <option value="PHYSICAL">In person</option>
                            <option value="VIRTUAL">Online only</option>
                            <option value="HYBRID">In person and online</option>
                        </select>
                    </div>
                    <div>
                        <label className="label">{form.mode === 'VIRTUAL' ? 'Venue (optional)' : 'Venue *'}</label>
                        <input className="input" value={form.venue || ''} onChange={set('venue')} placeholder="e.g. Company boardroom, Plot 12 Kampala Road" />
                    </div>
                    {form.mode !== 'PHYSICAL' && (
                        <div className="sm:col-span-2">
                            <label className="label">Online link *</label>
                            <input className="input" value={form.virtual_link || ''} onChange={set('virtual_link')} placeholder="https://meet.google.com/…" />
                        </div>
                    )}
                    {form.meeting_type === 'AGM' && (
                        <div>
                            <label className="label">Financial year whose accounts are laid</label>
                            <input className="input" value={form.financial_year || ''} onChange={set('financial_year')} placeholder="e.g. 2025" />
                        </div>
                    )}
                    <div>
                        <label className="label">Chairperson</label>
                        <PersonSelect value={form.chairperson_user_id} people={people} onChange={v => setForm(f => ({ ...f, chairperson_user_id: v }))} />
                    </div>
                    <div>
                        <label className="label">Secretary (takes the minutes)</label>
                        <PersonSelect value={form.secretary_user_id} people={people} onChange={v => setForm(f => ({ ...f, secretary_user_id: v }))} />
                    </div>
                </div>

                <div>
                    <div className="flex items-center justify-between mb-2">
                        <label className="label mb-0">Agenda</label>
                        <button type="button" className="btn-secondary text-xs" onClick={() => setAgenda(a => [...a, { title: '', business: 'ORDINARY' }])}>
                            <PlusIcon className="h-4 w-4 inline mr-1" />Add item
                        </button>
                    </div>
                    {!editing && agenda.length === 0 && (
                        <p className="text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-2">
                            Leave empty to start with the standard agenda for this type of meeting (an AGM gets: opening, previous minutes,
                            financial statements, dividend, directors, auditors, any other business, closure). You can edit it afterwards.
                        </p>
                    )}
                    <div className="space-y-2">
                        {agenda.map((a, i) => (
                            <div key={i} className="flex gap-2 items-start">
                                <span className="text-sm text-gray-400 w-6 pt-2 text-right">{i + 1}.</span>
                                <div className="flex-1 grid grid-cols-1 sm:grid-cols-[1fr_150px] gap-2">
                                    <input className="input" value={a.title} placeholder="Item"
                                        onChange={e => setAgenda(list => list.map((x, k) => (k === i ? { ...x, title: e.target.value } : x)))} />
                                    <select className="input" value={a.business || 'ROUTINE'}
                                        onChange={e => setAgenda(list => list.map((x, k) => (k === i ? { ...x, business: e.target.value } : x)))}>
                                        {BUSINESS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                                    </select>
                                </div>
                                <div className="flex flex-col">
                                    <button type="button" aria-label="Move up" className="p-1 text-gray-400 hover:text-gray-700" onClick={() => moveItem(i, -1)}><ArrowUpIcon className="h-4 w-4" /></button>
                                    <button type="button" aria-label="Move down" className="p-1 text-gray-400 hover:text-gray-700" onClick={() => moveItem(i, 1)}><ArrowDownIcon className="h-4 w-4" /></button>
                                </div>
                                <button type="button" aria-label="Remove" className="p-2 text-gray-400 hover:text-red-600" onClick={() => setAgenda(list => list.filter((_, k) => k !== i))}>
                                    <TrashIcon className="h-4 w-4" />
                                </button>
                            </div>
                        ))}
                    </div>
                    <p className="text-xs text-gray-400 mt-2">Special business (for example a change of name or of the Articles) needs a special resolution and the longer notice period.</p>
                </div>

                <div className="flex justify-end gap-3 pt-2">
                    <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
                    <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Saving…' : editing ? 'Save changes' : 'Create meeting'}</button>
                </div>
            </form>
        </Modal>
    );
};

// ============================================================
// RESOLUTION FORM
//   mode 'meeting' — for a meeting (kind chosen for general meetings)
//   mode 'written' — a written resolution circulated for signature
//   mode 'edit'    — change a pending resolution
// ============================================================
export const ResolutionFormModal = ({ isOpen, onClose, onSaved, mode = 'meeting', meeting = null, resolution = null }) => {
    const people = useDirectory();
    const [form, setForm] = useState({});
    const [clauses, setClauses] = useState(['']);
    const [error, setError] = useState(null);
    const [saving, setSaving] = useState(false);
    const board = meeting && meeting.meeting_type === 'BOARD';

    useEffect(() => {
        if (!isOpen) return;
        setError(null);
        if (resolution) {
            setForm({
                title: resolution.title, preamble: resolution.preamble || '', agenda_no: resolution.agenda_no || '',
                proposed_by_user_id: resolution.proposed_by_user_id, seconded_by_user_id: resolution.seconded_by_user_id,
                treated_as_special: !!resolution.treated_as_special, kind: resolution.kind,
            });
            setClauses(resolution.clauses && resolution.clauses.length ? [...resolution.clauses] : ['']);
        } else {
            setForm({ kind: mode === 'written' ? 'WRITTEN_MEMBERS' : (board ? 'BOARD' : 'ORDINARY'), title: '', preamble: '', agenda_no: '' });
            setClauses(['']);
        }
    }, [isOpen, resolution, mode, board]);

    const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));

    const submit = async (e) => {
        e.preventDefault();
        setError(null);
        setSaving(true);
        const payload = {
            title: form.title,
            preamble: form.preamble || null,
            clauses: clauses.map(c => c.trim()).filter(Boolean),
        };
        try {
            let res;
            if (mode === 'written') {
                res = await meetingsAPI.createWritten({ ...payload, kind: form.kind, treated_as_special: form.kind === 'WRITTEN_MEMBERS' && !!form.treated_as_special });
            } else {
                payload.agenda_no = form.agenda_no ? Number(form.agenda_no) : null;
                payload.proposed_by_user_id = form.proposed_by_user_id || null;
                payload.seconded_by_user_id = form.seconded_by_user_id || null;
                if (mode === 'edit') {
                    if (resolution.kind === 'WRITTEN_MEMBERS') payload.treated_as_special = !!form.treated_as_special;
                    res = await meetingsAPI.updateResolution(resolution.id, payload);
                } else {
                    res = await meetingsAPI.addResolution(meeting.id, { ...payload, kind: form.kind });
                }
            }
            onSaved(res.data.data, res.data.message);
            onClose();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setSaving(false);
        }
    };

    const isWritten = mode === 'written' || (resolution && !resolution.meeting_id);
    return (
        <Modal isOpen={isOpen} onClose={onClose} wide
            title={mode === 'edit' ? `Edit ${resolution?.resolution_number}` : mode === 'written' ? 'Written resolution' : 'Propose a resolution'}
            subtitle={isWritten
                ? 'Circulated to every member (or every director) for a digital signature. It is passed only if everyone agrees.'
                : 'Voted on a show of hands at the meeting. Write each operative part as a clause beginning "THAT …".'}>
            <form onSubmit={submit} className="space-y-4">
                {error && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-3">{error}</div>}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {mode === 'meeting' && !board && (
                        <div>
                            <label className="label">Kind *</label>
                            <select className="input" value={form.kind} onChange={set('kind')}>
                                <option value="ORDINARY">Ordinary resolution (more for than against)</option>
                                <option value="SPECIAL">Special resolution (at least 75% of votes cast)</option>
                            </select>
                        </div>
                    )}
                    {mode === 'written' && (
                        <div>
                            <label className="label">Signed by *</label>
                            <select className="input" value={form.kind} onChange={set('kind')}>
                                <option value="WRITTEN_MEMBERS">All the members (shareholders)</option>
                                <option value="WRITTEN_BOARD">All the directors</option>
                            </select>
                        </div>
                    )}
                    {(form.kind === 'WRITTEN_MEMBERS') && (
                        <label className="flex items-start gap-2 text-sm text-gray-700 sm:col-span-2">
                            <input type="checkbox" className="mt-1" checked={!!form.treated_as_special}
                                onChange={e => setForm(f => ({ ...f, treated_as_special: e.target.checked }))} />
                            <span>In place of a <strong>special resolution</strong> — it will then have to be filed with URSB within the filing period.</span>
                        </label>
                    )}
                    <div className="sm:col-span-2">
                        <label className="label">Title *</label>
                        <input className="input" value={form.title || ''} onChange={set('title')} required placeholder="e.g. Adoption of the 2025 financial statements" />
                    </div>
                    <div className="sm:col-span-2">
                        <label className="label">Background (optional)</label>
                        <textarea className="input" rows={2} value={form.preamble || ''} onChange={set('preamble')} placeholder="WHEREAS … (printed above the resolution)" />
                    </div>
                </div>
                <div>
                    <div className="flex items-center justify-between mb-2">
                        <label className="label mb-0">It is resolved *</label>
                        <button type="button" className="btn-secondary text-xs" onClick={() => setClauses(c => [...c, ''])}>
                            <PlusIcon className="h-4 w-4 inline mr-1" />Add clause
                        </button>
                    </div>
                    <div className="space-y-2">
                        {clauses.map((c, i) => (
                            <div key={i} className="flex gap-2 items-start">
                                <span className="text-sm text-gray-400 w-6 pt-2 text-right">{i + 1}.</span>
                                <textarea className="input flex-1" rows={2} value={c} placeholder="THAT the Company …"
                                    onChange={e => setClauses(list => list.map((x, k) => (k === i ? e.target.value : x)))} />
                                {clauses.length > 1 && (
                                    <button type="button" aria-label="Remove clause" className="p-2 text-gray-400 hover:text-red-600" onClick={() => setClauses(list => list.filter((_, k) => k !== i))}>
                                        <TrashIcon className="h-4 w-4" />
                                    </button>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
                {!isWritten && (
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div>
                            <label className="label">Agenda item</label>
                            <select className="input" value={form.agenda_no || ''} onChange={set('agenda_no')}>
                                <option value="">—</option>
                                {((meeting && meeting.agenda) || []).map(a => <option key={a.no} value={a.no}>{a.no}. {a.title}</option>)}
                            </select>
                        </div>
                        <div>
                            <label className="label">Proposed by</label>
                            <PersonSelect value={form.proposed_by_user_id} people={people} onChange={v => setForm(f => ({ ...f, proposed_by_user_id: v }))} placeholder="—" />
                        </div>
                        <div>
                            <label className="label">Seconded by</label>
                            <PersonSelect value={form.seconded_by_user_id} people={people} onChange={v => setForm(f => ({ ...f, seconded_by_user_id: v }))} placeholder="—" />
                        </div>
                    </div>
                )}
                <div className="flex justify-end gap-3 pt-2">
                    <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
                    <button type="submit" className="btn-primary" disabled={saving}>
                        {saving ? 'Saving…' : mode === 'written' ? 'Circulate for signature' : mode === 'edit' ? 'Save' : 'Add resolution'}
                    </button>
                </div>
            </form>
        </Modal>
    );
};

// ============================================================
// STATUTORY DOCUMENT BUTTONS
// Preview → the server assembles the content from the records, the
// browser renders it (nothing saved). Save → the same, stored in
// Documents as a draft that then collects its signatures.
// ============================================================
// v1.80.0 — `signers`: who signs the document, each pre-set to the
// meeting's chairperson / secretary and changeable here
//   [{ key: 'chairperson' | 'secretary' | 'director', label, defaultId }]
// `defaultDate`: the date the document carries ("Dated this … day of …"),
// changeable here (e.g. minutes signed at the next meeting).
export const StatutoryDocButtons = ({
    docKind, label, description, params, canSave, disabledReason = null, extra = null,
    signers = [], defaultDate = null,
}) => {
    const people = useDirectory();
    const [busy, setBusy] = useState(null);
    const [preview, setPreview] = useState(null);
    const [message, setMessage] = useState(null);
    const [error, setError] = useState(null);
    const [who, setWho] = useState(() => Object.fromEntries(signers.map(s => [s.key, s.defaultId || null])));
    const [date, setDate] = useState(defaultDate || '');
    const missing = signers.filter(s => s.required && !who[s.key]);

    const run = async (save) => {
        setBusy(save ? 'save' : 'preview');
        setError(null);
        setMessage(null);
        try {
            const chosen = Object.fromEntries(Object.entries(who).filter(([, v]) => v).map(([k, v]) => [`${k}_user_id`, v]));
            const res = await meetingsAPI.document({
                doc_kind: docKind, ...params, ...chosen, document_date: date || undefined, preview: !save,
            });
            const data = res.data.data.template_data;
            if (save) setMessage(res.data.message);
            else setPreview({ html: renderGovernanceDocument(data), title: label });
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setBusy(null);
        }
    };
    const blocked = disabledReason || (missing.length ? `Choose the ${missing.map(m => m.label.toLowerCase()).join(' and ')}.` : null);

    return (
        <div className="border border-gray-200 rounded-lg p-3 sm:p-4">
            <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-900">{label}</p>
                    {description && <p className="text-xs text-gray-500 mt-0.5">{description}</p>}
                </div>
                <div className="flex gap-2 flex-wrap">
                    <button type="button" className="btn-secondary text-sm" onClick={() => run(false)} disabled={!!busy || !!blocked}>
                        <EyeIcon className="h-4 w-4 inline mr-1" />{busy === 'preview' ? 'Preparing…' : 'Preview'}
                    </button>
                    {canSave && (
                        <button type="button" className="btn-primary text-sm" onClick={() => run(true)} disabled={!!busy || !!blocked}>
                            <DocumentArrowDownIcon className="h-4 w-4 inline mr-1" />{busy === 'save' ? 'Saving…' : 'Save to Documents'}
                        </button>
                    )}
                </div>
            </div>
            {canSave && !disabledReason && (signers.length > 0 || defaultDate) && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-3">
                    {signers.map(sg => (
                        <div key={sg.key}>
                            <label className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{sg.label} (signs)</label>
                            <PersonSelect value={who[sg.key]} people={people} placeholder={sg.required ? 'Choose…' : '—'}
                                className="input text-sm" onChange={v => setWho(w => ({ ...w, [sg.key]: v }))} />
                        </div>
                    ))}
                    {defaultDate && (
                        <div>
                            <label className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Dated</label>
                            <input type="date" className="input text-sm" value={date} onChange={e => setDate(e.target.value)} />
                        </div>
                    )}
                </div>
            )}
            {extra}
            {blocked && <p className="text-xs text-gray-400 mt-2">{blocked}</p>}
            {message && <p className="text-xs text-green-700 bg-green-50 rounded px-2 py-1.5 mt-2">{message} <Link to="/documents" className="underline">Open Documents</Link></p>}
            {error && <p className="text-xs text-red-700 bg-red-50 rounded px-2 py-1.5 mt-2">{error}</p>}
            <DocumentPreviewModal preview={preview} onClose={() => setPreview(null)} />
        </div>
    );
};

// ============================================================
// GOVERNANCE SETTINGS — Settings › Governance and Meetings › Rules
// ============================================================
const LEGAL_FIELDS = [
    ['agm', 'Annual general meeting'], ['notice', 'Notice of meetings'], ['quorum', 'Quorum'],
    ['proxy', 'Proxies'], ['special_resolution', 'Special resolutions'], ['filing', 'Filing resolutions with the Registrar'],
    ['minutes', 'Minutes'], ['annual_return', 'Annual return'], ['register_of_members', 'Register of members'],
];

export const GovernanceSettingsPanel = ({ canEdit }) => {
    const [s, setS] = useState(null);
    const [co, setCo] = useState(null);
    const [error, setError] = useState(null);
    const [message, setMessage] = useState(null);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        meetingsAPI.getSettings().then(r => setS(r.data.data)).catch(err => setError(getErrorMessage(err)));
        settingsAPI.getStatutory().then(r => setCo(r.data.data)).catch(() => {});
    }, []);

    if (!s) return <div className="card"><p className="text-sm text-gray-400">{error || 'Loading…'}</p></div>;

    const num = (k) => (e) => setS(x => ({ ...x, [k]: e.target.value }));
    const save = async () => {
        setSaving(true);
        setError(null);
        setMessage(null);
        try {
            const payload = {
                agm_notice_days: Number(s.agm_notice_days), special_resolution_notice_days: Number(s.special_resolution_notice_days),
                general_meeting_notice_days: Number(s.general_meeting_notice_days), board_meeting_notice_days: Number(s.board_meeting_notice_days),
                member_quorum: Number(s.member_quorum), board_quorum: Number(s.board_quorum),
                special_resolution_majority_pct: Number(s.special_resolution_majority_pct), short_notice_consent_pct: Number(s.short_notice_consent_pct),
                resolution_filing_days: Number(s.resolution_filing_days), agm_max_interval_months: Number(s.agm_max_interval_months),
                proxy_votes_on_show_of_hands: !!s.proxy_votes_on_show_of_hands,
                act_name: s.act_name, company_type: s.company_type, articles_note: s.articles_note || null,
                legal_references: s.legal_references,
            };
            const r = await meetingsAPI.updateSettings(payload);
            setS(r.data.data);
            if (co) {
                const c = await settingsAPI.updateStatutory({
                    registered_office: co.registered_office || null, postal_address: co.postal_address || null,
                    company_email: co.company_email || null, company_phone: co.company_phone || null,
                });
                setCo(c.data.data);
            }
            setMessage('Saved. New documents will use these values.');
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setSaving(false);
        }
    };

    // A plain function (not a component) so the inputs keep focus while typing.
    const numField = (k, label, suffix) => (
        <div key={k}>
            <label className="label">{label}</label>
            <div className="flex items-center gap-2">
                <input type="number" className="input" value={s[k] ?? ''} onChange={num(k)} disabled={!canEdit} />
                {suffix && <span className="text-sm text-gray-500 whitespace-nowrap">{suffix}</span>}
            </div>
        </div>
    );

    return (
        <div className="space-y-6">
            <div className="card">
                <h3 className="section-title mb-1">Meeting rules</h3>
                <p className="text-sm text-gray-500 mb-4">
                    Defaults follow Table A of the Companies Act, 2012. If your company's Articles of Association say something
                    different, change the numbers here — every meeting, check and document uses them.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                    {numField('agm_notice_days', 'Notice — AGM', 'days')}
                    {numField('general_meeting_notice_days', 'Notice — other general meeting', 'days')}
                    {numField('special_resolution_notice_days', 'Notice — special resolution', 'days')}
                    {numField('board_meeting_notice_days', 'Notice — board meeting', 'days')}
                    {numField('member_quorum', 'Quorum — general meeting', 'members')}
                    {numField('board_quorum', 'Quorum — board meeting', 'directors')}
                    {numField('special_resolution_majority_pct', 'Special resolution majority', '% of votes cast')}
                    {numField('short_notice_consent_pct', 'Consent to short notice', '% of voting rights')}
                    {numField('resolution_filing_days', 'File special resolutions within', 'days')}
                    {numField('agm_max_interval_months', 'Longest gap between AGMs', 'months')}
                </div>
                <label className="flex items-start gap-2 text-sm text-gray-700 mt-4">
                    <input type="checkbox" className="mt-1" checked={!!s.proxy_votes_on_show_of_hands} disabled={!canEdit}
                        onChange={e => setS(x => ({ ...x, proxy_votes_on_show_of_hands: e.target.checked }))} />
                    <span>Proxies may vote on a show of hands (Table A: they may not — only on a poll).</span>
                </label>
            </div>

            <div className="card">
                <h3 className="section-title mb-1">Legal references printed on the documents</h3>
                <p className="text-sm text-gray-500 mb-4">
                    The section numbers of the {s.act_name}. The revised edition of the Laws of Uganda (2023, Cap. 106) renumbers the
                    sections — ask the company secretary or your lawyer to confirm the numbers for the edition you use. Leave a box empty to
                    print no reference for that rule.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                    <div>
                        <label className="label">Name of the Act</label>
                        <input className="input" value={s.act_name || ''} disabled={!canEdit} onChange={e => setS(x => ({ ...x, act_name: e.target.value }))} />
                    </div>
                    <div>
                        <label className="label">Type of company (heading of resolutions)</label>
                        <input className="input" value={s.company_type || ''} disabled={!canEdit} onChange={e => setS(x => ({ ...x, company_type: e.target.value }))} />
                    </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    {LEGAL_FIELDS.map(([k, label]) => (
                        <div key={k}>
                            <label className="label">{label}</label>
                            <input className="input" value={(s.legal_references || {})[k] || ''} disabled={!canEdit}
                                onChange={e => setS(x => ({ ...x, legal_references: { ...(x.legal_references || {}), [k]: e.target.value } }))} />
                        </div>
                    ))}
                </div>
                <div className="mt-4">
                    <label className="label">Notes on your Articles (optional)</label>
                    <textarea className="input" rows={2} value={s.articles_note || ''} disabled={!canEdit}
                        onChange={e => setS(x => ({ ...x, articles_note: e.target.value }))}
                        placeholder="e.g. Our Articles adopt Table A without changes (Articles dated …)" />
                </div>
            </div>

            {co && (
                <div className="card">
                    <h3 className="section-title mb-1">Company details on every document</h3>
                    <p className="text-sm text-gray-500 mb-4">
                        Printed under the company name on the letterhead of every generated document. The registration number and TIN
                        are edited on the <Link to="/tax" className="text-primary-700 underline">Tax page</Link> (or Settings › Registration &amp; Tax).
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                            <label className="label">Registration number (URSB)</label>
                            <input className="input" value={co.registration_number || ''} disabled />
                        </div>
                        <div>
                            <label className="label">TIN</label>
                            <input className="input" value={co.tin || ''} disabled />
                        </div>
                        <div className="sm:col-span-2">
                            <label className="label">Registered office</label>
                            <input className="input" value={co.registered_office || ''} disabled={!canEdit}
                                onChange={e => setCo(x => ({ ...x, registered_office: e.target.value }))} placeholder="Plot, street, town" />
                        </div>
                        <div>
                            <label className="label">Postal address</label>
                            <input className="input" value={co.postal_address || ''} disabled={!canEdit}
                                onChange={e => setCo(x => ({ ...x, postal_address: e.target.value }))} placeholder="P.O. Box …" />
                        </div>
                        <div>
                            <label className="label">Phone</label>
                            <input className="input" value={co.company_phone || ''} disabled={!canEdit}
                                onChange={e => setCo(x => ({ ...x, company_phone: e.target.value }))} />
                        </div>
                        <div>
                            <label className="label">Email</label>
                            <input className="input" value={co.company_email || ''} disabled={!canEdit}
                                onChange={e => setCo(x => ({ ...x, company_email: e.target.value }))} />
                        </div>
                    </div>
                </div>
            )}

            {error && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-3">{error}</div>}
            {message && <div className="bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg p-3">{message}</div>}
            {canEdit ? (
                <div className="flex justify-end">
                    <button type="button" className="btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save governance settings'}</button>
                </div>
            ) : (
                <p className="text-xs text-gray-400">Only an Admin or the Company Secretary can change these.</p>
            )}
        </div>
    );
};
