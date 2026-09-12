-- ============================================================
-- MIGRATION v1.55.0 — Chart of Accounts / General Ledger foundation
-- for the new professional accounting reports suite (Trial Balance,
-- General Ledger, Balance Sheet, Income Statement, Cash Flow
-- Statement). See schema.sql's own "GROUP: CHART OF ACCOUNTS /
-- GENERAL LEDGER (v1.55.0)" header comment for the full design
-- rationale — this migration creates exactly the same two tables and
-- seeds exactly the same data, for upgrading an existing database.
--
-- Idempotent — safe to run against a database that already has some
-- or all of this applied (ON CONFLICT DO NOTHING throughout).
-- ============================================================

CREATE TABLE IF NOT EXISTS gl_accounts (
    id                 SERIAL PRIMARY KEY,
    code               VARCHAR(10)   NOT NULL UNIQUE,
    name               VARCHAR(150)  NOT NULL,
    account_type       VARCHAR(20)   NOT NULL
                       CHECK (account_type IN ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE')),
    normal_balance     VARCHAR(10)   NOT NULL
                       CHECK (normal_balance IN ('DEBIT', 'CREDIT')),
    statement_section  VARCHAR(50)   NOT NULL,
    cash_flow_category VARCHAR(20)   NOT NULL DEFAULT 'OPERATING'
                       CHECK (cash_flow_category IN ('OPERATING', 'INVESTING', 'FINANCING', 'EXCLUDED')),
    description        TEXT,
    display_order       INTEGER      NOT NULL DEFAULT 0,
    is_active          BOOLEAN       NOT NULL DEFAULT TRUE,
    created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS gl_inflow_type_mapping (
    id             SERIAL PRIMARY KEY,
    inflow_type    VARCHAR(30)   NOT NULL UNIQUE,
    gl_account_id  INTEGER       NOT NULL REFERENCES gl_accounts(id),
    notes          TEXT,
    updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_by     INTEGER REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_gl_inflow_type_mapping_account ON gl_inflow_type_mapping (gl_account_id);

INSERT INTO gl_accounts (code, name, account_type, normal_balance, statement_section, cash_flow_category, description, display_order) VALUES
    ('1000', 'Cash and Bank',                    'ASSET',     'DEBIT',  'CASH_AND_BANK', 'EXCLUDED',  'The real ledger balance of every Primary/Secondary/Savings account — this IS the cash position, never itself a cash flow line.', 100),
    ('1050', 'Inter-Account Transfers (Cash)',    'ASSET',     'DEBIT',  'CASH_AND_BANK', 'EXCLUDED',  'The clearing side of a transfer between the club''s own accounts. Always nets to zero company-wide — a non-zero total here would mean a transfer''s two legs don''t match.', 110),
    ('1100', 'Loans Receivable (Given)',          'ASSET',     'DEBIT',  'RECEIVABLES',   'INVESTING', 'Principal outstanding on loans the club has given to members/borrowers.', 200),
    ('1200', 'Service Fee Advances Receivable',   'ASSET',     'DEBIT',  'RECEIVABLES',   'OPERATING', 'Advances paid to contracted staff against future service fee months, net of amounts already recovered.', 210),
    ('1300', 'Money Market Fund Investments',     'ASSET',     'DEBIT',  'INVESTMENTS',   'INVESTING', 'Club funds placed into a Money Market Fund.', 300),
    ('1400', 'Other Investments (Projects & Bonds)', 'ASSET',  'DEBIT',  'INVESTMENTS',   'INVESTING', 'Capital deployed into project/bond investments. Reclassified out of the generic Operating Expenses bucket for any transaction linked to an investment record.', 310),
    ('2000', 'Loans Payable (Received)',          'LIABILITY', 'CREDIT', 'LIABILITIES',   'FINANCING', 'Principal outstanding on loans the club has borrowed from external lenders.', 400),
    ('2100', 'Member Savings Payable',             'LIABILITY', 'CREDIT', 'LIABILITIES',   'FINANCING', 'Member savings balances — money the club holds and owes back to members on request.', 410),
    ('2200', 'Member Deposits Payable',            'LIABILITY', 'CREDIT', 'LIABILITIES',   'FINANCING', 'Refundable member deposits.', 420),
    ('2300', 'Deferred Grant Income',              'LIABILITY', 'CREDIT', 'LIABILITIES',   'FINANCING', 'Grant money received but not yet recognized as income — conditional grants sit here until every condition is MET/WAIVED; unconditional grants pass through immediately.', 430),
    ('3000', 'Member Capital Contributions',       'EQUITY',    'CREDIT', 'EQUITY',        'FINANCING', 'Shareholder capital paid in.', 500),
    ('3100', 'Retained Earnings',                  'EQUITY',    'CREDIT', 'EQUITY',        'FINANCING', 'Dividends declared/distributed reduce this directly; cumulative net income from operations is added on top when the Balance Sheet is computed.', 510),
    ('4000', 'Interest Income',                    'REVENUE',   'CREDIT', 'REVENUE',       'OPERATING', 'Interest earned on loans given (and any bank interest).', 600),
    ('4100', 'Investment Income',                  'REVENUE',   'CREDIT', 'REVENUE',       'OPERATING', 'Returns received on investments.', 610),
    ('4200', 'Grant Income',                       'REVENUE',   'CREDIT', 'REVENUE',       'OPERATING', 'Grant money recognized as earned once its conditions are resolved — a non-cash reclassification out of Deferred Grant Income, not a new cash movement.', 620),
    ('4300', 'Side Fund Dues Income',              'REVENUE',   'CREDIT', 'REVENUE',       'OPERATING', 'Member dues collected into the Side Fund pool.', 630),
    ('4400', 'Fines Income',                       'REVENUE',   'CREDIT', 'REVENUE',       'OPERATING', 'Fines collected from members.', 640),
    ('4500', 'Other Income',                       'REVENUE',   'CREDIT', 'REVENUE',       'OPERATING', 'Miscellaneous income not covered by a more specific account.', 650),
    ('5000', 'Operating Expenses',                 'EXPENSE',   'DEBIT',  'EXPENSES',      'OPERATING', 'General club expenses, broken down further by transaction category on the General Ledger.', 700),
    ('5100', 'Interest Expense',                   'EXPENSE',   'DEBIT',  'EXPENSES',      'OPERATING', 'Interest paid on loans the club has received.', 710),
    ('5200', 'Side Fund Payouts',                  'EXPENSE',   'DEBIT',  'EXPENSES',      'OPERATING', 'Payouts from the Side Fund pool.', 720),
    ('5300', 'Service Fees Paid',                  'EXPENSE',   'DEBIT',  'EXPENSES',      'OPERATING', 'Fees paid to contracted staff — also where a recovered service fee advance is recognized as an expense.', 730),
    ('5400', 'Reimbursements Paid',                'EXPENSE',   'DEBIT',  'EXPENSES',      'OPERATING', 'Expense reimbursements paid to contracted staff.', 740),
    ('5500', 'General Payments',                   'EXPENSE',   'DEBIT',  'EXPENSES',      'OPERATING', 'One-off payments not covered by a more specific account.', 750)
ON CONFLICT (code) DO NOTHING;

INSERT INTO gl_inflow_type_mapping (inflow_type, gl_account_id, notes)
SELECT v.inflow_type, ga.id, v.notes
FROM (VALUES
    ('CONTRIBUTION',              '3000', NULL),
    ('GRANT',                     '2300', 'Deferred until recognized — see Grant Income (4200).'),
    ('LOAN_RECEIVED',             '2000', NULL),
    ('LOAN_REPAYMENT_IN',         '1100', NULL),
    ('INTEREST_IN',               '4000', NULL),
    ('INVESTMENT_RETURN',         '4100', NULL),
    ('TRANSFER_IN',               '1050', NULL),
    ('OTHER_INCOME',              '4500', NULL),
    ('SAVINGS_DEPOSIT_IN',        '2100', NULL),
    ('TRANSFER_OUT',              '1050', NULL),
    ('LOAN_DISBURSED',            '1100', NULL),
    ('LOAN_REPAYMENT_OUT',        '2000', NULL),
    ('INTEREST_OUT',              '5100', NULL),
    ('EXPENSE',                   '5000', 'Overridden in glService.js to 1400 (Other Investments) when the transaction carries a non-null investment_id.'),
    ('SAVINGS_HANDOUT_OUT',       '2100', NULL),
    ('GRANT_REFUND',              '2300', 'Same account as GRANT — a refund is just the reverse direction of the same liability.'),
    ('SIDE_FUND_CONTRIBUTION_IN', '4300', NULL),
    ('SIDE_FUND_DIRECT_IN',       '4300', NULL),
    ('SAVINGS_POOL_OTHER_IN',     '2100', NULL),
    ('SERVICE_FEE_OUT',           '5300', NULL),
    ('SERVICE_REIMBURSEMENT_OUT', '5400', NULL),
    ('DIVIDEND_OUT',              '3100', NULL),
    ('DIVIDEND_SAVINGS_IN',       '2100', 'A dividend redirected into savings rather than paid out directly.'),
    ('MMF_TOPUP_OUT',             '1300', NULL),
    ('MMF_WITHDRAWAL_IN',         '1300', NULL),
    ('SIDE_FUND_PAYOUT_OUT',      '5200', NULL),
    ('FINE_PAYMENT_IN',           '4400', NULL),
    ('DEPOSIT_CONTRIBUTION_IN',   '2200', NULL),
    ('DEPOSIT_REFUND_OUT',        '2200', NULL),
    ('GENERAL_PAYMENT_OUT',       '5500', NULL),
    ('SERVICE_FEE_ADVANCE_OUT',   '1200', NULL)
) AS v(inflow_type, gl_code, notes)
JOIN gl_accounts ga ON ga.code = v.gl_code
ON CONFLICT (inflow_type) DO NOTHING;
