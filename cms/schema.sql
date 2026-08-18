-- ============================================================
-- COMPANY MANAGEMENT SYSTEM — PostgreSQL Database Schema
-- Version: 1.6.0
-- Philosophy: Extensible by default. No hard deletes anywhere.
-- Changes in v1.6.0 (notifications, share price, account references):
--   + New table: notifications — in-app "bell" activity feed, one row
--     per user per event (approval needed, contribution recorded,
--     event reminder, etc.), with an email_sent flag since most of
--     these also trigger an actual email via the existing Gmail
--     SMTP sender in config/email.js
--   + New table: share_price_history — company-wide price-per-share
--     over time (effective_from/to, like the existing floor-limit
--     history pattern), replacing the old "percentage of primary
--     balance" estimate on the shareholder dashboard with an actual
--     shares-held × price calculation
--   + accounts.reference_prefix — an optional short code (e.g. "IRF")
--     an admin can set on a secondary/operational account so its
--     transactions get their own tailored reference series (e.g.
--     IRF-EXP-202607-00001) instead of the generic SA- prefix every
--     secondary account previously shared
-- Changes in v1.5.0 (investment operations + company branding):
--   + New table: investment_transactions — EXPENSE / INFLOW / TAX
--     entries recorded directly against one investment, each one
--     automatically posted to the general ledger (transactions
--     table) so an investment's own operational spending stays
--     inside the same double-entry system as everything else
--   + New table: company_settings — single-row table holding the
--     company's name, address, logo URL, and brand colors, so a
--     System Admin can rebrand the whole system (sidebar, topbar,
--     generated documents) without a code change or redeploy
-- Changes in v1.4.0 (contribution acknowledgement + role):
--   + New role: Assistant Treasurer
--   + requisitions.requisition_type ('EXPENSE' or 'CONTRIBUTION_ACKNOWLEDGEMENT'),
--     requisitions.contribution_date — lets a member ask the Treasurer to
--     acknowledge and record capital they've already contributed, instead
--     of posting the contribution themselves
-- Changes in v1.3.0 (bond investments):
--   + investments.investment_type ('STANDARD' or 'BOND'), face_value,
--     coupon_rate, coupon_frequency, tax_withholding_rate
--   + New table: bond_coupons — the generated payment schedule for a
--     BOND investment (one row per coupon, gross/tax/net amounts,
--     due date, paid status)
-- Changes in v1.2.0 (schema-drift fix — brings schema up to date with
-- controllers that were built after v1.1.0 but never got matching tables):
--   + transfers.sending_bank_charge / receiving_bank_charge / sending_charge_tx_id / receiving_charge_tx_id
--   + transactions.contributed_by
--   + New tables: dividends, dividend_distributions, authority_payments,
--     member_savings, requisitions
-- Changes in v1.1.0:
--   + Extended inflow types (grants, loans, investment returns)
--   + Loans Received module (company borrows)
--   + Loans Given module (company lends)
--   + Grants module (conditional and unconditional)
--   + Automatic interest calculation support
--   + Loan witnessing and documentation requirements
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";


-- ============================================================
-- GROUP 1: SYSTEM FOUNDATION — Users, Roles, Permissions
-- ============================================================

CREATE TABLE currencies (
    id                  SERIAL PRIMARY KEY,
    code                VARCHAR(10)  NOT NULL UNIQUE,
    name                VARCHAR(100) NOT NULL,
    symbol              VARCHAR(10),
    is_active           BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by          INTEGER
);

CREATE TABLE users (
    id                          SERIAL PRIMARY KEY,
    uuid                        UUID         NOT NULL DEFAULT uuid_generate_v4() UNIQUE,
    email                       VARCHAR(255) NOT NULL UNIQUE,
    password_hash               TEXT         NOT NULL,
    first_name                  VARCHAR(100) NOT NULL,
    last_name                   VARCHAR(100) NOT NULL,
    date_of_birth               DATE,
    nationality                 VARCHAR(100),
    id_number                   VARCHAR(100),
    phone                       VARCHAR(30),
    address                     TEXT,
    photo_path                  TEXT,
    gender                      VARCHAR(20)  CHECK (gender IN ('MALE','FEMALE','OTHER')),
    avatar_choice               VARCHAR(30),
    -- avatar_choice: id of a built-in illustrated avatar (e.g. 'male-1', 'female-2', 'neutral-1')
    -- used as a placeholder when the user has not uploaded a real photo_path.
    -- Only meaningful for the Auditor role (v1.20.0) — required before an
    -- auditor can submit anything through the External Audit portal, and
    -- used to build that auditor's reference-code prefix (first name +
    -- company initials) on every document their submissions produce.
    auditor_company_name        VARCHAR(200),
    auditor_company_initials    VARCHAR(10),
    auditor_contact_phone       VARCHAR(30),
    emergency_contact_name      VARCHAR(200),
    emergency_contact_phone     VARCHAR(30),
    two_factor_enabled          BOOLEAN      NOT NULL DEFAULT FALSE,
    two_factor_secret           TEXT,
    is_active                   BOOLEAN      NOT NULL DEFAULT TRUE,
    is_email_verified           BOOLEAN      NOT NULL DEFAULT FALSE,
    email_verification_token    TEXT,
    password_reset_token        TEXT,
    password_reset_expires      TIMESTAMPTZ,
    last_login_at               TIMESTAMPTZ,
    created_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by                  INTEGER REFERENCES users(id),
    -- v1.23.0 — personal signature, drawn on a signature pad at
    -- consent time (Section 4.29), stored as a PNG the same way
    -- photo_path/branding logos are.
    signature_path               TEXT,
    signature_updated_at         TIMESTAMPTZ
);

ALTER TABLE currencies
    ADD CONSTRAINT fk_currencies_created_by
    FOREIGN KEY (created_by) REFERENCES users(id);

CREATE TABLE roles (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(100) NOT NULL UNIQUE,
    description     TEXT,
    is_system_role  BOOLEAN      NOT NULL DEFAULT FALSE,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by      INTEGER REFERENCES users(id)
);

CREATE TABLE user_roles (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER     NOT NULL REFERENCES users(id),
    role_id     INTEGER     NOT NULL REFERENCES roles(id),
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    assigned_by INTEGER     NOT NULL REFERENCES users(id),
    revoked_at  TIMESTAMPTZ,
    revoked_by  INTEGER REFERENCES users(id),
    notes       TEXT,
    UNIQUE (user_id, role_id)
);

CREATE TABLE permissions (
    id          SERIAL PRIMARY KEY,
    code        VARCHAR(100) NOT NULL UNIQUE,
    module      VARCHAR(100) NOT NULL,
    description TEXT,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE role_permissions (
    id            SERIAL PRIMARY KEY,
    role_id       INTEGER     NOT NULL REFERENCES roles(id),
    permission_id INTEGER     NOT NULL REFERENCES permissions(id),
    granted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    granted_by    INTEGER     NOT NULL REFERENCES users(id),
    UNIQUE (role_id, permission_id)
);

CREATE TABLE role_requests (
    id           SERIAL PRIMARY KEY,
    user_id      INTEGER     NOT NULL REFERENCES users(id),
    role_id      INTEGER     NOT NULL REFERENCES roles(id),
    reason       TEXT,
    status       VARCHAR(30) NOT NULL DEFAULT 'PENDING'
                 CHECK (status IN ('PENDING','APPROVED','REJECTED')),
    reviewed_by  INTEGER REFERENCES users(id),
    reviewed_at  TIMESTAMPTZ,
    review_notes TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ============================================================
-- GROUP 2: CATEGORY SYSTEM — Universal Hierarchical Categories
-- ============================================================

CREATE TABLE categories (
    id           SERIAL PRIMARY KEY,
    parent_id    INTEGER REFERENCES categories(id),
    module       VARCHAR(50) NOT NULL
                 CHECK (module IN ('FINANCE','DOCUMENT','EVENT','INVESTMENT','GENERAL')),
    name         VARCHAR(150) NOT NULL,
    abbreviation VARCHAR(20)  NOT NULL,
    description  TEXT,
    is_active    BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by   INTEGER REFERENCES users(id),
    UNIQUE (parent_id, name, module)
);

CREATE TABLE category_paths (
    category_id       INTEGER     NOT NULL REFERENCES categories(id) PRIMARY KEY,
    full_path         TEXT        NOT NULL,
    full_abbreviation TEXT        NOT NULL,
    depth             INTEGER     NOT NULL DEFAULT 0,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ============================================================
-- GROUP 3: REFERENCE ENGINE
-- ============================================================

CREATE TABLE reference_sequences (
    id              SERIAL  PRIMARY KEY,
    module_code     VARCHAR(20) NOT NULL,
    category_abbrev VARCHAR(30) NOT NULL,
    year_month      CHAR(6)     NOT NULL,
    last_sequence   INTEGER     NOT NULL DEFAULT 0,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (module_code, category_abbrev, year_month)
);

CREATE TABLE references_registry (
    id             SERIAL PRIMARY KEY,
    reference_code VARCHAR(100) NOT NULL UNIQUE,
    -- Short random (non-sequential) ID generated alongside every
    -- reference code — safe to print/search/quote without revealing
    -- how many records of that kind exist or in what order.
    public_id      VARCHAR(10)  UNIQUE,
    module_code    VARCHAR(20)  NOT NULL,
    category_abbrev VARCHAR(30) NOT NULL,
    year_month     CHAR(6)      NOT NULL,
    sequence       INTEGER      NOT NULL,
    record_type    VARCHAR(50)  NOT NULL,
    record_id      INTEGER,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by     INTEGER REFERENCES users(id)
);


-- ============================================================
-- GROUP 4: ACCOUNTS & FINANCIAL STRUCTURE
-- ============================================================

CREATE TABLE accounts (
    id              SERIAL PRIMARY KEY,
    account_type    VARCHAR(20)    NOT NULL
                    -- SAVINGS (v1.14.0): the single dedicated account every
                    -- member-savings transaction is posted against instead of
                    -- Primary. It can NEVER take part in a transfer (the
                    -- transferController only ever allows PRIMARY<->SECONDARY
                    -- legs, so a SAVINGS account is automatically excluded —
                    -- no extra code needed for that rule) and is permanently
                    -- exempt from floor-limit enforcement, so it is allowed to
                    -- sit at exactly zero at any time.
                    CHECK (account_type IN ('PRIMARY','SECONDARY','SAVINGS')),
    name            VARCHAR(150)   NOT NULL,
    currency_id     INTEGER        NOT NULL REFERENCES currencies(id),
    description     TEXT,
    current_balance NUMERIC(20,4)  NOT NULL DEFAULT 0,
    is_active       BOOLEAN        NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    created_by      INTEGER REFERENCES users(id),
    -- Optional short code (e.g. "IRF") used as the reference-code
    -- prefix for this account's own transactions instead of the
    -- generic PA/SA module code — lets each operational account's
    -- money trail be told apart from every other account's at a
    -- glance. NULL falls back to the generic PA/SA code.
    reference_prefix VARCHAR(10) UNIQUE,
    -- Bank details (v1.12.0). Required unless is_virtual is TRUE —
    -- e.g. an internal notional/tracking account that has no real
    -- bank behind it. Accounts CAN share the same currency and even
    -- the same bank, as long as their own details (branch/account
    -- number) differ — nothing here is globally unique.
    is_virtual        BOOLEAN      NOT NULL DEFAULT FALSE,
    bank_name          VARCHAR(150),
    bank_branch         VARCHAR(150),
    bank_account_number VARCHAR(100),
    swift_routing_code  VARCHAR(50),
    CONSTRAINT check_balance_not_negative CHECK (current_balance >= 0),
    CONSTRAINT bank_details_required_unless_virtual CHECK (
        is_virtual = TRUE OR (bank_name IS NOT NULL AND bank_account_number IS NOT NULL)
    )
);

CREATE UNIQUE INDEX idx_one_primary_account
    ON accounts (account_type)
    WHERE account_type = 'PRIMARY' AND is_active = TRUE;

-- Mirrors idx_one_primary_account: exactly one active SAVINGS account can
-- exist, so every savings transaction has one unambiguous account to
-- reference.
CREATE UNIQUE INDEX idx_one_savings_account
    ON accounts (account_type)
    WHERE account_type = 'SAVINGS' AND is_active = TRUE;

-- Table name is historical — as of v1.14.0 a floor limit can be set on
-- ANY account (not just Primary); the column was never type-restricted
-- at the schema level, so no rename/migration is needed, just the
-- application-logic change that used to gate this to PRIMARY only. The
-- one permanent exception is the SAVINGS account, which is always
-- exempt (it must be allowed to sit at zero at any time).
CREATE TABLE primary_account_floor_limits (
    id             SERIAL PRIMARY KEY,
    account_id     INTEGER       NOT NULL REFERENCES accounts(id),
    floor_amount   NUMERIC(20,4) NOT NULL,
    effective_from DATE          NOT NULL,
    effective_to   DATE,
    set_by         INTEGER       NOT NULL REFERENCES users(id),
    approved_by    INTEGER REFERENCES users(id),
    notes          TEXT,
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT positive_floor CHECK (floor_amount >= 0)
);

-- Shareholder capital contributions (one specific inflow type)
CREATE TABLE shareholder_contributions (
    id             SERIAL PRIMARY KEY,
    reference_id   INTEGER       NOT NULL REFERENCES references_registry(id),
    user_id        INTEGER       NOT NULL REFERENCES users(id),
    account_id     INTEGER       NOT NULL REFERENCES accounts(id),
    amount         NUMERIC(20,4) NOT NULL,
    currency_id    INTEGER       NOT NULL REFERENCES currencies(id),
    contribution_date DATE       NOT NULL,
    category_id    INTEGER       NOT NULL REFERENCES categories(id),
    notes          TEXT,
    status         VARCHAR(30)   NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING','APPROVED','REJECTED','REVERSED')),
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_by     INTEGER       NOT NULL REFERENCES users(id),
    CONSTRAINT positive_contribution CHECK (amount > 0)
);

CREATE TABLE shareholding_registry (
    id             SERIAL PRIMARY KEY,
    user_id        INTEGER       NOT NULL REFERENCES users(id),
    shares_held    NUMERIC(20,4) NOT NULL DEFAULT 0,
    percentage     NUMERIC(8,4),
    effective_from DATE          NOT NULL,
    effective_to   DATE,
    updated_by     INTEGER       NOT NULL REFERENCES users(id),
    notes          TEXT,
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Company-wide price per share over time — same effective_from/to
-- history pattern as primary_account_floor_limits above. A
-- shareholder's share value = their shares_held × the currently
-- effective price_per_share here (see usersController/reportsController
-- for where this replaces the old percentage-of-balance estimate).
CREATE TABLE share_price_history (
    id               SERIAL PRIMARY KEY,
    price_per_share  NUMERIC(20,4) NOT NULL,
    currency_id      INTEGER       NOT NULL REFERENCES currencies(id),
    effective_from   DATE          NOT NULL,
    effective_to     DATE,
    set_by           INTEGER       NOT NULL REFERENCES users(id),
    notes            TEXT,
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT positive_share_price CHECK (price_per_share > 0)
);

-- Monthly, company-set exchange rates (v1.7.0) — used ONLY to DISPLAY
-- the share price/value in currencies other than the one it was set
-- in. Does not affect how contributions/transactions are recorded.
-- Each base->target pair has its own effective_from/to history, same
-- pattern as share_price_history above.
CREATE TABLE currency_exchange_rates (
    id                  SERIAL PRIMARY KEY,
    base_currency_id    INTEGER       NOT NULL REFERENCES currencies(id),
    target_currency_id  INTEGER       NOT NULL REFERENCES currencies(id),
    rate                NUMERIC(20,6) NOT NULL,
    effective_from      DATE          NOT NULL,
    effective_to        DATE,
    set_by              INTEGER       NOT NULL REFERENCES users(id),
    notes               TEXT,
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT positive_exchange_rate CHECK (rate > 0),
    CONSTRAINT different_currencies   CHECK (base_currency_id != target_currency_id)
);

CREATE INDEX idx_fx_rates_current
    ON currency_exchange_rates (base_currency_id, target_currency_id)
    WHERE effective_to IS NULL;

-- Certificate of Shares records (v1.8.0) — same format for MONTHLY
-- and ANNUAL, they only differ in issue frequency and reference
-- series/period. Each gets its own unique reference number via
-- references_registry (module code 'SHC').
CREATE TABLE share_certificates (
    id                SERIAL PRIMARY KEY,
    reference_id      INTEGER       NOT NULL REFERENCES references_registry(id),
    user_id           INTEGER       NOT NULL REFERENCES users(id),
    certificate_type  VARCHAR(20)   NOT NULL
                      CHECK (certificate_type IN ('MONTHLY', 'ANNUAL')),
    period_label      VARCHAR(20)   NOT NULL,
    shares_held       NUMERIC(20,4) NOT NULL,
    percentage        NUMERIC(8,4),
    price_per_share   NUMERIC(20,4),
    currency_id       INTEGER REFERENCES currencies(id),
    share_value       NUMERIC(20,4),
    issued_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    issued_by         INTEGER REFERENCES users(id),
    email_sent        BOOLEAN       NOT NULL DEFAULT FALSE,
    email_error       TEXT,
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    -- v1.23.0 — which monthly/annual signing round (if any) this
    -- certificate belongs to (Section 4.29.3). NULL for certificates
    -- issued before this feature existed, or via the on-demand
    -- single-certificate path, which isn't part of the signing-round
    -- gate.
    signing_round_id  INTEGER
);

CREATE INDEX idx_share_certs_user ON share_certificates (user_id, issued_at DESC);
CREATE INDEX idx_share_certs_type ON share_certificates (certificate_type);


-- ============================================================
-- GROUP 5: TRANSACTIONS & TRANSFERS
-- ============================================================

CREATE TABLE transactions (
    id               SERIAL PRIMARY KEY,
    reference_id     INTEGER       NOT NULL REFERENCES references_registry(id),
    account_id       INTEGER       NOT NULL REFERENCES accounts(id),
    transaction_type VARCHAR(30)   NOT NULL
                     CHECK (transaction_type IN (
                         'CREDIT',
                         'DEBIT',
                         'REVERSAL_CREDIT',
                         'REVERSAL_DEBIT'
                     )),
    -- Source of this transaction — what generated it
    -- This allows every credit/debit to be traced back to its origin
    inflow_type      VARCHAR(30)
                     CHECK (inflow_type IN (
                         'CONTRIBUTION',       -- shareholder capital contribution
                         'GRANT',              -- grant disbursement (full or tranche)
                         'LOAN_RECEIVED',      -- company received a loan
                         'LOAN_REPAYMENT_IN',  -- repayment received on a loan the company gave
                         'INTEREST_IN',        -- interest received on a loan the company gave
                         'INVESTMENT_RETURN',  -- profit/return from an investment
                         'TRANSFER_IN',        -- inter-account transfer credit leg
                         'OTHER_INCOME',       -- any other income not listed above
                         'SAVINGS_DEPOSIT_IN', -- member savings deposit approved
                         'TRANSFER_OUT',       -- inter-account transfer debit leg
                         'LOAN_DISBURSED',     -- company gave a loan out
                         'LOAN_REPAYMENT_OUT', -- company repaying a loan it received
                         'INTEREST_OUT',       -- interest paid on a loan company received
                         'EXPENSE',            -- operational expense
                         'SAVINGS_HANDOUT_OUT',-- member savings handout confirmed
                         'GRANT_REFUND',       -- returning unused grant funds
                         'SIDE_FUND_CONTRIBUTION_IN', -- member's monthly side fund due paid
                         'SIDE_FUND_DIRECT_IN',       -- lump-sum/batch top-up added directly to the side fund
                         'SAVINGS_POOL_OTHER_IN',     -- non-member inflow into the savings pool (e.g. investment profit), approved
                         'SERVICE_FEE_OUT',           -- monthly service fee paid to a contracted staff member
                         'SERVICE_REIMBURSEMENT_OUT', -- expense reimbursement paid to a contracted staff member
                         'DIVIDEND_OUT',              -- dividend debited from the declaring account
                         'DIVIDEND_SAVINGS_IN'        -- dividend credited into the Savings account for distribution
                     )),
    amount           NUMERIC(20,4) NOT NULL,
    currency_id      INTEGER       NOT NULL REFERENCES currencies(id),
    balance_before   NUMERIC(20,4) NOT NULL,
    balance_after    NUMERIC(20,4) NOT NULL,
    category_id      INTEGER       NOT NULL REFERENCES categories(id),
    description      TEXT          NOT NULL,
    value_date       DATE          NOT NULL,
    transaction_date TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    reversal_of      INTEGER REFERENCES transactions(id),
    is_reversal      BOOLEAN       NOT NULL DEFAULT FALSE,
    is_reversed      BOOLEAN       NOT NULL DEFAULT FALSE,
    transfer_id      INTEGER,
    -- Links to source records (only one will be populated per transaction)
    contribution_id  INTEGER REFERENCES shareholder_contributions(id),
    grant_tranche_id INTEGER,      -- FK added after grants table
    loan_received_id INTEGER,      -- FK added after loans_received table
    loan_given_id    INTEGER,      -- FK added after loans_given table
    investment_id    INTEGER,      -- FK added after investments table
    status           VARCHAR(30)   NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING','APPROVED','POSTED','REVERSED','REJECTED')),
    created_by       INTEGER       NOT NULL REFERENCES users(id),
    -- Member the transaction is recorded on behalf of (e.g. a contribution
    -- entered by the Treasurer for a shareholder). NULL when not applicable;
    -- distinct from created_by, which is always whoever performed the action.
    contributed_by   INTEGER REFERENCES users(id),
    approved_by      INTEGER REFERENCES users(id),
    approved_at      TIMESTAMPTZ,
    posted_at        TIMESTAMPTZ,
    CONSTRAINT positive_amount CHECK (amount > 0)
);

CREATE TABLE transfers (
    id                       SERIAL PRIMARY KEY,
    reference_id             INTEGER       NOT NULL REFERENCES references_registry(id),
    from_account_id          INTEGER       NOT NULL REFERENCES accounts(id),
    to_account_id            INTEGER       NOT NULL REFERENCES accounts(id),
    transfer_type            VARCHAR(30)   NOT NULL
                             CHECK (transfer_type IN (
                                 'PRIMARY_TO_SECONDARY',
                                 'SECONDARY_TO_PRIMARY'
                             )),
    amount_sent              NUMERIC(20,4) NOT NULL,
    currency_sent_id         INTEGER       NOT NULL REFERENCES currencies(id),
    amount_received          NUMERIC(20,4) NOT NULL,
    currency_received_id     INTEGER       NOT NULL REFERENCES currencies(id),
    exchange_rate            NUMERIC(20,8) NOT NULL,
    exchange_rate_entered_by INTEGER       NOT NULL REFERENCES users(id),
    category_id              INTEGER       NOT NULL REFERENCES categories(id),
    description              TEXT,
    value_date               DATE          NOT NULL,
    -- Bank charges deducted on either leg of the transfer (each posted as its
    -- own EXPENSE transaction once the transfer is approved). Default 0 = no charge.
    sending_bank_charge      NUMERIC(20,4) NOT NULL DEFAULT 0,
    receiving_bank_charge    NUMERIC(20,4) NOT NULL DEFAULT 0,
    status                   VARCHAR(30)   NOT NULL DEFAULT 'PENDING'
                             CHECK (status IN (
                                 'PENDING','AWAITING_APPROVAL','APPROVED',
                                 'POSTED','REJECTED','REVERSED'
                             )),
    debit_transaction_id     INTEGER REFERENCES transactions(id),
    credit_transaction_id    INTEGER REFERENCES transactions(id),
    -- Link to the separate EXPENSE transactions posted for each bank charge, if any
    sending_charge_tx_id     INTEGER REFERENCES transactions(id),
    receiving_charge_tx_id   INTEGER REFERENCES transactions(id),
    created_at               TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_by               INTEGER       NOT NULL REFERENCES users(id),
    CONSTRAINT no_self_transfer CHECK (from_account_id <> to_account_id),
    CONSTRAINT positive_amounts CHECK (amount_sent > 0 AND amount_received > 0),
    CONSTRAINT non_negative_charges CHECK (sending_bank_charge >= 0 AND receiving_bank_charge >= 0)
);

ALTER TABLE transactions
    ADD CONSTRAINT fk_transactions_transfer
    FOREIGN KEY (transfer_id) REFERENCES transfers(id);


-- ============================================================
-- GROUP 6: APPROVAL WORKFLOWS
-- ============================================================

CREATE TABLE approval_workflows (
    id                SERIAL PRIMARY KEY,
    workflow_type     VARCHAR(60) NOT NULL
                      CHECK (workflow_type IN (
                          'PRIMARY_TO_SECONDARY_TRANSFER',
                          'SECONDARY_TO_PRIMARY_TRANSFER',
                          'CONTRIBUTION',
                          'INVESTMENT',
                          'EVENT',
                          'DOCUMENT',
                          'FLOOR_LIMIT_CHANGE',
                          'GRANT',
                          'LOAN_RECEIVED',
                          'LOAN_GIVEN',
                          'LOAN_RATE_AMENDMENT',   -- when Treasurer amends overdue rate
                          'GRANT_CONDITION_WAIVER'
                      )),
    record_type       VARCHAR(50) NOT NULL,
    record_id         INTEGER     NOT NULL,
    required_approvals INTEGER    NOT NULL DEFAULT 1,
    current_approvals INTEGER     NOT NULL DEFAULT 0,
    status            VARCHAR(30) NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED')),
    initiated_by      INTEGER     NOT NULL REFERENCES users(id),
    initiated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at      TIMESTAMPTZ,
    notes             TEXT
);

CREATE TABLE approval_actions (
    id          SERIAL PRIMARY KEY,
    workflow_id INTEGER     NOT NULL REFERENCES approval_workflows(id),
    actor_id    INTEGER     NOT NULL REFERENCES users(id),
    action      VARCHAR(20) NOT NULL
                CHECK (action IN ('APPROVED','REJECTED','ABSTAINED')),
    role_id     INTEGER     NOT NULL REFERENCES roles(id),
    notes       TEXT,
    acted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (workflow_id, actor_id)
);


-- ============================================================
-- GROUP 7: GRANTS
-- ============================================================

-- A grant is a source of funds given to the company
-- It may come with conditions (milestones to meet) or be unconditional
-- It may be disbursed in one lump sum or multiple tranches

CREATE TABLE grants (
    id                  SERIAL PRIMARY KEY,
    reference_id        INTEGER       NOT NULL REFERENCES references_registry(id),
    account_id          INTEGER       NOT NULL REFERENCES accounts(id),
    currency_id         INTEGER       NOT NULL REFERENCES currencies(id),
    category_id         INTEGER       NOT NULL REFERENCES categories(id),
    grantor_name        VARCHAR(255)  NOT NULL,  -- name of the granting body/person
    grantor_type        VARCHAR(50)   NOT NULL
                        CHECK (grantor_type IN (
                            'GOVERNMENT','NGO','BANK','INSTITUTION','INDIVIDUAL','OTHER'
                        )),
    grantor_contact     TEXT,
    title               VARCHAR(255)  NOT NULL,
    description         TEXT,
    total_amount        NUMERIC(20,4) NOT NULL,  -- total grant amount approved
    amount_received     NUMERIC(20,4) NOT NULL DEFAULT 0,  -- running total received so far
    amount_remaining    NUMERIC(20,4) GENERATED ALWAYS AS (total_amount - amount_received) STORED,
    is_conditional      BOOLEAN       NOT NULL DEFAULT FALSE,
    agreement_document_id INTEGER,               -- FK added after documents table
    start_date          DATE,
    end_date            DATE,                    -- grant validity or reporting deadline
    status              VARCHAR(30)   NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN (
                            'PENDING','ACTIVE','PARTIALLY_RECEIVED',
                            'FULLY_RECEIVED','CLOSED','CANCELLED'
                        )),
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_by          INTEGER       NOT NULL REFERENCES users(id),
    approved_by         INTEGER REFERENCES users(id),
    approved_at         TIMESTAMPTZ,
    CONSTRAINT positive_grant CHECK (total_amount > 0)
);

-- Each disbursement of a grant (one or many tranches)
CREATE TABLE grant_tranches (
    id              SERIAL PRIMARY KEY,
    reference_id    INTEGER       NOT NULL REFERENCES references_registry(id),
    grant_id        INTEGER       NOT NULL REFERENCES grants(id),
    tranche_number  INTEGER       NOT NULL,      -- 1, 2, 3... auto-incremented per grant
    amount          NUMERIC(20,4) NOT NULL,
    received_date   DATE          NOT NULL,
    transaction_id  INTEGER REFERENCES transactions(id),
    notes           TEXT,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_by      INTEGER       NOT NULL REFERENCES users(id),
    CONSTRAINT positive_tranche CHECK (amount > 0),
    UNIQUE (grant_id, tranche_number)
);

-- Conditions that must be met for conditional grants
CREATE TABLE grant_conditions (
    id              SERIAL PRIMARY KEY,
    grant_id        INTEGER     NOT NULL REFERENCES grants(id),
    title           VARCHAR(255) NOT NULL,
    description     TEXT,
    due_date        DATE,
    status          VARCHAR(30) NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING','MET','FAILED','WAIVED')),
    met_at          DATE,
    waived_by       INTEGER REFERENCES users(id),
    waived_at       TIMESTAMPTZ,
    waiver_reason   TEXT,
    evidence_document_id INTEGER, -- FK added after documents table
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by      INTEGER     NOT NULL REFERENCES users(id)
);


-- ============================================================
-- GROUP 8: LOANS RECEIVED (Company Borrows Money)
-- ============================================================

-- A loan received is money the company borrows from any lender
-- Interest is calculated automatically by the system
-- Before overdue: fixed agreed rate. After overdue: penalty rate (amendable by Treasurer)

CREATE TABLE loans_received (
    id                      SERIAL PRIMARY KEY,
    reference_id            INTEGER       NOT NULL REFERENCES references_registry(id),
    account_id              INTEGER       NOT NULL REFERENCES accounts(id),  -- which account receives it
    currency_id             INTEGER       NOT NULL REFERENCES currencies(id),
    category_id             INTEGER       NOT NULL REFERENCES categories(id),

    -- Lender information
    lender_type             VARCHAR(30)   NOT NULL
                            CHECK (lender_type IN (
                                'BANK','INSTITUTION','INDIVIDUAL',
                                'MEMBER','AUTHORITY','OTHER'
                            )),
    lender_name             VARCHAR(255)  NOT NULL,
    lender_contact          TEXT,
    is_member_lender        BOOLEAN       NOT NULL DEFAULT FALSE, -- TRUE if lender is a system user
    member_lender_id        INTEGER REFERENCES users(id),        -- populated if is_member_lender = TRUE

    -- Loan financial terms
    principal_amount        NUMERIC(20,4) NOT NULL,
    amount_received         NUMERIC(20,4) NOT NULL DEFAULT 0,    -- may be disbursed in tranches
    outstanding_principal   NUMERIC(20,4) NOT NULL,              -- updated as repayments are made
    outstanding_interest    NUMERIC(20,4) NOT NULL DEFAULT 0,    -- accrued but unpaid interest

    -- Interest rate structure
    interest_rate_type      VARCHAR(20)   NOT NULL DEFAULT 'FIXED'
                            CHECK (interest_rate_type IN ('FIXED','VARIABLE')),
    fixed_interest_rate     NUMERIC(8,4)  NOT NULL,              -- % per period, applies before overdue
    penalty_interest_rate   NUMERIC(8,4)  NOT NULL,              -- % per period, applies after overdue
    interest_period         VARCHAR(20)   NOT NULL DEFAULT 'MONTHLY'
                            CHECK (interest_period IN ('DAILY','WEEKLY','MONTHLY','ANNUALLY')),
    interest_calculation    VARCHAR(20)   NOT NULL DEFAULT 'SIMPLE'
                            CHECK (interest_calculation IN ('SIMPLE','COMPOUND')),
                            -- SIMPLE for internal/member lenders, SIMPLE or COMPOUND for external

    -- Dates
    disbursement_date       DATE,                                -- when money was/will be received
    due_date                DATE          NOT NULL,              -- full repayment due by this date
    is_overdue              BOOLEAN       NOT NULL DEFAULT FALSE, -- system-updated daily
    overdue_since           DATE,                                -- date it became overdue

    -- Witnessing (required for member loans)
    requires_witnesses      BOOLEAN       NOT NULL DEFAULT FALSE,
    external_witness_name   VARCHAR(255),
    external_witness_contact TEXT,

    -- Status
    status                  VARCHAR(30)   NOT NULL DEFAULT 'PENDING'
                            CHECK (status IN (
                                'PENDING','ACTIVE','OVERDUE',
                                'PARTIALLY_REPAID','FULLY_REPAID','DEFAULTED','CANCELLED'
                            )),

    -- Documentation
    agreement_document_id   INTEGER,                             -- FK added after documents table

    created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_by              INTEGER       NOT NULL REFERENCES users(id),
    approved_by             INTEGER REFERENCES users(id),
    approved_at             TIMESTAMPTZ,
    CONSTRAINT positive_principal_received CHECK (principal_amount > 0)
);

-- Penalty rate amendment history — Treasurer can update overdue rate
-- Original rate is never overwritten; full history kept
CREATE TABLE loan_received_rate_amendments (
    id                    SERIAL PRIMARY KEY,
    loan_received_id      INTEGER       NOT NULL REFERENCES loans_received(id),
    previous_penalty_rate NUMERIC(8,4)  NOT NULL,
    new_penalty_rate      NUMERIC(8,4)  NOT NULL,
    reason                TEXT          NOT NULL,
    effective_from        DATE          NOT NULL,
    amended_by            INTEGER       NOT NULL REFERENCES users(id),  -- must be Treasurer
    approved_by           INTEGER REFERENCES users(id),
    created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Witnesses for member-lender loans
CREATE TABLE loan_received_witnesses (
    id               SERIAL PRIMARY KEY,
    loan_received_id INTEGER     NOT NULL REFERENCES loans_received(id),
    witness_type     VARCHAR(20) NOT NULL
                     CHECK (witness_type IN ('EXTERNAL','DIRECTOR')),
    -- For external witnesses (non-system users)
    witness_name     VARCHAR(255),
    witness_contact  TEXT,
    witness_id_number VARCHAR(100),
    -- For internal Director witnesses (system users)
    user_id          INTEGER REFERENCES users(id),
    signed_at        TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Repayment schedule — auto-generated or manually defined at loan creation
CREATE TABLE loan_received_schedule (
    id               SERIAL PRIMARY KEY,
    loan_received_id INTEGER       NOT NULL REFERENCES loans_received(id),
    instalment_number INTEGER      NOT NULL,
    due_date         DATE          NOT NULL,
    principal_due    NUMERIC(20,4) NOT NULL DEFAULT 0,
    interest_due     NUMERIC(20,4) NOT NULL DEFAULT 0,
    total_due        NUMERIC(20,4) GENERATED ALWAYS AS (principal_due + interest_due) STORED,
    status           VARCHAR(20)   NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING','PAID','OVERDUE','PARTIAL','WAIVED')),
    UNIQUE (loan_received_id, instalment_number)
);

-- Every repayment made on a loan received (principal + interest tracked separately)
CREATE TABLE loan_received_repayments (
    id               SERIAL PRIMARY KEY,
    reference_id     INTEGER       NOT NULL REFERENCES references_registry(id),
    loan_received_id INTEGER       NOT NULL REFERENCES loans_received(id),
    schedule_id      INTEGER REFERENCES loan_received_schedule(id),
    transaction_id   INTEGER       NOT NULL REFERENCES transactions(id),
    amount_paid      NUMERIC(20,4) NOT NULL,
    principal_portion NUMERIC(20,4) NOT NULL DEFAULT 0,
    interest_portion  NUMERIC(20,4) NOT NULL DEFAULT 0,
    penalty_portion   NUMERIC(20,4) NOT NULL DEFAULT 0,  -- penalty interest paid
    payment_date     DATE          NOT NULL,
    notes            TEXT,
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_by       INTEGER       NOT NULL REFERENCES users(id),
    CONSTRAINT positive_repayment CHECK (amount_paid > 0),
    CONSTRAINT portions_match CHECK (
        principal_portion + interest_portion + penalty_portion = amount_paid
    )
);

-- Daily interest accrual log — system-generated, one record per loan per day
CREATE TABLE loan_received_interest_accrual (
    id               SERIAL PRIMARY KEY,
    loan_received_id INTEGER       NOT NULL REFERENCES loans_received(id),
    accrual_date     DATE          NOT NULL,
    rate_used        NUMERIC(8,4)  NOT NULL,     -- which rate was applied (fixed or penalty)
    rate_type        VARCHAR(20)   NOT NULL
                     CHECK (rate_type IN ('FIXED','PENALTY')),
    principal_balance NUMERIC(20,4) NOT NULL,    -- balance on which interest was calculated
    interest_accrued NUMERIC(20,4) NOT NULL,     -- amount accrued on this day
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    UNIQUE (loan_received_id, accrual_date)
);


-- ============================================================
-- GROUP 9: LOANS GIVEN (Company Lends Money Out)
-- ============================================================

-- A loan given is money the company lends to any borrower
-- Simple interest for internal/member borrowers
-- Simple or compound for external, with same fixed/penalty rate structure

CREATE TABLE loans_given (
    id                      SERIAL PRIMARY KEY,
    reference_id            INTEGER       NOT NULL REFERENCES references_registry(id),
    account_id              INTEGER       NOT NULL REFERENCES accounts(id),  -- source account
    currency_id             INTEGER       NOT NULL REFERENCES currencies(id),
    category_id             INTEGER       NOT NULL REFERENCES categories(id),

    -- Borrower information
    borrower_type           VARCHAR(30)   NOT NULL
                            CHECK (borrower_type IN (
                                'MEMBER','INDIVIDUAL','INSTITUTION',
                                'BANK','AUTHORITY','OTHER'
                            )),
    borrower_name           VARCHAR(255)  NOT NULL,
    borrower_contact        TEXT,
    is_member_borrower      BOOLEAN       NOT NULL DEFAULT FALSE,
    member_borrower_id      INTEGER REFERENCES users(id),

    -- Loan financial terms
    principal_amount        NUMERIC(20,4) NOT NULL,
    outstanding_principal   NUMERIC(20,4) NOT NULL,
    outstanding_interest    NUMERIC(20,4) NOT NULL DEFAULT 0,

    -- Interest rate structure (mirrors loans_received logic)
    interest_rate_type      VARCHAR(20)   NOT NULL DEFAULT 'FIXED'
                            CHECK (interest_rate_type IN ('FIXED','VARIABLE')),
    fixed_interest_rate     NUMERIC(8,4)  NOT NULL,
    penalty_interest_rate   NUMERIC(8,4)  NOT NULL,
    interest_period         VARCHAR(20)   NOT NULL DEFAULT 'MONTHLY'
                            CHECK (interest_period IN ('DAILY','WEEKLY','MONTHLY','ANNUALLY')),
    interest_calculation    VARCHAR(20)   NOT NULL DEFAULT 'SIMPLE'
                            CHECK (interest_calculation IN ('SIMPLE','COMPOUND')),

    -- Dates
    disbursement_date       DATE,
    due_date                DATE          NOT NULL,
    is_overdue              BOOLEAN       NOT NULL DEFAULT FALSE,
    overdue_since           DATE,

    -- Witnessing (mirrors loan received rules)
    requires_witnesses      BOOLEAN       NOT NULL DEFAULT FALSE,
    external_witness_name   VARCHAR(255),
    external_witness_contact TEXT,

    -- Repayments return to source account
    repayment_account_id    INTEGER       NOT NULL REFERENCES accounts(id),

    -- Status
    status                  VARCHAR(30)   NOT NULL DEFAULT 'PENDING'
                            CHECK (status IN (
                                'PENDING','ACTIVE','OVERDUE',
                                'PARTIALLY_REPAID','FULLY_REPAID','DEFAULTED','CANCELLED'
                            )),

    agreement_document_id   INTEGER,

    created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_by              INTEGER       NOT NULL REFERENCES users(id),
    approved_by             INTEGER REFERENCES users(id),
    approved_at             TIMESTAMPTZ,
    CONSTRAINT positive_principal_given CHECK (principal_amount > 0),
    CONSTRAINT repayment_to_source CHECK (repayment_account_id = account_id)
);

-- Penalty rate amendment history for loans given
CREATE TABLE loan_given_rate_amendments (
    id                    SERIAL PRIMARY KEY,
    loan_given_id         INTEGER       NOT NULL REFERENCES loans_given(id),
    previous_penalty_rate NUMERIC(8,4)  NOT NULL,
    new_penalty_rate      NUMERIC(8,4)  NOT NULL,
    reason                TEXT          NOT NULL,
    effective_from        DATE          NOT NULL,
    amended_by            INTEGER       NOT NULL REFERENCES users(id),
    approved_by           INTEGER REFERENCES users(id),
    created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Witnesses for loans given
CREATE TABLE loan_given_witnesses (
    id              SERIAL PRIMARY KEY,
    loan_given_id   INTEGER     NOT NULL REFERENCES loans_given(id),
    witness_type    VARCHAR(20) NOT NULL
                    CHECK (witness_type IN ('EXTERNAL','DIRECTOR')),
    witness_name    VARCHAR(255),
    witness_contact TEXT,
    witness_id_number VARCHAR(100),
    user_id         INTEGER REFERENCES users(id),
    signed_at       TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Repayment schedule for loans given
CREATE TABLE loan_given_schedule (
    id               SERIAL PRIMARY KEY,
    loan_given_id    INTEGER       NOT NULL REFERENCES loans_given(id),
    instalment_number INTEGER      NOT NULL,
    due_date         DATE          NOT NULL,
    principal_due    NUMERIC(20,4) NOT NULL DEFAULT 0,
    interest_due     NUMERIC(20,4) NOT NULL DEFAULT 0,
    total_due        NUMERIC(20,4) GENERATED ALWAYS AS (principal_due + interest_due) STORED,
    status           VARCHAR(20)   NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING','PAID','OVERDUE','PARTIAL','WAIVED')),
    UNIQUE (loan_given_id, instalment_number)
);

-- Repayments received on loans given
CREATE TABLE loan_given_repayments (
    id                SERIAL PRIMARY KEY,
    reference_id      INTEGER       NOT NULL REFERENCES references_registry(id),
    loan_given_id     INTEGER       NOT NULL REFERENCES loans_given(id),
    schedule_id       INTEGER REFERENCES loan_given_schedule(id),
    transaction_id    INTEGER       NOT NULL REFERENCES transactions(id),
    amount_received   NUMERIC(20,4) NOT NULL,
    principal_portion NUMERIC(20,4) NOT NULL DEFAULT 0,
    interest_portion  NUMERIC(20,4) NOT NULL DEFAULT 0,
    penalty_portion   NUMERIC(20,4) NOT NULL DEFAULT 0,
    payment_date      DATE          NOT NULL,
    notes             TEXT,
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_by        INTEGER       NOT NULL REFERENCES users(id),
    CONSTRAINT positive_repayment_in CHECK (amount_received > 0),
    CONSTRAINT portions_match_given CHECK (
        principal_portion + interest_portion + penalty_portion = amount_received
    )
);

-- Daily interest accrual log for loans given
CREATE TABLE loan_given_interest_accrual (
    id               SERIAL PRIMARY KEY,
    loan_given_id    INTEGER       NOT NULL REFERENCES loans_given(id),
    accrual_date     DATE          NOT NULL,
    rate_used        NUMERIC(8,4)  NOT NULL,
    rate_type        VARCHAR(20)   NOT NULL
                     CHECK (rate_type IN ('FIXED','PENALTY')),
    principal_balance NUMERIC(20,4) NOT NULL,
    interest_accrued NUMERIC(20,4) NOT NULL,
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    UNIQUE (loan_given_id, accrual_date)
);


-- ============================================================
-- GROUP 10: INVESTMENTS & PROJECTS
-- ============================================================

CREATE TABLE investments (
    id                  SERIAL PRIMARY KEY,
    reference_id        INTEGER       NOT NULL REFERENCES references_registry(id),
    name                VARCHAR(200)  NOT NULL,
    description         TEXT,
    category_id         INTEGER       NOT NULL REFERENCES categories(id),
    funding_account_id  INTEGER       NOT NULL REFERENCES accounts(id),
    currency_id         INTEGER       NOT NULL REFERENCES currencies(id),
    planned_budget      NUMERIC(20,4) NOT NULL,
    actual_expenditure  NUMERIC(20,4) NOT NULL DEFAULT 0,
    -- Returns always go back to the funding source account (same currency)
    returns_account_id  INTEGER       NOT NULL REFERENCES accounts(id),
    total_returns       NUMERIC(20,4) NOT NULL DEFAULT 0,   -- cumulative returns received
    status              VARCHAR(30)   NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN (
                            'PENDING','ACTIVE','ON_HOLD','COMPLETED','CANCELLED'
                        )),
    start_date          DATE,
    expected_end_date   DATE,
    actual_end_date     DATE,
    responsible_user_id INTEGER REFERENCES users(id),
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_by          INTEGER       NOT NULL REFERENCES users(id),
    approved_by         INTEGER REFERENCES users(id),
    approved_at         TIMESTAMPTZ,
    -- Bond investments: investment_type = 'BOND' unlocks a generated
    -- coupon payment schedule (see bond_coupons below). start_date is
    -- used as the bond's issue date, expected_end_date as its maturity
    -- date — no separate columns needed for those.
    investment_type       VARCHAR(20)   NOT NULL DEFAULT 'STANDARD'
                          CHECK (investment_type IN ('STANDARD', 'BOND')),
    face_value             NUMERIC(20,4),                 -- bond principal / par value
    coupon_rate             NUMERIC(8,4),                  -- annual interest rate, e.g. 12.5000 = 12.5%
    coupon_frequency        VARCHAR(20)
                            CHECK (coupon_frequency IN (
                                'MONTHLY', 'QUARTERLY', 'SEMI_ANNUALLY', 'ANNUALLY', 'AT_MATURITY'
                            )),
    tax_withholding_rate    NUMERIC(8,4)  NOT NULL DEFAULT 0,  -- withholding tax %, e.g. 15.0000 = 15%
    -- Only set for a bond bought after it was already running — the
    -- issuer's next coupon date, used to anchor the generated payment
    -- schedule instead of assuming payments start `frequency` after
    -- start_date (which only holds true for a bond bought at issuance).
    first_coupon_date       DATE,
    CONSTRAINT positive_inv_budget CHECK (planned_budget > 0),
    CONSTRAINT returns_to_source CHECK (returns_account_id = funding_account_id),
    CONSTRAINT bond_fields_required CHECK (
        investment_type != 'BOND' OR (
            face_value        IS NOT NULL AND face_value > 0 AND
            coupon_rate        IS NOT NULL AND coupon_rate >= 0 AND
            coupon_frequency    IS NOT NULL AND
            start_date          IS NOT NULL AND
            expected_end_date   IS NOT NULL
        )
    )
);

-- Investment return records — each profit/return event
CREATE TABLE investment_returns (
    id              SERIAL PRIMARY KEY,
    reference_id    INTEGER       NOT NULL REFERENCES references_registry(id),
    investment_id   INTEGER       NOT NULL REFERENCES investments(id),
    transaction_id  INTEGER       NOT NULL REFERENCES transactions(id),
    return_type     VARCHAR(30)   NOT NULL
                    CHECK (return_type IN (
                        'DIVIDEND','PROFIT_SHARE','CAPITAL_GAIN',
                        'INTEREST','RENTAL','OTHER'
                    )),
    amount          NUMERIC(20,4) NOT NULL,
    return_date     DATE          NOT NULL,
    notes           TEXT,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_by      INTEGER       NOT NULL REFERENCES users(id),
    CONSTRAINT positive_return CHECK (amount > 0)
);

CREATE TABLE projects (
    id                  SERIAL PRIMARY KEY,
    reference_id        INTEGER       NOT NULL REFERENCES references_registry(id),
    investment_id       INTEGER       NOT NULL REFERENCES investments(id),
    name                VARCHAR(200)  NOT NULL,
    description         TEXT,
    category_id         INTEGER       NOT NULL REFERENCES categories(id),
    planned_budget      NUMERIC(20,4) NOT NULL,
    actual_expenditure  NUMERIC(20,4) NOT NULL DEFAULT 0,
    status              VARCHAR(30)   NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN (
                            'PENDING','ACTIVE','ON_HOLD','COMPLETED','CANCELLED'
                        )),
    start_date          DATE,
    expected_end_date   DATE,
    actual_end_date     DATE,
    responsible_user_id INTEGER REFERENCES users(id),
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_by          INTEGER       NOT NULL REFERENCES users(id),
    CONSTRAINT positive_project_budget CHECK (planned_budget > 0)
);

CREATE TABLE project_milestones (
    id          SERIAL PRIMARY KEY,
    project_id  INTEGER     NOT NULL REFERENCES projects(id),
    name        VARCHAR(200) NOT NULL,
    description TEXT,
    due_date    DATE         NOT NULL,
    completed_at DATE,
    status      VARCHAR(30) NOT NULL DEFAULT 'PENDING'
                CHECK (status IN ('PENDING','IN_PROGRESS','COMPLETED','MISSED')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by  INTEGER     NOT NULL REFERENCES users(id)
);

CREATE TABLE investment_funding (
    id             SERIAL PRIMARY KEY,
    investment_id  INTEGER       NOT NULL REFERENCES investments(id),
    project_id     INTEGER REFERENCES projects(id),
    transaction_id INTEGER       NOT NULL REFERENCES transactions(id),
    amount         NUMERIC(20,4) NOT NULL,
    notes          TEXT,
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_by     INTEGER       NOT NULL REFERENCES users(id)
);

-- Bond coupon schedule — generated once when a BOND investment is
-- created (one row per coupon date, from issue date to maturity,
-- based on face_value / coupon_rate / coupon_frequency). Each row
-- carries the pre-tax (gross), withheld tax, and post-tax (net)
-- amount, so the bond detail page can show expected yield up front.
-- When a coupon is actually paid, "Pay Coupon" records the money via
-- the normal investment_returns flow (return_type = 'INTEREST') and
-- links it back here via investment_return_id.
CREATE TABLE bond_coupons (
    id                   SERIAL PRIMARY KEY,
    investment_id        INTEGER       NOT NULL REFERENCES investments(id),
    coupon_number        INTEGER       NOT NULL,
    due_date             DATE          NOT NULL,
    gross_amount         NUMERIC(20,4) NOT NULL,
    tax_amount           NUMERIC(20,4) NOT NULL DEFAULT 0,
    net_amount           NUMERIC(20,4) NOT NULL,
    status               VARCHAR(20)   NOT NULL DEFAULT 'PENDING'
                         CHECK (status IN ('PENDING', 'PAID', 'MISSED')),
    investment_return_id INTEGER REFERENCES investment_returns(id),
    paid_at              TIMESTAMPTZ,
    created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT positive_coupon_gross CHECK (gross_amount > 0),
    CONSTRAINT unique_investment_coupon UNIQUE (investment_id, coupon_number)
);

-- Dedicated operational transactions for a single investment — the
-- day-to-day running costs (EXPENSE), extra income beyond scheduled
-- returns (INFLOW), and withholding/other tax (TAX) of operating that
-- investment. Each row is always paired 1:1 with a row in the main
-- `transactions` ledger (via transaction_id) — nothing here bypasses
-- the general ledger, this table just tags which ledger entries
-- belong to which investment's own operating budget so the investment
-- detail page can show a running balance of unspent operating capital.
CREATE TABLE investment_transactions (
    id             SERIAL PRIMARY KEY,
    reference_id   INTEGER       NOT NULL REFERENCES references_registry(id),
    investment_id  INTEGER       NOT NULL REFERENCES investments(id),
    transaction_id INTEGER       NOT NULL REFERENCES transactions(id),
    entry_type     VARCHAR(20)   NOT NULL
                   CHECK (entry_type IN ('EXPENSE', 'INFLOW', 'TAX')),
    amount         NUMERIC(20,4) NOT NULL,
    description    TEXT          NOT NULL,
    entry_date     DATE          NOT NULL,
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_by     INTEGER       NOT NULL REFERENCES users(id),
    CONSTRAINT positive_inv_txn_amount CHECK (amount > 0)
);


-- ============================================================
-- GROUP 11: EVENTS MANAGEMENT
-- ============================================================

CREATE TABLE event_types (
    id           SERIAL PRIMARY KEY,
    name         VARCHAR(100) NOT NULL UNIQUE,
    abbreviation VARCHAR(20)  NOT NULL UNIQUE,
    description  TEXT,
    is_active    BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by   INTEGER REFERENCES users(id)
);

CREATE TABLE events (
    id            SERIAL PRIMARY KEY,
    reference_id  INTEGER      NOT NULL REFERENCES references_registry(id),
    event_type_id INTEGER      NOT NULL REFERENCES event_types(id),
    category_id   INTEGER      NOT NULL REFERENCES categories(id),
    title         VARCHAR(255) NOT NULL,
    description   TEXT,
    location      TEXT,
    event_date    TIMESTAMPTZ  NOT NULL,
    end_date      TIMESTAMPTZ,
    recurrence    VARCHAR(30)
                  CHECK (recurrence IN ('NONE','DAILY','WEEKLY','MONTHLY','ANNUALLY')),
    status        VARCHAR(30)  NOT NULL DEFAULT 'DRAFT'
                  CHECK (status IN (
                      'DRAFT','PENDING_APPROVAL','APPROVED','CANCELLED','COMPLETED'
                  )),
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by    INTEGER      NOT NULL REFERENCES users(id),
    approved_by   INTEGER REFERENCES users(id),
    approved_at   TIMESTAMPTZ
);

CREATE TABLE event_notifications (
    id                SERIAL PRIMARY KEY,
    event_id          INTEGER     NOT NULL REFERENCES events(id),
    user_id           INTEGER REFERENCES users(id),
    role_id           INTEGER REFERENCES roles(id),
    email_override    VARCHAR(255),
    notification_type VARCHAR(30) NOT NULL DEFAULT 'EMAIL'
                      CHECK (notification_type IN ('EMAIL','IN_APP','BOTH')),
    sent_at           TIMESTAMPTZ,
    send_status       VARCHAR(20) DEFAULT 'PENDING'
                      CHECK (send_status IN ('PENDING','SENT','FAILED'))
);


-- ============================================================
-- GROUP 12: DOCUMENT MANAGEMENT
-- ============================================================

CREATE TABLE document_templates (
    id            SERIAL PRIMARY KEY,
    name          VARCHAR(200) NOT NULL,
    template_type VARCHAR(50)  NOT NULL
                  CHECK (template_type IN (
                      'MEETING_MINUTES','MEETING_AGENDA','INVESTMENT_PROPOSAL',
                      'FINANCIAL_REPORT_GENERAL','FINANCIAL_REPORT_INDIVIDUAL',
                      'RECEIPT','RESOLUTION','CONTRACT','LOAN_AGREEMENT','GRANT_AGREEMENT','OTHER'
                  )),
    description   TEXT,
    template_body TEXT         NOT NULL,
    version       INTEGER      NOT NULL DEFAULT 1,
    is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by    INTEGER REFERENCES users(id),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_by    INTEGER REFERENCES users(id)
);

CREATE TABLE documents (
    id                  SERIAL PRIMARY KEY,
    reference_id        INTEGER      NOT NULL REFERENCES references_registry(id),
    category_id         INTEGER      NOT NULL REFERENCES categories(id),
    title               VARCHAR(255) NOT NULL,
    document_type       VARCHAR(50)  NOT NULL
                        CHECK (document_type IN (
                            'MEETING_MINUTES','MEETING_AGENDA','INVESTMENT_PROPOSAL',
                            'FINANCIAL_REPORT_GENERAL','FINANCIAL_REPORT_INDIVIDUAL',
                            'RECEIPT','RESOLUTION','CONTRACT','LOAN_AGREEMENT','GRANT_AGREEMENT',
                            'AUDITOR_FEEDBACK','AUDIT_REPORT','OTHER'
                        )),
    source              VARCHAR(20)  NOT NULL
                        CHECK (source IN ('UPLOADED','SYSTEM_GENERATED')),
    template_id         INTEGER REFERENCES document_templates(id),
    -- The filled-in values used to render a SYSTEM_GENERATED document
    -- (v1.15.0). Without this, a generated document could only ever be
    -- viewed once, in the moment right after generation — there was no
    -- way to reconstruct it afterwards for preview/download, since
    -- nothing about its content was ever saved. Frontend re-renders the
    -- same client-side template function (exportUtils.js) using this
    -- data on demand.
    template_data       JSONB,
    file_path           TEXT,
    file_name           TEXT,
    file_size_bytes     BIGINT,
    mime_type           VARCHAR(100),
    version             INTEGER      NOT NULL DEFAULT 1,
    parent_document_id  INTEGER REFERENCES documents(id),
    related_record_type VARCHAR(50),
    related_record_id   INTEGER,
    status              VARCHAR(30)  NOT NULL DEFAULT 'DRAFT'
                        CHECK (status IN ('DRAFT','FINAL','ARCHIVED','SUPERSEDED')),
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by          INTEGER      NOT NULL REFERENCES users(id),
    approved_by         INTEGER REFERENCES users(id),
    approved_at         TIMESTAMPTZ,
    -- v1.23.0 — multi-signatory approval (Section 4.29). For document
    -- types with active signature_requirements rows, approved_by/at
    -- are set once the LAST required signature lands (not by a single
    -- approveDocument call). fully_signed is the reliable flag to
    -- check either way.
    fully_signed        BOOLEAN      NOT NULL DEFAULT FALSE,
    fully_signed_at     TIMESTAMPTZ
);

CREATE TABLE document_access (
    id            SERIAL PRIMARY KEY,
    document_id   INTEGER REFERENCES documents(id),
    document_type VARCHAR(50),
    role_id       INTEGER REFERENCES roles(id),
    can_view      BOOLEAN     NOT NULL DEFAULT FALSE,
    can_download  BOOLEAN     NOT NULL DEFAULT FALSE,
    can_edit      BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by    INTEGER REFERENCES users(id)
);

-- Now add forward-reference FKs to grants and loans that point to documents
ALTER TABLE grants
    ADD CONSTRAINT fk_grant_agreement_doc
    FOREIGN KEY (agreement_document_id) REFERENCES documents(id);

ALTER TABLE grant_conditions
    ADD CONSTRAINT fk_grant_condition_evidence_doc
    FOREIGN KEY (evidence_document_id) REFERENCES documents(id);

ALTER TABLE loans_received
    ADD CONSTRAINT fk_loan_received_agreement_doc
    FOREIGN KEY (agreement_document_id) REFERENCES documents(id);

ALTER TABLE loans_given
    ADD CONSTRAINT fk_loan_given_agreement_doc
    FOREIGN KEY (agreement_document_id) REFERENCES documents(id);

-- Now add forward-reference FKs from transactions to grants and loans
ALTER TABLE transactions
    ADD CONSTRAINT fk_tx_grant_tranche
    FOREIGN KEY (grant_tranche_id) REFERENCES grant_tranches(id);

ALTER TABLE transactions
    ADD CONSTRAINT fk_tx_loan_received
    FOREIGN KEY (loan_received_id) REFERENCES loans_received(id);

ALTER TABLE transactions
    ADD CONSTRAINT fk_tx_loan_given
    FOREIGN KEY (loan_given_id) REFERENCES loans_given(id);

ALTER TABLE transactions
    ADD CONSTRAINT fk_tx_investment
    FOREIGN KEY (investment_id) REFERENCES investments(id);


-- ============================================================
-- GROUP 13: REPORTING
-- ============================================================

CREATE TABLE report_log (
    id                  SERIAL PRIMARY KEY,
    report_type         VARCHAR(50)  NOT NULL
                        CHECK (report_type IN (
                            'MONTHLY_GENERAL','MONTHLY_INDIVIDUAL',
                            'ON_DEMAND_GENERAL','ON_DEMAND_INDIVIDUAL'
                        )),
    report_period       CHAR(6),
    generated_for_user  INTEGER REFERENCES users(id),
    document_id         INTEGER REFERENCES documents(id),
    email_sent_to       VARCHAR(255),
    sent_at             TIMESTAMPTZ,
    send_status         VARCHAR(20) DEFAULT 'PENDING'
                        CHECK (send_status IN ('PENDING','SENT','FAILED')),
    generated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    generated_by        INTEGER REFERENCES users(id)
);


-- ============================================================
-- GROUP 14: AUDIT LOG — Append-only, Never Updated or Deleted
-- ============================================================

CREATE TABLE audit_log (
    id          BIGSERIAL   PRIMARY KEY,
    user_id     INTEGER REFERENCES users(id),
    session_id  TEXT,
    ip_address  INET,
    action      VARCHAR(100) NOT NULL,
    module      VARCHAR(50)  NOT NULL,
    record_type VARCHAR(50),
    record_id   INTEGER,
    old_values  JSONB,
    new_values  JSONB,
    description TEXT,
    status      VARCHAR(20)  NOT NULL DEFAULT 'SUCCESS'
                CHECK (status IN ('SUCCESS','FAILURE','WARNING')),
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);


-- ============================================================
-- GROUP 15: DIVIDENDS, AUTHORITY PAYMENTS, MEMBER SAVINGS,
--           AND REQUISITIONS
-- Added in v1.2.0 — these tables back dividendsController.js,
-- savingsController.js and requisitionsController.js, which were
-- built after the original schema and had never been added here.
-- ============================================================

-- A dividend declaration for a period. Split across all shareholders
-- with an assigned percentage at the time of declaration.
CREATE TABLE dividends (
    id               SERIAL PRIMARY KEY,
    reference_id     INTEGER       NOT NULL REFERENCES references_registry(id),
    account_id       INTEGER       NOT NULL REFERENCES accounts(id),
    currency_id      INTEGER       NOT NULL REFERENCES currencies(id),
    category_id      INTEGER       NOT NULL REFERENCES categories(id),
    total_amount     NUMERIC(20,4) NOT NULL,
    period_label     VARCHAR(100),               -- e.g. "Q1 2026", "FY2025"
    declaration_date DATE          NOT NULL,
    payment_date     TIMESTAMPTZ,                -- set when paid
    status           VARCHAR(30)   NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING','PAID','CANCELLED')),
    notes            TEXT,
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_by       INTEGER       NOT NULL REFERENCES users(id),
    approved_by      INTEGER REFERENCES users(id),
    approved_at      TIMESTAMPTZ,
    -- The two legs posted on approval (v1.22.0): transaction_id is the
    -- debit from this dividend's own account; savings_transaction_id is
    -- the credit into the single Savings account, from which every
    -- shareholder's savings_balances share (below) is drawn.
    -- exchange_rate is the manually-entered rate used to convert into
    -- the Savings account's currency (1 if they already match) — see
    -- dividend_distributions.credited_amount for each shareholder's
    -- actual converted share.
    transaction_id         INTEGER REFERENCES transactions(id),
    savings_transaction_id INTEGER REFERENCES transactions(id),
    exchange_rate           NUMERIC(20,8),
    CONSTRAINT positive_dividend_total CHECK (total_amount > 0)
);

-- One row per shareholder per dividend — a snapshot of their share at
-- declaration time, so later shareholding changes don't rewrite history.
CREATE TABLE dividend_distributions (
    id                 SERIAL PRIMARY KEY,
    dividend_id        INTEGER       NOT NULL REFERENCES dividends(id),
    user_id            INTEGER       NOT NULL REFERENCES users(id),
    shares_at_time     NUMERIC(20,4) NOT NULL,
    percentage_at_time NUMERIC(8,4)  NOT NULL,
    amount             NUMERIC(20,4) NOT NULL,  -- declared share, in the dividend's own currency
    status             VARCHAR(30)   NOT NULL DEFAULT 'PENDING'
                       CHECK (status IN ('PENDING','PAID')),
    transaction_id     INTEGER REFERENCES transactions(id),
    -- credited_amount/exchange_rate (v1.22.0): the actual amount added
    -- to this shareholder's savings_balances, in the Savings account's
    -- own currency, and the rate used to get there from `amount` above.
    credited_amount    NUMERIC(20,4),
    exchange_rate      NUMERIC(20,8),
    paid_at            TIMESTAMPTZ,
    created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT positive_distribution_amount CHECK (amount > 0)
);

-- Payments to regulatory/government bodies (tax, registration, statutory funds)
CREATE TABLE authority_payments (
    id             SERIAL PRIMARY KEY,
    reference_id   INTEGER       NOT NULL REFERENCES references_registry(id),
    account_id     INTEGER       NOT NULL REFERENCES accounts(id),
    currency_id    INTEGER       NOT NULL REFERENCES currencies(id),
    category_id    INTEGER       NOT NULL REFERENCES categories(id),
    transaction_id INTEGER       NOT NULL REFERENCES transactions(id),
    authority_type VARCHAR(20)   NOT NULL
                   CHECK (authority_type IN ('URA','URSB','BANK','NSSF','OTHER')),
    authority_name VARCHAR(255)  NOT NULL,
    payment_type   VARCHAR(100),
    authority_ref  VARCHAR(150),
    amount         NUMERIC(20,4) NOT NULL,
    payment_date   DATE          NOT NULL,
    notes          TEXT,
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_by     INTEGER       NOT NULL REFERENCES users(id),
    CONSTRAINT positive_authority_amount CHECK (amount > 0)
);

-- Any member can request funds for a purpose; Treasurer/Director approves
-- (posting a transaction automatically) or rejects. Defined here, before
-- member_savings, because member_savings.requisition_id references it.
CREATE TABLE requisitions (
    id                SERIAL PRIMARY KEY,
    reference_id      INTEGER       NOT NULL REFERENCES references_registry(id),
    requested_by      INTEGER       NOT NULL REFERENCES users(id),
    category_id       INTEGER       NOT NULL REFERENCES categories(id),
    title             VARCHAR(255)  NOT NULL,
    description       TEXT,
    amount_requested  NUMERIC(20,4) NOT NULL,
    purpose           TEXT          NOT NULL,
    required_by_date  DATE,
    priority          VARCHAR(20)   NOT NULL DEFAULT 'NORMAL'
                      CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),
    -- A requisition is a request for money OUT (EXPENSE — the original use
    -- of this table), a member asking the Treasurer to acknowledge and
    -- record capital they've ALREADY contributed (CONTRIBUTION_ACKNOWLEDGEMENT),
    -- or a member asking to add money to their own savings
    -- (SAVINGS_DEPOSIT — see member_savings). Regular members can no
    -- longer post these directly — this is the only path open to them;
    -- staff still does the actual recording/approval. contribution_date
    -- is reused for SAVINGS_DEPOSIT too — it's the date the member says
    -- they actually paid the company, which may differ from when they
    -- submitted this request.
    requisition_type  VARCHAR(30)   NOT NULL DEFAULT 'EXPENSE'
                      CHECK (requisition_type IN ('EXPENSE', 'CONTRIBUTION_ACKNOWLEDGEMENT', 'SAVINGS_DEPOSIT')),
    contribution_date DATE,
    status            VARCHAR(30)   NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED')),
    -- Populated only once approved
    account_id        INTEGER REFERENCES accounts(id),
    currency_id       INTEGER REFERENCES currencies(id),
    amount_approved   NUMERIC(20,4),
    transaction_id    INTEGER REFERENCES transactions(id),
    reviewed_by       INTEGER REFERENCES users(id),
    reviewed_at       TIMESTAMPTZ,
    review_notes      TEXT,
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT positive_amount_requested CHECK (amount_requested > 0),
    CONSTRAINT positive_amount_approved  CHECK (amount_approved IS NULL OR amount_approved > 0)
);

-- Personal savings for shareholders, held in the primary account.
-- Two entry types:
--   FIXED_TERM — legacy style: one lump sum, agreed rate, fixed maturity
--                date, paid back in full at/after maturity (original v1.2.0
--                behaviour, kept working as-is for any existing records).
--   FLEXIBLE   — v1.10.0 style: an ongoing per-member balance (see
--                savings_balances) built up from many deposits over time,
--                with interest auto-accrued daily at the company-wide rate
--                in savings_settings, and paid out via savings_handouts
--                rather than a single all-at-once withdrawal.
-- A FLEXIBLE deposit can be entered directly by the Treasurer/Assistant
-- Treasurer on behalf of any member (source=TREASURY_DIRECT), or requested
-- by the member themself via a SAVINGS_DEPOSIT requisition
-- (source=REQUISITION) — either way it sits PENDING_APPROVAL until a
-- Treasurer/Assistant Treasurer approves it, which is what actually posts
-- the crediting transaction and adds it to the member's running balance.
CREATE TABLE member_savings (
    id                         SERIAL PRIMARY KEY,
    reference_id               INTEGER       NOT NULL REFERENCES references_registry(id),
    user_id                    INTEGER       NOT NULL REFERENCES users(id),
    account_id                 INTEGER       NOT NULL REFERENCES accounts(id),
    currency_id                INTEGER       NOT NULL REFERENCES currencies(id),
    category_id                INTEGER       NOT NULL REFERENCES categories(id),
    principal_amount           NUMERIC(20,4) NOT NULL,
    interest_rate              NUMERIC(8,4)  NOT NULL DEFAULT 0,   -- % per period, simple interest (FIXED_TERM only)
    interest_period             VARCHAR(20)   NOT NULL DEFAULT 'ANNUALLY'
                                CHECK (interest_period IN ('DAILY','WEEKLY','MONTHLY','ANNUALLY')),
    deposit_date                DATE          NOT NULL,
    maturity_date               DATE,                    -- FIXED_TERM only
    amount_at_maturity          NUMERIC(20,4),            -- FIXED_TERM only — principal + interest at deposit time
    entry_type                  VARCHAR(20)   NOT NULL DEFAULT 'FLEXIBLE'
                                CHECK (entry_type IN ('FIXED_TERM','FLEXIBLE')),
    source                      VARCHAR(20)   NOT NULL DEFAULT 'TREASURY_DIRECT'
                                CHECK (source IN ('TREASURY_DIRECT','REQUISITION')),
    requisition_id              INTEGER REFERENCES requisitions(id),
    recorded_by                 INTEGER REFERENCES users(id),  -- who entered it (may differ from user_id, the owner)
    status                      VARCHAR(30)   NOT NULL DEFAULT 'ACTIVE'
                                CHECK (status IN ('PENDING_APPROVAL','ACTIVE','WITHDRAWN','REJECTED','CANCELLED')),
    notes                       TEXT,
    review_notes                TEXT,
    secretary_approved_by       INTEGER REFERENCES users(id),
    secretary_approved_at       TIMESTAMPTZ,
    transaction_id              INTEGER REFERENCES transactions(id), -- deposit CREDIT, set once approved
    withdrawal_transaction_id   INTEGER REFERENCES transactions(id),                -- FIXED_TERM withdrawal DEBIT
    withdrawn_at                TIMESTAMPTZ,
    withdrawn_by                INTEGER REFERENCES users(id),
    created_at                  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_by                  INTEGER       NOT NULL REFERENCES users(id),
    CONSTRAINT positive_savings_principal CHECK (principal_amount > 0),
    CONSTRAINT maturity_after_deposit CHECK (maturity_date IS NULL OR maturity_date > deposit_date)
);

-- Company-wide interest rate applied to FLEXIBLE savings balances,
-- accrued automatically (see savings_interest_accrual). Single-row table.
CREATE TABLE savings_settings (
    id                    SERIAL PRIMARY KEY,
    interest_rate         NUMERIC(8,4)  NOT NULL DEFAULT 0,
    interest_period       VARCHAR(20)   NOT NULL DEFAULT 'ANNUALLY'
                          CHECK (interest_period IN ('DAILY','WEEKLY','MONTHLY','ANNUALLY')),
    interest_calculation  VARCHAR(20)   NOT NULL DEFAULT 'SIMPLE'
                          CHECK (interest_calculation IN ('SIMPLE','COMPOUND')),
    updated_by            INTEGER REFERENCES users(id),
    updated_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- One row per member with any FLEXIBLE savings activity — the running
-- balance that deposits/handouts and the daily accrual job all update.
CREATE TABLE savings_balances (
    id                   SERIAL PRIMARY KEY,
    user_id              INTEGER       NOT NULL UNIQUE REFERENCES users(id),
    principal_balance    NUMERIC(20,4) NOT NULL DEFAULT 0,
    accrued_interest     NUMERIC(20,4) NOT NULL DEFAULT 0,  -- earned, not yet handed out
    total_interest_paid  NUMERIC(20,4) NOT NULL DEFAULT 0,
    currency_id          INTEGER REFERENCES currencies(id),
    updated_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT non_negative_savings_balance  CHECK (principal_balance >= 0),
    CONSTRAINT non_negative_accrued_interest CHECK (accrued_interest >= 0)
);

-- Daily accrual ledger for FLEXIBLE savings — mirrors
-- loan_received_interest_accrual's pattern exactly.
CREATE TABLE savings_interest_accrual (
    id                 SERIAL PRIMARY KEY,
    user_id            INTEGER       NOT NULL REFERENCES users(id),
    accrual_date       DATE          NOT NULL,
    rate_used          NUMERIC(8,4)  NOT NULL,
    principal_balance  NUMERIC(20,4) NOT NULL,
    interest_accrued   NUMERIC(20,4) NOT NULL,
    created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, accrual_date)
);

-- A payout of FLEXIBLE savings (principal and/or accrued interest) to a
-- member. Entered by the Treasurer/Assistant Treasurer, but the money
-- only actually leaves the account and the balance only actually drops
-- once the receiving member confirms it — that's their "approval".
CREATE TABLE savings_handouts (
    id                SERIAL PRIMARY KEY,
    reference_id      INTEGER       NOT NULL REFERENCES references_registry(id),
    user_id           INTEGER       NOT NULL REFERENCES users(id),      -- receiving member
    account_id        INTEGER       NOT NULL REFERENCES accounts(id),   -- account paying out
    category_id       INTEGER       NOT NULL REFERENCES categories(id), -- categorizes the DEBIT transaction posted on confirm
    principal_amount  NUMERIC(20,4) NOT NULL,
    interest_amount   NUMERIC(20,4) NOT NULL DEFAULT 0,
    total_amount      NUMERIC(20,4) NOT NULL,
    currency_id       INTEGER       NOT NULL REFERENCES currencies(id),
    handout_date      DATE          NOT NULL,
    notes             TEXT,
    status            VARCHAR(30)   NOT NULL DEFAULT 'PENDING_CONFIRMATION'
                      CHECK (status IN ('PENDING_CONFIRMATION','CONFIRMED','REJECTED')),
    transaction_id    INTEGER REFERENCES transactions(id),  -- set once confirmed
    entered_by        INTEGER       NOT NULL REFERENCES users(id),
    confirmed_at      TIMESTAMPTZ,
    rejected_reason   TEXT,
    rejected_at       TIMESTAMPTZ,
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT positive_handout_principal CHECK (principal_amount > 0),
    CONSTRAINT positive_handout_total     CHECK (total_amount > 0)
);


-- ============================================================
-- GROUP 14b: SIDE FUND — optional shared petty-cash-style pool
-- for day-to-day simple activities.
--
-- A side fund is NOT its own bank account — it is an "envelope"
-- balance layered inside an existing Primary or Secondary account
-- (side_fund_config.parent_account_id), which is why it needs a
-- currency set (must match, or at least be tracked against, that
-- parent account's own currency).
--
-- Every side fund movement is dual-posted, in the same DB
-- transaction, so the two numbers can never drift apart:
--   1. A completely normal transaction on the parent account (so the
--      account's real balance is always correct and every movement
--      shows up in the ordinary Transactions ledger — side fund
--      expenses are deliberately posted with inflow_type 'EXPENSE',
--      the same as any other expense, per the "recorded as general
--      expenses" requirement)
--   2. An increment/decrement of side_fund_config.current_balance
--      (the envelope) by the exact same amount
--
-- Each member owes a monthly due (side_fund_config.monthly_amount —
-- changeable at any time; changing it only affects dues generated
-- from that point on, never past periods). Dues are auto-generated
-- for every active shareholder on the 1st of each month by a cron
-- job (see jobs/scheduler.js); any due still unpaid when the
-- following month's job runs is marked DEFAULTED.
-- ============================================================

-- Single-row table (id is always 1), same pattern as company_settings.
CREATE TABLE side_fund_config (
    id                 INTEGER       PRIMARY KEY DEFAULT 1,
    is_active          BOOLEAN       NOT NULL DEFAULT FALSE,
    parent_account_id  INTEGER REFERENCES accounts(id),
    currency_id        INTEGER REFERENCES currencies(id),
    monthly_amount     NUMERIC(20,4) NOT NULL DEFAULT 0,
    current_balance    NUMERIC(20,4) NOT NULL DEFAULT 0,
    updated_by         INTEGER REFERENCES users(id),
    updated_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT single_side_fund_row         CHECK (id = 1),
    CONSTRAINT non_negative_side_fund_balance CHECK (current_balance >= 0),
    CONSTRAINT non_negative_monthly_amount    CHECK (monthly_amount >= 0)
);

-- One row per member per calendar month (period = 'YYYY-MM'),
-- auto-generated by the monthly cron job using whatever
-- monthly_amount is set on side_fund_config at that time. Recording
-- a payment against a due is what actually moves the money (see
-- sideFundController.recordDuePayment) — the due row itself is just
-- the tracked obligation.
CREATE TABLE side_fund_dues (
    id             SERIAL PRIMARY KEY,
    user_id        INTEGER       NOT NULL REFERENCES users(id),
    period         CHAR(7)       NOT NULL,  -- 'YYYY-MM'
    amount_due     NUMERIC(20,4) NOT NULL,
    amount_paid    NUMERIC(20,4) NOT NULL DEFAULT 0,
    status         VARCHAR(20)   NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING','PARTIAL','PAID','DEFAULTED')),
    transaction_id INTEGER REFERENCES transactions(id),  -- the contribution transaction, once paid
    paid_date      DATE,
    recorded_by    INTEGER REFERENCES users(id),
    notes          TEXT,
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT non_negative_side_fund_due  CHECK (amount_due >= 0),
    CONSTRAINT non_negative_side_fund_paid CHECK (amount_paid >= 0),
    UNIQUE (user_id, period)
);

-- Expenses drawn from the side fund envelope. The actual money
-- movement is a completely normal EXPENSE transaction against the
-- parent account (so it shows up in the general Transactions ledger
-- exactly like any other expense) — this table just links that
-- transaction back to the side fund so its envelope balance can be
-- decremented and its own spending history shown on the Side Fund
-- page.
CREATE TABLE side_fund_expenses (
    id             SERIAL PRIMARY KEY,
    reference_id   INTEGER       NOT NULL REFERENCES references_registry(id),
    transaction_id INTEGER       NOT NULL REFERENCES transactions(id),
    amount         NUMERIC(20,4) NOT NULL,
    description    TEXT          NOT NULL,
    expense_date   DATE          NOT NULL,
    recorded_by    INTEGER       NOT NULL REFERENCES users(id),
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT positive_side_fund_expense CHECK (amount > 0)
);

-- ============================================================
-- GROUP 14c: SAVINGS POOL — "OTHER INFLOW" (v1.14.0)
--
-- The SAVINGS account only ever takes CREDIT postings — there is no
-- concept of an expense on it. Member deposits/handouts (member_savings,
-- savings_handouts) are one source of credits. This table is the other:
-- a non-member inflow into the same pool — e.g. the fund was invested
-- and the investment paid out a profit back into the pool. It goes
-- through the exact same Treasurer/Assistant Treasurer two-step
-- approval pipeline as a member deposit (SAVINGS_CREATE to record,
-- SAVINGS_APPROVE to approve — no new permissions needed), and only
-- posts the crediting transaction once approved.
-- ============================================================
CREATE TABLE savings_pool_inflows (
    id             SERIAL PRIMARY KEY,
    reference_id   INTEGER REFERENCES references_registry(id),
    account_id     INTEGER       NOT NULL REFERENCES accounts(id),
    currency_id    INTEGER       NOT NULL REFERENCES currencies(id),
    category_id    INTEGER       NOT NULL REFERENCES categories(id),
    amount         NUMERIC(20,4) NOT NULL,
    value_date     DATE          NOT NULL,
    description    TEXT          NOT NULL,
    status         VARCHAR(20)   NOT NULL DEFAULT 'PENDING_APPROVAL'
                   CHECK (status IN ('PENDING_APPROVAL','ACTIVE','REJECTED')),
    recorded_by    INTEGER       NOT NULL REFERENCES users(id),
    approved_by    INTEGER REFERENCES users(id),
    approved_at    TIMESTAMPTZ,
    review_notes   TEXT,
    transaction_id INTEGER REFERENCES transactions(id),
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT positive_savings_pool_inflow CHECK (amount > 0)
);


-- ============================================================
-- INDEXES
-- ============================================================

-- Users
CREATE INDEX idx_users_email     ON users (email);
CREATE INDEX idx_users_uuid      ON users (uuid);

-- Transactions
CREATE INDEX idx_transactions_account    ON transactions (account_id);
CREATE INDEX idx_transactions_date       ON transactions (value_date DESC);
CREATE INDEX idx_transactions_status     ON transactions (status);
CREATE INDEX idx_transactions_category   ON transactions (category_id);
CREATE INDEX idx_transactions_inflow     ON transactions (inflow_type);
CREATE INDEX idx_transactions_created_by ON transactions (created_by);

-- Transfers
CREATE INDEX idx_transfers_from   ON transfers (from_account_id);
CREATE INDEX idx_transfers_to     ON transfers (to_account_id);
CREATE INDEX idx_transfers_status ON transfers (status);

-- Grants
CREATE INDEX idx_grants_account  ON grants (account_id);
CREATE INDEX idx_grants_status   ON grants (status);
CREATE INDEX idx_grant_tranches  ON grant_tranches (grant_id);

-- Loans received
CREATE INDEX idx_loans_rec_account  ON loans_received (account_id);
CREATE INDEX idx_loans_rec_status   ON loans_received (status);
CREATE INDEX idx_loans_rec_overdue  ON loans_received (is_overdue);
CREATE INDEX idx_loans_rec_due      ON loans_received (due_date);
CREATE INDEX idx_loans_rec_accrual  ON loan_received_interest_accrual (loan_received_id, accrual_date);

-- Loans given
CREATE INDEX idx_loans_giv_account  ON loans_given (account_id);
CREATE INDEX idx_loans_giv_status   ON loans_given (status);
CREATE INDEX idx_loans_giv_overdue  ON loans_given (is_overdue);
CREATE INDEX idx_loans_giv_due      ON loans_given (due_date);
CREATE INDEX idx_loans_giv_accrual  ON loan_given_interest_accrual (loan_given_id, accrual_date);

-- Investments
CREATE INDEX idx_investments_status  ON investments (status);
CREATE INDEX idx_investments_account ON investments (funding_account_id);
CREATE INDEX idx_investments_type    ON investments (investment_type);
CREATE INDEX idx_inv_returns         ON investment_returns (investment_id);

-- Bond coupons
CREATE INDEX idx_bond_coupons_investment ON bond_coupons (investment_id);
CREATE INDEX idx_bond_coupons_status     ON bond_coupons (status);
CREATE INDEX idx_bond_coupons_due_date   ON bond_coupons (due_date);

-- Investment operational transactions
CREATE INDEX idx_inv_txn_investment ON investment_transactions (investment_id);
CREATE INDEX idx_inv_txn_type       ON investment_transactions (entry_type);

-- Projects
CREATE INDEX idx_projects_investment ON projects (investment_id);
CREATE INDEX idx_projects_status     ON projects (status);

-- Documents
CREATE INDEX idx_documents_type     ON documents (document_type);
CREATE INDEX idx_documents_category ON documents (category_id);
CREATE INDEX idx_documents_related  ON documents (related_record_type, related_record_id);

-- Events
CREATE INDEX idx_events_date   ON events (event_date);
CREATE INDEX idx_events_status ON events (status);
CREATE INDEX idx_events_type   ON events (event_type_id);

-- References
CREATE INDEX idx_references_code  ON references_registry (reference_code);
CREATE INDEX idx_references_month ON references_registry (year_month);

-- Categories
CREATE INDEX idx_categories_parent ON categories (parent_id);
CREATE INDEX idx_categories_module ON categories (module);

-- Audit log
CREATE INDEX idx_audit_user    ON audit_log (user_id);
CREATE INDEX idx_audit_action  ON audit_log (action);
CREATE INDEX idx_audit_module  ON audit_log (module);
CREATE INDEX idx_audit_created ON audit_log (created_at DESC);
CREATE INDEX idx_audit_record  ON audit_log (record_type, record_id);

-- Dividends
CREATE INDEX idx_dividends_status       ON dividends (status);
CREATE INDEX idx_dividends_account      ON dividends (account_id);
CREATE INDEX idx_dividend_dist_dividend ON dividend_distributions (dividend_id);
CREATE INDEX idx_dividend_dist_user     ON dividend_distributions (user_id);

-- Authority payments
CREATE INDEX idx_authority_payments_type    ON authority_payments (authority_type);
CREATE INDEX idx_authority_payments_account ON authority_payments (account_id);

-- Member savings
CREATE INDEX idx_member_savings_user     ON member_savings (user_id);
CREATE INDEX idx_member_savings_status   ON member_savings (status);
CREATE INDEX idx_member_savings_maturity ON member_savings (maturity_date);

-- Savings pool inflows
CREATE INDEX idx_savings_pool_inflows_status ON savings_pool_inflows (status);

-- Requisitions
CREATE INDEX idx_requisitions_status       ON requisitions (status);
CREATE INDEX idx_requisitions_requested_by ON requisitions (requested_by);
CREATE INDEX idx_requisitions_priority     ON requisitions (priority);

-- Side fund
CREATE INDEX idx_side_fund_dues_user   ON side_fund_dues (user_id);
CREATE INDEX idx_side_fund_dues_period ON side_fund_dues (period);
CREATE INDEX idx_side_fund_dues_status ON side_fund_dues (status);


-- ============================================================
-- SEED DATA
-- ============================================================

INSERT INTO currencies (code, name, symbol) VALUES
    ('EUR', 'Euro', '€'),
    ('UGX', 'Ugandan Shilling', 'UGX');

INSERT INTO roles (name, description, is_system_role) VALUES
    ('Admin',               'Full system access and configuration',                 TRUE),
    ('Director',            'Company director — financial oversight and approvals',  TRUE),
    ('Treasurer',           'Primary financial approver and accounts manager',       TRUE),
    ('Assistant Treasurer', 'Supports Treasurer with financial recording and contribution acknowledgement', TRUE),
    ('Secretary',           'Events, documents, and meeting management',             TRUE),
    ('Assistant Secretary', 'Supports Secretary with events and documents',          TRUE),
    ('Coordinator',         'Operational coordination and project tracking',         TRUE),
    ('Shareholder',         'Capital contributor — personal and general dashboard',  TRUE),
    ('Auditor',             'External auditor — read-only access to a specific scoped audit engagement, nothing else', TRUE),
    ('Administrative Officer', 'Hired/contracted staff — meetings, minutes, and correspondence; no finance access except individually granted documents', TRUE);

INSERT INTO categories (parent_id, module, name, abbreviation, description) VALUES
    -- Finance
    (NULL, 'FINANCE', 'Income',         'INC',  'All income streams'),
    (NULL, 'FINANCE', 'Expense',        'EXP',  'All expenditure'),
    (NULL, 'FINANCE', 'Transfer',       'TRF',  'Inter-account transfers'),
    (NULL, 'FINANCE', 'Loan',           'LN',   'All loan activity'),
    (NULL, 'FINANCE', 'Grant',          'GRN',  'All grant activity'),
    (NULL, 'FINANCE', 'Service Fees',   'SVC',  'Contracted staff service fees and expense reimbursements'),
    -- Documents
    (NULL, 'DOCUMENT', 'Financial',     'FIN',  'Financial documents'),
    (NULL, 'DOCUMENT', 'Corporate',     'CORP', 'Corporate governance documents'),
    (NULL, 'DOCUMENT', 'Legal',         'LEG',  'Legal and compliance documents'),
    (NULL, 'DOCUMENT', 'Agreements',    'AGR',  'Loan and grant agreements'),
    -- Events
    (NULL, 'EVENT', 'Meetings',         'MTG',  'All meeting types'),
    (NULL, 'EVENT', 'Deadlines',        'DL',   'Regulatory and business deadlines'),
    (NULL, 'EVENT', 'Anniversaries',    'ANN',  'Company calendar anniversaries'),
    -- Investments
    (NULL, 'INVESTMENT', 'Active',      'ACT',  'Currently active investments'),
    (NULL, 'INVESTMENT', 'Pipeline',    'PIPE', 'Planned future investments');

-- category_paths has to be populated for every category or any query that
-- INNER JOINs it (most of the app — grants, loans, requisitions, documents,
-- events, investments, transactions all do this to show a category's full
-- breadcrumb) will silently find zero rows for these seed categories.
-- Normally the categories API route populates this automatically when a
-- category is created; these seed rows are inserted directly, so it has to
-- be done by hand here. All seed categories are top-level (parent_id NULL).
INSERT INTO category_paths (category_id, full_path, full_abbreviation, depth)
SELECT id, name, abbreviation, 0
FROM categories
WHERE parent_id IS NULL;

INSERT INTO event_types (name, abbreviation, description) VALUES
    ('Meeting',             'MTG',  'Company meetings of any type'),
    ('Bidding Deadline',    'BID',  'Deadline for bidding on a contract or project'),
    ('Tax Filing',          'TAX',  'Government tax filing deadline'),
    ('Company Anniversary', 'ANN',  'Company anniversary or founding date'),
    ('Auction',             'AUC',  'Scheduled auction event'),
    ('License Renewal',     'LIC',  'Company or operational license renewal deadline'),
    ('Loan Repayment',      'LNREP','Scheduled loan repayment due date'),
    ('Grant Reporting',     'GRNREP','Grant condition reporting deadline');

INSERT INTO permissions (code, module, description) VALUES
    -- Finance
    ('FINANCE_VIEW_ALL',                    'FINANCE',      'View all financial records'),
    ('FINANCE_VIEW_OWN',                    'FINANCE',      'View own contributions and personal data'),
    ('FINANCE_TRANSACTION_CREATE',          'FINANCE',      'Create a new financial transaction'),
    ('FINANCE_TRANSACTION_APPROVE',         'FINANCE',      'Approve a pending transaction'),
    ('FINANCE_TRANSFER_CREATE',             'FINANCE',      'Initiate a transfer between accounts'),
    ('FINANCE_TRANSFER_APPROVE',            'FINANCE',      'Approve a transfer (Treasurer)'),
    ('FINANCE_TRANSFER_APPROVE_REVERSE',    'FINANCE',      'Approve secondary-to-primary transfer'),
    ('FINANCE_FLOOR_LIMIT_UPDATE',          'FINANCE',      'Update an account''s floor limit (any account except SAVINGS, which is always exempt)'),
    -- Loans
    ('LOAN_VIEW',                           'FINANCE',      'View loan records'),
    ('LOAN_CREATE',                         'FINANCE',      'Create loan records'),
    ('LOAN_APPROVE',                        'FINANCE',      'Approve loan records'),
    ('LOAN_RATE_AMEND',                     'FINANCE',      'Amend overdue interest rates (Treasurer)'),
    ('LOAN_REPAYMENT_RECORD',               'FINANCE',      'Record a loan repayment'),
    -- Grants
    ('GRANT_VIEW',                          'FINANCE',      'View grant records'),
    ('GRANT_CREATE',                        'FINANCE',      'Create grant records'),
    ('GRANT_APPROVE',                       'FINANCE',      'Approve grant records'),
    ('GRANT_CONDITION_MANAGE',              'FINANCE',      'Manage grant conditions'),
    -- Documents
    ('DOCUMENT_VIEW',                       'DOCUMENTS',    'View documents'),
    ('DOCUMENT_UPLOAD',                     'DOCUMENTS',    'Upload documents'),
    ('DOCUMENT_GENERATE',                   'DOCUMENTS',    'Generate documents from templates'),
    ('DOCUMENT_APPROVE',                    'DOCUMENTS',    'Approve and finalise documents'),
    ('DOCUMENT_ARCHIVE',                    'DOCUMENTS',    'Archive or supersede documents'),
    -- Events
    ('EVENT_VIEW',                          'EVENTS',       'View company events'),
    ('EVENT_CREATE',                        'EVENTS',       'Create new events'),
    ('EVENT_APPROVE',                       'EVENTS',       'Approve events'),
    ('EVENT_MANAGE',                        'EVENTS',       'Full event management'),
    -- Investments
    ('INVESTMENT_VIEW',                     'INVESTMENTS',  'View investment records'),
    ('INVESTMENT_CREATE',                   'INVESTMENTS',  'Create new investment records'),
    ('INVESTMENT_APPROVE',                  'INVESTMENTS',  'Approve investment proposals'),
    ('INVESTMENT_MANAGE',                   'INVESTMENTS',  'Full investment management'),
    -- Users
    ('USER_VIEW_ALL',                       'USERS',        'View all user profiles'),
    ('USER_VIEW_OWN',                       'USERS',        'View own profile only'),
    ('USER_MANAGE',                         'USERS',        'Create, edit, deactivate users'),
    ('ROLE_ASSIGN',                         'USERS',        'Assign and revoke roles'),
    -- System
    ('SYSTEM_CONFIG',                       'SYSTEM',       'System configuration and settings'),
    ('CATEGORY_MANAGE',                     'SYSTEM',       'Add and manage categories'),
    ('AUDIT_VIEW',                          'SYSTEM',       'View the full system audit log'),
    ('REPORT_GENERATE',                     'REPORTS',      'Generate financial and operational reports'),
    ('REPORT_VIEW_ALL',                     'REPORTS',      'View all generated reports'),
    -- Member Savings
    ('SAVINGS_VIEW',                        'FINANCE',      'View all members'' savings records'),
    ('SAVINGS_CREATE',                      'FINANCE',      'Record a savings deposit on behalf of a member'),
    ('SAVINGS_APPROVE',                     'FINANCE',      'Approve a pending savings deposit (Treasurer/Assistant Treasurer)'),
    ('SAVINGS_HANDOUT_CREATE',              'FINANCE',      'Enter a savings handout for a member (Treasurer)'),
    ('SAVINGS_SETTINGS_MANAGE',             'FINANCE',      'Change the company-wide savings interest rate'),
    -- Side Fund
    ('SIDE_FUND_VIEW',                      'FINANCE',      'View side fund balance, dues, and spending history'),
    ('SIDE_FUND_MANAGE',                    'FINANCE',      'Activate/deactivate the side fund and change its settings'),
    ('SIDE_FUND_CONTRIBUTION_RECORD',       'FINANCE',      'Record a member''s monthly side fund due as paid'),
    ('SIDE_FUND_EXPENSE_RECORD',            'FINANCE',      'Record an expense drawn from the side fund');

-- ============================================================
-- GROUP 15: COMPANY SETTINGS (BRANDING)
-- Single-row table (id is always 1) holding the identity of the
-- company running this installation, so the same codebase can be
-- reused by any company without editing source files — a System
-- Admin edits this through Settings > Company in the UI instead.
-- ============================================================

CREATE TABLE company_settings (
    id             INTEGER      PRIMARY KEY DEFAULT 1,
    company_name   VARCHAR(200) NOT NULL,
    company_address TEXT,
    logo_url       TEXT,
    primary_color  VARCHAR(7)   NOT NULL DEFAULT '#1e3a5f',  -- hex, e.g. sidebar/buttons
    accent_color   VARCHAR(7)   NOT NULL DEFAULT '#c9a227',  -- hex, e.g. highlights/badges
    -- "About" content (v1.7.0) — editable the same way as branding,
    -- Settings > Company, Admin only.
    description    TEXT,
    mission        TEXT,
    vision         TEXT,
    core_values    TEXT,
    motto          VARCHAR(300),
    -- v1.24.1 — master on/off switch for the company stamps/seals
    -- feature (Section 4.30). Defaults FALSE — an Admin must
    -- deliberately turn it on; per-document-type configuration
    -- (document_stamp_requirements) can still be set up while off,
    -- it just isn't applied to anything until this is TRUE.
    stamps_enabled BOOLEAN      NOT NULL DEFAULT FALSE,
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_by     INTEGER REFERENCES users(id),
    CONSTRAINT single_row_only CHECK (id = 1)
);

-- Seed the one settings row so the app always has something to read,
-- even before an Admin has customised anything.
INSERT INTO company_settings (id, company_name, company_address)
VALUES (1, 'ZWECK TUKULA Ltd', 'WAKISO, UGANDA')
ON CONFLICT (id) DO NOTHING;

INSERT INTO savings_settings (id, interest_rate, interest_period, interest_calculation)
VALUES (1, 0, 'ANNUALLY', 'SIMPLE')
ON CONFLICT (id) DO NOTHING;

-- Side fund starts inactive with no parent account/currency until an
-- Admin/Treasurer activates it from Settings.
INSERT INTO side_fund_config (id, is_active, monthly_amount, current_balance)
VALUES (1, FALSE, 0, 0)
ON CONFLICT (id) DO NOTHING;

-- Seed the Receipt and Resolution document templates so both appear
-- in "Generate Document" > Step 1 out of the box, without an Admin
-- having to create them by hand first. template_body is a required
-- column but isn't actually read for these — the real rendering is
-- done client-side by receiptTemplate()/resolutionTemplate() in
-- exportUtils.js, keyed off document_templates.template_type; this
-- column just needs a value to satisfy the NOT NULL constraint.
-- No unique constraint exists on template_type, so this uses a
-- NOT EXISTS guard instead of ON CONFLICT to stay idempotent.
INSERT INTO document_templates (name, template_type, description, template_body)
SELECT 'Receipt', 'RECEIPT',
       'A general-purpose receipt for money received in person (cash, cheque, mobile money, etc).',
       'Rendered client-side — see receiptTemplate() in exportUtils.js.'
WHERE NOT EXISTS (
    SELECT 1 FROM document_templates WHERE template_type = 'RECEIPT'
);

INSERT INTO document_templates (name, template_type, description, template_body)
SELECT 'Board Resolution', 'RESOLUTION',
       'A formal resolution passed by the Board/Directors, with proposer, seconder, and vote outcome.',
       'Rendered client-side — see resolutionTemplate() in exportUtils.js.'
WHERE NOT EXISTS (
    SELECT 1 FROM document_templates WHERE template_type = 'RESOLUTION'
);

-- v1.28.1 fix: Meeting Agenda and Meeting Minutes were always fully
-- supported end-to-end (both are hardcoded in GenerateDocumentPage.jsx's
-- TEMPLATE_FIELDS and rendered client-side by meetingAgendaTemplate()/
-- meetingMinutesTemplate() in exportUtils.js, exactly like Receipt and
-- Resolution above) but, unlike Receipt/Resolution, never had a seed
-- row here — so "Generate Document" only ever offered 2 of the 4
-- intended document types on a fresh database. Same idempotent
-- NOT EXISTS pattern as above.
INSERT INTO document_templates (name, template_type, description, template_body)
SELECT 'Meeting Agenda', 'MEETING_AGENDA',
       'A structured agenda for an upcoming meeting, with numbered items and expected duration.',
       'Rendered client-side — see meetingAgendaTemplate() in exportUtils.js.'
WHERE NOT EXISTS (
    SELECT 1 FROM document_templates WHERE template_type = 'MEETING_AGENDA'
);

INSERT INTO document_templates (name, template_type, description, template_body)
SELECT 'Meeting Minutes', 'MEETING_MINUTES',
       'A record of what was discussed and decided at a meeting, including attendance and closure notes.',
       'Rendered client-side — see meetingMinutesTemplate() in exportUtils.js.'
WHERE NOT EXISTS (
    SELECT 1 FROM document_templates WHERE template_type = 'MEETING_MINUTES'
);

-- ============================================================
-- GROUP 16: NOTIFICATIONS
-- The in-app "bell" activity feed — one row per user per event
-- worth telling them about (something needs their approval, their
-- own contribution/account was updated, an event they're invited
-- to, etc.). Most notification-worthy events also send a real email
-- via config/email.js — email_sent records whether that succeeded,
-- separately from is_read (which tracks the in-app bell only).
-- ============================================================

CREATE TABLE notifications (
    id           SERIAL PRIMARY KEY,
    user_id      INTEGER      NOT NULL REFERENCES users(id),
    type         VARCHAR(50)  NOT NULL,   -- e.g. CONTRIBUTION_RECORDED, REQUISITION_APPROVED
    title        VARCHAR(200) NOT NULL,
    body         TEXT,
    link         VARCHAR(300),            -- frontend route, e.g. /requisitions
    related_module      VARCHAR(50),
    related_record_type VARCHAR(50),
    related_record_id   INTEGER,
    is_read      BOOLEAN      NOT NULL DEFAULT FALSE,
    read_at      TIMESTAMPTZ,
    email_sent   BOOLEAN      NOT NULL DEFAULT FALSE,
    email_error  TEXT,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notifications_user      ON notifications (user_id, created_at DESC);
CREATE INDEX idx_notifications_user_read ON notifications (user_id, is_read);

-- ============================================================
-- GROUP 17: EXTERNAL AUDIT (v1.19.0)
-- Lets the company give a named external audit firm a dedicated,
-- narrowly-scoped, revocable login — "an engagement" — instead of
-- ever handing out a real member/staff role. Each engagement:
--   - covers a fixed transaction date range (period_start/end)
--   - only exposes the specific accounts an Admin picked
--   - only exposes the specific documents an Admin picked
--   - can have one or more auditor user logins attached to it
--   - can be revoked independently of any other engagement
-- The Auditor role itself grants no access to anything by default —
-- every auditController.js query joins back through these tables to
-- enforce scope server-side, not just hide things in the UI.
-- ============================================================

CREATE TABLE audit_engagements (
    id                 SERIAL PRIMARY KEY,
    name               VARCHAR(200) NOT NULL,   -- e.g. "2025 Annual Audit — Firm X"
    description        TEXT,
    period_start       DATE         NOT NULL,   -- transaction date range being audited
    period_end         DATE         NOT NULL,
    -- Optional hard login expiry, separate from the audited period —
    -- e.g. audit covers Jan-Dec 2025 but access itself should stop
    -- working after the engagement wraps up in March 2026. NULL means
    -- no automatic expiry; access lasts until manually revoked.
    access_expires_at  TIMESTAMPTZ,
    status             VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE'
                       CHECK (status IN ('ACTIVE','REVOKED')),
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by         INTEGER      NOT NULL REFERENCES users(id),
    revoked_at         TIMESTAMPTZ,
    revoked_by         INTEGER REFERENCES users(id),
    CONSTRAINT check_audit_period_valid CHECK (period_end >= period_start)
);

-- Which accounts this engagement's auditor(s) may see transactions
-- for. An engagement with zero rows here shows nothing — access is
-- opt-in per account, never "everything by default".
CREATE TABLE audit_engagement_accounts (
    engagement_id INTEGER NOT NULL REFERENCES audit_engagements(id) ON DELETE CASCADE,
    account_id    INTEGER NOT NULL REFERENCES accounts(id),
    PRIMARY KEY (engagement_id, account_id)
);

-- Which user logins belong to this engagement. A user with the
-- Auditor role but no row here can log in but sees nothing — the
-- engagement attachment is what actually grants visibility.
CREATE TABLE audit_engagement_users (
    engagement_id INTEGER NOT NULL REFERENCES audit_engagements(id) ON DELETE CASCADE,
    user_id       INTEGER NOT NULL REFERENCES users(id),
    added_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    added_by      INTEGER REFERENCES users(id),
    PRIMARY KEY (engagement_id, user_id)
);

-- Specific documents (uploaded or system-generated) an Admin has
-- explicitly chosen to make previewable for this engagement — a
-- separate, curated list from the raw transaction ledger above.
CREATE TABLE audit_engagement_documents (
    engagement_id INTEGER NOT NULL REFERENCES audit_engagements(id) ON DELETE CASCADE,
    document_id   INTEGER NOT NULL REFERENCES documents(id),
    added_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    added_by      INTEGER REFERENCES users(id),
    PRIMARY KEY (engagement_id, document_id)
);

CREATE INDEX idx_audit_engagement_accounts_engagement   ON audit_engagement_accounts (engagement_id);
CREATE INDEX idx_audit_engagement_users_user            ON audit_engagement_users (user_id);
CREATE INDEX idx_audit_engagement_documents_engagement  ON audit_engagement_documents (engagement_id);

-- ============================================================
-- GROUP 18: AUDITOR SUBMISSION WORKFLOW (v1.20.0)
-- The auditor's side of an engagement: a running log of comments,
-- staged report-file uploads, and a "Finish Audit" action that
-- bundles whatever's accumulated into a submission for review.
--
-- Comments and files start unattached to any submission
-- (submission_id IS NULL — "staged"). Clicking Finish Audit creates
-- an audit_submissions row and attaches every currently-staged
-- comment/file to it in one step, so what a Director/Secretary
-- reviews is a fixed snapshot, not a moving target.
--
-- Approval requires BOTH a Director and a Secretary — either one
-- rejecting short-circuits the whole submission to REJECTED
-- immediately, without waiting on the other. Only once both have
-- approved does the system generate reference codes and create the
-- actual documents (feedback + each report file), then archive them
-- — "referenced and archived" is a side effect of approval
-- completing, not something that happens at submission time.
-- ============================================================

CREATE TABLE audit_submissions (
    id                  SERIAL PRIMARY KEY,
    engagement_id       INTEGER      NOT NULL REFERENCES audit_engagements(id) ON DELETE CASCADE,
    submitted_by        INTEGER      NOT NULL REFERENCES users(id),
    submitted_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    status              VARCHAR(20)  NOT NULL DEFAULT 'SUBMITTED'
                        CHECK (status IN ('SUBMITTED','APPROVED','REJECTED')),
    director_approved_by INTEGER REFERENCES users(id),
    director_approved_at TIMESTAMPTZ,
    secretary_approved_by INTEGER REFERENCES users(id),
    secretary_approved_at TIMESTAMPTZ,
    rejected_by         INTEGER REFERENCES users(id),
    rejected_at         TIMESTAMPTZ,
    rejection_reason    TEXT,
    -- Set once both approvals are in and the compiled feedback
    -- document has actually been created (see auditController.js).
    feedback_document_id INTEGER REFERENCES documents(id)
);

CREATE TABLE audit_engagement_comments (
    id            SERIAL PRIMARY KEY,
    engagement_id INTEGER     NOT NULL REFERENCES audit_engagements(id) ON DELETE CASCADE,
    user_id       INTEGER     NOT NULL REFERENCES users(id),
    comment_text  TEXT        NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- NULL = staged, not yet part of a submission
    submission_id INTEGER REFERENCES audit_submissions(id)
);

CREATE TABLE audit_submission_files (
    id                SERIAL PRIMARY KEY,
    engagement_id     INTEGER      NOT NULL REFERENCES audit_engagements(id) ON DELETE CASCADE,
    -- NULL = staged, not yet part of a submission
    submission_id     INTEGER REFERENCES audit_submissions(id),
    file_path         TEXT         NOT NULL,
    file_name         TEXT         NOT NULL,
    file_size_bytes   BIGINT,
    mime_type         VARCHAR(100),
    uploaded_by       INTEGER      NOT NULL REFERENCES users(id),
    uploaded_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    -- Set once the submission is fully approved and this file has
    -- been promoted into a real documents row (source='UPLOADED').
    document_id       INTEGER REFERENCES documents(id)
);

CREATE TABLE audit_extension_requests (
    id                            SERIAL PRIMARY KEY,
    engagement_id                 INTEGER      NOT NULL REFERENCES audit_engagements(id) ON DELETE CASCADE,
    requested_by                  INTEGER      NOT NULL REFERENCES users(id),
    current_access_expires_at     TIMESTAMPTZ,
    requested_new_access_expires_at TIMESTAMPTZ NOT NULL,
    reason                        TEXT         NOT NULL,
    status                        VARCHAR(20)  NOT NULL DEFAULT 'PENDING'
                                  CHECK (status IN ('PENDING','APPROVED','REJECTED')),
    reviewed_by                   INTEGER REFERENCES users(id),
    reviewed_at                   TIMESTAMPTZ,
    reviewer_notes                TEXT,
    created_at                    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Deduplicates the daily access-expiry reminder cron job — one row
-- per (engagement, threshold) ever sent, so a reminder never goes
-- out twice for the same milestone.
CREATE TABLE audit_engagement_reminders_sent (
    id            SERIAL PRIMARY KEY,
    engagement_id INTEGER     NOT NULL REFERENCES audit_engagements(id) ON DELETE CASCADE,
    days_before   INTEGER     NOT NULL,
    sent_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (engagement_id, days_before)
);

CREATE INDEX idx_audit_submissions_engagement       ON audit_submissions (engagement_id);
CREATE INDEX idx_audit_submissions_status            ON audit_submissions (status);
CREATE INDEX idx_audit_engagement_comments_engagement ON audit_engagement_comments (engagement_id);
CREATE INDEX idx_audit_engagement_comments_submission ON audit_engagement_comments (submission_id);
CREATE INDEX idx_audit_submission_files_engagement    ON audit_submission_files (engagement_id);
CREATE INDEX idx_audit_submission_files_submission     ON audit_submission_files (submission_id);
CREATE INDEX idx_audit_extension_requests_engagement   ON audit_extension_requests (engagement_id);
CREATE INDEX idx_audit_extension_requests_status        ON audit_extension_requests (status);

-- ============================================================
-- GROUP 17: ADMINISTRATIVE OFFICER — STAFF DOCUMENT GRANTS
--           AND SERVICE FEES (v1.21.0)
-- Support for hired/contracted staff (see the "Administrative
-- Officer" role above): per-document access grants for the
-- otherwise finance-blocked documents this role can't see by
-- default, plus a recurring service-fee arrangement and expense
-- reimbursement flow for a contracted (not payroll/employee)
-- relationship.
-- ============================================================

-- Direct, ongoing per-user document access grant — no time-boxed
-- "engagement" wrapper, unlike the Audit Portal, since this is a
-- standing staff relationship rather than a fixed-period audit.
CREATE TABLE staff_document_grants (
    id          SERIAL PRIMARY KEY,
    document_id INTEGER NOT NULL REFERENCES documents(id),
    user_id     INTEGER NOT NULL REFERENCES users(id),
    granted_by  INTEGER NOT NULL REFERENCES users(id),
    granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at  TIMESTAMPTZ,
    revoked_by  INTEGER REFERENCES users(id),
    UNIQUE (document_id, user_id)
);

-- One row per contracted person's standing monthly fee arrangement.
CREATE TABLE service_fee_agreements (
    id             SERIAL PRIMARY KEY,
    user_id        INTEGER NOT NULL REFERENCES users(id),
    monthly_amount NUMERIC(20,4) NOT NULL,
    currency_id    INTEGER NOT NULL REFERENCES currencies(id),
    account_id     INTEGER NOT NULL REFERENCES accounts(id),
    category_id    INTEGER NOT NULL REFERENCES categories(id),
    start_date     DATE NOT NULL,
    end_date       DATE,
    status         VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
                   CHECK (status IN ('ACTIVE', 'ENDED')),
    notes          TEXT,
    created_by     INTEGER NOT NULL REFERENCES users(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT positive_monthly_amount CHECK (monthly_amount > 0),
    CONSTRAINT service_fee_end_after_start CHECK (end_date IS NULL OR end_date >= start_date)
);

-- Each actual monthly payment, tied to a real posted transaction.
CREATE TABLE service_fee_payments (
    id             SERIAL PRIMARY KEY,
    agreement_id   INTEGER NOT NULL REFERENCES service_fee_agreements(id),
    amount         NUMERIC(20,4) NOT NULL,
    payment_date   DATE NOT NULL,
    transaction_id INTEGER REFERENCES transactions(id),
    notes          TEXT,
    paid_by        INTEGER NOT NULL REFERENCES users(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT positive_service_fee_payment CHECK (amount > 0)
);

-- Ad hoc expense reimbursement requests from a contracted person —
-- structurally similar to a Requisitions EXPENSE request, kept
-- separate since Requisitions' other request type
-- (CONTRIBUTION_ACKNOWLEDGEMENT) is a shareholder concept that
-- doesn't apply to contracted, non-shareholder staff.
CREATE TABLE service_reimbursement_requests (
    id                SERIAL PRIMARY KEY,
    reference_id      INTEGER NOT NULL REFERENCES references_registry(id),
    user_id           INTEGER NOT NULL REFERENCES users(id),
    amount            NUMERIC(20,4) NOT NULL,
    currency_id       INTEGER NOT NULL REFERENCES currencies(id),
    category_id       INTEGER NOT NULL REFERENCES categories(id),
    description       TEXT NOT NULL,
    expense_date      DATE NOT NULL,
    receipt_file_path TEXT,
    receipt_file_name TEXT,
    status            VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
    account_id        INTEGER REFERENCES accounts(id),
    transaction_id    INTEGER REFERENCES transactions(id),
    reviewed_by       INTEGER REFERENCES users(id),
    reviewed_at       TIMESTAMPTZ,
    review_notes      TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT positive_reimbursement_amount CHECK (amount > 0)
);

CREATE INDEX idx_staff_document_grants_user            ON staff_document_grants (user_id);
CREATE INDEX idx_staff_document_grants_doc              ON staff_document_grants (document_id);
CREATE INDEX idx_service_fee_agreements_user            ON service_fee_agreements (user_id);
CREATE INDEX idx_service_fee_payments_agreement         ON service_fee_payments (agreement_id);
CREATE INDEX idx_service_reimbursement_requests_user    ON service_reimbursement_requests (user_id);


-- ============================================================
-- GROUP 20: DIGITAL CONSENT, SIGNATURES & MULTI-SIGNATORY APPROVAL
-- (v1.23.0, Section 4.29)
-- ============================================================

-- Singleton row — the Membership Agreement text every new member
-- reads and consents to once, before using the rest of the system.
CREATE TABLE membership_agreement (
    id          INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    content     TEXT NOT NULL DEFAULT 'This company''s Membership Agreement has not been set yet. An Administrator needs to add it in Settings before new members can complete sign-up.',
    version     INTEGER NOT NULL DEFAULT 1,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by  INTEGER REFERENCES users(id)
);
INSERT INTO membership_agreement (id) VALUES (1);

-- One-time consent record per member (UNIQUE user_id) — which
-- Membership Agreement version they consented to, when, and basic
-- provenance. Not re-triggered by later edits to the agreement text.
CREATE TABLE member_consents (
    id                SERIAL PRIMARY KEY,
    user_id           INTEGER NOT NULL UNIQUE REFERENCES users(id),
    agreement_version INTEGER NOT NULL,
    consented_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ip_address        VARCHAR(64),
    user_agent        TEXT
);

-- Admin-configured: which roles must sign which document type before
-- it counts as approved. A document type with zero active rows here
-- has no multi-signature requirement — it keeps using the original
-- single-approver approveDocument flow.
CREATE TABLE signature_requirements (
    id            SERIAL PRIMARY KEY,
    document_type VARCHAR(30) NOT NULL
                  CHECK (document_type IN (
                      'RESOLUTION', 'LOAN_AGREEMENT', 'GRANT_AGREEMENT', 'SHARE_CERTIFICATE'
                  )),
    role_id       INTEGER NOT NULL REFERENCES roles(id),
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by    INTEGER REFERENCES users(id),
    UNIQUE (document_type, role_id)
);

-- One row per required-role signing slot on a specific signable
-- thing. target_type/target_id points at either a `documents` row or
-- a `certificate_signing_rounds` row. required_role_id is a ROLE —
-- whoever currently holds it may fill the slot; signed_by records
-- who actually did. signature_snapshot_path is a copy of that
-- person's users.signature_path taken at signing time, so a later
-- change to their stored signature never alters something already
-- signed.
CREATE TABLE document_signatures (
    id                      SERIAL PRIMARY KEY,
    target_type             VARCHAR(20) NOT NULL
                            CHECK (target_type IN ('DOCUMENT', 'CERTIFICATE_ROUND')),
    target_id               INTEGER NOT NULL,
    required_role_id        INTEGER NOT NULL REFERENCES roles(id),
    status                  VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                            CHECK (status IN ('PENDING', 'SIGNED')),
    signed_by               INTEGER REFERENCES users(id),
    signature_snapshot_path TEXT,
    signed_at               TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (target_type, target_id, required_role_id)
);
CREATE INDEX idx_doc_signatures_target ON document_signatures (target_type, target_id);

-- One row per (certificate_type, period_label) monthly/annual batch.
-- Every share_certificates row issued in that batch links to it via
-- signing_round_id; the round itself is what gets signed (one
-- signature covers every certificate in it), and certificates are
-- only rendered-with-signatures and emailed once the round is
-- FULLY_SIGNED.
CREATE TABLE certificate_signing_rounds (
    id                SERIAL PRIMARY KEY,
    certificate_type  VARCHAR(20) NOT NULL CHECK (certificate_type IN ('MONTHLY', 'ANNUAL')),
    period_label      VARCHAR(20) NOT NULL,
    status            VARCHAR(20) NOT NULL DEFAULT 'OPEN'
                      CHECK (status IN ('OPEN', 'FULLY_SIGNED')),
    opened_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    opened_by         INTEGER REFERENCES users(id),
    fully_signed_at   TIMESTAMPTZ,
    UNIQUE (certificate_type, period_label)
);

-- Forward-reference FK — share_certificates is defined earlier in
-- this file than certificate_signing_rounds, same pattern as the
-- grants -> documents forward references above.
ALTER TABLE share_certificates
    ADD CONSTRAINT fk_share_cert_signing_round
    FOREIGN KEY (signing_round_id) REFERENCES certificate_signing_rounds(id);

-- ============================================================
-- GROUP 21: COMPANY STAMPS & SEALS (v1.24.0, Section 4.30)
-- Admin-uploaded named stamp images (Treasury, Secretariat, etc.),
-- auto-attached to a document/certificate round once it becomes
-- fully approved/signed. Opt-in per document_type, same shape as
-- GROUP 20's signature_requirements. document_stamps_applied
-- snapshots exactly which stamp(s) actually got applied at the
-- moment of finalisation, so a later config change never alters an
-- already-finalised document.
-- ============================================================

-- One row per uploaded stamp image. mime_type restricted to PNG and
-- SVG (transparent-background formats) so a stamp overlays cleanly.
CREATE TABLE company_stamps (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    file_path   TEXT NOT NULL,
    mime_type   VARCHAR(50) NOT NULL CHECK (mime_type IN ('image/png', 'image/svg+xml')),
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by  INTEGER REFERENCES users(id)
);

-- Which stamp(s) apply to which document_type. A type with zero
-- active rows never gets stamped.
CREATE TABLE document_stamp_requirements (
    id            SERIAL PRIMARY KEY,
    document_type VARCHAR(30) NOT NULL
                  CHECK (document_type IN (
                      'MEETING_MINUTES', 'MEETING_AGENDA', 'INVESTMENT_PROPOSAL',
                      'FINANCIAL_REPORT_GENERAL', 'FINANCIAL_REPORT_INDIVIDUAL',
                      'RECEIPT', 'RESOLUTION', 'CONTRACT', 'LOAN_AGREEMENT', 'GRANT_AGREEMENT',
                      'AUDITOR_FEEDBACK', 'AUDIT_REPORT', 'OTHER', 'SHARE_CERTIFICATE'
                  )),
    stamp_id      INTEGER NOT NULL REFERENCES company_stamps(id),
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by    INTEGER REFERENCES users(id),
    UNIQUE (document_type, stamp_id)
);

-- Structural enforcement of "monthly share certificates only get a
-- treasury stamp": SHARE_CERTIFICATE may have at most ONE active
-- stamp requirement at a time, whichever stamp the Admin has placed
-- there — not a hardcoded stamp name.
CREATE UNIQUE INDEX idx_one_active_stamp_per_share_cert
    ON document_stamp_requirements (document_type)
    WHERE document_type = 'SHARE_CERTIFICATE' AND is_active = TRUE;

-- Snapshot of which stamp(s) were actually baked onto a specific
-- document/round the moment it became fully approved/signed. Mirrors
-- document_signatures' polymorphic target shape.
CREATE TABLE document_stamps_applied (
    id          SERIAL PRIMARY KEY,
    target_type VARCHAR(20) NOT NULL CHECK (target_type IN ('DOCUMENT', 'CERTIFICATE_ROUND')),
    target_id   INTEGER NOT NULL,
    stamp_id    INTEGER NOT NULL REFERENCES company_stamps(id),
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (target_type, target_id, stamp_id)
);
CREATE INDEX idx_doc_stamps_applied_target ON document_stamps_applied (target_type, target_id);

-- ============================================================
-- GROUP 22: SIDE FUND PER-MEMBER OVERRIDES & OVERPAYMENT CREDIT,
-- CUSTOM FISCAL QUARTERS (v1.25.0, Section 4.10)
-- ============================================================

-- side_fund_dues — whether a due was settled with a real payment or
-- drawn down from previously-banked credit (added here since
-- side_fund_dues itself is defined earlier in GROUP 14b).
ALTER TABLE side_fund_dues ADD COLUMN paid_from_credit BOOLEAN NOT NULL DEFAULT FALSE;

-- One row per member with a custom monthly amount instead of the
-- company-wide default (side_fund_config.monthly_amount). No row =
-- uses the default.
CREATE TABLE side_fund_member_overrides (
    user_id        INTEGER PRIMARY KEY REFERENCES users(id),
    monthly_amount NUMERIC(20,4) NOT NULL CHECK (monthly_amount >= 0),
    set_by         INTEGER REFERENCES users(id),
    set_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per member — running balance of overpayment banked but not
-- yet applied to a due. Drawn down automatically as new monthly dues
-- are generated.
CREATE TABLE side_fund_member_credit (
    user_id        INTEGER PRIMARY KEY REFERENCES users(id),
    credit_balance NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (credit_balance >= 0),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Auditable log of every time a member's credit balance changed —
-- banked (positive delta) or applied against a specific due
-- (negative delta).
CREATE TABLE side_fund_credit_ledger (
    id             SERIAL PRIMARY KEY,
    user_id        INTEGER NOT NULL REFERENCES users(id),
    delta          NUMERIC(20,4) NOT NULL,
    reason         TEXT NOT NULL,
    related_due_id INTEGER REFERENCES side_fund_dues(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_side_fund_credit_ledger_user ON side_fund_credit_ledger (user_id, created_at DESC);

-- Admin-defined custom financial-year quarters — fully custom
-- start/end dates, not required to be equal 3-month blocks.
CREATE TABLE fiscal_quarters (
    id         SERIAL PRIMARY KEY,
    label      VARCHAR(50) NOT NULL,
    start_date DATE NOT NULL,
    end_date   DATE NOT NULL,
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fiscal_quarter_valid_range CHECK (end_date >= start_date)
);
CREATE INDEX idx_fiscal_quarters_range ON fiscal_quarters (start_date, end_date);

-- ============================================================
-- GROUP 23: SIDE FUND STRICT PER-MEMBER ATTRIBUTION (v1.26.0,
-- Section 4.10) — every side fund inflow must be tied to a specific
-- member's own due; the old unattributed "Add Funds Directly"
-- lump-sum top-up is gone.
-- ============================================================

-- side_fund_dues.due_date — the last day of the due's own period
-- month, stored explicitly (rather than recomputed from `period`
-- every time) so overdue amounts can be reported per member
-- precisely and consistently everywhere (added here since
-- side_fund_dues itself is defined earlier in GROUP 14b).
ALTER TABLE side_fund_dues ADD COLUMN due_date DATE NOT NULL;

-- Widen requisitions.requisition_type so a member can request/
-- acknowledge a side fund payment the same way they already can for
-- a capital contribution or a savings deposit (Section 4.9).
DO $$
DECLARE
    con_name text;
BEGIN
    SELECT conname INTO con_name
    FROM   pg_constraint
    WHERE  conrelid = 'requisitions'::regclass
    AND    pg_get_constraintdef(oid) LIKE '%requisition_type%';
    IF con_name IS NOT NULL THEN
        EXECUTE 'ALTER TABLE requisitions DROP CONSTRAINT ' || quote_ident(con_name);
    END IF;
    ALTER TABLE requisitions ADD CONSTRAINT requisitions_requisition_type_check
        CHECK (requisition_type IN (
            'EXPENSE', 'CONTRIBUTION_ACKNOWLEDGEMENT', 'SAVINGS_DEPOSIT', 'SIDE_FUND_CONTRIBUTION'
        ));
END $$;

-- ============================================================
-- GROUP 24: MONEY MARKET FUND (MMF) SUB-ACCOUNTS (v1.28.0,
-- Section 4.31) — a company can place part of an existing account's
-- balance into one or more Money Market Fund sub-accounts (a common
-- Ugandan SACCO/investment-club practice: daily interest, usually
-- reported/credited monthly). Money moved into an MMF stops counting
-- toward its parent account's real/spendable current_balance (it's
-- genuinely gone from that account, sitting with the MMF provider)
-- but is tracked here as its own running balance — principal in,
-- minus withdrawals, plus manually-recorded monthly interest, minus
-- the MMF's one allowed expense type (a management fee, paid at
-- withdrawal or on whatever interval the provider actually charges
-- it). A withdrawal credits the money back to the parent account for
-- real. Multiple MMF sub-accounts are allowed at once, each tied to
-- exactly one parent account and inheriting that account's currency.
-- ============================================================

CREATE TABLE mmf_accounts (
    id                     SERIAL PRIMARY KEY,
    reference_id           INTEGER       NOT NULL REFERENCES references_registry(id),
    parent_account_id      INTEGER       NOT NULL REFERENCES accounts(id),
    name                   VARCHAR(200)  NOT NULL,
    provider               VARCHAR(200),           -- fund manager / MMF provider name
    description            TEXT,
    -- Always the parent account's currency — enforced in application
    -- code at creation time, not re-derivable later if the parent's
    -- currency were ever changed (it can't be, per accounts.currency_id
    -- being immutable once transactions exist).
    currency_id            INTEGER       NOT NULL REFERENCES currencies(id),
    -- Running balance, maintained transactionally the same way
    -- accounts.current_balance is (recomputed on every posting, not a
    -- live SUM query) = total_principal_in - total_withdrawn +
    -- total_interest - total_management_fees.
    current_balance        NUMERIC(20,4) NOT NULL DEFAULT 0,
    total_principal_in     NUMERIC(20,4) NOT NULL DEFAULT 0,
    total_withdrawn        NUMERIC(20,4) NOT NULL DEFAULT 0,
    total_interest         NUMERIC(20,4) NOT NULL DEFAULT 0,
    total_management_fees  NUMERIC(20,4) NOT NULL DEFAULT 0,
    status                 VARCHAR(20)   NOT NULL DEFAULT 'ACTIVE'
                           CHECK (status IN ('ACTIVE', 'CLOSED')),
    opened_date            DATE          NOT NULL DEFAULT CURRENT_DATE,
    closed_date            DATE,
    created_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_by             INTEGER       NOT NULL REFERENCES users(id)
);

CREATE TABLE mmf_transactions (
    id               SERIAL PRIMARY KEY,
    reference_id     INTEGER       NOT NULL REFERENCES references_registry(id),
    mmf_account_id   INTEGER       NOT NULL REFERENCES mmf_accounts(id),
    -- TOPUP/WITHDRAWAL post a genuine transaction against the parent
    -- account (transaction_id set, via the same postTransaction()
    -- choke point everything else in the system uses) — INTEREST and
    -- MANAGEMENT_FEE only move the MMF's own balance and never touch
    -- the parent account or the main ledger at all.
    transaction_id   INTEGER REFERENCES transactions(id),
    entry_type       VARCHAR(20)   NOT NULL
                     CHECK (entry_type IN ('TOPUP', 'WITHDRAWAL', 'INTEREST', 'MANAGEMENT_FEE')),
    amount           NUMERIC(20,4) NOT NULL,
    -- Which calendar month this interest covers (first-of-month) —
    -- only set for INTEREST rows. The unique index below stops the
    -- same month's interest being posted twice by accident.
    interest_period  DATE,
    description      TEXT,
    entry_date       DATE          NOT NULL,
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_by       INTEGER       NOT NULL REFERENCES users(id),
    CONSTRAINT positive_mmf_txn_amount CHECK (amount > 0)
);

CREATE UNIQUE INDEX idx_mmf_interest_period_unique
    ON mmf_transactions (mmf_account_id, interest_period)
    WHERE entry_type = 'INTEREST';

CREATE INDEX idx_mmf_transactions_account ON mmf_transactions (mmf_account_id);
CREATE INDEX idx_mmf_accounts_parent      ON mmf_accounts (parent_account_id);

-- Widen transactions.inflow_type so an MMF top-up/withdrawal posts as
-- its own traceable type instead of being lumped into generic EXPENSE/
-- OTHER_INCOME (same widening pattern as every other module here).
DO $$
DECLARE
    con_name text;
BEGIN
    SELECT conname INTO con_name
    FROM   pg_constraint
    WHERE  conrelid = 'transactions'::regclass
    AND    pg_get_constraintdef(oid) LIKE '%inflow_type%';
    IF con_name IS NOT NULL THEN
        EXECUTE 'ALTER TABLE transactions DROP CONSTRAINT ' || quote_ident(con_name);
    END IF;
    ALTER TABLE transactions ADD CONSTRAINT transactions_inflow_type_check
        CHECK (inflow_type IN (
            'CONTRIBUTION', 'GRANT', 'LOAN_RECEIVED', 'LOAN_REPAYMENT_IN',
            'INTEREST_IN', 'INVESTMENT_RETURN', 'TRANSFER_IN', 'OTHER_INCOME',
            'SAVINGS_DEPOSIT_IN', 'TRANSFER_OUT', 'LOAN_DISBURSED',
            'LOAN_REPAYMENT_OUT', 'INTEREST_OUT', 'EXPENSE', 'SAVINGS_HANDOUT_OUT',
            'GRANT_REFUND', 'SIDE_FUND_CONTRIBUTION_IN', 'SIDE_FUND_DIRECT_IN',
            'SAVINGS_POOL_OTHER_IN', 'SERVICE_FEE_OUT', 'SERVICE_REIMBURSEMENT_OUT',
            'DIVIDEND_OUT', 'DIVIDEND_SAVINGS_IN',
            'MMF_TOPUP_OUT', 'MMF_WITHDRAWAL_IN'
        ));
END $$;

INSERT INTO permissions (code, module, description) VALUES
    ('MMF_VIEW',   'INVESTMENTS', 'View Money Market Fund sub-accounts and their performance'),
    ('MMF_MANAGE', 'INVESTMENTS', 'Create/close MMF sub-accounts and record top-ups, withdrawals, interest and management fees')
ON CONFLICT (code) DO NOTHING;

-- ============================================================
-- GROUP 25: CAPITAL GOALS (v1.29.0, Section 4.33) — a Treasurer/
-- Director sets a target amount of shareholder capital to raise over
-- a date range (e.g. EUR 100,000 from Jan 2026 to Dec 2026). Nothing
-- is posted anywhere — a goal doesn't move money or touch any
-- account balance. It's purely a target to measure actual capital
-- contributions against: "goal amount doesn't have to be the exact
-- amount of the account balance, but the total income of what is
-- collected from members as capital" (the requesting brief's own
-- words) — i.e. it tracks shareholder_contributions (gross capital
-- raised), not accounts.current_balance (which nets in withdrawals/
-- expenses that have nothing to do with fundraising progress).
-- The expected monthly distribution (target_amount split evenly
-- across the months in range) and the actual-vs-expected comparison
-- are both computed live by getCapitalGoalProgress — nothing about
-- the monthly breakdown is stored, so editing a goal's target/dates
-- automatically recomputes everything downstream with no migration
-- or backfill ever required.
-- ============================================================

CREATE TABLE capital_goals (
    id             SERIAL PRIMARY KEY,
    reference_id   INTEGER       NOT NULL REFERENCES references_registry(id),
    title          VARCHAR(255)  NOT NULL,
    description    TEXT,
    target_amount  NUMERIC(20,4) NOT NULL,
    currency_id    INTEGER       NOT NULL REFERENCES currencies(id),
    start_date     DATE          NOT NULL,
    end_date       DATE          NOT NULL,
    status         VARCHAR(20)   NOT NULL DEFAULT 'ACTIVE'
                   CHECK (status IN ('ACTIVE', 'COMPLETED', 'CANCELLED')),
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_by     INTEGER       NOT NULL REFERENCES users(id),
    updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT positive_goal_target CHECK (target_amount > 0),
    CONSTRAINT valid_goal_range CHECK (end_date >= start_date)
);

CREATE INDEX idx_capital_goals_status ON capital_goals (status);

INSERT INTO permissions (code, module, description) VALUES
    ('CAPITAL_GOAL_VIEW',   'FINANCE', 'View capital fundraising goals and their progress'),
    ('CAPITAL_GOAL_MANAGE', 'FINANCE', 'Create, edit, and cancel capital fundraising goals')
ON CONFLICT (code) DO NOTHING;

-- ============================================================
-- END OF SCHEMA — v1.29.0
-- ============================================================
