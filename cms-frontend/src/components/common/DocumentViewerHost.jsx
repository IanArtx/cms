// ============================================================
// DOCUMENT VIEWER (v1.81.0) — one viewer for the whole system.
//
// Before: "Preview" and "Print / Download" opened a blank new browser tab
// and wrote the document into it. Phones and tablets often block that tab,
// open it empty, or show the page source — "only working for the pc and
// showing lines of code on other devices".
//
// Now every preview opens here, inside the app, on every device:
//   • generated documents — the page itself, shrunk to fit the screen
//     (ScaledDocumentFrame), with Print / Save as PDF, Open in a new tab,
//     Fit / Actual size and Close;
//   • uploaded images — shown directly;
//   • uploaded PDFs — shown inside on a computer; on a phone or tablet
//     (whose browsers cannot show a PDF inside a page) a clear "Open the PDF"
//     button hands it to the device's PDF viewer, plus Download;
//   • any other file — Download.
// The phone's Back button closes the viewer instead of leaving the page.
//
// Pages ask for it through utils/documentViewer.js (viewHtml / viewFile);
// exportUtils.previewDocument / printDocument already do, so every existing
// Preview / Print button in the system uses it without further changes.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { XMarkIcon, PrinterIcon, ArrowTopRightOnSquareIcon, ArrowDownTrayIcon, MagnifyingGlassPlusIcon, MagnifyingGlassMinusIcon } from '@heroicons/react/24/outline';
import ScaledDocumentFrame from './ScaledDocumentFrame';
import { VIEW_EVENT, isTouchDevice } from '../../utils/documentViewer';

const openBlob = (blob) => {
    const url = URL.createObjectURL(blob);
    const w = window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return !!w;
};

const DocumentViewerHost = () => {
    const [doc, setDoc] = useState(null);       // { kind, html | blob, title, fileName, autoPrint, url }
    const [fit, setFit] = useState(true);
    const [message, setMessage] = useState(null);
    const frameRef = useRef(null);
    const pushedRef = useRef(false);

    const close = useCallback((fromBack = false) => {
        setDoc(prev => {
            if (prev?.url) URL.revokeObjectURL(prev.url);
            return null;
        });
        setMessage(null);
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
            const next = { ...d };
            if (d.kind === 'file' && d.blob) next.url = URL.createObjectURL(d.blob);
            setFit(true);
            setMessage(null);
            setDoc(prev => {
                if (prev?.url) URL.revokeObjectURL(prev.url);
                return next;
            });
            if (!pushedRef.current) {
                try { window.history.pushState({ ...(window.history.state || {}), cmsViewer: true }, ''); pushedRef.current = true; } catch (_) { /* ignore */ }
            }
        };
        window.addEventListener(VIEW_EVENT, onView);
        return () => { window.removeEventListener(VIEW_EVENT, onView); window.__cmsDocumentViewer = false; };
    }, []);

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

    // "Download" buttons on a computer print straight away (as before).
    useEffect(() => {
        if (doc?.kind === 'html' && doc.autoPrint) {
            const t = setTimeout(() => frameRef.current?.print(), 900);
            return () => clearTimeout(t);
        }
        return undefined;
    }, [doc]);

    if (!doc) return null;

    const touch = isTouchDevice();
    const mime = doc.blob?.type || '';
    const isPdf = doc.kind === 'file' && /pdf/i.test(mime);
    const isImage = doc.kind === 'file' && /^image\//i.test(mime);

    const print = () => {
        if (doc.kind === 'html') {
            if (!frameRef.current?.print()) setMessage('Printing is not available here — use "Open in new tab", then your browser\'s Share / Print.');
        } else if (doc.blob && !openBlob(doc.blob)) {
            setMessage('Your browser blocked the new tab — allow pop-ups for this site, or use Download.');
        }
    };
    const openNewTab = () => {
        const blob = doc.kind === 'html' ? new Blob([doc.html], { type: 'text/html;charset=utf-8' }) : doc.blob;
        if (!openBlob(blob)) setMessage('Your browser blocked the new tab — allow pop-ups for this site.');
    };
    const download = () => {
        const a = document.createElement('a');
        a.href = doc.url;
        a.download = doc.fileName || doc.title || 'document';
        document.body.appendChild(a);
        a.click();
        a.remove();
    };

    const btn = 'inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium';
    return (
        <div className="fixed inset-0 z-[70] flex flex-col bg-gray-900/70" role="dialog" aria-modal="true" aria-label={doc.title}>
            <div className="flex flex-col w-full h-full sm:h-[calc(100%-2rem)] sm:max-w-5xl sm:mx-auto sm:my-4 sm:rounded-xl overflow-hidden bg-gray-100 dark:bg-gray-900 shadow-2xl">
                {/* Bar */}
                <div className="flex items-center gap-2 px-3 py-2 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
                    <p className="flex-1 min-w-0 truncate text-sm font-semibold text-gray-800 dark:text-gray-100" title={doc.title}>{doc.title}</p>
                    {doc.kind === 'html' && (
                        <button type="button" className={`${btn} text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700`}
                            onClick={() => setFit(f => !f)} title={fit ? 'Actual size' : 'Fit to screen'}>
                            {fit ? <MagnifyingGlassPlusIcon className="h-5 w-5" /> : <MagnifyingGlassMinusIcon className="h-5 w-5" />}
                            <span className="hidden md:inline">{fit ? 'Actual size' : 'Fit to screen'}</span>
                        </button>
                    )}
                    {(doc.kind === 'html' || isPdf || isImage) && (
                        <button type="button" className={`${btn} bg-primary-600 text-white hover:bg-primary-700`} onClick={print}>
                            <PrinterIcon className="h-5 w-5" /><span className="hidden sm:inline">Print / Save as PDF</span>
                        </button>
                    )}
                    <button type="button" className={`${btn} text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700`} onClick={openNewTab} title="Open in a new tab">
                        <ArrowTopRightOnSquareIcon className="h-5 w-5" /><span className="hidden lg:inline">New tab</span>
                    </button>
                    {doc.kind === 'file' && (
                        <button type="button" className={`${btn} text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700`} onClick={download} title="Download">
                            <ArrowDownTrayIcon className="h-5 w-5" /><span className="hidden lg:inline">Download</span>
                        </button>
                    )}
                    <button type="button" className="p-2 rounded-lg text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700" onClick={() => close()} title="Close" aria-label="Close">
                        <XMarkIcon className="h-6 w-6" />
                    </button>
                </div>
                {message && <p className="px-3 py-2 text-xs text-amber-800 bg-amber-50 flex-shrink-0">{message}</p>}

                {/* Content */}
                <div className="flex-1 overflow-auto p-2 sm:p-4" style={{ WebkitOverflowScrolling: 'touch' }}>
                    {doc.kind === 'html' && <ScaledDocumentFrame ref={frameRef} html={doc.html} title={doc.title} fit={fit} />}
                    {isImage && <img src={doc.url} alt={doc.title} className="max-w-full h-auto mx-auto bg-white shadow" />}
                    {isPdf && !touch && <iframe title={doc.title} src={doc.url} className="w-full bg-white" style={{ height: 'calc(100vh - 8rem)', border: 'none' }} />}
                    {isPdf && touch && (
                        <div className="max-w-sm mx-auto mt-10 text-center bg-white dark:bg-gray-800 rounded-xl shadow p-6">
                            <p className="text-sm text-gray-700 dark:text-gray-200 mb-1 font-semibold">PDF document</p>
                            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">Phones and tablets show PDFs in their own viewer.</p>
                            <div className="flex flex-col gap-2">
                                <button type="button" className="btn-primary" onClick={openNewTab}>Open the PDF</button>
                                <button type="button" className="btn-secondary" onClick={download}>Download</button>
                            </div>
                        </div>
                    )}
                    {doc.kind === 'file' && !isPdf && !isImage && (
                        <div className="max-w-sm mx-auto mt-10 text-center bg-white dark:bg-gray-800 rounded-xl shadow p-6">
                            <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">This kind of file can't be shown inside the system. Download it to open it with the right app.</p>
                            <button type="button" className="btn-primary" onClick={download}>Download</button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default DocumentViewerHost;
