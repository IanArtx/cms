// ============================================================
// INVESTMENTS PAGE
// Shows investment portfolio with projects and milestones.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { investmentsAPI, mmfAPI, accountsAPI, categoriesAPI } from '../../api/endpoints';
import { formatDate, getErrorMessage } from '../../utils/helpers';
import PageHeader from '../../components/common/PageHeader';
import DataTable from '../../components/common/DataTable';
import ErrorMessage from '../../components/common/ErrorMessage';
import StatusBadge from '../../components/common/StatusBadge';
import { useAuth } from '../../contexts/AuthContext';
import { useConfirm } from '../../contexts/ConfirmContext';
import { compactNumber, useChartTheme } from '../../hooks/useChartTheme';
import {
    PlusIcon, CheckIcon, PencilIcon, BanknotesIcon,
    ArrowTrendingUpIcon, TrophyIcon, ChartPieIcon,
} from '@heroicons/react/24/outline';

import {
    ResponsiveContainer, BarChart, Bar, PieChart, Pie, Cell,
    XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';

// Bonds are only ever bought in these standard terms — categorical,
// not a free-typed duration. Requested directly: "each bond
// identifies its running period categorically since this is how they
// are already categorised as such when buying them."
const BOND_TERMS = [2, 3, 5, 10, 15, 20, 25];

// ============================================================
// PORTFOLIO OVERVIEW (v1.57.0) — a casual, at-a-glance summary
// dropped above the formal Investments table: headline figures plus
// two charts (input vs return, and a status breakdown). Requested
// directly: "lets also have the investment page transformed to a
// more casual look on the first page. There should be a couple
// charts and important figures outlined on it." Both charts are
// fed by endpoints that already exist from the Shareholder Dashboard
// rework (investmentsAPI.getInputVsReturn) and a small new company-
// wide aggregate (investmentsAPI.getPortfolioSummary) — see
// investmentsController.getPortfolioSummary for why the headline
// figures are scoped to the Primary account's own currency.
// ============================================================
const OverviewTile = ({ title, value, subtitle, icon: Icon, color }) => {
    const colors = {
        blue:   'bg-gradient-to-br from-blue-500 to-indigo-600 text-white',
        green:  'bg-gradient-to-br from-emerald-500 to-teal-600 text-white',
        purple: 'bg-gradient-to-br from-purple-500 to-fuchsia-600 text-white',
        yellow: 'bg-gradient-to-br from-amber-400 to-orange-500 text-white',
    };
    return (
        <div className="card">
            <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-500">{title}</p>
                    <p className="mt-2 text-2xl font-bold text-gray-900 truncate">{value}</p>
                    {subtitle && <p className="mt-1 text-xs text-gray-400">{subtitle}</p>}
                </div>
                <div className={`p-3 rounded-xl shadow-sm flex-shrink-0 ${colors[color]}`}>
                    <Icon className="h-6 w-6" />
                </div>
            </div>
        </div>
    );
};

const STATUS_COLOR_KEYS = ['primary', 'success', 'warning', 'accent', 'danger', 'neutral'];

const PortfolioOverview = ({ summary, inputVsReturn }) => {
    const theme = useChartTheme();

    if (!summary) return null;

    const hasChartData = inputVsReturn && inputVsReturn.length > 0;
    const hasStatusData = summary.byStatus && summary.byStatus.length > 0;
    const currency = summary.currencyCode || '';

    return (
        <div className="mb-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                <OverviewTile
                    title="Total Invested"
                    value={`${currency} ${summary.totalActualExpenditure.toLocaleString('en-US', { maximumFractionDigits: 2 })}`}
                    subtitle={`Planned: ${currency} ${summary.totalPlannedBudget.toLocaleString('en-US', { maximumFractionDigits: 2 })}`}
                    icon={BanknotesIcon}
                    color="blue"
                />
                <OverviewTile
                    title="Total Returns"
                    value={`${currency} ${summary.totalReturns.toLocaleString('en-US', { maximumFractionDigits: 2 })}`}
                    subtitle="Across the whole portfolio"
                    icon={ArrowTrendingUpIcon}
                    color="green"
                />
                <OverviewTile
                    title="Overall ROI"
                    value={`${summary.overallRoiPercentage}%`}
                    subtitle={summary.overallRoiPercentage >= 0 ? 'In the green' : 'In the red'}
                    icon={TrophyIcon}
                    color={summary.overallRoiPercentage >= 0 ? 'green' : 'yellow'}
                />
                <OverviewTile
                    title="Active Investments"
                    value={summary.activeCount}
                    subtitle={`${summary.totalCount} total — ${summary.bondCount} bond${summary.bondCount === 1 ? '' : 's'}, ${summary.mmfCount || 0} MMF${summary.mmfCount === 1 ? '' : 's'}`}
                    icon={ChartPieIcon}
                    color="purple"
                />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="card lg:col-span-2">
                    <h3 className="section-title mb-4">Input vs Return</h3>
                    {hasChartData ? (
                        <ResponsiveContainer width="100%" height={240}>
                            <BarChart data={inputVsReturn}>
                                <CartesianGrid {...theme.gridProps} />
                                <XAxis dataKey="name" tick={{ fontSize: 10, ...theme.axisTick }} tickLine={false}
                                    interval={0} angle={-15} textAnchor="end" height={45} />
                                <YAxis tick={{ fontSize: 11, ...theme.axisTick }} tickLine={false} axisLine={false}
                                    tickFormatter={compactNumber} />
                                <Tooltip
                                    {...theme.tooltipProps}
                                    formatter={(v, name) => [parseFloat(v).toLocaleString('en-US', { maximumFractionDigits: 2 }), name]}
                                />
                                <Legend {...theme.legendProps} />
                                <Bar dataKey="invested" name="Invested" fill={theme.primary} radius={[6, 6, 0, 0]} />
                                <Bar dataKey="returned" name="Returned" fill={theme.success} radius={[4, 4, 0, 0]} />
                            </BarChart>
                        </ResponsiveContainer>
                    ) : (
                        <div className="flex items-center justify-center h-48 text-gray-300 text-sm">
                            Nothing funded yet
                        </div>
                    )}
                </div>

                <div className="card">
                    <h3 className="section-title mb-4">By Status</h3>
                    {hasStatusData ? (
                        <ResponsiveContainer width="100%" height={220}>
                            <PieChart>
                                <Pie data={summary.byStatus} cx="50%" cy="50%"
                                    innerRadius={45} outerRadius={75}
                                    paddingAngle={2} dataKey="count" nameKey="status">
                                    {summary.byStatus.map((entry, index) => (
                                        <Cell key={entry.status}
                                            fill={theme[STATUS_COLOR_KEYS[index % STATUS_COLOR_KEYS.length]]}
                                            stroke={theme.cardStroke} strokeWidth={2} />
                                    ))}
                                </Pie>
                                <Tooltip {...theme.tooltipProps} formatter={(v, n, p) => [v, p.payload.status]} />
                                <Legend {...theme.legendProps} formatter={(value, entry) => entry.payload.status} />
                            </PieChart>
                        </ResponsiveContainer>
                    ) : (
                        <div className="flex items-center justify-center h-48 text-gray-300 text-sm">
                            No investments yet
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

// ============================================================
// CREATE INVESTMENT MODAL (v1.60.0: unified with MMF)
// A single "Add Investment" flow now covers all three: Standard,
// Bond, and MMF — requested directly: "upon entry one selects when
// adding a new investment the option of MMF as it is for the bond and
// the required fields show up on entry." Standard/Bond still post to
// investmentsAPI (the investments table); MMF posts to mmfAPI
// (mmf_accounts) — the two keep their own genuinely different
// mechanics under the hood (light unification, per the confirmed
// answer to a clarifying question), this modal just gives them one
// shared entry point and type selector.
// ============================================================
const BLANK_FORM = {
    name: '', description: '', category_id: '',
    funding_account_id: '', planned_budget: '',
    start_date: '', expected_end_date: '',
    investment_type: 'STANDARD',
    face_value: '', coupon_rate: '', coupon_frequency: 'ANNUALLY',
    tax_withholding_rate: '', first_coupon_date: '', settlement_value: '',
    bond_term_years: '',
    // v1.70.0 — treasury bills
    tbill_tax_timing: 'AT_MATURITY',
    // MMF-only
    provider: '', initial_amount: '', entry_date: '',
};

const CreateInvestmentModal = ({
    isOpen, onClose, onSuccess, accounts, categories, editingRecord,
    canCreateInvestment, canCreateMmf,
}) => {
    const [form, setForm] = useState(BLANK_FORM);
    const [loading, setLoading] = useState(false);
    const [error,   setError]   = useState(null);
    const isEdit = !!editingRecord;

    useEffect(() => {
        if (editingRecord) {
            setForm({
                ...BLANK_FORM,
                name: editingRecord.name || '',
                description: editingRecord.description || '',
                category_id: editingRecord.category_id || '',
                funding_account_id: editingRecord.funding_account_id || '',
                planned_budget: editingRecord.planned_budget || '',
                start_date: editingRecord.start_date ? editingRecord.start_date.slice(0, 10) : '',
                expected_end_date: editingRecord.expected_end_date ? editingRecord.expected_end_date.slice(0, 10) : '',
                investment_type: editingRecord.investment_type || 'STANDARD',
                face_value: editingRecord.face_value || '',
                coupon_rate: editingRecord.coupon_rate || '',
                coupon_frequency: editingRecord.coupon_frequency || 'ANNUALLY',
                tax_withholding_rate: editingRecord.tax_withholding_rate || '',
                first_coupon_date: editingRecord.first_coupon_date ? editingRecord.first_coupon_date.slice(0, 10) : '',
                settlement_value: editingRecord.settlement_value || '',
                bond_term_years: editingRecord.bond_term_years || '',
                tbill_tax_timing: editingRecord.tbill_tax_timing || 'AT_MATURITY',
            });
        } else {
            // Default to whichever type this user can actually create —
            // a role holding only MMF_MANAGE (not INVESTMENT_CREATE), or
            // vice versa, should land on a type they can submit.
            setForm({ ...BLANK_FORM, investment_type: canCreateInvestment ? 'STANDARD' : 'MMF' });
        }
    }, [editingRecord, isOpen, canCreateInvestment]);

    if (!isOpen) return null;

    const isBond = form.investment_type === 'BOND';
    const isMmf  = form.investment_type === 'MMF';
    const isTbill = form.investment_type === 'TREASURY_BILL';
    const tbillDiscount = isTbill && form.face_value && form.settlement_value
        ? parseFloat(form.face_value) - parseFloat(form.settlement_value) : null;
    const tbillTax = tbillDiscount !== null ? tbillDiscount * (parseFloat(form.tax_withholding_rate || 20) / 100) : null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            if (isMmf) {
                const payload = {
                    parent_account_id: form.funding_account_id,
                    name: form.name,
                    provider: form.provider || undefined,
                    description: form.description || undefined,
                };
                if (form.initial_amount) {
                    payload.initial_amount = parseFloat(form.initial_amount);
                    payload.category_id = form.category_id;
                    payload.entry_date = form.entry_date;
                }
                await mmfAPI.create(payload);
            } else {
                const payload = {
                    name: form.name,
                    description: form.description || undefined,
                    category_id: form.category_id,
                    funding_account_id: form.funding_account_id,
                    planned_budget: parseFloat(form.planned_budget),
                    start_date: form.start_date || undefined,
                    expected_end_date: form.expected_end_date || undefined,
                    investment_type: form.investment_type,
                };
                if (isBond) {
                    payload.face_value = parseFloat(form.face_value);
                    payload.coupon_rate = parseFloat(form.coupon_rate);
                    payload.coupon_frequency = form.coupon_frequency;
                    payload.tax_withholding_rate = form.tax_withholding_rate
                        ? parseFloat(form.tax_withholding_rate) : 0;
                    payload.first_coupon_date = form.first_coupon_date || null;
                    payload.settlement_value = form.settlement_value
                        ? parseFloat(form.settlement_value) : null;
                    // v1.60.0 — only send a term when one's actually picked.
                    // A legacy bond the migration couldn't confidently match
                    // starts this field blank (BLANK_FORM's '' preserved via
                    // editingRecord.bond_term_years || ''); unconditionally
                    // sending parseInt('') here used to serialize as JSON
                    // null, which editInvestment reads as "clear the term,
                    // please validate the new (invalid) value" and rejected
                    // — blocking an edit to ANY other field on a term-less
                    // bond. Omitting the key on edit lets the backend keep
                    // whatever the bond already has (still NULL is fine —
                    // that's what the Set Bond Term banner is for). On
                    // create, a term is genuinely required, so still guard.
                    if (form.bond_term_years) {
                        payload.bond_term_years = parseInt(form.bond_term_years);
                    } else if (!isEdit) {
                        setError('Select a bond term.');
                        setLoading(false);
                        return;
                    }
                }
                if (isTbill) {
                    payload.face_value = parseFloat(form.face_value);
                    payload.settlement_value = parseFloat(form.settlement_value);
                    if (form.tax_withholding_rate !== '') payload.tax_withholding_rate = parseFloat(form.tax_withholding_rate);
                    payload.tbill_tax_timing = form.tbill_tax_timing;
                }
                if (isEdit) {
                    delete payload.investment_type;
                    await investmentsAPI.update(editingRecord.id, payload);
                } else {
                    await investmentsAPI.create(payload);
                }
            }
            onSuccess();
            onClose();
            setForm(BLANK_FORM);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    // Standard/Bond can only be funded from a secondary operational
    // account; an MMF can be attached to Primary or Secondary.
    const fundingAccounts = isMmf
        ? accounts.filter(a => a.account_type === 'PRIMARY' || a.account_type === 'SECONDARY')
        : accounts.filter(a => a.account_type === 'SECONDARY');
    const investmentCategories = categories.filter(c => c.module === 'INVESTMENT');
    const mmfFundNow = !!form.initial_amount;

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            <div className="fixed inset-0 bg-black bg-opacity-40" onClick={onClose} />
            <div className="flex min-h-full items-center justify-center p-4">
                <div className="relative bg-white rounded-xl shadow-xl
                    max-w-lg w-full p-6">
                    <h2 className="text-lg font-semibold text-gray-900 mb-4">
                        {isEdit ? 'Edit Investment' : isMmf ? 'New Money Market Fund Sub-Account' : 'Create Investment'}
                    </h2>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">Investment Name *</label>
                            <input type="text" className="input" value={form.name}
                                onChange={e => setForm(p => ({
                                    ...p, name: e.target.value }))}
                                required />
                        </div>
                        <div>
                            <label className="label">Investment Type *</label>
                            <div className="flex gap-2">
                                {canCreateInvestment && (
                                    <button type="button" disabled={isEdit}
                                        onClick={() => setForm(p => ({ ...p, investment_type: 'STANDARD' }))}
                                        className={`flex-1 px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${
                                            form.investment_type === 'STANDARD'
                                                ? 'border-primary-600 bg-primary-50 text-primary-700'
                                                : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                                        } ${isEdit ? 'opacity-60 cursor-not-allowed' : ''}`}>
                                        Standard
                                    </button>
                                )}
                                {canCreateInvestment && (
                                    <button type="button" disabled={isEdit}
                                        onClick={() => setForm(p => ({ ...p, investment_type: 'BOND' }))}
                                        className={`flex-1 px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${
                                            isBond
                                                ? 'border-primary-600 bg-primary-50 text-primary-700'
                                                : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                                        } ${isEdit ? 'opacity-60 cursor-not-allowed' : ''}`}>
                                        Bond
                                    </button>
                                )}
                                {canCreateInvestment && (
                                    <button type="button" disabled={isEdit}
                                        onClick={() => setForm(p => ({ ...p, investment_type: 'TREASURY_BILL', tax_withholding_rate: p.tax_withholding_rate || '20' }))}
                                        className={`flex-1 px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${
                                            isTbill
                                                ? 'border-primary-600 bg-primary-50 text-primary-700'
                                                : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                                        } ${isEdit ? 'opacity-60 cursor-not-allowed' : ''}`}>
                                        T-Bill
                                    </button>
                                )}
                                {canCreateMmf && (
                                    <button type="button" disabled={isEdit}
                                        onClick={() => setForm(p => ({ ...p, investment_type: 'MMF' }))}
                                        className={`flex-1 px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${
                                            isMmf
                                                ? 'border-primary-600 bg-primary-50 text-primary-700'
                                                : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                                        } ${isEdit ? 'opacity-60 cursor-not-allowed' : ''}`}>
                                        MMF
                                    </button>
                                )}
                            </div>
                            {isEdit && (
                                <p className="text-xs text-gray-400 mt-1">
                                    Investment type can't be changed once created.
                                </p>
                            )}
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="label">{isMmf ? 'Parent Account *' : 'Funding Account *'}</label>
                                <select className="input" value={form.funding_account_id}
                                    onChange={e => setForm(p => ({
                                        ...p, funding_account_id: e.target.value }))}
                                    required>
                                    <option value="">Select account...</option>
                                    {fundingAccounts.map(a => (
                                        <option key={a.id} value={a.id}>
                                            {isMmf ? `${a.name} (${a.account_type})` : a.name}
                                        </option>
                                    ))}
                                </select>
                                {isMmf && (
                                    <p className="text-xs text-gray-400 mt-1">
                                        Money placed in this MMF is drawn out of this account and
                                        stops counting toward its spendable balance.
                                    </p>
                                )}
                            </div>
                            {!isMmf && (
                                <div>
                                    <label className="label">Category *</label>
                                    <select className="input" value={form.category_id}
                                        onChange={e => setForm(p => ({
                                            ...p, category_id: e.target.value }))}
                                        required>
                                        <option value="">Select category...</option>
                                        {investmentCategories.map(c => (
                                            <option key={c.id} value={c.id}>
                                                {c.full_path || c.name}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            )}
                        </div>
                        {isMmf && (
                            <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 space-y-4">
                                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                                    Fund Now (optional)
                                </p>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                    <div>
                                        <label className="label">Provider</label>
                                        <input type="text" className="input" value={form.provider}
                                            onChange={e => setForm(p => ({ ...p, provider: e.target.value }))}
                                            placeholder="e.g. Stanbic Bank Uganda" />
                                    </div>
                                    <div>
                                        <label className="label">Initial Amount</label>
                                        <input type="number" className="input"
                                            value={form.initial_amount}
                                            onChange={e => setForm(p => ({ ...p, initial_amount: e.target.value }))}
                                            min="0.01" step="0.01"
                                            placeholder="Leave blank to create empty, fund later" />
                                    </div>
                                </div>
                                {mmfFundNow && (
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                        <div>
                                            <label className="label">Category *</label>
                                            <select className="input" value={form.category_id}
                                                onChange={e => setForm(p => ({ ...p, category_id: e.target.value }))}
                                                required={mmfFundNow}>
                                                <option value="">Select category...</option>
                                                {investmentCategories.map(c => (
                                                    <option key={c.id} value={c.id}>{c.full_path || c.name}</option>
                                                ))}
                                            </select>
                                        </div>
                                        <div>
                                            <label className="label">Date *</label>
                                            <input type="date" className="input"
                                                value={form.entry_date}
                                                max={new Date().toISOString().slice(0, 10)}
                                                onChange={e => setForm(p => ({ ...p, entry_date: e.target.value }))}
                                                required={mmfFundNow} />
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                        {!isMmf && (
                            <div>
                                <label className="label">Planned Budget *</label>
                                <input type="number" className="input"
                                    value={form.planned_budget}
                                    onChange={e => setForm(p => ({
                                        ...p, planned_budget: e.target.value }))}
                                    min="0.01" step="0.01" required />
                            </div>
                        )}
                        {!isMmf && (
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <div>
                                    <label className="label">{isBond ? 'Issue Date *' : isTbill ? 'Purchase Date *' : 'Start Date'}</label>
                                    <input type="date" className="input"
                                        value={form.start_date}
                                        onChange={e => setForm(p => ({
                                            ...p, start_date: e.target.value }))}
                                        required={isBond || isTbill} />
                                </div>
                                <div>
                                    <label className="label">{isBond || isTbill ? 'Maturity Date *' : 'Expected End Date'}</label>
                                    <input type="date" className="input"
                                        value={form.expected_end_date}
                                        onChange={e => setForm(p => ({
                                            ...p, expected_end_date: e.target.value }))}
                                        required={isBond || isTbill} />
                                </div>
                            </div>
                        )}
                        {isTbill && (
                            <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 space-y-4">
                                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                                    Treasury Bill Details
                                </p>
                                <p className="text-xs text-gray-500">
                                    A treasury bill is bought below its face value and repaid at face value on the maturity date.
                                    The difference (the discount) is interest income, taxed at source as FINAL tax (20% for bills).
                                </p>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                    <div>
                                        <label className="label">Face Value (repaid at maturity) *</label>
                                        <input type="number" className="input" value={form.face_value}
                                            onChange={e => setForm(p => ({ ...p, face_value: e.target.value }))}
                                            min="0.01" step="0.01" required />
                                    </div>
                                    <div>
                                        <label className="label">Price Paid (before tax) *</label>
                                        <input type="number" className="input" value={form.settlement_value}
                                            onChange={e => setForm(p => ({ ...p, settlement_value: e.target.value }))}
                                            min="0.01" step="0.01" required />
                                    </div>
                                    <div>
                                        <label className="label">Tax Rate on the Discount (%)</label>
                                        <input type="number" className="input" value={form.tax_withholding_rate}
                                            onChange={e => setForm(p => ({ ...p, tax_withholding_rate: e.target.value }))}
                                            min="0" max="100" step="0.01" placeholder="20" />
                                    </div>
                                    <div>
                                        <label className="label">When is the tax taken?</label>
                                        <select className="input" value={form.tbill_tax_timing}
                                            onChange={e => setForm(p => ({ ...p, tbill_tax_timing: e.target.value }))}>
                                            <option value="AT_MATURITY">Deducted from the maturity proceeds</option>
                                            <option value="AT_PURCHASE">Paid with the purchase price</option>
                                        </select>
                                    </div>
                                </div>
                                {tbillDiscount !== null && tbillDiscount > 0 && (
                                    <p className="text-xs text-gray-600 bg-white rounded p-2">
                                        Discount (interest income): <strong>{tbillDiscount.toLocaleString('en-US', { maximumFractionDigits: 2 })}</strong> ·
                                        tax on it: <strong>{tbillTax.toLocaleString('en-US', { maximumFractionDigits: 2 })}</strong> ·
                                        {form.tbill_tax_timing === 'AT_PURCHASE'
                                            ? ` paid at purchase: ${(parseFloat(form.settlement_value) + tbillTax).toLocaleString('en-US', { maximumFractionDigits: 2 })}, received at maturity: ${parseFloat(form.face_value).toLocaleString('en-US')}`
                                            : ` paid at purchase: ${parseFloat(form.settlement_value).toLocaleString('en-US')}, received at maturity: ${(parseFloat(form.face_value) - tbillTax).toLocaleString('en-US', { maximumFractionDigits: 2 })}`}.
                                        The purchase is funded automatically when the bill is approved.
                                    </p>
                                )}
                            </div>
                        )}
                        {isBond && (
                            <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 space-y-4">
                                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                                    Bond Details
                                </p>
                                <div>
                                    <label className="label">Bond Term *</label>
                                    <div className="flex flex-wrap gap-2">
                                        {BOND_TERMS.map(t => (
                                            <button key={t} type="button"
                                                onClick={() => setForm(p => ({ ...p, bond_term_years: t }))}
                                                className={`px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors ${
                                                    parseInt(form.bond_term_years) === t
                                                        ? 'border-primary-600 bg-primary-50 text-primary-700'
                                                        : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                                                }`}>
                                                {t}yr
                                            </button>
                                        ))}
                                    </div>
                                    <p className="text-xs text-gray-400 mt-1">
                                        How this bond is categorised when bought — the company can buy
                                        several instances of the same term over time; each stays its own
                                        investment, but the term groups them for reporting.
                                    </p>
                                </div>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                    <div>
                                        <label className="label">Face Value *</label>
                                        <input type="number" className="input"
                                            value={form.face_value}
                                            onChange={e => setForm(p => ({
                                                ...p, face_value: e.target.value }))}
                                            min="0.01" step="0.01" required={isBond} />
                                    </div>
                                    <div>
                                        <label className="label">Annual Interest Rate (%) *</label>
                                        <input type="number" className="input"
                                            value={form.coupon_rate}
                                            onChange={e => setForm(p => ({
                                                ...p, coupon_rate: e.target.value }))}
                                            min="0" step="0.01" required={isBond} />
                                    </div>
                                </div>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                    <div>
                                        <label className="label">Coupon Frequency *</label>
                                        <select className="input" value={form.coupon_frequency}
                                            onChange={e => setForm(p => ({
                                                ...p, coupon_frequency: e.target.value }))}
                                            required={isBond}>
                                            <option value="MONTHLY">Monthly</option>
                                            <option value="QUARTERLY">Quarterly</option>
                                            <option value="SEMI_ANNUALLY">Semi-Annually</option>
                                            <option value="ANNUALLY">Annually</option>
                                            <option value="AT_MATURITY">Single payment at maturity</option>
                                        </select>
                                    </div>
                                    <div>
                                        <label className="label">Withholding Tax Rate (%)</label>
                                        <input type="number" className="input"
                                            value={form.tax_withholding_rate}
                                            onChange={e => setForm(p => ({
                                                ...p, tax_withholding_rate: e.target.value }))}
                                            min="0" max="100" step="0.01"
                                            placeholder="e.g. 15" />
                                    </div>
                                </div>
                                <div>
                                    <label className="label">First Coupon Date</label>
                                    <input type="date" className="input"
                                        value={form.first_coupon_date}
                                        onChange={e => setForm(p => ({
                                            ...p, first_coupon_date: e.target.value }))} />
                                    <p className="text-xs text-gray-400 mt-1">
                                        Only needed if this bond was already running when the
                                        company bought it — set this to the next coupon date the
                                        issuer already has scheduled, so the payment schedule lines
                                        up correctly. Leave blank for a bond bought at issuance. Can
                                        also be set or corrected later from the investment's own page.
                                    </p>
                                </div>
                                <div>
                                    <label className="label">Settlement Value (optional)</label>
                                    <input type="number" className="input"
                                        value={form.settlement_value}
                                        onChange={e => setForm(p => ({
                                            ...p, settlement_value: e.target.value }))}
                                        min="0.01" step="0.01"
                                        placeholder={`Leave blank if bought at par (100% of face value)`} />
                                    <p className="text-xs text-gray-400 mt-1">
                                        The actual price paid for this bond, if different from its face value
                                        (bought at a discount or premium). Coupon payments always stay
                                        calculated on the full face value — this is shown as a % on the
                                        investment's page purely for reference.
                                    </p>
                                </div>
                                <p className="text-xs text-gray-500">
                                    A full coupon (interest) payment schedule is generated automatically
                                    from these details once the investment is created — you'll see it
                                    on the investment's detail page.
                                </p>
                            </div>
                        )}
                        <div>
                            <label className="label">Description</label>
                            <textarea className="input" rows={2}
                                value={form.description}
                                onChange={e => setForm(p => ({
                                    ...p, description: e.target.value }))} />
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose}
                                className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading}
                                className="btn-primary">
                                {loading
                                    ? 'Saving...'
                                    : isEdit
                                        ? 'Save Changes'
                                        : isMmf ? 'Create MMF Sub-Account' : 'Create Investment'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// MAIN INVESTMENTS PAGE (v1.60.0: unified with MMF)
// Standard investments, Bonds, and MMF sub-accounts now share one
// list, one portfolio summary, and one "Add Investment" entry point —
// requested directly: "I would like the MMF and investments... now I
// realize that I can treat them the same and track them together.
// This means that the stats shall also be treated as one category not
// two." MMF keeps its own table/permissions/detail page under the
// hood (light unification); this page just merges the two lists
// client-side (both endpoints already return everything needed) and
// renders them as one.
// ============================================================
const InvestmentsPage = () => {
    const { hasPermission, user } = useAuth();
    const [rows,        setRows]        = useState([]);
    const [accounts,    setAccounts]    = useState([]);
    const [categories,  setCategories]  = useState([]);
    const [portfolioSummary, setPortfolioSummary] = useState(null);
    const [inputVsReturn,    setInputVsReturn]    = useState([]);
    const [loading,     setLoading]     = useState(true);
    const [error,       setError]       = useState(null);
    const [showCreate,  setShowCreate]  = useState(false);
    const [editingRecord, setEditingRecord] = useState(null);
    const [actionLoading, setActionLoading] = useState(null);

    const canViewInvestments = hasPermission('INVESTMENT_VIEW');
    const canViewMmf         = hasPermission('MMF_VIEW');
    const canCreateInvestment = hasPermission('INVESTMENT_CREATE');
    const canCreateMmf        = hasPermission('MMF_MANAGE');

    const canEdit = (row) =>
        row.kind !== 'MMF' && row.status === 'PENDING' &&
        (row.created_by === user?.id || hasPermission('INVESTMENT_APPROVE'));

    const openEditModal = async (row) => {
        try {
            const res = await investmentsAPI.getById(row.id);
            setEditingRecord(res.data.data);
            setShowCreate(true);
        } catch (err) {
            setError(getErrorMessage(err));
        }
    };

    const closeModal = () => {
        setShowCreate(false);
        setEditingRecord(null);
    };

    // Merges investments (Standard + Bond) and MMF sub-accounts into
    // one client-side list — both endpoints already return everything
    // this page needs, so no backend change was needed just to show
    // them together. Each source is only fetched if the viewer holds
    // its own view permission, same "don't spend a request on a
    // guaranteed 403" discipline used elsewhere in this system.
    const loadAll = useCallback(async () => {
        try {
            setLoading(true);
            const [invRes, mmfRes] = await Promise.all([
                canViewInvestments ? investmentsAPI.getAll({ limit: 200 }) : Promise.resolve({ data: { data: [] } }),
                canViewMmf         ? mmfAPI.getAll({ limit: 200 })         : Promise.resolve({ data: { data: [] } }),
            ]);
            const invRows = (invRes.data.data || []).map(r => ({
                ...r, kind: r.investment_type === 'BOND' ? 'BOND' : r.investment_type === 'TREASURY_BILL' ? 'TREASURY_BILL' : 'STANDARD',
            }));
            const mmfRows = (mmfRes.data.data || []).map(r => ({ ...r, kind: 'MMF' }));
            const merged = [...invRows, ...mmfRows].sort(
                (a, b) => new Date(b.created_at) - new Date(a.created_at)
            );
            setRows(merged);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, [canViewInvestments, canViewMmf]);

    useEffect(() => {
        loadAll();
        accountsAPI.getAll().then(r => setAccounts(r.data.data)).catch(() => {});
        categoriesAPI.getAll({ flat: true }).then(r => setCategories(r.data.data)).catch(() => {});
    }, [loadAll]);

    // v1.57.0 — Portfolio Overview data (headline figures + the two
    // charts), unified with MMF as of v1.60.0. Independent of the list
    // load above, and of each other, so a failure in one never blocks
    // the rest of the page.
    useEffect(() => {
        investmentsAPI.getPortfolioSummary()
            .then(res => setPortfolioSummary(res.data.data))
            .catch(() => {});
        investmentsAPI.getInputVsReturn()
            .then(res => setInputVsReturn(res.data.data || []))
            .catch(() => {});
    }, []);

    const handleApprove = async (id) => {
        setActionLoading(id);
        try {
            await investmentsAPI.approve(id);
            loadAll();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setActionLoading(null);
        }
    };

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
            header: 'Investment',
            render: row => (
                <div>
                    <div className="flex items-center gap-2 flex-wrap">
                        <Link
                            to={row.kind === 'MMF' ? `/mmf/${row.id}` : `/investments/${row.id}`}
                            className="text-sm font-medium text-primary-700
                                hover:text-primary-800 hover:underline"
                        >
                            {row.name}
                        </Link>
                        {row.kind === 'BOND' && (
                            <span className="badge-blue text-[10px] px-1.5 py-0.5">
                                {row.bond_term_years ? `Bond ${row.bond_term_years}yr` : 'Bond'}
                            </span>
                        )}
                        {row.kind === 'BOND' && !row.bond_term_years && (
                            <span className="badge-yellow text-[10px] px-1.5 py-0.5">No Term</span>
                        )}
                        {row.kind === 'MMF' && (
                            <span className="badge-purple text-[10px] px-1.5 py-0.5">MMF</span>
                        )}
                        {row.kind === 'TREASURY_BILL' && (
                            <span className="badge-blue text-[10px] px-1.5 py-0.5">T-Bill</span>
                        )}
                    </div>
                    <p className="text-xs text-gray-400">
                        {row.kind === 'MMF'
                            ? [row.provider, row.parent_account_name].filter(Boolean).join(' • ')
                            : row.funding_account}
                    </p>
                </div>
            ),
        },
        {
            header: 'Invested',
            render: row => (
                <div>
                    <span className="text-sm font-semibold text-gray-900">
                        {row.currency_code}{' '}
                        {parseFloat(row.kind === 'MMF' ? row.total_principal_in : row.actual_expenditure)
                            .toLocaleString('en-US', { maximumFractionDigits: 2 })}
                    </span>
                    <p className="text-xs text-gray-400">
                        {row.kind === 'MMF'
                            ? `Balance: ${parseFloat(row.current_balance).toLocaleString('en-US', { maximumFractionDigits: 2 })}`
                            : `Planned: ${parseFloat(row.planned_budget).toLocaleString('en-US', { maximumFractionDigits: 2 })}`}
                    </p>
                </div>
            ),
        },
        {
            header: 'Returns',
            render: row => (
                <span className="text-sm text-green-600 font-medium">
                    {row.currency_code}{' '}
                    {parseFloat(row.kind === 'MMF'
                        ? (row.total_interest - row.total_management_fees)
                        : row.total_returns
                    ).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                </span>
            ),
        },
        {
            header: 'ROI',
            render: row => (
                <span className={`text-sm font-semibold ${
                    parseFloat(row.roi_percentage) >= 0
                        ? 'text-green-600' : 'text-red-600'
                }`}>
                    {row.roi_percentage}%
                </span>
            ),
        },
        {
            header: 'Timeline',
            render: row => (
                <div>
                    <p className="text-xs text-gray-500">
                        {row.kind === 'MMF' ? formatDate(row.opened_date) : formatDate(row.start_date)} —
                    </p>
                    <p className="text-xs text-gray-500">
                        {row.kind === 'MMF'
                            ? (row.closed_date ? formatDate(row.closed_date) : 'Ongoing')
                            : formatDate(row.expected_end_date)}
                    </p>
                </div>
            ),
        },
        {
            header: 'Status',
            render: row => <StatusBadge status={row.status} />,
        },
        {
            header: 'Actions',
            render: row => (
                <div className="flex gap-2">
                    {canEdit(row) && (
                        <button
                            onClick={() => openEditModal(row)}
                            className="p-1.5 rounded-lg bg-blue-50 text-blue-600
                                hover:bg-blue-100 transition-colors"
                            title="Edit"
                        >
                            <PencilIcon className="h-4 w-4" />
                        </button>
                    )}
                    {row.kind !== 'MMF' && row.status === 'PENDING' && hasPermission('INVESTMENT_APPROVE') && (
                        <button
                            onClick={() => handleApprove(row.id)}
                            disabled={actionLoading === row.id}
                            className="p-1.5 rounded-lg bg-green-50 text-green-600
                                hover:bg-green-100 transition-colors"
                            title="Approve"
                        >
                            <CheckIcon className="h-4 w-4" />
                        </button>
                    )}
                </div>
            ),
        },
    ];

    return (
        <div>
            <PageHeader
                title="Investments"
                subtitle="Investments, Bonds and Money Market Funds — one portfolio"
                actions={
                    (canCreateInvestment || canCreateMmf) && (
                        <button
                            onClick={() => { setEditingRecord(null); setShowCreate(true); }}
                            className="btn-primary flex items-center gap-2"
                        >
                            <PlusIcon className="h-4 w-4" />
                            New Investment
                        </button>
                    )
                }
            />

            {error && (
                <div className="mb-4">
                    <ErrorMessage message={error} onDismiss={() => setError(null)} />
                </div>
            )}

            <PortfolioOverview summary={portfolioSummary} inputVsReturn={inputVsReturn} />

            <DataTable
                columns={columns}
                data={rows}
                loading={loading}
                emptyMessage="No investments found"
                searchable
                searchPlaceholder="Search investments, bonds and MMFs..."
            />

            <CreateInvestmentModal
                isOpen={showCreate}
                onClose={closeModal}
                onSuccess={loadAll}
                accounts={accounts}
                categories={categories}
                editingRecord={editingRecord}
                canCreateInvestment={canCreateInvestment}
                canCreateMmf={canCreateMmf}
            />
        </div>
    );
};

export default InvestmentsPage;