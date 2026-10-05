// ============================================================
// STATUTORY MEETING DOCUMENTS (v1.79.0)
//
// Requested: "a very well defined template for the AGM and well
// organised register of attendees since this should be a fileable
// version on the URSB … for the normal minutes, board resolutions,
// special resolutions and other system generated documents."
//
// Every template here takes ONE `data` object — the snapshot saved as
// the document's template_data when it is generated from the
// Meetings page — so a saved document always re-renders exactly as
// it was filed, even if the meeting is edited later:
//   {
//     doc_kind,            NOTICE | PROXY | REGISTER | MINUTES | RESOLUTION | WRITTEN | CERTIFIED
//     meeting,             company_meetings row (+ reference_code)
//     attendance[],        meeting_attendance rows
//     resolutions[],       meeting_resolutions rows of the meeting
//     resolution,          one resolution (RESOLUTION / WRITTEN / CERTIFIED)
//     signatories[],       written-resolution signatures
//     tally, notice,       from GET /api/meetings/:id
//     settings,            governance settings (act name, legal references, …)
//     company,             statutory details (name, reg. no., TIN, office …)
//     chairperson_user_id / _name, secretary_user_id / _name,
//     director_user_id / _name   → the people who sign it digitally
//     signatures, stamps   → added by DocumentsPage when reopening
//   }
//
// Layout standard (all of them): A4, company letterhead with the
// registration number, TIN and registered office, a formal statutory
// heading ("THE COMPANIES ACT, 2012 …"), numbered paragraphs, the
// legal references from Settings › Governance, signature blocks that
// fill in once signed, the company stamp once fully signed, and
// "Page x of y" at the foot of every printed page.
// ============================================================

import { docKit } from './exportUtils';

const { getBaseStyles, letterhead, signatureBlock, stampOverlay, personName, statutoryLines, resolveUploadUrl } = docKit;

// ------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------
const esc = (v) => String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const multiline = (v) => esc(v).replace(/\n/g, '<br>');

const isoDay = (d) => (d ? String(d).slice(0, 10) : '');
const asDate = (d) => {
    if (!d) return null;
    const s = String(d);
    const x = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00`) : new Date(s);
    return Number.isNaN(x.getTime()) ? null : x;
};
const ordinal = (n) => {
    const v = n % 100;
    return `${n}${(v >= 11 && v <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th')}`;
};
// "Tuesday, 3 November 2026"
const longDate = (d) => {
    const x = asDate(d);
    return x ? x.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : '________________';
};
// "3 November 2026"
const plainDate = (d) => {
    const x = asDate(d);
    return x ? x.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '________________';
};
// "this 3rd day of November 2026"
const dayOf = (d) => {
    const x = asDate(d);
    if (!x) return 'this ______ day of ________________ 20____';
    return `this ${ordinal(x.getDate())} day of ${x.toLocaleDateString('en-GB', { month: 'long' })} ${x.getFullYear()}`;
};
const dateTime = (d) => {
    const x = asDate(d);
    return x ? `${x.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })} ${x.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : '';
};
// "10:00" → "10.00 a.m."
const clock = (t) => {
    if (!t) return '______';
    const [h, m] = String(t).split(':').map(Number);
    if (Number.isNaN(h)) return esc(t);
    const suffix = h >= 12 ? 'p.m.' : 'a.m.';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}.${String(m || 0).padStart(2, '0')} ${suffix}`;
};
const shares = (n) => (n === null || n === undefined || n === '' ? '—'
    : Number(n).toLocaleString('en-GB', { maximumFractionDigits: 4 }));

// v1.80.0 — the person's captured signature (copied when they confirmed /
// signed), with the time and verification code underneath.
const capturedSignature = (path, at, code, fallback = '—') => {
    if (!at) return fallback;
    const img = path ? `<img src="${resolveUploadUrl(path)}" alt="Signature" style="height:30px;max-width:140px;display:block;" />` : '';
    return `${img}<span style="font-size:9.5px;color:#4b5563;">${dateTime(at)}${code ? ` · <span class="code">${esc(code)}</span>` : ''}</span>`;
};
const docDate = (data, fallback) => data.document_date || fallback;

const MEETING_LABEL = { AGM: 'Annual General Meeting', EGM: 'Extraordinary General Meeting', BOARD: 'Meeting of the Board of Directors' };
const KIND_LABEL = {
    ORDINARY: 'Ordinary Resolution', SPECIAL: 'Special Resolution', BOARD: 'Resolution of the Board of Directors',
    WRITTEN_MEMBERS: 'Written Resolution of the Members', WRITTEN_BOARD: 'Written Resolution of the Directors',
};
const ATTENDANCE_LABEL = {
    PRESENT: 'In person', PRESENT_VIRTUAL: 'Online', BY_PROXY: 'By proxy',
    APOLOGY: 'Apology', ABSENT: 'Absent', PENDING: 'Not recorded',
};
const PRESENT = ['PRESENT', 'PRESENT_VIRTUAL', 'BY_PROXY'];

const companyOf = (data) => {
    const c = data.company || {};
    return { ...c, company_name: c.company_name || docKit.companyName() };
};
const settingsOf = (data) => {
    const s = data.settings || {};
    return {
        act_name: s.act_name || 'Companies Act, 2012',
        company_type: s.company_type || 'Private Company Limited by Shares',
        legal: s.legal_references || {},
        special_resolution_majority_pct: s.special_resolution_majority_pct ?? 75,
        resolution_filing_days: s.resolution_filing_days ?? 15,
        proxy_votes_on_show_of_hands: !!s.proxy_votes_on_show_of_hands,
    };
};
// "section 148 of the Companies Act, 2012" — only if a reference is set.
const cite = (st, key) => (st.legal[key] ? ` (${esc(st.legal[key])}, ${esc(st.act_name)})` : '');

// The meeting's full name: "1st Annual General Meeting".
const meetingName = (m) => {
    if (!m) return '';
    if (m.title) return m.title;
    return `${m.sequence_number ? `${ordinal(m.sequence_number)} ` : ''}${MEETING_LABEL[m.meeting_type] || 'Meeting'}`;
};
const placeOf = (m) => {
    if (!m) return '________________';
    if (m.mode === 'VIRTUAL') return 'by electronic means (online)';
    const v = m.venue ? esc(m.venue) : '________________';
    return m.mode === 'HYBRID' ? `${v} and by electronic means (online)` : v;
};
const thatClause = (c) => {
    const t = String(c || '').trim();
    return /^that\b/i.test(t) ? `THAT ${esc(t.replace(/^that\s*/i, ''))}` : `THAT ${esc(t)}`;
};

// Votes on a show of hands, written out.
const voteLine = (r, st) => {
    if (!r || r.result === 'PENDING') return '';
    if (r.result === 'WITHDRAWN') return 'The resolution was withdrawn and not put to the vote.';
    const f = Number(r.votes_for || 0); const a = Number(r.votes_against || 0); const ab = Number(r.votes_abstain || 0);
    const cast = f + a;
    const share = cast > 0 ? Math.round((f / cast) * 10000) / 100 : 0;
    let line = `On a show of hands: ${f} for, ${a} against, ${ab} abstaining.`;
    if (r.chair_casting_vote) line += ` The votes being equal, the Chairperson gave a casting vote ${r.chair_casting_vote === 'FOR' ? 'in favour' : 'against'}.`;
    if (r.kind === 'SPECIAL') line += ` ${share}% of the votes cast were in favour (at least ${esc(r.majority_required_pct ?? st.special_resolution_majority_pct)}% required).`;
    line += r.result === 'CARRIED' ? ' The resolution was declared CARRIED.' : ' The resolution was declared LOST.';
    return line;
};

// ------------------------------------------------------------
// Page shell: the company letterhead, then the formal heading.
// ------------------------------------------------------------
const statutoryStyles = () => {
    const { primary } = docKit.colors();
    return `
    .stat { font-family: 'Times New Roman', Times, Georgia, serif; font-size: 13px; line-height: 1.6; color: #111; }
    .stat p { margin: 0 0 10px; text-align: justify; }
    .stat-head { text-align: center; margin: 4px 0 18px; }
    .stat-head .act { font-size: 12px; font-weight: 700; letter-spacing: 1.5px; }
    .stat-head .ctype { font-size: 11px; letter-spacing: 1px; margin-top: 2px; }
    .stat-head .doc { font-size: 17px; font-weight: 700; letter-spacing: 1px; margin-top: 14px; text-decoration: underline; text-underline-offset: 3px; }
    .stat-head .of { font-size: 11px; margin: 4px 0; letter-spacing: 1px; }
    .stat-head .co { font-size: 15px; font-weight: 700; letter-spacing: 0.5px; }
    .stat-head .reg { font-size: 11px; margin-top: 2px; }
    .stat h3 { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; margin: 18px 0 8px; color: ${primary}; }
    .stat ol.items { margin: 0 0 10px 22px; }
    .stat ol.items > li { margin-bottom: 8px; padding-left: 4px; }
    .stat .clause { margin: 6px 0 6px 18px; font-weight: 600; }
    .stat .res-box { border: 1px solid #9ca3af; padding: 10px 14px; margin: 8px 0 12px; background: #fafafa; page-break-inside: avoid; }
    .stat .res-box .res-no { font-size: 11px; font-weight: 700; letter-spacing: 0.5px; color: ${primary}; text-transform: uppercase; }
    .stat .minute { margin-bottom: 12px; page-break-inside: avoid; }
    .stat .minute .mno { font-weight: 700; font-family: Arial, sans-serif; font-size: 11px; color: ${primary}; }
    .stat .minute .mtitle { font-weight: 700; text-transform: uppercase; }
    .stat .notes { font-size: 11.5px; border-top: 1px solid #d1d5db; margin-top: 18px; padding-top: 8px; }
    .stat .notes ol { margin-left: 18px; }
    .stat table { font-family: Arial, sans-serif; font-size: 10.5px; }
    .stat table td, .stat table th { border: 1px solid #d1d5db; }
    .stat .kv { display: grid; grid-template-columns: 170px 1fr; gap: 4px 12px; margin: 6px 0 14px; font-size: 12.5px; }
    .stat .kv div:nth-child(odd) { font-weight: 700; }
    .stat .certified { border: 2px solid ${primary}; padding: 10px 14px; margin: 18px 0; page-break-inside: avoid; }
    .stat .certified .stamp-title { font-family: Arial, sans-serif; font-weight: 800; letter-spacing: 3px; color: ${primary}; text-align: center; font-size: 15px; margin-bottom: 6px; }
    .stat .lodged { font-size: 11px; border: 1px dashed #9ca3af; padding: 8px 12px; margin-top: 16px; page-break-inside: avoid; }
    .stat .signature-section { margin-top: 36px; page-break-inside: avoid; break-inside: avoid; }
    .stat .stamp-overlay-wrap { page-break-inside: avoid; break-inside: avoid; }
    .stat .signature-block { font-family: Arial, sans-serif; }
    .stat .muted { color: #6b7280; }
    .stat .code { font-family: 'Courier New', monospace; font-size: 10.5px; }
    .stat .digital-note { font-size: 10.5px; color: #4b5563; margin-top: 6px; }
    .stat .pill { display: inline-block; padding: 1px 7px; border-radius: 10px; font-size: 9.5px; font-weight: 700; font-family: Arial, sans-serif; }
    .stat .pill.ok { background: #dcfce7; color: #166534; }
    .stat .pill.no { background: #fee2e2; color: #991b1b; }
    .stat .pill.wait { background: #fef9c3; color: #854d0e; }
    `;
};

const shell = ({ title, docLabel, reference, date, body }) => `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>${esc(title)}</title>
    <style>${getBaseStyles()}${statutoryStyles()}</style>
</head>
<body>
<div class="page">
    ${letterhead(esc(docLabel), esc(reference || ''), date || new Date())}
    <div class="stat">${body}</div>
    <div class="footer"><span>${esc(docKit.companyName())}</span><span>Generated: ${new Date().toLocaleDateString('en-GB')} at ${new Date().toLocaleTimeString('en-GB')}</span></div>
</div>
</body>
</html>`;

// THE COMPANIES ACT, 2012 / PRIVATE COMPANY LIMITED BY SHARES / <DOC> / OF / <COMPANY> / (Reg. No.)
const formalHeading = (data, docTitle, { withOf = true } = {}) => {
    const c = companyOf(data);
    const st = settingsOf(data);
    return `
    <div class="stat-head">
        <div class="act">THE ${esc(st.act_name).toUpperCase()}</div>
        <div class="ctype">${esc(st.company_type).toUpperCase()}</div>
        <div class="doc">${esc(docTitle).toUpperCase()}</div>
        ${withOf ? '<div class="of">OF</div>' : ''}
        <div class="co">${esc(c.company_name).toUpperCase()}</div>
        ${c.registration_number ? `<div class="reg">(Registration No. ${esc(c.registration_number)})</div>` : ''}
    </div>`;
};

// v1.80.0 — no date under the signatures (the document carries one
// "Dated this … day of …" line); one person in two positions signs once.
const signatures = (data, blocks) => `
    <div class="stamp-overlay-wrap">
        <div class="signature-section">
            ${blocks.map(([label, key, title]) => signatureBlock(data, label, esc(personName(data, key)), title, {
                showDate: false, userId: data[`${key}_user_id`] ? Number(data[`${key}_user_id`]) : null,
            })).join('')}
        </div>
        ${stampOverlay(data)}
    </div>`;

const lodgedBy = (data) => {
    const c = companyOf(data);
    const st = statutoryLines();
    return `
    <div class="lodged">
        <strong>Drawn and lodged by:</strong> ${esc(c.company_name)}${c.registered_office ? `, ${esc(c.registered_office)}` : (st.addr ? `, ${st.addr}` : '')}${c.postal_address ? `, ${esc(c.postal_address)}` : ''}${c.company_email ? ` · ${esc(c.company_email)}` : ''}${c.company_phone ? ` · Tel ${esc(c.company_phone)}` : ''}
    </div>`;
};

// ============================================================
// 1. NOTICE OF MEETING
// ============================================================
export const noticeOfMeetingTemplate = (data) => {
    const m = data.meeting || {};
    const st = settingsOf(data);
    const c = companyOf(data);
    const general = m.meeting_type !== 'BOARD';
    const resolutions = (data.resolutions || []).filter(r => r.result !== 'WITHDRAWN');
    const resFor = (no) => resolutions.filter(r => Number(r.agenda_no) === Number(no));
    const unplaced = resolutions.filter(r => !r.agenda_no || !(m.agenda || []).some(a => Number(a.no) === Number(r.agenda_no)));

    const resText = (r) => `
        <div class="res-box">
            <div class="res-no">${esc(KIND_LABEL[r.kind] || 'Resolution')} ${esc(r.resolution_number)} — ${esc(r.title)}</div>
            <div>To consider and, if thought fit, to pass the following resolution as ${r.kind === 'SPECIAL' ? 'a <strong>special resolution</strong>' : (r.kind === 'BOARD' ? 'a resolution of the directors' : 'an <strong>ordinary resolution</strong>')}:</div>
            ${r.preamble ? `<p style="margin-top:6px;font-style:italic;">${multiline(r.preamble)}</p>` : ''}
            ${(r.clauses || []).map(cl => `<div class="clause">${thatClause(cl)}</div>`).join('')}
        </div>`;

    const items = (m.agenda || []);
    const ordinary = items.filter(a => a.business !== 'SPECIAL');
    const special = items.filter(a => a.business === 'SPECIAL');
    const itemHtml = (a) => `<li><strong>${esc(a.title)}</strong>${a.description ? `<br><span>${multiline(a.description)}</span>` : ''}${resFor(a.no).map(resText).join('')}</li>`;
    // Resolutions not tied to an agenda item get an item of their own,
    // under ordinary or special business as their kind requires.
    const resItem = (r) => `<li><strong>${esc(r.title)}</strong>${resText(r)}</li>`;
    const unplacedOrdinary = unplaced.filter(r => r.kind !== 'SPECIAL');
    const unplacedSpecial = unplaced.filter(r => r.kind === 'SPECIAL');
    // Closing items ("Any other business", "Closure") stay at the end.
    const closingRe = /^(any other business|a\.?o\.?b|clos)/i;
    const ordOpen = ordinary.filter(a => !closingRe.test(a.title));
    const ordClose = ordinary.filter(a => closingRe.test(a.title));

    const opening = general
        ? `<p><strong>NOTICE IS HEREBY GIVEN</strong> that the <strong>${esc(meetingName(m))}</strong> of the members of <strong>${esc(c.company_name)}</strong> will be held at <strong>${placeOf(m)}</strong> on <strong>${longDate(m.meeting_date)}</strong> at <strong>${clock(m.start_time)}</strong> to transact the following business:</p>`
        : `<p><strong>NOTICE IS HEREBY GIVEN</strong> that a <strong>${esc(meetingName(m))}</strong> of <strong>${esc(c.company_name)}</strong> will be held at <strong>${placeOf(m)}</strong> on <strong>${longDate(m.meeting_date)}</strong> at <strong>${clock(m.start_time)}</strong> to consider the following agenda:</p>`;

    const notes = [];
    if (general) {
        notes.push(`A member entitled to attend and vote at the meeting is entitled to appoint a proxy to attend and vote instead of him or her. A proxy need not be a member of the Company${cite(st, 'proxy')}. The form of proxy must be signed and deposited at the registered office of the Company not less than forty-eight (48) hours before the time of the meeting.`);
        notes.push(`Voting will be by a show of hands${st.proxy_votes_on_show_of_hands ? '; proxies may vote on a show of hands' : '; on a show of hands a proxy does not vote unless a poll is demanded'}. A special resolution requires a majority of not less than ${esc(st.special_resolution_majority_pct)}% of the votes cast${cite(st, 'special_resolution')}.`);
    }
    if (m.meeting_type === 'AGM') notes.push('Copies of the financial statements and the reports of the directors and the auditors to be laid before the meeting are available for inspection at the registered office of the Company during normal business hours.');
    if (m.mode !== 'PHYSICAL' && m.virtual_link) notes.push(`The meeting may be joined online at: <span class="code">${esc(m.virtual_link)}</span>`);
    notes.push(`Attendance is recorded on the Company's electronic register: each ${general ? 'member' : 'director'} confirms his or her attendance from his or her own account on the day of the meeting.`);
    if (m.short_notice_consent) notes.push(`This meeting is held at shorter notice than the period required${cite(st, 'notice')}, the consent of the ${general ? 'members' : 'directors'} having been obtained: ${esc(m.short_notice_note || '')}`);

    const body = `
        ${formalHeading(data, `Notice of ${general ? 'the ' : ''}${meetingName(m)}`)}
        ${opening}
        ${general ? `
            ${ordOpen.length + unplacedOrdinary.length ? `<h3>Ordinary business</h3><ol class="items">${ordOpen.map(itemHtml).join('')}${unplacedOrdinary.map(resItem).join('')}</ol>` : ''}
            ${special.length + unplacedSpecial.length ? `<h3>Special business</h3><ol class="items" start="${ordOpen.length + unplacedOrdinary.length + 1}">${special.map(itemHtml).join('')}${unplacedSpecial.map(resItem).join('')}</ol>` : ''}
            ${ordClose.length ? `<h3>Other business</h3><ol class="items" start="${ordOpen.length + unplacedOrdinary.length + special.length + unplacedSpecial.length + 1}">${ordClose.map(itemHtml).join('')}</ol>` : ''}
        ` : `<h3>Agenda</h3><ol class="items">${items.map(itemHtml).join('')}${unplaced.map(resItem).join('')}</ol>`}
        <p style="margin-top:16px;"><strong>BY ORDER OF THE BOARD</strong></p>
        <p>Dated ${dayOf(docDate(data, m.notice_issued_at || data.generated_date || new Date()))}.</p>
        ${signatures(data, [['Company Secretary', 'secretary', 'Secretary']])}
        <div class="notes"><strong>NOTES</strong><ol>${notes.map(n => `<li>${n}</li>`).join('')}</ol></div>
        ${general ? `<p class="muted" style="font-size:11px;margin-top:8px;">Notice given: ${esc(m.notice_days_given ?? data.notice?.given ?? '—')} days (${esc(m.notice_days_required ?? data.notice?.required ?? '—')} days required${cite(st, 'notice')}). Meeting reference ${esc(m.reference_code || '')}.</p>` : ''}
    `;
    return shell({ title: `Notice — ${meetingName(m)}`, docLabel: 'Notice of Meeting', reference: m.reference_code, date: data.generated_date, body });
};

// ============================================================
// 2. FORM OF PROXY (general meetings)
// Blank, or pre-filled for one member when data.member is given.
// ============================================================
export const proxyFormTemplate = (data) => {
    const m = data.meeting || {};
    const st = settingsOf(data);
    const c = companyOf(data);
    const member = data.member || null;
    const line = (v, w = 260) => (v ? `<strong>${esc(v)}</strong>` : `<span style="display:inline-block;min-width:${w}px;border-bottom:1px solid #111;">&nbsp;</span>`);
    const res = (data.resolutions || []).filter(r => r.result !== 'WITHDRAWN');
    const body = `
        ${formalHeading(data, 'Form of Proxy')}
        <p style="text-align:center;margin-top:-8px;">for use at the <strong>${esc(meetingName(m))}</strong> to be held on <strong>${longDate(m.meeting_date)}</strong> at <strong>${clock(m.start_time)}</strong></p>
        <p style="text-align:left;line-height:2.3;">I/We ${line(member && member.name, 300)} of ${line(null, 300)} being a member/members of <strong>${esc(c.company_name)}</strong> holding ${line(member && shares(member.shares_held), 90)} shares, hereby appoint ${line(null, 240)} of ${line(null, 200)} or, failing him/her, ${line(null, 220)} of ${line(null, 160)} or, failing him/her, the Chairperson of the meeting, as my/our proxy to attend and vote for me/us and on my/our behalf at the ${esc(meetingName(m))} of the Company to be held on ${longDate(m.meeting_date)} and at any adjournment thereof.</p>
        ${res.length ? `
        <p>I/We direct my/our proxy to vote on the resolutions as indicated below with an "X". If no indication is given, my/our proxy will vote or abstain as he/she thinks fit.</p>
        <table>
            <thead><tr><th style="width:90px;">No.</th><th>Resolution</th><th style="width:60px;" class="text-center">For</th><th style="width:60px;" class="text-center">Against</th><th style="width:60px;" class="text-center">Abstain</th></tr></thead>
            <tbody>${res.map(r => `<tr><td class="font-mono">${esc(r.resolution_number)}</td><td>${esc(r.title)} <span class="muted">(${r.kind === 'SPECIAL' ? 'special' : 'ordinary'})</span></td><td></td><td></td><td></td></tr>`).join('')}</tbody>
        </table>` : ''}
        <p style="margin-top:18px;">Signed ${dayOf(null)}.</p>
        <div class="signature-section">
            <div class="signature-block">Signature of member: _______________________<br>Name: ${member ? esc(member.name) : '_______________________'}</div>
            <div class="signature-block">Signature of joint holder (if any): _______________<br>Name: _______________________</div>
        </div>
        <div class="notes"><strong>NOTES</strong><ol>
            <li>A member entitled to attend and vote may appoint a proxy, who need not be a member, to attend and vote instead of him or her${cite(st, 'proxy')}.</li>
            <li>This form must be deposited at the registered office of the Company${c.registered_office ? ` (${esc(c.registered_office)})` : ''} not less than forty-eight (48) hours before the time of the meeting or adjourned meeting.</li>
            <li>A corporate member must execute this form under its common seal or under the hand of a duly authorised officer.</li>
            <li>The appointment of a proxy does not prevent a member from attending and voting in person, in which case the proxy's authority is revoked.</li>
            <li>${st.proxy_votes_on_show_of_hands ? 'Under the Articles a proxy may vote on a show of hands.' : 'On a show of hands a proxy does not vote; a proxy may vote on a poll and may demand or join in demanding a poll.'}</li>
        </ol></div>
        <p class="muted" style="font-size:11px;">Meeting reference ${esc(m.reference_code || '')}</p>
    `;
    return shell({ title: `Form of Proxy — ${meetingName(m)}`, docLabel: 'Form of Proxy', reference: m.reference_code, date: data.generated_date, body });
};

// ============================================================
// 3. REGISTER OF ATTENDANCE
// ============================================================
export const attendanceRegisterTemplate = (data) => {
    const m = data.meeting || {};
    const st = settingsOf(data);
    const general = m.meeting_type !== 'BOARD';
    const att = data.attendance || [];
    const counted = att.filter(a => a.capacity === (general ? 'MEMBER' : 'DIRECTOR'));
    const inAtt = att.filter(a => a.capacity === 'IN_ATTENDANCE');
    const totalShares = counted.reduce((s, a) => s + Number(a.shares_held || 0), 0);
    const t = data.tally || {};

    const statusCell = (a) => `${ATTENDANCE_LABEL[a.status] || esc(a.status)}${a.status === 'BY_PROXY' && a.proxy_name ? `<br><span class="muted">Proxy: ${esc(a.proxy_name)}</span>` : ''}`;
    const confirmCell = (a) => (a.confirmed_at
        ? capturedSignature(a.signature_snapshot_path, a.confirmed_at, a.confirmation_code)
        : (PRESENT.includes(a.status) ? '<span class="muted">Recorded by the secretary</span>' : '—'));

    const rows = counted.map((a, i) => `
        <tr>
            <td class="text-center">${i + 1}</td>
            <td><strong>${esc(a.name)}</strong></td>
            <td>${esc(a.designation || (general ? 'Member' : 'Director'))}</td>
            ${general ? `<td class="text-right">${shares(a.shares_held)}</td><td class="text-right">${totalShares > 0 ? `${(Math.round((Number(a.shares_held || 0) / totalShares) * 10000) / 100).toFixed(2)}%` : '—'}</td>` : ''}
            <td>${statusCell(a)}</td>
            <td>${confirmCell(a)}</td>
        </tr>`).join('');

    const quorumText = t.quorum_met
        ? `A quorum of ${esc(t.quorum_required)} ${general ? 'members' : 'directors'} being present (${esc(t.present)} present${general ? `, holding ${shares(t.shares_present)} of ${shares(t.shares_total)} shares, ${esc(t.shares_present_pct)}%` : ''}), the meeting was duly constituted${cite(st, 'quorum')}.`
        : `The quorum required is ${esc(t.quorum_required ?? '—')} ${general ? 'members' : 'directors'}; ${esc(t.present ?? 0)} ${t.present === 1 ? 'was' : 'were'} recorded present.`;

    const body = `
        ${formalHeading(data, `Register of Attendance`)}
        <p style="text-align:center;margin-top:-8px;"><strong>${esc(meetingName(m))}</strong></p>
        <div class="kv">
            <div>Date</div><div>${longDate(m.meeting_date)}</div>
            <div>Time</div><div>${clock(m.start_time)}${m.end_time ? ` to ${clock(m.end_time)}` : ''}</div>
            <div>Place</div><div>${placeOf(m)}</div>
            <div>Chairperson</div><div>${esc(m.chairperson_name || personName(data, 'chairperson') || '—')}</div>
            <div>Secretary</div><div>${esc(m.secretary_name || personName(data, 'secretary') || '—')}</div>
            <div>Meeting reference</div><div class="code">${esc(m.reference_code || '')}</div>
        </div>
        <h3>${general ? 'Members' : 'Directors'}</h3>
        <table>
            <thead><tr><th style="width:30px;">#</th><th>Name</th><th>Capacity</th>${general ? '<th class="text-right">Shares held</th><th class="text-right">% of shares</th>' : ''}<th>Attendance</th><th>Signature</th></tr></thead>
            <tbody>
                ${rows || `<tr><td colspan="${general ? 7 : 5}" class="text-center muted">No ${general ? 'members' : 'directors'} on the register</td></tr>`}
                ${general ? `<tr class="total-row"><td></td><td colspan="2">Total</td><td class="text-right">${shares(totalShares)}</td><td class="text-right">100.00%</td><td colspan="2"></td></tr>` : ''}
            </tbody>
        </table>
        ${inAtt.length ? `
        <h3>In attendance (not counted in the quorum, no vote)</h3>
        <table>
            <thead><tr><th style="width:30px;">#</th><th>Name</th><th>Capacity</th><th>Attendance</th><th>Signature</th></tr></thead>
            <tbody>${inAtt.map((a, i) => `<tr><td class="text-center">${i + 1}</td><td><strong>${esc(a.name)}</strong></td><td>${esc(a.designation || 'In attendance')}</td><td>${statusCell(a)}</td><td>${confirmCell(a)}</td></tr>`).join('')}</tbody>
        </table>` : ''}
        <h3>Summary</h3>
        <table>
            <tbody>
                <tr><td>Entitled to attend</td><td class="text-right"><strong>${esc(t.entitled ?? counted.length)}</strong></td><td>Present in person</td><td class="text-right">${esc(t.in_person ?? 0)}</td></tr>
                <tr><td>Present online</td><td class="text-right">${esc(t.online ?? 0)}</td><td>Represented by proxy</td><td class="text-right">${esc(t.by_proxy ?? 0)}</td></tr>
                <tr><td>Apologies</td><td class="text-right">${esc(t.apologies ?? 0)}</td><td>Absent</td><td class="text-right">${esc((t.absent ?? 0) + (t.not_marked ?? 0))}</td></tr>
                <tr><td><strong>Total present</strong></td><td class="text-right"><strong>${esc(t.present ?? 0)}</strong></td><td>Quorum required</td><td class="text-right">${esc(t.quorum_required ?? '—')}</td></tr>
                ${general ? `<tr><td>Shares represented</td><td class="text-right">${shares(t.shares_present)} of ${shares(t.shares_total)}</td><td>% represented</td><td class="text-right">${esc(t.shares_present_pct ?? 0)}%</td></tr>` : ''}
            </tbody>
        </table>
        <p style="margin-top:10px;">${quorumText}</p>
        <p class="digital-note">Each signature shown is the signature captured in the Company's system for the person named, applied by that person from his or her own account at the date and time shown. The verification code is a keyed hash of the meeting, the person and the time, and can be checked against the system's records and audit log.</p>
        <p>Dated ${dayOf(docDate(data, m.meeting_date))}.</p>
        <p>We certify that this is a true and complete record of the attendance at the meeting.</p>
        ${signatures(data, [['Chairperson', 'chairperson', 'Chairman'], ['Secretary', 'secretary', 'Secretary']])}
    `;
    return shell({ title: `Register of Attendance — ${meetingName(m)}`, docLabel: 'Register of Attendance', reference: m.reference_code, date: data.generated_date, body });
};

// ============================================================
// 4. MINUTES (AGM / EGM / Board) in statutory form
// ============================================================
export const statutoryMinutesTemplate = (data) => {
    const m = data.meeting || {};
    const st = settingsOf(data);
    const c = companyOf(data);
    const general = m.meeting_type !== 'BOARD';
    const mins = m.minutes || {};
    const att = data.attendance || [];
    const counted = att.filter(a => a.capacity === (general ? 'MEMBER' : 'DIRECTOR'));
    const present = counted.filter(a => a.status === 'PRESENT' || a.status === 'PRESENT_VIRTUAL');
    const proxies = counted.filter(a => a.status === 'BY_PROXY');
    const apologies = counted.filter(a => a.status === 'APOLOGY');
    const inAtt = att.filter(a => a.capacity === 'IN_ATTENDANCE' && PRESENT.includes(a.status));
    const t = data.tally || {};
    const year = isoDay(m.meeting_date).slice(0, 4);
    const tag = m.meeting_type === 'BOARD' ? 'BM' : m.meeting_type;
    let n = 0;
    const mno = () => { n += 1; return `MIN ${String(n).padStart(2, '0')}/${tag}/${year}`; };

    const personLine = (a) => `${esc(a.name)}${a.designation && !['Member', 'Director'].includes(a.designation) ? ` — ${esc(a.designation)}` : ''}${general && a.shares_held ? ` <span class="muted">(${shares(a.shares_held)} shares)</span>` : ''}${a.status === 'PRESENT_VIRTUAL' ? ' <span class="muted">[online]</span>' : ''}`;
    const list = (arr, f = personLine) => (arr.length ? `<ol class="items" style="margin-bottom:6px;">${arr.map(a => `<li>${f(a)}</li>`).join('')}</ol>` : '<p class="muted">None.</p>');

    const resolutions = (data.resolutions || []).filter(r => r.result !== 'PENDING');
    const resBlock = (r) => `
        <div class="res-box">
            <div class="res-no">${esc(KIND_LABEL[r.kind] || 'Resolution')} ${esc(r.resolution_number)} — ${esc(r.title)}</div>
            ${r.proposed_by_name ? `<div>Proposed by ${esc(r.proposed_by_name)}${r.seconded_by_name ? `; seconded by ${esc(r.seconded_by_name)}` : ''}.</div>` : ''}
            ${r.result === 'CARRIED'
                ? `<div style="margin-top:4px;"><strong>RESOLVED${r.kind === 'SPECIAL' ? ' as a special resolution' : (r.kind === 'ORDINARY' ? ' as an ordinary resolution' : '')}:</strong></div>${(r.clauses || []).map(cl => `<div class="clause">${thatClause(cl)}</div>`).join('')}`
                : `<div style="margin-top:4px;">The resolution${r.result === 'LOST' ? ' was put to the meeting and was not passed' : ''}:</div>${(r.clauses || []).map(cl => `<div class="clause" style="font-weight:400;">${thatClause(cl)}</div>`).join('')}`}
            <div class="muted" style="margin-top:4px;">${voteLine(r, st)}</div>
        </div>`;

    const agenda = m.agenda || [];
    const itemNotes = (mins.items || []);
    const used = new Set();
    // Functions, not values: minute numbers are handed out in the order
    // the minutes are printed (opening first).
    const agendaMinutes = () => agenda.map((a) => {
        const note = itemNotes.find(x => Number(x.no) === Number(a.no)) || {};
        const rs = resolutions.filter(r => Number(r.agenda_no) === Number(a.no));
        rs.forEach(r => used.add(r.id));
        const isOpening = Number(a.no) === 1 && /open/i.test(a.title);
        const isClosure = /^clos/i.test(a.title);
        if (isOpening || isClosure) return '';
        return `
        <div class="minute">
            <div><span class="mno">${mno()}</span> &nbsp; <span class="mtitle">${esc(note.title || a.title)}</span></div>
            ${note.discussion ? `<p>${multiline(note.discussion)}</p>` : ''}
            ${rs.map(resBlock).join('')}
            ${note.decision ? `<p><strong>Decision:</strong> ${multiline(note.decision)}</p>` : ''}
            ${note.action_by ? `<p><strong>Action:</strong> ${esc(note.action_by)}${note.action_due ? ` by ${esc(note.action_due)}` : ''}</p>` : ''}
            ${!note.discussion && !rs.length && !note.decision ? '<p class="muted">Noted.</p>' : ''}
        </div>`;
    }).join('');
    const extraRes = () => resolutions.filter(r => !used.has(r.id));

    const noticeSentence = m.short_notice_consent
        ? `The meeting was held at short notice with the consent of the ${general ? 'members' : 'directors'}${m.short_notice_note ? ` (${esc(m.short_notice_note)})` : ''}${cite(st, 'notice')}.`
        : (m.notice_issued_at ? `The Secretary confirmed that notice of the meeting was given on ${plainDate(m.notice_issued_at)}, being ${esc(m.notice_days_given ?? '—')} days before the meeting (${esc(m.notice_days_required ?? '—')} days required${cite(st, 'notice')}).` : '');

    const body = `
        ${formalHeading(data, `Minutes of the ${meetingName(m)}`)}
        <p style="text-align:center;margin-top:-8px;">held at ${placeOf(m)} on ${longDate(m.meeting_date)} at ${clock(m.start_time)}</p>

        <h3>Present</h3>
        ${list(present)}
        ${general ? `<h3>Represented by proxy</h3>${list(proxies, a => `${esc(a.name)} <span class="muted">(${shares(a.shares_held)} shares)</span>, represented by ${esc(a.proxy_name || '—')}`)}` : ''}
        <h3>In attendance</h3>
        ${list(inAtt, a => `${esc(a.name)} — ${esc(a.designation || 'In attendance')}`)}
        <h3>Apologies</h3>
        ${list(apologies, a => esc(a.name))}

        <h3>Proceedings</h3>
        <div class="minute">
            <div><span class="mno">${mno()}</span> &nbsp; <span class="mtitle">Opening, notice and quorum</span></div>
            <p>${mins.opening ? multiline(mins.opening) : `${esc(m.chairperson_name || 'The Chairperson')} took the chair and called the meeting to order at ${clock(m.opened_at && !m.recorded_after_event ? new Date(m.opened_at).toTimeString().slice(0, 5) : m.start_time)}.`}</p>
            ${noticeSentence ? `<p>${noticeSentence}</p>` : ''}
            <p>${t.quorum_met !== false ? `The Chairperson declared that a quorum was present (${esc(m.quorum_at_opening ?? t.present ?? '—')} ${general ? 'members' : 'directors'} present; ${esc(t.quorum_required ?? '—')} required${cite(st, 'quorum')})${general && t.shares_total ? `, representing ${esc(t.shares_present_pct)}% of the issued shares` : ''}, and that the meeting was duly constituted.` : 'No quorum was recorded.'}</p>
            ${mins.declarations ? `<p><strong>Declarations of interest:</strong> ${multiline(mins.declarations)}</p>` : ''}
        </div>
        ${mins.previous_minutes ? `
        <div class="minute">
            <div><span class="mno">${mno()}</span> &nbsp; <span class="mtitle">Minutes of the previous meeting</span></div>
            <p>${multiline(mins.previous_minutes)}</p>
        </div>` : ''}
        ${agendaMinutes()}
        ${extraRes().length ? `
        <div class="minute">
            <div><span class="mno">${mno()}</span> &nbsp; <span class="mtitle">Resolutions</span></div>
            ${extraRes().map(resBlock).join('')}
        </div>` : ''}
        ${mins.aob ? `
        <div class="minute">
            <div><span class="mno">${mno()}</span> &nbsp; <span class="mtitle">Any other business</span></div>
            <p>${multiline(mins.aob)}</p>
        </div>` : ''}
        <div class="minute">
            <div><span class="mno">${mno()}</span> &nbsp; <span class="mtitle">Closure</span></div>
            <p>${mins.closing ? multiline(mins.closing) : `There being no other business, the Chairperson declared the meeting closed at ${clock(m.end_time)}.`}</p>
            ${mins.next_meeting ? `<p>${multiline(mins.next_meeting)}</p>` : ''}
        </div>

        <p style="margin-top:16px;">Confirmed as a true record of the proceedings${cite(st, 'minutes')}.</p>
        <p>Dated ${dayOf(docDate(data, m.meeting_date))}.</p>
        ${signatures(data, [['Chairperson', 'chairperson', 'Chairman'], ['Secretary', 'secretary', 'Secretary']])}
        <p class="muted" style="font-size:11px;margin-top:12px;">${esc(c.company_name)} · Meeting reference ${esc(m.reference_code || '')} · The register of attendance for this meeting is a separate document.</p>
    `;
    return shell({ title: `Minutes — ${meetingName(m)}`, docLabel: general ? 'Minutes of General Meeting' : 'Minutes of Board Meeting', reference: m.reference_code, date: data.generated_date, body });
};

// ============================================================
// 5. RESOLUTION (ordinary / special / board) — as passed at a meeting
// ============================================================
const resolutionBody = (data, { certified = false } = {}) => {
    const r = data.resolution || {};
    const m = data.meeting || {};
    const st = settingsOf(data);
    const c = companyOf(data);
    const general = r.kind === 'ORDINARY' || r.kind === 'SPECIAL';
    const written = r.kind === 'WRITTEN_MEMBERS' || r.kind === 'WRITTEN_BOARD';
    const heading = written ? (r.treated_as_special ? 'Special Resolution (in writing)' : KIND_LABEL[r.kind]) : KIND_LABEL[r.kind];
    const passedOn = r.passed_on || m.meeting_date;

    let intro;
    if (written) {
        intro = `<p>The following resolution was passed in writing on <strong>${longDate(passedOn)}</strong>, having been signed by all the ${r.kind === 'WRITTEN_BOARD' ? 'directors' : 'members entitled to attend and vote at general meetings'} of the Company, in accordance with the Articles of Association of the Company${r.treated_as_special ? ', and has effect as a special resolution' : ''}:</p>`;
    } else if (general) {
        intro = `<p>At the <strong>${esc(meetingName(m))}</strong> of the members of the above-named Company duly convened and held at ${placeOf(m)} on <strong>${longDate(m.meeting_date)}</strong>, the following resolution was duly passed as ${r.kind === 'SPECIAL' ? `a <strong>SPECIAL RESOLUTION</strong>${cite(st, 'special_resolution')}` : 'an <strong>ORDINARY RESOLUTION</strong>'}:</p>`;
    } else {
        intro = `<p>At a <strong>meeting of the Board of Directors</strong> of the above-named Company duly convened and held at ${placeOf(m)} on <strong>${longDate(m.meeting_date)}</strong> at which a quorum was present, the following resolution was duly passed:</p>`;
    }
    if (r.result && r.result !== 'CARRIED') {
        intro = `<p class="muted"><strong>Status: ${esc(r.result === 'PENDING' ? 'not yet decided' : r.result.toLowerCase())}.</strong> The text below is the resolution as proposed.</p>${intro.replace('was duly passed', 'was proposed').replace('was passed in writing', 'was circulated in writing')}`;
    }
    return `
        ${formalHeading(data, heading)}
        ${intro}
        <div class="res-box">
            <div class="res-no">Resolution ${esc(r.resolution_number)} — ${esc(r.title)}</div>
            ${r.preamble ? `<p style="margin-top:6px;">${multiline(r.preamble)}</p>` : ''}
            <div style="margin-top:6px;"><strong>IT IS RESOLVED:</strong></div>
            ${(r.clauses || []).map((cl, i) => `<div class="clause">${(r.clauses || []).length > 1 ? `${i + 1}. ` : ''}${thatClause(cl)}</div>`).join('')}
        </div>
        ${!written && voteLine(r, st) ? `<p class="muted" style="font-size:12px;">${voteLine(r, st)}${r.proposed_by_name ? ` Proposed by ${esc(r.proposed_by_name)}${r.seconded_by_name ? `, seconded by ${esc(r.seconded_by_name)}` : ''}.` : ''}</p>` : ''}
        ${certified ? '' : `<p class="muted" style="font-size:11px;">Reference ${esc(r.reference_code || '')}${m.reference_code ? ` · Meeting ${esc(m.reference_code)}` : ''} · ${esc(c.company_name)}</p>`}
    `;
};

export const meetingResolutionTemplate = (data) => {
    const r = data.resolution || {};
    const general = r.kind === 'ORDINARY' || r.kind === 'SPECIAL';
    const body = `
        ${resolutionBody(data)}
        <p>Dated ${dayOf(docDate(data, r.passed_on || data.meeting?.meeting_date))}.</p>
        ${signatures(data, [[general ? 'Chairperson of the meeting' : 'Chairperson / Director', 'chairperson', 'Chairman'], ['Company Secretary', 'secretary', 'Secretary']])}
    `;
    return shell({ title: `${KIND_LABEL[r.kind] || 'Resolution'} ${r.resolution_number || ''}`, docLabel: KIND_LABEL[r.kind] || 'Resolution', reference: r.reference_code, date: data.generated_date, body });
};

// ============================================================
// 6. WRITTEN RESOLUTION with its table of digital signatures
// ============================================================
export const writtenResolutionTemplate = (data) => {
    const r = data.resolution || {};
    const sigs = data.signatories || [];
    const members = r.kind === 'WRITTEN_MEMBERS';
    const signedCount = sigs.filter(s => s.signed_at).length;
    const pill = (s) => (s.decision === 'AGREE' ? '<span class="pill ok">AGREE</span>'
        : s.decision === 'DISAGREE' ? '<span class="pill no">DISAGREE</span>' : '<span class="pill wait">NOT SIGNED</span>');
    const resultLine = r.result === 'CARRIED'
        ? `<p style="margin-top:12px"><strong>This resolution was passed on ${longDate(r.passed_on)}</strong>, the date on which the last ${members ? 'member' : 'director'} signed it in agreement.</p>`
        : r.result === 'LOST'
            ? '<p><strong>This resolution was NOT passed</strong>: at least one signatory did not agree, and a written resolution requires the agreement of every person entitled to vote.</p>'
            : `<p><strong>Awaiting signatures:</strong> ${signedCount} of ${sigs.length} signed. It will be passed only when every ${members ? 'member' : 'director'} listed has signed in agreement.</p>`;
    const body = `
        ${resolutionBody(data)}
        <h3>Signatures of the ${members ? 'members' : 'directors'}</h3>
        <p style="font-size:12px;">We, the undersigned, being all the ${members ? 'members of the Company entitled to attend and vote at general meetings' : 'directors of the Company'}, signify our decision on the resolution above:</p>
        <table>
            <thead><tr><th style="width:30px;">#</th><th>Name</th><th>Capacity</th>${members ? '<th class="text-right">Shares held</th>' : ''}<th>Decision</th><th>Signature</th></tr></thead>
            <tbody>${sigs.map((s, i) => `<tr><td class="text-center">${i + 1}</td><td><strong>${esc(s.name)}</strong></td><td>${s.capacity === 'DIRECTOR' ? 'Director' : 'Member'}</td>${members ? `<td class="text-right">${shares(s.shares_held)}</td>` : ''}<td>${pill(s)}</td><td>${capturedSignature(s.signature_snapshot_path, s.signed_at, s.confirmation_code, '<span class="muted">Not signed yet</span>')}</td></tr>`).join('')}</tbody>
        </table>
        ${resultLine}
        <p class="digital-note">Each signature shown is the signature captured in the Company's system for the person named, applied by that person from his or her own account at the date and time shown. The verification code is a keyed hash of the resolution, the signatory, the decision and the time, and can be checked against the system's records and audit log.</p>
        ${data.secretary_user_id || data.secretary_name ? signatures(data, [['Company Secretary', 'secretary', 'Secretary']]) : ''}
    `;
    return shell({ title: `${KIND_LABEL[r.kind] || 'Written Resolution'} ${r.resolution_number || ''}`, docLabel: 'Written Resolution', reference: r.reference_code, date: data.generated_date, body });
};

// ============================================================
// 7. CERTIFIED TRUE COPY — for filing with the Registrar (URSB)
// ============================================================
export const certifiedResolutionTemplate = (data) => {
    const r = data.resolution || {};
    const st = settingsOf(data);
    const filing = r.filing_required || r.kind === 'SPECIAL' || r.treated_as_special;
    const body = `
        ${resolutionBody(data, { certified: true })}
        <div class="certified">
            <div class="stamp-title">CERTIFIED TRUE COPY</div>
            <p>We certify that the above is a true copy of resolution <strong>${esc(r.resolution_number)}</strong> of the Company, ${r.kind === 'WRITTEN_MEMBERS' || r.kind === 'WRITTEN_BOARD' ? 'passed in writing' : 'passed at the meeting stated'} on <strong>${plainDate(r.passed_on)}</strong>, and that it has been entered in the Company's ${r.kind === 'BOARD' || r.kind === 'WRITTEN_BOARD' ? 'minute book of directors\' meetings' : 'minute book of general meetings'}${cite(st, 'minutes')}.</p>
            <p>Dated ${dayOf(docDate(data, data.generated_date || new Date()))}.</p>
            ${signatures(data, [['Director', 'director', 'Director'], ['Company Secretary', 'secretary', 'Secretary']])}
        </div>
        ${filing ? `<p style="font-size:12px;">For registration with the Registrar of Companies, Uganda Registration Services Bureau${cite(st, 'filing')}, within ${esc(st.resolution_filing_days)} days after the resolution was passed${r.filing_due_date ? ` — that is, by <strong>${plainDate(r.filing_due_date)}</strong>` : ''}.${r.filed_on ? ` Filed on ${plainDate(r.filed_on)}${r.filing_reference ? ` (URSB reference ${esc(r.filing_reference)})` : ''}.` : ''}</p>` : ''}
        ${lodgedBy(data)}
        <p class="muted" style="font-size:11px;margin-top:6px;">Resolution reference ${esc(r.reference_code || '')}</p>
    `;
    return shell({ title: `Certified copy — ${r.resolution_number || ''}`, docLabel: 'Certified True Copy', reference: r.reference_code, date: data.generated_date, body });
};

// ============================================================
// Dispatch by template_data.doc_kind (DocumentsPage reopens a saved
// document with this) and by document_type.
// ============================================================
export const GOVERNANCE_RENDERERS = {
    NOTICE: noticeOfMeetingTemplate,
    PROXY: proxyFormTemplate,
    REGISTER: attendanceRegisterTemplate,
    MINUTES: statutoryMinutesTemplate,
    RESOLUTION: meetingResolutionTemplate,
    WRITTEN: writtenResolutionTemplate,
    CERTIFIED: certifiedResolutionTemplate,
};
export const GOVERNANCE_DOCUMENT_TYPES = {
    NOTICE: 'NOTICE_OF_MEETING',
    PROXY: 'PROXY_FORM',
    REGISTER: 'ATTENDANCE_REGISTER',
    MINUTES: 'MEETING_MINUTES',
    RESOLUTION: 'RESOLUTION',
    WRITTEN: 'WRITTEN_RESOLUTION',
    CERTIFIED: 'CERTIFIED_RESOLUTION',
};
export const renderGovernanceDocument = (data) => {
    const fn = GOVERNANCE_RENDERERS[data && data.doc_kind];
    return fn ? fn(data) : null;
};
export const governanceDocTitle = (kind, data) => {
    const m = data.meeting || {};
    const r = data.resolution || {};
    switch (kind) {
    case 'NOTICE': return `Notice of ${meetingName(m)} — ${plainDate(m.meeting_date)}`;
    case 'PROXY': return `Form of Proxy — ${meetingName(m)}${data.member ? ` — ${data.member.name}` : ''}`;
    case 'REGISTER': return `Register of Attendance — ${meetingName(m)} — ${plainDate(m.meeting_date)}`;
    case 'MINUTES': return `Minutes of ${meetingName(m)} — ${plainDate(m.meeting_date)}`;
    case 'RESOLUTION': return `${KIND_LABEL[r.kind] || 'Resolution'} ${r.resolution_number} — ${r.title}`;
    case 'WRITTEN': return `${KIND_LABEL[r.kind] || 'Written Resolution'} ${r.resolution_number} — ${r.title}`;
    case 'CERTIFIED': return `Certified copy — ${r.resolution_number} — ${r.title}`;
    default: return 'Document';
    }
};
export { MEETING_LABEL, KIND_LABEL, ATTENDANCE_LABEL, meetingName, longDate, plainDate, clock };
