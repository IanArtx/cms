// ============================================================
// ONE PROJECT (v1.85.0) — /projects/:id
// Budget and spending, where its money comes from (on its own: Record
// spending = an expense; inside an investment: the investment's Fund),
// adding it to / taking it out of an investment, status, milestones,
// every money entry, and its documents (upload directly here).
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { projectsAPI, investmentsAPI, transactionsAPI, accountsAPI, categoriesAPI } from '../../api/endpoints';
import { formatDate, formatDateTime, getErrorMessage } from '../../utils/helpers';
import PageHeader from '../../components/common/PageHeader';
import ErrorMessage from '../../components/common/ErrorMessage';
import StatusBadge from '../../components/common/StatusBadge';
import { useAuth } from '../../contexts/AuthContext';
import RecordDocuments from '../../components/documents/RecordDocuments';
import ProjectFormModal from './ProjectForm';
import { SpendBar } from './ProjectsPage';
import {
    PencilIcon, ArrowPathIcon, LinkIcon, BanknotesIcon, ExclamationTriangleIcon, PlusIcon,
} from '@heroicons/react/24/outline';

const money = (v) => parseFloat(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const STATUS_LABEL = { PENDING: 'Pending', ACTIVE: 'Active', ON_HOLD: 'On hold', COMPLETED: 'Completed', CANCELLED: 'Cancelled' };
const today = () => new Date().toISOString().slice(0, 10);

// ---- small modal frame ----------------------------------------------
const Modal = ({ title, onClose, children, onSubmit }) => (
    <div className="fixed inset-0 z-50 overflow-y-auto">
        <div className="fixed inset-0 bg-black/40" onClick={onClose} />
        <div className="flex min-h-full items-center justify-center p-4">
            <form onSubmit={onSubmit} className="relative bg-white dark:bg-gray-900 rounded-xl shadow-xl max-w-md w-full p-6 space-y-4">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
                {children}
            </form>
        </div>
    </div>
);

// ---- change status ---------------------------------------------------
const StatusModal = ({ project, onClose, onDone }) => {
    const closed = ['COMPLETED', 'CANCELLED'].includes(project.status);
    const choices = Object.keys(STATUS_LABEL).filter(s => s !== project.status && (s !== 'PENDING' || closed));
    const [status, setStatus] = useState(choices[0]);
    const [note, setNote] = useState('');
    const [date, setDate] = useState(today());
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const needsNote = ['ON_HOLD', 'CANCELLED'].includes(status) || closed;
    const submit = async (e) => {
        e.preventDefault(); setBusy(true); setError(null);
        try {
            const r = await projectsAPI.setStatus(project.id, { status, note: note || undefined, date: status === 'COMPLETED' ? date : undefined });
            onDone(r.data.message);
        } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
    };
    return (
        <Modal title={`Status — ${project.name}`} onClose={onClose} onSubmit={submit}>
            {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
            <p className="text-sm text-gray-500">Now: <strong>{STATUS_LABEL[project.status]}</strong>{closed ? ' — choosing another status re-opens it.' : ''}</p>
            <div>
                <label className="label">New status *</label>
                <select className="input" value={status} onChange={e => setStatus(e.target.value)}>
                    {choices.map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                </select>
            </div>
            {status === 'COMPLETED' && (
                <div>
                    <label className="label">Completed on *</label>
                    <input type="date" className="input" max={today()} required value={date} onChange={e => setDate(e.target.value)} />
                </div>
            )}
            <div>
                <label className="label">Note {needsNote ? '*' : '(optional)'}</label>
                <textarea className="input" rows={2} required={needsNote} value={note} onChange={e => setNote(e.target.value)}
                    placeholder={status === 'CANCELLED' ? 'Why is it cancelled?' : status === 'ON_HOLD' ? 'Why is it on hold?' : ''} />
            </div>
            {['COMPLETED', 'CANCELLED'].includes(status) && (
                <p className="text-xs text-amber-700">No more money can be recorded for a completed or cancelled project until it is re-opened.</p>
            )}
            <div className="flex justify-end gap-2">
                <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
                <button type="submit" className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
            </div>
        </Modal>
    );
};

// ---- add to an investment / take out ---------------------------------
const LinkModal = ({ project, onClose, onDone }) => {
    const inside = !!project.investment_id;
    const [investments, setInvestments] = useState([]);
    const [investmentId, setInvestmentId] = useState('');
    const [reason, setReason] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    useEffect(() => {
        if (inside) return;
        investmentsAPI.getAll({ limit: 200 }).then(r => setInvestments((r.data.data || []).filter(i =>
            ['PENDING', 'ACTIVE', 'ON_HOLD', 'PENDING_TERMINATION'].includes(i.status) && i.investment_type !== 'MMF'
            && (!project.currency_code || i.currency_code === project.currency_code)))).catch(() => {});
    }, [inside, project.currency_code]);
    const submit = async (e) => {
        e.preventDefault(); setBusy(true); setError(null);
        try {
            const r = inside
                ? await projectsAPI.removeFromInvestment(project.id, reason)
                : await projectsAPI.addToInvestment(project.id, parseInt(investmentId, 10));
            onDone(r.data.message);
        } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
    };
    return (
        <Modal title={inside ? `Take out of ${project.investment_name}` : 'Add to an investment'} onClose={onClose} onSubmit={submit}>
            {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
            {inside ? (
                <>
                    <p className="text-sm text-gray-600 dark:text-gray-300">Only possible while no investment money has been recorded for the project. It becomes a project on its own again.</p>
                    <div>
                        <label className="label">Why? *</label>
                        <textarea className="input" rows={2} required value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Added to the wrong investment" />
                    </div>
                </>
            ) : (
                <>
                    <div>
                        <label className="label">Investment *</label>
                        <select className="input" required value={investmentId} onChange={e => setInvestmentId(e.target.value)}>
                            <option value="">Choose…</option>
                            {investments.map(i => <option key={i.id} value={i.id}>{i.name} ({i.reference_code})</option>)}
                        </select>
                        <p className="text-xs text-gray-500 mt-1">Only investments in {project.currency_code} are listed — the project and the investment must use the same currency.</p>
                    </div>
                    <div className="text-xs text-gray-600 dark:text-gray-300 bg-gray-50 dark:bg-gray-800 rounded-lg p-3 space-y-1">
                        <p><strong>What changes:</strong> from now on money for the project is recorded as funding of the investment (choose this project when funding) and counts in the investment's cost.</p>
                        <p><strong>What stays:</strong> {parseFloat(project.spent_as_expenses || 0) > 0
                            ? `the ${project.currency_code} ${money(project.spent_as_expenses)} already spent stays recorded as expenses — entries already in the books are never rewritten.`
                            : 'nothing has been spent yet.'}</p>
                    </div>
                </>
            )}
            <div className="flex justify-end gap-2">
                <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
                <button type="submit" className="btn-primary" disabled={busy}>{busy ? 'Saving…' : inside ? 'Take out' : 'Add to investment'}</button>
            </div>
        </Modal>
    );
};

// ---- record spending (a project on its own) --------------------------
const SpendModal = ({ project, onClose, onDone }) => {
    const [accounts, setAccounts] = useState([]);
    const [categories, setCategories] = useState([]);
    const [form, setForm] = useState({ account_id: '', amount: '', category_id: '', description: '', value_date: today() });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    useEffect(() => {
        accountsAPI.getAll().then(r => {
            const list = (r.data.data || []).filter(a => a.is_active !== false && a.currency_code === project.currency_code);
            setAccounts(list);
            if (list.length === 1) setForm(f => ({ ...f, account_id: String(list[0].id) }));
        }).catch(() => {});
        categoriesAPI.getAll({ flat: true }).then(r => setCategories((r.data.data || []).filter(c => c.module === 'FINANCE'))).catch(() => {});
    }, [project.currency_code]);
    const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));
    const submit = async (e) => {
        e.preventDefault(); setBusy(true); setError(null);
        try {
            const r = await transactionsAPI.recordExpense({ ...form, amount: parseFloat(form.amount), project_id: project.id });
            onDone(r.data.message);
        } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
    };
    return (
        <Modal title={`Record spending — ${project.name}`} onClose={onClose} onSubmit={submit}>
            {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
            <p className="text-xs text-gray-500">Recorded as an expense from the account, counted in this project's spending. (The same as Money › Transactions › Record Expense with this project chosen.)</p>
            <div>
                <label className="label">Paid from *</label>
                <select className="input" required value={form.account_id} onChange={set('account_id')}>
                    <option value="">Choose…</option>
                    {accounts.map(a => <option key={a.id} value={a.id}>{a.name} ({a.currency_code})</option>)}
                </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
                <div>
                    <label className="label">Amount ({project.currency_code}) *</label>
                    <input type="number" min="0.01" step="0.01" className="input" required value={form.amount} onChange={set('amount')} />
                </div>
                <div>
                    <label className="label">Date *</label>
                    <input type="date" className="input" max={today()} required value={form.value_date} onChange={set('value_date')} />
                </div>
            </div>
            <div>
                <label className="label">Category *</label>
                <select className="input" required value={form.category_id} onChange={set('category_id')}>
                    <option value="">Choose…</option>
                    {categories.map(c => <option key={c.id} value={c.id}>{c.full_path || c.name}</option>)}
                </select>
            </div>
            <div>
                <label className="label">Description *</label>
                <input className="input" required value={form.description} onChange={set('description')} placeholder="e.g. Drilling survey" />
            </div>
            <div className="flex justify-end gap-2">
                <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
                <button type="submit" className="btn-primary" disabled={busy}>{busy ? 'Recording…' : 'Record'}</button>
            </div>
        </Modal>
    );
};

// ---- milestones ------------------------------------------------------
const MILESTONE_STATUS = { PENDING: 'Pending', IN_PROGRESS: 'In progress', COMPLETED: 'Completed', MISSED: 'Missed' };
const Milestones = ({ project, canManage, onChanged }) => {
    const [form, setForm] = useState({ name: '', due_date: '', description: '' });
    const [adding, setAdding] = useState(false);
    const [error, setError] = useState(null);
    const closed = ['COMPLETED', 'CANCELLED'].includes(project.status);
    const add = async (e) => {
        e.preventDefault(); setError(null);
        try { await projectsAPI.addMilestone(project.id, form); setForm({ name: '', due_date: '', description: '' }); setAdding(false); onChanged(); }
        catch (err) { setError(getErrorMessage(err)); }
    };
    const change = async (m, status) => {
        setError(null);
        try { await projectsAPI.updateMilestone(project.id, m.id, { status }); onChanged(); }
        catch (err) { setError(getErrorMessage(err)); }
    };
    const ms = project.milestones || [];
    return (
        <div className="card">
            <div className="flex items-center justify-between mb-3">
                <h3 className="section-title mb-0">Milestones ({ms.filter(m => m.status === 'COMPLETED').length}/{ms.length})</h3>
                {canManage && !closed && (
                    <button type="button" className="btn-secondary text-sm flex items-center gap-1" onClick={() => setAdding(a => !a)}>
                        <PlusIcon className="h-4 w-4" /> Add
                    </button>
                )}
            </div>
            {error && <div className="mb-3"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}
            {adding && (
                <form onSubmit={add} className="mb-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <input className="input sm:col-span-2" required placeholder="Milestone" maxLength={200} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
                    <input type="date" className="input" required value={form.due_date} onChange={e => setForm(f => ({ ...f, due_date: e.target.value }))} />
                    <input className="input sm:col-span-2" placeholder="Details (optional)" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
                    <button type="submit" className="btn-primary text-sm">Add milestone</button>
                </form>
            )}
            {ms.length === 0 ? <p className="text-sm text-gray-400 text-center py-6">No milestones yet.</p> : (
                <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                    {ms.map(m => {
                        const late = m.status !== 'COMPLETED' && m.due_date < today();
                        return (
                            <li key={m.id} className="py-2.5 flex flex-wrap items-center justify-between gap-2">
                                <div className="min-w-0">
                                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{m.name}</p>
                                    <p className={`text-xs ${late ? 'text-red-600' : 'text-gray-400'}`}>
                                        Due {formatDate(m.due_date)}{late ? ' — overdue' : ''}{m.completed_at ? ` · done ${formatDate(m.completed_at)}` : ''}
                                        {m.description ? ` · ${m.description}` : ''}
                                    </p>
                                </div>
                                {canManage && !closed ? (
                                    <select className="input !w-40 !py-1 text-sm" value={m.status} onChange={e => change(m, e.target.value)}>
                                        {Object.entries(MILESTONE_STATUS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                                    </select>
                                ) : <StatusBadge status={m.status} />}
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
};

// ============================================================
const ProjectDetailPage = () => {
    const { id } = useParams();
    const { hasPermission, hasRole } = useAuth();
    const canManage = hasPermission('INVESTMENT_MANAGE');
    const canSpend = hasRole(['Treasurer', 'Assistant Treasurer', 'Admin']);
    const [p, setP] = useState(null);
    const [error, setError] = useState(null);
    const [msg, setMsg] = useState(null);
    const [modal, setModal] = useState(null); // edit | status | link | spend

    const load = useCallback(() => {
        projectsAPI.getById(id).then(r => setP(r.data.data)).catch(err => setError(getErrorMessage(err)));
    }, [id]);
    useEffect(() => { load(); }, [load]);
    const done = (m) => { setModal(null); setMsg(m); load(); };

    if (!p) {
        return (
            <div>
                <PageHeader title="Project" showBack backTo="/projects" />
                {error ? <ErrorMessage message={error} /> : <p className="text-sm text-gray-400">Loading…</p>}
            </div>
        );
    }
    const closed = ['COMPLETED', 'CANCELLED'].includes(p.status);
    const inside = !!p.investment_id;
    const cur = p.currency_code || '';
    const fundedByInvestment = (p.entries || []).some(e => e.kind === 'INVESTMENT_FUNDING' && !e.is_reversed);

    return (
        <div>
            <PageHeader
                title={p.name}
                subtitle={`${p.reference_code} · ${inside ? `inside ${p.investment_name}` : 'on its own'}`}
                showBack backTo="/projects"
                actions={canManage && (
                    <div className="flex flex-wrap gap-2">
                        <button type="button" className="btn-secondary flex items-center gap-1" onClick={() => setModal('edit')}><PencilIcon className="h-4 w-4" /> Edit</button>
                        <button type="button" className="btn-primary flex items-center gap-1" onClick={() => setModal('status')}><ArrowPathIcon className="h-4 w-4" /> Status</button>
                    </div>
                )}
            />
            {error && <div className="mb-4"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}
            {msg && <p className="mb-4 text-sm text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-900/20 rounded-lg px-3 py-2">{msg}</p>}
            {p.mismatch && (
                <p className="mb-4 text-sm text-red-700 bg-red-50 rounded-lg px-3 py-2 flex gap-2">
                    <ExclamationTriangleIcon className="h-5 w-5 flex-shrink-0" />
                    The spending total kept on the project ({cur} {money(p.actual_expenditure)}) differs from its money entries ({cur} {money(p.spent)}). The figures below use the entries. Please tell the administrator.
                </p>
            )}

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
                {[
                    ['Planned budget', `${cur} ${money(p.planned_budget)}`],
                    ['Spent', `${cur} ${money(p.spent)}`],
                    [p.remaining < 0 ? 'Over budget' : 'Remaining', `${cur} ${money(Math.abs(p.remaining))}`, p.remaining < 0 ? 'text-red-700' : ''],
                    ['Status', STATUS_LABEL[p.status]],
                ].map(([l, v, cls]) => (
                    <div key={l} className="card !p-4">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{l}</p>
                        <p className={`text-xl font-bold tabular-nums ${cls || 'text-gray-900 dark:text-gray-100'}`}>{v}</p>
                    </div>
                ))}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
                <div className="card space-y-3">
                    <h3 className="section-title mb-0">About</h3>
                    <SpendBar spent={p.spent} budget={p.planned_budget} />
                    {p.description && <p className="text-sm text-gray-700 dark:text-gray-200 whitespace-pre-line">{p.description}</p>}
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                        <dt className="text-gray-400">Investment</dt>
                        <dd>{inside ? <Link className="text-primary-700 hover:underline" to={`/investments/${p.investment_id}`}>{p.investment_name}</Link> : <span className="text-sky-700">On its own</span>}</dd>
                        {inside && p.linked_to_investment_at && (<><dt className="text-gray-400">Inside since</dt><dd>{formatDateTime(p.linked_to_investment_at)}{p.linked_by_name ? ` (${p.linked_by_name})` : ''}</dd></>)}
                        <dt className="text-gray-400">Currency</dt><dd>{cur}</dd>
                        <dt className="text-gray-400">Category</dt><dd>{p.category_trail || p.category_name || '—'}</dd>
                        <dt className="text-gray-400">Responsible</dt><dd>{p.responsible_name || '—'}</dd>
                        <dt className="text-gray-400">Start</dt><dd>{p.start_date ? formatDate(p.start_date) : '—'}</dd>
                        <dt className="text-gray-400">Expected end</dt><dd>{p.expected_end_date ? formatDate(p.expected_end_date) : '—'}</dd>
                        {p.actual_end_date && (<><dt className="text-gray-400">Completed</dt><dd>{formatDate(p.actual_end_date)}</dd></>)}
                        {p.status_note && (<><dt className="text-gray-400">Status note</dt><dd>{p.status_note}</dd></>)}
                        <dt className="text-gray-400">Created</dt><dd>{formatDate(p.created_at)}{p.created_by_name ? ` by ${p.created_by_name}` : ''}</dd>
                    </dl>
                    {inside && parseFloat(p.spent_as_expenses) > 0 && (
                        <p className="text-xs text-gray-500 bg-gray-50 dark:bg-gray-800 rounded-lg p-2">
                            {cur} {money(p.spent_as_expenses)} was spent while the project was on its own; it stays recorded as expenses and is not part of the investment's cost.
                        </p>
                    )}
                    {canManage && !closed && (!inside || !fundedByInvestment) && (
                        <button type="button" className="text-sm text-primary-700 hover:underline flex items-center gap-1" onClick={() => setModal('link')}>
                            <LinkIcon className="h-4 w-4" /> {inside ? 'Take out of the investment' : 'Add to an investment'}
                        </button>
                    )}
                </div>

                <div className="card space-y-3">
                    <div className="flex items-center justify-between">
                        <h3 className="section-title mb-0">Money for the project</h3>
                        {!closed && !inside && canSpend && (
                            <button type="button" className="btn-primary text-sm flex items-center gap-1" onClick={() => setModal('spend')}>
                                <BanknotesIcon className="h-4 w-4" /> Record spending
                            </button>
                        )}
                        {!closed && inside && (
                            <Link to={`/investments/${p.investment_id}`} className="btn-secondary text-sm">Fund via the investment</Link>
                        )}
                    </div>
                    <p className="text-xs text-gray-500">
                        {inside
                            ? 'Inside an investment: record money with the investment\'s Fund button and choose this project. It counts in the investment\'s cost.'
                            : 'On its own: each payment is an expense from an account in the project\'s currency (Record spending, or Record Expense with this project chosen).'}
                        {' '}A reversed entry is taken off the spending.
                    </p>
                    {(p.entries || []).length === 0 ? <p className="text-sm text-gray-400 text-center py-4">Nothing recorded yet.</p> : (
                        <div className="overflow-x-auto">
                            <table className="min-w-full text-sm">
                                <thead>
                                    <tr className="text-left text-xs uppercase text-gray-400 border-b border-gray-100 dark:border-gray-800">
                                        <th className="py-2 pr-3">Date</th><th className="py-2 pr-3">Reference</th><th className="py-2 pr-3">How</th><th className="py-2 text-right">Amount</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {p.entries.map(e => (
                                        <tr key={`${e.kind}-${e.transaction_id}`} className={`border-b border-gray-50 dark:border-gray-800 ${e.is_reversed ? 'opacity-50 line-through' : ''}`}>
                                            <td className="py-2 pr-3 whitespace-nowrap">{formatDate(e.value_date)}</td>
                                            <td className="py-2 pr-3 font-mono text-xs">{e.transaction_reference}</td>
                                            <td className="py-2 pr-3 text-xs">{e.kind === 'EXPENSE' ? 'Expense' : 'Investment funding'} · {e.account_name}{e.is_reversed ? ' · reversed' : ''}</td>
                                            <td className="py-2 text-right tabular-nums">{money(e.amount)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <Milestones project={p} canManage={canManage} onChanged={load} />
                <RecordDocuments recordType="projects" recordId={p.id} title="Project documents" />
            </div>

            <ProjectFormModal isOpen={modal === 'edit'} project={p} onClose={() => setModal(null)} onSaved={(_, m) => done(m)} />
            {modal === 'status' && <StatusModal project={p} onClose={() => setModal(null)} onDone={done} />}
            {modal === 'link' && <LinkModal project={p} onClose={() => setModal(null)} onDone={done} />}
            {modal === 'spend' && <SpendModal project={p} onClose={() => setModal(null)} onDone={done} />}
        </div>
    );
};

export default ProjectDetailPage;
