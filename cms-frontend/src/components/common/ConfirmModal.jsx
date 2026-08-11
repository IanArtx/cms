// ============================================================
// CONFIRM MODAL
// Reusable confirmation dialog for destructive actions.
// Used for approvals, rejections, cancellations, etc.
// ============================================================

import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';

const ConfirmModal = ({
    isOpen,
    onClose,
    onConfirm,
    title,
    message,
    confirmLabel = 'Confirm',
    cancelLabel  = 'Cancel',
    type         = 'danger',
    loading      = false,
}) => {
    if (!isOpen) return null;

    const buttonStyles = {
        danger:  'btn-danger',
        primary: 'btn-primary',
        warning: 'bg-yellow-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-yellow-700 transition-colors',
    };

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            {/* Backdrop */}
            <div
                className="fixed inset-0 bg-black bg-opacity-40 transition-opacity"
                onClick={onClose}
            />

            {/* Modal */}
            <div className="flex min-h-full items-center justify-center p-4">
                <div className="relative bg-white rounded-xl shadow-xl max-w-md w-full p-6">
                    {/* Icon */}
                    <div className="flex items-center gap-4 mb-4">
                        <div className="flex-shrink-0 w-12 h-12 rounded-full bg-red-100
                            flex items-center justify-center">
                            <ExclamationTriangleIcon className="h-6 w-6 text-red-600" />
                        </div>
                        <h3 className="text-lg font-semibold text-gray-900">
                            {title}
                        </h3>
                    </div>

                    {/* Message */}
                    <p className="text-sm text-gray-500 mb-6">
                        {message}
                    </p>

                    {/* Actions */}
                    <div className="flex justify-end gap-3">
                        <button
                            onClick={onClose}
                            disabled={loading}
                            className="btn-secondary"
                        >
                            {cancelLabel}
                        </button>
                        <button
                            onClick={onConfirm}
                            disabled={loading}
                            className={buttonStyles[type] || buttonStyles.danger}
                        >
                            {loading ? 'Processing...' : confirmLabel}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default ConfirmModal;