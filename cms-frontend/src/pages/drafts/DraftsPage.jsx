// ============================================================
// MY UNFINISHED FORMS (v1.81.0) — /drafts
// Every form the person started and has not submitted yet: kept in their
// account (any device) and/or on this device. Open goes back to the form
// (it fills itself in again); Discard throws the draft away.
// Only the person themselves ever sees this list.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { draftsAPI } from '../../api/endpoints';
import { useAuth } from '../../contexts/AuthContext';
import { useConfirm } from '../../contexts/ConfirmContext';
import { getErrorMessage, formatDateTime } from '../../utils/helpers';
import { DRAFT_PREFIX } from '../../utils/draftStore';
import PageHeader from '../../components/common/PageHeader';
import ErrorMessage from '../../components/common/ErrorMessage';
import { CloudIcon, DevicePhoneMobileIcon } from '@heroicons/react/24/outline';

const readDeviceDrafts = (uid) => {
    const out = [];
    try {
        const prefix = `${DRAFT_PREFIX}${uid}:`;
        Object.keys(localStorage).filter(k => k.startsWith(prefix)).forEach(k => {
            try {
                const v = JSON.parse(localStorage.getItem(k));
                out.push({ draft_key: k.slice(prefix.length), title: v.title, page_path: v.page, updated_at: v.savedAt, device: true });
            } catch (_) { /* skip a broken entry */ }
        });
    } catch (_) { /* storage unavailable */ }
    return out;
};

const DraftsPage = () => {
    const { user } = useAuth();
    const confirm = useConfirm();
    const navigate = useNavigate();
    const [rows, setRows] = useState(null);
    const [error, setError] = useState(null);

    const load = useCallback(async () => {
        const device = user?.id ? readDeviceDrafts(user.id) : [];
        let server = [];
        try { server = (await draftsAPI.list()).data.data || []; } catch (err) { setError(getErrorMessage(err)); }
        const map = new Map();
        server.forEach(d => map.set(d.draft_key, { ...d, account: true }));
        device.forEach(d => {
            const s = map.get(d.draft_key);
            if (s) { s.device = true; if (new Date(d.updated_at) > new Date(s.updated_at)) s.updated_at = d.updated_at; }
            else map.set(d.draft_key, d);
        });
        setRows([...map.values()].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)));
    }, [user?.id]);
    useEffect(() => { load(); }, [load]);

    const discard = async (d) => {
        const ok = await confirm({ title: 'Discard this draft?', message: `"${d.title || d.draft_key}" will be thrown away on this device and in your account.`, confirmLabel: 'Discard', danger: true });
        if (!ok) return;
        try { localStorage.removeItem(`${DRAFT_PREFIX}${user.id}:${d.draft_key}`); } catch (_) { /* ignore */ }
        try { await draftsAPI.remove(d.draft_key); } catch (err) { setError(getErrorMessage(err)); }
        load();
    };

    return (
        <div>
            <PageHeader title="Unfinished forms" subtitle="Forms you started and have not submitted yet — open one to carry on where you left off" />
            {error && <div className="mb-4"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}
            <div className="card">
                {!rows ? <p className="text-sm text-gray-400">Loading…</p> : rows.length === 0 ? (
                    <p className="text-sm text-gray-500">Nothing unfinished. Whenever you start filling in a form, what you type is kept here until you submit it.</p>
                ) : (
                    <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                        {rows.map(d => (
                            <li key={d.draft_key} className="py-3 flex items-center gap-3 flex-wrap">
                                <div className="min-w-0 flex-1">
                                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{d.title || d.draft_key}</p>
                                    <p className="text-xs text-gray-500 flex items-center gap-2 flex-wrap">
                                        <span>Last changed {formatDateTime(d.updated_at)}</span>
                                        {d.account && <span className="inline-flex items-center gap-1"><CloudIcon className="h-3.5 w-3.5" />your account</span>}
                                        {d.device && <span className="inline-flex items-center gap-1"><DevicePhoneMobileIcon className="h-3.5 w-3.5" />this device</span>}
                                    </p>
                                </div>
                                <div className="flex gap-2">
                                    {d.page_path && <button type="button" className="btn-primary text-sm" onClick={() => navigate(d.page_path)}>Open</button>}
                                    <button type="button" className="btn-secondary text-sm" onClick={() => discard(d)}>Discard</button>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
            <p className="text-xs text-gray-400 mt-3">
                Drafts are private to you. Signing out yourself removes the copies on this device; the copies in your account stay until the form
                is submitted or you discard them, and are removed after 90 days without changes. Attached files are not kept in a draft.
            </p>
        </div>
    );
};

export default DraftsPage;
