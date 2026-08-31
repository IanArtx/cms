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
import PageHeader from '../../components/common/PageHeader';
import DataTable from '../../components/common/DataTable';
import ErrorMessage from '../../components/common/ErrorMessage';
import StatusBadge from '../../components/common/StatusBadge';
import { HandRaisedIcon } from '@heroicons/react/24/outline';

// ============================================================
// SUBMIT / EDIT PLEDGE MODAL
// Used both for a brand new pledge into an open call, and for editing
// one of my own pledges that's still PENDING (nothing settled yet —
// the server itself is the real gate on this, this UI just avoids
// offering the button where it would obviously fail).
// ============================================================
const PledgeModal = ({ isOpen, onClose, onSuccess, target, currencies }) => {
    // `target` is either an open-call row (new pledge) or one of my
    // existing pledge rows (edit) — both shapes carry enough fields.
    const isEdit = !!(target && target.pledgeId);
    const [amount, setAmount] = useState('');
    const [currencyId, setCurrencyId] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (isOpen && target) {
            setAmount(isEdit ? String(target.pledged_amount) : (target.baseline != null ? String(target.baseline) : ''));
            setCurrencyId(isEdit ? String(target.currency_id) : '');
            setError(null);
        }
    }, [isOpen, target, isEdit]);

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
                                onChange={e => setCurrencyId(e.target.value)}
                                disabled={isEdit && false} required>
                                <option value="">Select currency...</option>
                                {currencies.map(c => (
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

// ============================================================
// MAIN PAGE
// ============================================================
const MyCapitalCallsPage = () => {
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

    return (
        <div>
            <PageHeader
                title="My Capital Calls"
                subtitle="Pledge into open monthly capital calls, and track every pledge you've made"
            />

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
                            Nothing open for you to pledge into right now — check back once a new monthly call opens.
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
                onSuccess={load}
                target={pledgeTarget}
                currencies={currencies}
            />
        </div>
    );
};

export default MyCapitalCallsPage;
