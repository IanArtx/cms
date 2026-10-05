// ============================================================
// CAPITAL GOALS PAGE — THE CAPITAL GOALS HUB
// Lists every capital fundraising goal — a target amount of
// shareholder capital to raise over a date range, with a live
// on-track/behind read against actual contributions. v1.29.0,
// Section 4.33.
//
// v1.78.0 — requested directly: "make the capital goal system more
// optimized and quick to access … and better navigation through the
// page … very intuitive and easy to navigate since it is where the
// company gets its capital." One page, five tabs (kept in the address,
// ?tab=…, so Back and refresh return to the same tab):
//   Overview     every active goal at a glance: progress, this month's
//                call, my pledge, what I owe, one-tap "Pledge"
//   Goals        the full list (all statuses), with type and investment
//   My pledges   what used to be the separate My Capital Calls page
//   Approvals    pledges waiting for the Treasurer (managers only)
//   Rules        how capital calls, deadlines and late fines work
// A secondary goal can now be tied to an investment when it is created
// (an existing one, or a new proposal).
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { capitalGoalsAPI, capitalGoalCallsAPI, accountsAPI } from '../../api/endpoints';
import { formatDate, getErrorMessage } from '../../utils/helpers';
import PageHeader from '../../components/common/PageHeader';
import DataTable from '../../components/common/DataTable';
import ErrorMessage from '../../components/common/ErrorMessage';
import StatusBadge from '../../components/common/StatusBadge';
import { useAuth } from '../../contexts/AuthContext';
import { useTabParam } from '../../hooks/useTabParam';
import { MyPledgesPanel } from './MyCapitalCallsPage';
import { GoalCard, OwedList, PledgeModal, pledgeTargetFor, money, periodLabel, StatTile } from './capitalGoalUi';
import { BLANK_TIE, InvestmentTieFields, tiePayload, useTieOptions } from './GoalInvestmentPanel';
import {
    PlusIcon, HandRaisedIcon, CheckBadgeIcon, ScaleIcon, BanknotesIcon, FlagIcon, Cog6ToothIcon,
} from '@heroicons/react/24/outline';

const currentFiscalYear = () => new Date().getFullYear();

// v1.43.0 — every new goal is call-based: shareholders pledge into
// equal monthly calls rather than the old free-form contribution
// flow. goal_type/fiscal_year/call_deadline_day are all required now.
const BLANK_FORM = {
    title: '', description: '', target_amount: '',
    currency_id: '', start_date: '', end_date: '',
    goal_type: 'PRIMARY', fiscal_year: String(currentFiscalYear()), call_deadline_day: '20',
    // v1.51.0 — left blank by default (defaults to start_date on the
    // server, i.e. every month live — no behaviour change unless
    // explicitly set).
    effective_from: '',
};

// ============================================================
// CREATE GOAL MODAL
// ============================================================
const CreateGoalModal = ({ isOpen, onClose, onSuccess, currencies, fineSettings }) => {
    const { hasPermission } = useAuth();
    const [form, setForm] = useState(BLANK_FORM);
    const [tie, setTie] = useState(BLANK_TIE); // v1.78.0 — secondary goal → investment
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const tieOptions = useTieOptions(isOpen && form.goal_type === 'SECONDARY');

    if (!isOpen) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await capitalGoalsAPI.create({
                title: form.title,
                description: form.description || undefined,
                target_amount: parseFloat(form.target_amount),
                currency_id: form.currency_id,
                start_date: form.start_date,
                end_date: form.end_date,
                goal_type: form.goal_type,
                fiscal_year: parseInt(form.fiscal_year),
                call_deadline_day: parseInt(form.call_deadline_day),
                effective_from: form.effective_from || undefined,
                ...(form.goal_type === 'SECONDARY' ? tiePayload(tie) : {}),
            });
            onSuccess();
            onClose();
            setForm(BLANK_FORM);
            setTie(BLANK_TIE);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    // Live preview of the even monthly split, so whoever's setting the
    // goal can see roughly what "on track" will mean before submitting.
    let monthlyPreview = null;
    if (form.target_amount && form.start_date && form.end_date &&
        new Date(form.end_date) >= new Date(form.start_date)) {
        const s = new Date(form.start_date);
        const e = new Date(form.end_date);
        const months = (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth()) + 1;
        if (months > 0) {
            monthlyPreview = (parseFloat(form.target_amount) / months).toLocaleString('en-US', { maximumFractionDigits: 2 });
        }
    }

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            <div className="fixed inset-0 bg-black bg-opacity-40" onClick={onClose} />
            <div className="flex min-h-full items-center justify-center p-4">
                <div className="relative bg-white rounded-xl shadow-xl max-w-lg w-full p-6">
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">New Capital Goal</h2>
                    <p className="text-sm text-gray-400 mb-4">
                        A target amount of shareholder capital to raise over a date range. The system splits it
                        evenly into monthly calls that shareholders pledge against ("call on shares") — a Treasurer
                        approves each pledge as it's paid, which is what actually counts toward progress here.
                    </p>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">Title *</label>
                            <input type="text" className="input" value={form.title}
                                onChange={e => setForm(p => ({ ...p, title: e.target.value }))}
                                placeholder="e.g. 2026 Capital Drive" required />
                        </div>
                        <div>
                            <label className="label">Description</label>
                            <textarea className="input" rows={2}
                                value={form.description}
                                onChange={e => setForm(p => ({ ...p, description: e.target.value }))} />
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="label">Goal Type *</label>
                                <select className="input" value={form.goal_type}
                                    onChange={e => setForm(p => ({ ...p, goal_type: e.target.value }))} required>
                                    <option value="PRIMARY">Primary (the year's general capital goal)</option>
                                    <option value="SECONDARY">Secondary (an extra goal alongside the primary)</option>
                                </select>
                                <p className="text-xs text-gray-400 mt-1">
                                    Each fiscal year has exactly one Primary goal — this is required once the
                                    feature is active. Any number of Secondary goals can also run in the same year.
                                </p>
                            </div>
                            <div>
                                <label className="label">Fiscal Year *</label>
                                <input type="number" className="input" value={form.fiscal_year}
                                    onChange={e => setForm(p => ({ ...p, fiscal_year: e.target.value }))}
                                    min="2000" max="2200" required />
                            </div>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="label">Target Amount *</label>
                                <input type="number" className="input" value={form.target_amount}
                                    onChange={e => setForm(p => ({ ...p, target_amount: e.target.value }))}
                                    min="0.01" step="0.01" required />
                            </div>
                            <div>
                                <label className="label">Currency *</label>
                                <select className="input" value={form.currency_id}
                                    onChange={e => setForm(p => ({ ...p, currency_id: e.target.value }))}
                                    required>
                                    <option value="">Select currency...</option>
                                    {currencies.map(c => (
                                        <option key={c.id} value={c.id}>{c.code} — {c.name}</option>
                                    ))}
                                </select>
                            </div>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="label">Start Date *</label>
                                <input type="date" className="input" value={form.start_date}
                                    onChange={e => setForm(p => ({ ...p, start_date: e.target.value }))}
                                    required />
                            </div>
                            <div>
                                <label className="label">End Date *</label>
                                <input type="date" className="input" value={form.end_date}
                                    min={form.start_date || undefined}
                                    onChange={e => setForm(p => ({ ...p, end_date: e.target.value }))}
                                    required />
                            </div>
                        </div>
                        <div>
                            <label className="label">Monthly Call Deadline Day *</label>
                            <input type="number" className="input" value={form.call_deadline_day}
                                onChange={e => setForm(p => ({ ...p, call_deadline_day: e.target.value }))}
                                min="1" max="28" required />
                            <p className="text-xs text-gray-400 mt-1">
                                The day of each month pledges are due by (1–28, so it applies safely to every
                                month including February). A shareholder who settles their pledge late is fined
                                {` ${fineSettings ? fineSettings.fine_percentage_within_grace : 5}% if within ${fineSettings ? fineSettings.grace_days : 7} days of this deadline, ${fineSettings ? fineSettings.fine_percentage_after_grace : 10}% after that`}
                                {' '}(set by an Admin under Settings → Capital Goals).
                            </p>
                        </div>
                        <div>
                            <label className="label">Effective Date of Adoption</label>
                            <input type="date" className="input" value={form.effective_from}
                                min={form.start_date || undefined}
                                max={form.end_date || undefined}
                                onChange={e => setForm(p => ({ ...p, effective_from: e.target.value }))} />
                            <p className="text-xs text-gray-400 mt-1">
                                Optional — leave blank if pledging should start right at the beginning (Start Date
                                above). If this goal is being adopted mid-year, set this to the 1st of the month
                                pledging actually starts. Every month before it is still shown for reference, using
                                a read-only total of contributions already recorded that month — nobody pledges or
                                gets fined for those earlier months.
                            </p>
                        </div>
                        {form.goal_type === 'SECONDARY' && (
                            <InvestmentTieFields value={tie} onChange={setTie}
                                investments={tieOptions.investments} accounts={tieOptions.accounts}
                                canCreate={hasPermission('INVESTMENT_CREATE')} />
                        )}
                        {monthlyPreview && (
                            <p className="text-xs text-gray-400 bg-gray-50 rounded-lg px-3 py-2">
                                ≈ {monthlyPreview} expected per month over this range
                            </p>
                        )}
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading} className="btn-primary">
                                {loading ? 'Saving...' : 'Create Goal'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// GOALS TAB — every goal, any status
// ============================================================
const GoalsListPanel = ({ reloadKey }) => {
    const [goals,      setGoals]      = useState([]);
    const [pagination, setPagination] = useState(null);
    const [loading,    setLoading]    = useState(true);
    const [error,      setError]      = useState(null);
    const [page,       setPage]       = useState(1);
    const [statusFilter, setStatusFilter] = useState('');
    const [typeFilter, setTypeFilter] = useState('');

    const loadGoals = useCallback(async () => {
        try {
            setLoading(true);
            const params = { page, limit: 20 };
            if (statusFilter) params.status = statusFilter;
            const res = await capitalGoalsAPI.getAll(params);
            setGoals(res.data.data);
            setPagination(res.data.meta?.pagination);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, [page, statusFilter]);

    useEffect(() => { loadGoals(); }, [loadGoals, reloadKey]);

    const shown = typeFilter ? goals.filter(g => (g.goal_type || 'LEGACY') === typeFilter) : goals;

    const columns = [
        {
            header: 'Reference',
            render: row => (
                <div>
                    <span className="font-mono text-xs font-medium text-primary-700">
                        {row.reference_code}
                    </span>
                    {row.public_id && (
                        <div className="font-mono text-[10px] text-gray-400" title="Public ID — searchable">
                            {row.public_id}
                        </div>
                    )}
                </div>
            ),
        },
        {
            header: 'Goal',
            render: row => (
                <div>
                    <div className="flex items-center gap-2 flex-wrap">
                        <Link to={`/capital-goals/${row.id}`}
                            className="text-sm font-medium text-primary-700 hover:text-primary-800 hover:underline">
                            {row.title}
                        </Link>
                        {/* v1.48.0 — a legacy (pre-v1.43.0) goal never got a
                            monthly pledge schedule and nobody can pledge
                            into it until an Admin/Treasurer activates one
                            from its detail page. */}
                        {row.status === 'ACTIVE' && !row.goal_type && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium flex-shrink-0">
                                Calls not activated
                            </span>
                        )}
                    </div>
                    <p className="text-xs text-gray-400">
                        {formatDate(row.start_date)} – {formatDate(row.end_date)}
                    </p>
                    {row.investment_name && (
                        <Link to={`/capital-goals/${row.id}?tab=investment`} className="text-[11px] text-teal-700 hover:underline">
                            For: {row.investment_name}
                        </Link>
                    )}
                </div>
            ),
        },
        {
            header: 'Type',
            render: row => row.goal_type
                ? <span className={row.goal_type === 'PRIMARY' ? 'badge-purple' : 'badge-teal'}>{row.goal_type === 'PRIMARY' ? 'Primary' : 'Secondary'}</span>
                : <span className="badge-gray">Legacy</span>,
        },
        {
            header: 'Target',
            render: row => (
                <span className="text-sm font-semibold text-gray-900 whitespace-nowrap">
                    {money(row.target_amount, row.currency_code)}
                </span>
            ),
        },
        {
            header: 'Collected',
            render: row => (
                <div>
                    <span className="text-sm text-gray-700 whitespace-nowrap">
                        {money(row.total_collected, row.currency_code)}
                    </span>
                    <div className="w-28 h-1.5 bg-gray-100 rounded-full mt-1 overflow-hidden">
                        <div className={`h-full rounded-full ${
                            row.progress_status === 'BEHIND' ? 'bg-red-500' : 'bg-green-500'
                        }`} style={{ width: `${Math.min(100, row.percent_of_target)}%` }} />
                    </div>
                    <p className="text-[11px] text-gray-400 mt-0.5">{row.percent_of_target}% of target</p>
                </div>
            ),
        },
        {
            header: 'Progress',
            render: row => (
                row.status === 'ACTIVE' ? (
                    <StatusBadge status={row.progress_status} />
                ) : (
                    <span className="text-gray-300 text-xs">—</span>
                )
            ),
        },
        {
            header: 'Status',
            render: row => <StatusBadge status={row.status} />,
        },
    ];

    return (
        <div>
            {error && (
                <div className="mb-4">
                    <ErrorMessage message={error} onDismiss={() => setError(null)} />
                </div>
            )}
            <div className="card mb-4 flex flex-wrap gap-x-6 gap-y-3">
                <div className="flex gap-2 flex-wrap items-center">
                    <span className="text-xs text-gray-400 mr-1">Status</span>
                    {['', 'ACTIVE', 'COMPLETED', 'CANCELLED'].map(s => (
                        <button key={s}
                            onClick={() => { setStatusFilter(s); setPage(1); }}
                            className={`chip-filter ${statusFilter === s ? 'chip-filter-active' : ''}`}>
                            {s ? s.charAt(0) + s.slice(1).toLowerCase() : 'All'}
                        </button>
                    ))}
                </div>
                <div className="flex gap-2 flex-wrap items-center">
                    <span className="text-xs text-gray-400 mr-1">Type</span>
                    {[['', 'All'], ['PRIMARY', 'Primary'], ['SECONDARY', 'Secondary']].map(([k, label]) => (
                        <button key={k} onClick={() => setTypeFilter(k)}
                            className={`chip-filter ${typeFilter === k ? 'chip-filter-active' : ''}`}>
                            {label}
                        </button>
                    ))}
                </div>
            </div>
            <DataTable
                columns={columns}
                data={shown}
                loading={loading}
                emptyMessage="No capital goals found"
                searchable
                searchPlaceholder="Search goals..."
                pagination={pagination}
                onPageChange={setPage}
            />
        </div>
    );
};

// ============================================================
// OVERVIEW TAB
// ============================================================
// "EUR 950.00 + UGX 200,000.00" — one total per currency, never mixed.
const byCurrency = (goals, pick) => {
    const t = {};
    for (const g of goals) {
        const v = pick(g);
        if (v === null || v === undefined || v === false) continue;
        t[g.currency_code] = (t[g.currency_code] || 0) + parseFloat(v);
    }
    const parts = Object.entries(t).map(([c, v]) => money(v, c));
    return parts.length ? parts.join(' + ') : '—';
};
const OverviewPanel = ({ overview, onPledge, onTab, canManage }) => {
    const { goals, me, approvals } = overview;
    const owedCurrencies = Object.entries(me.owed_by_currency || {});
    const openToPledge = goals.filter(g => g.current_call && g.current_call.can_pledge);
    const behind = goals.filter(g => g.progress_status === 'BEHIND').length;

    return (
        <div className="space-y-6">
            {!overview.tracking_enabled && (
                <div className="rounded-lg bg-amber-50 border border-amber-100 p-3 text-sm text-amber-800">
                    Capital goal tracking is turned off for the company — goals are shown for reference only.
                </div>
            )}

            {/* Quick figures */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <StatTile label="Active goals" value={goals.length} icon={FlagIcon}
                    sub={behind ? `${behind} behind schedule` : 'all on track'} tone={behind ? 'warn' : 'default'} />
                {overview.is_shareholder !== false ? (
                    <StatTile label="Open for my pledge" value={openToPledge.length} icon={HandRaisedIcon}
                        sub={openToPledge.length ? 'tap “Pledge” on a goal below' : 'nothing waiting for me'}
                        tone={openToPledge.length ? 'warn' : 'good'} />
                ) : (
                    <StatTile label="Collected this month" icon={HandRaisedIcon}
                        value={byCurrency(goals, g => g.current_call && g.current_call.settled)}
                        sub={`of ${byCurrency(goals, g => g.current_call && g.current_call.monthly_target)} called this month`} />
                )}
                <StatTile label="I still owe" icon={BanknotesIcon}
                    value={owedCurrencies.length ? owedCurrencies.map(([c, v]) => money(v, c)).join(' + ') : 'Nothing'}
                    sub={me.next_due ? `next: pay by ${formatDate(me.next_due.pay_by)}` : 'all my pledges are settled'}
                    tone={me.owed.some(o => o.overdue) ? 'bad' : owedCurrencies.length ? 'default' : 'good'} />
                {canManage && approvals ? (
                    <StatTile label="Pledges awaiting approval" value={approvals.count} icon={CheckBadgeIcon}
                        sub={approvals.count ? 'see the Approvals tab' : 'queue is empty'} tone={approvals.count ? 'warn' : 'good'} />
                ) : (
                    <StatTile label="Late fines" icon={ScaleIcon}
                        value={overview.fines ? `${overview.fines.within_grace_pct}% / ${overview.fines.after_grace_pct}%` : '—'}
                        sub={`within / after ${overview.grace_days} days late`} />
                )}
            </div>

            {/* What I owe */}
            {me.owed.length > 0 && (
                <div className="card">
                    <div className="flex items-center justify-between gap-2 mb-2">
                        <h3 className="section-title">What I still owe</h3>
                        <button type="button" onClick={() => onTab('mine')} className="text-xs text-primary-700 hover:underline">All my pledges</button>
                    </div>
                    <OwedList owed={me.owed} />
                    <p className="text-[11px] text-gray-400 mt-2">
                        Pay into the company account as usual — the Treasurer matches the payment to your pledge.
                    </p>
                </div>
            )}

            {/* Goals */}
            {goals.length === 0 ? (
                <div className="card text-center py-10">
                    <FlagIcon className="h-8 w-8 text-gray-300 mx-auto" />
                    <p className="text-sm text-gray-500 mt-2">No active capital goals.</p>
                    <button type="button" onClick={() => onTab('goals')} className="text-xs text-primary-700 hover:underline mt-1">See past goals</button>
                </div>
            ) : (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    {goals.map(g => <GoalCard key={g.id} goal={g} onPledge={onPledge} isShareholder={overview.is_shareholder !== false} />)}
                </div>
            )}

            {/* Approvals preview */}
            {canManage && approvals && approvals.count > 0 && (
                <div className="card">
                    <div className="flex items-center justify-between gap-2 mb-2">
                        <h3 className="section-title">Oldest pledges awaiting approval</h3>
                        <button type="button" onClick={() => onTab('approvals')} className="text-xs text-primary-700 hover:underline">
                            All {approvals.count}
                        </button>
                    </div>
                    <ApprovalRows rows={approvals.oldest} />
                </div>
            )}
        </div>
    );
};

// Pledges waiting for the Treasurer — each links to its month's page,
// where the approval form is.
const ApprovalRows = ({ rows }) => (
    <div className="divide-y divide-gray-100">
        {rows.map(r => (
            <Link key={r.id} to={`/capital-goals/monthly-calls/${r.monthly_call_id}#approvals`}
                className="flex items-center justify-between gap-3 py-2 hover:bg-gray-50 rounded px-1 -mx-1">
                <div className="min-w-0">
                    <p className="text-sm text-gray-800 truncate">
                        <strong>{r.member_name}</strong> — {r.goal_title}
                    </p>
                    <p className="text-[11px] text-gray-400">
                        {periodLabel(r.period)}{r.iteration === 2 ? ' (round 2)' : ''} · pledged {formatDate(r.submitted_at)}
                        {parseFloat(r.amount_settled) > 0 && ` · ${money(r.amount_settled, r.currency_code)} already paid`}
                    </p>
                </div>
                <div className="text-right flex-shrink-0">
                    <p className="text-sm font-semibold text-gray-900">{money(r.pledged_amount, r.currency_code)}</p>
                    <span className="text-[11px] text-primary-700">Review →</span>
                </div>
            </Link>
        ))}
    </div>
);

const ApprovalsPanel = ({ reloadKey }) => {
    const [rows, setRows] = useState(null);
    const [error, setError] = useState(null);
    const [goalFilter, setGoalFilter] = useState('');
    useEffect(() => {
        capitalGoalCallsAPI.getPendingPledges()
            .then(r => setRows(r.data.data || []))
            .catch(err => setError(getErrorMessage(err)));
    }, [reloadKey]);
    if (error) return <ErrorMessage message={error} />;
    if (!rows) return <div className="card text-sm text-gray-400">Loading...</div>;
    const goals = [...new Map(rows.map(r => [r.goal_id, r.goal_title])).entries()];
    const shown = goalFilter ? rows.filter(r => String(r.goal_id) === goalFilter) : rows;
    const totals = {};
    for (const r of shown) totals[r.currency_code] = (totals[r.currency_code] || 0) + (parseFloat(r.pledged_amount) - parseFloat(r.amount_settled || 0));
    return (
        <div className="card">
            <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
                <div>
                    <h3 className="section-title">Pledges awaiting approval ({shown.length})</h3>
                    <p className="text-xs text-gray-400 mt-0.5">
                        Still to be paid/approved: {Object.entries(totals).map(([c, v]) => money(v, c)).join(' + ') || '—'}.
                        Open one to record the payment against it.
                    </p>
                </div>
                {goals.length > 1 && (
                    <select className="input w-auto text-sm" value={goalFilter} onChange={e => setGoalFilter(e.target.value)}>
                        <option value="">All goals</option>
                        {goals.map(([id, title]) => <option key={id} value={id}>{title}</option>)}
                    </select>
                )}
            </div>
            {shown.length === 0
                ? <p className="text-sm text-gray-400 py-4 text-center">Nothing waiting for approval.</p>
                : <ApprovalRows rows={shown} />}
        </div>
    );
};

// ============================================================
// RULES TAB — how it works (everyone), with the live fine settings
// ============================================================
const RulesPanel = ({ overview, isAdmin }) => {
    const f = overview.fines || {};
    const g = overview.grace_days;
    return (
        <div className="card space-y-4 text-sm text-gray-700 max-w-3xl">
            <h3 className="section-title">How capital goals work</h3>
            <ol className="list-decimal pl-5 space-y-2">
                <li><strong>A goal</strong> is an amount of capital to raise between two dates. Each fiscal year has one
                    <em> primary</em> goal (the year's general capital) and may have any number of <em>secondary</em> goals —
                    a secondary goal can raise money for one particular investment.</li>
                <li><strong>Monthly calls.</strong> The target is split evenly into months. Each month every shareholder is
                    asked to pledge — the suggested equal share is shown, but any amount (even zero) is allowed.</li>
                <li><strong>Paying.</strong> Pay into the company account as usual. The Treasurer records the payment
                    against your pledge; only approved payments count towards the goal.</li>
                <li><strong>Deadlines and fines.</strong> A first-round pledge paid after the month's deadline is fined
                    <strong> {f.within_grace_pct ?? 5}%</strong> of the late amount if it is up to {g} days late, and
                    <strong> {f.after_grace_pct ?? 10}%</strong> after that. Second-round (remaining balance) pledges are never fined.</li>
                <li><strong>Round 2.</strong> If a month is not met by its deadline, members who pledged above the equal share may
                    pledge again for the remaining balance.</li>
                <li><strong>Everyone can see</strong> who pledged and paid how much (Pledgers tab of each goal), so the
                    raising is open and fair.</li>
                <li><strong>Goal money into an investment.</strong> For a secondary goal tied to an investment, a Director moves
                    the collected money to the investment's operational account (with the exchange rate when the currencies
                    differ, approved by the Treasurer), and it is then invested — never more than the goal collected.</li>
            </ol>
            {isAdmin && (
                <Link to="/settings?tab=capital-call-fines" className="btn-secondary inline-flex items-center gap-2">
                    <Cog6ToothIcon className="h-4 w-4" /> Change the fine rates or switch tracking off
                </Link>
            )}
        </div>
    );
};

// ============================================================
// MAIN CAPITAL GOALS PAGE (the hub)
// ============================================================
const CapitalGoalsPage = () => {
    const { hasPermission, hasRole } = useAuth();
    const canManage = hasPermission('CAPITAL_GOAL_MANAGE');
    const [tab, setTab] = useTabParam('overview');
    const [overview, setOverview] = useState(null);
    const [currencies, setCurrencies] = useState([]);
    const [fineSettings, setFineSettings] = useState(null);
    const [error, setError] = useState(null);
    const [showCreate, setShowCreate] = useState(false);
    const [pledgeTarget, setPledgeTarget] = useState(null);
    const [reloadKey, setReloadKey] = useState(0);

    const loadOverview = useCallback(async () => {
        try {
            const r = await capitalGoalsAPI.getOverview();
            setOverview(r.data.data);
        } catch (err) {
            setError(getErrorMessage(err));
        }
    }, []);

    useEffect(() => {
        loadOverview();
        accountsAPI.getCurrencies().then(r => setCurrencies(r.data.data)).catch(() => {});
        capitalGoalsAPI.getFineSettings().then(r => setFineSettings(r.data.data)).catch(() => {});
    }, [loadOverview]);

    const changed = () => { loadOverview(); setReloadKey(k => k + 1); };

    const owedCount = overview ? overview.me.owed.length : 0;
    const openCount = overview ? overview.me.open_to_pledge : 0;
    const tabs = [
        { key: 'overview', label: 'Overview' },
        { key: 'goals', label: 'All goals' },
        { key: 'mine', label: 'My pledges', badge: openCount + owedCount || null },
        ...(canManage ? [{ key: 'approvals', label: 'Approvals', badge: overview && overview.approvals ? overview.approvals.count || null : null }] : []),
        { key: 'rules', label: 'How it works' },
    ];

    return (
        <div>
            <PageHeader
                title="Capital Goals"
                subtitle="Raise the company's capital month by month — goals, pledges, payments and where the money went"
                actions={
                    canManage && (
                        <button onClick={() => setShowCreate(true)} className="btn-primary flex items-center gap-2">
                            <PlusIcon className="h-4 w-4" />
                            New Goal
                        </button>
                    )
                }
            />

            {error && (
                <div className="mb-4">
                    <ErrorMessage message={error} onDismiss={() => setError(null)} />
                </div>
            )}

            <div className="tab-bar" role="tablist">
                {tabs.map(t => (
                    <button key={t.key} role="tab" aria-selected={tab === t.key}
                        onClick={() => setTab(t.key)}
                        className={`tab ${tab === t.key ? 'tab-active' : ''}`}>
                        {t.label}
                        {t.badge ? (
                            <span className="ml-2 inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 rounded-full bg-red-500 text-white text-[11px] font-semibold">
                                {t.badge}
                            </span>
                        ) : null}
                    </button>
                ))}
            </div>

            {tab === 'overview' && (overview
                ? <OverviewPanel overview={overview} canManage={canManage} onTab={setTab}
                    onPledge={(g) => setPledgeTarget(pledgeTargetFor(g))} />
                : <div className="card text-sm text-gray-400">Loading...</div>)}
            {tab === 'goals' && <GoalsListPanel reloadKey={reloadKey} />}
            {tab === 'mine' && <MyPledgesPanel onChanged={loadOverview} />}
            {tab === 'approvals' && canManage && <ApprovalsPanel reloadKey={reloadKey} />}
            {tab === 'rules' && overview && <RulesPanel overview={overview} isAdmin={hasRole('Admin')} />}

            <CreateGoalModal
                isOpen={showCreate}
                onClose={() => setShowCreate(false)}
                onSuccess={changed}
                currencies={currencies}
                fineSettings={fineSettings}
            />
            <PledgeModal
                isOpen={!!pledgeTarget}
                onClose={() => setPledgeTarget(null)}
                onSuccess={changed}
                target={pledgeTarget}
                currencies={currencies}
            />
        </div>
    );
};

export default CapitalGoalsPage;
