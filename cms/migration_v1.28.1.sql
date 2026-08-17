-- ============================================================
-- MIGRATION v1.28.1 — Seed missing Meeting Agenda / Meeting Minutes
--                    document templates
--
-- "Generate Document" only ever offered Receipt and Resolution on a
-- fresh database — Meeting Agenda and Meeting Minutes are fully
-- supported end-to-end (hardcoded in GenerateDocumentPage.jsx and
-- rendered client-side by meetingAgendaTemplate()/
-- meetingMinutesTemplate() in exportUtils.js) but, unlike Receipt/
-- Resolution, never had a document_templates seed row anywhere in
-- schema.sql or a prior migration — GET /documents/templates only
-- returns rows that actually exist in that table, so these two types
-- were invisible on any database that hadn't had them created by
-- hand (e.g. via the local dev database's own manual testing).
--
-- Safe to run on a database that already has these rows — uses the
-- same idempotent NOT EXISTS guard as schema.sql (no unique
-- constraint exists on document_templates.template_type).
-- ============================================================

BEGIN;

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

COMMIT;
