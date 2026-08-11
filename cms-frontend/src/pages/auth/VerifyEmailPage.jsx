// ============================================================
// EMAIL VERIFICATION PAGE
// Handles the email verification link sent after registration.
// URL format: /verify-email?token=xxxxx
// ============================================================

import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { authAPI } from '../../api/endpoints';

const VerifyEmailPage = () => {
    const [searchParams]  = useSearchParams();
    const navigate        = useNavigate();
    const token           = searchParams.get('token');

    const [status,  setStatus]  = useState('verifying'); // verifying | success | error
    const [message, setMessage] = useState('');

    useEffect(() => {
        if (!token) {
            setStatus('error');
            setMessage('No verification token found in the link. Please check your email and try again.');
            return;
        }

        const verify = async () => {
            try {
                await authAPI.verifyEmail(token);
                setStatus('success');
                // Auto redirect to login after 3 seconds
                setTimeout(() => navigate('/login'), 3000);
            } catch (err) {
                setStatus('error');
                setMessage(
                    err.response?.data?.message ||
                    'This verification link is invalid or has expired. Please register again or contact support.'
                );
            }
        };

        verify();
    }, [token, navigate]);

    return (
        <div className="min-h-screen bg-gradient-to-br from-primary-900
            to-primary-700 flex items-center justify-center p-4">
            <div className="w-full max-w-md">

                {/* Logo */}
                <div className="text-center mb-8">
                    <div className="inline-flex items-center justify-center
                        w-16 h-16 bg-white rounded-2xl shadow-lg mb-4">
                        <span className="text-primary-900 font-bold text-xl">
                            {process.env.REACT_APP_COMPANY_INITIALS || 'CMS'}
                        </span>
                    </div>
                    <h1 className="text-2xl font-bold text-white">
                        {process.env.REACT_APP_COMPANY_NAME}
                    </h1>
                </div>

                {/* Card */}
                <div className="bg-white rounded-2xl shadow-xl p-8 text-center">

                    {/* Verifying */}
                    {status === 'verifying' && (
                        <>
                            <div className="w-16 h-16 border-4 border-primary-200
                                border-t-primary-700 rounded-full animate-spin
                                mx-auto mb-4" />
                            <h2 className="text-xl font-bold text-gray-900 mb-2">
                                Verifying your email...
                            </h2>
                            <p className="text-sm text-gray-500">
                                Please wait while we verify your email address.
                            </p>
                        </>
                    )}

                    {/* Success */}
                    {status === 'success' && (
                        <>
                            <div className="w-16 h-16 bg-green-100 rounded-full
                                flex items-center justify-center mx-auto mb-4">
                                <svg className="w-8 h-8 text-green-600"
                                    fill="none" viewBox="0 0 24 24"
                                    stroke="currentColor">
                                    <path strokeLinecap="round"
                                        strokeLinejoin="round" strokeWidth={2}
                                        d="M5 13l4 4L19 7" />
                                </svg>
                            </div>
                            <h2 className="text-xl font-bold text-gray-900 mb-2">
                                Email Verified Successfully
                            </h2>
                            <p className="text-sm text-gray-500 mb-6">
                                Your email has been verified. You can now log in
                                to your account. Redirecting you to login in 3
                                seconds...
                            </p>
                            <Link to="/login" className="btn-primary w-full block">
                                Go to Login Now
                            </Link>
                        </>
                    )}

                    {/* Error */}
                    {status === 'error' && (
                        <>
                            <div className="w-16 h-16 bg-red-100 rounded-full
                                flex items-center justify-center mx-auto mb-4">
                                <svg className="w-8 h-8 text-red-600"
                                    fill="none" viewBox="0 0 24 24"
                                    stroke="currentColor">
                                    <path strokeLinecap="round"
                                        strokeLinejoin="round" strokeWidth={2}
                                        d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </div>
                            <h2 className="text-xl font-bold text-gray-900 mb-2">
                                Verification Failed
                            </h2>
                            <p className="text-sm text-gray-500 mb-6">
                                {message}
                            </p>
                            <Link to="/login" className="btn-secondary w-full block">
                                Back to Login
                            </Link>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};

export default VerifyEmailPage;