// ============================================================
// ERROR MESSAGE
// Reusable error display component
// ============================================================

import { ExclamationTriangleIcon, XCircleIcon } from '@heroicons/react/24/outline';

const ErrorMessage = ({ message, type = 'error', onDismiss = null }) => {
    if (!message) return null;

    const styles = {
        error: {
            container: 'bg-red-50 border border-red-200 text-red-800',
            icon:      'text-red-400',
            IconComponent: XCircleIcon,
        },
        warning: {
            container: 'bg-yellow-50 border border-yellow-200 text-yellow-800',
            icon:      'text-yellow-400',
            IconComponent: ExclamationTriangleIcon,
        },
    };

    const style = styles[type] || styles.error;
    const { IconComponent } = style;

    return (
        <div className={`rounded-lg p-4 ${style.container}`}>
            <div className="flex items-start gap-3">
                <IconComponent className={`h-5 w-5 mt-0.5 flex-shrink-0 ${style.icon}`} />
                <div className="flex-1">
                    {Array.isArray(message) ? (
                        <ul className="list-disc list-inside space-y-1 text-sm">
                            {message.map((msg, i) => (
                                <li key={i}>{msg}</li>
                            ))}
                        </ul>
                    ) : (
                        <p className="text-sm">{message}</p>
                    )}
                </div>
                {onDismiss && (
                    <button
                        onClick={onDismiss}
                        className="flex-shrink-0 ml-auto"
                    >
                        <XCircleIcon className={`h-5 w-5 ${style.icon}`} />
                    </button>
                )}
            </div>
        </div>
    );
};

export default ErrorMessage;