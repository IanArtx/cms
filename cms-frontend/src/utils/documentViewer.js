// ============================================================
// DOCUMENT VIEWER — how any page asks for a document to be shown
// (v1.81.0). The viewer itself (components/common/DocumentViewerHost)
// is mounted once in the app layout and listens for these requests.
//
//   viewHtml(html, title, { autoPrint })  — a generated document
//   viewFile(blob, { title, fileName })   — an uploaded file (PDF, image…)
//
// Both return false when the viewer isn't mounted (e.g. on a page outside
// the signed-in layout), so callers can fall back to the old behaviour.
// ============================================================

export const VIEW_EVENT = 'cms:view-document';

export const viewerReady = () => typeof window !== 'undefined' && !!window.__cmsDocumentViewer;

// Phones and tablets (touch, no fine pointer) — printing straight away
// makes no sense there, the person first looks at the document.
export const isTouchDevice = () => {
    try {
        return window.matchMedia('(pointer: coarse)').matches || window.matchMedia('(hover: none)').matches;
    } catch (_) {
        return false;
    }
};

export const viewHtml = (html, title = 'Document', { autoPrint = false } = {}) => {
    if (!viewerReady()) return false;
    window.dispatchEvent(new CustomEvent(VIEW_EVENT, { detail: { kind: 'html', html, title, autoPrint: autoPrint && !isTouchDevice() } }));
    return true;
};

export const viewFile = (blob, { title = 'Document', fileName = null } = {}) => {
    if (!viewerReady()) return false;
    window.dispatchEvent(new CustomEvent(VIEW_EVENT, { detail: { kind: 'file', blob, title, fileName: fileName || title } }));
    return true;
};
