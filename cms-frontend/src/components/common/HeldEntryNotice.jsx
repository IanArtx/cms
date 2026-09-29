// ============================================================
// HELD ENTRY NOTICE (v1.73.0)
// Money entries recorded by anyone who is not the Treasurer or an Admin
// are held until the Treasurer or an Admin approves them. The server
// answers such a save with HTTP 202 and data.held = true; the API
// client (api/axios.js) turns that into a 'cms:money-held' browser
// event, and this notice — mounted once in AppLayout — shows it at the
// bottom of the screen, whatever page the entry was made on, with a
// link to the "Awaiting approval" page. It closes itself after 12 s.
// ============================================================

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ClockIcon, XMarkIcon } from '@heroicons/react/24/outline';

export const HELD_EVENT = 'cms:money-held';

const HeldEntryNotice = () => {
    const [message, setMessage] = useState(null);

    useEffect(() => {
        let timer = null;
        const onHeld = (e) => {
            setMessage(e.detail?.message || 'Sent for approval. No money has moved yet.');
            clearTimeout(timer);
            timer = setTimeout(() => setMessage(null), 12000);
        };
        window.addEventListener(HELD_EVENT, onHeld);
        return () => { window.removeEventListener(HELD_EVENT, onHeld); clearTimeout(timer); };
    }, []);

    if (!message) return null;

    return (
        <div role="status" aria-live="polite"
            className="fixed z-[60] left-4 right-4 bottom-24 md:bottom-6 md:left-auto md:right-6 md:max-w-md
                       rounded-xl border border-violet-200 bg-violet-50 shadow-lg p-4 flex gap-3 items-start">
            <ClockIcon className="h-6 w-6 text-violet-600 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-violet-900 flex-1">
                <p className="font-semibold">Waiting for approval</p>
                <p className="mt-0.5">{message}</p>
                <Link to="/money-approvals" onClick={() => setMessage(null)}
                    className="inline-block mt-2 font-medium text-violet-700 underline">
                    See entries awaiting approval
                </Link>
            </div>
            <button onClick={() => setMessage(null)} aria-label="Close"
                className="p-1 rounded hover:bg-violet-100 text-violet-700">
                <XMarkIcon className="h-5 w-5" />
            </button>
        </div>
    );
};

export default HeldEntryNotice;
