// ============================================================
// PHOTO CROP MODAL (v1.28.3)
// A lightweight "focus in frame" step for profile photo uploads —
// drag to reposition, slide to zoom, inside a circular preview that
// exactly matches how the photo will appear as an avatar everywhere
// else in the app. No external cropping library — just a plain
// <canvas> export, so there's nothing new to install or bundle.
//
// Takes a raw File the user just picked, lets them frame it, and on
// Save produces a square PNG Blob (EXPORT_SIZE x EXPORT_SIZE) via
// onSave(blob) — the caller uploads that blob instead of the
// original file. Cancelling discards the selection entirely.
// ============================================================

import { useState, useEffect, useRef } from 'react';

const FRAME_SIZE = 240;  // on-screen preview size, px
const EXPORT_SIZE = 480; // exported image size, px (2x for crispness)

const clampOffset = (offset, scale, naturalSize) => {
    const dispW = naturalSize.w * scale;
    const dispH = naturalSize.h * scale;
    const maxX = Math.max(0, (dispW - FRAME_SIZE) / 2);
    const maxY = Math.max(0, (dispH - FRAME_SIZE) / 2);
    return {
        x: Math.min(maxX, Math.max(-maxX, offset.x)),
        y: Math.min(maxY, Math.max(-maxY, offset.y)),
    };
};

const PhotoCropModal = ({ isOpen, file, onCancel, onSave, saving }) => {
    const [imgUrl, setImgUrl] = useState(null);
    const [naturalSize, setNaturalSize] = useState({ w: 0, h: 0 });
    const [scale, setScale] = useState(1);
    const [minScale, setMinScale] = useState(1);
    const [offset, setOffset] = useState({ x: 0, y: 0 });
    const dragRef = useRef(null);
    const imgRef = useRef(null);

    useEffect(() => {
        if (!isOpen || !file) {
            setImgUrl(null);
            return;
        }
        const url = URL.createObjectURL(file);
        setImgUrl(url);
        setOffset({ x: 0, y: 0 });
        return () => URL.revokeObjectURL(url);
    }, [isOpen, file]);

    if (!isOpen) return null;

    const handleImgLoad = (e) => {
        const { naturalWidth: w, naturalHeight: h } = e.target;
        setNaturalSize({ w, h });
        // "Cover" the circular frame, same idea as CSS background-size: cover —
        // the shorter dimension exactly fills the frame, nothing left blank.
        const cover = Math.max(FRAME_SIZE / w, FRAME_SIZE / h);
        setMinScale(cover);
        setScale(cover);
    };

    const startDrag = (e) => {
        const point = e.touches ? e.touches[0] : e;
        dragRef.current = { startX: point.clientX, startY: point.clientY, origin: offset };
    };
    const moveDrag = (e) => {
        if (!dragRef.current) return;
        const point = e.touches ? e.touches[0] : e;
        const dx = point.clientX - dragRef.current.startX;
        const dy = point.clientY - dragRef.current.startY;
        setOffset(clampOffset(
            { x: dragRef.current.origin.x + dx, y: dragRef.current.origin.y + dy },
            scale, naturalSize
        ));
    };
    const endDrag = () => { dragRef.current = null; };

    const handleZoom = (e) => {
        const s = parseFloat(e.target.value);
        setScale(s);
        setOffset(prev => clampOffset(prev, s, naturalSize));
    };

    const handleSave = () => {
        if (!imgRef.current || !naturalSize.w) return;
        const canvas = document.createElement('canvas');
        canvas.width = EXPORT_SIZE;
        canvas.height = EXPORT_SIZE;
        const ctx = canvas.getContext('2d');
        const ratio = EXPORT_SIZE / FRAME_SIZE;
        const dispW = naturalSize.w * scale;
        const dispH = naturalSize.h * scale;
        const frameLeft = (FRAME_SIZE - dispW) / 2 + offset.x;
        const frameTop = (FRAME_SIZE - dispH) / 2 + offset.y;
        ctx.drawImage(
            imgRef.current,
            0, 0, naturalSize.w, naturalSize.h,
            frameLeft * ratio, frameTop * ratio, dispW * ratio, dispH * ratio
        );
        canvas.toBlob((blob) => { if (blob) onSave(blob); }, 'image/png', 0.92);
    };

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            <div className="fixed inset-0 bg-black bg-opacity-50" onClick={saving ? undefined : onCancel} />
            <div className="flex min-h-full items-center justify-center p-4">
                <div className="relative bg-white rounded-xl shadow-xl max-w-sm w-full p-6">
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">Adjust Photo</h2>
                    <p className="text-sm text-gray-400 mb-4">
                        Drag to reposition, use the slider to zoom — this is exactly what
                        will show up as your circular profile photo.
                    </p>

                    <div
                        className="relative mx-auto rounded-full overflow-hidden bg-gray-100 select-none"
                        style={{ width: FRAME_SIZE, height: FRAME_SIZE, cursor: 'grab', touchAction: 'none' }}
                        onMouseDown={startDrag}
                        onMouseMove={moveDrag}
                        onMouseUp={endDrag}
                        onMouseLeave={endDrag}
                        onTouchStart={startDrag}
                        onTouchMove={moveDrag}
                        onTouchEnd={endDrag}
                    >
                        {imgUrl && (
                            <img
                                ref={imgRef}
                                src={imgUrl}
                                alt="Crop preview"
                                onLoad={handleImgLoad}
                                draggable={false}
                                crossOrigin="anonymous"
                                style={{
                                    position: 'absolute',
                                    left: '50%', top: '50%',
                                    width: naturalSize.w * scale,
                                    height: naturalSize.h * scale,
                                    transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px)`,
                                    maxWidth: 'none',
                                }}
                            />
                        )}
                    </div>

                    <div className="mt-4">
                        <label className="label">Zoom</label>
                        <input type="range"
                            min={minScale} max={minScale * 3} step={0.01}
                            value={scale}
                            onChange={handleZoom}
                            className="w-full" />
                    </div>

                    <div className="flex justify-end gap-3 pt-4">
                        <button type="button" onClick={onCancel} className="btn-secondary" disabled={saving}>
                            Cancel
                        </button>
                        <button type="button" onClick={handleSave} className="btn-primary" disabled={saving || !imgUrl}>
                            {saving ? 'Saving...' : 'Save Photo'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default PhotoCropModal;
