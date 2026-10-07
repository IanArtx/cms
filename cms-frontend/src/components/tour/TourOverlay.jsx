// ============================================================
// TOUR OVERLAY (v1.82.0) — draws one step of a guided tour:
// the screen dimmed, a bright frame around the part being explained,
// and a card with the explanation, "3 of 14", Back / Next and
// "Skip tour". Keyboard: → or Enter next, ← back, Esc skip.
//
// Finding the part a step points at (first match that is on screen):
//   step.tourId  — an element marked data-tour="…" (menu, top bar …)
//   step.tab     — a tab in the page's tab row, by its label
//   step.button  — a button or link on the page, by its label
//   step.target  — 'title' | 'actions' | 'tabs' of the page header
//   (none)       — the card sits in the middle of the screen
// A step whose part cannot be found is skipped (the person's role does
// not have it). On a phone the card sits at the bottom of the screen
// (or the top when the part is low down) so it never covers it.
// ============================================================

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';

const PAD = 6;
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

const isShown = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = window.getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) return false;
    // Off-screen to the left: the closed phone menu drawer. (A tab further
    // along a row that scrolls sideways is fine — it is scrolled into view.)
    if (r.right <= 0) return false;
    return true;
};

const main = () => document.getElementById('main-content') || document.body;

export const findTarget = (step) => {
    if (!step) return null;
    const first = (els) => Array.from(els).find(isShown) || null;
    if (step.tourId) return first(document.querySelectorAll(`[data-tour="${step.tourId}"]`));
    if (step.tab) {
        const want = norm(step.tab);
        const tabs = main().querySelectorAll('[role="tablist"] [role="tab"], [role="tablist"] button, .tab-bar > *');
        return Array.from(tabs).find(t => norm(t.textContent).startsWith(want) && isShown(t))
            || Array.from(tabs).find(t => norm(t.textContent).includes(want) && isShown(t)) || null;
    }
    if (step.button) {
        const want = norm(step.button);
        const all = Array.from(main().querySelectorAll('button, a, [role="button"]')).filter(isShown);
        const banner = all.filter(b => b.closest('.page-banner'));
        const pick = (arr) => arr.find(b => norm(b.textContent) === want || norm(b.getAttribute('aria-label')) === want)
            || arr.find(b => norm(b.textContent).startsWith(want));
        return pick(banner) || pick(all) || null;
    }
    if (step.target === 'title') return first(main().querySelectorAll('.page-banner h1'));
    if (step.target === 'actions') return first(main().querySelectorAll('.page-banner .page-actions'));
    if (step.target === 'tabs') return first(main().querySelectorAll('[role="tablist"], .tab-bar'));
    return null;
};

const wantsTarget = (step) => !!(step && (step.tourId || step.tab || step.button || step.target));

const TourOverlay = ({ tour, onFinish, onSkip, setDrawerOpen }) => {
    const steps = tour.steps;
    const [index, setIndex] = useState(0);
    const [rect, setRect] = useState(null);      // the part, on screen
    const [ready, setReady] = useState(false);
    const [vw, setVw] = useState(window.innerWidth);
    const [vh, setVh] = useState(window.innerHeight);
    const targetRef = useRef(null);
    const cardRef = useRef(null);
    const nextRef = useRef(null);
    const [cardH, setCardH] = useState(200);
    const dirRef = useRef(1);

    const step = steps[index];
    // Which steps this person will see (worked out once, as the tour opens).
    const [avail] = useState(() => steps.map(s => !wantsTarget(s) || !!s.drawer || !!findTarget(s)));

    // ---- go to a step, skipping the ones whose part is not on screen ----
    const goTo = useCallback((from, dir) => {
        dirRef.current = dir;
        let i = from;
        while (i >= 0 && i < steps.length) {
            const s = steps[i];
            if (!wantsTarget(s) || s.drawer) break;      // drawer steps are checked once the drawer is open
            if (findTarget(s)) break;
            i += dir;
        }
        if (i < 0) i = 0;
        if (i >= steps.length) { onFinish(); return; }
        setReady(false);
        setIndex(i);
    }, [steps, onFinish]);

    useEffect(() => { goTo(0, 1); }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // ---- open / close the phone menu drawer for the steps inside it ----
    useEffect(() => {
        if (!step) return undefined;
        setDrawerOpen?.(!!step.drawer);
        let cancelled = false;
        // Give the drawer (or a page that is still drawing) a moment.
        const t = setTimeout(() => {
            if (cancelled) return;
            const el = wantsTarget(step) ? findTarget(step) : null;
            if (wantsTarget(step) && !el) { goTo(index + dirRef.current, dirRef.current); return; }
            targetRef.current = el;
            if (el) {
                try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (_) { /* ignore */ }
            }
            setReady(true);
        }, step.drawer ? 320 : 60);
        return () => { cancelled = true; clearTimeout(t); };
    }, [index]); // eslint-disable-line react-hooks/exhaustive-deps

    // When the tour ends, the drawer closes.
    useEffect(() => () => setDrawerOpen?.(false), [setDrawerOpen]);

    // ---- keep the frame on the part (scrolling, resizing, animations) ----
    useEffect(() => {
        if (!ready) return undefined;
        const measure = () => {
            setVw(window.innerWidth); setVh(window.innerHeight);
            const el = targetRef.current;
            if (!el || !el.isConnected) { setRect(null); return; }
            const r = el.getBoundingClientRect();
            setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
        };
        measure();
        const id = setInterval(measure, 250);
        window.addEventListener('resize', measure);
        window.addEventListener('scroll', measure, true);
        return () => { clearInterval(id); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); };
    }, [ready, index]);

    // The card's height (for placing it above or below the part).
    useLayoutEffect(() => {
        if (cardRef.current) setCardH(cardRef.current.offsetHeight || 200);
    }, [index, ready, vw]);

    useEffect(() => { if (ready) nextRef.current?.focus({ preventScroll: true }); }, [ready, index]);

    // ---- keyboard ----
    const next = useCallback(() => goTo(index + 1, 1), [goTo, index]);
    const back = useCallback(() => goTo(Math.max(0, index - 1), -1), [goTo, index]);
    useEffect(() => {
        const onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); onSkip(); }
            else if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
            else if (e.key === 'ArrowLeft') { e.preventDefault(); back(); }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [next, back, onSkip]);

    if (!step) return null;

    // "3 of 14" counts only the steps this person will see.
    const total = Math.max(1, avail.filter(Boolean).length);
    const position = Math.min(total, avail.slice(0, index + 1).filter(Boolean).length || 1);
    const isLast = !steps.slice(index + 1).some((s, k) => avail[index + 1 + k]);
    const hasPart = ready && rect && wantsTarget(step);

    // ---- where the card goes ----
    const phone = vw < 640;
    const cardW = Math.min(phone ? vw - 24 : 380, vw - 24);
    let cardStyle;
    if (!hasPart) {
        cardStyle = { left: (vw - cardW) / 2, top: Math.max(12, (vh - cardH) / 2) };
    } else if (phone) {
        // Bottom of the screen (above the bottom bar), or the top when the
        // part being explained is in the lower half.
        const low = rect.top + rect.height / 2 > vh / 2;
        cardStyle = low ? { left: 12, top: 12 } : { left: 12, bottom: 84 };
    } else {
        const below = rect.top + rect.height + PAD + 12;
        const above = rect.top - PAD - 12 - cardH;
        const right = rect.left + rect.width + PAD + 14;
        let left = Math.min(Math.max(12, rect.left), vw - cardW - 12);
        let top;
        if (rect.height > vh * 0.55 && right + cardW < vw - 12) {
            // a tall part (the menu): the card goes beside it
            left = right;
            top = Math.min(Math.max(12, rect.top + 24), vh - cardH - 12);
        } else if (below + cardH < vh - 12) top = below;
        else if (above > 12) top = above;
        else if (right + cardW < vw - 12) { left = right; top = Math.min(Math.max(12, rect.top), vh - cardH - 12); }
        else top = Math.max(12, vh - cardH - 12);
        cardStyle = { left, top };
    }

    const frame = hasPart ? {
        top: rect.top - PAD, left: rect.left - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2,
    } : null;

    return (
        <div className="fixed inset-0 z-[90]" aria-live="polite" data-tour-overlay="">
            {/* Blocks every click on the page while the tour is open. */}
            <div className="absolute inset-0" style={{ background: frame ? 'transparent' : 'rgba(2, 6, 23, 0.62)' }}
                onMouseDown={(e) => e.preventDefault()} />
            {frame && (
                <div
                    className="absolute rounded-xl pointer-events-none transition-all duration-200"
                    style={{
                        ...frame,
                        boxShadow: '0 0 0 9999px rgba(2, 6, 23, 0.62), 0 0 0 3px #38bdf8, 0 0 24px 4px rgba(56, 189, 248, 0.45)',
                    }}
                />
            )}
            <div
                ref={cardRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="tour-step-title"
                aria-describedby="tour-step-text"
                className="absolute rounded-2xl border shadow-2xl p-4 sm:p-5 transition-opacity duration-150"
                style={{
                    ...cardStyle, width: cardW, maxHeight: phone ? '46vh' : '70vh', overflowY: 'auto',
                    opacity: ready ? 1 : 0,
                    backgroundColor: 'var(--cms-surface)', borderColor: 'var(--cms-border)', color: 'var(--cms-text-primary)',
                }}
            >
                <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                        <p className="text-[11px] font-bold tracking-[0.08em] uppercase text-primary-600">
                            {tour.title} · {position} of {total}
                        </p>
                        <h2 id="tour-step-title" className="mt-1 text-base sm:text-lg font-bold leading-snug">{step.title || tour.title}</h2>
                    </div>
                    <button type="button" onClick={onSkip} aria-label="Close the tour"
                        className="w-9 h-9 -mr-1 -mt-1 flex items-center justify-center rounded-lg hover:bg-gray-100 flex-shrink-0"
                        style={{ color: 'var(--cms-text-muted)' }}>
                        <XMarkIcon className="w-5 h-5" />
                    </button>
                </div>
                <p id="tour-step-text" className="mt-2 text-sm leading-relaxed" style={{ color: 'var(--cms-text-secondary)' }}>{step.text}</p>

                <div className="mt-3 h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--cms-surface-hover)' }} aria-hidden="true">
                    <div className="h-full bg-primary-600 transition-all duration-300" style={{ width: `${(position / total) * 100}%` }} />
                </div>

                <div className="mt-4 flex items-center gap-2">
                    <button type="button" onClick={onSkip} className="text-sm font-semibold hover:underline mr-auto" style={{ color: 'var(--cms-text-muted)' }}>
                        {index === 0 && tour.auto ? 'Not now' : 'Skip tour'}
                    </button>
                    {index > 0 && (
                        <button type="button" onClick={back} className="btn-secondary !py-2 !px-3 text-sm">Back</button>
                    )}
                    <button ref={nextRef} type="button" onClick={isLast ? onFinish : next} className="btn-primary !py-2 !px-4 text-sm">
                        {isLast ? 'Finish' : index === 0 ? 'Start' : 'Next'}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default TourOverlay;
