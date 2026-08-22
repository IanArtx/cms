// ============================================================
// LOANS PAGE
// Shows both loans received (company borrows) and
// loans given (company lends) in separate tabs.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { loansAPI, accountsAPI, categoriesAPI } from '../../api/endpoints';
import { formatDate, getErrorMessage } from '../../utils/helpers';
import PageHeader from '../../components/common/PageHeader';
import DataTable from '../../components/common/DataTable';
import ErrorMessage from '../../components/common/ErrorMessage';
import StatusBadge from '../../components/common/StatusBadge';
import { useAuth } from '../../contexts/AuthContext';
import { PlusIcon, CheckIcon, ArrowDownTrayIcon, PencilIcon } from '@heroicons/react/24/outline';
import { loanTemplate, printDocument } from '../../utils/exportUtils';
import DocumentPreviewModal from '../../components/common/DocumentPreviewModal';

const BLANK_LOAN_RECEIVED_FORM = {
    account_id: '', category_id: '', lender_type: 'BANK',
    lender_name: '', lender_contact: '', principal_amount: '',
    fixed_interest_rate: '', penalty_interest_rate: '',
    interest_period: 'MONTHLY', interest_calculation: 'SIMPLE',
    disbursement_date: '', due_date: '', instalments: '',
};

// ============================================================
// CREATE / EDIT LOAN RECEIVED MODAL
// ============================================================
const CreateLoanReceivedModal = ({ isOpen, onClose, onSuccess, accounts, categories, editingRecord }) => {
    const [form, setForm] = useState(BLANK_LOAN_RECEIVED_FORM);
    const [loading, setLoading] = useState(false);
    const [error,   setError]   = useState(null);
    const isEdit = !!editingRecord;

    useEffect(() => {
        if (editingRecord) {
            setForm({
                account_id: editingRecord.account_id || '',
                category_id: editingRecord.category_id || '',
                lender_type: editingRecord.lender_type || 'BANK',
                lender_name: editingRecord.lender_name || '',
                lender_contact: editingRecord.lender_contact || '',
                principal_amount: editingRecord.principal_amount || '',
                fixed_interest_rate: editingRecord.fixed_interest_rate || '',
                penalty_interest_rate: editingRecord.penalty_interest_rate || '',
                interest_period: editingRecord.interest_period || 'MONTHLY',
                interest_calculation: editingRecord.interest_calculation || 'SIMPLE',
                disbursement_date: editingRecord.disbursement_date ? editingRecord.disbursement_date.slice(0, 10) : '',
                due_date: editingRecord.due_date ? editingRecord.due_date.slice(0, 10) : '',
                instalments: '',
            });
        } else {
            setForm(BLANK_LOAN_RECEIVED_FORM);
        }
    }, [editingRecord, isOpen]);

    if (!isOpen) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            const payload = {
                ...form,
                principal_amount:      parseFloat(form.principal_amount),
                fixed_interest_rate:   parseFloat(form.fixed_interest_rate),
                penalty_interest_rate: parseFloat(form.penalty_interest_rate),
                instalments: form.instalments ? parseInt(form.instalments) : undefined,
            };
            if (isEdit) {
                const { account_id, ...editable } = payload;
                await loansAPI.updateReceived(editingRecord.id, editable);
            } else {
                await loansAPI.createReceived(payload);
            }
            onSuccess();
            onClose();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    const financeCategories = categories.filter(c => c.module === 'FINANCE');

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            <div className="fixed inset-0 bg-black bg-opacity-40" onClick={onClose} />
            <div className="flex min-h-full items-center justify-center p-4">
                <div className="relative bg-white rounded-xl shadow-xl
                    max-w-2xl w-full p-6 max-h-screen overflow-y-auto">
                    <h2 className="text-lg font-semibold text-gray-900 mb-4">
                        {isEdit ? 'Edit Loan Received' : 'Record Loan Received'}
                    </h2>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="label">Account *</label>
                                <select className="input" value={form.account_id}
                                    disabled={isEdit}
                                    onChange={e => setForm(p => ({ ...p, account_id: e.target.value }))} required>
                                    <option value="">Select account...</option>
                                    {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                                </select>
                            </div>
                            <div>
                                <label className="label">Category *</label>
                                <select className="input" value={form.category_id}
                                    onChange={e => setForm(p => ({ ...p, category_id: e.target.value }))} required>
                                    <option value="">Select category...</option>
                                    {financeCategories.map(c => (
                                        <option key={c.id} value={c.id}>{c.full_path || c.name}</option>
                                    ))}
                                </select>
                            </div>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="label">Lender Type *</label>
                                <select className="input" value={form.lender_type}
                                    onChange={e => setForm(p => ({ ...p, lender_type: e.target.value }))}>
                                    {['BANK','INSTITUTION','INDIVIDUAL','MEMBER','AUTHORITY','OTHER'].map(t => (
                                        <option key={t} value={t}>{t}</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className="label">Lender Name *</label>
                                <input type="text" className="input" value={form.lender_name}
                                    onChange={e => setForm(p => ({ ...p, lender_name: e.target.value }))} required />
                            </div>
                        </div>
                        <div>
                            <label className="label">Principal Amount *</label>
                            <input type="number" className="input" value={form.principal_amount}
                                onChange={e => setForm(p => ({ ...p, principal_amount: e.target.value }))}
                                min="0.01" step="0.01" required />
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="label">Fixed Interest Rate (%) *</label>
                                <input type="number" className="input" value={form.fixed_interest_rate}
                                    onChange={e => setForm(p => ({ ...p, fixed_interest_rate: e.target.value }))}
                                    min="0" step="0.01" required />
                            </div>
                            <div>
                                <label className="label">Penalty Rate (%) *</label>
                                <input type="number" className="input" value={form.penalty_interest_rate}
                                    onChange={e => setForm(p => ({ ...p, penalty_interest_rate: e.target.value }))}
                                    min="0" step="0.01" required />
                            </div>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="label">Interest Period *</label>
                                <select className="input" value={form.interest_period}
                                    onChange={e => setForm(p => ({ ...p, interest_period: e.target.value }))}>
                                    {['DAILY','WEEKLY','MONTHLY','ANNUALLY'].map(p => (
                                        <option key={p} value={p}>{p}</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className="label">Calculation Method *</label>
                                <select className="input" value={form.interest_calculation}
                                    onChange={e => setForm(p => ({ ...p, interest_calculation: e.target.value }))}>
                                    <option value="SIMPLE">Simple Interest</option>
                                    <option value="COMPOUND">Compound Interest</option>
                                </select>
                            </div>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                            <div>
                                <label className="label">Disbursement Date</label>
                                <input type="date" className="input" value={form.disbursement_date}
                                    max={new Date().toISOString().slice(0, 10)}
                                    onChange={e => setForm(p => ({ ...p, disbursement_date: e.target.value }))} />
                            </div>
                            <div>
                                <label className="label">Due Date *</label>
                                <input type="date" className="input" value={form.due_date}
                                    onChange={e => setForm(p => ({ ...p, due_date: e.target.value }))} required />
                            </div>
                            <div>
                                <label className="label">Instalments</label>
                                <input type="number" className="input" value={form.instalments}
                                    onChange={e => setForm(p => ({ ...p, instalments: e.target.value }))}
                                    min="1" step="1" placeholder={isEdit ? 'Leave blank to keep current' : 'e.g. 12'} />
                            </div>
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading} className="btn-primary">
                                {loading ? 'Saving...' : (isEdit ? 'Save Changes' : 'Create Loan Record')}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

const BLANK_LOAN_GIVEN_FORM = {
    account_id: '', category_id: '', borrower_type: 'INDIVIDUAL',
    borrower_name: '', borrower_contact: '', principal_amount: '',
    fixed_interest_rate: '', penalty_interest_rate: '',
    interest_period: 'MONTHLY', interest_calculation: 'SIMPLE',
    disbursement_date: '', due_date: '', instalments: '',
};

// ============================================================
// CREATE / EDIT LOAN GIVEN MODAL
// ============================================================
const CreateLoanGivenModal = ({ isOpen, onClose, onSuccess, accounts, categories, editingRecord }) => {
    const [form, setForm] = useState(BLANK_LOAN_GIVEN_FORM);
    const [loading, setLoading] = useState(false);
    const [error,   setError]   = useState(null);
    const isEdit = !!editingRecord;

    useEffect(() => {
        if (editingRecord) {
            setForm({
                account_id: editingRecord.account_id || '',
                category_id: editingRecord.category_id || '',
                borrower_type: editingRecord.borrower_type || 'INDIVIDUAL',
                borrower_name: editingRecord.borrower_name || '',
                borrower_contact: editingRecord.borrower_contact || '',
                principal_amount: editingRecord.principal_amount || '',
                fixed_interest_rate: editingRecord.fixed_interest_rate || '',
                penalty_interest_rate: editingRecord.penalty_interest_rate || '',
                interest_period: editingRecord.interest_period || 'MONTHLY',
                interest_calculation: editingRecord.interest_calculation || 'SIMPLE',
                disbursement_date: editingRecord.disbursement_date ? editingRecord.disbursement_date.slice(0, 10) : '',
                due_date: editingRecord.due_date ? editingRecord.due_date.slice(0, 10) : '',
                instalments: '',
            });
        } else {
            setForm(BLANK_LOAN_GIVEN_FORM);
        }
    }, [editingRecord, isOpen]);

    if (!isOpen) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            const payload = {
                ...form,
                principal_amount:      parseFloat(form.principal_amount),
                fixed_interest_rate:   parseFloat(form.fixed_interest_rate),
                penalty_interest_rate: parseFloat(form.penalty_interest_rate),
                instalments: form.instalments ? parseInt(form.instalments) : undefined,
            };
            if (isEdit) {
                const { account_id, ...editable } = payload;
                await loansAPI.updateGiven(editingRecord.id, editable);
            } else {
                await loansAPI.createGiven(payload);
            }
            onSuccess();
            onClose();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    const financeCategories = categories.filter(c => c.module === 'FINANCE');

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            <div className="fixed inset-0 bg-black bg-opacity-40" onClick={onClose} />
            <div className="flex min-h-full items-center justify-center p-4">
                <div className="relative bg-white rounded-xl shadow-xl
                    max-w-2xl w-full p-6 max-h-screen overflow-y-auto">
                    <h2 className="text-lg font-semibold text-gray-900 mb-4">
                        {isEdit ? 'Edit Loan Given' : 'Record Loan Given'}
                    </h2>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="label">Source Account *</label>
                                <select className="input" value={form.account_id}
                                    disabled={isEdit}
                                    onChange={e => setForm(p => ({ ...p, account_id: e.target.value }))} required>
                                    <option value="">Select account...</option>
                                    {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                                </select>
                            </div>
                            <div>
                                <label className="label">Category *</label>
                                <select className="input" value={form.category_id}
                                    onChange={e => setForm(p => ({ ...p, category_id: e.target.value }))} required>
                                    <option value="">Select category...</option>
                                    {financeCategories.map(c => (
                                        <option key={c.id} value={c.id}>{c.full_path || c.name}</option>
                                    ))}
                                </select>
                            </div>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="label">Borrower Type *</label>
                                <select className="input" value={form.borrower_type}
                                    onChange={e => setForm(p => ({ ...p, borrower_type: e.target.value }))}>
                                    {['MEMBER','INDIVIDUAL','INSTITUTION','BANK','AUTHORITY','OTHER'].map(t => (
                                        <option key={t} value={t}>{t}</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className="label">Borrower Name *</label>
                                <input type="text" className="input" value={form.borrower_name}
                                    onChange={e => setForm(p => ({ ...p, borrower_name: e.target.value }))} required />
                            </div>
                        </div>
                        <div>
                            <label className="label">Borrower Contact</label>
                            <input type="text" className="input" value={form.borrower_contact}
                                onChange={e => setForm(p => ({ ...p, borrower_contact: e.target.value }))} />
                        </div>
                        <div>
                            <label className="label">Principal Amount *</label>
                            <input type="number" className="input" value={form.principal_amount}
                                onChange={e => setForm(p => ({ ...p, principal_amount: e.target.value }))}
                                min="0.01" step="0.01" required />
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="label">Fixed Interest Rate (%) *</label>
                                <input type="number" className="input" value={form.fixed_interest_rate}
                                    onChange={e => setForm(p => ({ ...p, fixed_interest_rate: e.target.value }))}
                                    min="0" step="0.01" required />
                            </div>
                            <div>
                                <label className="label">Penalty Rate (%) *</label>
                                <input type="number" className="input" value={form.penalty_interest_rate}
                                    onChange={e => setForm(p => ({ ...p, penalty_interest_rate: e.target.value }))}
                                    min="0" step="0.01" required />
                            </div>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="label">Interest Period *</label>
                                <select className="input" value={form.interest_period}
                                    onChange={e => setForm(p => ({ ...p, interest_period: e.target.value }))}>
                                    {['DAILY','WEEKLY','MONTHLY','ANNUALLY'].map(p => (
                                        <option key={p} value={p}>{p}</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className="label">Calculation Method *</label>
                                <select className="input" value={form.interest_calculation}
                                    onChange={e => setForm(p => ({ ...p, interest_calculation: e.target.value }))}>
                                    <option value="SIMPLE">Simple Interest</option>
                                    <option value="COMPOUND">Compound Interest</option>
                                </select>
                            </div>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                            <div>
                                <label className="label">Disbursement Date</label>
                                <input type="date" className="input" value={form.disbursement_date}
                                    max={new Date().toISOString().slice(0, 10)}
                                    onChange={e => setForm(p => ({ ...p, disbursement_date: e.target.value }))} />
                            </div>
                            <div>
                                <label className="label">Due Date *</label>
                                <input type="date" className="input" value={form.due_date}
                                    onChange={e => setForm(p => ({ ...p, due_date: e.target.value }))} required />
                            </div>
                            <div>
                                <label className="label">Instalments</label>
                                <input type="number" className="input" value={form.instalments}
                                    onChange={e => setForm(p => ({ ...p, instalments: e.target.value }))}
                                    min="1" step="1" placeholder={isEdit ? 'Leave blank to keep current' : 'e.g. 12'} />
                            </div>
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading} className="btn-primary">
                                {loading ? 'Saving...' : (isEdit ? 'Save Changes' : 'Create Loan Record')}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// REPAYMENT MODAL (shared for both loan types — also used by
// LoanDetailPage.jsx, hence the named export below)
// ============================================================
export const RepaymentModal = ({ isOpen, loan, loanType, onClose, onSuccess }) => {
    const [form, setForm] = useState({ amount: '', payment_date: '', notes: '', is_payoff: false });
    const [loading, setLoading] = useState(false);
    const [error,   setError]   = useState(null);

    if (!isOpen || !loan) return null;

    const partyLabel   = loanType === 'received' ? loan.lender_name : loan.borrower_name;
    const actionLabel  = loanType === 'received' ? 'Repayment to' : 'Repayment from';
    const outstandingPrincipal = parseFloat(loan.outstanding_principal || 0);
    const outstandingInterest  = parseFloat(loan.outstanding_interest || 0);
    const outstandingTotal     = outstandingPrincipal + outstandingInterest;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            const payload = form.is_payoff
                ? { payment_date: form.payment_date, notes: form.notes, is_payoff: true }
                : { amount: form.amount, payment_date: form.payment_date, notes: form.notes };
            if (loanType === 'received') {
                await loansAPI.recordRepayment(loan.id, payload);
            } else {
                await loansAPI.recordGivenRepayment(loan.id, payload);
            }
            onSuccess();
            onClose();
            setForm({ amount: '', payment_date: '', notes: '', is_payoff: false });
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            <div className="fixed inset-0 bg-black bg-opacity-40" onClick={onClose} />
            <div className="flex min-h-full items-center justify-center p-4">
                <div className="relative bg-white rounded-xl shadow-xl max-w-md w-full p-6">
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">
                        Record {loanType === 'received' ? 'Repayment Made' : 'Repayment Received'}
                    </h2>
                    <p className="text-sm text-gray-500 mb-1">
                        {actionLabel} {partyLabel}
                    </p>
                    <div className="bg-gray-50 rounded-lg p-3 mb-4 text-sm">
                        <div className="flex justify-between text-gray-500">
                            <span>Outstanding principal</span>
                            <span>{loan.currency_code} {outstandingPrincipal.toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>
                        </div>
                        <div className="flex justify-between text-gray-500">
                            <span>Outstanding interest</span>
                            <span>{loan.currency_code} {outstandingInterest.toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>
                        </div>
                        <div className="flex justify-between font-bold text-gray-900 pt-1 mt-1 border-t border-gray-200">
                            <span>Total outstanding</span>
                            <span>{loan.currency_code} {outstandingTotal.toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>
                        </div>
                    </div>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <label className="flex items-start gap-2 text-sm bg-primary-50 border border-primary-100 rounded-lg p-3 cursor-pointer">
                            <input type="checkbox" className="mt-0.5" checked={form.is_payoff}
                                onChange={e => setForm(p => ({ ...p, is_payoff: e.target.checked }))} />
                            <span>
                                <span className="font-medium text-primary-800">Pay off remaining balance</span>
                                <span className="block text-xs text-primary-600">
                                    Clears principal and interest to exactly zero — the amount is calculated for you.
                                    This is the safe way to close out a loan (paying only the principal shown often
                                    leaves a small remainder that keeps accruing interest).
                                </span>
                            </span>
                        </label>
                        {!form.is_payoff && (
                            <div>
                                <label className="label">Amount *</label>
                                <input type="number" className="input" value={form.amount}
                                    onChange={e => setForm(p => ({ ...p, amount: e.target.value }))}
                                    min="0.01" step="0.01" required={!form.is_payoff} />
                            </div>
                        )}
                        <div>
                            <label className="label">Payment Date *</label>
                            <input type="date" className="input" value={form.payment_date}
                                max={new Date().toISOString().slice(0, 10)}
                                onChange={e => setForm(p => ({ ...p, payment_date: e.target.value }))} required />
                        </div>
                        <div>
                            <label className="label">Notes</label>
                            <textarea className="input" rows={2} value={form.notes}
                                onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} />
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={loading} className="btn-primary">
                                {loading ? 'Recording...' : form.is_payoff ? 'Pay Off Loan' : 'Record Repayment'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// LOANS TABLE (shared for both types)
// ============================================================
const LoansTable = ({
    loans, loading, pagination, onPageChange,
    onApprove, onRepay, onEdit, canEdit, actionLoading,
    hasPermission, loanType, onPreview,
}) => {
    const partyHeader = loanType === 'received' ? 'Lender' : 'Borrower';

    const columns = [
        {
            header: 'Reference',
            render: row => (
                <div>
                    <button
                        onClick={() => onPreview(row)}
                        className="font-mono text-xs font-medium text-primary-700 hover:underline"
                        title="Preview document"
                    >
                        {row.reference_code}
                    </button>
                    {row.public_id && (
                        <div className="font-mono text-[10px] text-gray-400" title="Public ID — searchable">
                            {row.public_id}
                        </div>
                    )}
                </div>
            ),
        },
        {
            header: partyHeader,
            render: row => (
                <div>
                    <Link
                        to={`/loans/${loanType}/${row.id}`}
                        className="text-sm font-medium text-gray-900 hover:text-primary-700
                            hover:underline"
                        title="View loan detail"
                    >
                        {loanType === 'received' ? row.lender_name : row.borrower_name}
                    </Link>
                    <p className="text-xs text-gray-400">
                        {loanType === 'received' ? row.lender_type : row.borrower_type}
                    </p>
                </div>
            ),
        },
        {
            header: 'Principal',
            render: row => (
                <span className="text-sm font-semibold text-gray-900">
                    {row.currency_code}{' '}
                    {parseFloat(row.principal_amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                </span>
            ),
        },
        {
            header: 'Outstanding',
            render: row => (
                <span className={`text-sm font-semibold ${
                    parseFloat(row.outstanding_principal) > 0
                        ? 'text-red-600' : 'text-green-600'
                }`}>
                    {row.currency_code}{' '}
                    {parseFloat(row.outstanding_principal).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                </span>
            ),
        },
        {
            header: 'Interest Rate',
            render: row => (
                <div>
                    <p className="text-sm text-gray-600">
                        Fixed: {row.fixed_interest_rate}%
                    </p>
                    <p className="text-xs text-red-500">
                        Penalty: {row.penalty_interest_rate}%
                    </p>
                </div>
            ),
        },
        {
            header: 'Due Date',
            render: row => (
                <span className={`text-sm ${
                    row.is_overdue ? 'text-red-600 font-semibold' : 'text-gray-600'
                }`}>
                    {formatDate(row.due_date)}
                    {row.is_overdue && ' (OVERDUE)'}
                </span>
            ),
        },
        {
            header: 'Account',
            render: row => (
                <span className="text-xs text-gray-500">{row.account_name}</span>
            ),
        },
        {
            header: 'Status',
            render: row => <StatusBadge status={row.status} />,
        },
        {
            header: 'Actions',
            render: row => (
                <div className="flex gap-2">
                    {canEdit(row) && (
                        <button
                            onClick={() => onEdit(row)}
                            className="p-1.5 rounded-lg bg-blue-50 text-blue-600
                                hover:bg-blue-100 transition-colors"
                            title="Edit"
                        >
                            <PencilIcon className="h-4 w-4" />
                        </button>
                    )}
                    {row.status === 'PENDING' && hasPermission('LOAN_APPROVE') && (
                        <button
                            onClick={() => onApprove(row.id)}
                            disabled={actionLoading === row.id}
                            className="p-1.5 rounded-lg bg-green-50 text-green-600
                                hover:bg-green-100 transition-colors"
                            title="Approve"
                        >
                            <CheckIcon className="h-4 w-4" />
                        </button>
                    )}
                    {['ACTIVE','OVERDUE','PARTIALLY_REPAID'].includes(row.status) &&
                     hasPermission('LOAN_REPAYMENT_RECORD') && (
                        <button
                            onClick={() => onRepay(row)}
                            className="text-xs text-primary-600 hover:text-primary-700
                                font-medium px-2 py-1 rounded border border-primary-200
                                hover:bg-primary-50 transition-colors"
                        >
                            {loanType === 'received' ? 'Repay' : 'Record Receipt'}
                        </button>
                    )}
                    <button
                        onClick={() => printDocument(
                            loanTemplate(row, [], loanType),
                            row.reference_code
                        )}
                        className="p-1.5 rounded-lg bg-gray-50 text-gray-500
                            hover:bg-gray-100 transition-colors"
                        title="Export this loan statement"
                    >
                        <ArrowDownTrayIcon className="h-4 w-4" />
                    </button>
                </div>
            ),
        },
    ];

    return (
        <DataTable
            columns={columns}
            data={loans}
            loading={loading}
            emptyMessage={`No ${loanType === 'received' ? 'loans received' : 'loans given'} found`}
            searchable
            searchPlaceholder="Search loans..."
            pagination={pagination}
            onPageChange={onPageChange}
        />
    );
};

// ============================================================
// MAIN LOANS PAGE
// ============================================================
const LoansPage = () => {
    const { hasPermission, user } = useAuth();

    // Tab state
    const [activeTab, setActiveTab] = useState('received');

    // Shared data
    const [accounts,   setAccounts]   = useState([]);
    const [categories, setCategories] = useState([]);

    // Loans received state
    const [loansReceived,    setLoansReceived]    = useState([]);
    const [paginationRec,    setPaginationRec]    = useState(null);
    const [loadingRec,       setLoadingRec]       = useState(true);
    const [pageRec,          setPageRec]          = useState(1);
    const [showCreateRec,    setShowCreateRec]    = useState(false);
    const [editingRec,       setEditingRec]       = useState(null);
    const [repayLoanRec,     setRepayLoanRec]     = useState(null);
    const [actionLoadingRec, setActionLoadingRec] = useState(null);

    // Loans given state
    const [loansGiven,       setLoansGiven]       = useState([]);
    const [paginationGiv,    setPaginationGiv]    = useState(null);
    const [loadingGiv,       setLoadingGiv]       = useState(true);
    const [pageGiv,          setPageGiv]          = useState(1);
    const [showCreateGiv,    setShowCreateGiv]    = useState(false);
    const [editingGiv,       setEditingGiv]       = useState(null);
    const [repayLoanGiv,     setRepayLoanGiv]     = useState(null);
    const [actionLoadingGiv, setActionLoadingGiv] = useState(null);

    const [error, setError] = useState(null);
    const [preview, setPreview] = useState(null);

    const canEditLoan = (row) =>
        row.status === 'PENDING' &&
        (row.created_by === user?.id || hasPermission('LOAN_APPROVE'));

    const openEditReceived = async (row) => {
        try {
            const res = await loansAPI.getReceivedById(row.id);
            setEditingRec(res.data.data);
            setShowCreateRec(true);
        } catch (err) {
            setError(getErrorMessage(err));
        }
    };

    const openEditGiven = async (row) => {
        try {
            const res = await loansAPI.getGivenById(row.id);
            setEditingGiv(res.data.data);
            setShowCreateGiv(true);
        } catch (err) {
            setError(getErrorMessage(err));
        }
    };

    const closeCreateRec = () => { setShowCreateRec(false); setEditingRec(null); };
    const closeCreateGiv = () => { setShowCreateGiv(false); setEditingGiv(null); };
    const openNewLoan = () => {
        if (activeTab === 'received') {
            setEditingRec(null);
            setShowCreateRec(true);
        } else {
            setEditingGiv(null);
            setShowCreateGiv(true);
        }
    };

    const handlePreview = (row, loanType) => setPreview({
        html: loanTemplate(row, [], loanType),
        title: row.reference_code,
    });

    const loadLoansReceived = useCallback(async () => {
        try {
            setLoadingRec(true);
            const res = await loansAPI.getAllReceived({ page: pageRec, limit: 20 });
            setLoansReceived(res.data.data);
            setPaginationRec(res.data.meta?.pagination);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoadingRec(false);
        }
    }, [pageRec]);

    const loadLoansGiven = useCallback(async () => {
        try {
            setLoadingGiv(true);
            const res = await loansAPI.getAllGiven({ page: pageGiv, limit: 20 });
            setLoansGiven(res.data.data);
            setPaginationGiv(res.data.meta?.pagination);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoadingGiv(false);
        }
    }, [pageGiv]);

    useEffect(() => {
        loadLoansReceived();
        loadLoansGiven();
        accountsAPI.getAll().then(r => setAccounts(r.data.data)).catch(() => {});
        categoriesAPI.getAll({ flat: true }).then(r => setCategories(r.data.data)).catch(() => {});
    }, [loadLoansReceived, loadLoansGiven]);

    const handleApproveReceived = async (id) => {
        setActionLoadingRec(id);
        try {
            await loansAPI.approveReceived(id);
            loadLoansReceived();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setActionLoadingRec(null);
        }
    };

    const handleApproveGiven = async (id) => {
        setActionLoadingGiv(id);
        try {
            await loansAPI.approveGiven(id);
            loadLoansGiven();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setActionLoadingGiv(null);
        }
    };

    return (
        <div>
            <PageHeader
                title="Loans"
                subtitle="Loans received and loans given — full repayment tracking"
                actions={
                    hasPermission('LOAN_CREATE') && (
                        <button
                            onClick={openNewLoan}
                            className="btn-primary flex items-center gap-2"
                        >
                            <PlusIcon className="h-4 w-4" />
                            {activeTab === 'received' ? 'New Loan Received' : 'New Loan Given'}
                        </button>
                    )
                }
            />

            {error && (
                <div className="mb-4">
                    <ErrorMessage message={error} onDismiss={() => setError(null)} />
                </div>
            )}

            {/* Tabs — overflow-x-auto (v1.32.5) so every tab stays reachable
                by scrolling on a narrow screen instead of overflowing with
                no way to reach it. */}
            <div className="flex gap-2 mb-6 overflow-x-auto scrollbar-hidden pb-1">
                <button
                    onClick={() => setActiveTab('received')}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors
                        ${activeTab === 'received'
                            ? 'bg-primary-700 text-white'
                            : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                        }`}
                >
                    Loans Received
                    <span className="ml-2 text-xs opacity-70">
                        ({loansReceived.length})
                    </span>
                </button>
                <button
                    onClick={() => setActiveTab('given')}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors
                        ${activeTab === 'given'
                            ? 'bg-primary-700 text-white'
                            : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                        }`}
                >
                    Loans Given
                    <span className="ml-2 text-xs opacity-70">
                        ({loansGiven.length})
                    </span>
                </button>
            </div>

            {/* Loans Received Tab */}
            {activeTab === 'received' && (
                <LoansTable
                    loans={loansReceived}
                    loading={loadingRec}
                    pagination={paginationRec}
                    onPageChange={setPageRec}
                    onApprove={handleApproveReceived}
                    onRepay={setRepayLoanRec}
                    onEdit={openEditReceived}
                    canEdit={canEditLoan}
                    actionLoading={actionLoadingRec}
                    hasPermission={hasPermission}
                    loanType="received"
                    onPreview={row => handlePreview(row, 'received')}
                />
            )}

            {/* Loans Given Tab */}
            {activeTab === 'given' && (
                <LoansTable
                    loans={loansGiven}
                    loading={loadingGiv}
                    pagination={paginationGiv}
                    onPageChange={setPageGiv}
                    onApprove={handleApproveGiven}
                    onRepay={setRepayLoanGiv}
                    onEdit={openEditGiven}
                    canEdit={canEditLoan}
                    actionLoading={actionLoadingGiv}
                    hasPermission={hasPermission}
                    loanType="given"
                    onPreview={row => handlePreview(row, 'given')}
                />
            )}

            {/* Modals */}
            <CreateLoanReceivedModal
                isOpen={showCreateRec}
                onClose={closeCreateRec}
                onSuccess={loadLoansReceived}
                accounts={accounts}
                categories={categories}
                editingRecord={editingRec}
            />
            <CreateLoanGivenModal
                isOpen={showCreateGiv}
                onClose={closeCreateGiv}
                onSuccess={loadLoansGiven}
                accounts={accounts}
                categories={categories}
                editingRecord={editingGiv}
            />
            <RepaymentModal
                isOpen={!!repayLoanRec}
                loan={repayLoanRec}
                loanType="received"
                onClose={() => setRepayLoanRec(null)}
                onSuccess={loadLoansReceived}
            />
            <RepaymentModal
                isOpen={!!repayLoanGiv}
                loan={repayLoanGiv}
                loanType="given"
                onClose={() => setRepayLoanGiv(null)}
                onSuccess={loadLoansGiven}
            />

            <DocumentPreviewModal preview={preview} onClose={() => setPreview(null)} />
        </div>
    );
};

export default LoansPage;