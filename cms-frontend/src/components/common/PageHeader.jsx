// ============================================================
// PAGE HEADER
// Consistent header used at the top of every page.
// Shows the page title, optional subtitle, and action buttons.
// ============================================================

const PageHeader = ({ title, subtitle = null, actions = null }) => {
    return (
        <div className="flex items-start justify-between mb-6">
            <div>
                <h1 className="page-title">{title}</h1>
                {subtitle && (
                    <p className="mt-1 text-sm text-gray-500">{subtitle}</p>
                )}
            </div>
            {actions && (
                <div className="flex items-center gap-3 ml-4">
                    {actions}
                </div>
            )}
        </div>
    );
};

export default PageHeader;