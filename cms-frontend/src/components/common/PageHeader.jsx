// ============================================================
// PAGE HEADER (v1.71.0 "Harbour")
// The blue → teal band at the top of every page. It runs edge to edge
// under the top bar (it pulls itself out over the page padding), holds
// the page title, an optional one-line description and the page's main
// buttons on the right.
//
// Buttons passed in `actions` are restyled automatically while they sit
// on the band (index.css): .btn-primary turns white with navy text and
// .btn-secondary becomes an outlined white button, so the page's main
// action is always the brightest thing on the band.
//
// Back button: pass showBack on a detail page (one investment, one
// loan …). It goes back in history, or to `backTo` when given. A
// detail page's title also becomes the last step of the breadcrumb in
// the top bar (Investments › Portfolio › <this title>).
// ============================================================

import { useNavigate } from 'react-router-dom';
import { ArrowLeftIcon } from '@heroicons/react/24/outline';
import { useBreadcrumbTitle } from '../layout/LayoutContext';

const PageHeader = ({ title, subtitle = null, actions = null, showBack = false, backTo = null, children = null }) => {
    const navigate = useNavigate();
    useBreadcrumbTitle(showBack && typeof title === 'string' ? title : null);

    const handleBack = () => {
        if (backTo) navigate(backTo);
        else navigate(-1);
    };

    return (
        <div className="page-banner -mx-4 -mt-4 md:-mx-6 md:-mt-6 mb-6 px-4 md:px-7 pt-5 pb-5">
            <div className="flex items-start sm:items-center justify-between gap-4 flex-wrap">
                <div className="flex items-start gap-3 min-w-0">
                    {showBack && (
                        <button
                            type="button"
                            onClick={handleBack}
                            aria-label="Go back"
                            className="mt-0.5 flex-shrink-0 w-10 h-10 flex items-center justify-center rounded-[10px]
                                       bg-white/15 hover:bg-white/25 focus:outline-none focus-visible:ring-2
                                       focus-visible:ring-white transition-colors"
                        >
                            <ArrowLeftIcon className="h-5 w-5 text-white" />
                        </button>
                    )}
                    <div className="min-w-0">
                        <h1 className="text-xl sm:text-2xl font-bold text-white leading-tight break-words">{title}</h1>
                        {subtitle && (
                            <p className="mt-1 text-sm text-blue-50/90 max-w-3xl">{subtitle}</p>
                        )}
                    </div>
                </div>
                {actions && (
                    // v1.77.0 — page-actions: on a phone the buttons take the full
                    // width and wrap onto more lines (they used to run off the
                    // screen where they could not be reached).
                    <div className="page-actions flex items-center gap-2.5 flex-wrap">
                        {actions}
                    </div>
                )}
            </div>
            {children}
        </div>
    );
};

export default PageHeader;
