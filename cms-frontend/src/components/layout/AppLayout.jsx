// ============================================================
// APP LAYOUT
// The main layout wrapper for all authenticated pages.
// ============================================================

import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import TopBar from './TopBar';

const AppLayout = () => {
    const [sidebarOpen, setSidebarOpen] = useState(false);

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