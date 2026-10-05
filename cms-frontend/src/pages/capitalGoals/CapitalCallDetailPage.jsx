// ============================================================
// CAPITAL CALL DETAIL PAGE (v1.43.0)
// One monthly capital call. Two audiences share this page:
//   - Every member sees the colour-coded status grid — one cell per
//     active shareholder.
//     v1.78.0 — requested: "make the names of the pledgers shown"
//     (confirmed: all members see names + amounts). The grid now
//     carries each member's name, and a member-by-member table lists
//     what each one pledged, paid and still owes this month.
//   - A Treasurer (CAPITAL_GOAL_MANAGE) also sees the approval queue:
//     every pledge submitted against this call, with Approve/Reject
//     actions. Approving IS the act of recording the payment — the
//     receiving account must match the pledge's own currency.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { capitalGoalCallsAPI, capitalGoalsAPI, accountsAPI } from '../../api/endpoints';
import { formatDate, formatNumber, getErrorMessage } from '../../utils/helpers';
import PageHeader from '../../components/common/PageHeader';
import LoadingSpinner from '../../components/common/LoadingSpinner';
import ErrorMessage from '../../components/common/ErrorMessage';
import StatusBadge from '../../components/common/StatusBadge';
import { useAuth } from '../../contexts/AuthContext';
import { CheckIcon, XMarkIcon, HandRaisedIcon } from '@heroicons/react/24/outline';
import { MemberStatus, PledgeModal, pledgeTargetFor, money, pct, ProgressBar } from './capitalGoalUi';

// ============================================================
// STATUS GRID CELL COLOURS — deliberately separate from the shared
// badge-* classes: this is a dense grid of small squares, not pill
// badges, so it needs its own compact swatch styling.
// ============================================================
const CELL_STYLES = {
    PAID:            { bg: 'bg-green-500',  label: 'Paid in full' },
    PARTIALLY_PAID:  { bg: 'bg-yellow-400', label: 'Partially paid' },
    PARTIAL_OVERDUE: { bg: 'bg-orange-500', label: 'Partially paid, past deadline' },
    PLEDGED:         { bg: 'bg-blue-400',   label: 'Pledged, not yet paid' },
    DEFAULTED:       { bg: 'bg-red-500',    label: 'Pledged but past deadline, unpaid' },
    NOT_RESPONDED:   { bg: 'bg-gray-200',   label: 'No pledge made' },
};

// ============================================================
// APPROVE PLEDGE MODAL — Treasurer. This is the money-moving action:
// records the payment, issues shares, and (iteration 1 only, if
// late) auto-assigns a fine — matching approvePledgePaymentmoney flow.
// ============================================================
const ApproveModal = ({ isOpen, onClose, onSuccess, pledge, accounts }) => {
    const [amount, setAmount] = useState('');
    const [accountId, setAccountId] = useState('');
    const [paidDate, setPaidDate] = useState('');
    const [notes, setNotes] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [result, setResult] = useState(null);

    useEffect(() => {
        if (isOpen && pledge) {
            const outstanding = parseFloat(pledge.pledged_amount) - parseFloat(pledge.amount_settled || 0);
            setAmount(outstanding > 0 ? outstanding.toFixed(2) : '');
            setAccountId('');
            setPaidDate(new Date().toISOString().slice(0, 10));
            setNotes('');
            setResult(null);
            setError(null);
        }
    }, [isOpen, pledge]);

    if (!isOpen || !pledge) return null;

    // The receiving account's currency must match the pledge's own
    // currency — enforced server-side too, this just avoids offering
    // an account that would obviously be rejected.
    const matchingAccounts = accounts.filter(a => a.currency_code === pledge.currency_code);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            const res = await capitalGoalCallsAPI.approvePledgePayment(pledge.id, {
                amount: parseFloat(amount),
                account_id: parseInt(accountId),
                paid_date: paidDate,
                notes: notes || undefined,
            });
            setResult(res.data.data);
            onSuccess();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    const handleDone = () => { setResult(null); onClose(); };

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            <div className="fixed inset-0 bg-black bg-opacity-40" onClick={result ? handleDone : onClose} />
            <div className="flex min-h-full items-center justify-center p-4">
                <div className="relative bg-white rounded-xl shadow-xl max-w-md w-full p-6">
                    {result ? (
                        <>
                            <h2 className="text-lg font-semibold text-gray-900 mb-1">Payment Recorded</h2>
                            <p className="text-sm text-gray-400 mb-4">
                                {result.isLate
                                    ? `Settled ${result.daysLate} day(s) late.`
                                    : 'Settled on time — no fine.'}
                            </p>
                            {result.isLate && result.fine && (
                                <div className="bg-red-50 border border-red-100 rounded-lg px-3 py-2 mb-4 text-sm text-red-800">
                                    A {result.fine.percentage}% late fine of {formatNumber(result.fine.amount)} was
                                    automatically recorded against this member's account.
                                </div>
                            )}
                            <div className="flex justify-end pt-2">
                                <button onClick={handleDone} className="btn-primary">Done</button>
                            </div>
                        </>
                    ) : (
                        <>
                            <h2 className="text-lg font-semibold text-gray-900 mb-1">Approve Pledge Payment</h2>
                            <p className="text-sm text-gray-400 mb-4">
                                {pledge.member_name} pledged {formatNumber(pledge.pledged_amount)} {pledge.currency_code}
                                {parseFloat(pledge.amount_settled || 0) > 0 && ` (already settled: ${formatNumber(pledge.amount_settled)})`}.
                                Approving this records the payment as arrived and counts it toward the member's
                                capital contribution and share balance.
                            </p>
                            {error && (
                                <div className="mb-4">
                                    <ErrorMessage message={error} onDismiss={() => setError(null)} />
                                </div>
                            )}
                            <form onSubmit={handleSubmit} className="space-y-4">
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                    <div>
                                        <label className="label">Amount *</label>
                                        <input type="number" className="input" value={amount}
                                            onChange={e => setAmount(e.target.value)}
                                            min="0.01" step="0.01" required />
                                    </div>
                                    <div>
                                        <label className="label">Date Paid *</label>
                                        <input type="date" className="input" value={paidDate}
                                            max={new Date().toISOString().slice(0, 10)}
                                            onChange={e => setPaidDate(e.target.value)} required />
                                    </div>
                                </div>
                                <div>
                                    <label className="label">Receiving Account *</label>
                                    <select className="input" value={accountId}
                                        onChange={e => setAccountId(e.target.value)} required>
                                        <option value="">Select account...</option>
                                        {matchingAccounts.map(a => (
                                            <option key={a.id} value={a.id}>{a.name} ({a.currency_code})</option>
                                        ))}
                                    </select>
                                    {matchingAccounts.length === 0 && (
                                        <p className="text-xs text-red-600 mt-1">
                                            No account in {pledge.currency_code} exists yet — create one before approving.
                                        </p>
                                    )}
                                </div>
                                <div>
                                    <label className="label">Notes</label>
                                    <textarea className="input" rows={2} value={notes}
                                        onChange={e => setNotes(e.target.value)} />
                                </div>
                                <div className="flex justify-end gap-3 pt-2">
                                    <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                                    <button type="submit" disabled={loading || matchingAccounts.length === 0} className="btn-primary">
                                        {loading ? 'Recording...' : 'Approve & Record Payment'}
                                    </button>
                                </div>
                            </form>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};

// ============================================================
// REJECT PLEDGE MODAL — Treasurer, only while nothing's settled yet.
// ============================================================
const RejectModal = ({ isOpen, onClose, onSuccess, pledge }) => {
    const [notes, setNotes] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => { if (isOpen) { setNotes(''); setError(null); } }, [isOpen]);

    if (!isOpen || !pledge) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await capitalGoalCallsAPI.rejectPledge(pledge.id, { review_notes: notes || undefined });
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
                <div className="relative bg-white rounded-xl shadow-xl max-w-sm w-full p-6">
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">Reject This Pledge?</h2>
                    <p className="text-sm text-gray-400 mb-4">
                        {pledge.member_name}'s pledge of {formatNumber(pledge.pledged_amount)} {pledge.currency_code}
                        will be marked rejected — they'll no longer appear as having pledged this month.
                    </p>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">Reason (optional)</label>
                            <textarea className="input" rows={2} value={notes}
                                onChange={e => setNotes(e.target.value)} />
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading} className="btn-danger">
                                {loading ? 'Rejecting...' : 'Reject Pledge'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// MAIN PAGE
// ============================================================
const CapitalCallDetailPage = () => {
    const { id } = useParams();
    const { hasPermission } = useAuth();
    const canManage = hasPermission('CAPITAL_GOAL_MANAGE');

    const [call, setCall] = useState(null);
    const [status, setStatus] = useState(null);
    const [pledges, setPledges] = useState([]);
    const [accounts, setAccounts] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [approving, setApproving] = useState(null);
    const [rejecting, setRejecting] = useState(null);
    const [members, setMembers] = useState(null);   // v1.78.0 — by name
    const [glance, setGlance] = useState(null);     // the goal as the overview sees it (my pledge, can I pledge)
    const [currencies, setCurrencies] = useState([]);
    const [pledgeTarget, setPledgeTarget] = useState(null);
    const [memberFilter, setMemberFilter] = useState('');

    const load = useCallback(async () => {
        try {
            setLoading(true);
            const [callRes, statusRes] = await Promise.all([
                capitalGoalCallsAPI.getMonthlyCallById(id),
                capitalGoalCallsAPI.getMonthlyCallStatus(id),
            ]);
            setCall(callRes.data.data);
            setStatus(statusRes.data.data);
            capitalGoalCallsAPI.getCallMembers(id).then(r => setMembers(r.data.data)).catch(() => {});
            capitalGoalsAPI.getOverview()
                .then(r => setGlance((r.data.data.goals || []).find(g => g.id === callRes.data.data.goal_id) || null))
                .catch(() => {});
            if (canManage) {
                const pledgesRes = await capitalGoalCallsAPI.getPledgesForMonthlyCall(id);
                setPledges(pledgesRes.data.data || []);
            }
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, [id, canManage]);

    useEffect(() => {
        load();
        accountsAPI.getCurrencies().then(r => setCurrencies(r.data.data || [])).catch(() => {});
        if (canManage) {
            accountsAPI.getAll().then(r => setAccounts(r.data.data || [])).catch(() => {});
        }
    }, [load, canManage]);

    if (loading && !call) return <LoadingSpinner fullPage text="Loading capital call..." />;
    if (error && !call) return <ErrorMessage message={error} />;
    if (!call) return null;

    const fmt = (v) => `${call.currency_code} ${formatNumber(v)}`;
    const metCount = members ? members.summary.paid_in_full : (status?.cells.filter(c => c.status === 'PAID').length || 0);
    const totalCount = members ? members.summary.members : (status?.cells.length || 0);
    const summary = members ? members.summary : null;
    // This call is the goal's open month and I may still pledge into it?
    const thisIsOpen = glance && glance.current_call && glance.current_call.id === call.id;
    const canPledgeHere = thisIsOpen && glance.current_call.can_pledge;
    const myPledge = thisIsOpen ? glance.current_call.my_pledge : null;
    const memberRows = members ? members.members.filter(m => !memberFilter || m.status === memberFilter
        || (memberFilter === 'PARTIALLY_PAID' && m.status === 'PARTIAL_OVERDUE')) : [];

    return (
        <div>
            <PageHeader
                title={`${call.goal_title} — ${call.period}`}
                subtitle={`Iteration 1 deadline: ${formatDate(call.iteration1_deadline)}${
                    call.iteration2_deadline ? ` · Iteration 2 deadline: ${formatDate(call.iteration2_deadline)}` : ''
                }`}
                showBack
                backTo={`/capital-goals/${call.goal_id}`}
                actions={<StatusBadge status={call.status} />}
            />

            {error && (
                <div className="mb-4">
                    <ErrorMessage message={error} onDismiss={() => setError(null)} />
                </div>
            )}

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                <div className="card">
                    <p className="text-xs font-medium text-gray-500">Monthly Target</p>
                    <p className="mt-1 text-xl font-bold text-gray-900">{fmt(call.monthly_target)}</p>
                </div>
                <div className="card">
                    <p className="text-xs font-medium text-gray-500">Settled So Far</p>
                    <p className={`mt-1 text-xl font-bold ${parseFloat(call.settled) >= parseFloat(call.monthly_target) ? 'text-green-600' : 'text-gray-900'}`}>
                        {fmt(call.settled)}
                    </p>
                    {summary && (
                        <>
                            <ProgressBar percent={summary.percent} tone="info" className="h-1.5 mt-2" />
                            <p className="text-xs text-gray-400 mt-1">
                                {pct(summary.percent)} of the target{summary.shortfall > 0 ? ` · short ${fmt(summary.shortfall)}` : ' · met'}
                            </p>
                        </>
                    )}
                </div>
                <div className="card">
                    <p className="text-xs font-medium text-gray-500">Shareholders Paid In Full</p>
                    <p className="mt-1 text-xl font-bold text-gray-900">{metCount} / {totalCount}</p>
                    {summary && (
                        <p className="text-xs text-gray-400 mt-1">
                            {summary.pledged_members} pledged · {fmt(summary.total_pledged)} pledged in all
                        </p>
                    )}
                </div>
                <div className="card">
                    <p className="text-xs font-medium text-gray-500">My pledge this month</p>
                    {myPledge ? (
                        <>
                            <p className="mt-1 text-lg font-bold text-gray-900">{money(myPledge.pledged_amount, myPledge.currency_code)}</p>
                            <p className="text-xs text-gray-400">paid {money(myPledge.amount_settled, myPledge.currency_code)} · {myPledge.status.toLowerCase()}</p>
                        </>
                    ) : canPledgeHere ? (
                        <button type="button" onClick={() => setPledgeTarget(pledgeTargetFor(glance))}
                            className="btn-primary mt-2 flex items-center gap-2 text-sm">
                            <HandRaisedIcon className="h-4 w-4" /> Pledge now
                        </button>
                    ) : (
                        <p className="mt-1 text-sm text-gray-400">{thisIsOpen ? 'Not open to me' : 'This month is not open for pledges'}</p>
                    )}
                    <Link to="/capital-goals?tab=mine" className="block text-xs text-primary-700 hover:underline mt-2">
                        All my pledges →
                    </Link>
                </div>
            </div>

            {/* Colour-coded status grid — one cell per active shareholder.
                v1.78.0 — each cell now names the member (hover / long
                press), and the table below gives the amounts. */}
            <div className="card mb-6">
                <h3 className="section-title mb-1">Status — Who's Pledged / Paid</h3>
                <p className="text-xs text-gray-400 mb-4">
                    One square per shareholder. Point at (or press) a square to see who it is; the table below lists everyone.
                </p>
                <div className="flex flex-wrap gap-1.5 mb-4">
                    {members ? members.members.filter(m => m.is_shareholder).map(m => (
                        <div key={m.user_id}
                            title={`${m.name} — ${CELL_STYLES[m.status]?.label || m.status}`}
                            className={`h-6 w-6 rounded ${CELL_STYLES[m.status]?.bg || 'bg-gray-200'}`} />
                    )) : (status?.cells || []).map((cell, i) => (
                        <div key={i}
                            title={CELL_STYLES[cell.status]?.label || cell.status}
                            className={`h-6 w-6 rounded ${CELL_STYLES[cell.status]?.bg || 'bg-gray-200'}`} />
                    ))}
                    {totalCount === 0 && <p className="text-sm text-gray-400">No active shareholders found</p>}
                </div>
                <div className="flex flex-wrap gap-4 pt-3 border-t border-gray-100">
                    {Object.entries(CELL_STYLES).map(([key, s]) => (
                        <div key={key} className="flex items-center gap-1.5">
                            <div className={`h-3 w-3 rounded ${s.bg}`} />
                            <span className="text-xs text-gray-500">{s.label}</span>
                        </div>
                    ))}
                </div>
            </div>

            {/* v1.78.0 — member by member, by name */}
            {members && (
                <div className="card mb-6">
                    <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
                        <h3 className="section-title">Member by member</h3>
                        <div className="flex gap-2 flex-wrap">
                            {[['', 'Everyone'], ['PAID', 'Paid'], ['PARTIALLY_PAID', 'Part paid'], ['PLEDGED', 'Pledged'],
                              ['DEFAULTED', 'Missed'], ['NOT_RESPONDED', 'No pledge']].map(([k, label]) => {
                                const n = k ? (k === 'PARTIALLY_PAID'
                                    ? (members.summary.counts.PARTIALLY_PAID || 0) + (members.summary.counts.PARTIAL_OVERDUE || 0)
                                    : members.summary.counts[k] || 0) : members.members.length;
                                return (
                                    <button key={k} type="button" onClick={() => setMemberFilter(k)}
                                        className={`chip-filter ${memberFilter === k ? 'chip-filter-active' : ''}`}>
                                        {label} ({n})
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                    <div className="cms-table-scroll overflow-x-auto">
                        <table className="min-w-full text-sm">
                            <thead>
                                <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                                    <th className="py-2 pr-4">Member</th>
                                    <th className="py-2 pr-4 text-right">Pledged</th>
                                    <th className="py-2 pr-4 text-right">Paid</th>
                                    <th className="py-2 pr-4 text-right">Still owed</th>
                                    <th className="py-2 pr-4">Pledge(s)</th>
                                    <th className="py-2">Standing</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-50">
                                {memberRows.map(m => (
                                    <tr key={m.user_id}>
                                        <td className="py-2 pr-4 text-gray-900 font-medium whitespace-nowrap">{m.name}</td>
                                        <td className="py-2 pr-4 text-right whitespace-nowrap">{m.pledged ? fmt(m.pledged) : '—'}</td>
                                        <td className="py-2 pr-4 text-right whitespace-nowrap text-green-700">{m.paid ? fmt(m.paid) : '—'}</td>
                                        <td className={`py-2 pr-4 text-right whitespace-nowrap ${m.outstanding > 0 && (m.status === 'DEFAULTED' || m.status === 'PARTIAL_OVERDUE') ? 'text-red-600 font-medium' : ''}`}>
                                            {m.outstanding ? fmt(m.outstanding) : '—'}
                                        </td>
                                        <td className="py-2 pr-4 text-xs text-gray-500">
                                            {m.pledges.length === 0 ? '—' : m.pledges.map(p => (
                                                <div key={p.id} className="whitespace-nowrap">
                                                    <span className="font-mono">{p.reference_code}</span>
                                                    {' · '}{p.iteration === 2 ? 'round 2 · ' : ''}
                                                    {formatNumber(p.pledged_amount)} {p.currency_code}
                                                    {' · '}<span className="lowercase">{p.status}</span>
                                                </div>
                                            ))}
                                        </td>
                                        <td className="py-2"><MemberStatus status={m.status} /></td>
                                    </tr>
                                ))}
                                {memberRows.length === 0 && (
                                    <tr><td colSpan={6} className="py-6 text-center text-sm text-gray-400">No one matches</td></tr>
                                )}
                            </tbody>
                            <tfoot>
                                <tr className="border-t border-gray-200 font-semibold">
                                    <td className="py-2 pr-4">Total</td>
                                    <td className="py-2 pr-4 text-right whitespace-nowrap">{fmt(members.summary.total_pledged)}</td>
                                    <td className="py-2 pr-4 text-right whitespace-nowrap">{fmt(members.summary.settled)}</td>
                                    <td className="py-2 pr-4 text-right whitespace-nowrap">{fmt(members.members.reduce((s, m) => s + m.outstanding, 0))}</td>
                                    <td colSpan={2} />
                                </tr>
                            </tfoot>
                        </table>
                    </div>
                    <p className="text-[11px] text-gray-400 mt-2">Amounts in {call.currency_code}; payments in another currency are converted at the rate used when they were approved.</p>
                </div>
            )}

            {/* Approval queue — Treasurer only */}
            {canManage && (
                <div className="card" id="approvals">
                    <h3 className="section-title mb-4">Pledges — Approval Queue</h3>
                    <div className="overflow-x-auto">
                        <table className="min-w-full text-sm">
                            <thead>
                                <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                                    <th className="py-2 pr-4">Reference</th>
                                    <th className="py-2 pr-4">Member</th>
                                    <th className="py-2 pr-4">Iteration</th>
                                    <th className="py-2 pr-4">Pledged</th>
                                    <th className="py-2 pr-4">Settled</th>
                                    <th className="py-2 pr-4">Status</th>
                                    <th className="py-2">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-50">
                                {pledges.map(p => (
                                    <tr key={p.id}>
                                        <td className="py-2 pr-4 font-mono text-xs text-primary-700">{p.reference_code}</td>
                                        <td className="py-2 pr-4 text-gray-900">{p.member_name}</td>
                                        <td className="py-2 pr-4 text-gray-500">{p.iteration}</td>
                                        <td className="py-2 pr-4 text-gray-900">{formatNumber(p.pledged_amount)} {p.currency_code}</td>
                                        <td className="py-2 pr-4 text-green-600">{formatNumber(p.amount_settled)}</td>
                                        <td className="py-2 pr-4"><StatusBadge status={p.status} /></td>
                                        <td className="py-2">
                                            {(p.status === 'PENDING' || p.status === 'PARTIAL') && (
                                                <div className="flex items-center gap-2">
                                                    <button onClick={() => setApproving(p)}
                                                        className="flex items-center gap-1 text-xs text-green-700 font-medium px-2 py-1 rounded border border-green-200 hover:bg-green-50 transition-colors">
                                                        <CheckIcon className="h-3.5 w-3.5" /> Approve
                                                    </button>
                                                    {p.status === 'PENDING' && (
                                                        <button onClick={() => setRejecting(p)}
                                                            className="flex items-center gap-1 text-xs text-red-600 font-medium px-2 py-1 rounded border border-red-200 hover:bg-red-50 transition-colors">
                                                            <XMarkIcon className="h-3.5 w-3.5" /> Reject
                                                        </button>
                                                    )}
                                                </div>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                                {pledges.length === 0 && (
                                    <tr><td colSpan={7} className="py-6 text-center text-sm text-gray-400">No pledges yet for this call</td></tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            <ApproveModal
                isOpen={!!approving}
                onClose={() => setApproving(null)}
                onSuccess={load}
                pledge={approving}
                accounts={accounts}
            />
            <RejectModal
                isOpen={!!rejecting}
                onClose={() => setRejecting(null)}
                onSuccess={load}
                pledge={rejecting}
            />
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

export default CapitalCallDetailPage;
