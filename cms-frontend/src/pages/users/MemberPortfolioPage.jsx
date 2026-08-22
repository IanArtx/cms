// ============================================================
// MEMBER PORTFOLIO PAGE (v1.34.0)
// The full "everything about this member" detail view. Reached two
// ways: an Admin clicking "View Portfolio" on the Users page for any
// member (route /users/:id/portfolio), or anyone tapping their own
// name/photo at the top of the Sidebar (route /portfolio, no :id —
// defaults to the logged-in user). Both render the exact same page;
// the backend (GET /users/:id/portfolio, isSelfOrHasPermission
// gate) is what actually decides whether the request is even
// allowed, this page just picks which id to ask for.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { usersAPI, documentsAPI, categoriesAPI } from '../../api/endpoints';
import { formatDate, getErrorMessage } from '../../utils/helpers';
import { memberPortfolioTemplate, printDocument } from '../../utils/exportUtils';
import PageHeader from '../../components/common/PageHeader';
import LoadingSpinner from '../../components/common/LoadingSpinner';
import ErrorMessage from '../../components/common/ErrorMessage';
import StatusBadge from '../../components/common/StatusBadge';
import Avatar from '../../components/common/Avatar';
import { useAuth } from '../../contexts/AuthContext';
import {
    PrinterIcon, ShieldCheckIcon, BanknotesIcon, ArrowsRightLeftIcon,
} from '@heroicons/react/24/outline';

// ------------------------------------------------------------
// Small stat tile — used across the summary banner
// ------------------------------------------------------------
const StatTile = ({ label, value, tone = 'default' }) => {
    const toneClass = {
        default: 'text-gray-900',
        green:   'text-green-600',
        red:     'text-red-600',
    }[tone];
    return (
        <div className="bg-gray-50 rounded-lg p-3">
            <p className="text-xs text-gray-400">{label}</p>
            <p className={`text-lg font-bold ${toneClass}`}>{value}</p>
        </div>
    );
};

const money = (amount, code = '') => {
    const n = parseFloat(amount) || 0;
    return `${code ? code + ' ' : ''}${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
};

const MemberPortfolioPage = () => {
    const { id } = useParams();
    const { user: authUser } = useAuth();
    const targetId = id || authUser?.id;
    const isSelf = String(targetId) === String(authUser?.id);

    const [portfolio, setPortfolio] = useState(null);
    const [loading,   setLoading]   = useState(true);
    const [error,     setError]     = useState(null);
    const [generating, setGenerating] = useState(false);
    const [genError,   setGenError]   = useState(null);

    const loadPortfolio = useCallback(async () => {
        if (!targetId) return;
        try {
            setLoading(true);
            const res = await usersAPI.getPortfolio(targetId);
            setPortfolio(res.data.data);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, [targetId]);

    useEffect(() => { loadPortfolio(); }, [loadPortfolio]);

    // --------------------------------------------------------
    // Instant print — no saved record, just renders the same
    // template straight to the browser's print dialog.
    // --------------------------------------------------------
    const handlePrint = () => {
        const templateData = {
            ...portfolio,
            prepared_by:    authUser ? `${authUser.first_name} ${authUser.last_name}` : '',
            generated_date: new Date().toLocaleDateString('en-GB'),
        };
        printDocument(
            memberPortfolioTemplate(templateData),
            `Portfolio Summary - ${portfolio.profile.first_name} ${portfolio.profile.last_name}`
        );
    };

    // --------------------------------------------------------
    // Formal generated Document — saved to the Documents library
    // (source SYSTEM_GENERATED, document_type
    // FINANCIAL_REPORT_INDIVIDUAL — see migration_v1.34.0.sql),
    // audit-logged, downloadable/re-printable later from Documents.
    // Same generic POST /documents/generate every other generated
    // document type uses (Receipt, Resolution, etc.) — this button
    // just builds template_data from the portfolio already on screen
    // instead of asking the admin to re-type it into a form.
    // --------------------------------------------------------
    const handleGenerateDocument = async () => {
        setGenerating(true);
        setGenError(null);
        try {
            const [templatesRes, categoriesRes] = await Promise.all([
                documentsAPI.getTemplates(),
                categoriesAPI.getAll(),
            ]);
            const template = (templatesRes.data.data || [])
                .find(t => t.template_type === 'FINANCIAL_REPORT_INDIVIDUAL');
            if (!template) {
                throw new Error(
                    'Portfolio Summary template not found — run migration_v1.34.0.sql first.'
                );
            }
            const docCategory = (categoriesRes.data.data || [])
                .find(c => c.module === 'DOCUMENT');
            if (!docCategory) {
                throw new Error('No Document category found to file this under.');
            }

            const templateData = {
                ...portfolio,
                prepared_by:    authUser ? `${authUser.first_name} ${authUser.last_name}` : '',
                generated_date: new Date().toLocaleDateString('en-GB'),
            };

            await documentsAPI.generate({
                template_id:   template.id,
                category_id:   docCategory.id,
                title: `Portfolio Summary - ${portfolio.profile.first_name} ${portfolio.profile.last_name} - ${new Date().toLocaleDateString('en-GB')}`,
                document_type: 'FINANCIAL_REPORT_INDIVIDUAL',
                template_data: templateData,
            });

            printDocument(
                memberPortfolioTemplate(templateData),
                `Portfolio Summary - ${portfolio.profile.first_name} ${portfolio.profile.last_name}`
            );
        } catch (err) {
            setGenError(getErrorMessage(err));
        } finally {
            setGenerating(false);
        }
    };

    if (loading) return <LoadingSpinner fullPage text="Loading portfolio..." />;
    if (error) return (
        <div>
            <PageHeader title="Member Portfolio" showBack backTo={isSelf ? '/' : '/users'} />
            <ErrorMessage message={error} />
        </div>
    );
    if (!portfolio) return null;

    const { profile, rolesCurrent, shareholding, savings, dividends, sideFund, payments, transactionsInvolved, summary } = portfolio;

    return (
        <div>
            <PageHeader
                title={isSelf ? 'My Portfolio' : `${profile.first_name} ${profile.last_name}`}
                subtitle={isSelf ? 'Your full standing in the company' : 'Member Portfolio'}
                showBack
                backTo={isSelf ? '/' : '/users'}
                actions={
                    <div className="flex flex-wrap gap-2">
                        <button onClick={handlePrint} className="btn-secondary flex items-center gap-2">
                            <PrinterIcon className="h-4 w-4" />
                            Print
                        </button>
                        <button onClick={handleGenerateDocument} disabled={generating}
                            className="btn-primary flex items-center gap-2">
                            <PrinterIcon className="h-4 w-4" />
                            {generating ? 'Generating...' : 'Generate Portfolio Summary'}
                        </button>
                    </div>
                }
            />

            {genError && (
                <div className="mb-6">
                    <ErrorMessage message={genError} onDismiss={() => setGenError(null)} />
                </div>
            )}

            {/* Summary banner */}
            <div className="card mb-6">
                <div className="flex items-center gap-4 mb-4">
                    <Avatar user={profile} size={56} />
                    <div>
                        <p className="text-lg font-semibold text-gray-900">
                            {profile.first_name} {profile.last_name}
                        </p>
                        <p className="text-sm text-gray-500">{profile.email}</p>
                        <div className="flex flex-wrap gap-1 mt-1">
                            {rolesCurrent.map(r => (
                                <span key={r.id} className="badge-blue text-xs">{r.name}</span>
                            ))}
                            <StatusBadge status={profile.is_active ? 'ACTIVE' : 'INACTIVE'} />
                            {!profile.is_email_verified && (
                                <span className="badge-yellow text-xs">Unverified</span>
                            )}
                        </div>
                    </div>
                    <div className="ml-auto text-right text-xs text-gray-400">
                        Member since<br />
                        <span className="text-sm text-gray-600">{formatDate(summary.memberSince)}</span>
                    </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                    <StatTile label="Shares Held" value={summary.sharesHeld.toLocaleString('en-US', { maximumFractionDigits: 2 })} />
                    <StatTile label="Shareholding %" value={`${summary.percentage.toFixed(2)}%`} />
                    <StatTile label="Current Value" tone="green"
                        value={shareholding.currentPrice ? money(summary.currentValue, shareholding.currentPrice.currency_code) : '—'} />
                    <StatTile label="Total Contributed" value={money(summary.totalContributed)} />
                    <StatTile label="Savings Balance" value={money(summary.savingsBalance, savings.currencyCode)} />
                    <StatTile label="Side Fund Overdue" tone={summary.sideFundOverdue > 0 ? 'red' : 'default'}
                        value={summary.sideFundOverdue > 0 ? money(summary.sideFundOverdue) : 'None'} />
                </div>
            </div>

            {/* Roles held */}
            <div className="card mb-6">
                <div className="flex items-center gap-2 mb-3">
                    <ShieldCheckIcon className="h-5 w-5 text-primary-600" />
                    <h3 className="font-semibold text-gray-900">Roles Held</h3>
                </div>
                <div className="overflow-x-auto">
                    <table className="min-w-full text-sm">
                        <thead>
                            <tr className="text-left text-xs text-gray-400">
                                <th className="pb-2">Role</th><th className="pb-2">Assigned</th>
                                <th className="pb-2">Assigned By</th><th className="pb-2">Status</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                            {portfolio.rolesHistory.map(r => (
                                <tr key={`${r.id}-${r.assigned_at}`}>
                                    <td className="py-2">{r.name}</td>
                                    <td className="py-2 text-gray-500">{formatDate(r.assigned_at)}</td>
                                    <td className="py-2 text-gray-500">{r.assigned_by_name || '—'}</td>
                                    <td className="py-2">
                                        {r.revoked_at
                                            ? <span className="text-gray-400">Revoked {formatDate(r.revoked_at)}</span>
                                            : <span className="text-green-600">Current</span>}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Shareholding & contributions */}
            <div className="card mb-6">
                <h3 className="font-semibold text-gray-900 mb-3">Contribution History</h3>
                <div className="overflow-x-auto max-h-96 overflow-y-auto">
                    <table className="min-w-full text-sm">
                        <thead className="sticky top-0 bg-white">
                            <tr className="text-left text-xs text-gray-400">
                                <th className="pb-2">Date</th><th className="pb-2">Reference</th>
                                <th className="pb-2">Account</th><th className="pb-2">Category</th>
                                <th className="pb-2 text-right">Amount</th><th className="pb-2">Status</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                            {shareholding.contributions.length === 0 ? (
                                <tr><td colSpan={6} className="py-4 text-center text-gray-400">No contributions on record</td></tr>
                            ) : shareholding.contributions.map(c => (
                                <tr key={c.id}>
                                    <td className="py-2">{formatDate(c.contribution_date)}</td>
                                    <td className="py-2 font-mono text-xs">{c.reference_code}</td>
                                    <td className="py-2">{c.account_name}</td>
                                    <td className="py-2">{c.category_name}</td>
                                    <td className="py-2 text-right font-medium">{money(c.amount, c.currency_code)}</td>
                                    <td className="py-2"><StatusBadge status={c.status} /></td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Savings */}
            <div className="card mb-6">
                <div className="flex items-center gap-2 mb-3">
                    <BanknotesIcon className="h-5 w-5 text-primary-600" />
                    <h3 className="font-semibold text-gray-900">Savings</h3>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
                    <StatTile label="Principal Balance" value={money(savings.principalBalance, savings.currencyCode)} />
                    <StatTile label="Accrued Interest" value={money(savings.accruedInterest, savings.currencyCode)} />
                    <StatTile label="Total Interest Paid" value={money(savings.totalInterestPaid, savings.currencyCode)} />
                </div>
                {savings.deposits.length > 0 && (
                    <div className="overflow-x-auto max-h-64 overflow-y-auto">
                        <table className="min-w-full text-sm">
                            <thead>
                                <tr className="text-left text-xs text-gray-400">
                                    <th className="pb-2">Date</th><th className="pb-2">Type</th>
                                    <th className="pb-2 text-right">Amount</th><th className="pb-2">Status</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100">
                                {savings.deposits.map(d => (
                                    <tr key={d.id}>
                                        <td className="py-2">{formatDate(d.deposit_date)}</td>
                                        <td className="py-2">{d.entry_type}</td>
                                        <td className="py-2 text-right">{money(d.principal_amount, d.currency_code)}</td>
                                        <td className="py-2"><StatusBadge status={d.status} /></td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* Dividends received */}
            {dividends.distributions.length > 0 && (
                <div className="card mb-6">
                    <h3 className="font-semibold text-gray-900 mb-3">
                        Dividends Received — Total {money(dividends.totalReceived)}
                    </h3>
                    <div className="overflow-x-auto max-h-64 overflow-y-auto">
                        <table className="min-w-full text-sm">
                            <thead>
                                <tr className="text-left text-xs text-gray-400">
                                    <th className="pb-2">Period</th><th className="pb-2 text-right">Amount</th>
                                    <th className="pb-2">Status</th><th className="pb-2">Paid</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100">
                                {dividends.distributions.map(d => (
                                    <tr key={d.id}>
                                        <td className="py-2">{d.period_label || formatDate(d.declaration_date)}</td>
                                        <td className="py-2 text-right">{money(d.credited_amount || d.amount, d.currency_code)}</td>
                                        <td className="py-2"><StatusBadge status={d.status} /></td>
                                        <td className="py-2">{d.paid_at ? formatDate(d.paid_at) : '—'}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* Side fund standing */}
            {sideFund.membership && (
                <div className="card mb-6">
                    <h3 className="font-semibold text-gray-900 mb-3">
                        Side Fund — {sideFund.membership.is_in ? 'Member' : 'Not currently a member'}
                        {sideFund.membership.start_period && ` (since ${sideFund.membership.start_period})`}
                    </h3>
                    {sideFund.dues.length > 0 && (
                        <div className="overflow-x-auto max-h-64 overflow-y-auto">
                            <table className="min-w-full text-sm">
                                <thead>
                                    <tr className="text-left text-xs text-gray-400">
                                        <th className="pb-2">Period</th><th className="pb-2 text-right">Due</th>
                                        <th className="pb-2 text-right">Paid</th><th className="pb-2">Status</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-100">
                                    {sideFund.dues.map(d => (
                                        <tr key={d.id}>
                                            <td className="py-2">{d.period}</td>
                                            <td className="py-2 text-right">{money(d.amount_due)}</td>
                                            <td className="py-2 text-right">{money(d.amount_paid)}</td>
                                            <td className="py-2"><StatusBadge status={d.status} /></td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            )}

            {/* Payments received (dividends/service fees/reimbursements/handouts/side fund payouts) */}
            {payments.payments.length > 0 && (
                <div className="card mb-6">
                    <h3 className="font-semibold text-gray-900 mb-3">Payments Received</h3>
                    <div className="overflow-x-auto max-h-64 overflow-y-auto">
                        <table className="min-w-full text-sm">
                            <thead>
                                <tr className="text-left text-xs text-gray-400">
                                    <th className="pb-2">Type</th><th className="pb-2 text-right">Amount</th>
                                    <th className="pb-2">Status</th><th className="pb-2">Date</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100">
                                {payments.payments.map(p => (
                                    <tr key={p.id}>
                                        <td className="py-2">{p.source_type.replace(/_/g, ' ')}</td>
                                        <td className="py-2 text-right">{money(p.amount, p.currency_code)}</td>
                                        <td className="py-2"><StatusBadge status={p.status} /></td>
                                        <td className="py-2">{formatDate(p.created_at)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* Transactions involved */}
            <div className="card mb-6">
                <div className="flex items-center gap-2 mb-3">
                    <ArrowsRightLeftIcon className="h-5 w-5 text-primary-600" />
                    <h3 className="font-semibold text-gray-900">
                        Transactions Involved In
                        {transactionsInvolved.totalCount > transactionsInvolved.transactions.length &&
                            ` (${transactionsInvolved.totalCount} total, most recent shown)`}
                    </h3>
                </div>
                <div className="overflow-x-auto max-h-96 overflow-y-auto">
                    <table className="min-w-full text-sm">
                        <thead className="sticky top-0 bg-white">
                            <tr className="text-left text-xs text-gray-400">
                                <th className="pb-2">Date</th><th className="pb-2">Reference</th>
                                <th className="pb-2">Description</th><th className="pb-2 text-right">Amount</th>
                                <th className="pb-2">Role</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                            {transactionsInvolved.transactions.length === 0 ? (
                                <tr><td colSpan={5} className="py-4 text-center text-gray-400">No transactions on record</td></tr>
                            ) : transactionsInvolved.transactions.map(t => {
                                const roles = [
                                    t.as_beneficiary && 'Beneficiary',
                                    t.as_creator && 'Recorded By',
                                    t.as_approver && 'Approved By',
                                ].filter(Boolean).join(', ');
                                return (
                                    <tr key={t.id}>
                                        <td className="py-2">{formatDate(t.value_date)}</td>
                                        <td className="py-2 font-mono text-xs">{t.reference_code}</td>
                                        <td className="py-2 truncate max-w-xs">{t.description}</td>
                                        <td className="py-2 text-right">{money(t.amount, t.currency_code)}</td>
                                        <td className="py-2 text-xs text-gray-500">{roles}</td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
};

export default MemberPortfolioPage;
