// ============================================================
// LOAN DETAIL PAGE
// Dedicated page for a single loan (received or given): balance
// breakdown, repayment schedule, repayment history and charts —
// mirrors the structure of InvestmentDetailPage.jsx. Shared between
// both loan types via the `loanType` prop ('received' | 'given'),
// since the two only differ in field names (lender vs borrower,
// amount_paid vs amount_received) and which endpoint to call.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { loansAPI } from '../../api/endpoints';
import { formatDate, getErrorMessage } from '../../utils/helpers';
import LoadingSpinner from '../../components/common/LoadingSpinner';
import ErrorMessage from '../../components/common/ErrorMessage';
import StatusBadge from '../../components/common/StatusBadge';
import { useAuth } from '../../contexts/AuthContext';
import { RepaymentModal } from './LoansPage';
import {
    ArrowLeftIcon,
    BanknotesIcon,
    CreditCardIcon,
    AdjustmentsHorizontalIcon,
} from '@heroicons/react/24/outline';
import {
    PieChart, Pie, Cell, BarChart, Bar, LineChart, Line,
    XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';

// ============================================================
// AMEND PENALTY RATE MODAL
// Treasurer only (matches the backend's requireRoles(['Treasurer'])
// gate on both amend-rate endpoints). Doesn't overwrite the old
// rate — the backend records it as a new dated amendment entry so
// the full rate history stays visible below.
// ============================================================
const AmendRateModal = ({ loan, isReceived, isOpen, onClose, onSuccess }) => {
    const [form, setForm] = useState({
        new_penalty_rate: '', reason: '', effective_from: '',
    });
    const [loading, setLoading] = useState(false);
    const [error, setError]     = useState(null);

    if (!isOpen) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            const payload = {
                ...form,
                new_penalty_rate: parseFloat(form.new_penalty_rate),
            };
            if (isReceived) {
                await loansAPI.amendRate(loan.id, payload);
            } else {
                await loansAPI.amendGivenRate(loan.id, payload);
            }
            onSuccess();
            onClose();
            setForm({ new_penalty_rate: '', reason: '', effective_from: '' });
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
                        Amend Penalty Rate
                    </h2>
                    <p className="text-sm text-gray-400 mb-4">
                        Current rate: <strong>{loan.penalty_interest_rate}%</strong>.
                        This is recorded as a new dated amendment — the previous rate
                        stays visible in the history below.
                    </p>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">New Penalty Rate (%) *</label>
                            <input type="number" className="input" value={form.new_penalty_rate}
                                onChange={e => setForm(p => ({ ...p, new_penalty_rate: e.target.value }))}
                                min="0" step="0.01" required />
                        </div>
                        <div>
                            <label className="label">Effective From *</label>
                            <input type="date" className="input" value={form.effective_from}
                                onChange={e => setForm(p => ({ ...p, effective_from: e.target.value }))}
                                required />
                        </div>
                        <div>
                            <label className="label">Reason *</label>
                            <textarea className="input" rows={2} value={form.reason}
                                onChange={e => setForm(p => ({ ...p, reason: e.target.value }))}
                                placeholder="Why is the penalty rate changing?"
                                required />
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading} className="btn-primary">
                                {loading ? 'Saving...' : 'Amend Rate'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

const LoanDetailPage = ({ loanType }) => {
    const { id } = useParams();
    const navigate = useNavigate();
    const { hasPermission, hasRole } = useAuth();

    const [loan,    setLoan]    = useState(null);
    const [loading, setLoading] = useState(true);
    const [error,   setError]   = useState(null);
    const [showRepay, setShowRepay] = useState(false);
    const [showAmend, setShowAmend] = useState(false);

    const isReceived = loanType === 'received';

    const loadLoan = useCallback(async () => {
        try {
            setLoading(true);
            const res = isReceived
                ? await loansAPI.getReceivedById(id)
                : await loansAPI.getGivenById(id);
            setLoan(res.data.data);
            setError(null);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, [id, isReceived]);

    useEffect(() => { loadLoan(); }, [loadLoan]);

    if (loading) {
        return <LoadingSpinner fullPage text="Loading loan..." />;
    }

    if (error || !loan) {
        return (
            <div>
                <button
                    onClick={() => navigate('/loans')}
                    className="flex items-center gap-2 text-sm text-gray-500
                        hover:text-gray-700 mb-6 transition-colors"
                >
                    <ArrowLeftIcon className="h-4 w-4" />
                    Back to Loans
                </button>
                <ErrorMessage message={error || 'Loan not found'} />
            </div>
        );
    }

    const currency = loan.currency_code;
    const principal = parseFloat(loan.principal_amount);
    const outstandingPrincipal = parseFloat(loan.outstanding_principal);
    const outstandingInterest  = parseFloat(loan.outstanding_interest || 0);
    const outstandingTotal     = outstandingPrincipal + outstandingInterest;
    const repaidPrincipal      = Math.max(0, principal - outstandingPrincipal);

    const partyName    = isReceived ? loan.lender_name    : loan.borrower_name;
    const partyType     = isReceived ? loan.lender_type    : loan.borrower_type;
    const partyContact  = isReceived ? loan.lender_contact : loan.borrower_contact;
    const partyLabel    = isReceived ? 'Lender'            : 'Borrower';

    const schedule    = loan.schedule    || [];
    const repayments  = loan.repayments  || [];
    const rateAmendments = loan.rate_amendments || [];

    // Repayments use different amount field names between the two tables
    const repaymentAmount = (r) => parseFloat(isReceived ? r.amount_paid : r.amount_received);

    // ---- Principal repaid vs outstanding donut ----
    const principalPieData = [
        { name: 'Repaid',      value: repaidPrincipal },
        { name: 'Outstanding', value: outstandingPrincipal },
    ];
    const PRINCIPAL_COLORS = ['#16a34a', '#dc2626'];

    // ---- Repayments over time ----
    const repaymentsChartData = repayments.map(r => ({
        date:   formatDate(r.payment_date),
        amount: repaymentAmount(r),
    }));

    // ---- Outstanding principal balance over time — walked chronologically
    // from the full principal down through each repayment's principal
    // portion, mirroring how InvestmentDetailPage derives all its chart
    // data client-side from the single detail payload. ----
    let runningBalance = principal;
    const balanceChartData = [
        { date: formatDate(loan.disbursement_date || loan.due_date), balance: principal },
        ...repayments.map(r => {
            runningBalance = Math.max(0, runningBalance - parseFloat(r.principal_portion || 0));
            return { date: formatDate(r.payment_date), balance: runningBalance };
        }),
    ];

    const canRepay = hasPermission('LOAN_REPAYMENT_RECORD') &&
        ['ACTIVE', 'OVERDUE', 'PARTIALLY_REPAID'].includes(loan.status);
    const canAmendRate = hasRole('Treasurer') &&
        ['ACTIVE', 'OVERDUE', 'PARTIALLY_REPAID'].includes(loan.status);

    return (
        <div>
            {/* Back button */}
            <button
                onClick={() => navigate('/loans')}
                className="flex items-center gap-2 text-sm text-gray-500
                    hover:text-gray-700 mb-6 transition-colors"
            >
                <ArrowLeftIcon className="h-4 w-4" />
                Back to Loans
            </button>

            {/* Loan Header */}
            <div className="rounded-xl p-6 mb-6 text-white
                bg-gradient-to-r from-primary-900 to-primary-700">
                <div className="flex items-start justify-between flex-wrap gap-4">
                    <div className="flex items-center gap-3">
                        <CreditCardIcon className="h-8 w-8 opacity-80" />
                        <div>
                            <p className="text-sm opacity-70 font-mono">
                                {loan.reference_code}
                            </p>
                            <h2 className="text-2xl font-bold mt-0.5">{partyName}</h2>
                            <div className="mt-2 flex items-center gap-2 flex-wrap">
                                <StatusBadge status={loan.status} />
                                <span className="text-xs px-2 py-0.5 rounded-full
                                    bg-white bg-opacity-20 font-medium">
                                    {isReceived ? 'Loan Received' : 'Loan Given'}
                                </span>
                                <span className="text-xs opacity-70">{partyType}</span>
                                {loan.is_overdue && (
                                    <span className="text-xs px-2 py-0.5 rounded-full
                                        bg-red-500 bg-opacity-80 font-medium">
                                        OVERDUE
                                    </span>
                                )}
                            </div>
                        </div>
                    </div>
                    <div className="text-right">
                        <p className="text-sm opacity-70">Total Outstanding</p>
                        <p className="text-3xl font-bold mt-0.5">
                            {currency} {outstandingTotal.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                        </p>
                    </div>
                </div>

                {/* Stats Row */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-6">
                    <div className="bg-white bg-opacity-10 rounded-lg p-3">
                        <p className="text-xs opacity-70">Principal</p>
                        <p className="text-lg font-bold mt-1">
                            {currency} {principal.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                        </p>
                    </div>
                    <div className="bg-white bg-opacity-10 rounded-lg p-3">
                        <p className="text-xs opacity-70">Outstanding Principal</p>
                        <p className="text-lg font-bold mt-1 text-red-300">
                            {currency} {outstandingPrincipal.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                        </p>
                    </div>
                    <div className="bg-white bg-opacity-10 rounded-lg p-3">
                        <p className="text-xs opacity-70">Outstanding Interest</p>
                        <p className="text-lg font-bold mt-1 text-red-300">
                            {currency} {outstandingInterest.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                        </p>
                    </div>
                    <div className="bg-white bg-opacity-10 rounded-lg p-3">
                        <p className="text-xs opacity-70">Fixed / Penalty Rate</p>
                        <p className="text-lg font-bold mt-1">
                            {loan.fixed_interest_rate}% / {loan.penalty_interest_rate}%
                        </p>
                    </div>
                </div>
            </div>

            {/* Actions */}
            {(canRepay || canAmendRate) && (
                <div className="flex items-center gap-3 mb-6">
                    {canRepay && (
                        <button
                            onClick={() => setShowRepay(true)}
                            className="btn-primary flex items-center gap-2"
                        >
                            <BanknotesIcon className="h-4 w-4" />
                            {isReceived ? 'Record Repayment' : 'Record Receipt'}
                        </button>
                    )}
                    {canAmendRate && (
                        <button
                            onClick={() => setShowAmend(true)}
                            className="btn-secondary flex items-center gap-2"
                        >
                            <AdjustmentsHorizontalIcon className="h-4 w-4" />
                            Amend Rate
                        </button>
                    )}
                </div>
            )}

            {/* Charts */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
                {/* Principal Repaid vs Outstanding */}
                <div className="card">
                    <h3 className="section-title mb-4">Principal Repaid</h3>
                    {principal > 0 ? (
                        <ResponsiveContainer width="100%" height={220}>
                            <PieChart>
                                <Pie data={principalPieData} cx="50%" cy="50%"
                                    innerRadius={50} outerRadius={80}
                                    dataKey="value">
                                    {principalPieData.map((entry, index) => (
                                        <Cell key={index} fill={PRINCIPAL_COLORS[index]} />
                                    ))}
                                </Pie>
                                <Tooltip
                                    formatter={(v) => [`${currency} ${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`]}
                                />
                                <Legend />
                            </PieChart>
                        </ResponsiveContainer>
                    ) : (
                        <div className="flex items-center justify-center h-48 text-gray-300 text-sm">
                            No principal recorded
                        </div>
                    )}
                </div>

                {/* Repayments Over Time */}
                <div className="card lg:col-span-2">
                    <h3 className="section-title mb-4">Repayments Over Time</h3>
                    {repaymentsChartData.length > 0 ? (
                        <ResponsiveContainer width="100%" height={220}>
                            <BarChart data={repaymentsChartData}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                                <XAxis dataKey="date" tick={{ fontSize: 11 }} tickLine={false} />
                                <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false}
                                    tickFormatter={v => v.toLocaleString('en-US', { maximumFractionDigits: 2 })} />
                                <Tooltip
                                    formatter={(v) => [`${currency} ${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`, 'Repayment']}
                                />
                                <Bar dataKey="amount" fill="#16a34a" radius={[4, 4, 0, 0]} />
                            </BarChart>
                        </ResponsiveContainer>
                    ) : (
                        <div className="flex items-center justify-center h-48 text-gray-300 text-sm">
                            No repayments yet
                        </div>
                    )}
                </div>
            </div>

            {/* Outstanding Balance Over Time */}
            <div className="card mb-6">
                <h3 className="section-title mb-4">Outstanding Principal Balance Over Time</h3>
                <ResponsiveContainer width="100%" height={220}>
                    <LineChart data={balanceChartData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                        <XAxis dataKey="date" tick={{ fontSize: 11 }} tickLine={false} />
                        <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false}
                            tickFormatter={v => v.toLocaleString('en-US', { maximumFractionDigits: 2 })} />
                        <Tooltip
                            formatter={(v) => [`${currency} ${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`, 'Balance']}
                        />
                        <Line type="monotone" dataKey="balance" stroke="#1d4ed8" strokeWidth={2} dot={{ r: 3 }} />
                    </LineChart>
                </ResponsiveContainer>
            </div>

            {/* Schedule + Repayment History */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
                <div className="card">
                    <h3 className="section-title mb-4">Repayment Schedule</h3>
                    {schedule.length === 0 ? (
                        <p className="text-sm text-gray-400 text-center py-6">No schedule generated</p>
                    ) : (
                        <div className="space-y-2 max-h-96 overflow-y-auto">
                            {schedule.map((s, i) => (
                                <div key={i} className="flex items-center justify-between
                                    py-2 border-b border-gray-100 last:border-0 text-sm">
                                    <div>
                                        <p className="font-medium text-gray-900">
                                            Instalment {s.instalment_number}
                                        </p>
                                        <p className="text-xs text-gray-400">{formatDate(s.due_date)}</p>
                                    </div>
                                    <div className="text-right">
                                        <p className="font-semibold text-gray-900">
                                            {currency} {parseFloat(s.total_due).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                                        </p>
                                        <StatusBadge status={s.status} />
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                <div className="card">
                    <h3 className="section-title mb-4">Repayment History</h3>
                    {repayments.length === 0 ? (
                        <p className="text-sm text-gray-400 text-center py-6">No repayments recorded yet</p>
                    ) : (
                        <div className="space-y-2 max-h-96 overflow-y-auto">
                            {repayments.map((r) => (
                                <div key={r.id} className="py-2 border-b border-gray-100 last:border-0 text-sm">
                                    <div className="flex items-center justify-between">
                                        <span className="font-mono text-xs text-primary-700">
                                            {r.repayment_reference}
                                        </span>
                                        <span className="font-semibold text-gray-900">
                                            {currency} {repaymentAmount(r).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                                        </span>
                                    </div>
                                    <div className="flex items-center justify-between text-xs text-gray-400 mt-0.5">
                                        <span>{formatDate(r.payment_date)}</span>
                                        <span>
                                            P: {parseFloat(r.principal_portion).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                                            {' · '}
                                            I: {parseFloat(r.interest_portion).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                                            {parseFloat(r.penalty_portion) > 0 &&
                                                ` · Pen: ${parseFloat(r.penalty_portion).toLocaleString('en-US', { maximumFractionDigits: 2 })}`}
                                        </span>
                                    </div>
                                    {r.notes && <p className="text-xs text-gray-400 mt-0.5">{r.notes}</p>}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {/* Rate Amendments */}
            {rateAmendments.length > 0 && (
                <div className="card mb-6">
                    <h3 className="section-title mb-4">Penalty Rate Amendments</h3>
                    <div className="space-y-2">
                        {rateAmendments.map((ra, i) => (
                            <div key={i} className="flex items-center justify-between text-sm
                                py-2 border-b border-gray-100 last:border-0">
                                <div>
                                    <p className="text-gray-900">
                                        {ra.previous_penalty_rate}% → {ra.new_penalty_rate}%
                                    </p>
                                    <p className="text-xs text-gray-400">{ra.reason}</p>
                                </div>
                                <span className="text-xs text-gray-500">{formatDate(ra.effective_from)}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Details Footer */}
            <div className="card">
                <h3 className="section-title mb-4">Loan Details</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
                    <div>
                        <p className="text-xs text-gray-400">Account</p>
                        <p className="font-medium text-gray-900">{loan.account_name}</p>
                    </div>
                    <div>
                        <p className="text-xs text-gray-400">Category</p>
                        <p className="font-medium text-gray-900">{loan.category_trail || loan.category_name}</p>
                    </div>
                    <div>
                        <p className="text-xs text-gray-400">{partyLabel} Contact</p>
                        <p className="font-medium text-gray-900">{partyContact || '—'}</p>
                    </div>
                    <div>
                        <p className="text-xs text-gray-400">Interest Period / Calculation</p>
                        <p className="font-medium text-gray-900">{loan.interest_period} / {loan.interest_calculation}</p>
                    </div>
                    <div>
                        <p className="text-xs text-gray-400">Disbursement Date</p>
                        <p className="font-medium text-gray-900">{loan.disbursement_date ? formatDate(loan.disbursement_date) : '—'}</p>
                    </div>
                    <div>
                        <p className="text-xs text-gray-400">Due Date</p>
                        <p className="font-medium text-gray-900">{formatDate(loan.due_date)}</p>
                    </div>
                    <div>
                        <p className="text-xs text-gray-400">Created By</p>
                        <p className="font-medium text-gray-900">{loan.created_by_name}</p>
                    </div>
                    <div>
                        <p className="text-xs text-gray-400">Approved By</p>
                        <p className="font-medium text-gray-900">{loan.approved_by_name || '—'}</p>
                    </div>
                </div>
            </div>

            <RepaymentModal
                isOpen={showRepay}
                loan={loan}
                loanType={loanType}
                onClose={() => setShowRepay(false)}
                onSuccess={loadLoan}
            />

            <AmendRateModal
                isOpen={showAmend}
                loan={loan}
                isReceived={isReceived}
                onClose={() => setShowAmend(false)}
                onSuccess={loadLoan}
            />
        </div>
    );
};

export default LoanDetailPage;
