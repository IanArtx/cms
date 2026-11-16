// ============================================================
// GROUP-BY SWITCH FOR CHARTS (v1.88.0)
//
// A small Days / Weeks / Months / Years switch shown at the top right of
// every chart over time. The choice is remembered per chart on this
// device (useGrouping), so a chart opens the way it was last looked at.
//
//   const [group, setGroup] = useGrouping('accounts-balance', 'day');
//   <GroupBy value={group} onChange={setGroup} />
//   <GroupBy value={group} onChange={setGroup} options={MONTHLY_ONLY} />
// ============================================================

import { useState } from 'react';
import { GRANULARITIES } from '../../utils/timeGrouping';

export const useGrouping = (key, initial = 'month', allowed = null) => {
    const storageKey = `cms-chart-group:${key}`;
    const [value, setValue] = useState(() => {
        try {
            const v = localStorage.getItem(storageKey);
            if (v && GRANULARITIES.some(g => g.key === v) && (!allowed || allowed.includes(v))) return v;
        } catch { /* storage unavailable */ }
        return initial;
    });
    const set = (v) => {
        setValue(v);
        try { localStorage.setItem(storageKey, v); } catch { /* storage unavailable */ }
    };
    return [value, set];
};

const GroupBy = ({ value, onChange, options = null, className = '' }) => {
    const list = GRANULARITIES.filter(g => !options || options.includes(g.key));
    return (
        <div role="group" aria-label="Group the chart by"
            className={`inline-flex rounded-lg border border-gray-200 dark:border-gray-700 p-0.5 text-[11px] ${className}`}>
            {list.map(g => (
                <button key={g.key} type="button" onClick={() => onChange(g.key)} aria-pressed={value === g.key} title={`Group by ${g.label.toLowerCase()}`}
                    className={`px-2 py-0.5 rounded-md font-medium transition-colors ${value === g.key
                        ? 'bg-primary-600 text-white'
                        : 'text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-100'}`}>
                    <span className="hidden sm:inline">{g.label}</span>
                    <span className="sm:hidden">{g.short}</span>
                </button>
            ))}
        </div>
    );
};

export default GroupBy;
