// ============================================================
// LOAN SERVICE
// Shared logic for both loans received and loans given.
//
// HANDLES:
//   - Interest calculation (simple and compound)
//   - Automatic rate switching (fixed to penalty on overdue)
//   - Repayment schedule generation
//   - Daily accrual calculations
// ============================================================

// ============================================================
// CALCULATE DAILY INTEREST RATE
// Converts a periodic rate to a daily rate.
// Example: 12% monthly = 12/30 = 0.4% per day
// ============================================================
const getDailyRate = (periodicRate, period) => {
    const rate = parseFloat(periodicRate) / 100;
    switch (period) {
        case 'DAILY':    return rate;
        case 'WEEKLY':   return rate / 7;
        case 'MONTHLY':  return rate / 30;
        case 'ANNUALLY': return rate / 365;
        default:         return rate / 30;
    }
};

// ============================================================
// CALCULATE SIMPLE INTEREST
// Formula: Principal × Rate × Time
// Used for internal/member loans
// ============================================================
const calculateSimpleInterest = (principal, periodicRate, period, days) => {
    const dailyRate = getDailyRate(periodicRate, period);
    return parseFloat(principal) * dailyRate * days;
};

// ============================================================
// CALCULATE COMPOUND INTEREST
// Formula: Principal × (1 + Rate)^Time - Principal
// Used for external loans where agreed
// ============================================================
const calculateCompoundInterest = (principal, periodicRate, period, days) => {
    const dailyRate = getDailyRate(periodicRate, period);
    return parseFloat(principal) * (Math.pow(1 + dailyRate, days) - 1);
};

// ============================================================
// DETERMINE APPLICABLE RATE
// Returns the correct rate based on whether the loan
// is overdue or not, and whether a rate amendment exists.
// ============================================================
const getApplicableRate = (loan, forDate = new Date()) => {
    const checkDate = new Date(forDate);
    const dueDate   = new Date(loan.due_date);

    const isOverdue = checkDate > dueDate;

    if (isOverdue) {
        // Use the most recent penalty rate amendment if any exist
        // Otherwise use the original penalty rate
        return {
            rate:     parseFloat(loan.current_penalty_rate || loan.penalty_interest_rate),
            rateType: 'PENALTY',
        };
    }

    return {
        rate:     parseFloat(loan.fixed_interest_rate),
        rateType: 'FIXED',
    };
};

// ============================================================
// GENERATE REPAYMENT SCHEDULE
// Creates a full instalment schedule for a loan.
// Called when a loan is approved.
//
// Parameters:
//   principal      — loan amount
//   interestRate   — periodic interest rate
//   period         — DAILY, WEEKLY, MONTHLY, ANNUALLY
//   calculation    — SIMPLE or COMPOUND
//   startDate      — when repayments begin
//   dueDate        — when full repayment is due
//   instalments    — number of instalments
// ============================================================
const generateRepaymentSchedule = (
    principal,
    interestRate,
    period,
    calculation,
    startDate,
    dueDate,
    instalments
) => {
    const schedule = [];
    const principalAmount = parseFloat(principal);
    const rate = parseFloat(interestRate) / 100;

    // Calculate total days
    const start = new Date(startDate);
    const end   = new Date(dueDate);
    const totalDays = Math.ceil((end - start) / (1000 * 60 * 60 * 24));

    // Calculate total interest for the full period
    let totalInterest;
    if (calculation === 'SIMPLE') {
        totalInterest = calculateSimpleInterest(
            principalAmount, interestRate, period, totalDays
        );
    } else {
        totalInterest = calculateCompoundInterest(
            principalAmount, interestRate, period, totalDays
        );
    }

    // Split evenly across instalments
    const principalPerInstalment = principalAmount / instalments;
    const interestPerInstalment  = totalInterest / instalments;

    // Calculate interval between instalments in days
    const intervalDays = Math.ceil(totalDays / instalments);

    for (let i = 1; i <= instalments; i++) {
        const dueDate = new Date(start);
        dueDate.setDate(dueDate.getDate() + (intervalDays * i));

        schedule.push({
            instalment_number: i,
            due_date:          dueDate.toISOString().split('T')[0],
            principal_due:     parseFloat(principalPerInstalment.toFixed(4)),
            interest_due:      parseFloat(interestPerInstalment.toFixed(4)),
            total_due:         parseFloat(
                (principalPerInstalment + interestPerInstalment).toFixed(4)
            ),
        });
    }

    return {
        schedule,
        total_principal: principalAmount,
        total_interest:  parseFloat(totalInterest.toFixed(4)),
        total_payable:   parseFloat((principalAmount + totalInterest).toFixed(4)),
    };
};

// ============================================================
// CALCULATE ACCRUAL FOR A SINGLE DAY
// Called by the daily cron job to accrue interest.
// ============================================================
const calculateDailyAccrual = (loan, accrualDate = new Date()) => {
    const { rate, rateType } = getApplicableRate(loan, accrualDate);
    const principal = parseFloat(loan.outstanding_principal);

    let interestAccrued;
    if (loan.interest_calculation === 'SIMPLE') {
        interestAccrued = calculateSimpleInterest(principal, rate, loan.interest_period, 1);
    } else {
        interestAccrued = calculateCompoundInterest(principal, rate, loan.interest_period, 1);
    }

    return {
        rate_used:        rate,
        rate_type:        rateType,
        principal_balance: principal,
        interest_accrued: parseFloat(interestAccrued.toFixed(4)),
    };
};

// ============================================================
// SPLIT REPAYMENT INTO PORTIONS
// When a repayment is made, split it into:
//   1. Penalty interest (cleared first)
//   2. Accrued interest (cleared second)
//   3. Principal (cleared last)
// This order protects the lender/borrower correctly.
// ============================================================
const splitRepayment = (amount, outstandingPenalty, outstandingInterest, outstandingPrincipal) => {
    let remaining = parseFloat(amount);
    let penaltyPortion   = 0;
    let interestPortion  = 0;
    let principalPortion = 0;

    // Clear penalty first
    if (remaining > 0 && outstandingPenalty > 0) {
        penaltyPortion = Math.min(remaining, outstandingPenalty);
        remaining -= penaltyPortion;
    }

    // Then clear interest
    if (remaining > 0 && outstandingInterest > 0) {
        interestPortion = Math.min(remaining, outstandingInterest);
        remaining -= interestPortion;
    }

    // Remainder goes to principal
    if (remaining > 0) {
        principalPortion = Math.min(remaining, outstandingPrincipal);
    }

    return {
        penalty_portion:   parseFloat(penaltyPortion.toFixed(4)),
        interest_portion:  parseFloat(interestPortion.toFixed(4)),
        principal_portion: parseFloat(principalPortion.toFixed(4)),
        total:             parseFloat(amount),
    };
};

// ============================================================
// CHECK IF LOAN IS OVERDUE
// Returns true if today is past the due date
// ============================================================
const isLoanOverdue = (dueDate) => {
    return new Date() > new Date(dueDate);
};

// ============================================================
// FORMAT LOAN STATUS
// Determines the correct status based on current state
// ============================================================
const determineLoanStatus = (loan) => {
    const outstandingPrincipal = parseFloat(loan.outstanding_principal);
    const outstandingInterest  = parseFloat(loan.outstanding_interest || 0);

    // A loan is only truly paid off once BOTH principal and interest are
    // clear — checking principal alone let a loan sit "partially repaid"
    // forever with a small residual principal (interest kept accruing on
    // that residue every day, so the outstanding balance never actually
    // reached zero even though the borrower believed they'd paid it off).
    // The <= 0.005 tolerance (half a cent) absorbs floating-point noise
    // from repeated subtraction — NUMERIC(20,4) columns round to 4dp on
    // write, but the JS arithmetic before that write can leave tiny
    // residues like 0.0000000002 that would otherwise block this check.
    if (outstandingPrincipal <= 0.005 && outstandingInterest <= 0.005) return 'FULLY_REPAID';
    if (isLoanOverdue(loan.due_date)) return 'OVERDUE';
    if (outstandingPrincipal < parseFloat(loan.principal_amount)) return 'PARTIALLY_REPAID';
    return 'ACTIVE';
};

module.exports = {
    getDailyRate,
    calculateSimpleInterest,
    calculateCompoundInterest,
    getApplicableRate,
    generateRepaymentSchedule,
    calculateDailyAccrual,
    splitRepayment,
    isLoanOverdue,
    determineLoanStatus,
};