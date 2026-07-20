// ============================================================
// BRANDING CONTEXT
// Loads the company's branding settings (name, address, logo,
// brand colors) from the backend and makes them available app-wide
// — this is what lets a System Admin rebrand the whole system for
// a different company through Settings > Company, with the change
// taking effect immediately for every logged-in user, no redeploy.
//
// Two things happen with the loaded settings:
//   1. primary/accent colors are written onto :root as CSS custom
//      properties (--brand-primary / --brand-accent), which the
//      sidebar and a few other spots read instead of a hardcoded hex.
//   2. exportUtils.setBranding() is called so every generated/
//      previewed document (letterhead, colors) uses the same values.
// ============================================================

import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { settingsAPI } from '../api/endpoints';
import { setBranding as setExportBranding } from '../utils/exportUtils';
import { useAuth } from './AuthContext';

const DEFAULTS = {
    company_name:    process.env.REACT_APP_COMPANY_NAME || 'Company Management System',
    company_address: process.env.REACT_APP_COMPANY_ADDRESS || '',
    logo_url:        null,
    primary_color:   '#1e3a5f',
    accent_color:    '#c9a227',
};

const BrandingContext = createContext(null);

const applyCssVariables = (branding) => {
    const root = document.documentElement;
    root.style.setProperty('--brand-primary', branding.primary_color);
    root.style.setProperty('--brand-accent', branding.accent_color);
};

export const BrandingProvider = ({ children }) => {
    const { isAuthenticated } = useAuth();
    const [branding, setBrandingState] = useState(DEFAULTS);
    const [loading, setLoading] = useState(true);

    const refresh = useCallback(async () => {
        try {
            const res = await settingsAPI.getCompany();
            const raw = { ...DEFAULTS, ...res.data.data };

            // Backend logo_url is a relative path like /uploads/branding/xyz.png
            // — resolve it against the API's origin, not the frontend's, BEFORE
            // storing it in state, so every consumer (Sidebar, exportUtils,
            // Settings > Company preview) gets a ready-to-use absolute URL.
            // Mirrors the same default axios.js uses, so local dev (no .env
            // override) resolves against the backend's port instead of the
            // frontend's own.
            const API_BASE_URL = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';
            const apiBase = API_BASE_URL.replace(/\/api\/?$/, '');
            const resolvedLogoUrl = raw.logo_url
                ? (raw.logo_url.startsWith('http') ? raw.logo_url : `${apiBase}${raw.logo_url}`)
                : null;

            const data = { ...raw, logo_url: resolvedLogoUrl };
            setBrandingState(data);
            applyCssVariables(data);

            setExportBranding({
                name:         data.company_name,
                address:      data.company_address,
                logoUrl:      resolvedLogoUrl || undefined,
                primaryColor: data.primary_color,
                accentColor:  data.accent_color,
            });
        } catch {
            // Not authenticated yet, or the settings endpoint failed —
            // fall back to defaults silently. The sidebar/topbar/
            // documents are only ever shown once logged in anyway.
            applyCssVariables(DEFAULTS);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (isAuthenticated) {
            refresh();
        } else {
            setLoading(false);
            applyCssVariables(DEFAULTS);
        }
    }, [isAuthenticated, refresh]);

    return (
        <BrandingContext.Provider value={{ branding, loading, refresh }}>
            {children}
        </BrandingContext.Provider>
    );
};

export const useBranding = () => {
    const context = useContext(BrandingContext);
    if (!context) {
        throw new Error('useBranding must be used within a BrandingProvider');
    }
    return context;
};

export default BrandingContext;
