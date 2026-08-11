// ============================================================
// PENDING APPROVAL PAGE
//
// Where a logged-in user with ZERO assigned roles lands, instead
// of the normal Sidebar/TopBar/Dashboard. AppLayout.jsx redirects
// here centrally for any such account (same pattern already used
// to force the Auditor role to /audit) — see this file's comment
// there for the full rationale.
//
// This exists because email verification alone used to be enough
// to reach the real app: register -> verify email -> log in ->
// land on the Dashboard, which shows real company account balances
// to "any authenticated user" by design (many endpoints across the
// system work this way — see requireAssignedRole's comment in
// middleware/auth.js). A verified-but-unapproved account should see
// nothing personalised until an Admin actually assigns it a role.
//
// No Sidebar/TopBar here on purpose — a zero-role account has
// nothing to navigate to yet.
// ============================================================

import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useBranding } from '../../contexts/BrandingContext';
import { usersAPI } from '../../api/endpoints';
import StatusBadge from '../../components/common/StatusBadge';

const POLL_INTERVAL_MS = 30000;

const PendingApprovalPage = () => {
    const { user, refreshUser, logout } = useAuth();
    const { branding } = useBranding();
    const navigate = useNavigate();

    const [roleRequest, setRoleRequest] = useState(null);
    const [loading, setLoading] = useState(true);
    const [checking, setChecking] = useState(false);
    const pollRef = useRef(null);

    // If this account already holds a role (e.g. approved in another
    // tab, or someone bookmarked this URL after approval), don't sit
    // here showing a stale "pending" message — leave immediately.
    useEffect(() => {
        if ((user?.roles || []).length > 0) {
            navigate('/', { replace: true });
        }
    }, [user, navigate]);

    const loadRoleRequest = useCallback(async () => {
        try {
            const res = await usersAPI.getMyRoleRequest();
            setRoleRequest(res.data.data);
        } catch {
            // No request on file, or a transient error — either way,
            // the generic "contact an Admin" message below still covers it.
            setRoleRequest(null);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { loadRoleRequest(); }, [loadRoleRequest]);

    // Quietly re-check every 30s so an approved user doesn't have to
    // think to click anything — if a role has landed, refreshUser()
    // updates the cached profile and the effect above sends them in.
    useEffect(() => {
        pollRef.current = setInterval(() => {
            refreshUser();
            loadRoleRequest();
        }, POLL_INTERVAL_MS);
        return () => clearInterval(pollRef.current);
    }, [refreshUser, loadRoleRequest]);

    const handleCheckNow = async () => {
        setChecking(true);
        await refreshUser();
        await loadRoleRequest();
        setChecking(false);
    };

    return (
        <div className="min-h-screen bg-gradient-to-br from-primary-900
            to-primary-700 flex items-center justify-center p-4">
            <div className="w-full max-w-md">

                {/* Logo */}
                <div className="text-center mb-8">
                    <div className="inline-flex items-center justify-center
                        w-16 h-16 bg-white rounded-2xl shadow-lg mb-4
                        overflow-hidden">
                        {branding.logo_url ? (
                            <img src={branding.logo_url} alt="Company Logo"
                                className="w-full h-full object-contain" />
                        ) : (
                            <span className="text-primary-900 font-bold text-xl">
                                {process.env.REACT_APP_COMPANY_INITIALS || 'CMS'}
                            </span>
                        )}
                    </div>
                    <h1 className="text-2xl font-bold text-white">
                        {branding.company_name}
                    </h1>
                </div>

                {/* Card */}
                <div className="bg-white rounded-2xl shadow-xl p-8 text-center">
                    <div className="w-16 h-16 bg-amber-100 rounded-full
                        flex items-center justify-center mx-auto mb-4">
                        <svg className="w-8 h-8 text-amber-600" fill="none"
                            viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round"
                                strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                    </div>

                    <h2 className="text-xl font-bold text-gray-900 mb-2">
                        Waiting for approval
                    </h2>
                    <p className="text-sm text-gray-500 mb-1">
                        Hi {user?.first_name}, your email is verified.
                    </p>
                    <p className="text-sm text-gray-500 mb-6">
                        An Administrator needs to assign your role before you can
                        access the system. You'll be taken in automatically once
                        that happens — no need to keep refreshing.
                    </p>

                    {!loading && roleRequest && (
                        <div className="bg-gray-50 rounded-lg p-4 mb-6 text-left">
                            <div className="flex items-center justify-between mb-1">
                                <span className="text-xs font-semibold text-gray-500">
                                    Requested role
                                </span>
                                <StatusBadge status={roleRequest.status} />
                            </div>
                            <p className="text-sm font-medium text-gray-900">
                                {roleRequest.role_name}
                            </p>
                            {roleRequest.reason && (
                                <p className="text-xs text-gray-500 mt-1">
                                    "{roleRequest.reason}"
                                </p>
                            )}
                            {roleRequest.status === 'REJECTED' && (
                                <p className="text-xs text-red-600 mt-2">
                                    This specific request wasn't approved
                                    {roleRequest.review_notes ? `: ${roleRequest.review_notes}` : '.'}
                                    {' '}An Administrator can still assign you a
                                    different role — you don't need to re-register.
                                </p>
                            )}
                        </div>
                    )}

                    {!loading && !roleRequest && (
                        <div className="bg-gray-50 rounded-lg p-4 mb-6">
                            <p className="text-xs text-gray-500">
                                No role was requested at registration. Please contact
                                an Administrator directly so they can assign one.
                            </p>
                        </div>
                    )}

                    <div className="flex flex-col gap-3">
                        <button onClick={handleCheckNow} disabled={checking}
                            className="btn-primary w-full">
                            {checking ? 'Checking...' : 'Check again'}
                        </button>
                        <button onClick={logout} className="btn-secondary w-full">
                            Log out
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default PendingApprovalPage;
