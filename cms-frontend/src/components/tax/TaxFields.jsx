// ============================================================
// TAX FIELDS FOR EXPENSE / INFLOW FORMS (v1.70.0)
//
// ExpenseTaxFields — how the expense is treated for corporate tax
//   (category default / deductible / not deductible / capital), and,
//   for a payment to a supplier or service provider, who was paid and
//   whether withholding tax applies. The preview shows what will
//   happen: 6% SHADOW while the company is not a designated
//   withholding agent (full amount paid, nothing held back), real 6%
//   once designated (only the net is paid), 15% for a non-resident, or
//   nothing below the UGX 1,000,000 threshold.
//
// InflowTaxFields — income received net of tax the payer kept back
//   (e.g. bank interest): the amount entered is then the GROSS income,
//   and the tax is recorded as FINAL or CREDITABLE.
//
// Both edit the parent form's fields through setForm; field names match
// the backend (POST /transactions/expenses, /transactions/inflows).
// ============================================================

import { useState, useEffect } from 'react';
import { taxAPI } from '../../api/endpoints';

const fmt = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 }));

export const ExpenseTaxFields = ({ form, setForm, currencyCode }) => {
    const [preview, setPreview] = useState(null);
    const isSupplier = !!form.is_supplier_payment;
    const nonResident = form.payee_residency === 'NON_RESIDENT';

    useEffect(() => {
        setPreview(null);
        if (!isSupplier || !form.apply_wht || !(parseFloat(form.amount) > 0) || !currencyCode) return undefined;
        const t = setTimeout(() => {
            taxAPI.previewWithholding({
                payment_type: nonResident ? 'NON_RESIDENT_SERVICE' : 'SUPPLIER',
                residency: nonResident ? 'NON_RESIDENT' : 'RESIDENT',
                gross: form.amount, currency_code: currencyCode, date: form.value_date || undefined,
            }).then(res => setPreview(res.data.data)).catch(() => setPreview(null));
        }, 350);
        return () => clearTimeout(t);
    }, [isSupplier, form.apply_wht, form.amount, form.value_date, currencyCode, nonResident]);

    const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

    return (
        <div className="border border-gray-200 rounded-lg p-3 space-y-3 bg-gray-50">
            <div>
                <label className="label">Tax treatment</label>
                <select className="input" value={form.tax_treatment || ''} onChange={e => set('tax_treatment', e.target.value)}>
                    <option value="">As set on the category (usually deductible)</option>
                    <option value="DEDUCTIBLE">Deductible — reduces taxable profit</option>
                    <option value="NOT_DEDUCTIBLE">Not deductible — fines, entertainment, personal costs…</option>
                    <option value="CAPITAL">Capital — equipment or other asset (capital allowances instead)</option>
                </select>
            </div>
            <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={isSupplier} onChange={e => setForm(p => ({ ...p, is_supplier_payment: e.target.checked, apply_wht: e.target.checked }))} />
                Payment to a supplier / service provider
            </label>
            {isSupplier && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="sm:col-span-2"><label className="label">Paid to *</label>
                        <input className="input" value={form.payee_name || ''} onChange={e => set('payee_name', e.target.value)} placeholder="Supplier name" required /></div>
                    <div><label className="label">Their TIN</label>
                        <input className="input" value={form.payee_tin || ''} onChange={e => set('payee_tin', e.target.value)} /></div>
                    <div><label className="label">Resident in Uganda?</label>
                        <select className="input" value={form.payee_residency || 'RESIDENT'} onChange={e => set('payee_residency', e.target.value)}>
                            <option value="RESIDENT">Resident</option><option value="NON_RESIDENT">Non-resident (15% on fees)</option>
                        </select></div>
                    <label className="flex items-center gap-2 text-sm sm:col-span-2">
                        <input type="checkbox" checked={!!form.apply_wht} onChange={e => set('apply_wht', e.target.checked)} />
                        Subject to withholding tax
                    </label>
                    {form.apply_wht && preview && (
                        <div className={`sm:col-span-2 text-xs rounded p-2 ${!preview.applies ? 'bg-white text-gray-600' : preview.isShadow ? 'bg-amber-50 text-amber-900' : 'bg-blue-50 text-blue-900'}`}>
                            {!preview.applies
                                ? (preview.note || 'Nothing to withhold.')
                                : preview.isShadow
                                    ? <>SHADOW: {preview.rate}% = {currencyCode} {fmt(preview.tax)} would be withheld if the company were a designated agent. It is recorded for reference only — the full amount is paid.</>
                                    : <>{preview.rate}% = {currencyCode} {fmt(preview.tax)} is withheld: only {currencyCode} {fmt(preview.net)} is paid now; the tax is paid to URA by the 15th of next month and a certificate is issued.</>}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export const InflowTaxFields = ({ form, setForm }) => {
    const set = (k, v) => setForm(p => ({ ...p, [k]: v }));
    const taxed = !!form.has_tax_deducted;
    return (
        <div className="border border-gray-200 rounded-lg p-3 space-y-3 bg-gray-50">
            <div>
                <label className="label">Kind of income</label>
                <select className="input" value={form.income_type || 'OTHER_INCOME'} onChange={e => set('income_type', e.target.value)}>
                    <option value="OTHER_INCOME">Other income</option>
                    <option value="INTEREST_IN">Interest (e.g. from a bank)</option>
                </select>
            </div>
            <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={taxed} onChange={e => setForm(p => ({ ...p, has_tax_deducted: e.target.checked }))} />
                The payer kept back tax (withholding tax deducted at source)
            </label>
            {taxed && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <p className="sm:col-span-2 text-xs text-gray-500">Enter the <strong>gross</strong> income as the amount above; the tax is recorded as its own entry, so the account only goes up by the net received.</p>
                    <div><label className="label">Tax kept back *</label>
                        <input type="number" step="0.01" className="input" value={form.tax_deducted || ''} onChange={e => set('tax_deducted', e.target.value)} required /></div>
                    <div><label className="label">Treatment</label>
                        <select className="input" value={form.tax_treatment || 'CREDITABLE'} onChange={e => set('tax_treatment', e.target.value)}>
                            <option value="CREDITABLE">Creditable — set off against corporate tax</option>
                            <option value="FINAL">Final — no further tax on this income</option>
                        </select></div>
                    <div><label className="label">Paid by</label>
                        <input className="input" value={form.payer_name || ''} onChange={e => set('payer_name', e.target.value)} placeholder="e.g. the bank" /></div>
                    <div><label className="label">Certificate number</label>
                        <input className="input" value={form.tax_certificate_number || ''} onChange={e => set('tax_certificate_number', e.target.value)} /></div>
                </div>
            )}
        </div>
    );
};

// Turns the form into the backend payload (drops the UI-only flags).
export const expenseTaxPayload = (form) => {
    const { is_supplier_payment, apply_wht, payee_name, payee_tin, payee_residency, tax_treatment, ...rest } = form;
    return {
        ...rest,
        tax_treatment: tax_treatment || undefined,
        ...(is_supplier_payment ? {
            payee_name: payee_name || undefined, payee_tin: payee_tin || undefined,
            payee_residency: payee_residency || 'RESIDENT', apply_wht: !!apply_wht,
        } : {}),
    };
};
export const inflowTaxPayload = (form) => {
    const { has_tax_deducted, tax_deducted, tax_treatment, payer_name, tax_certificate_number, income_type, ...rest } = form;
    return {
        ...rest,
        income_type: income_type || 'OTHER_INCOME',
        ...(has_tax_deducted && parseFloat(tax_deducted) > 0 ? {
            tax_deducted: parseFloat(tax_deducted), tax_treatment: tax_treatment || 'CREDITABLE',
            payer_name: payer_name || undefined, tax_certificate_number: tax_certificate_number || undefined,
        } : {}),
    };
};
