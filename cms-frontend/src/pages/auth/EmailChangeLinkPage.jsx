// ============================================================
// EMAIL CHANGE LINK PAGE (v1.75.0)
// Public — no sign-in needed. Opened from the two links an email
// change sends:
//
//   /confirm-email-change?token=…  (sent to the NEW address)
//       "Yes, this is my address" → the change takes effect.
//
//   /cancel-email-change?token=…   (sent to the OLD address)
//       "I didn't ask for this" → the waiting change is cancelled;
//       if it had already been confirmed (within 7 days) it is
//       UNDONE: the old address comes back, every device is signed
//       out and a link to set a new password goes to the old address.
//
// Nothing happens just by opening the page — the person presses the
// button. (Some email systems open links automatically to scan them;
// this keeps such a scan from confirming or cancelling anything.)
// ============================================================

import { useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { authAPI } from '../../api/endpoints';
import { useBranding } from '../../contexts/BrandingContext';

const EmailChangeLinkPage = ({ mode }) => {
    const { branding } = useBranding();
    const [searchParams] = useSearchParams();
    const token = searchParams.get('token');
    const isConfirm = mode === 'confirm';

    const [status,  setStatus]  = useState(token ? 'ready' : 'error'); // ready | working | success | error
    const [message, setMessage] = useState(token ? '' : 'This link is incomplete. Please open it again from the email, or copy the whole link into your browser.');

    const go = async () => {
        setStatus('working');
        try {
            const res = isConfirm
                ? await authAPI.confirmEmailChange(token)
                : await authAPI.cancelEmailChange(token);
            setMessage(res.data.message);
            setStatus('success');
            // Anyone signed in on this browser should re-load their details
            // (the address or the sign-in itself may have changed).
            try {
                if (!isConfirm && res.data.data?.outcome === 'reverted') {
                    localStorage.removeItem('accessToken');
                    localStorage.removeItem('refreshToken');
                    localStorage.removeItem('user');
                }
            } catch (_) { /* storage unavailable — nothing to clear */ }
        } catch (err) {
            setMessage(err.response?.data?.message || 'This link could not be used. It may have expired — please ask for the change again from your profile.');
            setStatus('error');
        }
    };

    return (
        <div className="min-h-screen bg-gradient-to-br from-primary-900 to-primary-700 flex items-center justify-center p-4">
            <div className="w-full max-w-md">
                <div className="text-center mb-8">
                    <div className="inline-flex items-center justify-center w-16 h-16 bg-white rounded-2xl shadow-lg mb-4 overflow-hidden">
                        {branding.logo_url ? (
                            <img src={branding.logo_url} alt="Company Logo" className="w-full h-full object-contain" />
                        ) : (
                            <span className="text-primary-900 font-bold text-xl">
                                {process.env.REACT_APP_COMPANY_INITIALS || 'CMS'}
                            </span>
                        )}
                    </div>
                    <h1 className="text-2xl font-bold text-white">{branding.company_name}</h1>
                </div>

                <div className="bg-white rounded-2xl shadow-xl p-8 text-center">
                    {(status === 'ready' || status === 'working') && (
                        <>
                            <h2 className="text-xl font-bold text-gray-900 mb-2">
                                {isConfirm ? 'Confirm your new email address' : 'Stop this email change'}
                            </h2>
                            <p className="text-sm text-gray-500 mb-6">
                                {isConfirm
                                    ? 'Press the button to make this address the one you sign in with. Your password stays the same.'
                                    : 'If you did not ask to change the email address on your account, press the button. A change that is still waiting is cancelled; one that already went through (in the last 7 days) is undone — your old address comes back, every device is signed out and we email you a link to set a new password.'}
                            </p>
                            <button
                                type="button"
                                onClick={go}
                                disabled={status === 'working'}
                                className={`${isConfirm ? 'btn-primary' : 'btn-danger'} w-full`}
                            >
                                {status === 'working'
                                    ? 'Please wait…'
                                    : isConfirm ? 'Yes, confirm this address' : "I didn't ask for this — stop it"}
                            </button>
                            <Link to="/login" className="block text-sm text-gray-500 hover:text-gray-700 mt-4">
                                Not now — go to sign in
                            </Link>
                        </>
                    )}

                    {status === 'success' && (
                        <>
                            <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                                <svg className="w-8 h-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                </svg>
                            </div>
                            <h2 className="text-xl font-bold text-gray-900 mb-2">
                                {isConfirm ? 'Email address confirmed' : 'Done'}
                            </h2>
                            <p className="text-sm text-gray-600 mb-6">{message}</p>
                            <Link to="/login" className="btn-primary w-full block">Go to sign in</Link>
                        </>
                    )}

                    {status === 'error' && (
                        <>
                            <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
                                <svg className="w-8 h-8 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </div>
                            <h2 className="text-xl font-bold text-gray-900 mb-2">This link can't be used</h2>
                            <p className="text-sm text-gray-600 mb-6">{message}</p>
                            <Link to="/login" className="btn-secondary w-full block">Back to sign in</Link>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};

export default EmailChangeLinkPage;
