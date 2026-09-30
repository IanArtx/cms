// ============================================================
// MAINTENANCE GATE (v1.74.0)
//
// Wraps the WHOLE app (App.js, outside every other provider) so it
// works no matter what state the rest of the app is in:
//   • It asks the server GET /api/maintenance/status with a plain
//     fetch() — not the shared axios client, contexts or router — when
//     the page opens, every 30 s, whenever the person signs in or out,
//     when the tab comes back into view, and immediately when any API
//     call is turned away with "maintenance" (api/axios.js raises the
//     'cms:maintenance' event).
//   • Maintenance ON and the person is not an Admin → only the
//     maintenance page is shown. Nothing else in the app even loads,
//     so an error anywhere else can't get in the way.
//   • Maintenance ON and the person IS an Admin → the app as normal,
//     plus the status bar (MaintenanceStatusBar in AppLayout) reading
//     from this component's context.
//   • The server can't be reached at all → a friendly "temporarily
//     unavailable" page that keeps retrying, instead of a broken app.
//
// Admin sign-in during maintenance: the maintenance page has an
// "Administrator sign-in" link. It lets the sign-in page through; once
// signed in the server itself decides — an Admin gets the app, anyone
// else goes straight back to the maintenance page (the server also
// refuses their requests).
// ============================================================

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import MaintenancePage, { UnavailablePage, CheckingPage } from './MaintenancePage';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';
const ADMIN_LOGIN_FLAG = 'cms-maintenance-admin-login';
export const MAINTENANCE_EVENT = 'cms:maintenance';

const MaintenanceContext = createContext({ status: null, refresh: () => {} });
export const useMaintenance = () => useContext(MaintenanceContext);

const withTimeout = (ms) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    return { signal: ctl.signal, done: () => clearTimeout(t) };
};

const fetchStatus = async () => {
    const token = localStorage.getItem('accessToken');
    const { signal, done } = withTimeout(8000);
    try {
        const res = await fetch(`${API}/maintenance/status`, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            cache: 'no-store', signal,
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const body = await res.json();
        return body.data;
    } finally { done(); }
};

// An Admin whose sign-in has simply expired must not be locked out:
// renew the token once and ask again.
const tryRefresh = async () => {
    const refreshToken = localStorage.getItem('refreshToken');
    if (!refreshToken) return false;
    const { signal, done } = withTimeout(8000);
    try {
        const res = await fetch(`${API}/auth/refresh`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken }), signal,
        });
        if (!res.ok) return false;
        const body = await res.json();
        if (!body?.data?.accessToken) return false;
        localStorage.setItem('accessToken', body.data.accessToken);
        return true;
    } catch (_) { return false; } finally { done(); }
};

const readFlag = () => { try { return sessionStorage.getItem(ADMIN_LOGIN_FLAG) === '1'; } catch (_) { return false; } };
const writeFlag = (v) => { try { v ? sessionStorage.setItem(ADMIN_LOGIN_FLAG, '1') : sessionStorage.removeItem(ADMIN_LOGIN_FLAG); } catch (_) {} };

const MaintenanceGate = ({ children }) => {
    // phase: checking | ok | maintenance | unreachable
    const [phase, setPhase] = useState('checking');
    const [status, setStatus] = useState(null);
    const [adminLogin, setAdminLogin] = useState(readFlag());
    const failures = useRef(0);
    const phaseRef = useRef('checking');
    const busy = useRef(false);

    const apply = (p) => { phaseRef.current = p; setPhase(p); };

    const check = useCallback(async () => {
        if (busy.current) return;
        busy.current = true;
        try {
            let data = await fetchStatus();
            if (data.on && !data.exempt && localStorage.getItem('accessToken')) {
                if (await tryRefresh()) data = await fetchStatus();
            }
            failures.current = 0;
            setStatus(data);
            if (!data.on || data.exempt) {
                if (readFlag()) { writeFlag(false); setAdminLogin(false); }
                apply('ok');
            } else {
                // Signed in but not an Admin → the sign-in exception ends here.
                if (readFlag() && localStorage.getItem('accessToken')) { writeFlag(false); setAdminLogin(false); }
                apply('maintenance');
            }
        } catch (_) {
            failures.current += 1;
            // While the app is running, a single missed check is just a
            // network blip — only give up after three in a row.
            const limit = phaseRef.current === 'ok' ? 3 : 2;
            if (failures.current >= limit) apply('unreachable');
            else if (phaseRef.current === 'checking') setTimeout(() => check(), 3000);
        } finally {
            busy.current = false;
        }
    }, []);

    // First check, then every 30 s (every 15 s while waiting).
    useEffect(() => {
        check();
        const t = setInterval(() => check(), phase === 'ok' ? 30000 : 15000);
        return () => clearInterval(t);
    }, [check, phase]);

    // Signing in / out, coming back to the tab, or a request turned away.
    useEffect(() => {
        let lastToken = localStorage.getItem('accessToken');
        const tokenWatch = setInterval(() => {
            const now = localStorage.getItem('accessToken');
            if (now !== lastToken) { lastToken = now; check(); }
        }, 1500);
        const onVisible = () => { if (document.visibilityState === 'visible') check(); };
        const onEvent = () => check();
        document.addEventListener('visibilitychange', onVisible);
        window.addEventListener(MAINTENANCE_EVENT, onEvent);
        return () => {
            clearInterval(tokenWatch);
            document.removeEventListener('visibilitychange', onVisible);
            window.removeEventListener(MAINTENANCE_EVENT, onEvent);
        };
    }, [check]);

    const startAdminLogin = () => {
        writeFlag(true);
        setAdminLogin(true);
        if (window.location.pathname !== '/login') window.location.assign('/login');
    };
    const cancelAdminLogin = () => { writeFlag(false); setAdminLogin(false); };

    const showApp = phase === 'ok' || (phase === 'maintenance' && adminLogin);

    let screen = null;
    if (phase === 'checking') screen = <CheckingPage />;
    else if (phase === 'unreachable') screen = <UnavailablePage onRetry={() => { failures.current = 0; check(); }} />;
    else if (phase === 'maintenance' && !adminLogin) screen = (
        <MaintenancePage status={status} onCheck={check} onAdminLogin={startAdminLogin} />
    );

    return (
        <MaintenanceContext.Provider value={{ status: phase === 'ok' ? status : null, refresh: check, adminLogin, cancelAdminLogin }}>
            {phase === 'maintenance' && adminLogin ? (
                <div role="status" style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 70 }}
                    className="bg-amber-500 text-amber-950 text-sm px-4 py-2 flex items-center justify-center gap-3 flex-wrap shadow">
                    <span><strong>Maintenance mode is on.</strong> Only Administrators can sign in.</span>
                    <button type="button" onClick={cancelAdminLogin}
                        className="underline font-semibold">Back to the maintenance page</button>
                </div>
            ) : null}
            {showApp ? children : screen}
        </MaintenanceContext.Provider>
    );
};

export default MaintenanceGate;
