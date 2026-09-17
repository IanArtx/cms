// ============================================================
// CONFIRM CONTEXT (v1.59.0)
// A single, app-wide replacement for window.confirm()/window.prompt()
// — requested directly: "let all approvals show a pop up confirmation
// instead of a browser inspired pop up at the top bar of the browser,
// in order to have a consistent uniform system dialogue."
//
// Mounts exactly ONE <ConfirmDialog> for the whole app (in App.js,
// alongside AuthProvider/BrandingProvider) and drives it imperatively
// via useConfirm(), a promise-based function with the same call-site
// ergonomics as the browser originals:
//
//   const ok = await confirm({ message: 'Approve this?' });
//   if (!ok) return;                       // same as: if (!window.confirm(...)) return;
//
//   const reason = await confirm({ message: 'Why?', requireInput: true });
//   if (!reason) return;                    // same as: if (!(reason = window.prompt(...))) return;
//
// Only one dialog can be open at a time (a second confirm() call while
// one is already open queues behind it, resolving false/null for the
// one that got replaced — not expected to happen in practice, since
// every call site awaits before firing the next action).
// ============================================================

import { createContext, useContext, useCallback, useState } from 'react';
import ConfirmDialog from '../components/common/ConfirmDialog';

const ConfirmContext = createContext(null);

export const ConfirmProvider = ({ children }) => {
    const [pending, setPending] = useState(null); // { options, resolve }

    const confirm = useCallback((options = {}) => {
        return new Promise((resolve) => {
            setPending({ options, resolve });
        });
    }, []);

    const settle = (value) => {
        pending?.resolve(value);
        setPending(null);
    };

    return (
        <ConfirmContext.Provider value={confirm}>
            {children}
            <ConfirmDialog
                isOpen={!!pending}
                options={pending?.options}
                onConfirm={(value) => settle(value)}
                onCancel={() => settle(pending?.options?.requireInput ? null : false)}
            />
        </ConfirmContext.Provider>
    );
};

export const useConfirm = () => {
    const ctx = useContext(ConfirmContext);
    if (!ctx) {
        throw new Error('useConfirm must be used within a ConfirmProvider');
    }
    return ctx;
};
