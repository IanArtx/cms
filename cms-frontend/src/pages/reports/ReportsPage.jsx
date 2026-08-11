// ============================================================
// REPORTS PAGE
// Shows financial reports — general and personal.
// Allows on-demand generation and monthly report sending.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { reportsAPI, certificatesAPI } from '../../api/endpoints';
import { formatCurrency, formatDate, getErrorMessage } from '../../utils/helpers';
import PageHeader from '../../components/common/PageHeader';
import ErrorMessage from '../../components/common/ErrorMessage';
import LoadingSpinner from '../../components/common/LoadingSpinner';
import { useAuth } from '../../contexts/AuthContext';
import {
    ChartBarIcon,
    UserIcon,
    PaperAirplaneIcon,
    ArrowPathIcon,
    MegaphoneIcon,
    DocumentTextIcon,
    CheckIcon,
    ChevronDownIcon,
    ChevronUpIcon,
} from '@heroicons/react/24/outline';

// ============================================================
// CERTIFICATE SIGNING ROUNDS PANEL (v1.23.0, Section 4.29)
// Every monthly/annual certificate batch (issued by the buttons
// above, or automatically by the schedule) is grouped into one
// signing round. If Settings -> Signatories has roles configured for
// SHARE_CERTIFICATE, a round stays OPEN — and certificates aren't
// emailed — until every required role signs it. Visible to Treasurer/
// Assistant Treasurer/Admin, same audience as the certificate list
// itself (routes/certificates.js).
// ============================================================
const SigningRoundsPanel = () => {
    const { hasRole } = useAuth();
    const [rounds, setRounds] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [expandedId, setExpandedId] = useState(null);
    const [expandedData, setExpandedData] = useState(null);
    const [expandLoading, setExpandLoading] = useState(false);
    const [signing, setSigning] = useState(false);

    const canSee = hasRole('Treasurer') || hasRole('Assistant Treasurer') || hasRole('Admin');

    const loadRounds = useCallback(async () => {
        try {
            setLoading(true);
            const res = await certificatesAPI.getRounds();
            setRounds(res.data.data || []);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { if (canSee) loadRounds(); }, [canSee, loadRounds]);

    const toggleExpand = async (round) => {
        if (expandedId === round.id) {
            setExpandedId(null);
            setExpandedData(null);
            return;
        }
        setExpandedId(round.id);
        setExpandLoading(true);
        try {
            const res = await certificatesAPI.getRoundById(round.id);
            setExpandedData(res.data.data);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setExpandLoading(false);
        }
    };

    const handleSign = async (roundId) => {
        setError(null);
        setSigning(true);
        try {
            await certificatesAPI.signRound(roundId);
            const res = await certificatesAPI.getRoundById(roundId);
            setExpandedData(res.data.data);
            await loadRounds();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setSigning(false);
        }
    };

    if (!canSee) return null;

    return (
        <div className="card mb-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-1">Certificate Signing Rounds</h3>
            <p className="text-sm text-gray-500 mb-4">
                Each monthly/annual certificate batch is grouped into one round here. If signatories
                are configured (Settings &rarr; Signatories), certificates aren't emailed to shareholders
                until every required role signs the round.
            </p>

            {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}

            {loading ? (
                <LoadingSpinner />
            ) : rounds.length === 0 ? (
                <p className="text-sm text-gray-400">No certificate rounds yet.</p>
            ) : (
                <div className="space-y-2">
                    {rounds.map(round => {
                        const isExpanded = expandedId === round.id;
                        const mySlot = isExpanded && expandedData?.signatures?.find(
                            s => s.status === 'PENDING' && hasRole(s.role_name)
                        );
                        return (
                            <div key={round.id} className="border border-gray-200 rounded-lg">
                                <button
                                    onClick={() => toggleExpand(round)}
                                    className="w-full flex items-center justify-between p-3 text-left"
                                >
                                    <div>
                                        <span className="text-sm font-medium text-gray-900">
                                            {round.certificate_type === 'ANNUAL' ? 'Annual' : 'Monthly'} — {round.period_label}
                                        </span>
                                        <span className="text-xs text-gray-400 ml-2">
                                            {round.certificate_count} certificate(s)
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                                            round.status === 'FULLY_SIGNED'
                                                ? 'bg-green-100 text-green-700'
                                                : 'bg-amber-100 text-amber-700'
                                        }`}>
                                            {round.status === 'FULLY_SIGNED' ? 'Fully signed' : 'Open'}
                                        </span>
                                        {isExpanded
                                            ? <ChevronUpIcon className="h-4 w-4 text-gray-400" />
                                            : <ChevronDownIcon className="h-4 w-4 text-gray-400" />
                                        }
                                    </div>
                                </button>

                                {isExpanded && (
                                    <div className="border-t border-gray-100 p-3">
                                        {expandLoading ? (
                                            <p className="text-xs text-gray-400">Loading...</p>
                                        ) : expandedData?.signatures?.length === 0 ? (
                                            <p className="text-xs text-gray-400">
                                                No signature requirement configured for Share Certificates
                                                (Settings &rarr; Signatories) — this round emailed immediately.
                                            </p>
                                        ) : (
                                            <div className="space-y-2 mb-3">
                                                {expandedData?.signatures?.map(sig => (
                                                    <div key={sig.role_id} className="flex items-center justify-between text-sm">
                                                        <span className="text-gray-700">
                                                            {sig.role_name}
                                                            {sig.signer_name && (
                                                                <span className="text-gray-400"> — {sig.signer_name}</span>
                                                            )}
                                                        </span>
                                                        {sig.status === 'SIGNED' ? (
                                                            sig.signature_url
                                                                ? <img src={sig.signature_url} alt="Signature" className="h-6" />
                                                                : <CheckIcon className="h-4 w-4 text-green-600" />
                                                        ) : (
                                                            <span className="text-xs font-medium text-amber-600">Pending</span>
                                                        )}
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                        {expandedData?.stamps?.length > 0 && (
                                            <div className="mb-3">
                                                <p className="text-xs text-gray-400 mb-1">Company stamp applied</p>
                                                <div className="flex flex-wrap gap-3">
                                                    {expandedData.stamps.map(stamp => (
                                                        <div key={stamp.stamp_id} className="flex flex-col items-center gap-1">
                                                            <img src={stamp.file_path} alt={stamp.name} className="h-10 w-10 object-contain" />
                                                            <span className="text-xs text-gray-500">{stamp.name}</span>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                        {mySlot && (
                                            <button
                                                onClick={() => handleSign(round.id)}
                                                disabled={signing}
                                                className="btn-primary text-xs"
                                            >
                                                {signing ? 'Signing...' : `Sign as ${mySlot.role_name}`}
                                            </button>
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

// ============================================================
// REPORT PERIOD SELECTOR
// ============================================================
const PeriodSelector = ({ year, month, onYearChange, onMonthChange }) => {
    const currentYear = new Date().getFullYear();
    const years = Array.from({ length: 5 }, (_, i) => currentYear - i);
    const months = [
        { value: 1,  label: 'January' },
        { value: 2,  label: 'February' },
        { value: 3,  label: 'March' },
        { value: 4,  label: 'April' },
        { value: 5,  label: 'May' },
        { value: 6,  label: 'June' },
        { value: 7,  label: 'July' },
        { value: 8,  label: 'August' },
        { value: 9,  label: 'September' },
        { value: 10, label: 'October' },
        { value: 11, label: 'November' },
        { value: 12, label: 'December' },
    ];

    return (
        <div className="flex items-center gap-3">
            <select className="input w-32" value={month} onChange={e => onMonthChange(parseInt(e.target.value))}>
                {months.map(m => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                ))}
            </select>
            <select className="input w-28" value={year} onChange={e => onYearChange(parseInt(e.target.value))}>
                {years.map(y => (
                    <option key={y} value={y}>{y}</option>
                ))}
            </select>
        </div>
    );
};

// ============================================================
// ACCOUNT BALANCE CARD
// ============================================================
const AccountBalanceCard = ({ account }) => (
    <div className="bg-gray-50 rounded-lg p-4">
        <div className="flex justify-between items-start">
            <div>
                <p className="text-sm font-medium text-gray-700">{account.name}</p>
                <p className="text-xs text-gray-400">{account.account_type}</p>
            </div>
            <div className="text-right">
                <p className="text-lg font-bold text-gray-900">
                    {account.currency_code}{' '}
                    {parseFloat(account.current_balance).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                </p>
                <p className="text-xs text-gray-500">
                    Available: {account.currency_code}{' '}
                    {parseFloat(account.available_balance).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                </p>
            </div>
        </div>
        {account.floor_limit && (
            <div className="mt-2 pt-2 border-t border-gray-200">
                <p className="text-xs text-gray-500">
                    Floor limit: {account.currency_code}{' '}
                    {parseFloat(account.floor_limit).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                </p>
            </div>
        )}
    </div>
);

// ============================================================
// INCOME ROW
// ============================================================
const IncomeRow = ({ item }) => (
    <div className="flex justify-between items-center py-2 border-b
        border-gray-100 last:border-0">
        <span className="text-sm text-gray-600">
            {item.inflow_type.replace(/_/g, ' ')}
        </span>
        <div className="text-right">
            <span className="text-sm font-semibold text-green-600">
                +{item.currency_code}{' '}
                {parseFloat(item.total_amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}
            </span>
            <span className="text-xs text-gray-400 ml-2">
                ({item.transaction_count} transactions)
            </span>
        </div>
    </div>
);

// ============================================================
// EXPENSE ROW
// ============================================================
const ExpenseRow = ({ item }) => (
    <div className="flex justify-between items-center py-2 border-b
        border-gray-100 last:border-0">
        <div>
            <p className="text-sm text-gray-600">{item.category_name}</p>
            <p className="text-xs text-gray-400">{item.category_trail}</p>
        </div>
        <div className="text-right">
            <span className="text-sm font-semibold text-red-600">
                -{item.currency_code}{' '}
                {parseFloat(item.total_amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}
            </span>
        </div>
    </div>
);

// ============================================================
// MAIN REPORTS PAGE
// ============================================================
const ReportsPage = () => {
    const { user, hasPermission } = useAuth();
    const currentDate = new Date();

    const [year,  setYear]  = useState(currentDate.getFullYear());
    const [month, setMonth] = useState(currentDate.getMonth() + 1);

    const [generalReport,    setGeneralReport]    = useState(null);
    const [individualReport, setIndividualReport] = useState(null);
    const [activeTab,        setActiveTab]        = useState('general');
    const [loading,          setLoading]          = useState(false);
    const [sending,          setSending]          = useState(false);
    const [error,            setError]            = useState(null);
    const [successMsg,       setSuccessMsg]       = useState(null);

    const [showAnnounceModal, setShowAnnounceModal] = useState(false);
    const [announceSubject,   setAnnounceSubject]   = useState('');
    const [announceMessage,   setAnnounceMessage]   = useState('');
    const [announceLink,      setAnnounceLink]      = useState('');
    const [announcing,        setAnnouncing]        = useState(false);
    const [issuingCert,       setIssuingCert]       = useState(null); // 'MONTHLY' | 'ANNUAL' | null

    // --------------------------------------------------------
    // LOAD GENERAL REPORT
    // --------------------------------------------------------
    const loadGeneralReport = async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await reportsAPI.getGeneral({ year, month });
            setGeneralReport(res.data.data);
            setActiveTab('general');
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    // --------------------------------------------------------
    // LOAD PERSONAL REPORT
    // --------------------------------------------------------
    const loadMyReport = async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await reportsAPI.getMyReport({ year, month });
            setIndividualReport(res.data.data);
            setActiveTab('individual');
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    // --------------------------------------------------------
    // SEND MONTHLY REPORTS
    // --------------------------------------------------------
    const sendMonthlyReports = async () => {
        if (!window.confirm(
            `Send monthly reports for ${month}/${year} to all members?`
        )) return;

        setSending(true);
        setError(null);
        try {
            const res = await reportsAPI.sendMonthly({ year, month });
            const { general_report, individual_reports } = res.data.data;
            setSuccessMsg(
                `Reports sent successfully. General: ${general_report.sent} sent. ` +
                `Individual: ${individual_reports.sent} sent.`
            );
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setSending(false);
        }
    };

    // --------------------------------------------------------
    // ISSUE CERTIFICATES NOW
    // Runs the exact same pipeline the monthly/annual schedule
    // runs automatically — issues + emails every active
    // shareholder a Certificate of Shares right now.
    // --------------------------------------------------------
    const issueCertificatesNow = async (certificateType) => {
        const label = certificateType === 'ANNUAL' ? 'annual' : 'monthly';
        if (!window.confirm(
            `Issue and email a ${label} Certificate of Shares to every active shareholder now?`
        )) return;

        setIssuingCert(certificateType);
        setError(null);
        try {
            const res = await certificatesAPI.issueNow({ certificate_type: certificateType });
            const { issued, emailed, total, requiresSignatures } = res.data.data;
            setSuccessMsg(
                requiresSignatures
                    ? `Certificates issued: ${issued}/${total}. Waiting on signatures before emailing — see Certificate Signing Rounds below.`
                    : `Certificates issued: ${issued}/${total}. Emailed: ${emailed}.`
            );
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setIssuingCert(null);
        }
    };

    // --------------------------------------------------------
    // SEND GENERAL ANNOUNCEMENT
    // --------------------------------------------------------
    const sendAnnouncement = async () => {
        if (!announceSubject.trim() || !announceMessage.trim()) {
            setError('Subject and message are required');
            return;
        }

        setAnnouncing(true);
        setError(null);
        try {
            const res = await reportsAPI.sendBroadcast({
                subject: announceSubject.trim(),
                message: announceMessage.trim(),
                link:    announceLink.trim() || undefined,
            });
            const { sent, recipients } = res.data.data;
            setSuccessMsg(`Announcement sent to ${sent} of ${recipients} member(s).`);
            setShowAnnounceModal(false);
            setAnnounceSubject('');
            setAnnounceMessage('');
            setAnnounceLink('');
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setAnnouncing(false);
        }
    };

    return (
        <div>
            <PageHeader
                title="Reports"
                subtitle="Financial reports — general company and personal"
            />

            {error && (
                <div className="mb-4">
                    <ErrorMessage message={error} onDismiss={() => setError(null)} />
                </div>
            )}

            {successMsg && (
                <div className="mb-4 bg-green-50 border border-green-200
                    rounded-lg p-4 text-sm text-green-700">
                    {successMsg}
                    <button onClick={() => setSuccessMsg(null)}
                        className="ml-2 text-green-500 hover:text-green-700">
                        ✕
                    </button>
                </div>
            )}

            {/* Controls */}
            <div className="card mb-6">
                <div className="flex flex-wrap items-center gap-4">
                    <PeriodSelector
                        year={year} month={month}
                        onYearChange={setYear} onMonthChange={setMonth}
                    />

                    <div className="flex gap-2 flex-wrap">
                        {hasPermission('REPORT_VIEW_ALL') && (
                            <button
                                onClick={loadGeneralReport}
                                disabled={loading}
                                className="btn-primary flex items-center gap-2"
                            >
                                <ChartBarIcon className="h-4 w-4" />
                                General Report
                            </button>
                        )}

                        <button
                            onClick={loadMyReport}
                            disabled={loading}
                            className="btn-secondary flex items-center gap-2"
                        >
                            <UserIcon className="h-4 w-4" />
                            My Report
                        </button>

                        {hasPermission('SYSTEM_CONFIG') && (
                            <button
                                onClick={sendMonthlyReports}
                                disabled={sending}
                                className="flex items-center gap-2 px-4 py-2 rounded-lg
                                    bg-green-600 text-white font-medium hover:bg-green-700
                                    transition-colors disabled:opacity-50"
                            >
                                {sending
                                    ? <ArrowPathIcon className="h-4 w-4 animate-spin" />
                                    : <PaperAirplaneIcon className="h-4 w-4" />
                                }
                                {sending ? 'Sending...' : 'Send to All Members'}
                            </button>
                        )}

                        {hasPermission('SYSTEM_CONFIG') && (
                            <button
                                onClick={() => setShowAnnounceModal(true)}
                                className="flex items-center gap-2 px-4 py-2 rounded-lg
                                    bg-primary-700 text-white font-medium hover:bg-primary-800
                                    transition-colors"
                            >
                                <MegaphoneIcon className="h-4 w-4" />
                                Send Announcement
                            </button>
                        )}

                        {hasPermission('SYSTEM_CONFIG') && (
                            <button
                                onClick={() => issueCertificatesNow('MONTHLY')}
                                disabled={issuingCert !== null}
                                className="flex items-center gap-2 px-4 py-2 rounded-lg
                                    bg-teal-600 text-white font-medium hover:bg-teal-700
                                    transition-colors disabled:opacity-50"
                            >
                                {issuingCert === 'MONTHLY'
                                    ? <ArrowPathIcon className="h-4 w-4 animate-spin" />
                                    : <DocumentTextIcon className="h-4 w-4" />
                                }
                                {issuingCert === 'MONTHLY' ? 'Issuing...' : 'Issue Monthly Certificates'}
                            </button>
                        )}

                        {hasPermission('SYSTEM_CONFIG') && (
                            <button
                                onClick={() => issueCertificatesNow('ANNUAL')}
                                disabled={issuingCert !== null}
                                className="flex items-center gap-2 px-4 py-2 rounded-lg
                                    bg-teal-800 text-white font-medium hover:bg-teal-900
                                    transition-colors disabled:opacity-50"
                            >
                                {issuingCert === 'ANNUAL'
                                    ? <ArrowPathIcon className="h-4 w-4 animate-spin" />
                                    : <DocumentTextIcon className="h-4 w-4" />
                                }
                                {issuingCert === 'ANNUAL' ? 'Issuing...' : 'Issue Annual Certificates'}
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {/* ANNOUNCEMENT MODAL */}
            {showAnnounceModal && (
                <div className="fixed inset-0 bg-black/40 flex items-center
                    justify-center z-50 p-4">
                    <div className="bg-white rounded-lg shadow-xl w-full max-w-lg p-6">
                        <h3 className="text-lg font-bold text-gray-900 mb-1">
                            Send General Announcement
                        </h3>
                        <p className="text-sm text-gray-500 mb-4">
                            Sent by email and notification bell to every active member —
                            use this for general meeting notices and company-wide updates.
                        </p>

                        <div className="space-y-3">
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">
                                    Subject
                                </label>
                                <input
                                    type="text"
                                    className="input w-full"
                                    value={announceSubject}
                                    onChange={e => setAnnounceSubject(e.target.value)}
                                    placeholder="e.g. Annual General Meeting — Notice"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">
                                    Message
                                </label>
                                <textarea
                                    className="input w-full"
                                    rows={5}
                                    value={announceMessage}
                                    onChange={e => setAnnounceMessage(e.target.value)}
                                    placeholder="Details of the meeting or announcement..."
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">
                                    Link (optional)
                                </label>
                                <input
                                    type="text"
                                    className="input w-full"
                                    value={announceLink}
                                    onChange={e => setAnnounceLink(e.target.value)}
                                    placeholder="/events/12"
                                />
                            </div>
                        </div>

                        <div className="flex justify-end gap-2 mt-6">
                            <button
                                onClick={() => setShowAnnounceModal(false)}
                                disabled={announcing}
                                className="btn-secondary"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={sendAnnouncement}
                                disabled={announcing}
                                className="flex items-center gap-2 px-4 py-2 rounded-lg
                                    bg-primary-700 text-white font-medium hover:bg-primary-800
                                    transition-colors disabled:opacity-50"
                            >
                                {announcing
                                    ? <ArrowPathIcon className="h-4 w-4 animate-spin" />
                                    : <PaperAirplaneIcon className="h-4 w-4" />
                                }
                                {announcing ? 'Sending...' : 'Send Announcement'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Certificate Signing Rounds (v1.23.0, Section 4.29) */}
            <SigningRoundsPanel />

            {/* Loading */}
            {loading && (
                <div className="flex justify-center py-12">
                    <LoadingSpinner size="lg" text="Generating report..." />
                </div>
            )}

            {/* GENERAL REPORT */}
            {!loading && generalReport && activeTab === 'general' && (
                <div className="space-y-6">
                    <div className="flex items-center justify-between">
                        <div>
                            <h2 className="text-xl font-bold text-gray-900">
                                General Company Report — {generalReport.period}
                            </h2>
                            {generalReport.fiscal_quarter && (
                                <span className="inline-block mt-1 text-xs font-medium text-primary-700
                                    bg-primary-50 px-2 py-0.5 rounded-full">
                                    {generalReport.fiscal_quarter.label}
                                </span>
                            )}
                        </div>
                        <span className="text-sm text-gray-400">
                            Generated {new Date(generalReport.generated_at)
                                .toLocaleString('en-GB')}
                        </span>
                    </div>

                    {/* Account Balances */}
                    <div className="card">
                        <h3 className="section-title mb-4">Account Balances</h3>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            {generalReport.accounts.map((a, i) => (
                                <AccountBalanceCard key={i} account={a} />
                            ))}
                        </div>
                    </div>

                    {/* Income and Expenses */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div className="card">
                            <h3 className="section-title mb-4">
                                Income This Period
                            </h3>
                            {generalReport.income.length === 0 ? (
                                <p className="text-sm text-gray-400">No income this period</p>
                            ) : (
                                generalReport.income.map((item, i) => (
                                    <IncomeRow key={i} item={item} />
                                ))
                            )}
                        </div>

                        <div className="card">
                            <h3 className="section-title mb-4">
                                Expenses This Period
                            </h3>
                            {generalReport.expenses.length === 0 ? (
                                <p className="text-sm text-gray-400">No expenses this period</p>
                            ) : (
                                generalReport.expenses.map((item, i) => (
                                    <ExpenseRow key={i} item={item} />
                                ))
                            )}
                        </div>
                    </div>

                    {/* Loans */}
                    {generalReport.loans.length > 0 && (
                        <div className="card">
                            <h3 className="section-title mb-4">Active Loans</h3>
                            <div className="space-y-2">
                                {generalReport.loans.map((loan, i) => (
                                    <div key={i} className="flex justify-between
                                        items-center py-2 border-b border-gray-100 last:border-0">
                                        <div>
                                            <p className="text-sm font-medium text-gray-900">
                                                {loan.lender_name}
                                            </p>
                                            <p className="text-xs text-gray-400">
                                                Due: {formatDate(loan.due_date)}
                                                {loan.is_overdue &&
                                                    <span className="text-red-500 ml-1">
                                                        OVERDUE
                                                    </span>
                                                }
                                            </p>
                                        </div>
                                        <div className="text-right">
                                            <p className="text-sm font-semibold text-gray-900">
                                                {loan.currency_code}{' '}
                                                {parseFloat(loan.principal_amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                                            </p>
                                            <p className="text-xs text-red-500">
                                                Outstanding:{' '}
                                                {parseFloat(loan.outstanding_principal).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                                            </p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Investments */}
                    {generalReport.investments.length > 0 && (
                        <div className="card">
                            <h3 className="section-title mb-4">
                                Investment Portfolio
                            </h3>
                            <div className="space-y-2">
                                {generalReport.investments.map((inv, i) => (
                                    <div key={i} className="flex justify-between
                                        items-center py-2 border-b border-gray-100 last:border-0">
                                        <div>
                                            <p className="text-sm font-medium text-gray-900">
                                                {inv.name}
                                            </p>
                                            <p className="text-xs text-gray-400">
                                                {inv.project_count} project(s)
                                            </p>
                                        </div>
                                        <div className="text-right">
                                            <p className="text-sm font-semibold text-gray-900">
                                                Budget: {inv.currency_code}{' '}
                                                {parseFloat(inv.planned_budget).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                                            </p>
                                            <p className={`text-xs font-medium ${
                                                parseFloat(inv.roi_percentage) >= 0
                                                    ? 'text-green-600' : 'text-red-600'
                                            }`}>
                                                ROI: {inv.roi_percentage}%
                                            </p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Upcoming Events */}
                    {generalReport.upcoming_events.length > 0 && (
                        <div className="card">
                            <h3 className="section-title mb-4">
                                Upcoming Events (Next 30 Days)
                            </h3>
                            <div className="space-y-2">
                                {generalReport.upcoming_events.map((event, i) => (
                                    <div key={i} className="flex justify-between
                                        items-center py-2 border-b border-gray-100 last:border-0">
                                        <div>
                                            <p className="text-sm font-medium text-gray-900">
                                                {event.title}
                                            </p>
                                            <p className="text-xs text-gray-400">
                                                {event.event_type}
                                                {event.location && ` • ${event.location}`}
                                            </p>
                                        </div>
                                        <span className="text-sm text-gray-600">
                                            {formatDate(event.event_date)}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* INDIVIDUAL REPORT */}
            {!loading && individualReport && activeTab === 'individual' && (
                <div className="space-y-6">
                    <div className="flex items-center justify-between">
                        <div>
                            <h2 className="text-xl font-bold text-gray-900">
                                Personal Report — {individualReport.period}
                            </h2>
                            {individualReport.fiscal_quarter && (
                                <span className="inline-block mt-1 text-xs font-medium text-primary-700
                                    bg-primary-50 px-2 py-0.5 rounded-full">
                                    {individualReport.fiscal_quarter.label}
                                </span>
                            )}
                        </div>
                    </div>

                    {/* Member Details */}
                    <div className="card">
                        <h3 className="section-title mb-4">Member Details</h3>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                            <div>
                                <p className="text-xs text-gray-400">Name</p>
                                <p className="text-sm font-medium text-gray-900">
                                    {individualReport.member.first_name}{' '}
                                    {individualReport.member.last_name}
                                </p>
                            </div>
                            <div>
                                <p className="text-xs text-gray-400">Email</p>
                                <p className="text-sm text-gray-900">
                                    {individualReport.member.email}
                                </p>
                            </div>
                            <div>
                                <p className="text-xs text-gray-400">Roles</p>
                                <p className="text-sm text-gray-900">
                                    {Array.isArray(individualReport.member.roles)
                                        ? individualReport.member.roles.join(', ')
                                        : individualReport.member.roles
                                    }
                                </p>
                            </div>
                            {individualReport.shareholding && (
                                <div>
                                    <p className="text-xs text-gray-400">Shareholding</p>
                                    <p className="text-sm font-bold text-primary-700">
                                        {individualReport.shareholding.percentage || '—'}%
                                    </p>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Total Contributions */}
                    <div className="card">
                        <h3 className="section-title mb-2">Contribution Summary</h3>
                        <p className="text-3xl font-bold text-gray-900">
                            EUR {parseFloat(individualReport.total_contributed).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                        </p>
                        <p className="text-sm text-gray-400 mt-1">Total contributed all time</p>
                    </div>

                    {/* Contributions This Period */}
                    <div className="card">
                        <h3 className="section-title mb-4">
                            Contributions This Period
                        </h3>
                        {individualReport.contributions_period.length === 0 ? (
                            <p className="text-sm text-gray-400">
                                No contributions this period
                            </p>
                        ) : (
                            <div className="space-y-2">
                                {individualReport.contributions_period.map((c, i) => (
                                    <div key={i} className="flex justify-between
                                        items-center py-2 border-b border-gray-100 last:border-0">
                                        <div>
                                            <p className="font-mono text-xs text-primary-700">
                                                {c.reference_code}
                                            </p>
                                            <p className="text-xs text-gray-400">
                                                {c.category_trail}
                                            </p>
                                        </div>
                                        <div className="text-right">
                                            <p className="text-sm font-semibold text-green-600">
                                                EUR {parseFloat(c.amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}
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
                </div>
            )}

            {/* Empty state */}
            {!loading && !generalReport && !individualReport && (
                <div className="card text-center py-12">
                    <ChartBarIcon className="h-12 w-12 text-gray-300 mx-auto mb-4" />
                    <p className="text-gray-500 font-medium">No report loaded</p>
                    <p className="text-sm text-gray-400 mt-1">
                        Select a period and click a report button above
                    </p>
                </div>
            )}
        </div>
    );
};

export default ReportsPage;