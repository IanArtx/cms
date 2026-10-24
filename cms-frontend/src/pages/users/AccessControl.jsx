// ============================================================
// ACCESS CONTROL (v1.86.0) — Members › Access requests / Invitations
//
// "I need a standard way to reject access and keep the system secure."
//
//   AccessRequestsTab — accounts that registered and were never given a
//     role: who they are, where they registered from, and warning flags
//     (address that cannot receive email, automated scanner, not
//     verified, not invited). Tick one or many and Decline: the account
//     is made inactive and kept for the record (or removed completely if
//     it has no activity), its email can be blocked from registering
//     again, and the reason is kept in the audit log. The "Declined" view
//     lists declined accounts with Restore; "Blocked addresses" lists
//     addresses that may not register, with Unblock. Admins also see the
//     access settings: how new accounts are made (by invitation only /
//     anyone may register / closed), the clean-up limits and blocked
//     email domains.
//   InvitationsTab — invite a person by email (optionally for a role):
//     the email holds a one-time link that works only for that address
//     and expires. Resend makes a new link; Withdraw cancels it.
//   DeclineAccessModal — also used from the Members and Role Requests
//     tabs.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { accessAPI } from '../../api/endpoints';
import { formatDate, formatRelativeTime, getErrorMessage } from '../../utils/helpers';
import ErrorMessage from '../../components/common/ErrorMessage';
import { useAuth } from '../../contexts/AuthContext';
import { useConfirm } from '../../contexts/ConfirmContext';
import { ShieldExclamationIcon, EnvelopeIcon, ClipboardDocumentIcon } from '@heroicons/react/24/outline';

const MODE_LABELS = {
    INVITE_ONLY: 'By invitation only (recommended)',
    OPEN: 'Anyone may register — an administrator assigns or declines the role',
    CLOSED: 'Closed — nobody can register',
};

const FLAG_STYLE = {
    FAKE_DOMAIN: 'badge-red',
    AUTOMATED: 'badge-red',
    BLOCKED_DOMAIN: 'badge-red',
    UNVERIFIED: 'badge-yellow',
    NOT_INVITED: 'badge-yellow',
    INACTIVE: 'badge-gray',
    NEVER_SIGNED_IN: 'badge-gray',
};

const Modal = ({ children, onClose }) => (
    <div className="fixed inset-0 z-50 overflow-y-auto">
        <div className="fixed inset-0 bg-black bg-opacity-40" onClick={onClose} />
        <div className="flex min-h-full items-center justify-center p-4">
            <div className="relative bg-white rounded-xl shadow-xl max-w-lg w-full p-6">{children}</div>
        </div>
    </div>
);

// ============================================================
// DECLINE ACCESS MODAL
// accounts: [{ id, first_name, last_name, email }]
// ============================================================
export const DeclineAccessModal = ({ accounts, onClose, onDone }) => {
    const [reason, setReason] = useState('');
    const [blockEmail, setBlockEmail] = useState(true);
    const [remove, setRemove] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);

    if (!accounts || !accounts.length) return null;

    const submit = async (e) => {
        e.preventDefault();
        setSaving(true); setError(null);
        try {
            const res = await accessAPI.decline({
                user_ids: accounts.map(a => a.id), reason: reason.trim(), block_email: blockEmail, remove,
            });
            onDone(res.data.message);
            onClose();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setSaving(false);
        }
    };

    return (
        <Modal onClose={onClose}>
            <h2 className="text-lg font-semibold text-gray-900 mb-1">
                Decline access — {accounts.length} account{accounts.length === 1 ? '' : 's'}
            </h2>
            <ul className="text-sm text-gray-600 mb-4 max-h-32 overflow-y-auto list-disc list-inside">
                {accounts.map(a => (
                    <li key={a.id} className="break-all">{a.first_name} {a.last_name} — {a.email}</li>
                ))}
            </ul>
            {error && <div className="mb-3"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}
            <form onSubmit={submit} className="space-y-4">
                <div>
                    <label className="label" htmlFor="decl-reason">Reason (kept with the account and in the audit log) *</label>
                    <textarea id="decl-reason" className="input" rows={2} value={reason} required minLength={3} maxLength={500}
                        onChange={e => setReason(e.target.value)}
                        placeholder="e.g. Not known to the company — automated scanner" />
                    <div className="flex flex-wrap gap-2 mt-2">
                        {['Not known to the company', 'Automated scanner / fake address', 'Duplicate account', 'Not a member'].map(t => (
                            <button key={t} type="button" onClick={() => setReason(t)}
                                className="text-xs px-2 py-1 rounded border border-gray-200 hover:bg-gray-50">{t}</button>
                        ))}
                    </div>
                </div>
                <label className="flex items-start gap-2 text-sm">
                    <input type="checkbox" className="mt-1" checked={blockEmail} onChange={e => setBlockEmail(e.target.checked)} />
                    <span><strong>Block the email address</strong> — it cannot register again until it is unblocked.</span>
                </label>
                <label className="flex items-start gap-2 text-sm">
                    <input type="checkbox" className="mt-1" checked={remove} onChange={e => setRemove(e.target.checked)} />
                    <span><strong>Remove the account completely if it has no activity</strong>. Accounts with any
                        record (an entry, a document, a signature…) are only made inactive and kept.</span>
                </label>
                <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-xs text-gray-600 space-y-1">
                    <p>• The account can no longer sign in; any open sign-in is ended.</p>
                    <p>• Its role requests are rejected. No email is sent to the address.</p>
                    <p>• A declined account that was kept can be restored under <em>Declined</em>.</p>
                    <p>• Accounts that hold a role cannot be declined — remove their roles or use Deactivate.</p>
                </div>
                <div className="flex justify-end gap-3">
                    <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                    <button type="submit" disabled={saving || reason.trim().length < 3} className="btn-danger">
                        {saving ? 'Declining…' : 'Decline access'}
                    </button>
                </div>
            </form>
        </Modal>
    );
};

// ============================================================
// ACCESS SETTINGS CARD (Admins change; others read)
// ============================================================
const AccessSettingsCard = ({ settings, onSaved }) => {
    const { hasRole } = useAuth();
    const isAdmin = hasRole('Admin');
    const [form, setForm] = useState(null);
    const [saving, setSaving] = useState(false);
    const [msg, setMsg] = useState(null);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (settings) {
            setForm({
                registration_mode: settings.registration_mode,
                unverified_expiry_days: settings.unverified_expiry_days,
                pending_expiry_days: settings.pending_expiry_days,
                auto_remove_days: settings.auto_remove_days ?? 7,
                invite_valid_days: settings.invite_valid_days,
                notify_admins: settings.notify_admins,
                blocked_domains: (settings.blocked_domains || []).join(', '),
            });
        }
    }, [settings]);

    if (!settings || !form) return null;
    if (!settings.ready) {
        return (
            <div className="card mt-6 bg-amber-50 border border-amber-200 text-sm text-amber-900">
                The database update for v1.86.0 has not been run yet, so anyone can still register.
                Run <code>update_live_database.js --apply</code> first.
            </div>
        );
    }

    const save = async (e) => {
        e.preventDefault();
        setSaving(true); setMsg(null); setError(null);
        try {
            const res = await accessAPI.updateSettings({
                ...form,
                unverified_expiry_days: Number(form.unverified_expiry_days),
                pending_expiry_days: Number(form.pending_expiry_days),
                auto_remove_days: Number(form.auto_remove_days),
                invite_valid_days: Number(form.invite_valid_days),
                blocked_domains: form.blocked_domains.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean),
            });
            setMsg(res.data.message);
            onSaved();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setSaving(false);
        }
    };

    const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

    return (
        <form onSubmit={save} className="card mt-6 space-y-4">
            <div className="flex items-center gap-2">
                <ShieldExclamationIcon className="h-5 w-5 text-primary-600" />
                <h3 className="section-title">Access settings</h3>
                {!isAdmin && <span className="text-xs text-gray-400">(only an Admin can change these)</span>}
            </div>
            {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
            {msg && <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm text-green-700">{msg}</div>}
            <div>
                <label className="label" htmlFor="acc-mode">How new accounts are made</label>
                <select id="acc-mode" className="input" value={form.registration_mode} onChange={set('registration_mode')} disabled={!isAdmin}>
                    {Object.entries(MODE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
                <p className="text-xs text-gray-500 mt-1">
                    By invitation only: the Register page refuses anyone without an invitation link sent from the
                    Invitations tab. Existing members are not affected by any choice here.
                </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                    <label className="label" htmlFor="acc-unv">Decline unverified after (days)</label>
                    <input id="acc-unv" type="number" min={1} max={60} className="input" value={form.unverified_expiry_days}
                        onChange={set('unverified_expiry_days')} disabled={!isAdmin} />
                    <p className="text-xs text-gray-500 mt-1">The email link also stops working then.</p>
                </div>
                <div>
                    {/* v1.87.0 — replaces "Decline if no role after (days)" on this card */}
                    <label className="label" htmlFor="acc-rem">Remove accounts with no role after (days)</label>
                    <input id="acc-rem" type="number" min={0} max={60} className="input" value={form.auto_remove_days}
                        onChange={set('auto_remove_days')} disabled={!isAdmin} />
                    <p className="text-xs text-gray-500 mt-1">
                        0 = never. Removed completely by the nightly check. Kept: invited people still waiting for their role,
                        and any account with a record (it is declined instead). Accounts that ever held a role are never touched.
                    </p>
                </div>
                <div>
                    <label className="label" htmlFor="acc-inv">Invitation link valid for (days)</label>
                    <input id="acc-inv" type="number" min={1} max={60} className="input" value={form.invite_valid_days}
                        onChange={set('invite_valid_days')} disabled={!isAdmin} />
                </div>
            </div>
            <div>
                <label className="label" htmlFor="acc-dom">Blocked email domains (comma separated)</label>
                <input id="acc-dom" className="input" value={form.blocked_domains} onChange={set('blocked_domains')} disabled={!isAdmin}
                    placeholder="e.g. mailinator.com, tempmail.com" />
                <p className="text-xs text-gray-500 mt-1">
                    Always refused, without listing them: addresses ending in {(settings.reserved_tlds || []).map(t => `.${t}`).join(', ')} and
                    example.com — they cannot receive email (the “blockaid-scan.invalid” accounts are such).
                    An invited address is never refused for its domain.
                </p>
            </div>
            <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={form.notify_admins} onChange={set('notify_admins')} disabled={!isAdmin} />
                Tell the Admins (bell and email) whenever a new account registers
            </label>
            {isAdmin && (
                <div className="flex justify-end">
                    <button type="submit" disabled={saving} className="btn-primary">{saving ? 'Saving…' : 'Save access settings'}</button>
                </div>
            )}
        </form>
    );
};

// ============================================================
// ACCESS REQUESTS TAB
// ============================================================
export const AccessRequestsTab = ({ onChanged }) => {
    const confirm = useConfirm();
    const [view, setView] = useState('pending'); // pending | declined | blocked
    const [settings, setSettings] = useState(null);
    const [rows, setRows] = useState([]);
    const [blocked, setBlocked] = useState([]);
    const [selected, setSelected] = useState([]);
    const [declining, setDeclining] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [msg, setMsg] = useState(null);

    const loadSettings = useCallback(() => {
        accessAPI.getSettings().then(r => setSettings(r.data.data)).catch(() => {});
    }, []);

    const load = useCallback(async () => {
        setLoading(true); setError(null);
        try {
            if (view === 'blocked') {
                const r = await accessAPI.listBlocked();
                setBlocked(r.data.data || []);
            } else {
                const r = await accessAPI.listRequests(view);
                setRows(r.data.data?.rows || []);
            }
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
            setSelected([]);
        }
    }, [view]);

    useEffect(() => { loadSettings(); }, [loadSettings]);
    useEffect(() => { load(); }, [load]);

    const done = (m) => { setMsg(m); load(); if (onChanged) onChanged(); };

    const restore = async (row) => {
        const ok = await confirm({
            title: 'Restore access',
            message: `${row.email} will be able to sign in again (still without a role until one is assigned)${row.email_blocked ? ', and the address is unblocked' : ''}. Continue?`,
            confirmLabel: 'Restore',
        });
        if (!ok) return;
        try {
            const r = await accessAPI.restore({ user_id: row.id, unblock: true });
            done(r.data.message);
        } catch (err) { setError(getErrorMessage(err)); }
    };

    const unblock = async (b) => {
        const ok = await confirm({ title: 'Unblock address', message: `${b.email} will be able to register again. Continue?`, confirmLabel: 'Unblock' });
        if (!ok) return;
        try {
            const r = await accessAPI.unblock(b.id);
            done(r.data.message);
        } catch (err) { setError(getErrorMessage(err)); }
    };

    const toggle = (id) => setSelected(s => (s.includes(id) ? s.filter(x => x !== id) : [...s, id]));
    const suspicious = rows.filter(r => (r.flags || []).some(f => ['FAKE_DOMAIN', 'AUTOMATED', 'BLOCKED_DOMAIN'].includes(f.code)));

    return (
        <div>
            <div className="card">
                <div className="flex flex-wrap items-center gap-2 mb-4">
                    {[['pending', 'Waiting for access'], ['declined', 'Declined'], ['blocked', 'Blocked addresses']].map(([k, label]) => (
                        <button key={k} type="button" onClick={() => { setView(k); setMsg(null); }}
                            className={`text-sm px-3 py-1.5 rounded-lg border ${view === k ? 'bg-primary-600 text-white border-primary-600' : 'border-gray-200 hover:bg-gray-50'}`}>
                            {label}{k === 'pending' && view === 'pending' && rows.length ? ` (${rows.length})` : ''}
                        </button>
                    ))}
                </div>

                {error && <div className="mb-3"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}
                {msg && <div className="mb-3 bg-green-50 border border-green-200 rounded-lg p-3 text-sm text-green-700">{msg}</div>}

                {view === 'pending' && (
                    <>
                        <p className="text-sm text-gray-600 mb-3">
                            Accounts that registered and were never given a role. They cannot see any company
                            information. If you do not recognise one, decline it. To accept someone, give them a role
                            under <em>Members › Manage Roles</em> (or approve their request under <em>Role Requests</em>).
                        </p>
                        <div className="flex flex-wrap gap-2 mb-3">
                            <button type="button" className="btn-danger text-sm" disabled={!selected.length}
                                onClick={() => setDeclining(rows.filter(r => selected.includes(r.id)))}>
                                Decline selected ({selected.length})
                            </button>
                            {suspicious.length > 0 && (
                                <button type="button" className="btn-secondary text-sm"
                                    onClick={() => setSelected(suspicious.map(r => r.id))}>
                                    Select the {suspicious.length} flagged in red
                                </button>
                            )}
                            {rows.length > 0 && (
                                <button type="button" className="btn-secondary text-sm"
                                    onClick={() => setSelected(selected.length === rows.length ? [] : rows.map(r => r.id))}>
                                    {selected.length === rows.length ? 'Clear selection' : 'Select all'}
                                </button>
                            )}
                        </div>
                    </>
                )}

                {loading ? (
                    <p className="text-sm text-gray-400 py-8 text-center">Loading…</p>
                ) : view === 'blocked' ? (
                    blocked.length === 0 ? (
                        <p className="text-sm text-gray-400 py-8 text-center">No blocked addresses.</p>
                    ) : (
                        <div className="divide-y divide-gray-100">
                            {blocked.map(b => (
                                <div key={b.id} className="py-3 flex flex-wrap items-start justify-between gap-2">
                                    <div className="min-w-0">
                                        <p className="text-sm font-medium text-gray-900 break-all">{b.email}</p>
                                        <p className="text-xs text-gray-500">
                                            {b.reason || '—'} · blocked {formatDate(b.blocked_at)}{b.blocked_by_name ? ` by ${b.blocked_by_name}` : ''}
                                        </p>
                                    </div>
                                    <button type="button" className="btn-secondary text-xs" onClick={() => unblock(b)}>Unblock</button>
                                </div>
                            ))}
                        </div>
                    )
                ) : rows.length === 0 ? (
                    <p className="text-sm text-gray-400 py-8 text-center">
                        {view === 'pending' ? 'No accounts are waiting for access.' : 'No declined accounts.'}
                    </p>
                ) : (
                    <div className="divide-y divide-gray-100">
                        {rows.map(r => (
                            <div key={r.id} className="py-3 flex gap-3 items-start">
                                {view === 'pending' && (
                                    <input type="checkbox" className="mt-1" checked={selected.includes(r.id)} onChange={() => toggle(r.id)}
                                        aria-label={`Select ${r.email}`} />
                                )}
                                <div className="flex-1 min-w-0">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <p className="text-sm font-medium text-gray-900">{r.first_name} {r.last_name}</p>
                                        <span className="text-xs text-gray-500 break-all">{r.email}</span>
                                    </div>
                                    {view === 'pending' && (r.flags || []).length > 0 && (
                                        <div className="flex flex-wrap gap-1 mt-1">
                                            {r.flags.map(f => <span key={f.code} className={FLAG_STYLE[f.code] || 'badge-gray'}>{f.label}</span>)}
                                        </div>
                                    )}
                                    <p className="text-xs text-gray-500 mt-1">
                                        Registered {formatRelativeTime(r.created_at)}
                                        {r.registered_ip ? ` from ${r.registered_ip}` : ''}
                                        {r.last_login_at ? ` · last signed in ${formatRelativeTime(r.last_login_at)}` : ' · never signed in'}
                                        {r.invited_by_name ? ` · invited by ${r.invited_by_name}` : ''}
                                    </p>
                                    {(r.role_requests || []).length > 0 && (
                                        <p className="text-xs text-gray-500">
                                            Asked for: {r.role_requests.map(q => `${q.role}${q.status !== 'PENDING' ? ` (${q.status.toLowerCase()})` : ''}`).join(', ')}
                                        </p>
                                    )}
                                    {r.registered_user_agent && (
                                        <p className="text-[11px] text-gray-400 truncate" title={r.registered_user_agent}>{r.registered_user_agent}</p>
                                    )}
                                    {view === 'declined' && (
                                        <p className="text-xs text-red-700 mt-1">
                                            Declined {formatDate(r.rejected_at)}{r.rejected_by_name ? ` by ${r.rejected_by_name}` : ' automatically'} — {r.rejection_reason}
                                            {r.email_blocked ? ' · address blocked' : ''}
                                        </p>
                                    )}
                                </div>
                                {view === 'pending' ? (
                                    <button type="button" className="btn-danger text-xs shrink-0" onClick={() => setDeclining([r])}>Decline</button>
                                ) : (
                                    <button type="button" className="btn-secondary text-xs shrink-0" onClick={() => restore(r)}>Restore</button>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* settings below the list — declining is the everyday job */}
            <AccessSettingsCard settings={settings} onSaved={loadSettings} />

            <DeclineAccessModal accounts={declining} onClose={() => setDeclining(null)} onDone={done} />
        </div>
    );
};

// ============================================================
// INVITATIONS TAB
// ============================================================
const STATE_STYLE = { OPEN: 'badge-blue', USED: 'badge-green', EXPIRED: 'badge-gray', REVOKED: 'badge-gray' };
const STATE_LABEL = { OPEN: 'Waiting', USED: 'Account created', EXPIRED: 'Expired', REVOKED: 'Withdrawn' };

export const InvitationsTab = ({ roles }) => {
    const confirm = useConfirm();
    const empty = { email: '', first_name: '', last_name: '', role_id: '', note: '' };
    const [form, setForm] = useState(empty);
    const [list, setList] = useState([]);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);
    const [msg, setMsg] = useState(null);
    const [link, setLink] = useState(null);
    const [copied, setCopied] = useState(false);

    const load = useCallback(() => {
        accessAPI.listInvitations().then(r => setList(r.data.data || [])).catch(err => setError(getErrorMessage(err)));
    }, []);
    useEffect(() => { load(); }, [load]);

    const showResult = (res) => {
        setMsg(res.data.message);
        setLink(res.data.data?.link || null);
        setCopied(false);
        load();
    };

    const submit = async (e) => {
        e.preventDefault();
        setSaving(true); setError(null); setMsg(null); setLink(null);
        try {
            const res = await accessAPI.invite({ ...form, role_id: form.role_id ? Number(form.role_id) : undefined });
            showResult(res);
            setForm(empty);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setSaving(false);
        }
    };

    const resend = async (inv) => {
        const ok = await confirm({ title: 'Send again', message: `Send ${inv.email} a new link? The old link stops working.`, confirmLabel: 'Send' });
        if (!ok) return;
        try { showResult(await accessAPI.resendInvitation(inv.id)); } catch (err) { setError(getErrorMessage(err)); }
    };
    const revoke = async (inv) => {
        const ok = await confirm({ title: 'Withdraw invitation', message: `The link sent to ${inv.email} will stop working. Continue?`, confirmLabel: 'Withdraw', danger: true });
        if (!ok) return;
        try { const r = await accessAPI.revokeInvitation(inv.id); setMsg(r.data.message); setLink(null); load(); } catch (err) { setError(getErrorMessage(err)); }
    };
    const copy = async () => {
        try { await navigator.clipboard.writeText(link); setCopied(true); } catch { setCopied(false); }
    };

    const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));

    return (
        <div>
            <form onSubmit={submit} className="card mb-6 space-y-4">
                <div className="flex items-center gap-2">
                    <EnvelopeIcon className="h-5 w-5 text-primary-600" />
                    <h3 className="section-title">Invite a person</h3>
                </div>
                <p className="text-sm text-gray-600">
                    The person gets an email with a link to create their account. The link works only for this email
                    address, only once, and expires. Their account is ready to sign in straight away (the invitation
                    proves the address); the role you choose is shown as their request and you confirm it under
                    <em> Role Requests</em> once they have registered.
                </p>
                {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
                {msg && <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm text-green-700">{msg}</div>}
                {link && (
                    <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-xs">
                        <p className="text-gray-600 mb-1">Invitation link (send it yourself only if the email did not arrive — treat it like a password):</p>
                        <div className="flex gap-2 items-start">
                            <code className="break-all flex-1">{link}</code>
                            <button type="button" onClick={copy} className="btn-secondary text-xs shrink-0 flex items-center gap-1">
                                <ClipboardDocumentIcon className="h-4 w-4" />{copied ? 'Copied' : 'Copy'}
                            </button>
                        </div>
                    </div>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="sm:col-span-2">
                        <label className="label" htmlFor="inv-email">Email address *</label>
                        <input id="inv-email" type="email" className="input" value={form.email} onChange={set('email')} required />
                    </div>
                    <div>
                        <label className="label" htmlFor="inv-fn">First name</label>
                        <input id="inv-fn" className="input" value={form.first_name} onChange={set('first_name')} maxLength={100} />
                    </div>
                    <div>
                        <label className="label" htmlFor="inv-ln">Last name</label>
                        <input id="inv-ln" className="input" value={form.last_name} onChange={set('last_name')} maxLength={100} />
                    </div>
                    <div>
                        <label className="label" htmlFor="inv-role">Role it is for</label>
                        <select id="inv-role" className="input" value={form.role_id} onChange={set('role_id')}>
                            <option value="">— decide later —</option>
                            {(roles || []).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                        </select>
                    </div>
                    <div>
                        <label className="label" htmlFor="inv-note">Note in the email</label>
                        <input id="inv-note" className="input" value={form.note} onChange={set('note')} maxLength={500}
                            placeholder="e.g. Welcome — as agreed at the AGM" />
                    </div>
                </div>
                <div className="flex justify-end">
                    <button type="submit" disabled={saving || !form.email.trim()} className="btn-primary">
                        {saving ? 'Sending…' : 'Send invitation'}
                    </button>
                </div>
            </form>

            <div className="card">
                <h3 className="section-title mb-3">Invitations</h3>
                {list.length === 0 ? (
                    <p className="text-sm text-gray-400 py-6 text-center">No invitations yet.</p>
                ) : (
                    <div className="divide-y divide-gray-100">
                        {list.map(inv => (
                            <div key={inv.id} className="py-3 flex flex-wrap items-start justify-between gap-2">
                                <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <p className="text-sm font-medium text-gray-900 break-all">{inv.email}</p>
                                        <span className={STATE_STYLE[inv.state]}>{STATE_LABEL[inv.state]}</span>
                                    </div>
                                    <p className="text-xs text-gray-500">
                                        {[inv.first_name, inv.last_name].filter(Boolean).join(' ') || '—'}
                                        {inv.role_name ? ` · for ${inv.role_name}` : ''}
                                        {` · by ${inv.invited_by_name} ${formatRelativeTime(inv.created_at)}`}
                                        {inv.sent_count > 1 ? ` · sent ${inv.sent_count} times` : ''}
                                        {inv.state === 'OPEN' ? ` · expires ${formatDate(inv.expires_at)}` : ''}
                                        {inv.used_at ? ` · used ${formatDate(inv.used_at)}${inv.used_by_name ? ` by ${inv.used_by_name}` : ''}` : ''}
                                    </p>
                                </div>
                                {(inv.state === 'OPEN' || inv.state === 'EXPIRED') && (
                                    <div className="flex gap-2">
                                        <button type="button" className="btn-secondary text-xs" onClick={() => resend(inv)}>Send again</button>
                                        <button type="button" className="btn-secondary text-xs text-red-600" onClick={() => revoke(inv)}>Withdraw</button>
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};
