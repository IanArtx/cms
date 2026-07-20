// ============================================================
// SHAREHOLDER PERSONAL DASHBOARD
// Shows a shareholder's personal financial summary:
//   - Their own contributions
//   - Their shareholding percentage
//   - Company general overview (no other member's personal data)
// ============================================================

import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { reportsAPI, usersAPI, accountsAPI, eventsAPI, investmentsAPI, sharesAPI } from '../../api/endpoints';
import { formatDate, formatCurrency, getErrorMessage } from '../../utils/helpers';
import LoadingSpinner from '../../components/common/LoadingSpinner';
import ErrorMessage from '../../components/common/ErrorMessage';
import { useAuth } from '../../contexts/AuthContext';
import {
    BanknotesIcon,
    ChartPieIcon,
    CalendarDaysIcon,
    ArrowTrendingUpIcon,
    TrophyIcon,
} from '@heroicons/react/24/outline';

// ============================================================
// BEST/WORST PERFORMING INVESTMENT CARD
// Same lightweight summary shown on the staff dashboard — just
// name + ROI%, no budget figures — so every shareholder can see
// how the company's investments are doing at a glance.
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
        <div className="card">
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
// STAT CARD
// ============================================================
const StatCard = ({ title, value, subtitle, icon: Icon, color = 'blue', to = null }) => {
    const colors = {
        blue:   'bg-blue-50 text-blue-700',
        green:  'bg-green-50 text-green-700',
        purple: 'bg-purple-50 text-purple-700',
        yellow: 'bg-yellow-50 text-yellow-700',
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
// MAIN SHAREHOLDER DASHBOARD
// ============================================================
const ShareholderDashboard = () => {
    const { user } = useAuth();
    const currentDate = new Date();

    const [profile,      setProfile]      = useState(null);
    const [report,       setReport]       = useState(null);
    const [accounts,     setAccounts]     = useState([]);
    const [events,       setEvents]       = useState([]);
    const [shareholding, setShareholding] = useState([]);
    const [performance,  setPerformance]  = useState(null);
    const [sharePrice,   setSharePrice]   = useState(null);
    const [loading,      setLoading]      = useState(true);
    const [error,        setError]        = useState(null);

    useEffect(() => {
        const load = async () => {
            try {
                setLoading(true);
                const [
                    profileRes,
                    reportRes,
                    accountsRes,
                    eventsRes,
                    shareholdingRes,
                    performanceRes,
                    sharePriceRes,
                ] = await Promise.allSettled([
                    usersAPI.getMyProfile(),
                    reportsAPI.getMyReport({
                        year:  currentDate.getFullYear(),
                        month: currentDate.getMonth() + 1,
                    }),
                    accountsAPI.getSummary(),
                    eventsAPI.getUpcoming(30),
                    usersAPI.getShareholding(),
                    investmentsAPI.getPerformanceSummary(),
                    sharesAPI.getCurrentPrice(),
                ]);

                if (profileRes.status === 'fulfilled') {
                    setProfile(profileRes.value.data.data);
                }
                if (reportRes.status === 'fulfilled') {
                    setReport(reportRes.value.data.data);
                }
                if (accountsRes.status === 'fulfilled') {
                    setAccounts(accountsRes.value.data.data || []);
                }
                if (eventsRes.status === 'fulfilled') {
                    setEvents(eventsRes.value.data.data || []);
                }
                if (shareholdingRes.status === 'fulfilled') {
                    setShareholding(shareholdingRes.value.data.data || []);
                }
                if (performanceRes.status === 'fulfilled') {
                    setPerformance(performanceRes.value.data.data || null);
                }
                if (sharePriceRes.status === 'fulfilled') {
                    setSharePrice(sharePriceRes.value.data.data || null);
                }
            } catch (err) {
                setError(getErrorMessage(err));
            } finally {
                setLoading(false);
            }
        };

        load();
    }, []);

    if (loading) return <LoadingSpinner fullPage text="Loading your dashboard..." />;

    const myShareholding = profile?.shareholding;
    const totalContributed = report?.total_contributed || 0;
    const contributions = report?.contributions_period || [];
    const primaryAccount = accounts.find(a => a.account_type === 'PRIMARY');

    // My holding's value = shares_held × current price per share.
    // Falls back to the old "percentage of primary account balance"
    // estimate only if no share price has been set yet.
    const myShareValue = (myShareholding?.shares_held && sharePrice?.price_per_share)
        ? (parseFloat(myShareholding.shares_held) *
           parseFloat(sharePrice.price_per_share)).toFixed(2)
        : (myShareholding?.percentage && primaryAccount
            ? (parseFloat(primaryAccount.current_balance) *
               parseFloat(myShareholding.percentage) / 100).toFixed(2)
            : null);

    return (
        <div>
            {/* Welcome Header */}
            <div className="mb-6">
                <h1 className="page-title">
                    Welcome, {user?.first_name}
                </h1>
                <p className="mt-1 text-sm text-gray-500">
                    {currentDate.toLocaleDateString('en-GB', {
                        weekday: 'long',
                        year:    'numeric',
                        month:   'long',
                        day:     'numeric',
                    })}
                </p>
            </div>

            {error && (
                <div className="mb-4">
                    <ErrorMessage message={error} onDismiss={() => setError(null)} />
                </div>
            )}

            {/* Personal Stats */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                <StatCard
                    title="My Total Contributions"
                    value={`EUR ${parseFloat(totalContributed).toLocaleString('en-US', { maximumFractionDigits: 2 })}`}
                    subtitle="All time contributions"
                    icon={BanknotesIcon}
                    color="blue"
                />
                <StatCard
                    title="My Shareholding"
                    value={myShareholding?.percentage
                        ? `${myShareholding.percentage}%`
                        : '—'
                    }
                    subtitle={myShareholding?.shares_held
                        ? `${parseFloat(myShareholding.shares_held).toLocaleString('en-US', { maximumFractionDigits: 2 })} shares`
                        : 'Not yet assigned'
                    }
                    icon={ChartPieIcon}
                    color="purple"
                />
                <StatCard
                    title="My Share Value"
                    value={myShareValue
                        ? `EUR ${parseFloat(myShareValue).toLocaleString('en-US', { maximumFractionDigits: 2 })}`
                        : '—'
                    }
                    subtitle={sharePrice?.price_per_share
                        ? `${parseFloat(sharePrice.price_per_share).toLocaleString('en-US', { maximumFractionDigits: 2 })} per share`
                        : 'Based on primary account balance'
                    }
                    icon={ArrowTrendingUpIcon}
                    color="green"
                />
                <StatCard
                    title="Upcoming Events"
                    value={events.length}
                    subtitle="Next 30 days"
                    icon={CalendarDaysIcon}
                    color="yellow"
                    to="/events"
                />
            </div>

            {/* Main Content Grid */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

                {/* My Contributions This Month */}
                <div className="lg:col-span-2">
                    <div className="card">
                        <div className="flex items-center justify-between mb-4">
                            <h2 className="section-title">
                                My Contributions This Month
                            </h2>
                            <span className="text-xs text-gray-400">
                                {currentDate.toLocaleString('en-GB', {
                                    month: 'long', year: 'numeric'
                                })}
                            </span>
                        </div>

                        {contributions.length === 0 ? (
                            <p className="text-sm text-gray-400 text-center py-8">
                                No contributions recorded this month
                            </p>
                        ) : (
                            <div className="space-y-3">
                                {contributions.map((c, i) => (
                                    <div key={i} className="flex items-center
                                        justify-between py-3 border-b
                                        border-gray-100 last:border-0">
                                        <div>
                                            <p className="font-mono text-xs
                                                text-primary-700 font-medium">
                                                {c.reference_code}
                                            </p>
                                            <p className="text-xs text-gray-400 mt-0.5">
                                                {c.category_trail}
                                            </p>
                                        </div>
                                        <div className="text-right">
                                            <p className="text-sm font-bold
                                                text-green-600">
                                                EUR {parseFloat(c.amount)
                                                    .toLocaleString('en-US', { maximumFractionDigits: 2 })}
                                            </p>
                                            <p className="text-xs text-gray-400">
                                                {formatDate(c.contribution_date)}
                                            </p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Company Account Overview (read-only aggregate) */}
                    <div className="card mt-4">
                        <h2 className="section-title mb-4">
                            Company Account Overview
                        </h2>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            {accounts.map((account, i) => (
                                <div key={i} className="bg-gray-50 rounded-lg p-4">
                                    <p className="text-xs text-gray-400 mb-1">
                                        {account.name}
                                    </p>
                                    <p className="text-lg font-bold text-gray-900">
                                        {account.currency_code}{' '}
                                        {parseFloat(account.current_balance)
                                            .toLocaleString('en-US', { maximumFractionDigits: 2 })}
                                    </p>
                                    {account.floor_limit && (
                                        <p className="text-xs text-gray-400 mt-1">
                                            Floor: {account.currency_code}{' '}
                                            {parseFloat(account.floor_limit)
                                                .toLocaleString('en-US', { maximumFractionDigits: 2 })}
                                        </p>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                </div>

                {/* Right Column */}
                <div className="space-y-4">
                    {/* Best/Worst Performing Investment */}
                    <PerformanceCard performance={performance} />

                    {/* Shareholding Breakdown */}
                    <div className="card">
                        <h2 className="section-title mb-4">
                            Shareholding Breakdown
                        </h2>
                        {shareholding.length === 0 ? (
                            <p className="text-sm text-gray-400 text-center py-4">
                                No shareholding data available
                            </p>
                        ) : (
                            <div className="space-y-2">
                                {shareholding.map((s, i) => (
                                    <div key={i} className="flex items-center
                                        justify-between">
                                        <div className="flex items-center gap-2">
                                            <div style={{
                                                width: '8px',
                                                height: '8px',
                                                borderRadius: '50%',
                                                backgroundColor: s.first_name ===
                                                    user?.first_name &&
                                                    s.last_name === user?.last_name
                                                        ? '#1e3a5f'
                                                        : '#e5e7eb',
                                            }} />
                                            <p className={`text-sm ${
                                                s.first_name === user?.first_name &&
                                                s.last_name === user?.last_name
                                                    ? 'font-bold text-primary-700'
                                                    : 'text-gray-600'
                                            }`}>
                                                {s.first_name === user?.first_name &&
                                                 s.last_name === user?.last_name
                                                    ? 'You'
                                                    : `${s.first_name} ${s.last_name}`
                                                }
                                            </p>
                                        </div>
                                        <span className="text-sm font-semibold
                                            text-gray-700">
                                            {s.percentage || '—'}%
                                        </span>
                                    </div>
                                ))}

                                {/* Visual bar */}
                                <div className="mt-3 h-3 rounded-full bg-gray-100
                                    overflow-hidden flex">
                                    {shareholding
                                        .filter(s => s.percentage)
                                        .map((s, i) => (
                                            <div
                                                key={i}
                                                style={{
                                                    width: `${s.percentage}%`,
                                                    backgroundColor:
                                                        s.first_name === user?.first_name &&
                                                        s.last_name === user?.last_name
                                                            ? '#1e3a5f'
                                                            : `hsl(${i * 60}, 60%, 60%)`,
                                                }}
                                                title={`${s.first_name}: ${s.percentage}%`}
                                            />
                                        ))
                                    }
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Upcoming Events */}
                    <div className="card">
                        <h2 className="section-title mb-4">Upcoming Events</h2>
                        {events.length === 0 ? (
                            <p className="text-sm text-gray-400 text-center py-4">
                                No upcoming events in the next 30 days
                            </p>
                        ) : (
                            <div className="space-y-3">
                                {events.map((event, i) => (
                                    <div key={i} className="flex items-start gap-3">
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
                </div>
            </div>
        </div>
    );
};

export default ShareholderDashboard;