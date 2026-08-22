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

// ============================================================
// BROWSER TAB TITLE + FAVICON (v1.32.6)
// public/index.html bakes in a correct-by-default title/favicon at
// BUILD time via %REACT_APP_COMPANY_NAME%/the static favicon.ico —
// this keeps both in sync with whatever's actually configured in
// Settings > Company AFTERWARDS, without needing a rebuild every time
// someone renames the company or uploads a new logo. Runs after every
// refresh(), so it's correct even before login (this endpoint is
// public) and stays correct if an Admin changes either value later in
// the same session.
// ============================================================
const applyBrowserChrome = (branding) => {
    if (branding.company_name) {
        document.title = branding.company_name;
    }
    if (branding.logo_url) {
        const iconLink = document.getElementById('app-favicon');
        if (iconLink) iconLink.href = branding.logo_url;
    }
};

export const BrandingProvider = ({ children }) => {
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
            applyBrowserChrome(data);

            setExportBranding({
                name:         data.company_name,
                address:      data.company_address,
                logoUrl:      resolvedLogoUrl || undefined,
                primaryColor: data.primary_color,
                accentColor:  data.accent_color,
            });
        } catch {
            // GET /settings/company is public (v1.32.3) so this should
            // basically never fail from an auth standpoint — a genuine
            // network error or the backend being down is the realistic
            // case now. Fall back to defaults silently either way — the
            // tab title/favicon just stay whatever index.html already
            // baked in at build time (applyBrowserChrome no-ops on a null
            // logo_url, and DEFAULTS.company_name matches the same
            // REACT_APP_COMPANY_NAME index.html already used).
            applyCssVariables(DEFAULTS);
            applyBrowserChrome(DEFAULTS);
        } finally {
            setLoading(false);
        }
    }, []);

    // Runs once on mount, regardless of login state (v1.32.3) — this is
    // what lets the pre-login Login/Register/Forgot Password/Consent
    // pages show this deployment's real company name/logo/colors instead
    // of whatever's baked into the frontend build at build time
    // (REACT_APP_COMPANY_NAME / the static public/logo.png fallback),
    // which is what let Company A's bundled logo silently show through
    // on Company B's login page despite Company B's own logo already
    // being uploaded and correctly stored.
    useEffect(() => {
        refresh();
    }, [refresh]);

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
