// ============================================================
// USER MANUAL — GENERAL CHAPTERS AND ROLES (v1.82.0)
//
// Requested: "update of the about page which should in detail describe
// the navigation (where to find what) and working of each feature, what
// it does, steps to follow when going through the features. This is what
// should be comprised in the downloadable manual in the about section."
//
// This file and manualModules.js are the ONE source of the manual. The
// About page, the downloadable PDF and the guided tours all read from
// here, so they can never say different things. When a page changes,
// change its text here.
//
// Shapes
//   chapter = { id, title, summary, auditor?: true (also shown to an
//               Auditor), sections: [section] }
//   section = { heading, text?: [paragraph], steps?: [step],
//               bullets?: [point], note?: 'a highlighted remark' }
// Plain text only (no HTML); "›" separates the parts of a menu path.
// ============================================================

export const GENERAL_CHAPTERS = [
    // --------------------------------------------------------
    {
        id: 'welcome',
        title: 'Welcome — what this system is for',
        auditor: true,
        summary: 'What the system does, how this manual is arranged and how to get help while you work.',
        sections: [
            {
                heading: 'What the system does',
                text: [
                    "This is the company's own management system. It keeps the company's records in one safe place: the money that comes in and goes out of every account and in every currency, the members and their shares, savings, side fund, deposits and fines, the investments, loans and grants, tax, meetings and resolutions, events and documents.",
                    'Every record gets its own unique reference and belongs to a category (for example INCOME › CAPITAL › CONTRIBUTION), so it can always be found again and the figures in one place always agree with the figures in another. Nothing that touches money is ever deleted: a mistake is corrected with a reversal that stays on record next to the original.',
                    'Not everybody sees everything. What you see depends on the role (or roles) an Admin has given you — this manual marks who can use each page.',
                ],
            },
            {
                heading: 'How this manual is arranged',
                bullets: [
                    'Part 1 — General: signing in, finding your way around the screen, references and categories, approvals, notifications, unfinished forms, documents and printing, security.',
                    'Part 2 — The pages, in the same order as the menu (Home, Money, Members\' funds, Investments, Compliance, Office, and your personal pages). For each page: where to find it, who can use it, what it does, its tabs, step-by-step instructions for the common tasks, the rules the system enforces, and tips.',
                    'Part 3 — Roles: what each role is for and which pages it uses.',
                    'Part 4 — Where to find what: a quick map from "I want to…" to the page and button.',
                ],
            },
            {
                heading: 'Help while you work',
                bullets: [
                    'Guided tour — a short walk around the screen, pointing at each part and explaining it. It starts by itself the first time you sign in. Take it again at any time: click your picture (top right) › Take the guided tour, or the question-mark (?) button in the top bar, or About › User manual › Take the guided tour.',
                    'Tour this page — on most pages, the (?) button or your picture › Tour this page walks you through that page\'s tabs and buttons.',
                    'Manual for this page — the (?) button › Manual for this page opens the right chapter of this manual.',
                    'Download the manual — About › Download manual saves this manual as a PDF: only the parts for your role, or the complete manual.',
                ],
            },
        ],
    },
    // --------------------------------------------------------
    {
        id: 'getting-in',
        title: 'Getting in: registering, signing in and staying safe',
        auditor: true,
        summary: 'Creating your account, confirming your email, waiting for your role, signing the Membership Agreement, signing in with two-factor authentication and resetting a forgotten password.',
        sections: [
            {
                heading: 'Create your account (Register)',
                steps: [
                    'Open the system\'s web address and click "Register here" under the sign-in box.',
                    'Fill in Personal Information: first and last name, email address, phone number, nationality, ID / passport number and the other details asked for.',
                    'Under Security, choose a password: at least 8 characters, with a capital letter, a number and a special character (for example ! or #).',
                    'Under Role Request (optional), pick the role you expect to have (for example Shareholder or Treasurer) and give a short reason. This is only a request — an Admin decides.',
                    'Click Create Account. You see "Registration Successful".',
                ],
            },
            {
                heading: 'Confirm your email address',
                steps: [
                    'Open the email the system sent you and click the confirmation link.',
                    'The link works for 24 hours. If it has expired, sign in and ask for a new one, or ask an Admin.',
                ],
            },
            {
                heading: 'Wait for your role',
                text: [
                    'Until an Admin gives you at least one role you see the "Waiting for approval" screen, which shows the role you requested. It checks again by itself every 30 seconds, so you do not need to refresh. You can also Log out and come back later.',
                    'An Admin gives roles under Office › Members › Role Requests (Approve) or with Manage Roles on your row.',
                ],
            },
            {
                heading: 'Sign the Membership Agreement (first time only)',
                steps: [
                    'After your first role is given, the system shows the Membership Agreement.',
                    'Draw your signature in the box with the mouse or your finger. It is saved straight away ("Signature saved") and is the same signature used later on documents you sign.',
                    'Read the agreement, tick "I have read and agree to the Membership Agreement above." and click Agree and continue.',
                    'You land on your Dashboard. The guided tour starts by itself the first time.',
                ],
            },
            {
                heading: 'Sign in',
                steps: [
                    'Enter your Email Address and Password and click Sign In.',
                    'If you have switched on two-factor authentication, the system asks for the 6-digit Authentication Code from your authenticator app. Type it in to finish.',
                    'Forgot your password? Click "Forgot password?" on the sign-in page, enter your email and follow the link that arrives. The link works for 1 hour.',
                ],
            },
            {
                heading: 'Staying safe',
                bullets: [
                    'Automatic sign-out: after 20 minutes without any mouse, keyboard, touch or scrolling, the system signs you out. Anything you were typing in a form is kept (see "Unfinished forms").',
                    'Switch on two-factor authentication: your picture › My profile › Security. Scan the code with an authenticator app (for example Google Authenticator) and type the 6-digit code to confirm.',
                    'Change your password or email address: your picture › My profile › Password & Email. A new email address only takes effect after you click the link sent to it.',
                    'Sign out on a shared computer: your picture › Sign out (or the red door icon at the bottom of the menu). Signing out yourself also removes the unfinished forms kept on that device (they stay in your account).',
                    'Maintenance: while an Admin is working on the system, members see a maintenance page instead of the system. Try again later.',
                ],
            },
        ],
    },
    // --------------------------------------------------------
    {
        id: 'layout',
        title: 'Finding your way around the screen',
        summary: 'The menu and its groups, shortcuts, the top bar (breadcrumb, search, balances, + New, light/dark, notifications, your profile menu) and the phone bottom bar.',
        sections: [
            {
                heading: 'The screen in three parts',
                bullets: [
                    'The menu (dark blue, on the left). On a phone or small tablet it is hidden: open it with the ☰ button at the top left or Menu on the bottom bar.',
                    'The top bar (white strip at the top): where you are, search, balances, + New, light/dark, notifications and your profile menu.',
                    'The page itself: a coloured band with the page title and its main buttons on the right, then (on most pages) a row of tabs, then the content.',
                ],
            },
            {
                heading: 'The menu',
                text: [
                    'Dashboard is always at the top. Below it are your SHORTCUTS and then the MENU, arranged in groups. Click a group to open it and see its pages; only one group is open at a time and the group of the page you are on opens by itself.',
                ],
                bullets: [
                    'Money — Accounts, Transactions, Transfers, Requisitions, Awaiting approval, Acknowledgements.',
                    "Members' funds — Savings, Side fund, Deposits, Fines, Share capital, Dividends, Capital goals.",
                    'Investments — Portfolio (investments, bonds, treasury bills, money market funds), Loans, Grants.',
                    'Compliance — Tax, Reports & ledger, External audit (Admin), Audit review (Directors and the Secretary).',
                    'Office — Events, Meetings & resolutions, Documents, Service fees, Members, Settings (Admin), About.',
                    'You only see the pages your role allows. If a page described in this manual is missing from your menu, your role does not include it — ask an Admin.',
                ],
            },
            {
                heading: 'Shortcuts (your pinned pages)',
                steps: [
                    'Click Edit beside SHORTCUTS. Every group opens and a ★ appears beside each page.',
                    'Click the ★ beside a page to pin it (up to 6). Click a gold ★ to unpin it.',
                    'Click Done. Your shortcuts are kept on this device for you.',
                ],
            },
            {
                heading: 'Bottom of the menu',
                bullets: [
                    'Your picture and name — opens My portfolio.',
                    'The red door icon — Log out (asks you to confirm).',
                    '« — shrink the menu to a narrow strip of icons (more room for the page). In the strip, click a group icon to see its pages; click » to widen it again.',
                    'The version number of the system.',
                ],
            },
            {
                heading: 'The top bar, left to right',
                bullets: [
                    'Breadcrumb — where you are, for example Money › Transactions or Investments › Portfolio › (an investment). Click an earlier step to go back up.',
                    'Search (or press Ctrl K, ⌘K on a Mac) — type part of a page name, a person, or a reference or Public ID to jump straight to it.',
                    'Balances — the live balance of every account (financial roles only).',
                    '+ New — "Create something new": quick links to the forms you are allowed to use (record a contribution or expense, transfer, requisition, convene a meeting, new event, upload or generate a document).',
                    'Sun / moon — switch between light and dark.',
                    '(?) Help — take the guided tour, tour this page, or open the manual for this page.',
                    'Bell — notifications: things waiting for you, approvals, events in the next 7 days and messages from the system. A red number means something new. "Mark all read" clears the dots.',
                    'Your picture — the profile menu: My profile, Unfinished forms, My portfolio, Take the guided tour, Tour this page, Appearance (Light / Dark / Same as my device) and Sign out.',
                ],
            },
            {
                heading: 'On a phone: the bottom bar',
                bullets: [
                    'Home — the Dashboard.',
                    'Shortcuts — your pinned pages.',
                    '+ (the round button) — the same "+ New" forms as on a computer.',
                    'Alerts — the notifications.',
                    'Menu — opens the full menu.',
                    'Wide tables scroll sideways: swipe them. A row of tabs that does not fit fades at the edge — swipe it to see the rest.',
                ],
            },
        ],
    },
    // --------------------------------------------------------
    {
        id: 'references',
        title: 'References, Public IDs and categories',
        auditor: true,
        summary: 'How every record is numbered and filed, so it can be found again and nothing is counted twice.',
        sections: [
            {
                heading: 'The reference',
                text: [
                    'Every record gets a reference the moment it is saved, in the form MODULE-CATEGORY-YEARMONTH-NUMBER, for example PA-CONTRIB-202606-00001 = the first contribution into the Primary Account in June 2026. The number restarts every month for each kind of record and two records can never get the same reference.',
                ],
            },
            {
                heading: 'The Public ID',
                text: [
                    'Next to the reference, every record also gets a short random Public ID of 10 letters and numbers (for example K7MQ2XRA9P). It is printed on receipts and certificates and can be typed into Search. Unlike the reference it does not reveal how many records exist, so it is the one to quote outside the company.',
                ],
            },
            {
                heading: 'Categories',
                text: [
                    'Every money entry, document and event is filed under a category trail such as INCOME › CAPITAL › CONTRIBUTION or EXPENSE › OPERATING › OFFICE. When a form asks for a Category, pick the most specific one that fits. The Admin keeps the list of categories under Settings › Categories.',
                ],
            },
        ],
    },
    // --------------------------------------------------------
    {
        id: 'approvals',
        title: 'Approvals and the "four eyes" rule',
        summary: 'Why most entries wait for a second person, where they wait, and who approves what.',
        sections: [
            {
                heading: 'The rule',
                text: [
                    'Anything that moves money, or changes what a member owns, needs a second person. The person who entered it, or the person who benefits from it, cannot approve it themselves. An Admin is the only exception to this, for emergencies.',
                ],
            },
            {
                heading: 'Where things wait',
                bullets: [
                    'Money › Awaiting approval — money entries recorded by anyone other than the Treasurer or an Admin are held here until the Treasurer or an Admin clicks "Approve and post". Only then do they reach the books.',
                    'Money › Transfers — Primary → operational transfers need one Treasurer approval; operational → Primary transfers need three different Directors.',
                    'Money › Requisitions › All Requests — the Treasurer or Assistant Treasurer approves and pays.',
                    'Members\' funds › Savings › Pending Approvals — deposits and pool inflows, approved by a Treasurer or Assistant Treasurer other than the one who recorded them.',
                    'Members\' funds › Share capital › Changes — two approvers plus a FINAL resolution.',
                    'Members\' funds › Dividends — declared by one Treasurer, "Approve and Pay" by a different one.',
                    'Members\' funds › Capital goals › Approvals — pledge payments.',
                    'Investments — new investments, loans and grants each have an Approve button for the approver.',
                    'Office › Events — "Approve & Send Notifications".',
                    'Office › Documents — Approve and Signatures; documents waiting for your signature are under "Pending My Signature".',
                ],
            },
            {
                heading: 'How you know',
                text: [
                    'Anything waiting for you shows on your Dashboard (Pending Approvals) and in the bell. You also receive an email for the important ones.',
                ],
            },
            {
                heading: 'Corrections are reversals',
                text: [
                    'A posted money entry is never edited or deleted. To correct one, open it (Money › Transactions), click "Request reversal" and give the reason. A different person approves the reversal ("Approve and post") or refuses it. The original and its reversal both stay on record and cancel each other out, then the correct entry is recorded afresh.',
                ],
            },
        ],
    },
    // --------------------------------------------------------
    {
        id: 'notifications',
        title: 'Notifications and emails',
        summary: 'The bell, the emails the system sends and the automatic monthly reports.',
        sections: [
            {
                heading: 'The bell',
                bullets: [
                    'Shows saved notifications (for example "your requisition was approved"), plus anything pending your approval and events in the next 7 days.',
                    'Click a notification to go straight to the record. Blue dot = not read yet. "Mark all read" clears them.',
                    'On a phone use Alerts on the bottom bar.',
                ],
            },
            {
                heading: 'Emails',
                bullets: [
                    'Approved events and meeting notices are emailed to the people chosen.',
                    'On the 1st of every month: the general financial report to the people prescribed (08:00), each member\'s own report (09:00) and certificates (10:00).',
                    'Changes that affect you (a role given, a fine, a dividend, a confirmation you need to give) are emailed as well as shown in the bell.',
                ],
            },
        ],
    },
    // --------------------------------------------------------
    {
        id: 'drafts',
        title: 'Unfinished forms — the system keeps what you type',
        summary: 'If the page refreshes, the internet drops, you are signed out or you press Back by mistake, your typing is not lost.',
        sections: [
            {
                heading: 'How it works',
                text: [
                    'While you fill in a form (requisitions, money entries, meetings and minutes, generated documents and others), what you type is kept on the device as you type and in your account every few seconds. When you open the same form again you see "Picked up where you left off …" with your typing already back in place.',
                ],
                bullets: [
                    'Start over — on that notice, throws the kept copy away and gives you an empty form.',
                    'Your picture › Unfinished forms — every form you started and did not submit: Open goes back to it, Discard throws it away.',
                    'When you submit the form, the kept copy is removed by itself.',
                    'Attached files cannot be kept — attach them again.',
                    'Nobody else can see your unfinished forms, not even an Admin.',
                ],
            },
        ],
    },
    // --------------------------------------------------------
    {
        id: 'viewer',
        title: 'Viewing, printing and saving documents as PDF',
        auditor: true,
        summary: 'The document viewer used everywhere for previews, receipts, statements and this manual.',
        sections: [
            {
                heading: 'The document viewer',
                text: [
                    'Every Preview, Print, Export and Download button opens the document viewer on top of the page. It shows the document exactly as it prints — letterhead, tables, signatures and stamps — shrunk to fit your screen. On a phone you can pinch to zoom.',
                ],
                steps: [
                    'Click Preview (or Print / Export) beside the record.',
                    'Read the document in the viewer. Uploaded PDFs are shown page by page, on phones too; pictures are shown as they are.',
                    'To keep it on a computer: Print / Save as PDF (choose "Save as PDF" as the printer) or Download PDF.',
                    'To keep it on a phone or tablet: Save as PDF — a real PDF file is made and saved in your Downloads; or the Share button to send it straight to WhatsApp, email or Files.',
                    'Word, Excel and other files that cannot be shown: Download, and they open in the right app.',
                    'Close the viewer with the ×, the Back button or the Escape key.',
                ],
            },
        ],
    },
    // --------------------------------------------------------
    {
        id: 'money-rules',
        title: 'How the money is kept straight',
        summary: 'The rules behind the figures: accounts, currencies, exchange rates, floor limits and the books.',
        sections: [
            {
                heading: 'The accounts',
                bullets: [
                    'Primary Account (Euros) — where shareholders\' capital contributions arrive. Each contribution records who paid, how much and when.',
                    'Operational (secondary) accounts, for example UGX — the accounts the company spends and invests from. More can be added (Money › Accounts › New Account).',
                    'Savings Account — holds members\' savings, separate from company money.',
                    'Money cannot be invested straight from the Primary Account: it is first transferred to an operational account.',
                ],
            },
            {
                heading: 'Exchange rates',
                text: [
                    'Every transfer between accounts in different currencies records the rate used, and every entry in a foreign currency also stores its value in the company\'s book currency (UGX), so totals in different currencies can always be added up and checked. The Treasurer keeps the reference rates under Money › Accounts › Set Rate.',
                ],
            },
            {
                heading: 'Floor limits',
                text: [
                    'An account can have a floor limit — a balance it may never go below. The Primary Account can still spend, but never below its floor. The floor can be changed once every six months (Money › Accounts › Update Floor Limit). The Savings Account never has one.',
                ],
            },
            {
                heading: 'The books (double entry)',
                text: [
                    'Behind the pages, every posted entry is also written to the general ledger as matching debits and credits. Compliance › Reports & ledger › Financial Statements shows the trial balance, balance sheet, income statement and cash flow built from it, and Records check confirms that every page agrees with the ledger.',
                ],
            },
        ],
    },
];

// ------------------------------------------------------------
// ROLES — what each role is for. `pages` are navigation ids from
// navConfig.js; what someone actually sees also depends on the
// permissions the Admin has ticked for that role (Settings › Roles).
// ------------------------------------------------------------
export const ROLES = [
    {
        role: 'Admin',
        color: 'red',
        summary: 'Runs the system: approves new members and gives roles, sets permissions, keeps the company settings, and can step in on any approval.',
        does: [
            'Approve role requests and manage each member\'s roles (Office › Members).',
            'Decide what each role may do (Settings › Roles).',
            'Company details, currencies, categories, signatories, stamps, integrations, fiscal quarters, capital goal rules, membership agreement, registration & tax, governance, maintenance (Settings).',
            'Set up external audits and give auditors their logins (Compliance › External audit).',
            'Can approve where a second person is normally needed (use sparingly — it is recorded).',
        ],
    },
    {
        role: 'Director',
        color: 'purple',
        summary: 'Oversees the company: approves transfers back into the Primary Account (three Directors), corporate tax, audit results and resolutions.',
        does: [
            'One of three Director approvals for a transfer from an operational account back to the Primary Account.',
            'Approve the corporate tax computation (Compliance › Tax › Corporate tax).',
            'Approve audit submissions together with the Secretary (Compliance › Audit review).',
            'Convene meetings, vote and sign resolutions (Office › Meetings & resolutions).',
            'Sees all company figures.',
        ],
    },
    {
        role: 'Treasurer',
        color: 'green',
        summary: 'Keeps the money: records and approves money entries, approves transfers and requisitions, declares dividends, keeps exchange rates and floor limits.',
        does: [
            'Record contributions and expenses; approve entries waiting in Awaiting approval.',
            'Approve Primary → operational transfers.',
            'Approve and pay requisitions; reverse a paid one when needed.',
            'Savings, side fund, deposits, fines, dividends, capital goals and service fee payments.',
            'Exchange rates, share price, floor limit; tax preparation; monthly reports.',
        ],
    },
    {
        role: 'Assistant Treasurer',
        color: 'emerald',
        summary: 'Helps the Treasurer: records money entries and approves the ones a different person recorded.',
        does: [
            'Record contributions, expenses, savings deposits and other entries.',
            'Approve savings deposits and requisitions recorded by someone else.',
            'Prepare tax records.',
        ],
    },
    {
        role: 'Secretary',
        color: 'blue',
        summary: 'Keeps the company records: meetings, minutes, resolutions, events and documents.',
        does: [
            'Convene meetings, issue notices, take the register of attendance and write the minutes.',
            'Keep the register of resolutions and file special resolutions with URSB.',
            'Events and documents; approve audit submissions together with a Director.',
        ],
    },
    {
        role: 'Assistant Secretary',
        color: 'sky',
        summary: 'Helps the Secretary with meetings, minutes, events and documents.',
        does: ['Convene meetings and write minutes.', 'Create events and upload or generate documents.'],
    },
    {
        role: 'Coordinator',
        color: 'amber',
        summary: 'Organises activities: events, requisitions for activities and the documents that go with them.',
        does: ['Create events and requisitions.', 'Upload documents.'],
    },
    {
        role: 'Shareholder',
        color: 'indigo',
        summary: 'A member who owns shares: sees their own shares, savings, dues, fines, dividends and the company\'s standing, and takes part in meetings and resolutions.',
        does: [
            'Own dashboard (My dashboard) and My portfolio.',
            'Confirm handouts, conversions and payments made to them; acknowledge contributions.',
            'Make requisitions (for example to have a contribution acknowledged).',
            'Attend meetings, vote and sign written resolutions.',
        ],
    },
    {
        role: 'Auditor',
        color: 'gray',
        summary: 'An outside auditor. Sees only the Audit page: the accounts and documents shared with their engagement, where they comment, upload their report and finish the audit.',
        does: ['Complete the auditor profile.', 'Review shared accounts and documents.', 'Add comments, upload report files, Finish Audit or Request More Time.'],
    },
    {
        role: 'Administrative Officer',
        color: 'slate',
        summary: 'Office support without access to the money pages: events, documents and the office pages their permissions allow.',
        does: ['Events and documents as permitted.', 'Does not see accounts, transactions, savings or other finance pages.'],
    },
];

// ------------------------------------------------------------
// Notes that matter when reading the manual (shown in the manual's
// "Before you start" box and in Part 3).
// ------------------------------------------------------------
export const PERMISSION_NOTE = 'What each role can do also depends on the permissions an Admin has ticked for it under Settings › Roles. A button described here that you do not see means your role has not been given that permission — ask an Admin.';
