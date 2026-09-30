// ============================================================
// MAINTENANCE PAGE (v1.74.0) + "checking" and "unavailable" screens
//
// Deliberately self-contained: no contexts, no API client, no router —
// only the status handed in by MaintenanceGate — so it shows even if
// other parts of the app are broken. Fixed colours (the Harbour navy /
// blue → teal band) that read the same in light and dark mode.
// ============================================================

import { WrenchScrewdriverIcon, ArrowPathIcon, CloudIcon } from '@heroicons/react/24/outline';

const COMPANY = process.env.REACT_APP_COMPANY_NAME || 'Company Management System';

const fmt = (iso) => {
    if (!iso) return null;
    try {
        return new Date(iso).toLocaleString(undefined, {
            weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
        });
    } catch (_) { return null; }
};

const signedInName = () => {
    try {
        const u = JSON.parse(localStorage.getItem('user') || 'null');
        return u?.first_name ? `${u.first_name} ${u.last_name || ''}`.trim() : null;
    } catch (_) { return null; }
};

const Shell = ({ children }) => (
    <div style={{ minHeight: '100dvh', background: 'linear-gradient(135deg, #0B1F3A 0%, #1D4ED8 55%, #0F766E 100%)' }}
        className="flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-lg">
            <div className="flex items-center justify-center gap-3 mb-6">
                <img src="/logo.png" alt="" className="h-10 w-10 rounded-lg bg-white/90 p-1 object-contain"
                    onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                <p className="text-white font-semibold text-lg">{COMPANY}</p>
            </div>
            <div style={{ background: '#ffffff', color: '#0f172a' }} className="rounded-2xl shadow-2xl p-7 sm:p-9 text-center">
                {children}
            </div>
        </div>
    </div>
);

const MaintenancePage = ({ status, onCheck, onAdminLogin }) => {
    const until = fmt(status?.expected_end);
    const since = fmt(status?.started_at);
    const who = signedInName();
    return (
        <Shell>
            <div style={{ background: '#fef3c7' }} className="mx-auto h-16 w-16 rounded-full flex items-center justify-center mb-5">
                <WrenchScrewdriverIcon style={{ color: '#b45309' }} className="h-8 w-8" />
            </div>
            <h1 className="text-2xl font-bold mb-2">We're updating the system</h1>
            <p style={{ color: '#334155' }} className="text-base leading-relaxed whitespace-pre-line">
                {status?.message || 'The system is being updated. Please check back shortly.'}
            </p>
            {(until || since) && (
                <div style={{ background: '#f1f5f9', color: '#334155' }} className="rounded-xl mt-5 px-4 py-3 text-sm space-y-1">
                    {until && <p>Expected back by <strong style={{ color: '#0f172a' }}>{until}</strong></p>}
                    {since && <p>Started {since}</p>}
                </div>
            )}
            <p style={{ color: '#64748b' }} className="text-sm mt-5">
                Nothing you have recorded is affected. This page checks again every 30 seconds
                and opens the system by itself as soon as the update is finished.
                {who ? ` You stay signed in, ${who}.` : ''}
            </p>
            <button type="button" onClick={onCheck}
                style={{ background: '#1D4ED8', color: '#ffffff' }}
                className="mt-6 inline-flex items-center gap-2 rounded-lg px-5 py-2.5 font-semibold hover:opacity-90">
                <ArrowPathIcon className="h-5 w-5" /> Check now
            </button>
            <div className="mt-6 pt-4" style={{ borderTop: '1px solid #e2e8f0' }}>
                <button type="button" onClick={onAdminLogin} style={{ color: '#64748b' }}
                    className="text-xs underline hover:opacity-80">
                    Administrator sign-in
                </button>
            </div>
        </Shell>
    );
};

export const UnavailablePage = ({ onRetry }) => (
    <Shell>
        <div style={{ background: '#e0f2fe' }} className="mx-auto h-16 w-16 rounded-full flex items-center justify-center mb-5">
            <CloudIcon style={{ color: '#0369a1' }} className="h-8 w-8" />
        </div>
        <h1 className="text-2xl font-bold mb-2">The system is temporarily unavailable</h1>
        <p style={{ color: '#334155' }} className="text-base leading-relaxed">
            We can't reach the server right now. It may be restarting after an update, or your
            internet connection may have dropped. This page keeps trying by itself.
        </p>
        <button type="button" onClick={onRetry}
            style={{ background: '#1D4ED8', color: '#ffffff' }}
            className="mt-6 inline-flex items-center gap-2 rounded-lg px-5 py-2.5 font-semibold hover:opacity-90">
            <ArrowPathIcon className="h-5 w-5" /> Try again
        </button>
    </Shell>
);

export const CheckingPage = () => (
    <div style={{ minHeight: '100dvh' }} className="flex items-center justify-center">
        <div className="h-8 w-8 rounded-full border-4 border-blue-200 border-t-blue-700 animate-spin" aria-label="Loading" />
    </div>
);

export default MaintenancePage;
