// ============================================================
// PASSWORD RULES (v1.75.0)
// A live checklist under a "new password" box, so a member sees
// exactly what is still missing while typing instead of finding
// out after pressing the button. The same four rules are checked
// by the server (services/accountSecurityService.js → passwordProblems
// and the validators in routes/auth.js) — keep the two in step.
// ============================================================

import { useState } from 'react';
import { CheckCircleIcon, EyeIcon, EyeSlashIcon } from '@heroicons/react/24/outline';

export const PASSWORD_RULES = [
    { key: 'len',     label: 'At least 8 characters',          test: p => p.length >= 8 },
    { key: 'upper',   label: 'An uppercase letter (A–Z)',       test: p => /[A-Z]/.test(p) },
    { key: 'number',  label: 'A number (0–9)',                  test: p => /[0-9]/.test(p) },
    { key: 'special', label: 'A special character (e.g. # ! @)', test: p => /[^A-Za-z0-9]/.test(p) },
];

export const passwordMeetsRules = (p) => PASSWORD_RULES.every(r => r.test(p || ''));

const PasswordRules = ({ password = '', confirm, showMatch = false }) => (
    <ul className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs">
        {PASSWORD_RULES.map(r => {
            const ok = r.test(password);
            return (
                <li key={r.key} className={`flex items-center gap-1.5 ${ok ? 'text-green-700' : 'text-gray-500'}`}>
                    {ok
                        ? <CheckCircleIcon className="h-4 w-4 flex-shrink-0" />
                        : <span className="h-4 w-4 flex-shrink-0 inline-flex items-center justify-center">
                              <span className="h-2 w-2 rounded-full border border-gray-400" />
                          </span>}
                    {r.label}
                </li>
            );
        })}
        {showMatch && (
            <li className={`flex items-center gap-1.5 ${confirm && confirm === password ? 'text-green-700' : 'text-gray-500'}`}>
                {confirm && confirm === password
                    ? <CheckCircleIcon className="h-4 w-4 flex-shrink-0" />
                    : <span className="h-4 w-4 flex-shrink-0 inline-flex items-center justify-center">
                          <span className="h-2 w-2 rounded-full border border-gray-400" />
                      </span>}
                Both new passwords match
            </li>
        )}
    </ul>
);

// A password box with a show/hide eye button.
export const PasswordInput = ({ value, onChange, autoComplete, placeholder, required = true, id }) => {
    const [show, setShow] = useState(false);
    return (
        <div className="relative">
            <input
                id={id}
                type={show ? 'text' : 'password'}
                className="input pr-10"
                value={value}
                onChange={onChange}
                autoComplete={autoComplete}
                placeholder={placeholder}
                required={required}
            />
            <button
                type="button"
                onClick={() => setShow(s => !s)}
                className="absolute inset-y-0 right-0 px-3 flex items-center text-gray-400 hover:text-gray-600"
                aria-label={show ? 'Hide password' : 'Show password'}
                title={show ? 'Hide password' : 'Show password'}
                tabIndex={-1}
            >
                {show ? <EyeSlashIcon className="h-5 w-5" /> : <EyeIcon className="h-5 w-5" />}
            </button>
        </div>
    );
};

export default PasswordRules;
