// ============================================================
// REGISTER OF MEMBERS AND OFFICERS (v1.86.1) — Members › Register
//
// "i would like that the system keeps an up to date downloadable
// register of the active members and their roles and information at
// all times".
//
// The register is built by the server from the live records each time
// the tab opens or a file is downloaded — there is no stored copy that
// could fall behind. Three downloads:
//   • Excel (.xlsx) — sheets Members, Roles, Former members, About;
//   • CSV — the Members sheet only, for any other program;
//   • Print / Save as PDF — the same register on company letterhead.
// Open to anyone with the members permission and to the Admin,
// Secretary, Assistant Secretary and Directors (the server checks).
// Every view and download is written to the audit log.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { memberRegisterAPI } from '../../api/endpoints';
import { formatDate, getErrorMessage } from '../../utils/helpers';
import { downloadBlob, previewDocument, docKit } from '../../utils/exportUtils';
import ErrorMessage from '../../components/common/ErrorMessage';
import { ArrowDownTrayIcon, PrinterIcon, ArrowPathIcon } from '@heroicons/react/24/outline';

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const n0 = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('en-GB'));
const stampOf = (iso) => new Date(iso).toLocaleString('en-GB', { timeZone: 'Africa/Kampala', dateStyle: 'long', timeStyle: 'short' });

// ------------------------------------------------------------
// Printable register (company letterhead, A4 landscape)
// ------------------------------------------------------------
const registerTemplate = (reg) => {
    const { getBaseStyles, letterhead, footer } = docKit;
    const at = stampOf(reg.generated_at);
    const members = reg.current.map(m => `
        <tr>
            <td>${m.no}</td>
            <td><strong>${esc(m.name)}</strong><br/><span class="muted">${esc(m.email)}${m.phone ? `<br/>${esc(m.phone)}` : ''}</span></td>
            <td>${m.roles_detail.map(d => `${esc(d.role)} <span class="muted">(${esc(d.since)})</span>`).join('<br/>')}</td>
            <td>${esc(m.member_since || '')}</td>
            <td>${esc(m.address || '—')}</td>
            <td>${esc(m.nationality || '—')}<br/><span class="muted">${esc(m.id_number || 'ID not given')}</span></td>
            <td>${esc(m.date_of_birth || '—')}</td>
            <td>${esc(m.tin || '—')}</td>
            <td class="num">${n0(m.shares_held)}${m.shares_held ? `<br/><span class="muted">${m.share_percent}%</span>` : ''}</td>
            <td class="num">${n0(m.shares_registered)}</td>
            <td>${esc(m.agreement_signed || 'Not yet')}</td>
        </tr>`).join('');
    const roles = reg.roles.map(r => `
        <tr><td><strong>${esc(r.role)}</strong></td><td class="num">${r.count}</td>
            <td>${r.holders.map(h => `${esc(h.name)} <span class="muted">(${esc(h.since)})</span>`).join(', ')}</td></tr>`).join('');
    const former = reg.former.map(f => `
        <tr><td><strong>${esc(f.name)}</strong><br/><span class="muted">${esc(f.email)}</span></td>
            <td>${f.roles_held.map(x => `${esc(x.role)} <span class="muted">(${esc(x.from)} – ${esc(x.to || 'now')})</span>`).join('<br/>')}</td>
            <td>${esc(f.ceased || '')}</td><td>${esc(f.how)}</td><td class="num">${n0(f.shares_held)}</td></tr>`).join('');
    return `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Register of members — ${esc(reg.company_name)}</title>
<style>${getBaseStyles()}
@page { size: A4 landscape; margin: 12mm; }
table.reg { width: 100%; border-collapse: collapse; font-size: 9.5px; margin-top: 6px; }
table.reg th { background: #1e3a5f; color: #fff; text-align: left; padding: 5px; font-weight: 600; }
table.reg td { border-bottom: 1px solid #e5e7eb; padding: 5px; vertical-align: top; }
table.reg td.num, table.reg th.num { text-align: right; }
.muted { color: #6b7280; }
table.reg td span.muted { white-space: nowrap; }
h2.sec { font-size: 13px; margin: 18px 0 4px; color: #1e3a5f; }
.summary { display: flex; gap: 18px; flex-wrap: wrap; font-size: 11px; margin: 8px 0; }
.summary b { font-size: 14px; display: block; }
.note { font-size: 9px; color: #6b7280; margin-top: 10px; }
</style></head><body>
${letterhead('REGISTER OF MEMBERS AND OFFICERS', `As at ${at}`, new Date(reg.generated_at))}
<div class="summary">
  <div><b>${reg.summary.members}</b>members now</div>
  <div><b>${reg.summary.shareholders}</b>shareholders</div>
  <div><b>${reg.summary.officers}</b>officers / staff</div>
  <div><b>${n0(reg.summary.shares_total)}</b>shares (company register)</div>
  <div><b>${reg.summary.former}</b>former members / officers</div>
</div>
<h2 class="sec">1. Members and officers</h2>
<table class="reg"><thead><tr>
  <th>No.</th><th>Name and contact</th><th>Roles (since)</th><th>Member since</th><th>Address</th>
  <th>Nationality / ID</th><th>Date of birth</th><th>TIN</th><th class="num">Shares held</th><th class="num">Registered (URSB)</th><th>Agreement signed</th>
</tr></thead><tbody>${members || '<tr><td colspan="11">No members.</td></tr>'}</tbody></table>
<h2 class="sec">2. Roles</h2>
<table class="reg"><thead><tr><th>Role</th><th class="num">Holders</th><th>Held by (since)</th></tr></thead><tbody>${roles}</tbody></table>
<h2 class="sec">3. Former members and officers</h2>
<table class="reg"><thead><tr><th>Name</th><th>Roles held (from – to)</th><th>Ceased</th><th>How</th><th class="num">Shares still held</th></tr></thead>
<tbody>${former || '<tr><td colspan="5">None.</td></tr>'}</tbody></table>
<p class="note">Made from the live records at ${esc(at)} (Kampala time) by ${esc(reg.generated_by || '')}. A member is every active account holding at least one role.
Shares held = the company's own share register; Registered = shares registered with URSB. Contains personal data — keep it confidential.</p>
${footer()}
</body></html>`;
};

const MemberRegisterTab = () => {
    const [reg, setReg] = useState(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(null);
    const [error, setError] = useState(null);
    const [filter, setFilter] = useState('');

    const load = useCallback(async () => {
        setLoading(true); setError(null);
        try {
            const r = await memberRegisterAPI.get();
            setReg(r.data.data);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, []);
    useEffect(() => { load(); }, [load]);

    const download = async (format) => {
        setBusy(format); setError(null);
        try {
            const res = await memberRegisterAPI.download(format);
            const cd = res.headers?.['content-disposition'] || '';
            const name = (cd.match(/filename="([^"]+)"/) || [])[1] || `register-of-members-${new Date().toISOString().slice(0, 10)}.${format}`;
            downloadBlob(res.data, name);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setBusy(null);
        }
    };

    const printPdf = async () => {
        setBusy('pdf'); setError(null);
        try {
            // fresh from the server at the moment of printing
            const r = await memberRegisterAPI.get({ purpose: 'pdf' });
            setReg(r.data.data);
            previewDocument(registerTemplate(r.data.data), 'Register of members');
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setBusy(null);
        }
    };

    const q = filter.trim().toLowerCase();
    const rows = (reg?.current || []).filter(m => !q || `${m.name} ${m.email} ${m.roles.join(' ')}`.toLowerCase().includes(q));

    return (
        <div>
            <div className="card mb-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                        <h3 className="section-title">Register of members and officers</h3>
                        <p className="text-sm text-gray-600 mt-1">
                            Always up to date: it is made from the live records each time you open or download it.
                            {reg && <> Shown as at <strong>{stampOf(reg.generated_at)}</strong> (Kampala time).</>}
                        </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <button type="button" className="btn-primary text-sm flex items-center gap-1" disabled={!!busy} onClick={() => download('xlsx')}>
                            <ArrowDownTrayIcon className="h-4 w-4" />{busy === 'xlsx' ? 'Preparing…' : 'Download Excel'}
                        </button>
                        <button type="button" className="btn-secondary text-sm flex items-center gap-1" disabled={!!busy} onClick={printPdf}>
                            <PrinterIcon className="h-4 w-4" />{busy === 'pdf' ? 'Preparing…' : 'Print / Save as PDF'}
                        </button>
                        <button type="button" className="btn-secondary text-sm flex items-center gap-1" disabled={!!busy} onClick={() => download('csv')}>
                            <ArrowDownTrayIcon className="h-4 w-4" />{busy === 'csv' ? 'Preparing…' : 'CSV'}
                        </button>
                        <button type="button" className="btn-secondary text-sm flex items-center gap-1" disabled={loading} onClick={load} title="Refresh">
                            <ArrowPathIcon className="h-4 w-4" />
                        </button>
                    </div>
                </div>
                <p className="text-xs text-gray-500 mt-3">
                    Contains personal data (ID numbers, dates of birth, addresses). Keep downloaded copies safe. Every view and
                    download is recorded in the audit log.
                </p>
                {error && <div className="mt-3"><ErrorMessage message={error} onDismiss={() => setError(null)} /></div>}
            </div>

            {loading && !reg ? (
                <p className="text-sm text-gray-400 py-8 text-center">Loading…</p>
            ) : reg && (
                <>
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-6">
                        {[
                            ['Members now', reg.summary.members],
                            ['Shareholders', reg.summary.shareholders],
                            ['Officers / staff', reg.summary.officers],
                            ['Shares (company register)', n0(reg.summary.shares_total)],
                            ['Former members / officers', reg.summary.former],
                        ].map(([label, v]) => (
                            <div key={label} className="card py-3">
                                <p className="text-xs text-gray-500">{label}</p>
                                <p className="text-xl font-semibold text-gray-900">{v}</p>
                            </div>
                        ))}
                    </div>
                    {reg.summary.missing_details > 0 && (
                        <div className="mb-4 bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-900">
                            {reg.summary.missing_details} member{reg.summary.missing_details === 1 ? ' has' : 's have'} no phone, address or ID number
                            on record (shown as “—”). Ask them to complete <em>My profile</em>; the register updates by itself.
                        </div>
                    )}

                    <div className="card">
                        <input className="input mb-4" placeholder="Filter by name, email or role…" value={filter} onChange={e => setFilter(e.target.value)} />
                        <div className="divide-y divide-gray-100">
                            {rows.map(m => (
                                <div key={m.user_id} className="py-3 grid grid-cols-1 md:grid-cols-3 gap-2">
                                    <div className="min-w-0">
                                        <p className="text-sm font-medium text-gray-900">{m.no}. {m.name}</p>
                                        <p className="text-xs text-gray-500 break-all">{m.email}{m.phone ? ` · ${m.phone}` : ''}</p>
                                        <p className="text-xs text-gray-500">Member since {m.member_since ? formatDate(m.member_since) : '—'}</p>
                                    </div>
                                    <div className="flex flex-wrap gap-1 content-start">
                                        {m.roles_detail.map(d => (
                                            <span key={d.role} className="badge-blue" title={`Since ${d.since}${d.by ? ` — given by ${d.by}` : ''}`}>{d.role}</span>
                                        ))}
                                    </div>
                                    <div className="text-xs text-gray-600">
                                        {m.shares_held > 0 && <p>Shares: <strong>{n0(m.shares_held)}</strong> ({m.share_percent}%) · registered (URSB) {n0(m.shares_registered)}</p>}
                                        <p>{m.nationality || '—'} · ID {m.id_number || '—'} · born {m.date_of_birth || '—'}</p>
                                        <p>Agreement {m.agreement_signed ? `signed ${m.agreement_signed}` : <span className="text-amber-700">not signed yet</span>}
                                            {' · '}2FA {m.two_factor ? 'on' : 'off'}</p>
                                    </div>
                                </div>
                            ))}
                            {rows.length === 0 && <p className="text-sm text-gray-400 py-6 text-center">No members match.</p>}
                        </div>
                    </div>

                    {reg.former.length > 0 && (
                        <div className="card mt-6">
                            <h3 className="section-title mb-3">Former members and officers</h3>
                            <div className="divide-y divide-gray-100">
                                {reg.former.map(f => (
                                    <div key={f.user_id} className="py-2 text-sm">
                                        <p className="font-medium text-gray-900">{f.name} <span className="text-xs text-gray-500 break-all">{f.email}</span></p>
                                        <p className="text-xs text-gray-500">
                                            {f.roles_held.map(x => `${x.role} (${x.from} – ${x.to || 'now'})`).join(', ')} · ceased {f.ceased || '—'} · {f.how.toLowerCase()}
                                        </p>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </>
            )}
        </div>
    );
};

export default MemberRegisterTab;
