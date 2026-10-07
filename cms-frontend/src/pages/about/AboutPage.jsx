// ============================================================
// ABOUT & USER MANUAL (rewritten v1.82.0)
//
// Requested: "update of the about page which should in detail describe
// the navigation (where to find what) and working of each feature, what
// it does, steps to follow when going through the features. This is what
// should be comprised in the downloadable manual in the about section."
//
// Four tabs (the address keeps the tab and chapter, so a link such as
// /about?tab=manual&section=transactions opens the right place — the
// (?) button › "Manual for this page" uses it):
//   Company Info      — company details, directors, shareholding
//   User manual       — Part 1 general chapters + Part 2 one chapter per
//                       page: where it is, who uses it, what it does, its
//                       tabs, step-by-step tasks, rules and tips. Search
//                       box; "pages I can use" or "all pages".
//   Where to find what — the menu as a map, and "I want to …" answers
//   Roles             — what each role does
//
// "Download manual" saves the same text as a PDF (cover, contents,
// letterhead, page numbers) — "For my role" or "Complete manual (all
// roles)". "Take the guided tour" starts the tour of the screen.
//
// All the text lives in src/guide/ (one source for this page, the PDF
// and the tours).
// ============================================================

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { usersAPI } from '../../api/endpoints';
import { useAuth } from '../../contexts/AuthContext';
import { useBranding } from '../../contexts/BrandingContext';
import { useLayout } from '../../components/layout/LayoutContext';
import { useTour } from '../../components/tour/TourProvider';
import { NAV_GROUPS } from '../../components/layout/navConfig';
import { userManualTemplate, printDocument } from '../../utils/exportUtils';
import {
    GENERAL_CHAPTERS, MODULES, MODULE_GROUPS, ROLES, PERMISSION_NOTE, MANUAL_EDITION,
    modulesFor, chaptersFor, whereToFind, moduleVisible, groupLabel,
} from '../../guide/manualContent';
import PageHeader from '../../components/common/PageHeader';
import {
    BuildingLibraryIcon,
    UserGroupIcon,
    BookOpenIcon,
    InformationCircleIcon,
    ChartPieIcon,
    ShieldCheckIcon,
    ArrowDownTrayIcon,
    MapIcon,
    MagnifyingGlassIcon,
    ArrowRightIcon,
    XMarkIcon,
    CheckCircleIcon,
    LightBulbIcon,
    ExclamationTriangleIcon,
    MapPinIcon,
    UserIcon,
} from '@heroicons/react/24/outline';

// ============================================================
// SECTION CARD (Company Info)
// ============================================================
const Section = ({ title, icon: Icon, children, gradient = false }) => (
    <div className={`card mb-6 ${gradient
        ? 'bg-gradient-to-r from-primary-900 to-primary-700 text-white border-0'
        : ''}`}>
        <div className="flex items-center gap-3 mb-4">
            <div className={`p-2 rounded-lg ${gradient ? 'bg-white bg-opacity-20' : 'bg-primary-50'}`}>
                <Icon className={`h-5 w-5 ${gradient ? 'text-white' : 'text-primary-700'}`} />
            </div>
            <h2 className={`text-lg font-bold ${gradient ? 'text-white' : 'text-gray-900'}`}>{title}</h2>
        </div>
        {children}
    </div>
);

// ============================================================
// MANUAL PIECES
// ============================================================
const Steps = ({ steps }) => (
    <ol className="space-y-2 mt-2">
        {steps.map((s, i) => (
            <li key={i} className="flex gap-3">
                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary-700 text-white text-xs font-bold flex items-center justify-center mt-0.5">{i + 1}</span>
                <span className="text-sm text-gray-700 leading-relaxed">{s}</span>
            </li>
        ))}
    </ol>
);

const Bullets = ({ items, icon: Icon = null, tone = 'text-primary-600' }) => (
    <ul className="space-y-1.5 mt-2">
        {items.map((s, i) => (
            <li key={i} className="flex gap-2.5 text-sm text-gray-700 leading-relaxed">
                {Icon ? <Icon className={`h-4 w-4 flex-shrink-0 mt-0.5 ${tone}`} /> : <span className="w-1.5 h-1.5 rounded-full bg-primary-500 flex-shrink-0 mt-2" />}
                <span>{s}</span>
            </li>
        ))}
    </ul>
);

const ChapterView = ({ chapter, number }) => (
    <article>
        <p className="text-xs font-bold uppercase tracking-wider text-primary-600">Part 1 · Chapter {number}</p>
        <h2 className="text-xl font-bold text-gray-900 mt-1">{chapter.title}</h2>
        {chapter.summary && <p className="text-sm text-gray-500 mt-1">{chapter.summary}</p>}
        <div className="mt-5 space-y-6">
            {chapter.sections.map((s, i) => (
                <section key={i}>
                    <h3 className="text-base font-bold text-gray-900">{s.heading}</h3>
                    {(s.text || []).map((p, k) => <p key={k} className="text-sm text-gray-700 leading-relaxed mt-2">{p}</p>)}
                    {s.steps && <Steps steps={s.steps} />}
                    {s.bullets && <Bullets items={s.bullets} />}
                    {s.note && <p className="mt-3 text-sm bg-amber-50 border border-amber-200 text-amber-900 rounded-lg p-3">{s.note}</p>}
                </section>
            ))}
        </div>
    </article>
);

const ModuleView = ({ m, number, canOpen, onTourHere }) => (
    <article>
        <p className="text-xs font-bold uppercase tracking-wider text-primary-600">Part 2 · {groupLabel(m.group)} · Chapter {number}</p>
        <div className="flex items-start justify-between gap-3 flex-wrap mt-1">
            <h2 className="text-xl font-bold text-gray-900">{m.title}</h2>
            {canOpen && m.path && (
                <div className="flex gap-2 flex-wrap">
                    {m.tour?.length > 0 && (
                        <button type="button" onClick={() => onTourHere(m)} className="btn-secondary text-sm !py-1.5">
                            <MapIcon className="h-4 w-4" /> Go there and take its tour
                        </button>
                    )}
                    <Link to={m.path} className="btn-primary text-sm !py-1.5">Open the page <ArrowRightIcon className="h-4 w-4" /></Link>
                </div>
            )}
        </div>
        {m.summary && <p className="text-sm text-gray-500 mt-1">{m.summary}</p>}
        {!canOpen && (
            <p className="mt-3 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                Your role does not include this page — it is described here for completeness.
            </p>
        )}

        <dl className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="rounded-lg bg-gray-50 p-3">
                <dt className="text-xs font-bold text-gray-500 flex items-center gap-1.5"><MapPinIcon className="h-4 w-4" />Where to find it</dt>
                <dd className="text-sm text-gray-800 mt-1">{m.where}</dd>
            </div>
            <div className="rounded-lg bg-gray-50 p-3">
                <dt className="text-xs font-bold text-gray-500 flex items-center gap-1.5"><UserIcon className="h-4 w-4" />Who uses it</dt>
                <dd className="text-sm text-gray-800 mt-1">{m.who}</dd>
            </div>
        </dl>

        {m.purpose?.length > 0 && (
            <section className="mt-6">
                <h3 className="text-base font-bold text-gray-900">What it does</h3>
                {m.purpose.map((p, i) => <p key={i} className="text-sm text-gray-700 leading-relaxed mt-2">{p}</p>)}
            </section>
        )}

        {m.tabs?.length > 0 && (
            <section className="mt-6">
                <h3 className="text-base font-bold text-gray-900">On this page</h3>
                <div className="mt-2 divide-y rounded-lg border border-gray-200 overflow-hidden">
                    {m.tabs.map((t, i) => (
                        <div key={i} className="grid grid-cols-1 sm:grid-cols-[180px_1fr] gap-1 sm:gap-3 px-3 py-2.5 bg-white">
                            <p className="text-sm font-semibold text-gray-900">{t.name}</p>
                            <p className="text-sm text-gray-600">{t.what}</p>
                        </div>
                    ))}
                </div>
            </section>
        )}

        {m.tasks?.length > 0 && (
            <section className="mt-6">
                <h3 className="text-base font-bold text-gray-900">Step by step</h3>
                <div className="mt-2 space-y-3">
                    {m.tasks.map((t, i) => (
                        <div key={i} className="rounded-xl border border-gray-200 p-4">
                            <p className="text-sm font-bold text-gray-900">
                                {t.title}
                                {t.who && <span className="ml-2 align-middle text-[11px] font-semibold text-primary-700 bg-primary-50 rounded-full px-2 py-0.5">{t.who}</span>}
                            </p>
                            <Steps steps={t.steps} />
                        </div>
                    ))}
                </div>
            </section>
        )}

        {(m.details || []).filter(d => d.purpose?.length || d.tasks?.length).map(d => (
            <section key={d.id} className="mt-6">
                <h3 className="text-base font-bold text-gray-900">{d.title}</h3>
                {(d.purpose || []).map((p, i) => <p key={i} className="text-sm text-gray-700 leading-relaxed mt-2">{p}</p>)}
                <div className="mt-2 space-y-3">
                    {(d.tasks || []).map((t, i) => (
                        <div key={i} className="rounded-xl border border-gray-200 p-4">
                            <p className="text-sm font-bold text-gray-900">{t.title}</p>
                            <Steps steps={t.steps} />
                        </div>
                    ))}
                </div>
            </section>
        ))}

        {m.rules?.length > 0 && (
            <section className="mt-6">
                <h3 className="text-base font-bold text-gray-900">Rules the system keeps</h3>
                <Bullets items={m.rules} icon={ExclamationTriangleIcon} tone="text-amber-500" />
            </section>
        )}
        {m.tips?.length > 0 && (
            <section className="mt-6">
                <h3 className="text-base font-bold text-gray-900">Tips</h3>
                <Bullets items={m.tips} icon={LightBulbIcon} tone="text-emerald-500" />
            </section>
        )}
    </article>
);

// Search: does this chapter or page mention every word typed?
const textOf = (x) => JSON.stringify(x, (k, v) => (v instanceof RegExp ? undefined : v)).toLowerCase();
const matches = (x, q) => !q || q.toLowerCase().split(/\s+/).filter(Boolean).every(w => textOf(x).includes(w));

// ============================================================
// MAIN ABOUT PAGE
// ============================================================
const AboutPage = () => {
    const { branding } = useBranding();
    const { user, hasRole } = useAuth();
    const { navCtx, isAuditor } = useLayout();
    const { startMainTour } = useTour();
    const navigate = useNavigate();
    const [params, setParams] = useSearchParams();

    const tabParam = params.get('tab');
    const activeSection = ['company', 'manual', 'where', 'roles'].includes(tabParam) ? tabParam : 'company';
    const setActiveSection = (key) => setParams(p => { const n = new URLSearchParams(p); n.set('tab', key); if (key !== 'manual') n.delete('section'); return n; }, { replace: true });

    const [shareholding, setShareholding] = useState([]);
    const [directors, setDirectors] = useState([]);
    const [showAll, setShowAll] = useState(false);       // manual: all pages, not only mine
    const [query, setQuery] = useState('');
    const [wantQuery, setWantQuery] = useState('');
    const [downloadOpen, setDownloadOpen] = useState(false);

    useEffect(() => {
        usersAPI.getShareholding().then(res => setShareholding(res.data.data || [])).catch(() => {});
        usersAPI.getAllUsers({ limit: 50 })
            .then(res => {
                const users = res.data.data || [];
                setDirectors(users.filter(u => (u.roles || []).some(r => (typeof r === 'object' ? r.name : r) === 'Director')));
            })
            .catch(() => {});
    }, []);

    const totalShareValue = shareholding.reduce((sum, s) => sum + parseFloat(s.shares_held || 0), 0);
    const myRoles = (user?.roles || []).map(r => (typeof r === 'object' ? r.name : r));

    // ---- what goes in the manual for this person ----
    const opts = { complete: showAll, isAuditor };
    const chapters = useMemo(() => chaptersFor(opts), [showAll, isAuditor]); // eslint-disable-line react-hooks/exhaustive-deps
    const modules = useMemo(() => modulesFor(navCtx, opts), [navCtx, showAll, isAuditor]); // eslint-disable-line react-hooks/exhaustive-deps
    const canOpen = (m) => moduleVisible(m, navCtx, { isAuditor });

    // Chapter numbers: general chapters first, then pages in menu order.
    const orderedModules = useMemo(() => MODULE_GROUPS.flatMap(g => modules.filter(m => m.group === g.id)), [modules]);
    const entries = useMemo(() => [
        ...chapters.map((c, i) => ({ kind: 'chapter', id: c.id, title: c.title, number: i + 1, item: c, group: 'general' })),
        ...orderedModules.map((m, i) => ({ kind: 'module', id: m.id, title: m.title, number: chapters.length + i + 1, item: m, group: m.group })),
    ], [chapters, orderedModules]);
    const shown = entries.filter(e => matches(e.item, query));

    const sectionParam = params.get('section');
    // A link to a page that is not in "my" manual switches to all pages.
    useEffect(() => {
        if (activeSection === 'manual' && sectionParam && !entries.some(e => e.id === sectionParam)
            && MODULES.some(m => m.id === sectionParam)) setShowAll(true);
    }, [sectionParam, activeSection]); // eslint-disable-line react-hooks/exhaustive-deps
    const current = entries.find(e => e.id === sectionParam) || shown[0] || entries[0];
    const openEntry = (id) => {
        setParams(p => { const n = new URLSearchParams(p); n.set('tab', 'manual'); n.set('section', id); return n; }, { replace: true });
        try { document.getElementById('main-content')?.scrollTo({ top: 0, behavior: 'smooth' }); } catch (_) { /* ignore */ }
    };
    const idx = entries.findIndex(e => e.id === current?.id);

    const tourHere = (m) => navigate(`${m.path}${m.path.includes('?') ? '&' : '?'}tour=page`);

    // ---- download ----
    const download = (complete) => {
        setDownloadOpen(false);
        const o = { complete, isAuditor };
        const html = userManualTemplate({
            chapters: chaptersFor(o),
            modules: modulesFor(navCtx, o),
            groups: MODULE_GROUPS,
            roles: ROLES,
            wants: whereToFind(navCtx, o),
            complete,
            roleNames: myRoles,
            personName: `${user?.first_name || ''} ${user?.last_name || ''}`.trim(),
            edition: MANUAL_EDITION,
            note: PERMISSION_NOTE,
        });
        printDocument(html, `${branding.company_name || 'Company'} — User Manual${complete ? '' : ' (my role)'}`);
    };

    const sections = [
        { key: 'company', label: 'Company Info', icon: BuildingLibraryIcon },
        { key: 'manual', label: 'User manual', icon: BookOpenIcon },
        { key: 'where', label: 'Where to find what', icon: MapIcon },
        { key: 'roles', label: 'Roles', icon: UserGroupIcon },
    ];

    // Where-to-find: the menu as this person sees it.
    const navGroups = NAV_GROUPS.map(g => ({ ...g, mods: MODULES.filter(m => m.group === g.id && canOpen(m)) })).filter(g => g.mods.length);
    const personal = MODULES.filter(m => m.group === 'home' && canOpen(m));
    const wants = whereToFind(navCtx, { isAuditor }).filter(w => matches(w, wantQuery));

    return (
        <div className="max-w-6xl mx-auto">
            <PageHeader
                title="About & User manual"
                subtitle="The company, how to find your way around the system, and how to use every page — step by step"
                actions={(
                    <>
                        {!isAuditor && (
                            <button type="button" onClick={() => startMainTour()} className="btn-secondary flex items-center gap-2">
                                <MapIcon className="h-4 w-4" /> Take the guided tour
                            </button>
                        )}
                        <button type="button" onClick={() => setDownloadOpen(true)} className="btn-primary flex items-center gap-2">
                            <ArrowDownTrayIcon className="h-4 w-4" /> Download manual
                        </button>
                    </>
                )}
            />

            <div className="tab-bar" role="tablist">
                {sections.map(s => (
                    <button key={s.key} type="button" role="tab" aria-selected={activeSection === s.key}
                        onClick={() => setActiveSection(s.key)} className={`tab ${activeSection === s.key ? 'tab-active' : ''}`}>
                        <s.icon className="h-4 w-4" /> {s.label}
                    </button>
                ))}
            </div>

            {/* ================= COMPANY INFO ================= */}
            {activeSection === 'company' && (
                <div>
                    <Section title="About the Company" icon={BuildingLibraryIcon} gradient>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <p className="text-primary-200 text-xs mb-1">Company Name</p>
                                <p className="font-bold text-lg">{branding.company_name}</p>
                            </div>
                            <div>
                                <p className="text-primary-200 text-xs mb-1">Address</p>
                                <p className="font-medium">{branding.company_address || '—'}</p>
                            </div>
                            <div className="sm:col-span-2">
                                <p className="text-primary-200 text-xs mb-1">Motto</p>
                                <p className="font-medium italic">{branding.motto || '— set one under Settings > Company —'}</p>
                            </div>
                            <div className="sm:col-span-2">
                                <p className="text-primary-200 text-xs mb-1">System</p>
                                <p className="font-medium">Company Management System v{process.env.REACT_APP_VERSION || MANUAL_EDITION}</p>
                            </div>
                        </div>
                    </Section>

                    {branding.description && (
                        <Section title="Description" icon={InformationCircleIcon}>
                            <p className="text-sm text-gray-600 leading-relaxed">{branding.description}</p>
                        </Section>
                    )}

                    <Section title="Mission & Values" icon={ShieldCheckIcon}>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                            {[
                                { title: 'Mission', text: branding.mission },
                                { title: 'Vision', text: branding.vision },
                                { title: 'Values', text: branding.core_values },
                            ].map((item, i) => (
                                <div key={i} className="bg-gray-50 rounded-lg p-4">
                                    <p className="text-xs font-bold text-primary-700 uppercase mb-2">{item.title}</p>
                                    <p className="text-sm text-gray-600">{item.text || 'Not set yet — add this under Settings > Company.'}</p>
                                </div>
                            ))}
                        </div>
                    </Section>

                    <Section title="Current Directors" icon={UserGroupIcon}>
                        {directors.length === 0 ? (
                            <p className="text-sm text-gray-400">No directors found in the system.</p>
                        ) : (
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                {directors.map((d, i) => (
                                    <div key={i} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                                        <div className="w-10 h-10 rounded-full bg-primary-700 flex items-center justify-center flex-shrink-0">
                                            <span className="text-white text-sm font-bold">{d.first_name?.[0]}{d.last_name?.[0]}</span>
                                        </div>
                                        <div>
                                            <p className="text-sm font-semibold text-gray-900">{d.first_name} {d.last_name}</p>
                                            <p className="text-xs text-gray-400">{(d.roles || []).map(r => (typeof r === 'object' ? r.name : r)).join(', ')}</p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </Section>

                    <Section title="Shareholding Structure" icon={ChartPieIcon}>
                        <div className="mb-3 flex items-center justify-between">
                            <p className="text-sm text-gray-500">
                                Total shares:{' '}
                                <span className="font-bold text-gray-900">{totalShareValue.toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>
                            </p>
                        </div>
                        {shareholding.length === 0 ? (
                            <p className="text-sm text-gray-400">No shareholding data available.</p>
                        ) : (
                            <div className="space-y-2">
                                {shareholding.map((s, i) => (
                                    <div key={i} className="flex items-center gap-3">
                                        <div className="w-32 text-sm text-gray-700 truncate font-medium">{s.first_name} {s.last_name}</div>
                                        <div className="flex-1 h-3 bg-gray-100 rounded-full overflow-hidden">
                                            <div className="h-full rounded-full bg-primary-600" style={{ width: `${s.percentage || 0}%` }} />
                                        </div>
                                        <div className="w-16 text-right text-sm font-bold text-primary-700">{s.percentage || 0}%</div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </Section>
                </div>
            )}

            {/* ================= USER MANUAL ================= */}
            {activeSection === 'manual' && (
                <div className="grid grid-cols-1 lg:grid-cols-[290px_1fr] gap-5 items-start">
                    {/* Contents */}
                    <aside className="card !p-3 lg:sticky lg:top-2 lg:max-h-[calc(100dvh-120px)] lg:overflow-y-auto">
                        <div className="relative">
                            <MagnifyingGlassIcon className="h-4 w-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
                            <input type="search" value={query} onChange={e => setQuery(e.target.value)}
                                placeholder="Search the manual…" aria-label="Search the manual"
                                className="input !pl-9 w-full" />
                        </div>
                        <div className="mt-2 flex rounded-lg border border-gray-200 p-0.5 text-xs font-semibold" role="radiogroup" aria-label="Which pages">
                            {[[false, 'Pages I can use'], [true, 'All pages']].map(([v, l]) => (
                                <button key={l} type="button" role="radio" aria-checked={showAll === v} onClick={() => setShowAll(v)}
                                    className={`flex-1 rounded-md py-1.5 ${showAll === v ? 'bg-primary-700 text-white' : 'text-gray-600 hover:bg-gray-50'}`}>{l}</button>
                            ))}
                        </div>
                        {/* Phones: a drop-down instead of the long list */}
                        <select className="input w-full mt-2 lg:hidden" value={current?.id || ''} onChange={e => openEntry(e.target.value)} aria-label="Chapter">
                            {shown.map(e => <option key={e.id} value={e.id}>{e.number}. {e.title}</option>)}
                        </select>
                        <nav className="hidden lg:block mt-3" aria-label="Manual contents">
                            {[{ id: 'general', label: 'Part 1 — General' }, ...MODULE_GROUPS.map(g => ({ id: g.id, label: g.label }))].map(g => {
                                const items = shown.filter(e => e.group === g.id);
                                if (!items.length) return null;
                                return (
                                    <div key={g.id} className="mb-3">
                                        <p className="px-2 text-[11px] font-bold uppercase tracking-wider text-gray-400">{g.id === 'general' ? g.label : g.label}</p>
                                        {items.map(e => (
                                            <button key={e.id} type="button" onClick={() => openEntry(e.id)}
                                                className={`w-full text-left flex gap-2 px-2 py-1.5 rounded-lg text-sm ${current?.id === e.id ? 'bg-primary-50 text-primary-800 font-semibold' : 'text-gray-700 hover:bg-gray-50'}`}>
                                                <span className="w-6 flex-shrink-0 text-right text-gray-400 tabular-nums">{e.number}</span>
                                                <span className="min-w-0">{e.title}</span>
                                            </button>
                                        ))}
                                    </div>
                                );
                            })}
                            {shown.length === 0 && <p className="px-2 py-4 text-sm text-gray-400">Nothing matches “{query}”.</p>}
                        </nav>
                    </aside>

                    {/* The chapter */}
                    <div className="card min-w-0">
                        {current ? (
                            current.kind === 'chapter'
                                ? <ChapterView chapter={current.item} number={current.number} />
                                : <ModuleView m={current.item} number={current.number} canOpen={canOpen(current.item)} onTourHere={tourHere} />
                        ) : <p className="text-sm text-gray-400">Nothing to show.</p>}
                        <div className="mt-8 pt-4 border-t border-gray-100 flex items-center justify-between gap-3">
                            {idx > 0
                                ? <button type="button" className="btn-secondary text-sm" onClick={() => openEntry(entries[idx - 1].id)}>← {entries[idx - 1].title}</button>
                                : <span />}
                            {idx >= 0 && idx < entries.length - 1 && (
                                <button type="button" className="btn-secondary text-sm text-right" onClick={() => openEntry(entries[idx + 1].id)}>{entries[idx + 1].title} →</button>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* ================= WHERE TO FIND WHAT ================= */}
            {activeSection === 'where' && (
                <div>
                    <Section title="The menu, as you see it" icon={MapIcon}>
                        <p className="text-sm text-gray-500 mb-4">
                            The menu is on the left (on a phone: ☰ at the top left, or Menu on the bottom bar). Click a group to open it.
                            Click any page below to go there, or “Manual” for its instructions.
                        </p>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {navGroups.map(g => (
                                <div key={g.id} className="rounded-xl border border-gray-200 p-4">
                                    <p className="flex items-center gap-2 text-sm font-bold text-gray-900">
                                        <g.icon className="h-5 w-5" style={{ color: g.color === '#fbbf24' ? '#d97706' : g.color }} /> {g.label}
                                    </p>
                                    <ul className="mt-2 divide-y divide-gray-100">
                                        {g.mods.map(m => (
                                            <li key={m.id} className="py-2 flex items-start justify-between gap-3">
                                                <div className="min-w-0">
                                                    <Link to={m.path} className="text-sm font-semibold text-primary-700 hover:underline">{m.title}</Link>
                                                    <p className="text-xs text-gray-500">{m.summary}</p>
                                                </div>
                                                <button type="button" onClick={() => openEntry(m.id)} className="text-xs font-semibold text-gray-500 hover:text-primary-700 flex-shrink-0">Manual</button>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            ))}
                            {personal.length > 0 && (
                                <div className="rounded-xl border border-gray-200 p-4">
                                    <p className="flex items-center gap-2 text-sm font-bold text-gray-900"><UserIcon className="h-5 w-5 text-primary-600" /> Your own pages (your picture, top right)</p>
                                    <ul className="mt-2 divide-y divide-gray-100">
                                        {personal.map(m => (
                                            <li key={m.id} className="py-2 flex items-start justify-between gap-3">
                                                <div className="min-w-0">
                                                    <Link to={m.path} className="text-sm font-semibold text-primary-700 hover:underline">{m.title}</Link>
                                                    <p className="text-xs text-gray-500">{m.where}</p>
                                                </div>
                                                <button type="button" onClick={() => openEntry(m.id)} className="text-xs font-semibold text-gray-500 hover:text-primary-700 flex-shrink-0">Manual</button>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                        </div>
                    </Section>

                    <Section title="I want to …" icon={MagnifyingGlassIcon}>
                        <input type="search" value={wantQuery} onChange={e => setWantQuery(e.target.value)}
                            placeholder="Type what you want to do, e.g. “expense”, “signature”, “tax”…" aria-label="Search what you want to do"
                            className="input w-full mb-3" />
                        <div className="divide-y rounded-lg border border-gray-200 overflow-hidden">
                            {wants.map((w, i) => {
                                const m = MODULES.find(x => x.id === w.page);
                                return (
                                    <div key={i} className="grid grid-cols-1 sm:grid-cols-[1fr_1.2fr_auto] gap-1 sm:gap-3 items-center px-3 py-2.5 bg-white">
                                        <p className="text-sm font-semibold text-gray-900">{w.want}</p>
                                        <p className="text-sm text-gray-600">{w.where}</p>
                                        {m?.path && <Link to={m.path} className="text-sm font-semibold text-primary-700 hover:underline whitespace-nowrap">Go <ArrowRightIcon className="inline h-3.5 w-3.5" /></Link>}
                                    </div>
                                );
                            })}
                            {wants.length === 0 && <p className="px-3 py-6 text-center text-sm text-gray-400">Nothing matches. Try another word, or search the User manual tab.</p>}
                        </div>
                    </Section>
                </div>
            )}

            {/* ================= ROLES ================= */}
            {activeSection === 'roles' && (
                <Section title="Roles — who does what" icon={UserGroupIcon}>
                    <p className="text-sm text-gray-500 mb-1">Roles are requested when registering and given by an Admin (Office › Members). A person can hold several roles.</p>
                    <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4">{PERMISSION_NOTE}</p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {ROLES.map(r => {
                            const mine = hasRole(r.role);
                            return (
                                <div key={r.role} className={`rounded-xl border p-4 ${mine ? 'border-primary-300 bg-primary-50/50' : 'border-gray-200'}`}>
                                    <p className="text-sm font-bold text-gray-900 flex items-center gap-2">
                                        {r.role}
                                        {mine && <span className="text-[11px] font-semibold text-white bg-primary-700 rounded-full px-2 py-0.5 flex items-center gap-1"><CheckCircleIcon className="h-3.5 w-3.5" />You</span>}
                                    </p>
                                    <p className="text-sm text-gray-600 mt-1">{r.summary}</p>
                                    <Bullets items={r.does} />
                                </div>
                            );
                        })}
                    </div>
                </Section>
            )}

            {/* ================= DOWNLOAD CHOICE ================= */}
            {downloadOpen && (
                <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-0 sm:p-4" role="dialog" aria-modal="true" aria-labelledby="dl-title">
                    <div className="absolute inset-0 bg-black/55" onClick={() => setDownloadOpen(false)} />
                    <div className="relative w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl p-5 shadow-2xl" style={{ backgroundColor: 'var(--cms-surface)' }}>
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <h2 id="dl-title" className="text-lg font-bold text-gray-900">Download the user manual</h2>
                                <p className="text-sm text-gray-500 mt-1">A PDF with a cover page, contents, the company letterhead and page numbers. It opens in the viewer — choose Print › “Save as PDF”.</p>
                            </div>
                            <button type="button" onClick={() => setDownloadOpen(false)} aria-label="Close" className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-500"><XMarkIcon className="h-5 w-5" /></button>
                        </div>
                        <div className="mt-4 space-y-2">
                            <button type="button" onClick={() => download(false)} className="w-full text-left rounded-xl border-2 border-primary-200 hover:border-primary-500 p-4">
                                <p className="text-sm font-bold text-gray-900">For my role</p>
                                <p className="text-xs text-gray-500 mt-0.5">Only the pages you can use{myRoles.length ? ` as ${myRoles.join(', ')}` : ''} ({modulesFor(navCtx, { isAuditor }).length} pages), plus the general chapters.</p>
                            </button>
                            <button type="button" onClick={() => download(true)} className="w-full text-left rounded-xl border-2 border-gray-200 hover:border-primary-500 p-4">
                                <p className="text-sm font-bold text-gray-900">Complete manual (all roles)</p>
                                <p className="text-xs text-gray-500 mt-0.5">Every page in the system ({MODULES.length} pages) and {GENERAL_CHAPTERS.length} general chapters — for training or for the office file.</p>
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default AboutPage;