// ============================================================
// EMAIL CONTROLS (v1.88.0)
// "I would also like I can regulate the notification emails rather than
// the system always sending emails ever time".
//
//   <CompanyEmailSettings />  Settings › Email (Admin): per kind of email —
//       Each time / Daily summary / Off, and whether members may change it;
//       a master switch "only essential emails"; the hour of the summary.
//   <MyEmailPreferences />    My Profile › Email notifications (everyone):
//       each person's own choice for the kinds the Admin lets them change.
// The bell notifications in the system are never affected — only email.
// Meeting notices and security emails are always sent.
// ============================================================

import { useEffect, useState } from 'react';
import { emailSettingsAPI } from '../../api/endpoints';
import { getErrorMessage } from '../../utils/helpers';
import ErrorMessage from '../common/ErrorMessage';
import { LockClosedIcon } from '@heroicons/react/24/outline';

const MODE_LABEL = { INSTANT: 'Each time', DIGEST: 'Daily summary', OFF: 'Off' };
const MODES = ['INSTANT', 'DIGEST', 'OFF'];
const hourLabel = (h) => `${String(h).padStart(2, '0')}:00`;

const Segmented = ({ value, onChange, disabled = false, name }) => (
    <div role="radiogroup" aria-label={name} className={`inline-flex rounded-lg border border-gray-200 dark:border-gray-700 p-0.5 text-xs ${disabled ? 'opacity-50' : ''}`}>
        {MODES.map(mo => (
            <button key={mo} type="button" role="radio" aria-checked={value === mo} disabled={disabled} onClick={() => onChange(mo)}
                className={`px-2.5 py-1 rounded-md font-medium whitespace-nowrap ${value === mo
                    ? (mo === 'OFF' ? 'bg-gray-600 text-white' : 'bg-primary-600 text-white')
                    : 'text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-100'}`}>
                {MODE_LABEL[mo]}
            </button>
        ))}
    </div>
);

export const CompanyEmailSettings = () => {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null);
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        emailSettingsAPI.getCompany().then(r => setData(r.data.data)).catch(err => setError(getErrorMessage(err)));
    }, []);
    if (error && !data) return <ErrorMessage message={error} />;
    if (!data) return <p className="text-sm text-gray-400">Loading…</p>;
    if (!data.ready) return <p className="text-sm text-amber-700">Email controls need the v1.88.0 database update — run update_live_database.js first.</p>;

    const setKind = (key, patch) => setData(d => ({ ...d, kinds: d.kinds.map(k => (k.key === key ? { ...k, ...patch } : k)) }));
    const save = async () => {
        setBusy(true); setError(null); setNotice(null);
        try {
            const r = await emailSettingsAPI.saveCompany({
                essential_only: data.essential_only, digest_hour: Number(data.digest_hour),
                kinds: data.kinds.filter(k => !k.always).map(k => ({ key: k.key, mode: k.mode, members_may_change: !!k.members_may_change })),
            });
            setData(r.data.data); setNotice(r.data.message);
        } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
    };

    return (
        <div className="space-y-5">
            <div>
                <h3 className="section-title mb-1">Which emails the system sends</h3>
                <p className="text-sm text-gray-500">
                    Every notification still appears in the bell inside the system — these settings only decide the <strong>emails</strong>.
                    <strong> Each time</strong> sends an email for every event, <strong>Daily summary</strong> collects them into one email a day,
                    <strong> Off</strong> sends none. Tick <em>Members may change</em> to let each person choose differently under My Profile.
                </p>
            </div>
            {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
            {notice && <div className="bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg p-3">{notice}</div>}

            <div className="rounded-xl border border-gray-200 dark:border-gray-700 p-4 grid gap-4 sm:grid-cols-2">
                <label className="flex items-start gap-3">
                    <input type="checkbox" className="mt-1" checked={!!data.essential_only} onChange={e => setData(d => ({ ...d, essential_only: e.target.checked }))} />
                    <span>
                        <span className="text-sm font-medium text-gray-900 dark:text-gray-100">Only essential emails</span>
                        <span className="block text-xs text-gray-500">Pauses every email except meeting notices and sign-in / security emails — for example during data entry or testing.</span>
                    </span>
                </label>
                <div>
                    <label className="label" htmlFor="digest-hour">Daily summary sent at (Kampala time)</label>
                    <select id="digest-hour" className="input max-w-[10rem]" value={data.digest_hour} onChange={e => setData(d => ({ ...d, digest_hour: Number(e.target.value) }))}>
                        {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
                    </select>
                </div>
            </div>

            <div className="divide-y divide-gray-100 dark:divide-gray-800 rounded-xl border border-gray-200 dark:border-gray-700">
                {data.kinds.map(k => (
                    <div key={k.key} className={`p-3 flex flex-col md:flex-row md:items-center gap-2 md:gap-4 ${data.essential_only && !k.always ? 'opacity-60' : ''}`}>
                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-gray-900 dark:text-gray-100 flex items-center gap-1.5">
                                {k.always && <LockClosedIcon className="h-4 w-4 text-gray-400" />}{k.label}
                            </p>
                            <p className="text-xs text-gray-500">{k.description}</p>
                        </div>
                        {k.always ? (
                            <span className="text-xs text-gray-500">Always sent</span>
                        ) : (
                            <div className="flex items-center gap-3 flex-wrap">
                                <Segmented name={k.label} value={k.mode} onChange={mo => setKind(k.key, { mode: mo })} />
                                <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300 whitespace-nowrap">
                                    <input type="checkbox" checked={!!k.members_may_change} disabled={k.mode === 'OFF'}
                                        onChange={e => setKind(k.key, { members_may_change: e.target.checked })} />
                                    Members may change
                                </label>
                            </div>
                        )}
                    </div>
                ))}
            </div>
            <div className="flex justify-end">
                <button type="button" className="btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save email settings'}</button>
            </div>
        </div>
    );
};

export const MyEmailPreferences = () => {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null);
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        emailSettingsAPI.getMine().then(r => setData(r.data.data)).catch(err => setError(getErrorMessage(err)));
    }, []);
    if (error && !data) return <ErrorMessage message={error} />;
    if (!data) return <p className="text-sm text-gray-400">Loading…</p>;
    if (!data.ready) return <p className="text-sm text-gray-500">Email choices become available after the next system update.</p>;

    const choose = async (key, mode) => {
        setBusy(true); setError(null); setNotice(null);
        try {
            const r = await emailSettingsAPI.saveMine({ kinds: [{ key, mode }] });
            setData(r.data.data); setNotice(r.data.message);
        } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
    };

    return (
        <div className="space-y-4">
            <p className="text-sm text-gray-500">
                Choose how you hear about things by email. Everything still appears in the bell inside the system.
                A daily summary arrives once a day at {hourLabel(data.digest_hour)} (Kampala time).
                {data.essential_only && <strong className="block mt-1 text-amber-700">The Admin has paused all but essential emails for now.</strong>}
            </p>
            {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
            {notice && <div className="bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg p-3">{notice}</div>}
            <div className="divide-y divide-gray-100 dark:divide-gray-800 rounded-xl border border-gray-200 dark:border-gray-700">
                {data.kinds.map(k => (
                    <div key={k.key} className="p-3 flex flex-col md:flex-row md:items-center gap-2 md:gap-4">
                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-gray-900 dark:text-gray-100 flex items-center gap-1.5">
                                {!k.can_change && <LockClosedIcon className="h-4 w-4 text-gray-400" />}{k.label}
                            </p>
                            <p className="text-xs text-gray-500">{k.description}</p>
                        </div>
                        {k.can_change ? (
                            <div className="flex items-center gap-2 flex-wrap">
                                <Segmented name={k.label} value={k.effective} onChange={mo => choose(k.key, mo)} disabled={busy} />
                                {k.my_mode && <button type="button" className="text-xs text-gray-500 hover:underline" disabled={busy} onClick={() => choose(k.key, null)} title={`Company setting: ${MODE_LABEL[k.company_mode]}`}>Use company setting</button>}
                            </div>
                        ) : (
                            <span className="text-xs text-gray-500 text-right">{MODE_LABEL[k.effective]} · {k.why_locked}</span>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
};
