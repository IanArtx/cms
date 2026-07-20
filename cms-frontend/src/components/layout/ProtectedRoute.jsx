// ============================================================
// PROTECTED ROUTE
// Wraps routes that require authentication.
// Redirects to login if not authenticated.
// Optionally checks for specific roles or permissions.
// ============================================================

import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import LoadingSpinner from '../common/LoadingSpinner';

const ProtectedRoute = ({
    children,
    requiredPermission = null,
    requiredRole       = null,
}) => {
    const { isAuthenticated, loading, hasPermission, hasRole } = useAuth();
    const location = useLocation();

    // Show spinner while checking auth status
    if (loading) {
        return <LoadingSpinner fullPage text="Loading..." />;
    }

    // Not logged in — redirect to login
    if (!isAuthenticated) {
        return (
            <Navigate
                to="/login"
                state={{ from: location }}
                replace
            />
        );
    }

    // Check permission if required
    if (requiredPermission && !hasPermission(requiredPermission)) {
        return (
            <div className="flex items-center justify-center h-full">
                <div className="text-center">
                    <h2 className="text-xl font-semibold text-gray-900 mb-2">
                        Access Denied
                    </h2>
                    <p className="text-gray-500">
                        You do not have permission to view this page.
                    </p>
                </div>
            </div>
        );
    }

    // Check role if required
    if (requiredRole && !hasRole(requiredRole)) {
        return (
            <div className="flex items-center justify-center h-full">
                <div className="text-center">
                    <h2 className="text-xl font-semibold text-gray-900 mb-2">
                        Access Denied
                    </h2>
                    <p className="text-gray-500">
                        This page requires the {Array.isArray(requiredRole) ? requiredRole.join(' or ') : requiredRole} role.
                    </p>
                </div>
            </div>
        );
    }

    return children;
};

export default ProtectedRoute;