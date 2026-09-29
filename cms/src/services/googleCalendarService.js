// ============================================================
// GOOGLE CALENDAR / MEET SERVICE (v1.63.0)
// One place that talks to the Google Calendar API — mirrors
// storageService.js's shape: a single choke point with a graceful
// "not configured yet" fallback (isGoogleConfigured), so callers
// never need to know or care whether the company has actually
// connected Google Calendar.
//
// Uses `google-auth-library` (small — just the OAuth2 client) for the
// consent flow and token refresh, and Node's own built-in `fetch` for
// the actual Calendar API v3 REST calls, rather than the full
// `googleapis` package — that package bundles typings/clients for
// every single Google API and is well over 100MB installed, for
// functionality this service only ever needs three REST endpoints of.
//
// HOW THE MEET LINK GETS CREATED:
// Google doesn't offer a "just give me a Meet link" endpoint — a Meet
// link only exists as part of a real Calendar event. So "auto-create
// an online meeting" here means: create a Calendar event (on the
// connected Google account's own calendar) with `conferenceData`
// requested, and Google generates + attaches the Meet link to it.
// The Calendar event's own id (google_calendar_event_id, stored on
// our `events` row) is what lets us patch its time later (extendEvent)
// or delete it (cancelEvent) instead of leaving an orphaned entry on
// someone's real Google Calendar.
//
// AUTH MODEL:
// GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are the OAuth app's own
// static credentials (obtained once from Google Cloud Console) — env
// vars, same convention as S3_*/GMAIL_*. The refresh_token is
// different: it's generated per-installation by a live OAuth consent
// flow (an Admin authorizing this app against the company's Google
// account via Settings > Integrations), so it lives in the
// google_calendar_settings DB row instead — there's no provider
// dashboard value an Admin could paste into an env var for this one.
// A fresh OAuth2Client is built per call and handed the stored
// refresh_token; calling .getAccessToken() transparently exchanges it
// for a short-lived access token, so nothing here ever has to manage
// access-token expiry itself.
// ============================================================

const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const { query } = require('../config/database');
const logger = require('../config/logger');

const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];
const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';

// ============================================================
// IS GOOGLE CONFIGURED
// True only once BOTH halves exist: the OAuth app's own client
// id/secret (env vars, set once at deploy time) AND a stored
// refresh_token (set once an Admin completes the consent flow).
// Either half missing means "not connected yet" — callers treat that
// as a normal, expected state, not an error.
// ============================================================
const isGoogleConfigured = async () => {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
        return false;
    }
    const result = await query(
        'SELECT is_connected, refresh_token FROM google_calendar_settings WHERE id = 1'
    );
    const row = result.rows[0];
    return !!(row && row.is_connected && row.refresh_token);
};

// ============================================================
// BUILD AN OAUTH2 CLIENT
// `redirectUri` is only meaningful for the consent-flow calls
// (getAuthUrl/handleOAuthCallback) — a client built for ordinary API
// calls (creating/updating/deleting events) doesn't redirect anywhere,
// it just needs the refresh_token as its credentials.
// ============================================================
const buildOAuthClient = (redirectUri) => {
    return new OAuth2Client(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        redirectUri
    );
};

// The backend's own callback route Google redirects back to once the
// Admin grants (or denies) consent.
const getRedirectUri = () => {
    // A fully-qualified, publicly-reachable backend URL is unavoidable
    // here — Google itself (not the frontend) navigates the browser to
    // this address, so a relative path won't do. On Render this is
    // covered automatically: RENDER_EXTERNAL_URL is a built-in env var
    // every Render web service gets for free, already set to that
    // service's own public onrender.com address — no manual setup
    // needed. BACKEND_URL is only for the two cases that don't cover:
    // local development (RENDER_EXTERNAL_URL doesn't exist outside
    // Render) and a backend later given its own custom domain
    // (RENDER_EXTERNAL_URL always reports the onrender.com address,
    // never a custom one). Whichever value resolves, it must match,
    // character-for-character, one of the "Authorized redirect URIs"
    // configured on the OAuth Client ID in Google Cloud Console —
    // Settings > Integrations shows the exact value to paste there.
    const base = process.env.BACKEND_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:5000';
    return `${base.replace(/\/$/, '')}/api/settings/google/callback`;
};

// ============================================================
// GET AUTH URL
// Builds the Google consent-screen URL an Admin is sent to from
// Settings > Integrations > Connect. `state` carries the initiating
// Admin's user id, signed with the app's own JWT_SECRET (same secret
// already used for login tokens) so the callback — a plain browser
// redirect from Google, with no Authorization header of its own — can
// verify who to record as `connected_by` without trusting an
// unsigned value an attacker could forge by just visiting the
// callback URL directly.
// access_type: 'offline' + prompt: 'consent' is what makes Google
// actually issue a refresh_token — without both, a user who's
// authorized this app before (even for a different scope) gets no
// refresh_token on a repeat consent, only a short-lived access token.
// ============================================================
const getAuthUrl = (adminUserId) => {
    const oauth2Client = buildOAuthClient(getRedirectUri());
    const state = jwt.sign(
        { userId: adminUserId, purpose: 'google_oauth' },
        process.env.JWT_SECRET,
        { expiresIn: '10m' }
    );
    return oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: SCOPES,
        state,
    });
};

// ============================================================
// HANDLE OAUTH CALLBACK
// Exchanges the one-time `code` Google appended to the callback URL
// for tokens, verifies+decodes `state` to recover who initiated the
// connection, looks up the connected account's own email (purely for
// display on Settings > Integrations — "Connected as
// treasurer@company.org" — never used for auth), and stores the
// refresh_token. Throws on a bad/expired/tampered state or a failed
// exchange — the route calling this catches it and redirects the
// Admin back to Settings with an error flag instead of a raw 500.
// ============================================================
const handleOAuthCallback = async (code, state) => {
    let decoded;
    try {
        decoded = jwt.verify(state, process.env.JWT_SECRET);
    } catch {
        throw new Error('This authorization link has expired or is invalid — please try connecting again.');
    }
    if (decoded.purpose !== 'google_oauth') {
        throw new Error('Invalid authorization state.');
    }

    const oauth2Client = buildOAuthClient(getRedirectUri());
    const { tokens } = await oauth2Client.getToken(code);
    if (!tokens.refresh_token) {
        // Happens if the Admin had already granted consent once
        // before and Google didn't re-issue a refresh_token this
        // time (shouldn't occur given prompt:'consent' above, but
        // guard anyway rather than silently storing nothing usable).
        throw new Error(
            'Google did not return a long-lived connection this time. ' +
            'In your Google Account, remove this app\'s existing access ' +
            '(myaccount.google.com > Security > Third-party access) and try connecting again.'
        );
    }

    // Best-effort — just for a friendly "Connected as ___" display.
    let email = null;
    try {
        const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { Authorization: `Bearer ${tokens.access_token}` },
        });
        if (res.ok) {
            const info = await res.json();
            email = info.email || null;
        }
    } catch (err) {
        logger.warn('Could not fetch Google account email after connecting', { error: err.message });
    }

    await query(`
        UPDATE google_calendar_settings
        SET    is_connected         = TRUE,
               refresh_token        = $1,
               google_account_email = $2,
               connected_by         = $3,
               connected_at         = NOW()
        WHERE  id = 1
    `, [tokens.refresh_token, email, decoded.userId]);

    return { email, userId: decoded.userId };
};

// ============================================================
// DISCONNECT
// Clears the stored refresh_token. Existing events keep whatever
// meeting_link they already have (a Meet link, once created, keeps
// working on Google's side regardless of this app's own connection
// state) — only future create/update/delete calls stop happening.
// ============================================================
const disconnect = async () => {
    await query(`
        UPDATE google_calendar_settings
        SET    is_connected         = FALSE,
               refresh_token        = NULL,
               google_account_email = NULL,
               connected_by         = NULL,
               connected_at         = NULL
        WHERE  id = 1
    `);
};

// ============================================================
// GET STATUS (for Settings > Integrations)
// Never returns the refresh_token itself.
// ============================================================
const getStatus = async () => {
    const result = await query(`
        SELECT gcs.is_connected, gcs.google_account_email, gcs.calendar_id,
               gcs.connected_at,
               u.first_name || ' ' || u.last_name AS connected_by_name
        FROM   google_calendar_settings gcs
        LEFT JOIN users u ON u.id = gcs.connected_by
        WHERE  gcs.id = 1
    `);
    const row = result.rows[0] || {};
    return {
        connected:         !!row.is_connected,
        google_account_email: row.google_account_email || null,
        calendar_id:       row.calendar_id || 'primary',
        connected_at:      row.connected_at || null,
        connected_by_name: row.connected_by_name || null,
        redirect_uri:      getRedirectUri(), // shown read-only so an Admin can copy it into Google Cloud Console
    };
};

// ============================================================
// GET A VALID ACCESS TOKEN + CALENDAR ID
// Internal helper — loads the stored refresh_token, exchanges it for
// a fresh access token (google-auth-library handles the actual token
// refresh HTTP call), and returns everything callCalendarApi() needs.
// Throws if not configured; every exported create/update/delete
// function below lets that throw propagate to its own caller
// (eventsController), which always wraps these calls in a try/catch —
// a Google failure must never block the underlying event's own
// create/edit/cancel from succeeding.
// ============================================================
const getAccessTokenAndCalendarId = async () => {
    const result = await query(
        'SELECT refresh_token, calendar_id FROM google_calendar_settings WHERE id = 1'
    );
    const row = result.rows[0];
    if (!row || !row.refresh_token) {
        throw new Error('Google Calendar is not connected');
    }
    const oauth2Client = buildOAuthClient();
    oauth2Client.setCredentials({ refresh_token: row.refresh_token });
    const { token } = await oauth2Client.getAccessToken();
    if (!token) {
        throw new Error('Could not obtain a Google access token — the stored connection may have been revoked');
    }
    return { accessToken: token, calendarId: row.calendar_id || 'primary' };
};

// ============================================================
// CALL CALENDAR API
// Thin wrapper around fetch for the Calendar v3 REST endpoints this
// service needs — same idea as config/email.js's sendEmail() being
// the one place mail actually goes out. Takes an already-resolved
// accessToken (rather than resolving one itself) so a caller that
// needs the calendarId too — every exported function below does —
// only pays for one getAccessTokenAndCalendarId() call, not two.
// ============================================================
const callCalendarApi = async (accessToken, path, { method = 'GET', body, query: qs } = {}) => {
    const url = new URL(`${CALENDAR_API_BASE}${path}`);
    if (qs) Object.entries(qs).forEach(([k, v]) => url.searchParams.set(k, v));

    const res = await fetch(url.toString(), {
        method,
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        const err = new Error(errBody.error?.message || `Google Calendar API error (${res.status})`);
        err.status = res.status;
        throw err;
    }
    if (res.status === 204) return null; // DELETE returns no body
    return res.json();
};

// ============================================================
// CREATE MEETING FOR EVENT
// Called from eventsController.createEvent (best-effort, after the
// event row itself is already committed) whenever is_online is true
// and no manual meeting_link was given. Returns
// { meetingLink, googleCalendarEventId } on success. Callers wrap
// this in their own try/catch — a Google-side failure (not connected,
// API error, expired/revoked consent) must never prevent the event
// itself from being created; it just means meeting_provider stays
// unset and the Secretary can paste a link in by hand instead.
// ============================================================
const createMeetingForEvent = async ({ title, description, startTime, endTime }) => {
    const { accessToken, calendarId } = await getAccessTokenAndCalendarId();

    const data = await callCalendarApi(accessToken, `/calendars/${encodeURIComponent(calendarId)}/events`, {
        method: 'POST',
        query: { conferenceDataVersion: 1 }, // required for Google to actually attach a Meet link
        body: {
            summary: title,
            description: description || undefined,
            start: { dateTime: new Date(startTime).toISOString() },
            // Google requires an end time; default to +1h when the event has none.
            end: { dateTime: new Date(endTime || new Date(startTime).getTime() + 60 * 60 * 1000).toISOString() },
            conferenceData: {
                createRequest: {
                    requestId: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    conferenceSolutionKey: { type: 'hangoutsMeet' },
                },
            },
        },
    });

    const meetingLink = data.hangoutLink || data.conferenceData?.entryPoints?.[0]?.uri || null;
    if (!meetingLink) {
        throw new Error('Google Calendar did not return a Meet link');
    }
    return { meetingLink, googleCalendarEventId: data.id };
};

// ============================================================
// UPDATE MEETING TIME
// Called from editEvent (while still DRAFT) / extendEvent (once
// APPROVED) whenever the event already has a google_calendar_event_id
// and its date/time changed — keeps the real Calendar event (and
// therefore what attendees see on their own calendars) in sync rather
// than leaving it pointing at the old time.
// ============================================================
const updateMeetingForEvent = async (googleCalendarEventId, { title, startTime, endTime }) => {
    const { accessToken, calendarId } = await getAccessTokenAndCalendarId();
    const patch = {};
    if (title) patch.summary = title;
    if (startTime) patch.start = { dateTime: new Date(startTime).toISOString() };
    if (endTime) patch.end = { dateTime: new Date(endTime).toISOString() };

    await callCalendarApi(
        accessToken,
        `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(googleCalendarEventId)}`,
        { method: 'PATCH', body: patch }
    );
};

// ============================================================
// DELETE MEETING
// Called from cancelEvent, and from editEvent when a draft is
// switched from online back to in-person. 404 (already gone on
// Google's side — e.g. someone deleted it manually from their own
// Calendar) is swallowed as a success, since the end state either way
// is "no meeting exists" — everything else propagates so the caller's
// own best-effort try/catch can decide what to do.
// ============================================================
const deleteMeetingForEvent = async (googleCalendarEventId) => {
    const { accessToken, calendarId } = await getAccessTokenAndCalendarId();
    try {
        await callCalendarApi(
            accessToken,
            `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(googleCalendarEventId)}`,
            { method: 'DELETE' }
        );
    } catch (err) {
        if (err.status === 404 || err.status === 410) return; // already gone — treat as success
        throw err;
    }
};

module.exports = {
    isGoogleConfigured,
    getAuthUrl,
    handleOAuthCallback,
    disconnect,
    getStatus,
    createMeetingForEvent,
    updateMeetingForEvent,
    deleteMeetingForEvent,
};
