// ============================================================
// RECORDS CHECK PAGE (v1.72.0) — Reports & ledger › Records check
//
// Requested directly: reversals of money that went to investments
// (money market funds in particular) went back to the account but were
// never taken off the investment — "this should be addressed and also
// reconcile past / historical transactions".
//
// The general ledger was always right (it is built from the entries
// themselves). What drifted were the running figures STORED on each
// money market fund and investment ("balance", "spent", "returns").
// This page compares every stored figure with the same figure worked
// out again from the entries that still stand, so a difference can
// never hide:
//
//   1. Money market funds — balance, money put in, withdrawn, interest
//      and fees, stored vs worked out.
//   2. Investments — "Spent" and "Returns", stored vs worked out.
//   3. Automatic corrections — every figure the system changed by
//      itself (e.g. the v1.72.0 update repairing past reversals), with
//      the old and new value. Rows marked "Needs a look" were NOT
//      changed automatically because the right answer needs a person
//      (e.g. only half of a coupon was reversed in the past).
//
// Read-only. Visible to anyone with FINANCE_VIEW_ALL (same as the
// financial statements).
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { reportsAPI } from '../../api/endpoints';
import { formatDate, getErrorMessage } from '../../utils/helpers';
import PageHeader from '../../components/common/PageHeader';
import LoadingSpinner from '../../components/common/LoadingSpinner';
import ErrorMessage from '../../components/common/ErrorMessage';
import StatusBadge from '../../components/common/StatusBadge';
import {
    ArrowPathIcon,
    CheckCircleIcon,
    ExclamationTriangleIcon,
    CircleStackIcon,
    ChartBarIcon,
    ClipboardDocumentListIcon,
} from '@heroicons/react/24/outline';

const fmt = (n) => (n === null || n === undefined || n === '')
    ? '—'
    : parseFloat(n).toLocaleString('en-US', { maximumFractionDigits: 2 });

// Plain-English names for the stored figures.
const FIELD_LABELS = {
    current_balance:       'Balance',
    total_principal_in:    'Money put in',
    total_withdrawn:       'Withdrawn',
    total_interest:        'Interest',
    total_management_fees: 'Management fees',
    actual_expenditure:    'Spent',
    total_returns:         'Returns',
    supplementary_budget:  'Supplementary budget',
    status:                'Status',
    is_reversed:           'Marked reversed',
};
const fieldLabel = (f) => FIELD_LABELS[f] || (f || '').replace(/_/g, ' ');

const RECORD_LABELS = {
    mmf_accounts:  'Money market fund',
    investments:   'Investment',
    projects:      'Project',
    bond_coupons:  'Bond coupon',
    transactions:  'Ledger entry',
};

const Section = ({ icon: Icon, title, subtitle, right = null, children }) => (
    <div className="card mb-6">
        <div className="flex items-start justify-between gap-3 mb-1">
            <div className="flex items-center gap-2">
                <Icon className="h-5 w-5 text-primary-600" />
                <h3 className="section-title mb-0">{title}</h3>
            </div>
            {right}
        </div>
        {subtitle && <p className="text-xs text-gray-400 mb-4">{subtitle}</p>}
        {children}
    </div>
);

const OkOrDiff = ({ ok }) => ok
    ? <span className="badge-green text-xs">Matches</span>
    : <span className="badge-red text-xs">Difference</span>;

const SummaryTile = ({ label, value, good }) => (
    <div className="card flex items-center gap-3">
        {good
            ? <CheckCircleIcon className="h-8 w-8 text-green-500 flex-shrink-0" />
            : <ExclamationTriangleIcon className="h-8 w-8 text-amber-500 flex-shrink-0" />}
        <div>
            <p className="kpi-value">{value}</p>
            <p className="text-xs text-gray-500">{label}</p>
        </div>
    </div>
);

const RecordChecksPage = () => {
    const [data, setData]       = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError]     = useState(null);
    const [onlyDiffs, setOnlyDiffs] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await reportsAPI.getRecordChecks();
            setData(res.data.data);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    const funds       = (data?.funds || []).filter(f => !onlyDiffs || !f.ok);
    const investments = (data?.investments || []).filter(i => !onlyDiffs || !i.ok);
    const corrections = data?.corrections || [];
    const summary     = data?.summary || {};

    return (
        <div>
            <PageHeader
                title="Records check"
                subtitle="Stored fund and investment figures compared with their own entries, and every automatic correction"
                showBack backTo="/reports"
                actions={
                    <button onClick={load} className="btn-secondary flex items-center gap-2" disabled={loading}>
                        <ArrowPathIcon className="h-4 w-4" />
                        Check again
                    </button>
                }
            />

            {error && (
                <div className="mb-4">
                    <ErrorMessage message={error} onDismiss={() => setError(null)} />
                </div>
            )}

            {loading && !data ? (
                <LoadingSpinner />
            ) : data && (
                <>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
                        <SummaryTile
                            label="Money market funds with a difference"
                            value={summary.funds_with_differences || 0}
                            good={!summary.funds_with_differences} />
                        <SummaryTile
                            label="Investments with a difference"
                            value={summary.investments_with_differences || 0}
                            good={!summary.investments_with_differences} />
                        <SummaryTile
                            label="Corrections that need a look"
                            value={summary.corrections_needing_attention || 0}
                            good={!summary.corrections_needing_attention} />
                    </div>

                    <label className="flex items-center gap-2 text-sm text-gray-600 mb-4">
                        <input type="checkbox" checked={onlyDiffs} onChange={e => setOnlyDiffs(e.target.checked)} />
                        Show only records with a difference
                    </label>

                    {/* 1. Money market funds */}
                    <Section
                        icon={CircleStackIcon}
                        title="Money market funds"
                        subtitle="Stored balance vs the balance worked out from the fund's entries (money put in + interest − withdrawn − fees). Reversed entries are left out."
                    >
                        {funds.length === 0 ? (
                            <p className="text-sm text-gray-400 text-center py-6">Nothing to show</p>
                        ) : (
                            <div className="overflow-x-auto -mx-2">
                                <table className="min-w-full text-sm">
                                    <thead>
                                        <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                                            <th className="px-2 py-2 font-medium">Fund</th>
                                            <th className="px-2 py-2 font-medium text-right">Stored balance</th>
                                            <th className="px-2 py-2 font-medium text-right">Worked out</th>
                                            <th className="px-2 py-2 font-medium text-right">Reversed entries</th>
                                            <th className="px-2 py-2 font-medium">Result</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {funds.map(f => (
                                            <tr key={f.id} className="border-b border-gray-50 last:border-0 align-top">
                                                <td className="px-2 py-2">
                                                    <Link to={`/mmf/${f.id}`} className="font-medium text-primary-700 hover:underline">{f.name}</Link>
                                                    <div className="mt-0.5"><StatusBadge status={f.status} /></div>
                                                </td>
                                                <td className="px-2 py-2 text-right whitespace-nowrap">{f.currency_code} {fmt(f.stored_balance)}</td>
                                                <td className="px-2 py-2 text-right whitespace-nowrap">{f.currency_code} {fmt(f.expected_balance)}</td>
                                                <td className="px-2 py-2 text-right">{f.reversed_entries}</td>
                                                <td className="px-2 py-2">
                                                    <OkOrDiff ok={f.ok} />
                                                    {f.differences.map(d => (
                                                        <p key={d.field} className="text-xs text-red-600 mt-1">
                                                            {fieldLabel(d.field)}: stored {fmt(d.stored)}, should be {fmt(d.expected)}
                                                        </p>
                                                    ))}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </Section>

                    {/* 2. Investments */}
                    <Section
                        icon={ChartBarIcon}
                        title="Investments"
                        subtitle={'"Spent" = funding + running costs + tax paid from the investment. "Returns" = income received (a treasury bill counts only its discount; face value repaid with a bond’s final coupon is not income). Reversed entries are left out. Investments recorded before v1.40 did not count running costs as spent, so an older one may show a difference that is only that history.'}
                    >
                        {investments.length === 0 ? (
                            <p className="text-sm text-gray-400 text-center py-6">Nothing to show</p>
                        ) : (
                            <div className="overflow-x-auto -mx-2">
                                <table className="min-w-full text-sm">
                                    <thead>
                                        <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                                            <th className="px-2 py-2 font-medium">Investment</th>
                                            <th className="px-2 py-2 font-medium text-right">Spent (stored / worked out)</th>
                                            <th className="px-2 py-2 font-medium text-right">Returns (stored / worked out)</th>
                                            <th className="px-2 py-2 font-medium text-right">Reversed entries</th>
                                            <th className="px-2 py-2 font-medium">Result</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {investments.map(i => (
                                            <tr key={i.id} className="border-b border-gray-50 last:border-0 align-top">
                                                <td className="px-2 py-2">
                                                    <Link to={`/investments/${i.id}`} className="font-medium text-primary-700 hover:underline">{i.name}</Link>
                                                    <div className="mt-0.5 flex items-center gap-1.5">
                                                        <StatusBadge status={i.status} />
                                                        <span className="text-[11px] text-gray-400">{(i.investment_type || '').replace(/_/g, ' ')}</span>
                                                    </div>
                                                </td>
                                                <td className="px-2 py-2 text-right whitespace-nowrap">
                                                    {i.currency_code} {fmt(i.stored_spent)}
                                                    <div className="text-xs text-gray-400">{fmt(i.expected_spent)}</div>
                                                </td>
                                                <td className="px-2 py-2 text-right whitespace-nowrap">
                                                    {i.currency_code} {fmt(i.stored_returns)}
                                                    <div className="text-xs text-gray-400">{fmt(i.expected_returns)}</div>
                                                </td>
                                                <td className="px-2 py-2 text-right">{i.reversed_entries}</td>
                                                <td className="px-2 py-2"><OkOrDiff ok={i.ok} /></td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </Section>

                    {/* 3. Corrections log */}
                    <Section
                        icon={ClipboardDocumentListIcon}
                        title="Automatic corrections"
                        subtitle={'Every figure the system changed by itself, newest first, with its old and new value. "Needs a look" means it was NOT changed — a person should decide (e.g. only one half of a coupon was reversed in the past; reverse the other half from Transactions if that was the intention).'}
                    >
                        {corrections.length === 0 ? (
                            <p className="text-sm text-gray-400 text-center py-6">No automatic corrections have been made</p>
                        ) : (
                            <div className="overflow-x-auto -mx-2">
                                <table className="min-w-full text-sm">
                                    <thead>
                                        <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                                            <th className="px-2 py-2 font-medium">When</th>
                                            <th className="px-2 py-2 font-medium">Record</th>
                                            <th className="px-2 py-2 font-medium">Figure</th>
                                            <th className="px-2 py-2 font-medium text-right">Was</th>
                                            <th className="px-2 py-2 font-medium text-right">Now</th>
                                            <th className="px-2 py-2 font-medium">Why</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {corrections.map(c => (
                                            <tr key={c.id} className={`border-b border-gray-50 last:border-0 align-top ${c.needs_attention ? 'bg-amber-50' : ''}`}>
                                                <td className="px-2 py-2 text-gray-500 whitespace-nowrap">
                                                    {formatDate(c.created_at)}
                                                    <div className="text-[11px] text-gray-400">{c.run_label}</div>
                                                </td>
                                                <td className="px-2 py-2">
                                                    <p className="text-gray-900">{c.record_name || `#${c.record_id}`}</p>
                                                    <p className="text-xs text-gray-400">{RECORD_LABELS[c.record_type] || c.record_type}</p>
                                                </td>
                                                <td className="px-2 py-2 text-gray-700">{c.field_name ? fieldLabel(c.field_name) : '—'}</td>
                                                <td className="px-2 py-2 text-right whitespace-nowrap text-gray-500">{isNaN(parseFloat(c.old_value)) ? (c.old_value || '—') : fmt(c.old_value)}</td>
                                                <td className="px-2 py-2 text-right whitespace-nowrap font-medium">{isNaN(parseFloat(c.new_value)) ? (c.new_value || '—') : fmt(c.new_value)}</td>
                                                <td className="px-2 py-2 text-xs text-gray-600 max-w-sm">
                                                    {c.needs_attention && (
                                                        <span className="badge-yellow text-xs mr-1.5">Needs a look</span>
                                                    )}
                                                    {c.note}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </Section>
                </>
            )}
        </div>
    );
};

export default RecordChecksPage;
