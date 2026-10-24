// ============================================================
// REGISTER PAGE
// New user registration with role request.
// v1.86.0 — accounts can be made by invitation only (the default): the
// page asks the server how registration works (/auth/registration-info).
//   • By invitation only, without a valid invitation link → no form,
//     an explanation instead.
//   • With an invitation link (?invite=…) → the email address is filled
//     in and locked; the role comes from the invitation.
//   • Closed → no form.
// A hidden "website" field is left empty by people; automated sign-up
// scripts fill it in, and the server then refuses the registration.
// ============================================================

import { useState, useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { authAPI } from '../../api/endpoints';
import { useBranding } from '../../contexts/BrandingContext';
import { getErrorMessage } from '../../utils/helpers';
import ErrorMessage from '../../components/common/ErrorMessage';

const RegisterPage = () => {
    const navigate = useNavigate();
    const { branding } = useBranding();

    const [roles,   setRoles]   = useState([]);
    const [loading, setLoading] = useState(false);
    const [success, setSuccess] = useState(false);
    const [error,   setError]   = useState(null);
    const [searchParams] = useSearchParams();
    const inviteToken = searchParams.get('invite') || '';
    const [info,    setInfo]    = useState(null);   // v1.86.0 { mode, invite }
    const [invited, setInvited] = useState(false);  // v1.86.0 — the account was made from an invitation
    const [website, setWebsite] = useState('');     // v1.86.0 — hidden field (people leave it empty)

    const [form, setForm] = useState({
        first_name:              '',
        last_name:               '',
        email:                   '',
        password:                '',
        confirm_password:        '',
        phone:                   '',
        nationality:             '',
        id_number:               '',
        requested_role_id:       '',
        role_request_reason:     '',
    });

    // Load available roles for the request dropdown. This uses the
    // public /auth/roles endpoint, not the protected /users/roles one
    // — a visitor on this page has no token yet, and calling a
    // protected endpoint here used to trigger a 401 that the global
    // axios interceptor treated as "session expired", hard-redirecting
    // back to /login a moment after the page loaded.
    useEffect(() => {
        authAPI.getPublicRoles()
            .then(res => setRoles(res.data.data))
            .catch(() => {});
    }, []);

    // v1.86.0 — how registration works, and who the invitation is for
    useEffect(() => {
        authAPI.registrationInfo(inviteToken || undefined)
            .then(res => {
                const d = res.data.data || {};
                setInfo(d);
                if (d.invite && d.invite.valid) {
                    setForm(prev => ({
                        ...prev,
                        email:      d.invite.email || prev.email,
                        first_name: d.invite.first_name || prev.first_name,
                        last_name:  d.invite.last_name || prev.last_name,
                    }));
                }
            })
            // an older server without this endpoint: registration as before
            .catch(() => setInfo({ mode: 'OPEN', invite: null }));
    }, [inviteToken]);

    const inviteValid = !!(info && info.invite && info.invite.valid);

    const handleChange = (e) => {
        setForm(prev => ({ ...prev, [e.target.name]: e.target.value }));
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError(null);

        if (form.password !== form.confirm_password) {
            setError('Passwords do not match');
            return;
        }

        setLoading(true);
        try {
            const res = await authAPI.register({
                invite_token:        inviteValid ? inviteToken : undefined,
                website:             website || undefined,
                first_name:          form.first_name,
                last_name:           form.last_name,
                email:               form.email,
                password:            form.password,
                phone:               form.phone || undefined,
                nationality:         form.nationality || undefined,
                id_number:           form.id_number || undefined,
                requested_role_id:   form.requested_role_id
                                        ? parseInt(form.requested_role_id)
                                        : undefined,
                role_request_reason: form.role_request_reason || undefined,
            });
            setInvited(!!res?.data?.data?.invited);
            setSuccess(true);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    // Success state
    if (success) {
        return (
            <div className="min-h-screen bg-gradient-to-br from-primary-900
                to-primary-700 flex items-center justify-center p-4">
                <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md w-full
                    text-center">
                    <div className="w-16 h-16 bg-green-100 rounded-full flex items-center
                        justify-center mx-auto mb-4">
                        <svg className="w-8 h-8 text-green-600" fill="none"
                            viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round"
                                strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                    </div>
                    <h2 className="text-xl font-bold text-gray-900 mb-2">
                        Registration Successful
                    </h2>
                    <p className="text-gray-500 text-sm mb-6">
                        {invited
                            ? 'Your account is ready — you can sign in now. An administrator will confirm your role; until then you will see a waiting page.'
                            : 'Please check your email to verify your account before logging in. Your role request will be reviewed by an administrator.'}
                    </p>
                    <button
                        onClick={() => navigate('/login')}
                        className="btn-primary w-full"
                    >
                        Go to Login
                    </button>
                </div>
            </div>
        );
    }

    // v1.86.0 — registration not available without an invitation (or closed)
    const blockedMessage = !info ? null
        : info.mode === 'CLOSED'
            ? 'New accounts cannot be created at the moment. If you are a member of the company, contact the company administrator.'
            : (info.mode === 'INVITE_ONLY' && !inviteValid)
                ? (inviteToken && info.invite && info.invite.reason
                    ? `${info.invite.reason} Ask the company administrator to send you a new invitation.`
                    : 'Accounts are created by invitation only. If you are a member of the company, ask the company administrator to send you an invitation by email, then open the link in it.')
                : null;

    if (!info || blockedMessage) {
        return (
            <div className="min-h-screen bg-gradient-to-br from-primary-900
                to-primary-700 flex items-center justify-center p-4">
                <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md w-full text-center">
                    {!info ? (
                        <p className="text-sm text-gray-500">Loading…</p>
                    ) : (
                        <>
                            <h2 className="text-xl font-bold text-gray-900 mb-2">Registration by invitation</h2>
                            <p className="text-gray-600 text-sm mb-6">{blockedMessage}</p>
                            <button onClick={() => navigate('/login')} className="btn-primary w-full">Go to Login</button>
                        </>
                    )}
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-gradient-to-br from-primary-900
            to-primary-700 flex items-center justify-center p-4">
            <div className="w-full max-w-2xl">

                {/* Header */}
                <div className="text-center mb-8">
                    <div className="inline-flex items-center justify-center w-16 h-16
                        bg-white rounded-2xl shadow-lg mb-4 overflow-hidden">
                        {/* GET /settings/company is public (v1.32.3) — same
                            pattern as LoginPage, so this page shows the real
                            uploaded logo instead of the shared bundled
                            /logo.png fallback. */}
                        {branding.logo_url ? (
                            <img src={branding.logo_url} alt="Company Logo"
                                className="w-full h-full object-contain" />
                        ) : (
                            <span className="text-primary-900 font-bold text-xl">
                                {process.env.REACT_APP_COMPANY_INITIALS || 'CMS'}
                            </span>
                        )}
                    </div>
                    <h1 className="text-2xl font-bold text-white">Create Account</h1>
                    <p className="text-primary-200 mt-1 text-sm">
                        Join the company management system
                    </p>
                </div>

                {/* Card */}
                <div className="bg-white rounded-2xl shadow-xl p-8">

                    {error && (
                        <div className="mb-6">
                            <ErrorMessage
                                message={error}
                                onDismiss={() => setError(null)}
                            />
                        </div>
                    )}

                    {inviteValid && (
                        <div className="mb-6 bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-900">
                            You were invited{info.invite.role_name ? <> for the role <strong>{info.invite.role_name}</strong></> : null}.
                            The account is made for <strong>{info.invite.email}</strong> — the address the invitation was sent to.
                        </div>
                    )}

                    <form onSubmit={handleSubmit} className="space-y-6">

                        {/* v1.86.0 — hidden from people; automated sign-ups fill it in */}
                        <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', top: 'auto', width: 1, height: 1, overflow: 'hidden' }}>
                            <label htmlFor="reg-website">Website</label>
                            <input id="reg-website" type="text" name="website" tabIndex={-1} autoComplete="off"
                                value={website} onChange={e => setWebsite(e.target.value)} />
                        </div>

                        {/* Personal Information */}
                        <div>
                            <h3 className="section-title mb-4">
                                Personal Information
                            </h3>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <div>
                                    <label className="label">First Name *</label>
                                    <input
                                        type="text"
                                        name="first_name"
                                        value={form.first_name}
                                        onChange={handleChange}
                                        className="input"
                                        required
                                    />
                                </div>
                                <div>
                                    <label className="label">Last Name *</label>
                                    <input
                                        type="text"
                                        name="last_name"
                                        value={form.last_name}
                                        onChange={handleChange}
                                        className="input"
                                        required
                                    />
                                </div>
                                <div>
                                    <label className="label">Email Address *</label>
                                    <input
                                        type="email"
                                        name="email"
                                        value={form.email}
                                        onChange={handleChange}
                                        className={`input ${inviteValid ? 'bg-gray-50' : ''}`}
                                        readOnly={inviteValid}
                                        required
                                    />
                                </div>
                                <div>
                                    <label className="label">Phone Number</label>
                                    <input
                                        type="tel"
                                        name="phone"
                                        value={form.phone}
                                        onChange={handleChange}
                                        className="input"
                                    />
                                </div>
                                <div>
                                    <label className="label">Nationality</label>
                                    <input
                                        type="text"
                                        name="nationality"
                                        value={form.nationality}
                                        onChange={handleChange}
                                        className="input"
                                    />
                                </div>
                                <div>
                                    <label className="label">ID / Passport Number</label>
                                    <input
                                        type="text"
                                        name="id_number"
                                        value={form.id_number}
                                        onChange={handleChange}
                                        className="input"
                                    />
                                </div>
                            </div>
                        </div>

                        {/* Password */}
                        <div>
                            <h3 className="section-title mb-4">Security</h3>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <div>
                                    <label className="label">Password *</label>
                                    <input
                                        type="password"
                                        name="password"
                                        value={form.password}
                                        onChange={handleChange}
                                        className="input"
                                        required
                                        minLength={8}
                                    />
                                    <p className="mt-1 text-xs text-gray-400">
                                        Min 8 chars, uppercase, number, special character
                                    </p>
                                </div>
                                <div>
                                    <label className="label">Confirm Password *</label>
                                    <input
                                        type="password"
                                        name="confirm_password"
                                        value={form.confirm_password}
                                        onChange={handleChange}
                                        className="input"
                                        required
                                    />
                                </div>
                            </div>
                        </div>

                        {/* Role Request — from the invitation when invited (v1.86.0) */}
                        {!(inviteValid && info.invite.role_id) && (
                        <div>
                            <h3 className="section-title mb-4">Role Request</h3>
                            <div className="space-y-4">
                                <div>
                                    <label className="label">
                                        Request a Role (optional)
                                    </label>
                                    <select
                                        name="requested_role_id"
                                        value={form.requested_role_id}
                                        onChange={handleChange}
                                        className="input"
                                    >
                                        <option value="">
                                            Select a role to request...
                                        </option>
                                        {roles.map(role => (
                                            <option key={role.id} value={role.id}>
                                                {role.name}
                                            </option>
                                        ))}
                                    </select>
                                    <p className="mt-1 text-xs text-gray-400">
                                        Role requests are reviewed and assigned
                                        by administrators.
                                    </p>
                                </div>
                                {form.requested_role_id && (
                                    <div>
                                        <label className="label">
                                            Reason for Role Request
                                        </label>
                                        <textarea
                                            name="role_request_reason"
                                            value={form.role_request_reason}
                                            onChange={handleChange}
                                            className="input"
                                            rows={3}
                                            placeholder="Briefly explain why you are requesting this role..."
                                        />
                                    </div>
                                )}
                            </div>
                        </div>
                        )}

                        {/* Submit */}
                        <button
                            type="submit"
                            disabled={loading}
                            className="btn-primary w-full py-3 text-base"
                        >
                            {loading ? 'Creating Account...' : 'Create Account'}
                        </button>
                    </form>

                    <p className="mt-6 text-center text-sm text-gray-500">
                        Already have an account?{' '}
                        <Link
                            to="/login"
                            className="text-primary-600 hover:text-primary-700
                                font-medium"
                        >
                            Sign in here
                        </Link>
                    </p>
                </div>
            </div>
        </div>
    );
};

export default RegisterPage;