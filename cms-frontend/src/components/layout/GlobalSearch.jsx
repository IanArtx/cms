// ============================================================
// GLOBAL SEARCH (v1.71.0)
// Opened from the top bar search box, the search icon on small
// screens, or Ctrl K / ⌘K anywhere.
//
// Two kinds of results:
//   • Pages — any menu page this person can see whose name or topic
//     matches ("wht" finds Tax, "ledger" finds Reports & ledger). Works
//     from the first letter and needs no server call.
//   • Records — members, transactions, documents, investments and
//     events from GET /api/search (2+ characters, as before). Not shown
//     to the Auditor or the Administrative Officer (the backend blocks
//     /api/search for both roles).
//
// Keyboard: ↑ ↓ to move, Enter to open, Esc to close.
// ============================================================

import { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { searchAPI } from '../../api/endpoints';
import { NAV_GROUPS, PERSONAL_ITEMS } from './navConfig';
import {
    MagnifyingGlassIcon,
    XMarkIcon,
    UserIcon,
    BanknotesIcon,
    DocumentTextIcon,
    ChartBarIcon,
    CalendarDaysIcon,
    ArrowTurnDownLeftIcon,
} from '@heroicons/react/24/outline';

const CATEGORY_META = {
    members:      { label: 'Members',      icon: UserIcon,         tint: 'bg-teal-100 text-teal-800' },
    transactions: { label: 'Transactions', icon: BanknotesIcon,    tint: 'bg-blue-100 text-blue-800' },
    documents:    { label: 'Documents',    icon: DocumentTextIcon, tint: 'bg-violet-100 text-violet-800' },
    investments:  { label: 'Investments',  icon: ChartBarIcon,     tint: 'bg-amber-100 text-amber-900' },
    events:       { label: 'Events',       icon: CalendarDaysIcon, tint: 'bg-pink-100 text-pink-800' },
};

const groupLabel = (id) => NAV_GROUPS.find(g => g.id === id)?.label || 'Home';

const GlobalSearch = ({ isOpen, onClose, pages = [], recordsAllowed = true }) => {
    const [term,    setTerm]    = useState('');
    const [results, setResults] = useState(null);
    const [loading, setLoading] = useState(false);
    const [cursor,  setCursor]  = useState(0);
    const inputRef = useRef(null);
    const navigate  = useNavigate();

    useEffect(() => {
        if (isOpen) {
            setTerm('');
            setResults(null);
            setCursor(0);
            setTimeout(() => inputRef.current?.focus(), 30);
        }
    }, [isOpen]);

    useEffect(() => {
        if (!recordsAllowed || term.trim().length < 2) {
            setResults(null);
            setLoading(false);
            return undefined;
        }
        setLoading(true);
        const handle = setTimeout(() => {
            searchAPI.search(term.trim())
                .then(res => setResults(res.data.data))
                .catch(() => setResults(null))
                .finally(() => setLoading(false));
        }, 300);
        return () => clearTimeout(handle);
    }, [term, recordsAllowed]);

    const pageHits = useMemo(() => {
        const q = term.trim().toLowerCase();
        const all = [...pages, ...PERSONAL_ITEMS.filter(p => pages.length > 1)];
        if (!q) return all.slice(0, 6);
        return all.filter(p => `${p.label} ${groupLabel(p.group)} ${p.keywords || ''}`.toLowerCase().includes(q)).slice(0, 6);
    }, [term, pages]);

    const categories = Object.keys(CATEGORY_META).filter(key => results?.[key]?.length > 0);

    // One flat list for keyboard movement.
    const flat = useMemo(() => {
        const list = pageHits.map(p => ({ key: `page-${p.id}`, link: p.href }));
        categories.forEach(cat => results[cat].forEach((item, i) => list.push({ key: `${cat}-${item.id}-${i}`, link: item.link })));
        return list;
    }, [pageHits, categories, results]);

    useEffect(() => { setCursor(0); }, [term]);

    if (!isOpen) return null;

    const go = (link) => { navigate(link); onClose(); };

    const onKeyDown = (e) => {
        if (e.key === 'Escape') { onClose(); return; }
        if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => Math.min(c + 1, flat.length - 1)); }
        if (e.key === 'ArrowUp')   { e.preventDefault(); setCursor(c => Math.max(c - 1, 0)); }
        if (e.key === 'Enter' && flat[cursor]) { e.preventDefault(); go(flat[cursor].link); }
    };

    let idx = -1;
    const rowClass = (active) => `w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors ${active ? 'bg-primary-50' : 'hover:bg-gray-50'}`;

    return (
        <div className="fixed inset-0 z-[60] overflow-y-auto" role="dialog" aria-modal="true" aria-label="Search">
            <div className="fixed inset-0 bg-slate-950/50" onClick={onClose} />
            <div className="flex min-h-full items-start justify-center p-3 pt-14 sm:pt-24">
                <div className="relative w-full max-w-xl rounded-2xl border overflow-hidden"
                    style={{ backgroundColor: 'var(--cms-surface)', borderColor: 'var(--cms-border)', boxShadow: 'var(--cms-shadow-pop)' }}>
                    <div className="flex items-center gap-3 px-4 h-14 border-b" style={{ borderColor: 'var(--cms-surface-divider)' }}>
                        <MagnifyingGlassIcon className="h-5 w-5 flex-shrink-0" style={{ color: 'var(--cms-text-muted)' }} />
                        <input
                            ref={inputRef}
                            type="text"
                            value={term}
                            onChange={e => setTerm(e.target.value)}
                            onKeyDown={onKeyDown}
                            aria-label="Search"
                            placeholder={recordsAllowed ? 'Search pages, members, references, documents…' : 'Search pages…'}
                            className="flex-1 !border-none !bg-transparent !shadow-none !ring-0 text-[15px] p-0"
                            style={{ color: 'var(--cms-text-primary)' }}
                        />
                        <button type="button" onClick={onClose} aria-label="Close search"
                            className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-gray-100" style={{ color: 'var(--cms-text-muted)' }}>
                            <XMarkIcon className="h-5 w-5" />
                        </button>
                    </div>

                    <div className="max-h-[62vh] overflow-y-auto p-2">
                        {pageHits.length > 0 && (
                            <div className="pb-1">
                                <p className="px-3 pt-2 pb-1 text-[11px] font-bold tracking-[0.08em]" style={{ color: 'var(--cms-text-muted)' }}>PAGES</p>
                                {pageHits.map(p => {
                                    idx += 1; const active = idx === cursor;
                                    return (
                                        <button key={`page-${p.id}`} type="button" onClick={() => go(p.href)} className={rowClass(active)}>
                                            <span className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 bg-slate-100 text-slate-700">
                                                <p.icon className="w-4 h-4" />
                                            </span>
                                            <span className="flex-1 min-w-0">
                                                <span className="block text-sm font-semibold truncate" style={{ color: 'var(--cms-text-primary)' }}>{p.label}</span>
                                                <span className="block text-xs" style={{ color: 'var(--cms-text-muted)' }}>{groupLabel(p.group)}</span>
                                            </span>
                                            {active && <ArrowTurnDownLeftIcon className="w-4 h-4" style={{ color: 'var(--cms-text-muted)' }} />}
                                        </button>
                                    );
                                })}
                            </div>
                        )}

                        {loading && <p className="text-sm text-center py-6" style={{ color: 'var(--cms-text-muted)' }}>Searching records…</p>}

                        {!loading && categories.map(catKey => {
                            const meta = CATEGORY_META[catKey];
                            return (
                                <div key={catKey} className="pb-1">
                                    <p className="px-3 pt-2 pb-1 text-[11px] font-bold tracking-[0.08em]" style={{ color: 'var(--cms-text-muted)' }}>{meta.label.toUpperCase()}</p>
                                    {results[catKey].map((item, i) => {
                                        idx += 1; const active = idx === cursor;
                                        return (
                                            <button key={`${catKey}-${item.id}-${i}`} type="button" onClick={() => go(item.link)} className={rowClass(active)}>
                                                <span className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${meta.tint}`}>
                                                    <meta.icon className="w-4 h-4" />
                                                </span>
                                                <span className="min-w-0 flex-1">
                                                    <span className="block text-sm truncate" style={{ color: 'var(--cms-text-primary)' }}>{item.label}</span>
                                                    {item.subtitle && <span className="block text-xs truncate" style={{ color: 'var(--cms-text-muted)' }}>{item.subtitle}</span>}
                                                </span>
                                                {active && <ArrowTurnDownLeftIcon className="w-4 h-4" style={{ color: 'var(--cms-text-muted)' }} />}
                                            </button>
                                        );
                                    })}
                                </div>
                            );
                        })}

                        {!loading && term.trim().length >= 2 && pageHits.length === 0 && categories.length === 0 && (
                            <p className="text-sm text-center py-8" style={{ color: 'var(--cms-text-muted)' }}>Nothing found for “{term.trim()}”.</p>
                        )}
                        {recordsAllowed && term.trim().length < 2 && (
                            <p className="text-xs text-center pt-2 pb-3" style={{ color: 'var(--cms-text-muted)' }}>
                                Type 2 or more letters to search records too. ↑ ↓ to move, Enter to open.
                            </p>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default GlobalSearch;
