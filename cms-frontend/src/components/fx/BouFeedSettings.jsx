// ============================================================
// DAILY BoU RATE SETTINGS (v1.83.0) — Settings › Currencies
//   • the daily Bank of Uganda check on / off;
//   • jump limit — a suggestion that moved more than this from the rate
//     on file is flagged ("I have checked this rate" before approving);
//   • transfer warning — a transfer whose bank rate is further than
//     this from the rate on file needs "I have checked the bank's rate".
// Admin or Treasurer may change them; everyone who can see the page
// sees them.
// ============================================================

import { useEffect, useState } from 'react';
import { BuildingLibraryIcon } from '@heroicons/react/24/outline';
import { exchangeRatesAPI } from '../../api/endpoints';
import { getErrorMessage } from '../../utils/helpers';
import ErrorMessage from '../common/ErrorMessage';

const BouFeedSettings = ({ canEdit }) => {
    const [form, setForm] = useState(null);
    const [info, setInfo] = useState(null);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);
    const [saved, setSaved] = useState(null);

    useEffect(() => {
        exchangeRatesAPI.getFeed().then(r => {
            const d = r.data.data;
            setInfo(d);
            setForm({ enabled: d.settings.enabled, jump_limit_pct: String(d.settings.jumpLimitPct), transfer_warn_pct: String(d.settings.transferWarnPct) });
        }).catch(err => { if (err?.response?.status !== 404) setError(getErrorMessage(err)); });
    }, []);

    if (!form) return error ? <ErrorMessage message={error} /> : null;

    const save = async (e) => {
        e.preventDefault();
        setSaving(true); setError(null); setSaved(null);
        try {
            const r = await exchangeRatesAPI.updateFeedSettings({
                enabled: form.enabled,
                jump_limit_pct: parseFloat(form.jump_limit_pct),
                transfer_warn_pct: parseFloat(form.transfer_warn_pct),
            });
            setSaved(r.data.message || 'Saved.');
        } catch (err) { setError(getErrorMessage(err)); } finally { setSaving(false); }
    };

    return (
        <form onSubmit={save} className="rounded-lg border border-gray-200 dark:border-gray-700 p-4 space-y-3" data-tour="bou-settings">
            <div className="flex items-center gap-2">
                <BuildingLibraryIcon className="h-5 w-5 text-emerald-600" />
                <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Daily Bank of Uganda rates</h4>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
                {info?.schedule ? `Checked ${info.schedule}. ` : ''}Each rate is only suggested — a Treasurer,
                Assistant Treasurer or Admin approves it under Money › Accounts. Rates entered by hand are never replaced.
                {info?.settings?.backupConfigured
                    ? ' A backup source (AllRatesToday) is set and is used as a cross-check.'
                    : ' No backup source is set (optional: BOU_RATES_API_KEY on the server).'}
            </p>
            {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
            {saved && <p className="text-sm text-green-700 dark:text-green-400">{saved}</p>}
            <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={form.enabled} disabled={!canEdit}
                    onChange={e => setForm(p => ({ ...p, enabled: e.target.checked }))} />
                Check Bank of Uganda every weekday
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                    <label className="label">Flag a daily rate that moved more than (%)</label>
                    <input type="number" className="input" min="0.1" max="50" step="0.1" required disabled={!canEdit}
                        value={form.jump_limit_pct} onChange={e => setForm(p => ({ ...p, jump_limit_pct: e.target.value }))} />
                </div>
                <div>
                    <label className="label">Ask to check a transfer's bank rate beyond (%)</label>
                    <input type="number" className="input" min="0.1" max="50" step="0.1" required disabled={!canEdit}
                        value={form.transfer_warn_pct} onChange={e => setForm(p => ({ ...p, transfer_warn_pct: e.target.value }))} />
                </div>
            </div>
            {canEdit && (
                <div className="flex justify-end">
                    <button type="submit" className="btn-primary text-sm" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
                </div>
            )}
        </form>
    );
};

export default BouFeedSettings;
