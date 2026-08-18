// ============================================================
// APP LAYOUT
// The main layout wrapper for all authenticated pages.
// ============================================================

import { useState, useCallback } from 'react';
import { Outlet, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import useIdleLogout from '../../hooks/useIdleLogout';
import Sidebar from './Sidebar';
import TopBar from './TopBar';
import ConfirmModal from '../common/ConfirmModal';

// Auto-logout after this many minutes of no mouse/keyboard/touch/
// scroll activity anywhere in the app — see hooks/useIdleLogout.js.
const IDLE_LOGOUT_MINUTES = 20;

const AppLayout = () => {
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
    const [loggingOut, setLoggingOut] = useState(false);
    const { user, hasRole, logout } = useAuth();
    const location = useLocation();

    // Idle timeout logs out directly (no confirmation prompt — the
    // whole point is that nobody's there to answer one); a manual
    // click on either Logout button always confirms first, below.
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
        <div className="flex" style={{ height: '100vh', overflow: 'hidden' }}>
            {/* Sidebar — manages its own responsive width/position now
                (fixed off-canvas drawer on mobile, static column on
                desktop), so this wrapper no longer reserves fixed space. */}
            <Sidebar
                isOpen={sidebarOpen}
                onClose={() => setSidebarOpen(false)}
                onLogoutClick={() => setShowLogoutConfirm(true)}
            />

            {/* Main content area */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
                overflow: 'hidden', minWidth: 0 }}>
                {/* Top bar */}
                <TopBar
                    onMenuClick={() => setSidebarOpen(true)}
                    onLogoutClick={() => setShowLogoutConfirm(true)}
                />

                {/* Page content */}
                <main className="p-4 md:p-6 scrollbar-hidden" style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
                    <Outlet />
                </main>
            </div>

            {/* Shared Logout confirmation — reached from either the
                sidebar's own Logout button or the TopBar user menu's
                Sign Out item (v1.28.2). Idle-timeout logout (above)
                deliberately bypasses this and logs out directly. */}
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
    );
};

export default AppLayout;