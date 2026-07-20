// ============================================================
// EMAIL CONFIGURATION
// Uses Nodemailer with Gmail SMTP.
// To use Gmail SMTP you must:
//   1. Enable 2-Step Verification on your Google account
//   2. Generate an App Password (Google Account > Security > App Passwords)
//   3. Use that App Password as GMAIL_APP_PASSWORD in your .env
// ============================================================

const nodemailer = require('nodemailer');
const logger = require('./logger');

// Create the Gmail transporter (reusable across the app)
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
    },
});

// Verify connection on startup
const verifyEmailConnection = async () => {
    try {
        await transporter.verify();
        logger.info('✅ Email (Gmail SMTP) connection verified');
        return true;
    } catch (err) {
        logger.error('❌ Email connection failed:', { error: err.message });
        return false;
    }
};

// ============================================================
// SEND EMAIL HELPER
// All email sending in the app goes through this function.
// This gives us one place to add logging, retries, or
// switch providers later without touching every caller.
//
// Usage:
//   await sendEmail({
//       to: 'user@example.com',
//       subject: 'Monthly Report',
//       html: '<h1>Your report</h1>',
//       attachments: [{ filename: 'report.pdf', path: '/path/to/file' }]
//   });
// ============================================================
const sendEmail = async ({ to, subject, html, text, attachments = [] }) => {
    // Lazily required to avoid a require-cycle at module load time
    // (emailTemplates.js only needs the database, so this direction is safe).
    const { getBranding } = require('../services/emailTemplates');
    let companyName = process.env.COMPANY_NAME || 'Company Management System';
    try {
        const branding = await getBranding();
        companyName = branding.company_name || companyName;
    } catch {
        // Fall back to the env var name above if Settings > Company can't be read
    }

    const mailOptions = {
        from: `"${companyName}" <${process.env.GMAIL_USER}>`,
        to,
        subject,
        html,
        text: text || html.replace(/<[^>]*>/g, ''), // fallback plain text
        attachments,
    };

    try {
        const info = await transporter.sendMail(mailOptions);
        logger.info('Email sent successfully', {
            to,
            subject,
            messageId: info.messageId,
        });
        return { success: true, messageId: info.messageId };
    } catch (err) {
        logger.error('Failed to send email', { to, subject, error: err.message });
        return { success: false, error: err.message };
    }
};

// ============================================================
// SEND BULK EMAILS
// Sends to multiple recipients individually (not as CC/BCC)
// so each person gets a personalised email.
// ============================================================
const sendBulkEmail = async (recipients, subjectFn, htmlFn) => {
    const results = [];
    for (const recipient of recipients) {
        const result = await sendEmail({
            to: recipient.email,
            subject: subjectFn(recipient),
            html: htmlFn(recipient),
        });
        results.push({ email: recipient.email, ...result });
        // Small delay between sends to avoid Gmail rate limits
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    return results;
};

module.exports = { transporter, verifyEmailConnection, sendEmail, sendBulkEmail };
