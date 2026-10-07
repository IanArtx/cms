// ============================================================
// DRAFT NOTICE (v1.81.0) — the line on a form that says its unfinished
// input was put back, or that it is being kept. Goes with useFormDraft.
//   <DraftNotice draft={draft} />
//   <DraftNotice draft={draft} onStartOver={() => draft.startOver(BLANK)} />
//   money — adds a reminder to check the entry was not already recorded
//   show="restored" | "status" — only that part (e.g. top of a long form /
//   next to its Save button)
// ============================================================

import { ArrowPathIcon, CloudArrowUpIcon, DevicePhoneMobileIcon } from '@heroicons/react/24/outline';

const when = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const sameDay = d.toDateString() === new Date().toDateString();
    return sameDay
        ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : d.toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};

const DraftNotice = ({ draft, onStartOver = null, className = '', show = 'both', money = false }) => {
    if (!draft?.active) return null;
    if (draft.restored && show !== 'status') {
        return (
            <div className={`flex items-start gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900 dark:border-sky-800 dark:bg-sky-900/30 dark:text-sky-100 ${className}`}>
                <ArrowPathIcon className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <p className="flex-1 min-w-0">
                    Picked up where you left off — your unfinished work from {when(draft.restored.savedAt)} was put back.
                    {money && <span className="block text-xs mt-0.5">If the connection dropped just as you submitted, check the list first so it is not recorded twice.</span>}
                </p>
                <button type="button" className="text-xs font-semibold underline flex-shrink-0"
                    onClick={() => (onStartOver ? onStartOver() : draft.startOver())}>
                    Start over
                </button>
            </div>
        );
    }
    if (show === 'restored') return null;
    if (draft.status === 'device') {
        return (
            <p className={`flex items-center gap-1.5 text-xs text-amber-700 ${className}`}>
                <DevicePhoneMobileIcon className="h-4 w-4" /> Kept on this device — it will be saved to your account when the connection is back.
            </p>
        );
    }
    if (draft.status === 'saved' || draft.status === 'saving') {
        return (
            <p className={`flex items-center gap-1.5 text-xs text-gray-400 ${className}`}>
                <CloudArrowUpIcon className="h-4 w-4" /> Draft kept{draft.savedAt ? ` · ${when(draft.savedAt)}` : ''} — you can leave and come back.
            </p>
        );
    }
    return null;
};

export default DraftNotice;
