// ============================================================
// DOCUMENT PREVIEW MODAL
// A reusable "click a record's name to preview its document"
// modal. Renders the same styled HTML produced by exportUtils
// templates inside an iframe (so the letterhead/table/print CSS
// all render exactly as they would on the printed page), with a
// "Print / Save as PDF" button that reuses the standard print flow.
//
// Usage:
//   const [preview, setPreview] = useState(null);
//   ...
//   onClick={() => setPreview({ html: someTemplate(row), title: row.reference_code })}
//   ...
//   <DocumentPreviewModal preview={preview} onClose={() => setPreview(null)} />
// ============================================================

import { useRef } from 'react';
import { XMarkIcon, PrinterIcon } from '@heroicons/react/24/outline';
import { printDocument } from '../../utils/exportUtils';

const DocumentPreviewModal = ({ preview, onClose }) => {
    const iframeRef = useRef(null);

    if (!preview) return null;

    const handlePrint = () => {
        printDocument(preview.html, preview.title || 'Document');
    };

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            <div className="fixed inset-0 bg-black bg-opacity-50" onClick={onClose} />
            <div className="flex min-h-full items-center justify-center p-4">
                <div className="relative bg-white rounded-xl shadow-2xl w-full
                    max-w-4xl max-h-[90vh] flex flex-col overflow-hidden">
                    {/* Header */}
                    <div className="flex items-center justify-between px-5 py-3
                        border-b border-gray-200 bg-gray-50 flex-shrink-0">
                        <p className="text-sm font-medium text-gray-700 truncate">
                            {preview.title || 'Document Preview'}
                        </p>
                        <div className="flex items-center gap-2 flex-shrink-0">
                            <button
                                onClick={handlePrint}
                                className="btn-primary text-sm flex items-center gap-2 py-1.5"
                            >
                                <PrinterIcon className="h-4 w-4" />
                                Print / Save as PDF
                            </button>
                            <button
                                onClick={onClose}
                                className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-200
                                    hover:text-gray-600 transition-colors"
                                title="Close"
                            >
                                <XMarkIcon className="h-5 w-5" />
                            </button>
                        </div>
                    </div>

                    {/* Preview */}
                    <div className="flex-1 overflow-auto bg-gray-100 p-4">
                        <iframe
                            ref={iframeRef}
                            title="Document preview"
                            srcDoc={preview.html}
                            className="w-full bg-white shadow-sm mx-auto"
                            style={{ minHeight: '80vh', border: '1px solid #e5e7eb' }}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
};

export default DocumentPreviewModal;
