const nodemailer = require('nodemailer');
const { getSetting, setSetting } = require('./db');

const TIMEZONE = process.env.EVENT_TIMEZONE || 'Asia/Karachi';

function getMailConfig() {
  const user = getSetting('smtp_user') || process.env.SMTP_USER || '';
  const pass = getSetting('smtp_pass') || process.env.SMTP_PASS || '';
  const host = getSetting('smtp_host') || process.env.SMTP_HOST || '';
  const port = Number(getSetting('smtp_port') || process.env.SMTP_PORT || 587);
  const secure = (getSetting('smtp_secure') ?? process.env.SMTP_SECURE) === 'true' || port === 465;
  const fromName = getSetting('mail_from_name') || process.env.MAIL_FROM_NAME || 'CAIPSD Events - The Islamia University of Bahawalpur';
  const fromEmail = getSetting('mail_from') || process.env.MAIL_FROM || user || 'admin@caipsd.org';

  return {
    configured: process.env.SMTP_JSON === '1' || Boolean(user && pass),
    user,
    pass,
    host,
    port,
    secure,
    fromName,
    fromEmail
  };
}

function createTransport() {
  if (process.env.SMTP_JSON === '1') return nodemailer.createTransport({ jsonTransport: true }); // used by tests
  const cfg = getMailConfig();
  if (!cfg.user || !cfg.pass) return null;
  if (!cfg.host || cfg.host.includes('gmail')) {
    return nodemailer.createTransport({
      service: 'gmail',
      auth: { user: cfg.user, pass: cfg.pass }
    });
  }
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass }
  });
}

async function verifyMailConfig(user, pass, host, port) {
  const transport = !host || host.includes('gmail')
    ? nodemailer.createTransport({ service: 'gmail', auth: { user, pass } })
    : nodemailer.createTransport({ host, port: Number(port || 587), auth: { user, pass } });
  await transport.verify();
  return true;
}

function mailConfigured() {
  return process.env.SMTP_JSON === '1' || getMailConfig().configured;
}

function fromAddress() {
  const cfg = getMailConfig();
  const sender = cfg.fromEmail;
  return /</.test(sender) ? sender : `"${cfg.fromName}" <${sender}>`;
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function formatWhen(iso) {
  return new Date(iso).toLocaleString('en-GB', {
    timeZone: TIMEZONE,
    weekday: 'short',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
}

function buildMessage(ticket, qrPng) {
  const validUntil = formatWhen(ticket.valid_until);
  const link = process.env.APP_URL ? `${process.env.APP_URL.replace(/\/$/, '')}/ticket.html?code=${ticket.ticket_code}` : '';
  const text = [
    `Hello ${ticket.full_name},`, '',
    'Your CAIPSD event ticket is ready.', '',
    `Ticket ID: ${ticket.ticket_code}`,
    `Valid until: ${validUntil}`, '',
    'Show the attached QR code (or the ticket ID) at the entrance. You can re-enter any time while the ticket is valid.',
    link ? `\nView your ticket online: ${link}` : '', '',
    'CAIPSD Events - The Islamia University of Bahawalpur'
  ].join('\n');

  const html = `<!doctype html><html><body style="margin:0;background:#f3f5f8;font-family:Arial,Helvetica,sans-serif;color:#18243a">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:28px 12px"><tr><td align="center">
    <table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e8ee;box-shadow:0 4px 16px rgba(0,0,0,0.06)">
      <tr><td style="background:linear-gradient(135deg, #1c304e 0%, #162740 100%);color:#ffffff;padding:26px 28px;border-bottom:3px solid #f59d14">
        <div style="font-size:11px;letter-spacing:2px;color:#f59d14;font-weight:700;text-transform:uppercase">The Islamia University of Bahawalpur</div>
        <div style="font-size:22px;font-weight:800;margin-top:6px;letter-spacing:-0.5px">CAIPSD Event Ticket</div>
        <div style="font-size:13px;color:#94a3b8;margin-top:2px">Official Admission & QR Pass</div>
      </td></tr>
      <tr><td style="padding:26px 28px">
        <p style="margin:0 0 14px;font-size:15px">Hello <strong>${esc(ticket.full_name)}</strong>,</p>
        <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#4a566b">Your official event ticket is confirmed. Show the QR pass below at the entrance for camera verification. It stays valid until <strong>${esc(validUntil)}</strong>.</p>
        <div style="text-align:center;padding:20px;border:2px dashed #2b5fdc;background:#f8fafc;border-radius:12px">
          <img src="cid:ticket-qr" width="220" height="220" alt="Ticket QR code" style="display:block;margin:0 auto;border-radius:8px">
          <div style="margin-top:14px;font-family:Consolas,monospace;font-size:17px;letter-spacing:3px;font-weight:800;color:#1c304e">${esc(ticket.ticket_code)}</div>
          <div style="margin-top:4px;font-size:12px;color:#64748b;font-weight:600">Scan at entrance for fast check-in</div>
        </div>
        ${link ? `<p style="text-align:center;margin:24px 0 0"><a href="${esc(link)}" style="background:#2b5fdc;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:6px;font-size:13px;font-weight:700;display:inline-block">View Ticket Online & Download Pass</a></p>` : ''}
      </td></tr>
      <tr><td style="padding:16px 28px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:12px;color:#64748b;text-align:center">
        This ticket is issued by CAIPSD, The Islamia University of Bahawalpur. Please do not share this QR pass with others.
      </td></tr>
    </table></td></tr></table></body></html>`;

  return {
    from: fromAddress(),
    to: ticket.email,
    subject: `Your CAIPSD Event Pass - ${ticket.ticket_code}`,
    text,
    html,
    attachments: [{ filename: `caipsd-ticket-${ticket.ticket_code}.png`, content: qrPng, cid: 'ticket-qr', contentType: 'image/png' }]
  };
}

async function sendTicketEmail(ticket, qrPng) {
  const transport = createTransport();
  if (!transport) throw new Error('Email is not configured. Please connect your Google / Gmail account in the portal.');
  return transport.sendMail(buildMessage(ticket, qrPng));
}

async function sendTestEmail(recipient) {
  const transport = createTransport();
  if (!transport) throw new Error('Email is not configured. Please connect your Google / Gmail account in the portal.');
  const cfg = getMailConfig();
  const html = `<!doctype html><html><body style="margin:0;background:#f3f5f8;font-family:Arial,Helvetica,sans-serif;color:#18243a">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:28px 12px"><tr><td align="center">
    <table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e8ee;box-shadow:0 4px 16px rgba(0,0,0,0.06)">
      <tr><td style="background:linear-gradient(135deg, #1c304e 0%, #162740 100%);color:#ffffff;padding:26px 28px;border-bottom:3px solid #f59d14">
        <div style="font-size:11px;letter-spacing:2px;color:#f59d14;font-weight:700;text-transform:uppercase">The Islamia University of Bahawalpur</div>
        <div style="font-size:22px;font-weight:800;margin-top:6px;letter-spacing:-0.5px">CAIPSD Event System</div>
        <div style="font-size:13px;color:#94a3b8;margin-top:2px">Email Integration Test</div>
      </td></tr>
      <tr><td style="padding:26px 28px">
        <p style="margin:0 0 14px;font-size:15px;color:#16a34a;font-weight:700">✓ Google Account Connected Successfully!</p>
        <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#4a566b">Your Google / Gmail account (<strong>${esc(cfg.user)}</strong>) is now connected with the CAIPSD Event Management Portal.</p>
        <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#4a566b">You can now send tickets and QR passes to individual students, or email all registered students with <strong>1-Click</strong> directly from the portal desk.</p>
        <div style="padding:14px 18px;background:#f8fafc;border-left:4px solid #2b5fdc;border-radius:6px;font-size:13px;color:#334155">
          <strong>Connected sender:</strong> ${esc(cfg.fromName)} &lt;${esc(cfg.user)}&gt;<br>
          <strong>Timestamp:</strong> ${esc(new Date().toLocaleString('en-GB', { timeZone: TIMEZONE }))}
        </div>
      </td></tr>
      <tr><td style="padding:16px 28px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:12px;color:#64748b;text-align:center">
        This is an automated test message from the CAIPSD Event Management System.
      </td></tr>
    </table></td></tr></table></body></html>`;

  return transport.sendMail({
    from: fromAddress(),
    to: recipient,
    subject: 'CAIPSD Event System - Google Account Connected Successfully',
    text: `Your Google / Gmail account (${cfg.user}) is now connected with the CAIPSD Event Management Portal. You can now email tickets and QR admission passes to students.`,
    html
  });
}

module.exports = {
  getMailConfig,
  createTransport,
  verifyMailConfig,
  mailConfigured,
  sendTicketEmail,
  sendTestEmail,
  buildMessage,
  fromAddress
};
