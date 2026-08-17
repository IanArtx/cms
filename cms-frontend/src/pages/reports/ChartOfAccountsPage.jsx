// ============================================================
// CHART OF ACCOUNTS PAGE
// A live, as-of-right-now snapshot of every money pool in the
// system: Accounts, Side Fund, Loans (received & given),
// Investments, Money Market Funds, and Grants. v1.28.0, Section 4.32.
//
// Figures are shown grouped by currency within each section (never
// summed across currencies), since different pools can each be
// denominated in a different currency.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { reportsAPI } from '../../api/endpoints';
import { formatDate } from '../../utils/helpers';
import PageHeader from '../../components/common/PageHeader';
import LoadingSpinner from '../../components/common/LoadingSpinner';
import ErrorMessage from '../../components/common/ErrorMessage';
import {
    BuildingLibraryIcon,
    WalletIcon,
    CreditCardIcon,
    ChartBarIcon,
    CircleStackIcon,
    GiftIcon,
    ArrowPathIcon,
} from '@heroicons/react/24/outline';

const fmt = (n) => parseFloat(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });

// ============================================================
// SECTION SHELL — consistent header (icon, title, subtitle) for
// every Chart of Accounts section
// ============================================================
const Section = ({ icon: Icon, title, subtitle, children }) => (
    <div className="card mb-6">
        <div className="flex items-center gap-2 mb-1">
            <Icon className="h-5 w-5 text-primary-600" />
            <h3 className="section-title mb-0">{title}</h3>
        </div>
        {subtitle && <p className="text-xs text-gray-400 mb-4">{subtitle}</p>}
        <div className={subtitle ? '' : 'mt-4'}>{children}</div>
    </div>
);

// ============================================================
// CURRENCY GROUP STAT ROW — a grid of labelled figures for one
// currency's worth of a section (loans / investments / mmf / grants)
// ============================================================
const CurrencyStatRow = ({ code, symbol, count, stats }) => (
    <div className="border-b border-gray-100 last:border-0 py-4 first:pt-0 last:pb-0">
        <div className="flex items-center justify-between mb-3">
            <span className="badge-blue text-xs">{code}</span>
            <span className="text-xs text-gray-400">{count} record{count === 1 ? '' : 's'}</span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {stats.map(s => (
                <div key={s.label}>
                    <p className="text-gray-400 text-xs">{s.label}</p>
                    <p className={`text-sm font-semibold mt-0.5 ${s.tone || 'text-gray-900'}`}>
                        {symbol || code} {fmt(s.value)}
                    </p>
                </div>
            ))}
        </div>
    </div>
);

const EmptySection = ({ text }) => (
    <p className="text-sm text-gray-400 text-center py-6">{text}</p>
);

// ============================================================
// MAIN CHART OF ACCOUNTS PAGE
// ============================================================
const ChartOfAccountsPage = () => {
    const [data,    setData]    = useState(null);
    const [loading, setLoading] = useState(true);
    const [error,   setError]   = useState(null);

    const loadData = useCallback(async () => {
        try {
            setLoading(true);
            const res = await reportsAPI.getChartOfAccounts();
            setData(res.data.data);
            setError(null);
        } catch (err) {
            setError(err.response?.data?.message || 'Failed to load Chart of Accounts');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { loadData(); }, [loadData]);

    if (loading) {
        return <LoadingSpinner fullPage text="Loading Chart of Accounts..." />;
    }

    if (error || !data) {
        return (
            <div>
                <PageHeader title="Chart of Accounts" showBack backTo="/reports" />
                <ErrorMessage message={error || 'Could not load Chart of Accounts'} />
            </div>
        );
    }

    const accounts = data.accounts || [];
    const primaryAndSecondary = accounts.filter(a => a.account_type !== 'SAVINGS');
    const savings = accounts.filter(a => a.account_type === 'SAVINGS');

    return (
        <div>
            <PageHeader
                title="Chart of Accounts"
                subtitle="Live snapshot of every money pool in the system"
                showBack backTo="/reports"
                actions={
                    <button onClick={loadData} className="btn-secondary flex items-center gap-2">
                        <ArrowPathIcon className="h-4 w-4" />
                        Refresh
                    </button>
                }
            />

            <p className="text-xs text-gray-400 mb-4">
                As of {new Date(data.generated_at).toLocaleString()}
            </p>

            {/* Accounts */}
            <Section icon={BuildingLibraryIcon} title="Accounts"
                subtitle="Primary, Secondary and Savings accounts and their current spendable balances">
                {accounts.length === 0 ? (
                    <EmptySection text="No active accounts" />
                ) : (
                    <div className="overflow-x-auto -mx-2">
                        <table className="min-w-full text-sm">
                            <thead>
                                <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                                    <th className="px-2 py-2 font-medium">Account</th>
                                    <th className="px-2 py-2 font-medium">Type</th>
                                    <th className="px-2 py-2 font-medium text-right">Current Balance</th>
                                </tr>
                            </thead>
                            <tbody>
                                {[...primaryAndSecondary, ...savings].map(a => (
                                    <tr key={a.id} className="border-b border-gray-50 last:border-0">
                                        <td className="px-2 py-2 text-gray-900 font-medium">{a.name}</td>
                                        <td className="px-2 py-2">
                                            <span className="badge-gray text-xs">{a.account_type}</span>
                                        </td>
                                        <td className="px-2 py-2 text-right font-semibold text-gray-900">
                                            {a.currency_symbol || a.currency_code} {fmt(a.current_balance)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </Section>

            {/* Side Fund */}
            <Section icon={WalletIcon} title="Side Fund"
                subtitle="Company-wide member welfare pool">
                {!data.side_fund ? (
                    <EmptySection text="Side Fund is not currently active" />
                ) : (
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                        <div>
                            <p className="text-gray-400 text-xs">Current Pool Balance</p>
                            <p className="text-sm font-semibold text-gray-900 mt-0.5">
                                {data.side_fund.currency_symbol || data.side_fund.currency_code}{' '}
                                {fmt(data.side_fund.current_balance)}
                            </p>
                        </div>
                        <div>
                            <p className="text-gray-400 text-xs">Monthly Due (per member)</p>
                            <p className="text-sm font-semibold text-gray-900 mt-0.5">
                                {data.side_fund.currency_symbol || data.side_fund.currency_code}{' '}
                                {fmt(data.side_fund.monthly_amount)}
                            </p>
                        </div>
                        <div>
                            <p className="text-gray-400 text-xs">Held Within</p>
                            <p className="text-sm font-semibold text-gray-900 mt-0.5">
                                {data.side_fund.parent_account_name || '—'}
                            </p>
                        </div>
                    </div>
                )}
            </Section>

            {/* Loans */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
                <div className="card">
                    <div className="flex items-center gap-2 mb-1">
                        <CreditCardIcon className="h-5 w-5 text-red-500" />
                        <h3 className="section-title mb-0">Loans Received</h3>
                    </div>
                    <p className="text-xs text-gray-400 mb-4">
                        Money the company owes — still outstanding
                    </p>
                    {(data.loans_received || []).length === 0 ? (
                        <EmptySection text="No outstanding loans received" />
                    ) : data.loans_received.map(row => (
                        <CurrencyStatRow key={row.currency_code}
                            code={row.currency_code} symbol={row.currency_symbol}
                            count={parseInt(row.count)}
                            stats={[
                                { label: 'Outstanding Principal', value: row.outstanding_principal, tone: 'text-red-600' },
                                { label: 'Outstanding Interest',  value: row.outstanding_interest,  tone: 'text-red-600' },
                                { label: 'Total Owed', value: parseFloat(row.outstanding_principal) + parseFloat(row.outstanding_interest), tone: 'text-red-700 font-bold' },
                            ]}
                        />
                    ))}
                </div>

                <div className="card">
                    <div className="flex items-center gap-2 mb-1">
                        <CreditCardIcon className="h-5 w-5 text-green-500" />
                        <h3 className="section-title mb-0">Loans Given</h3>
                    </div>
                    <p className="text-xs text-gray-400 mb-4">
                        Money owed to the company — still outstanding
                    </p>
                    {(data.loans_given || []).length === 0 ? (
                        <EmptySection text="No outstanding loans given" />
                    ) : data.loans_given.map(row => (
                        <CurrencyStatRow key={row.currency_code}
                            code={row.currency_code} symbol={row.currency_symbol}
                            count={parseInt(row.count)}
                            stats={[
                                { label: 'Outstanding Principal', value: row.outstanding_principal, tone: 'text-green-600' },
                                { label: 'Outstanding Interest',  value: row.outstanding_interest,  tone: 'text-green-600' },
                                { label: 'Total Expected', value: parseFloat(row.outstanding_principal) + parseFloat(row.outstanding_interest), tone: 'text-green-700 font-bold' },
                            ]}
                        />
                    ))}
                </div>
            </div>

            {/* Investments & MMF */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
                <div className="card">
                    <div className="flex items-center gap-2 mb-1">
                        <ChartBarIcon className="h-5 w-5 text-primary-600" />
                        <h3 className="section-title mb-0">
                            <Link to="/investments" className="hover:underline">Investments</Link>
                        </h3>
                    </div>
                    <p className="text-xs text-gray-400 mb-4">Active and on-hold investments</p>
                    {(data.investments || []).length === 0 ? (
                        <EmptySection text="No active investments" />
                    ) : data.investments.map(row => (
                        <CurrencyStatRow key={row.currency_code}
                            code={row.currency_code} symbol={row.currency_symbol}
                            count={parseInt(row.count)}
                            stats={[
                                { label: 'Planned Budget', value: row.planned_budget },
                                { label: 'Spent', value: row.actual_expenditure, tone: 'text-red-600' },
                                { label: 'Returns', value: row.total_returns, tone: 'text-green-600' },
                            ]}
                        />
                    ))}
                </div>

                <div className="card">
                    <div className="flex items-center gap-2 mb-1">
                        <CircleStackIcon className="h-5 w-5 text-primary-600" />
                        <h3 className="section-title mb-0">
                            <Link to="/mmf" className="hover:underline">Money Market Funds</Link>
                        </h3>
                    </div>
                    <p className="text-xs text-gray-400 mb-4">Active MMF sub-accounts</p>
                    {(data.mmf || []).length === 0 ? (
                        <EmptySection text="No active MMF sub-accounts" />
                    ) : data.mmf.map(row => (
                        <CurrencyStatRow key={row.currency_code}
                            code={row.currency_code} symbol={row.currency_symbol}
                            count={parseInt(row.count)}
                            stats={[
                                { label: 'Current Balance', value: row.current_balance, tone: 'font-bold text-primary-700' },
                                { label: 'Principal In', value: row.total_principal_in },
                                { label: 'Interest Earned', value: row.total_interest, tone: 'text-green-600' },
                                { label: 'Management Fees', value: row.total_management_fees, tone: 'text-red-600' },
                            ]}
                        />
                    ))}
                </div>
            </div>

            {/* Grants */}
            <Section icon={GiftIcon} title="Grants"
                subtitle="Active and partially-received grants — amount still expected">
                {(data.grants || []).length === 0 ? (
                    <EmptySection text="No active grants" />
                ) : data.grants.map(row => (
                    <CurrencyStatRow key={row.currency_code}
                        code={row.currency_code} symbol={row.currency_symbol}
                        count={parseInt(row.count)}
                        stats={[
                            { label: 'Total Amount', value: row.total_amount },
                            { label: 'Received', value: row.amount_received, tone: 'text-green-600' },
                            { label: 'Remaining', value: row.amount_remaining, tone: 'text-amber-600' },
                        ]}
                    />
                ))}
            </Section>
        </div>
    );
};

export default ChartOfAccountsPage;
