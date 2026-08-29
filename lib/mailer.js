// lib/mailer.js — outbound email via SMTP (v0.90)
// Reads config from env vars. When SMTP_HOST is absent the function logs only
// (preserves the existing dev/test behaviour without breaking anything).
//
// Required env vars (all optional — absent = log-only mode):
//   SMTP_HOST     e.g. smtp.sendgrid.net
//   SMTP_PORT     default 587
//   SMTP_SECURE   'true' for port 465 TLS; default false (STARTTLS on 587)
//   SMTP_USER     SMTP auth username
//   SMTP_PASS     SMTP auth password / API key
//   SMTP_FROM     Sender address, e.g. "Bread App <bread@instacart.com>"

'use strict';

const nodemailer = require('nodemailer');

let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;
  const host = process.env.SMTP_HOST;
  if (!host) return null; // log-only mode

  _transporter = nodemailer.createTransport({
    host,
    port:   Number(process.env.SMTP_PORT  || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  return _transporter;
}

/**
 * Send an email.
 *
 * @param {object} opts
 * @param {string}   opts.to                 Recipient address
 * @param {string}   opts.subject
 * @param {string}   opts.text               Plain-text body
 * @param {string}   [opts.html]             HTML body (optional)
 * @param {Buffer}   [opts.attachmentBuffer] Binary content of attachment
 * @param {string}   [opts.attachmentName]   Filename for the attachment
 * @returns {Promise<{sent: boolean, messageId?: string, error?: string}>}
 */
async function sendMail({ to, subject, text, html, attachmentBuffer, attachmentName }) {
  const from = process.env.SMTP_FROM || 'Bread App <bread@instacart.com>';
  const transport = getTransporter();

  if (!transport) {
    // Log-only mode — SMTP not configured.
    console.log(`📧 [email log-only — set SMTP_HOST to send for real] To: ${to} · Subject: ${subject}`);
    return { sent: false };
  }

  const attachments = [];
  if (attachmentBuffer && attachmentName) {
    attachments.push({ filename: attachmentName, content: attachmentBuffer });
  }

  try {
    const info = await transport.sendMail({ from, to, subject, text, html, attachments });
    console.log(`📧 [email sent] To: ${to} · Subject: ${subject} · messageId: ${info.messageId}`);
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    console.error(`📧 [email failed] To: ${to} · Subject: ${subject} · Error: ${err.message}`);
    return { sent: false, error: err.message };
  }
}

module.exports = { sendMail };
