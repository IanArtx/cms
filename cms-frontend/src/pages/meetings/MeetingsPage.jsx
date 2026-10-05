// ============================================================
// MEETINGS PAGE (v1.79.0) — /meetings
// The company's statutory meetings and resolutions in one place.
//   Meetings     — every AGM, EGM and board meeting, newest first
//   Resolutions  — the register of resolutions (all kinds), with the
//                  URSB filing position of each special resolution
//   Rules        — notice periods, quorum, majorities, legal
//                  references and the company details printed on the
//                  documents (Settings › Governance shows the same)
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { meetingsAPI } from '../../api/endpoints';
import { useAuth } from '../../contexts/AuthContext';
import { formatDate, getErrorMessage } from '../../utils/helpers';
import { useTabParam } from '../../hooks/useTabParam';
import useNewParam from '../../hooks/useNewParam';
import PageHeader from '../../components/common/PageHeader';
import DataTable from '../../components/common/DataTable';
import ErrorMessage from '../../components/common/ErrorMessage';
import {
    MeetingStatus, ResultBadge, FilingBadge, MeetingFormModal, ResolutionFormModal, GovernanceSettingsPanel,
    MEETING_TYPE_SHORT, KIND_LABEL, hhmm,
} from './meetingUi';
import { MeetingActionsCard } from './MeetingActionsCard';

const MeetingsList = ({ canManage, settings, showNew, setShowNew }) => {
    const navigate = useNavigate();
    const [rows, setRows] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [type, setType] = useState('');
    const load = useCallback(async () => {
        setLoading(true);
        try {
            const r = await meetingsAPI.getAll(type ? { type } : {});
            setRows(r.data.data.meetings || []);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, [type]);
    useEffect(() => { load(); }, [load]);

    const columns = [
        { header: 'Reference', render: m => <span className="font-mono text-xs font-medium text-primary-700">{m.reference_code}</span> },
        {
            header: 'Meeting',
            render: m => (
                <div>
                    <Link to={`/meetings/${m.id}`} className="text-sm font-medium text-primary-700 hover:underline">{m.title}</Link>
                    <p className="text-xs text-gray-400">{MEETING_TYPE_SHORT[m.meeting_type]}{m.financial_year ? ` · accounts for ${m.financial_year}` : ''}{m.has_special_business ? ' · special business' : ''}</p>
                </div>
            ),
        },
        { header: 'Date', render: m => <span className="text-sm">{formatDate(m.meeting_date)} <span className="text-gray-400">{hhmm(m.start_time)}</span></span> },
        { header: 'Where', render: m => <span className="text-sm text-gray-600">{m.mode === 'VIRTUAL' ? 'Online' : (m.venue || '—')}{m.mode === 'HYBRID' ? ' + online' : ''}</span> },
        { header: 'Attendance', render: m => <span className="text-sm text-gray-600">{m.status === 'DRAFT' ? '—' : `${m.present_count} of ${m.entitled_count}`}</span> },
        { header: 'Resolutions', render: m => <span className="text-sm text-gray-600">{m.resolution_count || '—'}</span> },
        { header: 'Status', render: m => <MeetingStatus status={m.status} /> },
    ];

    return (
        <div>
            {error && <div className="mb-4"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}
            <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
                <div className="flex gap-2 flex-wrap">
                    {[['', 'All'], ['AGM', 'AGM'], ['EGM', 'EGM'], ['BOARD', 'Board']].map(([v, l]) => (
                        <button key={v} type="button" onClick={() => setType(v)}
                            className={`px-3 py-1.5 rounded-full text-sm border ${type === v ? 'bg-primary-600 text-white border-primary-600' : 'bg-white text-gray-600 border-gray-200 hover:border-primary-300'}`}>
                            {l}
                        </button>
                    ))}
                </div>
            </div>
            <DataTable
                columns={columns}
                data={rows}
                loading={loading}
                emptyMessage={canManage ? 'No meetings yet — press "Convene a meeting" to call the first one.' : 'No meetings you can see yet.'}
                searchable
                searchPlaceholder="Search meetings…"
            />
            <MeetingFormModal
                isOpen={!!showNew}
                onClose={() => setShowNew(false)}
                settings={settings}
                onSaved={(m) => navigate(`/meetings/${m.id}`)}
            />
        </div>
    );
};

const ResolutionsRegister = ({ canManage }) => {
    const navigate = useNavigate();
    const [rows, setRows] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [filter, setFilter] = useState({ kind: '', result: '', filing: '' });
    const [showWritten, setShowWritten] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const params = Object.fromEntries(Object.entries(filter).filter(([, v]) => v));
            const r = await meetingsAPI.getResolutions(params);
            setRows(r.data.data.resolutions || []);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, [filter]);
    useEffect(() => { load(); }, [load]);

    const columns = [
        { header: 'No.', render: r => <span className="font-mono text-xs font-semibold text-primary-700 whitespace-nowrap">{r.resolution_number}</span> },
        {
            header: 'Resolution',
            render: r => (
                <div>
                    <Link to={`/meetings/resolutions/${r.id}`} className="text-sm font-medium text-primary-700 hover:underline">{r.title}</Link>
                    <p className="text-xs text-gray-400">
                        {KIND_LABEL[r.kind]}{r.treated_as_special ? ' (in place of special)' : ''}
                        {r.meeting_title ? ` · ${r.meeting_title}` : (r.signatories_total ? ` · ${r.signatories_signed} of ${r.signatories_total} signed` : '')}
                    </p>
                </div>
            ),
        },
        { header: 'Passed', render: r => <span className="text-sm">{r.passed_on ? formatDate(r.passed_on) : '—'}</span> },
        { header: 'Votes', render: r => <span className="text-xs text-gray-500">{r.votes_for != null ? `${r.votes_for} for · ${r.votes_against} against` : '—'}</span> },
        { header: 'Result', render: r => <ResultBadge result={r.result} /> },
        { header: 'URSB filing', render: r => (r.filing_state ? <FilingBadge state={r.filing_state} due={r.filing_due_date} /> : <span className="text-xs text-gray-300">Not required</span>) },
    ];

    const sel = (k, opts) => (
        <select className="input w-auto text-sm" value={filter[k]} onChange={e => setFilter(f => ({ ...f, [k]: e.target.value }))}>
            {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
    );

    return (
        <div>
            {error && <div className="mb-4"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}
            <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
                <div className="flex gap-2 flex-wrap">
                    {sel('kind', [['', 'All kinds'], ['ORDINARY', 'Ordinary'], ['SPECIAL', 'Special'], ['BOARD', 'Board'], ['WRITTEN_MEMBERS', 'Written (members)'], ['WRITTEN_BOARD', 'Written (directors)']])}
                    {sel('result', [['', 'Any result'], ['PENDING', 'Pending'], ['CARRIED', 'Carried'], ['LOST', 'Lost'], ['WITHDRAWN', 'Withdrawn']])}
                    {sel('filing', [['', 'Any filing'], ['due', 'To file with URSB'], ['overdue', 'Filing overdue'], ['filed', 'Filed']])}
                </div>
                {canManage && (
                    <button type="button" className="btn-secondary text-sm" onClick={() => setShowWritten(true)}>New written resolution</button>
                )}
            </div>
            <DataTable
                columns={columns}
                data={rows}
                loading={loading}
                emptyMessage="No resolutions match."
                searchable
                searchPlaceholder="Search resolutions…"
            />
            <ResolutionFormModal
                isOpen={showWritten}
                mode="written"
                onClose={() => setShowWritten(false)}
                onSaved={(r) => navigate(`/meetings/resolutions/${r.id}`)}
            />
        </div>
    );
};

const MeetingsPage = () => {
    const { hasRole, hasPermission } = useAuth();
    const [activeTab, setActiveTab] = useTabParam('meetings');
    const [settings, setSettings] = useState(null);
    const canManage = hasPermission('MEETING_MANAGE') || hasRole(['Admin', 'Secretary', 'Assistant Secretary', 'Director']);
    const canEditRules = hasRole(['Admin', 'Secretary']);
    const [showNew, setShowNew] = useState(false);
    // "+ New" menu → /meetings?new=1
    useNewParam(() => { if (canManage) { setActiveTab('meetings'); setShowNew(true); } });

    useEffect(() => {
        meetingsAPI.getSettings().then(r => setSettings(r.data.data)).catch(() => {});
    }, []);

    const tabs = [
        { key: 'meetings', label: 'Meetings' },
        { key: 'resolutions', label: 'Register of resolutions' },
        { key: 'rules', label: 'Rules & company details' },
    ];

    return (
        <div>
            <PageHeader
                title="Meetings & resolutions"
                subtitle="AGMs, EGMs and board meetings — notice, register of attendance, minutes and resolutions in the standard form for filing"
                actions={canManage ? (
                    <button type="button" className="btn-primary" onClick={() => { setActiveTab('meetings'); setShowNew(true); }}>Convene a meeting</button>
                ) : null}
            />
            <MeetingActionsCard compact />
            <div className="tab-bar mb-6" role="tablist">
                {tabs.map(t => (
                    <button key={t.key} type="button" role="tab" aria-selected={activeTab === t.key} onClick={() => setActiveTab(t.key)} className={`tab ${activeTab === t.key ? 'tab-active' : ''}`}>
                        {t.label}
                    </button>
                ))}
            </div>
            {activeTab === 'meetings' && <MeetingsList canManage={canManage} settings={settings} showNew={showNew} setShowNew={setShowNew} />}
            {activeTab === 'resolutions' && <ResolutionsRegister canManage={canManage} />}
            {activeTab === 'rules' && <GovernanceSettingsPanel canEdit={canEditRules} />}
            {activeTab === 'meetings' && settings && (
                <p className="text-xs text-gray-400 mt-6">
                    Current rules: AGM notice {settings.agm_notice_days} days · other general meetings {settings.general_meeting_notice_days} days ·
                    board {settings.board_meeting_notice_days} days · quorum {settings.member_quorum} members / {settings.board_quorum} directors ·
                    special resolution {settings.special_resolution_majority_pct}% · file with URSB within {settings.resolution_filing_days} days.{' '}
                    <Link to="/meetings?tab=rules" className="underline">Change</Link>
                </p>
            )}
        </div>
    );
};

export default MeetingsPage;
