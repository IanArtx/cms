// ============================================================
// FORGOT PASSWORD PAGE
// Public — no login required. Lets a locked-out member request a
// password reset link by email. Always shows the same success
// message regardless of whether the email exists (matches the
// backend's forgotPassword controller, which never reveals whether
// an account exists — that's an intentional anti-enumeration choice,
// not a bug, so this page must not contradict it).
// ============================================================

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { authAPI } from '../../api/endpoints';
import { useBranding } from '../../contexts/BrandingContext';
import { getErrorMessage } from '../../utils/helpers';
import ErrorMessage from '../../components/common/ErrorMessage';

const ForgotPasswordPage = () => {
    const { branding } = useBranding();
    const [email, setEmail]     = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError]     = useState(null);
    const [sent, setSent]       = useState(false);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError(null);
        setLoading(true);
        try {
            await authAPI.forgotPassword({ email });
            setSent(true);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-gradient-to-br from-primary-900 to-primary-700
            flex items-center justify-center p-4">
            <div className="w-full max-w-md">

                {/* Logo / Company Name */}
                <div className="text-center mb-8">
                    <div className="inline-flex items-center justify-center w-16 h-16
                        bg-white rounded-2xl shadow-lg mb-4 overflow-hidden">
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
                    <p className="text-primary-200 mt-1 text-sm">
                        Reset your password
                    </p>
                </div>

                {/* Card */}
                <div className="bg-white rounded-2xl shadow-xl p-8">

                    {!sent ? (
                        <>
                            <p className="text-sm text-gray-500 mb-5">
                                Enter the email address on your account and we'll send you
                                a link to reset your password.
                            </p>

                            {error && (
                                <div className="mb-4">
                                    <ErrorMessage message={error} onDismiss={() => setError(null)} />
                                </div>
                            )}

                            <form onSubmit={handleSubmit} className="space-y-5">
                                <div>
                                    <label className="label">Email Address</label>
                                    <input
                                        type="email"
                                        value={email}
                                        onChange={(e) => setEmail(e.target.value)}
                                        className="input"
                                        placeholder="you@company.com"
                                        required
                                        autoFocus
                                    />
                                </div>

                                <button
                                    type="submit"
                                    disabled={loading}
                                    className="btn-primary w-full py-3 text-base"
                                >
                                    {loading ? 'Sending...' : 'Send Reset Link'}
                                </button>
                            </form>
                        </>
                    ) : (
                        <div className="text-center">
                            <div className="w-16 h-16 bg-green-100 rounded-full
                                flex items-center justify-center mx-auto mb-4">
                                <svg className="w-8 h-8 text-green-600"
                                    fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round"
                                        strokeWidth={2} d="M5 13l4 4L19 7" />
                                </svg>
                            </div>
                            <h2 className="text-xl font-bold text-gray-900 mb-2">
                                Check Your Email
                            </h2>
                            <p className="text-sm text-gray-500">
                                If an account exists for <strong>{email}</strong>, a password
                                reset link has been sent. The link expires in 1 hour.
                            </p>
                        </div>
                    )}

                    <p className="mt-6 text-center text-sm text-gray-500">
                        <Link to="/login" className="text-primary-600 hover:text-primary-700 font-medium">
                            Back to login
                        </Link>
                    </p>
                </div>
            </div>
        </div>
    );
};

export default ForgotPasswordPage;
