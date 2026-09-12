// ============================================================
// DASHBOARD PAGE
// Two dashboards live here:
//   - ShareholderDashboard — anyone holding the Shareholder role
//   - General Dashboard (this file's own JSX below) — Admin/
//     Director/Treasurer/etc.
//
// v1.56.1 — redesigned routing + full rework, per direct request:
// "anyone having a shareholder role, the shareholder dashboard is
// the default and a redesign of general dashboard for the Admin/
// Director/Treasurer roles which one can toggle between each other
// in case they hold these roles." So:
//   - Holds ONLY Shareholder -> always the Shareholder dashboard,
//     no toggle (nothing else to toggle to).
//   - Holds Shareholder PLUS another role -> Shareholder dashboard
//     by default, with a toggle to switch to the General Dashboard
//     and back.
//   - Holds no Shareholder role at all -> always the General
//     Dashboard, no toggle.
// The General Dashboard itself was fully reworked (not just
// restyled) into: restyled account balances/recent transactions/
// upcoming events (unchanged content, new gradient-area chart
// style), a company-wide inflow/outflow trend, a Pending Approvals
// feed, a Capital Goals overview (every ACTIVE goal, not just the
// nearest one), and a Money Owed to/by the Company snapshot.
// See docs/v1.56.1_general_dashboard_rework.mermaid.
// ============================================================

import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import {
    accountsAPI, eventsAPI, transactionsAPI, investmentsAPI, capitalGoalsAPI,
    capitalGoalCallsAPI, settingsAPI, usersAPI, grantsAPI, loansAPI,
    serviceFeesAPI, sideFundAPI, finesAPI, documentsAPI,
} from '../../api/endpoints';
import { formatDate, getErrorMessage } from '../../utils/helpers';
import LoadingSpinner from '../../components/common/LoadingSpinner';
import StatusBadge from '../../components/common/StatusBadge';
import PageHeader from '../../components/common/PageHeader';
import ShareholderDashboard from './ShareholderDashboard';
import { useChartTheme } from '../../hooks/useChartTheme';
import {
    BanknotesIcon,
    ChartBarIcon,
    CalendarDaysIcon,
    TrophyIcon,
    FlagIcon,
    ClipboardDocumentCheckIcon,
    WalletIcon,
} from '@heroicons/react/24/outline';
import {
    ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';

// ============================================================
// COMPANY-WIDE INFLOW / OUTFLOW TREND — gradient area chart
// (v1.56.1). Same accountsAPI.getInflowOutflowTrend endpoint the
// Shareholder Dashboard uses, and the same "Balance Over Time"
// gradient-area, no-node style as the individual account pages
// (AccountsPage.jsx) per direct request. Distinct gradient element
// ids from ShareholderDashboard's own copy of this chart, since SVG
// <defs> ids are global to the page and only one of the two
// dashboards is ever mounted at a time, but a stray leftover
// wouldn't be safe to assume.
// ============================================================
const CompanyInflowOutflowChart = ({ trend, currencyCode }) => {
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
                            <linearGradient id="genDashInflowGrad" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor={theme.success} stopOpacity={0.35} />
                                <stop offset="95%" stopColor={theme.success} stopOpacity={0} />
                            </linearGradient>
                            <linearGradient id="genDashOutflowGrad" x1="0" y1="0" x2="0" y2="1">
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
                            tickFormatter={v => v.toLocaleString('en-US', { maximumFractionDigits: 0 })}
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
                            stroke={theme.success} strokeWidth={2} fill="url(#genDashInflowGrad)" />
                        <Area type="monotone" dataKey="outflow" name="Outflow"
                            stroke={theme.danger} strokeWidth={2} fill="url(#genDashOutflowGrad)" />
                    </AreaChart>
                </ResponsiveContainer>
            )}
        </div>
    );
};

// ============================================================
// PENDING APPROVALS FEED (v1.56.1) — everything currently awaiting
// THIS person's action, across every module they hold the relevant
// approval permission for. Built entirely from each module's own
// existing "list by status=PENDING" endpoint (no single module
// needed a new one) plus one new endpoint for capital pledges, the
// one genuine gap — see capitalGoalCallsController.getPendingPledges.
// Oldest first, since that's usually the most overdue to clear.
// ============================================================
const PendingApprovalsCard = ({ items }) => (
    <div className="card">
        <div className="flex items-center gap-2 mb-4">
            <ClipboardDocumentCheckIcon className="h-4 w-4 text-primary-600" />
            <h2 className="section-title mb-0">Pending Approvals</h2>
            <span className="ml-auto text-xs font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700">
                {items.length}
            </span>
        </div>
        <div className="space-y-1">
            {items.map((item) => (
                <Link key={item.key} to={item.to} className="flex items-center justify-between py-2
                    border-b border-gray-100 last:border-0 hover:bg-gray-50 rounded-md px-1 -mx-1
                    transition-colors">
                    <div className="min-w-0">
                        <p className="text-sm text-gray-900 truncate">{item.label}</p>
                        <p className="text-xs text-gray-400">
                            {item.type}{item.date && ` • ${formatDate(item.date)}`}
                        </p>
                    </div>
                </Link>
            ))}
        </div>
    </div>
);

// ============================================================
// CAPITAL GOALS OVERVIEW (v1.56.1) — every ACTIVE goal (Primary and
// every Secondary), not just the single nearest-ending one the old
// CapitalGoalCard showed. The Primary goal's own currently open call
// (if any) is surfaced with a direct "pledge" link, same as before.
// ============================================================
const CapitalGoalsOverviewCard = ({ goals, primaryOpenCall }) => {
    if (!goals || goals.length === 0) return null;

    return (
        <div className="card">
            <div className="flex items-center gap-2 mb-4">
                <FlagIcon className="h-4 w-4 text-primary-600" />
                <h2 className="section-title mb-0">Capital Goals</h2>
            </div>
            <div className="space-y-4">
                {goals.map((goal) => {
                    const behind = goal.progress_status === 'BEHIND';
                    const isPrimary = goal.goal_type === 'PRIMARY';
                    return (
                        <Link key={goal.id} to={`/capital-goals/${goal.id}`}
                            className="block hover:bg-gray-50 rounded-md p-2 -m-2 transition-colors">
                            <div className="flex items-center gap-2 mb-1">
                                <p className="text-sm font-medium text-gray-900 truncate">
                                    {goal.title}
                                </p>
                                {isPrimary && (
                                    <span className="badge-blue text-[10px] px-1.5 py-0.5 flex-shrink-0">PRIMARY</span>
                                )}
                                <span className={`ml-auto text-xs font-semibold px-2 py-0.5 rounded-full flex-shrink-0 ${
                                    behind ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'
                                }`}>
                                    {goal.progress_status?.replace('_', ' ')}
                                </span>
                            </div>
                            <div className="flex items-baseline justify-between mb-1">
                                <p className="text-xs text-gray-500">
                                    {goal.currency_code} {parseFloat(goal.total_collected).toLocaleString('en-US', { maximumFractionDigits: 0 })}
                                    {' '}of{' '}
                                    {goal.currency_code} {parseFloat(goal.target_amount).toLocaleString('en-US', { maximumFractionDigits: 0 })}
                                </p>
                                <p className="text-xs font-bold text-gray-900">{goal.percent_of_target}%</p>
                            </div>
                            <div className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden">
                                <div className={`h-full rounded-full ${behind ? 'bg-red-500' : 'bg-green-500'}`}
                                    style={{ width: `${Math.min(100, goal.percent_of_target)}%` }} />
                            </div>
                            {isPrimary && primaryOpenCall && (
                                <p className="text-xs text-primary-500 mt-1">
                                    Call open for {primaryOpenCall.period}
                                    {primaryOpenCall.already_pledged ? ' — already pledged' : ' — not yet pledged'}
                                </p>
                            )}
                        </Link>
                    );
                })}
            </div>
        </div>
    );
};

// ============================================================
// MONEY OWED TO / BY THE COMPANY (v1.56.1) — a Treasurer's at-a-
// glance health check: Side Fund arrears, outstanding fines,
// Service Fee arrears, and loan/grant obligations. Each line keeps
// its own currency rather than being summed into one blended total
// across modules — these aren't always the same currency, and this
// system otherwise treats currency-mixing without conversion as a
// modelling mistake (see accountsController.getInflowOutflowTrend).
// ============================================================
const MoneyOwedCard = ({ items }) => {
    if (!items || items.length === 0) return null;

    return (
        <div className="card">
            <div className="flex items-center gap-2 mb-4">
                <WalletIcon className="h-4 w-4 text-primary-600" />
                <h2 className="section-title mb-0">Money Owed To / By the Company</h2>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {items.map((item) => (
                    <div key={item.key} className="bg-gray-50 rounded-lg p-3">
                        <p className="text-xs text-gray-400 mb-1">{item.label}</p>
                        <p className="text-base font-bold text-gray-900">
                            {item.currency} {item.amount.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                        </p>
                        {item.subtitle && (
                            <p className="text-xs text-gray-400 mt-0.5">{item.subtitle}</p>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
};

// ============================================================
// BEST/WORST PERFORMING INVESTMENT CARD
// ============================================================
const PerformanceCard = ({ performance }) => {
    if (!performance || performance.count === 0) return null;

    const { best, worst } = performance;
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
// STAT CARD COMPONENT
// ============================================================
const StatCard = ({ title, value, subtitle, icon: Icon, color = 'blue', to = null }) => {
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
// VIEW TOGGLE (v1.56.1) — only rendered for a user who holds the
// Shareholder role AND at least one other role. A pure Shareholder
// has nothing to toggle to; a pure staff role never sees the
// Shareholder dashboard at all.
// ============================================================
const DashboardViewToggle = ({ activeView, onChange }) => (
    <div className="flex justify-end mb-4">
        <div className="inline-flex rounded-lg border border-gray-200 bg-white p-1">
            <button
                onClick={() => onChange('shareholder')}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                    activeView === 'shareholder' ? 'bg-primary-600 text-white' : 'text-gray-500 hover:text-gray-700'
                }`}
            >
                My Dashboard
            </button>
            <button
                onClick={() => onChange('general')}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                    activeView === 'general' ? 'bg-primary-600 text-white' : 'text-gray-500 hover:text-gray-700'
                }`}
            >
                General Dashboard
            </button>
        </div>
    </div>
);

// ============================================================
// DASHBOARD PAGE
// ============================================================
const DashboardPage = () => {
    const { user, hasPermission, hasFinancialAccess } = useAuth();
    const navigate = useNavigate();
    const canSeeFinance = hasFinancialAccess('FINANCE_VIEW_ALL');

    const [accounts,     setAccounts]     = useState([]);
    const [events,       setEvents]       = useState([]);
    const [transactions, setTransactions] = useState([]);
    const [investments,  setInvestments]  = useState([]);
    const [performance,  setPerformance]  = useState(null);
    const [primaryOpenCall, setPrimaryOpenCall] = useState(null);
    const [currentQuarter, setCurrentQuarter] = useState(null);
    const [capitalGoalTrackingEnabled, setCapitalGoalTrackingEnabled] = useState(true);
    const [loading,      setLoading]      = useState(true);

    // --- v1.56.1 additions ---
    const [companyTrend, setCompanyTrend] = useState({ currencyCode: null, trend: [] });
    const [allGoals, setAllGoals] = useState([]);
    const [pendingApprovals, setPendingApprovals] = useState([]);
    const [moneyOwed, setMoneyOwed] = useState([]);

    // Roles held, and the resulting default view + whether a toggle
    // is even possible (v1.56.1 — replaces the old "shareholder-only"
    // all-or-nothing check).
    const roles = Array.isArray(user?.roles)
        ? user.roles.map(r => typeof r === 'object' ? r.name : r)
        : [];
    const hasShareholderRole = roles.includes('Shareholder');
    const hasOtherRole = roles.some(r => r !== 'Shareholder');
    const canToggle = hasShareholderRole && hasOtherRole;

    const [activeView, setActiveView] = useState(() => hasShareholderRole ? 'shareholder' : 'general');

    useEffect(() => {
        const loadDashboard = async () => {
            try {
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

    // v1.56.1 — every ACTIVE capital goal (Primary + Secondary), for
    // the new Capital Goals overview. Replaces the old single-
    // nearest-goal fetch (limit: 1).
    useEffect(() => {
        if (!hasPermission('CAPITAL_GOAL_VIEW')) return;
        capitalGoalsAPI.getAll({ status: 'ACTIVE' })
            .then(res => setAllGoals(res.data.data || []))
            .catch(() => {});
        capitalGoalsAPI.getTrackingSettings()
            .then(res => setCapitalGoalTrackingEnabled(res.data.data.tracking_enabled))
            .catch(() => {});
    }, [hasPermission]);

    useEffect(() => {
        capitalGoalCallsAPI.getMyPledges()
            .then(res => {
                const openCalls = res.data.data?.open_calls || [];
                setPrimaryOpenCall(openCalls.find(c => c.goal_type === 'PRIMARY') || null);
            })
            .catch(() => {});
    }, []);

    useEffect(() => {
        settingsAPI.getCurrentFiscalQuarter()
            .then(res => setCurrentQuarter(res.data.data?.label || null))
            .catch(() => {});
    }, []);

    // v1.56.1 — company-wide inflow/outflow trend for the new chart.
    useEffect(() => {
        if (!canSeeFinance) return;
        accountsAPI.getInflowOutflowTrend(12)
            .then(res => setCompanyTrend(res.data.data || { currencyCode: null, trend: [] }))
            .catch(() => {});
    }, [canSeeFinance]);

    // v1.56.1 — Pending Approvals feed. Each source is only called at
    // all if this user holds the matching approval permission, same
    // "don't spend a request on a 403" discipline as loadDashboard
    // above. Built from each module's own existing PENDING-status
    // list endpoint, plus the one new capitalGoalCallsAPI.getPendingPledges.
    useEffect(() => {
        const loadPendingApprovals = async () => {
            const calls = [];
            const mappers = [];

            if (hasPermission('ROLE_ASSIGN')) {
                calls.push(usersAPI.getRoleRequests({ status: 'PENDING' }));
                mappers.push(rows => rows.map(r => ({
                    key: `role-${r.id}`, type: 'Role Request',
                    label: `${r.user.first_name} ${r.user.last_name} → ${r.role.name}`,
                    date: r.created_at, to: '/users',
                })));
            }
            if (hasPermission('INVESTMENT_APPROVE')) {
                calls.push(investmentsAPI.getAll({ status: 'PENDING' }));
                mappers.push(rows => rows.map(r => ({
                    key: `inv-${r.id}`, type: 'Investment',
                    label: `Pending approval — ${r.name}`,
                    date: r.created_at, to: '/investments',
                })));
            }
            if (hasPermission('GRANT_APPROVE')) {
                calls.push(grantsAPI.getAll({ status: 'PENDING' }));
                mappers.push(rows => rows.map(r => ({
                    key: `grant-${r.id}`, type: 'Grant',
                    label: `Pending approval — ${r.title}`,
                    date: r.created_at, to: '/grants',
                })));
            }
            if (hasPermission('LOAN_APPROVE')) {
                calls.push(loansAPI.getAllReceived({ status: 'PENDING' }));
                mappers.push(rows => rows.map(r => ({
                    key: `loanr-${r.id}`, type: 'Loan Received',
                    label: `Pending approval — ${r.lender_name}`,
                    date: r.created_at, to: '/loans',
                })));
                calls.push(loansAPI.getAllGiven({ status: 'PENDING' }));
                mappers.push(rows => rows.map(r => ({
                    key: `loang-${r.id}`, type: 'Loan Given',
                    label: `Pending approval — ${r.borrower_name}`,
                    date: r.created_at, to: '/loans',
                })));
            }
            if (hasPermission('SERVICE_FEE_MANAGE')) {
                calls.push(serviceFeesAPI.listPaymentRequests({ status: 'PENDING' }));
                mappers.push(rows => rows.map(r => ({
                    key: `sfpr-${r.id}`, type: 'Service Fee Payment',
                    label: `${r.user_name} requested payment`,
                    date: r.created_at, to: '/service-fees',
                })));
                calls.push(serviceFeesAPI.listAdvances({ status: 'PENDING' }));
                mappers.push(rows => rows.map(r => ({
                    key: `sfadv-${r.id}`, type: 'Service Fee Advance',
                    label: `${r.user_name} requested an advance — ${r.currency_code} ${parseFloat(r.amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}`,
                    date: r.created_at, to: '/service-fees',
                })));
            }
            if (hasPermission('CAPITAL_GOAL_MANAGE')) {
                calls.push(capitalGoalCallsAPI.getPendingPledges());
                mappers.push(rows => rows.map(r => ({
                    key: `pledge-${r.id}`, type: 'Capital Pledge',
                    label: `${r.member_name} pledged ${r.currency_code} ${parseFloat(r.pledged_amount).toLocaleString('en-US', { maximumFractionDigits: 2 })} — ${r.goal_title} (${r.period})`,
                    date: r.submitted_at, to: '/capital-goals',
                })));
            }
            // Document signatures — self-scoped, no extra permission gate,
            // same as documentsAPI.getPendingSignatures's own /me nature.
            calls.push(documentsAPI.getPendingSignatures());
            mappers.push(rows => rows.map(r => ({
                key: `doc-${r.target_type}-${r.target_id}`, type: 'Signature',
                label: `${r.title} — ${r.subtitle}`,
                date: null, to: '/documents',
            })));

            const results = await Promise.allSettled(calls);
            const combined = results.flatMap((res, i) => (
                res.status === 'fulfilled' ? mappers[i](res.value.data.data || []) : []
            ));
            combined.sort((a, b) => {
                if (!a.date && !b.date) return 0;
                if (!a.date) return 1;
                if (!b.date) return -1;
                return new Date(a.date) - new Date(b.date);
            });
            setPendingApprovals(combined.slice(0, 8));
        };

        loadPendingApprovals();
    }, [hasPermission]);

    // v1.56.1 — Money Owed To/By the Company. Each source independent
    // (own try/catch) since the shapes are heterogeneous enough that
    // bundling them into one Promise.allSettled/mapper pair (like the
    // Pending Approvals feed above) would be harder to read, not easier.
    useEffect(() => {
        const loadMoneyOwed = async () => {
            const items = [];

            if (hasFinancialAccess('SIDE_FUND_VIEW')) {
                try {
                    const [overdueRes, settingsRes] = await Promise.all([
                        sideFundAPI.getAllOverdue(), sideFundAPI.getSettings(),
                    ]);
                    const overdue = overdueRes.data.data || [];
                    const total = overdue.reduce((s, o) => s + parseFloat(o.overdue_amount), 0);
                    if (total > 0) {
                        items.push({
                            key: 'sidefund', label: 'Side Fund dues overdue',
                            subtitle: `${overdue.length} member${overdue.length === 1 ? '' : 's'}`,
                            amount: total, currency: settingsRes.data.data?.currency_code || '',
                        });
                    }
                } catch { /* silent — matches this page's other optional-widget fetches */ }
            }

            if (hasFinancialAccess('FINE_VIEW')) {
                try {
                    const res = await finesAPI.getAll({ status: 'OUTSTANDING', limit: 200 });
                    const fines = res.data.data || [];
                    const byCurrency = {};
                    fines.forEach(f => {
                        byCurrency[f.currency_code] = (byCurrency[f.currency_code] || 0) + parseFloat(f.amount);
                    });
                    Object.entries(byCurrency).forEach(([currency, amount]) => {
                        items.push({
                            key: `fines-${currency}`, label: 'Fines outstanding',
                            subtitle: `${fines.filter(f => f.currency_code === currency).length} fine(s)`,
                            amount, currency,
                        });
                    });
                } catch { /* silent */ }
            }

            if (hasPermission('SERVICE_FEE_VIEW')) {
                try {
                    const res = await serviceFeesAPI.getTreasuryStats();
                    const totalOutstanding = parseFloat(res.data.data?.totals?.total_outstanding || 0);
                    if (totalOutstanding > 0) {
                        items.push({
                            key: 'servicefees', label: 'Service Fees outstanding',
                            subtitle: 'Across all agreements',
                            amount: totalOutstanding, currency: '',
                        });
                    }
                } catch { /* silent */ }
            }

            if (hasPermission('LOAN_VIEW')) {
                try {
                    const [receivedRes, givenRes] = await Promise.all([
                        loansAPI.getAllReceived({}), loansAPI.getAllGiven({}),
                    ]);
                    const activeStatuses = ['ACTIVE', 'OVERDUE', 'PARTIALLY_REPAID'];
                    const received = (receivedRes.data.data || []).filter(l => activeStatuses.includes(l.status));
                    const given = (givenRes.data.data || []).filter(l => activeStatuses.includes(l.status));

                    const byCurrencyReceived = {};
                    received.forEach(l => {
                        byCurrencyReceived[l.currency_code] = (byCurrencyReceived[l.currency_code] || 0) + parseFloat(l.outstanding_principal);
                    });
                    Object.entries(byCurrencyReceived).forEach(([currency, amount]) => {
                        if (amount > 0) items.push({
                            key: `loanr-${currency}`, label: 'Owed by the company (loans received)',
                            subtitle: `${received.length} loan(s)`, amount, currency,
                        });
                    });

                    const byCurrencyGiven = {};
                    given.forEach(l => {
                        byCurrencyGiven[l.currency_code] = (byCurrencyGiven[l.currency_code] || 0) + parseFloat(l.outstanding_principal);
                    });
                    Object.entries(byCurrencyGiven).forEach(([currency, amount]) => {
                        if (amount > 0) items.push({
                            key: `loang-${currency}`, label: 'Owed to the company (loans given)',
                            subtitle: `${given.length} loan(s)`, amount, currency,
                        });
                    });
                } catch { /* silent */ }
            }

            if (hasPermission('GRANT_VIEW')) {
                try {
                    const res = await grantsAPI.getAll({});
                    const expected = (res.data.data || []).filter(g => ['ACTIVE', 'PARTIALLY_RECEIVED'].includes(g.status));
                    const byCurrency = {};
                    expected.forEach(g => {
                        byCurrency[g.currency_code] = (byCurrency[g.currency_code] || 0) + parseFloat(g.amount_remaining);
                    });
                    Object.entries(byCurrency).forEach(([currency, amount]) => {
                        if (amount > 0) items.push({
                            key: `grants-${currency}`, label: 'Grants still expected',
                            subtitle: `${expected.length} grant(s)`, amount, currency,
                        });
                    });
                } catch { /* silent */ }
            }

            setMoneyOwed(items);
        };

        loadMoneyOwed();
    }, [hasPermission, hasFinancialAccess]);

    if (loading) {
        return <LoadingSpinner fullPage text="Loading dashboard..." />;
    }

    // Pure Shareholder (no other role) — always the Shareholder
    // dashboard, nothing to toggle to.
    if (hasShareholderRole && !hasOtherRole) {
        return <ShareholderDashboard />;
    }

    const toggleBar = canToggle
        ? <DashboardViewToggle activeView={activeView} onChange={setActiveView} />
        : null;

    // Holds Shareholder + another role, currently viewing "My Dashboard".
    if (canToggle && activeView === 'shareholder') {
        return (
            <div>
                {toggleBar}
                <ShareholderDashboard />
            </div>
        );
    }

    const primaryAccount    = accounts.find(a => a.account_type === 'PRIMARY');
    const secondaryAccounts = accounts.filter(a => a.account_type === 'SECONDARY');
    const savingsAccount    = accounts.find(a => a.account_type === 'SAVINGS');
    const sideFundTotal = accounts.reduce(
        (sum, a) => sum + parseFloat(a.side_fund_allocation || 0), 0
    );

    return (
        <div>
            {toggleBar}

            <PageHeader
                title={`Welcome back, ${user?.first_name}`}
                subtitle={`${new Date().toLocaleDateString('en-GB', {
                    weekday: 'long', year: 'numeric',
                    month: 'long', day: 'numeric'
                })}${currentQuarter ? ` • ${currentQuarter}` : ''}`}
            />

            {/* Account Summary Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3
                xl:grid-cols-4 gap-4 mb-6">

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

                <StatCard
                    title="Upcoming Events"
                    value={events.length}
                    subtitle="Next 30 days"
                    icon={CalendarDaysIcon}
                    color="blue"
                    to="/events"
                />
            </div>

            {/* Company-wide inflow/outflow trend (v1.56.1) */}
            {canSeeFinance && (
                <div className="mb-6">
                    <CompanyInflowOutflowChart trend={companyTrend.trend} currencyCode={companyTrend.currencyCode} />
                </div>
            )}

            {/* Pending Approvals feed (v1.56.1) */}
            {pendingApprovals.length > 0 && (
                <div className="mb-6">
                    <PendingApprovalsCard items={pendingApprovals} />
                </div>
            )}

            {/* Capital Goals overview — every ACTIVE goal (v1.56.1) */}
            {capitalGoalTrackingEnabled && (
                <div className="mb-6">
                    <CapitalGoalsOverviewCard goals={allGoals} primaryOpenCall={primaryOpenCall} />
                </div>
            )}

            {/* Money Owed To/By the Company (v1.56.1) */}
            <div className="mb-6">
                <MoneyOwedCard items={moneyOwed} />
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

                    {/* Best/Worst Performing Investment */}
                    {hasFinancialAccess('INVESTMENT_VIEW') && (
                        <PerformanceCard performance={performance} />
                    )}

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
