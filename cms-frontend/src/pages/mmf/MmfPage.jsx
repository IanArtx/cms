// ============================================================
// MONEY MARKET FUNDS (MMF) PAGE
// Lists every MMF sub-account company-wide, with a "New MMF"
// action that both registers the sub-account and (optionally)
// funds it with an initial amount in one step. v1.28.0, Section 4.31.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { mmfAPI, accountsAPI, categoriesAPI } from '../../api/endpoints';
import { getErrorMessage } from '../../utils/helpers';
import PageHeader from '../../components/common/PageHeader';
import DataTable from '../../components/common/DataTable';
import ErrorMessage from '../../components/common/ErrorMessage';
import StatusBadge from '../../components/common/StatusBadge';
import { useAuth } from '../../contexts/AuthContext';
import { PlusIcon } from '@heroicons/react/24/outline';

// ============================================================
// CREATE MMF MODAL
// ============================================================
const BLANK_FORM = {
    parent_account_id: '', name: '', provider: '', description: '',
    initial_amount: '', category_id: '', entry_date: '',
};

const CreateMmfModal = ({ isOpen, onClose, onSuccess, accounts, categories }) => {
    const [form, setForm] = useState(BLANK_FORM);
    const [loading, setLoading] = useState(false);
    const [error,   setError]   = useState(null);

    if (!isOpen) return null;

    const fundNow = !!form.initial_amount;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            const payload = {
                parent_account_id: form.parent_account_id,
                name: form.name,
                provider: form.provider || undefined,
                description: form.description || undefined,
            };
            if (fundNow) {
                payload.initial_amount = parseFloat(form.initial_amount);
                payload.category_id = form.category_id;
                payload.entry_date = form.entry_date;
            }
            await mmfAPI.create(payload);
            onSuccess();
            onClose();
            setForm(BLANK_FORM);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    // An MMF can be attached to a Primary or Secondary account
    const eligibleAccounts = accounts.filter(a =>
        a.account_type === 'PRIMARY' || a.account_type === 'SECONDARY');
    const mmfCategories = categories.filter(c => c.module === 'INVESTMENT');

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            <div className="fixed inset-0 bg-black bg-opacity-40" onClick={onClose} />
            <div className="flex min-h-full items-center justify-center p-4">
                <div className="relative bg-white rounded-xl shadow-xl max-w-lg w-full p-6">
                    <h2 className="text-lg font-semibold text-gray-900 mb-4">
                        New Money Market Fund Sub-Account
                    </h2>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">Parent Account *</label>
                            <select className="input" value={form.parent_account_id}
                                onChange={e => setForm(p => ({
                                    ...p, parent_account_id: e.target.value }))}
                                required>
                                <option value="">Select account...</option>
                                {eligibleAccounts.map(a => (
                                    <option key={a.id} value={a.id}>
                                        {a.name} ({a.account_type})
                                    </option>
                                ))}
                            </select>
                            <p className="text-xs text-gray-400 mt-1">
                                Money placed in this MMF is drawn out of this account and
                                stops counting toward its spendable balance.
                            </p>
                        </div>
                        <div>
                            <label className="label">MMF Name *</label>
                            <input type="text" className="input" value={form.name}
                                onChange={e => setForm(p => ({
                                    ...p, name: e.target.value }))}
                                placeholder="e.g. Stanbic MMF" required />
                        </div>
                        <div>
                            <label className="label">Provider</label>
                            <input type="text" className="input" value={form.provider}
                                onChange={e => setForm(p => ({
                                    ...p, provider: e.target.value }))}
                                placeholder="e.g. Stanbic Bank Uganda" />
                        </div>
                        <div>
                            <label className="label">Description</label>
                            <textarea className="input" rows={2}
                                value={form.description}
                                onChange={e => setForm(p => ({
                                    ...p, description: e.target.value }))} />
                        </div>

                        <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 space-y-4">
                            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                                Fund Now (optional)
                            </p>
                            <div>
                                <label className="label">Initial Amount</label>
                                <input type="number" className="input"
                                    value={form.initial_amount}
                                    onChange={e => setForm(p => ({
                                        ...p, initial_amount: e.target.value }))}
                                    min="0.01" step="0.01"
                                    placeholder="Leave blank to create empty, fund later" />
                            </div>
                            {fundNow && (
                                <>
                                    <div>
                                        <label className="label">Category *</label>
                                        <select className="input" value={form.category_id}
                                            onChange={e => setForm(p => ({
                                                ...p, category_id: e.target.value }))}
                                            required={fundNow}>
                                            <option value="">Select category...</option>
                                            {mmfCategories.map(c => (
                                                <option key={c.id} value={c.id}>
                                                    {c.full_path || c.name}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                    <div>
                                        <label className="label">Date *</label>
                                        <input type="date" className="input"
                                            value={form.entry_date}
                                            max={new Date().toISOString().slice(0, 10)}
                                            onChange={e => setForm(p => ({
                                                ...p, entry_date: e.target.value }))}
                                            required={fundNow} />
                                    </div>
                                </>
                            )}
                        </div>

                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose}
                                className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading}
                                className="btn-primary">
                                {loading ? 'Saving...' : 'Create MMF Sub-Account'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// MAIN MMF PAGE
// ============================================================
const MmfPage = () => {
    const { hasPermission } = useAuth();
    const [mmfAccounts, setMmfAccounts] = useState([]);
    const [accounts,    setAccounts]    = useState([]);
    const [categories,  setCategories]  = useState([]);
    const [pagination,  setPagination]  = useState(null);
    const [loading,     setLoading]     = useState(true);
    const [error,       setError]       = useState(null);
    const [page,        setPage]        = useState(1);
    const [showCreate,  setShowCreate]  = useState(false);

    const loadMmfAccounts = useCallback(async () => {
        try {
            setLoading(true);
            const res = await mmfAPI.getAll({ page, limit: 20 });
            setMmfAccounts(res.data.data);
            setPagination(res.data.meta?.pagination);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, [page]);

    useEffect(() => {
        loadMmfAccounts();
        accountsAPI.getAll().then(r => setAccounts(r.data.data)).catch(() => {});
        categoriesAPI.getAll({ flat: true }).then(r => setCategories(r.data.data)).catch(() => {});
    }, [loadMmfAccounts]);

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
            header: 'MMF',
            render: row => (
                <div>
                    <Link
                        to={`/mmf/${row.id}`}
                        className="text-sm font-medium text-primary-700
                            hover:text-primary-800 hover:underline"
                    >
                        {row.name}
                    </Link>
                    <p className="text-xs text-gray-400">
                        {row.provider || '—'} • {row.parent_account_name}
                    </p>
                </div>
            ),
        },
        {
            header: 'Current Balance',
            render: row => (
                <span className="text-sm font-semibold text-gray-900">
                    {row.currency_code}{' '}
                    {parseFloat(row.current_balance).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                </span>
            ),
        },
        {
            header: 'Principal In',
            render: row => (
                <span className="text-sm text-gray-600">
                    {row.currency_code}{' '}
                    {parseFloat(row.total_principal_in).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                </span>
            ),
        },
        {
            header: 'Interest Earned',
            render: row => (
                <span className="text-sm text-green-600 font-medium">
                    {row.currency_code}{' '}
                    {parseFloat(row.total_interest).toLocaleString('en-US', { maximumFractionDigits: 2 })}
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
            header: 'Status',
            render: row => <StatusBadge status={row.status} />,
        },
    ];

    return (
        <div>
            <PageHeader
                title="Money Market Funds"
                subtitle="MMF sub-accounts drawn out of Primary/Secondary accounts — daily interest, monthly accounting"
                actions={
                    hasPermission('MMF_MANAGE') && (
                        <button
                            onClick={() => setShowCreate(true)}
                            className="btn-primary flex items-center gap-2"
                        >
                            <PlusIcon className="h-4 w-4" />
                            New MMF
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
                data={mmfAccounts}
                loading={loading}
                emptyMessage="No MMF sub-accounts found"
                searchable
                searchPlaceholder="Search MMF sub-accounts..."
                pagination={pagination}
                onPageChange={setPage}
            />

            <CreateMmfModal
                isOpen={showCreate}
                onClose={() => setShowCreate(false)}
                onSuccess={loadMmfAccounts}
                accounts={accounts}
                categories={categories}
            />
        </div>
    );
};

export default MmfPage;
