// ============================================================
// INVESTMENT DETAIL PAGE
// Dedicated page for a single investment: budget usage, expenses,
// returns, and project/milestone progress, with charts.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { investmentsAPI, categoriesAPI } from '../../api/endpoints';
import { formatDate, getErrorMessage } from '../../utils/helpers';
import { investmentEntryTemplate, printDocument } from '../../utils/exportUtils';
import LoadingSpinner from '../../components/common/LoadingSpinner';
import ErrorMessage from '../../components/common/ErrorMessage';
import StatusBadge from '../../components/common/StatusBadge';
import { useAuth } from '../../contexts/AuthContext';
import {
    ArrowLeftIcon,
    ArrowTrendingUpIcon,
    ChartBarIcon,
    MinusCircleIcon,
    PlusCircleIcon,
    CheckCircleIcon,
    PrinterIcon,
    BanknotesIcon,
    ReceiptPercentIcon,
} from '@heroicons/react/24/outline';
import {
    PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, CartesianGrid,
    Tooltip, ResponsiveContainer, Legend,
} from 'recharts';

// ============================================================
// RECORD EXPENSE MODAL
// Calls POST /investments/:id/fund — money spent on the investment
// ============================================================
const RecordExpenseModal = ({ isOpen, onClose, onSuccess, investment, categories }) => {
    const [form, setForm] = useState({
        amount: '', value_date: '', category_id: '',
        description: '', project_id: '',
    });
    const [loading, setLoading] = useState(false);
    const [error,   setError]   = useState(null);

    if (!isOpen) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await investmentsAPI.fund(investment.id, {
                ...form,
                amount:      parseFloat(form.amount),
                category_id: form.category_id || undefined,
                project_id:  form.project_id || undefined,
            });
            onSuccess();
            onClose();
            setForm({ amount: '', value_date: '', category_id: '',
                description: '', project_id: '' });
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    const investmentCategories = categories.filter(c => c.module === 'INVESTMENT');

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            <div className="fixed inset-0 bg-black bg-opacity-40" onClick={onClose} />
            <div className="flex min-h-full items-center justify-center p-4">
                <div className="relative bg-white rounded-xl shadow-xl max-w-lg w-full p-6">
                    <h2 className="text-lg font-semibold text-gray-900 mb-4">
                        Record Expense
                    </h2>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">
                                Amount {investment.currency_code} *
                            </label>
                            <input type="number" className="input"
                                value={form.amount}
                                onChange={e => setForm(p => ({
                                    ...p, amount: e.target.value }))}
                                min="0.01" step="0.01" required />
                        </div>
                        <div>
                            <label className="label">Date *</label>
                            <input type="date" className="input"
                                value={form.value_date}
                                onChange={e => setForm(p => ({
                                    ...p, value_date: e.target.value }))}
                                required />
                        </div>
                        {investment.projects?.length > 0 && (
                            <div>
                                <label className="label">Project (optional)</label>
                                <select className="input" value={form.project_id}
                                    onChange={e => setForm(p => ({
                                        ...p, project_id: e.target.value }))}>
                                    <option value="">Not linked to a project</option>
                                    {investment.projects.map(p => (
                                        <option key={p.id} value={p.id}>{p.name}</option>
                                    ))}
                                </select>
                            </div>
                        )}
                        <div>
                            <label className="label">Category (optional)</label>
                            <select className="input" value={form.category_id}
                                onChange={e => setForm(p => ({
                                    ...p, category_id: e.target.value }))}>
                                <option value="">
                                    Use investment's category ({investment.category_name})
                                </option>
                                {investmentCategories.map(c => (
                                    <option key={c.id} value={c.id}>
                                        {c.full_path || c.name}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label className="label">Description</label>
                            <input type="text" className="input"
                                value={form.description}
                                onChange={e => setForm(p => ({
                                    ...p, description: e.target.value }))} />
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose}
                                className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading}
                                className="btn-primary">
                                {loading ? 'Recording...' : 'Record Expense'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// RECORD RETURN MODAL
// Calls POST /investments/:id/returns — money gained from the investment
// ============================================================
const RecordReturnModal = ({ isOpen, onClose, onSuccess, investment }) => {
    const [form, setForm] = useState({
        amount: '', return_type: 'PROFIT_SHARE', return_date: '', notes: '',
    });
    const [loading, setLoading] = useState(false);
    const [error,   setError]   = useState(null);

    if (!isOpen) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await investmentsAPI.recordReturn(investment.id, form);
            onSuccess();
            onClose();
            setForm({ amount: '', return_type: 'PROFIT_SHARE', return_date: '', notes: '' });
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
                <div className="relative bg-white rounded-xl shadow-xl max-w-lg w-full p-6">
                    <h2 className="text-lg font-semibold text-gray-900 mb-4">
                        Record Return
                    </h2>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">
                                Amount {investment.currency_code} *
                            </label>
                            <input type="number" className="input"
                                value={form.amount}
                                onChange={e => setForm(p => ({
                                    ...p, amount: e.target.value }))}
                                min="0.01" step="0.01" required />
                        </div>
                        <div>
                            <label className="label">Return Type *</label>
                            <select className="input" value={form.return_type}
                                onChange={e => setForm(p => ({
                                    ...p, return_type: e.target.value }))}
                                required>
                                <option value="DIVIDEND">Dividend</option>
                                <option value="PROFIT_SHARE">Profit Share</option>
                                <option value="CAPITAL_GAIN">Capital Gain</option>
                                <option value="INTEREST">Interest</option>
                                <option value="RENTAL">Rental</option>
                                <option value="OTHER">Other</option>
                            </select>
                        </div>
                        <div>
                            <label className="label">Date *</label>
                            <input type="date" className="input"
                                value={form.return_date}
                                onChange={e => setForm(p => ({
                                    ...p, return_date: e.target.value }))}
                                required />
                        </div>
                        <div>
                            <label className="label">Notes</label>
                            <input type="text" className="input"
                                value={form.notes}
                                onChange={e => setForm(p => ({
                                    ...p, notes: e.target.value }))} />
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose}
                                className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading}
                                className="btn-primary">
                                {loading ? 'Recording...' : 'Record Return'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// RECORD OPERATIONAL TRANSACTION MODAL
// Calls POST /investments/:id/transactions — a dedicated expense,
// extra inflow, or tax entry against this investment's own
// operating budget (separate from the overall planned budget /
// scheduled returns tracked above). Always posts to the general
// ledger automatically on the backend.
// ============================================================
const RecordOperationModal = ({ isOpen, onClose, onSuccess, investment, categories }) => {
    const [form, setForm] = useState({
        entry_type: 'EXPENSE', amount: '', entry_date: '',
        description: '', category_id: '',
    });
    const [loading, setLoading] = useState(false);
    const [error,   setError]   = useState(null);

    if (!isOpen) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await investmentsAPI.recordTransaction(investment.id, {
                ...form,
                amount:      parseFloat(form.amount),
                category_id: form.category_id || undefined,
            });
            onSuccess();
            onClose();
            setForm({ entry_type: 'EXPENSE', amount: '', entry_date: '',
                description: '', category_id: '' });
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    const investmentCategories = categories.filter(c => c.module === 'INVESTMENT');
    const typeLabels = {
        EXPENSE: 'Operational Expense — a running cost of this investment',
        INFLOW:  'Extra Inflow — income beyond the scheduled/manual returns',
        TAX:     'Tax — tax withheld or paid on this investment',
    };

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            <div className="fixed inset-0 bg-black bg-opacity-40" onClick={onClose} />
            <div className="flex min-h-full items-center justify-center p-4">
                <div className="relative bg-white rounded-xl shadow-xl max-w-lg w-full p-6">
                    <h2 className="text-lg font-semibold text-gray-900 mb-4">
                        Record Operational Transaction
                    </h2>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">Type *</label>
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                                {['EXPENSE', 'INFLOW', 'TAX'].map(t => (
                                    <button
                                        key={t}
                                        type="button"
                                        onClick={() => setForm(p => ({ ...p, entry_type: t }))}
                                        className={`text-xs font-medium py-2 rounded-lg border transition-colors ${
                                            form.entry_type === t
                                                ? 'bg-primary-700 text-white border-primary-700'
                                                : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
                                        }`}
                                    >
                                        {t === 'EXPENSE' ? 'Expense' : t === 'INFLOW' ? 'Inflow' : 'Tax'}
                                    </button>
                                ))}
                            </div>
                            <p className="text-xs text-gray-400 mt-1.5">
                                {typeLabels[form.entry_type]}
                            </p>
                        </div>
                        <div>
                            <label className="label">
                                Amount {investment.currency_code} *
                            </label>
                            <input type="number" className="input"
                                value={form.amount}
                                onChange={e => setForm(p => ({
                                    ...p, amount: e.target.value }))}
                                min="0.01" step="0.01" required />
                        </div>
                        <div>
                            <label className="label">Date *</label>
                            <input type="date" className="input"
                                value={form.entry_date}
                                onChange={e => setForm(p => ({
                                    ...p, entry_date: e.target.value }))}
                                required />
                        </div>
                        <div>
                            <label className="label">Category (optional)</label>
                            <select className="input" value={form.category_id}
                                onChange={e => setForm(p => ({
                                    ...p, category_id: e.target.value }))}>
                                <option value="">
                                    Use investment's category ({investment.category_name})
                                </option>
                                {investmentCategories.map(c => (
                                    <option key={c.id} value={c.id}>
                                        {c.full_path || c.name}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label className="label">Description</label>
                            <input type="text" className="input"
                                value={form.description}
                                onChange={e => setForm(p => ({
                                    ...p, description: e.target.value }))} />
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose}
                                className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading}
                                className="btn-primary">
                                {loading ? 'Recording...' : 'Record Transaction'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// OPERATING BUDGET CARD
// Shows the investment's own operating budget — capital allotted
// to it, income (scheduled returns + extra inflows), expenses and
// tax paid out of it, and the running balance still unspent — plus
// a printable list of every operational transaction.
// ============================================================
const OperatingBudgetCard = ({ investment }) => {
    const currency = investment.currency_code;
    const budget = investment.operating_budget || {};
    const operations = investment.operations || [];

    const printEntry = (op) => {
        const isInflow = op.entry_type === 'INFLOW';
        const label = op.entry_type === 'TAX' ? 'Tax Payment' :
                      op.entry_type === 'INFLOW' ? 'Operational Inflow' : 'Operational Expense';
        printDocument(investmentEntryTemplate({
            investment_name:      investment.name,
            investment_reference: investment.reference_code,
            entry_label:          label,
            amount:               op.amount,
            currency_code:        currency,
            direction:            isInflow ? 'IN' : 'OUT',
            date:                 op.entry_date,
            reference_code:       op.reference_code,
            notes:                op.description,
            recorded_by_name:     op.recorded_by_name,
            recorded_at:          op.created_at,
        }), op.reference_code);
    };

    return (
        <div className="card mb-6">
            <div className="flex items-center justify-between mb-4">
                <h3 className="section-title">Operating Budget</h3>
                <BanknotesIcon className="h-5 w-5 text-gray-300" />
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 mb-5">
                <div>
                    <p className="text-gray-400 text-xs">Operating Capital</p>
                    <p className="text-sm font-semibold text-gray-900 mt-0.5">
                        {currency} {(budget.operating_capital || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                    </p>
                </div>
                <div>
                    <p className="text-gray-400 text-xs">Total Income</p>
                    <p className="text-sm font-semibold text-green-600 mt-0.5">
                        {currency} {(budget.total_income || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                    </p>
                </div>
                <div>
                    <p className="text-gray-400 text-xs">Expenses</p>
                    <p className="text-sm font-semibold text-red-600 mt-0.5">
                        {currency} {(budget.total_expenses || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                    </p>
                </div>
                <div>
                    <p className="text-gray-400 text-xs">Tax</p>
                    <p className="text-sm font-semibold text-red-600 mt-0.5">
                        {currency} {(budget.total_tax || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                    </p>
                </div>
                <div>
                    <p className="text-gray-400 text-xs">Running Balance (Unspent)</p>
                    <p className={`text-sm font-bold mt-0.5 ${
                        (budget.running_balance || 0) < 0 ? 'text-red-600' : 'text-primary-700'
                    }`}>
                        {currency} {(budget.running_balance || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                    </p>
                </div>
            </div>

            {operations.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-6">
                    No operational transactions recorded yet
                </p>
            ) : (
                <div className="overflow-x-auto -mx-2">
                    <table className="min-w-full text-sm">
                        <thead>
                            <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                                <th className="px-2 py-2 font-medium">Date</th>
                                <th className="px-2 py-2 font-medium">Type</th>
                                <th className="px-2 py-2 font-medium">Description</th>
                                <th className="px-2 py-2 font-medium text-right">Amount</th>
                                <th className="px-2 py-2 font-medium">Recorded By</th>
                                <th className="px-2 py-2 font-medium text-right">Receipt</th>
                            </tr>
                        </thead>
                        <tbody>
                            {[...operations].reverse().map(op => (
                                <tr key={op.id} className="border-b border-gray-50 last:border-0">
                                    <td className="px-2 py-2 text-gray-700">{formatDate(op.entry_date)}</td>
                                    <td className="px-2 py-2">
                                        <span className={`text-xs ${
                                            op.entry_type === 'INFLOW' ? 'badge-green' : 'badge-red'
                                        }`}>
                                            {op.entry_type === 'INFLOW' ? 'Inflow' :
                                             op.entry_type === 'TAX' ? 'Tax' : 'Expense'}
                                        </span>
                                    </td>
                                    <td className="px-2 py-2 text-gray-600">{op.description || '—'}</td>
                                    <td className={`px-2 py-2 text-right font-medium ${
                                        op.entry_type === 'INFLOW' ? 'text-green-600' : 'text-red-600'
                                    }`}>
                                        {op.entry_type === 'INFLOW' ? '+' : '-'}
                                        {currency} {parseFloat(op.amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                                    </td>
                                    <td className="px-2 py-2 text-gray-500">{op.recorded_by_name}</td>
                                    <td className="px-2 py-2 text-right">
                                        <button
                                            onClick={() => printEntry(op)}
                                            className="text-gray-400 hover:text-primary-700"
                                            title="Preview / print receipt"
                                        >
                                            <PrinterIcon className="h-4 w-4 inline" />
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
};

// ============================================================
// BOND COUPON SCHEDULE
// Shows the generated payment dates, expected gross/tax/net yield,
// and lets a Treasurer mark each coupon as paid once received.
// ============================================================
const BondScheduleCard = ({ investment, canManage, onPaid }) => {
    const [payingId, setPayingId] = useState(null);
    const [error, setError] = useState(null);
    const coupons = investment.coupons || [];
    const currency = investment.currency_code;

    const handlePay = async (couponId) => {
        setPayingId(couponId);
        setError(null);
        try {
            await investmentsAPI.payCoupon(investment.id, couponId, {});
            onPaid();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setPayingId(null);
        }
    };

    const totals = coupons.reduce((acc, c) => ({
        gross: acc.gross + parseFloat(c.gross_amount),
        tax:   acc.tax   + parseFloat(c.tax_amount),
        net:   acc.net   + parseFloat(c.net_amount),
    }), { gross: 0, tax: 0, net: 0 });

    const nextPending = coupons.find(c => c.status === 'PENDING');

    return (
        <div className="card mb-6">
            <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
                <h3 className="section-title">Bond Coupon Schedule</h3>
                <span className="badge-blue text-xs">
                    {parseFloat(investment.coupon_rate)}% p.a. •{' '}
                    {investment.coupon_frequency?.replace(/_/g, ' ')}
                </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-5">
                <div>
                    <p className="text-gray-400 text-xs">Face Value</p>
                    <p className="text-sm font-semibold text-gray-900 mt-0.5">
                        {currency} {parseFloat(investment.face_value).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                    </p>
                </div>
                <div>
                    <p className="text-gray-400 text-xs">Expected Total Yield (Gross)</p>
                    <p className="text-sm font-semibold text-gray-900 mt-0.5">
                        {currency} {totals.gross.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                    </p>
                </div>
                <div>
                    <p className="text-gray-400 text-xs">
                        Tax Withheld ({parseFloat(investment.tax_withholding_rate)}%)
                    </p>
                    <p className="text-sm font-semibold text-red-600 mt-0.5">
                        {currency} {totals.tax.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                    </p>
                </div>
                <div>
                    <p className="text-gray-400 text-xs">Expected Net Yield</p>
                    <p className="text-sm font-semibold text-green-600 mt-0.5">
                        {currency} {totals.net.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                    </p>
                </div>
            </div>

            {nextPending && (
                <p className="text-xs text-gray-500 mb-3">
                    Next coupon due <span className="font-medium text-gray-700">
                        {formatDate(nextPending.due_date)}
                    </span> — {currency} {parseFloat(nextPending.net_amount).toLocaleString('en-US', { maximumFractionDigits: 2 })} net
                </p>
            )}

            {error && (
                <div className="mb-3">
                    <ErrorMessage message={error} onDismiss={() => setError(null)} />
                </div>
            )}

            <div className="overflow-x-auto -mx-2">
                <table className="min-w-full text-sm">
                    <thead>
                        <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                            <th className="px-2 py-2 font-medium">#</th>
                            <th className="px-2 py-2 font-medium">Due Date</th>
                            <th className="px-2 py-2 font-medium text-right">Gross</th>
                            <th className="px-2 py-2 font-medium text-right">Tax</th>
                            <th className="px-2 py-2 font-medium text-right">Net</th>
                            <th className="px-2 py-2 font-medium">Status</th>
                            {canManage && <th className="px-2 py-2 font-medium text-right">Action</th>}
                        </tr>
                    </thead>
                    <tbody>
                        {coupons.map(c => (
                            <tr key={c.id} className="border-b border-gray-50 last:border-0">
                                <td className="px-2 py-2 text-gray-500">{c.coupon_number}</td>
                                <td className="px-2 py-2 text-gray-700">{formatDate(c.due_date)}</td>
                                <td className="px-2 py-2 text-right text-gray-700">
                                    {parseFloat(c.gross_amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                                </td>
                                <td className="px-2 py-2 text-right text-red-500">
                                    {parseFloat(c.tax_amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                                </td>
                                <td className="px-2 py-2 text-right font-medium text-gray-900">
                                    {parseFloat(c.net_amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                                </td>
                                <td className="px-2 py-2">
                                    {c.status === 'PAID' ? (
                                        <span className="badge-green text-xs flex items-center gap-1 w-fit">
                                            <CheckCircleIcon className="h-3.5 w-3.5" /> Paid
                                        </span>
                                    ) : (
                                        <span className="badge-yellow text-xs">Pending</span>
                                    )}
                                </td>
                                {canManage && (
                                    <td className="px-2 py-2 text-right">
                                        {c.status !== 'PAID' && investment.status === 'ACTIVE' && (
                                            <button
                                                onClick={() => handlePay(c.id)}
                                                disabled={payingId === c.id}
                                                className="text-xs text-primary-700 hover:text-primary-800
                                                    font-medium disabled:opacity-50"
                                            >
                                                {payingId === c.id ? 'Recording...' : 'Mark Paid'}
                                            </button>
                                        )}
                                    </td>
                                )}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
};

// ============================================================
// MAIN INVESTMENT DETAIL PAGE
// ============================================================
const InvestmentDetailPage = () => {
    const { id } = useParams();
    const navigate = useNavigate();
    const { hasPermission } = useAuth();

    const [investment, setInvestment] = useState(null);
    const [categories, setCategories] = useState([]);
    const [loading,    setLoading]    = useState(true);
    const [error,      setError]      = useState(null);
    const [showExpenseModal,   setShowExpenseModal]   = useState(false);
    const [showReturnModal,    setShowReturnModal]    = useState(false);
    const [showOperationModal, setShowOperationModal] = useState(false);

    const loadInvestment = useCallback(async () => {
        try {
            setLoading(true);
            const res = await investmentsAPI.getById(id);
            setInvestment(res.data.data);
            setError(null);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, [id]);

    useEffect(() => {
        loadInvestment();
        categoriesAPI.getAll({ flat: true }).then(r => setCategories(r.data.data)).catch(() => {});
    }, [loadInvestment]);

    if (loading) {
        return <LoadingSpinner fullPage text="Loading investment..." />;
    }

    if (error || !investment) {
        return (
            <div>
                <button
                    onClick={() => navigate('/investments')}
                    className="flex items-center gap-2 text-sm text-gray-500
                        hover:text-gray-700 mb-6 transition-colors"
                >
                    <ArrowLeftIcon className="h-4 w-4" />
                    Back to Investments
                </button>
                <ErrorMessage message={error || 'Investment not found'} />
            </div>
        );
    }

    const currency  = investment.currency_code;
    const budget    = parseFloat(investment.planned_budget);
    const spent     = parseFloat(investment.actual_expenditure);
    const gained    = parseFloat(investment.total_returns);
    const remaining = budget - spent;
    const isOverBudget = remaining < 0;
    const projects  = investment.projects || [];
    const returns   = investment.returns  || [];

    // ---- Budget usage donut ----
    const budgetPieData = isOverBudget
        ? [{ name: 'Over Budget', value: spent }]
        : [
            { name: 'Spent',     value: spent },
            { name: 'Remaining', value: remaining },
          ];
    const BUDGET_COLORS = isOverBudget
        ? ['#dc2626']
        : ['#dc2626', '#2563eb'];

    // ---- Returns over time ----
    const returnsChartData = returns.map(r => ({
        date:   formatDate(r.return_date),
        amount: parseFloat(r.amount),
        type:   r.return_type,
    }));

    // ---- Spend by project (only worth showing with 2+ projects) ----
    const projectChartData = projects.map(p => ({
        name:   p.name.length > 14 ? `${p.name.slice(0, 14)}…` : p.name,
        Budget: parseFloat(p.planned_budget),
        Spent:  parseFloat(p.actual_expenditure),
    }));

    const canManage = hasPermission('INVESTMENT_MANAGE');

    return (
        <div>
            {/* Back button */}
            <button
                onClick={() => navigate('/investments')}
                className="flex items-center gap-2 text-sm text-gray-500
                    hover:text-gray-700 mb-6 transition-colors"
            >
                <ArrowLeftIcon className="h-4 w-4" />
                Back to Investments
            </button>

            {/* Investment Header */}
            <div className="rounded-xl p-6 mb-6 text-white
                bg-gradient-to-r from-primary-900 to-primary-700">
                <div className="flex items-start justify-between flex-wrap gap-4">
                    <div className="flex items-center gap-3">
                        <ChartBarIcon className="h-8 w-8 opacity-80" />
                        <div>
                            <p className="text-sm opacity-70 font-mono">
                                {investment.reference_code}
                            </p>
                            <h2 className="text-2xl font-bold mt-0.5">
                                {investment.name}
                            </h2>
                            <div className="mt-2 flex items-center gap-2">
                                <StatusBadge status={investment.status} />
                                {investment.investment_type === 'BOND' && (
                                    <span className="text-xs px-2 py-0.5 rounded-full
                                        bg-white bg-opacity-20 font-medium">
                                        Bond
                                    </span>
                                )}
                                <span className="text-xs opacity-70">
                                    {investment.category_trail || investment.category_name}
                                </span>
                            </div>
                        </div>
                    </div>
                    <div className="text-right">
                        <p className="text-sm opacity-70">Return on Investment</p>
                        <p className={`text-3xl font-bold mt-0.5 ${
                            parseFloat(investment.roi_percentage) >= 0
                                ? 'text-green-300' : 'text-red-300'
                        }`}>
                            {investment.roi_percentage}%
                        </p>
                    </div>
                </div>

                {/* Stats Row */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-6">
                    <div className="bg-white bg-opacity-10 rounded-lg p-3">
                        <p className="text-xs opacity-70">Planned Budget</p>
                        <p className="text-lg font-bold mt-1">
                            {currency} {budget.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                        </p>
                    </div>
                    <div className="bg-white bg-opacity-10 rounded-lg p-3">
                        <p className="text-xs opacity-70">Spent</p>
                        <p className="text-lg font-bold mt-1 text-red-300">
                            {currency} {spent.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                        </p>
                    </div>
                    <div className="bg-white bg-opacity-10 rounded-lg p-3">
                        <p className="text-xs opacity-70">
                            {isOverBudget ? 'Over Budget By' : 'Remaining Budget'}
                        </p>
                        <p className={`text-lg font-bold mt-1 ${
                            isOverBudget ? 'text-red-300' : 'text-white'
                        }`}>
                            {currency} {Math.abs(remaining).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                        </p>
                    </div>
                    <div className="bg-white bg-opacity-10 rounded-lg p-3">
                        <p className="text-xs opacity-70">Gained (Returns)</p>
                        <p className="text-lg font-bold mt-1 text-green-300">
                            {currency} {gained.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                        </p>
                    </div>
                </div>
            </div>

            {/* Actions */}
            {canManage && investment.status === 'ACTIVE' && (
                <div className="flex items-center gap-3 mb-6">
                    <button
                        onClick={() => setShowExpenseModal(true)}
                        className="btn-secondary flex items-center gap-2"
                    >
                        <MinusCircleIcon className="h-4 w-4" />
                        Record Expense
                    </button>
                    <button
                        onClick={() => setShowReturnModal(true)}
                        className="btn-primary flex items-center gap-2"
                    >
                        <PlusCircleIcon className="h-4 w-4" />
                        Record Return
                    </button>
                    <button
                        onClick={() => setShowOperationModal(true)}
                        className="btn-secondary flex items-center gap-2"
                    >
                        <ReceiptPercentIcon className="h-4 w-4" />
                        Record Operational Transaction
                    </button>
                </div>
            )}

            {/* Operating Budget — dedicated expenses/inflows/tax for THIS
                investment, and the resulting running balance unspent */}
            <OperatingBudgetCard investment={investment} />

            {/* Bond Coupon Schedule — only for BOND-type investments */}
            {investment.investment_type === 'BOND' && (
                <BondScheduleCard
                    investment={investment}
                    canManage={canManage}
                    onPaid={loadInvestment}
                />
            )}

            {/* Charts */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
                {/* Budget Usage */}
                <div className="card">
                    <h3 className="section-title mb-4">Budget Usage</h3>
                    {budget > 0 ? (
                        <ResponsiveContainer width="100%" height={220}>
                            <PieChart>
                                <Pie data={budgetPieData} cx="50%" cy="50%"
                                    innerRadius={50} outerRadius={80}
                                    dataKey="value">
                                    {budgetPieData.map((entry, index) => (
                                        <Cell key={index} fill={BUDGET_COLORS[index]} />
                                    ))}
                                </Pie>
                                <Tooltip
                                    formatter={(v) => [`${currency} ${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`]}
                                />
                                <Legend />
                            </PieChart>
                        </ResponsiveContainer>
                    ) : (
                        <div className="flex items-center justify-center h-48
                            text-gray-300 text-sm">
                            No budget set
                        </div>
                    )}
                </div>

                {/* Returns Over Time */}
                <div className="card lg:col-span-2">
                    <h3 className="section-title mb-4">Returns Over Time</h3>
                    {returnsChartData.length > 0 ? (
                        <ResponsiveContainer width="100%" height={220}>
                            <BarChart data={returnsChartData}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                                <XAxis dataKey="date" tick={{ fontSize: 11 }}
                                    tickLine={false} />
                                <YAxis tick={{ fontSize: 11 }} tickLine={false}
                                    axisLine={false}
                                    tickFormatter={v => v.toLocaleString('en-US', { maximumFractionDigits: 2 })} />
                                <Tooltip
                                    formatter={(v, n, p) => [
                                        `${currency} ${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`,
                                        p.payload.type?.replace(/_/g, ' '),
                                    ]}
                                />
                                <Bar dataKey="amount" fill="#16a34a" radius={[4, 4, 0, 0]} />
                            </BarChart>
                        </ResponsiveContainer>
                    ) : (
                        <div className="flex items-center justify-center h-48
                            text-gray-300 text-sm">
                            No returns recorded yet
                        </div>
                    )}
                </div>
            </div>

            {/* Spend by Project — only worth a chart with more than one project */}
            {projects.length > 1 && (
                <div className="card mb-6">
                    <h3 className="section-title mb-4">Budget vs Spent by Project</h3>
                    <ResponsiveContainer width="100%" height={Math.max(220, projects.length * 50)}>
                        <BarChart data={projectChartData} layout="vertical"
                            margin={{ left: 20 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                            <XAxis type="number" tick={{ fontSize: 11 }}
                                tickFormatter={v => v.toLocaleString('en-US', { maximumFractionDigits: 2 })} />
                            <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }}
                                width={110} />
                            <Tooltip
                                formatter={(v) => [`${currency} ${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`]}
                            />
                            <Legend />
                            <Bar dataKey="Budget" fill="#93c5fd" radius={[0, 4, 4, 0]} />
                            <Bar dataKey="Spent" fill="#dc2626" radius={[0, 4, 4, 0]} />
                        </BarChart>
                    </ResponsiveContainer>
                </div>
            )}

            {/* Main Content Grid */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Projects */}
                <div className="card">
                    <h3 className="section-title mb-4">
                        Projects ({projects.length})
                    </h3>
                    {projects.length === 0 ? (
                        <p className="text-sm text-gray-400 text-center py-8">
                            No projects under this investment yet
                        </p>
                    ) : (
                        <div className="space-y-4">
                            {projects.map(p => {
                                const pBudget = parseFloat(p.planned_budget);
                                const pSpent  = parseFloat(p.actual_expenditure);
                                const pct = pBudget > 0
                                    ? Math.min(100, (pSpent / pBudget) * 100)
                                    : 0;
                                return (
                                    <div key={p.id} className="border-b border-gray-100
                                        last:border-0 pb-4 last:pb-0">
                                        <div className="flex items-center justify-between mb-1">
                                            <p className="text-sm font-medium text-gray-900">
                                                {p.name}
                                            </p>
                                            <StatusBadge status={p.status} />
                                        </div>
                                        <p className="text-xs text-gray-400 mb-2">
                                            {p.project_reference} •{' '}
                                            {p.completed_milestones}/{p.total_milestones} milestones
                                            {' '}complete
                                        </p>
                                        <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
                                            <div
                                                className={`h-full ${
                                                    pct >= 100 ? 'bg-red-500' : 'bg-primary-600'
                                                }`}
                                                style={{ width: `${pct}%` }}
                                            />
                                        </div>
                                        <p className="text-xs text-gray-400 mt-1">
                                            {currency} {pSpent.toLocaleString('en-US', { maximumFractionDigits: 2 })} of{' '}
                                            {currency} {pBudget.toLocaleString('en-US', { maximumFractionDigits: 2 })} spent
                                        </p>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                {/* Returns History */}
                <div className="card">
                    <h3 className="section-title mb-4">
                        Returns History ({returns.length})
                    </h3>
                    {returns.length === 0 ? (
                        <p className="text-sm text-gray-400 text-center py-8">
                            No returns recorded yet
                        </p>
                    ) : (
                        <div className="space-y-3">
                            {[...returns].reverse().map((r, i) => (
                                <div key={i} className="flex items-center justify-between
                                    py-2 border-b border-gray-100 last:border-0">
                                    <div className="flex items-center gap-3">
                                        <div className="p-2 rounded-lg bg-green-50
                                            text-green-600">
                                            <ArrowTrendingUpIcon className="h-4 w-4" />
                                        </div>
                                        <div>
                                            <p className="text-sm font-medium text-gray-900">
                                                {r.return_type.replace(/_/g, ' ')}
                                            </p>
                                            <p className="text-xs text-gray-400">
                                                {r.return_reference} •{' '}
                                                {formatDate(r.return_date)}
                                            </p>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-3">
                                        <p className="text-sm font-semibold text-green-600">
                                            +{currency} {parseFloat(r.amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                                        </p>
                                        <button
                                            onClick={() => printDocument(investmentEntryTemplate({
                                                investment_name:      investment.name,
                                                investment_reference: investment.reference_code,
                                                entry_label:          r.return_type.replace(/_/g, ' '),
                                                amount:               r.amount,
                                                currency_code:        currency,
                                                direction:            'IN',
                                                date:                 r.return_date,
                                                reference_code:       r.return_reference,
                                                notes:                r.notes,
                                                recorded_by_name:     r.recorded_by_name,
                                                recorded_at:          r.created_at,
                                            }), r.return_reference)}
                                            className="text-gray-400 hover:text-primary-700"
                                            title="Preview / print receipt"
                                        >
                                            <PrinterIcon className="h-4 w-4" />
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {/* Details footer */}
            <div className="card mt-6">
                <h3 className="section-title mb-4">Details</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
                    <div>
                        <p className="text-gray-400 text-xs">Funding Account</p>
                        <p className="text-gray-900 font-medium mt-0.5">
                            {investment.funding_account_name}
                        </p>
                    </div>
                    <div>
                        <p className="text-gray-400 text-xs">Responsible</p>
                        <p className="text-gray-900 font-medium mt-0.5">
                            {investment.responsible_name || '—'}
                        </p>
                    </div>
                    <div>
                        <p className="text-gray-400 text-xs">Timeline</p>
                        <p className="text-gray-900 font-medium mt-0.5">
                            {formatDate(investment.start_date)} —{' '}
                            {formatDate(investment.expected_end_date)}
                        </p>
                    </div>
                    <div>
                        <p className="text-gray-400 text-xs">Created By</p>
                        <p className="text-gray-900 font-medium mt-0.5">
                            {investment.created_by_name}
                        </p>
                    </div>
                </div>
                {investment.description && (
                    <p className="text-sm text-gray-500 mt-4 pt-4 border-t border-gray-100">
                        {investment.description}
                    </p>
                )}
            </div>

            <RecordExpenseModal
                isOpen={showExpenseModal}
                onClose={() => setShowExpenseModal(false)}
                onSuccess={loadInvestment}
                investment={investment}
                categories={categories}
            />
            <RecordReturnModal
                isOpen={showReturnModal}
                onClose={() => setShowReturnModal(false)}
                onSuccess={loadInvestment}
                investment={investment}
            />
            <RecordOperationModal
                isOpen={showOperationModal}
                onClose={() => setShowOperationModal(false)}
                onSuccess={loadInvestment}
                investment={investment}
                categories={categories}
            />
        </div>
    );
};

export default InvestmentDetailPage;
