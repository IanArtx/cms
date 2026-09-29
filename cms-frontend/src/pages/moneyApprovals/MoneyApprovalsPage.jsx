// ============================================================
// AWAITING APPROVAL PAGE (v1.73.0) — /money-approvals
//
// Requested directly: "lets also make the approval rule apply for
// transactions as well for any one that is not the treasurer or admin".
//
// Every money entry recorded by someone who is NOT the Treasurer or an
// Admin (an expense, a contribution, an MMF top-up, a coupon, a loan
// repayment, a tax payment …) waits here. Nothing has been posted yet:
// no balance has changed and no reference number has been used.
//
//   • Treasurer / Admin — see everyone's entries; Approve posts it
//     exactly as if it had just been recorded (same checks; the ledger
//     shows who recorded it and who approved it); Refuse needs a reason.
//     If a check fails when approving (e.g. not enough money on that
//     date) nothing is posted, the reason is shown on the entry and it
//     stays waiting.
//   • Everyone else — sees only their own entries and can Withdraw one
//     that is still waiting.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { moneyApprovalsAPI } from '../../api/endpoints';
import { formatDate, getErrorMessage } from '../../utils/helpers';
import PageHeader from '../../components/common/PageHeader';
import DataTable from '../../components/common/DataTable';
import ErrorMessage from '../../components/common/ErrorMessage';
import StatusBadge from '../../components/common/StatusBadge';
import { useAuth } from '../../contexts/AuthContext';
import { useConfirm } from '../../contexts/ConfirmContext';
import { useTabParam } from '../../hooks/useTabParam';
import { ArrowPathIcon } from '@heroicons/react/24/outline';

const FILTERS = [
    { id: 'PENDING',   label: 'Waiting' },
    { id: 'APPROVED',  label: 'Approved' },
    { id: 'REJECTED',  label: 'Refused' },
    { id: 'WITHDRAWN', label: 'Withdrawn' },
    { id: 'ALL',       label: 'All' },
];

const STATUS_LABEL = { PENDING: 'Waiting', EXECUTING: 'Posting…', APPROVED: 'Approved', REJECTED: 'Refused', WITHDRAWN: 'Withdrawn' };

const fmt = (n) => parseFloat(n).toLocaleString('en-US', { maximumFractionDigits: 2 });

// Readable list of what was typed in, for the "All values entered" view.
const prettyKey = (k) => k.replace(/_id$/, '').replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
const prettyVal = (v) => {
    if (v === null || v === undefined || v === '') return '—';
    if (Array.isArray(v)) return `${v.length} item(s)`;
    if (typeof v === 'object') return JSON.stringify(v);
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    return String(v);
};

const MoneyApprovalsPage = () => {
    const { user } = useAuth();
    const confirm = useConfirm();
    const [filter, setFilter] = useTabParam('PENDING', 'status');
    const [rows, setRows] = useState([]);
    const [canApprove, setCanApprove] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null);
    const [busy, setBusy] = useState(null);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await moneyApprovalsAPI.getAll(filter === 'ALL' ? {} : { status: filter });
            setRows(res.data.data || []);
            setCanApprove(!!res.data.meta?.can_approve);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, [filter]);

    useEffect(() => { load(); }, [load]);

    const run = async (id, fn) => {
        setBusy(id); setNotice(null); setError(null);
        try {
            const res = await fn();
            setNotice(res?.data?.message || null);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setBusy(null);
            load();
        }
    };

    const amountText = (r) => r.amount ? `${r.currency_code ? r.currency_code + ' ' : ''}${fmt(r.amount)}` : 'Worked out when posted';

    const approve = async (r) => {
        const ok = await confirm({
            title: 'Approve and post',
            message: `Post "${r.label}" (${amountText(r)}) recorded by ${r.created_by_name}? The money moves as soon as you confirm.`,
            confirmLabel: 'Approve and post',
        });
        if (ok) run(r.id, () => moneyApprovalsAPI.approve(r.id));
    };
    const refuse = async (r) => {
        const note = await confirm({
            title: 'Refuse entry', message: `Why is "${r.label}" being refused? ${r.created_by_name} will see your reason.`,
            requireInput: true, inputLabel: 'Reason', confirmLabel: 'Refuse', danger: true,
        });
        if (note) run(r.id, () => moneyApprovalsAPI.reject(r.id, { note }));
    };
    const withdraw = async (r) => {
        const ok = await confirm({
            title: 'Withdraw entry', message: `Withdraw "${r.label}"? Nothing will be posted.`,
            confirmLabel: 'Withdraw', danger: true,
        });
        if (ok) run(r.id, () => moneyApprovalsAPI.reject(r.id, {}));
    };

    const columns = [
        {
            header: 'Entry',
            render: r => (
                <div className="min-w-[14rem] max-w-md whitespace-normal">
                    <p className="text-sm font-medium text-gray-900">{r.label}</p>
                    {r.subject && <p className="text-xs text-gray-600">{r.subject}</p>}
                    {r.account_name && <p className="text-xs text-gray-500">Account: {r.account_name}</p>}
                    {r.note && <p className="text-xs text-gray-500 italic">“{r.note}”</p>}
                    <details className="mt-1">
                        <summary className="text-[11px] text-primary-700 cursor-pointer select-none">All values entered</summary>
                        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px] text-gray-600">
                            {Object.entries(r.body || {}).map(([k, v]) => (
                                <div key={k} className="contents">
                                    <dt className="text-gray-400">{prettyKey(k)}</dt>
                                    <dd className="break-all">{prettyVal(v)}</dd>
                                </div>
                            ))}
                        </dl>
                    </details>
                </div>
            ),
        },
        {
            header: 'Amount',
            render: r => (
                <span className={`text-sm whitespace-nowrap ${r.amount ? 'font-semibold text-gray-900' : 'text-gray-400 italic'}`}>
                    {amountText(r)}
                </span>
            ),
        },
        {
            header: 'Recorded',
            render: r => (
                <div className="text-xs text-gray-500">
                    <p className="text-gray-700">{r.created_by_name}</p>
                    <p>{formatDate(r.created_at)}</p>
                </div>
            ),
        },
        {
            header: 'Status',
            render: r => (
                <div className="text-xs text-gray-500 space-y-1 max-w-xs whitespace-normal">
                    <StatusBadge status={r.status === 'EXECUTING' ? 'IN_PROGRESS' : r.status} label={STATUS_LABEL[r.status]} />
                    {r.decided_by_name && r.status !== 'PENDING' && <p>by {r.decided_by_name} · {formatDate(r.decided_at)}</p>}
                    {r.decision_note && <p className="text-red-600">Reason: {r.decision_note}</p>}
                    {r.posted_references?.length > 0 && (
                        <p className="font-mono text-[11px] text-gray-600">{r.posted_references.join(', ')}</p>
                    )}
                    {r.status === 'PENDING' && r.last_error && (
                        <p className="rounded bg-amber-50 border border-amber-200 text-amber-800 p-1.5">
                            Last approval attempt could not post it: {r.last_error}
                        </p>
                    )}
                </div>
            ),
        },
        {
            header: '',
            render: r => {
                if (r.status !== 'PENDING') return null;
                const mine = Number(r.created_by) === Number(user?.id);
                return (
                    <div className="flex flex-col items-stretch gap-1.5 min-w-[6.5rem]">
                        {canApprove && !mine && (
                            <>
                                <button disabled={busy === r.id} onClick={() => approve(r)}
                                    className="btn-primary text-xs px-3 py-1.5">{busy === r.id ? 'Posting…' : 'Approve'}</button>
                                <button disabled={busy === r.id} onClick={() => refuse(r)}
                                    className="btn-secondary text-xs px-3 py-1.5">Refuse</button>
                            </>
                        )}
                        {mine && (
                            <button disabled={busy === r.id} onClick={() => withdraw(r)}
                                className="btn-secondary text-xs px-3 py-1.5">Withdraw</button>
                        )}
                    </div>
                );
            },
        },
    ];

    return (
        <div>
            <PageHeader
                title="Awaiting approval"
                subtitle={canApprove
                    ? 'Money entries recorded by others. Nothing here has been posted yet — approving posts it.'
                    : 'Your money entries waiting for the Treasurer or an Admin. Nothing has been posted yet.'}
                actions={
                    <button onClick={load} className="btn-secondary flex items-center gap-2" disabled={loading}>
                        <ArrowPathIcon className="h-4 w-4" />
                        Refresh
                    </button>
                }
            />

            {error && (
                <div className="mb-4">
                    <ErrorMessage message={error} onDismiss={() => setError(null)} />
                </div>
            )}
            {notice && (
                <div className="mb-4 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">{notice}</div>
            )}

            <div className="flex flex-wrap gap-2 mb-4">
                {FILTERS.map(f => (
                    <button key={f.id} onClick={() => setFilter(f.id)}
                        className={`chip-filter ${filter === f.id ? 'chip-filter-active' : ''}`}>
                        {f.label}
                    </button>
                ))}
            </div>

            <DataTable
                columns={columns}
                data={rows}
                loading={loading}
                emptyMessage={filter === 'PENDING' ? 'Nothing is waiting for approval' : 'No entries'}
            />

            <p className="text-xs text-gray-400 mt-4 max-w-3xl">
                Why entries wait here: money recorded by anyone who is not the Treasurer or an Admin is held until the
                Treasurer or an Admin approves it (the "four eyes" rule). Approving runs the same checks as recording —
                balance on that date, floor limit, dates — so an entry that no longer fits is not posted and stays here with the reason.
            </p>
        </div>
    );
};

export default MoneyApprovalsPage;
