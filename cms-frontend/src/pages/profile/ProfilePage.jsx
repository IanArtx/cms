// ============================================================
// PROFILE PAGE
// Summary view first — shows member activity, shareholding,
// and personal info. Edit mode is separate.
// ============================================================

import { useState, useEffect } from 'react';
import { usersAPI, authAPI, certificatesAPI, sideFundAPI } from '../../api/endpoints';
import api from '../../api/axios';
import { formatDate, formatRelativeTime, getErrorMessage, getUploadUrl } from '../../utils/helpers';
import { shareCertificateTemplate, printDocument } from '../../utils/exportUtils';
import PageHeader from '../../components/common/PageHeader';
import ErrorMessage from '../../components/common/ErrorMessage';
import LoadingSpinner from '../../components/common/LoadingSpinner';
import Avatar, { AVATAR_OPTIONS, IllustratedAvatar } from '../../components/common/Avatar';
import PhotoCropModal from '../../components/common/PhotoCropModal';
import SignaturePad from '../../components/common/SignaturePad';
import { useAuth } from '../../contexts/AuthContext';
import { useConfirm } from '../../contexts/ConfirmContext';
import PasswordRules, { PasswordInput, passwordMeetsRules } from '../../components/common/PasswordRules'; // v1.75.0
import {
    UserCircleIcon,
    KeyIcon,
    ShieldCheckIcon,
    CameraIcon,
    PencilIcon,
    PencilSquareIcon,
    CheckIcon,
    XMarkIcon,
    DocumentTextIcon,
} from '@heroicons/react/24/outline';
import { useTabParam } from '../../hooks/useTabParam'; // v1.71.0 — tab kept in the address

// ============================================================
// EDIT PERSONAL INFO FORM
// ============================================================
const EditProfileForm = ({ user, onSuccess, onCancel }) => {
    const [form, setForm] = useState({
        first_name:              user?.first_name || '',
        last_name:               user?.last_name  || '',
        phone:                   user?.phone       || '',
        nationality:             user?.nationality || '',
        id_number:               user?.id_number   || '',
        address:                 user?.address     || '',
        emergency_contact_name:  user?.emergency_contact_name  || '',
        emergency_contact_phone: user?.emergency_contact_phone || '',
        // v1.70.0 — used for withholding tax on dividends / interest paid to you
        tin:                     user?.tin || '',
        tax_residency:           user?.tax_residency || 'RESIDENT',
    });
    const [loading, setLoading] = useState(false);
    const [error,   setError]   = useState(null);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await usersAPI.updateMyProfile(form);
            onSuccess();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    return (
        <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
                <ErrorMessage message={error} onDismiss={() => setError(null)} />
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                    <label className="label">First Name</label>
                    <input type="text" className="input" value={form.first_name}
                        onChange={e => setForm(p => ({ ...p, first_name: e.target.value }))} />
                </div>
                <div>
                    <label className="label">Last Name</label>
                    <input type="text" className="input" value={form.last_name}
                        onChange={e => setForm(p => ({ ...p, last_name: e.target.value }))} />
                </div>
                <div>
                    <label className="label">Phone Number</label>
                    <input type="tel" className="input" value={form.phone}
                        onChange={e => setForm(p => ({ ...p, phone: e.target.value }))} />
                </div>
                <div>
                    <label className="label">Nationality</label>
                    <input type="text" className="input" value={form.nationality}
                        onChange={e => setForm(p => ({ ...p, nationality: e.target.value }))} />
                </div>
                <div>
                    <label className="label">ID / Passport Number</label>
                    <input type="text" className="input" value={form.id_number}
                        onChange={e => setForm(p => ({ ...p, id_number: e.target.value }))} />
                </div>
                <div>
                    <label className="label">TIN (Uganda, 10 digits)</label>
                    <input type="text" className="input" value={form.tin} maxLength={10}
                        onChange={e => setForm(p => ({ ...p, tin: e.target.value.replace(/\D/g, '') }))}
                        placeholder="Leave empty if you have none" />
                </div>
                <div>
                    <label className="label">Tax residency</label>
                    <select className="input" value={form.tax_residency}
                        onChange={e => setForm(p => ({ ...p, tax_residency: e.target.value }))}>
                        <option value="RESIDENT">Resident in Uganda</option>
                        <option value="NON_RESIDENT">Not resident in Uganda</option>
                    </select>
                </div>
            </div>
            <p className="text-xs text-gray-400">
                Your TIN and tax residency decide the withholding tax on dividends and savings interest paid to you,
                and are printed on your withholding tax certificates.
            </p>
            <div>
                <label className="label">Address</label>
                <textarea className="input" rows={2} value={form.address}
                    onChange={e => setForm(p => ({ ...p, address: e.target.value }))} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                    <label className="label">Emergency Contact Name</label>
                    <input type="text" className="input"
                        value={form.emergency_contact_name}
                        onChange={e => setForm(p => ({
                            ...p, emergency_contact_name: e.target.value }))} />
                </div>
                <div>
                    <label className="label">Emergency Contact Phone</label>
                    <input type="tel" className="input"
                        value={form.emergency_contact_phone}
                        onChange={e => setForm(p => ({
                            ...p, emergency_contact_phone: e.target.value }))} />
                </div>
            </div>
            <div className="flex justify-end gap-3">
                <button type="button" onClick={onCancel} className="btn-secondary">
                    Cancel
                </button>
                <button type="submit" disabled={loading} className="btn-primary">
                    {loading ? 'Saving...' : 'Save Changes'}
                </button>
            </div>
        </form>
    );
};

// ============================================================
// CHANGE PASSWORD FORM (v1.75.0)
// Current password + new password (twice), with a live checklist of
// the rules. When it succeeds, every OTHER device signed in to this
// account is signed out; this device gets fresh sign-in tokens and
// stays signed in. An email tells the member it happened (with a
// "wasn't me" reset link).
// Forgot the current password? A reset link is emailed instead.
// ============================================================
const ChangePasswordForm = () => {
    const { user } = useAuth();
    const empty = { current_password: '', new_password: '', confirm_password: '' };
    const [form,     setForm]     = useState(empty);
    const [loading,  setLoading]  = useState(false);
    const [error,    setError]    = useState(null);
    const [success,  setSuccess]  = useState(null);
    const [sending,  setSending]  = useState(false);
    const [linkSent, setLinkSent] = useState(false);

    const set = (k) => (e) => setForm(p => ({ ...p, [k]: e.target.value }));
    const rulesOk = passwordMeetsRules(form.new_password);
    const matches = form.new_password && form.new_password === form.confirm_password;
    const canSubmit = form.current_password && rulesOk && matches && !loading;

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!rulesOk)  { setError('The new password does not meet all the rules yet (see the list under it).'); return; }
        if (!matches)  { setError('The two new passwords are not the same.'); return; }
        if (form.new_password === form.current_password) { setError('The new password must be different from the current one.'); return; }
        setLoading(true);
        setError(null);
        setSuccess(null);
        try {
            const res = await authAPI.changePassword({
                current_password: form.current_password,
                new_password: form.new_password,
            });
            // The old sign-in on this device was ended along with the
            // others — keep this device signed in with the new tokens.
            const { accessToken, refreshToken } = res.data.data || {};
            if (accessToken)  localStorage.setItem('accessToken', accessToken);
            if (refreshToken) localStorage.setItem('refreshToken', refreshToken);
            setSuccess(res.data.message || 'Password changed.');
            setForm(empty);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    const sendResetLink = async () => {
        setSending(true);
        setError(null);
        try {
            await authAPI.forgotPassword({ email: user.email });
            setLinkSent(true);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setSending(false);
        }
    };

    return (
        <div className="space-y-4 max-w-xl">
            {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
            {success && (
                <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm text-green-700">
                    {success}
                </div>
            )}
            <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                    <label className="label" htmlFor="pw-current">Current password</label>
                    <PasswordInput id="pw-current" value={form.current_password} onChange={set('current_password')}
                        autoComplete="current-password" />
                </div>
                <div>
                    <label className="label" htmlFor="pw-new">New password</label>
                    <PasswordInput id="pw-new" value={form.new_password} onChange={set('new_password')}
                        autoComplete="new-password" />
                </div>
                <div>
                    <label className="label" htmlFor="pw-confirm">Type the new password again</label>
                    <PasswordInput id="pw-confirm" value={form.confirm_password} onChange={set('confirm_password')}
                        autoComplete="new-password" />
                    <PasswordRules password={form.new_password} confirm={form.confirm_password} showMatch />
                </div>
                <p className="text-xs text-gray-500">
                    After the change, any other phone or computer signed in to your account is signed out.
                    You stay signed in here.
                </p>
                <button type="submit" disabled={!canSubmit} className="btn-primary">
                    {loading ? 'Changing…' : 'Change password'}
                </button>
            </form>

            <div className="border-t border-gray-200 pt-4">
                <p className="text-sm font-medium text-gray-700">Forgot your current password?</p>
                {linkSent ? (
                    <p className="text-sm text-green-700 mt-1">
                        A link to set a new password was sent to <strong>{user?.email}</strong>. It works for one hour.
                    </p>
                ) : (
                    <>
                        <p className="text-sm text-gray-500 mt-1">
                            We can email a link to <strong>{user?.email}</strong> that lets you set a new one.
                        </p>
                        <button type="button" onClick={sendResetLink} disabled={sending} className="btn-secondary mt-2">
                            {sending ? 'Sending…' : 'Email me a reset link'}
                        </button>
                    </>
                )}
            </div>
        </div>
    );
};

// ============================================================
// CHANGE EMAIL FORM (v1.75.0)
// The new address only takes effect when the member clicks the link
// we email to it (within 48 hours). The current address is told and
// gets a link to stop it — or undo it for 7 days after it went through.
// ============================================================
const ChangeEmailForm = ({ profile, onChanged }) => {
    const [pending,  setPending]  = useState(null);
    const [loaded,   setLoaded]   = useState(false);
    const [form,     setForm]     = useState({ new_email: '', current_password: '', two_factor_code: '' });
    const [loading,  setLoading]  = useState(false);
    const [error,    setError]    = useState(null);
    const [success,  setSuccess]  = useState(null);
    const confirm = useConfirm();

    useEffect(() => {
        usersAPI.getMyEmailChange()
            .then(res => setPending(res.data.data || null))
            .catch(() => setPending(null))
            .finally(() => setLoaded(true));
    }, []);

    const set = (k) => (e) => setForm(p => ({ ...p, [k]: e.target.value }));
    const needs2FA = !!profile?.two_factor_enabled;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        setSuccess(null);
        try {
            const body = { new_email: form.new_email.trim(), current_password: form.current_password };
            if (needs2FA) body.two_factor_code = form.two_factor_code.trim();
            const res = await usersAPI.requestEmailChange(body);
            setPending(res.data.data || null);
            setSuccess(res.data.message);
            setForm({ new_email: '', current_password: '', two_factor_code: '' });
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    const cancelPending = async () => {
        const ok = await confirm({
            title: 'Cancel email change',
            message: `Stop the change to ${pending?.new_email}? Your address stays ${profile?.email}.`,
            confirmLabel: 'Cancel the change',
        });
        if (!ok) return;
        setError(null);
        try {
            const res = await usersAPI.cancelMyEmailChange();
            setPending(null);
            setSuccess(res.data.message);
            if (onChanged) onChanged();
        } catch (err) {
            setError(getErrorMessage(err));
        }
    };

    return (
        <div className="space-y-4 max-w-xl">
            {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
            {success && (
                <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm text-green-700">
                    {success}
                </div>
            )}

            <p className="text-sm text-gray-600">
                You sign in with <strong>{profile?.email}</strong>.
            </p>

            {loaded && pending && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm">
                    <p className="font-medium text-amber-900">
                        Waiting for confirmation: {pending.new_email}
                    </p>
                    <p className="text-amber-800 mt-1">
                        {pending.requested_by_admin
                            ? <>Started by {pending.requested_by_name || 'an Admin'}{pending.admin_reason ? <> — reason: “{pending.admin_reason}”</> : null}. </>
                            : null}
                        Open the email we sent to <strong>{pending.new_email}</strong> and press the link
                        before {formatDate(pending.expires_at)} ({formatRelativeTime(pending.expires_at)}).
                        Nothing changes until then.
                    </p>
                    <p className="text-amber-800 mt-1">
                        Didn't get it? Check the spam folder, or ask again below — a new link replaces the old one.
                    </p>
                    <button type="button" onClick={cancelPending} className="btn-secondary mt-3">
                        Cancel this change
                    </button>
                </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                    <label className="label" htmlFor="em-new">New email address</label>
                    <input id="em-new" type="email" className="input" value={form.new_email}
                        onChange={set('new_email')} autoComplete="email" required />
                </div>
                <div>
                    <label className="label" htmlFor="em-pw">Your current password</label>
                    <PasswordInput id="em-pw" value={form.current_password} onChange={set('current_password')}
                        autoComplete="current-password" />
                    <p className="text-xs text-gray-500 mt-1">Asked so nobody using an unlocked device can move your account to their own address.</p>
                </div>
                {needs2FA && (
                    <div>
                        <label className="label" htmlFor="em-2fa">6-digit code from your authenticator app</label>
                        <input id="em-2fa" type="text" inputMode="numeric" maxLength={6} className="input w-40 tracking-widest"
                            value={form.two_factor_code}
                            onChange={e => setForm(p => ({ ...p, two_factor_code: e.target.value.replace(/\D/g, '') }))}
                            autoComplete="one-time-code" required />
                    </div>
                )}
                <p className="text-xs text-gray-500">
                    We email a confirmation link to the new address (it works for 48 hours). Your current address
                    is told too, with a link to stop the change — or undo it within 7 days.
                </p>
                <button type="submit" disabled={loading} className="btn-primary">
                    {loading ? 'Sending…' : 'Send confirmation link'}
                </button>
            </form>
        </div>
    );
};

// ============================================================
// 2FA SECTION
// ============================================================
const TwoFactorSection = ({ user, onSuccess }) => {
    const [qrCode,    setQrCode]    = useState(null);
    const [manualKey, setManualKey] = useState(null);
    const [code,      setCode]      = useState('');
    const [step,      setStep]      = useState('idle');
    const [loading,   setLoading]   = useState(false);
    const [error,     setError]     = useState(null);
    const [success,   setSuccess]   = useState(null);

    const setup2FA = async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await authAPI.setup2FA();
            setQrCode(res.data.data.qrCode);
            setManualKey(res.data.data.manualKey);
            setStep('scan');
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    const activate2FA = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await authAPI.activate2FA({ token: code });
            setSuccess('Two-factor authentication enabled successfully.');
            setStep('idle');
            setQrCode(null);
            if (onSuccess) onSuccess();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="space-y-4">
            {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
            {success && (
                <div className="bg-green-50 border border-green-200 rounded-lg
                    p-3 text-sm text-green-700">{success}</div>
            )}
            {user?.two_factor_enabled ? (
                <div className="flex items-center gap-3 p-4 bg-green-50
                    rounded-lg border border-green-200">
                    <ShieldCheckIcon className="h-6 w-6 text-green-600 flex-shrink-0" />
                    <div>
                        <p className="text-sm font-medium text-green-800">
                            Two-factor authentication is enabled
                        </p>
                        <p className="text-xs text-green-600">
                            Your account is protected with an authenticator app
                        </p>
                    </div>
                </div>
            ) : (
                <>
                    <div className="flex items-center gap-3 p-4 bg-yellow-50
                        rounded-lg border border-yellow-200">
                        <ShieldCheckIcon className="h-6 w-6 text-yellow-600 flex-shrink-0" />
                        <div>
                            <p className="text-sm font-medium text-yellow-800">
                                Two-factor authentication is not enabled
                            </p>
                            <p className="text-xs text-yellow-600">
                                Enable 2FA to secure your account
                            </p>
                        </div>
                    </div>
                    {step === 'idle' && (
                        <button onClick={setup2FA} disabled={loading}
                            className="btn-primary">
                            {loading ? 'Setting up...' : 'Enable 2FA'}
                        </button>
                    )}
                    {step === 'scan' && qrCode && (
                        <div className="space-y-4">
                            <p className="text-sm text-gray-600">
                                Scan with Google Authenticator or Authy:
                            </p>
                            <img src={qrCode} alt="2FA QR Code"
                                className="w-48 h-48 border border-gray-200 rounded-lg" />
                            {manualKey && (
                                <div className="bg-gray-50 rounded-lg p-3">
                                    <p className="text-xs text-gray-500 mb-1">
                                        Manual key:
                                    </p>
                                    <code className="text-sm font-mono text-gray-800
                                        break-all">{manualKey}</code>
                                </div>
                            )}
                            <form onSubmit={activate2FA} className="space-y-3">
                                <div>
                                    <label className="label">6-digit code</label>
                                    <input type="text"
                                        className="input w-40 text-center font-mono
                                            text-xl tracking-widest"
                                        value={code}
                                        onChange={e => setCode(
                                            e.target.value.replace(/\D/g, '').slice(0, 6)
                                        )}
                                        maxLength={6} required />
                                </div>
                                <div className="flex gap-3">
                                    <button type="submit"
                                        disabled={loading || code.length !== 6}
                                        className="btn-primary">
                                        {loading ? 'Verifying...' : 'Verify & Activate'}
                                    </button>
                                    <button type="button"
                                        onClick={() => { setStep('idle'); setCode(''); }}
                                        className="btn-secondary">Cancel</button>
                                </div>
                            </form>
                        </div>
                    )}
                </>
            )}
        </div>
    );
};

// ============================================================
// AVATAR PICKER SECTION
// Lets a member choose one of the built-in illustrated avatars
// instead of uploading a real photo. A real uploaded photo always
// takes priority over an avatar choice (see the Avatar component),
// so this is purely a "for the meantime" option.
// ============================================================
const AvatarPickerSection = ({ profile, onSuccess }) => {
    const [gender, setGender]   = useState(profile?.gender || 'MALE');
    const [loading, setLoading] = useState(false);
    const [error, setError]     = useState(null);

    const genders = [
        { value: 'MALE',   label: 'Male'   },
        { value: 'FEMALE', label: 'Female' },
        { value: 'OTHER',  label: 'Other / Prefer not to say' },
    ];

    const options = AVATAR_OPTIONS.filter(o => o.gender === gender);

    const choose = async (optionId) => {
        setLoading(true);
        setError(null);
        try {
            await usersAPI.updateMyProfile({ gender, avatar_choice: optionId });
            onSuccess();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    const removeAvatar = async () => {
        setLoading(true);
        setError(null);
        try {
            // An explicit empty string clears the choice (unlike leaving the
            // field out of the request, which the backend treats as "no change").
            await usersAPI.updateMyProfile({ avatar_choice: '' });
            onSuccess();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="border border-gray-200 rounded-lg p-4 mb-6">
            <div className="flex items-center justify-between mb-3">
                <div>
                    <h4 className="text-sm font-semibold text-gray-800">
                        Choose an Avatar
                    </h4>
                    <p className="text-xs text-gray-500 mt-0.5">
                        Don't want to upload a real photo? Pick an illustrated
                        avatar to use instead — it only shows when you haven't
                        uploaded a photo.
                    </p>
                </div>
                {profile?.avatar_choice && (
                    <button type="button" onClick={removeAvatar} disabled={loading}
                        className="text-xs text-gray-500 hover:text-red-600
                            underline whitespace-nowrap">
                        Remove avatar
                    </button>
                )}
            </div>

            {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}

            <div className="flex gap-2 mb-4">
                {genders.map(g => (
                    <button key={g.value} type="button"
                        onClick={() => setGender(g.value)}
                        className={`chip-filter ${gender === g.value ? 'chip-filter-active' : ''}`}
                    >
                        {g.label}
                    </button>
                ))}
            </div>

            <div className="flex flex-wrap gap-3">
                {options.map(o => (
                    <button key={o.id} type="button" disabled={loading}
                        onClick={() => choose(o.id)}
                        title={o.id}
                        style={{
                            border: profile?.avatar_choice === o.id
                                ? '2px solid #1d4ed8' : '2px solid transparent',
                            borderRadius: '50%', padding: '2px', cursor: 'pointer',
                            background: 'none',
                        }}
                    >
                        <IllustratedAvatar optionId={o.id} size={52} />
                    </button>
                ))}
            </div>
        </div>
    );
};

// ============================================================
// MAIN PROFILE PAGE
// ============================================================
const ProfilePage = () => {
    const { user, refreshUser }                 = useAuth();
    const [profile,        setProfile]          = useState(null);
    const [loading,        setLoading]          = useState(true);
    const [activeTab,      setActiveTab]        = useTabParam('summary');
    const [editing,        setEditing]          = useState(false);
    const [photoUploading, setPhotoUploading]   = useState(false);
    const [photoError,     setPhotoError]       = useState(null);
    const [cropFile,       setCropFile]         = useState(null);
    const [editSuccess,    setEditSuccess]      = useState(false);
    const [certLoading,    setCertLoading]      = useState(null); // 'MONTHLY' | 'ANNUAL' | null
    const [certError,      setCertError]        = useState(null);
    const [signatureSaving, setSignatureSaving] = useState(false);
    const [signatureError,  setSignatureError]  = useState(null);
    const [signatureSuccess, setSignatureSuccess] = useState(false);
    const [sideFundDues,   setSideFundDues]     = useState([]);
    const [sideFundCredit, setSideFundCredit]   = useState(null);

    useEffect(() => {
        usersAPI.getMyProfile()
            .then(res => setProfile(res.data.data))
            .catch(() => {})
            .finally(() => setLoading(false));
        // Side fund (v1.25.0) — every shareholder's own due history and any
        // banked overpayment credit, shown alongside shareholding below.
        Promise.all([sideFundAPI.getMyDues(), sideFundAPI.getMyCredit()])
            .then(([duesRes, creditRes]) => {
                setSideFundDues(duesRes.data.data || []);
                setSideFundCredit(creditRes.data.data || null);
            })
            .catch(() => {});
    }, []);

    const reloadProfile = () => {
        usersAPI.getMyProfile()
            .then(res => setProfile(res.data.data))
            .catch(() => {});
        // Keep the top bar / sidebar avatar and name in sync too.
        refreshUser();
    };

    const handleDownloadCertificate = async (certificateType) => {
        setCertLoading(certificateType);
        setCertError(null);
        try {
            const res = await certificatesAPI.issue({ certificate_type: certificateType });
            printDocument(shareCertificateTemplate(res.data.data), 'Certificate of Shares');
        } catch (err) {
            setCertError(getErrorMessage(err));
        } finally {
            setCertLoading(null);
        }
    };

    // v1.28.3 — picking a file no longer uploads it straight away. It
    // opens PhotoCropModal first (drag/zoom inside a circular frame,
    // matching how the avatar actually displays everywhere), and only
    // the cropped result gets uploaded — see handleCropSave below.
    const handlePhotoSelect = (e) => {
        const file = e.target.files[0];
        e.target.value = ''; // allow re-selecting the same file later
        if (!file) return;
        if (!['image/jpeg', 'image/png'].includes(file.type)) {
            setPhotoError('Only JPEG and PNG images are allowed');
            return;
        }
        if (file.size > 5 * 1024 * 1024) {
            setPhotoError('Image must be smaller than 5MB');
            return;
        }
        setPhotoError(null);
        setCropFile(file);
    };

    const handleCropSave = async (blob) => {
        setPhotoUploading(true);
        setPhotoError(null);
        try {
            const formData = new FormData();
            formData.append('photo', blob, 'avatar.png');
            await api.patch('/users/me/photo', formData, {
                headers: { 'Content-Type': 'multipart/form-data' },
            });
            setCropFile(null);
            reloadProfile();
        } catch (err) {
            setPhotoError(getErrorMessage(err));
        } finally {
            setPhotoUploading(false);
        }
    };

    // v1.23.0 — redraw signature (Section 4.29). The consent flow
    // saves one at sign-up; this lets a member replace it later (e.g.
    // they weren't happy with how it looked the first time). Existing
    // signed documents are unaffected — they keep their own snapshot
    // taken at signing time, not a live reference to this one.
    const handleSignatureChange = async (dataUrl) => {
        if (!dataUrl) return;
        setSignatureSaving(true);
        setSignatureError(null);
        setSignatureSuccess(false);
        try {
            await usersAPI.updateSignature(dataUrl);
            reloadProfile();
            setSignatureSuccess(true);
            setTimeout(() => setSignatureSuccess(false), 3000);
        } catch (err) {
            setSignatureError(getErrorMessage(err));
        } finally {
            setSignatureSaving(false);
        }
    };

    const handleEditSuccess = () => {
        reloadProfile();
        setEditing(false);
        setEditSuccess(true);
        setTimeout(() => setEditSuccess(false), 3000);
    };

    if (loading) return <LoadingSpinner fullPage text="Loading profile..." />;

    const roles = Array.isArray(profile?.roles)
        ? profile.roles.map(r => typeof r === 'object' ? r.name : r)
        : [];

    return (
        <div className="max-w-6xl mx-auto">
            <PageHeader
                title="My Profile"
                subtitle="Your account summary and settings"
            />

            {editSuccess && (
                <div className="mb-4 bg-green-50 border border-green-200
                    rounded-lg p-3 text-sm text-green-700 flex items-center gap-2">
                    <CheckIcon className="h-4 w-4" />
                    Profile updated successfully.
                </div>
            )}

            {/* Profile Header Card */}
            <div className="card mb-6">
                <div className="flex items-center gap-5">
                    {/* Avatar */}
                    <div style={{ position: 'relative', flexShrink: 0 }}>
                        <div style={{
                            width: '88px', height: '88px', borderRadius: '50%',
                            display: 'flex', alignItems: 'center',
                            justifyContent: 'center', overflow: 'hidden',
                            border: '3px solid #e5e7eb',
                        }}>
                            <Avatar user={profile} size={88} />
                            {photoUploading && (
                                <div style={{
                                    position: 'absolute', inset: 0,
                                    backgroundColor: 'rgba(0,0,0,0.5)',
                                    display: 'flex', alignItems: 'center',
                                    justifyContent: 'center',
                                }}>
                                    <div style={{
                                        width: '20px', height: '20px',
                                        border: '2px solid white',
                                        borderTopColor: 'transparent',
                                        borderRadius: '50%',
                                        animation: 'spin 0.8s linear infinite',
                                    }} />
                                </div>
                            )}
                        </div>
                        <label htmlFor="photo-upload" title="Change photo"
                            style={{
                                position: 'absolute', bottom: 0, right: 0,
                                width: '28px', height: '28px', borderRadius: '50%',
                                backgroundColor: '#2563eb', border: '2px solid white',
                                display: 'flex', alignItems: 'center',
                                justifyContent: 'center',
                                cursor: photoUploading ? 'not-allowed' : 'pointer',
                            }}>
                            <CameraIcon style={{ width: '14px', height: '14px',
                                color: 'white' }} />
                        </label>
                        <input id="photo-upload" type="file"
                            accept="image/jpeg,image/png"
                            style={{ display: 'none' }}
                            onChange={handlePhotoSelect}
                            disabled={photoUploading} />
                    </div>

                    {/* Name and roles */}
                    <div className="flex-1 min-w-0">
                        <h2 className="text-2xl font-bold text-gray-900">
                            {profile?.first_name} {profile?.last_name}
                        </h2>
                        <p className="text-sm text-gray-500 mt-0.5">
                            {profile?.email}
                        </p>
                        {photoError && (
                            <p className="text-xs text-red-500 mt-1">{photoError}</p>
                        )}
                        <div className="flex flex-wrap gap-1 mt-2">
                            {roles.map((role, i) => (
                                <span key={i} className="badge-blue">{role}</span>
                            ))}
                        </div>
                    </div>

                    {/* Quick stats */}
                    <div className="text-right flex-shrink-0">
                        <p className="text-xs text-gray-400">Member since</p>
                        <p className="text-sm font-semibold text-gray-700">
                            {formatDate(profile?.created_at)}
                        </p>
                        {profile?.last_login_at && (
                            <>
                                <p className="text-xs text-gray-400 mt-2">Last login</p>
                                <p className="text-sm text-gray-600">
                                    {formatRelativeTime(profile?.last_login_at)}
                                </p>
                            </>
                        )}
                        {profile?.shareholding && (
                            <>
                                <p className="text-xs text-gray-400 mt-2">Shareholding</p>
                                <p className="text-lg font-bold text-primary-700">
                                    {profile.shareholding.percentage || '—'}%
                                </p>
                            </>
                        )}
                    </div>
                </div>
            </div>

            {/* Tabs — overflow-x-auto (v1.32.5) so every tab stays reachable
                by scrolling on a narrow screen instead of overflowing with
                no way to reach it. */}
            <div className="tab-bar" role="tablist">
                {[
                    { key: 'summary',   label: 'Summary',          icon: UserCircleIcon },
                    { key: 'personal',  label: 'Personal Info',     icon: PencilIcon },
                    { key: 'signature', label: 'Signature',         icon: PencilSquareIcon },
                    { key: 'password',  label: 'Password & Email',  icon: KeyIcon },
                    { key: '2fa',       label: 'Security',          icon: ShieldCheckIcon },
                ].map(tab => (
                    <button
                        key={tab.key}
                        onClick={() => { setActiveTab(tab.key); setEditing(false); }}
                        className={`tab ${activeTab === tab.key ? 'tab-active' : ''}`}
                    >
                        <tab.icon className="h-4 w-4" />
                        {tab.label}
                    </button>
                ))}
            </div>

            {/* Tab Content */}
            <div className="card">

                {/* SUMMARY TAB */}
                {activeTab === 'summary' && (
                    <div>
                        <h3 className="section-title mb-6">Account Summary</h3>

                        {/* Shareholding */}
                        {profile?.shareholding && (
                            <div className="bg-gradient-to-r from-primary-900
                                to-primary-700 rounded-xl p-5 text-white mb-6">
                                <p className="text-sm text-primary-200 mb-1">
                                    My Shareholding
                                </p>
                                <p className="text-4xl font-bold">
                                    {profile.shareholding.percentage || '—'}%
                                </p>
                                <p className="text-primary-200 text-sm mt-1">
                                    {parseFloat(profile.shareholding.shares_held || 0)
                                        .toLocaleString('en-US', { maximumFractionDigits: 2 })} shares held
                                </p>

                                {/* Share value + total contributions breakdown */}
                                <div className="grid grid-cols-2 gap-4 mt-4 pt-4
                                    border-t border-white/20">
                                    <div>
                                        <p className="text-xs text-primary-200">
                                            Share Value
                                        </p>
                                        <p className="text-lg font-bold">
                                            {profile.shareholding.share_value != null
                                                ? `${profile.shareholding.currency_symbol ||
                                                    profile.shareholding.currency_code} ${parseFloat(
                                                        profile.shareholding.share_value
                                                    ).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
                                                : '—'
                                            }
                                        </p>
                                        {profile.shareholding.share_value_conversions?.length > 0 && (
                                            <p className="text-xs text-primary-200 mt-1">
                                                {profile.shareholding.share_value_conversions.map((c, i) => (
                                                    <span key={i}>
                                                        {i > 0 && ' · '}
                                                        ≈ {c.currency_symbol || c.currency_code}{' '}
                                                        {parseFloat(c.amount).toLocaleString(undefined, {
                                                            maximumFractionDigits: 2 })}
                                                    </span>
                                                ))}
                                            </p>
                                        )}
                                    </div>
                                    <div>
                                        <p className="text-xs text-primary-200">
                                            Total Contributions
                                        </p>
                                        {profile.total_contributions?.length > 0 ? (
                                            profile.total_contributions.map((c, i) => (
                                                <p key={i} className="text-lg font-bold">
                                                    {c.currency_symbol || c.currency_code}{' '}
                                                    {parseFloat(c.amount).toLocaleString(undefined, {
                                                        maximumFractionDigits: 2 })}
                                                </p>
                                            ))
                                        ) : (
                                            <p className="text-lg font-bold">—</p>
                                        )}
                                    </div>
                                </div>

                                {/* Certificate of Shares */}
                                <div className="flex flex-wrap gap-2 mt-4 pt-4 border-t border-white/20">
                                    <button
                                        onClick={() => handleDownloadCertificate('MONTHLY')}
                                        disabled={certLoading !== null}
                                        className="flex items-center gap-2 px-3 py-1.5 rounded-lg
                                            bg-white/10 hover:bg-white/20 text-white text-xs
                                            font-medium transition-colors disabled:opacity-50"
                                    >
                                        <DocumentTextIcon className="h-4 w-4" />
                                        {certLoading === 'MONTHLY' ? 'Preparing...' : 'Download Monthly Certificate'}
                                    </button>
                                    <button
                                        onClick={() => handleDownloadCertificate('ANNUAL')}
                                        disabled={certLoading !== null}
                                        className="flex items-center gap-2 px-3 py-1.5 rounded-lg
                                            bg-white/10 hover:bg-white/20 text-white text-xs
                                            font-medium transition-colors disabled:opacity-50"
                                    >
                                        <DocumentTextIcon className="h-4 w-4" />
                                        {certLoading === 'ANNUAL' ? 'Preparing...' : 'Download Annual Certificate'}
                                    </button>
                                </div>
                                {certError && (
                                    <p className="text-xs text-red-200 mt-2">{certError}</p>
                                )}
                            </div>
                        )}

                        {/* Side Fund */}
                        {sideFundDues.length > 0 && (() => {
                            const currentDue = sideFundDues[0]; // ORDER BY period DESC
                            const outstanding = parseFloat(currentDue.amount_due) - parseFloat(currentDue.amount_paid);
                            const creditBalance = parseFloat(sideFundCredit?.credit_balance || 0);
                            const statusColor = {
                                PAID: 'text-green-300',
                                PARTIAL: 'text-yellow-300',
                                PENDING: 'text-primary-200',
                                DEFAULTED: 'text-red-300',
                            }[currentDue.status] || 'text-primary-200';
                            return (
                                <div className="bg-gradient-to-r from-emerald-900
                                    to-emerald-700 rounded-xl p-5 text-white mb-6">
                                    <p className="text-sm text-emerald-200 mb-1">
                                        My Side Fund — {currentDue.period}
                                    </p>
                                    <p className="text-4xl font-bold">
                                        {outstanding > 0 ? outstanding.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '0.00'}
                                    </p>
                                    <p className={`text-sm mt-1 font-medium ${statusColor}`}>
                                        {currentDue.status === 'PAID' ? 'Paid in full for this period'
                                            : currentDue.status === 'DEFAULTED' ? 'Defaulted — overdue'
                                            : currentDue.status === 'PARTIAL' ? 'Partially paid, balance outstanding'
                                            : 'Outstanding for this period'}
                                    </p>

                                    <div className="grid grid-cols-2 gap-4 mt-4 pt-4
                                        border-t border-white/20">
                                        <div>
                                            <p className="text-xs text-emerald-200">
                                                Amount Due This Period
                                            </p>
                                            <p className="text-lg font-bold">
                                                {parseFloat(currentDue.amount_due).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                                            </p>
                                        </div>
                                        <div>
                                            <p className="text-xs text-emerald-200">
                                                Banked Credit
                                            </p>
                                            <p className="text-lg font-bold">
                                                {creditBalance > 0
                                                    ? creditBalance.toLocaleString(undefined, { maximumFractionDigits: 2 })
                                                    : '—'}
                                            </p>
                                            {creditBalance > 0 && (
                                                <p className="text-xs text-emerald-200 mt-1">
                                                    Applied automatically to future months
                                                </p>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            );
                        })()}

                        {/* Info Grid */}
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-6">
                            <div className="bg-gray-50 rounded-lg p-4">
                                <p className="text-xs text-gray-400">Account Status</p>
                                <p className="text-sm font-semibold text-green-600 mt-1">
                                    Active
                                </p>
                            </div>
                            <div className="bg-gray-50 rounded-lg p-4">
                                <p className="text-xs text-gray-400">Email Verified</p>
                                <p className={`text-sm font-semibold mt-1 ${
                                    profile?.is_email_verified
                                        ? 'text-green-600' : 'text-red-500'
                                }`}>
                                    {profile?.is_email_verified ? 'Yes' : 'No'}
                                </p>
                            </div>
                            <div className="bg-gray-50 rounded-lg p-4">
                                <p className="text-xs text-gray-400">2FA Enabled</p>
                                <p className={`text-sm font-semibold mt-1 ${
                                    profile?.two_factor_enabled
                                        ? 'text-green-600' : 'text-yellow-600'
                                }`}>
                                    {profile?.two_factor_enabled ? 'Yes' : 'Not set'}
                                </p>
                            </div>
                            <div className="bg-gray-50 rounded-lg p-4">
                                <p className="text-xs text-gray-400">Roles Assigned</p>
                                <p className="text-sm font-semibold text-gray-700 mt-1">
                                    {roles.length}
                                </p>
                            </div>
                            <div className="bg-gray-50 rounded-lg p-4">
                                <p className="text-xs text-gray-400">Member Since</p>
                                <p className="text-sm font-semibold text-gray-700 mt-1">
                                    {formatDate(profile?.created_at)}
                                </p>
                            </div>
                            <div className="bg-gray-50 rounded-lg p-4">
                                <p className="text-xs text-gray-400">Last Login</p>
                                <p className="text-sm font-semibold text-gray-700 mt-1">
                                    {profile?.last_login_at
                                        ? formatRelativeTime(profile.last_login_at)
                                        : 'Never'}
                                </p>
                            </div>
                        </div>

                        {/* Personal Details Read-only */}
                        <div className="border-t border-gray-100 pt-5">
                            <div className="flex items-center justify-between mb-4">
                                <h4 className="text-sm font-semibold text-gray-700">
                                    Personal Information
                                </h4>
                                <button
                                    onClick={() => setActiveTab('personal')}
                                    className="text-xs text-primary-600
                                        hover:text-primary-700 font-medium
                                        flex items-center gap-1"
                                >
                                    <PencilIcon className="h-3 w-3" />
                                    Edit
                                </button>
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                {[
                                    { label: 'Phone', value: profile?.phone },
                                    { label: 'Nationality', value: profile?.nationality },
                                    { label: 'ID / Passport', value: profile?.id_number },
                                    { label: 'TIN', value: profile?.tin },
                                    { label: 'Tax residency', value: profile?.tax_residency === 'NON_RESIDENT' ? 'Not resident in Uganda' : 'Resident in Uganda' },
                                    { label: 'Address', value: profile?.address },
                                    { label: 'Emergency Contact',
                                        value: profile?.emergency_contact_name },
                                    { label: 'Emergency Phone',
                                        value: profile?.emergency_contact_phone },
                                ].map((field, i) => (
                                    <div key={i}>
                                        <p className="text-xs text-gray-400">
                                            {field.label}
                                        </p>
                                        <p className="text-sm text-gray-700 mt-0.5">
                                            {field.value || '—'}
                                        </p>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                )}

                {/* PERSONAL INFO TAB */}
                {activeTab === 'personal' && (
                    <div>
                        <div className="flex items-center justify-between mb-4">
                            <h3 className="section-title">Personal Information</h3>
                        </div>
                        <AvatarPickerSection profile={profile} onSuccess={reloadProfile} />
                        <EditProfileForm
                            user={profile}
                            onSuccess={handleEditSuccess}
                            onCancel={() => setActiveTab('summary')}
                        />
                    </div>
                )}

                {/* SIGNATURE TAB (v1.23.0, Section 4.29) */}
                {activeTab === 'signature' && (
                    <div>
                        <h3 className="section-title mb-2">My Signature</h3>
                        <p className="text-sm text-gray-500 mb-4">
                            This is attached to documents you approve (Resolutions, Loan/Grant
                            Agreements, Share Certificates, and similar). Redrawing it here replaces
                            it going forward — documents you've already signed keep the signature
                            image as it looked at the time, unaffected by this change.
                        </p>

                        {profile?.signature_path && (
                            <div className="mb-4">
                                <p className="text-xs text-gray-400 mb-1">Current signature</p>
                                <img src={getUploadUrl(profile.signature_path)} alt="Current signature"
                                    className="h-16 border border-gray-200 rounded-lg bg-white p-2" />
                            </div>
                        )}

                        {signatureError && <ErrorMessage message={signatureError} />}
                        {signatureSuccess && (
                            <div className="bg-green-50 border border-green-200 rounded-lg p-3 mb-4">
                                <p className="text-sm text-green-700">Signature updated</p>
                            </div>
                        )}

                        <p className="text-xs text-gray-400 mb-1">
                            {profile?.signature_path ? 'Draw a new signature to replace it' : 'Draw your signature'}
                        </p>
                        <SignaturePad onChange={handleSignatureChange} />
                        {signatureSaving && <p className="text-xs text-primary-600 mt-2">Saving...</p>}
                    </div>
                )}

                {/* PASSWORD TAB */}
                {activeTab === 'password' && (
                    <>
                        <h3 className="section-title mb-4">Change Password</h3>
                        <ChangePasswordForm />
                        {/* v1.75.0 — email address change */}
                        <h3 className="section-title mt-8 pt-6 border-t border-gray-200 mb-4">Change Email Address</h3>
                        <ChangeEmailForm profile={profile} onChanged={reloadProfile} />
                    </>
                )}

                {/* 2FA TAB */}
                {activeTab === '2fa' && (
                    <>
                        <h3 className="section-title mb-4">
                            Two-Factor Authentication
                        </h3>
                        <TwoFactorSection
                            user={profile}
                            onSuccess={reloadProfile}
                        />
                    </>
                )}
            </div>

            <PhotoCropModal
                isOpen={!!cropFile}
                file={cropFile}
                onCancel={() => setCropFile(null)}
                onSave={handleCropSave}
                saving={photoUploading}
            />
        </div>
    );
};

export default ProfilePage;