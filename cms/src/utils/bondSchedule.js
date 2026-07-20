// ============================================================
// BOND COUPON SCHEDULE GENERATOR
//
// Given a bond's face value, annual coupon (interest) rate, payment
// frequency, tax withholding rate, issue date and maturity date, this
// builds the full list of expected coupon (interest) payments — one
// row per payment date, from just after issue through to maturity.
//
// Each row carries three amounts:
//   gross_amount — interest earned before tax
//   tax_amount   — withholding tax deducted (gross_amount * tax rate)
//   net_amount   — what actually gets paid/received (gross - tax)
//
// This is pure math with no database access, so it's easy to unit
// test on its own (see the sandbox verification notes in the CMS
// project bible).
// ============================================================

const FREQUENCY_MONTHS = {
    MONTHLY:       1,
    QUARTERLY:     3,
    SEMI_ANNUALLY: 6,
    ANNUALLY:      12,
};

function round2(n) {
    return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Adds `months` calendar months to an ISO date string, returns a
// new Date. Using UTC throughout avoids local-timezone off-by-one
// bugs on date-only values.
function addMonthsUTC(isoDate, months) {
    const d = new Date(`${isoDate}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + months);
    return d;
}

function toISODate(date) {
    return date.toISOString().slice(0, 10);
}

/**
 * @param {object} params
 * @param {number|string} params.faceValue        bond principal
 * @param {number|string} params.couponRate        annual %, e.g. 12.5
 * @param {string}        params.frequency         MONTHLY | QUARTERLY | SEMI_ANNUALLY | ANNUALLY | AT_MATURITY
 * @param {number|string} params.taxWithholdingRate withholding tax %, e.g. 15
 * @param {string}        params.issueDate          ISO date (YYYY-MM-DD)
 * @param {string}        params.maturityDate       ISO date (YYYY-MM-DD)
 * @param {string}        [params.firstCouponDate]  ISO date (YYYY-MM-DD) — optional.
 *   For a bond bought partway through its life (already running when the
 *   company acquired it), the next coupon date is fixed by the issuer's
 *   own schedule and won't generally fall exactly `frequency` after our
 *   issue/purchase date. When supplied, the schedule is anchored on this
 *   date instead of computing the first due date from issueDate.
 * @returns {Array<{coupon_number:number, due_date:string, gross_amount:number, tax_amount:number, net_amount:number}>}
 */
function generateBondCouponSchedule({
    faceValue,
    couponRate,
    frequency,
    taxWithholdingRate,
    issueDate,
    maturityDate,
    firstCouponDate = null,
}) {
    const fv       = parseFloat(faceValue);
    const rate     = parseFloat(couponRate) / 100;
    const taxRate  = parseFloat(taxWithholdingRate || 0) / 100;
    const issue    = new Date(`${issueDate}T00:00:00Z`);
    const maturity = new Date(`${maturityDate}T00:00:00Z`);

    if (maturity <= issue) {
        throw new Error('Maturity date must be after issue date');
    }

    const coupons = [];

    // A single lump-sum interest payment at maturity — common for
    // zero-coupon-style / short-term bonds. Interest accrues on a
    // simple (not compounding) basis for the full term.
    if (frequency === 'AT_MATURITY') {
        const years = (maturity - issue) / (1000 * 60 * 60 * 24 * 365.25);
        const gross = round2(fv * rate * years);
        const tax   = round2(gross * taxRate);
        coupons.push({
            coupon_number: 1,
            due_date:      maturityDate,
            gross_amount:  gross,
            tax_amount:    tax,
            net_amount:    round2(gross - tax),
        });
        return coupons;
    }

    const months          = FREQUENCY_MONTHS[frequency];
    if (!months) {
        throw new Error(`Unknown coupon frequency: ${frequency}`);
    }
    const paymentsPerYear  = 12 / months;
    const periodicGross    = round2(fv * rate / paymentsPerYear);
    const periodicTax      = round2(periodicGross * taxRate);
    const periodicNet      = round2(periodicGross - periodicTax);

    // Anchor date for the first coupon: either the explicit first-coupon
    // date supplied (bond already running when bought) or the usual
    // issue-date-plus-one-period (bond bought at/near issuance).
    const anchorDate = firstCouponDate || toISODate(addMonthsUTC(issueDate, months));

    let couponNumber = 1;
    let dueDate = new Date(`${anchorDate}T00:00:00Z`);

    // Regular coupons — every `months` from the anchor date, up to (not
    // including) the maturity date itself. Each due date is recomputed
    // fresh from the anchor (not by repeatedly adding to the previous
    // one) to avoid calendar drift over a long schedule.
    while (dueDate < maturity) {
        coupons.push({
            coupon_number: couponNumber,
            due_date:      toISODate(dueDate),
            gross_amount:  periodicGross,
            tax_amount:    periodicTax,
            net_amount:    periodicNet,
        });
        couponNumber += 1;
        dueDate = addMonthsUTC(anchorDate, months * (couponNumber - 1));
    }

    // Final coupon always lands exactly on the maturity date, even
    // if that makes the last period shorter or longer than a full
    // interval (common when dates don't divide evenly).
    coupons.push({
        coupon_number: couponNumber,
        due_date:      maturityDate,
        gross_amount:  periodicGross,
        tax_amount:    periodicTax,
        net_amount:    periodicNet,
    });

    return coupons;
}

module.exports = { generateBondCouponSchedule };
