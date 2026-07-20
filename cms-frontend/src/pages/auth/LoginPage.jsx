// ============================================================
// LOGIN PAGE
// Handles email/password login and 2FA verification.
// ============================================================

import { useState } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { getErrorMessage } from '../../utils/helpers';
import ErrorMessage from '../../components/common/ErrorMessage';

const LoginPage = () => {
    const { login, verify2FA } = useAuth();
    const navigate  = useNavigate();
    const location  = useLocation();
    const from      = location.state?.from?.pathname || '/';

    const [step, setStep]       = useState('login'); // 'login' or '2fa'
    const [loading, setLoading] = useState(false);
    const [error, setError]     = useState(null);

    // Login form state
    const [email,    setEmail]    = useState('');
    const [password, setPassword] = useState('');

    // 2FA form state
    const [twoFACode, setTwoFACode] = useState('');

    // --------------------------------------------------------
    // HANDLE LOGIN
    // --------------------------------------------------------
    const handleLogin = async (e) => {
        e.preventDefault();
        setError(null);
        setLoading(true);

        try {
            const { requiresTwoFactor } = await login(email, password);

            if (requiresTwoFactor) {
                setStep('2fa');
            } else {
                navigate(from, { replace: true });
            }
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    // --------------------------------------------------------
    // HANDLE 2FA VERIFICATION
    // --------------------------------------------------------
    const handle2FA = async (e) => {
        e.preventDefault();
        setError(null);
        setLoading(true);

        try {
            await verify2FA(twoFACode);
            navigate(from, { replace: true });
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
                        {/* Uses the bundled /logo.png static asset (not the
                            /api/settings/company endpoint) — this page loads
                            before any login happens, so there's no token yet
                            to call an authenticated endpoint with. Falls back
                            to initials only if that file is somehow missing. */}
                        <img
                            src="/logo.png"
                            alt="Company Logo"
                            className="w-full h-full object-contain"
                            onError={(e) => {
                                e.target.style.display = 'none';
                                e.target.parentElement.innerHTML =
                                    `<span class="text-primary-900 font-bold text-xl">${
                                        process.env.REACT_APP_COMPANY_INITIALS || 'CMS'
                                    }</span>`;
                            }}
                        />
                    </div>
                    <h1 className="text-2xl font-bold text-white">
                        {process.env.REACT_APP_COMPANY_NAME || 'Company Management System'}
                    </h1>
                    <p className="text-primary-200 mt-1 text-sm">
                        {step === 'login'
                            ? 'Sign in to your account'
                            : 'Enter your two-factor authentication code'
                        }
                    </p>
                </div>

                {/* Card */}
                <div className="bg-white rounded-2xl shadow-xl p-8">

                    {/* Error */}
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage
                                message={error}
                                onDismiss={() => setError(null)}
                            />
                        </div>
                    )}

                    {/* LOGIN FORM */}
                    {step === 'login' && (
                        <form onSubmit={handleLogin} className="space-y-5">
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

                            <div>
                                <div className="flex justify-between items-center mb-1">
                                    <label className="label mb-0">Password</label>
                                    <Link
                                        to="/forgot-password"
                                        className="text-xs text-primary-600
                                            hover:text-primary-700 font-medium"
                                    >
                                        Forgot password?
                                    </Link>
                                </div>
                                <input
                                    type="password"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
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
                                {loading ? 'Signing in...' : 'Sign In'}
                            </button>
                        </form>
                    )}

                    {/* 2FA FORM */}
                    {step === '2fa' && (
                        <form onSubmit={handle2FA} className="space-y-5">
                            <div className="text-center mb-2">
                                <p className="text-sm text-gray-500">
                                    Open your authenticator app and enter the
                                    6-digit code for this account.
                                </p>
                            </div>

                            <div>
                                <label className="label">Authentication Code</label>
                                <input
                                    type="text"
                                    value={twoFACode}
                                    onChange={(e) => setTwoFACode(
                                        e.target.value.replace(/\D/g, '').slice(0, 6)
                                    )}
                                    className="input text-center text-2xl
                                        tracking-[0.5em] font-mono"
                                    placeholder="000000"
                                    maxLength={6}
                                    required
                                    autoFocus
                                />
                            </div>

                            <button
                                type="submit"
                                disabled={loading || twoFACode.length !== 6}
                                className="btn-primary w-full py-3 text-base"
                            >
                                {loading ? 'Verifying...' : 'Verify Code'}
                            </button>

                            <button
                                type="button"
                                onClick={() => {
                                    setStep('login');
                                    setTwoFACode('');
                                    setError(null);
                                }}
                                className="w-full text-sm text-gray-500
                                    hover:text-gray-700 transition-colors"
                            >
                                Back to login
                            </button>
                        </form>
                    )}

                    {/* Register link */}
                    {step === 'login' && (
                        <p className="mt-6 text-center text-sm text-gray-500">
                            Don't have an account?{' '}
                            <Link
                                to="/register"
                                className="text-primary-600 hover:text-primary-700
                                    font-medium"
                            >
                                Register here
                            </Link>
                        </p>
                    )}
                </div>
            </div>
        </div>
    );
};

export default LoginPage;