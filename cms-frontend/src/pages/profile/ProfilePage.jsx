// ============================================================
// PROFILE PAGE
// Summary view first — shows member activity, shareholding,
// and personal info. Edit mode is separate.
// ============================================================

import { useState, useEffect } from 'react';
import { usersAPI, authAPI, certificatesAPI } from '../../api/endpoints';
import api from '../../api/axios';
import { formatDate, formatRelativeTime, getErrorMessage } from '../../utils/helpers';
import { shareCertificateTemplate, printDocument } from '../../utils/exportUtils';
import PageHeader from '../../components/common/PageHeader';
import ErrorMessage from '../../components/common/ErrorMessage';
import LoadingSpinner from '../../components/common/LoadingSpinner';
import Avatar, { AVATAR_OPTIONS, IllustratedAvatar } from '../../components/common/Avatar';
import { useAuth } from '../../contexts/AuthContext';
import {
    UserCircleIcon,
    KeyIcon,
    ShieldCheckIcon,
    CameraIcon,
    PencilIcon,
    CheckIcon,
    XMarkIcon,
    DocumentTextIcon,
} from '@heroicons/react/24/outline';

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
            </div>
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
// CHANGE PASSWORD FORM
// ============================================================
const ChangePasswordForm = () => {
    const { user } = useAuth();
    const [form, setForm] = useState({
        token: '', password: '', confirm_password: ''
    });
    const [loading,  setLoading]  = useState(false);
    const [error,    setError]    = useState(null);
    const [success,  setSuccess]  = useState(false);
    const [sending,  setSending]  = useState(false);
    const [codeSent, setCodeSent] = useState(false);

    const sendResetCode = async () => {
        setSending(true);
        setError(null);
        try {
            await authAPI.forgotPassword({ email: user.email });
            setCodeSent(true);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setSending(false);
        }
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (form.password !== form.confirm_password) {
            setError('Passwords do not match');
            return;
        }
        setLoading(true);
        setError(null);
        try {
            await authAPI.resetPassword({ token: form.token, password: form.password });
            setSuccess(true);
            setForm({ token: '', password: '', confirm_password: '' });
            setCodeSent(false);
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
                <div className="bg-green-50 border border-green-200 rounded-lg p-3
                    text-sm text-green-700">
                    Password changed successfully.
                </div>
            )}
            {!codeSent ? (
                <div>
                    <p className="text-sm text-gray-500 mb-4">
                        A reset code will be sent to:{' '}
                        <strong>{user?.email}</strong>
                    </p>
                    <button onClick={sendResetCode} disabled={sending}
                        className="btn-secondary">
                        {sending ? 'Sending...' : 'Send Reset Code to My Email'}
                    </button>
                </div>
            ) : (
                <form onSubmit={handleSubmit} className="space-y-4">
                    <p className="text-sm text-green-600">
                        Check your inbox at {user?.email} for the reset code.
                    </p>
                    <div>
                        <label className="label">Reset Code</label>
                        <input type="text" className="input" value={form.token}
                            onChange={e => setForm(p => ({ ...p, token: e.target.value }))}
                            placeholder="Paste code from email" required />
                    </div>
                    <div>
                        <label className="label">New Password</label>
                        <input type="password" className="input" value={form.password}
                            onChange={e => setForm(p => ({ ...p, password: e.target.value }))}
                            minLength={8} required />
                    </div>
                    <div>
                        <label className="label">Confirm New Password</label>
                        <input type="password" className="input"
                            value={form.confirm_password}
                            onChange={e => setForm(p => ({
                                ...p, confirm_password: e.target.value }))}
                            required />
                    </div>
                    <div className="flex gap-3">
                        <button type="submit" disabled={loading} className="btn-primary">
                            {loading ? 'Changing...' : 'Change Password'}
                        </button>
                        <button type="button"
                            onClick={() => setCodeSent(false)}
                            className="btn-secondary">Back</button>
                    </div>
                </form>
            )}
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
                        className={`text-xs px-3 py-1.5 rounded-full font-medium
                            transition-colors ${
                            gender === g.value
                                ? 'bg-primary-700 text-white'
                                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                        }`}
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
    const [activeTab,      setActiveTab]        = useState('summary');
    const [editing,        setEditing]          = useState(false);
    const [photoUploading, setPhotoUploading]   = useState(false);
    const [photoError,     setPhotoError]       = useState(null);
    const [editSuccess,    setEditSuccess]      = useState(false);
    const [certLoading,    setCertLoading]      = useState(null); // 'MONTHLY' | 'ANNUAL' | null
    const [certError,      setCertError]        = useState(null);

    useEffect(() => {
        usersAPI.getMyProfile()
            .then(res => setProfile(res.data.data))
            .catch(() => {})
            .finally(() => setLoading(false));
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

    const handlePhotoUpload = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (!['image/jpeg', 'image/png'].includes(file.type)) {
            setPhotoError('Only JPEG and PNG images are allowed');
            return;
        }
        if (file.size > 5 * 1024 * 1024) {
            setPhotoError('Image must be smaller than 5MB');
            return;
        }
        setPhotoUploading(true);
        setPhotoError(null);
        try {
            const formData = new FormData();
            formData.append('photo', file);
            await api.patch('/users/me/photo', formData, {
                headers: { 'Content-Type': 'multipart/form-data' },
            });
            reloadProfile();
        } catch (err) {
            setPhotoError(getErrorMessage(err));
        } finally {
            setPhotoUploading(false);
            e.target.value = '';
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
        <div className="max-w-4xl">
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
                            onChange={handlePhotoUpload}
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

            {/* Tabs */}
            <div className="flex gap-2 mb-6">
                {[
                    { key: 'summary',  label: 'Summary',          icon: UserCircleIcon },
                    { key: 'personal', label: 'Personal Info',     icon: PencilIcon },
                    { key: 'password', label: 'Password',          icon: KeyIcon },
                    { key: '2fa',      label: 'Security',          icon: ShieldCheckIcon },
                ].map(tab => (
                    <button
                        key={tab.key}
                        onClick={() => { setActiveTab(tab.key); setEditing(false); }}
                        className={`flex items-center gap-2 px-4 py-2 rounded-lg
                            text-sm font-medium transition-colors ${
                            activeTab === tab.key
                                ? 'bg-primary-700 text-white'
                                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                        }`}
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

                {/* PASSWORD TAB */}
                {activeTab === 'password' && (
                    <>
                        <h3 className="section-title mb-4">Change Password</h3>
                        <ChangePasswordForm />
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
        </div>
    );
};

export default ProfilePage;