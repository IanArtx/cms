// ============================================================
// STORAGE SERVICE (v1.29.1, Section 4.34)
//
// Single choke point for saving and serving every uploaded file in
// this system — profile photos, drawn signatures (+ their per-
// signing snapshots), the company logo, company stamps/seals,
// uploaded Documents, Auditor report files, and expense-
// reimbursement receipts.
//
// WHY THIS EXISTS: Render's web service disk is EPHEMERAL — anything
// written to local disk is wiped on the next deploy or restart. That
// silently broke uploaded profile photos (fixed in v1.28.3 for the
// URL-format half of the bug, but the underlying "the file itself
// disappears on redeploy" problem was still there for every upload
// type) and would eventually bite Documents, Audit report files, and
// everything else that used the same pattern. This service moves
// file bytes into an S3-compatible bucket (Cloudflare R2 by default —
// see DEPLOYMENT_GUIDE.md for setup) whenever S3_ENDPOINT/S3_BUCKET/
// S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY are configured, so files
// persist across every future deploy forever.
//
// LOCAL DEV FALLBACK: if those env vars are NOT set (e.g. a developer
// running the backend locally without R2 credentials), every function
// here transparently falls back to the exact same local-disk
// behaviour this system always had — nobody needs real R2 credentials
// just to test file uploads on their own machine.
//
// EVERY FILE IS ADDRESSED BY A "KEY" — the same relative path multer
// used to write locally, e.g. "profiles/1699999999-photo.jpg" or
// "documents/1699999999-report.pdf". Existing DB values already in
// the "/uploads/<key>" URL-path format (photo_path, signature_path,
// logo_url, stamp file_path, document file_path, etc.) need no
// migration — toKey() below strips that prefix, which IS the key.
// ============================================================

const fs = require('fs');
const path = require('path');
const {
    S3Client, PutObjectCommand, GetObjectCommand,
    DeleteObjectCommand, CopyObjectCommand,
} = require('@aws-sdk/client-s3');
const { createError } = require('../utils/errors');

const isS3Configured = !!(
    process.env.S3_ENDPOINT && process.env.S3_BUCKET &&
    process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
);

const s3Client = isS3Configured ? new S3Client({
    region: process.env.S3_REGION || 'auto', // R2 uses 'auto'; AWS S3/other providers set a real region
    endpoint: process.env.S3_ENDPOINT,
    credentials: {
        accessKeyId:     process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    },
}) : null;

const localFilePath = (key) => path.join(process.env.UPLOAD_DIR || './uploads', key);

// ============================================================
// GENERATE A KEY for a newly-uploaded file — timestamp-prefixed and
// sanitised, same convention the old multer diskStorage `filename`
// callback used (middleware/upload.js), just computed here now that
// multer runs in memoryStorage mode and never touches disk itself.
// ============================================================
const generateKey = (category, originalName) => {
    const sanitised = (originalName || 'file')
        .replace(/[^a-zA-Z0-9.\-_]/g, '_')
        .toLowerCase();
    return `${category}/${Date.now()}-${sanitised}`;
};

// ============================================================
// NORMALISE a stored DB value (which might be an old "/uploads/xxx"
// path, a bare key, or null) down to just the key, so callers never
// need to care which format a given row happens to hold.
// ============================================================
const toKey = (storedValue) => {
    if (!storedValue) return null;
    return String(storedValue).replace(/^\/?uploads\//, '');
};

// ============================================================
// SAVE a file's bytes under `key`. Called right after multer hands
// over req.file.buffer.
// ============================================================
const uploadBuffer = async (buffer, key, contentType) => {
    if (isS3Configured) {
        await s3Client.send(new PutObjectCommand({
            Bucket:      process.env.S3_BUCKET,
            Key:         key,
            Body:        buffer,
            ContentType: contentType || 'application/octet-stream',
        }));
    } else {
        const dest = localFilePath(key);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, buffer);
    }
    return key;
};

// ============================================================
// SERVE a file inline (no forced download) — used by the generic
// /uploads/:key* proxy route in server.js for "public-style" files
// (photos, signatures, logo, stamps) that have no access-control
// check of their own (same as when they were plain express.static
// files — this doesn't reduce security versus before, it matches it).
// ============================================================
const streamInline = async (key, res) => {
    if (isS3Configured) {
        try {
            const obj = await s3Client.send(new GetObjectCommand({
                Bucket: process.env.S3_BUCKET, Key: key,
            }));
            if (obj.ContentType) res.setHeader('Content-Type', obj.ContentType);
            obj.Body.pipe(res);
        } catch (err) {
            res.status(404).end();
        }
    } else {
        const filePath = localFilePath(key);
        if (!fs.existsSync(filePath)) {
            res.status(404).end();
            return;
        }
        fs.createReadStream(filePath).pipe(res);
    }
};

// ============================================================
// FORCE A DOWNLOAD with a specific filename — used by every
// permission-checked download endpoint (Documents, Audit report
// files, expense receipts) AFTER their own access-control check has
// already passed. Same Content-Disposition: attachment behaviour
// res.download() gave before.
// ============================================================
const sendFileDownload = async (res, key, downloadFilename) => {
    if (!key) throw createError.notFound('No file is attached to this record');

    if (isS3Configured) {
        let obj;
        try {
            obj = await s3Client.send(new GetObjectCommand({
                Bucket: process.env.S3_BUCKET, Key: key,
            }));
        } catch (err) {
            throw createError.notFound(
                'The uploaded file could not be found on the server. It may have been moved or deleted outside the app.'
            );
        }
        res.setHeader('Content-Disposition', `attachment; filename="${(downloadFilename || key).replace(/"/g, '')}"`);
        res.setHeader('Content-Type', obj.ContentType || 'application/octet-stream');
        obj.Body.pipe(res);
    } else {
        const filePath = localFilePath(key);
        if (!fs.existsSync(filePath)) {
            throw createError.notFound(
                'The uploaded file could not be found on the server. It may have been moved or deleted outside the app.'
            );
        }
        res.download(path.resolve(filePath), downloadFilename || key);
    }
};

// ============================================================
// COPY an object to a new key — used by signatureService's
// per-signing snapshot (a copy of the signer's current signature
// image, taken at the moment they sign, so a later change to their
// live signature never alters something already signed).
// ============================================================
const copyObject = async (sourceKey, destKey) => {
    if (isS3Configured) {
        await s3Client.send(new CopyObjectCommand({
            Bucket:     process.env.S3_BUCKET,
            CopySource: `${process.env.S3_BUCKET}/${sourceKey}`,
            Key:        destKey,
        }));
    } else {
        const src = localFilePath(sourceKey);
        const dest = localFilePath(destKey);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
    }
};

// ============================================================
// DELETE — best-effort, fire-and-forget (mirrors the old
// fs.unlink(path, () => {}) "don't block the response on cleanup"
// pattern used throughout this codebase before this service existed).
// ============================================================
const deleteObject = (key) => {
    if (!key) return;
    if (isS3Configured) {
        s3Client.send(new DeleteObjectCommand({
            Bucket: process.env.S3_BUCKET, Key: key,
        })).catch(() => {});
    } else {
        fs.unlink(localFilePath(key), () => {});
    }
};

module.exports = {
    isS3Configured,
    generateKey,
    toKey,
    uploadBuffer,
    streamInline,
    sendFileDownload,
    copyObject,
    deleteObject,
};
