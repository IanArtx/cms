// ============================================================
// SHARE CAPITAL PAGE (v1.69.0)
//
// Tabs:
//   Overview        — nominal value, registered vs issued shares (with
//                     the excess to file), issue price and the suggested
//                     price (net asset value per share), members' share
//                     credit, returns of allotment due, the book
//                     reconciliation, and the one-off opening conversion.
//   My Shares       — the signed-in member's own whole shares, share
//                     credit (with every movement) and refunds.
//   Changes         — propose / approve / reject a change to the issue
//                     price, the nominal value (split or consolidation)
//                     or the registered shares. Needs a FINAL board
//                     resolution and two different people: two
//                     Directors, or a Director and the Treasurer. Admin
//                     alone never approves.
//   Allotments      — every allotment, by month, with its return-of-
//                     allotment due date (Companies Act 2012 s.61) and
//                     "mark filed".
//   Credit & Refunds — each member's share credit and refund requests
//                     (requested by Treasury, approved by someone else).
//
// Backend: /api/share-capital (shareCapitalController / shareCapitalService).
// ============================================================

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { shareCapitalAPI, accountsAPI } from '../../api/endpoints';
import { formatDate, getErrorMessage } from '../../utils/helpers';
import PageHeader from '../../components/common/PageHeader';
import LoadingSpinner from '../../components/common/LoadingSpinner';
import ErrorMessage from '../../components/common/ErrorMessage';
import StatusBadge from '../../components/common/StatusBadge';
import { useAuth } from '../../contexts/AuthContext';
import { useConfirm } from '../../contexts/ConfirmContext';
import { RegisteredByMemberTab } from './RegisteredByMember'; // v1.81.0
import {
    ScaleIcon,
    ExclamationTriangleIcon,
    CheckCircleIcon,
    InformationCircleIcon,
    XMarkIcon,
} from '@heroicons/react/24/outline';

const money = (n, dp = 2) => (n === null || n === undefined || Number.isNaN(Number(n))
    ? '—'
    : Number(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }));
const whole = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }));

const CHANGE_TYPES = {
    ISSUE_PRICE: 'Issue price per share',
    NOMINAL_VALUE: 'Nominal value per share (split / consolidation)',
    REGISTERED_SHARES: 'Number of registered shares',
};

const SOURCE_LABELS = {
    CONTRIBUTION: 'Contribution',
    OPENING_CONVERSION: 'Opening conversion',
    SPLIT: 'Share split',
    CONSOLIDATION: 'Consolidation',
};

const CREDIT_LABELS = {
    CONTRIBUTION: 'Contribution received',
    ALLOTMENT: 'Whole shares allotted',
    REFUND: 'Refund paid',
    CONSOLIDATION_LEFTOVER: 'Consolidation leftover',
    CONTRIBUTION_REVERSAL: 'Contribution reversed',
    ALLOTMENT_REVERSAL: 'Allotment cancelled',
};

const Tabs = ({ tabs, active, onChange }) => (
    <div className="tab-bar" role="tablist">
        {tabs.map(t => (
            <button
                key={t.key}
                onClick={() => onChange(t.key)}
                className={`tab ${active === t.key ? 'tab-active' : ''}`}
            >
                {t.label}
                {t.count ? <span className="tab-count-alert">{t.count}</span> : null}
            </button>
        ))}
    </div>
);

const Stat = ({ label, value, sub, tone = 'default' }) => (
    <div className={`card ${tone === 'warn' ? 'border border-amber-300 bg-amber-50' : ''}`}>
        <p className="text-sm font-medium text-gray-500">{label}</p>
        <p className="text-2xl font-bold text-gray-900 mt-1">{value}</p>
        {sub && <p className="text-xs text-gray-500 mt-1">{sub}</p>}
    </div>
);

const Note = ({ children, tone = 'info' }) => (
    <div className={`flex gap-2 p-3 rounded-lg text-sm mb-4 ${tone === 'warn'
        ? 'bg-amber-50 text-amber-900 border border-amber-200'
        : 'bg-blue-50 text-blue-900 border border-blue-100'}`}>
        {tone === 'warn'
            ? <ExclamationTriangleIcon className="h-5 w-5 flex-shrink-0" />
            : <InformationCircleIcon className="h-5 w-5 flex-shrink-0" />}
        <div>{children}</div>
    </div>
);

// ============================================================
// REGISTERED VALUES — nominal value per share and number of registered
// shares, with their history. Entered here by a Director or the
// Treasurer; editable until the first shares are allotted, then only
// through the Changes tab (resolution + two approvers).
// ============================================================
const RegisteredValuesCard = ({ canEdit, onSaved }) => {
    const [setup, setSetup] = useState(null);
    const [editing, setEditing] = useState(false);
    const [rows, setRows] = useState([]);
    const [currencyId, setCurrencyId] = useState('');
    const [notes, setNotes] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    const load = useCallback(() => {
        shareCapitalAPI.getRegisteredSetup()
            .then(res => setSetup(res.data.data))
            .catch(err => setError(getErrorMessage(err)));
    }, []);
    useEffect(() => { load(); }, [load]);

    if (!setup) return null;
    const cur = setup.history[0]?.currency_code || setup.issuePrice?.currencyCode || '';
    const empty = setup.history.length === 0;

    const startEdit = () => {
        setRows(empty
            ? [{ effective_from: setup.firstContributionDate || new Date().toISOString().split('T')[0], nominal_value: '', registered_shares: '' }]
            : setup.history.map(h => ({ effective_from: h.effective_from, nominal_value: h.nominal_value, registered_shares: h.registered_shares ?? '' })));
        setCurrencyId(String(setup.history[0]?.currency_id || setup.issuePrice?.currencyId || ''));
        setNotes('');
        setError(null);
        setEditing(true);
    };
    const setRow = (i, k, v) => setRows(p => p.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
    const addRow = () => {
        const last = rows[rows.length - 1] || {};
        setRows(p => [...p, { effective_from: new Date().toISOString().split('T')[0], nominal_value: last.nominal_value || '', registered_shares: last.registered_shares || '' }]);
    };
    const save = async () => {
        setBusy(true); setError(null);
        try {
            await shareCapitalAPI.saveRegisteredSetup({
                currency_id: Number(currencyId),
                notes: notes || undefined,
                rows: rows.map(r => ({
                    effective_from: r.effective_from,
                    nominal_value: Number(r.nominal_value),
                    registered_shares: r.registered_shares === '' || r.registered_shares === null ? null : Number(r.registered_shares),
                })),
            });
            setEditing(false);
            load(); onSaved();
        } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
    };

    const sorted = [...rows].sort((a, b) => (a.effective_from < b.effective_from ? -1 : 1));
    const firstFrom = sorted[0]?.effective_from;
    const startsLate = setup.firstContributionDate && firstFrom && firstFrom > setup.firstContributionDate;

    return (
        <div className={`card mb-6 ${empty ? 'border border-amber-300' : ''}`}>
            <div className="flex justify-between items-start flex-wrap gap-2 mb-2">
                <div>
                    <h3 className="text-base font-semibold text-gray-900">Registered values</h3>
                    <p className="text-sm text-gray-600">
                        The nominal (par) value of one ordinary share and the number of shares registered with URSB, as
                        on the company's registration documents — with every change and the date it applied from.
                    </p>
                </div>
                {canEdit && !setup.locked && !editing && (
                    <button onClick={startEdit} className="btn-primary text-sm">{empty ? 'Enter registered values' : 'Edit'}</button>
                )}
            </div>
            {error && <div className="mb-3"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}

            {!editing && (empty ? (
                <Note tone="warn">
                    Not entered yet. {canEdit ? 'Enter them before running the opening conversion — it uses them for every allotment.' : 'A Director or the Treasurer must enter them before the opening conversion can run.'}
                </Note>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-left text-gray-500 border-b">
                                <th className="py-2 pr-3">From</th><th className="py-2 pr-3">To</th>
                                <th className="py-2 pr-3 text-right">Nominal value ({cur})</th><th className="py-2 pr-3 text-right">Registered shares</th>
                                <th className="py-2 pr-3 text-right">Registered capital ({cur})</th><th className="py-2">Set by</th>
                            </tr>
                        </thead>
                        <tbody>
                            {setup.history.map(h => (
                                <tr key={h.id} className="border-b border-gray-100">
                                    <td className="py-2 pr-3">{formatDate(h.effective_from)}</td>
                                    <td className="py-2 pr-3">{h.effective_to ? formatDate(h.effective_to) : 'current'}</td>
                                    <td className="py-2 pr-3 text-right">{money(h.nominal_value, 0)}</td>
                                    <td className="py-2 pr-3 text-right">{h.registered_shares ? whole(h.registered_shares) : '—'}</td>
                                    <td className="py-2 pr-3 text-right">{h.registered_shares ? money(h.registered_shares * h.nominal_value, 0) : '—'}</td>
                                    <td className="py-2 text-xs text-gray-500">{h.set_by_name || '—'}{h.change_request_id ? ' (approved change)' : ''}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    <p className="text-xs text-gray-500 mt-2">
                        {setup.locked
                            ? 'Shares have been allotted under these values, so they are now locked. To change the nominal value or the number of registered shares, use the Changes tab (board resolution + two approvers).'
                            : 'No shares have been allotted yet, so a Director or the Treasurer can still correct these. They lock once the first shares are allotted (the opening conversion or the first contribution).'}
                    </p>
                </div>
            ))}

            {editing && (
                <div className="space-y-3">
                    <p className="text-sm text-gray-600">
                        One row per period. If the registered shares (or nominal value) changed at some point, add a row
                        starting on the date the change was registered. Leave "Registered shares" empty if you don't know it.
                    </p>
                    <div className="max-w-xs">
                        <label className="label">Currency of the nominal value *</label>
                        <select className="input" value={currencyId} onChange={e => setCurrencyId(e.target.value)}>
                            <option value="">Select...</option>
                            {setup.currencies.map(c => <option key={c.id} value={c.id}>{c.code}</option>)}
                        </select>
                        {setup.issuePrice && <p className="text-xs text-gray-500 mt-1">Must match the share price currency ({setup.issuePrice.currencyCode}).</p>}
                    </div>
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-left text-gray-500 border-b">
                                    <th className="py-2 pr-3">Applies from *</th><th className="py-2 pr-3">Nominal value per share *</th>
                                    <th className="py-2 pr-3">Registered shares</th><th className="py-2 pr-3 text-right">Registered capital</th><th />
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((r, i) => (
                                    <tr key={i} className="border-b border-gray-100">
                                        <td className="py-2 pr-3"><input type="date" className="input" value={r.effective_from} onChange={e => setRow(i, 'effective_from', e.target.value)} /></td>
                                        <td className="py-2 pr-3"><input type="number" className="input" min="0" step="0.01" value={r.nominal_value} onChange={e => setRow(i, 'nominal_value', e.target.value)} /></td>
                                        <td className="py-2 pr-3"><input type="number" className="input" min="1" step="1" value={r.registered_shares} onChange={e => setRow(i, 'registered_shares', e.target.value)} placeholder="e.g. 600" /></td>
                                        <td className="py-2 pr-3 text-right whitespace-nowrap">{r.nominal_value && r.registered_shares ? money(Number(r.nominal_value) * Number(r.registered_shares), 0) : '—'}</td>
                                        <td className="py-2 text-right">{rows.length > 1 && <button onClick={() => setRows(p => p.filter((_, j) => j !== i))} className="text-xs text-red-600 hover:underline">Remove</button>}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <button onClick={addRow} className="text-sm text-primary-600 hover:underline">+ Add a later change</button>
                    {startsLate && (
                        <Note tone="warn">
                            The first row starts on {formatDate(firstFrom)}, but the first contribution was on {formatDate(setup.firstContributionDate)}.
                            The first row will also be used for those earlier contributions — start it on or before {formatDate(setup.firstContributionDate)} if that is not right.
                        </Note>
                    )}
                    {setup.issuePrice && rows.some(r => Number(r.nominal_value) > setup.issuePrice.value) && (
                        <Note tone="warn">
                            A nominal value above the current share price ({money(setup.issuePrice.value, 0)}) would mean shares issued below nominal value. Check the figures.
                        </Note>
                    )}
                    <div>
                        <label className="label">Note (optional)</label>
                        <input type="text" className="input" value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. From the certificate of incorporation / URSB form" />
                    </div>
                    <div className="flex gap-3">
                        <button onClick={save} disabled={busy} className="btn-primary">{busy ? 'Saving...' : 'Save registered values'}</button>
                        <button onClick={() => setEditing(false)} className="btn-secondary">Cancel</button>
                    </div>
                </div>
            )}
        </div>
    );
};

// ============================================================
// OVERVIEW
// ============================================================
const OpeningConversionPanel = ({ overview, canConvert, onDone }) => {
    const confirm = useConfirm();
    const [preview, setPreview] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    if (overview.openingConverted) return null;

    const loadPreview = async () => {
        setBusy(true); setError(null);
        try {
            const res = await shareCapitalAPI.previewOpeningConversion();
            setPreview(res.data.data);
        } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
    };
    const commit = async () => {
        const ok = await confirm({
            title: 'Run the opening conversion',
            message: `This turns every approved contribution to date into whole shares (${preview.totalShares} in total) plus share credit (${money(preview.totalCredit)}). It can only be run once.`,
            confirmLabel: 'Convert',
        });
        if (!ok) return;
        setBusy(true); setError(null);
        try {
            await shareCapitalAPI.runOpeningConversion();
            onDone();
        } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
    };

    return (
        <div className="card mb-6 border border-amber-300">
            <h3 className="text-base font-semibold text-gray-900 mb-2">Opening conversion — required once</h3>
            <p className="text-sm text-gray-600 mb-3">
                Until now each member's holding could include fractions of a share. From v1.69.0 only whole shares are
                allotted, and money that does not buy a whole share stays with the member as <strong>share credit</strong>,
                used first at their next contribution (or refunded). The conversion replays every approved contribution,
                oldest first, at the share price that applied <em>on that contribution's own date</em>, so no past holding is
                re-priced. New contributions are refused until this has been done.
            </p>
            {error && <div className="mb-3"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}
            {!canConvert && <p className="text-sm text-amber-800">Ask the Treasurer or an Admin to run it.</p>}
            {!overview.nominal && <p className="text-sm text-amber-800">First enter the registered values below (nominal value and registered shares).</p>}
            {canConvert && overview.nominal && !preview && (
                <button onClick={loadPreview} disabled={busy} className="btn-primary">
                    {busy ? 'Working...' : 'Preview the conversion'}
                </button>
            )}
            {preview && (
                <>
                    <div className="overflow-x-auto mt-2">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-left text-gray-500 border-b">
                                    <th className="py-2 pr-4">Member</th>
                                    <th className="py-2 pr-4 text-right">Contributions</th>
                                    <th className="py-2 pr-4 text-right">Paid in ({overview.currencyCode})</th>
                                    <th className="py-2 pr-4 text-right">Old shares</th>
                                    <th className="py-2 pr-4 text-right">Whole shares</th>
                                    <th className="py-2 pr-4 text-right">Share credit</th>
                                    <th className="py-2 text-right">New %</th>
                                </tr>
                            </thead>
                            <tbody>
                                {preview.members.map(m => (
                                    <tr key={m.userId} className="border-b border-gray-100">
                                        <td className="py-2 pr-4">{m.name}</td>
                                        <td className="py-2 pr-4 text-right">{m.contributions}</td>
                                        <td className="py-2 pr-4 text-right">{money(m.paidIn)}</td>
                                        <td className="py-2 pr-4 text-right">{Number(m.oldSharesHeld).toLocaleString('en-US', { maximumFractionDigits: 4 })}</td>
                                        <td className="py-2 pr-4 text-right font-semibold">{whole(m.newWholeShares)}</td>
                                        <td className="py-2 pr-4 text-right">{money(m.creditLeft)}</td>
                                        <td className="py-2 text-right">{money(m.newPercentage, 4)}%</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <p className="text-sm text-gray-600 mt-3">
                        Total: <strong>{whole(preview.totalShares)}</strong> whole shares; members' share credit{' '}
                        <strong>{overview.currencyCode} {money(preview.totalCredit)}</strong>.
                        {preview.registeredShares !== null && preview.sharesBeyondRegistered > 0 && (
                            <> {whole(preview.sharesBeyondRegistered)} share(s) go beyond the {whole(preview.registeredShares)} registered.</>
                        )}
                    </p>
                    {preview.allottedBelowNominal?.length > 0 && (
                        <Note tone="warn">
                            {preview.allottedBelowNominal.length} contribution(s) bought shares at a price below the nominal value
                            (shown as a negative share premium). Please check the share price history.
                        </Note>
                    )}
                    <div className="flex gap-3 mt-3">
                        <button onClick={commit} disabled={busy} className="btn-primary">{busy ? 'Converting...' : 'Confirm & convert'}</button>
                        <button onClick={() => setPreview(null)} className="btn-secondary">Close preview</button>
                    </div>
                </>
            )}
        </div>
    );
};

const OverviewTab = ({ overview, canConvert, canEditRegistered, onReload, onOpenStatement }) => {
    const cur = overview.currencyCode || '';
    const reg = overview.registeredShares;
    const usedPct = reg ? Math.min(100, (overview.sharesInIssue / reg) * 100) : null;
    const rec = overview.reconciliation;

    return (
        <div>
            <OpeningConversionPanel overview={overview} canConvert={canConvert} onDone={onReload} />
            {!overview.registeredSetupLocked && <RegisteredValuesCard canEdit={canEditRegistered} onSaved={onReload} />}

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
                <Stat
                    label="Nominal value per share"
                    value={overview.nominal ? `${cur} ${money(overview.nominal.value, 0)}` : 'Not set'}
                    sub={overview.nominal ? `Registered value, since ${formatDate(overview.nominal.effectiveFrom)}` : null}
                />
                <Stat
                    label="Issue price per share"
                    value={overview.issuePrice ? `${cur} ${money(overview.issuePrice.value, 0)}` : 'Not set'}
                    sub={overview.scheduledIssuePrices?.length
                        ? `Changes to ${cur} ${money(overview.scheduledIssuePrices[0].value, 0)} on ${formatDate(overview.scheduledIssuePrices[0].effectiveFrom)}`
                        : (overview.issuePrice ? `Since ${formatDate(overview.issuePrice.effectiveFrom)}` : null)}
                />
                <Stat
                    label="Shares in issue"
                    value={whole(overview.sharesInIssue)}
                    sub={reg ? `of ${whole(reg)} registered with URSB` : 'Registered number not recorded'}
                    tone={overview.sharesBeyondRegistered > 0 ? 'warn' : 'default'}
                />
                <Stat
                    label="Members' share credit"
                    value={`${cur} ${money(overview.totalMemberCredit)}`}
                    sub="Paid in, not yet enough for a whole share"
                />
            </div>

            {reg ? (
                <div className="card mb-6">
                    <div className="flex justify-between text-sm mb-2">
                        <span className="font-medium text-gray-700">Registered share capital used</span>
                        <span className="text-gray-500">{whole(overview.sharesInIssue)} / {whole(reg)} shares</span>
                    </div>
                    <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                        <div className={`h-full ${overview.sharesBeyondRegistered > 0 ? 'bg-amber-500' : 'bg-primary-600'}`} style={{ width: `${usedPct}%` }} />
                    </div>
                    {overview.sharesBeyondRegistered > 0 ? (
                        <Note tone="warn">
                            <strong>{whole(overview.sharesBeyondRegistered)} share(s)</strong> ({cur} {money(overview.excessNominalValue, 0)} at nominal value)
                            have been allotted beyond the {whole(reg)} registered. The system keeps allotting (the companies issue
                            shares monthly) but the registered share capital should be increased: an ordinary resolution of the
                            members, then notice to the Registrar (Companies Act 2012 s.72–73 — confirm the filing deadline with URSB).
                            Record the new number under <em>Changes</em> once it is registered.
                        </Note>
                    ) : (
                        <p className="text-xs text-gray-500 mt-2">
                            Registered share capital: {cur} {money(overview.registeredCapitalValue, 0)} ({whole(reg)} × {money(overview.nominal?.value, 0)}).
                        </p>
                    )}
                </div>
            ) : null}

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
                <div className="card">
                    <h3 className="text-base font-semibold text-gray-900 mb-2">Suggested issue price</h3>
                    {overview.nav ? (
                        <>
                            <table className="w-full text-sm">
                                <tbody>
                                    <tr><td className="py-1 text-gray-500">Total equity (Balance Sheet, {formatDate(overview.nav.asOfDate)})</td><td className="py-1 pl-3 text-right whitespace-nowrap">{cur} {money(overview.nav.totalEquity)}</td></tr>
                                    <tr><td className="py-1 text-gray-500">less capital pending allotment (share credit)</td><td className="py-1 pl-3 text-right whitespace-nowrap">− {money(overview.nav.capitalPendingAllotment)}</td></tr>
                                    <tr><td className="py-1 text-gray-500">Equity belonging to the shares in issue</td><td className="py-1 pl-3 text-right whitespace-nowrap">{cur} {money(overview.nav.equityForShares)}</td></tr>
                                    <tr><td className="py-1 text-gray-500">÷ whole shares in issue</td><td className="py-1 pl-3 text-right whitespace-nowrap">{whole(overview.nav.sharesInIssue)}</td></tr>
                                    <tr className="font-semibold"><td className="py-1">Net asset value (NAV) per share</td><td className="py-1 pl-3 text-right whitespace-nowrap">{cur} {money(overview.nav.navPerShare)}</td></tr>
                                    <tr className="font-semibold"><td className="py-1">Suggested issue price — NAV rounded to the nearest 1,000, never below nominal</td><td className="py-1 pl-3 text-right whitespace-nowrap">{cur} {money(overview.suggestedIssuePriceRounded, 0)}</td></tr>
                                </tbody>
                            </table>
                            <p className="text-xs text-gray-500 mt-2">
                                Current policy: shares are issued at the issue price above{overview.issuePrice && overview.nominal && Math.abs(overview.issuePrice.value - overview.nominal.value) < 0.01 ? ' (the nominal value)' : ''}.
                                The NAV is a guide only — issuing below it gives new money a share of reserves built up by existing members.
                                {overview.nav.provisional ? ' This month is not closed yet, so the figures include a provisional FX revaluation.' : ''}
                                {overview.nav.unconvertedCount ? ` ${overview.nav.unconvertedCount} transaction(s) have no UGX value yet and are left out.` : ''}
                            </p>
                        </>
                    ) : (
                        <p className="text-sm text-gray-500">{overview.navError || 'Available after the opening conversion.'}</p>
                    )}
                </div>

                <div className="card">
                    <h3 className="text-base font-semibold text-gray-900 mb-2">Returns of allotment</h3>
                    <p className="text-sm text-gray-600 mb-2">
                        Every allotment must be reported to the Registrar within {overview.allotmentReturnDays} days
                        (Companies Act 2012 s.61). Most practical: one return per month.
                    </p>
                    <p className="text-sm">Not yet filed: <strong>{whole(overview.returns.pending)}</strong> allotment(s)
                        {overview.returns.overdue > 0 && <span className="text-red-600 font-semibold"> — {whole(overview.returns.overdue)} overdue</span>}
                    </p>
                    {overview.returns.nextDue && <p className="text-sm text-gray-500">Earliest due: {formatDate(overview.returns.nextDue)}</p>}
                    {rec && (
                        <>
                            <h3 className="text-base font-semibold text-gray-900 mt-4 mb-2">Books check</h3>
                            <table className="w-full text-sm">
                                <tbody>
                                    <tr>
                                        <td className="py-1 text-gray-500">3000 Share Capital vs allotments</td>
                                        <td className="py-1 pl-3 text-right whitespace-nowrap">{money(rec.ledger3000)} / {money(rec.allotments3000)}</td>
                                        <td className="py-1 pl-2">{Math.abs(rec.difference3000) < 1 ? <CheckCircleIcon className="h-5 w-5 text-green-600" /> : <ExclamationTriangleIcon className="h-5 w-5 text-amber-600" />}</td>
                                    </tr>
                                    <tr>
                                        <td className="py-1 text-gray-500">3020 Capital Pending Allotment vs members' credit</td>
                                        <td className="py-1 pl-3 text-right whitespace-nowrap">{money(rec.ledger3020)} / {money(rec.memberCredit)}</td>
                                        <td className="py-1 pl-2">{Math.abs(rec.difference) < 1 ? <CheckCircleIcon className="h-5 w-5 text-green-600" /> : <ExclamationTriangleIcon className="h-5 w-5 text-amber-600" />}</td>
                                    </tr>
                                </tbody>
                            </table>
                            {(Math.abs(rec.difference) >= 1 || Math.abs(rec.difference3000) >= 1) && (
                                <p className="text-xs text-amber-700 mt-1">
                                    A difference usually means an exchange rate was added or changed for a date after the contribution
                                    was recorded, so the transaction's UGX value moved. Check Reports &gt; FX &amp; Revaluation.
                                </p>
                            )}
                        </>
                    )}
                </div>
            </div>

            {overview.registeredSetupLocked && <RegisteredValuesCard canEdit={canEditRegistered} onSaved={onReload} />}

            {overview.canSeeMembers && overview.members?.length > 0 && (
                <div className="card">
                    <h3 className="text-base font-semibold text-gray-900 mb-3">Register of members — whole shares and credit</h3>
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-left text-gray-500 border-b">
                                    <th className="py-2 pr-4">Member</th>
                                    <th className="py-2 pr-4 text-right">Shares</th>
                                    <th className="py-2 pr-4 text-right">% of company</th>
                                    <th className="py-2 pr-4 text-right">Share credit ({cur})</th>
                                    <th className="py-2"></th>
                                </tr>
                            </thead>
                            <tbody>
                                {overview.members.map(m => (
                                    <tr key={m.userId} className="border-b border-gray-100">
                                        <td className="py-2 pr-4">{m.name}</td>
                                        <td className="py-2 pr-4 text-right font-semibold">{whole(m.shares)}</td>
                                        <td className="py-2 pr-4 text-right">{money(m.percentage, 4)}%</td>
                                        <td className={`py-2 pr-4 text-right ${m.credit < 0 ? 'text-red-600' : ''}`}>{money(m.credit)}</td>
                                        <td className="py-2 text-right">
                                            <button onClick={() => onOpenStatement(m.userId)} className="text-primary-600 hover:underline text-xs">Statement</button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <p className="text-xs text-gray-500 mt-2">A negative credit means a reversed contribution had already been used for shares; the member's next contribution fills it first.</p>
                </div>
            )}
        </div>
    );
};

// ============================================================
// MEMBER STATEMENT (own tab + modal for Treasury)
// ============================================================
const StatementView = ({ statement }) => {
    if (!statement) return null;
    const cur = statement.creditEntries[0]?.currency_code || statement.allotments[0]?.currency_code || '';
    return (
        <div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                <Stat label="Whole shares held" value={whole(statement.sharesHeld)} sub={statement.percentage !== null ? `${money(statement.percentage, 4)}% of the company` : null} />
                <Stat label="Share credit" value={`${cur} ${money(statement.creditBalance)}`} sub="Used first at the next contribution; refundable on request" tone={statement.creditBalance < 0 ? 'warn' : 'default'} />
                <Stat label="Allotments" value={whole(statement.allotments.filter(a => a.status === 'ACTIVE').length)} />
            </div>

            <div className="card mb-6">
                <h3 className="text-base font-semibold text-gray-900 mb-3">Shares allotted</h3>
                {statement.allotments.length === 0 ? <p className="text-sm text-gray-500">None yet.</p> : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-left text-gray-500 border-b">
                                    <th className="py-2 pr-3">Date</th><th className="py-2 pr-3">Reference</th><th className="py-2 pr-3">How</th>
                                    <th className="py-2 pr-3 text-right">Shares</th><th className="py-2 pr-3 text-right">Issue price</th>
                                    <th className="py-2 pr-3 text-right">Nominal</th><th className="py-2 text-right">Status</th>
                                </tr>
                            </thead>
                            <tbody>
                                {statement.allotments.map(a => (
                                    <tr key={a.id} className="border-b border-gray-100">
                                        <td className="py-2 pr-3">{formatDate(a.allotment_date)}</td>
                                        <td className="py-2 pr-3 font-mono text-xs">{a.reference_code}</td>
                                        <td className="py-2 pr-3">{SOURCE_LABELS[a.source] || a.source}</td>
                                        <td className="py-2 pr-3 text-right font-semibold">{a.shares > 0 ? '+' : ''}{whole(a.shares)}</td>
                                        <td className="py-2 pr-3 text-right">{money(a.issue_price, 0)}</td>
                                        <td className="py-2 pr-3 text-right">{money(a.nominal_value, 0)}</td>
                                        <td className="py-2 text-right"><StatusBadge status={a.status} /></td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            <div className="card mb-6">
                <h3 className="text-base font-semibold text-gray-900 mb-3">Share credit movements</h3>
                {statement.creditEntries.length === 0 ? <p className="text-sm text-gray-500">None yet.</p> : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-left text-gray-500 border-b">
                                    <th className="py-2 pr-3">Date</th><th className="py-2 pr-3">Movement</th><th className="py-2 pr-3">Details</th>
                                    <th className="py-2 pr-3 text-right">Amount ({cur})</th><th className="py-2 text-right">Balance</th>
                                </tr>
                            </thead>
                            <tbody>
                                {statement.creditEntries.map(e => (
                                    <tr key={e.id} className="border-b border-gray-100">
                                        <td className="py-2 pr-3">{formatDate(e.entry_date)}</td>
                                        <td className="py-2 pr-3">{CREDIT_LABELS[e.entry_type] || e.entry_type}</td>
                                        <td className="py-2 pr-3 text-xs text-gray-500">
                                            {e.contribution_reference && <span className="font-mono mr-1">{e.contribution_reference}</span>}
                                            {e.entry_type === 'CONTRIBUTION' && e.original_currency_code && e.original_currency_code !== e.currency_code
                                                ? `${e.original_currency_code} ${money(e.original_amount)} @ ${Number(e.rate_used).toLocaleString('en-US', { maximumFractionDigits: 6 })}`
                                                : (e.notes || '')}
                                        </td>
                                        <td className={`py-2 pr-3 text-right ${e.amount < 0 ? 'text-red-600' : 'text-green-700'}`}>{e.amount > 0 ? '+' : ''}{money(e.amount)}</td>
                                        <td className="py-2 text-right font-medium">{money(e.balance)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {statement.refunds.length > 0 && (
                <div className="card">
                    <h3 className="text-base font-semibold text-gray-900 mb-3">Credit refunds</h3>
                    <RefundsTable refunds={statement.refunds} />
                </div>
            )}
        </div>
    );
};

const StatementModal = ({ userId, onClose }) => {
    const [statement, setStatement] = useState(null);
    const [error, setError] = useState(null);
    useEffect(() => {
        if (!userId) return;
        setStatement(null);
        shareCapitalAPI.getMemberStatement(userId)
            .then(res => setStatement(res.data.data))
            .catch(err => setError(getErrorMessage(err)));
    }, [userId]);
    if (!userId) return null;
    return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            <div className="fixed inset-0 bg-black bg-opacity-40" onClick={onClose} />
            <div className="flex min-h-full items-start justify-center p-4">
                <div className="relative bg-gray-50 rounded-xl shadow-xl max-w-5xl w-full p-6 mt-8">
                    <div className="flex justify-between items-center mb-4">
                        <h2 className="text-lg font-semibold text-gray-900">Share capital statement — {statement?.member?.name || ''}</h2>
                        <button onClick={onClose} className="p-1 rounded hover:bg-gray-200"><XMarkIcon className="h-5 w-5" /></button>
                    </div>
                    {error && <ErrorMessage message={error} />}
                    {!statement && !error && <p className="text-sm text-gray-500">Loading...</p>}
                    <StatementView statement={statement} />
                </div>
            </div>
        </div>
    );
};

const MySharesTab = () => {
    const [statement, setStatement] = useState(null);
    const [error, setError] = useState(null);
    useEffect(() => {
        shareCapitalAPI.getMyStatement()
            .then(res => setStatement(res.data.data))
            .catch(err => setError(getErrorMessage(err)));
    }, []);
    if (error) return <ErrorMessage message={error} />;
    if (!statement) return <LoadingSpinner text="Loading your shares..." />;
    return (
        <div>
            <Note>
                Shares are allotted in whole shares at every contribution, at the issue price on the contribution date.
                Whatever does not buy a whole share stays as your <strong>share credit</strong> and is used first at your next
                contribution. You can ask the Treasurer to refund it.
            </Note>
            <StatementView statement={statement} />
        </div>
    );
};

// ============================================================
// CHANGES
// ============================================================
const ProposeChangeForm = ({ overview, onDone }) => {
    // v1.69.2 — a new issue price starts pre-filled with the suggested
    // price (NAV per share rounded to the nearest 1,000, never below
    // nominal) and its reason; both can be changed. If the price is
    // changed away from the suggestion, the auto-filled reason is
    // cleared so it can't describe a figure that isn't being proposed.
    const suggested = overview.suggestedIssuePriceRounded;
    const suggestedReason = overview.suggestedReason || '';
    const suggestionUsable = suggested !== null && suggested !== undefined
        && overview.issuePrice && Math.abs(suggested - overview.issuePrice.value) >= 0.01;
    const initialIssueFields = suggestionUsable
        ? { proposed_value: String(suggested), reason: suggestedReason }
        : { proposed_value: '', reason: '' };
    const [form, setForm] = useState({
        change_type: 'ISSUE_PRICE',
        ...initialIssueFields,
        effective_date: new Date().toISOString().split('T')[0],
        resolution_document_id: '',
    });
    const [reasonIsAuto, setReasonIsAuto] = useState(suggestionUsable && !!suggestedReason);
    const [resolutions, setResolutions] = useState([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        shareCapitalAPI.getResolutions().then(res => setResolutions(res.data.data || [])).catch(() => {});
    }, []);

    const cur = overview.currencyCode || '';
    const nominal = overview.nominal?.value;
    const issue = overview.issuePrice?.value;
    const proposed = parseFloat(form.proposed_value);

    // Live explanation of what the change would do.
    const explanation = useMemo(() => {
        if (!(proposed > 0)) return null;
        if (form.change_type === 'ISSUE_PRICE') {
            if (nominal && proposed < nominal) return { tone: 'warn', text: `Below the nominal value (${money(nominal, 0)}) — not allowed (a discount needs s.68 conditions).` };
            const premium = nominal ? proposed - nominal : 0;
            return { tone: 'info', text: `New shares would cost ${cur} ${money(proposed, 0)} each: ${cur} ${money(nominal, 0)} to share capital and ${cur} ${money(premium, 0)} to share premium. Holdings already allotted do not change.` };
        }
        if (form.change_type === 'NOMINAL_VALUE') {
            if (!nominal) return null;
            const split = proposed < nominal;
            const f = split ? nominal / proposed : proposed / nominal;
            if (Math.abs(f - Math.round(f)) > 1e-9 || Math.round(f) < 2) {
                return { tone: 'warn', text: `Must be an exact split or consolidation — e.g. ${money(nominal / 2, 0)} (1 share → 2) or ${money(nominal * 2, 0)} (2 shares → 1).` };
            }
            const k = Math.round(f);
            const ex = 7;
            return split
                ? { tone: 'info', text: `SPLIT 1 → ${k}: every share becomes ${k} shares of ${cur} ${money(proposed, 0)}. A member with ${ex} shares will hold ${ex * k}. The issue price becomes ${cur} ${money(issue / k, 0)} and the registered shares ${overview.registeredShares ? whole(overview.registeredShares * k) : '—'}. Nobody's value changes.` }
                : { tone: 'info', text: `CONSOLIDATION ${k} → 1: every ${k} shares become 1 share of ${cur} ${money(proposed, 0)}. A member with ${ex} shares will hold ${Math.floor(ex / k)}, and the ${ex % k} leftover old share(s) (${cur} ${money((ex % k) * nominal, 0)} at nominal) go back to their share credit. The issue price becomes ${cur} ${money(issue * k, 0)} and the registered shares ${overview.registeredShares ? whole(Math.floor(overview.registeredShares / k)) : '—'}. Takes effect the day it is approved.` };
        }
        if (form.change_type === 'REGISTERED_SHARES') {
            if (!Number.isInteger(proposed)) return { tone: 'warn', text: 'Must be a whole number of shares.' };
            const excess = Math.max(0, overview.sharesInIssue - proposed);
            return { tone: excess > 0 ? 'warn' : 'info', text: `Registered share capital becomes ${whole(proposed)} × ${cur} ${money(nominal, 0)} = ${cur} ${money(proposed * nominal, 0)}. ${excess > 0 ? `Still ${whole(excess)} share(s) beyond it.` : 'All shares in issue are covered.'}` };
        }
        return null;
    }, [form.change_type, proposed, nominal, issue, cur, overview.registeredShares, overview.sharesInIssue]);

    const submit = async (e) => {
        e.preventDefault();
        setBusy(true); setError(null);
        try {
            await shareCapitalAPI.createChangeRequest({
                ...form,
                effective_date: form.change_type === 'NOMINAL_VALUE' ? undefined : form.effective_date,
            });
            setForm(p => ({ ...p, proposed_value: '', reason: '' }));
            setReasonIsAuto(false);
            onDone();
        } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
    };

    return (
        <form onSubmit={submit} className="card mb-6 space-y-4">
            <h3 className="text-base font-semibold text-gray-900">Propose a change</h3>
            {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                    <label className="label">What changes *</label>
                    <select className="input" value={form.change_type} onChange={e => {
                        const t = e.target.value;
                        if (t === 'ISSUE_PRICE' && suggestionUsable) {
                            setForm(p => ({ ...p, change_type: t, proposed_value: String(suggested), reason: suggestedReason }));
                            setReasonIsAuto(!!suggestedReason);
                        } else {
                            setForm(p => ({ ...p, change_type: t, proposed_value: '', reason: reasonIsAuto ? '' : p.reason }));
                            setReasonIsAuto(false);
                        }
                    }}>
                        {Object.entries(CHANGE_TYPES)
                            .filter(([k]) => overview.registeredSetupLocked || k === 'ISSUE_PRICE')
                            .map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                    {!overview.registeredSetupLocked && (
                        <p className="text-xs text-gray-500 mt-1">
                            No shares are allotted yet — the nominal value and registered shares are edited directly under Overview &gt; Registered values.
                        </p>
                    )}
                    <p className="text-xs text-gray-500 mt-1">
                        Now: {form.change_type === 'ISSUE_PRICE' ? `${cur} ${money(issue, 0)}`
                            : form.change_type === 'NOMINAL_VALUE' ? `${cur} ${money(nominal, 0)}`
                                : (overview.registeredShares ? `${whole(overview.registeredShares)} shares` : 'not recorded')}
                    </p>
                </div>
                <div>
                    <label className="label">{form.change_type === 'REGISTERED_SHARES' ? 'New number of registered shares *' : `New value (${cur}) *`}</label>
                    <input type="number" className="input" min="0" step={form.change_type === 'REGISTERED_SHARES' ? '1' : '0.01'}
                        value={form.proposed_value} onChange={e => {
                            const v = e.target.value;
                            const stillSuggested = suggestionUsable && Math.abs(parseFloat(v) - suggested) < 0.01;
                            setForm(p => ({ ...p, proposed_value: v, reason: (reasonIsAuto && !stillSuggested) ? '' : p.reason }));
                            if (reasonIsAuto && !stillSuggested) setReasonIsAuto(false);
                        }} required />
                    {form.change_type === 'ISSUE_PRICE' && suggested !== null && suggested !== undefined && (
                        <div className="text-xs text-gray-500 mt-1">
                            Suggested: <strong>{cur} {money(suggested, 0)}</strong>
                            {overview.nav?.navPerShare != null && <> (NAV per share {cur} {money(overview.nav.navPerShare)}, rounded to the nearest 1,000; never below nominal)</>}
                            {!suggestionUsable && overview.issuePrice && <> — the same as the current issue price, so no change is needed.</>}
                            {suggestionUsable && Math.abs(parseFloat(form.proposed_value) - suggested) >= 0.01 && (
                                <button type="button" className="ml-2 text-primary-600 hover:underline"
                                    onClick={() => { setForm(p => ({ ...p, proposed_value: String(suggested), reason: suggestedReason })); setReasonIsAuto(!!suggestedReason); }}>
                                    Use suggested
                                </button>
                            )}
                        </div>
                    )}
                </div>
                {form.change_type !== 'NOMINAL_VALUE' && (
                    <div>
                        <label className="label">{form.change_type === 'REGISTERED_SHARES' ? 'Date registered with URSB *' : 'Takes effect from *'}</label>
                        <input type="date" className="input" value={form.effective_date}
                            onChange={e => setForm(p => ({ ...p, effective_date: e.target.value }))} required />
                    </div>
                )}
                <div>
                    <label className="label">Approved board resolution *</label>
                    <select className="input" value={form.resolution_document_id}
                        onChange={e => setForm(p => ({ ...p, resolution_document_id: e.target.value }))} required>
                        <option value="">Select a FINAL resolution from Documents...</option>
                        {resolutions.map(r => <option key={r.id} value={r.id}>{r.reference_code} — {r.title}</option>)}
                    </select>
                    {resolutions.length === 0 && <p className="text-xs text-amber-700 mt-1">No FINAL resolution found. Generate or upload the resolution in Documents and have it approved first.</p>}
                </div>
            </div>
            <div>
                <label className="label">Reason *</label>
                <textarea className="input" rows={form.reason && form.reason.length > 160 ? 4 : 2} value={form.reason} onChange={e => { setForm(p => ({ ...p, reason: e.target.value })); setReasonIsAuto(false); }} required
                    placeholder="e.g. Issue price raised to reflect the net asset value per share, as resolved on ..." />
            </div>
            {explanation && <Note tone={explanation.tone}>{explanation.text}</Note>}
            <p className="text-xs text-gray-500">
                You are the first approver. A second, different person must approve: two Directors, or a Director and the
                Treasurer (if you are the Treasurer, a Director must approve). The change is applied on approval and a formal
                notice goes to every shareholder's My Documents.
            </p>
            <button type="submit" disabled={busy} className="btn-primary">{busy ? 'Submitting...' : 'Propose change'}</button>
        </form>
    );
};

const describeChange = (r) => {
    const cur = r.currency_code;
    if (r.change_type === 'REGISTERED_SHARES') return `${whole(r.current_value)} → ${whole(r.proposed_value)} shares`;
    return `${cur} ${money(r.current_value, 0)} → ${cur} ${money(r.proposed_value, 0)}`;
};

const ChangesTab = ({ overview, userId, canPropose, onReload }) => {
    const confirm = useConfirm();
    const [requests, setRequests] = useState([]);
    const [error, setError] = useState(null);
    const [busyId, setBusyId] = useState(null);

    const load = useCallback(() => {
        shareCapitalAPI.getChangeRequests().then(res => setRequests(res.data.data || [])).catch(err => setError(getErrorMessage(err)));
    }, []);
    useEffect(() => { load(); }, [load]);

    const act = async (r, action) => {
        let note = null;
        if (action === 'approve') {
            const ok = await confirm({
                title: `Approve ${r.reference_code}`,
                message: `${CHANGE_TYPES[r.change_type]}: ${describeChange(r)}. It is applied immediately and every shareholder is notified.`,
                confirmLabel: 'Approve & apply',
            });
            if (!ok) return;
        } else {
            note = await confirm({
                title: action === 'reject' ? `Reject ${r.reference_code}` : `Withdraw ${r.reference_code}`,
                message: 'Give a short reason.',
                requireInput: true, danger: true,
                confirmLabel: action === 'reject' ? 'Reject' : 'Withdraw',
            });
            if (!note) return;
        }
        setBusyId(r.id); setError(null);
        try {
            if (action === 'approve') await shareCapitalAPI.approveChangeRequest(r.id, {});
            if (action === 'reject') await shareCapitalAPI.rejectChangeRequest(r.id, { note });
            if (action === 'cancel') await shareCapitalAPI.cancelChangeRequest(r.id, { note });
            load(); onReload();
        } catch (err) { setError(getErrorMessage(err)); } finally { setBusyId(null); }
    };

    return (
        <div>
            <Note>
                Any change to the issue price, the nominal value or the registered number of shares needs (1) an approved
                (FINAL) board resolution linked from Documents and (2) two different people — two Directors, or a Director
                and the Treasurer. The Admin role alone cannot approve. A nominal value change is a <strong>split</strong> or{' '}
                <strong>consolidation</strong>: every holding, the issue price and the registered shares are converted by the same
                ratio, so nobody's value changes.
            </Note>
            {error && <div className="mb-4"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}
            {canPropose && overview.openingConverted !== undefined && <ProposeChangeForm overview={overview} onDone={() => { load(); onReload(); }} />}

            <div className="card">
                <h3 className="text-base font-semibold text-gray-900 mb-3">Changes</h3>
                {requests.length === 0 ? <p className="text-sm text-gray-500">No changes proposed yet.</p> : (
                    <div className="space-y-3">
                        {requests.map(r => (
                            <div key={r.id} className="border border-gray-200 rounded-lg p-3">
                                <div className="flex justify-between flex-wrap gap-2">
                                    <div>
                                        <p className="text-sm font-semibold text-gray-900">
                                            {CHANGE_TYPES[r.change_type]} — {describeChange(r)}
                                        </p>
                                        <p className="text-xs text-gray-500">
                                            <span className="font-mono">{r.reference_code}</span> · effective {formatDate(r.effective_date)} ·
                                            resolution <span className="font-mono">{r.resolution_reference}</span> {r.resolution_title}
                                        </p>
                                        <p className="text-xs text-gray-600 mt-1">{r.reason}</p>
                                        <p className="text-xs text-gray-500 mt-1">
                                            Proposed by {r.requested_by_name} ({r.requested_role}) on {formatDate(r.requested_at)}
                                            {r.approved_by_name && <> · approved by {r.approved_by_name} ({r.approved_role}) on {formatDate(r.approved_at)}</>}
                                            {r.rejected_by_name && <> · {r.status === 'CANCELLED' ? 'withdrawn' : 'rejected'} by {r.rejected_by_name}{r.decision_note ? `: ${r.decision_note}` : ''}</>}
                                            {r.notice_reference && <> · notice <span className="font-mono">{r.notice_reference}</span></>}
                                        </p>
                                        {r.result_summary?.ratioText && <p className="text-xs text-gray-600 mt-1">{r.result_summary.ratioText}; shares {whole(r.result_summary.sharesBefore)} → {whole(r.result_summary.sharesAfter)}</p>}
                                    </div>
                                    <div className="flex items-start gap-2">
                                        {r.status === 'APPLIED' ? <StatusBadge status="APPROVED" label="APPLIED" /> : <StatusBadge status={r.status} />}
                                    </div>
                                </div>
                                {r.status === 'PENDING' && canPropose && (
                                    <div className="flex gap-2 mt-3">
                                        {r.requested_by !== userId && (
                                            <>
                                                <button disabled={busyId === r.id} onClick={() => act(r, 'approve')} className="btn-primary text-xs">Approve &amp; apply</button>
                                                <button disabled={busyId === r.id} onClick={() => act(r, 'reject')} className="btn-secondary text-xs">Reject</button>
                                            </>
                                        )}
                                        {r.requested_by === userId && (
                                            <button disabled={busyId === r.id} onClick={() => act(r, 'cancel')} className="btn-secondary text-xs">Withdraw</button>
                                        )}
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

// ============================================================
// ALLOTMENTS & RETURNS
// ============================================================
const AllotmentsTab = ({ canFile, onReload }) => {
    const [rows, setRows] = useState([]);
    const [pendingOnly, setPendingOnly] = useState(false);
    const [selected, setSelected] = useState({});
    const [filing, setFiling] = useState({ filed_at: new Date().toISOString().split('T')[0], return_reference: '' });
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);

    const load = useCallback(() => {
        shareCapitalAPI.getAllotments(pendingOnly ? { pending_returns: 'true' } : {})
            .then(res => { setRows(res.data.data || []); setSelected({}); })
            .catch(err => setError(getErrorMessage(err)));
    }, [pendingOnly]);
    useEffect(() => { load(); }, [load]);

    const byMonth = useMemo(() => {
        const m = new Map();
        for (const r of rows) { if (!m.has(r.month)) m.set(r.month, []); m.get(r.month).push(r); }
        return Array.from(m.entries());
    }, [rows]);

    const ids = Object.keys(selected).filter(k => selected[k]).map(Number);
    const fileSelected = async () => {
        setBusy(true); setError(null);
        try {
            await shareCapitalAPI.markReturnsFiled({ allotment_ids: ids, ...filing });
            load(); onReload();
        } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
    };
    const selectMonth = (list, value) => setSelected(p => {
        const n = { ...p };
        for (const r of list) if (r.status === 'ACTIVE' && r.return_due_date && !r.return_filed_at) n[r.id] = value;
        return n;
    });

    return (
        <div>
            <Note>
                A return of allotment (URSB form) must be filed within 60 days of each allotment (Companies Act 2012 s.61; late
                filing carries a fine). Tick the allotments a return covers — usually a whole month — and mark them filed with
                the URSB reference. Splits and consolidations are converted holdings, not new allotments, and are listed for the
                record only.
            </Note>
            {error && <div className="mb-4"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}
            <div className="flex flex-wrap items-center gap-3 mb-4">
                <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={pendingOnly} onChange={e => setPendingOnly(e.target.checked)} />
                    Only allotments whose return is not yet filed
                </label>
                {canFile && ids.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2 ml-auto">
                        <input type="date" className="input w-40" value={filing.filed_at} onChange={e => setFiling(p => ({ ...p, filed_at: e.target.value }))} />
                        <input type="text" className="input w-48" placeholder="URSB reference" value={filing.return_reference}
                            onChange={e => setFiling(p => ({ ...p, return_reference: e.target.value }))} />
                        <button onClick={fileSelected} disabled={busy} className="btn-primary text-sm">Mark {ids.length} filed</button>
                    </div>
                )}
            </div>
            {byMonth.length === 0 && <div className="card text-sm text-gray-500">No allotments.</div>}
            {byMonth.map(([month, list]) => {
                const shares = list.filter(r => r.status === 'ACTIVE' && (r.source === 'CONTRIBUTION' || r.source === 'OPENING_CONVERSION')).reduce((s, r) => s + r.shares, 0);
                const beyond = list.reduce((s, r) => s + (r.status === 'ACTIVE' ? r.shares_beyond_registered : 0), 0);
                return (
                    <div key={month} className="card mb-4">
                        <div className="flex justify-between flex-wrap gap-2 mb-2">
                            <h3 className="text-base font-semibold text-gray-900">
                                {new Date(`${month}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}
                                <span className="ml-2 text-sm font-normal text-gray-500">{whole(shares)} share(s) allotted{beyond > 0 ? ` · ${whole(beyond)} beyond registered` : ''}</span>
                            </h3>
                            {canFile && <button onClick={() => selectMonth(list, true)} className="text-xs text-primary-600 hover:underline">Select this month's unfiled</button>}
                        </div>
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="text-left text-gray-500 border-b">
                                        {canFile && <th className="py-2 pr-2"></th>}
                                        <th className="py-2 pr-3">Date</th><th className="py-2 pr-3">Reference</th><th className="py-2 pr-3">Member</th>
                                        <th className="py-2 pr-3">How</th><th className="py-2 pr-3 text-right">Shares</th>
                                        <th className="py-2 pr-3 text-right">Issue / nominal</th><th className="py-2 pr-3 text-right">Capital</th>
                                        <th className="py-2 pr-3 text-right">Premium</th><th className="py-2 pr-3">Return</th><th className="py-2 text-right">Status</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {list.map(r => {
                                        const fileable = r.status === 'ACTIVE' && r.return_due_date && !r.return_filed_at;
                                        return (
                                            <tr key={r.id} className="border-b border-gray-100">
                                                {canFile && <td className="py-2 pr-2">{fileable && <input type="checkbox" checked={!!selected[r.id]} onChange={e => setSelected(p => ({ ...p, [r.id]: e.target.checked }))} />}</td>}
                                                <td className="py-2 pr-3">{formatDate(r.allotment_date)}</td>
                                                <td className="py-2 pr-3 font-mono text-xs">{r.reference_code}</td>
                                                <td className="py-2 pr-3">{r.member_name}</td>
                                                <td className="py-2 pr-3">{SOURCE_LABELS[r.source] || r.source}</td>
                                                <td className="py-2 pr-3 text-right font-semibold">{r.shares > 0 ? '+' : ''}{whole(r.shares)}{r.shares_beyond_registered > 0 && <span className="ml-1 text-xs text-amber-700" title="Beyond the registered number of shares">({whole(r.shares_beyond_registered)} over)</span>}</td>
                                                <td className="py-2 pr-3 text-right">{money(r.issue_price, 0)} / {money(r.nominal_value, 0)}</td>
                                                <td className="py-2 pr-3 text-right">{money(r.share_capital_amount, 0)}</td>
                                                <td className="py-2 pr-3 text-right">{money(r.share_premium_amount, 0)}</td>
                                                <td className="py-2 pr-3 text-xs">
                                                    {!r.return_due_date ? '—'
                                                        : r.return_filed_at ? <span className="text-green-700">Filed {formatDate(r.return_filed_at)}{r.return_reference ? ` (${r.return_reference})` : ''}</span>
                                                            : <span className={r.return_overdue ? 'text-red-600 font-semibold' : 'text-gray-600'}>Due {formatDate(r.return_due_date)}{r.return_overdue ? ' — overdue' : ''}</span>}
                                                </td>
                                                <td className="py-2 text-right"><StatusBadge status={r.status} /></td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>
                );
            })}
        </div>
    );
};

// ============================================================
// CREDIT & REFUNDS
// ============================================================
const RefundsTable = ({ refunds, userId = null, canCheck = false, canMake = false, onAct = null, busyId = null }) => (
    <div className="overflow-x-auto">
        <table className="w-full text-sm">
            <thead>
                <tr className="text-left text-gray-500 border-b">
                    <th className="py-2 pr-3">Reference</th><th className="py-2 pr-3">Member</th><th className="py-2 pr-3 text-right">Credit</th>
                    <th className="py-2 pr-3">Paid from</th><th className="py-2 pr-3 text-right">Paid</th><th className="py-2 pr-3">People</th>
                    <th className="py-2 pr-3">Status</th>{onAct && <th className="py-2"></th>}
                </tr>
            </thead>
            <tbody>
                {refunds.map(r => (
                    <tr key={r.id} className="border-b border-gray-100 align-top">
                        <td className="py-2 pr-3 font-mono text-xs">{r.reference_code}</td>
                        <td className="py-2 pr-3">{r.member_name}<div className="text-xs text-gray-500">{r.reason}</div></td>
                        <td className="py-2 pr-3 text-right">{r.credit_currency_code} {money(r.credit_amount)}</td>
                        <td className="py-2 pr-3">{r.account_name}</td>
                        <td className="py-2 pr-3 text-right">{r.payout_amount ? `${r.payout_currency_code} ${money(r.payout_amount)}` : '—'}{r.payout_date && <div className="text-xs text-gray-500">{formatDate(r.payout_date)}</div>}</td>
                        <td className="py-2 pr-3 text-xs text-gray-600">Requested: {r.requested_by_name}{r.decided_by_name && <><br />Decided: {r.decided_by_name}</>}{r.decision_note && <><br />{r.decision_note}</>}</td>
                        <td className="py-2 pr-3"><StatusBadge status={r.status} /></td>
                        {onAct && (
                            <td className="py-2 text-right whitespace-nowrap">
                                {r.status === 'PENDING' && canCheck && r.requested_by !== userId && (
                                    <>
                                        <button disabled={busyId === r.id} onClick={() => onAct(r, 'approve')} className="btn-primary text-xs mr-1">Approve &amp; pay</button>
                                        <button disabled={busyId === r.id} onClick={() => onAct(r, 'reject')} className="btn-secondary text-xs">Reject</button>
                                    </>
                                )}
                                {r.status === 'PENDING' && canMake && r.requested_by === userId && (
                                    <button disabled={busyId === r.id} onClick={() => onAct(r, 'cancel')} className="btn-secondary text-xs">Withdraw</button>
                                )}
                            </td>
                        )}
                    </tr>
                ))}
            </tbody>
        </table>
    </div>
);

const CreditsTab = ({ overview, userId, canMake, canCheck, onReload }) => {
    const confirm = useConfirm();
    const [refunds, setRefunds] = useState([]);
    const [accounts, setAccounts] = useState([]);
    const [form, setForm] = useState({ user_id: '', credit_amount: '', account_id: '', reason: '' });
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const [busyId, setBusyId] = useState(null);
    const cur = overview.currencyCode || '';

    const load = useCallback(() => {
        shareCapitalAPI.getRefunds().then(res => setRefunds(res.data.data || [])).catch(err => setError(getErrorMessage(err)));
    }, []);
    useEffect(() => {
        load();
        if (canMake) accountsAPI.getAll().then(res => setAccounts((res.data.data || []).filter(a => a.account_type !== 'SAVINGS' && a.is_active !== false))).catch(() => {});
    }, [load, canMake]);

    const withCredit = (overview.members || []).filter(m => Math.abs(m.credit) >= 0.01);
    const selectedMember = withCredit.find(m => String(m.userId) === String(form.user_id));

    const submit = async (e) => {
        e.preventDefault();
        setBusy(true); setError(null);
        try {
            await shareCapitalAPI.createRefund(form);
            setForm({ user_id: '', credit_amount: '', account_id: '', reason: '' });
            load(); onReload();
        } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
    };

    const act = async (r, action) => {
        let note = null;
        if (action === 'approve') {
            const ok = await confirm({
                title: `Approve refund ${r.reference_code}`,
                message: `Pay ${r.member_name} their share credit of ${r.credit_currency_code} ${money(r.credit_amount)} from ${r.account_name}? A payment transaction is posted today.`,
                confirmLabel: 'Approve & pay',
            });
            if (!ok) return;
        } else {
            note = await confirm({ title: action === 'reject' ? 'Reject refund' : 'Withdraw refund', message: 'Give a short reason.', requireInput: true, danger: true });
            if (!note) return;
        }
        setBusyId(r.id); setError(null);
        try {
            if (action === 'approve') await shareCapitalAPI.approveRefund(r.id, {});
            if (action === 'reject') await shareCapitalAPI.rejectRefund(r.id, { note });
            if (action === 'cancel') await shareCapitalAPI.cancelRefund(r.id, { note });
            load(); onReload();
        } catch (err) { setError(getErrorMessage(err)); } finally { setBusyId(null); }
    };

    return (
        <div>
            <Note>
                Share credit is capital a member has paid in that has not yet bought a whole share. It sits in the books as
                <em> 3020 Capital Pending Allotment</em> and is used first at the member's next contribution. A refund is requested
                by the Treasurer or Assistant Treasurer and must be approved — and paid — by a different person (Treasurer,
                Assistant Treasurer or a Director).
            </Note>
            {error && <div className="mb-4"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}

            <div className="card mb-6">
                <h3 className="text-base font-semibold text-gray-900 mb-3">Members with share credit</h3>
                {withCredit.length === 0 ? <p className="text-sm text-gray-500">No member has share credit.</p> : (
                    <table className="w-full text-sm">
                        <thead><tr className="text-left text-gray-500 border-b"><th className="py-2">Member</th><th className="py-2 text-right">Share credit ({cur})</th></tr></thead>
                        <tbody>
                            {withCredit.map(m => (
                                <tr key={m.userId} className="border-b border-gray-100">
                                    <td className="py-2">{m.name}</td>
                                    <td className={`py-2 text-right ${m.credit < 0 ? 'text-red-600' : ''}`}>{money(m.credit)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

            {canMake && (
                <form onSubmit={submit} className="card mb-6 space-y-4">
                    <h3 className="text-base font-semibold text-gray-900">Request a refund of share credit</h3>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div>
                            <label className="label">Member *</label>
                            <select className="input" value={form.user_id} onChange={e => setForm(p => ({ ...p, user_id: e.target.value }))} required>
                                <option value="">Select...</option>
                                {withCredit.filter(m => m.credit > 0).map(m => <option key={m.userId} value={m.userId}>{m.name} — {cur} {money(m.credit)}</option>)}
                            </select>
                        </div>
                        <div>
                            <label className="label">Amount of credit ({cur}) *</label>
                            <input type="number" className="input" min="0.01" step="0.01" max={selectedMember ? selectedMember.credit : undefined}
                                value={form.credit_amount} onChange={e => setForm(p => ({ ...p, credit_amount: e.target.value }))} required />
                        </div>
                        <div>
                            <label className="label">Pay from account *</label>
                            <select className="input" value={form.account_id} onChange={e => setForm(p => ({ ...p, account_id: e.target.value }))} required>
                                <option value="">Select...</option>
                                {accounts.map(a => <option key={a.id} value={a.id}>{a.name} ({a.currency_code})</option>)}
                            </select>
                        </div>
                    </div>
                    <div>
                        <label className="label">Reason *</label>
                        <input type="text" className="input" value={form.reason} onChange={e => setForm(p => ({ ...p, reason: e.target.value }))} required />
                    </div>
                    <p className="text-xs text-gray-500">
                        Paid from a foreign-currency account, the amount is converted at the rate on the payment date (rounded down to
                        the cent), and the member's credit is reduced by the payment's UGX value.
                    </p>
                    <button type="submit" disabled={busy} className="btn-primary">{busy ? 'Submitting...' : 'Request refund'}</button>
                </form>
            )}

            <div className="card">
                <h3 className="text-base font-semibold text-gray-900 mb-3">Refund requests</h3>
                {refunds.length === 0 ? <p className="text-sm text-gray-500">None.</p> : (
                    <RefundsTable refunds={refunds} userId={userId} canCheck={canCheck} canMake={canMake} onAct={act} busyId={busyId} />
                )}
            </div>
        </div>
    );
};

// ============================================================
// PAGE
// ============================================================
const ShareCapitalPage = () => {
    const { user, hasRole } = useAuth();
    const [searchParams, setSearchParams] = useSearchParams();
    const [overview, setOverview] = useState(null);
    const [error, setError] = useState(null);
    const [statementUserId, setStatementUserId] = useState(null);

    const isStaff = hasRole(['Treasurer', 'Assistant Treasurer', 'Director', 'Admin', 'Secretary']);
    const canPropose = hasRole(['Director', 'Treasurer']);
    const canConvert = hasRole(['Treasurer', 'Admin']);
    const canFile = hasRole(['Secretary', 'Assistant Secretary', 'Treasurer', 'Director', 'Admin']);
    const canMakeRefund = hasRole(['Treasurer', 'Assistant Treasurer']);
    const canCheckRefund = hasRole(['Treasurer', 'Assistant Treasurer', 'Director']);

    const load = useCallback(() => {
        shareCapitalAPI.getOverview()
            .then(res => setOverview(res.data.data))
            .catch(err => setError(getErrorMessage(err)));
    }, []);
    useEffect(() => { load(); }, [load]);

    const tabs = [
        { key: 'overview', label: 'Overview' },
        { key: 'mine', label: 'My Shares' },
        { key: 'changes', label: 'Changes', count: overview?.pending?.change_requests || 0 },
        ...(isStaff ? [
            { key: 'allotments', label: 'Allotments & Returns', count: overview?.returns?.overdue || 0 },
            { key: 'registered', label: 'Registered (URSB)' }, // v1.81.0 — member by member
            { key: 'credits', label: 'Credit & Refunds', count: overview?.pending?.refunds || 0 },
        ] : []),
    ];
    const active = tabs.some(t => t.key === searchParams.get('tab')) ? searchParams.get('tab') : 'overview';
    const setTab = (k) => setSearchParams(k === 'overview' ? {} : { tab: k });

    if (error && !overview) return <div className="p-6"><ErrorMessage message={error} /></div>;
    if (!overview) return <LoadingSpinner fullPage text="Loading share capital..." />;

    return (
        <div>
            <PageHeader
                title="Share Capital"
                subtitle="Nominal value, whole-share allotments, members' share credit and registered capital"
                actions={<ScaleIcon className="h-8 w-8 text-white/80" />}
            />
            <Tabs tabs={tabs} active={active} onChange={setTab} />

            {active === 'overview' && <OverviewTab overview={overview} canConvert={canConvert} canEditRegistered={canPropose} onReload={load} onOpenStatement={setStatementUserId} />}
            {active === 'mine' && <MySharesTab />}
            {active === 'changes' && <ChangesTab overview={overview} userId={user?.id} canPropose={canPropose} onReload={load} />}
            {active === 'allotments' && isStaff && <AllotmentsTab canFile={canFile} onReload={load} />}
            {active === 'registered' && isStaff && <RegisteredByMemberTab canEdit={canFile} />}
            {active === 'credits' && isStaff && (
                <CreditsTab overview={overview} userId={user?.id} canMake={canMakeRefund} canCheck={canCheckRefund} onReload={load} />
            )}

            <StatementModal userId={statementUserId} onClose={() => setStatementUserId(null)} />
        </div>
    );
};

export default ShareCapitalPage;
