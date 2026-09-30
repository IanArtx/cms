// ============================================================
// MAINTENANCE MODE (v1.74.0)
//
// Requested directly: "add a page that shows whenever I would like to
// make updates to the system. This is triggered by admin in settings
// and informs all except the admin that the system is under
// maintenance. It should be independent of any errors in the system
// else where and also a status on the admin side to show that this
// mode is still on when enabled".
//
// Where the switch lives
//   • system_maintenance (one row) — switched in Settings › Maintenance.
//   • The Render environment setting MAINTENANCE_MODE=on forces it on
//     no matter what the table says — for when the database itself is
//     being updated (or is broken) and cannot be read.
//
// Built to keep working when other things are broken
//   • Reads are cached for a few seconds and NEVER throw: if the table
//     can't be read (database down, migration not run yet) the answer
//     is "off" — unless MAINTENANCE_MODE forces it on.
//   • Only depends on the database pool, jsonwebtoken and the logger.
//
// Who may still use the system: the Admin role only.
//
// Nightly jobs: while maintenance is on, every scheduled job is
// skipped and recorded (maintenance_skipped_jobs). When maintenance is
// turned off, catchUpSkippedJobs() runs them: the daily interest jobs
// once for each missed date (so no day of interest is lost), every
// other job once.
// ============================================================

const jwt = require('jsonwebtoken');
const { query } = require('../config/database');
const logger = require('../config/logger');

const DEFAULT_MESSAGE =
    'The system is being updated to serve you better. Please check back shortly — nothing you have recorded is affected.';

const STATE_TTL_MS = 5000;     // re-read the switch at most every 5 s
const ROLE_TTL_MS  = 30000;    // re-check a person's Admin role at most every 30 s

let cache = { at: 0, state: null };
const adminCache = new Map();  // userId -> { at, isAdmin }

const envForced = () => ['on', 'true', '1', 'yes'].includes(String(process.env.MAINTENANCE_MODE || '').trim().toLowerCase());

// Jobs whose work is tied to a single date: caught up once per missed date.
const DATED_JOBS = new Set(['DailyInterestAccrual', 'DailySavingsAccrual']);

const invalidate = () => { cache = { at: 0, state: null }; };

const readState = async () => {
    const forced = envForced();
    try {
        const r = await query(`
            SELECT m.is_on, m.message, m.expected_end, m.started_at, m.started_by,
                   u.first_name || ' ' || u.last_name AS started_by_name,
                   (SELECT COUNT(*)::int FROM maintenance_skipped_jobs WHERE caught_up_at IS NULL) AS skipped_jobs
            FROM   system_maintenance m
            LEFT JOIN users u ON u.id = m.started_by
            WHERE  m.id = 1
        `);
        const row = r.rows[0] || {};
        // Forced by the server setting while the switch itself is off:
        // the last session's message/times no longer apply.
        const live = !!row.is_on;
        return {
            on: forced || !!row.is_on,
            source: forced ? 'server_setting' : (row.is_on ? 'settings' : null),
            switch_on: !!row.is_on,
            forced,
            message: (live && row.message) || DEFAULT_MESSAGE,
            expected_end: live ? (row.expected_end || null) : null,
            started_at: live ? (row.started_at || null) : null,
            started_by_name: live ? (row.started_by_name || null) : null,
            skipped_jobs: row.skipped_jobs || 0,
            db_ok: true,
        };
    } catch (err) {
        // Table missing (migration not run yet) or database unreachable.
        return {
            on: forced, source: forced ? 'server_setting' : null, switch_on: false, forced,
            message: DEFAULT_MESSAGE, expected_end: null, started_at: null,
            started_by_name: null, skipped_jobs: 0, db_ok: false, db_error: err.message,
        };
    }
};

// Never throws.
const getState = async ({ fresh = false } = {}) => {
    if (!fresh && cache.state && Date.now() - cache.at < STATE_TTL_MS) return cache.state;
    const state = await readState();
    cache = { at: Date.now(), state };
    return state;
};

const isOn = async () => (await getState()).on;

// Is this request made by someone holding the Admin role? Reads the
// token itself (the route's own authenticate middleware hasn't run
// yet at this point). Never throws — any doubt = not an Admin.
const isAdminRequest = async (req) => {
    try {
        const header = req.headers?.authorization || '';
        if (!header.startsWith('Bearer ')) return false;
        const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);
        const userId = decoded?.userId;
        if (!userId) return false;
        const hit = adminCache.get(userId);
        if (hit && Date.now() - hit.at < ROLE_TTL_MS) return hit.isAdmin;
        const r = await query(`
            SELECT EXISTS (
                SELECT 1 FROM users u
                JOIN user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
                JOIN roles ro ON ro.id = ur.role_id AND ro.is_active = TRUE
                WHERE u.id = $1 AND u.is_active = TRUE AND ro.name = 'Admin'
            ) AS ok
        `, [userId]);
        const isAdmin = !!r.rows[0]?.ok;
        adminCache.set(userId, { at: Date.now(), isAdmin });
        return isAdmin;
    } catch (_) {
        return false;
    }
};

// ---- switching ----------------------------------------------------------
const setMaintenance = async ({ on, message, expectedEnd, userId }) => {
    const cur = await query('SELECT is_on FROM system_maintenance WHERE id = 1');
    const wasOn = !!cur.rows[0]?.is_on;
    const msg = (message || '').trim() || null;
    const end = expectedEnd || null;

    if (on) {
        await query(`
            UPDATE system_maintenance
            SET    is_on = TRUE, message = $1, expected_end = $2,
                   started_at = CASE WHEN is_on THEN started_at ELSE NOW() END,
                   started_by = CASE WHEN is_on THEN started_by ELSE $3 END,
                   updated_at = NOW()
            WHERE  id = 1
        `, [msg, end, userId]);
    } else {
        await query(`
            UPDATE system_maintenance
            SET    is_on = FALSE, ended_at = NOW(), ended_by = $1, updated_at = NOW()
            WHERE  id = 1
        `, [userId]);
    }
    const event = on ? (wasOn ? 'UPDATE' : 'ON') : 'OFF';
    const ev = await query(`
        INSERT INTO maintenance_events (event, message, expected_end, user_id)
        VALUES ($1, $2, $3, $4) RETURNING id
    `, [event, on ? msg : null, on ? end : null, userId]);
    invalidate();
    return { event, wasOn, eventId: ev.rows[0].id };
};

const markEmailed = async (eventId) => {
    try { await query('UPDATE maintenance_events SET emailed_members = TRUE WHERE id = $1', [eventId]); } catch (_) {}
};

// ---- nightly jobs --------------------------------------------------------
// The date a job would process if it ran now — computed exactly as the
// jobs themselves do, so a catch-up records the same date.
const jobRunDate = () => new Date().toISOString().split('T')[0];

const recordSkippedJob = async (jobName) => {
    const runDate = jobRunDate();
    try {
        await query(`
            INSERT INTO maintenance_skipped_jobs (job_name, run_date)
            VALUES ($1, $2) ON CONFLICT (job_name, run_date) DO NOTHING
        `, [jobName, runDate]);
    } catch (err) {
        logger.error('Could not record a skipped job', { jobName, error: err.message });
    }
    invalidate();
    logger.warn(`Maintenance mode is on — scheduled job "${jobName}" skipped (will be caught up when maintenance is turned off)`);
};

let catchingUp = false;

// Runs every job skipped during maintenance. Called (in the background)
// when maintenance is turned off. Oldest first; dated jobs once per date.
const catchUpSkippedJobs = async () => {
    if (catchingUp) return { alreadyRunning: true };
    catchingUp = true;
    const results = [];
    try {
        // Lazy require — the scheduler requires this file too.
        const { getJobRunner } = require('../jobs/scheduler');
        const pending = await query(`
            SELECT id, job_name, run_date::text AS run_date
            FROM   maintenance_skipped_jobs
            WHERE  caught_up_at IS NULL
            ORDER  BY run_date, id
        `);
        const doneOnce = new Set();
        for (const row of pending.rows) {
            const run = getJobRunner(row.job_name);
            let result = 'done';
            if (!run) {
                result = 'job no longer exists — nothing to run';
            } else if (!DATED_JOBS.has(row.job_name) && doneOnce.has(row.job_name)) {
                result = 'covered by the earlier catch-up run of this job';
            } else {
                try {
                    await run(DATED_JOBS.has(row.job_name) ? row.run_date : undefined);
                    doneOnce.add(row.job_name);
                } catch (err) {
                    result = `failed: ${err.message}`;
                }
            }
            await query(`UPDATE maintenance_skipped_jobs SET caught_up_at = NOW(), result = $1 WHERE id = $2`, [result, row.id]);
            results.push({ job: row.job_name, date: row.run_date, result });
        }
        if (results.length) logger.info('Maintenance catch-up finished', { results });
    } catch (err) {
        logger.error('Maintenance catch-up failed', { error: err.message });
    } finally {
        catchingUp = false;
        invalidate();
    }
    return { results };
};

// ---- admin detail ----------------------------------------------------------
const getAdminDetail = async () => {
    const state = await getState({ fresh: true });
    let events = [];
    let skipped = [];
    try {
        events = (await query(`
            SELECT e.id, e.event, e.message, e.expected_end, e.emailed_members, e.created_at,
                   u.first_name || ' ' || u.last_name AS by_name
            FROM   maintenance_events e LEFT JOIN users u ON u.id = e.user_id
            ORDER  BY e.id DESC LIMIT 30
        `)).rows;
        skipped = (await query(`
            SELECT id, job_name, run_date::text AS run_date, skipped_at, caught_up_at, result
            FROM   maintenance_skipped_jobs ORDER BY id DESC LIMIT 60
        `)).rows;
    } catch (_) { /* tables missing — shown as empty */ }
    return { ...state, events, skipped_jobs_list: skipped, default_message: DEFAULT_MESSAGE };
};

module.exports = {
    DEFAULT_MESSAGE, DATED_JOBS,
    getState, isOn, isAdminRequest, setMaintenance, markEmailed,
    recordSkippedJob, catchUpSkippedJobs, getAdminDetail, envForced, invalidate,
};
