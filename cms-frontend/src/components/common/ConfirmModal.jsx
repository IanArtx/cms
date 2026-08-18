// ============================================================
// CONFIRM MODAL
// Generic "are you sure?" dialog — same overlay/panel shell used
// by every other modal in the app, just without a form inside.
// Reused for the sidebar/top-bar Logout confirmation (v1.28.2).
// ============================================================

import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';

const ConfirmModal = ({
    isOpen,
    title,
    message,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    danger = false,
    loading = false,
    onConfirm,
    onCancel,
}) => {
    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            <div className="fixed inset-0 bg-black bg-opacity-40" onClick={onCancel} />
            <div className="flex min-h-full items-center justify-center p-4">
                <div className="relative bg-white rounded-xl shadow-xl max-w-sm w-full p-6">
                    <div className="flex items-start gap-3 mb-2">
                        <div className={`p-2 rounded-lg flex-shrink-0 ${
                            danger ? 'bg-red-50 text-red-600' : 'bg-primary-50 text-primary-700'
                        }`}>
                            <ExclamationTriangleIcon className="h-5 w-5" />
                        </div>
                        <div>
                            <h2 className="text-base font-semibold text-gray-900">{title}</h2>
                            {message && (
                                <p className="text-sm text-gray-500 mt-1">{message}</p>
                            )}
                        </div>
                    </div>
                    <div className="flex justify-end gap-3 mt-5">
                        <button type="button" onClick={onCancel} disabled={loading}
                            className="btn-secondary">
                            {cancelLabel}
                        </button>
                        <button type="button" onClick={onConfirm} disabled={loading}
                            className={danger ? 'btn-danger' : 'btn-primary'}>
                            {loading ? 'Please wait...' : confirmLabel}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default ConfirmModal;
