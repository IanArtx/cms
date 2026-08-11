-- ============================================================
-- MIGRATION v1.23.0 — DIGITAL CONSENT, SIGNATURES & MULTI-SIGNATORY
-- APPROVAL
--
-- Three related additions:
--
-- 1. MEMBERSHIP CONSENT + PERSONAL SIGNATURE. A new member must read
--    and consent to a single company-wide Membership Agreement, and
--    draw their personal signature (a signature-pad, not an upload),
--    before they can use the rest of the system — the same kind of
--    hard gate as the v1.21.1 pending-approval screen, just the next
--    step after a role is assigned. This is a ONE-TIME consent: if
--    an Admin later edits the Membership Agreement's wording, members
--    who already consented are not required to re-consent (their
--    consent stands against whichever version they actually agreed
--    to — membership_agreement.version is bumped and kept only as a
--    record of that, not as a trigger to re-prompt anyone).
--
-- 2. MULTI-SIGNATORY DOCUMENT APPROVAL. Resolutions and Loan/Grant
--    Agreements (existing `documents` rows) can now require more
--    than one person to sign before they count as approved — each
--    required signature is its own row in document_signatures, keyed
--    to a specific ROLE (whoever currently holds that role can fill
--    it), not a specific person. A document isn't FINAL until every
--    required role's slot is SIGNED. Which roles are required for
--    which document type is configured by an Admin in Settings
--    (signature_requirements) — if nothing is configured for a given
--    type, that type keeps behaving exactly as it always has (a
--    single approveDocument call finalises it), so this feature is
--    fully opt-in per document type.
--
-- 3. MONTHLY SHARE CERTIFICATE SIGNING ROUNDS. The existing monthly/
--    annual certificate pipeline (certificateService) still issues
--    one share_certificates row per shareholder on the same schedule
--    as before, but now groups that batch into a single
--    certificate_signing_rounds row instead of emailing immediately.
--    The round uses the exact same document_signatures mechanism as
--    documents above (target_type = 'CERTIFICATE_ROUND') — one
--    signature is enough to cover every certificate in that round,
--    not one signature per certificate per signatory. Certificates
--    are only rendered-with-signatures and emailed once the round is
--    fully signed. Same opt-in rule: no signature_requirements
--    configured for SHARE_CERTIFICATE means certificates keep
--    emailing immediately, exactly as before.
--
-- document_signatures is a single generic table reused for both (2)
-- and (3) rather than two near-identical tables, since "N required
-- roles must each sign before this is approved" is exactly the same
-- shape of problem for a Resolution as for a batch of certificates.
--
-- Safe to run on a database that already has these objects (all
-- statements are idempotent).
-- ============================================================

BEGIN;

-- ----------------------------------------------------------
-- 1. users — personal signature (drawn on a signature pad, stored
--    as a PNG on disk the same way photo_path/branding logos are)
-- ----------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS signature_path TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS signature_updated_at TIMESTAMPTZ;

-- ----------------------------------------------------------
-- 2. membership_agreement — singleton row (same id=1 pattern as
--    savings_settings / side_fund_config), the text every new member
--    reads and consents to. Admin-editable via Settings.
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS membership_agreement (
    id          INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    content     TEXT NOT NULL DEFAULT 'This company''s Membership Agreement has not been set yet. An Administrator needs to add it in Settings before new members can complete sign-up.',
    version     INTEGER NOT NULL DEFAULT 1,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by  INTEGER REFERENCES users(id)
);
INSERT INTO membership_agreement (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------
-- 3. member_consents — one row per member, ever (UNIQUE user_id).
--    Records which version they consented to and when, plus basic
--    provenance (IP/user-agent) since this stands in for a wet-ink
--    signature on a membership form.
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS member_consents (
    id                SERIAL PRIMARY KEY,
    user_id           INTEGER NOT NULL UNIQUE REFERENCES users(id),
    agreement_version INTEGER NOT NULL,
    consented_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ip_address        VARCHAR(64),
    user_agent        TEXT
);

-- ----------------------------------------------------------
-- 4. signature_requirements — which roles must sign which document
--    type. Admin-managed (Settings -> Signatories). A document type
--    with zero active rows here means "no multi-signature requirement
--    configured" — that type's documents keep using the original
--    single-approver approveDocument flow.
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS signature_requirements (
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

-- ----------------------------------------------------------
-- 5. document_signatures — one row per required-role signing slot on
--    a specific signable thing. target_type + target_id points at
--    either a `documents` row or a `certificate_signing_rounds` row.
--    required_role_id is a ROLE, not a person — whoever currently
--    holds that role may fill the slot; signed_by records who
--    actually did. signature_snapshot_path is a copy of that
--    person's users.signature_path made at the moment they sign, so
--    a later change to their stored signature never alters a
--    document they already signed.
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS document_signatures (
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
CREATE INDEX IF NOT EXISTS idx_doc_signatures_target ON document_signatures (target_type, target_id);

-- ----------------------------------------------------------
-- 6. documents — track when a document became fully signed (distinct
--    from approved_by/approved_at, which for a multi-signature
--    document now records whoever supplied the LAST signature)
-- ----------------------------------------------------------
ALTER TABLE documents ADD COLUMN IF NOT EXISTS fully_signed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS fully_signed_at TIMESTAMPTZ;

-- ----------------------------------------------------------
-- 7. certificate_signing_rounds — one row per (certificate_type,
--    period_label) batch, e.g. ('MONTHLY', '202608'). Every
--    share_certificates row issued in that batch links to it.
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS certificate_signing_rounds (
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

-- ----------------------------------------------------------
-- 8. share_certificates — which round (if any) this certificate
--    belongs to. NULL means it was issued before this feature
--    existed, or via a path that doesn't use rounds (Section 4.20.6
--    known-issues note covers on-demand single-certificate issuance,
--    which is not yet part of the signing-round gate).
-- ----------------------------------------------------------
ALTER TABLE share_certificates ADD COLUMN IF NOT EXISTS signing_round_id INTEGER REFERENCES certificate_signing_rounds(id);

COMMIT;

-- ============================================================
-- After running this migration:
--   1. Restart the backend so requireConsent, the new /users/me
--      signature+consent endpoints, and the signing endpoints are
--      picked up.
--   2. Set the real Membership Agreement text via Settings ->
--      Membership Agreement — the default placeholder text blocks
--      nothing, but every member will see it until it's replaced.
--   3. Existing members (already using the system before this
--      migration) will be prompted for consent + signature on their
--      next login, exactly like a brand-new member — there is no
--      way to know their past usage already implied agreement, so
--      everyone goes through the same one-time gate once.
--   4. Nothing is multi-signature-gated until an Admin explicitly
--      configures signature_requirements for a document type in
--      Settings -> Signatories. Until then, Resolutions/Loan/Grant
--      Agreements keep using the original single-approver flow, and
--      Share Certificates keep emailing immediately as issued.
-- ============================================================
