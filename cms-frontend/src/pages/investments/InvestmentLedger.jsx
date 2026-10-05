// ============================================================
// INVESTMENT LEDGER (v1.80.0)
// Requested: "linking transactions of investments to them that can be
// accessed under the individual investments or the main transactions
// page … money used to buy or sustain or operate an investment is well
// categorised". Confirmed: buying / expanding = asset; running and
// maintenance = expenses; older entries are classified one by one.
//
// Every ledger entry of this investment — funding, expenses, returns,
// tax, requisitions paid for it and their reversals — with totals by
// purpose, the connected documents, and (Treasurer / Admin) a picker to
// classify an expense recorded before v1.80.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { investmentsAPI } from '../../api/endpoints';
import { formatDate, getErrorMessage } from '../../utils/helpers';
import { useAuth } from '../../contexts/AuthContext';
import { TransactionDetailModal, LinkCount } from '../../components/documents/TransactionDocuments';

const money = (n, code) => `${code ? `${code} ` : ''}${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const KIND = { FUNDING: 'Funding', EXPENSE: 'Expense', INFLOW: 'Inflow', TAX: 'Tax', RETURN: 'Return', OTHER: 'Entry' };
const COST = {
    CAPITAL: ['bg-indigo-50 text-indigo-700', 'Buying / expanding'],
    OPERATING: ['bg-teal-50 text-teal-700', 'Running'],
    MAINTENANCE: ['bg-amber-50 text-amber-700', 'Maintenance'],
};

export const CostTypeBadge = ({ value, missing = false }) => {
    if (!value) return missing ? <span className="text-[10px] font-semibold rounded-full px-1.5 py-0.5 bg-red-50 text-red-700">Not classified</span> : null;
    const [cls, label] = COST[value] || ['bg-gray-100 text-gray-600', value];
    return <span className={`text-[10px] font-semibold rounded-full px-1.5 py-0.5 ${cls}`}>{label}</span>;
};

const InvestmentLedger = ({ investment, onChanged = null }) => {
    const { hasRole } = useAuth();
    const canClassify = hasRole(['Treasurer', 'Admin']);
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(null);
    const [open, setOpen] = useState(null);
    const code = investment.currency_code;

    const load = useCallback(async () => {
        try {
            const r = await investmentsAPI.getLedger(investment.id);
            setData(r.data.data);
        } catch (err) { setError(getErrorMessage(err)); }
    }, [investment.id]);
    useEffect(() => { load(); }, [load]);

    const classify = async (t, costType) => {
        if (!costType) return;
        setBusy(t.id);
        setError(null);
        try {
            await investmentsAPI.classifyExpense(investment.id, { transaction_id: t.id, cost_type: costType });
            await load();
            if (onChanged) onChanged();
        } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(null); }
    };

    if (!data) return <div className="card mb-6"><p className="text-sm text-gray-400">{error || 'Loading the ledger…'}</p></div>;
    const t = data.totals;
    const tiles = [
        ['Buying / expanding', t.capital, 'Added to what the investment is worth (asset)'],
        ['Running costs', t.operating, 'Expense of the investment'],
        ['Maintenance & repairs', t.maintenance, 'Expense of the investment'],
        ['Returns received', t.returns, 'Money that came back'],
    ];

    return (
        <div className="card mb-6">
            <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
                <h3 className="section-title mb-0">All transactions of this investment</h3>
                <Link to={`/transactions?investment_id=${investment.id}`} className="text-sm text-primary-700 hover:underline">Open in Transactions</Link>
            </div>
            {error && <p className="text-sm text-red-700 bg-red-50 rounded px-3 py-2 mb-3">{error}</p>}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
                {tiles.map(([label, v, hint]) => (
                    <div key={label} className="rounded-lg bg-gray-50 px-3 py-2">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{label}</p>
                        <p className="text-base font-bold text-gray-900 tabular-nums">{money(v, code)}</p>
                        <p className="text-[11px] text-gray-400">{hint}</p>
                    </div>
                ))}
            </div>
            {t.unclassified > 0 && (
                <p className="text-xs text-amber-800 bg-amber-50 rounded px-3 py-2 mb-3">
                    {money(t.unclassified, code)} of expenses recorded before this update are <strong>not classified</strong> — they are still counted
                    as part of the investment's value (as before).{canClassify ? ' Choose what each one was for below; running and maintenance costs then move to the expenses of the investment, from their own dates.' : ' The Treasurer can classify them.'}
                </p>
            )}
            {!data.ready && <p className="text-xs text-gray-500 mb-3">Buying / running classification needs the v1.80.0 database update.</p>}
            <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                    <thead>
                        <tr className="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-gray-200">
                            <th className="py-2 pr-3">Date</th>
                            <th className="py-2 pr-3">Reference</th>
                            <th className="py-2 pr-3">What</th>
                            <th className="py-2 pr-3">Category</th>
                            <th className="py-2 pr-3 text-right">Amount</th>
                            <th className="py-2 pr-3">Docs</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                        {data.transactions.map(x => {
                            const out = x.transaction_type === 'DEBIT';
                            const isExpense = x.inflow_type === 'EXPENSE' && x.kind !== 'TAX';
                            return (
                                <tr key={x.id} className={x.is_reversal || x.is_reversed ? 'opacity-60' : ''}>
                                    <td className="py-2 pr-3 whitespace-nowrap">{formatDate(x.value_date)}</td>
                                    <td className="py-2 pr-3">
                                        <button type="button" className="font-mono text-xs text-primary-700 hover:underline" onClick={() => setOpen(x.id)}>{x.reference_code}</button>
                                        {x.requisition_reference && <span className="block text-[11px] text-gray-500">from {x.requisition_reference}</span>}
                                    </td>
                                    <td className="py-2 pr-3">
                                        <span className="text-gray-900">{KIND[x.kind] || x.kind}</span>{' '}
                                        {isExpense && <CostTypeBadge value={x.cost_type} missing={x.kind === 'EXPENSE'} />}
                                        {x.is_reversal && <span className="text-[11px] text-gray-500"> reversal</span>}
                                        {x.is_reversed && <span className="text-[11px] text-gray-500"> reversed</span>}
                                        <span className="block text-[11px] text-gray-500 truncate max-w-xs" title={x.description}>{x.description}</span>
                                        {canClassify && x.can_classify && !x.is_reversed && (
                                            <select className="input py-0.5 text-xs w-auto mt-1" value="" disabled={busy === x.id}
                                                onChange={e => classify(x, e.target.value)}>
                                                <option value="">{x.cost_type ? 'Change what it was for…' : 'Classify — what was it for?'}</option>
                                                <option value="OPERATING">Running costs (expense)</option>
                                                <option value="MAINTENANCE">Maintenance & repairs (expense)</option>
                                                <option value="CAPITAL">Buying / expanding (asset)</option>
                                            </select>
                                        )}
                                    </td>
                                    <td className="py-2 pr-3 text-xs text-gray-500">{x.category_trail || '—'}</td>
                                    <td className={`py-2 pr-3 text-right tabular-nums whitespace-nowrap ${out ? 'text-red-600' : 'text-green-700'}`}>{out ? '−' : '+'}{money(x.amount, x.currency_code)}</td>
                                    <td className="py-2 pr-3"><LinkCount count={x.document_count} title={`${x.document_count} document(s)`} onClick={() => setOpen(x.id)} /></td>
                                </tr>
                            );
                        })}
                        {data.transactions.length === 0 && (
                            <tr><td colSpan={6} className="py-4 text-center text-sm text-gray-400">No transactions yet.</td></tr>
                        )}
                    </tbody>
                </table>
            </div>
            {open && <TransactionDetailModal transactionId={open} onClose={() => setOpen(null)} onChanged={load} />}
        </div>
    );
};

export default InvestmentLedger;
