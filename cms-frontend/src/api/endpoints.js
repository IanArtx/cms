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
    // v1.75.0 — change password while signed in (other devices signed out;
    // returns fresh tokens for this device) and the two email-change links
    changePassword:     (data)  => api.post('/auth/change-password', data),
    confirmEmailChange: (token) => api.post('/auth/email-change/confirm', { token }),
    cancelEmailChange:  (token) => api.post('/auth/email-change/cancel', { token }),
};

// ============================================================
// USERS
// ============================================================
export const usersAPI = {
    getMyProfile:    ()         => api.get('/users/me'),
    updateMyProfile: (data)     => api.patch('/users/me', data),
    getAllUsers:      (params)   => api.get('/users', { params }),
    // v1.69.1 — names only, for person pickers (Generate Document, Events)
    getDirectory:     ()         => api.get('/users/directory'),
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
    getMyPaymentLedger: (limit) => api.get('/users/me/payment-ledger', { params: { limit } }), // v1.56.0
    getShareholders:  ()       => api.get('/users/shareholders'),
    // v1.23.0 — digital consent + signature (Section 4.29)
    updateSignature:         (dataUrl) => api.patch('/users/me/signature', { signature_data_url: dataUrl }),
    getMembershipAgreement:  ()        => api.get('/users/me/membership-agreement'),
    giveConsent:             ()        => api.post('/users/me/consent'),
    // v1.75.0 — email-address change (confirmed from the new address)
    getMyEmailChange:        ()        => api.get('/users/me/email-change'),
    requestEmailChange:      (data)    => api.post('/users/me/email-change', data),
    cancelMyEmailChange:     ()        => api.delete('/users/me/email-change'),
    adminGetEmailChange:     (id)       => api.get(`/users/${id}/email-change`),
    adminRequestEmailChange: (id, data) => api.post(`/users/${id}/email-change`, data),
    adminCancelEmailChange:  (id)       => api.delete(`/users/${id}/email-change`),
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
    // v1.56.0 — Shareholder Dashboard inflow/outflow chart
    getInflowOutflowTrend: (months) => api.get('/accounts/inflow-outflow-trend', { params: { months } }),
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
    // v1.50.0 — Income vs Expense by currency + most/least quarter,
    // and a CSV export honoring the same filters as the ledger.
    getAnalytics:     (params) => api.get('/transactions/analytics', { params }),
    exportCsv:        (params) => api.get('/transactions/export', { params, responseType: 'blob' }),
    // v1.72.0 — a reversal is now a REQUEST that someone else approves.
    // reverse() above files the request; these list and decide them.
    getReversalRequests:    (params)   => api.get('/transactions/reversal-requests', { params }),
    approveReversalRequest: (id)       => api.post(`/transactions/reversal-requests/${id}/approve`),
    rejectReversalRequest:  (id, data) => api.post(`/transactions/reversal-requests/${id}/reject`, data),
    // v1.78.0 — documents connected to a transaction
    getDocuments:    (id)         => api.get(`/transactions/${id}/documents`),
    linkDocuments:   (id, data)   => api.post(`/transactions/${id}/documents`, data),
    unlinkDocument:  (id, docId)  => api.delete(`/transactions/${id}/documents/${docId}`),
};

// ============================================================
// MAINTENANCE MODE (v1.74.0) — Admin switch in Settings › Maintenance.
// (The public status check is read by MaintenanceGate with plain
// fetch(), deliberately not through this client.)
// ============================================================
export const maintenanceAPI = {
    getAdmin: ()     => api.get('/maintenance'),
    set:      (data) => api.put('/maintenance', data),
};

// ============================================================
// MONEY APPROVALS (v1.73.0) — money entries recorded by anyone who is
// not the Treasurer or an Admin wait here until the Treasurer or an
// Admin approves them.
// ============================================================
export const moneyApprovalsAPI = {
    getAll:  (params)   => api.get('/money-approvals', { params }),
    approve: (id)       => api.post(`/money-approvals/${id}/approve`),
    reject:  (id, data) => api.post(`/money-approvals/${id}/reject`, data),
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
    // v1.50.0 — per-currency volume/rate/charges + largest-smallest,
    // and a CSV export honoring the same filters as the ledger.
    getAnalytics: (params) => api.get('/transfers/analytics', { params }),
    exportCsv:    (params) => api.get('/transfers/export', { params, responseType: 'blob' }),
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
    // v1.70.0 — lender residency / TIN and withholding tax on interest
    updateReceivedTax:   (id, data) => api.patch(`/loans/received/${id}/tax`, data),
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
    // v1.80.0 — every ledger entry of one investment, and classifying an expense
    getLedger:       (id)       => api.get(`/investments/${id}/ledger`),
    classifyExpense: (id, data) => api.patch(`/investments/${id}/cost-type`, data),
    // v1.70.0 — treasury bill repaid at maturity (tax on the discount)
    recordTreasuryBillMaturity: (id, data) => api.post(`/investments/${id}/treasury-bill-maturity`, data),
    getPerformanceSummary: () => api.get('/investments/performance-summary'),
    getInputVsReturn:      () => api.get('/investments/input-vs-return'), // v1.56.0
    getPortfolioSummary:   () => api.get('/investments/portfolio-summary'), // v1.57.0
    // v1.40.0
    updateCouponSchedule:     (id, data) => api.patch(`/investments/${id}/coupon-schedule`, data),
    requestTermination:       (id, data) => api.post(`/investments/${id}/terminate/request`, data),
    confirmTerminationRecords:(id)       => api.post(`/investments/${id}/terminate/confirm-records`),
    approveTermination:       (id, data) => api.post(`/investments/${id}/terminate/approve`, data),
    rejectTermination:        (id, data) => api.post(`/investments/${id}/terminate/reject`, data),
    // v1.42.0
    setSettlementValue:       (id, data) => api.patch(`/investments/${id}/settlement-value`, data),
    // v1.60.0 — bond term identifier (2/3/5/10/15/20/25yr)
    setBondTerm:              (id, data) => api.patch(`/investments/${id}/bond-term`, data),
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
    // v1.48.0 — turns a legacy (pre-v1.43.0) goal into a call-based one,
    // or regenerates a call-based goal's missing schedule.
    activateCallSchedule: (id, data) => api.post(`/capital-goals/${id}/activate-call-schedule`, data),
    // v1.48.0 — Admin-configurable late-payment fine rate/grace period,
    // replacing what used to be hardcoded constants.
    getFineSettings:    ()     => api.get('/capital-goals/fine-settings'),
    updateFineSettings: (data) => api.patch('/capital-goals/fine-settings', data),
    // v1.51.0 — company-wide Capital Goal Tracking on/off toggle.
    getTrackingSettings:    ()     => api.get('/capital-goals/settings/tracking'),
    updateTrackingSettings: (data) => api.patch('/capital-goals/settings/tracking', data),
    // v1.78.0 — dashboards/hub, statistics, pledgers by name, activity,
    // goal money (Collected → Moved → Invested), tie to an investment
    getOverview:   ()         => api.get('/capital-goals/overview'),
    getInsights:   (id)       => api.get(`/capital-goals/${id}/insights`),
    getPledgers:   (id)       => api.get(`/capital-goals/${id}/pledgers`),
    getActivity:   (id, params) => api.get(`/capital-goals/${id}/activity`, { params }),
    getFunds:      (id)       => api.get(`/capital-goals/${id}/funds`),
    setInvestment: (id, data) => api.put(`/capital-goals/${id}/investment`, data),
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
    getPendingPledges:        ()               => api.get('/capital-goals/pending-pledges'), // v1.56.1
    getCallMembers:           (monthlyCallId)  => api.get(`/capital-goals/monthly-calls/${monthlyCallId}/members`), // v1.78.0 — by name
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
// MEETINGS & RESOLUTIONS (v1.79.0) — AGM / EGM / board meetings,
// the register of attendees, resolutions, written resolutions
// ============================================================
export const meetingsAPI = {
    getSettings:      ()          => api.get('/meetings/settings'),
    updateSettings:   (data)      => api.patch('/meetings/settings', data),
    getMyActions:     ()          => api.get('/meetings/my-actions'),
    getAll:           (params)    => api.get('/meetings', { params }),
    create:           (data)      => api.post('/meetings', data),
    getById:          (id)        => api.get(`/meetings/${id}`),
    update:           (id, data)  => api.patch(`/meetings/${id}`, data),
    refreshRegister:  (id)        => api.post(`/meetings/${id}/register/refresh`),
    addAttendee:      (id, data)  => api.post(`/meetings/${id}/attendees`, data),
    markAttendance:   (id, aid, data) => api.patch(`/meetings/${id}/attendees/${aid}`, data),
    removeAttendee:   (id, aid)   => api.delete(`/meetings/${id}/attendees/${aid}`),
    issueNotice:      (id, data)  => api.post(`/meetings/${id}/notice`, data || {}),
    open:             (id)        => api.post(`/meetings/${id}/open`, {}),
    confirmAttendance: (id, data) => api.post(`/meetings/${id}/confirm`, data),
    saveMinutes:      (id, data)  => api.put(`/meetings/${id}/minutes`, data),
    close:            (id, data)  => api.post(`/meetings/${id}/close`, data || {}),
    cancel:           (id, data)  => api.post(`/meetings/${id}/cancel`, data),
    addResolution:    (id, data)  => api.post(`/meetings/${id}/resolutions`, data),
    getResolutions:   (params)    => api.get('/meetings/resolutions', { params }),
    getResolution:    (rid)       => api.get(`/meetings/resolutions/${rid}`),
    updateResolution: (rid, data) => api.patch(`/meetings/resolutions/${rid}`, data),
    vote:             (rid, data) => api.post(`/meetings/resolutions/${rid}/vote`, data),
    withdraw:         (rid)       => api.post(`/meetings/resolutions/${rid}/withdraw`, {}),
    markFiled:        (rid, data) => api.post(`/meetings/resolutions/${rid}/filed`, data),
    createWritten:    (data)      => api.post('/meetings/resolutions/written', data),
    sign:             (rid, data) => api.post(`/meetings/resolutions/${rid}/sign`, data),
    // The server builds the document's content; preview: true returns it unsaved.
    document:         (data)      => api.post('/meetings/documents', data),
};

// ============================================================
// DOCUMENTS
// ============================================================
export const documentsAPI = {
    getAll:         (params) => api.get('/documents', { params }),
    // v1.65.0 — a member's own documents (Share Purchase Receipts).
    // No DOCUMENT_VIEW permission needed; see documentsController.getMyDocuments.
    getMine:        (params) => api.get('/documents/mine', { params }),
    // v1.67.0 — every member's Share Purchase Receipts, Treasury only
    // (Treasurer / Assistant Treasurer / Admin); see documentsController.getShareReceipts.
    getShareReceipts: (params) => api.get('/documents/share-receipts', { params }),
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
    // v1.46.0 — remove an already-ARCHIVED document from the archive
    // (soft removal — see deleteDocument in documentsController.js)
    remove:         (id)     => api.delete(`/documents/${id}`),
    newVersion:     (id, data) => api.post(`/documents/${id}/new-version`, data, {
        headers: { 'Content-Type': 'multipart/form-data' },
    }),
    getTemplates:   ()       => api.get('/documents/templates'),
    createTemplate: (data)   => api.post('/documents/templates', data),
    // v1.78.0 — transactions connected to a document
    getTransactions:   (id)        => api.get(`/documents/${id}/transactions`),
    linkTransactions:  (id, data)  => api.post(`/documents/${id}/transactions`, data),
    unlinkTransaction: (id, txId)  => api.delete(`/documents/${id}/transactions/${txId}`),
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
    // v1.79.0 — registration number, TIN, registered office … (logged-in users only)
    getStatutory:    ()     => api.get('/settings/company/statutory'),
    updateStatutory: (data) => api.patch('/settings/company/statutory', data),
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
    // v1.51.0 — today's quarter, for the Dashboard widget.
    getCurrentFiscalQuarter: () => api.get('/settings/fiscal-quarters/current'),
    // v1.63.0 — Google Calendar / Meet integration (Section 4.20
    // addendum). Status is open to any authenticated user; connect/
    // disconnect are Admin-only (enforced server-side).
    getGoogleStatus:     () => api.get('/settings/google/status'),
    startGoogleConnect:  () => api.get('/settings/google/connect'),
    disconnectGoogle:    () => api.post('/settings/google/disconnect'),
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

    // General Ledger suite (v1.55.0)
    getGLAccounts:        ()               => api.get('/reports/gl-accounts'),
    updateGLMapping:      (inflowType, data) => api.patch(`/reports/gl-accounts/mapping/${inflowType}`, data),
    getTrialBalance:      (params)         => api.get('/reports/trial-balance', { params }),
    getGeneralLedger:     (params)         => api.get('/reports/general-ledger', { params }),
    getBalanceSheet:      (params)         => api.get('/reports/balance-sheet', { params }),
    getIncomeStatement:   (params)         => api.get('/reports/income-statement', { params }),
    getCashFlowStatement: (params)         => api.get('/reports/cash-flow-statement', { params }),

    // Records check (v1.72.0) — stored fund/investment figures vs the
    // same figures worked out again from their entries, plus the log of
    // automatic corrections.
    getRecordChecks:      ()               => api.get('/reports/record-checks'),

    // FX & Revaluation (v1.66.0)
    getFxStatus:          ()               => api.get('/reports/fx/status'),
    getFxRevaluations:    ()               => api.get('/reports/fx/revaluations'),
    runFxRevaluation:     (data)           => api.post('/reports/fx/revaluations', data),
    reopenFxRevaluation:  (periodEnd)      => api.delete(`/reports/fx/revaluations/${periodEnd}`),
    setTransactionFxRate: (id, data)       => api.patch(`/reports/fx/transactions/${id}/rate`, data),
    clearTransactionFxRate: (id)           => api.delete(`/reports/fx/transactions/${id}/rate`),
    recomputeFxValues:    ()               => api.post('/reports/fx/recompute'),
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
    // Currencies that already have an active SAVINGS account set up —
    // every currency picker on the Savings page (v1.61.0) is built
    // from this, not the general accounts list (which needs
    // FINANCE_VIEW_ALL and isn't every Savings actor's permission).
    getSavingsCurrencies: () => api.get('/savings/currencies'),
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
    // Savings-to-Capital Conversion (v1.58.0) — Treasurer redirects a
    // member's own savings principal into a capital contribution;
    // nothing moves until the member confirms.
    getMyCapitalConversions:  ()         => api.get('/savings/capital-conversions/me'),
    getAllCapitalConversions: (params)   => api.get('/savings/capital-conversions', { params }),
    createCapitalConversion:  (data)     => api.post('/savings/capital-conversions', data),
    confirmCapitalConversion: (id)       => api.patch(`/savings/capital-conversions/${id}/confirm`),
    rejectCapitalConversion:  (id, data) => api.patch(`/savings/capital-conversions/${id}/reject`, data),
    // Savings Currency Conversion (v1.61.0) — Treasurer moves a
    // member's own savings from one currency they hold into another,
    // at a manually-entered rate, no charges; nothing moves until the
    // member confirms.
    getMyCurrencyConversions:  ()         => api.get('/savings/currency-conversions/me'),
    getAllCurrencyConversions: (params)   => api.get('/savings/currency-conversions', { params }),
    createCurrencyConversion:  (data)     => api.post('/savings/currency-conversions', data),
    confirmCurrencyConversion: (id)       => api.patch(`/savings/currency-conversions/${id}/confirm`),
    rejectCurrencyConversion:  (id, data) => api.patch(`/savings/currency-conversions/${id}/reject`, data),
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
    // Settle Fines With Savings (v1.59.0) — two entry points funnelling
    // into the same review flow: a Treasurer enters it directly
    // (member confirms), or a member requests it themselves (Treasurer
    // approves).
    getMySettlements:      ()         => api.get('/fines/settlements/me'),
    getAllSettlements:     (params)   => api.get('/fines/settlements', { params }),
    getSettlementItems:    (id)       => api.get(`/fines/settlements/${id}/items`),
    createSettlement:      (data)     => api.post('/fines/settlements', data),
    requestSettlement:     (data)     => api.post('/fines/settlements/request', data),
    confirmSettlement:     (id)       => api.patch(`/fines/settlements/${id}/confirm`),
    rejectSettlement:      (id, data) => api.patch(`/fines/settlements/${id}/reject`, data),
    approveSettlement:     (id)       => api.patch(`/fines/settlements/${id}/approve`),
    denySettlement:        (id, data) => api.patch(`/fines/settlements/${id}/deny`, data),
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
    // v1.80.0 — supporting documents, investments
    investmentOptions: ()        => api.get('/requisitions/investment-options'),
    getDocuments:   (id)         => api.get(`/requisitions/${id}/documents`),
    linkDocuments:  (id, ids)    => api.post(`/requisitions/${id}/documents`, { document_ids: ids }),
    uploadDocument: (id, formData) => api.post(`/requisitions/${id}/documents/upload`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
    }),
    unlinkDocument: (id, docId)  => api.delete(`/requisitions/${id}/documents/${docId}`),
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
    // v1.70.0 — withholding tax on an agreement (amendment with a trail)
    getAgreementWht:  (id)       => api.get(`/service-fees/agreements/${id}/wht`),
    amendAgreementWht:(id, data) => api.patch(`/service-fees/agreements/${id}/wht`, data),

    // v1.52.0 — monthly period tracking
    getOutstandingPeriods: (id) => api.get(`/service-fees/agreements/${id}/outstanding-periods`),
    settlePastMonths:      (id, data) => api.post(`/service-fees/agreements/${id}/settle`, data),
    overridePeriod:        (id, periodId, data) => api.patch(`/service-fees/agreements/${id}/periods/${periodId}/override`, data),
    // v1.54.0 — exclude/include a month (cancels the obligation
    // entirely, distinct from overridePeriod above which just changes
    // the amount owed)
    excludePeriod:         (id, periodId, data) => api.patch(`/service-fees/agreements/${id}/periods/${periodId}/exclude`, data),
    includePeriod:         (id, periodId, data) => api.patch(`/service-fees/agreements/${id}/periods/${periodId}/include`, data),
    getTreasuryStats:      () => api.get('/service-fees/stats'),

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

    // v1.53.0 — self-service payment requests (request payment for
    // any unpaid month(s), a lump sum if more than one)
    requestPayment:        (agreementId, data) => api.post(`/service-fees/agreements/${agreementId}/payment-requests`, data),
    getMyPaymentRequests:  () => api.get('/service-fees/my-payment-requests'),

    // v1.53.0 — Treasurer review of payment requests
    listPaymentRequests:   (params) => api.get('/service-fees/payment-requests', { params }),
    approvePaymentRequest: (id, data) => api.post(`/service-fees/payment-requests/${id}/approve`, data),
    rejectPaymentRequest:  (id, data) => api.post(`/service-fees/payment-requests/${id}/reject`, data),

    // v1.53.0 — self-service advances (recovered automatically from
    // future month(s) once confirmed received)
    requestAdvance:  (agreementId, data) => api.post(`/service-fees/agreements/${agreementId}/advances`, data),
    getMyAdvances:   () => api.get('/service-fees/my-advances'),

    // v1.53.0 — Treasurer review of advances
    listAdvances:              (params) => api.get('/service-fees/advances', { params }),
    getAdvanceRecoveryPreview: (id) => api.get(`/service-fees/advances/${id}/recovery-preview`),
    approveAdvance:            (id, data) => api.post(`/service-fees/advances/${id}/approve`, data),
    rejectAdvance:             (id, data) => api.post(`/service-fees/advances/${id}/reject`, data),
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
// SHARE CAPITAL (v1.69.0) — nominal value, whole-share allotments,
// members' share credit and refunds, returns of allotment, and
// dual-approved changes to the issue price / nominal value /
// registered shares.
// ============================================================
export const shareCapitalAPI = {
    getOverview:            ()           => api.get('/share-capital/overview'),
    getMyStatement:         ()           => api.get('/share-capital/me'),
    getMemberStatement:     (userId)     => api.get(`/share-capital/members/${userId}/statement`),
    getRegisteredSetup:     ()           => api.get('/share-capital/registered-setup'),
    saveRegisteredSetup:    (data)       => api.put('/share-capital/registered-setup', data),
    previewOpeningConversion: ()         => api.get('/share-capital/opening-conversion/preview'),
    runOpeningConversion:   ()           => api.post('/share-capital/opening-conversion'),
    getAllotments:          (params)     => api.get('/share-capital/allotments', { params }),
    markReturnsFiled:       (data)       => api.post('/share-capital/allotments/returns', data),
    getChangeRequests:      ()           => api.get('/share-capital/change-requests'),
    getResolutions:         ()           => api.get('/share-capital/resolutions'),
    createChangeRequest:    (data)       => api.post('/share-capital/change-requests', data),
    approveChangeRequest:   (id, data)   => api.post(`/share-capital/change-requests/${id}/approve`, data || {}),
    rejectChangeRequest:    (id, data)   => api.post(`/share-capital/change-requests/${id}/reject`, data || {}),
    cancelChangeRequest:    (id, data)   => api.post(`/share-capital/change-requests/${id}/cancel`, data || {}),
    getRefunds:             ()           => api.get('/share-capital/refunds'),
    createRefund:           (data)       => api.post('/share-capital/refunds', data),
    approveRefund:          (id, data)   => api.post(`/share-capital/refunds/${id}/approve`, data || {}),
    rejectRefund:           (id, data)   => api.post(`/share-capital/refunds/${id}/reject`, data || {}),
    cancelRefund:           (id, data)   => api.post(`/share-capital/refunds/${id}/cancel`, data || {}),
};

// ============================================================
// TAX (v1.70.0)
// Withholding tax (deducted from the company and withheld by it),
// corporate income tax years, payments to URA and deadlines.
// ============================================================
export const taxAPI = {
    getOverview:        ()           => api.get('/tax/overview'),
    getRegistration:    ()           => api.get('/tax/registration'),
    saveRegistration:   (data)       => api.put('/tax/registration', data),
    setAgentStatus:     (data)       => api.post('/tax/agent-status', data),
    getRates:           ()           => api.get('/tax/rates'),
    addRate:            (data)       => api.post('/tax/rates', data),
    getWithholdings:    (params)     => api.get('/tax/withholdings', { params }),
    previewWithholding: (params)     => api.get('/tax/withholding-preview', { params }),
    getRemittances:     ()           => api.get('/tax/remittances'),
    remitMonth:         (data)       => api.post('/tax/remittances', data),
    getAtSource:        (params)     => api.get('/tax/at-source', { params }),
    recordAtSource:     (data)       => api.post('/tax/at-source', data),
    updateAtSource:     (id, data)   => api.patch(`/tax/at-source/${id}`, data),
    getYears:           ()           => api.get('/tax/years'),
    getWorksheet:       (id)         => api.get(`/tax/years/${id}/worksheet`),
    updateYearOptions:  (id, data)   => api.patch(`/tax/years/${id}/options`, data),
    setProvisional:     (id, data)   => api.put(`/tax/years/${id}/provisional`, data),
    addAdjustment:      (id, data)   => api.post(`/tax/years/${id}/adjustments`, data),
    removeAdjustment:   (adjId)      => api.delete(`/tax/adjustments/${adjId}`),
    prepareYear:        (id)         => api.post(`/tax/years/${id}/prepare`),
    returnYear:         (id, data)   => api.post(`/tax/years/${id}/return`, data || {}),
    approveYear:        (id)         => api.post(`/tax/years/${id}/approve`),
    fileYear:           (id, data)   => api.post(`/tax/years/${id}/file`, data),
    recordPayment:      (data)       => api.post('/tax/payments', data),
    getCalendar:        ()           => api.get('/tax/calendar'),
    getMyWithholdings:  ()           => api.get('/tax/my-withholdings'),
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
    getFixed:   ()       => api.get('/exchange-rates/fixed'),   // v1.76.0 — company fixed-rate decisions
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