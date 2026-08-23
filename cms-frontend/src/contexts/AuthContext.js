// ============================================================
// AUTH CONTEXT
// Manages authentication state across the entire app.
// Provides: user, token, login, logout, hasRole, hasPermission
// ============================================================

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { authAPI, usersAPI } from '../api/endpoints';

const AuthContext = createContext(null);

// v1.36.0 — the 5 roles that see company financial information (account
// balances, share price, exchange rates, investment/MMF figures, savings/
// side-fund settings) BY DEFAULT, with no extra permission grant needed.
// Every other role (Secretary, Assistant Secretary, Coordinator,
// Administrative Officer, and any future "performative" role) sees none
// of it unless separately granted the matching permission by an Admin.
// Kept in exact sync with FINANCIAL_ROLES in cms/src/middleware/auth.js —
// this is the client-side mirror used to decide what to even render
// (and, for the dashboard-style data below, what to bother calling the
// API for at all); the backend list is still the real enforcement.
export const FINANCIAL_ROLES = ['Treasurer', 'Assistant Treasurer', 'Shareholder', 'Director', 'Admin'];

export const AuthProvider = ({ children }) => {
    const [user, setUser]       = useState(null);
    const [loading, setLoading] = useState(true);

    // --------------------------------------------------------
    // Load user from localStorage on app start
    // --------------------------------------------------------
    useEffect(() => {
        const initAuth = async () => {
            const token = localStorage.getItem('accessToken');
            const savedUser = localStorage.getItem('user');

            if (token && savedUser) {
                setUser(JSON.parse(savedUser));
                try {
                    // Refresh user data from server
                    const response = await usersAPI.getMyProfile();
                    const freshUser = response.data.data;
                    setUser(freshUser);
                    localStorage.setItem('user', JSON.stringify(freshUser));
                } catch (err) {
                    // Only clear the session on a genuine rejection from
                    // the server (401/403 — the token really is invalid
                    // or expired). A network error (backend unreachable —
                    // mid-restart, brief connectivity blip, etc.) has
                    // nothing to say about whether this token is still
                    // good, so keep the cached session from localStorage
                    // (already set above) and let the next real API call
                    // decide instead of forcing a logout on every page
                    // load that happens to land during a backend restart.
                    const status = err?.response?.status;
                    if (status === 401 || status === 403) {
                        localStorage.removeItem('accessToken');
                        localStorage.removeItem('refreshToken');
                        localStorage.removeItem('user');
                        setUser(null);
                    }
                }
            }
            setLoading(false);
        };

        initAuth();
    }, []);

    // --------------------------------------------------------
    // LOGIN
    // --------------------------------------------------------
    const login = useCallback(async (email, password) => {
        const response = await authAPI.login({ email, password });
        const { accessToken, refreshToken, user: userData, requiresTwoFactor } = response.data.data;

        localStorage.setItem('accessToken', accessToken);
        localStorage.setItem('refreshToken', refreshToken);

        if (!requiresTwoFactor) {
            // Load full profile
            const profileResponse = await usersAPI.getMyProfile();
            const fullUser = profileResponse.data.data;
            console.log('Full user from API:', fullUser);
            console.log('Permissions:', fullUser.permissions);
            localStorage.setItem('user', JSON.stringify(fullUser));
            setUser(fullUser);
        }

        return { requiresTwoFactor, userData };
    }, []);

    // --------------------------------------------------------
    // VERIFY 2FA
    // --------------------------------------------------------
    const verify2FA = useCallback(async (token) => {
        const response = await authAPI.verify2FA({ token });
        const { accessToken } = response.data.data;
        localStorage.setItem('accessToken', accessToken);

        // Load full profile after 2FA
        const profileResponse = await usersAPI.getMyProfile();
        const fullUser = profileResponse.data.data;
        localStorage.setItem('user', JSON.stringify(fullUser));
        setUser(fullUser);
    }, []);

    // --------------------------------------------------------
    // REFRESH USER
    // Re-fetches the current profile and updates both state and
    // localStorage — call this after anything that changes data
    // shown outside the Profile page itself (e.g. photo/avatar,
    // name), so the top bar and sidebar update immediately instead
    // of waiting for the next login/page reload.
    // --------------------------------------------------------
    const refreshUser = useCallback(async () => {
        try {
            const response = await usersAPI.getMyProfile();
            const freshUser = response.data.data;
            localStorage.setItem('user', JSON.stringify(freshUser));
            setUser(freshUser);
        } catch {
            // Silently ignore — the existing cached user stays in place
        }
    }, []);

    // --------------------------------------------------------
    // LOGOUT
    // --------------------------------------------------------
    const logout = useCallback(async () => {
        try {
            await authAPI.logout();
        } catch {
            // Continue logout even if API call fails
        }
        localStorage.removeItem('accessToken');
        localStorage.removeItem('refreshToken');
        localStorage.removeItem('user');
        setUser(null);
        window.location.href = '/login';
    }, []);

    // --------------------------------------------------------
    // PERMISSION HELPERS
    // --------------------------------------------------------
    const hasRole = useCallback((role) => {
    if (!user?.roles) return false;
    const roleNames = user.roles.map(r =>
        typeof r === 'object' ? r.name : r
    );
    if (Array.isArray(role)) {
        return role.some(r => roleNames.includes(r));
    }
    return roleNames.includes(role);
}, [user]);

    const hasPermission = useCallback((permission) => {
    if (!user?.permissions) return false;
    // Handle permissions as either strings or objects
    const permCodes = user.permissions.map(p =>
        typeof p === 'object' ? p.code : p
    );
    if (Array.isArray(permission)) {
        return permission.some(p => permCodes.includes(p));
    }
    return permCodes.includes(permission);
    }, [user]);

    // v1.36.0 — true if this user sees financial info by default (holds
    // one of FINANCIAL_ROLES) OR has separately been granted the specific
    // permission passed in (an Admin's "extra roles that allow seeing
    // other views" override, via Settings > Roles & Permissions). Called
    // with no argument, it only checks the default-role part — useful
    // for broad UI like the Dashboard's balance cards and the TopBar
    // strip, which aren't gated behind one single named permission.
    const hasFinancialAccess = useCallback((permission) => {
        if (hasRole(FINANCIAL_ROLES)) return true;
        return permission ? hasPermission(permission) : false;
    }, [hasRole, hasPermission]);

    const isAdmin = useCallback(() => hasRole('Admin'), [hasRole]);

    const isTreasurer = useCallback(() =>
        hasRole(['Treasurer', 'Admin']), [hasRole]);

    const isDirector = useCallback(() =>
        hasRole(['Director', 'Admin']), [hasRole]);

    return (
        <AuthContext.Provider value={{
            user,
            loading,
            login,
            logout,
            verify2FA,
            refreshUser,
            hasRole,
            hasPermission,
            hasFinancialAccess,
            isAdmin,
            isTreasurer,
            isDirector,
            isAuthenticated: !!user,
        }}>
            {children}
        </AuthContext.Provider>
    );
};

// Custom hook for easy access
export const useAuth = () => {
    const context = useContext(AuthContext);
    if (!context) {
        throw new Error('useAuth must be used within an AuthProvider');
    }
    return context;
};

export default AuthContext;