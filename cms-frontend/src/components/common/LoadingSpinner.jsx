// ============================================================
// LOADING SPINNER
// Reusable loading indicator used across all pages
// ============================================================

const LoadingSpinner = ({ size = 'md', text = null, fullPage = false }) => {
    const sizes = {
        sm: 'h-4 w-4',
        md: 'h-8 w-8',
        lg: 'h-12 w-12',
    };

    const spinner = (
        <div className="flex flex-col items-center justify-center gap-3">
            <div className={`${sizes[size]} animate-spin rounded-full 
                border-4 border-gray-200 border-t-primary-700`} />
            {text && (
                <p className="text-sm text-gray-500">{text}</p>
            )}
        </div>
    );

    if (fullPage) {
        return (
            <div className="fixed inset-0 flex items-center justify-center
                bg-white bg-opacity-75 z-50">
                {spinner}
            </div>
        );
    }

    return spinner;
};

export default LoadingSpinner;