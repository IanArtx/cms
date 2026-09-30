// ============================================================
// MAINTENANCE STATUS BAR (v1.74.0) — the Admin's reminder
// Shown at the top of every page for an Admin while maintenance mode
// is on, so it is never forgotten: since when, by whom, how many
// nightly job runs are paused, and a button to turn it off.
// Reads MaintenanceGate's context (members never get this far).
// ============================================================

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { WrenchScrewdriverIcon } from '@heroicons/react/24/outline';
import { useMaintenance } from './MaintenanceGate';
import { maintenanceAPI } from '../../api/endpoints';
import { useConfirm } from '../../contexts/ConfirmContext';
import { getErrorMessage } from '../../utils/helpers';

const fmt = (iso) => {
    if (!iso) return null;
    try { return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
    catch (_) { return null; }
};

const MaintenanceStatusBar = () => {
    const { status, refresh } = useMaintenance();
    const confirm = useConfirm();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    if (!status?.on) return null;

    const turnOff = async () => {
        const ok = await confirm({
            title: 'Turn maintenance off',
            message: 'Open the system to all members again?' +
                (status.skipped_jobs ? ` The ${status.skipped_jobs} paused nightly job run(s) will be caught up straight away.` : ''),
            confirmLabel: 'Turn off',
        });
        if (!ok) return;
        setBusy(true); setError(null);
        try { await maintenanceAPI.set({ on: false }); refresh(); }
        catch (err) { setError(getErrorMessage(err)); }
        finally { setBusy(false); }
    };

    return (
        <div role="status" className="bg-amber-400 text-amber-950 px-4 md:px-6 py-2 text-sm flex items-center gap-3 flex-wrap">
            <WrenchScrewdriverIcon className="h-5 w-5 flex-shrink-0" />
            <p className="flex-1 min-w-[14rem]">
                <strong>Maintenance mode is ON</strong>
                {status.started_at ? ` since ${fmt(status.started_at)}` : ''}
                {status.started_by_name ? ` (by ${status.started_by_name})` : ''}
                {' — members see the maintenance page; only Admins can use the system.'}
                {status.skipped_jobs > 0 && ` ${status.skipped_jobs} nightly job run(s) paused — they run when you turn it off.`}
                {status.forced && ' Forced by the server setting MAINTENANCE_MODE — remove it in Render to turn off.'}
                {status.db_ok === false && ' The database cannot be read right now.'}
                {error && <span className="block font-semibold">{error}</span>}
            </p>
            <Link to="/settings?tab=maintenance" className="underline font-semibold whitespace-nowrap">Maintenance settings</Link>
            {!status.forced && (
                <button type="button" onClick={turnOff} disabled={busy}
                    className="rounded-md bg-amber-950 text-amber-50 px-3 py-1 font-semibold hover:opacity-90 whitespace-nowrap">
                    {busy ? 'Turning off…' : 'Turn off'}
                </button>
            )}
        </div>
    );
};

export default MaintenanceStatusBar;
