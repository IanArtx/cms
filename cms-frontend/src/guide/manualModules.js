// ============================================================
// USER MANUAL — THE PAGES (v1.82.0)
// One entry per page, in menu order. Read by the About page, the
// downloadable PDF and the "Tour this page" tours (see manualContent.js).
//
//   {
//     id, navId        — navConfig id the page's visibility follows
//                        (always: true = everyone signed in;
//                         auditorOnly: true = the Auditor's page)
//     group, title, path, where (how to get there), who (who uses it)
//     summary          — one line
//     purpose          — paragraphs: what it does
//     tabs             — [{ name, what }]
//     tasks            — [{ title, who?, steps: [] }]  step by step
//     rules, tips      — points
//     tour             — the page tour: [{ tab | button | target, title?, text }]
//                        target: 'title' | 'actions' | 'tabs'
//                        A step whose tab/button is not on the screen
//                        (the person's role does not have it) is skipped.
//     match            — extra paths (RegExp) the page tour also runs on
//     details          — detail pages under this page, same shape (title,
//                        match, purpose, tasks, tour)
//   }
// ============================================================

export const MODULE_GROUPS = [
    { id: 'home',        label: 'Home and your own pages' },
    { id: 'money',       label: 'Money' },
    { id: 'members',     label: "Members' funds" },
    { id: 'investments', label: 'Investments' },
    { id: 'compliance',  label: 'Compliance' },
    { id: 'office',      label: 'Office' },
];

export const MODULES = [
    // ========================================================
    // HOME
    // ========================================================
    {
        id: 'dashboard', navId: 'dashboard', group: 'home', title: 'Dashboard', path: '/',
        where: 'Menu › Dashboard (top of the menu), the company logo, or Home on the phone bottom bar.',
        who: 'Everyone. What it shows depends on your role.',
        summary: 'Your starting page: the company\'s standing at a glance and everything waiting for you.',
        purpose: [
            'The Dashboard is the first page after signing in. Financial roles see the company\'s balances and activity; a member who is only a Shareholder sees their own dashboard (their shares, contributions, dues and what is waiting for them).',
            'If you are a Shareholder and also hold another role, a "Which dashboard" switch at the top lets you choose My dashboard or Company dashboard.',
        ],
        tabs: [
            { name: 'Stat cards', what: 'Primary Account balance, the Savings pool (all member savings), the Side Fund balance and other headline figures.' },
            { name: 'Pending Approvals', what: 'Items waiting for your decision — click one to open it.' },
            { name: 'Meeting actions', what: 'Meetings you should confirm attendance for and resolutions waiting for your signature ("I\'m here in person", "Read and sign").' },
            { name: 'Capital goals', what: 'Progress of the active capital goals.' },
            { name: 'Money Owed To / By the Company', what: 'Loans received and given, grants still expected, side fund dues overdue, fines and service fees outstanding.' },
            { name: 'Recent Transactions, Upcoming Events, Investment Performance', what: 'The latest entries (View all opens Transactions), events in the next 30 days and how the investments are doing.' },
        ],
        tasks: [
            { title: 'Deal with something waiting for you', steps: ['Look at Pending Approvals (or the bell).', 'Click the item — its page opens on the record.', 'Approve, refuse or confirm it there.'] },
        ],
        tips: ['A red number on the bell means something new — it is the same list as Pending Approvals plus events and messages.'],
        tour: [
            { target: 'title', text: 'Your Dashboard — the first page after you sign in. The cards below change with your role.' },
            { button: 'My dashboard', title: 'Which dashboard', text: 'If you are a Shareholder with another role, switch here between your own figures and the company\'s.' },
        ],
    },
    {
        id: 'my-portfolio', always: true, group: 'home', title: 'My portfolio', path: '/portfolio',
        where: 'Click your picture or name at the bottom of the menu, or your picture (top right) › My portfolio.',
        who: 'Every member (their own). Admins and the Treasurer can open any member\'s portfolio from Office › Members › View Portfolio.',
        summary: 'Everything you hold in the company on one page, ready to print.',
        purpose: [
            'Shows your shares held and your percentage, their current value, everything you have contributed, your savings balance in each currency, side fund dues overdue, fines outstanding, your deposit balance, loans, roles held and your contribution history.',
        ],
        tasks: [
            { title: 'Print or save your statement', steps: ['Open My portfolio.', 'Click Print / Save as PDF.', 'In the viewer click Print and choose "Save as PDF".'] },
        ],
        tour: [
            { target: 'title', text: 'Your portfolio — shares, contributions, savings, dues, fines and deposits on one page.' },
            { button: 'Print / Save as PDF', text: 'Keep a copy as a PDF or print it.' },
        ],
    },
    {
        id: 'profile', always: true, group: 'home', title: 'My profile', path: '/profile',
        where: 'Your picture (top right) › My profile.',
        who: 'Everyone (their own).',
        summary: 'Your personal details, signature, password, email and two-factor security.',
        tabs: [
            { name: 'Summary', what: 'Your shareholding, share value, total contributions, amount due this period, banked credit, account status and certificates.' },
            { name: 'Personal Info', what: 'Name, phone, nationality, ID/passport, TIN (Uganda, 10 digits), tax residency, address and emergency contact. Click Edit to change them.' },
            { name: 'Signature', what: 'Draw your signature. It saves itself after every stroke and is used on documents you sign.' },
            { name: 'Password & Email', what: 'Change Password; Change Email Address (takes effect when you click the link sent to the new address).' },
            { name: 'Security', what: 'Two-factor authentication with an authenticator app.' },
        ],
        tasks: [
            { title: 'Change your photo', steps: ['On the Summary tab click Change photo.', 'Choose a picture, crop it and save. Remove avatar puts the initials back.'] },
            { title: 'Switch on two-factor authentication', steps: ['Open the Security tab.', 'Follow "Enable 2FA": scan the code with an authenticator app.', 'Type the 6-digit code from the app to confirm. From now on sign-in asks for a code.'] },
            { title: 'Change your password', steps: ['Open Password & Email.', 'Enter your current password, then the new one twice, and save.', 'Forgot your current password? Use "Forgot your current password?" to get a reset link by email.'] },
        ],
        rules: ['A TIN, when given, must be 10 digits. Tax residency decides the withholding tax on payments made to you.'],
        tour: [
            { tab: 'Summary', text: 'Your shares, contributions, what is due and your certificates.' },
            { tab: 'Personal Info', text: 'Your details — click Edit to change them. Keep your TIN and tax residency correct.' },
            { tab: 'Signature', text: 'Draw your signature; it is saved as you draw and used on documents you sign.' },
            { tab: 'Password & Email', text: 'Change your password or your email address.' },
            { tab: 'Security', text: 'Switch on two-factor authentication for extra protection.' },
        ],
    },
    {
        id: 'drafts', always: true, group: 'home', title: 'Unfinished forms', path: '/drafts',
        where: 'Your picture (top right) › Unfinished forms.',
        who: 'Everyone (their own only).',
        summary: 'Forms you started and did not submit, kept for you.',
        purpose: ['Lists each form you started (requisitions, money entries, meetings, minutes, generated documents …) with when it was last kept. See also Part 1, "Unfinished forms".'],
        tasks: [
            { title: 'Carry on with a form', steps: ['Click Open beside it.', 'The form opens with your typing back in place — finish it and submit.'] },
            { title: 'Throw one away', steps: ['Click Discard and confirm.'] },
        ],
        tour: [
            { target: 'title', text: 'Every form you started and did not submit. Open carries on; Discard throws it away.' },
        ],
    },

    // ========================================================
    // MONEY
    // ========================================================
    {
        id: 'accounts', navId: 'accounts', group: 'money', title: 'Accounts', path: '/accounts',
        where: 'Menu › Money › Accounts. Also: top bar › Balances › Open Accounts.',
        who: 'Financial roles. New accounts need the system configuration permission (Admin).',
        summary: 'The company\'s bank accounts, their balances, exchange rates, the share price and floor limits.',
        purpose: [
            'Shows each account — the Primary (Euro) account, the operational accounts (for example UGX) and the Savings account — with its current balance. Open an account to see its full ledger, inflows and outflows and a balance chart.',
            'Also where the Treasurer keeps the reference exchange rates, the share (issue) price and each account\'s floor limit.',
        ],
        tasks: [
            { title: 'Add an operational account in another currency', who: 'Admin', steps: ['Click New Account.', 'Choose its type (Secondary), currency, name, reference prefix and bank details (bank, branch, account number, SWIFT). Tick "No real bank behind it" for a virtual account.', 'Save. It appears in the list and in transfers.'] },
            { title: 'Set an exchange rate', who: 'Treasurer', steps: ['In Currency Exchange Rates click Set Rate.', 'Choose the currency, enter the rate and the date it applies from, and save. Market History keeps every rate.'] },
            { title: 'Set or propose the share price', who: 'Treasurer', steps: ['In the share price card click Set Price (the first time; every active shareholder is notified).', 'Once a price exists the button reads Propose a Change: enter the new price; it goes to Members\' funds › Share capital › Changes for approval.'] },
            { title: 'Update a floor limit', who: 'Treasurer / Assistant Treasurer', steps: ['Open the account.', 'Click Update Floor Limit, enter the new limit and a note.', 'The floor can be changed once every six months.'] },
            { title: 'Record money in or out of one account', who: 'Treasurer / Assistant Treasurer', steps: ['Open the account (Open — details and connected documents).', 'Click Record Inflow or Record Expense and fill in the form (see Transactions).'] },
        ],
        rules: [
            'The Primary Account receives shareholders\' contributions; money leaves it only by transfer to an operational account, or as spending that never takes it below its floor limit.',
            'The Savings Account never has a floor limit.',
        ],
        tour: [
            { target: 'title', text: 'Every company account and its live balance. Click an account to open its ledger.' },
            { button: 'New Account', text: 'Add another operational account or currency (Admin).' },
            { button: 'Set Rate', text: 'Keep the exchange rates used to value foreign-currency money.' },
            { button: 'Set Price', title: 'Share price', text: 'Set the share (issue) price. Every active shareholder is notified.' },
            { button: 'Propose a Change', title: 'Share price', text: 'Once a price is set, changes are proposed here and approved under Members\' funds › Share capital › Changes.' },
            { button: 'Record Inflow', text: 'Inside an open account: record money coming in.' },
            { button: 'Record Expense', text: 'Inside an open account: record money paid out.' },
            { button: 'Update Floor Limit', text: 'The lowest balance this account may reach — changeable once every six months.' },
        ],
    },
    {
        id: 'transactions', navId: 'transactions', group: 'money', title: 'Transactions', path: '/transactions',
        where: 'Menu › Money › Transactions. Quick: + New › Record a contribution / Record an expense.',
        who: 'Financial roles see it; the Treasurer and Assistant Treasurer record; reversals need a second person.',
        summary: 'Every money entry in every account: contributions, expenses, returns and their reversals.',
        purpose: [
            'The full ledger of all accounts with filters (account, category, type, dates, investment), search by reference or Public ID, CSV export and print.',
            'Entries recorded by anyone other than the Treasurer or an Admin wait in Awaiting approval before they reach the ledger.',
        ],
        tabs: [
            { name: 'Ledger', what: 'All posted entries, newest first. Click one to open it.' },
            { name: 'Reversal requests', what: 'Requests to cancel an entry, waiting for a second person.' },
        ],
        tasks: [
            {
                title: 'Record a shareholder\'s contribution', who: 'Treasurer / Assistant Treasurer',
                steps: [
                    'Click Record › Record Contribution (or + New › Record a contribution).',
                    'Choose the shareholder and the account (normally the Primary Account), and enter the amount, the date the money arrived (value date) and the category (INCOME › CAPITAL › CONTRIBUTION).',
                    'Add a description and save. The entry gets its reference, the shareholder is notified and their shareholding is updated.',
                ],
            },
            {
                title: 'Record an expense', who: 'Treasurer / Assistant Treasurer',
                steps: [
                    'Click Record › Record Expense (or + New › Record an expense).',
                    'Choose the account, amount, value date and the most specific expense category, and describe what it was for.',
                    'If it is for an investment, choose the investment so it is counted against it.',
                    'Save. The system refuses an expense that would take an account below its floor limit.',
                ],
            },
            { title: 'Connect a document (receipt, invoice) to an entry', steps: ['Open the entry.', 'Click Connect document and pick the document from the library (upload it first under Documents if needed).'] },
            {
                title: 'Correct a mistake (reversal)',
                steps: [
                    'Open the wrong entry and click Request reversal. Give the reason.',
                    'A different Treasurer, Assistant Treasurer or an Admin opens Reversal requests and clicks Approve and post (or Refuse). You can Withdraw your request while it waits.',
                    'Once approved, a reversing entry cancels the original. Record the correct entry afresh.',
                ],
            },
            { title: 'Export or print', steps: ['Set the filters you want.', 'Click Export CSV for a spreadsheet, or Print for a printable statement.'] },
        ],
        rules: [
            'Posted entries are never edited or deleted — only reversed.',
            'The person who asked for a reversal cannot approve it.',
            'Note: the Record button is shown to anyone with the transaction permission, but the system only accepts entries from the Treasurer or Assistant Treasurer.',
        ],
        tour: [
            { tab: 'Ledger', text: 'Every posted money entry. Use the filters and search to find one; click it to open it.' },
            { tab: 'Reversal requests', text: 'Requests to cancel an entry wait here for a second person to approve or refuse.' },
            { button: 'Record', text: 'Record a contribution or an expense (Treasurer and Assistant Treasurer).' },
            { button: 'Export CSV', text: 'Download the filtered list as a spreadsheet.' },
            { button: 'Print', text: 'A printable statement of the filtered entries.' },
        ],
    },
    {
        id: 'transfers', navId: 'transfers', group: 'money', title: 'Transfers', path: '/transfers',
        where: 'Menu › Money › Transfers. Quick: + New › Transfer between accounts.',
        who: 'Financial roles see it; the Treasurer starts transfers; approvals as below.',
        summary: 'Moving money between the Primary Account and the operational accounts, with the exchange rate.',
        purpose: ['Every transfer records the amount sent, the exchange rate, the amount received and any bank charges on either side, so the two accounts always agree.'],
        tasks: [
            {
                title: 'Move money from the Primary Account to an operational account', who: 'Treasurer',
                steps: [
                    'Click New Transfer.',
                    'From: the Primary Account. To: the operational account.',
                    'Enter the Amount Sent and the Exchange Rate the bank used; the amount received is worked out.',
                    'Enter the Sending Bank Charge and Receiving Bank Charge if any, the category and the value date, and a description.',
                    'Save. It waits for approval and only moves the money once approved.',
                ],
            },
            { title: 'Approve or reject a transfer', steps: ['Open the transfer from the list.', 'Click Approve, or Reject with a reason.'] },
        ],
        rules: [
            'Only Primary ↔ operational transfers are allowed.',
            'Primary → operational: one Treasurer approval.',
            'Operational → Primary: three different Directors must approve.',
            'The sending account may not go below its floor limit.',
        ],
        tour: [
            { button: 'New Transfer', text: 'Start a transfer: from, to, amount, exchange rate and bank charges.' },
            { target: 'title', text: 'Each transfer shows its status. Open one to Approve or Reject it.' },
        ],
    },
    {
        id: 'requisitions', navId: 'requisitions', group: 'money', title: 'Requisitions', path: '/requisitions',
        where: 'Menu › Money › Requisitions. Quick: + New › New requisition.',
        who: 'Any member can ask; the Treasurer or Assistant Treasurer approves and pays.',
        summary: 'Asking the company for money, or asking it to acknowledge money you paid.',
        purpose: ['Four kinds of request: Money Request (the company pays for something), Acknowledge My Contribution (you paid capital and want it recorded), Request Savings Deposit, and Acknowledge Side Fund Payment.'],
        tabs: [
            { name: 'My Requests', what: 'Your own requisitions and their status.' },
            { name: 'All Requests', what: 'Everyone\'s (Treasury) — where they are approved and paid.' },
        ],
        tasks: [
            {
                title: 'Ask for money',
                steps: [
                    'Click New Requisition and choose Money Request.',
                    'Enter the title, amount, currency, category and priority (Low, Normal, High, Urgent), and explain what it is for in Additional Details.',
                    'If the money is for one of the company\'s investments, tick "This money is for one of the company\'s investments", choose the investment and say what the money is for.',
                    'Attach the supporting documents (quotation, invoice). At least one supporting document is needed before it can be paid.',
                    'Submit. You are notified when it is approved, paid or rejected.',
                ],
            },
            { title: 'Have a payment you made acknowledged', steps: ['Click New Requisition and choose Acknowledge My Contribution (or Request Savings Deposit / Acknowledge Side Fund Payment).', 'Enter the amount, the date and the account you paid into ("Received Into Account"), and attach the bank slip.', 'Submit; the Treasurer checks it and records it.'] },
            { title: 'Approve and pay a requisition', who: 'Treasurer / Assistant Treasurer', steps: ['Open All Requests and click the requisition.', 'Check "Before it can be paid" — every point must be ticked (for example a document connected).', 'Click Approve & Pay and choose the account it is paid from; or Reject with a reason.'] },
            { title: 'Undo a paid requisition', who: 'Treasurer', steps: ['Open the paid requisition and click "Reverse this payment", giving the reason.'] },
        ],
        rules: ['You cannot approve your own requisition.', 'Approval is limited to the Treasurer and Assistant Treasurer.', 'Supporting documents are required before payment.'],
        tour: [
            { tab: 'My Requests', text: 'Your requisitions and where each one has got to.' },
            { tab: 'All Requests', text: 'Everyone\'s requisitions — the Treasury approves and pays from here.' },
            { button: 'New Requisition', text: 'Ask for money, or ask for a contribution, savings deposit or side fund payment to be acknowledged.' },
        ],
    },
    {
        id: 'money-approvals', navId: 'money-approvals', group: 'money', title: 'Awaiting approval', path: '/money-approvals',
        where: 'Menu › Money › Awaiting approval.',
        who: 'Anyone who records money (to follow their entries); the Treasurer or an Admin approves.',
        summary: 'Money entries held until the Treasurer or an Admin approves them.',
        purpose: ['When someone other than the Treasurer or an Admin records money (an expense, a repayment, a side fund expense …), the entry is held here and does not touch any balance until approved.'],
        tabs: [{ name: 'Waiting / Approved / Refused / Withdrawn / All', what: 'Filter chips at the top of the list.' }],
        tasks: [
            { title: 'Approve a held entry', who: 'Treasurer / Admin', steps: ['Open the Waiting list and read the entry.', 'Click Approve and post — it is now in the books — or Refuse entry with a reason.'] },
            { title: 'Take back your own entry', steps: ['Find it under Waiting and click Withdraw entry.'] },
        ],
        rules: ['The person who recorded the entry cannot approve it.'],
        tour: [
            { target: 'title', text: 'Money entries waiting for the Treasurer or an Admin. Nothing here has touched a balance yet.' },
            { button: 'Waiting', text: 'Filter by status: Waiting, Approved, Refused, Withdrawn or All.' },
        ],
    },
    {
        id: 'acknowledgements', navId: 'acknowledgements', group: 'money', title: 'Acknowledgements', path: '/payment-acknowledgements',
        where: 'Menu › Money › Acknowledgements.',
        who: 'Everyone confirms payments made to them; the Treasury records and gives final approval.',
        summary: 'Confirming that money really reached the person it was paid to.',
        tabs: [
            { name: 'My Acknowledgements', what: 'Payments the company made to you — Acknowledge (I received it) or Dispute.' },
            { name: 'All (Treasury)', what: 'Every acknowledgement; Final Approve, or Reopen a disputed one for the recipient.' },
            { name: 'Payment Confirmations', what: 'New Payment entries (for example mobile money) for the recipient to Confirm or Dispute; Cancel entry.' },
        ],
        tasks: [
            { title: 'Confirm a payment you received', steps: ['Open My Acknowledgements.', 'Check the amount and date, then click Acknowledge — or Dispute and say what is wrong.'] },
            { title: 'Record a payment for confirmation', who: 'Treasury', steps: ['Open Payment Confirmations and click New Payment.', 'Choose the person, account, category, provider (MTN, Airtel, Other) and amount, and save. The person is asked to confirm.'] },
        ],
        tour: [
            { tab: 'My Acknowledgements', text: 'Confirm (Acknowledge) or Dispute payments made to you.' },
            { tab: 'All (Treasury)', text: 'Treasury: give final approval or reopen a disputed one.' },
            { tab: 'Payment Confirmations', text: 'Payments recorded for the recipient to confirm.' },
        ],
    },

    // ========================================================
    // MEMBERS' FUNDS
    // ========================================================
    {
        id: 'savings', navId: 'savings', group: 'members', title: 'Savings', path: '/savings',
        where: "Menu › Members' funds › Savings.",
        who: 'Members see their own; the Treasurer and Assistant Treasurer manage and approve.',
        summary: 'Members\' personal savings, in one or more currencies, kept in the Savings Account.',
        tabs: [
            { name: 'My Savings', what: 'Your balance in each currency, deposits, handouts and conversions — and anything awaiting your confirmation.' },
            { name: 'Pending Approvals', what: 'Deposits and pool inflows waiting for a second Treasurer.' },
            { name: 'All Members', what: 'Every member\'s savings and all deposits, handouts and conversions.' },
        ],
        tasks: [
            { title: 'Record a savings deposit', who: 'Treasurer / Assistant Treasurer', steps: ['Click New Deposit.', 'Choose the member, currency, amount, date and category, and save.', 'A different Treasurer or Assistant Treasurer approves it under Pending Approvals.'] },
            { title: 'Pay out interest (a handout)', who: 'Treasury', steps: ['Click New Handout and enter the interest amount for each member.', '15% withholding tax is taken from the interest automatically.', 'Each member confirms it under My Savings ("Confirm I received this") or disputes it.'] },
            { title: 'Turn savings into capital', steps: ['Click Convert to Capital, choose the member and amount.', 'The member confirms ("Confirm — move this into my capital contributions").'] },
            { title: 'Change savings into another currency', steps: ['Click Convert Currency, enter the amount and rate.', 'The member confirms the conversion.'] },
            { title: 'Withdraw matured fixed-term savings', steps: ['On the matured savings click Withdraw and follow the form.'] },
            { title: 'Money earned by the savings pool itself', steps: ['Click Pool Inflow (for example interest the fund earned), choose the currency and amount; it needs approval like a deposit.'] },
        ],
        rules: ['Savings are always posted to the Savings Account, never to the Primary Account.', 'The person who recorded a deposit cannot approve it.', 'Interest settings (Settings) choose simple or compound interest and the period.'],
        tour: [
            { tab: 'My Savings', text: 'Your savings in every currency and anything waiting for your confirmation.' },
            { tab: 'Pending Approvals', text: 'Deposits waiting for a second Treasurer.' },
            { tab: 'All Members', text: 'Every member\'s savings, deposits and handouts.' },
            { button: 'New Deposit', text: 'Record a member\'s savings deposit.' },
            { button: 'New Handout', text: 'Pay interest out to members (15% withholding tax is taken).' },
            { button: 'Convert to Capital', text: 'Move savings into a member\'s capital contributions — the member confirms.' },
        ],
    },
    {
        id: 'side-fund', navId: 'side-fund', group: 'members', title: 'Side fund', path: '/side-fund',
        where: "Menu › Members' funds › Side fund.",
        who: 'Members see their dues; the Treasury records payments and expenses.',
        summary: 'A shared pool for day-to-day activities, funded by members\' monthly dues and kept inside another account.',
        tabs: [
            { name: 'My Dues', what: 'Your monthly dues, what you have paid and any banked credit.' },
            { name: 'All Members', what: 'Everyone\'s dues and arrears.' },
            { name: 'Spending History', what: 'What the fund has been spent on.' },
            { name: 'Member Credit', what: 'Members who paid ahead (credit used automatically on later months).' },
            { name: 'Member Overrides', what: 'A different monthly due for particular members.' },
            { name: 'Membership', what: 'Who is in the fund; Add to Side Fund or Remove (the payout goes to the member\'s savings).' },
        ],
        tasks: [
            { title: 'Record a member\'s payment', steps: ['Click Record Payment on the member (or Bulk Pay Dues for several members and months).', 'Enter the amount; it pays the oldest dues first and any extra is banked as credit for future months.'] },
            { title: 'Record spending from the fund', steps: ['Click Record Expense, choose the category and amount and describe it.'] },
            { title: 'Change the monthly due or switch the fund on', who: 'Treasury', steps: ['Click Settings: "Side fund active", the monthly due and the account it is held in.'] },
        ],
        rules: ['The side fund balance is always shown separately from the account that holds it.', 'Note: side fund payments are posted straight away, without a second-person approval step.'],
        tour: [
            { tab: 'My Dues', text: 'Your monthly dues and any credit you have.' },
            { tab: 'All Members', text: 'Everyone\'s dues and arrears.' },
            { tab: 'Spending History', text: 'What the fund was spent on.' },
            { button: 'Bulk Pay Dues', text: 'Record dues for several members and months at once.' },
            { button: 'Record Expense', text: 'Record spending from the fund.' },
        ],
    },
    {
        id: 'deposits', navId: 'deposits', group: 'members', title: 'Deposits', path: '/deposits',
        where: "Menu › Members' funds › Deposits.",
        who: 'Members see their own; the Treasury records.',
        summary: 'Each member\'s security deposit against the company target.',
        tabs: [
            { name: 'My Deposit', what: 'Your deposit balance, the company target and whether you are on target.' },
            { name: 'All Members', what: 'Every member\'s deposit and standing (On target, Below target, Excused).' },
        ],
        tasks: [
            { title: 'Record a deposit', steps: ['Click Record Deposit, choose the member, amount and account, and save.'] },
            { title: 'Excuse a member from the target', steps: ['On the member click Excuse and give the reason (Clear Excusal undoes it).'] },
            { title: 'Refund a member who leaves', steps: ['Click Exit Refund and choose the kind of exit.', 'Mutual agreement: 5% is deducted. Forced exit: a deduction of at least 50% (up to 100%) is entered.', 'The net amount is paid into the member\'s savings.'] },
        ],
        tour: [
            { target: 'title', text: 'Security deposits against the company target. The tabs appear once deposits are switched on (Settings on this page).' },
            { tab: 'My Deposit', text: 'Your deposit against the company target.' },
            { tab: 'All Members', text: 'Every member\'s deposit and standing.' },
            { button: 'Record Deposit', text: 'Record a member\'s deposit.' },
        ],
    },
    {
        id: 'fines', navId: 'fines', group: 'members', title: 'Fines', path: '/fines',
        where: "Menu › Members' funds › Fines.",
        who: 'Members see their own; the Treasury assigns and clears.',
        summary: 'Fines for late contributions, meeting violations and other breaches, and how they are paid.',
        tabs: [
            { name: 'My Fines', what: 'Your fines and what is outstanding.' },
            { name: 'All Fines', what: 'Everyone\'s fines.' },
        ],
        tasks: [
            { title: 'Assign a fine', steps: ['Click Assign Fine.', 'Choose the member and type: Contribution Failure (worked out as a percentage of what was missed), Meeting Violation or General; enter the details and save. The member is notified.'] },
            { title: 'Clear a paid fine', steps: ['Click Clear Fine, choose the account the money arrived in and the category.'] },
            { title: 'Pay fines from your savings', steps: ['Click Settle With My Savings, tick the fines and confirm.', 'The Treasury approves the settlement (Approve Settlement / Deny Settlement).'] },
        ],
        rules: ['A fine in a different currency from the savings cannot be settled from those savings.'],
        tour: [
            { tab: 'My Fines', text: 'Your fines and what you still owe.' },
            { tab: 'All Fines', text: 'Everyone\'s fines (Treasury).' },
            { button: 'Assign Fine', text: 'Fine a member.' },
            { button: 'Settle With My Savings', text: 'Pay your fines from your savings.' },
        ],
    },
    {
        id: 'share-capital', navId: 'share-capital', group: 'members', title: 'Share capital', path: '/share-capital',
        where: "Menu › Members' funds › Share capital.",
        who: 'Financial roles; changes need two approvers and a FINAL resolution.',
        summary: 'Nominal value, issue price, whole shares allotted to members, returns of allotment and shares registered with URSB.',
        tabs: [
            { name: 'Overview', what: 'Nominal value per share, issue price, shares in issue, members, and the opening conversion of contributions into whole shares.' },
            { name: 'My Shares', what: 'Your whole shares, your share credit (money not yet enough for a whole share) and your allotments.' },
            { name: 'Changes', what: 'Proposed changes to the share price or registered capital — two approvers plus a FINAL resolution from Documents.' },
            { name: 'Allotments & Returns', what: 'Shares allotted; the return of allotment must be filed with URSB within 60 days ("Mark … filed").' },
            { name: 'Registered (URSB)', what: 'Each shareholder\'s shares as registered with URSB, and any excess not yet registered.' },
            { name: 'Credit & Refunds', what: 'Members with share credit and refund requests.' },
        ],
        tasks: [
            { title: 'Propose a change', steps: ['Open Changes and click Propose a change.', 'Enter the new value (Use suggested gives the suggested issue price) and choose the FINAL resolution from Documents.', 'Two different approvers click Approve & apply.'] },
            { title: 'File returns of allotment', steps: ['Open Allotments & Returns.', 'Select the allotments filed (Select this month\'s unfiled), then mark them filed.'] },
            { title: 'Record shares registered with URSB', steps: ['Open Registered (URSB) and enter each member\'s registered shares from the URSB register once; filed returns add to them afterwards.'] },
        ],
        tour: [
            { tab: 'Overview', text: 'The share capital at a glance.' },
            { tab: 'My Shares', text: 'Your whole shares and share credit.' },
            { tab: 'Changes', text: 'Proposed changes, approved by two people with a FINAL resolution.' },
            { tab: 'Allotments & Returns', text: 'Allotments and their returns to URSB (within 60 days).' },
            { tab: 'Registered (URSB)', text: 'Shares registered with URSB for each member.' },
            { tab: 'Credit & Refunds', text: 'Share credit and refund requests.' },
        ],
    },
    {
        id: 'dividends', navId: 'dividends', group: 'members', title: 'Dividends', path: '/dividends',
        where: "Menu › Members' funds › Dividends.",
        who: 'People with full finance view; the Treasurer declares, a different Treasurer approves and pays.',
        summary: 'Sharing profit with shareholders, and payments to authorities.',
        tabs: [
            { name: 'Dividends', what: 'Declared dividends and each shareholder\'s share.' },
            { name: 'Authority Payments', what: 'Payments to authorities (for example URA) — Record Payment.' },
        ],
        tasks: [
            { title: 'Declare and pay a dividend', who: 'Treasurer', steps: ['Click Declare Dividend: total amount, period, account, category.', 'The system splits it by shareholding and takes 15% withholding tax from each share.', 'A different Treasurer clicks Approve and Pay. The net amount goes into each shareholder\'s savings and their certificate appears in My Documents.'] },
            { title: 'Record a payment to an authority', steps: ['Open Authority Payments and click Record Payment: payment type, authority reference, amount and account.'] },
        ],
        rules: ['Only the Treasurer can declare (an Admin sees the button but the system refuses).'],
        tour: [
            { tab: 'Dividends', text: 'Declared dividends and each shareholder\'s share.' },
            { tab: 'Authority Payments', text: 'Payments made to authorities.' },
            { button: 'Declare Dividend', text: 'Share out profit — 15% withholding tax is taken and the rest goes to savings.' },
        ],
    },
    {
        id: 'capital-goals', navId: 'capital-goals', group: 'members', title: 'Capital goals', path: '/capital-goals',
        where: "Menu › Members' funds › Capital goals.",
        who: 'Members pledge and pay; the Treasury creates goals and approves pledge payments.',
        summary: 'Raising a set amount of capital, month by month, with members\' pledges.',
        tabs: [
            { name: 'Overview', what: 'Active goals, what is open for your pledge, what was collected this month and what you still owe.' },
            { name: 'All goals', what: 'Every goal, past and present.' },
            { name: 'My pledges', what: 'Your pledges and what you still owe.' },
            { name: 'Approvals', what: 'Pledge payments waiting for approval, oldest first.' },
            { name: 'How it works', what: 'The rules explained, and where to change the fine rates or switch tracking off.' },
        ],
        tasks: [
            { title: 'Create a goal', who: 'Treasury', steps: ['Click New Goal: Primary (the year\'s general goal) or Secondary, target, currency, effective date.', 'Open the goal and click Activate Capital Calls to start the monthly calls.'] },
            { title: 'Pledge', steps: ['Open the goal (or Overview › Open for my pledge) and click Pledge.', 'Enter what you will pay and when.'] },
            { title: 'Approve a pledge payment', who: 'Treasury', steps: ['Open Approvals and approve the payment.'] },
        ],
        rules: ['Late payment fines: 5% within the grace period, 10% after it.'],
        tour: [
            { tab: 'Overview', text: 'Active goals and what is open for your pledge.' },
            { tab: 'My pledges', text: 'Your pledges and what you still owe.' },
            { tab: 'Approvals', text: 'Pledge payments waiting for approval.' },
            { tab: 'How it works', text: 'The rules, in plain words.' },
            { button: 'New Goal', text: 'Create a capital goal.' },
        ],
        details: [
            {
                id: 'capital-goal-detail', title: 'One capital goal', match: [/^\/capital-goals\/\d+/],
                tour: [
                    { target: 'title', text: 'One goal: target, collected so far, what is still to raise and who has pledged.' },
                    { button: 'Activate Capital Calls', text: 'Start the monthly capital calls for this goal.' },
                    { button: 'Pledge', text: 'Pledge what you will contribute.' },
                ],
            },
        ],
    },

    // ========================================================
    // INVESTMENTS
    // ========================================================
    {
        id: 'portfolio', navId: 'portfolio', group: 'investments', title: 'Investments portfolio', path: '/investments',
        where: 'Menu › Investments › Portfolio.',
        who: 'People with investment view; investment managers create; an approver approves.',
        summary: 'All investments — standard projects, bonds, treasury bills and money market funds — in one portfolio.',
        purpose: [
            'Shows total invested, total returns, overall return on investment and active investments, with charts. Each investment has its own page.',
            'Buying or expanding an investment is capital; its day-to-day running costs and income are "operational" and tracked in its operating budget.',
        ],
        tasks: [
            {
                title: 'Create an investment', steps: [
                    'Click New Investment and choose the type: Standard, Bond, T-Bill or MMF (cannot be changed later).',
                    'Fill in the name, provider, funding account, category, initial amount, dates and responsible person. For a bond: face value, coupon frequency (Monthly … Annually, or single payment at maturity), first coupon date and optional settlement value. For a treasury bill: when the tax is taken.',
                    'Optionally "Fund Now". Save; an approver clicks Approve before money moves.',
                ],
            },
        ],
        tour: [
            { target: 'title', text: 'The whole portfolio: invested, returns and return on investment. Click an investment to open it.' },
            { button: 'New Investment', text: 'Add a standard investment, bond, treasury bill or money market fund.' },
        ],
        match: [/^\/mmf\//],
        details: [
            {
                id: 'investment-detail', title: 'One investment', match: [/^\/investments\/\d+/],
                purpose: ['The investment\'s budget, spending, returns, return on investment and all its transactions.'],
                tasks: [
                    { title: 'Add capital to it', steps: ['Click Buy / Expand (capital), enter the amount and account.'] },
                    { title: 'Record income from it', steps: ['Click Record Return: type (dividend, profit share, capital gain, interest, rental, other), amount, any tax kept back (final or creditable) and the certificate number.'] },
                    { title: 'Record a running cost or income', steps: ['Click Record Operational Transaction and answer "What was it for?".'] },
                    { title: 'Bond coupons', steps: ['In Bond Coupon Schedule, Mark Paid or Record Actual Payment for each coupon.'] },
                    { title: 'Treasury bill maturity', steps: ['Click Record maturity on the treasury bill card.'] },
                    { title: 'Close the investment', steps: ['Click Terminate Investment, confirm the records are up to date, read the Termination Report and send it; an approver clicks Approve & Close Investment.'] },
                ],
                tour: [
                    { target: 'title', text: 'One investment: budget, spending, returns and its transactions.' },
                    { button: 'Buy / Expand (capital)', text: 'Put more capital into it.' },
                    { button: 'Record Return', text: 'Income from the investment, with any tax kept back.' },
                    { button: 'Record Operational Transaction', text: 'A running cost or income — tracked in its operating budget.' },
                    { button: 'Terminate Investment', text: 'Close it (three steps, then approval).' },
                ],
            },
            {
                id: 'mmf-detail', title: 'One money market fund', match: [/^\/mmf\/\d+/],
                tasks: [{ title: 'Money market fund entries', steps: ['Top Up adds money; Withdraw takes it out; Record Interest and Record Management Fee keep the balance matching the fund\'s statement.'] }],
                tour: [
                    { target: 'title', text: 'A money market fund: balance, money in and out, interest and fees.' },
                    { button: 'Top Up', text: 'Add money to the fund.' },
                    { button: 'Record Interest', text: 'Monthly interest from the fund statement.' },
                ],
            },
        ],
    },
    {
        id: 'loans', navId: 'loans', group: 'investments', title: 'Loans', path: '/loans',
        where: 'Menu › Investments › Loans.',
        who: 'People with loan view; repayments by those with the repayment permission; the Treasurer amends rates.',
        summary: 'Money the company borrowed and money it lent, with schedules, interest and repayments.',
        tabs: [
            { name: 'Loans Received', what: 'What the company owes.' },
            { name: 'Loans Given', what: 'What is owed to the company.' },
        ],
        tasks: [
            { title: 'Record a loan', steps: ['On the right tab create the loan: lender or borrower, amount, account, interest (simple or compound), disbursement date, instalments.', 'An approver approves it.'] },
            { title: 'Record a repayment', steps: ['Open the loan and record the repayment (loans received) or receipt (loans given). "Pay off remaining balance" fills in what is left.'] },
            { title: 'Change the penalty rate', who: 'Treasurer', steps: ['Open the loan and click Amend Rate.'] },
        ],
        rules: ['For a lender outside Uganda, 15% withholding tax is taken from the interest paid.'],
        tour: [
            { tab: 'Loans Received', text: 'What the company owes.' },
            { tab: 'Loans Given', text: 'What is owed to the company. Open a loan to see its schedule and record repayments.' },
        ],
        details: [{ id: 'loan-detail', title: 'One loan', match: [/^\/loans\/(received|given)\/\d+/], tour: [
            { target: 'title', text: 'One loan: outstanding principal and interest, schedule and repayments.' },
            { button: 'Amend Rate', text: 'Change the penalty rate (Treasurer).' },
        ] }],
    },
    {
        id: 'grants', navId: 'grants', group: 'investments', title: 'Grants', path: '/grants',
        where: 'Menu › Investments › Grants.',
        who: 'People with grant view; approvers approve.',
        summary: 'Grant money the company receives, its conditions and its tranches.',
        tasks: [
            { title: 'Record a grant', steps: ['Click New Grant: donor, amount, account, start and end dates; tick "This grant has conditions" and list them.', 'An approver clicks Approve.'] },
            { title: 'Record money received', steps: ['On the grant click + Tranche (Record Grant Tranche) and enter the amount received.'] },
        ],
        tour: [{ button: 'New Grant', text: 'Record a grant and its conditions; tranches are added as the money arrives.' }],
    },

    // ========================================================
    // COMPLIANCE
    // ========================================================
    {
        id: 'tax', navId: 'tax', group: 'compliance', title: 'Tax', path: '/tax',
        where: 'Menu › Compliance › Tax.',
        who: 'The Treasurer and Assistant Treasurer prepare; a Director approves; other members see "My withholding tax".',
        summary: 'Withholding tax both ways, payments to URA, corporate tax and the tax calendar.',
        tabs: [
            { name: 'Overview', what: 'What is owed to URA, deadlines coming up and totals for the year.' },
            { name: 'Deducted from us', what: 'Tax others withheld from the company\'s income (final or creditable), with certificates.' },
            { name: 'Withheld & returns', what: 'Tax the company withheld from payments it made, waiting to be paid to URA — Record payment with the PRN.' },
            { name: 'Corporate tax', what: 'The year\'s computation: Prepare (for approval) › Approve › Mark filed, plus provisional instalments.' },
            { name: 'Calendar', what: 'Every tax deadline.' },
            { name: 'Settings', what: 'Tax rates and their history.' },
        ],
        tasks: [
            { title: 'Pay withheld tax to URA', steps: ['Open Withheld & returns.', 'Select what is waiting to be paid and click Record payment: PRN, return reference, date and account.'] },
            { title: 'Corporate tax for a year', steps: ['Open Corporate tax; add back or deduct items, then Prepare for approval.', 'A Director clicks Approve (or Send back).', 'After filing, click Mark filed.'] },
        ],
        tour: [
            { tab: 'Overview', text: 'What is owed to URA and the next deadlines.' },
            { tab: 'Deducted from us', text: 'Tax withheld from the company\'s income.' },
            { tab: 'Withheld & returns', text: 'Tax the company withheld, and its payment to URA.' },
            { tab: 'Corporate tax', text: 'The yearly computation: prepare, approve, file.' },
            { tab: 'Calendar', text: 'All tax deadlines.' },
        ],
    },
    {
        id: 'reports', navId: 'reports', group: 'compliance', title: 'Reports & ledger', path: '/reports',
        where: 'Menu › Compliance › Reports & ledger.',
        who: 'Everyone except the Administrative Officer; the company-wide reports need financial access.',
        summary: 'The monthly reports, financial statements, chart of accounts and the records check.',
        tasks: [
            { title: 'See a month\'s report', steps: ['Choose the month and year.', 'Click General Report (the company) or My Report (your own).', 'Print it from the viewer.'] },
            { title: 'Send the monthly reports now', who: 'Treasury / Admin', steps: ['Click Send Monthly Reports and confirm. (They also go out by themselves on the 1st: general 08:00, personal 09:00.)'] },
            { title: 'Issue share certificates', steps: ['Click Issue Certificates (also automatic on the 1st at 10:00). Signing rounds are listed under Certificate Signing Rounds.'] },
            { title: 'Send an announcement', steps: ['Click Send Announcement: subject, message and an optional link.'] },
            { title: 'Financial statements', steps: ['Click Financial Statements: Trial Balance, General Ledger, Balance Sheet, Income Statement, Cash Flow Statement, FX & Revaluation (month-end closing) and Ledger Accounts.'] },
            { title: 'Check the records agree', steps: ['Click Records check: every account, investment and fund compared with the ledger. "Check again" re-runs it; anything with a difference is listed.'] },
        ],
        tour: [
            { button: 'General Report', text: 'The company report for the chosen month.' },
            { button: 'My Report', text: 'Your own report for the month.' },
            { button: 'Financial Statements', text: 'Trial balance, balance sheet, income statement, cash flow and more.' },
            { button: 'Chart of Accounts', text: 'A live snapshot of every money pool.' },
            { button: 'Records check', text: 'Confirms every page agrees with the ledger.' },
        ],
        details: [
            { id: 'ledger', title: 'Financial statements', match: [/^\/reports\/general-ledger/], tour: [
                { target: 'tabs', text: 'Trial Balance, General Ledger, Balance Sheet, Income Statement, Cash Flow Statement, FX & Revaluation and Ledger Accounts.' },
            ] },
        ],
    },
    {
        id: 'audit-management', navId: 'audit-management', group: 'compliance', title: 'External audit', path: '/audit-management',
        where: 'Menu › Compliance › External audit.',
        who: 'Admin.',
        summary: 'Setting up an audit and giving an outside auditor controlled access.',
        tasks: [
            { title: 'Start an audit', steps: ['Click New Engagement: description, period, accounts covered and when access expires.', 'Attach the auditor logins and share the documents they need ("Select a document to share…").', 'Revoke ends their access.'] },
        ],
        tour: [{ button: 'New Engagement', text: 'Start an audit and decide exactly what the auditor can see.' }],
    },
    {
        id: 'audit-review', navId: 'audit-review', group: 'compliance', title: 'Audit review', path: '/audit-review',
        where: 'Menu › Compliance › Audit review.',
        who: 'Directors and the Secretary.',
        summary: 'Approving what the auditor submitted and their requests for more time.',
        tabs: [
            { name: 'Submissions', what: 'Finished audits — a Director and the Secretary must both approve.' },
            { name: 'Extension Requests', what: 'Requests for more time.' },
        ],
        tasks: [{ title: 'Review a submission', steps: ['Open it, read the comments and files (Preview).', 'Click Approve, or Reject with a reason.'] }],
        tour: [
            { tab: 'Submissions', text: 'Audit submissions — a Director and the Secretary both approve.' },
            { tab: 'Extension Requests', text: 'Requests from the auditor for more time.' },
        ],
    },
    {
        id: 'audit-portal', auditorOnly: true, group: 'compliance', title: 'Auditor portal', path: '/audit',
        where: 'The only page an Auditor sees, straight after signing in.',
        who: 'Auditor.',
        summary: 'Where the outside auditor works.',
        tasks: [
            { title: 'Audit the company', steps: [
                'First time: complete your auditor profile (company name, initials, contact phone).',
                'Choose the engagement and account; review the transactions and the Shared Documents (Preview).',
                'Add comments; upload your report files.',
                'Click Finish Audit when done, or Request More Time (new access expiry date and reason).',
            ] },
        ],
        tour: [{ target: 'title', text: 'Your audit: the accounts and documents shared with you, your comments and report files.' }],
    },

    // ========================================================
    // OFFICE
    // ========================================================
    {
        id: 'events', navId: 'events', group: 'office', title: 'Events', path: '/events',
        where: 'Menu › Office › Events. Quick: + New › New event.',
        who: 'Everyone with event view; creators and approvers.',
        summary: 'The company calendar: meetings, deadlines and anniversaries, with email invitations.',
        tasks: [
            { title: 'Create an event', steps: [
                'Click New Event: title, type, category, date and time, end date, location, recurrence and description.',
                'Tick "This is an online event" to add a Google Meet link.',
                'Tick "Notify by email once approved" and choose who: Everyone, By role, or Individual selection.',
                'Save. An approver clicks Approve & Send Notifications — only then are the emails sent.',
            ] },
            { title: 'Change or finish an event', steps: ['Extend Event moves it to a new date; Mark as Completed when it has happened; Cancel Event if it will not.'] },
        ],
        tour: [
            { button: 'New Event', text: 'Create an event; once approved, the chosen people are emailed.' },
            { target: 'title', text: 'Open an event to approve it, extend it, mark it completed or cancel it.' },
        ],
    },
    {
        id: 'meetings', navId: 'meetings', group: 'office', title: 'Meetings & resolutions', path: '/meetings',
        where: 'Menu › Office › Meetings & resolutions. Quick: + New › Convene a meeting.',
        who: 'Directors, the Secretary and Assistant Secretary convene; shareholders and directors attend, vote and sign.',
        summary: 'AGMs, EGMs and board meetings from notice to minutes, and the register of resolutions.',
        tabs: [
            { name: 'Meetings', what: 'All meetings and their status.' },
            { name: 'Register of resolutions', what: 'Every resolution passed, with its signatures and URSB filing.' },
            { name: 'Rules & company details', what: 'Notice periods, quorum and the company details used on notices.' },
        ],
        tasks: [
            { title: 'Hold a meeting', steps: [
                'Click Convene a meeting: type (AGM, EGM, board), date, time, venue or online link, chairperson, secretary and agenda.',
                'Open it and click Issue the notice — everyone on the register is notified and emailed with the date, place and agenda.',
                'On the day click Open the meeting. Members confirm attendance with "I\'m here in person" or "I\'ve joined online"; the register of attendance fills itself.',
                'In Resolutions, Propose a resolution and Record the vote.',
                'Write the Minutes (opening, declarations, discussion, decisions, action points, next meeting) — they are kept as you type.',
                'Click Close the meeting with the time it closed.',
            ] },
            { title: 'Pass a written resolution (no meeting)', steps: ['Click New written resolution, write it and send it.', 'Each member opens it ("Read and sign") and signs.'] },
        ],
        rules: ['A special resolution must be filed with URSB — you are reminded and it is tracked in the register.'],
        tour: [
            { tab: 'Meetings', text: 'Every meeting and its status.' },
            { tab: 'Register of resolutions', text: 'All resolutions with signatures and filing.' },
            { tab: 'Rules & company details', text: 'Notice periods and quorum.' },
            { button: 'Convene a meeting', text: 'Call an AGM, EGM or board meeting.' },
            { button: 'New written resolution', text: 'A resolution signed without a meeting.' },
        ],
        details: [
            { id: 'meeting-detail', title: 'One meeting', match: [/^\/meetings\/\d+/], tour: [
                { tab: 'Details & notice', text: 'Date, venue, agenda, quorum and the notice.' },
                { tab: 'Attendance', text: 'The register of attendance.' },
                { tab: 'Resolutions', text: 'Propose resolutions and record the votes.' },
                { tab: 'Minutes', text: 'Write the minutes — kept as you type.' },
                { tab: 'Documents', text: 'Notice, proxy form, register and minutes as documents.' },
                { button: 'Issue the notice', text: 'Send the notice to everyone on the register.' },
            ] },
        ],
    },
    {
        id: 'documents', navId: 'documents', group: 'office', title: 'Documents', path: '/documents',
        where: 'Menu › Office › Documents. Quick: + New › Upload a document / Generate a document.',
        who: 'Everyone with document view; uploading and generating by permission; approvals and signatures by the chosen signatories.',
        summary: 'The company library: uploaded files and documents generated from templates, by category.',
        tabs: [
            { name: 'Library', what: 'A tile for every category (Financial, Corporate, Legal, Agreements …) and the other places. Click a tile to open that category\'s own page with its sub-categories.' },
            { name: 'All Documents', what: 'One list of every document with filters (type, Draft/Final, status, category).' },
            { name: 'Company Archive', what: 'Foundational documents (registration, tax filings, MOU & MOA, licences …) and archived documents.' },
            { name: 'Pending My Signature', what: 'Documents and share certificates waiting for your signature.' },
            { name: 'My Documents', what: 'Your own share purchase receipts and certificates.' },
            { name: 'Shareholding Receipts', what: 'Every member\'s receipts (Treasury).' },
        ],
        tasks: [
            { title: 'Upload a document', steps: ['Click Upload (or Upload here inside a category).', 'Choose the file, title, category and Draft or Final, and save.'] },
            { title: 'Generate a document from a template', steps: ['Click Generate.', 'Select Template (meeting agenda, minutes, receipt, board resolution …) › fill in Details › Content › Preview.', 'Click Confirm & Save to Library (or Print / Save as PDF).'] },
            { title: 'Approve and sign', steps: ['Approve on the document row; signatories sign from Pending My Signature. When fully signed, the company stamp is applied.'] },
            { title: 'Archive and take out again', steps: ['Archive moves a document into the Company Archive.', 'Take out of the archive puts it back among the regular documents, as it was before.'] },
            { title: 'Give a staff member access to one document', steps: ['Click Grant staff access on the row and choose the person (Revoke access to remove it).'] },
        ],
        tour: [
            { tab: 'Library', text: 'Tiles for every category — click one to open its own page.' },
            { tab: 'All Documents', text: 'Every document in one list with filters.' },
            { tab: 'Company Archive', text: 'Foundational and archived documents.' },
            { tab: 'Pending My Signature', text: 'What is waiting for your signature.' },
            { tab: 'My Documents', text: 'Your receipts and certificates.' },
            { button: 'Upload', text: 'Add a file to the library.' },
            { button: 'Generate', text: 'Create a document from a template.' },
        ],
        details: [
            { id: 'document-category', title: 'One category', match: [/^\/documents\/category\/\d+/], tour: [
                { target: 'title', text: 'One category: its sub-categories as tiles and its documents.' },
                { button: 'Upload here', text: 'Upload straight into this category.' },
            ] },
            { id: 'generate', title: 'Generate a document', match: [/^\/documents\/generate/], tour: [
                { target: 'title', text: 'Choose a template, fill in the details and content, preview, then save it to the library.' },
            ] },
        ],
    },
    {
        id: 'service-fees', navId: 'service-fees', group: 'office', title: 'Service fees', path: '/service-fees',
        where: 'Menu › Office › Service fees.',
        who: 'Contracted people see their own; the Treasury manages agreements and payments.',
        summary: 'Monthly fees for contracted staff, advances and expense reimbursements.',
        tabs: [
            { name: 'My Service Fee', what: 'Your agreement, payment history, unpaid months; Request Payment, Request Advance, Request Reimbursement.' },
            { name: 'Agreements', what: 'Every agreement (New Agreement, Amend Agreement, Terminate Agreement).' },
            { name: 'Treasury Overview', what: 'Paid and outstanding by person.' },
            { name: 'Reimbursement Requests', what: 'Requests to approve or reject.' },
        ],
        tasks: [
            { title: 'Set up an agreement', who: 'Treasury', steps: ['Click New Agreement: contracted person, monthly fee, account, start date and payment day.'] },
            { title: 'Pay a fee', who: 'Treasury', steps: ['On the agreement click Record Payment (Settle Past Months for arrears).'] },
            { title: 'Ask to be reimbursed', steps: ['Click Request Reimbursement, enter the amount and attach the receipt.'] },
        ],
        tour: [
            { tab: 'My Service Fee', text: 'Your agreement, payments and requests.' },
            { tab: 'Agreements', text: 'All agreements (Treasury).' },
            { tab: 'Treasury Overview', text: 'Paid versus outstanding.' },
            { button: 'Request Reimbursement', text: 'Claim back money you spent for the company.' },
        ],
    },
    {
        id: 'members', navId: 'members', group: 'office', title: 'Members', path: '/users',
        where: 'Menu › Office › Members.',
        who: 'Admins (and others with the members permission).',
        summary: 'Everyone with an account, their roles and their access.',
        tabs: [
            { name: 'Members', what: 'Every account: name, email, roles, status.' },
            { name: 'Role Requests', what: 'Roles people asked for when registering — Approve.' },
        ],
        tasks: [
            { title: 'Approve a new member', steps: ['Open Role Requests and click Approve (or open Manage Roles to give a different role).'] },
            { title: 'Give or remove a role', steps: ['On the member\'s row click Manage Roles.', 'Assign New Role, or Remove beside a current role.'] },
            { title: 'Other actions', steps: ['View Portfolio; Change Email (Admin); Deactivate (blocks sign-in, keeps the records); Delete Permanently (only for an account with no activity).'] },
        ],
        tour: [
            { tab: 'Members', text: 'Every account. Use the row buttons to manage roles, view a portfolio or deactivate.' },
            { tab: 'Role Requests', text: 'New members waiting for their role.' },
        ],
    },
    {
        id: 'settings', navId: 'settings', group: 'office', title: 'Settings', path: '/settings',
        where: 'Menu › Office › Settings.',
        who: 'Admin.',
        summary: 'Everything that configures the system.',
        tabs: [
            { name: 'Company', what: 'Name, logo, address, motto, mission, vision and values (also used on documents and the app icon).' },
            { name: 'Currencies', what: 'Currencies in use.' },
            { name: 'Roles', what: 'Which permissions each role has — tick and save.' },
            { name: 'Categories', what: 'The category trees for money, documents and events.' },
            { name: 'Signatories', what: 'Who signs which kind of document.' },
            { name: 'Stamps', what: 'Company stamps applied to fully signed documents.' },
            { name: 'Integrations', what: 'Email and Google Calendar / Meet.' },
            { name: 'Fiscal Quarters', what: 'The financial year and its quarters.' },
            { name: 'Capital Goals', what: 'Tracking on/off and late fine rates.' },
            { name: 'Membership Agreement', what: 'The agreement every member signs.' },
            { name: 'Registration & Tax', what: 'TIN, URSB number, incorporation date, tax office, withholding agent status.' },
            { name: 'Governance', what: 'Meeting and resolution rules.' },
            { name: 'Maintenance', what: 'Switch maintenance mode on or off.' },
        ],
        tasks: [
            { title: 'Give a role a permission', steps: ['Open Roles, choose the role, tick the permissions and save. Members with that role see the change after their next sign-in or page refresh.'] },
        ],
        tour: [
            { tab: 'Company', text: 'Company details, logo and letterhead.' },
            { tab: 'Roles', text: 'What each role may do — this decides which pages and buttons people see.' },
            { tab: 'Categories', text: 'The category trees used everywhere.' },
            { tab: 'Maintenance', text: 'Take the system offline for maintenance.' },
        ],
    },
    {
        id: 'about', navId: 'about', group: 'office', title: 'About & manual', path: '/about',
        where: 'Menu › Office › About.',
        who: 'Everyone.',
        summary: 'Company information, this manual, where to find what, the roles, and the PDF download.',
        tasks: [
            { title: 'Download the manual', steps: ['Click Download manual.', 'Choose "For my role" (only what you can use) or "Complete manual (all roles)".', 'In the viewer click Print and choose "Save as PDF".'] },
        ],
        tour: [
            { target: 'tabs', text: 'Company Info, the User manual, Where to find what, and Roles.' },
            { button: 'Download manual', text: 'Save this manual as a PDF — for your role or complete.' },
            { button: 'Take the guided tour', text: 'Walk around the screen again at any time.' },
        ],
    },
];
