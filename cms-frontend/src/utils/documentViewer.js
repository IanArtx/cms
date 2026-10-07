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

import { detectFileType, withType } from './fileType';

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

// ============================================================
// v1.82.1 — a real PDF of a generated document, made on the server.
// Phones and tablets cannot "print to PDF" from inside a page, and the
// old "Download" saved the page's HTML (which a phone shows as code).
// The pictures in the document (logo, signatures, stamps) are first
// turned into data: images here in the browser — the server is not
// allowed to fetch anything itself.
// ============================================================
const toDataUrl = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
});

export const inlineImages = async (html) => {
    let doc;
    try { doc = new DOMParser().parseFromString(html, 'text/html'); } catch (_) { return html; }
    const imgs = Array.from(doc.querySelectorAll('img[src]'));
    const cache = new Map();
    await Promise.all(imgs.map(async (img) => {
        const src = img.getAttribute('src') || '';
        img.removeAttribute('onerror');
        if (!src || src.startsWith('data:')) return;
        let abs;
        try { abs = new URL(src, window.location.href).href; } catch (_) { img.remove(); return; }
        try {
            if (!cache.has(abs)) {
                cache.set(abs, fetch(abs, { credentials: 'omit' })
                    .then(r => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
                    .then(async (b) => {
                        // Files kept on the computer's own disk come without a type — look at the bytes.
                        const info = /^image\//.test(b.type) ? { kind: 'image', mime: b.type } : await detectFileType(b, abs);
                        if (info.kind !== 'image') throw new Error('not an image');
                        return toDataUrl(withType(b, info.mime));
                    }));
            }
            img.setAttribute('src', await cache.get(abs));
        } catch (_) {
            img.remove(); // could not be loaded — leave it out rather than show a broken picture
        }
    }));
    doc.querySelectorAll('script').forEach(s => s.remove());
    return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
};

// The message the server sent with a failed blob request.
export const blobErrorMessage = async (err, fallback) => {
    try {
        const data = err?.response?.data;
        if (data instanceof Blob) {
            const j = JSON.parse(await data.text());
            if (j?.message) return j.message;
        }
        if (err?.response?.data?.message) return err.response.data.message;
    } catch (_) { /* ignore */ }
    return fallback;
};
