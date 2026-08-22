// ============================================================
// USE IDLE LOGOUT (v1.28.2; rewritten v1.32.5 to actually work on
// mobile/backgrounded tabs — see the long comment below)
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
//
// WHY THE ORIGINAL v1.28.2 VERSION NEVER FIRED ON MOBILE:
// It only ever scheduled a single setTimeout and reset it blindly on
// every activity event, with no record of *when* the last activity
// actually happened. Two mobile-specific problems fell out of that:
//   1. Phones aggressively suspend a backgrounded tab's JS timers —
//      locking the screen or switching apps can pause a scheduled
//      setTimeout indefinitely, so it may never fire while
//      backgrounded no matter how long the phone sits locked.
//   2. Worse: the very act of coming BACK to the app (unlocking the
//      phone, tapping back into the browser) is itself a touchstart —
//      which the old code treated as fresh "activity" and used to
//      blindly restart a brand-new full-length timer, with no check
//      of how long the user had actually been away first. So even on
//      the rare occasion the background timer *did* survive, the
//      returning touch itself would race ahead and reset the clock
//      before it could fire — silently extending the session forever
//      through any number of lock/unlock cycles.
// Fixed by tracking a real `lastActivity` timestamp instead of only a
// timer, and checking ELAPSED REAL TIME (not "did a timer fire") in
// three places: on every activity event (before resetting anything),
// on the timer's own tick, and on the Page Visibility API's
// `visibilitychange` event firing when a backgrounded tab becomes
// visible again — that last one is what makes a phone that was locked
// well past the timeout log out the instant it's unlocked, rather
// than waiting for another full idle period to elapse in the
// foreground first.
// ============================================================

import { useEffect, useRef } from 'react';

const ACTIVITY_EVENTS = ['mousedown', 'mousemove', 'keydown', 'scroll', 'touchstart', 'click'];

const useIdleLogout = (timeoutMs, onIdle) => {
    const timerRef = useRef(null);
    const lastActivityRef = useRef(Date.now());
    const firedRef = useRef(false);
    const onIdleRef = useRef(onIdle);
    onIdleRef.current = onIdle;

    useEffect(() => {
        if (!timeoutMs) return undefined;

        firedRef.current = false;
        lastActivityRef.current = Date.now();

        const fireIdle = () => {
            if (firedRef.current) return; // only ever fire once per mount
            firedRef.current = true;
            if (timerRef.current) clearTimeout(timerRef.current);
            onIdleRef.current?.();
        };

        const scheduleTimer = (delay) => {
            if (timerRef.current) clearTimeout(timerRef.current);
            // Never schedule a non-positive delay — Date.now() can have
            // ticked forward between an elapsed-time check and this call.
            timerRef.current = setTimeout(checkIdle, Math.max(delay, 0));
        };

        // Central check — used by the scheduled timer, every activity
        // event, AND visibilitychange. Always compares against real
        // elapsed wall-clock time rather than trusting that a timer fired
        // on schedule, which is exactly what a backgrounded/suspended
        // mobile tab can't be relied on to do.
        const checkIdle = () => {
            const elapsed = Date.now() - lastActivityRef.current;
            if (elapsed >= timeoutMs) {
                fireIdle();
            } else {
                scheduleTimer(timeoutMs - elapsed);
            }
        };

        const handleActivity = () => {
            if (firedRef.current) return;
            // Check BEFORE resetting: if the user is only now touching the
            // screen after already having been away longer than the
            // timeout (e.g. unlocking a phone that's been locked for an
            // hour), that touch should trigger logout, not quietly
            // restart the clock as if nothing happened.
            const elapsed = Date.now() - lastActivityRef.current;
            if (elapsed >= timeoutMs) {
                fireIdle();
                return;
            }
            lastActivityRef.current = Date.now();
            scheduleTimer(timeoutMs);
        };

        const handleVisibility = () => {
            if (document.visibilityState === 'visible' && !firedRef.current) {
                checkIdle();
            }
        };

        ACTIVITY_EVENTS.forEach(evt => window.addEventListener(evt, handleActivity, { passive: true }));
        document.addEventListener('visibilitychange', handleVisibility);
        scheduleTimer(timeoutMs);

        return () => {
            if (timerRef.current) clearTimeout(timerRef.current);
            ACTIVITY_EVENTS.forEach(evt => window.removeEventListener(evt, handleActivity));
            document.removeEventListener('visibilitychange', handleVisibility);
        };
    }, [timeoutMs]);
};

export default useIdleLogout;
