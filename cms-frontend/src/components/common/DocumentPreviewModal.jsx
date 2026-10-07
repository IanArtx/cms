// ============================================================
// DOCUMENT PREVIEW MODAL
// A reusable "click a record's name to preview its document" helper.
//
// v1.81.0 — it now hands the document to the system-wide document viewer
// (components/common/DocumentViewerHost), which shows the page scaled to
// the screen on phones, tablets and computers, with Print / Save as PDF.
// Only if that viewer isn't available does it show its own window, which
// also uses the scaled page.
//
// Usage (unchanged):
//   const [preview, setPreview] = useState(null);
//   onClick={() => setPreview({ html: someTemplate(row), title: row.reference_code })}
//   <DocumentPreviewModal preview={preview} onClose={() => setPreview(null)} />
// ============================================================

import { useEffect, useRef, useState } from 'react';
import { XMarkIcon, PrinterIcon } from '@heroicons/react/24/outline';
import ScaledDocumentFrame from './ScaledDocumentFrame';
import { viewHtml } from '../../utils/documentViewer';

const DocumentPreviewModal = ({ preview, onClose }) => {
    const frameRef = useRef(null);
    const [ownWindow, setOwnWindow] = useState(false);

    useEffect(() => {
        if (!preview) { setOwnWindow(false); return; }
        if (viewHtml(preview.html, preview.title || 'Document')) onClose();
        else setOwnWindow(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [preview]);

    if (!preview || !ownWindow) return null;

    return (
        <div className="fixed inset-0 z-50 flex flex-col bg-black/50">
            <div className="flex flex-col w-full h-full sm:h-[calc(100%-2rem)] sm:max-w-5xl sm:mx-auto sm:my-4 sm:rounded-xl overflow-hidden bg-gray-100">
                <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-gray-200 bg-white flex-shrink-0">
                    <p className="text-sm font-medium text-gray-700 truncate">{preview.title || 'Document Preview'}</p>
                    <div className="flex items-center gap-2 flex-shrink-0">
                        <button type="button" onClick={() => frameRef.current?.print()} className="btn-primary text-sm flex items-center gap-2 py-1.5">
                            <PrinterIcon className="h-4 w-4" />
                            <span className="hidden sm:inline">Print / Save as PDF</span>
                        </button>
                        <button type="button" onClick={onClose} className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-200 hover:text-gray-600" title="Close">
                            <XMarkIcon className="h-5 w-5" />
                        </button>
                    </div>
                </div>
                <div className="flex-1 overflow-auto p-2 sm:p-4">
                    <ScaledDocumentFrame ref={frameRef} html={preview.html} title={preview.title || 'Document preview'} />
                </div>
            </div>
        </div>
    );
};

export default DocumentPreviewModal;
