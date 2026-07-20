// ============================================================
// GLOBAL SEARCH
// Triggered by the search icon in the TopBar. A centered overlay
// with a text input; results are fetched (debounced) from
// GET /api/search and grouped by category. Clicking a result
// navigates there and closes the overlay.
// ============================================================

import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { searchAPI } from '../../api/endpoints';
import {
    MagnifyingGlassIcon,
    XMarkIcon,
    UserIcon,
    BanknotesIcon,
    DocumentTextIcon,
    ChartBarIcon,
    CalendarDaysIcon,
} from '@heroicons/react/24/outline';

const CATEGORY_META = {
    members:      { label: 'Members',      icon: UserIcon },
    transactions: { label: 'Transactions', icon: BanknotesIcon },
    documents:    { label: 'Documents',    icon: DocumentTextIcon },
    investments:  { label: 'Investments',  icon: ChartBarIcon },
    events:       { label: 'Events',       icon: CalendarDaysIcon },
};

const GlobalSearch = ({ isOpen, onClose }) => {
    const [term,    setTerm]    = useState('');
    const [results, setResults] = useState(null);
    const [loading, setLoading] = useState(false);
    const inputRef = useRef(null);
    const navigate  = useNavigate();

    useEffect(() => {
        if (isOpen) {
            setTerm('');
            setResults(null);
            setTimeout(() => inputRef.current?.focus(), 50);
        }
    }, [isOpen]);

    useEffect(() => {
        if (term.trim().length < 2) {
            setResults(null);
            return;
        }
        setLoading(true);
        const handle = setTimeout(() => {
            searchAPI.search(term.trim())
                .then(res => setResults(res.data.data))
                .catch(() => setResults(null))
                .finally(() => setLoading(false));
        }, 300);
        return () => clearTimeout(handle);
    }, [term]);

    if (!isOpen) return null;

    const handleSelect = (link) => {
        navigate(link);
        onClose();
    };

    const categories = Object.keys(CATEGORY_META).filter(
        key => results?.[key]?.length > 0
    );
    const hasAnyResults = categories.length > 0;

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            <div className="fixed inset-0 bg-black/40" onClick={onClose} />
            <div className="flex min-h-full items-start justify-center p-4 pt-16 sm:pt-24">
                <div className="relative bg-white rounded-xl shadow-xl w-full max-w-lg">
                    <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100">
                        <MagnifyingGlassIcon className="h-5 w-5 text-gray-400 flex-shrink-0" />
                        <input
                            ref={inputRef}
                            type="text"
                            value={term}
                            onChange={e => setTerm(e.target.value)}
                            placeholder="Search members, transactions, documents, investments, events..."
                            className="flex-1 border-none outline-none text-sm"
                        />
                        <button onClick={onClose} className="flex-shrink-0 text-gray-400 hover:text-gray-600">
                            <XMarkIcon className="h-5 w-5" />
                        </button>
                    </div>

                    <div className="max-h-[60vh] overflow-y-auto">
                        {loading && (
                            <p className="text-sm text-gray-400 text-center py-8">Searching...</p>
                        )}

                        {!loading && term.trim().length >= 2 && !hasAnyResults && (
                            <p className="text-sm text-gray-400 text-center py-8">No results found</p>
                        )}

                        {!loading && term.trim().length < 2 && (
                            <p className="text-xs text-gray-400 text-center py-8">
                                Type at least 2 characters to search
                            </p>
                        )}

                        {!loading && categories.map(catKey => {
                            const meta = CATEGORY_META[catKey];
                            return (
                                <div key={catKey} className="py-2">
                                    <p className="px-4 py-1 text-xs font-semibold text-gray-400 uppercase tracking-wide">
                                        {meta.label}
                                    </p>
                                    {results[catKey].map((item, i) => (
                                        <button
                                            key={`${catKey}-${item.id}-${i}`}
                                            onClick={() => handleSelect(item.link)}
                                            className="w-full flex items-center gap-3 px-4 py-2 text-left
                                                hover:bg-gray-50 transition-colors"
                                        >
                                            <meta.icon className="h-4 w-4 text-gray-400 flex-shrink-0" />
                                            <div className="min-w-0">
                                                <p className="text-sm text-gray-900 truncate">{item.label}</p>
                                                {item.subtitle && (
                                                    <p className="text-xs text-gray-400 truncate">{item.subtitle}</p>
                                                )}
                                            </div>
                                        </button>
                                    ))}
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default GlobalSearch;
