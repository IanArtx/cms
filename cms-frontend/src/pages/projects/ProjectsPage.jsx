// ============================================================
// PROJECTS (v1.85.0) — Investments › Projects
// Requested: "there is no way to enter project under investments or at
// all in any forms" and "Projects can stand independently or with in or
// added later to an investment".
// Every project: on its own or inside an investment, with its budget,
// spending, milestones and documents. "New project" creates either kind.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { projectsAPI } from '../../api/endpoints';
import { formatDate, getErrorMessage } from '../../utils/helpers';
import PageHeader from '../../components/common/PageHeader';
import ErrorMessage from '../../components/common/ErrorMessage';
import StatusBadge from '../../components/common/StatusBadge';
import { useAuth } from '../../contexts/AuthContext';
import ProjectFormModal from './ProjectForm';
import { PlusIcon, ExclamationTriangleIcon, PaperClipIcon } from '@heroicons/react/24/outline';

const money = (v) => parseFloat(v || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });

export const SpendBar = ({ spent, budget }) => {
    const b = parseFloat(budget || 0);
    const s = parseFloat(spent || 0);
    const pct = b > 0 ? Math.min(100, (s / b) * 100) : 0;
    return (
        <div className="h-2 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
            <div className={`h-full ${s > b ? 'bg-red-500' : 'bg-primary-600'}`} style={{ width: `${pct}%` }} />
        </div>
    );
};

const FILTERS = [
    ['', 'All'], ['standalone', 'On their own'], ['inside', 'Inside an investment'],
];

const ProjectsPage = () => {
    const { hasPermission } = useAuth();
    const canManage = hasPermission('INVESTMENT_MANAGE');
    const navigate = useNavigate();
    const [rows, setRows] = useState(null);
    const [error, setError] = useState(null);
    const [kind, setKind] = useState('');
    const [status, setStatus] = useState('');
    const [search, setSearch] = useState('');
    const [showNew, setShowNew] = useState(false);

    const load = useCallback(() => {
        const params = {};
        if (status) params.status = status;
        if (kind === 'standalone') params.standalone = 1;
        if (search.trim()) params.search = search.trim();
        projectsAPI.getAll(params)
            .then(r => {
                let list = r.data.data || [];
                if (kind === 'inside') list = list.filter(p => p.investment_id);
                setRows(list);
            })
            .catch(err => { setRows([]); setError(getErrorMessage(err)); });
    }, [kind, status, search]);
    useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);

    const open = (rows || []).filter(p => !['COMPLETED', 'CANCELLED'].includes(p.status));

    return (
        <div>
            <PageHeader
                title="Projects"
                subtitle="Projects on their own or inside an investment — budget, spending, milestones and documents"
                actions={canManage && (
                    <button type="button" className="btn-primary flex items-center gap-2" onClick={() => setShowNew(true)}>
                        <PlusIcon className="h-4 w-4" /> New project
                    </button>
                )}
            />
            {error && <div className="mb-4"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
                {[
                    ['Projects', rows ? rows.length : '…'],
                    ['Open', rows ? open.length : '…'],
                    ['On their own', rows ? rows.filter(p => !p.investment_id).length : '…'],
                    ['Inside an investment', rows ? rows.filter(p => p.investment_id).length : '…'],
                ].map(([l, v]) => (
                    <div key={l} className="card !p-4">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{l}</p>
                        <p className="text-2xl font-bold tabular-nums text-gray-900 dark:text-gray-100">{v}</p>
                    </div>
                ))}
            </div>

            <div className="flex flex-wrap items-center gap-2 mb-4">
                <div className="inline-flex rounded-lg border border-gray-200 dark:border-gray-700 p-0.5 text-sm" role="group">
                    {FILTERS.map(([v, l]) => (
                        <button key={v} type="button" onClick={() => setKind(v)} aria-pressed={kind === v}
                            className={`px-3 py-1 rounded-md ${kind === v ? 'bg-primary-600 text-white' : 'text-gray-600 dark:text-gray-300'}`}>{l}</button>
                    ))}
                </div>
                <select className="input !w-auto" value={status} onChange={e => setStatus(e.target.value)}>
                    <option value="">Any status</option>
                    {['PENDING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED'].map(s => <option key={s} value={s}>{s.replace('_', ' ').toLowerCase()}</option>)}
                </select>
                <input className="input !w-auto flex-1 min-w-[12rem]" placeholder="Search name or reference…" value={search} onChange={e => setSearch(e.target.value)} />
            </div>

            {!rows ? <div className="card"><p className="text-sm text-gray-400">Loading…</p></div>
                : rows.length === 0 ? (
                    <div className="card text-center py-10">
                        <p className="text-gray-500">No projects{status || kind || search ? ' match' : ' yet'}.</p>
                        {canManage && !status && !kind && !search && (
                            <button type="button" className="btn-primary mt-4 inline-flex items-center gap-2" onClick={() => setShowNew(true)}>
                                <PlusIcon className="h-4 w-4" /> Create the first project
                            </button>
                        )}
                    </div>
                ) : (
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                        {rows.map(p => (
                            <Link key={p.id} to={`/projects/${p.id}`} className="card hover:ring-2 hover:ring-primary-200 transition block">
                                <div className="flex items-start justify-between gap-3 mb-1">
                                    <div className="min-w-0">
                                        <p className="font-semibold text-gray-900 dark:text-gray-100 truncate">{p.name}</p>
                                        <p className="text-xs text-gray-400 font-mono">{p.reference_code}</p>
                                    </div>
                                    <StatusBadge status={p.status} />
                                </div>
                                <p className="text-xs text-gray-500 mb-3">
                                    {p.investment_id
                                        ? <>Inside <span className="font-medium text-gray-700 dark:text-gray-200">{p.investment_name}</span></>
                                        : <span className="text-sky-700 dark:text-sky-300">On its own</span>}
                                    {p.responsible_name ? ` · ${p.responsible_name}` : ''}
                                    {p.expected_end_date ? ` · ends ${formatDate(p.expected_end_date)}` : ''}
                                </p>
                                <SpendBar spent={p.spent} budget={p.planned_budget} />
                                <div className="flex flex-wrap justify-between gap-2 mt-1.5 text-xs text-gray-500">
                                    <span>{p.currency_code} {money(p.spent)} of {money(p.planned_budget)} spent</span>
                                    <span className="flex items-center gap-3">
                                        <span>{p.completed_milestones}/{p.total_milestones} milestones</span>
                                        <span className="flex items-center gap-1"><PaperClipIcon className="h-3.5 w-3.5" />{p.document_count}</span>
                                    </span>
                                </div>
                                {p.mismatch && (
                                    <p className="mt-2 text-xs text-red-700 flex items-center gap-1">
                                        <ExclamationTriangleIcon className="h-4 w-4" /> Spending total differs from its entries — open to check
                                    </p>
                                )}
                            </Link>
                        ))}
                    </div>
                )}

            <ProjectFormModal isOpen={showNew} onClose={() => setShowNew(false)}
                onSaved={(id) => { setShowNew(false); navigate(`/projects/${id}`); }} />
        </div>
    );
};

export default ProjectsPage;
