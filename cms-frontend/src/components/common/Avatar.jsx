// ============================================================
// AVATAR
// Shared avatar display used everywhere a user's picture appears
// (top bar, sidebar, Users list, Profile page).
//
// Display priority:
//   1. A real uploaded photo (user.photo_path)          -> <img>
//   2. A chosen illustrated avatar (user.avatar_choice)  -> inline SVG
//   3. Initials                                          -> existing fallback
//
// No external image files are used for the illustrated set — every
// avatar is a small inline SVG built from basic shapes (circles /
// ellipses only, no hand-drawn paths), so there is nothing to
// upload, host, or link to.
// ============================================================

import { useState } from 'react';
import { getInitials, getPhotoUrl } from '../../utils/helpers';

// ------------------------------------------------------------
// The built-in illustrated avatar set.
// 'style' controls the hair silhouette drawn on top of a plain
// head+shoulders bust:
//   'short'  — a small cap of "hair" across the top of the head
//   'long'   — the short cap PLUS hair framing both sides down to
//              the shoulders
//   'bald'   — no extra hair shapes, just the plain bust
// ------------------------------------------------------------
export const AVATAR_OPTIONS = [
    { id: 'male-1',    gender: 'MALE',   bg: '#DBEAFE', fg: '#1E40AF', style: 'short' },
    { id: 'male-2',    gender: 'MALE',   bg: '#DCFCE7', fg: '#166534', style: 'short' },
    { id: 'male-3',    gender: 'MALE',   bg: '#FEF3C7', fg: '#92400E', style: 'short' },
    { id: 'female-1',  gender: 'FEMALE', bg: '#FCE7F3', fg: '#9D174D', style: 'long'  },
    { id: 'female-2',  gender: 'FEMALE', bg: '#EDE9FE', fg: '#5B21B6', style: 'long'  },
    { id: 'female-3',  gender: 'FEMALE', bg: '#FFE4E6', fg: '#9F1239', style: 'long'  },
    { id: 'neutral-1', gender: 'OTHER',  bg: '#E0E7FF', fg: '#3730A3', style: 'bald'  },
    { id: 'neutral-2', gender: 'OTHER',  bg: '#F1F5F9', fg: '#334155', style: 'bald'  },
];

export const getAvatarOption = (id) => AVATAR_OPTIONS.find(o => o.id === id) || null;

// ------------------------------------------------------------
// Renders a single illustrated avatar as an inline SVG.
// ------------------------------------------------------------
export const IllustratedAvatar = ({ optionId, size = 40, className = '' }) => {
    const option = getAvatarOption(optionId);
    if (!option) return null;
    const { bg, fg, style } = option;

    return (
        <svg
            width={size} height={size} viewBox="0 0 100 100"
            className={`rounded-full flex-shrink-0 ${className}`}
        >
            <clipPath id={`clip-${optionId}`}>
                <circle cx="50" cy="50" r="50" />
            </clipPath>
            <g clipPath={`url(#clip-${optionId})`}>
                <circle cx="50" cy="50" r="50" fill={bg} />
                {/* shoulders */}
                <ellipse cx="50" cy="98" rx="32" ry="26" fill={fg} />
                {/* head */}
                <circle cx="50" cy="40" r="18" fill={fg} />
                {/* hair */}
                {(style === 'short' || style === 'long') && (
                    <ellipse cx="50" cy="29" rx="19" ry="10" fill={fg} />
                )}
                {style === 'long' && (
                    <>
                        <ellipse cx="31" cy="48" rx="8" ry="20" fill={fg} />
                        <ellipse cx="69" cy="48" rx="8" ry="20" fill={fg} />
                    </>
                )}
            </g>
        </svg>
    );
};

// ------------------------------------------------------------
// Main Avatar component — pass the user object (needs first_name,
// last_name, photo_path, avatar_choice).
// ------------------------------------------------------------
const Avatar = ({ user, size = 40, className = '' }) => {
    const [photoFailed, setPhotoFailed] = useState(false);
    const photoUrl = !photoFailed ? getPhotoUrl(user?.photo_path) : null;

    if (photoUrl) {
        return (
            <img
                src={photoUrl}
                alt={`${user?.first_name || ''} ${user?.last_name || ''}`.trim() || 'User'}
                width={size} height={size}
                className={`rounded-full object-cover flex-shrink-0 ${className}`}
                onError={() => setPhotoFailed(true)}
            />
        );
    }

    if (user?.avatar_choice && getAvatarOption(user.avatar_choice)) {
        return <IllustratedAvatar optionId={user.avatar_choice} size={size} className={className} />;
    }

    // Initials fallback — matches the look previously used everywhere.
    return (
        <div
            className={`rounded-full bg-primary-100 text-primary-700 flex items-center justify-center font-semibold flex-shrink-0 ${className}`}
            style={{ width: size, height: size, fontSize: Math.max(11, size * 0.4) }}
        >
            {getInitials(user?.first_name, user?.last_name)}
        </div>
    );
};

export default Avatar;
