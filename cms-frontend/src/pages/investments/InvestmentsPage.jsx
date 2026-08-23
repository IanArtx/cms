// ============================================================
// INVESTMENTS PAGE
// Shows investment portfolio with projects and milestones.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { investmentsAPI, accountsAPI, categoriesAPI } from '../../api/endpoints';
import { formatDate, getErrorMessage } from '../../utils/helpers';
import PageHeader from '../../components/common/PageHeader';
import DataTable from '../../components/common/DataTable';
import ErrorMessage from '../../components/common/ErrorMessage';
import StatusBadge from '../../components/common/StatusBadge';
import { useAuth } from '../../contexts/AuthContext';
import { PlusIcon, CheckIcon, PencilIcon } from '@heroicons/react/24/outline';

// ============================================================
// CREATE INVESTMENT MODAL
// ============================================================
const BLANK_FORM = {
    name: '', description: '', category_id: '',
    funding_account_id: '', planned_budget: '',
    start_date: '', expected_end_date: '',
    investment_type: 'STANDARD',
    face_value: '', coupon_rate: '', coupon_frequency: 'ANNUALLY',
    tax_withholding_rate: '', first_coupon_date: '', settlement_value: '',
};

const CreateInvestmentModal = ({ isOpen, onClose, onSuccess, accounts, categories, editingRecord }) => {
    const [form, setForm] = useState(BLANK_FORM);
    const [loading, setLoading] = useState(false);
    const [error,   setError]   = useState(null);
    const isEdit = !!editingRecord;

    useEffect(() => {
        if (editingRecord) {
            setForm({
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
            });
        } else {
            setForm(BLANK_FORM);
        }
    }, [editingRecord, isOpen]);

    if (!isOpen) return null;

    const isBond = form.investment_type === 'BOND';

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            const payload = {
                ...form,
                planned_budget: parseFloat(form.planned_budget),
            };
            if (isBond) {
                payload.face_value = parseFloat(form.face_value);
                payload.coupon_rate = parseFloat(form.coupon_rate);
                payload.tax_withholding_rate = form.tax_withholding_rate
                    ? parseFloat(form.tax_withholding_rate) : 0;
                payload.first_coupon_date = form.first_coupon_date || null;
                payload.settlement_value = form.settlement_value
                    ? parseFloat(form.settlement_value) : null;
            } else {
                delete payload.face_value;
                delete payload.coupon_rate;
                delete payload.coupon_frequency;
                delete payload.tax_withholding_rate;
                delete payload.first_coupon_date;
                delete payload.settlement_value;
            }
            if (isEdit) {
                delete payload.investment_type;
                await investmentsAPI.update(editingRecord.id, payload);
            } else {
                await investmentsAPI.create(payload);
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

    // Only secondary accounts can fund investments
    const secondaryAccounts = accounts.filter(a => a.account_type === 'SECONDARY');
    const investmentCategories = categories.filter(c => c.module === 'INVESTMENT');

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            <div className="fixed inset-0 bg-black bg-opacity-40" onClick={onClose} />
            <div className="flex min-h-full items-center justify-center p-4">
                <div className="relative bg-white rounded-xl shadow-xl
                    max-w-lg w-full p-6">
                    <h2 className="text-lg font-semibold text-gray-900 mb-4">
                        {isEdit ? 'Edit Investment' : 'Create Investment'}
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
                                <button type="button" disabled={isEdit}
                                    onClick={() => setForm(p => ({ ...p, investment_type: 'STANDARD' }))}
                                    className={`flex-1 px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${
                                        !isBond
                                            ? 'border-primary-600 bg-primary-50 text-primary-700'
                                            : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                                    } ${isEdit ? 'opacity-60 cursor-not-allowed' : ''}`}>
                                    Standard
                                </button>
                                <button type="button" disabled={isEdit}
                                    onClick={() => setForm(p => ({ ...p, investment_type: 'BOND' }))}
                                    className={`flex-1 px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${
                                        isBond
                                            ? 'border-primary-600 bg-primary-50 text-primary-700'
                                            : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                                    } ${isEdit ? 'opacity-60 cursor-not-allowed' : ''}`}>
                                    Bond
                                </button>
                            </div>
                            {isEdit && (
                                <p className="text-xs text-gray-400 mt-1">
                                    Investment type can't be changed once created.
                                </p>
                            )}
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="label">Funding Account *</label>
                                <select className="input" value={form.funding_account_id}
                                    onChange={e => setForm(p => ({
                                        ...p, funding_account_id: e.target.value }))}
                                    required>
                                    <option value="">Select account...</option>
                                    {secondaryAccounts.map(a => (
                                        <option key={a.id} value={a.id}>
                                            {a.name}
                                        </option>
                                    ))}
                                </select>
                            </div>
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
                        </div>
                        <div>
                            <label className="label">Planned Budget *</label>
                            <input type="number" className="input"
                                value={form.planned_budget}
                                onChange={e => setForm(p => ({
                                    ...p, planned_budget: e.target.value }))}
                                min="0.01" step="0.01" required />
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="label">{isBond ? 'Issue Date *' : 'Start Date'}</label>
                                <input type="date" className="input"
                                    value={form.start_date}
                                    onChange={e => setForm(p => ({
                                        ...p, start_date: e.target.value }))}
                                    required={isBond} />
                            </div>
                            <div>
                                <label className="label">{isBond ? 'Maturity Date *' : 'Expected End Date'}</label>
                                <input type="date" className="input"
                                    value={form.expected_end_date}
                                    onChange={e => setForm(p => ({
                                        ...p, expected_end_date: e.target.value }))}
                                    required={isBond} />
                            </div>
                        </div>
                        {isBond && (
                            <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 space-y-4">
                                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                                    Bond Details
                                </p>
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
                                {loading ? 'Saving...' : (isEdit ? 'Save Changes' : 'Create Investment')}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// MAIN INVESTMENTS PAGE
// ============================================================
const InvestmentsPage = () => {
    const { hasPermission, user } = useAuth();
    const [investments, setInvestments] = useState([]);
    const [accounts,    setAccounts]    = useState([]);
    const [categories,  setCategories]  = useState([]);
    const [pagination,  setPagination]  = useState(null);
    const [loading,     setLoading]     = useState(true);
    const [error,       setError]       = useState(null);
    const [page,        setPage]        = useState(1);
    const [showCreate,  setShowCreate]  = useState(false);
    const [editingRecord, setEditingRecord] = useState(null);
    const [actionLoading, setActionLoading] = useState(null);

    const canEdit = (row) =>
        row.status === 'PENDING' &&
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

    const loadInvestments = useCallback(async () => {
        try {
            setLoading(true);
            const res = await investmentsAPI.getAll({ page, limit: 20 });
            setInvestments(res.data.data);
            setPagination(res.data.meta?.pagination);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, [page]);

    useEffect(() => {
        loadInvestments();
        accountsAPI.getAll().then(r => setAccounts(r.data.data)).catch(() => {});
        categoriesAPI.getAll({ flat: true }).then(r => setCategories(r.data.data)).catch(() => {});
    }, [loadInvestments]);

    const handleApprove = async (id) => {
        setActionLoading(id);
        try {
            await investmentsAPI.approve(id);
            loadInvestments();
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
                    <div className="flex items-center gap-2">
                        <Link
                            to={`/investments/${row.id}`}
                            className="text-sm font-medium text-primary-700
                                hover:text-primary-800 hover:underline"
                        >
                            {row.name}
                        </Link>
                        {row.investment_type === 'BOND' && (
                            <span className="badge-blue text-[10px] px-1.5 py-0.5">Bond</span>
                        )}
                    </div>
                    <p className="text-xs text-gray-400">{row.funding_account}</p>
                </div>
            ),
        },
        {
            header: 'Budget',
            render: row => (
                <span className="text-sm font-semibold text-gray-900">
                    {row.currency_code}{' '}
                    {parseFloat(row.planned_budget).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                </span>
            ),
        },
        {
            header: 'Spent',
            render: row => (
                <span className="text-sm text-red-600 font-medium">
                    {row.currency_code}{' '}
                    {parseFloat(row.actual_expenditure).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                </span>
            ),
        },
        {
            header: 'Returns',
            render: row => (
                <span className="text-sm text-green-600 font-medium">
                    {row.currency_code}{' '}
                    {parseFloat(row.total_returns).toLocaleString('en-US', { maximumFractionDigits: 2 })}
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
            header: 'Projects',
            render: row => (
                <span className="text-sm text-gray-600">
                    {row.project_count}
                </span>
            ),
        },
        {
            header: 'Timeline',
            render: row => (
                <div>
                    <p className="text-xs text-gray-500">
                        {formatDate(row.start_date)} —
                    </p>
                    <p className="text-xs text-gray-500">
                        {formatDate(row.expected_end_date)}
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
                    {row.status === 'PENDING' && hasPermission('INVESTMENT_APPROVE') && (
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
                subtitle="Investment portfolio, projects and returns tracking"
                actions={
                    hasPermission('INVESTMENT_CREATE') && (
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

            <DataTable
                columns={columns}
                data={investments}
                loading={loading}
                emptyMessage="No investments found"
                searchable
                searchPlaceholder="Search investments..."
                pagination={pagination}
                onPageChange={setPage}
            />

            <CreateInvestmentModal
                isOpen={showCreate}
                onClose={closeModal}
                onSuccess={loadInvestments}
                accounts={accounts}
                categories={categories}
                editingRecord={editingRecord}
            />
        </div>
    );
};

export default InvestmentsPage;