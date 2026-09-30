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
    notes       TEXT
);
-- Partial unique index (v1.35.3), not a plain table-wide UNIQUE — a user
-- can only hold a given role ONCE at a time (revoked_at IS NULL), but is
-- allowed to hold, lose, and later be re-given the same role over their
-- membership. A plain UNIQUE(user_id, role_id) would keep blocking every
-- future re-assignment forever after the first time that pairing was ever
-- revoked, even once, since the old revoked row never goes away. See
-- Section 23.6, CMS_BIBLE.md.
CREATE UNIQUE INDEX user_roles_active_role_unique
    ON user_roles (user_id, role_id)
    WHERE revoked_at IS NULL;

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
                    -- SAVINGS (v1.14.0): the dedicated account every
                    -- member-savings transaction is posted against instead of
                    -- Primary. It can NEVER take part in a transfer (the
                    -- transferController only ever allows PRIMARY<->SECONDARY
                    -- legs, so a SAVINGS account is automatically excluded —
                    -- no extra code needed for that rule) and is permanently
                    -- exempt from floor-limit enforcement, so it is allowed to
                    -- sit at exactly zero at any time. v1.61.0: a company can
                    -- now have one SAVINGS account PER CURRENCY (was: exactly
                    -- one, ever) — see idx_one_savings_account_per_currency
                    -- below — so members can hold and move savings across
                    -- several currencies rather than being locked to whatever
                    -- currency the single Savings account happened to be in.
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

-- v1.61.0: was idx_one_savings_account — exactly one active SAVINGS
-- account, ever. Widened to one active SAVINGS account PER CURRENCY,
-- so every (member, currency) pair still has one unambiguous account
-- to reference, but a company can now hold savings in several
-- currencies at once. A new currency's SAVINGS account is created the
-- same way the original one was (Accounts → set up Savings account),
-- just once per currency needed.
CREATE UNIQUE INDEX idx_one_savings_account_per_currency
    ON accounts (account_type, currency_id)
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
    signing_round_id  INTEGER,
    -- v1.64.0 — the historical date this certificate's shares_held/
    -- percentage/price_per_share/share_value were snapshotted AS OF,
    -- not when it was issued/sent. NULL for the on-demand single-
    -- certificate path (which always reflects live figures) and for
    -- certificates issued before this feature existed. For the
    -- monthly/annual bulk pipeline this is always set — e.g. a
    -- MONTHLY certificate issued on 1 September carries
    -- as_of_date = 31 August, the period it actually reports on.
    as_of_date        DATE
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
                            'PENDING','ACTIVE','ON_HOLD','COMPLETED','CANCELLED',
                            'PENDING_TERMINATION','TERMINATED'
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
    -- v1.40.0: actual price paid for a BOND when it differs from
    -- face_value (bought at a discount or premium). Purely
    -- informational — coupon math always stays on face_value. NULL
    -- means bought at par (100% of face value).
    settlement_value        NUMERIC(20,4),
    -- v1.40.0: auto-tracked running total of spend that pushed
    -- actual_expenditure past planned_budget. Updated automatically
    -- by fundInvestment / recordInvestmentTransaction — never set
    -- directly by the user.
    supplementary_budget    NUMERIC(20,4) NOT NULL DEFAULT 0,
    -- v1.60.0: which of the standard bond durations this bond runs —
    -- how bonds are actually categorised when bought (a company may
    -- buy several "10yr bond" instances across different months, each
    -- its own investments row, all sharing this same term). BOND-only,
    -- nullable — required going forward for every NEW bond (enforced
    -- in the controller, not here, so a legacy bond backfilled with an
    -- ambiguous duration can sit NULL pending manual review rather
    -- than being forced into the nearest wrong bucket).
    bond_term_years         INTEGER
                            CHECK (bond_term_years IS NULL OR bond_term_years IN (2, 3, 5, 10, 15, 20, 25)),
    -- v1.40.0: mid-term termination workflow. status_before_termination
    -- snapshots status at request time so a rejected termination can
    -- restore it exactly. records_confirmed_* is the investment's
    -- responsible person attesting all returns/expenses/transactions
    -- are up to date; termination_approved_* is the Treasurer/Director
    -- final sign-off that locks in termination_report (states whether
    -- the investment profited or lost money, and by how much).
    status_before_termination VARCHAR(30),
    termination_requested_by  INTEGER REFERENCES users(id),
    termination_requested_at  TIMESTAMPTZ,
    termination_reason        TEXT,
    records_confirmed_by      INTEGER REFERENCES users(id),
    records_confirmed_at      TIMESTAMPTZ,
    termination_approved_by   INTEGER REFERENCES users(id),
    termination_approved_at   TIMESTAMPTZ,
    termination_report        TEXT,
    CONSTRAINT positive_inv_budget CHECK (planned_budget > 0),
    CONSTRAINT returns_to_source CHECK (returns_account_id = funding_account_id),
    CONSTRAINT positive_settlement_value CHECK (settlement_value IS NULL OR settlement_value > 0),
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
                        'INTEREST','RENTAL','OTHER',
                        'PRINCIPAL' -- v1.42.0: bond face value repaid at maturity
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
    -- v1.40.0: set only when the amount actually received differs from
    -- the scheduled gross_amount above (the "Record Actual Payment"
    -- action). Tax/net here are recalculated from actual_gross_amount
    -- using the bond's tax_withholding_rate — gross_amount/tax_amount/
    -- net_amount above are always left as the original forecast, so
    -- the schedule still shows what was expected vs what really
    -- happened. NULL means paid exactly as scheduled.
    actual_gross_amount  NUMERIC(20,4),
    actual_tax_amount    NUMERIC(20,4),
    actual_net_amount    NUMERIC(20,4),
    adjusted_by          INTEGER REFERENCES users(id),
    adjusted_at          TIMESTAMPTZ,
    CONSTRAINT positive_coupon_gross CHECK (gross_amount > 0),
    CONSTRAINT positive_actual_coupon_gross CHECK (actual_gross_amount IS NULL OR actual_gross_amount > 0),
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
    -- v1.63.0 — online meeting support. is_online marks that people are
    -- expected to attend remotely (regardless of whether `location` is
    -- also filled in — a hybrid event can have both a room AND a link).
    -- meeting_link is either auto-populated by googleCalendarService.js
    -- (meeting_provider='GOOGLE_MEET') once the company has connected
    -- Google Calendar (Settings > Integrations), or typed in by hand
    -- (meeting_provider='MANUAL') when it hasn't. google_calendar_event_id
    -- is only set for the GOOGLE_MEET case — it's what lets editEvent/
    -- extendEvent/cancelEvent keep the underlying Calendar event (and
    -- therefore the Meet link) in sync instead of orphaning it.
    is_online     BOOLEAN      NOT NULL DEFAULT FALSE,
    meeting_link  TEXT,
    meeting_provider VARCHAR(20)
                  CHECK (meeting_provider IN ('GOOGLE_MEET','MANUAL')),
    google_calendar_event_id VARCHAR(255),
    -- v1.63.0 — a fourth notification audience alongside the existing
    -- per-person (event_notifications.user_id) and per-role
    -- (event_notifications.role_id) targeting below: every active user
    -- in the system, any role, checked once at send time in
    -- approveEvent rather than needing a row per user here.
    notify_all_users BOOLEAN   NOT NULL DEFAULT FALSE,
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
                        -- DELETED (v1.46.0) — a soft removal, only ever reached
                        -- from ARCHIVED (see deleteDocument in documentsController.js).
                        -- The row itself is never actually removed (would break
                        -- references_registry, document_signatures,
                        -- document_stamps_applied, grants/loans agreement links,
                        -- etc.) — DELETED documents are just excluded from every
                        -- list view, the same way SUPERSEDED already was.
                        CHECK (status IN ('DRAFT','FINAL','ARCHIVED','SUPERSEDED','DELETED')),
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
                                CHECK (status IN ('PENDING_APPROVAL','ACTIVE','WITHDRAWN','REJECTED','CANCELLED','REVERSED')),
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
    -- v1.41.0: set when the linked deposit `transaction_id` is reversed
    -- (transactionsController.reverseTransaction) — for a FLEXIBLE entry,
    -- savings_balances.principal_balance has already been decremented back
    -- by that point; a FIXED_TERM entry never touched savings_balances in
    -- the first place, so only its own status flips.
    reversed_at                 TIMESTAMPTZ,
    reversed_by                 INTEGER REFERENCES users(id),
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

-- One row per (member, currency) with any FLEXIBLE savings activity —
-- the running balance that deposits/handouts and the daily accrual
-- job all update. v1.61.0: was one row per member, period (UNIQUE
-- user_id, currency_id nullable) — a member can now hold savings in
-- several currencies at once, each tracked as its own row here, one
-- per SAVINGS account/currency they've ever touched. currency_id is
-- NOT NULL going forward; every write path already supplied it even
-- when the column allowed NULL.
CREATE TABLE savings_balances (
    id                   SERIAL PRIMARY KEY,
    user_id              INTEGER       NOT NULL REFERENCES users(id),
    principal_balance    NUMERIC(20,4) NOT NULL DEFAULT 0,
    accrued_interest     NUMERIC(20,4) NOT NULL DEFAULT 0,  -- earned, not yet handed out
    total_interest_paid  NUMERIC(20,4) NOT NULL DEFAULT 0,
    currency_id          INTEGER       NOT NULL REFERENCES currencies(id),
    updated_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT non_negative_savings_balance  CHECK (principal_balance >= 0),
    CONSTRAINT non_negative_accrued_interest CHECK (accrued_interest >= 0),
    UNIQUE (user_id, currency_id)
);

-- Daily accrual ledger for FLEXIBLE savings — mirrors
-- loan_received_interest_accrual's pattern exactly. v1.61.0: gained
-- currency_id so a member with balances in more than one currency
-- gets a separate accrual row (and a separate interest credit) per
-- currency per day, instead of the job having no way to tell which of
-- their several savings_balances rows a single day's entry belonged to.
CREATE TABLE savings_interest_accrual (
    id                 SERIAL PRIMARY KEY,
    user_id            INTEGER       NOT NULL REFERENCES users(id),
    currency_id        INTEGER       NOT NULL REFERENCES currencies(id),
    accrual_date       DATE          NOT NULL,
    rate_used          NUMERIC(8,4)  NOT NULL,
    principal_balance  NUMERIC(20,4) NOT NULL,
    interest_accrued   NUMERIC(20,4) NOT NULL,
    created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, currency_id, accrual_date)
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
                      CHECK (status IN ('PENDING_CONFIRMATION','CONFIRMED','REJECTED','REVERSED')),
    transaction_id    INTEGER REFERENCES transactions(id),  -- set once confirmed
    entered_by        INTEGER       NOT NULL REFERENCES users(id),
    confirmed_at      TIMESTAMPTZ,
    rejected_reason   TEXT,
    rejected_at       TIMESTAMPTZ,
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    -- v1.41.0: set when the linked `transaction_id` (the handout's DEBIT)
    -- is reversed — by that point principal_balance/accrued_interest have
    -- already been restored on savings_balances.
    reversed_at       TIMESTAMPTZ,
    reversed_by       INTEGER REFERENCES users(id),
    CONSTRAINT positive_handout_principal CHECK (principal_amount > 0),
    CONSTRAINT positive_handout_total     CHECK (total_amount > 0)
);

-- v1.58.0 — a Treasurer/Assistant Treasurer can redirect a member's
-- own savings principal into a capital contribution instead of paying
-- it out as cash. Deliberately its own table/flow rather than a
-- variant of savings_handouts — the destination differs (a capital
-- contribution landing in the usable/operational account, not a cash
-- payout) and it produces a second, separate record
-- (shareholder_contributions) that also changes the member's
-- shares_held/percentage. Same "Treasurer enters it, only the member's
-- own confirmation actually moves the money" shape as a handout — this
-- is still the member's own savings being redirected, so their
-- agreement is required before anything posts. Confirming debits the
-- SAVINGS account (savings_transaction_id, inflow_type
-- SAVINGS_TO_CAPITAL_OUT) and decrements savings_balances.principal_
-- balance exactly like a handout does, then runs the ordinary
-- creditShareholderContribution() flow into destination_account_id
-- (contribution_id / contribution_transaction_id) — same shareholding
-- recalculation and capital-goal auto-attribution as any other
-- contribution.
CREATE TABLE savings_capital_conversions (
    id                          SERIAL PRIMARY KEY,
    reference_id                INTEGER       NOT NULL REFERENCES references_registry(id),
    user_id                     INTEGER       NOT NULL REFERENCES users(id),      -- the member whose savings this is
    account_id                  INTEGER       NOT NULL REFERENCES accounts(id),   -- the SAVINGS account the money leaves
    destination_account_id      INTEGER       NOT NULL REFERENCES accounts(id),   -- the usable/operational account the contribution lands in (must share the Savings account's currency — no implicit FX conversion)
    category_id                 INTEGER       NOT NULL REFERENCES categories(id), -- categorizes both legs
    amount                      NUMERIC(20,4) NOT NULL,
    currency_id                 INTEGER       NOT NULL REFERENCES currencies(id),
    conversion_date              DATE          NOT NULL,
    notes                        TEXT,
    status                       VARCHAR(30)   NOT NULL DEFAULT 'PENDING_CONFIRMATION'
                                 CHECK (status IN ('PENDING_CONFIRMATION','CONFIRMED','REJECTED')),
    savings_transaction_id       INTEGER REFERENCES transactions(id),               -- the SAVINGS account DEBIT, set once confirmed
    contribution_id              INTEGER REFERENCES shareholder_contributions(id),  -- the resulting capital contribution row, set once confirmed
    contribution_transaction_id  INTEGER REFERENCES transactions(id),               -- the destination account CREDIT, set once confirmed
    entered_by                   INTEGER       NOT NULL REFERENCES users(id),       -- Treasurer/Assistant Treasurer who initiated it
    confirmed_at                 TIMESTAMPTZ,
    rejected_reason               TEXT,
    rejected_at                   TIMESTAMPTZ,
    created_at                    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT positive_savings_capital_conversion_amount CHECK (amount > 0)
);

CREATE INDEX idx_savings_capital_conversions_user   ON savings_capital_conversions (user_id, status);
CREATE INDEX idx_savings_capital_conversions_status ON savings_capital_conversions (status);

-- v1.61.0 — a member's own savings, moved from one currency they hold
-- into another, at a manually-entered exchange rate (same convention
-- as transfers.exchange_rate — the currency_exchange_rates table is
-- display-only, never used for real money), with NO bank charges —
-- this never leaves the club's own accounts, both legs are the club's
-- own SAVINGS-type accounts holding the same member's own money, so
-- there is nothing for a bank to charge. Requested directly: "money
-- come be transferred within the savings account at an exchange rate
-- just like the normal transfer except that no charges apply here."
-- Same "Treasurer enters it, member confirms" shape as Savings-to-
-- Capital Conversion above — nothing moves until the member agrees,
-- since this is still entirely their own money either way.
CREATE TABLE savings_currency_conversions (
    id                          SERIAL PRIMARY KEY,
    reference_id                INTEGER       NOT NULL REFERENCES references_registry(id),
    user_id                     INTEGER       NOT NULL REFERENCES users(id),      -- the member whose savings this is — same owner on both legs
    from_account_id             INTEGER       NOT NULL REFERENCES accounts(id),   -- source SAVINGS account (source currency)
    from_currency_id            INTEGER       NOT NULL REFERENCES currencies(id),
    from_amount                 NUMERIC(20,4) NOT NULL,
    to_account_id               INTEGER       NOT NULL REFERENCES accounts(id),   -- destination SAVINGS account (target currency)
    to_currency_id              INTEGER       NOT NULL REFERENCES currencies(id),
    to_amount                   NUMERIC(20,4) NOT NULL,
    exchange_rate               NUMERIC(20,8) NOT NULL,   -- manually entered, from_currency -> to_currency
    exchange_rate_entered_by    INTEGER       NOT NULL REFERENCES users(id),
    conversion_date              DATE          NOT NULL,
    notes                        TEXT,
    status                       VARCHAR(30)   NOT NULL DEFAULT 'PENDING_CONFIRMATION'
                                 CHECK (status IN ('PENDING_CONFIRMATION','CONFIRMED','REJECTED')),
    from_transaction_id          INTEGER REFERENCES transactions(id),  -- the source SAVINGS account DEBIT, set once confirmed
    to_transaction_id            INTEGER REFERENCES transactions(id),  -- the destination SAVINGS account CREDIT, set once confirmed
    entered_by                   INTEGER       NOT NULL REFERENCES users(id),     -- Treasurer/Assistant Treasurer who initiated it
    confirmed_at                 TIMESTAMPTZ,
    rejected_reason               TEXT,
    rejected_at                   TIMESTAMPTZ,
    created_at                    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT positive_conversion_from_amount CHECK (from_amount > 0),
    CONSTRAINT positive_conversion_to_amount   CHECK (to_amount > 0),
    CONSTRAINT positive_conversion_rate        CHECK (exchange_rate > 0),
    CONSTRAINT conversion_different_currencies CHECK (from_currency_id != to_currency_id)
);

CREATE INDEX idx_savings_currency_conversions_user   ON savings_currency_conversions (user_id, status);
CREATE INDEX idx_savings_currency_conversions_status ON savings_currency_conversions (status);


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

-- v1.41.0 — append-only record of exactly what one transaction applied
-- to the side fund, written by sideFundService.applySideFundPayment.
-- Exists because side_fund_dues.transaction_id above is last-write-wins
-- (a due paid off across several separate payments only remembers the
-- most recent one) and side_fund_member_credit has no history at all —
-- neither can answer "what did transaction X actually do?" on their own,
-- which a reversal (transactionsController.reverseTransaction) needs to
-- know. One row per (transaction, due) touched, plus one row per
-- transaction if it banked overpayment as credit (due_id NULL). Also
-- naturally handles bulkPayDues, where one transaction can span several
-- members/dues — reversal just queries every row for that transaction_id.
CREATE TABLE side_fund_payment_applications (
    id               SERIAL PRIMARY KEY,
    transaction_id   INTEGER       NOT NULL REFERENCES transactions(id),
    user_id          INTEGER       NOT NULL REFERENCES users(id),
    due_id           INTEGER REFERENCES side_fund_dues(id),
    application_type VARCHAR(20)   NOT NULL
                     CHECK (application_type IN ('DUE_PAYMENT', 'CREDIT_BANKED')),
    amount           NUMERIC(20,4) NOT NULL CHECK (amount > 0),
    is_reversed      BOOLEAN       NOT NULL DEFAULT FALSE,
    reversed_at      TIMESTAMPTZ,
    reversed_by      INTEGER REFERENCES users(id),
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT due_payment_needs_due_id CHECK (application_type != 'DUE_PAYMENT' OR due_id IS NOT NULL)
);
CREATE INDEX idx_side_fund_applications_tx ON side_fund_payment_applications (transaction_id);

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
-- v1.62.0 — backs postTransaction's point-in-time balance sum and
-- cascade-shift UPDATE (both filter by account_id + value_date, tie-
-- broken by id), which now run on every single transaction posted.
CREATE INDEX idx_transactions_account_valuedate ON transactions (account_id, value_date, id);
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
    ('DOCUMENT_DELETE',                     'DOCUMENTS',    'Permanently remove an archived document from the archive'),
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
    ('SAVINGS_CAPITAL_CONVERT_CREATE',      'FINANCE',      'Redirect a member''s savings principal into a capital contribution, pending the member''s own confirmation (v1.58.0)'),
    ('SAVINGS_SETTINGS_MANAGE',             'FINANCE',      'Change the company-wide savings interest rate'),
    -- Side Fund
    ('SIDE_FUND_VIEW',                      'FINANCE',      'View side fund balance, dues, and spending history'),
    ('SIDE_FUND_MANAGE',                    'FINANCE',      'Activate/deactivate the side fund and change its settings'),
    ('SIDE_FUND_CONTRIBUTION_RECORD',       'FINANCE',      'Record a member''s monthly side fund due as paid'),
    ('SIDE_FUND_EXPENSE_RECORD',            'FINANCE',      'Record an expense drawn from the side fund'),
    -- Service Fees (v1.47.0 — replaces the old hardcoded Admin/Treasurer
    -- role gates on this module with real permissions)
    ('SERVICE_FEE_VIEW',                    'FINANCE',      'View all service fee agreements, payment history, and reimbursement requests'),
    ('SERVICE_FEE_MANAGE',                  'FINANCE',      'Create/edit/terminate service fee agreements, record payments, and review reimbursements');

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

-- ============================================================
-- GOOGLE CALENDAR / MEET INTEGRATION (v1.63.0)
-- Single-row table, same singleton convention as company_settings —
-- an Admin connects it once via Settings > Integrations, and it's
-- consulted by googleCalendarService.js whenever an online event
-- needs a Meet link auto-created. GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET
-- (the OAuth app's own static credentials, obtained once from Google
-- Cloud Console) live as env vars, same pattern as S3_*/GMAIL_* —
-- refresh_token below is different: it's generated per-installation by
-- a live OAuth consent flow, not something you look up in a provider
-- dashboard, so a database row (not an env var an Admin has no way to
-- populate without a redeploy) is where it has to live. Never exposed
-- by any GET endpoint — only ever read server-side by
-- googleCalendarService.js.
-- ============================================================
CREATE TABLE google_calendar_settings (
    id                   INTEGER      PRIMARY KEY DEFAULT 1,
    is_connected         BOOLEAN      NOT NULL DEFAULT FALSE,
    refresh_token        TEXT,
    google_account_email VARCHAR(255),
    calendar_id          VARCHAR(255) NOT NULL DEFAULT 'primary',
    connected_by         INTEGER REFERENCES users(id),
    connected_at         TIMESTAMPTZ,
    CONSTRAINT single_row_only CHECK (id = 1)
);

INSERT INTO google_calendar_settings (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;

INSERT INTO savings_settings (id, interest_rate, interest_period, interest_calculation)
VALUES (1, 0, 'ANNUALLY', 'SIMPLE')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- CAPITAL CALL FINE SETTINGS (v1.48.0)
-- Single-row table (id is always 1), same convention as
-- savings_settings — a company-wide configuration an Admin edits
-- through Settings > Capital Call Fines instead of a code change.
-- Governs the automatic late-payment fine capitalGoalCallService.js
-- assigns on a late iteration-1 capital call settlement: within
-- `grace_days` of the deadline, a smaller percentage applies; beyond
-- it, the larger one does. `iteration2_window_days` is how long a
-- monthly call's second round stays open once opened. These four
-- values used to be hardcoded module-level constants
-- (ITERATION1_GRACE_DAYS, ITERATION2_WINDOW_DAYS,
-- FINE_PERCENTAGE_WITHIN_GRACE, FINE_PERCENTAGE_AFTER_GRACE) — the
-- defaults below match those exact prior values, so existing
-- behaviour is unchanged until an Admin deliberately edits them.
-- ============================================================
CREATE TABLE capital_call_fine_settings (
    id                            INTEGER      PRIMARY KEY DEFAULT 1,
    grace_days                    INTEGER      NOT NULL DEFAULT 7,
    fine_percentage_within_grace  NUMERIC(5,2) NOT NULL DEFAULT 5,
    fine_percentage_after_grace   NUMERIC(5,2) NOT NULL DEFAULT 10,
    iteration2_window_days        INTEGER      NOT NULL DEFAULT 7,
    updated_by                    INTEGER REFERENCES users(id),
    updated_at                    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT single_row_only_fine_settings CHECK (id = 1)
);

INSERT INTO capital_call_fine_settings (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- CAPITAL GOAL TRACKING TOGGLE (v1.51.0) — company-wide on/off switch
-- for the entire Capital Goal Calls feature (goals, monthly calls,
-- pledges, fines, the Dashboard widgets). Having a PRIMARY goal (or
-- any capital goal at all) is not compulsory for a company — this row
-- is how an Admin opts out of the feature entirely: the UI hides,
-- the daily deadline-sweep cron skips this company's goals, and the
-- write endpoints (create/activate/pledge/edit/reject/approve) reject
-- with a clear "feature disabled" error. Existing data is untouched
-- either way, so re-enabling resumes cleanly. Defaults to TRUE so
-- every existing deployment keeps working exactly as before until an
-- Admin deliberately switches it off.
-- ============================================================
CREATE TABLE capital_goal_settings (
    id               INTEGER     PRIMARY KEY DEFAULT 1,
    tracking_enabled BOOLEAN     NOT NULL DEFAULT TRUE,
    updated_by       INTEGER REFERENCES users(id),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT single_row_only_capital_goal_settings CHECK (id = 1)
);

INSERT INTO capital_goal_settings (id)
VALUES (1)
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
    -- v1.52.0 — day of the month each period is due; mirrors
    -- capital_goals.call_deadline_day (1-28, so dateInPeriod() always
    -- resolves to a real calendar date, never a month-end overflow).
    -- Drives the monthly period generator (serviceFeeService.js) and
    -- the due-date reminder cron job.
    payment_day    SMALLINT NOT NULL
                   CHECK (payment_day BETWEEN 1 AND 28),
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

-- Monthly-amount change history — mirrors loan_received_rate_amendments:
-- the original amount is never overwritten, one row per change, so the
-- agreement detail page (v1.47.0) can show an exact effective-dated
-- history of every adjustment to the service money instead of just the
-- current figure.
CREATE TABLE service_fee_agreement_amendments (
    id               SERIAL PRIMARY KEY,
    agreement_id     INTEGER       NOT NULL REFERENCES service_fee_agreements(id),
    previous_amount  NUMERIC(20,4) NOT NULL,
    new_amount       NUMERIC(20,4) NOT NULL,
    reason           TEXT          NOT NULL,
    effective_from   DATE          NOT NULL,
    amended_by       INTEGER       NOT NULL REFERENCES users(id),
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT positive_service_fee_amendment_amounts
        CHECK (previous_amount > 0 AND new_amount > 0)
);

-- v1.52.0 — one row per agreement per calendar month, from the
-- agreement's start_date through the current month. amount_due/
-- amount_paid/status are CACHED columns (kept current by
-- serviceFeeService.js whenever a payment is applied or an override
-- is set) — mirrors side_fund_dues, the closer structural analog
-- here (a flat recurring amount, no pledge/iteration/fine layer that
-- would make a cached column drift-prone), not the live-computed
-- style capital_goal_calls uses.
-- amount_override/override_reason/override_by/override_at let the
-- Treasurer change a SINGLE historical month's amount_due without
-- touching the agreement's ongoing monthly_amount — that's what
-- service_fee_agreement_amendments (above) is for, a going-forward
-- change, the wrong tool for a one-off month. Audited via logAction
-- rather than a dedicated history table.
CREATE TABLE service_fee_monthly_periods (
    id               SERIAL PRIMARY KEY,
    agreement_id     INTEGER       NOT NULL REFERENCES service_fee_agreements(id),
    period           CHAR(7)       NOT NULL,  -- 'YYYY-MM'
    amount_due       NUMERIC(20,4) NOT NULL,
    amount_paid      NUMERIC(20,4) NOT NULL DEFAULT 0,
    status           VARCHAR(20)   NOT NULL DEFAULT 'UNPAID'
                     CHECK (status IN ('UNPAID', 'PARTIAL', 'PAID', 'EXCLUDED')),
    due_date         DATE          NOT NULL,
    amount_override  NUMERIC(20,4),
    override_reason  TEXT,
    override_by      INTEGER REFERENCES users(id),
    override_at      TIMESTAMPTZ,
    -- v1.54.0 — a month can be EXCLUDED (waived out of the agreement
    -- entirely — not owed, not counted as outstanding/overdue, and
    -- deliberately NOT counted as PAID either, since no money moved).
    -- Deliberately separate from amount_override above: override
    -- changes what a month is worth; exclude cancels the obligation
    -- outright while leaving amount_due/amount_paid untouched, so
    -- reversing an exclusion (see include-period) is just a status
    -- recompute, not a data restore.
    excluded_reason  TEXT,
    excluded_by      INTEGER REFERENCES users(id),
    excluded_at      TIMESTAMPTZ,
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT non_negative_service_fee_period_due      CHECK (amount_due >= 0),
    CONSTRAINT non_negative_service_fee_period_paid     CHECK (amount_paid >= 0),
    CONSTRAINT non_negative_service_fee_period_override CHECK (amount_override IS NULL OR amount_override >= 0),
    UNIQUE (agreement_id, period)
);

-- v1.52.0 — append-only record of exactly which period(s) a real,
-- CONFIRMED service_fee_payments row settled, and how much went to
-- each. Mirrors side_fund_payment_applications. Needed because one
-- payment (e.g. a bulk "settle all past months" action) can span
-- several periods, and a single period can be paid across more than
-- one payment (partial payments).
CREATE TABLE service_fee_payment_applications (
    id             SERIAL PRIMARY KEY,
    payment_id     INTEGER       NOT NULL REFERENCES service_fee_payments(id),
    period_id      INTEGER       NOT NULL REFERENCES service_fee_monthly_periods(id),
    amount         NUMERIC(20,4) NOT NULL CHECK (amount > 0),
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    UNIQUE (payment_id, period_id)
);

-- v1.52.0 — the PENDING version of the above. payment_confirmations
-- has no JSON/metadata column and only a single source_id (the
-- agreement, not a period), so there's nowhere on that table to
-- carry a per-period breakdown while a bulk settlement sits in
-- PENDING_CONFIRMATION awaiting the recipient. Written when the
-- confirmation is created (one row for a single-month payment,
-- several for a bulk settlement); read by confirmPayment() once the
-- real service_fee_payments row exists, to populate the table above.
-- confirmation_id's FK to payment_confirmations is added further down
-- via ALTER TABLE (same "forward-reference FK" pattern used for
-- share_certificates -> certificate_signing_rounds elsewhere in this
-- file) — payment_confirmations itself isn't defined until much later
-- in this file, so an inline REFERENCES here would fail on a fresh
-- install.
CREATE TABLE service_fee_payment_confirmation_periods (
    id               SERIAL PRIMARY KEY,
    confirmation_id  INTEGER       NOT NULL,
    period_id        INTEGER       NOT NULL REFERENCES service_fee_monthly_periods(id),
    amount           NUMERIC(20,4) NOT NULL CHECK (amount > 0),
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    UNIQUE (confirmation_id, period_id)
);

-- v1.52.0 — dedup table for the due-date reminder cron job, mirrors
-- the audit engagement reminder pattern (scheduler.js): ON CONFLICT
-- DO NOTHING guarantees at most one reminder per (agreement, period,
-- calendar day), so a daily-until-settled sweep never double-notifies
-- within the same day even if it's retried.
CREATE TABLE service_fee_due_reminders_sent (
    id            SERIAL PRIMARY KEY,
    agreement_id  INTEGER     NOT NULL REFERENCES service_fee_agreements(id),
    period_id     INTEGER     NOT NULL REFERENCES service_fee_monthly_periods(id),
    sent_date     DATE        NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (agreement_id, period_id, sent_date)
);

-- v1.53.0 — the contracted person's own self-service request to be
-- paid for one or more already-unpaid months, as a single lump sum if
-- more than one. Mirrors service_reimbursement_requests' PENDING/
-- APPROVED/REJECTED shape rather than Requisitions, since the payload
-- here (a per-period breakdown) doesn't fit Requisitions' flat
-- amount_requested model. Approving one does NOT post a transaction
-- directly — it creates a normal payment_confirmations entry (see
-- confirmation_id below) through the exact same two-step flow a
-- Treasurer-initiated payment already uses, so the recipient still
-- confirms actual receipt before anything posts.
-- confirmation_id's FK to payment_confirmations is added further
-- down via ALTER TABLE (forward-reference — payment_confirmations
-- isn't defined until later in this file).
CREATE TABLE service_fee_payment_requests (
    id              SERIAL PRIMARY KEY,
    agreement_id    INTEGER     NOT NULL REFERENCES service_fee_agreements(id),
    requested_by    INTEGER     NOT NULL REFERENCES users(id),
    status          VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
    notes           TEXT,
    reviewed_by     INTEGER REFERENCES users(id),
    reviewed_at     TIMESTAMPTZ,
    review_notes    TEXT,
    confirmation_id INTEGER,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Which month(s) + how much a payment request covers — auto-filled
-- client-side from the agreement's own outstanding balance per month,
-- but editable by the Treasurer before approving (same "auto-filled,
-- editable" convention as the existing Settle Past Months action).
CREATE TABLE service_fee_payment_request_periods (
    id         SERIAL PRIMARY KEY,
    request_id INTEGER       NOT NULL REFERENCES service_fee_payment_requests(id),
    period_id  INTEGER       NOT NULL REFERENCES service_fee_monthly_periods(id),
    amount     NUMERIC(20,4) NOT NULL CHECK (amount > 0),
    UNIQUE (request_id, period_id)
);

-- v1.53.0 — an advance: money paid out now against future, not-yet-
-- earned months, recovered automatically from those months once they
-- come due (per the Treasurer's confirmed answer: recovered in full
-- from the very next payment(s), oldest-future-first, spilling into
-- further months if one isn't enough). outstanding_balance stays 0
-- until the disbursement is actually CONFIRMED (the recipient
-- acknowledges receiving the advance cash) — nothing is owed back
-- for money that was only approved, never actually paid out.
-- confirmation_id's FK to payment_confirmations is added further
-- down via ALTER TABLE (forward-reference, same as above).
CREATE TABLE service_fee_advances (
    id                   SERIAL PRIMARY KEY,
    agreement_id         INTEGER       NOT NULL REFERENCES service_fee_agreements(id),
    amount               NUMERIC(20,4) NOT NULL CHECK (amount > 0),
    reason               TEXT          NOT NULL,
    status               VARCHAR(20)   NOT NULL DEFAULT 'PENDING'
                         CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
    requested_by         INTEGER       NOT NULL REFERENCES users(id),
    reviewed_by          INTEGER REFERENCES users(id),
    reviewed_at          TIMESTAMPTZ,
    review_notes         TEXT,
    confirmation_id      INTEGER,
    outstanding_balance  NUMERIC(20,4) NOT NULL DEFAULT 0,
    disbursed_at         TIMESTAMPTZ,
    transaction_id       INTEGER REFERENCES transactions(id),
    created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- The recovery schedule for one advance — which future period(s)
-- absorb how much of it. Written (unapplied — applied_at NULL) at
-- approval time, once the Treasurer has reviewed/edited the
-- auto-suggested oldest-future-first breakdown; actually applied
-- (period.amount_paid incremented, applied_at set) only once the
-- disbursement itself is confirmed received — an approved-but-not-
-- yet-confirmed advance must never reduce what a future month shows
-- as owed. Applying it is an internal accounting offset only (per the
-- Treasurer's confirmed answer) — no separate transaction is posted
-- for the recovered portion, the same way a banked credit is drawn
-- down elsewhere in this app (e.g. side_fund_member_credit).
CREATE TABLE service_fee_advance_recoveries (
    id          SERIAL PRIMARY KEY,
    advance_id  INTEGER       NOT NULL REFERENCES service_fee_advances(id),
    period_id   INTEGER       NOT NULL REFERENCES service_fee_monthly_periods(id),
    amount      NUMERIC(20,4) NOT NULL CHECK (amount > 0),
    applied_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    UNIQUE (advance_id, period_id)
);

CREATE INDEX idx_service_fee_payment_requests_agreement ON service_fee_payment_requests (agreement_id);
CREATE INDEX idx_service_fee_payment_requests_status    ON service_fee_payment_requests (status);
CREATE INDEX idx_service_fee_payment_request_periods_request ON service_fee_payment_request_periods (request_id);
CREATE INDEX idx_service_fee_advances_agreement         ON service_fee_advances (agreement_id);
CREATE INDEX idx_service_fee_advances_status            ON service_fee_advances (status);
CREATE INDEX idx_service_fee_advance_recoveries_advance ON service_fee_advance_recoveries (advance_id);
CREATE INDEX idx_service_fee_advance_recoveries_period  ON service_fee_advance_recoveries (period_id);

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
CREATE INDEX idx_service_fee_amendments_agreement       ON service_fee_agreement_amendments (agreement_id);
CREATE INDEX idx_service_fee_periods_agreement          ON service_fee_monthly_periods (agreement_id);
CREATE INDEX idx_service_fee_periods_due_date           ON service_fee_monthly_periods (due_date);
CREATE INDEX idx_service_fee_applications_payment       ON service_fee_payment_applications (payment_id);
CREATE INDEX idx_service_fee_applications_period        ON service_fee_payment_applications (period_id);
CREATE INDEX idx_service_fee_confirmation_periods        ON service_fee_payment_confirmation_periods (confirmation_id);
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
    -- v1.44.0 — widened from the original 4 to every document type
    -- (mirrors document_stamp_requirements' own CHECK below). Being
    -- listed here only makes a type ELIGIBLE for a signature
    -- requirement; an Admin still has to configure one in Settings ->
    -- Signatories for anything to actually change.
    document_type VARCHAR(30) NOT NULL
                  CHECK (document_type IN (
                      'RESOLUTION', 'LOAN_AGREEMENT', 'GRANT_AGREEMENT', 'SHARE_CERTIFICATE',
                      'CONTRACT', 'MEETING_MINUTES', 'MEETING_AGENDA', 'INVESTMENT_PROPOSAL',
                      'FINANCIAL_REPORT_GENERAL', 'FINANCIAL_REPORT_INDIVIDUAL',
                      'RECEIPT', 'AUDITOR_FEEDBACK', 'AUDIT_REPORT', 'OTHER'
                  )),
    role_id       INTEGER NOT NULL REFERENCES roles(id),
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by    INTEGER REFERENCES users(id),
    UNIQUE (document_type, role_id)
);

-- One row per required-role signing slot on a specific signable
-- thing. target_type/target_id points at either a `documents` row or
-- a `certificate_signing_rounds` row. Each slot is required by
-- EITHER a ROLE (required_role_id — whoever currently holds it may
-- fill the slot) OR, since v1.45.0, one SPECIFIC person
-- (required_user_id — only that exact user may fill it, regardless
-- of what role they hold; position_title is a free-text label like
-- 'Chairman'/'Secretary' describing their capacity on this one
-- document, purely for display). Exactly one of the two must be set
-- — see document_signatures_slot_type_check below. signed_by records
-- who actually signed; signature_snapshot_path is a copy of that
-- person's users.signature_path taken at signing time, so a later
-- change to their stored signature never alters something already
-- signed.
CREATE TABLE document_signatures (
    id                      SERIAL PRIMARY KEY,
    target_type             VARCHAR(20) NOT NULL
                            CHECK (target_type IN ('DOCUMENT', 'CERTIFICATE_ROUND')),
    target_id               INTEGER NOT NULL,
    required_role_id        INTEGER REFERENCES roles(id),
    required_user_id        INTEGER REFERENCES users(id),
    position_title          VARCHAR(50),
    status                  VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                            CHECK (status IN ('PENDING', 'SIGNED')),
    signed_by               INTEGER REFERENCES users(id),
    signature_snapshot_path TEXT,
    signed_at               TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT document_signatures_slot_type_check CHECK (
        (required_role_id IS NOT NULL AND required_user_id IS NULL) OR
        (required_role_id IS NULL AND required_user_id IS NOT NULL)
    )
);
CREATE INDEX idx_doc_signatures_target ON document_signatures (target_type, target_id);
-- Two partial unique indexes instead of one composite UNIQUE, since
-- required_role_id and required_user_id are each NULL half the time
-- now (a plain UNIQUE constraint would let that NULL column silently
-- stop deduplicating the other one).
CREATE UNIQUE INDEX document_signatures_role_slot_unique
    ON document_signatures (target_type, target_id, required_role_id)
    WHERE required_role_id IS NOT NULL;
CREATE UNIQUE INDEX document_signatures_user_slot_unique
    ON document_signatures (target_type, target_id, required_user_id)
    WHERE required_user_id IS NOT NULL;

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
    -- v1.64.0 — the historical date every certificate in this round
    -- was snapshotted as of (see share_certificates.as_of_date above).
    -- One value per round since every certificate in a round shares
    -- the same period.
    as_of_date        DATE,
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
            'MMF_TOPUP_OUT', 'MMF_WITHDRAWAL_IN',
            'SIDE_FUND_PAYOUT_OUT'
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
    -- v1.43.0 — Capital Goal Calls. NULL on every goal created before
    -- this version (a legacy, free-form goal funded by ordinary
    -- shareholder_contributions, untouched by any of this). Every new
    -- goal from here on always sets these three: goal_type distinguishes
    -- the one yearly PRIMARY goal from any number of SECONDARY goals
    -- alongside it (enforced one-per-year via the partial unique index
    -- below); fiscal_year ties it to a calendar year; call_deadline_day
    -- is the day of each covered month that its own iteration-1 pledge
    -- round closes on. See capital_goal_monthly_calls below — a goal
    -- itself is never pledged against directly, only its monthly rows.
    goal_type          VARCHAR(20)
                       CHECK (goal_type IS NULL OR goal_type IN ('PRIMARY', 'SECONDARY')),
    fiscal_year        INTEGER,
    call_deadline_day  SMALLINT
                       CHECK (call_deadline_day IS NULL OR (call_deadline_day BETWEEN 1 AND 28)),
    -- v1.51.0 — the date pledging/iteration/fine machinery actually
    -- starts. NULL means "same as start_date" (zero-behaviour-change
    -- default). Any month whose period is BEFORE effective_from's own
    -- period is "historical": generated already CLOSED, no pledging/
    -- fines, its collected figure a read-only aggregate of actual
    -- shareholder_contributions already recorded in that month. Lets a
    -- PRIMARY goal be adopted mid-year without penalizing (or trying to
    -- retroactively force pledges into) months that already happened.
    effective_from     DATE,
    CONSTRAINT positive_goal_target CHECK (target_amount > 0),
    CONSTRAINT valid_goal_range CHECK (end_date >= start_date),
    CONSTRAINT capital_goal_effective_from_first_of_month
        CHECK (effective_from IS NULL OR EXTRACT(DAY FROM effective_from) = 1)
);

CREATE INDEX idx_capital_goals_status ON capital_goals (status);

-- Exactly one PRIMARY goal per fiscal year — legacy goals (goal_type
-- NULL) are entirely unaffected by this index.
CREATE UNIQUE INDEX one_primary_capital_goal_per_year
    ON capital_goals (fiscal_year) WHERE goal_type = 'PRIMARY';

INSERT INTO permissions (code, module, description) VALUES
    ('CAPITAL_GOAL_VIEW',   'FINANCE', 'View capital fundraising goals and their progress'),
    ('CAPITAL_GOAL_MANAGE', 'FINANCE', 'Create, edit, and cancel capital fundraising goals')
ON CONFLICT (code) DO NOTHING;

-- ============================================================
-- CAPITAL GOAL CALLS (v1.43.0) — "call on shares"
--
-- A PRIMARY or SECONDARY capital_goals row is never pledged against
-- directly. It's pre-split, in full, at creation time, into one
-- capital_goal_monthly_calls row per calendar month it covers, each
-- with its own fixed target (goal.target_amount / total_months) and
-- its own iteration-1 deadline (goal.call_deadline_day of that
-- month). Shareholders pledge against a specific month.
--
-- Approving a pledge (capital_goal_pledges -> capital_goal_pledge_
-- payments) IS the act of recording the money arriving — same
-- "approval = posting" shape Requisitions/Fines already use — and
-- immediately issues real shares via the ordinary shareholder_
-- contributions core. A pledge can be settled across more than one
-- tranche (capital_goal_pledge_payments), each judged for lateness
-- independently.
--
-- If a month's target isn't fully met by its iteration-1 deadline,
-- iteration 2 opens automatically for 7 more days, offered only to
-- members who pledged ABOVE that month's baseline in iteration 1 —
-- never fined, regardless of how it's eventually settled. Any
-- shortfall left over keeps rolling forward, stacked onto every
-- later month's own iteration 2, until it's actually covered —
-- capital_goal_payment_applications (same pattern as v1.41.0's
-- side_fund_payment_applications) records exactly which month(s) one
-- payment actually counted toward, oldest-unpaid-period-first.
-- ============================================================

CREATE TABLE capital_goal_monthly_calls (
    id                SERIAL PRIMARY KEY,
    capital_goal_id   INTEGER       NOT NULL REFERENCES capital_goals(id),
    period            CHAR(7)       NOT NULL,  -- 'YYYY-MM'
    monthly_target    NUMERIC(20,4) NOT NULL,  -- goal.target_amount / total_months, fixed at generation
    iteration1_deadline DATE        NOT NULL,
    iteration2_deadline DATE,                  -- set only once iteration 2 actually opens
    status            VARCHAR(20)   NOT NULL DEFAULT 'ITERATION_1'
                      CHECK (status IN ('ITERATION_1', 'ITERATION_2', 'CLOSED')),
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT positive_monthly_target CHECK (monthly_target > 0),
    CONSTRAINT unique_goal_period UNIQUE (capital_goal_id, period)
);

CREATE INDEX idx_capital_goal_monthly_calls_goal   ON capital_goal_monthly_calls (capital_goal_id);
CREATE INDEX idx_capital_goal_monthly_calls_status ON capital_goal_monthly_calls (status);

CREATE TABLE capital_goal_pledges (
    id                     SERIAL PRIMARY KEY,
    reference_id           INTEGER       NOT NULL REFERENCES references_registry(id),
    monthly_call_id        INTEGER       NOT NULL REFERENCES capital_goal_monthly_calls(id),
    user_id                INTEGER       NOT NULL REFERENCES users(id),
    iteration              SMALLINT      NOT NULL CHECK (iteration IN (1, 2)),
    currency_id            INTEGER       NOT NULL REFERENCES currencies(id),
    pledged_amount         NUMERIC(20,4) NOT NULL CHECK (pledged_amount >= 0),
    baseline_amount_snapshot NUMERIC(20,4) NOT NULL, -- the suggested equal-split shown at entry time
    status                 VARCHAR(20)   NOT NULL DEFAULT 'PENDING'
                           CHECK (status IN ('PENDING', 'PARTIAL', 'FULFILLED', 'REJECTED')),
    amount_settled         NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (amount_settled >= 0),
    submitted_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    reviewed_by            INTEGER REFERENCES users(id),
    reviewed_at            TIMESTAMPTZ,
    review_notes           TEXT,
    created_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_pledge_per_iteration UNIQUE (monthly_call_id, user_id, iteration),
    CONSTRAINT settled_not_over_pledged CHECK (amount_settled <= pledged_amount)
);

CREATE INDEX idx_capital_goal_pledges_call   ON capital_goal_pledges (monthly_call_id);
CREATE INDEX idx_capital_goal_pledges_user   ON capital_goal_pledges (user_id);
CREATE INDEX idx_capital_goal_pledges_status ON capital_goal_pledges (status);

CREATE TABLE capital_goal_pledge_payments (
    id                             SERIAL PRIMARY KEY,
    pledge_id                      INTEGER       NOT NULL REFERENCES capital_goal_pledges(id),
    amount                         NUMERIC(20,4) NOT NULL CHECK (amount > 0), -- in the pledge's own currency
    account_id                     INTEGER       NOT NULL REFERENCES accounts(id),
    transaction_id                 INTEGER       NOT NULL REFERENCES transactions(id),
    shareholder_contribution_id    INTEGER       NOT NULL REFERENCES shareholder_contributions(id),
    converted_amount_goal_currency NUMERIC(20,4) NOT NULL, -- frozen conversion into the capital goal's own currency, for progress tracking
    exchange_rate_to_goal_currency NUMERIC(20,8) NOT NULL,
    is_late                        BOOLEAN       NOT NULL DEFAULT FALSE,
    days_late                      INTEGER,
    -- fine_id added via ALTER TABLE further down, right after the
    -- `fines` table itself is created (fines is defined later in this
    -- file than capital_goals — same reason requisitions.fine_id is
    -- added the same way, just below fines' own CREATE TABLE).
    approved_by                    INTEGER       NOT NULL REFERENCES users(id),
    approved_at                    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    notes                          TEXT
);

CREATE INDEX idx_capital_goal_pledge_payments_pledge ON capital_goal_pledge_payments (pledge_id);

CREATE TABLE capital_goal_payment_applications (
    id              SERIAL PRIMARY KEY,
    payment_id      INTEGER       NOT NULL REFERENCES capital_goal_pledge_payments(id),
    monthly_call_id INTEGER       NOT NULL REFERENCES capital_goal_monthly_calls(id),
    amount          NUMERIC(20,4) NOT NULL CHECK (amount > 0) -- always in the capital goal's own currency
);

CREATE INDEX idx_capital_goal_payment_applications_payment ON capital_goal_payment_applications (payment_id);
CREATE INDEX idx_capital_goal_payment_applications_call   ON capital_goal_payment_applications (monthly_call_id);

-- ============================================================
-- GROUP 26: PAYMENT ACKNOWLEDGEMENTS (v1.30.0, extended v1.30.2,
-- Section 4.35) — a two-way, two-step record for money paid OUT to
-- an individual (dividends, service fee payments, expense
-- reimbursements, savings handouts — "e.t.c." per the requesting
-- brief, so `source_type` is a CHECK list deliberately easy to
-- extend with more payout types later, not a polymorphic
-- free-for-all).
--
-- Flow: the system auto-creates one row (PENDING_ACK) the moment a
-- payment is actually disbursed — never created by hand. The
-- RECIPIENT then reviews the amount/purpose and either acknowledges
-- (ACKNOWLEDGED) or disputes it (DISPUTED, with a reason, no money
-- movement happens automatically either way — this is a paper-trail
-- confirmation step, not a re-approval of the underlying payment).
-- Once ACKNOWLEDGED, whoever holds PAYMENT_ACK_MANAGE (Treasurer/
-- Director, granted like any other new permission — starts ungranted
-- for every role, Admin included) gives the final sign-off
-- (FINAL_APPROVED), at which point a two-party printable document
-- (payer + recipient, Section 4.35) is available.
--
-- purpose/amount/currency are captured as a point-in-time snapshot
-- on this row (not read live off the source record at print time) —
-- so the acknowledgement always reflects exactly what the recipient
-- actually reviewed and signed off on, even if the underlying
-- dividend/agreement/request is edited or its category renamed later.
-- ============================================================

CREATE TABLE payment_acknowledgements (
    id                   SERIAL PRIMARY KEY,
    reference_id         INTEGER       NOT NULL REFERENCES references_registry(id),
    source_type          VARCHAR(30)   NOT NULL
                         CHECK (source_type IN ('DIVIDEND', 'SERVICE_FEE_PAYMENT', 'REIMBURSEMENT', 'SAVINGS_HANDOUT', 'SIDE_FUND_PAYOUT', 'DEPOSIT_REFUND')),
    source_id            INTEGER       NOT NULL,
    transaction_id       INTEGER       REFERENCES transactions(id),
    payer_id             INTEGER       NOT NULL REFERENCES users(id),
    recipient_id         INTEGER       NOT NULL REFERENCES users(id),
    amount               NUMERIC(20,4) NOT NULL,
    currency_id          INTEGER       NOT NULL REFERENCES currencies(id),
    purpose              TEXT          NOT NULL,
    status               VARCHAR(20)   NOT NULL DEFAULT 'PENDING_ACK'
                         CHECK (status IN ('PENDING_ACK', 'ACKNOWLEDGED', 'DISPUTED', 'FINAL_APPROVED')),
    acknowledged_at      TIMESTAMPTZ,
    acknowledgement_note TEXT,
    dispute_reason       TEXT,
    disputed_at          TIMESTAMPTZ,
    final_approved_by    INTEGER       REFERENCES users(id),
    final_approved_at    TIMESTAMPTZ,
    created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT positive_ack_amount CHECK (amount > 0)
);

CREATE INDEX idx_payment_ack_recipient ON payment_acknowledgements (recipient_id);
CREATE INDEX idx_payment_ack_status    ON payment_acknowledgements (status);
CREATE INDEX idx_payment_ack_source    ON payment_acknowledgements (source_type, source_id);

INSERT INTO permissions (code, module, description) VALUES
    ('PAYMENT_ACK_VIEW',   'FINANCE', 'View all payment acknowledgements (Treasury oversight, not just your own)'),
    ('PAYMENT_ACK_MANAGE', 'FINANCE', 'Give final sign-off on a payment acknowledgement once the recipient has confirmed it')
ON CONFLICT (code) DO NOTHING;

-- ============================================================
-- GROUP 27: SIDE FUND MEMBERSHIP CHECKLIST & EXIT PAYOUTS (v1.32.0,
-- Section 4.10)
--
-- Before this, EVERY active shareholder automatically owed a monthly
-- side fund due (generateDuesForPeriod sourced straight from
-- shareholding_registry) — there was no way to opt a member out. This
-- checklist replaces that blanket rule: dues are now only generated
-- for a member while side_fund_members.is_in = TRUE, and only from
-- their own start_period onward (which can be set in the past —
-- adding a member with e.g. start_period = '2025-01' immediately
-- backfills a PENDING due for every month from then to the current
-- one, so their overdue balance reflects the true historical
-- obligation, not just what accrued after today).
--
-- Removing a member (is_in -> FALSE) settles their standing:
--   payout = (their own side_fund_dues.amount_paid, summed over every
--             period >= their current start_period, i.e. this
--             membership cycle only)
--          + (any side_fund_member_credit balance still banked)
--          - (total side_fund_expenses, split evenly across every
--             member currently marked is_in = TRUE, INCLUDING the one
--             leaving)
-- floored at zero. If positive, it's transferred straight into the
-- leaving member's own Savings balance (a normal two-leg posting —
-- DEBIT the side fund's parent account with inflow_type
-- SIDE_FUND_PAYOUT_OUT, CREDIT the Savings account — exactly the same
-- shape as a Dividend approval) and a payment_acknowledgements row
-- (source_type SIDE_FUND_PAYOUT) is created for the two-party
-- sign-off, same as every other money-paid-OUT-to-an-individual flow
-- in this system. A member who rejoins later gets a fresh start_period
-- and a fresh JOINED event — their side_fund_dues history from the
-- previous membership cycle is untouched and simply excluded from the
-- next payout's "amount_paid" sum by the period >= start_period bound.
-- ============================================================

-- The checklist itself — one row per member who has ever been added,
-- current state only (is_in is the live in/out flag). No row at all
-- means "never added, not in the fund".
CREATE TABLE side_fund_members (
    user_id      INTEGER PRIMARY KEY REFERENCES users(id),
    is_in        BOOLEAN NOT NULL DEFAULT FALSE,
    start_period CHAR(7),  -- 'YYYY-MM' — required once is_in = TRUE; the first month this member owes a due
    added_by     INTEGER REFERENCES users(id),
    added_at     TIMESTAMPTZ,
    removed_by   INTEGER REFERENCES users(id),
    removed_at   TIMESTAMPTZ,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT side_fund_member_start_period_format
        CHECK (start_period IS NULL OR start_period ~ '^\d{4}-\d{2}$'),
    CONSTRAINT side_fund_member_in_needs_start_period
        CHECK (is_in = FALSE OR start_period IS NOT NULL)
);

-- Audit trail of every join/leave — JOINED events record the
-- start_period chosen; REMOVED events record the full exit-payout
-- breakdown so it stays reviewable even after side_fund_members has
-- moved on to a later cycle.
CREATE TABLE side_fund_membership_events (
    id             SERIAL PRIMARY KEY,
    user_id        INTEGER     NOT NULL REFERENCES users(id),
    event_type     VARCHAR(10) NOT NULL CHECK (event_type IN ('JOINED', 'REMOVED')),
    start_period   CHAR(7),                  -- JOINED only
    dues_paid      NUMERIC(20,4),            -- REMOVED only — this cycle's amount_paid sum
    credit_applied NUMERIC(20,4),            -- REMOVED only — banked credit rolled into the payout
    member_count   INTEGER,                  -- REMOVED only — divisor used for the expense split
    total_expenses NUMERIC(20,4),            -- REMOVED only — all-time side_fund_expenses total at the time
    expense_share  NUMERIC(20,4),            -- REMOVED only — total_expenses / member_count
    payout_amount  NUMERIC(20,4),            -- REMOVED only — the amount actually transferred (0 if none)
    payment_ack_id INTEGER REFERENCES payment_acknowledgements(id),
    performed_by   INTEGER NOT NULL REFERENCES users(id),
    performed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    notes          TEXT
);
CREATE INDEX idx_side_fund_membership_events_user ON side_fund_membership_events (user_id, performed_at DESC);

-- ============================================================
-- GROUP 28: FINES & PENALTIES (v1.37.0)
-- Treasury (Treasurer/Assistant Treasurer/Admin) can assign a fine to
-- a shareholder — special income to the company, posted with its own
-- traceable inflow_type (FINE_PAYMENT_IN) once cleared. A fine is
-- denominated in one currency at creation and can only be paid into
-- an account in that same currency. Three reasons: CONTRIBUTION_FAILURE
-- (auto-calculates amount = defaulted_amount x fine_percentage/100 from
-- the deadline/defaulted-amount/percentage entered), MEETING_VIOLATION,
-- and GENERAL (amount entered directly for both). Cleared either by the
-- Treasurer entering the payment directly (date + description only) or
-- by the member submitting a Requisition (FINE_PAYMENT type,
-- requisitions.fine_id) after paying externally — reviewed the same
-- way CONTRIBUTION_ACKNOWLEDGEMENT/SIDE_FUND_CONTRIBUTION already are.
-- ============================================================

CREATE TABLE fines (
    id                   SERIAL PRIMARY KEY,
    reference_id         INTEGER       NOT NULL REFERENCES references_registry(id),
    user_id              INTEGER       NOT NULL REFERENCES users(id),
    reason               VARCHAR(30)   NOT NULL
                         CHECK (reason IN ('CONTRIBUTION_FAILURE', 'MEETING_VIOLATION', 'GENERAL')),
    description          TEXT,
    currency_id          INTEGER       NOT NULL REFERENCES currencies(id),
    amount               NUMERIC(20,4) NOT NULL,
    -- Contribution-failure auto-calc inputs — NULL for the other two
    -- reasons, required (enforced below) for this one.
    default_deadline     DATE,
    defaulted_amount     NUMERIC(20,4),
    fine_percentage      NUMERIC(8,4),
    status               VARCHAR(20)   NOT NULL DEFAULT 'OUTSTANDING'
                         CHECK (status IN ('OUTSTANDING', 'PAID')),
    -- Populated only once cleared/paid
    account_id           INTEGER REFERENCES accounts(id),
    transaction_id       INTEGER REFERENCES transactions(id),
    paid_date            DATE,
    payment_description  TEXT,
    cleared_by           INTEGER REFERENCES users(id),
    cleared_at           TIMESTAMPTZ,
    assigned_by          INTEGER       NOT NULL REFERENCES users(id),
    created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT positive_fine_amount CHECK (amount > 0),
    CONSTRAINT contribution_failure_fields CHECK (
        reason != 'CONTRIBUTION_FAILURE' OR
        (default_deadline IS NOT NULL AND defaulted_amount IS NOT NULL AND fine_percentage IS NOT NULL)
    )
);

CREATE INDEX idx_fines_user   ON fines (user_id);
CREATE INDEX idx_fines_status ON fines (status);

-- v1.59.0 — pay one or more of a member's own OUTSTANDING fines
-- straight out of their savings principal, instead of paying in cash.
-- Two entry points, mirroring the Savings module's own established
-- pattern: a Treasurer/Assistant Treasurer enters it directly on the
-- member's behalf (source=TREASURY_DIRECT) and the member themselves
-- must confirm before anything posts (PENDING_CONFIRMATION — same
-- shape as a Savings Handout / v1.58.0's Savings-to-Capital
-- Conversion); OR a member requests it themselves
-- (source=MEMBER_REQUEST) and a Treasurer/Assistant Treasurer must
-- approve it (PENDING_APPROVAL — same shape as a self-service Savings
-- Deposit requisition). Whichever party did NOT initiate it is always
-- the one who reviews it, tracked generically as reviewed_by/at/notes
-- since only one review action (confirm-or-reject, or
-- approve-or-deny) ever happens per settlement, never both.
-- Settling debits the SAVINGS account once for the combined total
-- (savings_transaction_id), then reuses finesService.clearFine() once
-- per selected fine (each fine keeps its own normal FINE_PAYMENT_IN
-- transaction, tracked per-item in savings_fine_settlement_items) —
-- the exact same crediting core every other fine-clearing path
-- already shares. Every selectable fine must be in the SAME currency
-- as the Savings account itself (enforced in the controller) — this
-- system never silently blends or converts currencies across a real
-- money movement.
CREATE TABLE savings_fine_settlements (
    id                       SERIAL PRIMARY KEY,
    reference_id             INTEGER       NOT NULL REFERENCES references_registry(id),
    user_id                  INTEGER       NOT NULL REFERENCES users(id),      -- whose fines and whose savings
    account_id               INTEGER       NOT NULL REFERENCES accounts(id),   -- the SAVINGS account the money leaves
    destination_account_id   INTEGER       NOT NULL REFERENCES accounts(id),   -- where each fine's own clearing payment lands (must match the fines' own currency)
    total_amount             NUMERIC(20,4) NOT NULL,
    currency_id              INTEGER       NOT NULL REFERENCES currencies(id),
    settlement_date           DATE          NOT NULL,
    notes                     TEXT,
    source                    VARCHAR(20)   NOT NULL
                              CHECK (source IN ('TREASURY_DIRECT','MEMBER_REQUEST')),
    status                    VARCHAR(30)   NOT NULL DEFAULT 'PENDING_CONFIRMATION'
                              CHECK (status IN ('PENDING_CONFIRMATION','PENDING_APPROVAL','SETTLED','REJECTED')),
    savings_transaction_id    INTEGER REFERENCES transactions(id),             -- the single SAVINGS DEBIT covering total_amount, set once SETTLED
    initiated_by              INTEGER       NOT NULL REFERENCES users(id),     -- the Treasurer (TREASURY_DIRECT) or the member themselves (MEMBER_REQUEST)
    reviewed_by                INTEGER REFERENCES users(id),                   -- whoever confirmed/rejected or approved/denied it
    reviewed_at                TIMESTAMPTZ,
    review_notes                TEXT,
    created_at                  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT positive_savings_fine_settlement_total CHECK (total_amount > 0)
);

CREATE TABLE savings_fine_settlement_items (
    id                   SERIAL PRIMARY KEY,
    settlement_id         INTEGER       NOT NULL REFERENCES savings_fine_settlements(id),
    fine_id               INTEGER       NOT NULL REFERENCES fines(id),
    amount                NUMERIC(20,4) NOT NULL,               -- snapshot of fines.amount at selection time, for display/audit
    fine_transaction_id   INTEGER REFERENCES transactions(id),  -- the clearFine() CREDIT for this specific fine, set once SETTLED
    UNIQUE (settlement_id, fine_id)
);

CREATE INDEX idx_savings_fine_settlements_user   ON savings_fine_settlements (user_id, status);
CREATE INDEX idx_savings_fine_settlements_status ON savings_fine_settlements (status);
CREATE INDEX idx_savings_fine_settlement_items_settlement ON savings_fine_settlement_items (settlement_id);
CREATE INDEX idx_savings_fine_settlement_items_fine        ON savings_fine_settlement_items (fine_id);

ALTER TABLE requisitions ADD COLUMN fine_id INTEGER REFERENCES fines(id);

-- v1.43.0 — only ever set for a late ITERATION 1 pledge payment
-- tranche (capital_goal_pledge_payments); see that table above.
ALTER TABLE capital_goal_pledge_payments ADD COLUMN fine_id INTEGER REFERENCES fines(id);

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
            'EXPENSE', 'CONTRIBUTION_ACKNOWLEDGEMENT', 'SAVINGS_DEPOSIT',
            'SIDE_FUND_CONTRIBUTION', 'FINE_PAYMENT'
        ));
END $$;

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
            'MMF_TOPUP_OUT', 'MMF_WITHDRAWAL_IN',
            'SIDE_FUND_PAYOUT_OUT',
            'FINE_PAYMENT_IN'
        ));
END $$;

INSERT INTO permissions (code, module, description) VALUES
    ('FINE_VIEW',   'FINANCE', 'View every member''s fines (Treasury oversight, not just your own)'),
    ('FINE_MANAGE', 'FINANCE', 'Assign fines to shareholders and clear/record fine payments')
ON CONFLICT (code) DO NOTHING;

-- ============================================================
-- GROUP 29: MEMBER DEPOSIT TRACKING (v1.38.0, activation/parent
-- account added v1.38.1)
-- An optional feature, off by default (is_active) — a company that
-- doesn't use deposits sees nothing extra. Like the Side Fund, it is
-- "parented" to one specific account chosen when activating it. UNLIKE
-- the Side Fund, that account is NOT a separate envelope — there is no
-- current_balance counter layered on top of it; every deposit is a
-- completely normal transaction into that one designated account,
-- fully spendable/commingled from that moment on. deposit_config is
-- only ever a tracking pointer (which account, which target), never a
-- pooled balance itself. Does not contribute to shareholding. Funded
-- via a contribution slice (mirroring Side Fund/Savings) AND a
-- standalone inflow entry, both normalized into deposit_config's own
-- currency (derived from the parent account) at credit time so they
-- can be compared against the single company-wide target. On exit,
-- refunded into Savings (same two-leg shape as the Side Fund exit
-- payout) with a deduction — MUTUAL_AGREEMENT is a fixed 5%, FORCED is
-- admin-entered at exit time and must be >= 50%.
-- ============================================================

CREATE TABLE deposit_config (
    id                 INTEGER       PRIMARY KEY DEFAULT 1,
    is_active          BOOLEAN       NOT NULL DEFAULT FALSE,
    parent_account_id  INTEGER REFERENCES accounts(id),
    target_amount      NUMERIC(20,4) NOT NULL DEFAULT 0,
    currency_id        INTEGER REFERENCES currencies(id),
    updated_by         INTEGER REFERENCES users(id),
    updated_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT single_deposit_config_row     CHECK (id = 1),
    CONSTRAINT non_negative_deposit_target   CHECK (target_amount >= 0)
);
INSERT INTO deposit_config (id, target_amount) VALUES (1, 0);

CREATE TABLE deposit_balances (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id),
    balance    NUMERIC(20,4) NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT non_negative_deposit_balance CHECK (balance >= 0)
);

-- Presence of a row = this member is excused from the "cannot be
-- zero" expectation (monitoring/reporting only).
CREATE TABLE deposit_excusals (
    user_id     INTEGER PRIMARY KEY REFERENCES users(id),
    excused_by  INTEGER NOT NULL REFERENCES users(id),
    excused_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reason      TEXT
);

CREATE TABLE deposit_entries (
    id                 SERIAL PRIMARY KEY,
    user_id            INTEGER       NOT NULL REFERENCES users(id),
    source             VARCHAR(20)   NOT NULL CHECK (source IN ('CONTRIBUTION_SLICE', 'STANDALONE')),
    account_id         INTEGER       NOT NULL REFERENCES accounts(id),
    transaction_id     INTEGER REFERENCES transactions(id),
    amount             NUMERIC(20,4) NOT NULL,
    currency_id        INTEGER       NOT NULL REFERENCES currencies(id),
    normalized_amount  NUMERIC(20,4) NOT NULL,
    exchange_rate_used NUMERIC(20,8) NOT NULL DEFAULT 1,
    entry_date         DATE          NOT NULL,
    recorded_by        INTEGER       NOT NULL REFERENCES users(id),
    created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    -- v1.40.1: set when the linked transaction is reversed
    -- (transactionsController.reverseTransaction) — by that point
    -- normalized_amount has already been decremented back out of
    -- deposit_balances.balance for this entry's user. The row itself
    -- is kept, never deleted, so deposit history stays complete.
    is_reversed        BOOLEAN       NOT NULL DEFAULT FALSE,
    reversed_at        TIMESTAMPTZ,
    reversed_by        INTEGER REFERENCES users(id),
    CONSTRAINT positive_deposit_entry_amount CHECK (amount > 0)
);
CREATE INDEX idx_deposit_entries_user ON deposit_entries (user_id, entry_date DESC);

CREATE TABLE deposit_exit_events (
    id                    SERIAL PRIMARY KEY,
    user_id               INTEGER       NOT NULL REFERENCES users(id),
    exit_type             VARCHAR(20)   NOT NULL CHECK (exit_type IN ('MUTUAL_AGREEMENT', 'FORCED')),
    deduction_percentage  NUMERIC(5,2)  NOT NULL,
    gross_balance         NUMERIC(20,4) NOT NULL,
    deduction_amount      NUMERIC(20,4) NOT NULL,
    net_payout            NUMERIC(20,4) NOT NULL,
    source_account_id     INTEGER REFERENCES accounts(id),
    transaction_id        INTEGER REFERENCES transactions(id),
    payment_ack_id        INTEGER REFERENCES payment_acknowledgements(id),
    processed_by          INTEGER       NOT NULL REFERENCES users(id),
    processed_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    notes                 TEXT,
    CONSTRAINT valid_deposit_exit_deduction CHECK (
        (exit_type = 'MUTUAL_AGREEMENT' AND deduction_percentage = 5) OR
        (exit_type = 'FORCED' AND deduction_percentage >= 50 AND deduction_percentage <= 100)
    )
);
CREATE INDEX idx_deposit_exit_events_user ON deposit_exit_events (user_id, processed_at DESC);

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
            'MMF_TOPUP_OUT', 'MMF_WITHDRAWAL_IN',
            'SIDE_FUND_PAYOUT_OUT',
            'FINE_PAYMENT_IN',
            'DEPOSIT_CONTRIBUTION_IN', 'DEPOSIT_REFUND_OUT'
        ));
END $$;

-- payment_acknowledgements.source_type's CHECK is widened in place at
-- its original CREATE TABLE definition above (DEPOSIT_REFUND), not
-- here — existing table structure, not a new addition.

INSERT INTO permissions (code, module, description) VALUES
    ('DEPOSIT_VIEW',   'FINANCE', 'View every member''s deposit standing (Treasury oversight)'),
    ('DEPOSIT_MANAGE', 'FINANCE', 'Update the deposit target, record standalone deposits, manage excusals, and process exit refunds')
ON CONFLICT (code) DO NOTHING;

-- ============================================================
-- GROUP 30: PAYMENT CONFIRMATIONS (v1.39.0)
-- The mirror image of GROUP 26's payment_acknowledgements — that
-- table is always created the INSTANT a payment has ALREADY posted
-- (a post-hoc paper trail the recipient signs off on afterward).
-- payment_confirmations is the opposite order: Treasury posts an
-- entry FIRST, documenting that a specific active user was paid a
-- specific amount by Cash, Bank Transfer, or Mobile Money (MTN /
-- Airtel / Other) — a transaction ID (`external_reference`) is
-- required for Bank Transfer/Mobile Money, forbidden for Cash (there
-- isn't one). Nothing is posted to the ledger yet at this point. Only
-- once the RECIPIENT reviews it and confirms does the real
-- transaction get posted (DEBIT out of `account_id`) — confirmation
-- is what CREATES the transaction here, not a signoff on one that
-- already exists. If the recipient disputes it instead (a reason is
-- required), no transaction is ever created; Treasury cancels the
-- entry and reissues a corrected one — there is no "reopen" step
-- (unlike payment_acknowledgements) since nothing was ever posted to
-- undo.
--
-- Two source types today: GENERAL_PAYMENT (Treasury pays anyone,
-- ad hoc — source_id is NULL) and SERVICE_FEE_PAYMENT (replaces the
-- old instant-post flow in serviceFeesController.recordPayment —
-- source_id = service_fee_agreements.id, recipient/account/category
-- all derived from that agreement). A CONFIRMED SERVICE_FEE_PAYMENT
-- also inserts the usual service_fee_payments row at that point,
-- exactly as recordPayment used to do immediately — now deferred
-- until the fee recipient actually confirms they were paid.
-- ============================================================

CREATE TABLE payment_confirmations (
    id                     SERIAL PRIMARY KEY,
    reference_id           INTEGER       NOT NULL REFERENCES references_registry(id),
    source_type            VARCHAR(20)   NOT NULL
                           -- SERVICE_FEE_ADVANCE (v1.53.0) — an advance disbursement
                           -- against a service fee agreement, recovered from future
                           -- months rather than tied to any specific already-earned
                           -- period the way SERVICE_FEE_PAYMENT is.
                           CHECK (source_type IN ('GENERAL_PAYMENT', 'SERVICE_FEE_PAYMENT', 'SERVICE_FEE_ADVANCE')),
    source_id              INTEGER,
    account_id             INTEGER       NOT NULL REFERENCES accounts(id),
    category_id            INTEGER       NOT NULL REFERENCES categories(id),
    payer_id               INTEGER       NOT NULL REFERENCES users(id),
    recipient_id           INTEGER       NOT NULL REFERENCES users(id),
    amount                 NUMERIC(20,4) NOT NULL,
    currency_id            INTEGER       NOT NULL REFERENCES currencies(id),
    payment_method         VARCHAR(20)   NOT NULL
                           CHECK (payment_method IN ('CASH', 'BANK_TRANSFER', 'MOBILE_MONEY')),
    mobile_money_provider  VARCHAR(20)
                           CHECK (mobile_money_provider IN ('MTN', 'AIRTEL', 'OTHER')),
    external_reference     VARCHAR(100),
    purpose                TEXT          NOT NULL,
    entry_date             DATE          NOT NULL,
    status                 VARCHAR(20)   NOT NULL DEFAULT 'PENDING_CONFIRMATION'
                           CHECK (status IN ('PENDING_CONFIRMATION', 'CONFIRMED', 'DISPUTED', 'CANCELLED')),
    transaction_id         INTEGER REFERENCES transactions(id),
    confirmation_note      TEXT,
    confirmed_at           TIMESTAMPTZ,
    dispute_reason         TEXT,
    disputed_at            TIMESTAMPTZ,
    cancellation_reason    TEXT,
    cancelled_by           INTEGER REFERENCES users(id),
    cancelled_at           TIMESTAMPTZ,
    created_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT positive_payment_confirmation_amount CHECK (amount > 0),
    CONSTRAINT valid_mobile_money_provider CHECK (
        (payment_method = 'MOBILE_MONEY' AND mobile_money_provider IS NOT NULL) OR
        (payment_method != 'MOBILE_MONEY' AND mobile_money_provider IS NULL)
    ),
    CONSTRAINT valid_payment_confirmation_reference CHECK (
        (payment_method = 'CASH' AND external_reference IS NULL) OR
        (payment_method IN ('BANK_TRANSFER', 'MOBILE_MONEY')
            AND external_reference IS NOT NULL AND length(trim(external_reference)) > 0)
    )
);

CREATE INDEX idx_payment_confirmations_recipient ON payment_confirmations (recipient_id);
CREATE INDEX idx_payment_confirmations_status    ON payment_confirmations (status);
CREATE INDEX idx_payment_confirmations_source    ON payment_confirmations (source_type, source_id);

-- Forward-reference FK — service_fee_payment_confirmation_periods
-- (v1.52.0) is defined earlier in this file than payment_confirmations,
-- same pattern as share_certificates -> certificate_signing_rounds.
ALTER TABLE service_fee_payment_confirmation_periods
    ADD CONSTRAINT fk_service_fee_confirmation_periods_confirmation
    FOREIGN KEY (confirmation_id) REFERENCES payment_confirmations(id);

-- Forward-reference FKs — service_fee_payment_requests/service_fee_advances
-- (v1.53.0) are both defined earlier in this file than
-- payment_confirmations, same pattern as above.
ALTER TABLE service_fee_payment_requests
    ADD CONSTRAINT fk_service_fee_payment_requests_confirmation
    FOREIGN KEY (confirmation_id) REFERENCES payment_confirmations(id);
ALTER TABLE service_fee_advances
    ADD CONSTRAINT fk_service_fee_advances_confirmation
    FOREIGN KEY (confirmation_id) REFERENCES payment_confirmations(id);

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
            'MMF_TOPUP_OUT', 'MMF_WITHDRAWAL_IN',
            'SIDE_FUND_PAYOUT_OUT',
            'FINE_PAYMENT_IN',
            'DEPOSIT_CONTRIBUTION_IN', 'DEPOSIT_REFUND_OUT',
            'GENERAL_PAYMENT_OUT',
            'SERVICE_FEE_ADVANCE_OUT'
        ));
END $$;

-- No new permissions here — reuses PAYMENT_ACK_VIEW/PAYMENT_ACK_MANAGE
-- (GROUP 26 above), since this lives in the same Payment
-- Acknowledgements page/module as a second tab.

-- ============================================================
-- GROUP: CHART OF ACCOUNTS / GENERAL LEDGER (v1.55.0)
--
-- Foundation for the professional accounting reports suite (Trial
-- Balance, General Ledger, Balance Sheet, Income Statement, Cash
-- Flow Statement). The system's real ledger (`transactions`) is
-- single-leg — every row only records the ONE account it hit, plus a
-- fixed `inflow_type` describing its nature. It was never a formal
-- double-entry book. Rather than rebuild the whole ledger, these two
-- tables let `glService.js` DERIVE a proper double-entry view on
-- demand: every transaction becomes two lines — "Line A" is always
-- the transaction's own `accounts` row, treated as the Cash and Bank
-- asset; "Line B" is whichever `gl_accounts` row its `inflow_type`
-- maps to here, on the opposite side of the entry. This is exactly
-- how a real bank-account sub-ledger is bolted onto a formal chart of
-- accounts, and requires no changes to `transactions` itself.
--
-- `gl_inflow_type_mapping` is deliberately a normal, editable table
-- (not a hardcoded switch in application code) — the classification
-- of e.g. "is Side Fund income Revenue or a Liability" is a real
-- accounting-policy decision for the club to own, not something that
-- should require a code change to revisit. See the Admin-only Chart
-- of Accounts screen (Reports module).
-- ============================================================

CREATE TABLE gl_accounts (
    id                 SERIAL PRIMARY KEY,
    code               VARCHAR(10)   NOT NULL UNIQUE,   -- e.g. '1000', '4200' — standard Asset/Liability/Equity/Revenue/Expense numbering
    name               VARCHAR(150)  NOT NULL,
    account_type       VARCHAR(20)   NOT NULL
                       CHECK (account_type IN ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE')),
    normal_balance     VARCHAR(10)   NOT NULL
                       CHECK (normal_balance IN ('DEBIT', 'CREDIT')),  -- ASSET/EXPENSE = DEBIT, LIABILITY/EQUITY/REVENUE = CREDIT
    statement_section  VARCHAR(50)   NOT NULL,   -- groups rows within the Balance Sheet / Income Statement (e.g. 'CASH_AND_BANK', 'RECEIVABLES', 'REVENUE')
    cash_flow_category VARCHAR(20)   NOT NULL DEFAULT 'OPERATING'
                       CHECK (cash_flow_category IN ('OPERATING', 'INVESTING', 'FINANCING', 'EXCLUDED')),  -- EXCLUDED = cash itself / internal transfers, never a flow
    description        TEXT,
    display_order       INTEGER      NOT NULL DEFAULT 0,
    is_active          BOOLEAN       NOT NULL DEFAULT TRUE,
    created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Maps every transactions.inflow_type value to the gl_accounts row
-- representing the OTHER side of its double entry (its "Line B" —
-- Line A is always the transaction's own account, as Cash and Bank).
-- One override is applied in code, not here: an EXPENSE-tagged
-- transaction that also carries a non-null transactions.investment_id
-- is capital deployed into an investment (an Asset), not a real
-- operating expense — see glService.js's own header comment for why
-- this can't be expressed as a second, more specific inflow_type
-- without a wider schema change to the investments module.
CREATE TABLE gl_inflow_type_mapping (
    id             SERIAL PRIMARY KEY,
    inflow_type    VARCHAR(30)   NOT NULL UNIQUE,   -- mirrors transactions.inflow_type's own CHECK list
    gl_account_id  INTEGER       NOT NULL REFERENCES gl_accounts(id),
    notes          TEXT,
    updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_by     INTEGER REFERENCES users(id)
);

CREATE INDEX idx_gl_inflow_type_mapping_account ON gl_inflow_type_mapping (gl_account_id);

-- ------------------------------------------------------------
-- Seed the chart of accounts. Numbering follows the standard
-- 1000s Asset / 2000s Liability / 3000s Equity / 4000s Revenue /
-- 5000s Expense convention.
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- Seed the mapping — every value in transactions.inflow_type's own
-- CHECK constraint must appear here exactly once. If a future
-- version widens that CHECK constraint with a new value, this table
-- needs a matching new row (glService.js will otherwise treat an
-- unmapped inflow_type as an error rather than silently guessing).
-- ------------------------------------------------------------
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

-- No new permissions — viewing the new reports reuses FINANCE_VIEW_ALL
-- (the same permission every other report in this module already
-- requires); editing the chart-of-accounts mapping reuses SYSTEM_CONFIG
-- (the same permission Accounts/Currencies configuration already
-- requires), since reclassifying an inflow type is an accounting-
-- policy change, not a day-to-day finance action.

-- ============================================================
-- GROUP: SAVINGS-TO-CAPITAL CONVERSION (v1.58.0)
-- savings_capital_conversions itself is defined earlier, alongside
-- savings_handouts (GROUP 14), so it's created in the right order
-- relative to the tables it references. This trailing block only
-- widens transactions.inflow_type and extends the GL mapping —
-- appended here, after the GL feature (v1.55.0) is already defined
-- above, for the same forward-reference reason every other post-
-- v1.55.0 inflow_type widening in this file lives down here.
-- ============================================================
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
            'MMF_TOPUP_OUT', 'MMF_WITHDRAWAL_IN',
            'SIDE_FUND_PAYOUT_OUT',
            'FINE_PAYMENT_IN',
            'DEPOSIT_CONTRIBUTION_IN', 'DEPOSIT_REFUND_OUT',
            'GENERAL_PAYMENT_OUT',
            'SERVICE_FEE_ADVANCE_OUT',
            'SAVINGS_TO_CAPITAL_OUT'
        ));
END $$;

-- Same liability account (2100, Member Savings Payable) as
-- SAVINGS_HANDOUT_OUT — money leaving the savings pool always reduces
-- that liability, whether it's paid out in cash (a handout) or
-- reclassified into capital (this). The offsetting CREDIT leg posts
-- through the ordinary CONTRIBUTION inflow_type/mapping (3000, Member
-- Capital Contributions) via creditShareholderContribution — no new
-- mapping needed for that side.
INSERT INTO gl_inflow_type_mapping (inflow_type, gl_account_id, notes)
SELECT v.inflow_type, ga.id, v.notes
FROM (VALUES
    ('SAVINGS_TO_CAPITAL_OUT', '2100', 'Same account as SAVINGS_HANDOUT_OUT — money leaving the savings pool, here reclassified into capital (3000) rather than paid out in cash.')
) AS v(inflow_type, gl_code, notes)
JOIN gl_accounts ga ON ga.code = v.gl_code
ON CONFLICT (inflow_type) DO NOTHING;

-- ============================================================
-- GROUP: SAVINGS-TO-FINE-SETTLEMENT (v1.59.0)
-- savings_fine_settlements/savings_fine_settlement_items themselves
-- are defined earlier, alongside `fines` (GROUP: FINES), so they're
-- created in the right order relative to the tables they reference.
-- This trailing block only widens transactions.inflow_type and
-- extends the GL mapping, same reason every other post-v1.55.0
-- inflow_type widening in this file lives down here.
-- ============================================================
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
            'MMF_TOPUP_OUT', 'MMF_WITHDRAWAL_IN',
            'SIDE_FUND_PAYOUT_OUT',
            'FINE_PAYMENT_IN',
            'DEPOSIT_CONTRIBUTION_IN', 'DEPOSIT_REFUND_OUT',
            'GENERAL_PAYMENT_OUT',
            'SERVICE_FEE_ADVANCE_OUT',
            'SAVINGS_TO_CAPITAL_OUT',
            'SAVINGS_FINE_SETTLEMENT_OUT'
        ));
END $$;

-- Same liability account (2100, Member Savings Payable) as
-- SAVINGS_HANDOUT_OUT/SAVINGS_TO_CAPITAL_OUT — money leaving the
-- savings pool always reduces that liability, whatever it's used for.
-- The offsetting CREDIT leg posts through the ordinary FINE_PAYMENT_IN
-- inflow_type/mapping (4400, Fines Income) via finesService.clearFine
-- — no new mapping needed for that side.
INSERT INTO gl_inflow_type_mapping (inflow_type, gl_account_id, notes)
SELECT v.inflow_type, ga.id, v.notes
FROM (VALUES
    ('SAVINGS_FINE_SETTLEMENT_OUT', '2100', 'Same account as SAVINGS_HANDOUT_OUT/SAVINGS_TO_CAPITAL_OUT — money leaving the savings pool, here used to settle one or more fines (4400) instead of being paid out or converted to capital.')
) AS v(inflow_type, gl_code, notes)
JOIN gl_accounts ga ON ga.code = v.gl_code
ON CONFLICT (inflow_type) DO NOTHING;

-- ============================================================
-- GROUP: SAVINGS CURRENCY CONVERSION (v1.61.0)
-- savings_currency_conversions itself is defined earlier, alongside
-- savings_capital_conversions, so it's created in the right order
-- relative to the tables it references. This trailing block only
-- widens transactions.inflow_type and extends the GL mapping, same
-- reason every other post-v1.55.0 inflow_type widening in this file
-- lives down here.
-- ============================================================
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
            'MMF_TOPUP_OUT', 'MMF_WITHDRAWAL_IN',
            'SIDE_FUND_PAYOUT_OUT',
            'FINE_PAYMENT_IN',
            'DEPOSIT_CONTRIBUTION_IN', 'DEPOSIT_REFUND_OUT',
            'GENERAL_PAYMENT_OUT',
            'SERVICE_FEE_ADVANCE_OUT',
            'SAVINGS_TO_CAPITAL_OUT',
            'SAVINGS_FINE_SETTLEMENT_OUT',
            'SAVINGS_CURRENCY_CONV_OUT', 'SAVINGS_CURRENCY_CONV_IN'
        ));
END $$;

-- Same liability account (2100, Member Savings Payable) on BOTH legs —
-- this never leaves the savings pool at all, it just moves from one
-- currency's SAVINGS account to another's, so the pool's total
-- member-savings liability is unchanged in substance, only its
-- currency split shifts. Unlike every other SAVINGS_*_OUT above, this
-- is the one case where the offsetting leg is ALSO a savings-pool
-- entry (SAVINGS_CURRENCY_CONV_IN, not a capital/fine/cash
-- posting elsewhere), so both sides get their own mapping row here.
-- Note: both values are deliberately abbreviated ("CONV" not
-- "CONVERSION") to fit transactions.inflow_type's VARCHAR(30) limit —
-- 'SAVINGS_CURRENCY_CONVERSION_OUT' (31 chars) does not fit.
INSERT INTO gl_inflow_type_mapping (inflow_type, gl_account_id, notes)
SELECT v.inflow_type, ga.id, v.notes
FROM (VALUES
    ('SAVINGS_CURRENCY_CONV_OUT', '2100', 'Money leaving one currency''s Savings account as part of an internal currency conversion — same liability account as SAVINGS_HANDOUT_OUT, since it is still the member''s own savings, just changing currency.'),
    ('SAVINGS_CURRENCY_CONV_IN',  '2100', 'The matching credit into the destination currency''s Savings account for the same internal conversion — same liability account as SAVINGS_DEPOSIT_IN.')
) AS v(inflow_type, gl_code, notes)
JOIN gl_accounts ga ON ga.code = v.gl_code
ON CONFLICT (inflow_type) DO NOTHING;

-- New permission — same module/shape as SAVINGS_CAPITAL_CONVERT_CREATE.
-- Reviewing (confirm/reject) needs no permission at all, same as every
-- other "only the member whose money this is" review action in this
-- module — enforced by ownership check in the controller, not a grant.
INSERT INTO permissions (code, module, description) VALUES
    ('SAVINGS_CURRENCY_CONVERT_CREATE', 'FINANCE', 'Convert a member''s own savings from one currency they hold into another, pending the member''s own confirmation (v1.61.0)')
ON CONFLICT (code) DO NOTHING;

-- ============================================================
-- GROUP: FUNCTIONAL-CURRENCY CONSOLIDATION & FX REVALUATION (v1.66.0)
--
-- Identical to migration_v1.66.0.sql (see that file's header for the
-- full reasoning): company_settings functional/presentation currency
-- and financial-year start; fx_rate_on(); transactions.functional_*
-- columns filled by trg_transactions_functional_amount; gl_accounts
-- .is_monetary + 2400 Side Fund Payable / 4600 FX Gains / 5600 FX
-- Losses; the side fund reclassified as members' money (a
-- liability); and the fx_revaluation_runs/lines month-end record.
-- Appended here so a fresh install gets exactly what an upgraded
-- database gets.
-- ============================================================


-- ------------------------------------------------------------
-- 1. company_settings — functional / presentation currency and
--    the first month of the financial year.
-- ------------------------------------------------------------
ALTER TABLE company_settings
    ADD COLUMN IF NOT EXISTS functional_currency_id   INTEGER REFERENCES currencies(id),
    ADD COLUMN IF NOT EXISTS presentation_currency_id INTEGER REFERENCES currencies(id),
    ADD COLUMN IF NOT EXISTS fiscal_year_start_month  SMALLINT NOT NULL DEFAULT 7;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_settings_fy_start_month_check') THEN
        ALTER TABLE company_settings
            ADD CONSTRAINT company_settings_fy_start_month_check
            CHECK (fiscal_year_start_month BETWEEN 1 AND 12);
    END IF;
END $$;

UPDATE company_settings
SET    functional_currency_id = (SELECT id FROM currencies WHERE code = 'UGX' LIMIT 1)
WHERE  id = 1 AND functional_currency_id IS NULL;

UPDATE company_settings
SET    presentation_currency_id = (SELECT id FROM currencies WHERE code = 'EUR' LIMIT 1)
WHERE  id = 1 AND presentation_currency_id IS NULL;

-- ------------------------------------------------------------
-- 2. fx_rate_on — the database's single rate lookup.
--    Returns how many units of p_to one unit of p_from is worth on
--    p_date (e.g. EUR -> UGX = 4100), or NULL if no rate covers
--    that date in either direction.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fx_rate_on(p_from INTEGER, p_to INTEGER, p_date DATE)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_rate NUMERIC;
BEGIN
    IF p_from IS NULL OR p_to IS NULL OR p_date IS NULL THEN
        RETURN NULL;
    END IF;
    IF p_from = p_to THEN
        RETURN 1;
    END IF;

    SELECT rate INTO v_rate
    FROM   currency_exchange_rates
    WHERE  base_currency_id = p_from AND target_currency_id = p_to
    AND    effective_from <= p_date
    AND    (effective_to IS NULL OR effective_to > p_date)
    ORDER  BY effective_from DESC, id DESC
    LIMIT  1;
    IF v_rate IS NOT NULL THEN
        RETURN v_rate;
    END IF;

    SELECT 1 / rate INTO v_rate
    FROM   currency_exchange_rates
    WHERE  base_currency_id = p_to AND target_currency_id = p_from
    AND    effective_from <= p_date
    AND    (effective_to IS NULL OR effective_to > p_date)
    ORDER  BY effective_from DESC, id DESC
    LIMIT  1;
    RETURN v_rate;
END $$;

-- ------------------------------------------------------------
-- 3. transactions — the UGX (functional) value of every row.
-- ------------------------------------------------------------
ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS functional_amount      NUMERIC(20,4),
    ADD COLUMN IF NOT EXISTS functional_rate        NUMERIC(30,12),
    ADD COLUMN IF NOT EXISTS functional_rate_source VARCHAR(20),
    ADD COLUMN IF NOT EXISTS functional_rate_note   TEXT,
    ADD COLUMN IF NOT EXISTS functional_set_by      INTEGER REFERENCES users(id),
    ADD COLUMN IF NOT EXISTS functional_set_at      TIMESTAMPTZ;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_functional_rate_source_check') THEN
        ALTER TABLE transactions
            ADD CONSTRAINT transactions_functional_rate_source_check
            CHECK (functional_rate_source IS NULL OR functional_rate_source IN
                   ('SAME_CURRENCY', 'TRANSFER', 'REVERSAL', 'RATE_TABLE', 'MANUAL'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_functional_rate_positive') THEN
        ALTER TABLE transactions
            ADD CONSTRAINT transactions_functional_rate_positive
            CHECK (functional_rate IS NULL OR functional_rate > 0);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_transactions_functional_missing
    ON transactions (value_date)
    WHERE functional_amount IS NULL;

-- The trigger function. Runs BEFORE the row is written, so the
-- value is stored in the same statement that posts the money —
-- there is never a moment where a posted transaction exists
-- without its UGX value (unless no rate is available at all).
CREATE OR REPLACE FUNCTION set_transaction_functional_amount()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_func   INTEGER;
    v_rate   NUMERIC;
    v_source VARCHAR(20);
    v_value  NUMERIC;
    tr       RECORD;
BEGIN
    SELECT functional_currency_id INTO v_func FROM company_settings WHERE id = 1;
    IF v_func IS NULL THEN
        -- No functional currency configured yet — nothing to value against.
        NEW.functional_amount := NULL;
        NEW.functional_rate := NULL;
        NEW.functional_rate_source := NULL;
        RETURN NEW;
    END IF;

    -- A MANUAL rate set by an Admin is kept for as long as the
    -- transaction stays in the same currency — only the amount is
    -- re-multiplied, in case the amount itself was corrected.
    IF NEW.functional_rate_source = 'MANUAL'
       AND NEW.functional_rate IS NOT NULL
       AND (TG_OP = 'INSERT' OR NEW.currency_id = OLD.currency_id) THEN
        NEW.functional_amount := ROUND(NEW.amount * NEW.functional_rate, 4);
        RETURN NEW;
    END IF;

    v_rate := NULL;
    v_source := NULL;

    IF NEW.currency_id = v_func THEN
        v_rate := 1;
        v_source := 'SAME_CURRENCY';
    END IF;

    -- A reversal cancels its original at the ORIGINAL's rate.
    IF v_rate IS NULL AND NEW.reversal_of IS NOT NULL THEN
        SELECT functional_rate INTO v_rate
        FROM   transactions
        WHERE  id = NEW.reversal_of AND currency_id = NEW.currency_id;
        IF v_rate IS NOT NULL THEN
            v_source := 'REVERSAL';
        END IF;
    END IF;

    -- A transfer leg (or a bank charge posted with the transfer)
    -- uses the transfer's own actual rate. v_value = the UGX value
    -- of the whole transfer; each leg's rate is v_value divided by
    -- that leg's own amount, so both legs carry the same UGX value.
    IF v_rate IS NULL AND NEW.transfer_id IS NOT NULL THEN
        SELECT * INTO tr FROM transfers WHERE id = NEW.transfer_id;
        IF FOUND THEN
            IF tr.currency_received_id = v_func THEN
                v_value := tr.amount_received;
            ELSIF tr.currency_sent_id = v_func THEN
                v_value := tr.amount_sent;
            ELSE
                v_value := tr.amount_sent * fx_rate_on(tr.currency_sent_id, v_func, tr.value_date);
            END IF;

            IF v_value IS NOT NULL THEN
                IF NEW.currency_id = tr.currency_sent_id THEN
                    v_rate := v_value / tr.amount_sent;
                    v_source := 'TRANSFER';
                ELSIF NEW.currency_id = tr.currency_received_id THEN
                    v_rate := v_value / tr.amount_received;
                    v_source := 'TRANSFER';
                END IF;
            END IF;
        END IF;
    END IF;

    -- Everything else: the rate table, on the transaction's own date.
    IF v_rate IS NULL THEN
        v_rate := fx_rate_on(NEW.currency_id, v_func, NEW.value_date);
        IF v_rate IS NOT NULL THEN
            v_source := 'RATE_TABLE';
        END IF;
    END IF;

    NEW.functional_rate := v_rate;
    NEW.functional_rate_source := v_source;
    NEW.functional_amount := CASE WHEN v_rate IS NULL THEN NULL
                                  ELSE ROUND(NEW.amount * v_rate, 4) END;
    IF v_source IS DISTINCT FROM 'MANUAL' THEN
        NEW.functional_rate_note := NULL;
        NEW.functional_set_by := NULL;
        NEW.functional_set_at := NULL;
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_transactions_functional_amount ON transactions;
CREATE TRIGGER trg_transactions_functional_amount
    BEFORE INSERT OR UPDATE OF amount, currency_id, value_date, transfer_id, reversal_of,
                               functional_rate, functional_rate_source
    ON transactions
    FOR EACH ROW
    EXECUTE FUNCTION set_transaction_functional_amount();

-- ------------------------------------------------------------
-- 4. Value every EXISTING transaction with the same rules.
--    "SET functional_rate_source = functional_rate_source" changes
--    nothing by itself — it only wakes the trigger up for each row.
--    Originals first, reversals second (a reversal needs its
--    original's rate to exist already).
-- ------------------------------------------------------------
UPDATE transactions
SET    functional_rate_source = functional_rate_source
WHERE  reversal_of IS NULL;

UPDATE transactions
SET    functional_rate_source = functional_rate_source
WHERE  reversal_of IS NOT NULL;

-- ------------------------------------------------------------
-- 5. Chart of accounts — monetary flag + three new accounts.
-- ------------------------------------------------------------
ALTER TABLE gl_accounts
    ADD COLUMN IF NOT EXISTS is_monetary BOOLEAN NOT NULL DEFAULT FALSE;

INSERT INTO gl_accounts (code, name, account_type, normal_balance, statement_section, cash_flow_category, description, display_order) VALUES
    ('2400', 'Side Fund Payable (Members)', 'LIABILITY', 'CREDIT', 'LIABILITIES', 'FINANCING',
     'Members'' side fund money the company holds for them. Dues and top-ups increase it; payouts and side fund expenses reduce it. It is the members'' money, not company income (confirmed policy, v1.66.0).', 440),
    ('4600', 'Foreign Exchange Gains', 'REVENUE', 'CREDIT', 'REVENUE', 'OPERATING',
     'Gains from revaluing foreign-currency balances (cash, savings, loans, deposits) to the month-end closing rate. Non-cash.', 660),
    ('5600', 'Foreign Exchange Losses', 'EXPENSE', 'DEBIT', 'EXPENSES', 'OPERATING',
     'Losses from revaluing foreign-currency balances to the month-end closing rate. Non-cash.', 760)
ON CONFLICT (code) DO NOTHING;

-- 1050 (Inter-Account Transfers) is deliberately NOT monetary: it is a
-- clearing account whose two legs always carry the same UGX value
-- (the transfer's own rate), so it nets to zero in UGX by itself.
-- Revaluing one leg of it would break that.
UPDATE gl_accounts
SET    is_monetary = TRUE
WHERE  code IN ('1000', '1100', '1200', '1300', '2000', '2100', '2200', '2400');

-- ------------------------------------------------------------
-- 6. Side Fund = members' money (a liability), not income/expense.
-- ------------------------------------------------------------
UPDATE gl_inflow_type_mapping m
SET    gl_account_id = ga.id,
       notes = CASE m.inflow_type
                   WHEN 'SIDE_FUND_PAYOUT_OUT' THEN 'v1.66.0: members'' money paid back out of the side fund — reduces Side Fund Payable (2400). Was 5200 Side Fund Payouts.'
                   ELSE 'v1.66.0: members'' money received into the side fund — increases Side Fund Payable (2400). Was 4300 Side Fund Dues Income.'
               END,
       updated_at = NOW()
FROM   gl_accounts ga
WHERE  ga.code = '2400'
AND    m.inflow_type IN ('SIDE_FUND_CONTRIBUTION_IN', 'SIDE_FUND_DIRECT_IN', 'SIDE_FUND_PAYOUT_OUT')
AND    m.gl_account_id <> ga.id;

UPDATE gl_accounts
SET    is_active = FALSE,
       description = description || ' — Inactive since v1.66.0: the side fund is members'' money, now booked to 2400 Side Fund Payable.'
WHERE  code IN ('4300', '5200')
AND    is_active = TRUE;

-- ------------------------------------------------------------
-- 7. Month-end FX revaluation record.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fx_revaluation_runs (
    id                      SERIAL PRIMARY KEY,
    period_end              DATE          NOT NULL UNIQUE,   -- always the last day of a month
    functional_currency_id  INTEGER       NOT NULL REFERENCES currencies(id),
    rates_used              JSONB         NOT NULL DEFAULT '[]'::jsonb,  -- [{currencyId, currencyCode, rate}] closing rates applied
    total_gain              NUMERIC(20,4) NOT NULL DEFAULT 0,
    total_loss              NUMERIC(20,4) NOT NULL DEFAULT 0,
    notes                   TEXT,
    run_by                  INTEGER       NOT NULL REFERENCES users(id),
    run_at                  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- One row per revalued balance. account_id is the bank/cash account
-- the balance is attributed to (the same attribution every GL line
-- carries); NULL for company-level non-cash balances.
CREATE TABLE IF NOT EXISTS fx_revaluation_lines (
    id                SERIAL PRIMARY KEY,
    run_id            INTEGER       NOT NULL REFERENCES fx_revaluation_runs(id) ON DELETE CASCADE,
    gl_account_id     INTEGER       NOT NULL REFERENCES gl_accounts(id),
    account_id        INTEGER REFERENCES accounts(id),
    currency_id       INTEGER       NOT NULL REFERENCES currencies(id),
    foreign_balance   NUMERIC(20,4) NOT NULL,   -- balance in the foreign currency (debit positive)
    closing_rate      NUMERIC(30,12) NOT NULL,
    carrying_before   NUMERIC(20,4) NOT NULL,   -- UGX value on the books before this run
    revalued_balance  NUMERIC(20,4) NOT NULL,   -- foreign_balance x closing_rate
    adjustment        NUMERIC(20,4) NOT NULL    -- revalued_balance - carrying_before (+ = debit the balance, gain on an asset / loss on a liability)
);

CREATE INDEX IF NOT EXISTS idx_fx_revaluation_lines_run ON fx_revaluation_lines (run_id);

-- ============================================================
-- GROUP: PERSONAL DOCUMENTS — documents.owner_user_id (v1.67.0)
--
-- Identical to migration_v1.67.0.sql (see that file's header): a
-- document with an owner (a member's own Share Purchase Receipt) is
-- visible only to that member (GET /documents/mine) and to Treasury
-- (GET /documents/share-receipts), never in "All Documents".
-- ============================================================

ALTER TABLE documents
    ADD COLUMN IF NOT EXISTS owner_user_id INTEGER REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_documents_owner_user
    ON documents (owner_user_id)
    WHERE owner_user_id IS NOT NULL;

UPDATE documents d
SET    owner_user_id = sc.user_id
FROM   shareholder_contributions sc
WHERE  d.related_record_type = 'shareholder_contributions'
AND    d.related_record_id = sc.id
AND    d.template_data ->> 'receipt_kind' = 'SHARE_PURCHASE'
AND    d.owner_user_id IS DISTINCT FROM sc.user_id;

-- ============================================================
-- GROUP: SHARE CAPITAL — nominal value, share premium, whole-share
-- allotments, members' share credit, refunds, returns of allotment,
-- dual-approved share value changes (v1.69.0)
--
-- Identical to migration_v1.69.0.sql (see that file's header for the
-- full explanation). On a new installation there are no contributions,
-- so the opening conversion is marked done automatically (section 12).
-- ============================================================

-- ------------------------------------------------------------
-- 1. NOMINAL VALUE + REGISTERED SHARES (history)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS share_nominal_history (
    id                 SERIAL PRIMARY KEY,
    nominal_value      NUMERIC(20,4) NOT NULL CHECK (nominal_value > 0),
    currency_id        INTEGER       NOT NULL REFERENCES currencies(id),
    -- Number of shares registered with URSB (authorised). NULL = not
    -- recorded yet (no limit is tracked until it is set).
    registered_shares  INTEGER       CHECK (registered_shares IS NULL OR registered_shares > 0),
    effective_from     DATE          NOT NULL,
    effective_to       DATE,
    change_request_id  INTEGER,
    set_by             INTEGER REFERENCES users(id),
    notes              TEXT,
    created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS share_nominal_history_one_current
    ON share_nominal_history ((TRUE)) WHERE effective_to IS NULL;

-- ------------------------------------------------------------
-- 2. SHARE ALLOTMENTS (whole shares)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS share_allotments (
    id                        SERIAL PRIMARY KEY,
    reference_id              INTEGER       REFERENCES references_registry(id),
    user_id                   INTEGER       NOT NULL REFERENCES users(id),
    contribution_id           INTEGER       REFERENCES shareholder_contributions(id),
    change_request_id         INTEGER,
    source                    VARCHAR(30)   NOT NULL
                              CHECK (source IN ('CONTRIBUTION','OPENING_CONVERSION','SPLIT','CONSOLIDATION')),
    allotment_date            DATE          NOT NULL,
    -- Whole shares. Negative only for a CONSOLIDATION (shares taken
    -- away when several old shares become one new share).
    shares                    INTEGER       NOT NULL CHECK (shares <> 0),
    nominal_value             NUMERIC(20,4) NOT NULL,
    issue_price               NUMERIC(20,4) NOT NULL,
    currency_id               INTEGER       NOT NULL REFERENCES currencies(id),
    consideration_amount      NUMERIC(20,2) NOT NULL DEFAULT 0,  -- shares x issue price (what the credit paid)
    share_capital_amount      NUMERIC(20,2) NOT NULL DEFAULT 0,  -- shares x nominal value
    share_premium_amount      NUMERIC(20,2) NOT NULL DEFAULT 0,  -- shares x (issue price - nominal value)
    -- Registered-capital tracking, snapshotted at allotment time.
    registered_shares         INTEGER,
    total_shares_after        INTEGER,
    shares_beyond_registered  INTEGER       NOT NULL DEFAULT 0,
    -- Return of allotment (Companies Act 2012 s.61 — within 60 days).
    return_due_date           DATE,
    return_filed_at           DATE,
    return_reference          VARCHAR(100),
    return_filed_by           INTEGER REFERENCES users(id),
    status                    VARCHAR(20)   NOT NULL DEFAULT 'ACTIVE'
                              CHECK (status IN ('ACTIVE','REVERSED')),
    reversed_at               DATE,
    reversed_by               INTEGER REFERENCES users(id),
    reversal_reason           TEXT,
    notes                     TEXT,
    created_by                INTEGER REFERENCES users(id),
    created_at                TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT share_allotment_sign CHECK (shares > 0 OR source = 'CONSOLIDATION')
);
CREATE INDEX IF NOT EXISTS idx_share_allotments_user ON share_allotments (user_id, allotment_date);
CREATE INDEX IF NOT EXISTS idx_share_allotments_contribution ON share_allotments (contribution_id);
CREATE INDEX IF NOT EXISTS idx_share_allotments_date ON share_allotments (allotment_date);

-- ------------------------------------------------------------
-- 3. MEMBERS' SHARE CREDIT (signed ledger, share currency)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS member_capital_credit_entries (
    id                 SERIAL PRIMARY KEY,
    user_id            INTEGER       NOT NULL REFERENCES users(id),
    entry_date         DATE          NOT NULL,
    entry_type         VARCHAR(30)   NOT NULL
                       CHECK (entry_type IN ('CONTRIBUTION','ALLOTMENT','REFUND','CONSOLIDATION_LEFTOVER',
                                             'CONTRIBUTION_REVERSAL','ALLOTMENT_REVERSAL')),
    amount             NUMERIC(20,2) NOT NULL,   -- + adds to credit, - uses it
    currency_id        INTEGER       NOT NULL REFERENCES currencies(id),
    contribution_id    INTEGER       REFERENCES shareholder_contributions(id),
    allotment_id       INTEGER       REFERENCES share_allotments(id),
    refund_id          INTEGER,
    change_request_id  INTEGER,
    -- How a contribution's value in the share currency was arrived at.
    original_amount    NUMERIC(20,4),
    original_currency_id INTEGER     REFERENCES currencies(id),
    rate_used          NUMERIC(30,12),
    notes              TEXT,
    created_by         INTEGER REFERENCES users(id),
    created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_member_credit_user ON member_capital_credit_entries (user_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_member_credit_contribution ON member_capital_credit_entries (contribution_id);

-- ------------------------------------------------------------
-- 4. SHARE CREDIT REFUNDS (maker-checker)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS capital_credit_refunds (
    id                  SERIAL PRIMARY KEY,
    reference_id        INTEGER       REFERENCES references_registry(id),
    user_id             INTEGER       NOT NULL REFERENCES users(id),
    credit_amount       NUMERIC(20,2) NOT NULL CHECK (credit_amount > 0),  -- in the share currency
    credit_currency_id  INTEGER       NOT NULL REFERENCES currencies(id),
    account_id          INTEGER       NOT NULL REFERENCES accounts(id),   -- paid from
    payout_amount       NUMERIC(20,2),                                    -- in the account's currency
    payout_currency_id  INTEGER       REFERENCES currencies(id),
    rate_used           NUMERIC(30,12),
    reason              TEXT          NOT NULL,
    status              VARCHAR(20)   NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING','PAID','REJECTED','CANCELLED')),
    requested_by        INTEGER       NOT NULL REFERENCES users(id),
    requested_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    decided_by          INTEGER REFERENCES users(id),
    decided_at          TIMESTAMPTZ,
    decision_note       TEXT,
    payout_date         DATE,
    transaction_id      INTEGER REFERENCES transactions(id),
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_capital_credit_refunds_user ON capital_credit_refunds (user_id);

-- ------------------------------------------------------------
-- 5. SHARE CAPITAL CHANGE REQUESTS (two different approvers)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS share_capital_change_requests (
    id                      SERIAL PRIMARY KEY,
    reference_id            INTEGER       REFERENCES references_registry(id),
    change_type             VARCHAR(30)   NOT NULL
                            CHECK (change_type IN ('ISSUE_PRICE','NOMINAL_VALUE','REGISTERED_SHARES')),
    currency_id             INTEGER       NOT NULL REFERENCES currencies(id),
    current_value           NUMERIC(20,4),
    proposed_value          NUMERIC(20,4) NOT NULL CHECK (proposed_value > 0),
    effective_date          DATE          NOT NULL,
    resolution_document_id  INTEGER       NOT NULL REFERENCES documents(id),
    reason                  TEXT          NOT NULL,
    status                  VARCHAR(20)   NOT NULL DEFAULT 'PENDING'
                            CHECK (status IN ('PENDING','APPLIED','REJECTED','CANCELLED')),
    requested_by            INTEGER       NOT NULL REFERENCES users(id),
    requested_role          VARCHAR(30)   NOT NULL,
    requested_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    approved_by             INTEGER REFERENCES users(id),
    approved_role           VARCHAR(30),
    approved_at             TIMESTAMPTZ,
    rejected_by             INTEGER REFERENCES users(id),
    rejected_at             TIMESTAMPTZ,
    decision_note           TEXT,
    applied_at              TIMESTAMPTZ,
    result_summary          JSONB,
    notice_document_id      INTEGER REFERENCES documents(id),
    created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT share_change_two_people CHECK (approved_by IS NULL OR approved_by <> requested_by)
);
CREATE UNIQUE INDEX IF NOT EXISTS share_capital_change_one_pending
    ON share_capital_change_requests (change_type) WHERE status = 'PENDING';

-- ------------------------------------------------------------
-- 6. ONE-ROW SETTINGS (opening conversion status, filing days)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS share_capital_settings (
    id                      INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    allotment_return_days   INTEGER      NOT NULL DEFAULT 60,
    opening_converted_at    TIMESTAMPTZ,
    opening_converted_by    INTEGER REFERENCES users(id),
    opening_summary         JSONB,
    updated_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
INSERT INTO share_capital_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------
-- 7. NOMINAL VALUE + REGISTERED SHARES ARE SET IN THE SYSTEM
-- Nothing is seeded here. A Director or the Treasurer enters the
-- nominal value per share, the number of registered shares and their
-- history on the Share Capital page (Overview > Registered values).
-- They can be edited freely until the first shares are allotted; after
-- that, every change goes through Share Capital > Changes (board
-- resolution + two approvers).
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- 8. documents.audience
-- ------------------------------------------------------------
ALTER TABLE documents ADD COLUMN IF NOT EXISTS audience VARCHAR(30);
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_audience_check') THEN
        ALTER TABLE documents ADD CONSTRAINT documents_audience_check
            CHECK (audience IS NULL OR audience IN ('ALL_SHAREHOLDERS'));
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_documents_audience ON documents (audience) WHERE audience IS NOT NULL;

-- ------------------------------------------------------------
-- 9. Late foreign keys (tables above reference each other)
-- ------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'share_nominal_history_request_fk') THEN
        ALTER TABLE share_nominal_history ADD CONSTRAINT share_nominal_history_request_fk
            FOREIGN KEY (change_request_id) REFERENCES share_capital_change_requests(id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'share_allotments_request_fk') THEN
        ALTER TABLE share_allotments ADD CONSTRAINT share_allotments_request_fk
            FOREIGN KEY (change_request_id) REFERENCES share_capital_change_requests(id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'member_credit_refund_fk') THEN
        ALTER TABLE member_capital_credit_entries ADD CONSTRAINT member_credit_refund_fk
            FOREIGN KEY (refund_id) REFERENCES capital_credit_refunds(id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'member_credit_request_fk') THEN
        ALTER TABLE member_capital_credit_entries ADD CONSTRAINT member_credit_request_fk
            FOREIGN KEY (change_request_id) REFERENCES share_capital_change_requests(id);
    END IF;
END $$;

-- ------------------------------------------------------------
-- 10. transactions.inflow_type gains CAPITAL_CREDIT_REFUND_OUT.
-- Rebuilt from the constraint's CURRENT list (whatever earlier
-- versions added), so nothing already allowed is dropped.
-- ------------------------------------------------------------
DO $$
DECLARE
    con_name text;
    con_def  text;
    vals     text[];
BEGIN
    SELECT conname, pg_get_constraintdef(oid) INTO con_name, con_def
    FROM   pg_constraint
    WHERE  conrelid = 'transactions'::regclass
    AND    contype = 'c'
    AND    pg_get_constraintdef(oid) LIKE '%inflow_type%'
    LIMIT  1;

    IF con_def IS NOT NULL AND con_def LIKE '%CAPITAL_CREDIT_REFUND_OUT%' THEN
        RETURN;
    END IF;

    SELECT array_agg(DISTINCT m[1]) INTO vals
    FROM   regexp_matches(COALESCE(con_def, ''), '''([A-Z_]+)''', 'g') AS m;
    vals := COALESCE(vals, ARRAY[]::text[]) || ARRAY['CAPITAL_CREDIT_REFUND_OUT'];

    IF con_name IS NOT NULL THEN
        EXECUTE 'ALTER TABLE transactions DROP CONSTRAINT ' || quote_ident(con_name);
    END IF;
    EXECUTE 'ALTER TABLE transactions ADD CONSTRAINT transactions_inflow_type_check CHECK (inflow_type IN ('
        || (SELECT string_agg(quote_literal(v), ', ' ORDER BY v) FROM unnest(vals) AS v)
        || '))';
END $$;

-- ------------------------------------------------------------
-- 11. CHART OF ACCOUNTS
-- ------------------------------------------------------------
UPDATE gl_accounts
SET    name = 'Share Capital (Ordinary)',
       description = 'Nominal (par) value of the ordinary shares allotted: whole shares x nominal value per share. Moved here from 3020 when shares are allotted.'
WHERE  code = '3000';

INSERT INTO gl_accounts (code, name, account_type, normal_balance, statement_section, cash_flow_category, description, display_order, is_monetary)
VALUES
    ('3010', 'Share Premium', 'EQUITY', 'CREDIT', 'EQUITY', 'FINANCING',
     'Amount paid for allotted shares above their nominal value: whole shares x (issue price - nominal value). May only be used as the Companies Act 2012 s.67 allows (e.g. bonus shares).', 505, FALSE),
    ('3020', 'Capital Pending Allotment (Members'' Share Credit)', 'EQUITY', 'CREDIT', 'EQUITY', 'FINANCING',
     'Capital paid in by members that has not yet bought a whole share. Every contribution lands here; the value of shares allotted moves out to 3000/3010. Its balance equals the total of all members'' share credit. Reduced by approved credit refunds.', 507, FALSE)
ON CONFLICT (code) DO NOTHING;

UPDATE gl_inflow_type_mapping m
SET    gl_account_id = ga.id,
       notes = 'v1.69.0 — capital paid in lands in Capital Pending Allotment; shares allotted move it to Share Capital (3000) / Share Premium (3010).',
       updated_at = NOW()
FROM   gl_accounts ga
WHERE  ga.code = '3020' AND m.inflow_type = 'CONTRIBUTION';

INSERT INTO gl_inflow_type_mapping (inflow_type, gl_account_id, notes)
SELECT 'CAPITAL_CREDIT_REFUND_OUT', ga.id, 'v1.69.0 — a member''s unused share credit paid back to them.'
FROM   gl_accounts ga WHERE ga.code = '3020'
ON CONFLICT (inflow_type) DO NOTHING;

-- ------------------------------------------------------------
-- 12. A database with no approved contributions has nothing to
-- convert — mark the opening conversion as done so contributions can
-- be recorded straight away (a brand-new installation).
-- ------------------------------------------------------------
UPDATE share_capital_settings
SET    opening_converted_at = NOW(),
       opening_summary = '{"contributions":0,"members":[],"totalShares":0,"totalCredit":0,"allottedBelowNominal":[],"note":"Nothing to convert — no approved contributions when v1.69.0 was installed."}'::jsonb,
       updated_at = NOW()
WHERE  id = 1
AND    opening_converted_at IS NULL
AND    NOT EXISTS (SELECT 1 FROM shareholder_contributions WHERE status = 'APPROVED')
AND    NOT EXISTS (SELECT 1 FROM share_allotments);

-- ============================================================
-- GROUP: TAX — withholding tax (both directions), corporate income
-- tax years, payments to URA, reminders, expense tax treatment,
-- treasury bills, and re-classification of investment tax legs and
-- bond principal (v1.70.0)
-- Identical to migration_v1.70.0.sql (see that file's header for the
-- full explanation); kept here so a fresh install matches an upgraded
-- one.
-- ============================================================
-- ------------------------------------------------------------
-- 1. COMPANY REGISTRATION + WHT AGENT STATUS
-- ------------------------------------------------------------
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS tin                      VARCHAR(20);
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS registration_number      VARCHAR(50);
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS incorporation_date       DATE;
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS tax_office               VARCHAR(100);
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS wht_agent_designated     BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS wht_agent_effective_date DATE;
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS tax_settings_updated_at  TIMESTAMPTZ;
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS tax_settings_updated_by  INTEGER REFERENCES users(id);

CREATE TABLE IF NOT EXISTS wht_agent_status_history (
    id                 SERIAL PRIMARY KEY,
    designated         BOOLEAN      NOT NULL,
    effective_date     DATE         NOT NULL,
    notes              TEXT,
    notice_document_id INTEGER      REFERENCES documents(id),
    changed_by         INTEGER      NOT NULL REFERENCES users(id),
    changed_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------------
-- 2. MEMBERS' TAX DETAILS
-- ------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS tin           VARCHAR(20);
ALTER TABLE users ADD COLUMN IF NOT EXISTS tax_residency VARCHAR(20) NOT NULL DEFAULT 'RESIDENT';
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_tax_residency_check') THEN
        ALTER TABLE users ADD CONSTRAINT users_tax_residency_check
            CHECK (tax_residency IN ('RESIDENT', 'NON_RESIDENT'));
    END IF;
END $$;

-- ------------------------------------------------------------
-- 3. TAX RATES (dated)
-- rate is a PERCENTAGE (30 = 30%). treatment only matters for tax
-- deducted FROM the company: FINAL (that is the end of it — the income
-- is left out of the corporate tax computation) or CREDITABLE (it is a
-- prepayment, set off against the corporate tax of the year).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tax_rates (
    id               SERIAL PRIMARY KEY,
    code             VARCHAR(40)   NOT NULL,
    name             VARCHAR(200)  NOT NULL,
    rate             NUMERIC(7,4)  NOT NULL CHECK (rate >= 0 AND rate <= 100),
    treatment        VARCHAR(15)   CHECK (treatment IS NULL OR treatment IN ('FINAL', 'CREDITABLE')),
    threshold_amount NUMERIC(20,4),                 -- in the functional currency (UGX)
    legal_reference  TEXT,
    notes            TEXT,
    effective_from   DATE          NOT NULL,
    effective_to     DATE,
    created_by       INTEGER       REFERENCES users(id),
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT tax_rates_code_from_unique UNIQUE (code, effective_from)
);
CREATE INDEX IF NOT EXISTS idx_tax_rates_code ON tax_rates (code, effective_from);

INSERT INTO tax_rates (code, name, rate, treatment, threshold_amount, legal_reference, notes, effective_from)
VALUES
 ('CIT_RATE', 'Corporate income tax rate', 30, NULL, NULL,
  'Income Tax Act Cap. 338, Second Schedule', 'Applied to the chargeable income of the year.', '2000-01-01'),
 ('WHT_GOV_SECURITIES_SHORT', 'Tax on interest from government securities (term under 10 years) — treasury bills and bonds', 20, 'FINAL', NULL,
  'Income Tax Act s.117 (as amended)', 'Deducted by Bank of Uganda / the issuer. Final tax.', '2000-01-01'),
 ('WHT_GOV_SECURITIES_LONG', 'Tax on interest from government securities (term 10 years or more)', 10, 'FINAL', NULL,
  'Income Tax Act s.117 (as amended)', 'Deducted by Bank of Uganda / the issuer. Final tax.', '2000-01-01'),
 ('WHT_INTEREST_RECEIVED', 'Tax deducted from interest received (banks, other payers)', 15, 'CREDITABLE', NULL,
  'Income Tax Act s.117', 'Creditable against the company''s corporate tax.', '2000-01-01'),
 ('WHT_DIVIDEND_RECEIVED', 'Tax deducted from dividends received', 15, 'CREDITABLE', NULL,
  'Income Tax Act s.118', 'Verify: a holding of 25% or more in a resident company may be exempt.', '2000-01-01'),
 ('WHT_DIVIDEND_PAID_RESIDENT', 'Withholding tax on dividends paid to resident shareholders', 15, NULL, NULL,
  'Income Tax Act s.118', 'Deducted by the company from each shareholder''s dividend.', '2000-01-01'),
 ('WHT_DIVIDEND_PAID_NON_RESIDENT', 'Withholding tax on dividends paid to non-resident shareholders', 15, NULL, NULL,
  'Income Tax Act s.83', 'Check any double tax agreement with the shareholder''s country.', '2000-01-01'),
 ('WHT_INTEREST_PAID_RESIDENT', 'Withholding tax on interest paid to residents (e.g. members'' savings interest)', 15, NULL, NULL,
  'Income Tax Act s.117', 'Deducted from the interest part of a savings handout.', '2000-01-01'),
 ('WHT_INTEREST_PAID_NON_RESIDENT', 'Withholding tax on interest paid to non-residents (e.g. a foreign lender)', 15, NULL, NULL,
  'Income Tax Act s.83', 'Check any double tax agreement with the lender''s country.', '2000-01-01'),
 ('WHT_AGENT_PAYMENTS', 'Withholding by designated agents on payments for goods and services (above the threshold)', 6, NULL, 1000000,
  'Income Tax Act s.119', 'Only real once URA designates the company; until then recorded as shadow.', '2000-01-01'),
 ('WHT_NON_RESIDENT_SERVICES', 'Withholding tax on fees paid to non-residents', 15, NULL, NULL,
  'Income Tax Act s.85', NULL, '2000-01-01'),
 ('LATE_PAYMENT_INTEREST', 'Interest on tax paid late (per month)', 2, NULL, NULL,
  'Tax Procedures Code Act s.43', 'Per month, simple interest on the unpaid tax.', '2000-01-01')
ON CONFLICT (code, effective_from) DO NOTHING;

-- ------------------------------------------------------------
-- 4. TAX DEDUCTED FROM THE COMPANY (at source)
-- cash_leg = TRUE: the tax has its own transaction (tax_transaction_id)
--   that points at 5700 / 1500 via transactions.gl_override_account_code.
-- cash_leg = FALSE: the tax was paid inside another amount (e.g. a
--   treasury bill whose tax was added to the purchase price) — the
--   ledger moves it out of contra_gl_code into 5700 / 1500 (glService).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tax_at_source (
    id                        SERIAL PRIMARY KEY,
    reference_id              INTEGER       REFERENCES references_registry(id),
    source_type               VARCHAR(30)   NOT NULL
                              CHECK (source_type IN ('BOND_COUPON', 'TREASURY_BILL', 'INVESTMENT_RETURN',
                                                     'INVESTMENT_TAX_ENTRY', 'BANK_INTEREST', 'MMF',
                                                     'DIVIDEND_RECEIVED', 'OTHER_INCOME', 'OTHER')),
    payer_name                VARCHAR(200),
    payer_tin                 VARCHAR(20),
    investment_id             INTEGER       REFERENCES investments(id),
    bond_coupon_id            INTEGER       REFERENCES bond_coupons(id),
    income_transaction_id     INTEGER       REFERENCES transactions(id),
    tax_transaction_id        INTEGER       REFERENCES transactions(id),
    cash_leg                  BOOLEAN       NOT NULL DEFAULT TRUE,
    contra_gl_code            VARCHAR(10),
    tax_rate_code             VARCHAR(40),
    rate                      NUMERIC(7,4),
    treatment                 VARCHAR(15)   NOT NULL CHECK (treatment IN ('FINAL', 'CREDITABLE')),
    gross_amount              NUMERIC(20,4) NOT NULL CHECK (gross_amount >= 0),
    tax_amount                NUMERIC(20,4) NOT NULL CHECK (tax_amount > 0),
    net_amount                NUMERIC(20,4) NOT NULL,
    currency_id               INTEGER       NOT NULL REFERENCES currencies(id),
    deduction_date            DATE          NOT NULL,
    functional_rate           NUMERIC(20,8),
    gross_functional          NUMERIC(20,2),
    tax_functional            NUMERIC(20,2),
    certificate_number        VARCHAR(60),
    certificate_received_at   DATE,
    certificate_document_id   INTEGER       REFERENCES documents(id),
    credit_claimed_tax_year_id INTEGER,
    status                    VARCHAR(15)   NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVERSED')),
    reversed_at               DATE,
    is_backfilled             BOOLEAN       NOT NULL DEFAULT FALSE,
    notes                     TEXT,
    created_by                INTEGER       REFERENCES users(id),
    created_at                TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT tax_at_source_noncash_contra CHECK (cash_leg OR contra_gl_code IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_tax_at_source_date ON tax_at_source (deduction_date);
CREATE UNIQUE INDEX IF NOT EXISTS tax_at_source_one_per_tax_tx
    ON tax_at_source (tax_transaction_id) WHERE tax_transaction_id IS NOT NULL;

-- ------------------------------------------------------------
-- 5. TAX THE COMPANY WITHHOLDS FROM OTHERS
-- tax_functional is what is owed to URA, in UGX, fixed at the rate on
-- the withholding date. debit_gl_code is where the GROSS payment was
-- charged — glService adds Dr <debit_gl_code> / Cr 2500 for the tax
-- (the cash transaction itself only carries the NET amount paid).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wht_remittances (
    id                   SERIAL PRIMARY KEY,
    reference_id         INTEGER       REFERENCES references_registry(id),
    period_month         DATE          NOT NULL,     -- first day of the month the tax was withheld in
    due_date             DATE          NOT NULL,     -- the 15th of the following month
    total_tax_functional NUMERIC(20,2) NOT NULL CHECK (total_tax_functional > 0),
    account_id           INTEGER       NOT NULL REFERENCES accounts(id),
    transaction_id       INTEGER       REFERENCES transactions(id),
    prn                  VARCHAR(40),
    return_reference     VARCHAR(60),
    paid_date            DATE          NOT NULL,
    status               VARCHAR(15)   NOT NULL DEFAULT 'PAID' CHECK (status IN ('PAID', 'REVERSED')),
    notes                TEXT,
    created_by           INTEGER       NOT NULL REFERENCES users(id),
    created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wht_withholdings (
    id                       SERIAL PRIMARY KEY,
    reference_id             INTEGER       REFERENCES references_registry(id),
    payment_type             VARCHAR(30)   NOT NULL
                             CHECK (payment_type IN ('DIVIDEND', 'SAVINGS_INTEREST', 'LOAN_INTEREST', 'SERVICE_FEE',
                                                     'SUPPLIER', 'NON_RESIDENT_SERVICE', 'OTHER')),
    payee_user_id            INTEGER       REFERENCES users(id),
    payee_name               VARCHAR(200)  NOT NULL,
    payee_tin                VARCHAR(20),
    payee_residency          VARCHAR(20)   NOT NULL DEFAULT 'RESIDENT' CHECK (payee_residency IN ('RESIDENT', 'NON_RESIDENT')),
    tax_rate_code            VARCHAR(40),
    rate                     NUMERIC(7,4)  NOT NULL,
    gross_amount             NUMERIC(20,4) NOT NULL CHECK (gross_amount > 0),
    tax_amount               NUMERIC(20,4) NOT NULL CHECK (tax_amount >= 0),
    net_amount               NUMERIC(20,4) NOT NULL,
    currency_id              INTEGER       NOT NULL REFERENCES currencies(id),
    withholding_date         DATE          NOT NULL,
    functional_rate          NUMERIC(20,8),
    tax_functional           NUMERIC(20,2),
    debit_gl_code            VARCHAR(10),
    source_transaction_id    INTEGER       REFERENCES transactions(id),
    dividend_distribution_id INTEGER       REFERENCES dividend_distributions(id),
    savings_handout_id       INTEGER       REFERENCES savings_handouts(id),
    loan_repayment_id        INTEGER       REFERENCES loan_received_repayments(id),
    service_fee_payment_id   INTEGER       REFERENCES service_fee_payments(id),
    is_shadow                BOOLEAN       NOT NULL DEFAULT FALSE,
    shadow_reason            TEXT,
    remittance_id            INTEGER       REFERENCES wht_remittances(id),
    status                   VARCHAR(15)   NOT NULL DEFAULT 'PENDING'
                             CHECK (status IN ('PENDING', 'REMITTED', 'SHADOW', 'REVERSED')),
    reversal_date            DATE,
    certificate_document_id  INTEGER       REFERENCES documents(id),
    notes                    TEXT,
    created_by               INTEGER       REFERENCES users(id),
    created_at               TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT wht_real_needs_ugx_value CHECK (is_shadow OR status = 'REVERSED' OR tax_functional IS NOT NULL),
    CONSTRAINT wht_real_needs_debit_gl CHECK (is_shadow OR debit_gl_code IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_wht_withholdings_date   ON wht_withholdings (withholding_date);
CREATE INDEX IF NOT EXISTS idx_wht_withholdings_status ON wht_withholdings (status);
CREATE INDEX IF NOT EXISTS idx_wht_withholdings_payee  ON wht_withholdings (payee_user_id);

-- ------------------------------------------------------------
-- 6. TAX YEARS, ADJUSTMENTS, PAYMENTS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tax_years (
    id                            SERIAL PRIMARY KEY,
    label                         VARCHAR(30)   NOT NULL,
    start_date                    DATE          NOT NULL UNIQUE,
    end_date                      DATE          NOT NULL,
    is_first_year                 BOOLEAN       NOT NULL DEFAULT FALSE,
    status                        VARCHAR(15)   NOT NULL DEFAULT 'OPEN'
                                  CHECK (status IN ('OPEN', 'PREPARED', 'APPROVED', 'FILED')),
    include_pre_incorporation     BOOLEAN       NOT NULL DEFAULT FALSE,
    fx_revaluation_taxable        BOOLEAN       NOT NULL DEFAULT TRUE,
    provisional_estimate          NUMERIC(20,2),          -- estimated chargeable income (UGX)
    provisional_tax_estimate      NUMERIC(20,2),          -- estimate x rate
    provisional_set_by            INTEGER       REFERENCES users(id),
    provisional_set_at            TIMESTAMPTZ,
    computation                   JSONB,                  -- the worksheet snapshot, frozen at PREPARED
    profit_before_tax             NUMERIC(20,2),
    total_add_backs               NUMERIC(20,2),
    total_deductions              NUMERIC(20,2),
    chargeable_income             NUMERIC(20,2),
    loss_brought_forward          NUMERIC(20,2),
    loss_utilised                 NUMERIC(20,2),
    taxable_income                NUMERIC(20,2),
    loss_carried_forward          NUMERIC(20,2),
    tax_rate                      NUMERIC(7,4),
    gross_tax                     NUMERIC(20,2),
    wht_credits                   NUMERIC(20,2),
    provisional_paid              NUMERIC(20,2),
    balance_due                   NUMERIC(20,2),
    prepared_by                   INTEGER       REFERENCES users(id),
    prepared_at                   TIMESTAMPTZ,
    approved_by                   INTEGER       REFERENCES users(id),
    approved_at                   TIMESTAMPTZ,
    returned_reason               TEXT,
    filed_by                      INTEGER       REFERENCES users(id),
    filed_at                      TIMESTAMPTZ,
    filing_date                   DATE,
    return_reference              VARCHAR(60),
    computation_document_id       INTEGER       REFERENCES documents(id),
    notes                         TEXT,
    created_at                    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT tax_years_dates CHECK (end_date > start_date)
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_at_source_claim_year_fk') THEN
        ALTER TABLE tax_at_source ADD CONSTRAINT tax_at_source_claim_year_fk
            FOREIGN KEY (credit_claimed_tax_year_id) REFERENCES tax_years(id);
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS tax_year_adjustments (
    id              SERIAL PRIMARY KEY,
    tax_year_id     INTEGER       NOT NULL REFERENCES tax_years(id) ON DELETE CASCADE,
    kind            VARCHAR(15)   NOT NULL CHECK (kind IN ('ADD_BACK', 'DEDUCTION')),
    description     TEXT          NOT NULL,
    amount          NUMERIC(20,2) NOT NULL CHECK (amount > 0),
    legal_reference TEXT,
    created_by      INTEGER       NOT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tax_payments (
    id              SERIAL PRIMARY KEY,
    reference_id    INTEGER       REFERENCES references_registry(id),
    tax_year_id     INTEGER       REFERENCES tax_years(id),
    payment_kind    VARCHAR(25)   NOT NULL
                    CHECK (payment_kind IN ('PROVISIONAL', 'INCOME_TAX_BALANCE', 'LATE_INTEREST', 'REFUND_RECEIVED')),
    instalment_no   SMALLINT,
    amount          NUMERIC(20,2) NOT NULL CHECK (amount > 0),
    account_id      INTEGER       NOT NULL REFERENCES accounts(id),
    transaction_id  INTEGER       REFERENCES transactions(id),
    prn             VARCHAR(40),
    paid_date       DATE          NOT NULL,
    status          VARCHAR(15)   NOT NULL DEFAULT 'PAID' CHECK (status IN ('PAID', 'REVERSED')),
    notes           TEXT,
    created_by      INTEGER       NOT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tax_reminders_sent (
    id          SERIAL PRIMARY KEY,
    reminder_key VARCHAR(120) NOT NULL,
    sent_on     DATE         NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT tax_reminders_sent_unique UNIQUE (reminder_key, sent_on)
);

-- ------------------------------------------------------------
-- 7. EXPENSE TAX TREATMENT (categories + per transaction)
-- NULL on a category = inherit from its parent (top level: DEDUCTIBLE).
-- NULL on a transaction = use its category's.
-- ------------------------------------------------------------
ALTER TABLE categories   ADD COLUMN IF NOT EXISTS tax_treatment VARCHAR(20);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS tax_treatment VARCHAR(20);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS gl_override_account_code VARCHAR(10);
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'categories_tax_treatment_check') THEN
        ALTER TABLE categories ADD CONSTRAINT categories_tax_treatment_check
            CHECK (tax_treatment IS NULL OR tax_treatment IN ('DEDUCTIBLE', 'NOT_DEDUCTIBLE', 'CAPITAL'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_tax_treatment_check') THEN
        ALTER TABLE transactions ADD CONSTRAINT transactions_tax_treatment_check
            CHECK (tax_treatment IS NULL OR tax_treatment IN ('DEDUCTIBLE', 'NOT_DEDUCTIBLE', 'CAPITAL'));
    END IF;
END $$;

-- ------------------------------------------------------------
-- 8. WHT SETTINGS ON THE MODULES THAT PAY PEOPLE
-- ------------------------------------------------------------
-- Service fees: off by default ("no ties with WHT"); switched on by an
-- amendment with a reason and an effective date (trail below).
ALTER TABLE service_fee_agreements ADD COLUMN IF NOT EXISTS wht_applicable     BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE service_fee_agreements ADD COLUMN IF NOT EXISTS wht_rate_code      VARCHAR(40);
ALTER TABLE service_fee_agreements ADD COLUMN IF NOT EXISTS wht_effective_from DATE;
CREATE TABLE IF NOT EXISTS service_fee_wht_amendments (
    id                 SERIAL PRIMARY KEY,
    agreement_id       INTEGER      NOT NULL REFERENCES service_fee_agreements(id),
    previous_applicable BOOLEAN     NOT NULL,
    new_applicable     BOOLEAN      NOT NULL,
    previous_rate_code VARCHAR(40),
    new_rate_code      VARCHAR(40),
    effective_from     DATE         NOT NULL,
    reason             TEXT         NOT NULL,
    amended_by         INTEGER      NOT NULL REFERENCES users(id),
    amended_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE payment_confirmations ADD COLUMN IF NOT EXISTS wht_amount    NUMERIC(20,4);
ALTER TABLE payment_confirmations ADD COLUMN IF NOT EXISTS wht_is_shadow BOOLEAN;

-- Loans received: interest paid to a lender outside Uganda has tax withheld.
ALTER TABLE loans_received ADD COLUMN IF NOT EXISTS lender_residency VARCHAR(20) NOT NULL DEFAULT 'RESIDENT';
ALTER TABLE loans_received ADD COLUMN IF NOT EXISTS lender_tin       VARCHAR(20);
ALTER TABLE loans_received ADD COLUMN IF NOT EXISTS wht_applicable   BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE loans_received ADD COLUMN IF NOT EXISTS wht_rate_code    VARCHAR(40);
ALTER TABLE loan_received_repayments ADD COLUMN IF NOT EXISTS wht_amount NUMERIC(20,4) NOT NULL DEFAULT 0;
ALTER TABLE loan_received_repayments ADD COLUMN IF NOT EXISTS cash_paid  NUMERIC(20,4);
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'loans_received_lender_residency_check') THEN
        ALTER TABLE loans_received ADD CONSTRAINT loans_received_lender_residency_check
            CHECK (lender_residency IN ('RESIDENT', 'NON_RESIDENT'));
    END IF;
END $$;

ALTER TABLE dividend_distributions ADD COLUMN IF NOT EXISTS wht_rate   NUMERIC(7,4);
ALTER TABLE dividend_distributions ADD COLUMN IF NOT EXISTS wht_amount NUMERIC(20,4);
ALTER TABLE dividend_distributions ADD COLUMN IF NOT EXISTS net_amount NUMERIC(20,4);

ALTER TABLE savings_handouts ADD COLUMN IF NOT EXISTS wht_rate   NUMERIC(7,4);
ALTER TABLE savings_handouts ADD COLUMN IF NOT EXISTS wht_amount NUMERIC(20,4) NOT NULL DEFAULT 0;
ALTER TABLE savings_handouts ADD COLUMN IF NOT EXISTS net_amount NUMERIC(20,4);

-- ------------------------------------------------------------
-- 9. TREASURY BILLS
-- ------------------------------------------------------------
DO $$
DECLARE con_name text;
BEGIN
    SELECT conname INTO con_name FROM pg_constraint
    WHERE  conrelid = 'investments'::regclass AND contype = 'c'
    AND    pg_get_constraintdef(oid) LIKE '%investment_type%' AND pg_get_constraintdef(oid) LIKE '%STANDARD%'
    AND    pg_get_constraintdef(oid) NOT LIKE '%TREASURY_BILL%'
    LIMIT 1;
    IF con_name IS NOT NULL THEN
        EXECUTE 'ALTER TABLE investments DROP CONSTRAINT ' || quote_ident(con_name);
        ALTER TABLE investments ADD CONSTRAINT investments_investment_type_check
            CHECK (investment_type IN ('STANDARD', 'BOND', 'TREASURY_BILL'));
    END IF;
END $$;
ALTER TABLE investments ADD COLUMN IF NOT EXISTS tbill_tax_timing VARCHAR(15);
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'investments_tbill_tax_timing_check') THEN
        ALTER TABLE investments ADD CONSTRAINT investments_tbill_tax_timing_check
            CHECK (tbill_tax_timing IS NULL OR tbill_tax_timing IN ('AT_MATURITY', 'AT_PURCHASE'));
    END IF;
END $$;

-- ------------------------------------------------------------
-- 10. documents.audience gains 'ALL_MEMBERS' (every member, whether
-- or not they hold shares — used for the WHT agent status notice).
-- ------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_audience_check'
               AND pg_get_constraintdef(oid) NOT LIKE '%ALL_MEMBERS%') THEN
        ALTER TABLE documents DROP CONSTRAINT documents_audience_check;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_audience_check') THEN
        ALTER TABLE documents ADD CONSTRAINT documents_audience_check
            CHECK (audience IS NULL OR audience IN ('ALL_SHAREHOLDERS', 'ALL_MEMBERS'));
    END IF;
END $$;

-- ------------------------------------------------------------
-- 11. transactions.inflow_type gains the five tax payment types.
-- Rebuilt from the constraint's CURRENT list (nothing dropped).
-- ------------------------------------------------------------
DO $$
DECLARE
    con_name text;
    con_def  text;
    vals     text[];
BEGIN
    SELECT conname, pg_get_constraintdef(oid) INTO con_name, con_def
    FROM   pg_constraint
    WHERE  conrelid = 'transactions'::regclass
    AND    contype = 'c'
    AND    pg_get_constraintdef(oid) LIKE '%inflow_type%'
    LIMIT  1;

    IF con_def IS NOT NULL AND con_def LIKE '%TAX_REFUND_IN%' THEN
        RETURN;
    END IF;

    SELECT array_agg(DISTINCT m[1]) INTO vals
    FROM   regexp_matches(COALESCE(con_def, ''), '''([A-Z_]+)''', 'g') AS m;
    vals := COALESCE(vals, ARRAY[]::text[])
         || ARRAY['WHT_REMITTANCE_OUT', 'PROVISIONAL_TAX_OUT', 'INCOME_TAX_OUT', 'TAX_PENALTY_OUT', 'TAX_REFUND_IN'];
    SELECT array_agg(DISTINCT v) INTO vals FROM unnest(vals) AS v;

    IF con_name IS NOT NULL THEN
        EXECUTE 'ALTER TABLE transactions DROP CONSTRAINT ' || quote_ident(con_name);
    END IF;
    EXECUTE 'ALTER TABLE transactions ADD CONSTRAINT transactions_inflow_type_check CHECK (inflow_type IN ('
        || (SELECT string_agg(quote_literal(v), ', ' ORDER BY v) FROM unnest(vals) AS v)
        || '))';
END $$;

-- ------------------------------------------------------------
-- 12. CHART OF ACCOUNTS
-- ------------------------------------------------------------
INSERT INTO gl_accounts (code, name, account_type, normal_balance, statement_section, cash_flow_category, description, display_order, is_monetary)
VALUES
    ('1500', 'Withholding Tax Recoverable', 'ASSET', 'DEBIT', 'TAX_ASSETS', 'OPERATING',
     'CREDITABLE tax deducted from the company''s income by the payer (e.g. bank interest). A prepayment of corporate tax: set off against the year''s tax when the return is filed.', 220, FALSE),
    ('1510', 'Provisional Tax Paid', 'ASSET', 'DEBIT', 'TAX_ASSETS', 'OPERATING',
     'Provisional (instalment) corporate tax paid to URA during the year. Set off against the year''s tax when the return is filed.', 225, FALSE),
    ('2500', 'Withholding Tax Payable (URA)', 'LIABILITY', 'CREDIT', 'TAX_LIABILITIES', 'OPERATING',
     'Tax the company deducted from payments it made (dividends, members'' savings interest, foreign lender interest, fees) and must pay to URA by the 15th of the following month.', 445, FALSE),
    ('2510', 'Corporate Income Tax Payable', 'LIABILITY', 'CREDIT', 'TAX_LIABILITIES', 'OPERATING',
     'Corporate income tax of approved tax years, less what has been set off or paid. A debit balance is tax refundable.', 447, FALSE),
    ('5700', 'Income Tax — Final Withholding Tax', 'EXPENSE', 'DEBIT', 'INCOME_TAX', 'OPERATING',
     'FINAL tax deducted at source from income (government securities, treasury bills). Part of the income tax charge, not an operating expense.', 790, FALSE),
    ('5710', 'Income Tax — Corporate (Current Year)', 'EXPENSE', 'DEBIT', 'INCOME_TAX', 'OPERATING',
     'Corporate income tax on the chargeable income of each approved tax year.', 795, FALSE),
    ('5720', 'Tax Penalties and Late Payment Interest', 'EXPENSE', 'DEBIT', 'EXPENSES', 'OPERATING',
     'Interest and penalties charged by URA for late filing or payment. Not deductible for tax.', 770, FALSE)
ON CONFLICT (code) DO NOTHING;

INSERT INTO gl_inflow_type_mapping (inflow_type, gl_account_id, notes)
SELECT v.inflow_type, ga.id, v.notes
FROM (VALUES
    ('WHT_REMITTANCE_OUT',  '2500', 'v1.70.0 — withheld tax paid over to URA.'),
    ('PROVISIONAL_TAX_OUT', '1510', 'v1.70.0 — provisional corporate tax instalment paid to URA.'),
    ('INCOME_TAX_OUT',      '2510', 'v1.70.0 — balance of corporate income tax paid to URA.'),
    ('TAX_PENALTY_OUT',     '5720', 'v1.70.0 — late payment interest / penalty paid to URA.'),
    ('TAX_REFUND_IN',       '2510', 'v1.70.0 — tax refunded by URA.')
) AS v(inflow_type, code, notes)
JOIN gl_accounts ga ON ga.code = v.code
ON CONFLICT (inflow_type) DO NOTHING;

-- ------------------------------------------------------------
-- 13. RE-CLASSIFICATION OF EXISTING ENTRIES (reports only)
-- a) Every investment "TAX" leg (bond coupon withholding tax and
--    manual TAX entries) was an EXPENSE carrying investment_id, which
--    the ledger counted as money INVESTED (1400). It is income tax
--    deducted at source: FINAL for government securities -> 5700.
-- ------------------------------------------------------------
UPDATE transactions t
SET    gl_override_account_code = '5700'
FROM   investment_transactions it
WHERE  it.transaction_id = t.id
AND    it.entry_type = 'TAX'
AND    t.gl_override_account_code IS NULL;

-- Their reversals follow them.
UPDATE transactions r
SET    gl_override_account_code = o.gl_override_account_code
FROM   transactions o
WHERE  r.reversal_of = o.id
AND    o.gl_override_account_code IS NOT NULL
AND    r.gl_override_account_code IS NULL;

-- ...and each gets a row in the register of tax deducted from us.
INSERT INTO tax_at_source (
    source_type, payer_name, investment_id, bond_coupon_id, income_transaction_id, tax_transaction_id,
    cash_leg, tax_rate_code, rate, treatment, gross_amount, tax_amount, net_amount, currency_id,
    deduction_date, functional_rate, gross_functional, tax_functional, status, is_backfilled, notes)
SELECT
    CASE WHEN bc.id IS NOT NULL THEN 'BOND_COUPON' ELSE 'INVESTMENT_TAX_ENTRY' END,
    i.name,
    i.id,
    bc.id,
    ir.transaction_id,
    t.id,
    TRUE,
    CASE WHEN i.investment_type = 'BOND' AND COALESCE(i.bond_term_years, 0) >= 10 THEN 'WHT_GOV_SECURITIES_LONG'
         WHEN i.investment_type = 'BOND' THEN 'WHT_GOV_SECURITIES_SHORT' ELSE NULL END,
    NULLIF(i.tax_withholding_rate, 0),
    'FINAL',
    COALESCE(bc.actual_gross_amount, bc.gross_amount, t.amount),
    t.amount,
    COALESCE(bc.actual_gross_amount, bc.gross_amount, t.amount) - t.amount,
    t.currency_id,
    t.value_date,
    t.functional_rate,
    ROUND(COALESCE(bc.actual_gross_amount, bc.gross_amount, t.amount) * COALESCE(t.functional_rate, 0), 2),
    t.functional_amount,
    CASE WHEN t.is_reversed THEN 'REVERSED' ELSE 'ACTIVE' END,
    TRUE,
    'Recorded before v1.70.0; added to the tax register by the migration. Check the treatment (FINAL / CREDITABLE) and attach the certificate.'
FROM   investment_transactions it
JOIN   transactions t  ON t.id = it.transaction_id AND t.is_reversal = FALSE
JOIN   investments  i  ON i.id = it.investment_id
LEFT JOIN bond_coupons bc ON bc.investment_id = i.id
       AND bc.status = 'PAID'
       AND bc.paid_at IS NOT NULL
       AND it.description = 'Withholding tax on bond coupon #' || bc.coupon_number
LEFT JOIN investment_returns ir ON ir.id = bc.investment_return_id
WHERE  it.entry_type = 'TAX'
AND    t.amount > 0
AND    NOT EXISTS (SELECT 1 FROM tax_at_source s WHERE s.tax_transaction_id = t.id);

-- b) A bond's face value repaid at maturity (return type PRINCIPAL) is
--    the company's own money coming back, not income: -> 1400.
UPDATE transactions t
SET    gl_override_account_code = '1400'
FROM   investment_returns ir
WHERE  ir.transaction_id = t.id
AND    ir.return_type = 'PRINCIPAL'
AND    t.gl_override_account_code IS NULL;

UPDATE transactions r
SET    gl_override_account_code = o.gl_override_account_code
FROM   transactions o
WHERE  r.reversal_of = o.id
AND    o.gl_override_account_code IS NOT NULL
AND    r.gl_override_account_code IS NULL;

-- ============================================================
-- v1.72.0 — reversal requests (second-person approval), "reversed"
-- markers on money-market-fund / investment entries, and the log of
-- automatic record corrections. (Existing databases: run
-- migration_v1.72.0.sql, which also repairs past reversals.)
-- ============================================================
-- ------------------------------------------------------------
-- 1. Reversal requests (second-person approval)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reversal_requests (
    id                       SERIAL PRIMARY KEY,
    transaction_id           INTEGER      NOT NULL REFERENCES transactions(id),
    reason                   TEXT         NOT NULL,
    status                   VARCHAR(20)  NOT NULL DEFAULT 'PENDING'
                             CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
    -- What the rehearsal said would happen ("2 linked entries …; MMF
    -- balance reduced by …"), shown to the approver.
    effect_summary           TEXT,
    linked_count             INTEGER      NOT NULL DEFAULT 1,
    requested_by             INTEGER      NOT NULL REFERENCES users(id),
    requested_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    decided_by               INTEGER      REFERENCES users(id),
    decided_at               TIMESTAMPTZ,
    decision_note            TEXT,
    reversal_transaction_id  INTEGER      REFERENCES transactions(id)
);
-- Only one open request per transaction.
CREATE UNIQUE INDEX IF NOT EXISTS uq_reversal_requests_pending
    ON reversal_requests (transaction_id) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_reversal_requests_status ON reversal_requests (status, requested_at DESC);

-- ------------------------------------------------------------
-- 2. "Reversed" markers on the sub-ledger rows
-- ------------------------------------------------------------
ALTER TABLE mmf_transactions        ADD COLUMN IF NOT EXISTS is_reversed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE mmf_transactions        ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;
ALTER TABLE mmf_transactions        ADD COLUMN IF NOT EXISTS reversed_by INTEGER REFERENCES users(id);
ALTER TABLE mmf_transactions        ADD COLUMN IF NOT EXISTS reversal_transaction_id INTEGER REFERENCES transactions(id);

ALTER TABLE investment_funding      ADD COLUMN IF NOT EXISTS is_reversed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE investment_funding      ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;
ALTER TABLE investment_funding      ADD COLUMN IF NOT EXISTS reversed_by INTEGER REFERENCES users(id);
ALTER TABLE investment_funding      ADD COLUMN IF NOT EXISTS reversal_transaction_id INTEGER REFERENCES transactions(id);

ALTER TABLE investment_returns      ADD COLUMN IF NOT EXISTS is_reversed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE investment_returns      ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;
ALTER TABLE investment_returns      ADD COLUMN IF NOT EXISTS reversed_by INTEGER REFERENCES users(id);
ALTER TABLE investment_returns      ADD COLUMN IF NOT EXISTS reversal_transaction_id INTEGER REFERENCES transactions(id);

ALTER TABLE investment_transactions ADD COLUMN IF NOT EXISTS is_reversed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE investment_transactions ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;
ALTER TABLE investment_transactions ADD COLUMN IF NOT EXISTS reversed_by INTEGER REFERENCES users(id);
ALTER TABLE investment_transactions ADD COLUMN IF NOT EXISTS reversal_transaction_id INTEGER REFERENCES transactions(id);

-- ------------------------------------------------------------
-- 3. Log of every automatic correction (Reports › Records check)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS record_corrections (
    id            SERIAL PRIMARY KEY,
    run_label     VARCHAR(40)  NOT NULL,           -- e.g. 'v1.72.0 migration'
    record_type   VARCHAR(40)  NOT NULL,           -- mmf_accounts / investments / bond_coupons
    record_id     INTEGER      NOT NULL,
    record_name   TEXT,
    field_name    VARCHAR(60),
    old_value     TEXT,
    new_value     TEXT,
    note          TEXT,
    needs_attention BOOLEAN    NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);


-- ============================================================
-- v1.73.0 — MONEY ENTRIES HELD FOR APPROVAL
-- (anyone who is not the Treasurer or an Admin: held until the
--  Treasurer or an Admin approves — see middleware/holdMoneyEntry.js)
-- ============================================================
CREATE TABLE IF NOT EXISTS held_money_entries (
    id                     SERIAL PRIMARY KEY,
    route_key              VARCHAR(60)   NOT NULL,   -- which action, e.g. 'transactions.expense'
    label                  VARCHAR(120)  NOT NULL,   -- plain-English name shown on the list
    method                 VARCHAR(10)   NOT NULL,
    path                   TEXT          NOT NULL,   -- the address it was sent to (for the record)
    params                 JSONB         NOT NULL DEFAULT '{}',
    body                   JSONB         NOT NULL DEFAULT '{}',  -- the checked form values
    query_params           JSONB         NOT NULL DEFAULT '{}',
    subject                TEXT,                      -- e.g. 'Investment: GoU 2yr bond'
    account_name           TEXT,
    amount                 NUMERIC(20,4),
    currency_code          VARCHAR(10),
    note                   TEXT,
    status                 VARCHAR(12)   NOT NULL DEFAULT 'PENDING'
                           CHECK (status IN ('PENDING', 'EXECUTING', 'APPROVED', 'REJECTED', 'WITHDRAWN')),
    created_by             INTEGER       NOT NULL REFERENCES users(id),
    created_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    decided_by             INTEGER       REFERENCES users(id),
    decided_at             TIMESTAMPTZ,
    decision_note          TEXT,
    last_error             TEXT,          -- why the last approval attempt could not post it
    last_error_at          TIMESTAMPTZ,
    result_message         TEXT,
    posted_transaction_ids INTEGER[]
);

CREATE INDEX IF NOT EXISTS idx_held_money_entries_status  ON held_money_entries(status);
CREATE INDEX IF NOT EXISTS idx_held_money_entries_creator ON held_money_entries(created_by);

COMMENT ON TABLE held_money_entries IS
    'v1.73.0 — money entries recorded by someone who is not the Treasurer or an Admin, held until the Treasurer or an Admin approves them. On approval the original action is run on behalf of the recorder and the ledger rows store approved_by = the approver.';

-- ============================================================
-- v1.74.0 — MAINTENANCE MODE
-- (Settings › Maintenance; MAINTENANCE_MODE=on in Render forces it on)
-- ============================================================
-- The switch itself — one row only (id = 1).
CREATE TABLE IF NOT EXISTS system_maintenance (
    id               INTEGER      PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    is_on            BOOLEAN      NOT NULL DEFAULT FALSE,
    message          TEXT,                         -- shown to members on the maintenance page
    expected_end     TIMESTAMPTZ,                  -- optional "back by"
    started_at       TIMESTAMPTZ,
    started_by       INTEGER      REFERENCES users(id),
    ended_at         TIMESTAMPTZ,
    ended_by         INTEGER      REFERENCES users(id),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
INSERT INTO system_maintenance (id, is_on) VALUES (1, FALSE) ON CONFLICT (id) DO NOTHING;

-- History of every switch on/off.
CREATE TABLE IF NOT EXISTS maintenance_events (
    id              SERIAL       PRIMARY KEY,
    event           VARCHAR(10)  NOT NULL CHECK (event IN ('ON', 'OFF', 'UPDATE')),
    message         TEXT,
    expected_end    TIMESTAMPTZ,
    emailed_members BOOLEAN      NOT NULL DEFAULT FALSE,
    user_id         INTEGER      REFERENCES users(id),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Nightly jobs that were skipped because maintenance was on, and when
-- they were caught up afterwards.
CREATE TABLE IF NOT EXISTS maintenance_skipped_jobs (
    id              SERIAL       PRIMARY KEY,
    job_name        VARCHAR(80)  NOT NULL,
    run_date        DATE         NOT NULL,     -- the date the job would have processed
    skipped_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    caught_up_at    TIMESTAMPTZ,
    result          TEXT,                      -- 'done' or the error message
    UNIQUE (job_name, run_date)
);
CREATE INDEX IF NOT EXISTS idx_maintenance_skipped_pending
    ON maintenance_skipped_jobs(caught_up_at) WHERE caught_up_at IS NULL;

-- ============================================================
-- END OF SCHEMA — v1.74.0
-- ============================================================
