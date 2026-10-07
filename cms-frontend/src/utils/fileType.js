// ============================================================
// WHAT KIND OF FILE IS THIS? (v1.82.1)
//
// The document viewer used to trust the type the server sent with a
// file. On a computer running the system locally (files kept on disk,
// not in cloud storage) that type is guessed from the file name — and a
// stored name without ".pdf" came back as "application/octet-stream".
// The viewer then said the file could not be shown and "Download" saved
// it without the right ending, so a phone opened it as text.
//
// Now the viewer looks at the first bytes of the file itself (every PDF
// starts with "%PDF-", every PNG with the same 8 bytes …), then at the
// file name, and only then at the type the server sent.
//
//   const info = await detectFileType(blob, 'Minutes AGM 2026');
//   → { kind: 'pdf' | 'image' | 'html' | 'text' | 'other', mime, ext }
//   const typed = withType(blob, info.mime)        // same bytes, right type
//   const name  = withExtension('Minutes AGM 2026', info.ext) // "… .pdf"
// ============================================================

const startsWith = (bytes, sig) => sig.every((b, i) => bytes[i] === b);

const EXT_TYPES = {
    pdf: ['pdf', 'application/pdf'],
    png: ['image', 'image/png'], jpg: ['image', 'image/jpeg'], jpeg: ['image', 'image/jpeg'],
    gif: ['image', 'image/gif'], webp: ['image', 'image/webp'], bmp: ['image', 'image/bmp'],
    svg: ['image', 'image/svg+xml'],
    html: ['html', 'text/html'], htm: ['html', 'text/html'],
    txt: ['text', 'text/plain'], csv: ['text', 'text/csv'],
    doc: ['other', 'application/msword'],
    docx: ['other', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    xls: ['other', 'application/vnd.ms-excel'],
    xlsx: ['other', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ppt: ['other', 'application/vnd.ms-powerpoint'],
    pptx: ['other', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    zip: ['other', 'application/zip'],
};

const MIME_EXT = {
    'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
    'image/bmp': 'bmp', 'image/svg+xml': 'svg', 'text/html': 'html', 'text/plain': 'txt', 'text/csv': 'csv',
};

export const extensionOf = (name) => {
    const m = /\.([a-z0-9]{1,5})$/i.exec(String(name || '').trim());
    return m ? m[1].toLowerCase() : '';
};

const fromMime = (mime) => {
    const m = String(mime || '').split(';')[0].trim().toLowerCase();
    if (!m || m === 'application/octet-stream' || m === 'binary/octet-stream') return null;
    if (m === 'application/pdf') return { kind: 'pdf', mime: m, ext: 'pdf' };
    if (m.startsWith('image/')) return { kind: 'image', mime: m, ext: MIME_EXT[m] || m.slice(6) };
    if (m === 'text/html') return { kind: 'html', mime: m, ext: 'html' };
    if (m.startsWith('text/')) return { kind: 'text', mime: m, ext: MIME_EXT[m] || 'txt' };
    return { kind: 'other', mime: m, ext: '' };
};

/** Look at the file's own first bytes, then its name, then the type sent. */
export const detectFileType = async (blob, fileName = '') => {
    let head = new Uint8Array(0);
    try { head = new Uint8Array(await blob.slice(0, 512).arrayBuffer()); } catch (_) { /* ignore */ }

    if (startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { kind: 'pdf', mime: 'application/pdf', ext: 'pdf' };          // %PDF-
    if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: 'image', mime: 'image/png', ext: 'png' };
    if (startsWith(head, [0xff, 0xd8, 0xff])) return { kind: 'image', mime: 'image/jpeg', ext: 'jpg' };
    if (startsWith(head, [0x47, 0x49, 0x46, 0x38])) return { kind: 'image', mime: 'image/gif', ext: 'gif' };                       // GIF8
    if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head.slice(8), [0x57, 0x45, 0x42, 0x50])) return { kind: 'image', mime: 'image/webp', ext: 'webp' };
    if (startsWith(head, [0x42, 0x4d])) {
        const byName = EXT_TYPES[extensionOf(fileName)];
        if (byName && byName[0] === 'image') return { kind: 'image', mime: 'image/bmp', ext: 'bmp' };
    }
    if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) {                                                                                 // zip family (docx, xlsx …)
        const ext = extensionOf(fileName);
        const byName = EXT_TYPES[ext];
        return { kind: 'other', mime: byName ? byName[1] : 'application/zip', ext: byName ? ext : 'zip' };
    }

    // Text-like: decide between HTML and plain text by looking at it.
    const looksText = head.length > 0 && Array.from(head.slice(0, 256)).every(b => b === 9 || b === 10 || b === 13 || b >= 32);
    if (looksText) {
        let text = '';
        try { text = new TextDecoder('utf-8').decode(head).replace(/^﻿/, '').trimStart().toLowerCase(); } catch (_) { /* ignore */ }
        if (text.startsWith('<!doctype html') || text.startsWith('<html') || /^<(head|body|div|table|style|meta)[\s>]/.test(text)) {
            return { kind: 'html', mime: 'text/html', ext: 'html' };
        }
        if (text.startsWith('<svg') || (text.startsWith('<?xml') && text.includes('<svg'))) return { kind: 'image', mime: 'image/svg+xml', ext: 'svg' };
    }

    const ext = extensionOf(fileName);
    if (EXT_TYPES[ext]) return { kind: EXT_TYPES[ext][0], mime: EXT_TYPES[ext][1], ext };
    const sent = fromMime(blob.type);
    if (sent) return sent;
    if (looksText) return { kind: 'text', mime: 'text/plain', ext: 'txt' };
    return { kind: 'other', mime: 'application/octet-stream', ext: '' };
};

/** The same bytes, labelled with the right type. */
export const withType = (blob, mime) => (blob.type === mime ? blob : new Blob([blob], { type: mime }));

/** "Minutes AGM" + "pdf" → "Minutes AGM.pdf" (unless it already ends so). */
export const withExtension = (name, ext) => {
    const base = String(name || 'document').trim() || 'document';
    if (!ext) return base;
    return extensionOf(base) === ext.toLowerCase() ? base : `${base.replace(/[.\s]+$/, '')}.${ext}`;
};
