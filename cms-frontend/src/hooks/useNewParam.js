// ============================================================
// useNewParam (v1.71.0)
// Lets the "+ New" menu (top bar / phone bottom bar) open a page's own
// form. The menu links to e.g. /transactions?new=expense; the page
// calls
//
//   useNewParam((kind) => { if (kind === 'expense') setShowExpense(true); });
//
// The handler runs once, then `new` is removed from the address so a
// refresh or Back does not open the form again. The page still decides
// whether the person may use that form — the handler should only open
// forms whose button the person can see.
// ============================================================

import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';

export const useNewParam = (handler, ready = true) => {
    const [searchParams, setSearchParams] = useSearchParams();
    const kind = searchParams.get('new');
    const handlerRef = useRef(handler);
    handlerRef.current = handler;

    useEffect(() => {
        if (!kind || !ready) return;
        handlerRef.current(kind);
        setSearchParams(prev => {
            const params = new URLSearchParams(prev);
            params.delete('new');
            return params;
        }, { replace: true });
    }, [kind, ready, setSearchParams]);
};

export default useNewParam;
