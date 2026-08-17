// ============================================================
// APP.JS
// Main application router.
// ============================================================

import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from './contexts/AuthContext';
import { BrandingProvider } from './contexts/BrandingContext';
import ProtectedRoute from './components/layout/ProtectedRoute';
import AppLayout from './components/layout/AppLayout';

// Auth Pages
import LoginPage       from './pages/auth/LoginPage';
import RegisterPage    from './pages/auth/RegisterPage';
import ForgotPasswordPage from './pages/auth/ForgotPasswordPage';
import ResetPasswordPage  from './pages/auth/ResetPasswordPage';

// App Pages
import DashboardPage    from './pages/dashboard/DashboardPage';
import AccountsPage     from './pages/accounts/AccountsPage';
import TransactionsPage from './pages/transactions/TransactionsPage';
import TransfersPage    from './pages/transfers/TransfersPage';
import GrantsPage from './pages/grants/GrantsPage';
import LoansPage from './pages/loans/LoansPage';
import LoanDetailPage from './pages/loans/LoanDetailPage';
import InvestmentsPage from './pages/investments/InvestmentsPage';
import InvestmentDetailPage from './pages/investments/InvestmentDetailPage';
import MmfPage from './pages/mmf/MmfPage';
import MmfDetailPage from './pages/mmf/MmfDetailPage';
import ChartOfAccountsPage from './pages/reports/ChartOfAccountsPage';
import EventsPage from './pages/events/EventsPage';
import DocumentsPage from './pages/documents/DocumentsPage';
import ReportsPage from './pages/reports/ReportsPage';
import UsersPage from './pages/users/UsersPage';
import ProfilePage from './pages/profile/ProfilePage';
import GenerateDocumentPage from './pages/documents/GenerateDocumentPage';
import SettingsPage from './pages/settings/SettingsPage';
import VerifyEmailPage from './pages/auth/VerifyEmailPage';
import PendingApprovalPage from './pages/auth/PendingApprovalPage';
import ConsentPage from './pages/auth/ConsentPage';
import DividendsPage from './pages/dividends/DividendsPage';
import SavingsPage from './pages/savings/SavingsPage';
import SideFundPage from './pages/sideFund/SideFundPage';
import AboutPage from './pages/about/AboutPage';
import RequisitionsPage from './pages/requisitions/RequisitionsPage';
import ServiceFeesPage from './pages/serviceFees/ServiceFeesPage';
import AuditManagementPage from './pages/audit/AuditManagementPage';
import AuditorPortalPage from './pages/audit/AuditorPortalPage';
import AuditReviewPage from './pages/audit/AuditReviewPage';

const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            retry:                1,
            refetchOnWindowFocus: false,
            staleTime:            5 * 60 * 1000,
        },
    },
});

function App() {
    return (
        <QueryClientProvider client={queryClient}>
            <AuthProvider>
              <BrandingProvider>
                <BrowserRouter>
                    <Routes>
                        {/* Public routes */}
                        <Route path="/login"    element={<LoginPage />} />
                        <Route path="/register" element={<RegisterPage />} />
                        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
                        <Route path="/reset-password"  element={<ResetPasswordPage />} />
                        {/* Also public — was previously nested inside the protected
                            layout below, which meant an unauthenticated user
                            clicking their verification email link got bounced to
                            /login before ever reaching this page. */}
                        <Route path="/verify-email" element={<VerifyEmailPage />} />

                        {/* Protected, but deliberately OUTSIDE AppLayout — a
                            zero-role account has no Sidebar/TopBar to show.
                            AppLayout.jsx redirects here for any such account;
                            this route renders standalone, same shape as the
                            public auth pages above it. */}
                        <Route
                            path="/pending-approval"
                            element={
                                <ProtectedRoute>
                                    <PendingApprovalPage />
                                </ProtectedRoute>
                            }
                        />

                        {/* Same reasoning as /pending-approval above — a
                            role-assigned-but-not-yet-consented account has no
                            Sidebar/TopBar to show either, so this renders
                            standalone too, right after the pending-approval
                            step in the same onboarding chain (Section 4.29). */}
                        <Route
                            path="/consent"
                            element={
                                <ProtectedRoute>
                                    <ConsentPage />
                                </ProtectedRoute>
                            }
                        />

                        {/* Protected routes — all inside AppLayout */}
                        <Route
                            path="/"
                            element={
                                <ProtectedRoute>
                                    <AppLayout />
                                </ProtectedRoute>
                            }
                        >
                            <Route index element={<DashboardPage />} />
                            <Route path="accounts" element={<AccountsPage />} />
                            <Route path="transactions" element={<TransactionsPage />} />
                            <Route path="transfers" element={<TransfersPage />} />
                            <Route path="grants" element={<GrantsPage />} />
                            <Route path="loans" element={<LoansPage />} />
                            <Route path="loans/received/:id" element={<LoanDetailPage loanType="received" />} />
                            <Route path="loans/given/:id" element={<LoanDetailPage loanType="given" />} />
                            <Route path="investments" element={<InvestmentsPage />} />
                            <Route path="investments/:id" element={<InvestmentDetailPage />} />
                            <Route path="mmf" element={<MmfPage />} />
                            <Route path="mmf/:id" element={<MmfDetailPage />} />
                            <Route path="events" element={<EventsPage />} />
                            <Route path="documents/generate" element={<GenerateDocumentPage />} />
                            <Route path="documents" element={<DocumentsPage />} />
                            <Route path="reports" element={<ReportsPage />} />
                            <Route path="reports/chart-of-accounts" element={<ChartOfAccountsPage />} />
                            <Route path="users" element={<UsersPage />} />
                            <Route path="profile" element={<ProfilePage />} />
                            <Route path="settings" element={<SettingsPage />} />
                            <Route path="dividends" element={<DividendsPage />} />
                            <Route path="savings" element={<SavingsPage />} />
                            <Route path="side-fund" element={<SideFundPage />} />
                            <Route path="about" element={<AboutPage />} />
                            <Route path="requisitions" element={<RequisitionsPage />} />
                            <Route path="service-fees" element={<ServiceFeesPage />} />
                            <Route path="audit" element={
                                <ProtectedRoute requiredRole="Auditor">
                                    <AuditorPortalPage />
                                </ProtectedRoute>
                            } />
                            <Route path="audit-management" element={
                                <ProtectedRoute requiredRole="Admin">
                                    <AuditManagementPage />
                                </ProtectedRoute>
                            } />
                            <Route path="audit-review" element={
                                <ProtectedRoute requiredRole={['Director', 'Secretary']}>
                                    <AuditReviewPage />
                                </ProtectedRoute>
                            } />
                        </Route>

                        {/* Catch all */}
                        <Route path="*" element={<Navigate to="/" replace />} />
                    </Routes>
                </BrowserRouter>
              </BrandingProvider>
            </AuthProvider>
        </QueryClientProvider>
    );
}

export default App;