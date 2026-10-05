// ============================================================
// MY CAPITAL CALLS PAGE (v1.43.0)
// A shareholder's personal "call on shares" dashboard: every open
// monthly call they can still pledge into (across every capital
// goal), and the full history of pledges they've already submitted.
// Submitting a pledge here does NOT move money — it just registers
// interest; it stays PENDING until a Treasurer approves the actual
// payment (Section: Capital Goal Calls).
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { capitalGoalCallsAPI, accountsAPI } from '../../api/endpoints';
import { formatDate, formatNumber, getErrorMessage } from '../../utils/helpers';
import { PledgeModal } from './capitalGoalUi';
import PageHeader from '../../components/common/PageHeader';
import DataTable from '../../components/common/DataTable';
import ErrorMessage from '../../components/common/ErrorMessage';
import StatusBadge from '../../components/common/StatusBadge';
import { HandRaisedIcon } from '@heroicons/react/24/outline';

// ============================================================
// MY PLEDGES PANEL
// v1.78.0 — the page body on its own, so the Capital Goals hub can
// show it as its "My pledges" tab. The old address
// /capital-goals/my-calls still works (MyCapitalCallsPage below).
// PledgeModal now lives in capitalGoalUi.jsx (shared with the hub,
// the goal page and the dashboards).
// ============================================================
export const MyPledgesPanel = ({ onChanged = null }) => {
    const [myPledges, setMyPledges] = useState([]);
    const [openCalls, setOpenCalls] = useState([]);
    const [currencies, setCurrencies] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [pledgeTarget, setPledgeTarget] = useState(null);

    const load = useCallback(async () => {
        try {
            setLoading(true);
            const res = await capitalGoalCallsAPI.getMyPledges();
            setMyPledges(res.data.data.my_pledges || []);
            setOpenCalls(res.data.data.open_calls || []);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        load();
        accountsAPI.getCurrencies().then(r => setCurrencies(r.data.data)).catch(() => {});
    }, [load]);

    // Calls I can still act on: not already pledged for this iteration,
    // and (for iteration 2) actually eligible.
    const actionableCalls = openCalls.filter(c => !c.already_pledged && c.eligible);
    const waitingCalls = openCalls.filter(c => !c.already_pledged && !c.eligible);
    // v1.48.0 — previously invisible: a call I've already pledged into
    // fell out of BOTH lists above with no trace, so "nothing open"
    // looked identical whether there was truly nothing anywhere, or
    // I'd simply already acted on everything currently open. Tracked
    // separately so the empty-state message can tell the two apart.
    const alreadyPledgedOpenCalls = openCalls.filter(c => c.already_pledged);

    const pledgeColumns = [
        { header: 'Reference', render: row => <span className="font-mono text-xs font-medium text-primary-700">{row.reference_code}</span> },
        {
            header: 'Goal / Period',
            render: row => (
                <div>
                    <p className="text-sm font-medium text-gray-900">{row.goal_title}</p>
                    <p className="text-xs text-gray-400">{row.period}{row.iteration === 2 ? ' — Iteration 2' : ''}</p>
                </div>
            ),
        },
        {
            header: 'Pledged',
            render: row => (
                <span className="text-sm text-gray-900">
                    {formatNumber(row.pledged_amount)} {row.currency_code}
                </span>
            ),
        },
        { header: 'Settled', render: row => <span className="text-sm text-green-600">{formatNumber(row.amount_settled)}</span> },
        { header: 'Status', render: row => <StatusBadge status={row.status} /> },
        { header: 'Submitted', render: row => <span className="text-xs text-gray-500">{formatDate(row.submitted_at)}</span> },
        {
            header: 'Actions',
            render: row => (
                <div className="flex items-center gap-2">
                    {row.status === 'PENDING' && (
                        <button
                            onClick={() => setPledgeTarget({
                                pledgeId: row.id, goal_title: row.goal_title, period: row.period,
                                pledged_amount: row.pledged_amount, currency_id: row.currency_id,
                            })}
                            className="text-xs text-primary-700 hover:text-primary-800 font-medium px-2 py-1 rounded border border-primary-200 hover:bg-primary-50 transition-colors">
                            Edit
                        </button>
                    )}
                    <Link to={`/capital-goals/monthly-calls/${row.monthly_call_id}`}
                        className="text-xs text-gray-500 hover:text-gray-700">
                        View call
                    </Link>
                </div>
            ),
        },
    ];

    const reload = () => { load(); if (onChanged) onChanged(); };

    return (
        <div>
            {error && (
                <div className="mb-4">
                    <ErrorMessage message={error} onDismiss={() => setError(null)} />
                </div>
            )}

            {/* Calls I can still pledge into */}
            <div className="card mb-6">
                <h3 className="section-title mb-4">Open Calls You Can Pledge Into</h3>
                {loading ? (
                    <p className="text-sm text-gray-400">Loading...</p>
                ) : actionableCalls.length === 0 ? (
                    <div className="flex items-center gap-3 py-4">
                        <HandRaisedIcon className="h-6 w-6 text-gray-300 flex-shrink-0" />
                        <p className="text-sm text-gray-400">
                            {alreadyPledgedOpenCalls.length > 0
                                ? "You've already pledged into everything that's currently open — check back once a new monthly call opens."
                                : waitingCalls.length > 0
                                    ? "Nothing you're eligible for right now — see below."
                                    : "Nothing open for you to pledge into right now — check back once a new monthly call opens."}
                        </p>
                    </div>
                ) : (
                    <div className="divide-y divide-gray-100">
                        {actionableCalls.map(call => (
                            <div key={`${call.id}-${call.iteration}`} className="flex items-center justify-between py-3 gap-4 flex-wrap">
                                <div className="min-w-0">
                                    <p className="text-sm font-medium text-gray-900">
                                        {call.goal_title}
                                        <span className="text-gray-400 font-normal"> — {call.period}{call.iteration === 2 ? ' (Iteration 2)' : ''}</span>
                                    </p>
                                    <p className="text-xs text-gray-400">
                                        {call.iteration === 1
                                            ? `Suggested equal share: ${formatNumber(call.baseline)} ${call.currency_code} — due ${formatDate(call.iteration1_deadline)}`
                                            : `Remaining balance call — due ${formatDate(call.iteration2_deadline)}, no late fine applies`}
                                    </p>
                                </div>
                                <button onClick={() => setPledgeTarget(call)} className="btn-primary text-sm flex-shrink-0">
                                    Make Pledge
                                </button>
                            </div>
                        ))}
                    </div>
                )}
                {!loading && waitingCalls.length > 0 && (
                    <div className="mt-4 pt-4 border-t border-gray-100">
                        <p className="text-xs text-gray-400 mb-2">
                            Also open, but not available to you (iteration 2 is only open to shareholders who
                            pledged above the baseline in iteration 1):
                        </p>
                        <div className="flex flex-wrap gap-2">
                            {waitingCalls.map(call => (
                                <span key={`${call.id}-${call.iteration}`} className="text-xs text-gray-400 bg-gray-50 rounded-lg px-2 py-1">
                                    {call.goal_title} — {call.period}
                                </span>
                            ))}
                        </div>
                    </div>
                )}
            </div>

            {/* My pledge history */}
            <DataTable
                columns={pledgeColumns}
                data={myPledges}
                loading={loading}
                emptyMessage="You haven't made any capital call pledges yet"
                searchable
                searchPlaceholder="Search my pledges..."
            />

            <PledgeModal
                isOpen={!!pledgeTarget}
                onClose={() => setPledgeTarget(null)}
                onSuccess={reload}
                target={pledgeTarget}
                currencies={currencies}
            />
        </div>
    );
};

// ============================================================
// MAIN PAGE — /capital-goals/my-calls (kept for old links and
// notifications; the hub's "My pledges" tab shows the same panel)
// ============================================================
const MyCapitalCallsPage = () => (
    <div>
        <PageHeader
            title="My Capital Calls"
            subtitle="Pledge into open monthly capital calls, and track every pledge you've made"
            showBack
            backTo="/capital-goals"
        />
        <MyPledgesPanel />
    </div>
);

export default MyCapitalCallsPage;
