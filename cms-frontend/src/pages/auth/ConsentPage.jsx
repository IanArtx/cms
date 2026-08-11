// ============================================================
// CONSENT PAGE (v1.23.0, Section 4.29)
//
// Where a role-assigned user who has NOT yet consented to the
// Membership Agreement lands, instead of the normal Sidebar/TopBar/
// Dashboard — the next step in the same onboarding chain
// PendingApprovalPage.jsx starts (verify email -> get a role ->
// consent + sign -> full access). AppLayout.jsx redirects here
// centrally for any such account; see that file's comment for the
// full rationale, and requireConsent in middleware/auth.js for the
// backend half.
//
// Two things happen on this one screen, in order:
//   1. Draw a personal signature (SignaturePad) — saved immediately
//      via PATCH /users/me/signature so it's available the moment
//      consent is given.
//   2. Read the Membership Agreement and consent to it — POST
//      /users/me/consent, which requires the signature to already
//      be saved (Section 4.29's business rule).
//
// No Sidebar/TopBar here on purpose, same reasoning as
// PendingApprovalPage — nothing to navigate to until this is done.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useBranding } from '../../contexts/BrandingContext';
import { usersAPI } from '../../api/endpoints';
import SignaturePad from '../../components/common/SignaturePad';

const ConsentPage = () => {
    const { user, refreshUser, logout } = useAuth();
    const { branding } = useBranding();
    const navigate = useNavigate();

    const [agreement, setAgreement] = useState(null);
    const [loading, setLoading] = useState(true);
    const [signatureDataUrl, setSignatureDataUrl] = useState(null);
    const [savingSignature, setSavingSignature] = useState(false);
    const [signatureSaved, setSignatureSaved] = useState(false);
    const [agreed, setAgreed] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');

    // Already consented (e.g. approved in another tab) — don't sit
    // here, leave immediately.
    useEffect(() => {
        if (user?.has_consented) {
            navigate('/', { replace: true });
        }
    }, [user, navigate]);

    const loadAgreement = useCallback(async () => {
        try {
            const res = await usersAPI.getMembershipAgreement();
            setAgreement(res.data.data.agreement);
        } catch {
            setAgreement(null);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { loadAgreement(); }, [loadAgreement]);

    // A user might already have a signature saved from a previous
    // visit to this page (e.g. they drew it, then closed the tab
    // before consenting) — don't make them redraw it.
    useEffect(() => {
        if (user?.signature_path) setSignatureSaved(true);
    }, [user]);

    const handleSignatureChange = async (dataUrl) => {
        setSignatureDataUrl(dataUrl);
        setSignatureSaved(false);
        setError('');
        if (!dataUrl) return;

        setSavingSignature(true);
        try {
            await usersAPI.updateSignature(dataUrl);
            setSignatureSaved(true);
        } catch (err) {
            setError(err.response?.data?.message || 'Could not save your signature — please try again.');
        } finally {
            setSavingSignature(false);
        }
    };

    const handleSubmit = async () => {
        setError('');
        if (!signatureSaved) {
            setError('Please draw and save your signature first.');
            return;
        }
        if (!agreed) {
            setError('Please confirm you have read and agree to the Membership Agreement.');
            return;
        }

        setSubmitting(true);
        try {
            await usersAPI.giveConsent();
            await refreshUser();
            navigate('/', { replace: true });
        } catch (err) {
            setError(err.response?.data?.message || 'Could not record your consent — please try again.');
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="min-h-screen bg-gradient-to-br from-primary-900
            to-primary-700 flex items-center justify-center p-4 py-10">
            <div className="w-full max-w-2xl">

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
                <div className="bg-white rounded-2xl shadow-xl p-8">
                    <h2 className="text-xl font-bold text-gray-900 mb-2 text-center">
                        Welcome, {user?.first_name}
                    </h2>
                    <p className="text-sm text-gray-500 mb-6 text-center">
                        Before you continue, please set up your signature and consent to the
                        Membership Agreement below. This is a one-time step.
                    </p>

                    {/* Step 1 — Signature */}
                    <div className="mb-6">
                        <h3 className="text-sm font-semibold text-gray-900 mb-2">
                            1. Your signature
                        </h3>
                        <p className="text-xs text-gray-500 mb-3">
                            This will be attached to documents you approve going forward
                            (Resolutions, Loan/Grant Agreements, Share Certificates, and similar).
                        </p>
                        <SignaturePad onChange={handleSignatureChange} />
                        {savingSignature && (
                            <p className="text-xs text-primary-600 mt-2">Saving signature...</p>
                        )}
                        {signatureSaved && !savingSignature && (
                            <p className="text-xs text-green-600 mt-2 flex items-center gap-1">
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                </svg>
                                Signature saved
                            </p>
                        )}
                    </div>

                    {/* Step 2 — Membership Agreement */}
                    <div className="mb-6">
                        <h3 className="text-sm font-semibold text-gray-900 mb-2">
                            2. Membership Agreement
                        </h3>
                        {loading ? (
                            <p className="text-xs text-gray-400">Loading agreement...</p>
                        ) : (
                            <div className="bg-gray-50 border border-gray-200 rounded-lg p-4
                                max-h-56 overflow-y-auto text-sm text-gray-700 whitespace-pre-wrap">
                                {agreement?.content || 'The Membership Agreement is not available right now.'}
                            </div>
                        )}
                        {agreement?.version && (
                            <p className="text-xs text-gray-400 mt-1">Version {agreement.version}</p>
                        )}

                        <label className="flex items-start gap-2 mt-3 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={agreed}
                                onChange={(e) => setAgreed(e.target.checked)}
                                className="mt-0.5"
                            />
                            <span className="text-sm text-gray-700">
                                I have read and agree to the Membership Agreement above.
                            </span>
                        </label>
                    </div>

                    {error && (
                        <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4">
                            <p className="text-sm text-red-600">{error}</p>
                        </div>
                    )}

                    <div className="flex flex-col gap-3">
                        <button
                            onClick={handleSubmit}
                            disabled={submitting || !signatureSaved || !agreed}
                            className="btn-primary w-full disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {submitting ? 'Submitting...' : 'Agree and continue'}
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

export default ConsentPage;
