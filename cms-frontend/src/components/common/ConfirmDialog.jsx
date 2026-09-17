// ============================================================
// CONFIRM DIALOG (v1.59.0)
// The in-app modal every window.confirm()/window.prompt() call was
// replaced with — requested directly: "let all approvals show a pop
// up confirmation instead of a browser inspired pop up at the top bar
// of the browser, in order to have a consistent uniform system
// dialogue." Purely presentational — ConfirmContext.jsx renders
// exactly one instance of this and drives it imperatively via the
// useConfirm() hook, so every page shares the same dialog rather than
// each building its own.
// ============================================================

import { useState, useEffect } from 'react';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';

const ConfirmDialog = ({ isOpen, options, onConfirm, onCancel }) => {
    const {
        title = 'Confirm',
        message = '',
        confirmLabel = 'Confirm',
        cancelLabel = 'Cancel',
        danger = false,
        requireInput = false,
        inputLabel = 'Reason',
        inputPlaceholder = '',
    } = options || {};

    const [value, setValue] = useState('');

    useEffect(() => {
        if (isOpen) setValue('');
    }, [isOpen]);

    if (!isOpen) return null;

    const canSubmit = !requireInput || value.trim().length > 0;

    const handleConfirm = () => {
        if (!canSubmit) return;
        onConfirm(requireInput ? value.trim() : true);
    };

    return (
        <div className="fixed inset-0 z-[60] overflow-y-auto">
            <div className="fixed inset-0 bg-black bg-opacity-40" onClick={onCancel} />
            <div className="flex min-h-full items-center justify-center p-4">
                <div className="relative bg-white rounded-xl shadow-xl max-w-md w-full p-6">
                    <div className="flex items-start gap-3 mb-4">
                        {danger && (
                            <ExclamationTriangleIcon className="h-6 w-6 text-red-500 flex-shrink-0 mt-0.5" />
                        )}
                        <div>
                            <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
                            {message && <p className="text-sm text-gray-500 mt-1">{message}</p>}
                        </div>
                    </div>

                    {requireInput && (
                        <div className="mb-4">
                            <label className="label">{inputLabel}</label>
                            <textarea
                                className="input"
                                rows={3}
                                autoFocus
                                value={value}
                                onChange={e => setValue(e.target.value)}
                                placeholder={inputPlaceholder}
                                onKeyDown={e => {
                                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleConfirm();
                                }}
                            />
                        </div>
                    )}

                    <div className="flex justify-end gap-3 pt-2">
                        <button type="button" onClick={onCancel} className="btn-secondary">
                            {cancelLabel}
                        </button>
                        <button
                            type="button"
                            onClick={handleConfirm}
                            disabled={!canSubmit}
                            className={danger ? 'btn-danger' : 'btn-primary'}
                        >
                            {confirmLabel}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default ConfirmDialog;
