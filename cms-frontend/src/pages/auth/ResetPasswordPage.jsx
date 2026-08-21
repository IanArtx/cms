// ============================================================
// RESET PASSWORD PAGE
// Public — no login required. Reached from the link in the
// password-reset email: /reset-password?token=xxxxx
// ============================================================

import { useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { authAPI } from '../../api/endpoints';
import { useBranding } from '../../contexts/BrandingContext';
import { getErrorMessage } from '../../utils/helpers';
import ErrorMessage from '../../components/common/ErrorMessage';

const ResetPasswordPage = () => {
    const { branding } = useBranding();
    const [searchParams] = useSearchParams();
    const navigate        = useNavigate();
    const token            = searchParams.get('token');

    const [password, setPassword]               = useState('');
    const [confirmPassword, setConfirmPassword]  = useState('');
    const [loading, setLoading]                  = useState(false);
    const [error, setError]                      = useState(null);
    const [success, setSuccess]                  = useState(false);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError(null);

        if (password !== confirmPassword) {
            setError('Passwords do not match.');
            return;
        }
        if (password.length < 8) {
            setError('Password must be at least 8 characters.');
            return;
        }

        setLoading(true);
        try {
            await authAPI.resetPassword({ token, password });
            setSuccess(true);
            setTimeout(() => navigate('/login'), 3000);
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
                        Set a new password
                    </p>
                </div>

                {/* Card */}
                <div className="bg-white rounded-2xl shadow-xl p-8">

                    {!token ? (
                        <div className="text-center">
                            <div className="w-16 h-16 bg-red-100 rounded-full
                                flex items-center justify-center mx-auto mb-4">
                                <svg className="w-8 h-8 text-red-600"
                                    fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round"
                                        strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </div>
                            <h2 className="text-xl font-bold text-gray-900 mb-2">
                                Invalid Link
                            </h2>
                            <p className="text-sm text-gray-500 mb-6">
                                No reset token found in this link. Please request a new
                                password reset.
                            </p>
                            <Link to="/forgot-password" className="btn-primary w-full block">
                                Request New Link
                            </Link>
                        </div>
                    ) : success ? (
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
                                Password Reset
                            </h2>
                            <p className="text-sm text-gray-500">
                                Your password has been changed. Redirecting you to login
                                in 3 seconds...
                            </p>
                        </div>
                    ) : (
                        <>
                            {error && (
                                <div className="mb-4">
                                    <ErrorMessage message={error} onDismiss={() => setError(null)} />
                                </div>
                            )}

                            <form onSubmit={handleSubmit} className="space-y-5">
                                <div>
                                    <label className="label">New Password</label>
                                    <input
                                        type="password"
                                        value={password}
                                        onChange={(e) => setPassword(e.target.value)}
                                        className="input"
                                        placeholder="••••••••"
                                        required
                                        autoFocus
                                    />
                                    <p className="text-xs text-gray-400 mt-1">
                                        At least 8 characters, with an uppercase letter, a number, and a special character
                                    </p>
                                </div>

                                <div>
                                    <label className="label">Confirm New Password</label>
                                    <input
                                        type="password"
                                        value={confirmPassword}
                                        onChange={(e) => setConfirmPassword(e.target.value)}
                                        className="input"
                                        placeholder="••••••••"
                                        required
                                    />
                                </div>

                                <button
                                    type="submit"
                                    disabled={loading}
                                    className="btn-primary w-full py-3 text-base"
                                >
                                    {loading ? 'Resetting...' : 'Reset Password'}
                                </button>
                            </form>
                        </>
                    )}

                    {!success && (
                        <p className="mt-6 text-center text-sm text-gray-500">
                            <Link to="/login" className="text-primary-600 hover:text-primary-700 font-medium">
                                Back to login
                            </Link>
                        </p>
                    )}
                </div>
            </div>
        </div>
    );
};

export default ResetPasswordPage;
