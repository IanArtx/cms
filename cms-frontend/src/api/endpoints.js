// ============================================================
// API ENDPOINTS
// All API calls organised by module.
// Every function returns a promise that resolves to the
// response data. Errors are handled by the axios interceptor.
// ============================================================

import api from './axios';

// ============================================================
// AUTH
// ============================================================
export const authAPI = {
    register:        (data) => api.post('/auth/register', data),
    login:           (data) => api.post('/auth/login', data),
    logout:          ()     => api.post('/auth/logout'),
    refreshToken:    (data) => api.post('/auth/refresh', data),
    forgotPassword:  (data) => api.post('/auth/forgot-password', data),
    resetPassword:   (data) => api.post('/auth/reset-password', data),
    verifyEmail:     (token) => api.get(`/auth/verify-email?token=${token}`),
    // Unauthenticated — used by the Register page's role dropdown,
    // since a visitor filling out that form has no token yet.
    getPublicRoles:  ()     => api.get('/auth/roles'),
    setup2FA:        ()     => api.post('/auth/2fa/setup'),
    activate2FA:     (data) => api.post('/auth/2fa/activate', data),
    verify2FA:       (data) => api.post('/auth/2fa/verify', data),
};

// ============================================================
// USERS
// ============================================================
export const usersAPI = {
    getMyProfile:    ()         => api.get('/users/me'),
    updateMyProfile: (data)     => api.patch('/users/me', data),
    getAllUsers:      (params)   => api.get('/users', { params }),
    getUserById:     (id)       => api.get(`/users/${id}`),
    // v1.34.0 — full Member Portfolio snapshot (Section 6.x)
    getPortfolio:    (id)       => api.get(`/users/${id}/portfolio`),
    deactivateUser:  (id)       => api.patch(`/users/${id}/deactivate`),
    // v1.35.0 — permanent deletion, duplicate/unused registrations only
    getDeletionCheck: (id)      => api.get(`/users/${id}/deletion-check`),
    deleteUserPermanently: (id) => api.delete(`/users/${id}`),
    assignRole:      (id, data) => api.post(`/users/${id}/roles`, data),
    revokeRole:      (id, roleId) => api.delete(`/users/${id}/roles/${roleId}`),
    getRoleRequests: (params)   => api.get('/users/role-requests', { params }),
    getMyRoleRequest: ()        => api.get('/users/me/role-request'),
    getAllRoles:      ()         => api.get('/users/roles'),
    getShareholding: ()         => api.get('/users/shareholding'),
    getShareholders:  ()       => api.get('/users/shareholders'),
    // v1.23.0 — digital consent + signature (Section 4.29)
    updateSignature:         (dataUrl) => api.patch('/users/me/signature', { signature_data_url: dataUrl }),
    getMembershipAgreement:  ()        => api.get('/users/me/membership-agreement'),
    giveConsent:             ()        => api.post('/users/me/consent'),
};

// ============================================================
// CATEGORIES
// ============================================================
export const categoriesAPI = {
    getAll:    (params) => api.get('/categories', { params }),
    create:    (data)   => api.post('/categories', data),
    update:    (id, data) => api.patch(`/categories/${id}`, data),
};

// ============================================================
// ACCOUNTS
// ============================================================
export const accountsAPI = {
    getAll:           ()         => api.get('/accounts'),
    getSummary:       ()         => api.get('/accounts/summary'),
    getById:          (id)       => api.get(`/accounts/${id}`),
    createPrimary:    (data)     => api.post('/accounts/primary', data),
    createSecondary:  (data)     => api.post('/accounts', data),
    createSavings:    (data)     => api.post('/accounts/savings', data),
    updateAccount:    (id, data) => api.patch(`/accounts/${id}`, data),
    updateFloorLimit: (id, data) => api.post(`/accounts/${id}/floor-limit`, data),
    getCurrencies:    ()         => api.get('/accounts/currencies'),
    addCurrency:      (data)     => api.post('/accounts/currencies', data),
    updateCurrency:   (id, data) => api.patch(`/accounts/currencies/${id}`, data),
};

// ============================================================
// TRANSACTIONS
// ============================================================
export const transactionsAPI = {
    getAll:           (params) => api.get('/transactions', { params }),
    getById:          (id)     => api.get(`/transactions/${id}`),
    recordContribution: (data) => api.post('/transactions/contributions', data),
    recordExpense:    (data)   => api.post('/transactions/expenses', data),
    recordInflow:     (data)   => api.post('/transactions/inflows', data),
    reverse:          (id, data) => api.post(`/transactions/${id}/reverse`, data),
};

// ============================================================
// TRANSFERS
// ============================================================
export const transfersAPI = {
    getAll:    (params)   => api.get('/transfers', { params }),
    getById:   (id)       => api.get(`/transfers/${id}`),
    initiate:  (data)     => api.post('/transfers', data),
    update:    (id, data) => api.patch(`/transfers/${id}`, data),
    approve:   (id, data) => api.post(`/transfers/${id}/approve`, data),
    reject:    (id, data) => api.post(`/transfers/${id}/reject`, data),
};

// ============================================================
// GRANTS
// ============================================================
export const grantsAPI = {
    getAll:          (params)   => api.get('/grants', { params }),
    getById:         (id)       => api.get(`/grants/${id}`),
    create:          (data)     => api.post('/grants', data),
    update:          (id, data) => api.patch(`/grants/${id}`, data),
    approve:         (id)       => api.post(`/grants/${id}/approve`),
    recordTranche:   (id, data) => api.post(`/grants/${id}/tranches`, data),
    updateCondition: (id, conditionId, data) =>
        api.patch(`/grants/${id}/conditions/${conditionId}`, data),
};

// ============================================================
// LOANS
// ============================================================
export const loansAPI = {
    getAllReceived:       (params)   => api.get('/loans/received', { params }),
    getReceivedById:     (id)       => api.get(`/loans/received/${id}`),
    createReceived:      (data)     => api.post('/loans/received', data),
    updateReceived:      (id, data) => api.patch(`/loans/received/${id}`, data),
    approveReceived:     (id)       => api.post(`/loans/received/${id}/approve`),
    recordRepayment:     (id, data) => api.post(`/loans/received/${id}/repayments`, data),
    amendRate:           (id, data) => api.post(`/loans/received/${id}/amend-rate`, data),
    getAllGiven:          (params)   => api.get('/loans/given', { params }),
    getGivenById:        (id)       => api.get(`/loans/given/${id}`),
    createGiven:         (data)     => api.post('/loans/given', data),
    updateGiven:         (id, data) => api.patch(`/loans/given/${id}`, data),
    approveGiven:        (id)       => api.post(`/loans/given/${id}/approve`),
    recordGivenRepayment:(id, data) => api.post(`/loans/given/${id}/repayments`, data),
    amendGivenRate:      (id, data) => api.post(`/loans/given/${id}/amend-rate`, data),
};

// ============================================================
// INVESTMENTS
// ============================================================
export const investmentsAPI = {
    getAll:          (params)   => api.get('/investments', { params }),
    getById:         (id)       => api.get(`/investments/${id}`),
    create:          (data)     => api.post('/investments', data),
    update:          (id, data) => api.patch(`/investments/${id}`, data),
    approve:         (id)       => api.post(`/investments/${id}/approve`),
    fund:            (id, data) => api.post(`/investments/${id}/fund`, data),
    recordReturn:    (id, data) => api.post(`/investments/${id}/returns`, data),
    updateStatus:    (id, data) => api.patch(`/investments/${id}/status`, data),
    createProject:   (id, data) => api.post(`/investments/${id}/projects`, data),
    getProject:      (id, projectId) =>
        api.get(`/investments/${id}/projects/${projectId}`),
    addMilestone:    (id, projectId, data) =>
        api.post(`/investments/${id}/projects/${projectId}/milestones`, data),
    updateMilestone: (id, projectId, milestoneId, data) =>
        api.patch(`/investments/${id}/projects/${projectId}/milestones/${milestoneId}`, data),
    payCoupon:       (id, couponId, data) =>
        api.patch(`/investments/${id}/coupons/${couponId}/pay`, data),
    recordTransaction: (id, data) => api.post(`/investments/${id}/transactions`, data),
    getPerformanceSummary: () => api.get('/investments/performance-summary'),
    // v1.40.0
    updateCouponSchedule:     (id, data) => api.patch(`/investments/${id}/coupon-schedule`, data),
    requestTermination:       (id, data) => api.post(`/investments/${id}/terminate/request`, data),
    confirmTerminationRecords:(id)       => api.post(`/investments/${id}/terminate/confirm-records`),
    approveTermination:       (id, data) => api.post(`/investments/${id}/terminate/approve`, data),
    rejectTermination:        (id, data) => api.post(`/investments/${id}/terminate/reject`, data),
    // v1.42.0
    setSettlementValue:       (id, data) => api.patch(`/investments/${id}/settlement-value`, data),
};

// ============================================================
// MONEY MARKET FUNDS (MMF) — v1.28.0, Section 4.31
// Standalone sub-accounts drawn out of a Primary/Secondary account.
// ============================================================
export const mmfAPI = {
    getAll:                (params)   => api.get('/mmf', { params }),
    getById:               (id)       => api.get(`/mmf/${id}`),
    create:                (data)     => api.post('/mmf', data),
    topUp:                 (id, data) => api.post(`/mmf/${id}/topup`, data),
    withdraw:              (id, data) => api.post(`/mmf/${id}/withdraw`, data),
    recordInterest:        (id, data) => api.post(`/mmf/${id}/interest`, data),
    recordFee:             (id, data) => api.post(`/mmf/${id}/fee`, data),
    close:                 (id)       => api.post(`/mmf/${id}/close`),
    getPerformanceSummary: ()         => api.get('/mmf/performance-summary'),
};

// ============================================================
// CAPITAL GOALS (v1.29.0)
// ============================================================
export const capitalGoalsAPI = {
    getAll:    (params)   => api.get('/capital-goals', { params }),
    getById:   (id)       => api.get(`/capital-goals/${id}`),
    create:    (data)     => api.post('/capital-goals', data),
    update:    (id, data) => api.patch(`/capital-goals/${id}`, data),
    cancel:    (id, data) => api.post(`/capital-goals/${id}/cancel`, data),
    complete:  (id)       => api.post(`/capital-goals/${id}/complete`),
};

// ============================================================
// CAPITAL GOAL CALLS (v1.43.0) — "call on shares" pledges against a
// specific monthly call. See capitalGoalsController for the goal
// itself; these all hang off /capital-goals too.
// ============================================================
export const capitalGoalCallsAPI = {
    getMyPledges:            ()               => api.get('/capital-goals/my-calls'),
    getMonthlyCallById:      (monthlyCallId)  => api.get(`/capital-goals/monthly-calls/${monthlyCallId}`),
    submitPledge:            (monthlyCallId, data) => api.post(`/capital-goals/monthly-calls/${monthlyCallId}/pledges`, data),
    editPledge:               (pledgeId, data) => api.patch(`/capital-goals/pledges/${pledgeId}`, data),
    rejectPledge:             (pledgeId, data) => api.post(`/capital-goals/pledges/${pledgeId}/reject`, data),
    approvePledgePayment:     (pledgeId, data) => api.post(`/capital-goals/pledges/${pledgeId}/approve`, data),
    getPledgesForMonthlyCall: (monthlyCallId)  => api.get(`/capital-goals/monthly-calls/${monthlyCallId}/pledges`),
    getMonthlyCallStatus:     (monthlyCallId)  => api.get(`/capital-goals/monthly-calls/${monthlyCallId}/status`),
    listMonthlyCallsForGoal:  (goalId)         => api.get(`/capital-goals/${goalId}/monthly-calls`),
    getGoalContributionStats: (goalId)         => api.get(`/capital-goals/${goalId}/stats`),
};

// ============================================================
// PAYMENT ACKNOWLEDGEMENTS (v1.30.0)
// ============================================================
export const paymentAcknowledgementsAPI = {
    getMine:      ()         => api.get('/payment-acknowledgements/my'),
    getAll:       (params)   => api.get('/payment-acknowledgements', { params }),
    getById:      (id)       => api.get(`/payment-acknowledgements/${id}`),
    acknowledge:  (id, data) => api.post(`/payment-acknowledgements/${id}/acknowledge`, data),
    dispute:      (id, data) => api.post(`/payment-acknowledgements/${id}/dispute`, data),
    reopen:       (id)       => api.post(`/payment-acknowledgements/${id}/reopen`),
    finalApprove: (id)       => api.post(`/payment-acknowledgements/${id}/final-approve`),
};

// v1.39.0 — the opposite order from paymentAcknowledgementsAPI above:
// an entry is created FIRST (pending), and confirming it is what
// posts the real transaction.
export const paymentConfirmationsAPI = {
    create:   (data)     => api.post('/payment-confirmations', data),
    getMine:  ()          => api.get('/payment-confirmations/my'),
    getAll:   (params)    => api.get('/payment-confirmations', { params }),
    getById:  (id)        => api.get(`/payment-confirmations/${id}`),
    confirm:  (id, data)  => api.post(`/payment-confirmations/${id}/confirm`, data),
    dispute:  (id, data)  => api.post(`/payment-confirmations/${id}/dispute`, data),
    cancel:   (id, data)  => api.post(`/payment-confirmations/${id}/cancel`, data),
};

// ============================================================
// EVENTS
// ============================================================
export const eventsAPI = {
    getAll:      (params) => api.get('/events', { params }),
    getById:     (id)     => api.get(`/events/${id}`),
    getUpcoming: (days)   => api.get(`/events/upcoming?days=${days || 90}`),
    getTypes:    ()       => api.get('/events/types'),
    create:      (data)   => api.post('/events', data),
    update:      (id, data) => api.patch(`/events/${id}`, data),
    approve:     (id)     => api.post(`/events/${id}/approve`),
    cancel:      (id, data) => api.post(`/events/${id}/cancel`, data),
    // v1.28.3 — schedule change (dates can only move later) and manual completion
    extend:      (id, data) => api.patch(`/events/${id}/extend`, data),
    complete:    (id)     => api.post(`/events/${id}/complete`),
};

// ============================================================
// DOCUMENTS
// ============================================================
export const documentsAPI = {
    getAll:         (params) => api.get('/documents', { params }),
    getById:        (id)     => api.get(`/documents/${id}`),
    // responseType 'blob' so this works for both a real file stream
    // (UPLOADED) and a JSON payload (SYSTEM_GENERATED) — the caller
    // reads the blob's type to tell the two apart.
    download:       (id)     => api.get(`/documents/${id}/download`, { responseType: 'blob' }),
    upload:         (data)   => api.post('/documents/upload', data, {
        headers: { 'Content-Type': 'multipart/form-data' },
    }),
    generate:       (data)   => api.post('/documents/generate', data),
    approve:        (id)     => api.post(`/documents/${id}/approve`),
    // v1.23.0 — multi-signatory approval (Section 4.29)
    sign:               (id) => api.post(`/documents/${id}/sign`),
    getSignatures:      (id) => api.get(`/documents/${id}/signatures`),
    // v1.44.0 — everything (documents + certificate rounds) currently
    // awaiting the caller's own signature
    getPendingSignatures: ()  => api.get('/documents/pending-signatures'),
    // v1.24.0 — company stamps/seals (Section 4.30)
    getStamps:          (id) => api.get(`/documents/${id}/stamps`),
    archive:        (id)     => api.post(`/documents/${id}/archive`),
    newVersion:     (id, data) => api.post(`/documents/${id}/new-version`, data, {
        headers: { 'Content-Type': 'multipart/form-data' },
    }),
    getTemplates:   ()       => api.get('/documents/templates'),
    createTemplate: (data)   => api.post('/documents/templates', data),
};

// ============================================================
// EXTERNAL AUDIT
// ============================================================
export const auditAPI = {
    // Admin — engagement management
    listEngagements:   ()          => api.get('/audit/engagements'),
    getEngagement:     (id)        => api.get(`/audit/engagements/${id}`),
    createEngagement:  (data)      => api.post('/audit/engagements', data),
    updateEngagement:  (id, data)  => api.patch(`/audit/engagements/${id}`, data),
    revokeEngagement:  (id)        => api.post(`/audit/engagements/${id}/revoke`),
    addUser:           (id, data)  => api.post(`/audit/engagements/${id}/users`, data),
    removeUser:        (id, userId) => api.delete(`/audit/engagements/${id}/users/${userId}`),
    addDocument:       (id, data)  => api.post(`/audit/engagements/${id}/documents`, data),
    removeDocument:    (id, documentId) => api.delete(`/audit/engagements/${id}/documents/${documentId}`),

    // Auditor — scoped read-only portal
    getMyEngagements:  ()          => api.get('/audit/my-engagements'),
    getAllowedAccounts:(id)        => api.get(`/audit/engagements/${id}/allowed-accounts`),
    getTransactions:   (id, params) => api.get(`/audit/engagements/${id}/transactions`, { params }),
    getDocuments:      (id)        => api.get(`/audit/engagements/${id}/documents`),
    // responseType 'blob' — same UPLOADED-vs-SYSTEM_GENERATED split as documentsAPI.download
    previewDocument:   (id, documentId) => api.get(
        `/audit/engagements/${id}/documents/${documentId}`, { responseType: 'blob' }
    ),
    getSummary:        (id)        => api.get(`/audit/engagements/${id}/summary`),

    // Auditor — submission workflow (v1.20.0)
    getComments:       (id)        => api.get(`/audit/engagements/${id}/comments`),
    addComment:        (id, data)  => api.post(`/audit/engagements/${id}/comments`, data),
    getReportFiles:    (id)        => api.get(`/audit/engagements/${id}/report-files`),
    uploadReportFile:  (id, formData) => api.post(`/audit/engagements/${id}/report-files`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
    }),
    deleteReportFile:  (id, fileId) => api.delete(`/audit/engagements/${id}/report-files/${fileId}`),
    getEngagementSubmissions: (id) => api.get(`/audit/engagements/${id}/submissions`),
    finishAudit:       (id)        => api.post(`/audit/engagements/${id}/finish`),
    requestExtension:  (id, data)  => api.post(`/audit/engagements/${id}/extension-requests`, data),
    getMyExtensionRequests: (id)   => api.get(`/audit/engagements/${id}/extension-requests`),

    // Director / Secretary — submission review (v1.20.0)
    listSubmissions:   (params)    => api.get('/audit/submissions', { params }),
    getSubmission:     (id)        => api.get(`/audit/submissions/${id}`),
    previewSubmissionFile: (id, fileId) => api.get(
        `/audit/submissions/${id}/files/${fileId}`, { responseType: 'blob' }
    ),
    approveSubmission: (id)        => api.post(`/audit/submissions/${id}/approve`),
    rejectSubmission:  (id, data)  => api.post(`/audit/submissions/${id}/reject`, data),
    listExtensionRequests: (params) => api.get('/audit/extension-requests', { params }),
    approveExtensionRequest: (id, data) => api.post(`/audit/extension-requests/${id}/approve`, data),
    rejectExtensionRequest:  (id, data) => api.post(`/audit/extension-requests/${id}/reject`, data),
};

// ============================================================
// SETTINGS (company branding)
// ============================================================
export const settingsAPI = {
    getCompany:    ()     => api.get('/settings/company'),
    updateCompany: (data) => api.patch('/settings/company', data),
    uploadLogo:    (formData) => api.post('/settings/company/logo', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
    }),
    // v1.23.0 — digital consent + multi-signatory approval (Section 4.29)
    updateMembershipAgreement:  (content)   => api.patch('/settings/membership-agreement', { content }),
    getSignatureRequirements:   ()          => api.get('/settings/signature-requirements'),
    setSignatureRequirements:   (documentType, roleIds) =>
        api.put(`/settings/signature-requirements/${documentType}`, { role_ids: roleIds }),
    // v1.24.0 — company stamps/seals (Section 4.30)
    getStamps:            ()          => api.get('/settings/stamps'),
    uploadStamp:           (formData) => api.post('/settings/stamps', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
    }),
    deactivateStamp:       (id)       => api.patch(`/settings/stamps/${id}/deactivate`),
    getStampRequirements:  ()          => api.get('/settings/stamp-requirements'),
    setStampRequirements:  (documentType, stampIds) =>
        api.put(`/settings/stamp-requirements/${documentType}`, { stamp_ids: stampIds }),
    // v1.25.0 — custom fiscal quarters (Section 4.10)
    getFiscalQuarters:   ()       => api.get('/settings/fiscal-quarters'),
    createFiscalQuarter: (data)   => api.post('/settings/fiscal-quarters', data),
    updateFiscalQuarter: (id, data) => api.put(`/settings/fiscal-quarters/${id}`, data),
    deleteFiscalQuarter: (id)     => api.delete(`/settings/fiscal-quarters/${id}`),
};

// ============================================================
// REPORTS
// ============================================================
export const reportsAPI = {
    getChartOfAccounts: () => api.get('/reports/chart-of-accounts'),
    getGeneral:        (params) => api.get('/reports/general', { params }),
    getIndividual:     (userId, params) =>
        api.get(`/reports/individual/${userId}`, { params }),
    getMyReport:       (params) => api.get('/reports/me', { params }),
    sendMonthly:       (data)   => api.post('/reports/send-monthly', data),
    sendBroadcast:     (data)   => api.post('/reports/broadcast', data),
    getLog:            (params) => api.get('/reports/log', { params }),
    getAuditLog:       (params) => api.get('/reports/audit', { params }),
};

// ============================================================
// DIVIDENDS & AUTHORITY PAYMENTS
// ============================================================
export const dividendsAPI = {
    getAll:                  (params)   => api.get('/dividends', { params }),
    getById:                 (id)       => api.get(`/dividends/${id}`),
    declare:                 (data)     => api.post('/dividends', data),
    update:                  (id, data) => api.patch(`/dividends/${id}`, data),
    approve:                 (id, data) => api.post(`/dividends/${id}/approve`, data),
    getAllAuthorityPayments:  (params)   => api.get('/dividends/authority-payments', { params }),
    recordAuthorityPayment:  (data)     => api.post('/dividends/authority-payments', data),
};

// ============================================================
// MEMBER SAVINGS
// ============================================================
export const savingsAPI = {
    // Flexible (ongoing balance) savings
    getMySavings:     ()         => api.get('/savings/me'),
    getMyBalance:     ()         => api.get('/savings/balance/me'),
    getBalanceForUser: (userId)  => api.get(`/savings/balance/${userId}`),
    getMyHandouts:    ()         => api.get('/savings/handouts/me'),
    getAll:           (params)   => api.get('/savings', { params }),
    create:           (data)     => api.post('/savings', data),
    approve:          (id, data) => api.patch(`/savings/${id}/approve`, data),
    reject:           (id, data) => api.patch(`/savings/${id}/reject`, data),
    // Handouts
    getAllHandouts:   (params)   => api.get('/savings/handouts', { params }),
    createHandout:    (data)     => api.post('/savings/handouts', data),
    confirmHandout:   (id)       => api.patch(`/savings/handouts/${id}/confirm`),
    rejectHandout:    (id, data) => api.patch(`/savings/handouts/${id}/reject`, data),
    // Company-wide interest settings
    getSettings:      ()         => api.get('/savings/settings'),
    updateSettings:   (data)     => api.patch('/savings/settings', data),
    // Legacy fixed-term
    createFixedTerm:  (data)     => api.post('/savings/fixed-term', data),
    withdraw:         (id)       => api.post(`/savings/${id}/withdraw`),
    // Pool "other" inflow — non-member credit into the savings pool
    // (e.g. investment profit), same Treasurer/Assistant Treasurer
    // approval pipeline as a member deposit.
    getPoolInflows:   (params)   => api.get('/savings/pool-inflows', { params }),
    createPoolInflow: (data)     => api.post('/savings/pool-inflows', data),
    approvePoolInflow: (id, data) => api.patch(`/savings/pool-inflows/${id}/approve`, data),
    rejectPoolInflow:  (id, data) => api.patch(`/savings/pool-inflows/${id}/reject`, data),
};

// ============================================================
// SYSTEM (permissions management)
// ============================================================
export const systemAPI = {
    getPermissions:        ()       => api.get('/system/permissions'),
    getRolePermissions:    (roleId) => api.get(`/system/roles/${roleId}/permissions`),
    updateRolePermissions: (roleId, codes) =>
        api.put(`/system/roles/${roleId}/permissions`, { permission_codes: codes }),
};

// ============================================================
// SIDE FUND
// ============================================================
export const sideFundAPI = {
    getSettings:    ()         => api.get('/side-fund/settings'),
    updateSettings: (data)     => api.patch('/side-fund/settings', data),
    getMyDues:      ()         => api.get('/side-fund/dues/me'),
    getAllDues:     (params)   => api.get('/side-fund/dues', { params }),
    payDue:         (id, data) => api.patch(`/side-fund/dues/${id}/pay`, data),
    getExpenses:    (params)   => api.get('/side-fund/expenses', { params }),
    recordExpense:  (data)     => api.post('/side-fund/expenses', data),
    // v1.25.0 — per-member overrides + overpayment credit
    getOverrides:   ()         => api.get('/side-fund/overrides'),
    setOverride:    (userId, data) => api.put(`/side-fund/overrides/${userId}`, data),
    clearOverride:  (userId)   => api.delete(`/side-fund/overrides/${userId}`),
    getMyCredit:    ()         => api.get('/side-fund/credit/me'),
    getAllCredit:   ()         => api.get('/side-fund/credit'),
    // v1.26.0 — bulk pay-all-dues, per-member overdue summary
    bulkPayDues:      (data) => api.patch('/side-fund/dues/bulk-pay', data),
    getMyOverdue:     ()     => api.get('/side-fund/overdue/me'),
    getAllOverdue:    ()     => api.get('/side-fund/overdue'),
    // v1.28.3 — on-demand due generation (fills the gap left by pure
    // cron generation when the fund/backend went live after the 1st)
    generateDues:     (data) => api.post('/side-fund/dues/generate', data),
    // v1.32.0 — membership checklist (who's in/out) + exit payouts
    getMembers:        ()             => api.get('/side-fund/members'),
    addMember:         (userId, data) => api.post(`/side-fund/members/${userId}`, data),
    getPayoutPreview:  (userId)       => api.get(`/side-fund/members/${userId}/payout-preview`),
    removeMember:      (userId, data) => api.patch(`/side-fund/members/${userId}/remove`, data),
};

// ============================================================
// FINES & PENALTIES (v1.37.0)
// ============================================================
export const finesAPI = {
    getMine:   ()         => api.get('/fines/me'),
    getAll:    (params)   => api.get('/fines', { params }),
    create:    (data)     => api.post('/fines', data),
    clear:     (id, data) => api.patch(`/fines/${id}/clear`, data),
};

// ============================================================
// MEMBER DEPOSIT TRACKING (v1.38.0)
// ============================================================
export const depositsAPI = {
    getSettings:      ()         => api.get('/deposits/settings'),
    updateSettings:   (data)     => api.patch('/deposits/settings', data),
    getMine:          ()         => api.get('/deposits/me'),
    getAll:           ()         => api.get('/deposits'),
    create:           (data)     => api.post('/deposits', data),
    getExcusals:      ()         => api.get('/deposits/excusals'),
    setExcusal:       (userId, data) => api.put(`/deposits/excusals/${userId}`, data),
    clearExcusal:     (userId)   => api.delete(`/deposits/excusals/${userId}`),
    getExitPreview:   (userId, params) => api.get(`/deposits/${userId}/exit-preview`, { params }),
    processExitRefund: (userId, data)  => api.patch(`/deposits/${userId}/exit-refund`, data),
};

// ============================================================
// REQUISITIONS
// ============================================================
export const requisitionsAPI = {
    getAll:    (params)   => api.get('/requisitions', { params }),
    getMine:   ()         => api.get('/requisitions/me'),
    create:    (data)     => api.post('/requisitions', data),
    update:    (id, data) => api.patch(`/requisitions/${id}`, data),
    approve:   (id, data) => api.post(`/requisitions/${id}/approve`, data),
    reject:    (id, data) => api.post(`/requisitions/${id}/reject`, data),
};

// ============================================================
// SERVICE FEES (v1.21.0) — contracted-staff monthly fee
// arrangements and expense reimbursements.
// ============================================================
export const serviceFeesAPI = {
    // Admin — agreements
    listAgreements:   (params) => api.get('/service-fees/agreements', { params }),
    getAgreement:     (id)     => api.get(`/service-fees/agreements/${id}`),
    createAgreement:  (data)   => api.post('/service-fees/agreements', data),
    updateAgreement:  (id, data) => api.patch(`/service-fees/agreements/${id}`, data),
    recordPayment:    (id, data) => api.post(`/service-fees/agreements/${id}/pay`, data),

    // Self-service
    getMyAgreement:   ()       => api.get('/service-fees/my-agreement'),
    getMyReimbursements: ()    => api.get('/service-fees/my-reimbursements'),
    requestReimbursement: (data) => api.post('/service-fees/reimbursements', data, {
        headers: { 'Content-Type': 'multipart/form-data' },
    }),

    // Treasurer — reimbursement review
    listReimbursements:  (params) => api.get('/service-fees/reimbursements', { params }),
    approveReimbursement: (id, data) => api.post(`/service-fees/reimbursements/${id}/approve`, data),
    rejectReimbursement:  (id, data) => api.post(`/service-fees/reimbursements/${id}/reject`, data),
    downloadReceipt:      (id) => api.get(`/service-fees/reimbursements/${id}/receipt`, { responseType: 'blob' }),
};

// ============================================================
// STAFF ACCESS (v1.21.0) — per-document grants for finance-
// restricted staff roles (e.g. Administrative Officer).
// ============================================================
export const staffAccessAPI = {
    listGrants:   (params) => api.get('/staff-access/grants', { params }),
    grantDocument: (data)  => api.post('/staff-access/grants', data),
    revokeGrant:  (id)     => api.delete(`/staff-access/grants/${id}`),
    getMyDocuments: ()     => api.get('/staff-access/my-documents'),
    previewMyDocument: (documentId) => api.get(`/staff-access/my-documents/${documentId}`, { responseType: 'blob' }),
};

export const notificationsAPI = {
    getAll:         (params) => api.get('/notifications', { params }),
    getUnreadCount: ()       => api.get('/notifications/unread-count'),
    markAsRead:     (id)     => api.patch(`/notifications/${id}/read`),
    markAllAsRead:  ()       => api.patch('/notifications/read-all'),
};

export const sharesAPI = {
    getCurrentPrice: ()       => api.get('/shares/price'),
    setPrice:        (data)   => api.post('/shares/price', data),
    getHistory:      (params) => api.get('/shares/price/history', { params }),
    // v1.33.0 — full shareholding recompute (unit-price method). Preview
    // is read-only and shows old-vs-proposed for every member; recalculate
    // actually commits it. Admin only on the backend.
    getRecalculatePreview: () => api.get('/shares/recalculate-preview'),
    recalculate:           () => api.post('/shares/recalculate'),
};

// ============================================================
// CURRENCY EXCHANGE RATES
// Monthly, display-only rates for showing the share price/value
// in other currencies.
// ============================================================
export const exchangeRatesAPI = {
    getCurrent: ()       => api.get('/exchange-rates/current'),
    setRate:    (data)   => api.post('/exchange-rates', data),
    getHistory: (params) => api.get('/exchange-rates/history', { params }),
};

// ============================================================
// CERTIFICATE OF SHARES
// Same format for MONTHLY and ANNUAL — issued on demand here,
// or automatically by the schedule (see Reports > Issue Now).
// ============================================================
export const certificatesAPI = {
    issue:      (data)   => api.post('/certificates', data),
    getMine:    (params) => api.get('/certificates/me', { params }),
    getAll:     (params) => api.get('/certificates', { params }),
    issueNow:   (data)   => api.post('/certificates/issue-now', data),
    // v1.23.0 — monthly/annual signing rounds (Section 4.29)
    getRounds:      ()   => api.get('/certificates/rounds'),
    getRoundById:   (id) => api.get(`/certificates/rounds/${id}`),
    signRound:      (id) => api.post(`/certificates/rounds/${id}/sign`),
};

// ============================================================
// GLOBAL SEARCH
// ============================================================
export const searchAPI = {
    search: (q) => api.get('/search', { params: { q } }),
};