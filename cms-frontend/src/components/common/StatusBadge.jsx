// ============================================================
// STATUS BADGE
// Displays a coloured pill badge for any status value
// ============================================================

import { getStatusBadgeClass } from '../../utils/helpers';

const StatusBadge = ({ status, label = null }) => {
    if (!status) return null;

    const displayLabel = label || status.replace(/_/g, ' ');

    return (
        <span className={getStatusBadgeClass(status)}>
            {displayLabel}
        </span>
    );
};

export default StatusBadge;