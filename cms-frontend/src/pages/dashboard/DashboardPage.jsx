// ============================================================
// DASHBOARD PAGE
// Main dashboard showing company financial overview.
// Automatically shows ShareholderDashboard for shareholder-only users.
// ============================================================

import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { accountsAPI, eventsAPI, transactionsAPI, investmentsAPI } from '../../api/endpoints';
import { formatDate, getErrorMessage } from '../../utils/helpers';
import LoadingSpinner from '../../components/common/LoadingSpinner';
import StatusBadge from '../../components/common/StatusBadge';
import PageHeader from '../../components/common/PageHeader';
import ShareholderDashboard from './ShareholderDashboard';
import {
    BanknotesIcon,
    ArrowsRightLeftIcon,
    ChartBarIcon,
    CalendarDaysIcon,
    ArrowUpIcon,
    ArrowDownIcon,
    TrophyIcon,
} from '@heroicons/react/24/outline';

// ============================================================
// BEST/WORST PERFORMING INVESTMENT CARD
// Shown to every user, regardless of full investment access —
// just the name and ROI%, nothing about budgets or balances.
// ============================================================
const PerformanceCard = ({ performance }) => {
    if (!performance || performance.count === 0) return null;

    const { best, worst } = performance;
    const showBoth = worst && worst.id !== best.id;

    const Row = ({ label, inv, tone }) => (
        <div className="flex items-center justify-between py-2">
            <div className="flex items-center gap-2 min-w-0">
                <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                    tone === 'good' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
                }`}>
                    {label}
                </span>
                <p className="text-sm text-gray-900 truncate">{inv.name}</p>
            </div>
            <p className={`text-sm font-bold flex-shrink-0 ml-3 ${
                parseFloat(inv.roi_percentage) >= 0 ? 'text-green-600' : 'text-red-600'
            }`}>
                {inv.roi_percentage}%
            </p>
        </div>
    );

    return (
        <div className="card mt-4">
            <div className="flex items-center gap-2 mb-2">
                <TrophyIcon className="h-4 w-4 text-yellow-500" />
                <h2 className="section-title mb-0">Investment Performance</h2>
            </div>
            <div className="divide-y divide-gray-100">
                <Row label="Best" inv={best} tone="good" />
                {showBoth && <Row label="Worst" inv={worst} tone="bad" />}
            </div>
        </div>
    );
};

// ============================================================
// STAT CARD COMPONENT
// If `to` is given, the whole card is a link to that section.
// ============================================================
const StatCard = ({ title, value, subtitle, icon: Icon, color = 'blue', to = null }) => {
    const colors = {
        blue:   'bg-blue-50 text-blue-700',
        green:  'bg-green-50 text-green-700',
        yellow: 'bg-yellow-50 text-yellow-700',
        red:    'bg-red-50 text-red-700',
    };

    const content = (
        <div className="flex items-start justify-between">
            <div className="flex-1">
                <p className="text-sm font-medium text-gray-500">{title}</p>
                <p className="mt-2 text-2xl font-bold text-gray-900">{value}</p>
                {subtitle && (
                    <p className="mt-1 text-xs text-gray-400">{subtitle}</p>
                )}
            </div>
            <div className={`p-3 rounded-xl ${colors[color]}`}>
                <Icon className="h-6 w-6" />
            </div>
        </div>
    );

    if (to) {
        return (
            <Link
                to={to}
                className="card block hover:shadow-md hover:-translate-y-0.5
                    transition-all duration-150"
            >
                {content}
            </Link>
        );
    }

    return <div className="card">{content}</div>;
};

// ============================================================
// DASHBOARD PAGE
// ============================================================
const DashboardPage = () => {
    const { user, hasPermission } = useAuth();
    const navigate = useNavigate();

    const [accounts,     setAccounts]     = useState([]);
    const [events,       setEvents]       = useState([]);
    const [transactions, setTransactions] = useState([]);
    const [investments,  setInvestments]  = useState([]);
    const [performance,  setPerformance]  = useState(null);
    const [loading,      setLoading]      = useState(true);

    // Determine if user is shareholder-only
    const roles = Array.isArray(user?.roles)
        ? user.roles.map(r => typeof r === 'object' ? r.name : r)
        : [];
    const isShareholderOnly = roles.length > 0 &&
        roles.every(r => r === 'Shareholder');

    useEffect(() => {
        const loadDashboard = async () => {
            try {
                const promises = [
                    accountsAPI.getSummary(),
                    eventsAPI.getUpcoming(30),
                    investmentsAPI.getPerformanceSummary(),
                ];

                if (hasPermission('FINANCE_VIEW_ALL')) {
                    promises.push(transactionsAPI.getAll({ limit: 5 }));
                    promises.push(investmentsAPI.getAll({ status: 'ACTIVE', limit: 5 }));
                }

                const results = await Promise.allSettled(promises);

                if (results[0].status === 'fulfilled') {
                    setAccounts(results[0].value.data.data || []);
                }
                if (results[1].status === 'fulfilled') {
                    setEvents(results[1].value.data.data || []);
                }
                if (results[2]?.status === 'fulfilled') {
                    setPerformance(results[2].value.data.data || null);
                }
                if (results[3]?.status === 'fulfilled') {
                    setTransactions(results[3].value.data.data || []);
                }
                if (results[4]?.status === 'fulfilled') {
                    setInvestments(results[4].value.data.data || []);
                }
            } catch (err) {
                console.error('Dashboard load error:', err);
            } finally {
                setLoading(false);
            }
        };

        loadDashboard();
    }, [hasPermission]);

    if (loading) {
        return <LoadingSpinner fullPage text="Loading dashboard..." />;
    }

    // Show shareholder dashboard for shareholder-only users
    if (isShareholderOnly) {
        return <ShareholderDashboard />;
    }

    const primaryAccount    = accounts.find(a => a.account_type === 'PRIMARY');
    const secondaryAccounts = accounts.filter(a => a.account_type === 'SECONDARY');
    const savingsAccount    = accounts.find(a => a.account_type === 'SAVINGS');
    // Side fund allocation is excluded from each account's "current_balance"
    // above (display-only split, v1.14.0) and shown separately here, summed
    // across accounts in case that ever changes which account holds it.
    const sideFundTotal = accounts.reduce(
        (sum, a) => sum + parseFloat(a.side_fund_allocation || 0), 0
    );

    return (
        <div>
            <PageHeader
                title={`Welcome back, ${user?.first_name}`}
                subtitle={`${new Date().toLocaleDateString('en-GB', {
                    weekday: 'long', year: 'numeric',
                    month: 'long', day: 'numeric'
                })}`}
            />

            {/* Account Summary Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3
                xl:grid-cols-4 gap-4 mb-6">

                {/* Primary Account */}
                {primaryAccount && (
                    <StatCard
                        title="Primary Account Balance"
                        value={`${primaryAccount.currency_code} ${parseFloat(
                            primaryAccount.current_balance
                        ).toLocaleString('en-US', { maximumFractionDigits: 2 })}`}
                        subtitle={`Available: ${primaryAccount.currency_code} ${parseFloat(
                            primaryAccount.available_balance
                        ).toLocaleString('en-US', { maximumFractionDigits: 2 })}`}
                        icon={BanknotesIcon}
                        color="blue"
                        to="/accounts"
                    />
                )}

                {/* Secondary Accounts */}
                {secondaryAccounts.map(account => (
                    <StatCard
                        key={account.id}
                        title={account.name}
                        value={`${account.currency_code} ${parseFloat(
                            account.current_balance
                        ).toLocaleString('en-US', { maximumFractionDigits: 2 })}`}
                        icon={BanknotesIcon}
                        color="green"
                        to="/accounts"
                    />
                ))}

                {/* Savings Account */}
                {savingsAccount && (
                    <StatCard
                        title="Savings Pool"
                        value={`${savingsAccount.currency_code} ${parseFloat(
                            savingsAccount.current_balance
                        ).toLocaleString('en-US', { maximumFractionDigits: 2 })}`}
                        subtitle="All member savings"
                        icon={BanknotesIcon}
                        color="yellow"
                        to="/savings"
                    />
                )}

                {/* Side Fund — shown separately from whichever account holds it */}
                {sideFundTotal > 0 && (
                    <StatCard
                        title="Side Fund Balance"
                        value={sideFundTotal.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                        subtitle="Held inside another account"
                        icon={BanknotesIcon}
                        color="blue"
                        to="/side-fund"
                    />
                )}

                {/* Active Investments */}
                {hasPermission('INVESTMENT_VIEW') && (
                    <StatCard
                        title="Active Investments"
                        value={investments.length}
                        subtitle="Currently active"
                        icon={ChartBarIcon}
                        color="yellow"
                        to="/investments"
                    />
                )}

                {/* Upcoming Events */}
                <StatCard
                    title="Upcoming Events"
                    value={events.length}
                    subtitle="Next 30 days"
                    icon={CalendarDaysIcon}
                    color="blue"
                    to="/events"
                />
            </div>

            {/* Main Content Grid */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

                {/* Recent Transactions */}
                {hasPermission('FINANCE_VIEW_ALL') && (
                    <div className="lg:col-span-2">
                        <div className="card">
                            <div className="flex items-center justify-between mb-4">
                                <h2 className="section-title">Recent Transactions</h2>
                                <button
                                    onClick={() => navigate('/transactions')}
                                    className="text-sm text-primary-600
                                        hover:text-primary-700 font-medium"
                                >
                                    View all
                                </button>
                            </div>

                            {transactions.length === 0 ? (
                                <p className="text-sm text-gray-400 text-center py-8">
                                    No transactions recorded yet
                                </p>
                            ) : (
                                <div className="space-y-3">
                                    {transactions.map((tx, i) => (
                                        <div key={i} className="flex items-center
                                            justify-between py-2 border-b
                                            border-gray-100 last:border-0">
                                            <div className="flex-1 min-w-0">
                                                <p className="text-sm font-medium
                                                    text-gray-900 truncate">
                                                    {tx.description}
                                                </p>
                                                <p className="text-xs text-gray-400">
                                                    {tx.reference_code} •{' '}
                                                    {formatDate(tx.value_date)}
                                                </p>
                                            </div>
                                            <div className="ml-4 text-right flex-shrink-0">
                                                <p className={`text-sm font-semibold
                                                    ${tx.transaction_type === 'CREDIT' ||
                                                      tx.transaction_type === 'REVERSAL_CREDIT'
                                                        ? 'text-green-600'
                                                        : 'text-red-600'
                                                    }`}>
                                                    {tx.transaction_type === 'CREDIT' ||
                                                     tx.transaction_type === 'REVERSAL_CREDIT'
                                                        ? '+' : '-'}
                                                    {tx.currency_code}{' '}
                                                    {parseFloat(tx.amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                                                </p>
                                                <p className="text-xs text-gray-400">
                                                    {tx.account_name}
                                                </p>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* Upcoming Events */}
                <div className={hasPermission('FINANCE_VIEW_ALL') ? '' : 'lg:col-span-3'}>
                    <div className="card">
                        <div className="flex items-center justify-between mb-4">
                            <h2 className="section-title">Upcoming Events</h2>
                            <button
                                onClick={() => navigate('/events')}
                                className="text-sm text-primary-600
                                    hover:text-primary-700 font-medium"
                            >
                                View all
                            </button>
                        </div>

                        {events.length === 0 ? (
                            <p className="text-sm text-gray-400 text-center py-8">
                                No upcoming events in the next 30 days
                            </p>
                        ) : (
                            <div className="space-y-3">
                                {events.map((event, i) => (
                                    <div key={i} className="flex items-start gap-3
                                        py-2 border-b border-gray-100 last:border-0">
                                        <div className="flex-shrink-0 w-10 h-10
                                            bg-primary-50 rounded-lg flex flex-col
                                            items-center justify-center">
                                            <span className="text-xs font-bold
                                                text-primary-700">
                                                {new Date(event.event_date).getDate()}
                                            </span>
                                            <span className="text-xs text-primary-500">
                                                {new Date(event.event_date)
                                                    .toLocaleString('en-GB', {
                                                        month: 'short'
                                                    })}
                                            </span>
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm font-medium
                                                text-gray-900 truncate">
                                                {event.title}
                                            </p>
                                            <p className="text-xs text-gray-400">
                                                {event.event_type}
                                                {event.location &&
                                                    ` • ${event.location}`}
                                            </p>
                                            <p className="text-xs text-primary-500 mt-0.5">
                                                in {event.days_until_event} days
                                            </p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Best/Worst Performing Investment — visible to everyone */}
                    <PerformanceCard performance={performance} />

                    {/* Active Investments Summary */}
                    {hasPermission('INVESTMENT_VIEW') && investments.length > 0 && (
                        <div className="card mt-4">
                            <div className="flex items-center justify-between mb-4">
                                <h2 className="section-title">Active Investments</h2>
                                <button
                                    onClick={() => navigate('/investments')}
                                    className="text-sm text-primary-600
                                        hover:text-primary-700 font-medium"
                                >
                                    View all
                                </button>
                            </div>
                            <div className="space-y-3">
                                {investments.slice(0, 3).map((inv, i) => (
                                    <div key={i} className="flex items-center
                                        justify-between py-2 border-b border-gray-100
                                        last:border-0">
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm font-medium
                                                text-gray-900 truncate">
                                                {inv.name}
                                            </p>
                                            <p className="text-xs text-gray-400">
                                                {inv.currency_code}{' '}
                                                {parseFloat(inv.actual_expenditure)
                                                    .toLocaleString('en-US', { maximumFractionDigits: 2 })} spent
                                            </p>
                                        </div>
                                        <StatusBadge status={inv.status} />
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default DashboardPage;