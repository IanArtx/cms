// ============================================================
// SCALED DOCUMENT FRAME (v1.81.0)
// Shows a generated document (letterhead, tables, signatures — the same
// HTML that prints) inside the page, at its real A4 width, shrunk to fit
// the screen. On a phone the whole page is visible like a PDF page; on a
// computer it is shown at full size. Pinch-zoom still works on phones.
//
// Requested: "preview of documents in the entire system gets to be
// functional on mobile and tablet because so far it is only working for
// the pc and showing lines of code on other devices".
//
// Usage: <ScaledDocumentFrame ref={frameRef} html={html} title="…" />
//        frameRef.current.print()  — prints / saves as PDF only the document
// ============================================================

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';

// A4 at 96 dpi is 794 px; the templates add a little margin around it.
const PAGE_WIDTH = 820;

const ScaledDocumentFrame = forwardRef(({ html, title = 'Document', fit = true, minHeight = 400 }, ref) => {
    const wrapRef = useRef(null);
    const frameRef = useRef(null);
    const [width, setWidth] = useState(PAGE_WIDTH);
    const [height, setHeight] = useState(1123); // one A4 page until measured

    // How wide the space is.
    useEffect(() => {
        const el = wrapRef.current;
        if (!el) return undefined;
        const measure = () => setWidth(el.clientWidth || PAGE_WIDTH);
        measure();
        if (typeof ResizeObserver === 'undefined') {
            window.addEventListener('resize', measure);
            return () => window.removeEventListener('resize', measure);
        }
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    // How tall the document is (re-measured as images such as signatures load).
    const measureDoc = useCallback(() => {
        try {
            const doc = frameRef.current?.contentDocument;
            if (!doc) return;
            const h = Math.max(doc.documentElement?.scrollHeight || 0, doc.body?.scrollHeight || 0);
            if (h) setHeight(h + 4);
        } catch (_) { /* never fails the page */ }
    }, []);

    const onLoad = () => {
        measureDoc();
        try {
            const doc = frameRef.current.contentDocument;
            doc.querySelectorAll('img').forEach(img => { if (!img.complete) img.addEventListener('load', measureDoc); });
            if (typeof ResizeObserver !== 'undefined' && doc.body) new ResizeObserver(measureDoc).observe(doc.body);
        } catch (_) { /* ignore */ }
        setTimeout(measureDoc, 400);
    };

    useImperativeHandle(ref, () => ({
        print: () => {
            const w = frameRef.current?.contentWindow;
            if (!w) return false;
            try { w.focus(); w.print(); return true; } catch (_) { return false; }
        },
        html: () => html,
    }), [html]);

    const scale = fit ? Math.min(1, width / PAGE_WIDTH) : 1;
    return (
        <div ref={wrapRef} className="w-full" style={{ overflowX: fit ? 'hidden' : 'auto' }}>
            <div style={{ width: PAGE_WIDTH * scale, height: Math.max(minHeight, height) * scale, margin: '0 auto' }}>
                <iframe
                    ref={frameRef}
                    title={title}
                    srcDoc={html}
                    onLoad={onLoad}
                    scrolling="no"
                    style={{
                        width: PAGE_WIDTH, height: Math.max(minHeight, height), border: 'none', background: '#fff',
                        transform: `scale(${scale})`, transformOrigin: 'top left', display: 'block',
                        boxShadow: '0 1px 3px rgba(0,0,0,.12)',
                    }}
                />
            </div>
        </div>
    );
});

export default ScaledDocumentFrame;
