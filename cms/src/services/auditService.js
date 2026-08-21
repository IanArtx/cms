// ============================================================
// AUDIT LOG SERVICE
// Every significant action in the system is permanently
// recorded here. This is append-only — nothing is ever
// updated or deleted from this table.
//
// Audit logs are written even when the main action fails,
// so we have a record of attempted actions too.
// ============================================================

const { query } = require('../config/database');
const logger = require('../config/logger');

// ============================================================
// LOG ACTION
// Call this after (or during) any significant system action.
//
// Parameters:
//   userId      — who performed the action (null = system/cron)
//   action      — short code e.g. 'USER_LOGIN', 'TRANSACTION_CREATE'
//   module      — e.g. 'AUTH', 'FINANCE', 'DOCUMENTS', 'EVENTS'
//   options     — {
//       sessionId,    — JWT session ID
//       ipAddress,    — request IP
//       recordType,   — table affected e.g. 'transactions'
//       recordId,     — ID of the record affected
//       oldValues,    — snapshot before change (object)
//       newValues,    — snapshot after change (object)
//       description,  — human-readable description
//       status,       — 'SUCCESS' | 'FAILURE' | 'WARNING'
//       client,       — pg transaction client (if inside a transaction)
//   }
// ============================================================
const logAction = async (userId, action, module, options = {}) => {
    const {
        sessionId   = null,
        ipAddress   = null,
        recordType  = null,
        recordId    = null,
        oldValues   = null,
        newValues   = null,
        description = null,
        status      = 'SUCCESS',
        client      = null,      // if provided, runs in the same transaction
    } = options;

    const sql = `
        INSERT INTO audit_log
            (user_id, session_id, ip_address, action, module,
             record_type, record_id, old_values, new_values, description, status)
        VALUES ($1, $2, $3::inet, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING id
    `;

    const params = [
        userId,
        sessionId,
        ipAddress,
        action,
        module,
        recordType,
        recordId,
        oldValues  ? JSON.stringify(oldValues)  : null,
        newValues  ? JSON.stringify(newValues)  : null,
        description,
        status,
    ];

    try {
        // Use the provided transaction client, or fall back to the pool
        const result = client
            ? await client.query(sql, params)
            : await query(sql, params);
        return result.rows[0].id;
    } catch (err) {
        // Audit logging must NEVER crash the app
        // If it fails, log to file/console and continue
        logger.error('Audit log write failed', {
            action,
            module,
            userId,
            error: err.message,
        });
        return null;
    }
};

// ============================================================
// EXTRACT REQUEST CONTEXT
// Pulls session and IP info from an Express request object
// to attach to audit log entries automatically via middleware.
// ============================================================
const extractRequestContext = (req) => ({
    sessionId: req.user?.sessionId || null,
    ipAddress: req.ip || req.connection?.remoteAddress || null,
});

// ============================================================
// COMMON ACTION CODES
// Centralised constants to prevent typos across the codebase.
// ============================================================
const ACTIONS = {
    // Auth
    USER_REGISTER:          'USER_REGISTER',
    USER_LOGIN:             'USER_LOGIN',
    USER_LOGOUT:            'USER_LOGOUT',
    USER_LOGIN_FAILED:      'USER_LOGIN_FAILED',
    USER_2FA_ENABLED:       'USER_2FA_ENABLED',
    USER_2FA_VERIFIED:      'USER_2FA_VERIFIED',
    USER_PASSWORD_RESET:    'USER_PASSWORD_RESET',
    USER_EMAIL_VERIFIED:    'USER_EMAIL_VERIFIED',
    // Users & Roles
    USER_PROFILE_UPDATED:   'USER_PROFILE_UPDATED',
    USER_DEACTIVATED:       'USER_DEACTIVATED',
    ROLE_ASSIGNED:          'ROLE_ASSIGNED',
    ROLE_REVOKED:           'ROLE_REVOKED',
    ROLE_REQUESTED:         'ROLE_REQUESTED',
    ROLE_REQUEST_REVIEWED:  'ROLE_REQUEST_REVIEWED',
    // Finance
    TRANSACTION_CREATED:    'TRANSACTION_CREATED',
    TRANSACTION_APPROVED:   'TRANSACTION_APPROVED',
    TRANSACTION_REJECTED:   'TRANSACTION_REJECTED',
    TRANSACTION_REVERSED:   'TRANSACTION_REVERSED',
    TRANSFER_CREATED:       'TRANSFER_CREATED',
    TRANSFER_UPDATED:       'TRANSFER_UPDATED',
    TRANSFER_APPROVED:      'TRANSFER_APPROVED',
    TRANSFER_REJECTED:      'TRANSFER_REJECTED',
    FLOOR_LIMIT_UPDATED:    'FLOOR_LIMIT_UPDATED',
    CONTRIBUTION_CREATED:   'CONTRIBUTION_CREATED',
    CONTRIBUTION_APPROVED:  'CONTRIBUTION_APPROVED',
    // Grants
    GRANT_CREATED:          'GRANT_CREATED',
    GRANT_UPDATED:          'GRANT_UPDATED',
    GRANT_APPROVED:         'GRANT_APPROVED',
    GRANT_TRANCHE_RECORDED: 'GRANT_TRANCHE_RECORDED',
    GRANT_CONDITION_MET:    'GRANT_CONDITION_MET',
    GRANT_CONDITION_WAIVED: 'GRANT_CONDITION_WAIVED',
    // Loans
    LOAN_RECEIVED_CREATED:  'LOAN_RECEIVED_CREATED',
    LOAN_RECEIVED_UPDATED:  'LOAN_RECEIVED_UPDATED',
    LOAN_RECEIVED_APPROVED: 'LOAN_RECEIVED_APPROVED',
    LOAN_REPAYMENT_MADE:    'LOAN_REPAYMENT_MADE',
    LOAN_RATE_AMENDED:      'LOAN_RATE_AMENDED',
    LOAN_GIVEN_CREATED:     'LOAN_GIVEN_CREATED',
    LOAN_GIVEN_UPDATED:     'LOAN_GIVEN_UPDATED',
    LOAN_GIVEN_APPROVED:    'LOAN_GIVEN_APPROVED',
    LOAN_REPAYMENT_RECEIVED:'LOAN_REPAYMENT_RECEIVED',
    // Investments
    INVESTMENT_CREATED:     'INVESTMENT_CREATED',
    INVESTMENT_UPDATED:     'INVESTMENT_UPDATED',
    INVESTMENT_APPROVED:    'INVESTMENT_APPROVED',
    INVESTMENT_RETURN:      'INVESTMENT_RETURN',
    PROJECT_CREATED:        'PROJECT_CREATED',
    MILESTONE_UPDATED:      'MILESTONE_UPDATED',
    // Money Market Fund sub-accounts (v1.28.0)
    MMF_ACCOUNT_CREATED:    'MMF_ACCOUNT_CREATED',
    MMF_ACCOUNT_CLOSED:     'MMF_ACCOUNT_CLOSED',
    MMF_TOPUP:              'MMF_TOPUP',
    MMF_WITHDRAWAL:         'MMF_WITHDRAWAL',
    MMF_INTEREST_RECORDED:  'MMF_INTEREST_RECORDED',
    MMF_FEE_RECORDED:       'MMF_FEE_RECORDED',
    // Capital Goals (v1.29.0)
    CAPITAL_GOAL_CREATED:   'CAPITAL_GOAL_CREATED',
    CAPITAL_GOAL_UPDATED:   'CAPITAL_GOAL_UPDATED',
    CAPITAL_GOAL_CANCELLED: 'CAPITAL_GOAL_CANCELLED',
    // Events
    EVENT_CREATED:          'EVENT_CREATED',
    EVENT_UPDATED:          'EVENT_UPDATED',
    EVENT_APPROVED:         'EVENT_APPROVED',
    EVENT_CANCELLED:        'EVENT_CANCELLED',
    EVENT_EXTENDED:         'EVENT_EXTENDED',
    EVENT_COMPLETED:        'EVENT_COMPLETED',
    EVENT_NOTIFICATION_SENT:'EVENT_NOTIFICATION_SENT',
    // Documents
    DOCUMENT_UPLOADED:      'DOCUMENT_UPLOADED',
    DOCUMENT_GENERATED:     'DOCUMENT_GENERATED',
    DOCUMENT_APPROVED:      'DOCUMENT_APPROVED',
    DOCUMENT_ARCHIVED:      'DOCUMENT_ARCHIVED',
    // Reports
    REPORT_GENERATED:       'REPORT_GENERATED',
    REPORT_SENT:            'REPORT_SENT',
    // System
    CATEGORY_CREATED:       'CATEGORY_CREATED',
    ROLE_CREATED:           'ROLE_CREATED',
    PERMISSION_GRANTED:     'PERMISSION_GRANTED',
    SYSTEM_CONFIG_CHANGED:  'SYSTEM_CONFIG_CHANGED',
    CERTIFICATE_ISSUED:     'CERTIFICATE_ISSUED',
    // DIVIDENDS AND AUTHORITY PAYMENTS
    DIVIDEND_DECLARED:      'DIVIDEND_DECLARED',
    DIVIDEND_UPDATED:       'DIVIDEND_UPDATED',
    DIVIDEND_PAID:          'DIVIDEND_PAID',
    AUTHORITY_PAYMENT_MADE: 'AUTHORITY_PAYMENT_MADE',
    // SAVINGS
    SAVINGS_CREATED:            'SAVINGS_CREATED',
    SAVINGS_WITHDRAWN:          'SAVINGS_WITHDRAWN',
    SAVINGS_DEPOSIT_APPROVED:   'SAVINGS_DEPOSIT_APPROVED',
    SAVINGS_DEPOSIT_REJECTED:   'SAVINGS_DEPOSIT_REJECTED',
    SAVINGS_CONTRIBUTION_CREDITED: 'SAVINGS_CONTRIBUTION_CREDITED', // v1.31.0 — savings portion sliced out of a Record Contribution, credited directly (no approval step — Treasurer already has authority)
    SAVINGS_HANDOUT_ENTERED:    'SAVINGS_HANDOUT_ENTERED',
    SAVINGS_HANDOUT_CONFIRMED:  'SAVINGS_HANDOUT_CONFIRMED',
    SAVINGS_HANDOUT_REJECTED:   'SAVINGS_HANDOUT_REJECTED',
    SAVINGS_SETTINGS_UPDATED:   'SAVINGS_SETTINGS_UPDATED',
    SAVINGS_ACCOUNT_CREATED:      'SAVINGS_ACCOUNT_CREATED',
    SAVINGS_POOL_INFLOW_RECORDED: 'SAVINGS_POOL_INFLOW_RECORDED',
    SAVINGS_POOL_INFLOW_APPROVED: 'SAVINGS_POOL_INFLOW_APPROVED',
    SAVINGS_POOL_INFLOW_REJECTED: 'SAVINGS_POOL_INFLOW_REJECTED',
    // SIDE FUND
    SIDE_FUND_SETTINGS_UPDATED: 'SIDE_FUND_SETTINGS_UPDATED',
    SIDE_FUND_DUE_PAID:         'SIDE_FUND_DUE_PAID',
    SIDE_FUND_DUE_DEFAULTED:    'SIDE_FUND_DUE_DEFAULTED',
    SIDE_FUND_DUES_GENERATED:   'SIDE_FUND_DUES_GENERATED',
    SIDE_FUND_EXPENSE_RECORDED: 'SIDE_FUND_EXPENSE_RECORDED',
    SIDE_FUND_DIRECT_INFLOW_RECORDED: 'SIDE_FUND_DIRECT_INFLOW_RECORDED', // legacy, no longer produced (v1.26.0 removed direct/unattributed inflows)
    SIDE_FUND_BULK_PAYMENT_RECORDED: 'SIDE_FUND_BULK_PAYMENT_RECORDED',
    //REQUISITIONS
    REQUISITION_CREATED:  'REQUISITION_CREATED',
    REQUISITION_UPDATED:  'REQUISITION_UPDATED',
    REQUISITION_APPROVED: 'REQUISITION_APPROVED',
    REQUISITION_REJECTED: 'REQUISITION_REJECTED',
    // EXTERNAL AUDIT
    AUDIT_ENGAGEMENT_CREATED: 'AUDIT_ENGAGEMENT_CREATED',
    AUDIT_ENGAGEMENT_UPDATED: 'AUDIT_ENGAGEMENT_UPDATED',
    AUDIT_ENGAGEMENT_REVOKED: 'AUDIT_ENGAGEMENT_REVOKED',
    AUDIT_USER_ADDED:         'AUDIT_USER_ADDED',
    AUDIT_USER_REMOVED:       'AUDIT_USER_REMOVED',
    AUDIT_DOCUMENT_ADDED:     'AUDIT_DOCUMENT_ADDED',
    AUDIT_DOCUMENT_REMOVED:   'AUDIT_DOCUMENT_REMOVED',
    AUDIT_DOCUMENT_VIEWED:    'AUDIT_DOCUMENT_VIEWED',
    AUDIT_SUMMARY_DOWNLOADED: 'AUDIT_SUMMARY_DOWNLOADED',
    // AUDITOR SUBMISSION WORKFLOW (v1.20.0)
    AUDIT_COMMENT_ADDED:        'AUDIT_COMMENT_ADDED',
    AUDIT_FILE_UPLOADED:        'AUDIT_FILE_UPLOADED',
    AUDIT_FILE_REMOVED:         'AUDIT_FILE_REMOVED',
    AUDIT_SUBMISSION_CREATED:   'AUDIT_SUBMISSION_CREATED',
    AUDIT_SUBMISSION_APPROVED_STEP: 'AUDIT_SUBMISSION_APPROVED_STEP',
    AUDIT_SUBMISSION_FINALIZED: 'AUDIT_SUBMISSION_FINALIZED',
    AUDIT_SUBMISSION_REJECTED:  'AUDIT_SUBMISSION_REJECTED',
    AUDIT_EXTENSION_REQUESTED:  'AUDIT_EXTENSION_REQUESTED',
    AUDIT_EXTENSION_APPROVED:   'AUDIT_EXTENSION_APPROVED',
    AUDIT_EXTENSION_REJECTED:   'AUDIT_EXTENSION_REJECTED',
    AUDIT_REMINDER_SENT:        'AUDIT_REMINDER_SENT',
    // ADMINISTRATIVE OFFICER — STAFF DOCUMENT GRANTS & SERVICE FEES (v1.21.0)
    STAFF_DOCUMENT_GRANTED:        'STAFF_DOCUMENT_GRANTED',
    STAFF_DOCUMENT_REVOKED:        'STAFF_DOCUMENT_REVOKED',
    SERVICE_FEE_AGREEMENT_CREATED: 'SERVICE_FEE_AGREEMENT_CREATED',
    SERVICE_FEE_AGREEMENT_UPDATED: 'SERVICE_FEE_AGREEMENT_UPDATED',
    SERVICE_FEE_PAYMENT_RECORDED:  'SERVICE_FEE_PAYMENT_RECORDED',
    SERVICE_REIMBURSEMENT_REQUESTED: 'SERVICE_REIMBURSEMENT_REQUESTED',
    SERVICE_REIMBURSEMENT_APPROVED:  'SERVICE_REIMBURSEMENT_APPROVED',
    SERVICE_REIMBURSEMENT_REJECTED:  'SERVICE_REIMBURSEMENT_REJECTED',
    // DIGITAL CONSENT & SIGNATURES (v1.23.0)
    SIGNATURE_UPDATED:          'SIGNATURE_UPDATED',
    MEMBERSHIP_CONSENT_GIVEN:   'MEMBERSHIP_CONSENT_GIVEN',
    MEMBERSHIP_AGREEMENT_UPDATED: 'MEMBERSHIP_AGREEMENT_UPDATED',
    SIGNATURE_REQUIREMENTS_UPDATED: 'SIGNATURE_REQUIREMENTS_UPDATED',
    DOCUMENT_SIGNED:            'DOCUMENT_SIGNED',
    DOCUMENT_FULLY_SIGNED:      'DOCUMENT_FULLY_SIGNED',
    CERTIFICATE_ROUND_OPENED:   'CERTIFICATE_ROUND_OPENED',
    CERTIFICATE_ROUND_SIGNED:   'CERTIFICATE_ROUND_SIGNED',
    CERTIFICATE_ROUND_FULLY_SIGNED: 'CERTIFICATE_ROUND_FULLY_SIGNED',
    // STAMPS & SEALS (v1.24.0)
    STAMP_UPLOADED:            'STAMP_UPLOADED',
    STAMP_DEACTIVATED:         'STAMP_DEACTIVATED',
    STAMP_REQUIREMENTS_UPDATED: 'STAMP_REQUIREMENTS_UPDATED',
    // SIDE FUND — per-member overrides & overpayment credit (v1.25.0)
    SIDE_FUND_MEMBER_OVERRIDE_SET:     'SIDE_FUND_MEMBER_OVERRIDE_SET',
    SIDE_FUND_MEMBER_OVERRIDE_CLEARED: 'SIDE_FUND_MEMBER_OVERRIDE_CLEARED',
    SIDE_FUND_CREDIT_BANKED:           'SIDE_FUND_CREDIT_BANKED',
    SIDE_FUND_CREDIT_APPLIED:          'SIDE_FUND_CREDIT_APPLIED',
    // FISCAL QUARTERS (v1.25.0)
    FISCAL_QUARTER_CREATED: 'FISCAL_QUARTER_CREATED',
    FISCAL_QUARTER_UPDATED: 'FISCAL_QUARTER_UPDATED',
    FISCAL_QUARTER_DELETED: 'FISCAL_QUARTER_DELETED',
    // PAYMENT ACKNOWLEDGEMENTS (v1.30.0, Section 4.35)
    PAYMENT_ACK_CREATED:       'PAYMENT_ACK_CREATED',
    PAYMENT_ACK_ACKNOWLEDGED:  'PAYMENT_ACK_ACKNOWLEDGED',
    PAYMENT_ACK_DISPUTED:      'PAYMENT_ACK_DISPUTED',
    PAYMENT_ACK_REOPENED:      'PAYMENT_ACK_REOPENED',
    PAYMENT_ACK_FINAL_APPROVED: 'PAYMENT_ACK_FINAL_APPROVED',
};

const MODULES = {
    AUTH:        'AUTH',
    USERS:       'USERS',
    FINANCE:     'FINANCE',
    GRANTS:      'GRANTS',
    LOANS:       'LOANS',
    INVESTMENTS: 'INVESTMENTS',
    EVENTS:      'EVENTS',
    DOCUMENTS:   'DOCUMENTS',
    REPORTS:     'REPORTS',
    SYSTEM:      'SYSTEM',
    STAFF:       'STAFF',
    MMF:         'MMF',
};

module.exports = { logAction, extractRequestContext, ACTIONS, MODULES };
