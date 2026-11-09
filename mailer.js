const nodemailer = require('nodemailer');
const { getSetting, setSetting } = require('./db');

const TIMEZONE = process.env.EVENT_TIMEZONE || 'Asia/Karachi';
// Never let a slow mail server freeze ticket creation.
const TIMEOUTS = { connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000 };

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
      auth: { user: cfg.user, pass: cfg.pass },
      ...TIMEOUTS
    });
  }
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    ...TIMEOUTS
  });
}

async function verifyMailConfig(user, pass, host, port) {
  const transport = !host || host.includes('gmail')
    ? nodemailer.createTransport({ service: 'gmail', auth: { user, pass }, ...TIMEOUTS })
    : nodemailer.createTransport({ host, port: Number(port || 587), secure: Number(port) === 465, auth: { user, pass }, ...TIMEOUTS });
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
  const cfg = getMailConfig();
  const validUntil = formatWhen(ticket.valid_until);
  const link = process.env.APP_URL ? `${process.env.APP_URL.replace(/\/$/, '')}/ticket.html?code=${ticket.ticket_code}` : '';
  const senderEmail = cfg.fromEmail || cfg.user || 'admin@caipsd.org';

  const text = [
    `Official Admission Pass · CAIPSD Workshop`,
    `The Islamia University of Bahawalpur`,
    `----------------------------------------------------`,
    `Hello ${ticket.full_name},`, '',
    `Your official admission pass and QR code for the CAIPSD Workshop has been confirmed.`, '',
    `Participant Name: ${ticket.full_name}`,
    `Ticket ID: ${ticket.ticket_code}`,
    `Valid Until: ${validUntil}`,
    `Venue: Baghdad-ul-Jadeed Campus, The Islamia University of Bahawalpur`, '',
    `INSTRUCTIONS:`,
    `- Please present the attached QR code at the entrance checkpoint for camera verification.`,
    `- Do not share this private admission pass with others.`,
    link ? `\nView your pass online anytime: ${link}` : '', '',
    `----------------------------------------------------`,
    `Centre for Artificial Intelligence & Professional Skills Development (CAIPSD)`,
    `The Islamia University of Bahawalpur, Baghdad-ul-Jadeed Campus, Bahawalpur 63100, Punjab, Pakistan`,
    `Inquiries & Helpdesk: ${senderEmail}`
  ].join('\n');

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CAIPSD Admission Pass</title>
</head>
<body style="margin:0;padding:0;background:#f3f5f8;font-family:Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased;color:#18243a;">
  <!-- Preheader text (inbox preview snippet) -->
  <div style="display:none;font-size:1px;color:#ffffff;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;mso-hide:all;">
    Official Admission Pass &amp; QR Entry Code for ${esc(ticket.full_name)} · CAIPSD Event, The Islamia University of Bahawalpur.
  </div>

  <table width="100%" cellpadding="0" cellspacing="0" style="padding:24px 10px;background:#f3f5f8;">
    <tr>
      <td align="center">
        <table width="540" cellpadding="0" cellspacing="0" style="max-width:540px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;box-shadow:0 2px 8px rgba(0,0,0,0.04);">
          <!-- Header -->
          <tr>
            <td style="background:#0d1930;color:#ffffff;padding:26px 28px;border-bottom:3px solid #f59d14;">
              <div style="font-size:11px;letter-spacing:1.8px;color:#f59d14;font-weight:700;text-transform:uppercase;">The Islamia University of Bahawalpur</div>
              <div style="font-size:22px;font-weight:800;margin-top:6px;letter-spacing:-0.3px;color:#ffffff;">CAIPSD Admission Pass</div>
              <div style="font-size:13px;color:#94a3b8;margin-top:2px;">Official Event &amp; QR Entrance Pass</div>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:28px 28px 20px;">
              <p style="margin:0 0 12px;font-size:15px;line-height:1.5;color:#1e293b;">Dear <strong>${esc(ticket.full_name)}</strong>,</p>
              <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#475569;">
                Your admission pass for the <strong>CAIPSD Event</strong> at The Islamia University of Bahawalpur has been officially confirmed. Please present your personalized QR pass at the entrance scanner for entry verification.
              </p>

              <!-- Ticket Badge Frame -->
              <div style="text-align:center;padding:22px;border:2px dashed #3b82f6;background:#f8fafc;border-radius:12px;margin:20px 0;">
                <img src="cid:ticket-qr" width="220" height="220" alt="Admission QR Pass" style="display:block;margin:0 auto;border-radius:8px;background:#ffffff;padding:8px;border:1px solid #e2e8f0;">
                <div style="margin-top:14px;font-family:Consolas,monospace;font-size:18px;letter-spacing:3px;font-weight:800;color:#0f172a;">${esc(ticket.ticket_code)}</div>
                <div style="margin-top:4px;font-size:12px;color:#64748b;font-weight:600;">Valid Until: ${esc(validUntil)}</div>
              </div>

              ${link ? `<div style="text-align:center;margin:24px 0 10px;">
                <a href="${esc(link)}" style="background:#1d4ed8;color:#ffffff;text-decoration:none;padding:12px 26px;border-radius:8px;font-size:13.5px;font-weight:700;display:inline-block;">View Pass Online &amp; Save to Phone</a>
              </div>` : ''}

              <!-- Event Details -->
              <table width="100%" cellpadding="8" cellspacing="0" style="margin-top:22px;border-top:1px solid #f1f5f9;font-size:12.5px;color:#475569;">
                <tr>
                  <td width="30%" style="font-weight:600;color:#1e293b;">Participant:</td>
                  <td>${esc(ticket.full_name)}</td>
                </tr>
                <tr>
                  <td style="font-weight:600;color:#1e293b;">Institution:</td>
                  <td>The Islamia University of Bahawalpur</td>
                </tr>
                <tr>
                  <td style="font-weight:600;color:#1e293b;">Venue:</td>
                  <td>Baghdad-ul-Jadeed Campus, Bahawalpur</td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Institutional CAN-SPAM Footer -->
          <tr>
            <td style="padding:18px 28px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:11.5px;color:#64748b;line-height:1.6;text-align:center;">
              <p style="margin:0 0 6px;">This official registration confirmation was delivered to <strong>${esc(ticket.email)}</strong> because you registered for the CAIPSD event.</p>
              <p style="margin:0 0 6px;">Centre for Artificial Intelligence &amp; Professional Skills Development &bull; The Islamia University of Bahawalpur</p>
              <p style="margin:0;color:#94a3b8;">Baghdad-ul-Jadeed Campus, Bahawalpur 63100, Punjab, Pakistan &bull; Contact: ${esc(senderEmail)}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return {
    from: fromAddress(),
    to: ticket.email,
    replyTo: senderEmail,
    subject: `CAIPSD Admission Pass · ${ticket.full_name} [${ticket.ticket_code}]`,
    text,
    html,
    headers: {
      'X-Priority': '3',
      'X-Mailer': 'CAIPSD Event Management Portal',
      'List-Unsubscribe': `<mailto:${senderEmail}?subject=unsubscribe>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      'Auto-Submitted': 'auto-generated',
      'Precedence': 'bulk',
      'Feedback-ID': `caipsd-pass:${ticket.ticket_code}:iub:caipsd`
    },
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
  const html = `<!doctype html><html><body style="margin:0;background:#ffffff;font-family:Arial,Helvetica,sans-serif;color:#14213D">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:28px 12px"><tr><td align="center">
    <table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #E6E0D2">
      <tr><td style="background:#ffffff;color:#14213D;padding:26px 28px;border-bottom:3px solid #B7791F">
        <div style="font-size:11px;letter-spacing:2px;color:#8A5A12;font-weight:700;text-transform:uppercase">The Islamia University of Bahawalpur</div>
        <div style="font-family:Georgia,'Times New Roman',serif;font-size:26px;font-weight:700;margin-top:8px;letter-spacing:-0.5px;color:#14213D">CAIPSD Event System</div>
        <div style="font-size:13px;color:#5A6275;margin-top:2px">Email Integration Test</div>
      </td></tr>
      <tr><td style="padding:26px 28px">
        <p style="margin:0 0 14px;font-size:15px;color:#16a34a;font-weight:700">✓ Google Account Connected Successfully!</p>
        <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#3A445B">Your Google / Gmail account (<strong>${esc(cfg.user)}</strong>) is now connected with the CAIPSD Event Management Portal.</p>
        <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#3A445B">You can now send tickets and QR passes to individual students, or email all registered students with <strong>1-Click</strong> directly from the portal desk.</p>
        <div style="padding:14px 18px;background:#FBF9F4;border-left:4px solid #B7791F;border-radius:6px;font-size:13px;color:#3A445B">
          <strong>Connected sender:</strong> ${esc(cfg.fromName)} &lt;${esc(cfg.user)}&gt;<br>
          <strong>Timestamp:</strong> ${esc(new Date().toLocaleString('en-GB', { timeZone: TIMEZONE }))}
        </div>
      </td></tr>
      <tr><td style="padding:16px 28px;background:#FBF9F4;border-top:1px solid #E6E0D2;font-size:12px;color:#5A6275;text-align:center">
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
