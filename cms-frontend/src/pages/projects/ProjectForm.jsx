// ============================================================
// NEW / EDIT PROJECT (v1.85.0)
//   <ProjectFormModal isOpen onClose onSaved project={null|project}
//                     investmentId={optional: fixed investment} />
// A project may be on its own (choose its currency) or inside an
// investment (the investment's currency is used).
// ============================================================

import { useEffect, useState } from 'react';
import { projectsAPI, investmentsAPI, accountsAPI, categoriesAPI, usersAPI } from '../../api/endpoints';
import { getErrorMessage } from '../../utils/helpers';
import ErrorMessage from '../../components/common/ErrorMessage';

const LINKABLE = ['PENDING', 'ACTIVE', 'ON_HOLD', 'PENDING_TERMINATION'];

export const useProjectFormOptions = (enabled) => {
    const [opts, setOpts] = useState({ investments: [], currencies: [], categories: [], people: [] });
    useEffect(() => {
        if (!enabled) return;
        Promise.allSettled([
            investmentsAPI.getAll({ limit: 200 }),
            accountsAPI.getCurrencies(),
            categoriesAPI.getAll({ flat: true }),
            usersAPI.getDirectory(),
        ]).then(([inv, cur, cat, ppl]) => setOpts({
            investments: inv.status === 'fulfilled' ? (inv.value.data.data || []).filter(i => LINKABLE.includes(i.status) && i.investment_type !== 'MMF') : [],
            currencies: cur.status === 'fulfilled' ? cur.value.data.data || [] : [],
            categories: cat.status === 'fulfilled' ? (cat.value.data.data || []).filter(c => c.module === 'INVESTMENT') : [],
            people: ppl.status === 'fulfilled' ? ppl.value.data.data || [] : [],
        }));
    }, [enabled]);
    return opts;
};

const empty = (investmentId) => ({
    name: '', description: '', planned_budget: '', currency_id: '', investment_id: investmentId ? String(investmentId) : '',
    category_id: '', start_date: '', expected_end_date: '', responsible_user_id: '', status: 'PENDING',
});

const ProjectFormModal = ({ isOpen, onClose, onSaved, project = null, investmentId = null }) => {
    const opts = useProjectFormOptions(isOpen);
    const [form, setForm] = useState(empty(investmentId));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (!isOpen) return;
        setError(null);
        if (project) {
            setForm({
                name: project.name || '', description: project.description || '',
                planned_budget: String(parseFloat(project.planned_budget || 0)),
                currency_id: project.currency_id ? String(project.currency_id) : '',
                investment_id: project.investment_id ? String(project.investment_id) : '',
                category_id: project.category_id ? String(project.category_id) : '',
                start_date: project.start_date || '', expected_end_date: project.expected_end_date || '',
                responsible_user_id: project.responsible_user_id ? String(project.responsible_user_id) : '',
                status: project.status,
            });
        } else setForm(empty(investmentId));
    }, [isOpen, project, investmentId]);

    if (!isOpen) return null;
    const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));
    const inv = opts.investments.find(i => String(i.id) === String(form.investment_id));
    const insideInvestment = !!form.investment_id;

    const submit = async (e) => {
        e.preventDefault();
        setBusy(true); setError(null);
        try {
            const payload = {
                name: form.name.trim(), description: form.description || undefined,
                planned_budget: parseFloat(form.planned_budget),
                category_id: form.category_id || undefined,
                start_date: form.start_date || undefined, expected_end_date: form.expected_end_date || undefined,
                responsible_user_id: form.responsible_user_id ? parseInt(form.responsible_user_id, 10) : (project ? null : undefined),
            };
            if (project) {
                if (!project.investment_id && form.currency_id) payload.currency_id = parseInt(form.currency_id, 10);
                await projectsAPI.update(project.id, payload);
                onSaved(project.id, 'Project saved.');
            } else {
                if (insideInvestment) payload.investment_id = parseInt(form.investment_id, 10);
                else payload.currency_id = form.currency_id ? parseInt(form.currency_id, 10) : undefined;
                payload.status = form.status;
                const r = await projectsAPI.create(payload);
                onSaved(r.data.data.project_id, r.data.message);
            }
        } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
    };

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            <div className="fixed inset-0 bg-black/40" onClick={onClose} />
            <div className="flex min-h-full items-center justify-center p-4">
                <form onSubmit={submit} className="relative bg-white dark:bg-gray-900 rounded-xl shadow-xl max-w-lg w-full p-6 space-y-4">
                    <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{project ? `Edit project — ${project.reference_code}` : 'New project'}</h2>
                    {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
                    <div>
                        <label className="label">Project name *</label>
                        <input className="input" required maxLength={200} value={form.name} onChange={set('name')} placeholder="e.g. Borehole at the farm" />
                    </div>
                    <div>
                        <label className="label">What it is</label>
                        <textarea className="input" rows={2} value={form.description} onChange={set('description')} />
                    </div>
                    {!project && (
                        <div>
                            <label className="label">Investment</label>
                            <select className="input" value={form.investment_id} onChange={set('investment_id')} disabled={!!investmentId}>
                                <option value="">None — the project is on its own</option>
                                {opts.investments.map(i => <option key={i.id} value={i.id}>{i.name} ({i.reference_code})</option>)}
                            </select>
                            <p className="text-xs text-gray-500 mt-1">
                                {insideInvestment
                                    ? 'Money for it is recorded as funding of the investment (Fund → choose this project) and counts in the investment\'s cost.'
                                    : 'Money for it is recorded with Record Expense (choose this project). It can be added to an investment later from its page.'}
                            </p>
                        </div>
                    )}
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="label">Planned budget *</label>
                            <input type="number" min="0.01" step="0.01" className="input" required value={form.planned_budget} onChange={set('planned_budget')} />
                        </div>
                        <div>
                            <label className="label">Currency {insideInvestment || (project && project.investment_id) ? '' : '*'}</label>
                            {insideInvestment || (project && project.investment_id) ? (
                                <input className="input" disabled value={inv ? `${inv.currency_code || ''} (the investment's)` : (project?.currency_code ? `${project.currency_code} (the investment's)` : 'The investment\'s currency')} />
                            ) : (
                                <select className="input" required value={form.currency_id} onChange={set('currency_id')}>
                                    <option value="">Choose…</option>
                                    {opts.currencies.map(c => <option key={c.id} value={c.id}>{c.code}</option>)}
                                </select>
                            )}
                        </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="label">Start date</label>
                            <input type="date" className="input" value={form.start_date} onChange={set('start_date')} />
                        </div>
                        <div>
                            <label className="label">Expected end</label>
                            <input type="date" className="input" value={form.expected_end_date} min={form.start_date || undefined} onChange={set('expected_end_date')} />
                        </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="label">Category</label>
                            <select className="input" value={form.category_id} onChange={set('category_id')}>
                                <option value="">{project ? 'Keep' : 'Projects (default)'}</option>
                                {opts.categories.map(c => <option key={c.id} value={c.id}>{c.full_path || c.name}</option>)}
                            </select>
                        </div>
                        <div>
                            <label className="label">Responsible person</label>
                            <select className="input" value={form.responsible_user_id} onChange={set('responsible_user_id')}>
                                <option value="">Nobody yet</option>
                                {opts.people.map(p => <option key={p.id} value={p.id}>{p.first_name} {p.last_name}</option>)}
                            </select>
                        </div>
                    </div>
                    {!project && (
                        <label className="flex items-center gap-2 text-sm">
                            <input type="checkbox" checked={form.status === 'ACTIVE'} onChange={e => setForm(f => ({ ...f, status: e.target.checked ? 'ACTIVE' : 'PENDING' }))} />
                            Work has already started (active)
                        </label>
                    )}
                    <div className="flex justify-end gap-2">
                        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
                        <button type="submit" className="btn-primary" disabled={busy}>{busy ? 'Saving…' : project ? 'Save' : 'Create project'}</button>
                    </div>
                </form>
            </div>
        </div>
    );
};

export default ProjectFormModal;
