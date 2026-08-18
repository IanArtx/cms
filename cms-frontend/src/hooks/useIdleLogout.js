// ============================================================
// USE IDLE LOGOUT (v1.28.2)
// Auto-logs the user out after a period of no interaction — the
// same protection any banking/finance app has, since this system
// holds real financial records and a JWT access token alone
// (silently refreshed on every request) would otherwise keep a
// forgotten, unattended browser tab logged in indefinitely.
//
// "Activity" is any of the usual interaction events — moving the
// mouse, typing, clicking, scrolling, or touching the screen — each
// one resets the idle timer. When the timer fires with no activity
// in between, `onIdle` is called once. No warning dialog before it
// fires, by design — this stays a background safety net rather than
// another popup interrupting normal use.
// ============================================================

import { useEffect, useRef } from 'react';

const ACTIVITY_EVENTS = ['mousedown', 'mousemove', 'keydown', 'scroll', 'touchstart', 'click'];

const useIdleLogout = (timeoutMs, onIdle) => {
    const timerRef = useRef(null);
    const onIdleRef = useRef(onIdle);
    onIdleRef.current = onIdle;

    useEffect(() => {
        if (!timeoutMs) return undefined;

        const resetTimer = () => {
            if (timerRef.current) clearTimeout(timerRef.current);
            timerRef.current = setTimeout(() => {
                onIdleRef.current?.();
            }, timeoutMs);
        };

        ACTIVITY_EVENTS.forEach(evt => window.addEventListener(evt, resetTimer, { passive: true }));
        resetTimer();

        return () => {
            if (timerRef.current) clearTimeout(timerRef.current);
            ACTIVITY_EVENTS.forEach(evt => window.removeEventListener(evt, resetTimer));
        };
    }, [timeoutMs]);
};

export default useIdleLogout;
