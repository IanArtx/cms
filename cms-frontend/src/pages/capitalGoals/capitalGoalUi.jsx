// ============================================================
// CAPITAL GOAL — SHARED PIECES (v1.78.0)
// Used by the Capital Goals hub, a goal's own page, a month's page and
// both dashboards, so a goal looks and behaves the same everywhere:
//   • money()            "EUR 1,250.00"
//   • ProgressBar        coloured bar (green = on track, red = behind)
//   • StatTile           one figure with a label and a small note
//   • MemberStatus       coloured chip for a member's standing
//   • PledgeModal        make / edit a pledge (moved here from
//                        MyCapitalCallsPage so every screen can open it)
//   • pledgeTargetFor()  turns an overview goal into what PledgeModal needs
//   • GoalCard           one goal at a glance: progress, this month's
//                        call, my pledge, the investment it is tied to,
//                        and a one-tap "Pledge" button
//   • OwedList           my unpaid pledges with their deadlines
//   • CapitalGoalsDashboardSection
//                        the block both dashboards show: every active
//                        goal, what I owe, approvals waiting (managers),
//                        with pledging right there
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { capitalGoalCallsAPI, capitalGoalsAPI, accountsAPI } from '../../api/endpoints';
import { formatDate, formatNumber, getErrorMessage } from '../../utils/helpers';
import ErrorMessage from '../../components/common/ErrorMessage';
import { BriefcaseIcon, ClockIcon, UsersIcon, FlagIcon, CheckBadgeIcon, ArrowRightIcon } from '@heroicons/react/24/outline';

export const money = (v, code = '', dp = 2) => {
    if (v === null || v === undefined || v === '' || isNaN(parseFloat(v))) return '—';
    const n = parseFloat(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
    return code ? `${code} ${n}` : n;
};

export const pct = (v) => (v === null || v === undefined ? '—' : `${parseFloat(v).toLocaleString('en-US', { maximumFractionDigits: 1 })}%`);

// "2026-10" → "Oct 2026"
export const periodLabel = (p) => {
    if (!p || !/^\d{4}-\d{2}/.test(p)) return p || '—';
    const [y, m] = p.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
};

export const ProgressBar = ({ percent, tone = 'good', className = 'h-2' }) => {
    const width = Math.max(0, Math.min(100, parseFloat(percent) || 0));
    const colour = tone === 'bad' ? 'bg-red-500' : tone === 'warn' ? 'bg-amber-500' : tone === 'info' ? 'bg-primary-600' : 'bg-green-500';
    return (
        <div className={`w-full bg-gray-100 rounded-full overflow-hidden ${className}`}>
            <div className={`h-full rounded-full ${colour}`} style={{ width: `${width}%` }} />
        </div>
    );
};

export const StatTile = ({ label, value, sub = null, tone = 'default', icon: Icon = null, flat = false }) => (
    <div className={flat ? 'rounded-lg bg-gray-50 p-3' : 'card'}>
        <div className="flex items-start justify-between gap-2">
            <p className="text-xs font-medium text-gray-500">{label}</p>
            {Icon && <Icon className="h-4 w-4 text-gray-300 flex-shrink-0" />}
        </div>
        <p className={`mt-1 text-lg sm:text-xl font-bold break-words ${
            tone === 'good' ? 'text-green-600' : tone === 'bad' ? 'text-red-600' : tone === 'warn' ? 'text-amber-600' : 'text-gray-900'
        }`}>
            {value}
        </p>
        {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
);

// A member's standing — on the whole goal (pledgers tab) or in one
// month (month page).
const STATUS_META = {
    // whole goal
    UP_TO_DATE:      { label: 'Up to date',      cls: 'badge-green' },
    OWES:            { label: 'Owes (not late)', cls: 'badge-blue' },
    OVERDUE:         { label: 'Overdue',         cls: 'badge-red' },
    NO_PLEDGE:       { label: 'No pledge yet',   cls: 'badge-gray' },
    // one month
    PAID:            { label: 'Paid in full',    cls: 'badge-green' },
    PARTIALLY_PAID:  { label: 'Part paid',       cls: 'badge-teal' },
    PARTIAL_OVERDUE: { label: 'Part paid — late', cls: 'badge-orange' },
    PLEDGED:         { label: 'Pledged, not paid', cls: 'badge-blue' },
    DEFAULTED:       { label: 'Missed deadline', cls: 'badge-red' },
    NOT_RESPONDED:   { label: 'No pledge',       cls: 'badge-gray' },
};

export const MemberStatus = ({ status }) => {
    const meta = STATUS_META[status] || { label: (status || '').replace(/_/g, ' '), cls: 'badge-gray' };
    return <span className={`${meta.cls} whitespace-nowrap`}>{meta.label}</span>;
};

export const memberStatusLabel = (status) => (STATUS_META[status] || {}).label || status;

// ============================================================
// SUBMIT / EDIT PLEDGE MODAL
// Used both for a brand new pledge into an open call, and for editing
// one of my own pledges that's still PENDING (nothing settled yet —
// the server itself is the real gate on this, this UI just avoids
// offering the button where it would obviously fail).
//   new:  target = { id: <monthly call id>, iteration, goal_title, period, baseline, currency_code? }
//   edit: target = { pledgeId, goal_title, period, pledged_amount, currency_id }
// ============================================================
export const PledgeModal = ({ isOpen, onClose, onSuccess, target, currencies }) => {
    const isEdit = !!(target && target.pledgeId);
    const [amount, setAmount] = useState('');
    const [currencyId, setCurrencyId] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (isOpen && target) {
            setAmount(isEdit ? String(target.pledged_amount) : (target.baseline != null ? String(target.baseline) : ''));
            // v1.78.0 — a new pledge starts in the goal's own currency
            // (the usual case); any other active currency can be chosen.
            const goalCurrency = !isEdit && target.currency_code
                ? (currencies || []).find(c => c.code === target.currency_code) : null;
            setCurrencyId(isEdit ? String(target.currency_id) : (goalCurrency ? String(goalCurrency.id) : ''));
            setError(null);
        }
    }, [isOpen, target, isEdit, currencies]);

    if (!isOpen || !target) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (currencyId === '' && !isEdit) {
            setError('Choose a currency');
            return;
        }
        setLoading(true);
        setError(null);
        try {
            if (isEdit) {
                await capitalGoalCallsAPI.editPledge(target.pledgeId, {
                    pledged_amount: parseFloat(amount),
                    currency_id: currencyId ? parseInt(currencyId) : undefined,
                });
            } else {
                await capitalGoalCallsAPI.submitPledge(target.id, {
                    iteration: target.iteration,
                    currency_id: parseInt(currencyId),
                    pledged_amount: parseFloat(amount),
                });
            }
            onSuccess();
            onClose();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            <div className="fixed inset-0 bg-black bg-opacity-40" onClick={onClose} />
            <div className="flex min-h-full items-center justify-center p-4">
                <div className="relative bg-white rounded-xl shadow-xl max-w-md w-full p-6">
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">
                        {isEdit ? 'Edit My Pledge' : 'Pledge Into This Call'}
                    </h2>
                    <p className="text-sm text-gray-400 mb-4">
                        {isEdit
                            ? `${target.goal_title} — ${target.period}`
                            : `${target.goal_title} — ${target.period}${target.iteration === 2 ? ' (Iteration 2)' : ''}`}
                    </p>
                    {!isEdit && target.iteration === 1 && target.baseline != null && (
                        <p className="text-xs text-gray-400 bg-gray-50 rounded-lg px-3 py-2 mb-4">
                            Suggested equal share for this month: <strong>{formatNumber(target.baseline)}</strong>.
                            Enter this amount if you're happy to contribute your equal share, less if you'd like to
                            contribute less, more if you'd like to contribute more, or zero if you don't wish to
                            make a call this month — none of these are penalized. Only a pledge you commit to and
                            then fail to pay by the deadline can attract a late fine.
                        </p>
                    )}
                    {!isEdit && target.iteration === 2 && (
                        <p className="text-xs text-gray-400 bg-gray-50 rounded-lg px-3 py-2 mb-4">
                            This is a second-round call on the remaining balance after the first deadline passed
                            without the month being fully met. No late fine ever applies to an iteration 2 pledge.
                        </p>
                    )}
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">Amount *</label>
                            <input type="number" className="input" value={amount}
                                onChange={e => setAmount(e.target.value)}
                                min="0" step="0.01" required />
                        </div>
                        <div>
                            <label className="label">Currency *</label>
                            <select className="input" value={currencyId}
                                onChange={e => setCurrencyId(e.target.value)} required>
                                <option value="">Select currency...</option>
                                {(currencies || []).map(c => (
                                    <option key={c.id} value={c.id}>{c.code} — {c.name}</option>
                                ))}
                            </select>
                            <p className="text-xs text-gray-400 mt-1">
                                You can pledge in any active currency — it's converted to the goal's currency at
                                the exchange rate in effect when the Treasurer approves your payment.
                            </p>
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading} className="btn-primary">
                                {loading ? 'Saving...' : isEdit ? 'Save Changes' : 'Submit Pledge'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// What PledgeModal needs, from a goal returned by /capital-goals/overview.
export const pledgeTargetFor = (goal) => {
    const c = goal && goal.current_call;
    if (!c) return null;
    return {
        id: c.id, iteration: c.iteration, goal_title: goal.title, period: periodLabel(c.period),
        baseline: c.baseline, currency_code: goal.currency_code,
    };
};

// ============================================================
// GOAL CARD — one goal at a glance (hub + dashboards)
// ============================================================
export const GoalCard = ({ goal, onPledge = null, compact = false, isShareholder = true }) => {
    const c = goal.current_call;
    const code = goal.currency_code;
    const behind = goal.progress_status === 'BEHIND';
    const daysLeft = c && c.pay_by
        ? Math.ceil((new Date(`${c.pay_by}T23:59:59`) - new Date()) / 86400000) : null;

    return (
        <div className={`${compact ? 'rounded-xl border border-gray-200 p-3 sm:p-4' : 'card'} flex flex-col gap-3 min-w-0`}>
            {/* Title row */}
            <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                    <Link to={`/capital-goals/${goal.id}`}
                        className="text-sm sm:text-base font-semibold text-gray-900 hover:text-primary-700 hover:underline break-words">
                        {goal.title}
                    </Link>
                    <p className="text-[11px] text-gray-400 font-mono">{goal.reference_code}</p>
                </div>
                <span className={`${goal.goal_type === 'PRIMARY' ? 'badge-purple' : 'badge-teal'} flex-shrink-0`}>
                    {goal.goal_type === 'PRIMARY' ? 'Primary' : 'Secondary'}
                </span>
            </div>

            {/* Whole goal */}
            <div>
                <div className="flex items-baseline justify-between gap-2 flex-wrap">
                    <span className="text-lg font-bold text-gray-900">{money(goal.total_collected, code)}</span>
                    <span className="text-xs text-gray-400">of {money(goal.target_amount, code)}</span>
                </div>
                <ProgressBar percent={goal.percent_of_target} tone={behind ? 'bad' : 'good'} className="h-2 mt-1.5" />
                <div className="flex justify-between text-[11px] text-gray-400 mt-1 gap-2 flex-wrap">
                    <span>{pct(goal.percent_of_target)} raised</span>
                    <span className={behind ? 'text-red-600 font-medium' : 'text-green-600 font-medium'}>
                        {behind ? 'Behind schedule' : 'On track'}
                    </span>
                    <span>{goal.months_closed}/{goal.months_total} months closed</span>
                </div>
            </div>

            {/* This month's call */}
            {c ? (
                <div className="rounded-lg bg-gray-50 p-3">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                        <Link to={`/capital-goals/monthly-calls/${c.id}`}
                            className="text-xs font-semibold text-primary-700 hover:underline">
                            {periodLabel(c.period)} call{c.iteration === 2 ? ' — round 2' : ''}
                        </Link>
                        {c.pay_by && (
                            <span className={`text-[11px] flex items-center gap-1 ${daysLeft !== null && daysLeft < 0 ? 'text-red-600' : 'text-gray-500'}`}>
                                <ClockIcon className="h-3.5 w-3.5" />
                                Pay by {formatDate(c.pay_by)}
                                {daysLeft !== null && daysLeft >= 0 && ` (${daysLeft} day${daysLeft === 1 ? '' : 's'})`}
                            </span>
                        )}
                    </div>
                    <div className="flex items-baseline justify-between gap-2 mt-1.5 flex-wrap">
                        <span className="text-sm font-semibold text-gray-900">{money(c.settled, code)}</span>
                        <span className="text-[11px] text-gray-400">of {money(c.monthly_target, code)} this month</span>
                    </div>
                    <ProgressBar percent={c.percent} tone="info" className="h-1.5 mt-1" />
                    <div className="flex justify-between text-[11px] text-gray-500 mt-1 gap-2 flex-wrap">
                        <span className="flex items-center gap-1">
                            <UsersIcon className="h-3.5 w-3.5" />
                            {c.pledgers}/{c.members} pledged · {c.paid_in_full} paid in full
                        </span>
                        {c.shortfall > 0
                            ? <span className="text-amber-700">Short {money(c.shortfall, code)}</span>
                            : <span className="text-green-600">Month met</span>}
                    </div>

                    {/* Me */}
                    {!compact || c.my_pledge || c.can_pledge ? (
                        <div className="mt-2 pt-2 border-t border-gray-200 flex items-center justify-between gap-2 flex-wrap">
                            {c.my_pledge ? (
                                <span className="text-xs text-gray-600">
                                    My pledge: <strong>{money(c.my_pledge.pledged_amount, c.my_pledge.currency_code)}</strong>
                                    {' · '}paid {money(c.my_pledge.amount_settled, c.my_pledge.currency_code)}
                                    {' · '}<span className="lowercase">{c.my_pledge.status}</span>
                                </span>
                            ) : c.can_pledge ? (
                                <span className="text-xs text-gray-600">
                                    You haven't pledged yet{c.baseline != null && c.iteration === 1 ? ` — equal share ${money(c.baseline, code)}` : ''}
                                </span>
                            ) : (
                                <span className="text-xs text-gray-400">
                                    {!isShareholder ? 'Monthly calls are made to shareholders'
                                        : c.eligible ? 'Pledging closed'
                                            : 'Round 2 is only for members who pledged above the equal share'}
                                </span>
                            )}
                            {c.can_pledge && onPledge && (
                                <button type="button" onClick={() => onPledge(goal)} className="btn-primary text-xs px-3 py-1.5">
                                    Pledge
                                </button>
                            )}
                        </div>
                    ) : null}
                </div>
            ) : (
                <p className="text-xs text-gray-400 bg-gray-50 rounded-lg px-3 py-2">
                    {goal.is_call_based ? 'No month is open for pledges right now.' : 'Monthly calls are not activated for this goal.'}
                </p>
            )}

            {/* Tied investment */}
            {goal.investment && (
                <Link to={`/capital-goals/${goal.id}?tab=investment`}
                    className="flex items-center gap-2 text-xs text-gray-600 hover:text-primary-700">
                    <BriefcaseIcon className="h-4 w-4 text-gray-400 flex-shrink-0" />
                    <span className="truncate">
                        For <strong>{goal.investment.name}</strong> ({goal.investment.status.toLowerCase()})
                        {goal.investment.funds && ` · ${money(goal.investment.funds.invested_goal_value, code)} invested`}
                    </span>
                </Link>
            )}

            {!compact && goal.my_paid > 0 && (
                <p className="text-[11px] text-gray-500">You have paid {money(goal.my_paid, code)} into this goal so far.</p>
            )}
        </div>
    );
};

// ============================================================
// WHAT I OWE — list of my unpaid pledges (hub + dashboards)
// ============================================================
export const OwedList = ({ owed, limit = null }) => {
    const rows = limit ? owed.slice(0, limit) : owed;
    return (
        <div className="divide-y divide-gray-100">
            {rows.map(o => (
                <Link key={o.pledge_id} to={`/capital-goals/monthly-calls/${o.monthly_call_id}`}
                    className="flex items-center justify-between gap-3 py-2 hover:bg-gray-50 rounded px-1 -mx-1">
                    <div className="min-w-0">
                        <p className="text-sm text-gray-800 truncate">
                            {o.goal_title} <span className="text-gray-400">— {periodLabel(o.period)}{o.iteration === 2 ? ' (round 2)' : ''}</span>
                        </p>
                        <p className={`text-[11px] ${o.overdue ? 'text-red-600' : 'text-gray-400'}`}>
                            {o.overdue ? 'Past the deadline of' : 'Pay by'} {o.deadline ? formatDate(o.deadline) : ''}
                            {o.higher_fine_from ? ` · higher late fine from ${formatDate(o.higher_fine_from)}` : ''}
                            {o.iteration === 2 ? ' · no late fine in round 2' : ''}
                        </p>
                    </div>
                    <span className={`text-sm font-semibold flex-shrink-0 ${o.overdue ? 'text-red-600' : 'text-gray-900'}`}>
                        {money(o.owed, o.currency_code)}
                    </span>
                </Link>
            ))}
        </div>
    );
};

// ============================================================
// DASHBOARD SECTION — company dashboard and shareholder dashboard
// Requested: "quick to access on dashboards (company and individuals)".
// One request (/capital-goals/overview) gives every active goal, this
// month's call, my pledge, what I owe and — for managers — the pledges
// waiting for approval. Pledging happens right here (PledgeModal).
//   onOverview(overview) — lets the page reuse the data (e.g. a banner).
// ============================================================
export const CapitalGoalsDashboardSection = ({ title = 'Capital goals', onOverview = null, showApprovals = true }) => {
    const [overview, setOverview] = useState(null);
    const [currencies, setCurrencies] = useState([]);
    const [pledgeTarget, setPledgeTarget] = useState(null);

    const load = useCallback(() => {
        capitalGoalsAPI.getOverview()
            .then(r => { setOverview(r.data.data); if (onOverview) onOverview(r.data.data); })
            .catch(() => {});
    }, [onOverview]);

    useEffect(() => {
        load();
        accountsAPI.getCurrencies().then(r => setCurrencies(r.data.data || [])).catch(() => {});
    }, [load]);

    if (!overview || !overview.tracking_enabled) return null;
    const { goals, me, approvals } = overview;
    if (goals.length === 0 && me.owed.length === 0) return null;
    const owed = Object.entries(me.owed_by_currency || {});

    return (
        <div className="card">
            <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
                <div className="flex items-center gap-2">
                    <FlagIcon className="h-4 w-4 text-primary-600" />
                    <h2 className="section-title mb-0">{title}</h2>
                </div>
                <Link to="/capital-goals" className="text-xs font-medium text-primary-700 hover:underline flex items-center gap-1">
                    Open capital goals <ArrowRightIcon className="h-3.5 w-3.5" />
                </Link>
            </div>

            {/* Me + approvals strip */}
            <div className="flex flex-wrap gap-2 mb-3">
                {(overview.is_shareholder !== false || owed.length > 0) && <Link to="/capital-goals?tab=mine"
                    className={`text-xs rounded-lg px-3 py-1.5 ${me.owed.some(o => o.overdue) ? 'bg-red-50 text-red-700' : owed.length ? 'bg-amber-50 text-amber-800' : 'bg-green-50 text-green-700'}`}>
                    {owed.length
                        ? <>I owe <strong>{owed.map(([c, v]) => money(v, c)).join(' + ')}</strong>{me.next_due ? ` · next by ${formatDate(me.next_due.pay_by)}` : ''}</>
                        : 'My pledges are all paid'}
                </Link>}
                {me.open_to_pledge > 0 && (
                    <span className="text-xs rounded-lg px-3 py-1.5 bg-blue-50 text-blue-800">
                        {me.open_to_pledge} goal{me.open_to_pledge === 1 ? '' : 's'} waiting for my pledge
                    </span>
                )}
                {showApprovals && approvals && approvals.count > 0 && (
                    <Link to="/capital-goals?tab=approvals" className="text-xs rounded-lg px-3 py-1.5 bg-violet-50 text-violet-800 flex items-center gap-1">
                        <CheckBadgeIcon className="h-4 w-4" /> {approvals.count} pledge{approvals.count === 1 ? '' : 's'} to approve
                    </Link>
                )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {goals.map(g => <GoalCard key={g.id} goal={g} compact isShareholder={overview.is_shareholder !== false}
                    onPledge={(goal) => setPledgeTarget(pledgeTargetFor(goal))} />)}
            </div>

            <PledgeModal
                isOpen={!!pledgeTarget}
                onClose={() => setPledgeTarget(null)}
                onSuccess={load}
                target={pledgeTarget}
                currencies={currencies}
            />
        </div>
    );
};
