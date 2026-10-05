// ============================================================
// APP LAYOUT
// The main layout wrapper for all authenticated pages.
//
// v1.71.0 ("Harbour"): the frame is now
//   [ Sidebar ][ TopBar                         ]
//   [         ][ page (header band, tabs, body) ]
//   [ phone bottom bar (below 768 px only)      ]
// LayoutProvider shares the menu state (drawer, shortcuts, breadcrumb
// title, notification panel) between these parts.
// ============================================================

import { useState, useCallback, useEffect } from 'react';
import { Outlet, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import useIdleLogout from '../../hooks/useIdleLogout';
import Sidebar from './Sidebar';
import TopBar from './TopBar';
import ConfirmModal from '../common/ConfirmModal';
import MobileNav from './MobileNav';
import { LayoutProvider } from './LayoutContext';
import HeldEntryNotice from '../common/HeldEntryNotice'; // v1.73.0
import MaintenanceStatusBar from '../maintenance/MaintenanceStatusBar'; // v1.74.0
import useScrollHints from '../../hooks/useScrollHints'; // v1.77.0
import { settingsAPI } from '../../api/endpoints';
import { setStatutory } from '../../utils/exportUtils'; // v1.79.0

// Auto-logout after this many minutes of no mouse/keyboard/touch/
// scroll activity anywhere in the app — see hooks/useIdleLogout.js.
const IDLE_LOGOUT_MINUTES = 20;

const AppLayout = () => {
    const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
    const [loggingOut, setLoggingOut] = useState(false);
    const { user, hasRole, logout } = useAuth();
    const location = useLocation();

    // v1.79.0 — the registration number, TIN and registered office
    // printed on every generated document's letterhead. Loaded once
    // after login (they are not on the public branding endpoint).
    useEffect(() => {
        if (!user) return;
        settingsAPI.getStatutory().then(r => setStatutory(r.data.data || {})).catch(() => {});
    }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

    // Idle timeout logs out directly (no confirmation prompt — the
    // whole point is that nobody's there to answer one); a manual
    // click on either Logout button always confirms first, below.
    // v1.77.0 — tab rows: fades where more tabs are hidden, selected tab
    // scrolled into view (every page).
    useScrollHints('main-content');

    useIdleLogout(IDLE_LOGOUT_MINUTES * 60 * 1000, () => {
        logout();
    });

    const confirmLogout = useCallback(async () => {
        setLoggingOut(true);
        await logout();
        // logout() redirects the whole page to /login, so there's no
        // need to reset loggingOut/showLogoutConfirm afterwards.
    }, [logout]);

    // A verified account with ZERO assigned roles has not been approved
    // by an Admin yet — enforced centrally here, the same way the
    // Auditor redirect below is, rather than trusting every individual
    // page to notice. Without this, such an account would land straight
    // on the Dashboard, which (like several other "any authenticated
    // user" endpoints across this system) shows real company data.
    // See requireAssignedRole in middleware/auth.js for the backend half
    // of this fix, and PendingApprovalPage.jsx for where this sends them.
    if ((user?.roles || []).length === 0) {
        return <Navigate to="/pending-approval" replace />;
    }

    // A role-assigned account that hasn't yet consented to the
    // Membership Agreement (and drawn a signature, same one-time
    // step) is next in the same chain — enforced centrally here, the
    // same reasoning as the pending-approval redirect above: consent
    // is one-time gating logic that shouldn't depend on every
    // individual page remembering to check for it. See requireConsent
    // in middleware/auth.js for the backend half, and ConsentPage.jsx
    // for where this sends them (Section 4.29).
    if (!user?.has_consented) {
        return <Navigate to="/consent" replace />;
    }

    // The Auditor role is the one place in this app an external,
    // non-member party gets a login — every other page assumes an
    // internal member/staff user, and most would either 403 or show
    // a confusing empty state for an Auditor anyway. Rather than
    // relying on every individual page to guard against that, this
    // is enforced once, centrally: an Auditor is bounced to /audit
    // no matter what URL they land on or type in directly.
    if (hasRole('Auditor') && location.pathname !== '/audit') {
        return <Navigate to="/audit" replace />;
    }

    return (
        <LayoutProvider>
        <div className="flex h-[100dvh] overflow-hidden" style={{ backgroundColor: 'var(--cms-bg)' }}>
            {/* Sidebar — static column on wide screens (full or icon strip),
                slide-in drawer on phones and tablets. */}
            <Sidebar onLogoutClick={() => setShowLogoutConfirm(true)} />

            {/* Main column */}
            <div className="flex-1 flex flex-col overflow-hidden min-w-0">
                {/* v1.74.0 — Admin reminder while maintenance mode is on */}
                <MaintenanceStatusBar />
                <TopBar onLogoutClick={() => setShowLogoutConfirm(true)} />

                {/* Page content. Extra space at the bottom on phones so the
                    bottom bar never covers the last row of a page. */}
                <main id="main-content" className="flex-1 overflow-y-auto overflow-x-hidden px-4 pt-4 pb-28 md:px-6 md:pt-6 md:pb-10">
                    <div className="w-full">
                        <Outlet />
                    </div>
                </main>
            </div>

            <MobileNav />

            {/* v1.73.0 — "Sent for approval" notice for held money entries */}
            <HeldEntryNotice />

            {/* Shared Logout confirmation — reached from the sidebar and the
                profile menu (v1.28.2). Idle-timeout logout bypasses it. */}
            <ConfirmModal
                isOpen={showLogoutConfirm}
                title="Log out?"
                message="You'll need to sign in again to continue."
                confirmLabel="Log Out"
                danger
                loading={loggingOut}
                onConfirm={confirmLogout}
                onCancel={() => setShowLogoutConfirm(false)}
            />
        </div>
        </LayoutProvider>
    );
};

export default AppLayout;