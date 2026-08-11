// ============================================================
// APP LAYOUT
// The main layout wrapper for all authenticated pages.
// ============================================================

import { useState } from 'react';
import { Outlet, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import Sidebar from './Sidebar';
import TopBar from './TopBar';

const AppLayout = () => {
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const { user, hasRole } = useAuth();
    const location = useLocation();

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
            />

            {/* Main content area */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
                overflow: 'hidden', minWidth: 0 }}>
                {/* Top bar */}
                <TopBar onMenuClick={() => setSidebarOpen(true)} />

                {/* Page content */}
                <main className="p-4 md:p-6" style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
                    <Outlet />
                </main>
            </div>
        </div>
    );
};

export default AppLayout;