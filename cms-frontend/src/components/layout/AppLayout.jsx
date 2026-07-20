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
    const { hasRole } = useAuth();
    const location = useLocation();

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