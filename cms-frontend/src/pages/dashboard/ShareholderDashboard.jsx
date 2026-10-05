// ============================================================
// SHAREHOLDER PERSONAL DASHBOARD
// Shows a shareholder's personal financial summary:
//   - Their own contributions
//   - Their shareholding percentage
//   - Company general overview (no other member's personal data)
//
// v1.56.0 — redesigned to a more practical, at-a-glance layout per
// direct shareholder feedback. New in this version:
//   - Double-line inflow/outflow chart for the Primary + Secondary
//     accounts (accountsAPI.getInflowOutflowTrend)
//   - A notification banner for a pledge that's unpaid, showing the
//     date it must be paid by to avoid a late fine
//   - A "Primary Goal" tile showing the goal's own progress/status
//     (not just whether a call happens to be open right now),
//     clicking through to the current pledge
//   - A combined "Outstanding Balances" list (fines + side fund dues
//     + unpaid capital pledges, up to 5) — previously these each
//     lived on their own page with no single place to see them all
//   - An Input vs Return bar chart alongside the existing Best/Worst
//     Investment performance card (investmentsAPI.getInputVsReturn)
//   - A personal payment ledger at the bottom (up to 5 records) —
//     every kind of payment this member has made into the company,
//     unified across contributions, side fund dues, fines, and
//     capital pledge settlements (usersAPI.getMyPaymentLedger)
// See docs/v1.56.0_shareholder_dashboard_redesign.mermaid for the
// full data-flow diagram.
// ============================================================

import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
    reportsAPI, usersAPI, accountsAPI, eventsAPI, investmentsAPI, sharesAPI,
    sideFundAPI, capitalGoalCallsAPI, capitalGoalsAPI, settingsAPI, finesAPI,
} from '../../api/endpoints';
import { formatDate, formatCurrency, getErrorMessage } from '../../utils/helpers';
import LoadingSpinner from '../../components/common/LoadingSpinner';
import ErrorMessage from '../../components/common/ErrorMessage';
import { useAuth } from '../../contexts/AuthContext';
import { compactNumber, useChartTheme } from '../../hooks/useChartTheme';
import {
    BanknotesIcon,
    ChartPieIcon,
    CalendarDaysIcon,
    ArrowTrendingUpIcon,
    TrophyIcon,
    WalletIcon,
    ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import {
    ResponsiveContainer, AreaChart, Area, LineChart, Line,
    XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import PageHeader from '../../components/common/PageHeader';
import { CapitalGoalsDashboardSection } from '../capitalGoals/capitalGoalUi';
import { MeetingActionsCard } from '../meetings/MeetingActionsCard'; // v1.79.0

// Shortens a long investment/bond name for an x-axis tick label —
// the full name still shows in the tooltip on hover. Charts whose
// x-axis is "one point per record" rather than a fixed calendar
// period (unlike the inflow/outflow trend above) can grow arbitrarily
// long as more investments are added, so labels need to degrade
// gracefully rather than overlap.
const truncateLabel = (value, max = 14) =>
    (value && value.length > max) ? `${value.slice(0, max)}…` : value;

// ============================================================
// INFLOW / OUTFLOW TREND — gradient area chart (v1.56.1)
// Primary + Secondary accounts combined, last 12 months. See
// accountsController.getInflowOutflowTrend — single-currency by
// design (the Primary account's own currency), same assumption the
// rest of this dashboard already makes everywhere else it shows a
// company-wide figure. Styled to match the "Balance Over Time" chart
// on the individual account pages (AccountsPage.jsx) per direct
// request — a gradient-filled Area, no dot markers on the line —
// rather than the plain dotted Line chart this started as.
// ============================================================
const InflowOutflowChart = ({ trend, currencyCode }) => {
    const theme = useChartTheme();

    return (
        <div className="card">
            <h2 className="section-title mb-4">
                Inflow vs Outflow — Primary &amp; Secondary Accounts
            </h2>
            {!trend || trend.length === 0 ? (
                <div className="flex items-center justify-center h-56 text-gray-300 text-sm">
                    No transaction history yet
                </div>
            ) : (
                <ResponsiveContainer width="100%" height={280}>
                    <AreaChart data={trend}>
                        <defs>
                            <linearGradient id="shDashInflowGrad" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor={theme.success} stopOpacity={0.35} />
                                <stop offset="95%" stopColor={theme.success} stopOpacity={0} />
                            </linearGradient>
                            <linearGradient id="shDashOutflowGrad" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor={theme.danger} stopOpacity={0.35} />
                                <stop offset="95%" stopColor={theme.danger} stopOpacity={0} />
                            </linearGradient>
                        </defs>
                        <CartesianGrid {...theme.gridProps} />
                        <XAxis dataKey="period" tick={{ fontSize: 11, ...theme.axisTick }} tickLine={false} />
                        <YAxis
                            tick={{ fontSize: 11, ...theme.axisTick }}
                            tickLine={false}
                            axisLine={false}
                            tickFormatter={compactNumber}
                        />
                        <Tooltip
                            {...theme.tooltipProps}
                            formatter={(v, name) => [
                                `${currencyCode || ''} ${parseFloat(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}`,
                                name,
                            ]}
                        />
                        <Legend {...theme.legendProps} />
                        <Area type="monotone" dataKey="inflow" name="Inflow"
                            stroke={theme.success} strokeWidth={2} fill="url(#shDashInflowGrad)" />
                        <Area type="monotone" dataKey="outflow" name="Outflow"
                            stroke={theme.danger} strokeWidth={2} fill="url(#shDashOutflowGrad)" />
                    </AreaChart>
                </ResponsiveContainer>
            )}
        </div>
    );
};

// ============================================================
// PENDING PLEDGE NOTIFICATION BANNER (v1.56.0)
// Shows only when a pledge of mine is still unpaid (PENDING/PARTIAL).
// v1.78.0 — fed by /capital-goals/overview (me.next_due) and corrected:
// it used to say "pay by <deadline + grace days> to avoid a late fine",
// but a first-round payment made after the deadline IS fined (at the
// lower rate during the grace days, the higher rate after). It now says
// pay by the deadline, and when the higher fine starts. It links to the
// month itself.
// ============================================================
const PendingPledgeBanner = ({ due, count }) => {
    if (!due) return null;
    return (
        <div className={`mb-6 flex items-start gap-3 rounded-lg border p-4 ${due.overdue ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50'}`}>
            <ExclamationTriangleIcon className={`h-5 w-5 flex-shrink-0 mt-0.5 ${due.overdue ? 'text-red-500' : 'text-amber-500'}`} />
            <div className="flex-1 min-w-0">
                <p className={`text-sm font-semibold ${due.overdue ? 'text-red-800' : 'text-amber-800'}`}>
                    Pledge payment {due.overdue ? 'overdue' : 'pending'} — {due.goal_title} ({due.period}{due.iteration === 2 ? ', round 2' : ''})
                    {count > 1 ? ` · ${count} unpaid pledges in all` : ''}
                </p>
                <p className={`text-xs mt-0.5 ${due.overdue ? 'text-red-700' : 'text-amber-700'}`}>
                    {due.currency_code} {parseFloat(due.owed).toLocaleString('en-US', { maximumFractionDigits: 2 })} still owed.
                    {' '}{due.overdue ? 'The deadline was' : 'Pay by'} <strong>{formatDate(due.deadline)}</strong>
                    {due.iteration === 2
                        ? ' (no late fine in round 2).'
                        : due.higher_fine_from
                            ? `${due.overdue ? '' : ' to avoid a late fine'}; the higher late fine applies from ${formatDate(due.higher_fine_from)}.`
                            : '.'}
                </p>
            </div>
            <Link to={`/capital-goals/monthly-calls/${due.monthly_call_id}`}
                className={`text-xs font-semibold underline flex-shrink-0 whitespace-nowrap ${due.overdue ? 'text-red-800' : 'text-amber-800'}`}>
                View
            </Link>
        </div>
    );
};

// ============================================================
// BEST/WORST PERFORMING INVESTMENT CARD
// v1.56.0: now also renders the Input vs Return bar chart
// (investmentsAPI.getInputVsReturn) beneath the Best/Worst rows,
// per the direct request that "the investment performance section
// remains but with an addition of a chart of input vs return."
// ============================================================
const PerformanceCard = ({ performance, inputVsReturn }) => {
    const theme = useChartTheme();
    const hasPerformance = performance && performance.count > 0;
    const hasChart = inputVsReturn && inputVsReturn.length > 0;

    if (!hasPerformance && !hasChart) return null;

    const { best, worst } = performance || {};
    const showBoth = hasPerformance && worst &&
        (worst.id !== best.id || worst.investment_type !== best.investment_type);

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
        <div className="card">
            <div className="flex items-center gap-2 mb-2">
                <TrophyIcon className="h-4 w-4 text-yellow-500" />
                <h2 className="section-title mb-0">Investment Performance</h2>
            </div>
            {hasPerformance && (
                <div className="divide-y divide-gray-100">
                    <Row label="Best" inv={best} tone="good" />
                    {showBoth && <Row label="Worst" inv={worst} tone="bad" />}
                </div>
            )}
            {hasChart && (
                <div className={hasPerformance ? 'mt-4 pt-4 border-t border-gray-100' : ''}>
                    <h3 className="text-xs font-semibold text-gray-500 mb-2">
                        Input vs Return <span className="font-normal text-gray-400">— every investment</span>
                    </h3>
                    <ResponsiveContainer width="100%" height={220}>
                        <LineChart data={inputVsReturn} margin={{ top: 4, right: 8, left: 0, bottom: 8 }}>
                            <CartesianGrid {...theme.gridProps} />
                            <XAxis
                                dataKey="name"
                                tick={{ fontSize: 10, ...theme.axisTick }}
                                tickLine={false}
                                interval="preserveStartEnd"
                                angle={-35}
                                textAnchor="end"
                                height={54}
                                tickFormatter={truncateLabel}
                            />
                            <YAxis tick={{ fontSize: 10, ...theme.axisTick }} tickLine={false} axisLine={false}
                                tickFormatter={compactNumber} />
                            <Tooltip
                                {...theme.tooltipProps}
                                formatter={(v, name) => [parseFloat(v).toLocaleString('en-US', { maximumFractionDigits: 2 }), name]}
                            />
                            <Legend {...theme.legendProps} verticalAlign="top" height={28} />
                            <Line type="monotone" dataKey="invested" name="Invested"
                                stroke={theme.neutral} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                            <Line type="monotone" dataKey="returned" name="Returned"
                                stroke={theme.success} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                        </LineChart>
                    </ResponsiveContainer>
                </div>
            )}
        </div>
    );
};

// ============================================================
// OUTSTANDING BALANCES CARD (v1.56.0) — up to 5 records, combining
// fines, overdue/partial Side Fund dues, and unpaid capital pledges
// into one place, per the direct request "if one has fines and any
// outstanding balances there should a section for that can
// accommodate upto five records."
// ============================================================
const OutstandingBalancesCard = ({ items }) => (
    <div className="card">
        <h2 className="section-title mb-4">Outstanding Balances</h2>
        {items.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-4">
                Nothing outstanding — you&apos;re all caught up
            </p>
        ) : (
            <div className="space-y-3">
                {items.map((item) => (
                    <div key={item.key} className="flex items-center justify-between py-2
                        border-b border-gray-100 last:border-0">
                        <div className="min-w-0">
                            <p className="text-sm text-gray-900 truncate">{item.label}</p>
                            <p className="text-xs text-gray-400">{item.type}</p>
                        </div>
                        <p className="text-sm font-bold text-amber-600 flex-shrink-0 ml-3">
                            {item.currency} {item.amount.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                        </p>
                    </div>
                ))}
            </div>
        )}
    </div>
);

// ============================================================
// PERSONAL PAYMENT LEDGER (v1.56.0) — bottom-of-page, up to 5
// records, every kind of payment this member has made into the
// company (usersAPI.getMyPaymentLedger).
// ============================================================
const PAYMENT_TYPE_LABELS = {
    CONTRIBUTION:   'Contribution',
    SIDE_FUND_DUE:  'Side Fund',
    FINE_PAYMENT:   'Fine Paid',
    CAPITAL_PLEDGE: 'Capital Pledge',
};

const PaymentLedgerCard = ({ payments }) => (
    <div className="card">
        <h2 className="section-title mb-4">My Recent Payments</h2>
        {payments.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">
                No payments recorded yet
            </p>
        ) : (
            <div className="space-y-3">
                {payments.map((p, i) => (
                    <div key={i} className="flex items-center justify-between py-3
                        border-b border-gray-100 last:border-0">
                        <div className="min-w-0">
                            <p className="text-sm text-gray-900 truncate">{p.description}</p>
                            <p className="text-xs text-gray-400">
                                {PAYMENT_TYPE_LABELS[p.paymentType] || p.paymentType}
                                {p.referenceCode && ` • ${p.referenceCode}`}
                                {' • '}{formatDate(p.paymentDate)}
                            </p>
                        </div>
                        <p className="text-sm font-bold text-green-600 flex-shrink-0 ml-3">
                            {p.currencyCode} {p.amount.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                        </p>
                    </div>
                ))}
            </div>
        )}
    </div>
);

// ============================================================
// STAT CARD
// ============================================================
const StatCard = ({ title, value, subtitle, icon: Icon, color = 'blue', to = null }) => {
    // Icon chip carries a small gradient rather than a flat tint — the
    // "colourful tile" treatment, kept to the chip so the card body
    // itself stays readable in both light and dark mode.
    const colors = {
        blue:   'bg-gradient-to-br from-blue-500 to-indigo-600 text-white',
        green:  'bg-gradient-to-br from-emerald-500 to-teal-600 text-white',
        purple: 'bg-gradient-to-br from-purple-500 to-fuchsia-600 text-white',
        yellow: 'bg-gradient-to-br from-amber-400 to-orange-500 text-white',
    };

    const content = (
        <div className="flex items-start justify-between">
            <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-500">{title}</p>
                <p className="mt-2 text-2xl font-bold text-gray-900">{value}</p>
                {subtitle && (
                    <p className="mt-1 text-xs text-gray-400 truncate">{subtitle}</p>
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
// MAIN SHAREHOLDER DASHBOARD
// ============================================================
const ShareholderDashboard = ({ headerActions = null }) => {
    const { user } = useAuth();
    const currentDate = new Date();

    const [profile,      setProfile]      = useState(null);
    const [report,       setReport]       = useState(null);
    const [accounts,     setAccounts]     = useState([]);
    const [events,       setEvents]       = useState([]);
    const [shareholding, setShareholding] = useState([]);
    const [performance,  setPerformance]  = useState(null);
    const [sharePrice,   setSharePrice]   = useState(null);
    const [sideFund,        setSideFund]        = useState(null);
    const [sideFundOverdue, setSideFundOverdue]  = useState(null);
    const [sideFundCredit,  setSideFundCredit]   = useState(null);
    const [currentQuarter, setCurrentQuarter]    = useState(null);
    // v1.51.0 — hide the capital call widget while tracking is paused.
    const [capitalGoalTrackingEnabled, setCapitalGoalTrackingEnabled] = useState(true);
    const [loading,      setLoading]      = useState(true);
    const [error,        setError]        = useState(null);

    // --- v1.56.0 additions ---
    const [inflowOutflow, setInflowOutflow] = useState({ currencyCode: null, trend: [] });
    const [investmentInputReturn, setInvestmentInputReturn] = useState([]);
    const [paymentLedger, setPaymentLedger] = useState([]);
    const [myFines, setMyFines] = useState([]);
    const [myDues, setMyDues] = useState([]);
    const [myPledges, setMyPledges] = useState([]);
    const [capitalOverview, setCapitalOverview] = useState(null); // v1.78.0 — from the Capital goals section

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
                    sideFundRes,
                    sideFundOverdueRes,
                    sideFundCreditRes,
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
                    sideFundAPI.getSettings(),
                    sideFundAPI.getMyOverdue(),
                    sideFundAPI.getMyCredit(),
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
                if (sideFundRes.status === 'fulfilled') {
                    setSideFund(sideFundRes.value.data.data || null);
                }
                if (sideFundOverdueRes.status === 'fulfilled') {
                    setSideFundOverdue(sideFundOverdueRes.value.data.data || null);
                }
                if (sideFundCreditRes.status === 'fulfilled') {
                    setSideFundCredit(sideFundCreditRes.value.data.data || null);
                }
            } catch (err) {
                setError(getErrorMessage(err));
            } finally {
                setLoading(false);
            }
        };

        load();
    }, []);

    // Separate, independent fetch (own error handling — no goal simply
    // means the card doesn't render) for the PRIMARY capital goal's
    // currently open call, if any, AND the member's full pledge list
    // (v1.56.0 — also needed for the outstanding-balances list and the
    // pending-payment notification banner).
    useEffect(() => {
        capitalGoalCallsAPI.getMyPledges()
            .then(res => {
                setMyPledges(res.data.data?.my_pledges || []);
            })
            .catch(() => {});
    }, []);

    // v1.51.0 — same "current quarter known to all members" widget as
    // the staff-side DashboardPage.jsx; no permission gate needed.
    useEffect(() => {
        settingsAPI.getCurrentFiscalQuarter()
            .then(res => setCurrentQuarter(res.data.data?.label || null))
            .catch(() => {});
    }, []);

    useEffect(() => {
        capitalGoalsAPI.getTrackingSettings()
            .then(res => setCapitalGoalTrackingEnabled(res.data.data.tracking_enabled))
            .catch(() => {});
    }, []);

    // v1.56.0 — new dashboard sections' data, fetched independently of
    // the main load() above so a failure here never blocks the rest of
    // the dashboard from rendering.
    useEffect(() => {
        const loadExtra = async () => {
            const [
                trendRes, invRes, ledgerRes, finesRes, duesRes,
            ] = await Promise.allSettled([
                accountsAPI.getInflowOutflowTrend(12),
                investmentsAPI.getInputVsReturn(),
                usersAPI.getMyPaymentLedger(5),
                finesAPI.getMine(),
                sideFundAPI.getMyDues(),
            ]);

            if (trendRes.status === 'fulfilled') {
                setInflowOutflow(trendRes.value.data.data || { currencyCode: null, trend: [] });
            }
            if (invRes.status === 'fulfilled') {
                setInvestmentInputReturn(invRes.value.data.data || []);
            }
            if (ledgerRes.status === 'fulfilled') {
                setPaymentLedger(ledgerRes.value.data.data || []);
            }
            if (finesRes.status === 'fulfilled') {
                setMyFines(finesRes.value.data.data || []);
            }
            if (duesRes.status === 'fulfilled') {
                setMyDues(duesRes.value.data.data || []);
            }
        };

        loadExtra();
    }, []);

    if (loading) return <LoadingSpinner fullPage text="Loading your dashboard..." />;

    const myShareholding = profile?.shareholding;
    const totalContributed = report?.total_contributed || 0;
    // v1.77.0 — money is always shown with ITS OWN currency, never a
    // fixed "EUR" label.
    const money = (currency, amount) =>
        `${currency ? `${currency} ` : ''}${parseFloat(amount || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
    const contributedByCurrency = report?.total_contributed_by_currency || null;
    const totalContributedLabel = contributedByCurrency && contributedByCurrency.length > 0
        ? contributedByCurrency.map(t => money(t.currency_code, t.total)).join(' + ')
        : money(report?.currency_code || 'EUR', totalContributed);
    const contributions = report?.contributions_period || [];
    const primaryAccount = accounts.find(a => a.account_type === 'PRIMARY');
    const nextEvent = events[0] || null;

    // My holding's value = shares_held × current price per share.
    // Falls back to the old "percentage of primary account balance"
    // estimate only if no share price has been set yet.
    const valuedByPrice = !!(myShareholding?.shares_held && sharePrice?.price_per_share);
    const myShareValue = valuedByPrice
        ? (parseFloat(myShareholding.shares_held) *
           parseFloat(sharePrice.price_per_share)).toFixed(2)
        : (myShareholding?.percentage && primaryAccount
            ? (parseFloat(primaryAccount.current_balance) *
               parseFloat(myShareholding.percentage) / 100).toFixed(2)
            : null);
    // v1.77.0 — the value is in the currency it was worked out in: the
    // share price's currency (UGX), or the primary account's for the
    // fallback estimate. It used to always say "EUR".
    const myShareValueCurrency = valuedByPrice
        ? sharePrice?.currency_code
        : primaryAccount?.currency_code;

    // v1.56.0 — the nearest unpaid/partial pledge, for the top-of-page
    // notification banner. v1.78.0 — taken from the capital goals
    // overview (me.next_due), which already knows the deadline that
    // applies (round 1 or round 2) and when the higher fine starts.

    // v1.56.0 — combined outstanding balances: fines, overdue/partial
    // Side Fund dues, and unpaid capital pledges, newest first, capped
    // at 5 records as requested.
    const outstandingItems = [
        ...myFines.filter(f => f.status === 'OUTSTANDING').map(f => ({
            key:      `fine-${f.id}`,
            type:     'Fine',
            label:    (f.reason || '').replace(/_/g, ' '),
            amount:   parseFloat(f.amount),
            currency: f.currency_code,
            date:     f.created_at,
        })),
        ...myDues.filter(d => ['PENDING', 'PARTIAL', 'DEFAULTED'].includes(d.status)).map(d => ({
            key:      `sfd-${d.id}`,
            type:     'Side Fund',
            label:    `Dues — ${d.period}`,
            amount:   parseFloat(d.amount_due) - parseFloat(d.amount_paid),
            currency: sideFund?.currency_code || '',
            date:     `${d.period}-01`,
        })),
        ...myPledges.filter(p => p.status === 'PENDING' || p.status === 'PARTIAL').map(p => ({
            key:      `pledge-${p.id}`,
            type:     'Capital Pledge',
            label:    `${p.goal_title} — ${p.period}`,
            amount:   parseFloat(p.pledged_amount) - parseFloat(p.amount_settled),
            currency: p.currency_code,
            date:     p.submitted_at,
        })),
    ]
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .slice(0, 5);

    return (
        <div>
            {/* Welcome band (v1.71.0 — same header band as every page) */}
            <PageHeader
                title={`Welcome, ${user?.first_name}`}
                subtitle={`${currentDate.toLocaleDateString('en-GB', {
                    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
                })}${currentQuarter ? ` • ${currentQuarter}` : ''}`}
                actions={headerActions}
            />

            {error && (
                <div className="mb-4">
                    <ErrorMessage message={error} onDismiss={() => setError(null)} />
                </div>
            )}

            {/* Pending pledge payment notification (v1.56.0) */}
            {capitalGoalTrackingEnabled && capitalOverview && (
                <PendingPledgeBanner due={capitalOverview.me.next_due} count={capitalOverview.me.owed.length} />
            )}

            {/* Personal Stats */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                <StatCard
                    title="My Total Contributions"
                    value={totalContributedLabel}
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
                        ? money(myShareValueCurrency, myShareValue)
                        : '—'
                    }
                    subtitle={sharePrice?.price_per_share
                        ? `${money(sharePrice.currency_code, sharePrice.price_per_share)} per share`
                        : 'Based on primary account balance'
                    }
                    icon={ArrowTrendingUpIcon}
                    color="green"
                />
                <StatCard
                    title="Upcoming Events"
                    value={events.length}
                    subtitle={nextEvent
                        ? `Next: ${nextEvent.title} — ${formatDate(nextEvent.event_date)}`
                        : 'Next 30 days'
                    }
                    icon={CalendarDaysIcon}
                    color="yellow"
                    to="/events"
                />
                {sideFund?.is_active && (
                    <StatCard
                        title="My Side Fund"
                        value={sideFundOverdue?.overdue_amount > 0
                            ? `${money(sideFund?.currency_code, sideFundOverdue.overdue_amount)} overdue`
                            : sideFundCredit?.credit_balance > 0
                                ? `${money(sideFund?.currency_code, sideFundCredit.credit_balance)} credit`
                                : 'Up to date'
                        }
                        subtitle={sideFundOverdue?.overdue_count > 0
                            ? `${sideFundOverdue.overdue_count} month${sideFundOverdue.overdue_count > 1 ? 's' : ''} unpaid`
                            : sideFundCredit?.credit_balance > 0
                                ? 'Banked for future months'
                                : 'No dues overdue'
                        }
                        icon={WalletIcon}
                        color={sideFundOverdue?.overdue_amount > 0 ? 'yellow' : 'green'}
                        to="/side-fund"
                    />
                )}
            </div>

            {/* Company meetings (v1.79.0) — confirm attendance, sign written
                resolutions, meetings I'm called to, URSB filings due.
                Shows nothing when there is nothing to do. */}
            <MeetingActionsCard compact />

            {/* My capital goals (v1.78.0) — every active goal, this month's
                call, my pledge and what I owe, with a one-tap "Pledge".
                Replaces the single Primary Goal tile; hidden while Capital
                Goal Tracking is paused. */}
            {capitalGoalTrackingEnabled && (
                <div className="mb-6">
                    <CapitalGoalsDashboardSection title="My capital goals" onOverview={setCapitalOverview} showApprovals={false} />
                </div>
            )}

            {/* Inflow / Outflow trend chart (v1.56.0) — full width, up top
                per the direct request that this be the dashboard's first
                thing shown. */}
            <div className="mb-6">
                <InflowOutflowChart trend={inflowOutflow.trend} currencyCode={inflowOutflow.currencyCode} />
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
                    {/* Best/Worst Performing Investment + Input vs Return chart */}
                    <PerformanceCard performance={performance} inputVsReturn={investmentInputReturn} />

                    {/* Outstanding Balances (v1.56.0) */}
                    <OutstandingBalancesCard items={outstandingItems} />

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

            {/* Personal Payment Ledger (v1.56.0) — bottom of page, full
                width, up to 5 records across every kind of payment made. */}
            <div className="mt-6">
                <PaymentLedgerCard payments={paymentLedger} />
            </div>
        </div>
    );
};

export default ShareholderDashboard;
