// ============================================================
// SERVICE FEE AGREEMENT DETAIL PAGE (v1.47.0)
//
// Requested directly: "under service fees, let there be a detail
// page under each agreement that can be accessed by clicking on the
// particular agreements that gives details of how the payments have
// been paid over the time it has been active. in this page one can
// control payments and download the summary of the payments and
// details of the persons the payments have been going to. Any
// adjustments to the service money shows that the effective change
// date and the change history."
//
// Mirrors LoanDetailPage.jsx's structure: a header with the key
// figures, the Record Payment/Amend/Terminate actions relocated here
// from the flat ServiceFeesPage table (same modals, same permission
// gates — nothing new was added, per the clarifying answer this
// should just relocate existing actions), a payment history list, the
// new amendment history (effective date + reason + who changed it,
// per the "effective change date and the change history" ask), and a
// Download Summary button that prints serviceFeeAgreementTemplate.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { serviceFeesAPI, accountsAPI, categoriesAPI, usersAPI } from '../../api/endpoints';
import { formatDate, getErrorMessage } from '../../utils/helpers';
import { printDocument, serviceFeeAgreementTemplate } from '../../utils/exportUtils';
import LoadingSpinner from '../../components/common/LoadingSpinner';
import ErrorMessage from '../../components/common/ErrorMessage';
import StatusBadge from '../../components/common/StatusBadge';
import { useAuth } from '../../contexts/AuthContext';
import {
    CreateAgreementModal, TerminateAgreementModal, RecordPaymentModal,
} from './ServiceFeesPage';
import {
    ArrowLeftIcon, BanknotesIcon, PencilIcon, NoSymbolIcon, ArrowDownTrayIcon,
} from '@heroicons/react/24/outline';

const ServiceFeeAgreementDetailPage = () => {
    const { id } = useParams();
    const navigate = useNavigate();
    const { hasPermission } = useAuth();
    const canManage = hasPermission('SERVICE_FEE_MANAGE');

    const [agreement, setAgreement] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    const [users, setUsers] = useState([]);
    const [accounts, setAccounts] = useState([]);
    const [categories, setCategories] = useState([]);

    const [showAmend, setShowAmend] = useState(false);
    const [showTerminate, setShowTerminate] = useState(false);
    const [showPay, setShowPay] = useState(false);

    const loadAgreement = useCallback(async () => {
        try {
            setLoading(true);
            const res = await serviceFeesAPI.getAgreement(id);
            setAgreement(res.data.data);
            setError(null);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, [id]);

    useEffect(() => { loadAgreement(); }, [loadAgreement]);

    useEffect(() => {
        accountsAPI.getAll().then(r => setAccounts(r.data.data || [])).catch(() => {});
        categoriesAPI.getAll({ flat: true }).then(r => setCategories(r.data.data || [])).catch(() => {});
        if (canManage) {
            usersAPI.getAllUsers({ is_active: true, limit: 500 }).then(r => setUsers(r.data.data || [])).catch(() => {});
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canManage]);

    if (loading) {
        return <LoadingSpinner fullPage text="Loading agreement..." />;
    }

    if (error || !agreement) {
        return (
            <div>
                <button
                    onClick={() => navigate('/service-fees')}
                    className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700 mb-6 transition-colors"
                >
                    <ArrowLeftIcon className="h-4 w-4" />
                    Back to Service Fees
                </button>
                <ErrorMessage message={error || 'Agreement not found'} />
            </div>
        );
    }

    const payments = agreement.payments || [];
    const amendments = agreement.amendments || [];
    const totalPaid = payments.reduce((s, p) => s + parseFloat(p.amount || 0), 0);

    const handleDownload = () => {
        printDocument(
            serviceFeeAgreementTemplate(agreement, payments, amendments),
            `Service Fee Agreement — ${agreement.user_name}`
        );
    };

    return (
        <div>
            <button
                onClick={() => navigate('/service-fees')}
                className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700 mb-6 transition-colors"
            >
                <ArrowLeftIcon className="h-4 w-4" />
                Back to Service Fees
            </button>

            {/* Header */}
            <div className="rounded-xl p-6 mb-6 text-white bg-gradient-to-r from-primary-900 to-primary-700">
                <div className="flex items-start justify-between flex-wrap gap-4">
                    <div>
                        <p className="text-sm opacity-70 font-mono">Agreement #{agreement.id}</p>
                        <h2 className="text-2xl font-bold mt-0.5">{agreement.user_name}</h2>
                        <div className="mt-2 flex items-center gap-2 flex-wrap">
                            <StatusBadge status={agreement.status} />
                            <span className="text-xs opacity-70">Service Fee Agreement</span>
                        </div>
                    </div>
                    <div className="text-right">
                        <p className="text-sm opacity-70">Total Paid To Date</p>
                        <p className="text-3xl font-bold mt-0.5">
                            {agreement.currency_code} {totalPaid.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                        </p>
                    </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-6">
                    <div className="bg-white bg-opacity-10 rounded-lg p-3">
                        <p className="text-xs opacity-70">Current Monthly Amount</p>
                        <p className="text-lg font-bold mt-1">
                            {agreement.currency_code} {parseFloat(agreement.monthly_amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                        </p>
                    </div>
                    <div className="bg-white bg-opacity-10 rounded-lg p-3">
                        <p className="text-xs opacity-70">Paying Account</p>
                        <p className="text-lg font-bold mt-1">{agreement.account_name || '—'}</p>
                    </div>
                    <div className="bg-white bg-opacity-10 rounded-lg p-3">
                        <p className="text-xs opacity-70">Start Date</p>
                        <p className="text-lg font-bold mt-1">{formatDate(agreement.start_date)}</p>
                    </div>
                    <div className="bg-white bg-opacity-10 rounded-lg p-3">
                        <p className="text-xs opacity-70">End Date</p>
                        <p className="text-lg font-bold mt-1">{agreement.end_date ? formatDate(agreement.end_date) : '—'}</p>
                    </div>
                </div>
            </div>

            {/* Actions — relocated from the flat table, same permission
                gates as before (canManage === SERVICE_FEE_MANAGE) */}
            <div className="flex items-center gap-3 mb-6 flex-wrap">
                {agreement.status === 'ACTIVE' && canManage && (
                    <button onClick={() => setShowPay(true)} className="btn-primary flex items-center gap-2">
                        <BanknotesIcon className="h-4 w-4" /> Record Payment
                    </button>
                )}
                {canManage && (
                    <button onClick={() => setShowAmend(true)} className="btn-secondary flex items-center gap-2">
                        <PencilIcon className="h-4 w-4" /> Amend Agreement
                    </button>
                )}
                {agreement.status === 'ACTIVE' && canManage && (
                    <button onClick={() => setShowTerminate(true)}
                        className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium
                            bg-red-50 text-red-600 hover:bg-red-100 transition-colors">
                        <NoSymbolIcon className="h-4 w-4" /> Terminate Agreement
                    </button>
                )}
                <button onClick={handleDownload}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium
                        bg-gray-50 text-gray-500 hover:bg-gray-100 transition-colors">
                    <ArrowDownTrayIcon className="h-4 w-4" /> Download Summary
                </button>
            </div>

            {/* Payment History */}
            <div className="card mb-6">
                <h3 className="section-title mb-4">Payment History</h3>
                {payments.length === 0 ? (
                    <p className="text-sm text-gray-400 text-center py-6">No payments recorded yet</p>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                                    <th className="pb-2 font-medium">Date</th>
                                    <th className="pb-2 font-medium">Reference</th>
                                    <th className="pb-2 font-medium text-right">Amount</th>
                                    <th className="pb-2 font-medium">Paid By</th>
                                    <th className="pb-2 font-medium">Notes</th>
                                </tr>
                            </thead>
                            <tbody>
                                {payments.map(p => (
                                    <tr key={p.id} className="border-b border-gray-50 last:border-0">
                                        <td className="py-2">{formatDate(p.payment_date)}</td>
                                        <td className="py-2 font-mono text-xs text-primary-700">{p.reference_code || '—'}</td>
                                        <td className="py-2 text-right font-semibold text-gray-900">
                                            {agreement.currency_code} {parseFloat(p.amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                                        </td>
                                        <td className="py-2 text-gray-500">{p.paid_by_name || '—'}</td>
                                        <td className="py-2 text-gray-400 text-xs">{p.notes || '—'}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* Amendment History — effective change date + reason for
                every change to the monthly amount, per the request. */}
            <div className="card mb-6">
                <h3 className="section-title mb-4">Monthly Amount Change History</h3>
                {amendments.length === 0 ? (
                    <p className="text-sm text-gray-400 text-center py-6">
                        No changes have been made to the monthly amount since this agreement started.
                    </p>
                ) : (
                    <div className="space-y-2">
                        {amendments.map(a => (
                            <div key={a.id} className="flex items-center justify-between text-sm py-2 border-b border-gray-100 last:border-0">
                                <div>
                                    <p className="text-gray-900">
                                        {agreement.currency_code} {parseFloat(a.previous_amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                                        {' → '}
                                        {agreement.currency_code} {parseFloat(a.new_amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                                    </p>
                                    <p className="text-xs text-gray-400">{a.reason}</p>
                                </div>
                                <div className="text-right">
                                    <p className="text-xs text-gray-500">Effective {formatDate(a.effective_from)}</p>
                                    <p className="text-xs text-gray-400">{a.amended_by_name}</p>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Details Footer */}
            <div className="card">
                <h3 className="section-title mb-4">Agreement Details</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
                    <div>
                        <p className="text-xs text-gray-400">Category</p>
                        <p className="font-medium text-gray-900">{agreement.category_trail || agreement.category_name || '—'}</p>
                    </div>
                    <div>
                        <p className="text-xs text-gray-400">Notes</p>
                        <p className="font-medium text-gray-900">{agreement.notes || '—'}</p>
                    </div>
                    <div>
                        <p className="text-xs text-gray-400">Created By</p>
                        <p className="font-medium text-gray-900">{agreement.created_by_name || '—'}</p>
                    </div>
                    <div>
                        <p className="text-xs text-gray-400">Created At</p>
                        <p className="font-medium text-gray-900">{formatDate(agreement.created_at)}</p>
                    </div>
                </div>
            </div>

            <CreateAgreementModal
                isOpen={showAmend}
                onClose={() => setShowAmend(false)}
                onSuccess={loadAgreement}
                users={users} accounts={accounts} categories={categories}
                editingAgreement={agreement}
            />
            <TerminateAgreementModal
                isOpen={showTerminate}
                agreement={agreement}
                onClose={() => setShowTerminate(false)}
                onSuccess={loadAgreement}
            />
            <RecordPaymentModal
                isOpen={showPay}
                agreement={agreement}
                onClose={() => setShowPay(false)}
                onSuccess={loadAgreement}
            />
        </div>
    );
};

export default ServiceFeeAgreementDetailPage;
