// ============================================================
// PDF PAGES (v1.82.1) — shows a PDF inside the system, page by page.
//
// Phones and tablets (Android especially) cannot show a PDF inside a web
// page: they answer "this document cannot be previewed on this device"
// and offer a download. This draws each page of the PDF as a picture
// with pdf.js (the same engine Firefox uses), so the document shows in
// the system's own viewer on every device. Pages are drawn as they are
// scrolled to, so a long PDF does not make a phone slow.
//
// pdf.js is loaded only the first time a PDF is opened. Its helper
// ("worker") file is served from public/pdf.worker-3.11.174.min.js —
// it must stay the same version as the pdfjs-dist package (pinned to
// 3.11.174 in package.json).
//
//   <PdfPages blob={pdfBlob} zoom={1} onError={(msg) => …} />
// ============================================================

import { useEffect, useRef, useState } from 'react';

const WORKER_SRC = `${process.env.PUBLIC_URL || ''}/pdf.worker-3.11.174.min.js`;

let pdfjsPromise = null;
const loadPdfJs = () => {
    if (!pdfjsPromise) {
        pdfjsPromise = import('pdfjs-dist/legacy/build/pdf').then((lib) => {
            const pdfjs = lib.default && lib.default.getDocument ? lib.default : lib;
            pdfjs.GlobalWorkerOptions.workerSrc = WORKER_SRC;
            return pdfjs;
        }).catch((err) => { pdfjsPromise = null; throw err; });
    }
    return pdfjsPromise;
};

// One page: drawn when it comes near the screen.
const Page = ({ pdf, number, width, zoom }) => {
    const holderRef = useRef(null);
    const canvasRef = useRef(null);
    const [size, setSize] = useState(null);   // { w, h } at the shown width
    const [visible, setVisible] = useState(number <= 2);
    const [drawn, setDrawn] = useState(false);

    // How big the page is (cheap — no drawing).
    useEffect(() => {
        let cancelled = false;
        pdf.getPage(number).then((page) => {
            if (cancelled) return;
            const vp = page.getViewport({ scale: 1 });
            const w = Math.max(200, width * zoom);
            setSize({ w, h: (vp.height / vp.width) * w });
        }).catch(() => {});
        return () => { cancelled = true; };
    }, [pdf, number, width, zoom]);

    // Draw only when on (or near) the screen.
    useEffect(() => {
        const el = holderRef.current;
        if (!el || typeof IntersectionObserver === 'undefined') { setVisible(true); return undefined; }
        const io = new IntersectionObserver((entries) => {
            if (entries.some(e => e.isIntersecting)) setVisible(true);
        }, { rootMargin: '600px 0px' });
        io.observe(el);
        return () => io.disconnect();
    }, []);

    useEffect(() => {
        if (!visible || !size) return undefined;
        let task = null;
        let cancelled = false;
        setDrawn(false);
        pdf.getPage(number).then((page) => {
            if (cancelled || !canvasRef.current) return;
            const base = page.getViewport({ scale: 1 });
            const ratio = Math.min(window.devicePixelRatio || 1, 2.5);
            const viewport = page.getViewport({ scale: (size.w / base.width) * ratio });
            const canvas = canvasRef.current;
            canvas.width = Math.floor(viewport.width);
            canvas.height = Math.floor(viewport.height);
            task = page.render({ canvasContext: canvas.getContext('2d'), viewport });
            return task.promise.then(() => { if (!cancelled) setDrawn(true); });
        }).catch(() => {});
        return () => { cancelled = true; try { task?.cancel(); } catch (_) { /* ignore */ } };
    }, [pdf, number, visible, size]);

    return (
        <div ref={holderRef} className="relative mx-auto bg-white shadow" style={{ width: size?.w || width * zoom, height: size?.h || (width * zoom * 1.414) }}>
            <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} aria-label={`Page ${number}`} />
            {!drawn && <p className="absolute inset-0 flex items-center justify-center text-xs text-gray-400">Page {number}…</p>}
        </div>
    );
};

const PdfPages = ({ blob, zoom = 1, onError }) => {
    const wrapRef = useRef(null);
    const [pdf, setPdf] = useState(null);
    const [pages, setPages] = useState(0);
    const [width, setWidth] = useState(600);
    const [state, setState] = useState('loading'); // loading | ready | failed

    // Available width (re-measured when the screen turns or resizes).
    useEffect(() => {
        const el = wrapRef.current;
        if (!el) return undefined;
        let raf = 0;
        const measure = () => {
            cancelAnimationFrame(raf);
            raf = requestAnimationFrame(() => {
                const w = Math.min(900, Math.max(240, (el.clientWidth || 600) - 8));
                setWidth(prev => (Math.abs(prev - w) > 2 ? w : prev));
            });
        };
        measure();
        window.addEventListener('resize', measure);
        return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', measure); };
    }, []);

    useEffect(() => {
        let cancelled = false;
        let doc = null;
        setState('loading');
        (async () => {
            try {
                const pdfjs = await loadPdfJs();
                const data = new Uint8Array(await blob.arrayBuffer());
                doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
                if (cancelled) { doc.destroy(); return; }
                setPdf(doc);
                setPages(doc.numPages);
                setState('ready');
            } catch (err) {
                if (cancelled) return;
                setState('failed');
                onError?.(err?.name === 'PasswordException'
                    ? 'This PDF is protected with a password — download it and open it with a PDF app.'
                    : 'This PDF could not be shown here — use Download to open it with a PDF app.');
            }
        })();
        return () => { cancelled = true; try { doc?.destroy(); } catch (_) { /* ignore */ } };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [blob]);

    return (
        <div ref={wrapRef} className="w-full">
            {state === 'loading' && <p className="py-10 text-center text-sm text-gray-500">Opening the PDF…</p>}
            {state === 'ready' && pdf && (
                <div className="flex flex-col items-center gap-3 pb-4" style={{ minWidth: zoom > 1 ? width * zoom : undefined }}>
                    <p className="text-[11px] text-gray-500">{pages} page{pages === 1 ? '' : 's'}</p>
                    {Array.from({ length: pages }, (_, i) => (
                        <Page key={i + 1} pdf={pdf} number={i + 1} width={width} zoom={zoom} />
                    ))}
                </div>
            )}
        </div>
    );
};

export default PdfPages;
