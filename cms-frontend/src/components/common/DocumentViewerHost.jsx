// ============================================================
// DOCUMENT VIEWER (v1.81.0, phones fixed v1.82.1) — one viewer for the
// whole system.
//
// Before v1.81: "Preview" and "Print / Download" opened a blank new
// browser tab and wrote the document into it. Phones and tablets often
// blocked that tab, opened it empty, or showed the page source.
//
// Every preview opens here, inside the app, on every device:
//   • generated documents (receipts, minutes, statements, the manual …)
//     — the page itself, shrunk to fit the screen (ScaledDocumentFrame);
//   • uploaded PDFs — every page drawn inside the viewer (PdfPages, with
//     pdf.js) on phones and tablets; a computer uses its own PDF viewer;
//   • uploaded pictures — shown directly;
//   • uploaded web pages (.html) — shown, with nothing in them able to run;
//   • anything else (Word, Excel …) — Download, with the right file ending.
// The phone's Back button closes the viewer instead of leaving the page.
//
// v1.82.1 — reported: on phones "this document cannot be previewed on
// this device … download to view, but even that only downloads the code
// text". Three causes, all fixed:
//   1. A stored PDF whose name had no ".pdf" came from the server as
//      "unknown file" — the viewer believed it and offered only Download.
//      Now the file's own first bytes decide what it is (utils/fileType).
//   2. Phones cannot show a PDF inside a page; the old "Open the PDF"
//      handed it to the phone, which refused. Now pdf.js draws the pages.
//   3. "Download" / "New tab" of a generated document saved its HTML —
//      code on a phone. Now phones get "Save as PDF": a real PDF made on
//      the server (POST /api/viewer/pdf), and "Share" where the phone
//      can share files. Downloads always carry the right ending (.pdf …).
//
// Buttons
//   computer: Fit / Actual size · Print / Save as PDF · Download PDF ·
//             New tab · Download (uploaded files) · Close
//   phone / tablet: Zoom · Save as PDF · Share · Download · Close
//
// Pages ask for it through utils/documentViewer.js (viewHtml / viewFile);
// exportUtils.previewDocument / printDocument already do, so every existing
// Preview / Print button in the system uses it without further changes.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import {
    XMarkIcon, PrinterIcon, ArrowTopRightOnSquareIcon, ArrowDownTrayIcon, MagnifyingGlassPlusIcon,
    MagnifyingGlassMinusIcon, ShareIcon, DocumentArrowDownIcon,
} from '@heroicons/react/24/outline';
import ScaledDocumentFrame from './ScaledDocumentFrame';
import PdfPages from './PdfPages';
import { VIEW_EVENT, isTouchDevice, inlineImages, blobErrorMessage } from '../../utils/documentViewer';
import { detectFileType, withType, withExtension } from '../../utils/fileType';
import { viewerAPI } from '../../api/endpoints';

const saveBlob = (blob, fileName) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
};

const openBlob = (blob) => {
    const url = URL.createObjectURL(blob);
    const w = window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return !!w;
};

// A generated document in a new tab: written into the tab, never handed
// over as a file (a phone would save it as code).
const openHtmlTab = (html, title) => {
    const w = window.open('', '_blank');
    if (!w) return false;
    try {
        w.document.open();
        w.document.write(html);
        w.document.close();
        w.document.title = title || 'Document';
        return true;
    } catch (_) { return false; }
};

const canShareFiles = () => {
    try {
        return typeof navigator !== 'undefined' && !!navigator.share && !!navigator.canShare
            && navigator.canShare({ files: [new File([new Blob(['x'], { type: 'application/pdf' })], 'x.pdf', { type: 'application/pdf' })] });
    } catch (_) { return false; }
};

const DocumentViewerHost = () => {
    const [doc, setDoc] = useState(null);       // { kind: 'html'|'file', html | blob, title, fileName, autoPrint }
    const [file, setFile] = useState(null);     // uploaded file, once its type is known: { type, blob, name, html? }
    const [fit, setFit] = useState(true);
    const [zoom, setZoom] = useState(1);
    const [message, setMessage] = useState(null);
    const [busy, setBusy] = useState(null);     // 'pdf' | 'share' | null
    const frameRef = useRef(null);
    const pushedRef = useRef(false);
    const pdfCache = useRef(null);              // { html, blob } — the server PDF, made once per document

    const close = useCallback((fromBack = false) => {
        setDoc(null);
        setFile(null);
        setMessage(null);
        setBusy(null);
        pdfCache.current = null;
        if (pushedRef.current) {
            pushedRef.current = false;
            if (!fromBack) window.history.back();
        }
    }, []);

    // Listen for requests from any page.
    useEffect(() => {
        window.__cmsDocumentViewer = true;
        const onView = (e) => {
            const d = e.detail || {};
            setFit(true);
            setZoom(1);
            setMessage(null);
            setFile(null);
            pdfCache.current = null;
            setDoc({ ...d });
            if (!pushedRef.current) {
                try { window.history.pushState({ ...(window.history.state || {}), cmsViewer: true }, ''); pushedRef.current = true; } catch (_) { /* ignore */ }
            }
        };
        window.addEventListener(VIEW_EVENT, onView);
        return () => { window.removeEventListener(VIEW_EVENT, onView); window.__cmsDocumentViewer = false; };
    }, []);

    // An uploaded file: find out what it really is.
    useEffect(() => {
        if (doc?.kind !== 'file' || !doc.blob) return undefined;
        let cancelled = false;
        (async () => {
            const info = await detectFileType(doc.blob, doc.fileName || doc.title);
            const blob = withType(doc.blob, info.mime);
            const name = withExtension(doc.fileName || doc.title, info.ext);
            let html = null;
            if (info.kind === 'html' || info.kind === 'text') {
                const text = await blob.text();
                html = info.kind === 'html' ? text
                    : `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font:13px/1.5 monospace;padding:24px;white-space:pre-wrap;word-break:break-word;color:#111}</style></head><body>${text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</body></html>`;
            }
            if (!cancelled) setFile({ type: info.kind, blob, name, html });
        })();
        return () => { cancelled = true; };
    }, [doc]);

    // Back button / Escape close the viewer.
    useEffect(() => {
        if (!doc) return undefined;
        const onPop = () => { if (pushedRef.current) { pushedRef.current = false; close(true); } };
        const onKey = (e) => { if (e.key === 'Escape') close(); };
        window.addEventListener('popstate', onPop);
        window.addEventListener('keydown', onKey);
        const prevOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            window.removeEventListener('popstate', onPop);
            window.removeEventListener('keydown', onKey);
            document.body.style.overflow = prevOverflow;
        };
    }, [doc, close]);

    const touch = isTouchDevice();

    // "Download" buttons on a computer print straight away (as before).
    useEffect(() => {
        if (doc?.kind === 'html' && doc.autoPrint && !touch) {
            const t = setTimeout(() => frameRef.current?.print(), 900);
            return () => clearTimeout(t);
        }
        return undefined;
    }, [doc, touch]);

    if (!doc) return null;

    const isHtmlDoc = doc.kind === 'html';
    const ftype = file?.type;                       // pdf | image | html | text | other
    const shownHtml = isHtmlDoc ? doc.html : (ftype === 'html' || ftype === 'text' ? file.html : null);
    const pdfName = withExtension(doc.title || 'document', 'pdf');

    // ---- a real PDF of a generated document (made on the server once) ----
    const serverPdf = async () => {
        if (pdfCache.current?.html === doc.html) return pdfCache.current.blob;
        const html = await inlineImages(doc.html);
        const r = await viewerAPI.pdf(html, doc.title || 'document');
        const blob = withType(r.data, 'application/pdf');
        pdfCache.current = { html: doc.html, blob };
        return blob;
    };

    const savePdf = async () => {
        setBusy('pdf'); setMessage('Making the PDF…');
        try {
            saveBlob(await serverPdf(), pdfName);
            setMessage(`Saved as "${pdfName}" — look in your Downloads (or the notification) to open it.`);
        } catch (err) {
            setMessage(await blobErrorMessage(err, 'The PDF could not be made just now — check the connection and try again.'));
        } finally { setBusy(null); }
    };

    const share = async () => {
        setBusy('share'); setMessage(null);
        try {
            let blob; let name;
            if (isHtmlDoc) { setMessage('Making the PDF…'); blob = await serverPdf(); name = pdfName; }
            else { blob = file.blob; name = file.name; }
            const f = new File([blob], name, { type: blob.type || 'application/octet-stream' });
            if (navigator.canShare && !navigator.canShare({ files: [f] })) { saveBlob(blob, name); setMessage(`Saved as "${name}".`); return; }
            await navigator.share({ files: [f], title: doc.title || name });
            setMessage(null);
        } catch (err) {
            if (err?.name === 'AbortError') setMessage(null); // the person closed the share sheet
            else setMessage(await blobErrorMessage(err, 'Sharing did not work here — use Save as PDF / Download instead.'));
        } finally { setBusy(null); }
    };

    const print = () => {
        if (shownHtml) {
            if (!frameRef.current?.print()) setMessage(touch
                ? 'Printing is not available on this device — use Save as PDF.'
                : 'Printing is not available here — use "Download PDF".');
        } else if (file?.blob && !openBlob(file.blob)) {
            setMessage('Your browser blocked the new tab — allow pop-ups for this site, or use Download.');
        }
    };

    const openNewTab = () => {
        if (isHtmlDoc) { if (!openHtmlTab(doc.html, doc.title)) setMessage('Your browser blocked the new tab — allow pop-ups for this site.'); return; }
        if (file?.blob && !openBlob(file.blob)) setMessage('Your browser blocked the new tab — allow pop-ups for this site.');
    };

    const download = () => { if (file?.blob) saveBlob(file.blob, file.name); };

    const btn = 'inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-50';
    const plain = `${btn} text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700`;
    const primary = `${btn} bg-primary-600 text-white hover:bg-primary-700`;
    const shareOk = touch && canShareFiles();
    const zoomable = touch ? (shownHtml || ftype === 'pdf') : (shownHtml);

    return (
        <div className="fixed inset-0 z-[70] flex flex-col bg-gray-900/70" role="dialog" aria-modal="true" aria-label={doc.title}>
            <div className="flex flex-col w-full h-full sm:h-[calc(100%-2rem)] sm:max-w-5xl sm:mx-auto sm:my-4 sm:rounded-xl overflow-hidden bg-gray-100 dark:bg-gray-900 shadow-2xl">
                {/* Bar */}
                <div className="flex items-center gap-1 sm:gap-2 px-2 sm:px-3 py-2 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
                    <p className="flex-1 min-w-0 truncate text-sm font-semibold text-gray-800 dark:text-gray-100" title={doc.title}>{doc.title}</p>

                    {zoomable && (
                        touch && ftype === 'pdf' ? (
                            <button type="button" className={plain} onClick={() => setZoom(z => (z >= 2 ? 1 : z + 0.5))} title="Zoom" aria-label="Zoom">
                                {zoom >= 2 ? <MagnifyingGlassMinusIcon className="h-5 w-5" /> : <MagnifyingGlassPlusIcon className="h-5 w-5" />}
                            </button>
                        ) : (
                            <button type="button" className={plain} onClick={() => setFit(f => !f)} title={fit ? 'Actual size' : 'Fit to screen'} aria-label={fit ? 'Actual size' : 'Fit to screen'}>
                                {fit ? <MagnifyingGlassPlusIcon className="h-5 w-5" /> : <MagnifyingGlassMinusIcon className="h-5 w-5" />}
                                <span className="hidden md:inline">{fit ? 'Actual size' : 'Fit to screen'}</span>
                            </button>
                        )
                    )}

                    {/* Generated document */}
                    {isHtmlDoc && touch && (
                        <button type="button" className={primary} onClick={savePdf} disabled={!!busy}>
                            <DocumentArrowDownIcon className="h-5 w-5" /><span>{busy === 'pdf' ? 'Making…' : 'Save as PDF'}</span>
                        </button>
                    )}
                    {isHtmlDoc && !touch && (
                        <>
                            <button type="button" className={primary} onClick={print}>
                                <PrinterIcon className="h-5 w-5" /><span className="hidden sm:inline">Print / Save as PDF</span>
                            </button>
                            <button type="button" className={plain} onClick={savePdf} disabled={!!busy} title="Download as a PDF file">
                                <DocumentArrowDownIcon className="h-5 w-5" /><span className="hidden lg:inline">{busy === 'pdf' ? 'Making…' : 'Download PDF'}</span>
                            </button>
                            <button type="button" className={plain} onClick={openNewTab} title="Open in a new tab">
                                <ArrowTopRightOnSquareIcon className="h-5 w-5" /><span className="hidden lg:inline">New tab</span>
                            </button>
                        </>
                    )}

                    {/* Uploaded file */}
                    {!isHtmlDoc && file && !touch && (ftype === 'pdf' || ftype === 'image' || ftype === 'html' || ftype === 'text') && (
                        <button type="button" className={primary} onClick={print}>
                            <PrinterIcon className="h-5 w-5" /><span className="hidden sm:inline">Print</span>
                        </button>
                    )}
                    {!isHtmlDoc && file && !touch && (ftype === 'pdf' || ftype === 'image') && (
                        <button type="button" className={plain} onClick={openNewTab} title="Open in a new tab">
                            <ArrowTopRightOnSquareIcon className="h-5 w-5" /><span className="hidden lg:inline">New tab</span>
                        </button>
                    )}
                    {!isHtmlDoc && file && (
                        <button type="button" className={touch ? primary : plain} onClick={download} title={`Download ${file.name}`}>
                            <ArrowDownTrayIcon className="h-5 w-5" /><span className={touch ? 'inline' : 'hidden lg:inline'}>Download</span>
                        </button>
                    )}

                    {shareOk && (isHtmlDoc || file) && (
                        <button type="button" className={plain} onClick={share} disabled={!!busy} title="Share" aria-label="Share">
                            <ShareIcon className="h-5 w-5" />
                        </button>
                    )}

                    <button type="button" className="p-2 rounded-lg text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700" onClick={() => close()} title="Close" aria-label="Close">
                        <XMarkIcon className="h-6 w-6" />
                    </button>
                </div>
                {message && <p className="px-3 py-2 text-xs text-amber-800 bg-amber-50 flex-shrink-0" role="status">{message}</p>}

                {/* Content */}
                <div className="flex-1 overflow-auto p-2 sm:p-4" style={{ WebkitOverflowScrolling: 'touch' }}>
                    {shownHtml && (
                        <ScaledDocumentFrame ref={frameRef} html={shownHtml} title={doc.title} fit={fit} sandboxed={!isHtmlDoc} />
                    )}
                    {!isHtmlDoc && !file && <p className="py-10 text-center text-sm text-gray-500">Opening…</p>}
                    {ftype === 'image' && <ImageView blob={file.blob} title={doc.title} />}
                    {ftype === 'pdf' && !touch && <PdfFrame blob={file.blob} title={doc.title} />}
                    {ftype === 'pdf' && touch && <PdfPages blob={file.blob} zoom={zoom} onError={setMessage} />}
                    {ftype === 'other' && (
                        <div className="max-w-sm mx-auto mt-10 text-center bg-white dark:bg-gray-800 rounded-xl shadow p-6">
                            <p className="text-sm font-semibold text-gray-800 dark:text-gray-100 mb-1">{file.name}</p>
                            <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">This kind of file (for example Word or Excel) cannot be shown inside the system. Download it and it opens in the right app on your device.</p>
                            <button type="button" className="btn-primary" onClick={download}>Download</button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

// A picture, from its own short-lived address.
const ImageView = ({ blob, title }) => {
    const [url, setUrl] = useState(null);
    useEffect(() => {
        const u = URL.createObjectURL(blob);
        setUrl(u);
        return () => URL.revokeObjectURL(u);
    }, [blob]);
    return url ? <img src={url} alt={title} className="max-w-full h-auto mx-auto bg-white shadow" /> : null;
};

// A computer shows a PDF with its own built-in viewer.
const PdfFrame = ({ blob, title }) => {
    const [url, setUrl] = useState(null);
    useEffect(() => {
        const u = URL.createObjectURL(blob);
        setUrl(u);
        return () => URL.revokeObjectURL(u);
    }, [blob]);
    return url ? <iframe title={title} src={url} className="w-full bg-white" style={{ height: 'calc(100vh - 8rem)', border: 'none' }} /> : null;
};

export default DocumentViewerHost;
