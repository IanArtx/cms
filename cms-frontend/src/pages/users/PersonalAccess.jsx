// ============================================================
// PERSONAL ACCESS RULES (v1.89.0)
// "the admin can limit one's individual actions like approvals or any
//  permission depite the role they hold since even directors and
//  secretaries can have different roles and limitations with in the
//  company" (13 Nov 2026).
//
//   <PersonalAccessModal userId name onClose />  Members › a member ›
//       "Access limits" (Admin): the person's rules, adding / ending a
//       rule, and every permission with where it comes from.
//   <PersonalLimitsTab />  Members › "Personal limits": everyone who has
//       a rule now or from a later date.
//   <MyAccess />  My Profile › Sign-in & security › My access: the limits
//       on one's own account (read only).
// Rule kinds: take a permission away · give one extra permission · block
// an action · approval limit (amount per currency and/or accounts) ·
// hide a part of the system. Each needs a reason; dates are optional
// (a rule with an end date lifts itself).
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usersAPI } from '../../api/endpoints';
import { getErrorMessage } from '../../utils/helpers';
import ErrorMessage from '../../components/common/ErrorMessage';
import LoadingSpinner from '../../components/common/LoadingSpinner';
import { XMarkIcon, LockClosedIcon, PlusIcon, NoSymbolIcon, EyeSlashIcon, BanknotesIcon, KeyIcon } from '@heroicons/react/24/outline';

const KIND_INFO = {
    PERMISSION_REMOVE: { label: 'Take away a permission', short: 'Permission taken away', icon: KeyIcon, help: 'The person loses one permission their roles give them (for example "approve documents"). Everyone else with the same role keeps it.' },
    PERMISSION_ADD: { label: 'Give one extra permission', short: 'Extra permission', icon: PlusIcon, help: 'The person gets one permission without being given a whole role.' },
    ACTION_BLOCK: { label: 'Block an action', short: 'Action blocked', icon: NoSymbolIcon, help: 'The person may not do this at all — for example approve transfers, release requisitions, sign documents or sign resolutions — whatever their roles.' },
    APPROVAL_LIMIT: { label: 'Approval limit (amount or accounts)', short: 'Approval limit', icon: BanknotesIcon, help: 'The person may approve only up to an amount in one currency (add one limit per currency), and/or only on certain accounts. Above it, someone else must approve.' },
    AREA_HIDE: { label: 'Hide a part of the system', short: 'Hidden', icon: EyeSlashIcon, help: 'The page disappears from the person’s menu and the system refuses its requests. Their own things there (their profile, savings, requests…) stay available.' },
};
const STATE_CLS = {
    ACTIVE: 'bg-green-50 text-green-700 border-green-200',
    SCHEDULED: 'bg-blue-50 text-blue-700 border-blue-200',
    EXPIRED: 'bg-gray-100 text-gray-500 border-gray-200',
    ENDED: 'bg-gray-100 text-gray-500 border-gray-200',
};
const STATE_LABEL = { ACTIVE: 'In force', SCHEDULED: 'Starts later', EXPIRED: 'Expired', ENDED: 'Ended' };

const Pill = ({ state }) => <span className={`text-[11px] border rounded-full px-2 py-0.5 ${STATE_CLS[state] || STATE_CLS.ENDED}`}>{STATE_LABEL[state] || state}</span>;

const RuleRow = ({ r, onEnd, busy }) => {
    const Icon = (KIND_INFO[r.kind] || {}).icon || LockClosedIcon;
    const [ending, setEnding] = useState(false);
    const [why, setWhy] = useState('');
    const live = r.state === 'ACTIVE' || r.state === 'SCHEDULED';
    return (
        <li className="p-3">
            <div className="flex items-start gap-3">
                <Icon className="h-5 w-5 text-gray-400 flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{r.summary}</p>
                    <p className="text-xs text-gray-500 mt-0.5">
                        {r.starts_on}{r.ends_on ? ` → ${r.ends_on}` : ' → no end date'} · set by {r.created_by_name || '—'} · Reason: {r.reason}
                    </p>
                    {r.ended_at && <p className="text-xs text-gray-500">Ended {new Date(r.ended_at).toLocaleDateString()} by {r.ended_by_name}: {r.end_reason}</p>}
                </div>
                <Pill state={r.state} />
                {live && onEnd && !ending && (
                    <button type="button" className="text-xs text-red-600 hover:underline whitespace-nowrap" onClick={() => setEnding(true)}>End now</button>
                )}
            </div>
            {ending && (
                <div className="mt-2 ml-8 flex flex-col sm:flex-row gap-2">
                    <input className="input text-sm flex-1" placeholder="Why it ends (e.g. back from leave)" value={why} onChange={e => setWhy(e.target.value)} />
                    <div className="flex gap-2">
                        <button type="button" className="btn-secondary text-sm" onClick={() => { setEnding(false); setWhy(''); }}>Cancel</button>
                        <button type="button" className="btn-danger text-sm" disabled={busy || why.trim().length < 5} onClick={() => onEnd(r, why.trim())}>End rule</button>
                    </div>
                </div>
            )}
        </li>
    );
};

const AddRuleForm = ({ data, onSaved }) => {
    const [kind, setKind] = useState('ACTION_BLOCK');
    const [f, setF] = useState({ permission_code: '', action_code: '', area_code: '', currency_code: '', max_amount: '', account_ids: [], reason: '', starts_on: '', ends_on: '' });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const set = (k, v) => setF(x => ({ ...x, [k]: v }));
    const cat = data.catalogue;
    const removable = data.permissions.filter(p => p.from_roles && !p.removed);
    const addable = data.permissions.filter(p => !p.from_roles && !p.added);
    const actions = cat.actions.filter(a => (kind === 'APPROVAL_LIMIT' ? a.money : !a.limitOnly));
    const groups = useMemo(() => Array.from(new Set(actions.map(a => a.group))), [actions]);
    const byModule = (list) => Array.from(new Set(list.map(p => p.module))).map(m => ({ m, items: list.filter(p => p.module === m) }));

    const save = async (e) => {
        e.preventDefault();
        setBusy(true); setError(null);
        try {
            const payload = { kind, reason: f.reason, starts_on: f.starts_on || undefined, ends_on: f.ends_on || undefined };
            if (kind === 'PERMISSION_REMOVE' || kind === 'PERMISSION_ADD') payload.permission_code = f.permission_code;
            if (kind === 'ACTION_BLOCK' || kind === 'APPROVAL_LIMIT') payload.action_code = f.action_code;
            if (kind === 'AREA_HIDE') payload.area_code = f.area_code;
            if (kind === 'APPROVAL_LIMIT') {
                if (f.max_amount !== '') { payload.max_amount = Number(f.max_amount); payload.currency_code = f.currency_code; }
                payload.account_ids = f.account_ids.map(Number);
            }
            const r = await usersAPI.addAccessRule(data.person.id, payload);
            setF({ permission_code: '', action_code: '', area_code: '', currency_code: '', max_amount: '', account_ids: [], reason: '', starts_on: '', ends_on: '' });
            onSaved(r.data.message);
        } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
    };

    return (
        <form onSubmit={save} className="space-y-3">
            <div className="flex flex-wrap gap-1.5">
                {Object.entries(KIND_INFO).map(([k, info]) => (
                    <button key={k} type="button" onClick={() => setKind(k)}
                        className={`text-xs px-2.5 py-1.5 rounded-lg border inline-flex items-center gap-1.5 ${kind === k ? 'bg-primary-600 text-white border-primary-600' : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'}`}>
                        <info.icon className="h-4 w-4" />{info.label}
                    </button>
                ))}
            </div>
            <p className="text-xs text-gray-500">{KIND_INFO[kind].help}</p>
            {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}

            {kind === 'PERMISSION_REMOVE' && (
                <select className="input" required value={f.permission_code} onChange={e => set('permission_code', e.target.value)}>
                    <option value="">Choose the permission to take away…</option>
                    {byModule(removable).map(g => <optgroup key={g.m} label={g.m}>{g.items.map(p => <option key={p.code} value={p.code}>{p.code} — {p.description || ''} (from {p.from_roles})</option>)}</optgroup>)}
                </select>
            )}
            {kind === 'PERMISSION_ADD' && (
                <select className="input" required value={f.permission_code} onChange={e => set('permission_code', e.target.value)}>
                    <option value="">Choose the permission to give…</option>
                    {byModule(addable).map(g => <optgroup key={g.m} label={g.m}>{g.items.map(p => <option key={p.code} value={p.code}>{p.code} — {p.description || ''}</option>)}</optgroup>)}
                </select>
            )}
            {(kind === 'ACTION_BLOCK' || kind === 'APPROVAL_LIMIT') && (
                <select className="input" required value={f.action_code} onChange={e => set('action_code', e.target.value)}>
                    <option value="">Choose the action…</option>
                    {groups.map(g => <optgroup key={g} label={g}>{actions.filter(a => a.group === g).map(a => <option key={a.code} value={a.code}>{a.label}</option>)}</optgroup>)}
                </select>
            )}
            {kind === 'APPROVAL_LIMIT' && (
                <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                        <label className="label" htmlFor="pa-amt">Most they may approve (leave empty for no amount limit)</label>
                        <div className="flex gap-2">
                            <select className="input max-w-[6rem]" value={f.currency_code} onChange={e => set('currency_code', e.target.value)} aria-label="Currency">
                                <option value="">Cur.</option>
                                {cat.currencies.map(c => <option key={c} value={c}>{c}</option>)}
                            </select>
                            <input id="pa-amt" type="number" min="0" step="0.01" className="input" value={f.max_amount} onChange={e => set('max_amount', e.target.value)} placeholder="e.g. 5000000" />
                        </div>
                        <p className="text-[11px] text-gray-500 mt-1">One limit per currency — add a second rule for another currency.</p>
                    </div>
                    <div>
                        <span className="label">Only on these accounts (none ticked = any account)</span>
                        <div className="space-y-1 max-h-32 overflow-y-auto">
                            {cat.accounts.map(a => (
                                <label key={a.id} className="flex items-center gap-2 text-sm">
                                    <input type="checkbox" checked={f.account_ids.includes(a.id)}
                                        onChange={e => set('account_ids', e.target.checked ? [...f.account_ids, a.id] : f.account_ids.filter(x => x !== a.id))} />
                                    {a.name} <span className="text-xs text-gray-400">{a.currency_code}</span>
                                </label>
                            ))}
                        </div>
                    </div>
                </div>
            )}
            {kind === 'AREA_HIDE' && (
                <select className="input" required value={f.area_code} onChange={e => set('area_code', e.target.value)}>
                    <option value="">Choose the part of the system to hide…</option>
                    {cat.areas.map(a => <option key={a.code} value={a.code}>{a.label}</option>)}
                </select>
            )}
            <div>
                <label className="label" htmlFor="pa-reason">Reason (the person sees it)</label>
                <input id="pa-reason" className="input" required minLength={5} value={f.reason} onChange={e => set('reason', e.target.value)} placeholder="e.g. Board resolution BR 4/2026 — payments above UGX 5M need two directors" />
            </div>
            <div className="grid grid-cols-2 gap-3">
                <div><label className="label" htmlFor="pa-from">From (empty = today)</label><input id="pa-from" type="date" className="input" value={f.starts_on} onChange={e => set('starts_on', e.target.value)} /></div>
                <div><label className="label" htmlFor="pa-to">Until (empty = no end)</label><input id="pa-to" type="date" className="input" value={f.ends_on} onChange={e => set('ends_on', e.target.value)} /></div>
            </div>
            <div className="flex justify-end"><button type="submit" className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save rule'}</button></div>
        </form>
    );
};

export const PersonalAccessModal = ({ userId, name, onClose, onChanged }) => {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null);
    const [busy, setBusy] = useState(false);
    const [showEnded, setShowEnded] = useState(false);
    const [permFilter, setPermFilter] = useState('changed');

    const load = useCallback(() => {
        usersAPI.getPersonAccess(userId).then(r => setData(r.data.data)).catch(err => setError(getErrorMessage(err)));
    }, [userId]);
    useEffect(() => { if (userId) load(); }, [userId, load]);
    if (!userId) return null;

    const end = async (r, reason) => {
        setBusy(true); setError(null);
        try { const res = await usersAPI.endAccessRule(userId, r.id, reason); setNotice(res.data.message); load(); onChanged && onChanged(); } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
    };
    const live = data ? data.rules.filter(r => r.state === 'ACTIVE' || r.state === 'SCHEDULED') : [];
    const past = data ? data.rules.filter(r => !(r.state === 'ACTIVE' || r.state === 'SCHEDULED')) : [];
    const perms = data ? data.permissions.filter(p => (permFilter === 'all' ? true : permFilter === 'has' ? p.effective : (p.removed || p.added))) : [];

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto" role="dialog" aria-modal="true">
            <div className="fixed inset-0 bg-black/40" onClick={onClose} />
            <div className="flex min-h-full items-start sm:items-center justify-center p-3 sm:p-6">
                <div className="relative bg-white dark:bg-gray-900 rounded-xl shadow-xl w-full max-w-3xl">
                    <div className="flex items-start justify-between p-5 border-b border-gray-100 dark:border-gray-800">
                        <div>
                            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Access limits — {name}</h2>
                            <p className="text-sm text-gray-500">{data ? `Roles: ${data.person.roles.join(', ') || 'none'}. ` : ''}Rules here apply to this person only, on top of their roles.</p>
                        </div>
                        <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="Close"><XMarkIcon className="h-5 w-5" /></button>
                    </div>
                    <div className="p-5 space-y-5">
                        {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
                        {notice && <div className="bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg p-3">{notice}</div>}
                        {!data ? <LoadingSpinner /> : !data.ready ? (
                            <p className="text-sm text-amber-700">Personal access rules need the v1.89.0 database update — run update_live_database.js first.</p>
                        ) : (
                            <>
                                <section>
                                    <h3 className="text-sm font-semibold mb-2">Rules now and to come ({live.length})</h3>
                                    {live.length ? (
                                        <ul className="divide-y divide-gray-100 dark:divide-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
                                            {live.map(r => <RuleRow key={r.id} r={r} onEnd={end} busy={busy} />)}
                                        </ul>
                                    ) : <p className="text-sm text-gray-500">None — this person can do exactly what their roles allow.</p>}
                                    {past.length > 0 && (
                                        <div className="mt-2">
                                            <button type="button" className="text-xs text-gray-500 hover:underline" onClick={() => setShowEnded(s => !s)}>{showEnded ? 'Hide' : 'Show'} earlier rules ({past.length})</button>
                                            {showEnded && <ul className="mt-2 divide-y divide-gray-100 dark:divide-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 opacity-80">{past.map(r => <RuleRow key={r.id} r={r} />)}</ul>}
                                        </div>
                                    )}
                                </section>
                                <section className="rounded-lg border border-gray-200 dark:border-gray-700 p-4">
                                    <h3 className="text-sm font-semibold mb-3">Add a rule</h3>
                                    <AddRuleForm data={data} onSaved={(m) => { setNotice(m); load(); onChanged && onChanged(); }} />
                                </section>
                                <section>
                                    <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
                                        <h3 className="text-sm font-semibold">Permissions</h3>
                                        <div className="inline-flex rounded-lg border border-gray-200 dark:border-gray-700 p-0.5 text-xs">
                                            {[['changed', 'Changed for this person'], ['has', 'What they have'], ['all', 'All']].map(([k, l]) => (
                                                <button key={k} type="button" onClick={() => setPermFilter(k)} className={`px-2.5 py-1 rounded-md ${permFilter === k ? 'bg-primary-600 text-white' : 'text-gray-500'}`}>{l}</button>
                                            ))}
                                        </div>
                                    </div>
                                    {perms.length === 0 ? <p className="text-sm text-gray-500">Nothing changed — their permissions are those of their roles.</p> : (
                                        <div className="max-h-72 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700">
                                            <table className="w-full text-sm">
                                                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                                                    {perms.map(p => (
                                                        <tr key={p.code}>
                                                            <td className="px-3 py-1.5"><span className={p.effective ? '' : 'text-gray-400 line-through'}>{p.code}</span><span className="block text-xs text-gray-500">{p.description}</span></td>
                                                            <td className="px-3 py-1.5 text-xs text-right whitespace-nowrap">
                                                                {p.removed ? <span className="text-red-600">taken away</span>
                                                                    : p.added ? <span className="text-primary-600">given to this person</span>
                                                                        : p.from_roles ? <span className="text-gray-500">from {p.from_roles}</span> : <span className="text-gray-300">—</span>}
                                                            </td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    )}
                                    <p className="text-[11px] text-gray-500 mt-2">Some powers come from holding a role rather than a permission (for example only the Treasurer, Assistant Treasurer or Admin release money). Limit those with <em>Block an action</em>, an <em>Approval limit</em> or <em>Hide a part of the system</em>.</p>
                                </section>
                            </>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

export const PersonalLimitsTab = () => {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [open, setOpen] = useState(null);
    const load = useCallback(() => { usersAPI.getAccessOverview().then(r => setData(r.data.data)).catch(err => setError(getErrorMessage(err))); }, []);
    useEffect(() => { load(); }, [load]);
    if (error) return <ErrorMessage message={error} />;
    if (!data) return <LoadingSpinner />;
    if (!data.ready) return <p className="text-sm text-amber-700">Personal access rules need the v1.89.0 database update.</p>;
    return (
        <div className="space-y-4">
            <div className="card p-4 text-sm text-gray-600 dark:text-gray-300">
                People whose access differs from their roles — limits on approvals or amounts, actions blocked, parts of the system hidden, or a single extra permission.
                To add a rule, open <strong>Members</strong> and click <strong>Access limits</strong> on the person.
            </div>
            {data.people.length === 0 ? <p className="text-sm text-gray-500">No one has personal rules — everyone can do exactly what their roles allow.</p> : (
                <ul className="card divide-y divide-gray-100 dark:divide-gray-800 p-0">
                    {data.people.map(p => (
                        <li key={p.user_id} className="p-4 flex flex-col sm:flex-row sm:items-start gap-2">
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{p.name}</p>
                                <ul className="mt-1 space-y-0.5">
                                    {p.rules.map(r => (
                                        <li key={r.id} className="text-xs text-gray-600 dark:text-gray-400 flex items-center gap-2">
                                            <Pill state={r.state} /><span>{r.summary}{r.ends_on ? ` — until ${r.ends_on}` : ''}{r.state === 'SCHEDULED' ? ` — from ${r.starts_on}` : ''}</span>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                            <button type="button" className="btn-secondary text-sm self-start" onClick={() => setOpen(p)}>Manage</button>
                        </li>
                    ))}
                </ul>
            )}
            {open && <PersonalAccessModal userId={open.user_id} name={open.name} onClose={() => setOpen(null)} onChanged={load} />}
        </div>
    );
};

export const MyAccess = () => {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    useEffect(() => { usersAPI.getMyAccess().then(r => setData(r.data.data)).catch(err => setError(getErrorMessage(err))); }, []);
    if (error) return <ErrorMessage message={error} />;
    if (!data) return <LoadingSpinner />;
    return (
        <div className="space-y-3">
            <p className="text-sm text-gray-500">What you can do comes from your roles. An Admin can also set limits for you personally — they are listed here with the reason.</p>
            {!data.ready || data.rules.length === 0 ? (
                <p className="text-sm text-gray-600 dark:text-gray-300">You have no personal limits — you can do everything your roles allow.</p>
            ) : (
                <ul className="divide-y divide-gray-100 dark:divide-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
                    {data.rules.map(r => (
                        <li key={r.id} className="p-3 flex items-start gap-3">
                            <div className="flex-1">
                                <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{r.summary}</p>
                                <p className="text-xs text-gray-500">Reason: {r.reason} · {r.starts_on}{r.ends_on ? ` → ${r.ends_on}` : ''}</p>
                            </div>
                            <Pill state={r.state} />
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
};
