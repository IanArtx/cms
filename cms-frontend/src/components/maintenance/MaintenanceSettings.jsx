// ============================================================
// SETTINGS › MAINTENANCE (v1.74.0) — Admin only
// Switch maintenance mode on and off, set the message members see and
// an optional "expected back by" time, optionally email every member,
// and see the history and the nightly job runs that were paused.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { maintenanceAPI } from '../../api/endpoints';
import { getErrorMessage } from '../../utils/helpers';
import { useConfirm } from '../../contexts/ConfirmContext';
import { useMaintenance } from './MaintenanceGate';
import ErrorMessage from '../common/ErrorMessage';
import LoadingSpinner from '../common/LoadingSpinner';

const fmt = (iso) => {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
    catch (_) { return iso; }
};

// <input type="datetime-local"> works in local time without a zone.
const toLocalInput = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const JOB_LABELS = {
    DailyInterestAccrual: 'Daily loan interest',
    DailySavingsAccrual: 'Daily savings interest',
    DailyOverdueCheck: 'Loan overdue check',
    MonthlyGeneralReport: 'Monthly company report email',
    MonthlyIndividualReports: 'Monthly personal report emails',
    SideFundDueGeneration: 'Side fund monthly dues',
    SideFundDefaultCheck: 'Side fund default check',
    MonthlyShareCertificates: 'Monthly share certificates',
    AnnualShareCertificates: 'Annual share certificates',
    CertificateSigningReminders: 'Certificate signing reminders',
    DocumentSignatureReminders: 'Document signature reminders',
    AuditAccessExpiryReminders: 'Auditor access reminders',
    CapitalGoalCallDeadlines: 'Capital call deadlines',
    ServiceFeePeriodGeneration: 'Service fee months',
    ServiceFeeDueReminders: 'Service fee reminders',
    TaxDeadlineReminders: 'Tax deadline reminders',
};

const MaintenanceSettings = () => {
    const confirm = useConfirm();
    const { refresh } = useMaintenance();
    const [detail, setDetail] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null);
    const [busy, setBusy] = useState(false);
    const [form, setForm] = useState({ message: '', expected_end: '', email_members: false });

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await maintenanceAPI.getAdmin();
            const d = res.data.data;
            setDetail(d);
            setForm(f => ({
                ...f,
                message: d.switch_on ? (d.message || '') : (f.message || d.default_message || ''),
                expected_end: d.switch_on ? toLocalInput(d.expected_end) : f.expected_end,
            }));
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    const submit = async (on) => {
        const ok = await confirm(on && !detail?.switch_on ? {
            title: 'Turn maintenance ON',
            message: 'Everyone except Admins will see the maintenance page straight away and cannot use the system — including anyone with a page already open. Nightly jobs pause until you turn it off.'
                + (form.email_members ? ' Every member will also get an email.' : ''),
            confirmLabel: 'Turn on',
            danger: true,
        } : !on ? {
            title: 'Turn maintenance OFF',
            message: 'Open the system to all members again? Any paused nightly job runs are caught up straight away.'
                + (form.email_members ? ' Every member will get an email that the system is back.' : ''),
            confirmLabel: 'Turn off',
        } : {
            title: 'Save changes', message: 'Update the message / expected time shown on the maintenance page?', confirmLabel: 'Save',
        });
        if (!ok) return;
        setBusy(true); setError(null); setNotice(null);
        try {
            const res = await maintenanceAPI.set({
                on,
                message: form.message || null,
                expected_end: form.expected_end ? new Date(form.expected_end).toISOString() : null,
                email_members: !!form.email_members,
            });
            setNotice(res.data.message);
            setDetail(res.data.data);
            setForm(f => ({ ...f, email_members: false }));
            refresh();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setBusy(false);
        }
    };

    if (loading && !detail) return <LoadingSpinner />;

    const on = !!detail?.on;
    const pendingJobs = (detail?.skipped_jobs_list || []).filter(j => !j.caught_up_at);

    return (
        <div className="space-y-6">
            <div>
                <h3 className="section-title mb-1">Maintenance mode</h3>
                <p className="text-sm text-gray-500 max-w-3xl">
                    Use this while you update the system. Everyone except Admins sees a maintenance page instead of the
                    system and cannot read or record anything (the server itself refuses their requests). Admins keep
                    working and see an amber bar on every page while it is on. Automatic nightly jobs (interest, reports,
                    reminders) are paused and caught up automatically when you turn it off — interest is caught up for
                    every missed day.
                </p>
            </div>

            {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
            {notice && <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">{notice}</div>}

            {/* Current state */}
            <div className={`rounded-xl border p-4 ${on ? 'border-amber-300 bg-amber-50' : 'border-gray-200'}`}>
                <div className="flex items-center gap-3 flex-wrap">
                    <span className={on ? 'badge-yellow' : 'badge-green'}>{on ? 'ON — members locked out' : 'OFF — system open'}</span>
                    {on && <span className="text-sm text-gray-700">since {fmt(detail.started_at)}{detail.started_by_name ? ` by ${detail.started_by_name}` : ''}</span>}
                </div>
                {detail?.forced && (
                    <p className="text-sm text-amber-900 mt-2">
                        Forced on by the server setting <code>MAINTENANCE_MODE</code> in Render (cms-backend › Environment).
                        It stays on until that setting is removed, whatever this switch says.
                    </p>
                )}
                {detail?.db_ok === false && (
                    <p className="text-sm text-red-700 mt-2">The maintenance table can't be read — has <code>migration_v1.74.0.sql</code> been run?</p>
                )}
                {pendingJobs.length > 0 && (
                    <p className="text-sm text-gray-700 mt-2">{pendingJobs.length} nightly job run(s) paused so far — they will run when maintenance is turned off.</p>
                )}
            </div>

            {/* Form */}
            <div className="grid gap-4 max-w-2xl">
                <div>
                    <label className="label">Message members will see</label>
                    <textarea className="input" rows={3} value={form.message}
                        onChange={e => setForm(f => ({ ...f, message: e.target.value }))} />
                </div>
                <div>
                    <label className="label">Expected back by (optional)</label>
                    <input type="datetime-local" className="input max-w-xs" value={form.expected_end}
                        onChange={e => setForm(f => ({ ...f, expected_end: e.target.value }))} />
                </div>
                <label className="flex items-center gap-2 text-sm text-gray-700">
                    <input type="checkbox" checked={form.email_members}
                        onChange={e => setForm(f => ({ ...f, email_members: e.target.checked }))} />
                    Email all members {on ? 'that the system is available again (when turning off)' : 'that maintenance has started'}
                </label>
                <div className="flex gap-3 flex-wrap">
                    {!on && (
                        <button type="button" disabled={busy} onClick={() => submit(true)} className="btn-danger">
                            {busy ? 'Working…' : 'Turn maintenance ON'}
                        </button>
                    )}
                    {on && (
                        <>
                            <button type="button" disabled={busy} onClick={() => submit(true)} className="btn-secondary">
                                Save message / time
                            </button>
                            {!detail?.forced && (
                                <button type="button" disabled={busy} onClick={() => submit(false)} className="btn-primary">
                                    {busy ? 'Working…' : 'Turn maintenance OFF'}
                                </button>
                            )}
                        </>
                    )}
                </div>
            </div>

            {/* Paused jobs */}
            {(detail?.skipped_jobs_list || []).length > 0 && (
                <div>
                    <h4 className="text-sm font-semibold text-gray-800 mb-2">Nightly jobs paused by maintenance</h4>
                    <div className="overflow-x-auto -mx-2">
                        <table className="min-w-full text-sm">
                            <thead>
                                <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                                    <th className="px-2 py-2 font-medium">Job</th>
                                    <th className="px-2 py-2 font-medium">For date</th>
                                    <th className="px-2 py-2 font-medium">Paused at</th>
                                    <th className="px-2 py-2 font-medium">Caught up</th>
                                </tr>
                            </thead>
                            <tbody>
                                {detail.skipped_jobs_list.map(j => (
                                    <tr key={j.id} className="border-b border-gray-50 last:border-0">
                                        <td className="px-2 py-2 text-gray-800">{JOB_LABELS[j.job_name] || j.job_name}</td>
                                        <td className="px-2 py-2 text-gray-600">{j.run_date}</td>
                                        <td className="px-2 py-2 text-gray-500">{fmt(j.skipped_at)}</td>
                                        <td className="px-2 py-2 text-gray-600">
                                            {j.caught_up_at ? `${fmt(j.caught_up_at)} — ${j.result}` : <span className="badge-purple">Waiting</span>}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* History */}
            <div>
                <h4 className="text-sm font-semibold text-gray-800 mb-2">History</h4>
                {(detail?.events || []).length === 0 ? (
                    <p className="text-sm text-gray-400">Maintenance mode has not been used yet.</p>
                ) : (
                    <div className="overflow-x-auto -mx-2">
                        <table className="min-w-full text-sm">
                            <thead>
                                <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                                    <th className="px-2 py-2 font-medium">When</th>
                                    <th className="px-2 py-2 font-medium">What</th>
                                    <th className="px-2 py-2 font-medium">By</th>
                                    <th className="px-2 py-2 font-medium">Message</th>
                                    <th className="px-2 py-2 font-medium">Emailed</th>
                                </tr>
                            </thead>
                            <tbody>
                                {detail.events.map(e => (
                                    <tr key={e.id} className="border-b border-gray-50 last:border-0 align-top">
                                        <td className="px-2 py-2 text-gray-600 whitespace-nowrap">{fmt(e.created_at)}</td>
                                        <td className="px-2 py-2">
                                            <span className={e.event === 'ON' ? 'badge-yellow' : e.event === 'OFF' ? 'badge-green' : 'badge-blue'}>
                                                {e.event === 'ON' ? 'Turned on' : e.event === 'OFF' ? 'Turned off' : 'Updated'}
                                            </span>
                                        </td>
                                        <td className="px-2 py-2 text-gray-600">{e.by_name || '—'}</td>
                                        <td className="px-2 py-2 text-gray-600 max-w-md whitespace-normal">
                                            {e.message || ''}{e.expected_end ? ` (back by ${fmt(e.expected_end)})` : ''}
                                        </td>
                                        <td className="px-2 py-2 text-gray-600">{e.emailed_members ? 'Yes' : 'No'}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
};

export default MaintenanceSettings;
