// ============================================================
// Drafts kept on this device (v1.81.0) — see hooks/useFormDraft.js.
// Keys: "cms-draft:<userId>:<form key>".
// ============================================================

export const DRAFT_PREFIX = 'cms-draft:';

// Remove every draft of this person kept on this device (own sign-out).
export const clearDeviceDrafts = (userId) => {
    try {
        const prefix = `${DRAFT_PREFIX}${userId}:`;
        Object.keys(localStorage).filter(k => k.startsWith(prefix)).forEach(k => localStorage.removeItem(k));
    } catch (_) { /* ignore */ }
};
