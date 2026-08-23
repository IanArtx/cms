// ============================================================
// DASHBOARD PAGE
// Main dashboard showing company financial overview.
// Automatically shows ShareholderDashboard for shareholder-only users.
// ============================================================

import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { accountsAPI, eventsAPI, transactionsAPI, investmentsAPI, capitalGoalsAPI } from '../../api/endpoints';
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
    FlagIcon,
} from '@heroicons/react/24/outline';

// ============================================================
// BEST/WORST PERFORMING INVESTMENT CARD
// Shown to every user, regardless of full investment access —
// just the name and ROI%, nothing about budgets or balances.
// ============================================================
const PerformanceCard = ({ performance }) => {
    if (!performance || performance.count === 0) return null;

    const { best, worst } = performance;
    // Compare both id AND investment_type — best/worst can now come from
    // either the investments table or the mmf_accounts table (v1.28.0
    // MMF/Investments ROI comparison), so two different records could
    // coincidentally share the same numeric id across those two tables.
    const showBoth = worst && (worst.id !== best.id || worst.investment_type !== best.investment_type);

    const Row = ({ label, inv, tone }) => (
        <div className="flex items-center justify-between py-2">
            <div className="flex items-center gap-2 min-w-0">
                <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                    tone === 'good' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
                }`}>
                    {label}
                </span>
                <p className="text-sm text-gray-900 truncate">{inv.name}</p>
                {inv.investment_type === 'MMF' && (
                    <span className="badge-blue text-[10px] px-1.5 py-0.5 flex-shrink-0">MMF</span>
                )}
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
// NEAREST ACTIVE CAPITAL GOAL CARD (v1.29.0)
// Shown to anyone who can view goals — the soonest-ending ACTIVE
// goal, with a progress bar and on-track/behind read, linking
// through to the full goal (and its expected-vs-actual chart).
// ============================================================
const CapitalGoalCard = ({ goal }) => {
    if (!goal) return null;

    const behind = goal.progress_status === 'BEHIND';

    return (
        <Link to={`/capital-goals/${goal.id}`} className="card mt-4 block hover:shadow-md transition-shadow">
            <div className="flex items-center gap-2 mb-2">
                <FlagIcon className="h-4 w-4 text-primary-600" />
                <h2 className="section-title mb-0">Capital Goal — {goal.title}</h2>
                <span className={`ml-auto text-xs font-semibold px-2 py-0.5 rounded-full ${
                    behind ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'
                }`}>
                    {goal.progress_status?.replace('_', ' ')}
                </span>
            </div>
            <div className="flex items-baseline justify-between mb-1">
                <p className="text-sm text-gray-500">
                    {goal.currency_code} {parseFloat(goal.total_collected).toLocaleString('en-US', { maximumFractionDigits: 0 })}
                    {' '}of{' '}
                    {goal.currency_code} {parseFloat(goal.target_amount).toLocaleString('en-US', { maximumFractionDigits: 0 })}
                </p>
                <p className="text-sm font-bold text-gray-900">{goal.percent_of_target}%</p>
            </div>
            <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
                <div className={`h-full rounded-full ${behind ? 'bg-red-500' : 'bg-green-500'}`}
                    style={{ width: `${Math.min(100, goal.percent_of_target)}%` }} />
            </div>
        </Link>
    );
};

// ============================================================
// STAT CARD COMPONENT
// If `to` is given, the whole card is a link to that section.
// ============================================================
const StatCard = ({ title, value, subtitle, icon: Icon, color = 'blue', to = null }) => {
    // Icon chip carries a small gradient rather than a flat tint — the
    // "colourful tile" treatment, kept to the chip so the card body
    // itself stays readable in both light and dark mode.
    const colors = {
        blue:   'bg-gradient-to-br from-blue-500 to-indigo-600 text-white',
        green:  'bg-gradient-to-br from-emerald-500 to-teal-600 text-white',
        yellow: 'bg-gradient-to-br from-amber-400 to-orange-500 text-white',
        red:    'bg-gradient-to-br from-rose-500 to-red-600 text-white',
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
            <div className={`p-3 rounded-xl shadow-sm ${colors[color]}`}>
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
    const { user, hasPermission, hasFinancialAccess } = useAuth();
    const navigate = useNavigate();
    // v1.36.0 — the "default financial role" check (Treasurer/Assistant
    // Treasurer/Shareholder/Director/Admin, or an explicit FINANCE_VIEW_ALL
    // grant). Everything showing a real account balance on this page is
    // gated behind this, matching the same rule now enforced server-side
    // on GET /accounts/summary — a Secretary/Assistant Secretary/
    // Coordinator/Administrative Officer holding only that role sees
    // Upcoming Events (and anything else already gated by its own specific
    // permission) and nothing with money figures in it.
    const canSeeFinance = hasFinancialAccess('FINANCE_VIEW_ALL');

    const [accounts,     setAccounts]     = useState([]);
    const [events,       setEvents]       = useState([]);
    const [transactions, setTransactions] = useState([]);
    const [investments,  setInvestments]  = useState([]);
    const [performance,  setPerformance]  = useState(null);
    const [capitalGoal,  setCapitalGoal]  = useState(null);
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
                // v1.36.0 — accounts/summary and investments/performance-
                // summary are now both backend-gated behind
                // requireFinancialAccess (see server-side changelog); only
                // fetch them at all if this user would actually get data
                // back, so a Secretary/Coordinator/etc. doesn't spend a
                // request just to hit a 403 for a card that won't render
                // anyway.
                const promises = [
                    canSeeFinance ? accountsAPI.getSummary() : Promise.resolve(null),
                    eventsAPI.getUpcoming(30),
                    hasFinancialAccess('INVESTMENT_VIEW') ? investmentsAPI.getPerformanceSummary() : Promise.resolve(null),
                ];

                if (hasPermission('FINANCE_VIEW_ALL')) {
                    promises.push(transactionsAPI.getAll({ limit: 5 }));
                    promises.push(investmentsAPI.getAll({ status: 'ACTIVE', limit: 5 }));
                }

                const results = await Promise.allSettled(promises);

                if (results[0].status === 'fulfilled' && results[0].value) {
                    setAccounts(results[0].value.data.data || []);
                }
                if (results[1].status === 'fulfilled') {
                    setEvents(results[1].value.data.data || []);
                }
                if (results[2]?.status === 'fulfilled' && results[2].value) {
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
    }, [hasPermission, hasFinancialAccess, canSeeFinance]);

    // Separate, independent fetch (not part of the Promise.allSettled
    // batch above, whose results are read by fixed array index) — the
    // soonest-ending ACTIVE capital goal, if the viewer can see goals
    // at all. Failing silently (no goals yet, or no permission) just
    // means the card doesn't render, same as every other optional
    // dashboard widget here.
    useEffect(() => {
        if (!hasPermission('CAPITAL_GOAL_VIEW')) return;
        capitalGoalsAPI.getAll({ status: 'ACTIVE', limit: 1 })
            .then(res => setCapitalGoal((res.data.data || [])[0] || null))
            .catch(() => {});
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

                {/* Account balance cards — v1.36.0: only for the default
                    financial roles (Treasurer/Assistant Treasurer/
                    Shareholder/Director/Admin) or an explicit
                    FINANCE_VIEW_ALL grant. Previously rendered
                    unconditionally to any signed-in member. */}
                {canSeeFinance && primaryAccount && (
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
                {canSeeFinance && secondaryAccounts.map(account => (
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
                {canSeeFinance && savingsAccount && (
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
                {canSeeFinance && sideFundTotal > 0 && (
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

                    {/* Best/Worst Performing Investment — v1.36.0: was
                        visible to everyone (name + ROI% only, no budget/
                        balance figures); narrowed to the same financial-
                        role default as the rest of this page, since the
                        backend's own /investments/performance-summary
                        is now gated the same way. */}
                    {hasFinancialAccess('INVESTMENT_VIEW') && (
                        <PerformanceCard performance={performance} />
                    )}

                    {/* Nearest active capital goal, if any (v1.29.0) */}
                    <CapitalGoalCard goal={capitalGoal} />

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