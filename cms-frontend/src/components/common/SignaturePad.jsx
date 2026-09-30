// ============================================================
// SIGNATURE PAD (v1.23.0, Section 4.29)
//
// A draw-on-screen signature capture — chosen over a photo/scan
// upload because it needs no scanner, gives a consistent result on
// any device (phone, tablet, laptop trackpad), and is the same kind
// of interaction most people already know from courier/delivery
// apps. Uses the native Pointer Events API (not separate mouse/touch
// handlers) so mouse, touch, and stylus input all work identically
// without an external drawing library.
//
// Exports the drawing as a white-background PNG data URL via
// onChange(dataUrl) — white background (not transparent) so it reads
// clearly once printed into a document/certificate, matching how a
// real ink signature on paper looks.
//
// Usage:
//   <SignaturePad onChange={(dataUrl) => setSignature(dataUrl)} />
// ============================================================

import { useRef, useState, useEffect, useLayoutEffect, useCallback } from 'react';

const SignaturePad = ({ onChange, width = 400, height = 160 }) => {
    const canvasRef = useRef(null);
    // v1.77.0 — never wider than the space it sits in (a 400px pad ran
    // off a phone screen). Measured once when it appears, so turning the
    // phone never wipes a signature being drawn.
    const boxRef = useRef(null);
    const [drawWidth, setDrawWidth] = useState(width);
    useLayoutEffect(() => {
        const room = boxRef.current?.parentElement?.clientWidth;
        if (room) setDrawWidth(Math.max(200, Math.min(width, room - 4)));
    }, [width]);
    const drawingRef = useRef(false);
    const [hasDrawn, setHasDrawn] = useState(false);

    // High-DPI aware setup so the signature isn't blurry on retina
    // screens/phones — draws at devicePixelRatio scale internally,
    // but the element itself stays at the requested CSS size.
    const setupCanvas = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ratio = window.devicePixelRatio || 1;
        canvas.width = drawWidth * ratio;
        canvas.height = height * ratio;
        canvas.style.width = `${drawWidth}px`;
        canvas.style.height = `${height}px`;
        const ctx = canvas.getContext('2d');
        ctx.scale(ratio, ratio);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, drawWidth, height);
        ctx.strokeStyle = '#1a1a1a';
        ctx.lineWidth = 2.2;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
    }, [drawWidth, height]);

    useEffect(() => { setupCanvas(); }, [setupCanvas]);

    const getPos = (e) => {
        const rect = canvasRef.current.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    const handlePointerDown = (e) => {
        e.preventDefault();
        drawingRef.current = true;
        const ctx = canvasRef.current.getContext('2d');
        const { x, y } = getPos(e);
        ctx.beginPath();
        ctx.moveTo(x, y);
    };

    const handlePointerMove = (e) => {
        if (!drawingRef.current) return;
        e.preventDefault();
        const ctx = canvasRef.current.getContext('2d');
        const { x, y } = getPos(e);
        ctx.lineTo(x, y);
        ctx.stroke();
        if (!hasDrawn) setHasDrawn(true);
    };

    const finishStroke = () => {
        if (!drawingRef.current) return;
        drawingRef.current = false;
        if (onChange && hasDrawn) {
            onChange(canvasRef.current.toDataURL('image/png'));
        }
    };

    const handleClear = () => {
        setupCanvas();
        setHasDrawn(false);
        if (onChange) onChange(null);
    };

    return (
        <div>
            <div ref={boxRef} className="border-2 border-dashed border-gray-300 rounded-lg inline-block max-w-full bg-white touch-none">
                <canvas
                    ref={canvasRef}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={finishStroke}
                    onPointerLeave={finishStroke}
                    className="cursor-crosshair touch-none rounded-lg"
                    style={{ display: 'block' }}
                />
            </div>
            <div className="flex items-center justify-between mt-2">
                <span className="text-xs text-gray-400">
                    {hasDrawn ? 'Looks good' : 'Draw your signature above with mouse, finger, or stylus'}
                </span>
                <button
                    type="button"
                    onClick={handleClear}
                    className="text-xs font-medium text-gray-500 hover:text-gray-700"
                >
                    Clear
                </button>
            </div>
        </div>
    );
};

export default SignaturePad;
