// ============================================================
// SCALED DOCUMENT FRAME (v1.81.0, measuring fixed v1.82.1)
// Shows a generated document (letterhead, tables, signatures — the same
// HTML that prints) inside the page, at its real A4 width, shrunk to fit
// the screen. On a phone the whole page is visible like a PDF page; on a
// computer it is shown at full size. Pinch-zoom still works on phones.
//
// Requested: "preview of documents in the entire system gets to be
// functional on mobile and tablet because so far it is only working for
// the pc and showing lines of code on other devices".
//
// v1.82.1 — "Uncaught runtime errors: ResizeObserver loop completed with
// undelivered notifications" after closing a preview (e.g. AGM minutes).
// Cause: the frame was made as tall as the document's *visible area*
// plus 4 px; the documents' pages are "at least one screen tall", so
// every resize made the document taller again — an endless loop, and
// the watcher kept running after the preview was closed. Now: the
// document is measured by its content only (the "one screen tall" rule
// is switched off inside the preview), changes of 2 px or less are
// ignored, measuring waits for the next screen refresh, and every
// watcher is stopped when the preview closes or a new document loads.
//
// Usage: <ScaledDocumentFrame ref={frameRef} html={html} title="…" />
//        frameRef.current.print()  — prints / saves as PDF only the document
//        sandboxed — for an uploaded HTML file: nothing in it can run
// ============================================================

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';

// A4 at 96 dpi is 794 px; the templates add a little margin around it.
const PAGE_WIDTH = 820;

// Inside the preview only: let the document be as tall as its content.
// (Screen only — printing from the preview is unchanged.)
const PREVIEW_CSS = `
@media screen {
  html, body { height: auto !important; min-height: 0 !important; overflow: hidden !important; }
  .page { min-height: 0 !important; }
}
`;

const ScaledDocumentFrame = forwardRef(({ html, title = 'Document', fit = true, minHeight = 400, sandboxed = false }, ref) => {
    const wrapRef = useRef(null);
    const frameRef = useRef(null);
    const [width, setWidth] = useState(PAGE_WIDTH);
    const [height, setHeight] = useState(1123); // one A4 page until measured
    const cleanupRef = useRef(() => {});

    // How wide the space is.
    useEffect(() => {
        const el = wrapRef.current;
        if (!el) return undefined;
        let raf = 0;
        const measure = () => {
            cancelAnimationFrame(raf);
            raf = requestAnimationFrame(() => {
                const w = el.clientWidth || PAGE_WIDTH;
                setWidth(prev => (Math.abs(prev - w) > 1 ? w : prev));
            });
        };
        measure();
        if (typeof ResizeObserver === 'undefined') {
            window.addEventListener('resize', measure);
            return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', measure); };
        }
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => { cancelAnimationFrame(raf); ro.disconnect(); };
    }, []);

    // How tall the document's content is.
    const measureDoc = useCallback(() => {
        try {
            const doc = frameRef.current?.contentDocument;
            if (!doc?.body) return;
            const h = Math.ceil(Math.max(doc.body.scrollHeight, doc.body.getBoundingClientRect().height)) + 24;
            if (h > 0) setHeight(prev => (Math.abs(prev - h) > 2 ? h : prev));
        } catch (_) { /* never fails the page */ }
    }, []);

    const onLoad = () => {
        cleanupRef.current();
        const timers = [];
        let ro = null;
        let raf = 0;
        const later = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(measureDoc); };
        try {
            const doc = frameRef.current.contentDocument;
            const style = doc.createElement('style');
            style.setAttribute('data-preview', '');
            style.textContent = PREVIEW_CSS;
            (doc.head || doc.documentElement).appendChild(style);
            measureDoc();
            doc.querySelectorAll('img').forEach(img => { if (!img.complete) img.addEventListener('load', later, { once: true }); });
            if (typeof ResizeObserver !== 'undefined' && doc.body) {
                ro = new ResizeObserver(later);
                ro.observe(doc.body);
            }
        } catch (_) { /* ignore */ }
        timers.push(setTimeout(later, 400), setTimeout(later, 1500));
        cleanupRef.current = () => {
            timers.forEach(clearTimeout);
            cancelAnimationFrame(raf);
            try { ro?.disconnect(); } catch (_) { /* ignore */ }
        };
    };

    // Closing the preview (or a new document) stops the watcher.
    useEffect(() => () => cleanupRef.current(), []);
    useEffect(() => () => cleanupRef.current(), [html]);

    useImperativeHandle(ref, () => ({
        print: () => {
            const w = frameRef.current?.contentWindow;
            if (!w) return false;
            try { w.focus(); w.print(); return true; } catch (_) { return false; }
        },
        html: () => html,
    }), [html]);

    const scale = fit ? Math.min(1, width / PAGE_WIDTH) : 1;
    const shownHeight = Math.max(minHeight, height);
    return (
        <div ref={wrapRef} className="w-full" style={{ overflowX: fit ? 'hidden' : 'auto' }}>
            <div style={{ width: PAGE_WIDTH * scale, height: shownHeight * scale, margin: '0 auto' }}>
                <iframe
                    ref={frameRef}
                    title={title}
                    srcDoc={html}
                    onLoad={onLoad}
                    scrolling="no"
                    // An uploaded HTML file is shown but nothing in it can run.
                    sandbox={sandboxed ? 'allow-same-origin allow-modals' : undefined}
                    style={{
                        width: PAGE_WIDTH, height: shownHeight, border: 'none', background: '#fff',
                        transform: `scale(${scale})`, transformOrigin: 'top left', display: 'block',
                        boxShadow: '0 1px 3px rgba(0,0,0,.12)',
                    }}
                />
            </div>
        </div>
    );
});

export default ScaledDocumentFrame;
