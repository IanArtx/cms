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
import { compactNumber, useChartTheme } from '../../hooks/useChartTheme';
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
    ExclamationTriangleIcon,
    ClipboardDocumentCheckIcon,
    LockClosedIcon,
    XCircleIcon,
} from '@heroicons/react/24/outline';
import {
    PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, CartesianGrid,
    Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { useBreadcrumbTitle } from '../../components/layout/LayoutContext'; // v1.71.0
import InvestmentLedger from './InvestmentLedger'; // v1.80.0
import { INVESTMENT_PURPOSES } from '../requisitions/requisitionParts'; // v1.80.0

// v1.60.0 — the fixed set of standard bond durations, matching how
// bonds are actually categorised when bought. Same list enforced
// server-side (investmentsController.js) and used for the quick-pick
// buttons on both the creation modal (InvestmentsPage.jsx) and the
// "Set Bond Term" modal below.
const BOND_TERMS = [2, 3, 5, 10, 15, 20, 25];

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
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">
                        Buy / expand — money put into the investment
                    </h2>
                    <p className="text-xs text-gray-500 mb-4">
                        Capital: it is added to what the investment is worth. For running costs (feed, wages, fuel …) or repairs use
                        <strong> Record Operational Transaction › Expense</strong> instead — those are expenses of the investment.
                    </p>
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
                                max={new Date().toISOString().slice(0, 10)}
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
                                    Automatic — Expense › Investments › Purchase &amp; expansion
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
                                {loading ? 'Recording...' : 'Record capital spending'}
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
        tax_deducted: '', tax_treatment: 'FINAL', tax_certificate_number: '',
    });
    const [loading, setLoading] = useState(false);
    const [error,   setError]   = useState(null);

    if (!isOpen) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            // v1.70.0 — tax kept back by the payer (amount is then the gross)
            const payload = { ...form };
            if (!(parseFloat(payload.tax_deducted) > 0)) {
                delete payload.tax_deducted; delete payload.tax_treatment; delete payload.tax_certificate_number;
            }
            await investmentsAPI.recordReturn(investment.id, payload);
            onSuccess();
            onClose();
            setForm({ amount: '', return_type: 'PROFIT_SHARE', return_date: '', notes: '', tax_deducted: '', tax_treatment: 'FINAL', tax_certificate_number: '' });
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
                                <option value="PRINCIPAL">Principal — the company's own capital coming back (not income)</option>
                            </select>
                        </div>
                        {form.return_type !== 'PRINCIPAL' && (
                            <div className="border border-gray-200 rounded-lg p-3 bg-gray-50 space-y-3">
                                <p className="text-xs text-gray-500">If the payer kept back tax, enter the <strong>gross</strong> return above and the tax here —
                                    it is recorded as its own entry and in the Tax register.</p>
                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                    <div><label className="label">Tax kept back</label>
                                        <input type="number" className="input" min="0" step="0.01" value={form.tax_deducted}
                                            onChange={e => setForm(p => ({ ...p, tax_deducted: e.target.value }))} /></div>
                                    <div><label className="label">Treatment</label>
                                        <select className="input" value={form.tax_treatment} onChange={e => setForm(p => ({ ...p, tax_treatment: e.target.value }))}>
                                            <option value="FINAL">Final tax</option><option value="CREDITABLE">Creditable</option>
                                        </select></div>
                                    <div><label className="label">Certificate no.</label>
                                        <input className="input" value={form.tax_certificate_number} onChange={e => setForm(p => ({ ...p, tax_certificate_number: e.target.value }))} /></div>
                                </div>
                            </div>
                        )}
                        <div>
                            <label className="label">Date *</label>
                            <input type="date" className="input"
                                value={form.return_date}
                                max={new Date().toISOString().slice(0, 10)}
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
        tax_treatment: 'FINAL', gross_amount: '', tax_certificate_number: '',
        cost_type: '', // v1.80.0 — what an expense was for
    });
    const [loading, setLoading] = useState(false);
    const [error,   setError]   = useState(null);

    if (!isOpen) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            const isTax = form.entry_type === 'TAX';
            if (form.entry_type === 'EXPENSE' && !form.cost_type) throw new Error('Choose what the expense was for.');
            await investmentsAPI.recordTransaction(investment.id, {
                ...form,
                cost_type: form.entry_type === 'EXPENSE' ? form.cost_type : undefined,
                amount:      parseFloat(form.amount),
                category_id: form.category_id || undefined,
                // v1.70.0 — a TAX entry is tax deducted at source
                tax_treatment: isTax ? form.tax_treatment : undefined,
                gross_amount: isTax && form.gross_amount ? parseFloat(form.gross_amount) : undefined,
                tax_certificate_number: isTax && form.tax_certificate_number ? form.tax_certificate_number : undefined,
            });
            onSuccess();
            onClose();
            setForm({ entry_type: 'EXPENSE', amount: '', entry_date: '',
                description: '', category_id: '', tax_treatment: 'FINAL', gross_amount: '', tax_certificate_number: '', cost_type: '' });
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
        TAX:     'Tax — tax deducted at source from this investment\'s income (recorded in the Tax register)',
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
                        {form.entry_type === 'EXPENSE' && (
                            <div>
                                <label className="label">What was it for? *</label>
                                <div className="space-y-1.5">
                                    {INVESTMENT_PURPOSES.map(pp => (
                                        <label key={pp.value} className={`flex items-start gap-2 rounded-lg border px-3 py-2 cursor-pointer ${form.cost_type === pp.value ? 'border-primary-500 bg-primary-50' : 'border-gray-200'}`}>
                                            <input type="radio" name="cost_type" className="mt-1" checked={form.cost_type === pp.value}
                                                onChange={() => setForm(p => ({ ...p, cost_type: pp.value }))} />
                                            <span><span className="text-sm font-medium text-gray-900">{pp.label}</span>
                                                <span className="block text-xs text-gray-500">{pp.hint}</span></span>
                                        </label>
                                    ))}
                                </div>
                            </div>
                        )}
                        {form.entry_type === 'TAX' && (
                            <div className="border border-gray-200 rounded-lg p-3 bg-gray-50 grid grid-cols-1 sm:grid-cols-3 gap-3">
                                <div><label className="label">Treatment</label>
                                    <select className="input" value={form.tax_treatment} onChange={e => setForm(p => ({ ...p, tax_treatment: e.target.value }))}>
                                        <option value="FINAL">Final tax (e.g. government securities)</option>
                                        <option value="CREDITABLE">Creditable (set off against corporate tax)</option>
                                    </select></div>
                                <div><label className="label">Gross income it was taken from</label>
                                    <input type="number" className="input" min="0" step="0.01" value={form.gross_amount} onChange={e => setForm(p => ({ ...p, gross_amount: e.target.value }))} /></div>
                                <div><label className="label">Certificate no.</label>
                                    <input className="input" value={form.tax_certificate_number} onChange={e => setForm(p => ({ ...p, tax_certificate_number: e.target.value }))} /></div>
                            </div>
                        )}
                        <div>
                            <label className="label">Date *</label>
                            <input type="date" className="input"
                                value={form.entry_date}
                                max={new Date().toISOString().slice(0, 10)}
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
                                    {form.entry_type === 'EXPENSE'
                                        ? 'Automatic — Expense › Investments › (what it was for)'
                                        : `Use investment's category (${investment.category_name})`}
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
                                <tr key={op.id} className={`border-b border-gray-50 last:border-0 ${op.is_reversed ? 'opacity-60' : ''}`}>
                                    <td className="px-2 py-2 text-gray-700">{formatDate(op.entry_date)}</td>
                                    <td className="px-2 py-2">
                                        <span className={`text-xs ${
                                            op.entry_type === 'INFLOW' ? 'badge-green' : 'badge-red'
                                        }`}>
                                            {op.entry_type === 'INFLOW' ? 'Inflow' :
                                             op.entry_type === 'TAX' ? 'Tax' : 'Expense'}
                                        </span>
                                        {op.is_reversed && (
                                            <span className="ml-1.5 text-xs badge-gray"
                                                title={`Reversed ${formatDate(op.reversed_at)} — no longer counted`}>
                                                Reversed
                                            </span>
                                        )}
                                    </td>
                                    <td className="px-2 py-2 text-gray-600">{op.description || '—'}</td>
                                    <td className={`px-2 py-2 text-right font-medium ${
                                        op.entry_type === 'INFLOW' ? 'text-green-600' : 'text-red-600'
                                    }`}>
                                        <span className={op.is_reversed ? 'line-through' : ''}>
                                        {op.entry_type === 'INFLOW' ? '+' : '-'}
                                        {currency} {parseFloat(op.amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                                        </span>
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
// Statuses in which coupon actions (mark paid / adjust / reschedule)
// are still permitted — mirrors MUTABLE_INVESTMENT_STATUSES on the
// backend (ACTIVE plus the termination review window).
const COUPON_MUTABLE_STATUSES = ['ACTIVE', 'PENDING_TERMINATION'];

const BondScheduleCard = ({ investment, canManage, onPaid }) => {
    const [payingId, setPayingId] = useState(null);
    const [adjustingCoupon, setAdjustingCoupon] = useState(null);
    const [showRescheduleModal, setShowRescheduleModal] = useState(false);
    const [showSettlementModal, setShowSettlementModal] = useState(false);
    const [showTermModal, setShowTermModal] = useState(false);
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
    const anyPaid = coupons.some(c => c.status === 'PAID');
    const todayISO = new Date().toISOString().slice(0, 10);
    const canManageNow = canManage && COUPON_MUTABLE_STATUSES.includes(investment.status);

    // v1.40.0: settlement value — bond bought at a discount/premium to
    // face value. Coupon math always stays on face_value; this is
    // purely informational.
    const hasSettlement = investment.settlement_value !== null && investment.settlement_value !== undefined;
    const settlementPct = investment.settlement_percentage !== null && investment.settlement_percentage !== undefined
        ? parseFloat(investment.settlement_percentage) : null;
    const discountAmount = investment.settlement_discount_amount !== null && investment.settlement_discount_amount !== undefined
        ? parseFloat(investment.settlement_discount_amount) : null;
    // v1.42.0: settlement value can still be recorded (and is
    // auto-funded the moment it is) any time after approval, as long
    // as nothing has been funded against this investment yet by any
    // means — once actual_expenditure > 0 it's locked, same principle
    // as the coupon schedule locking after the first coupon is paid.
    const canRecordSettlement = canManage && investment.status === 'ACTIVE' &&
        parseFloat(investment.actual_expenditure || 0) === 0;

    return (
        <div className="card mb-6">
            <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
                <h3 className="section-title">Bond Coupon Schedule</h3>
                <div className="flex items-center gap-2">
                    <span className="badge-blue text-xs">
                        {parseFloat(investment.coupon_rate)}% p.a. •{' '}
                        {investment.coupon_frequency?.replace(/_/g, ' ')}
                    </span>
                    {canManageNow && !anyPaid && (
                        <button
                            onClick={() => setShowRescheduleModal(true)}
                            className="text-xs text-primary-700 hover:text-primary-800 font-medium"
                        >
                            Edit Coupon Date / Frequency
                        </button>
                    )}
                </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-5">
                <div>
                    <p className="text-gray-400 text-xs">Term</p>
                    <p className="text-sm font-semibold text-gray-900 mt-0.5">
                        {investment.bond_term_years ? (
                            <>
                                {investment.bond_term_years} Years
                                {canManage && (
                                    <button onClick={() => setShowTermModal(true)}
                                        className="ml-2 text-xs font-normal text-primary-700 hover:text-primary-800 underline">
                                        Change
                                    </button>
                                )}
                            </>
                        ) : canManage ? (
                            <button onClick={() => setShowTermModal(true)}
                                className="text-xs font-medium text-amber-700 hover:text-amber-800 underline">
                                Set Term
                            </button>
                        ) : (
                            <span className="text-gray-300">Not set</span>
                        )}
                    </p>
                </div>
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

            {hasSettlement && (
                <div className="mb-5 p-3 rounded-lg bg-blue-50 border border-blue-100 flex items-center justify-between flex-wrap gap-2">
                    <div>
                        <p className="text-xs text-blue-900 font-medium">
                            Settlement Value: {currency} {parseFloat(investment.settlement_value).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                            {' '}({settlementPct}% of face value)
                        </p>
                        <p className="text-xs text-blue-700 mt-0.5">
                            {discountAmount > 0
                                ? `Bought at a discount — ${currency} ${discountAmount.toLocaleString('en-US', { maximumFractionDigits: 2 })} less than face value`
                                : discountAmount < 0
                                ? `Bought at a premium — ${currency} ${Math.abs(discountAmount).toLocaleString('en-US', { maximumFractionDigits: 2 })} more than face value`
                                : 'Bought at par (100% of face value)'}
                            . Coupon payments remain calculated on the full face value.
                        </p>
                    </div>
                </div>
            )}

            {!hasSettlement && canRecordSettlement && (
                <div className="mb-5 p-3 rounded-lg bg-amber-50 border border-amber-100 flex items-center justify-between flex-wrap gap-2">
                    <p className="text-xs text-amber-900">
                        Settlement value wasn't known when this bond was approved, so it hasn't been funded yet.
                        Record it now to fund it automatically.
                    </p>
                    <button
                        onClick={() => setShowSettlementModal(true)}
                        className="text-xs text-amber-900 hover:text-amber-950 font-semibold underline"
                    >
                        Record Settlement Value
                    </button>
                </div>
            )}

            {/* v1.60.0 — a legacy bond migration_v1.60.0.sql's auto-
                backfill couldn't confidently match to one of the 7
                standard terms (its duration didn't cleanly fit any
                bucket) sits with no term until assigned by hand here. */}
            {!investment.bond_term_years && canManage && (
                <div className="mb-5 p-3 rounded-lg bg-amber-50 border border-amber-100 flex items-center justify-between flex-wrap gap-2">
                    <p className="text-xs text-amber-900">
                        This bond has no term assigned yet — its duration didn't cleanly match one of the
                        standard terms (2/3/5/10/15/20/25yr) when this was auto-checked. Set it by hand.
                    </p>
                    <button
                        onClick={() => setShowTermModal(true)}
                        className="text-xs text-amber-900 hover:text-amber-950 font-semibold underline"
                    >
                        Set Bond Term
                    </button>
                </div>
            )}

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
                            {canManageNow && <th className="px-2 py-2 font-medium text-right">Action</th>}
                        </tr>
                    </thead>
                    <tbody>
                        {coupons.map(c => {
                            const isAdjusted = c.actual_gross_amount !== null && c.actual_gross_amount !== undefined;
                            const isDue = c.due_date <= todayISO;
                            return (
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
                                            <div>
                                                <span className="badge-green text-xs flex items-center gap-1 w-fit">
                                                    <CheckCircleIcon className="h-3.5 w-3.5" /> Paid
                                                </span>
                                                {isAdjusted && (
                                                    <p className="text-xs text-amber-600 mt-1">
                                                        Actual: {currency} {parseFloat(c.actual_gross_amount).toLocaleString('en-US', { maximumFractionDigits: 2 })} gross,{' '}
                                                        {currency} {parseFloat(c.actual_net_amount).toLocaleString('en-US', { maximumFractionDigits: 2 })} net
                                                    </p>
                                                )}
                                            </div>
                                        ) : c.status === 'MISSED' ? (
                                            <span className="badge-red text-xs">Missed</span>
                                        ) : (
                                            <span className="badge-yellow text-xs">
                                                {isDue ? 'Pending' : 'Not yet due'}
                                            </span>
                                        )}
                                    </td>
                                    {canManageNow && (
                                        <td className="px-2 py-2 text-right">
                                            {c.status === 'PENDING' && (
                                                isDue ? (
                                                    <div className="flex items-center justify-end gap-3">
                                                        <button
                                                            onClick={() => handlePay(c.id)}
                                                            disabled={payingId === c.id}
                                                            className="text-xs text-primary-700 hover:text-primary-800
                                                                font-medium disabled:opacity-50"
                                                        >
                                                            {payingId === c.id ? 'Recording...' : 'Mark Paid'}
                                                        </button>
                                                        <button
                                                            onClick={() => setAdjustingCoupon(c)}
                                                            className="text-xs text-amber-600 hover:text-amber-700 font-medium"
                                                        >
                                                            Record Actual Payment
                                                        </button>
                                                    </div>
                                                ) : (
                                                    <span className="text-xs text-gray-300">Not due yet</span>
                                                )
                                            )}
                                        </td>
                                    )}
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            <RecordActualCouponPaymentModal
                coupon={adjustingCoupon}
                investment={investment}
                onClose={() => setAdjustingCoupon(null)}
                onSuccess={onPaid}
            />
            <UpdateCouponScheduleModal
                isOpen={showRescheduleModal}
                onClose={() => setShowRescheduleModal(false)}
                onSuccess={onPaid}
                investment={investment}
            />
            <RecordSettlementValueModal
                isOpen={showSettlementModal}
                onClose={() => setShowSettlementModal(false)}
                onSuccess={onPaid}
                investment={investment}
            />
            <SetBondTermModal
                isOpen={showTermModal}
                onClose={() => setShowTermModal(false)}
                onSuccess={onPaid}
                investment={investment}
            />
        </div>
    );
};

// ============================================================
// RECORD ACTUAL COUPON PAYMENT MODAL
// "Adjust Payment" — the amount actually received differs from the
// scheduled coupon amount. Tax is auto-recalculated on the entered
// gross amount using the bond's own tax_withholding_rate; only this
// one coupon is affected.
// ============================================================
const RecordActualCouponPaymentModal = ({ coupon, investment, onClose, onSuccess }) => {
    const [amount, setAmount] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (coupon) setAmount('');
    }, [coupon]);

    if (!coupon) return null;

    const taxRate = parseFloat(investment.tax_withholding_rate) || 0;
    const previewGross = parseFloat(amount) || 0;
    const previewTax = Math.round(previewGross * (taxRate / 100) * 100) / 100;
    const previewNet = Math.round((previewGross - previewTax) * 100) / 100;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await investmentsAPI.payCoupon(investment.id, coupon.id, {
                actual_gross_amount: parseFloat(amount),
            });
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
                <div className="relative bg-white rounded-xl shadow-xl max-w-lg w-full p-6">
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">
                        Record Actual Payment — Coupon #{coupon.coupon_number}
                    </h2>
                    <p className="text-xs text-gray-400 mb-4">
                        Scheduled gross was {investment.currency_code} {parseFloat(coupon.gross_amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}.
                        Enter what was actually received — tax and net are recalculated automatically.
                        Only this coupon is affected; the rest of the schedule is unchanged.
                    </p>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">
                                Actual Gross Amount {investment.currency_code} *
                            </label>
                            <input type="number" className="input"
                                value={amount}
                                onChange={e => setAmount(e.target.value)}
                                min="0.01" step="0.01" required autoFocus />
                        </div>
                        {previewGross > 0 && (
                            <div className="rounded-lg bg-gray-50 p-3 text-xs space-y-1">
                                <div className="flex justify-between">
                                    <span className="text-gray-500">Tax withheld ({taxRate}%)</span>
                                    <span className="font-medium text-red-600">
                                        {investment.currency_code} {previewTax.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                                    </span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-gray-500">Net</span>
                                    <span className="font-semibold text-green-600">
                                        {investment.currency_code} {previewNet.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                                    </span>
                                </div>
                            </div>
                        )}
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose}
                                className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading}
                                className="btn-primary">
                                {loading ? 'Recording...' : 'Record Payment'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// UPDATE COUPON SCHEDULE MODAL
// Sets/corrects the first coupon date and regenerates the whole
// schedule from it — only usable before any coupon has been paid.
// ============================================================
const COUPON_FREQUENCY_OPTIONS = ['MONTHLY', 'QUARTERLY', 'SEMI_ANNUALLY', 'ANNUALLY', 'AT_MATURITY'];

const UpdateCouponScheduleModal = ({ isOpen, onClose, onSuccess, investment }) => {
    const [firstCouponDate, setFirstCouponDate] = useState(investment.first_coupon_date?.slice(0, 10) || '');
    const [frequency, setFrequency] = useState(investment.coupon_frequency || 'QUARTERLY');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    if (!isOpen) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await investmentsAPI.updateCouponSchedule(investment.id, {
                first_coupon_date: firstCouponDate,
                coupon_frequency: frequency,
            });
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
                <div className="relative bg-white rounded-xl shadow-xl max-w-lg w-full p-6">
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">
                        Edit Coupon Date / Frequency
                    </h2>
                    <p className="text-xs text-gray-400 mb-4">
                        The rest of the coupon schedule will be recalculated automatically from this date and
                        frequency, using the bond's existing face value and rate. Only usable until the first
                        coupon has actually been paid.
                    </p>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">First Coupon Date *</label>
                            <input type="date" className="input"
                                value={firstCouponDate}
                                onChange={e => setFirstCouponDate(e.target.value)}
                                required />
                        </div>
                        <div>
                            <label className="label">Coupon Frequency *</label>
                            <select className="input"
                                value={frequency}
                                onChange={e => setFrequency(e.target.value)}
                                required>
                                {COUPON_FREQUENCY_OPTIONS.map(f => (
                                    <option key={f} value={f}>{f.replace(/_/g, ' ')}</option>
                                ))}
                            </select>
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose}
                                className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading}
                                className="btn-primary">
                                {loading ? 'Saving...' : 'Save & Recalculate'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// v1.42.0 — record (or correct) a bond's settlement value once it's
// already ACTIVE, immediately auto-funding it. Only rendered/usable
// while nothing has been funded against the investment yet
// (actual_expenditure still 0) — see canRecordSettlement above.
const RecordSettlementValueModal = ({ isOpen, onClose, onSuccess, investment }) => {
    const [amount, setAmount] = useState(investment.settlement_value || '');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    if (!isOpen) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await investmentsAPI.setSettlementValue(investment.id, { settlement_value: amount });
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
                <div className="relative bg-white rounded-xl shadow-xl max-w-lg w-full p-6">
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">Record Settlement Value</h2>
                    <p className="text-xs text-gray-400 mb-4">
                        The price actually paid for this bond (at par, a discount, or a premium to face value).
                        This amount will be deducted from the funding account immediately — the investment can't
                        go below a zero balance.
                    </p>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">Settlement Value *</label>
                            <input type="number" step="0.01" min="0.01" className="input"
                                value={amount}
                                onChange={e => setAmount(e.target.value)}
                                required />
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose}
                                className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading}
                                className="btn-primary">
                                {loading ? 'Recording...' : 'Record & Fund'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// v1.60.0 — assign (or correct) the categorical term for a bond,
// either a legacy record the migration's auto-backfill couldn't
// confidently match, or simply to fix a mistaken pick later. Mirrors
// RecordSettlementValueModal's shape; quick-pick buttons instead of
// a free-text field since the term is a fixed 7-value set.
const SetBondTermModal = ({ isOpen, onClose, onSuccess, investment }) => {
    const [term, setTerm] = useState(investment.bond_term_years || '');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    if (!isOpen) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!term) {
            setError('Select a term.');
            return;
        }
        setLoading(true);
        setError(null);
        try {
            await investmentsAPI.setBondTerm(investment.id, { bond_term_years: term });
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
                <div className="relative bg-white rounded-xl shadow-xl max-w-lg w-full p-6">
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">Set Bond Term</h2>
                    <p className="text-xs text-gray-400 mb-4">
                        Which of the standard bond durations this bond runs — how it was categorised when bought.
                        This lets the company track how much is invested in, say, "10yr bonds" as a whole.
                    </p>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">Term *</label>
                            <div className="flex flex-wrap gap-2 mt-1">
                                {BOND_TERMS.map(t => (
                                    <button
                                        key={t}
                                        type="button"
                                        onClick={() => setTerm(t)}
                                        className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                                            term === t
                                                ? 'bg-primary-600 text-white border-primary-600'
                                                : 'bg-white text-gray-700 border-gray-200 hover:border-primary-300'
                                        }`}
                                    >
                                        {t}yr
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose}
                                className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading || !term}
                                className="btn-primary">
                                {loading ? 'Saving...' : 'Save Term'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// REQUEST TERMINATION MODAL
// Step 1 of the mid-term termination workflow — states the reason a
// resolution was made to close this investment early.
// ============================================================
const RequestTerminationModal = ({ isOpen, onClose, onSuccess, investment }) => {
    const [reason, setReason] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    if (!isOpen) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await investmentsAPI.requestTermination(investment.id, { reason });
            onSuccess();
            onClose();
            setReason('');
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
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">
                        Terminate Investment
                    </h2>
                    <p className="text-xs text-gray-400 mb-4">
                        This puts "{investment.name}" up for mid-term termination by internal resolution.
                        {investment.responsible_name
                            ? ` ${investment.responsible_name} will be asked to confirm all records are up to date`
                            : ' An investment approver will need to confirm all records are up to date'}
                        , then a Treasurer/Director gives final sign-off before it's formally closed.
                    </p>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">Reason / Resolution *</label>
                            <textarea className="input" rows={3}
                                value={reason}
                                onChange={e => setReason(e.target.value)}
                                required />
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose}
                                className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading}
                                className="btn-primary">
                                {loading ? 'Submitting...' : 'Request Termination'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// APPROVE TERMINATION MODAL
// Final Treasurer/Director sign-off — closes the investment and
// generates its closing report.
// ============================================================
const ApproveTerminationModal = ({ isOpen, onClose, onSuccess, investment }) => {
    const [closingNote, setClosingNote] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    if (!isOpen) return null;

    const netResult = parseFloat(investment.total_returns) - parseFloat(investment.actual_expenditure);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await investmentsAPI.approveTermination(investment.id, { closing_note: closingNote });
            onSuccess();
            onClose();
            setClosingNote('');
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
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">
                        Approve & Close Investment
                    </h2>
                    <p className="text-xs text-gray-400 mb-4">
                        This is final — the investment will be marked TERMINATED and a closing report generated,
                        showing a {netResult >= 0 ? 'profit' : 'loss'} of {investment.currency_code}{' '}
                        {Math.abs(netResult).toLocaleString('en-US', { maximumFractionDigits: 2 })}.
                        Any coupons still pending will be marked missed.
                    </p>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">Closing Note (optional)</label>
                            <textarea className="input" rows={2}
                                value={closingNote}
                                onChange={e => setClosingNote(e.target.value)} />
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose}
                                className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading}
                                className="btn-primary">
                                {loading ? 'Closing...' : 'Approve & Close'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// REJECT TERMINATION MODAL
// Abandons the termination request and restores the investment to
// whatever status it had before (ACTIVE or ON_HOLD).
// ============================================================
const RejectTerminationModal = ({ isOpen, onClose, onSuccess, investment }) => {
    const [reason, setReason] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    if (!isOpen) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await investmentsAPI.rejectTermination(investment.id, { reason });
            onSuccess();
            onClose();
            setReason('');
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
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">
                        Reject / Cancel Termination
                    </h2>
                    <p className="text-xs text-gray-400 mb-4">
                        This abandons the termination request and restores the investment to its previous status.
                    </p>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">Reason (optional)</label>
                            <textarea className="input" rows={2}
                                value={reason}
                                onChange={e => setReason(e.target.value)} />
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose}
                                className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading}
                                className="btn-primary">
                                {loading ? 'Submitting...' : 'Reject Termination'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// MAIN INVESTMENT DETAIL PAGE
// ============================================================
// ============================================================
// TREASURY BILL (v1.70.0) — face value, price paid, discount, the tax
// on it (FINAL, taken at purchase or at maturity), and "Record
// maturity" once the maturity date has come.
// ============================================================
const TreasuryBillCard = ({ investment, canManage, onDone }) => {
    const [open, setOpen] = useState(false);
    const [form, setForm] = useState({ maturity_date: '', amount_received: '', tax_amount: '', tax_certificate_number: '' });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [done, setDone] = useState(null);
    const face = parseFloat(investment.face_value) || 0;
    const price = parseFloat(investment.settlement_value) || 0;
    const rate = parseFloat(investment.tax_withholding_rate) || 0;
    const discount = face - price;
    const tax = Math.round(discount * rate) / 100;
    const atPurchase = investment.tbill_tax_timing === 'AT_PURCHASE';
    const maturity = investment.expected_end_date ? String(investment.expected_end_date).slice(0, 10) : null;
    const due = maturity && maturity <= new Date().toISOString().slice(0, 10);
    const matured = investment.status === 'COMPLETED';
    const cur = investment.currency_code;
    const n = (v) => Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
    const submit = async (e) => {
        e.preventDefault(); setBusy(true); setError(null);
        try {
            const payload = {};
            Object.entries(form).forEach(([k, v]) => { if (v !== '') payload[k] = v; });
            const res = await investmentsAPI.recordTreasuryBillMaturity(investment.id, payload);
            setDone(res.data.message); setOpen(false); onDone();
        } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
    };
    return (
        <div className="card mb-6">
            <h3 className="section-title mb-3">Treasury Bill</h3>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 text-sm">
                <div><p className="text-gray-500 text-xs">Face value</p><p className="font-semibold">{cur} {n(face)}</p></div>
                <div><p className="text-gray-500 text-xs">Price paid</p><p className="font-semibold">{cur} {n(price)}</p></div>
                <div><p className="text-gray-500 text-xs">Discount (income)</p><p className="font-semibold text-green-700">{cur} {n(discount)}</p></div>
                <div><p className="text-gray-500 text-xs">Tax {rate}% (final)</p><p className="font-semibold">{cur} {n(tax)}</p>
                    <p className="text-[11px] text-gray-400">{atPurchase ? 'paid with the purchase' : 'deducted at maturity'}</p></div>
                <div><p className="text-gray-500 text-xs">Matures</p><p className="font-semibold">{maturity ? formatDate(maturity) : '—'}</p>
                    <p className="text-[11px] text-gray-400">receive {cur} {n(atPurchase ? face : face - tax)}</p></div>
            </div>
            {done && <p className="text-sm text-green-700 mt-3">{done}</p>}
            {matured && <p className="text-sm text-gray-500 mt-3">Matured and closed. The discount is in investment income; the tax is in the Tax register.</p>}
            {!matured && canManage && ['ACTIVE', 'PENDING_TERMINATION'].includes(investment.status) && (
                <div className="mt-4">
                    {!open ? (
                        <button className="btn-primary text-sm" disabled={!due} title={due ? '' : 'Available on the maturity date'} onClick={() => setOpen(true)}>
                            Record maturity
                        </button>
                    ) : (
                        <form onSubmit={submit} className="bg-gray-50 border border-gray-200 rounded-lg p-3 space-y-3">
                            {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
                            <p className="text-xs text-gray-500">Leave the fields empty to use the expected figures. Change them only if the bank statement shows something different.</p>
                            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                                <div><label className="label">Maturity date</label>
                                    <input type="date" className="input" value={form.maturity_date} placeholder={maturity || ''} max={new Date().toISOString().slice(0, 10)}
                                        onChange={e => setForm(p => ({ ...p, maturity_date: e.target.value }))} /></div>
                                <div><label className="label">Amount received ({cur})</label>
                                    <input type="number" step="0.01" className="input" placeholder={n(atPurchase ? face : face - tax)} value={form.amount_received}
                                        onChange={e => setForm(p => ({ ...p, amount_received: e.target.value }))} /></div>
                                <div><label className="label">Tax ({cur})</label>
                                    <input type="number" step="0.01" className="input" placeholder={n(tax)} value={form.tax_amount}
                                        onChange={e => setForm(p => ({ ...p, tax_amount: e.target.value }))} /></div>
                                <div><label className="label">Certificate no.</label>
                                    <input className="input" value={form.tax_certificate_number} onChange={e => setForm(p => ({ ...p, tax_certificate_number: e.target.value }))} /></div>
                            </div>
                            <div className="flex justify-end gap-2">
                                <button type="button" className="btn-secondary text-sm" onClick={() => setOpen(false)}>Cancel</button>
                                <button className="btn-primary text-sm" disabled={busy}>{busy ? 'Saving…' : 'Record maturity'}</button>
                            </div>
                        </form>
                    )}
                </div>
            )}
        </div>
    );
};

const InvestmentDetailPage = () => {
    const { id } = useParams();
    const navigate = useNavigate();
    const { hasPermission, user } = useAuth();
    const theme = useChartTheme();

    const [investment, setInvestment] = useState(null);
    useBreadcrumbTitle(investment?.name || null);
    const [categories, setCategories] = useState([]);
    const [loading,    setLoading]    = useState(true);
    const [error,      setError]      = useState(null);
    const [showExpenseModal,   setShowExpenseModal]   = useState(false);
    const [showReturnModal,    setShowReturnModal]    = useState(false);
    const [showOperationModal, setShowOperationModal] = useState(false);
    const [showTerminateModal, setShowTerminateModal] = useState(false);
    const [showApproveTermModal, setShowApproveTermModal] = useState(false);
    const [showRejectTermModal,  setShowRejectTermModal]  = useState(false);
    const [termActionLoading, setTermActionLoading] = useState(false);
    const [termActionError,   setTermActionError]   = useState(null);

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
        ? [theme.danger]
        : [theme.danger, theme.primary];

    // ---- Returns over time ----
    // v1.72.0 — reversed returns stay in the history (marked "Reversed")
    // but are left out of the chart, as they are left out of Returns.
    const returnsChartData = returns.filter(r => !r.is_reversed).map(r => ({
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
    const canApprove = hasPermission('INVESTMENT_APPROVE');
    const supplementaryBudget = parseFloat(investment.supplementary_budget) || 0;
    const isPendingTermination = investment.status === 'PENDING_TERMINATION';
    const isTerminated = investment.status === 'TERMINATED';
    const isResponsiblePerson = !!investment.responsible_user_id && investment.responsible_user_id === user?.id;
    const canConfirmRecords = isPendingTermination && !investment.records_confirmed_at &&
        (investment.responsible_user_id ? isResponsiblePerson : canApprove);
    const canRequestTermination = canManage && ['ACTIVE', 'ON_HOLD'].includes(investment.status);
    const canApproveTermination = canApprove && isPendingTermination && !!investment.records_confirmed_at;
    const canRejectTermination = (canManage || canApprove) && isPendingTermination;
    const PERFORMANCE_LABELS = {
        PROFITABLE: { text: 'Profitable', cls: 'text-green-300' },
        LOSING:     { text: 'Losing',     cls: 'text-red-300' },
        BREAK_EVEN: { text: 'Break-even', cls: 'text-white' },
    };
    const performance = PERFORMANCE_LABELS[investment.performance_status];

    const doTerminationAction = async (fn) => {
        setTermActionLoading(true);
        setTermActionError(null);
        try {
            await fn();
            await loadInvestment();
        } catch (err) {
            setTermActionError(getErrorMessage(err));
        } finally {
            setTermActionLoading(false);
        }
    };

    return (
        <div>

            {/* Investment Header */}
            <div className="page-banner -mx-4 -mt-4 md:-mx-6 md:-mt-6 mb-6 px-4 md:px-7 py-6">
                <button type="button" onClick={() => navigate('/investments')} className="mb-4 inline-flex items-center gap-2 text-sm font-semibold text-white/90 hover:text-white rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-white">
                    <ArrowLeftIcon className="h-4 w-4" />
                    Back to Investments
                </button>
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
                        {performance && (
                            <p className={`text-xs font-medium mt-0.5 ${performance.cls}`}>
                                {performance.text}
                            </p>
                        )}
                    </div>
                </div>

                {/* Stats Row */}
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 mt-6">
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
                    <div className="bg-white bg-opacity-10 rounded-lg p-3">
                        <p className="text-xs opacity-70">Supplementary Budget</p>
                        <p className={`text-lg font-bold mt-1 ${supplementaryBudget > 0 ? 'text-amber-300' : 'text-white'}`}>
                            {currency} {supplementaryBudget.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                        </p>
                    </div>
                </div>
            </div>

            {/* Termination status */}
            {isPendingTermination && (
                <div className="card mb-6 border-l-4 border-amber-400">
                    <div className="flex items-start gap-3">
                        <ExclamationTriangleIcon className="h-5 w-5 text-amber-500 flex-shrink-0 mt-0.5" />
                        <div className="flex-1">
                            <h3 className="text-sm font-semibold text-gray-900">
                                Termination under review
                            </h3>
                            <p className="text-sm text-gray-600 mt-1">
                                Requested by {investment.termination_requested_by_name || '—'} on{' '}
                                {formatDate(investment.termination_requested_at)}: "{investment.termination_reason}"
                            </p>
                            <p className="text-sm text-gray-600 mt-1">
                                {investment.records_confirmed_at ? (
                                    <>Records confirmed up to date by {investment.records_confirmed_by_name} on{' '}
                                    {formatDate(investment.records_confirmed_at)}. Awaiting final approval to close.</>
                                ) : (
                                    <>Awaiting records confirmation from{' '}
                                    {investment.responsible_name
                                        ? `${investment.responsible_name} (the responsible person)`
                                        : 'an investment approver (no responsible person on file)'}.</>
                                )}
                            </p>
                            {termActionError && (
                                <div className="mt-3">
                                    <ErrorMessage message={termActionError} onDismiss={() => setTermActionError(null)} />
                                </div>
                            )}
                            <div className="flex items-center gap-3 mt-3">
                                {canConfirmRecords && (
                                    <button
                                        disabled={termActionLoading}
                                        onClick={() => doTerminationAction(
                                            () => investmentsAPI.confirmTerminationRecords(investment.id)
                                        )}
                                        className="btn-secondary text-xs flex items-center gap-1.5 disabled:opacity-50"
                                    >
                                        <ClipboardDocumentCheckIcon className="h-4 w-4" />
                                        Confirm Records Up To Date
                                    </button>
                                )}
                                {canApproveTermination && (
                                    <button
                                        disabled={termActionLoading}
                                        onClick={() => setShowApproveTermModal(true)}
                                        className="btn-primary text-xs flex items-center gap-1.5 disabled:opacity-50"
                                    >
                                        <LockClosedIcon className="h-4 w-4" />
                                        Approve & Close Investment
                                    </button>
                                )}
                                {canRejectTermination && (
                                    <button
                                        disabled={termActionLoading}
                                        onClick={() => setShowRejectTermModal(true)}
                                        className="text-xs text-gray-500 hover:text-red-600 flex items-center gap-1.5 disabled:opacity-50"
                                    >
                                        <XCircleIcon className="h-4 w-4" />
                                        Reject / Cancel Termination
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {isTerminated && investment.termination_report && (
                <div className="card mb-6 border-l-4 border-gray-400">
                    <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
                        <LockClosedIcon className="h-4 w-4 text-gray-400" />
                        Termination Report
                    </h3>
                    <p className="text-xs text-gray-400 mt-1">
                        Closed by {investment.termination_approved_by_name || '—'} on{' '}
                        {formatDate(investment.termination_approved_at)}
                    </p>
                    <pre className="text-sm text-gray-700 mt-3 whitespace-pre-wrap font-sans">
                        {investment.termination_report}
                    </pre>
                </div>
            )}

            {/* Actions */}
            {(canManage && (investment.status === 'ACTIVE' || isPendingTermination)) || canRequestTermination ? (
                <div className="flex items-center gap-3 mb-6 flex-wrap">
                    {canManage && investment.status === 'ACTIVE' && (
                        <button
                            onClick={() => setShowExpenseModal(true)}
                            className="btn-secondary flex items-center gap-2"
                        >
                            <MinusCircleIcon className="h-4 w-4" />
                            Buy / Expand (capital)
                        </button>
                    )}
                    {canManage && (investment.status === 'ACTIVE' || isPendingTermination) && (
                        <>
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
                        </>
                    )}
                    {canRequestTermination && (
                        <button
                            onClick={() => setShowTerminateModal(true)}
                            className="text-sm text-gray-500 hover:text-red-600 flex items-center gap-2 ml-auto"
                        >
                            <ExclamationTriangleIcon className="h-4 w-4" />
                            Terminate Investment
                        </button>
                    )}
                </div>
            ) : null}

            {/* Operating Budget — dedicated expenses/inflows/tax for THIS
                investment, and the resulting running balance unspent */}
            <OperatingBudgetCard investment={investment} />

            {/* v1.80.0 — every ledger entry of this investment, by purpose */}
            <InvestmentLedger investment={investment} onChanged={loadInvestment} />

            {/* Bond Coupon Schedule — only for BOND-type investments */}
            {investment.investment_type === 'BOND' && (
                <BondScheduleCard
                    investment={investment}
                    canManage={canManage}
                    onPaid={loadInvestment}
                />
            )}

            {investment.investment_type === 'TREASURY_BILL' && (
                <TreasuryBillCard investment={investment} canManage={canManage} onDone={loadInvestment} />
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
                                    paddingAngle={2}
                                    dataKey="value">
                                    {budgetPieData.map((entry, index) => (
                                        <Cell key={index} fill={BUDGET_COLORS[index]}
                                            stroke={theme.cardStroke} strokeWidth={2} />
                                    ))}
                                </Pie>
                                <Tooltip
                                    {...theme.tooltipProps}
                                    formatter={(v) => [`${currency} ${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`]}
                                />
                                <Legend {...theme.legendProps} />
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
                                <CartesianGrid {...theme.gridProps} />
                                <XAxis dataKey="date" tick={{ fontSize: 11, ...theme.axisTick }}
                                    tickLine={false} />
                                <YAxis tick={{ fontSize: 11, ...theme.axisTick }} tickLine={false}
                                    axisLine={false}
                                    tickFormatter={compactNumber} />
                                <Tooltip
                                    {...theme.tooltipProps}
                                    formatter={(v, n, p) => [
                                        `${currency} ${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`,
                                        p.payload.type?.replace(/_/g, ' '),
                                    ]}
                                />
                                <Bar dataKey="amount" fill={theme.success} radius={[4, 4, 0, 0]} />
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
                            <CartesianGrid {...theme.gridProps} horizontal={false} vertical />
                            <XAxis type="number" tick={{ fontSize: 11, ...theme.axisTick }}
                                tickFormatter={v => v.toLocaleString('en-US', { maximumFractionDigits: 2 })} />
                            <YAxis type="category" dataKey="name" tick={{ fontSize: 11, ...theme.axisTick }}
                                width={110} />
                            <Tooltip
                                {...theme.tooltipProps}
                                formatter={(v) => [`${currency} ${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`]}
                            />
                            <Legend {...theme.legendProps} />
                            <Bar dataKey="Budget" fill={theme.primary} fillOpacity={0.35} radius={[0, 4, 4, 0]} />
                            <Bar dataKey="Spent" fill={theme.danger} radius={[0, 4, 4, 0]} />
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
                                <div key={i} className={`flex items-center justify-between
                                    py-2 border-b border-gray-100 last:border-0 ${r.is_reversed ? 'opacity-60' : ''}`}>
                                    <div className="flex items-center gap-3">
                                        <div className="p-2 rounded-lg bg-green-50
                                            text-green-600">
                                            <ArrowTrendingUpIcon className="h-4 w-4" />
                                        </div>
                                        <div>
                                            <p className="text-sm font-medium text-gray-900">
                                                {r.return_type.replace(/_/g, ' ')}
                                                {r.is_reversed && (
                                                    <span className="ml-1.5 text-xs badge-gray"
                                                        title={`Reversed ${formatDate(r.reversed_at)} — no longer counted in Returns`}>
                                                        Reversed
                                                    </span>
                                                )}
                                            </p>
                                            <p className="text-xs text-gray-400">
                                                {r.return_reference} •{' '}
                                                {formatDate(r.return_date)}
                                            </p>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-3">
                                        <p className={`text-sm font-semibold text-green-600 ${r.is_reversed ? 'line-through' : ''}`}>
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
            <RequestTerminationModal
                isOpen={showTerminateModal}
                onClose={() => setShowTerminateModal(false)}
                onSuccess={loadInvestment}
                investment={investment}
            />
            <ApproveTerminationModal
                isOpen={showApproveTermModal}
                onClose={() => setShowApproveTermModal(false)}
                onSuccess={loadInvestment}
                investment={investment}
            />
            <RejectTerminationModal
                isOpen={showRejectTermModal}
                onClose={() => setShowRejectTermModal(false)}
                onSuccess={loadInvestment}
                investment={investment}
            />
        </div>
    );
};

export default InvestmentDetailPage;
