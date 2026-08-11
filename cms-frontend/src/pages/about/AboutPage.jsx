// ============================================================
// ABOUT PAGE
// Company information, system manual, and role guide.
// ============================================================

import { useState, useEffect } from 'react';
import { usersAPI } from '../../api/endpoints';
import { useBranding } from '../../contexts/BrandingContext';
import { formatDate } from '../../utils/helpers';
import { systemManualTemplate, printDocument } from '../../utils/exportUtils';
import PageHeader from '../../components/common/PageHeader';
import {
    BuildingLibraryIcon,
    UserGroupIcon,
    BookOpenIcon,
    InformationCircleIcon,
    ChartPieIcon,
    ShieldCheckIcon,
    ArrowDownTrayIcon,
} from '@heroicons/react/24/outline';

// ============================================================
// MANUAL CONTENT — shared between the on-screen tabs and the
// downloadable manual (systemManualTemplate), so the two can never
// drift apart.
// ============================================================
const MANUAL_STEPS = [
    {
        step: '1',
        title: 'Getting Started',
        content: 'Register your account using the Register page. Provide your personal information and request a role. An administrator will review and assign your role. Once your email is verified and your role is assigned, you can log in and access the system.',
    },
    {
        step: '2',
        title: 'Dashboard',
        content: 'The dashboard shows a summary of company finances, upcoming events, and recent activity. Shareholders see their personal contribution summary and shareholding percentage. Administrators and Treasurers see the full financial overview, including the Savings pool balance and any Side Fund balance shown as its own figure.',
    },
    {
        step: '3',
        title: 'Accounts, Floor Limits & Transactions',
        content: 'The company has one Primary account, any number of Secondary operational accounts, and one dedicated Savings account. Any account (except Savings, which is always exempt) can have an editable floor limit set by the Treasurer/Assistant Treasurer, protecting a minimum balance it can never go below. Money flows in as contributions, moves between accounts via transfers, and every account\'s own transaction ledger records everything posted against it. All transactions are immutable — corrections are made through reversals only.',
    },
    {
        step: '4',
        title: 'Approvals',
        content: 'Many actions require approval. Transfers from Primary to Secondary require Treasurer approval. Secondary to Primary transfers require 3 Director approvals. Savings deposits and the Savings pool\'s non-member inflows both require sign-off from a Treasurer/Assistant Treasurer other than whoever recorded them. Grants, investments, and loans all have their own approval workflows. Pending approvals appear in the notification bell.',
    },
    {
        step: '5',
        title: 'References',
        content: 'Every record in the system gets a unique auto-generated reference number. References follow the format: MODULE-TYPE-YYYYMM-SEQUENCE. For example: PA-CONTRIB-202606-00001 is a contribution to the primary account in June 2026.',
    },
    {
        step: '6',
        title: 'Savings & Side Fund',
        content: 'Member savings deposits and handouts are always posted against the dedicated Savings account, never the Primary account, and go through Treasurer/Assistant Treasurer approval. The Savings pool can also receive a non-member "pool inflow" (e.g. profit from investing the fund), through the same approval pipeline. The optional Side Fund is a separate earmarked petty-cash-style pool living inside an existing account — funded by members\' monthly dues or a direct/batch top-up — and is always shown as its own figure, separate from that account\'s general balance.',
    },
    {
        step: '7',
        title: 'Loans',
        content: 'Loans received (company borrows) and loans given (company lends) each have a dedicated detail page — click a loan\'s party name from the Loans list to see its balance breakdown, repayment schedule, repayment history and charts. When repaying, use the "Pay off remaining balance" option to clear a loan to exactly zero in one step — it computes the exact amount owed (principal plus any accrued interest) automatically, which is the safest way to close a loan out.',
    },
    {
        step: '8',
        title: 'Documents',
        content: 'Upload files or generate documents from templates (meeting agendas/minutes). Every document — uploaded or generated — can be previewed and downloaded from the Documents page: uploaded PDFs/images open in a new tab, other file types download directly, and generated documents are re-rendered on demand so they can always be reproduced. The Company Archive stores foundational documents like registration papers, tax filings, and licenses permanently.',
    },
    {
        step: '9',
        title: 'Reports',
        content: 'Generate on-demand reports or view your personal financial summary. The system automatically sends monthly reports to all members on the 1st of each month. Treasurers and Admins can also send reports manually.',
    },
    {
        step: '10',
        title: 'Permissions Management',
        content: 'Admins manage exactly what each role can do from Settings > Roles — click the shield icon next to any role to see and grant/revoke its permissions directly, grouped by module. If an action\'s button doesn\'t appear for someone who should have access, this is almost always the fix: check the role has the relevant permission granted here.',
    },
    {
        step: '11',
        title: 'Security',
        content: 'Enable Two-Factor Authentication (2FA) from your Profile page for extra security. Passwords must be at least 8 characters and include uppercase, a number, and a special character. All actions are permanently recorded in the audit log.',
    },
];

const MODULE_GUIDE = [
    {
        module: 'Accounts',
        icon: '🏦',
        description: 'Manages the company\'s Primary, Secondary and Savings accounts. Any account except Savings can have a protected floor limit. Secondary accounts are used for operations; Savings holds only member savings and the pool\'s non-member inflows. Click any account tile to see its full transaction history and charts.',
    },
    {
        module: 'Transactions',
        icon: '💳',
        description: 'The complete financial ledger. Records contributions (money in), expenses (money out), and all other financial movements. Every transaction has a unique reference, category trail, and running balance. Transactions cannot be edited — only reversed.',
    },
    {
        module: 'Transfers',
        icon: '🔄',
        description: 'Moves money between accounts. Primary to Secondary transfers require Treasurer approval. Secondary to Primary transfers require 3 Director approvals. The Savings account can never take part in a transfer. Every transfer records the exchange rate at the time of transfer (locked to 1 when both accounts share the same currency).',
    },
    {
        module: 'Grants',
        icon: '🎁',
        description: 'Tracks grants received from government bodies, NGOs, or institutions. Grants can be conditional (with trackable conditions) or unconditional. Received in multiple tranches. Each tranche credits the designated account.',
    },
    {
        module: 'Loans',
        icon: '💰',
        description: 'Tracks loans received (company borrows) and loans given (company lends). Each loan has its own detail page with charts, a repayment schedule and full repayment history. Includes automatic overdue detection and a "pay off remaining balance" option that always clears a loan to exactly zero. Penalty rates apply after the due date and can be amended by the Treasurer.',
    },
    {
        module: 'Investments',
        icon: '📈',
        description: 'Portfolio management for company investments. Always funded from secondary accounts. Each investment can have multiple projects and milestones. Returns are tracked separately and ROI is calculated automatically.',
    },
    {
        module: 'Events',
        icon: '📅',
        description: 'Company event management — meetings, deadlines, and anniversaries. When an event is approved, email notifications are automatically sent to all designated recipients. Upcoming events appear in the notification bell.',
    },
    {
        module: 'Documents',
        icon: '📄',
        description: 'Company document library. Upload files or generate documents from templates. Every document can be previewed and downloaded. Documents go through a Draft → Final workflow. The Company Archive stores foundational documents permanently. Versions are tracked.',
    },
    {
        module: 'Dividends',
        icon: '💵',
        description: 'Declares and distributes profits to shareholders. The total amount is automatically split based on each shareholder\'s registered percentage. Authority payments to URA, URSB, banks and other regulatory bodies are also recorded here.',
    },
    {
        module: 'Savings',
        icon: '🏧',
        description: 'Personal savings accounts for shareholders, always held in the dedicated Savings account (never Primary). Deposits and handouts each go through Treasurer/Assistant Treasurer approval. The pool can also receive a non-member "other inflow" (e.g. investment profit), through the same approval pipeline — the Savings account never takes an expense.',
    },
    {
        module: 'Side Fund',
        icon: '🪙',
        description: 'An optional shared petty-cash-style pool living inside an existing account — funded by members\' monthly dues, or a direct/batch top-up not tied to any individual member. Its balance is always shown separately from that account\'s general balance, including on the Dashboard, while every contribution still appears in the parent account\'s own transaction ledger.',
    },
    {
        module: 'Reports',
        icon: '📊',
        description: 'General company reports and personal member reports. On-demand generation or automatic monthly distribution. Reports cover all financial activity — accounts, income, expenses, loans, grants, investments, and events.',
    },
    {
        module: 'Settings',
        icon: '⚙️',
        description: 'System configuration for Admins. Manage currencies, create and edit roles and their permissions (Settings > Roles > the shield icon), and organise the category hierarchy used across all modules. System roles cannot be modified.',
    },
];

const ROLE_GUIDE = [
    {
        role: 'Admin', color: 'red',
        description: 'Full system access and configuration',
        permissions: ['All permissions', 'User management', 'Role assignment', 'System settings', 'Audit log access'],
    },
    {
        role: 'Treasurer', color: 'blue',
        description: 'Financial oversight and approvals',
        permissions: ['Approve transfers', 'Approve loans', 'Approve savings & pool inflows', 'Set floor limits', 'Declare dividends', 'Amend rates', 'Send reports', 'View all finances'],
    },
    {
        role: 'Assistant Treasurer', color: 'blue',
        description: 'Shares the Treasurer\'s financial recording/approval duties',
        permissions: ['Record & approve savings', 'Record side fund payments', 'Set floor limits', 'Record repayments', 'View all finances'],
    },
    {
        role: 'Director', color: 'purple',
        description: 'Company director with approval powers',
        permissions: ['Approve S→P transfers', 'View all finances', 'Approve investments', 'Approve events', 'View reports'],
    },
    {
        role: 'Secretary', color: 'green',
        description: 'Events, documents and meeting management',
        permissions: ['Create events', 'Upload documents', 'Generate documents', 'Manage meetings', 'Record minutes'],
    },
    {
        role: 'Coordinator', color: 'yellow',
        description: 'Operational coordination and project tracking',
        permissions: ['Manage investments', 'Track projects', 'Manage milestones', 'View finances'],
    },
    {
        role: 'Shareholder', color: 'gray',
        description: 'Company shareholder with personal financial access',
        permissions: ['View own contributions', 'View own savings', 'Personal reports', 'View events', 'View documents'],
    },
];

// ============================================================
// SECTION COMPONENT
// ============================================================
const Section = ({ title, icon: Icon, children, gradient = false }) => (
    <div className={`card mb-6 ${gradient
        ? 'bg-gradient-to-r from-primary-900 to-primary-700 text-white border-0'
        : ''}`}>
        <div className="flex items-center gap-3 mb-4">
            <div className={`p-2 rounded-lg ${gradient
                ? 'bg-white bg-opacity-20'
                : 'bg-primary-50'}`}>
                <Icon className={`h-5 w-5 ${gradient
                    ? 'text-white'
                    : 'text-primary-700'}`} />
            </div>
            <h2 className={`text-lg font-bold ${gradient
                ? 'text-white'
                : 'text-gray-900'}`}>
                {title}
            </h2>
        </div>
        {children}
    </div>
);

// ============================================================
// ROLE GUIDE CARD
// ============================================================
const RoleCard = ({ role, color, permissions, description }) => {
    const colors = {
        blue:   { bg: 'bg-blue-50',   text: 'text-blue-700',   badge: 'bg-blue-100 text-blue-800' },
        green:  { bg: 'bg-green-50',  text: 'text-green-700',  badge: 'bg-green-100 text-green-800' },
        purple: { bg: 'bg-purple-50', text: 'text-purple-700', badge: 'bg-purple-100 text-purple-800' },
        yellow: { bg: 'bg-yellow-50', text: 'text-yellow-700', badge: 'bg-yellow-100 text-yellow-800' },
        red:    { bg: 'bg-red-50',    text: 'text-red-700',    badge: 'bg-red-100 text-red-800' },
        gray:   { bg: 'bg-gray-50',   text: 'text-gray-700',   badge: 'bg-gray-100 text-gray-800' },
    };
    const c = colors[color] || colors.gray;

    return (
        <div className={`rounded-xl p-4 ${c.bg} border border-opacity-20`}>
            <h4 className={`font-bold text-sm mb-1 ${c.text}`}>{role}</h4>
            <p className="text-xs text-gray-500 mb-3">{description}</p>
            <div className="flex flex-wrap gap-1">
                {permissions.map((p, i) => (
                    <span key={i} className={`text-xs px-2 py-0.5 rounded-full
                        font-medium ${c.badge}`}>
                        {p}
                    </span>
                ))}
            </div>
        </div>
    );
};

// ============================================================
// MAIN ABOUT PAGE
// ============================================================
const AboutPage = () => {
    const { branding } = useBranding();
    const [activeSection, setActiveSection] = useState('company');
    const [shareholding,  setShareholding]  = useState([]);
    const [directors,     setDirectors]     = useState([]);

    useEffect(() => {
        // Load shareholding data
        usersAPI.getShareholding()
            .then(res => setShareholding(res.data.data || []))
            .catch(() => {});

        // Load directors
        usersAPI.getAllUsers({ limit: 50 })
            .then(res => {
                const users = res.data.data || [];
                const dirs  = users.filter(u =>
                    (u.roles || []).some(r =>
                        (typeof r === 'object' ? r.name : r) === 'Director'
                    )
                );
                setDirectors(dirs);
            })
            .catch(() => {});
    }, []);

    const totalShareValue = shareholding.reduce(
        (sum, s) => sum + parseFloat(s.shares_held || 0), 0
    );

    const handleDownloadManual = () => {
        const html = systemManualTemplate({
            steps:   MANUAL_STEPS,
            modules: MODULE_GUIDE,
            roles:   ROLE_GUIDE,
        });
        printDocument(html, `${branding.company_name || 'Company'} — System Manual`);
    };

    const sections = [
        { key: 'company', label: 'Company Info',  icon: BuildingLibraryIcon },
        { key: 'manual',  label: 'System Manual', icon: BookOpenIcon },
        { key: 'roles',   label: 'Role Guide',    icon: UserGroupIcon },
        { key: 'modules', label: 'Modules Guide', icon: InformationCircleIcon },
    ];

    return (
        <div className="max-w-5xl">
            <PageHeader
                title="About & Manual"
                subtitle="Company information and system usage guide"
                actions={
                    <button
                        onClick={handleDownloadManual}
                        className="btn-primary flex items-center gap-2"
                    >
                        <ArrowDownTrayIcon className="h-4 w-4" />
                        Download Manual
                    </button>
                }
            />

            {/* Section Tabs */}
            <div className="flex gap-2 mb-6 flex-wrap">
                {sections.map(s => (
                    <button
                        key={s.key}
                        onClick={() => setActiveSection(s.key)}
                        className={`flex items-center gap-2 px-4 py-2 rounded-lg
                            text-sm font-medium transition-colors ${
                            activeSection === s.key
                                ? 'bg-primary-700 text-white'
                                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                        }`}
                    >
                        <s.icon className="h-4 w-4" />
                        {s.label}
                    </button>
                ))}
            </div>

            {/* COMPANY INFO SECTION */}
            {activeSection === 'company' && (
                <div>
                    {/* Company Header */}
                    <Section title="About the Company" icon={BuildingLibraryIcon} gradient>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <p className="text-primary-200 text-xs mb-1">Company Name</p>
                                <p className="font-bold text-lg">
                                    {branding.company_name}
                                </p>
                            </div>
                            <div>
                                <p className="text-primary-200 text-xs mb-1">Address</p>
                                <p className="font-medium">
                                    {branding.company_address || '—'}
                                </p>
                            </div>
                            <div className="sm:col-span-2">
                                <p className="text-primary-200 text-xs mb-1">Motto</p>
                                <p className="font-medium italic">
                                    {branding.motto || '— set one under Settings > Company —'}
                                </p>
                            </div>
                            <div className="sm:col-span-2">
                                <p className="text-primary-200 text-xs mb-1">System</p>
                                <p className="font-medium">
                                    Company Management System v{process.env.REACT_APP_VERSION || '1.9.0'}
                                </p>
                            </div>
                        </div>
                    </Section>

                    {/* Description */}
                    {branding.description && (
                        <Section title="Description" icon={InformationCircleIcon}>
                            <p className="text-sm text-gray-600 leading-relaxed">
                                {branding.description}
                            </p>
                        </Section>
                    )}

                    {/* Mission & Values */}
                    <Section title="Mission & Values" icon={ShieldCheckIcon}>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                            {[
                                { title: 'Mission', text: branding.mission },
                                { title: 'Vision',  text: branding.vision },
                                { title: 'Values',  text: branding.core_values },
                            ].map((item, i) => (
                                <div key={i} className="bg-gray-50 rounded-lg p-4">
                                    <p className="text-xs font-bold text-primary-700
                                        uppercase mb-2">{item.title}</p>
                                    <p className="text-sm text-gray-600">
                                        {item.text || `Not set yet — add this under Settings > Company.`}
                                    </p>
                                </div>
                            ))}
                        </div>
                    </Section>

                    {/* Directors */}
                    <Section title="Current Directors" icon={UserGroupIcon}>
                        {directors.length === 0 ? (
                            <p className="text-sm text-gray-400">
                                No directors found in the system.
                            </p>
                        ) : (
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                {directors.map((d, i) => (
                                    <div key={i} className="flex items-center gap-3
                                        p-3 bg-gray-50 rounded-lg">
                                        <div className="w-10 h-10 rounded-full
                                            bg-primary-700 flex items-center
                                            justify-center flex-shrink-0">
                                            <span className="text-white text-sm
                                                font-bold">
                                                {d.first_name?.[0]}{d.last_name?.[0]}
                                            </span>
                                        </div>
                                        <div>
                                            <p className="text-sm font-semibold
                                                text-gray-900">
                                                {d.first_name} {d.last_name}
                                            </p>
                                            <p className="text-xs text-gray-400">
                                                {(d.roles || []).map(r =>
                                                    typeof r === 'object' ? r.name : r
                                                ).join(', ')}
                                            </p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </Section>

                    {/* Shareholding */}
                    <Section title="Shareholding Structure" icon={ChartPieIcon}>
                        <div className="mb-3 flex items-center justify-between">
                            <p className="text-sm text-gray-500">
                                Total shares:{' '}
                                <span className="font-bold text-gray-900">
                                    {totalShareValue.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                                </span>
                            </p>
                        </div>
                        {shareholding.length === 0 ? (
                            <p className="text-sm text-gray-400">
                                No shareholding data available.
                            </p>
                        ) : (
                            <div className="space-y-2">
                                {shareholding.map((s, i) => (
                                    <div key={i} className="flex items-center gap-3">
                                        <div className="w-32 text-sm text-gray-700
                                            truncate font-medium">
                                            {s.first_name} {s.last_name}
                                        </div>
                                        <div className="flex-1 h-3 bg-gray-100
                                            rounded-full overflow-hidden">
                                            <div
                                                className="h-full rounded-full
                                                    bg-primary-600"
                                                style={{
                                                    width: `${s.percentage || 0}%`
                                                }}
                                            />
                                        </div>
                                        <div className="w-16 text-right text-sm
                                            font-bold text-primary-700">
                                            {s.percentage || 0}%
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </Section>
                </div>
            )}

            {/* SYSTEM MANUAL SECTION */}
            {activeSection === 'manual' && (
                <div>
                    <Section title="System Manual" icon={BookOpenIcon}>
                        <div className="space-y-6">
                            {MANUAL_STEPS.map((item, i) => (
                                <div key={i} className="flex gap-4">
                                    <div className="flex-shrink-0 w-8 h-8 rounded-full
                                        bg-primary-700 text-white flex items-center
                                        justify-center text-sm font-bold">
                                        {item.step}
                                    </div>
                                    <div>
                                        <h4 className="text-sm font-bold text-gray-900 mb-1">
                                            {item.title}
                                        </h4>
                                        <p className="text-sm text-gray-500 leading-relaxed">
                                            {item.content}
                                        </p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </Section>
                </div>
            )}

            {/* ROLES GUIDE SECTION */}
            {activeSection === 'roles' && (
                <div>
                    <Section title="Role Guide" icon={UserGroupIcon}>
                        <p className="text-sm text-gray-500 mb-4">
                            Each role in the system has specific permissions.
                            Roles are assigned by administrators.
                        </p>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            {ROLE_GUIDE.map((r, i) => (
                                <RoleCard key={i} {...r} />
                            ))}
                        </div>
                    </Section>
                </div>
            )}

            {/* MODULES GUIDE SECTION */}
            {activeSection === 'modules' && (
                <div>
                    <Section title="System Modules" icon={InformationCircleIcon}>
                        <div className="space-y-4">
                            {MODULE_GUIDE.map((item, i) => (
                                <div key={i} className="flex gap-4 p-4 bg-gray-50
                                    rounded-lg border border-gray-100">
                                    <span className="text-2xl flex-shrink-0">
                                        {item.icon}
                                    </span>
                                    <div>
                                        <h4 className="text-sm font-bold text-gray-900 mb-1">
                                            {item.module}
                                        </h4>
                                        <p className="text-sm text-gray-500 leading-relaxed">
                                            {item.description}
                                        </p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </Section>
                </div>
            )}
        </div>
    );
};

export default AboutPage;