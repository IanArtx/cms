// ============================================================
// TRANSFER RATE CHECK (v1.83.0)
// Shown on the transfer form under the exchange rate. It compares the
// bank's rate (what the books use) with the rate on file for the value
// date — the approved Bank of Uganda rate, or one entered by hand — and
// says, in plain words, how much more or less the receiving account gets
// than at that rate. That difference is booked as a REALISED exchange
// gain or loss when the transfer is approved.
//
// When the gap is bigger than the warning limit (Settings › Currencies,
// 3 % unless changed) the person must tick "I have checked the bank's
// rate" before saving — the server refuses it otherwise. It catches a
// typing slip or a rate entered the wrong way round; a real bank rate
// that is simply poor can still be saved once checked.
//
//   <TransferRateCheck fromCode="EUR" toCode="UGX" rate={…} amountSent={…}
//       date="2026-10-14" confirmed={bool} onConfirmedChange={fn}
//       onNeedsConfirm={fn(bool)} />
// ============================================================

import { useEffect, useState } from 'react';
import { ExclamationTriangleIcon, ScaleIcon } from '@heroicons/react/24/outline';
import { exchangeRatesAPI } from '../../api/endpoints';

const n = (v, digits = 2) => Number(v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: digits });
const rateText = (r) => (r >= 1 ? n(r, 4) : n(r, 8));

export const sourceText = (ref) => {
    if (!ref) return '';
    if (ref.source === 'BOU') return `Bank of Uganda${ref.setByName ? `, approved by ${ref.setByName}` : ''}`;
    if (ref.source === 'ALLRATESTODAY') return `BoU table via AllRatesToday${ref.setByName ? `, approved by ${ref.setByName}` : ''}`;
    return `entered by hand${ref.setByName ? ` by ${ref.setByName}` : ''}`;
};

const TransferRateCheck = ({ fromCode, toCode, rate, amountSent, date, confirmed, onConfirmedChange, onNeedsConfirm }) => {
    const [ref, setRef] = useState(null);
    const [loading, setLoading] = useState(false);
    const day = date || new Date().toISOString().slice(0, 10);

    useEffect(() => {
        if (!fromCode || !toCode || fromCode === toCode) { setRef(null); return undefined; }
        let alive = true;
        setLoading(true);
        const t = setTimeout(() => {
            exchangeRatesAPI.getReference({ from: fromCode, to: toCode, date: day })
                .then(r => { if (alive) setRef(r.data.data); })
                .catch(() => { if (alive) setRef(null); })
                .finally(() => { if (alive) setLoading(false); });
        }, 250);
        return () => { alive = false; clearTimeout(t); };
    }, [fromCode, toCode, day]);

    const bank = parseFloat(rate);
    const hasRef = !!(ref && ref.rate);
    const gapPct = hasRef && bank > 0 ? ((bank - ref.rate) / ref.rate) * 100 : null;
    const warnPct = ref?.warnPct ?? 3;
    const needsConfirm = gapPct !== null && Math.abs(gapPct) > warnPct;
    const sent = parseFloat(amountSent) || 0;
    const diff = gapPct !== null ? sent * (bank - ref.rate) : null;

    useEffect(() => { if (onNeedsConfirm) onNeedsConfirm(needsConfirm); }, [needsConfirm]); // eslint-disable-line react-hooks/exhaustive-deps

    if (!fromCode || !toCode || fromCode === toCode) return null;
    if (loading && !ref) return <p className="text-xs text-gray-400">Looking up the rate on file for {day}…</p>;
    if (!hasRef) {
        return (
            <p className="text-xs text-gray-500 rounded-lg bg-gray-50 dark:bg-gray-800 px-3 py-2">
                No {fromCode}/{toCode} rate is on file for {day}, so the bank's rate can't be compared.
                The transfer still uses the bank's rate; set the day's rate under Accounts when you can.
            </p>
        );
    }

    return (
        <div className={`rounded-lg border px-3 py-2 text-sm ${needsConfirm
            ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-100'
            : 'border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200'}`}
            data-testid="transfer-rate-check">
            <p className="flex items-start gap-2">
                <ScaleIcon className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <span>
                    Rate on file for {day}: <strong>1 {fromCode} = {rateText(ref.rate)} {toCode}</strong>
                    {ref.rate < 1 && <> (1 {toCode} = {n(1 / ref.rate, 2)} {fromCode})</>}
                    <span className="block text-xs opacity-80">Source: {sourceText(ref)}{ref.effectiveFrom ? `, since ${ref.effectiveFrom}` : ''}.</span>
                </span>
            </p>
            {gapPct !== null && (
                <p className="mt-1.5 text-xs">
                    The bank's rate is <strong>{Math.abs(gapPct) < 0.005 ? 'the same as' : `${n(Math.abs(gapPct), 2)} % ${gapPct < 0 ? 'below' : 'above'}`}</strong> that rate
                    {sent > 0 && Math.abs(diff) >= 0.01 && (
                        <> — the receiving account gets about <strong>{toCode} {n(Math.abs(diff), 2)} {diff < 0 ? 'less' : 'more'}</strong> than
                        at the rate on file. On approval this is booked as a realised exchange {diff < 0 ? 'loss' : 'gain'}.</>
                    )}
                    {!(sent > 0 && Math.abs(diff) >= 0.01) && '.'}
                </p>
            )}
            {needsConfirm && (
                <div className="mt-2">
                    <p className="flex items-start gap-1.5 text-xs font-medium">
                        <ExclamationTriangleIcon className="h-4 w-4 flex-shrink-0" />
                        More than the {n(warnPct, 2)} % warning limit. Check the bank's figure — and that it is
                        "{toCode} per 1 {fromCode}", not the other way round.
                    </p>
                    <label className="mt-1.5 flex items-center gap-2 text-sm font-medium">
                        <input type="checkbox" checked={!!confirmed} onChange={e => onConfirmedChange(e.target.checked)} />
                        I have checked the bank's rate
                    </label>
                </div>
            )}
        </div>
    );
};

export default TransferRateCheck;
