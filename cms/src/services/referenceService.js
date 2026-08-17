// ============================================================
// REFERENCE GENERATION SERVICE
// Generates all unique references in the system.
// Format: [MODULE_CODE]-[CATEGORY_ABBREV]-[YYYYMM]-[00001]
//
// Example: PA-CONTRIB-202601-00001
//
// CRITICAL: This runs inside a database transaction with a
// row-level lock (SELECT FOR UPDATE) to guarantee that two
// simultaneous requests never get the same sequence number.
// ============================================================

const { withTransaction } = require('../config/database');
const crypto = require('crypto');

// ============================================================
// PUBLIC ID — a short random (non-sequential) code generated
// alongside every sequential reference code. The sequential code
// (e.g. SHC-MONTHLY-202607-00001) is great for filing and sorting,
// but it also reveals how many records of that kind exist and in
// what order. The public ID is for searching/quoting a specific
// record without any of that being guessable — e.g. on a printed
// certificate or receipt, or typed into Global Search.
//
// Alphabet excludes visually-confusable characters (0/O, 1/I/L) so
// it's easy to read aloud or copy from a printed document.
// ============================================================
const PUBLIC_ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PUBLIC_ID_LENGTH   = 10;

const randomPublicId = () => {
    const bytes = crypto.randomBytes(PUBLIC_ID_LENGTH);
    let id = '';
    for (let i = 0; i < PUBLIC_ID_LENGTH; i++) {
        id += PUBLIC_ID_ALPHABET[bytes[i] % PUBLIC_ID_ALPHABET.length];
    }
    return id;
};

// Generates a public ID guaranteed unique against references_registry,
// retrying on the (astronomically unlikely) chance of a collision.
const generateUniquePublicId = async (client) => {
    for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = randomPublicId();
        const existing = await client.query(
            'SELECT 1 FROM references_registry WHERE public_id = $1', [candidate]
        );
        if (existing.rows.length === 0) return candidate;
    }
    throw new Error('Could not generate a unique public ID after 5 attempts');
};

// ============================================================
// GENERATE REFERENCE
// Call this inside an existing transaction by passing the
// transaction client, or let it create its own transaction.
//
// Parameters:
//   client        — active pg transaction client
//   moduleCode    — e.g. 'PA', 'SA', 'DOC', 'EVT', 'INV', 'PRJ'
//   categoryAbbrev — e.g. 'CONTRIB', 'OPEX', 'MIN', 'MTG'
//   recordType    — human label e.g. 'TRANSACTION', 'DOCUMENT'
//   createdBy     — user ID generating the reference
//   yearMonth     — optional override (YYYYMM) — defaults to now
// ============================================================
const generateReference = async (
    client,
    moduleCode,
    categoryAbbrev,
    recordType,
    createdBy,
    yearMonth = null
) => {
    // Default year-month to current if not specified
    const now = new Date();
    const ym = yearMonth || (
        String(now.getFullYear()) +
        String(now.getMonth() + 1).padStart(2, '0')
    );

    // Normalise inputs to uppercase for consistency
    const mod = moduleCode.toUpperCase();
    const cat = categoryAbbrev.toUpperCase();

    // --------------------------------------------------------
    // STEP 1: Lock and increment the sequence counter
    // FOR UPDATE locks this row so no other transaction can
    // read it until we commit — prevents duplicate sequences
    // --------------------------------------------------------
    const upsertSeq = await client.query(`
        INSERT INTO reference_sequences (module_code, category_abbrev, year_month, last_sequence)
        VALUES ($1, $2, $3, 1)
        ON CONFLICT (module_code, category_abbrev, year_month)
        DO UPDATE SET
            last_sequence = reference_sequences.last_sequence + 1,
            updated_at    = NOW()
        RETURNING last_sequence
    `, [mod, cat, ym]);

    const sequence = upsertSeq.rows[0].last_sequence;

    // --------------------------------------------------------
    // STEP 2: Build the full reference string
    // Sequence is zero-padded to 5 digits (up to 99,999/month)
    // --------------------------------------------------------
    const sequencePadded = String(sequence).padStart(5, '0');
    const referenceCode  = `${mod}-${cat}-${ym}-${sequencePadded}`;

    // --------------------------------------------------------
    // STEP 2b: Generate the random public ID (see comment above)
    // --------------------------------------------------------
    const publicId = await generateUniquePublicId(client);

    // --------------------------------------------------------
    // STEP 3: Register in the references registry
    // record_id is null here — the caller updates it once the
    // parent record (transaction, document etc.) is created
    // --------------------------------------------------------
    const regResult = await client.query(`
        INSERT INTO references_registry
            (reference_code, public_id, module_code, category_abbrev, year_month, sequence, record_type, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id
    `, [referenceCode, publicId, mod, cat, ym, sequence, recordType, createdBy]);

    const referenceId = regResult.rows[0].id;

    return { referenceId, referenceCode, publicId };
};

// ============================================================
// LINK REFERENCE TO RECORD
// After the parent record is inserted, call this to store
// the record's ID in the registry so every reference is
// traceable back to its source record.
// ============================================================
const linkReferenceToRecord = async (client, referenceId, recordId) => {
    await client.query(`
        UPDATE references_registry
        SET    record_id = $1
        WHERE  id        = $2
    `, [recordId, referenceId]);
};

// ============================================================
// MODULE CODES — centralised constants used across the app
// ============================================================
const MODULE_CODES = {
    PRIMARY_ACCOUNT:   'PA',
    SECONDARY_ACCOUNT: 'SA',
    DOCUMENT:          'DOC',
    EVENT:             'EVT',
    INVESTMENT:        'INV',
    PROJECT:           'PRJ',
    LOAN_RECEIVED:     'LNR',
    LOAN_GIVEN:        'LNG',
    GRANT:             'GRN',
    TRANSFER:          'TRF',
    REPORT:            'RPT',
    SHARE_CERTIFICATE: 'SHC',
    MMF:               'MMF',
};

// ============================================================
// RESOLVE MODULE CODE FOR AN ACCOUNT
// Every account normally uses the generic PA/SA module code for
// its transaction references. If the account has its own
// reference_prefix set (configured by an Admin on the account),
// that short code is used instead — e.g. an "Investment Reserve
// Fund" account with prefix 'IRF' gets IRF-EXP-202607-00001
// instead of SA-EXP-202607-00001.
//
// `account` must at least have `account_type`; `reference_prefix`
// is optional — callers that don't SELECT it simply always get
// the generic fallback, which is the previous (pre-v1.6.0) behaviour.
// ============================================================
const resolveModuleCode = (account) => {
    if (account && account.reference_prefix) return account.reference_prefix;
    if (account && account.account_type === 'PRIMARY') return MODULE_CODES.PRIMARY_ACCOUNT;
    // MODULE_CODES.SAVINGS is monkey-patched onto this singleton by
    // savingsController.js (same pattern used throughout this file) —
    // fall back to 'SAV' if that controller hasn't loaded for some reason.
    if (account && account.account_type === 'SAVINGS') return MODULE_CODES.SAVINGS || 'SAV';
    return MODULE_CODES.SECONDARY_ACCOUNT;
};

module.exports = { generateReference, linkReferenceToRecord, MODULE_CODES, resolveModuleCode };
