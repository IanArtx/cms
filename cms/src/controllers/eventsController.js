// ============================================================
// EVENTS CONTROLLER
// Handles all company event management.
//
// HANDLES:
//   - Creating and managing company events
//   - Event approval workflow
//   - Email notifications to prescribed parties on approval
//   - Recurring events
//   - Linking events to documents
// ============================================================

const { query, withTransaction } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess, sendCreated, sendPaginated, getPagination } = require('../utils/response');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');
const { generateReference, linkReferenceToRecord, MODULE_CODES } = require('../services/referenceService');
const { sendEmail, sendBulkEmail } = require('../config/email');
const { notify } = require('../services/notificationService');
const { getBranding } = require('../services/emailTemplates');
const googleCalendarService = require('../services/googleCalendarService');
const logger = require('../config/logger');
const { assertNotOwnRecord } = require('../services/approvalGuard'); // v1.72.0

// ============================================================
// CREATE EVENT
// POST /api/events
// ============================================================
const createEvent = asyncHandler(async (req, res) => {
    const {
        event_type_id,
        category_id,
        title,
        description,
        location,
        event_date,
        end_date,
        recurrence,
        notifications,
        // v1.63.0 — online meeting + "notify everyone" audience
        is_online,
        meeting_link,      // manual override — if given, no Google Meet auto-creation is attempted
        notify_all_users,
    } = req.body;

    // Captured inside the transaction, used just after it commits —
    // the Google Meet call below is a slow external network request
    // that must never happen while holding the transaction's DB client.
    let created = null;

    await withTransaction(async (client) => {
        // Verify event type exists
        const eventType = await client.query(
            'SELECT id, name, abbreviation FROM event_types WHERE id = $1 AND is_active = TRUE',
            [event_type_id]
        );
        if (eventType.rows.length === 0) {
            throw createError.notFound('Event type not found');
        }

        // Generate event reference: EVT-MTG-YYYYMM-00001
        const { referenceId, referenceCode } = await generateReference(
            client,
            MODULE_CODES.EVENT,
            eventType.rows[0].abbreviation,
            'EVENT',
            req.user.id
        );

        // Create the event
        const result = await client.query(`
            INSERT INTO events (
                reference_id,
                event_type_id,
                category_id,
                title,
                description,
                location,
                event_date,
                end_date,
                recurrence,
                status,
                is_online,
                meeting_link,
                meeting_provider,
                notify_all_users,
                created_by
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, 'DRAFT', $10, $11, $12, $13, $14
            )
            RETURNING id
        `, [
            referenceId,
            event_type_id,
            category_id,
            title.trim(),
            description || null,
            location || null,
            event_date,
            end_date || null,
            recurrence || 'NONE',
            !!is_online,
            meeting_link || null,
            meeting_link ? 'MANUAL' : null, // a link typed in here is always manual — auto-created ones are added after commit, below
            !!notify_all_users,
            req.user.id,
        ]);

        const eventId = result.rows[0].id;
        await linkReferenceToRecord(client, referenceId, eventId);

        // Add notification recipients if provided
        if (notifications && notifications.length > 0) {
            for (const notification of notifications) {
                await client.query(`
                    INSERT INTO event_notifications (
                        event_id,
                        user_id,
                        role_id,
                        email_override,
                        notification_type
                    ) VALUES ($1, $2, $3, $4, $5)
                `, [
                    eventId,
                    notification.user_id || null,
                    notification.role_id || null,
                    notification.email_override || null,
                    notification.notification_type || 'EMAIL',
                ]);
            }
        }

        // Create approval workflow
        await client.query(`
            INSERT INTO approval_workflows (
                workflow_type, record_type, record_id,
                required_approvals, initiated_by
            ) VALUES ('EVENT', 'events', $1, 1, $2)
        `, [eventId, req.user.id]);

        await logAction(req.user.id, ACTIONS.EVENT_CREATED, MODULES.EVENTS, {
            ipAddress:   req.ip,
            recordType:  'events',
            recordId:    eventId,
            newValues:   { referenceCode, title, event_date, is_online: !!is_online },
            description: `Event created: ${referenceCode} — ${title}`,
            client,
        });

        created = { eventId, referenceCode, title: title.trim(), description, event_date, end_date };
    });

    // --------------------------------------------------------
    // AUTO-CREATE GOOGLE MEET LINK (v1.63.0) — best-effort, after the
    // event itself is already safely committed. Only attempted when
    // the event is online AND no manual link was already given above.
    // A Google-side failure (not connected, API error, revoked
    // consent) never fails event creation — it just leaves
    // meeting_link/meeting_provider unset, same as an ordinary
    // in-person event, and the Secretary can paste a link in by hand
    // via PATCH /events/:id while it's still DRAFT.
    // --------------------------------------------------------
    let finalMeetingLink = meeting_link || null;
    let finalMeetingProvider = meeting_link ? 'MANUAL' : null;
    if (is_online && !meeting_link) {
        try {
            if (await googleCalendarService.isGoogleConfigured()) {
                const { meetingLink, googleCalendarEventId } = await googleCalendarService.createMeetingForEvent({
                    title: created.title,
                    description: created.description,
                    startTime: created.event_date,
                    endTime: created.end_date,
                });
                await query(`
                    UPDATE events
                    SET    meeting_link = $1, meeting_provider = 'GOOGLE_MEET', google_calendar_event_id = $2
                    WHERE  id = $3
                `, [meetingLink, googleCalendarEventId, created.eventId]);
                finalMeetingLink = meetingLink;
                finalMeetingProvider = 'GOOGLE_MEET';
            }
        } catch (err) {
            logger.error('Failed to auto-create Google Meet link for event', {
                eventId: created.eventId, error: err.message,
            });
        }
    }

    sendCreated(res, {
        event_id:  created.eventId,
        reference: created.referenceCode,
        title:     created.title,
        event_date: created.event_date,
        status:    'DRAFT',
        is_online: !!is_online,
        meeting_link: finalMeetingLink,
        meeting_provider: finalMeetingProvider,
    }, `Event created. Reference: ${created.referenceCode}`);
});

// ============================================================
// EDIT EVENT (before approval)
// PATCH /api/events/:id
// Only while still DRAFT. Editable by whoever created it, or
// anyone who could approve it. Recipients/notifications aren't
// editable here — cancel and recreate if those need to change.
// ============================================================
const editEvent = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const {
        event_type_id, category_id, title, description,
        location, event_date, end_date, recurrence,
        // v1.63.0
        is_online, meeting_link, notify_all_users,
    } = req.body;

    let event, updatedEvent;

    await withTransaction(async (client) => {
        const existing = await client.query(
            'SELECT * FROM events WHERE id = $1 FOR UPDATE', [id]
        );
        if (existing.rows.length === 0) {
            throw createError.notFound('Event not found');
        }
        event = existing.rows[0];

        if (event.status !== 'DRAFT') {
            throw createError.badRequest('Only a draft event can be edited');
        }

        const isCreator = event.created_by === req.user.id;
        const canApprove = (req.user.permissions || []).includes('EVENT_APPROVE');
        if (!isCreator && !canApprove) {
            throw createError.forbidden(
                'Only the person who created this event, or someone who can approve it, can edit it'
            );
        }

        if (event_type_id) {
            const eventType = await client.query(
                'SELECT id FROM event_types WHERE id = $1 AND is_active = TRUE', [event_type_id]
            );
            if (eventType.rows.length === 0) {
                throw createError.notFound('Event type not found');
            }
        }

        // v1.63.0 — a manually-typed meeting_link always wins over
        // whatever's already there (including a prior Google-created
        // one — see the reconciliation block after commit, which
        // deletes the old Calendar event when that happens). Leaving
        // meeting_link out of the request body entirely means "no
        // change"; explicitly clearing is_online is what removes it.
        const nextIsOnline = is_online !== undefined ? !!is_online : event.is_online;
        let nextMeetingLink = event.meeting_link;
        let nextMeetingProvider = event.meeting_provider;
        if (!nextIsOnline) {
            nextMeetingLink = null;
            nextMeetingProvider = null;
        } else if (meeting_link !== undefined) {
            nextMeetingLink = meeting_link || null;
            nextMeetingProvider = meeting_link ? 'MANUAL' : null;
        }

        const updated = await client.query(`
            UPDATE events
            SET    event_type_id = COALESCE($1, event_type_id),
                   category_id   = COALESCE($2, category_id),
                   title         = COALESCE($3, title),
                   description   = COALESCE($4, description),
                   location      = COALESCE($5, location),
                   event_date    = COALESCE($6, event_date),
                   end_date      = $7,
                   recurrence    = COALESCE($8, recurrence),
                   is_online     = $9,
                   meeting_link  = $10,
                   meeting_provider = $11,
                   notify_all_users = COALESCE($12, notify_all_users),
                   -- A manual link (or turning is_online off) always
                   -- detaches any previously auto-created Calendar
                   -- event — the reconciliation block below is what
                   -- actually deletes it on Google's side; this just
                   -- stops our own row from still pointing at it.
                   google_calendar_event_id = CASE
                       WHEN $11 = 'GOOGLE_MEET' THEN google_calendar_event_id
                       ELSE NULL
                   END
            WHERE  id = $13
            RETURNING *
        `, [
            event_type_id || null, category_id || null,
            title ? title.trim() : null, description !== undefined ? description : null,
            location !== undefined ? location : null, event_date || null,
            end_date !== undefined ? end_date : event.end_date,
            recurrence || null,
            nextIsOnline, nextMeetingLink, nextMeetingProvider,
            notify_all_users !== undefined ? !!notify_all_users : null,
            id,
        ]);
        updatedEvent = updated.rows[0];

        await logAction(req.user.id, ACTIONS.EVENT_UPDATED, MODULES.EVENTS, {
            ipAddress:   req.ip,
            recordType:  'events',
            recordId:    id,
            oldValues:   event,
            newValues:   updatedEvent,
            description: `Event edited before approval: ID ${id}`,
            client,
        });
    });

    // --------------------------------------------------------
    // GOOGLE CALENDAR RECONCILIATION (v1.63.0) — best-effort, after
    // commit, same reasoning as createEvent above. Three cases:
    //   1. Had a Google meeting, no longer should (turned offline, or
    //      replaced with a manual link) -> delete the old Calendar event.
    //   2. Newly online with no manual link and nothing auto-created
    //      yet -> create one now.
    //   3. Still on the same Google meeting, but the date/time or
    //      title changed -> patch it in place instead of recreating.
    // --------------------------------------------------------
    try {
        const hadGoogleMeeting = event.meeting_provider === 'GOOGLE_MEET' && event.google_calendar_event_id;
        const stillWantsThatGoogleMeeting = updatedEvent.meeting_provider === 'GOOGLE_MEET'
            && updatedEvent.google_calendar_event_id === event.google_calendar_event_id;

        if (hadGoogleMeeting && !stillWantsThatGoogleMeeting) {
            await googleCalendarService.deleteMeetingForEvent(event.google_calendar_event_id);
        }

        if (updatedEvent.is_online && !updatedEvent.meeting_link && await googleCalendarService.isGoogleConfigured()) {
            // Online, no link at all yet (manual or Google) — create one.
            const { meetingLink, googleCalendarEventId } = await googleCalendarService.createMeetingForEvent({
                title: updatedEvent.title,
                description: updatedEvent.description,
                startTime: updatedEvent.event_date,
                endTime: updatedEvent.end_date,
            });
            await query(`
                UPDATE events
                SET    meeting_link = $1, meeting_provider = 'GOOGLE_MEET', google_calendar_event_id = $2
                WHERE  id = $3
            `, [meetingLink, googleCalendarEventId, id]);
            updatedEvent.meeting_link = meetingLink;
            updatedEvent.meeting_provider = 'GOOGLE_MEET';
            updatedEvent.google_calendar_event_id = googleCalendarEventId;
        } else if (hadGoogleMeeting && stillWantsThatGoogleMeeting) {
            const dateChanged = String(event.event_date) !== String(updatedEvent.event_date)
                || String(event.end_date) !== String(updatedEvent.end_date);
            const titleChanged = event.title !== updatedEvent.title;
            if (dateChanged || titleChanged) {
                await googleCalendarService.updateMeetingForEvent(event.google_calendar_event_id, {
                    title: titleChanged ? updatedEvent.title : undefined,
                    startTime: dateChanged ? updatedEvent.event_date : undefined,
                    endTime: dateChanged ? updatedEvent.end_date : undefined,
                });
            }
        }
    } catch (err) {
        logger.error('Google Calendar reconciliation failed while editing event', {
            eventId: id, error: err.message,
        });
        // Best-effort — the event edit itself already committed successfully above.
    }

    sendSuccess(res, updatedEvent, 'Event updated');
});

// ============================================================
// APPROVE EVENT AND SEND NOTIFICATIONS
// POST /api/events/:id/approve
// On approval, emails are sent to all prescribed parties.
// ============================================================
const approveEvent = asyncHandler(async (req, res) => {
    // v1.72.0 — four-eyes rule: the creator (or the member it benefits) can't approve it; an Admin can.
    await assertNotOwnRecord(req, null, 'events', req.params.id, ['created_by'], 'event');
    const { id } = req.params;

    await withTransaction(async (client) => {
        // Get the event with full details
        const eventResult = await client.query(`
            SELECT
                e.*,
                r.reference_code,
                et.name AS event_type_name,
                u.first_name || ' ' || u.last_name AS created_by_name
            FROM   events e
            JOIN   references_registry r ON r.id  = e.reference_id
            JOIN   event_types et        ON et.id = e.event_type_id
            JOIN   users u               ON u.id  = e.created_by
            WHERE  e.id = $1
            FOR UPDATE
        `, [id]);

        if (eventResult.rows.length === 0) {
            throw createError.notFound('Event not found');
        }

        const event = eventResult.rows[0];

        if (event.status !== 'DRAFT' && event.status !== 'PENDING_APPROVAL') {
            throw createError.badRequest(
                `Event cannot be approved. Current status: ${event.status}`
            );
        }

        // Approve the event
        await client.query(`
            UPDATE events
            SET    status      = 'APPROVED',
                   approved_by = $1,
                   approved_at = NOW()
            WHERE  id = $2
        `, [req.user.id, id]);

        await client.query(`
            UPDATE approval_workflows
            SET    status            = 'APPROVED',
                   current_approvals = 1,
                   completed_at      = NOW()
            WHERE  record_type = 'events'
            AND    record_id   = $1
        `, [id]);

        // Gather all notification recipients
        const notifResult = await client.query(`
            SELECT
                en.id,
                en.notification_type,
                en.email_override,
                u.id          AS user_id,
                u.email       AS user_email,
                u.first_name  AS user_first_name,
                u.last_name   AS user_last_name
            FROM  event_notifications en
            LEFT JOIN users u ON u.id = en.user_id
            WHERE en.event_id = $1
        `, [id]);

        // Also get all users with the notified roles
        const roleNotifResult = await client.query(`
            SELECT DISTINCT
                u.id,
                u.email,
                u.first_name,
                u.last_name
            FROM  event_notifications en
            JOIN  user_roles ur ON ur.role_id = en.role_id
                               AND ur.revoked_at IS NULL
            JOIN  users u       ON u.id = ur.user_id
                               AND u.is_active = TRUE
            WHERE en.event_id = $1
            AND   en.role_id IS NOT NULL
        `, [id]);

        // v1.63.0 — "Notify Everyone" audience: every active user in
        // the system, any role, except Auditor (external, scoped to a
        // specific audit engagement — not a general company-event
        // audience, per the chosen answer when this was built).
        const everyoneResult = event.notify_all_users
            ? await client.query(`
                SELECT DISTINCT u.id, u.email, u.first_name, u.last_name
                FROM   users u
                JOIN   user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
                JOIN   roles r       ON r.id = ur.role_id
                WHERE  u.is_active = TRUE
                AND    r.name != 'Auditor'
            `)
            : { rows: [] };

        // Build recipients list
        const recipients = [];

        // Individual user notifications
        notifResult.rows.forEach(n => {
            if (n.user_email) {
                recipients.push({
                    email:      n.user_email,
                    first_name: n.user_first_name,
                    last_name:  n.user_last_name,
                    notif_id:   n.id,
                    user_id:    n.user_id || null,
                });
            }
            if (n.email_override) {
                recipients.push({
                    email:      n.email_override,
                    first_name: 'Valued',
                    last_name:  'Partner',
                    notif_id:   n.id,
                    user_id:    null, // external address, not a system user
                });
            }
        });

        // Role-based notifications
        roleNotifResult.rows.forEach(u => {
            if (!recipients.find(r => r.email === u.email)) {
                recipients.push({
                    email:      u.email,
                    first_name: u.first_name,
                    last_name:  u.last_name,
                    user_id:    u.id || null,
                });
            }
        });

        // "Notify Everyone" — same dedupe-by-email as the role-based
        // block above, so someone already on the individual/role list
        // never gets a second email just because this is also checked.
        everyoneResult.rows.forEach(u => {
            if (!recipients.find(r => r.email === u.email)) {
                recipients.push({
                    email:      u.email,
                    first_name: u.first_name,
                    last_name:  u.last_name,
                    user_id:    u.id || null,
                });
            }
        });

        // Format event date nicely
        const eventDate = new Date(event.event_date).toLocaleString('en-GB', {
            weekday: 'long',
            year:    'numeric',
            month:   'long',
            day:     'numeric',
            hour:    '2-digit',
            minute:  '2-digit',
        });

        // Send notification emails
        let emailsSent = 0;
        if (recipients.length > 0) {
            // Fetched once, outside the loop — sendBulkEmail's htmlFn runs
            // synchronously per recipient, so branding must be resolved first.
            const branding = await getBranding();
            const results = await sendBulkEmail(
                recipients,
                () => `${event.event_type_name}: ${event.title} — ${branding.company_name}`,
                (recipient) => `
                    <div style="font-family: Arial, sans-serif; max-width: 600px;">
                        <h2>${branding.company_name}</h2>
                        <h3>${event.event_type_name} Notification</h3>
                        <p>Dear ${recipient.first_name},</p>
                        <p>You are invited to / notified of the following event:</p>
                        <table style="width:100%; border-collapse:collapse; margin:16px 0;">
                            <tr>
                                <td style="padding:8px; background:#f3f4f6; font-weight:bold; width:140px;">
                                    Reference
                                </td>
                                <td style="padding:8px;">${event.reference_code}</td>
                            </tr>
                            <tr>
                                <td style="padding:8px; background:#f3f4f6; font-weight:bold;">
                                    Event
                                </td>
                                <td style="padding:8px;">${event.title}</td>
                            </tr>
                            <tr>
                                <td style="padding:8px; background:#f3f4f6; font-weight:bold;">
                                    Type
                                </td>
                                <td style="padding:8px;">${event.event_type_name}</td>
                            </tr>
                            <tr>
                                <td style="padding:8px; background:#f3f4f6; font-weight:bold;">
                                    Date & Time
                                </td>
                                <td style="padding:8px;">${eventDate}</td>
                            </tr>
                            ${event.location ? `
                            <tr>
                                <td style="padding:8px; background:#f3f4f6; font-weight:bold;">
                                    Location
                                </td>
                                <td style="padding:8px;">${event.location}</td>
                            </tr>` : ''}
                            ${event.is_online && event.meeting_link ? `
                            <tr>
                                <td style="padding:8px; background:#f3f4f6; font-weight:bold;">
                                    Join Online
                                </td>
                                <td style="padding:8px;">
                                    <a href="${event.meeting_link}" style="color:#1e3a5f;font-weight:bold;">
                                        ${event.meeting_provider === 'GOOGLE_MEET' ? 'Join Google Meet' : 'Join Meeting'}
                                    </a>
                                </td>
                            </tr>` : event.is_online ? `
                            <tr>
                                <td style="padding:8px; background:#f3f4f6; font-weight:bold;">
                                    Join Online
                                </td>
                                <td style="padding:8px;color:#6b7280;">
                                    This is an online event — a meeting link will be shared separately.
                                </td>
                            </tr>` : ''}
                            ${event.description ? `
                            <tr>
                                <td style="padding:8px; background:#f3f4f6; font-weight:bold;">
                                    Details
                                </td>
                                <td style="padding:8px;">${event.description}</td>
                            </tr>` : ''}
                        </table>
                        <p>This event was approved by ${req.user.first_name} ${req.user.last_name}.</p>
                        <hr>
                        <small>${branding.company_name}${branding.company_address ? ` — ${branding.company_address}` : ''}</small>
                    </div>
                `
            );

            emailsSent = results.filter(r => r.success).length;

            // Update notification send status
            for (const r of results) {
                await client.query(`
                    UPDATE event_notifications
                    SET    sent_at     = NOW(),
                           send_status = $1
                    WHERE  event_id = $2
                    AND    (
                        (user_id IS NOT NULL AND user_id IN (
                            SELECT id FROM users WHERE email = $3
                        ))
                        OR email_override = $3
                    )
                `, [r.success ? 'SENT' : 'FAILED', id, r.email]);
            }
        }

        // --------------------------------------------------------
        // BELL NOTIFICATIONS FOR INTERNAL USERS
        // The block above already emailed every recipient (internal
        // and external) through the event's own bespoke template —
        // this does NOT send a second email. It only adds a bell
        // notification in the generic `notifications` table for the
        // subset of recipients who are actual system users, so the
        // event invitation also shows up in their notification bell.
        // --------------------------------------------------------
        const notifiedUserIds = new Set();
        for (const recipient of recipients) {
            if (!recipient.user_id || notifiedUserIds.has(recipient.user_id)) continue;
            notifiedUserIds.add(recipient.user_id);

            notify({
                userId:     recipient.user_id,
                type:       'EVENT_NOTIFICATION',
                title:      `${event.event_type_name}: ${event.title}`,
                body:       `You are notified of an event on ${eventDate}${event.location ? ` at ${event.location}` : ''}.`,
                // v1.41.0 fix: there is no /events/:id detail route — EventsPage.jsx
                // is list-only — so this used to silently bounce to the dashboard.
                link:       `/events`,
                module:     'EVENTS',
                recordType: 'events',
                recordId:   parseInt(id),
                // No `email` block — the bulk email above already covered it.
            });
        }

        await logAction(req.user.id, ACTIONS.EVENT_APPROVED, MODULES.EVENTS, {
            ipAddress:   req.ip,
            recordType:  'events',
            recordId:    parseInt(id),
            description: `Event approved: ${event.reference_code} — ${emailsSent} notifications sent`,
            client,
        });

        sendSuccess(res, {
            status:        'APPROVED',
            reference:     event.reference_code,
            notifications_sent: emailsSent,
        }, `Event approved. ${emailsSent} notification(s) sent.`);
    });
});

// ============================================================
// CANCEL EVENT
// POST /api/events/:id/cancel
// ============================================================
const cancelEvent = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;

    const result = await query(`
        UPDATE events
        SET    status = 'CANCELLED'
        WHERE  id = $1
        AND    status NOT IN ('COMPLETED', 'CANCELLED')
        RETURNING id, title, status, meeting_provider, google_calendar_event_id
    `, [id]);

    if (result.rows.length === 0) {
        throw createError.badRequest('Event cannot be cancelled or not found');
    }

    // v1.63.0 — best-effort: don't leave an orphaned meeting sitting on
    // the connected Google account's calendar once the event itself is
    // cancelled. A failure here (not connected, already deleted by
    // someone directly on Google, API error) never blocks the
    // cancellation, which has already committed above.
    const cancelled = result.rows[0];
    if (cancelled.meeting_provider === 'GOOGLE_MEET' && cancelled.google_calendar_event_id) {
        try {
            await googleCalendarService.deleteMeetingForEvent(cancelled.google_calendar_event_id);
        } catch (err) {
            logger.error('Failed to delete Google Calendar meeting for cancelled event', {
                eventId: id, error: err.message,
            });
        }
    }

    await logAction(req.user.id, ACTIONS.EVENT_CANCELLED, MODULES.EVENTS, {
        ipAddress:   req.ip,
        recordType:  'events',
        recordId:    parseInt(id),
        description: `Event cancelled: ID ${id} — Reason: ${reason}`,
    });

    sendSuccess(res, null, 'Event cancelled successfully');
});

// ============================================================
// EXTEND EVENT
// PATCH /api/events/:id/extend
// A schedule change to an already-approved event — pushes event_date
// and/or end_date further out (extends it, doesn't reschedule it —
// dates can only move later, never earlier; use PATCH /events/:id
// while still DRAFT for a genuine reschedule before approval).
// Status stays APPROVED. Bell-notifies everyone who was on the
// original notification list so nobody shows up expecting the old
// time — reuses the same event_notifications recipients approveEvent
// emailed, but as an in-app notification only (no re-send of the
// original approval email).
// ============================================================
const extendEvent = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { event_date, end_date, reason } = req.body;

    if (!event_date && !end_date) {
        throw createError.badRequest('Provide a new event_date and/or end_date to extend to');
    }

    let extendedEvent;

    await withTransaction(async (client) => {
        const existing = await client.query(`
            SELECT e.*, r.reference_code
            FROM   events e
            JOIN   references_registry r ON r.id = e.reference_id
            WHERE  e.id = $1
            FOR UPDATE
        `, [id]);
        if (existing.rows.length === 0) {
            throw createError.notFound('Event not found');
        }
        const event = existing.rows[0];

        if (event.status !== 'APPROVED') {
            throw createError.badRequest(
                `Only an approved event can be extended. Current status: ${event.status}`
            );
        }

        const oldEventDate = new Date(event.event_date);
        const oldEndDate = event.end_date ? new Date(event.end_date) : null;
        const newEventDate = event_date ? new Date(event_date) : oldEventDate;
        const newEndDate = end_date ? new Date(end_date) : oldEndDate;

        if (newEventDate < oldEventDate) {
            throw createError.badRequest(
                'event_date can only be moved later, not earlier — this extends the event, it does not reschedule it'
            );
        }
        if (oldEndDate && newEndDate && newEndDate < oldEndDate) {
            throw createError.badRequest('end_date can only be moved later, not earlier');
        }
        if (newEndDate && newEndDate < newEventDate) {
            throw createError.badRequest('end_date cannot be before event_date');
        }

        const updated = await client.query(`
            UPDATE events
            SET    event_date = $1, end_date = $2
            WHERE  id = $3
            RETURNING *
        `, [newEventDate, newEndDate, id]);
        extendedEvent = updated.rows[0];

        await logAction(req.user.id, ACTIONS.EVENT_EXTENDED, MODULES.EVENTS, {
            ipAddress:   req.ip,
            recordType:  'events',
            recordId:    parseInt(id),
            oldValues:   { event_date: event.event_date, end_date: event.end_date },
            newValues:   { event_date: extendedEvent.event_date, end_date: extendedEvent.end_date },
            description: `Event extended: ${event.reference_code}${reason ? ` — ${reason}` : ''}`,
            client,
        });

        // Bell-notify the same people who were on the original
        // notification list (individual + role-based, same as
        // approveEvent's recipient gathering) — nobody needs a fresh
        // email for a date change, but they should see it in-app.
        const notifResult = await client.query(`
            SELECT DISTINCT u.id
            FROM   event_notifications en
            LEFT JOIN users u ON u.id = en.user_id
            WHERE  en.event_id = $1 AND en.user_id IS NOT NULL AND u.is_active = TRUE
            UNION
            SELECT DISTINCT u.id
            FROM   event_notifications en
            JOIN   user_roles ur ON ur.role_id = en.role_id AND ur.revoked_at IS NULL
            JOIN   users u       ON u.id = ur.user_id AND u.is_active = TRUE
            WHERE  en.event_id = $1 AND en.role_id IS NOT NULL
        `, [id]);

        const newEventDateStr = new Date(extendedEvent.event_date).toLocaleString('en-GB', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
        });
        for (const row of notifResult.rows) {
            notify({
                userId:     row.id,
                type:       'EVENT_EXTENDED',
                title:      `Event rescheduled: ${event.title}`,
                body:       `This event now runs ${newEventDateStr}` +
                    (extendedEvent.end_date ? ` until ${new Date(extendedEvent.end_date).toLocaleString('en-GB', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}` : '') +
                    (reason ? ` — ${reason}` : ''),
                link:       `/events`,
                module:     'EVENTS',
                recordType: 'events',
                recordId:   parseInt(id),
            });
        }
    });

    // v1.63.0 — keep an auto-created Meet link's underlying Calendar
    // event pointed at the new time, after the extension itself has
    // already committed above. Best-effort, same reasoning as
    // everywhere else in this file — a Google-side failure never
    // blocks the extension.
    if (extendedEvent.meeting_provider === 'GOOGLE_MEET' && extendedEvent.google_calendar_event_id) {
        try {
            await googleCalendarService.updateMeetingForEvent(extendedEvent.google_calendar_event_id, {
                startTime: extendedEvent.event_date,
                endTime: extendedEvent.end_date,
            });
        } catch (err) {
            logger.error('Failed to update Google Calendar meeting time for extended event', {
                eventId: id, error: err.message,
            });
        }
    }

    sendSuccess(res, extendedEvent, 'Event extended');
});

// ============================================================
// MARK EVENT AS COMPLETED
// POST /api/events/:id/complete
// Purely manual — there's no automatic "the calendar date has
// passed" job, since a multi-day or extended event can genuinely
// still be running after its originally planned date. A Secretary/
// Director marks it done once it's actually wrapped up.
// ============================================================
const completeEvent = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const result = await query(`
        UPDATE events
        SET    status = 'COMPLETED'
        WHERE  id = $1
        AND    status = 'APPROVED'
        RETURNING id, title, status
    `, [id]);

    if (result.rows.length === 0) {
        throw createError.badRequest(
            'Only an approved event can be marked completed, or event not found'
        );
    }

    await logAction(req.user.id, ACTIONS.EVENT_COMPLETED, MODULES.EVENTS, {
        ipAddress:   req.ip,
        recordType:  'events',
        recordId:    parseInt(id),
        description: `Event marked completed: ID ${id} — ${result.rows[0].title}`,
    });

    sendSuccess(res, null, 'Event marked as completed');
});

// ============================================================
// GET ALL EVENTS
// GET /api/events?status=APPROVED&from_date=2026-01-01
// ============================================================
const getAllEvents = asyncHandler(async (req, res) => {
    const { status, event_type_id, from_date, to_date } = req.query;
    const { page, limit, offset } = getPagination(req.query);

    const conditions = [];
    const params = [];
    let p = 0;

    if (status) {
        p++; conditions.push(`e.status = $${p}`);
        params.push(status.toUpperCase());
    }
    if (event_type_id) {
        p++; conditions.push(`e.event_type_id = $${p}`);
        params.push(event_type_id);
    }
    if (from_date) {
        p++; conditions.push(`e.event_date >= $${p}`);
        params.push(from_date);
    }
    if (to_date) {
        p++; conditions.push(`e.event_date <= $${p}`);
        params.push(to_date);
    }

    const where = conditions.length > 0
        ? 'WHERE ' + conditions.join(' AND ')
        : '';

    const countResult = await query(
        `SELECT COUNT(*) AS total FROM events e ${where}`, params
    );
    const total = parseInt(countResult.rows[0].total);

    params.push(limit, offset);
    const result = await query(`
        SELECT
            e.id,
            e.title,
            e.description,
            e.location,
            e.event_date,
            e.end_date,
            e.recurrence,
            e.status,
            e.is_online,
            e.meeting_link,
            e.meeting_provider,
            e.notify_all_users,
            e.created_at,
            e.created_by,
            e.category_id,
            e.event_type_id,
            r.reference_code,
            r.public_id,
            et.name      AS event_type,
            cat.name     AS category_name,
            cp.full_path AS category_trail,
            u.first_name || ' ' || u.last_name AS created_by_name,
            -- Days until event
            CASE
                WHEN e.event_date > NOW() THEN
                    EXTRACT(DAY FROM e.event_date - NOW())::integer
                ELSE NULL
            END AS days_until_event
        FROM  events e
        JOIN  references_registry r ON r.id  = e.reference_id
        JOIN  event_types et        ON et.id = e.event_type_id
        JOIN  categories cat        ON cat.id = e.category_id
        JOIN  category_paths cp     ON cp.category_id = e.category_id
        JOIN  users u               ON u.id  = e.created_by
        ${where}
        ORDER BY e.event_date ASC
        LIMIT $${p + 1} OFFSET $${p + 2}
    `, params);

    sendPaginated(res, result.rows, total, page, limit);
});

// ============================================================
// GET SINGLE EVENT WITH FULL DETAILS
// GET /api/events/:id
// ============================================================
const getEventById = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const result = await query(`
        SELECT
            e.*,
            r.reference_code,
            et.name      AS event_type,
            cat.name     AS category_name,
            cp.full_path AS category_trail,
            u.first_name  || ' ' || u.last_name AS created_by_name,
            approver.first_name || ' ' || approver.last_name AS approved_by_name,
            -- Notification recipients
            (
                SELECT json_agg(n_data ORDER BY n_data.id ASC)
                FROM (
                    SELECT
                        en.id,
                        en.notification_type,
                        en.email_override,
                        en.send_status,
                        en.sent_at,
                        nu.email      AS user_email,
                        nu.first_name AS user_first_name,
                        nu.last_name  AS user_last_name,
                        nr.name       AS role_name
                    FROM event_notifications en
                    LEFT JOIN users nu ON nu.id = en.user_id
                    LEFT JOIN roles nr ON nr.id = en.role_id
                    WHERE en.event_id = e.id
                ) n_data
            ) AS notifications
        FROM  events e
        JOIN  references_registry r ON r.id  = e.reference_id
        JOIN  event_types et        ON et.id = e.event_type_id
        JOIN  categories cat        ON cat.id = e.category_id
        JOIN  category_paths cp     ON cp.category_id = e.category_id
        JOIN  users u               ON u.id  = e.created_by
        LEFT JOIN users approver    ON approver.id = e.approved_by
        WHERE e.id = $1
    `, [id]);

    if (result.rows.length === 0) {
        throw createError.notFound('Event not found');
    }

    sendSuccess(res, result.rows[0]);
});

// ============================================================
// GET UPCOMING EVENTS (next 90 days)
// GET /api/events/upcoming
// Used by the dashboard
// ============================================================
const getUpcomingEvents = asyncHandler(async (req, res) => {
    const days = parseInt(req.query.days) || 90;

    const result = await query(`
        SELECT
            e.id,
            e.title,
            e.event_date,
            e.end_date,
            e.location,
            e.status,
            e.is_online,
            e.meeting_link,
            e.meeting_provider,
            r.reference_code,
            et.name AS event_type,
            EXTRACT(DAY FROM e.event_date - NOW())::integer AS days_until_event
        FROM  events e
        JOIN  references_registry r ON r.id  = e.reference_id
        JOIN  event_types et        ON et.id = e.event_type_id
        WHERE e.event_date BETWEEN NOW() AND NOW() + ($1 || ' days')::interval
        AND   e.status = 'APPROVED'
        ORDER BY e.event_date ASC
        LIMIT 20
    `, [days]);

    sendSuccess(res, result.rows);
});

// ============================================================
// GET ALL EVENT TYPES
// GET /api/events/types
// ============================================================
const getEventTypes = asyncHandler(async (req, res) => {
    const result = await query(
        `SELECT id, name, abbreviation, description
         FROM event_types WHERE is_active = TRUE ORDER BY name`
    );
    sendSuccess(res, result.rows);
});

module.exports = {
    createEvent,
    editEvent,
    approveEvent,
    cancelEvent,
    extendEvent,
    completeEvent,
    getAllEvents,
    getEventById,
    getUpcomingEvents,
    getEventTypes,
};