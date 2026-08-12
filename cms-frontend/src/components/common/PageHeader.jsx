// ============================================================
// PAGE HEADER
// Consistent header used at the top of every page — now rendered as
// a gradient banner (brand blue -> indigo -> teal) rather than plain
// text, so every page carries the same colourful "top of page" feel.
//
// Back button (v1.27.0): pass showBack to render an arrow at the
// left of the title. Sub-pages (a detail view reached by drilling
// into a list — e.g. one investment, one loan) should set this;
// top-level list pages (Accounts, Loans, Investments themselves)
// should not, since there's nowhere meaningful to go "back" to other
// than the sidebar they're already in. Defaults to browser history
// (navigate(-1)); pass backTo to force a specific destination
// instead (useful when a detail page can be reached from more than
// one place and history isn't reliable).
// ============================================================

import { useNavigate } from 'react-router-dom';
import { ArrowLeftIcon } from '@heroicons/react/24/outline';

const PageHeader = ({ title, subtitle = null, actions = null, showBack = false, backTo = null }) => {
    const navigate = useNavigate();

    const handleBack = () => {
        if (backTo) navigate(backTo);
        else navigate(-1);
    };

    return (
        <div className="page-banner flex items-start justify-between gap-4 flex-wrap mb-6">
            <div className="flex items-start gap-3 min-w-0">
                {showBack && (
                    <button
                        onClick={handleBack}
                        aria-label="Go back"
                        className="mt-0.5 flex-shrink-0 p-1.5 rounded-lg bg-white/15
                                   hover:bg-white/25 focus:outline-none focus:ring-2
                                   focus:ring-white/40 transition-colors"
                    >
                        <ArrowLeftIcon className="h-5 w-5 text-white" />
                    </button>
                )}
                <div className="min-w-0">
                    <h1 className="text-2xl font-bold text-white truncate">{title}</h1>
                    {subtitle && (
                        <p className="mt-1 text-sm text-white/80">{subtitle}</p>
                    )}
                </div>
            </div>
            {actions && (
                <div className="flex items-center gap-3 flex-wrap">
                    {actions}
                </div>
            )}
        </div>
    );
};

export default PageHeader;