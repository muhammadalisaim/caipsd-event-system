require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const QRCode = require('qrcode');
const { db, initializeAdmin, getSetting, setSetting, deleteSetting } = require('./db');
const { mailConfigured, sendTicketEmail, sendTestEmail, fromAddress, getMailConfig, verifyMailConfig, createTransport } = require('./mailer');
const {
  getSheetsConfig,
  saveSheetsConfig,
  testConnection: testSheetsConnection,
  appendTicket: sheetsAppendTicket,
  updateTicket: sheetsUpdateTicket,
  cancelTicket: sheetsCancelTicket,
  syncAllTickets,
  fetchTicketsFromSheet,
  sendTicketEmailViaSheet,
  sendTestEmailViaSheet,
  getAppsScriptTemplate
} = require('./sheets');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

const DEFAULT_ADMIN_PASSWORD = 'ChangeMe123!';
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.includes('replace-this')) {
  if (isProduction) throw new Error('Set a strong SESSION_SECRET in your production environment.');
  console.warn('Using a development session secret. Set SESSION_SECRET in .env before deployment.');
}
if (isProduction && (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD === DEFAULT_ADMIN_PASSWORD)) {
  throw new Error('Set a strong, unique ADMIN_PASSWORD in your production environment.');
}
initializeAdmin(process.env.ADMIN_EMAIL || 'admin@caipsd.org', process.env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD);
const TICKET_VALID_DAYS = Math.max(1, Number(process.env.TICKET_VALID_DAYS || 3));

class SQLiteSessionStore extends session.Store {
  get(sid, callback) {
    try {
      const row = db.prepare('SELECT sess, expired FROM sessions WHERE sid = ?').get(sid);
      if (!row) return callback(null, null);
      if (row.expired <= Date.now()) {
        db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        return callback(null, null);
      }
      callback(null, JSON.parse(row.sess));
    } catch (error) { callback(error); }
  }
  set(sid, sess, callback = () => {}) {
    try {
      const expires = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86400000;
      db.prepare(`INSERT INTO sessions (sid, sess, expired) VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expired = excluded.expired`)
        .run(sid, JSON.stringify(sess), expires);
      callback(null);
    } catch (error) { callback(error); }
  }
  destroy(sid, callback = () => {}) {
    try { db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid); callback(null); }
    catch (error) { callback(error); }
  }
  touch(sid, sess, callback = () => {}) { this.set(sid, sess, callback); }
}

app.disable('x-powered-by');
app.use((req, res, next) => {
  if (req.headers.origin) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(helmet({
  permissionsPolicy: { features: { camera: ['self'] } },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'", 'http://localhost:*', 'http://127.0.0.1:*', '*'],
      fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
      workerSrc: ["'self'", 'blob:'],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: isProduction ? [] : null
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '30kb' }));
app.use(session({
  name: 'caipsd.sid',
  secret: process.env.SESSION_SECRET || 'local-development-only-change-this-secret',
  store: new SQLiteSessionStore(),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: isProduction, maxAge: 8 * 60 * 60 * 1000 }
}));
app.use('/vendor/html5-qrcode', express.static(path.join(__dirname, 'node_modules', 'html5-qrcode'), { maxAge: isProduction ? '7d' : 0 }));
app.get('/', (req, res) => res.redirect('/admin.html'));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: isProduction ? '1h' : 0, extensions: ['html'], index: false }));

const ticketLimiter = rateLimit({ windowMs: 5 * 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many requests. Please try again shortly.' } });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many login attempts. Please try again later.' } });

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.adminId) return res.status(401).json({ error: 'Please sign in to continue.' });
  next();
}
function cleanText(value, max = 200) { return String(value ?? '').trim().slice(0, max); }
function extractTicketCode(raw) {
  if (!raw) return '';
  const text = String(raw).trim();
  const urlMatch = text.match(/[?&]code=([A-Fa-f0-9]{16})\b/i);
  if (urlMatch) return urlMatch[1].toUpperCase();
  const prefixMatch = text.match(/CAIPSD\|TICKET\|([A-Fa-f0-9]{16})\b/i);
  if (prefixMatch) return prefixMatch[1].toUpperCase();
  const hexMatch = text.match(/\b([A-Fa-f0-9]{16})\b/);
  if (hexMatch) return hexMatch[1].toUpperCase();
  const stripped = text.replace(/[^A-Fa-f0-9]/g, '');
  if (stripped.length === 16) return stripped.toUpperCase();
  return text.replace(/^(?:CAIPSD\|TICKET\|)?/i, '').trim().toUpperCase();
}
function normalizeEmail(value) { return cleanText(value, 180).toLowerCase(); }
function validPhone(value) { return /^\+?[0-9][0-9\s\-()]{6,28}$/.test(value); }
function validEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
function escapeLike(value) { return value.replace(/[\\%_]/g, (c) => `\\${c}`); }

function ticketStatus(row, now = Date.now()) {
  if (new Date(row.valid_until).getTime() <= now) return 'expired';
  return row.entry_count > 0 ? 'checked_in' : 'valid';
}
function serializeTicket(row) { return { ...row, status: ticketStatus(row) }; }
function publicTicket(row) {
  const { id, email, phone, email_status, emailed_at, email_error, ...rest } = row; // eslint-disable-line no-unused-vars
  return { ...rest, status: ticketStatus(row) };
}
function getTicketById(id) { return db.prepare('SELECT * FROM tickets WHERE id = ?').get(id); }
function getTicketByCode(code) { return db.prepare('SELECT * FROM tickets WHERE ticket_code = ?').get(code); }
function qrOptions(width) { return { width, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#14213D', light: '#FFFFFF' } }; }

async function emailTicket(ticket) {
  let lastError = null;
  if (mailConfigured()) {
    try {
      const png = await QRCode.toBuffer(ticket.ticket_code, qrOptions(320));
      await sendTicketEmail(ticket, png);
      db.prepare("UPDATE tickets SET email_status='sent', emailed_at=?, email_error=NULL WHERE id=?").run(new Date().toISOString(), ticket.id);
      return { status: 'sent' };
    } catch (error) {
      console.warn('SMTP ticket email failed, attempting Google Web App fallback:', error.message);
      lastError = error;
    }
  }

  // Fallback to attached Google Web App
  try {
    const config = getSheetsConfig();
    if (config.webhookUrl) {
      await sendTicketEmailViaSheet(ticket);
      db.prepare("UPDATE tickets SET email_status='sent', emailed_at=?, email_error=NULL WHERE id=?").run(new Date().toISOString(), ticket.id);
      return { status: 'sent' };
    }
  } catch (error) {
    console.error('Google Web App ticket email fallback failed:', error.message);
    if (!lastError) lastError = error;
  }

  const message = cleanText(lastError ? lastError.message : 'Email is not configured', 300);
  db.prepare("UPDATE tickets SET email_status='failed', email_error=? WHERE id=?").run(message, ticket.id);
  return { status: 'failed', error: message };
}

app.get('/api/health', (req, res) => res.json({ status: 'ok', app: 'CAIPSD Event Management' }));

app.get('/api/ticket/:code', ticketLimiter, async (req, res) => {
  const code = cleanText(req.params.code, 32).toUpperCase();
  if (!/^[A-F0-9]{16}$/.test(code)) return res.status(404).json({ error: 'Ticket not found.' });
  const ticket = getTicketByCode(code);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });
  try {
    const qrDataUrl = await QRCode.toDataURL(code, qrOptions(240));
    res.json({ ticket: { ...publicTicket(ticket), qrDataUrl } });
  } catch (error) {
    console.error('QR generation error:', error);
    res.status(500).json({ error: 'Ticket could not be loaded.' });
  }
});

app.post('/api/admin/login', loginLimiter, (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password ?? '');
  const admin = db.prepare('SELECT id, email, password_hash FROM admins WHERE email = ?').get(email);
  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) return res.status(401).json({ error: 'Email or password is incorrect.' });
  req.session.regenerate((error) => {
    if (error) return res.status(500).json({ error: 'Could not start a secure session.' });
    req.session.adminId = admin.id;
    req.session.adminEmail = admin.email;
    req.session.save((saveError) => {
      if (saveError) return res.status(500).json({ error: 'Could not save your session.' });
      res.json({ admin: { email: admin.email } });
    });
  });
});
app.get('/api/admin/me', requireAdmin, (req, res) => res.json({ admin: { email: req.session.adminEmail } }));
app.post('/api/admin/logout', requireAdmin, (req, res) => req.session.destroy((error) => {
  if (error) return res.status(500).json({ error: 'Could not sign out.' });
  res.clearCookie('caipsd.sid', { httpOnly: true, sameSite: 'lax', secure: isProduction });
  res.json({ message: 'Signed out.' });
}));

app.get('/api/admin/config', requireAdmin, (req, res) => {
  const mailCfg = getMailConfig();
  res.json({
    validDays: TICKET_VALID_DAYS,
    mail: {
      configured: mailConfigured(),
      from: mailConfigured() ? fromAddress() : null,
      user: mailCfg.user || null,
      fromName: mailCfg.fromName,
      isGmail: !mailCfg.host || mailCfg.host.includes('gmail')
    },
    sheets: getSheetsConfig()
  });
});

app.get('/api/admin/summary', requireAdmin, (req, res) => {
  const now = new Date().toISOString();
  const count = (sql, ...params) => db.prepare(sql).get(...params).count;
  const total = count('SELECT COUNT(*) AS count FROM tickets');
  const expired = count('SELECT COUNT(*) AS count FROM tickets WHERE valid_until <= ?', now);
  const entered = count('SELECT COUNT(*) AS count FROM tickets WHERE entry_count > 0 AND valid_until > ?', now);
  const awaiting = count('SELECT COUNT(*) AS count FROM tickets WHERE entry_count = 0 AND valid_until > ?', now);
  const emailed = count("SELECT COUNT(*) AS count FROM tickets WHERE email_status = 'sent'");
  res.json({ total, entered, awaiting, expired, emailed });
});

app.get('/api/admin/tickets', requireAdmin, (req, res) => {
  const q = cleanText(req.query.q, 100);
  const status = cleanText(req.query.status, 20);
  const now = new Date().toISOString();
  let sql = 'SELECT * FROM tickets WHERE 1=1';
  const params = [];
  if (q) {
    sql += " AND (full_name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR ticket_code LIKE ? ESCAPE '\\')";
    const like = escapeLike(q);
    params.push(`%${like}%`, `%${like}%`, `%${like}%`, `%${like.toUpperCase()}%`);
  }
  if (status === 'expired') { sql += ' AND valid_until <= ?'; params.push(now); }
  if (status === 'checked_in') { sql += ' AND entry_count > 0 AND valid_until > ?'; params.push(now); }
  if (status === 'valid') { sql += ' AND entry_count = 0 AND valid_until > ?'; params.push(now); }
  sql += ' ORDER BY id DESC LIMIT 500';
  res.json({ tickets: db.prepare(sql).all(...params).map(serializeTicket) });
});

app.post('/api/admin/tickets', requireAdmin, async (req, res, next) => {
  try {
    const fullName = cleanText(req.body.fullName, 100);
    const email = normalizeEmail(req.body.email);
    const phone = cleanText(req.body.phone, 30);
    if (!fullName || !email || !phone) return res.status(400).json({ error: 'Please enter the participant name, email and phone number.' });
    if (fullName.length < 2) return res.status(400).json({ error: 'Please enter the full name.' });
    if (!validEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
    if (!validPhone(phone)) return res.status(400).json({ error: 'Please enter a valid phone number (digits, spaces, + - and brackets only).' });
    const existing = db.prepare('SELECT * FROM tickets WHERE email = ?').get(email);
    if (existing) return res.status(409).json({ error: 'A ticket has already been issued to this email address.', ticket: serializeTicket(existing) });

    const issued = new Date();
    const validUntil = new Date(issued.getTime() + TICKET_VALID_DAYS * 24 * 60 * 60 * 1000);
    const ticketCode = crypto.randomBytes(8).toString('hex').toUpperCase();
    const result = db.prepare(`INSERT INTO tickets (full_name, email, phone, ticket_code, issued_at, valid_until) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(fullName, email, phone, ticketCode, issued.toISOString(), validUntil.toISOString());
    let ticket = getTicketById(Number(result.lastInsertRowid));

    const wantsEmail = req.body.sendEmail !== false && req.body.sendEmail !== 'false';
    const emailResult = wantsEmail && mailConfigured() ? await emailTicket(ticket) : { status: 'not_sent', skipped: wantsEmail ? 'not_configured' : 'declined' };
    ticket = getTicketById(ticket.id);

    // Auto-sync ticket to Google Sheet in background
    sheetsAppendTicket(serializeTicket(ticket)).catch((err) => console.error('Sheet append error:', err.message));

    res.status(201).json({ ticket: serializeTicket(ticket), email: emailResult });
  } catch (error) { next(error); }
});

app.post('/api/admin/tickets/:id/send', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const ticket = Number.isInteger(id) ? getTicketById(id) : null;
    if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });
    if (!mailConfigured()) return res.status(503).json({ error: 'Email is not configured. Please connect your Google / Gmail account in the portal.' });
    const result = await emailTicket(ticket);
    const updated = serializeTicket(getTicketById(id));
    sheetsUpdateTicket(updated).catch((err) => console.error('Sheet update error:', err.message));
    if (result.status === 'failed') return res.status(502).json({ error: `Email could not be sent: ${result.error}`, ticket: updated });
    res.json({ message: `Ticket emailed to ${ticket.email}.`, ticket: updated });
  } catch (error) { next(error); }
});

app.post('/api/admin/tickets/email-all', requireAdmin, async (req, res, next) => {
  try {
    if (!mailConfigured()) {
      return res.status(503).json({ error: 'Email is not configured. Please connect your Google / Gmail account in the portal.' });
    }
    const mode = req.body && req.body.mode === 'all' ? 'all' : 'pending';
    const tickets = mode === 'all'
      ? db.prepare('SELECT * FROM tickets ORDER BY id ASC').all()
      : db.prepare("SELECT * FROM tickets WHERE email_status IS NULL OR email_status != 'sent' ORDER BY id ASC").all();

    if (tickets.length === 0) {
      return res.json({
        total: 0,
        sent: 0,
        failed: 0,
        errors: [],
        message: mode === 'all' ? 'No tickets found in the system.' : 'All students have already received their tickets!'
      });
    }

    let sent = 0;
    let failed = 0;
    const errors = [];

    for (const t of tickets) {
      try {
        const result = await emailTicket(t);
        const updated = serializeTicket(getTicketById(t.id));
        sheetsUpdateTicket(updated).catch((err) => console.error('Sheet update error:', err.message));
        if (result.status === 'sent') {
          sent++;
        } else {
          failed++;
          errors.push({ id: t.id, name: t.full_name, email: t.email, error: result.error });
        }
      } catch (err) {
        failed++;
        errors.push({ id: t.id, name: t.full_name, email: t.email, error: err.message });
      }
      if (tickets.length > 1) {
        await new Promise((r) => setTimeout(r, 150));
      }
    }

    res.json({
      total: tickets.length,
      sent,
      failed,
      errors,
      message: `Completed: ${sent} ticket${sent === 1 ? '' : 's'} sent successfully${failed > 0 ? `, ${failed} failed` : ''}.`
    });
  } catch (error) { next(error); }
});

app.delete('/api/admin/tickets/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid ticket.' });
  const existing = getTicketById(id);
  if (!existing) return res.status(404).json({ error: 'Ticket not found.' });
  const result = db.prepare('DELETE FROM tickets WHERE id = ?').run(id);
  if (!result.changes) return res.status(404).json({ error: 'Ticket not found.' });
  sheetsCancelTicket(existing.ticket_code).catch((err) => console.error('Sheet cancel error:', err.message));
  res.json({ message: 'Ticket cancelled. Its QR code will no longer work.' });
});

app.post('/api/admin/check-in', requireAdmin, async (req, res, next) => {
  try {
    const code = extractTicketCode(req.body.ticketCode);
    const match = code.match(/^[A-F0-9]{16}$/);
    if (!match) return res.status(400).json({ error: 'Enter a valid ticket code or scan a CAIPSD ticket QR.' });
    let ticket = getTicketByCode(match[0]);
    if (!ticket) {
      try {
        const sheetTickets = await fetchTicketsFromSheet();
        const found = sheetTickets.find((x) => x.ticket_code && x.ticket_code.toUpperCase() === match[0]);
        if (found) {
          const issued = found.issued_at || new Date().toISOString();
          const validUntil = found.valid_until || new Date(Date.now() + TICKET_VALID_DAYS * 86400000).toISOString();
          db.prepare(`INSERT OR IGNORE INTO tickets (full_name, email, phone, ticket_code, issued_at, valid_until, entry_count, first_entry_at, last_entry_at, email_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            found.full_name || 'Participant',
            found.email || `attendee-${match[0].toLowerCase()}@caipsd.org`,
            found.phone || '',
            match[0],
            issued,
            validUntil,
            found.entry_count || 0,
            found.first_entry_at || null,
            found.last_entry_at || null,
            found.email_status || 'not_sent'
          );
          ticket = getTicketByCode(match[0]);
        }
      } catch (err) {}
    }
    if (!ticket) return res.status(404).json({ error: 'Ticket not found. This ticket is invalid or was cancelled.' });
    const now = new Date();
    if (new Date(ticket.valid_until).getTime() <= now.getTime()) {
      return res.status(410).json({ error: 'This ticket has expired.', ticket: serializeTicket(ticket) });
    }
    const scannedAt = now.toISOString();
    db.transaction(() => {
      db.prepare('INSERT INTO entries (ticket_id, scanned_at) VALUES (?, ?)').run(ticket.id, scannedAt);
      db.prepare('UPDATE tickets SET entry_count = entry_count + 1, first_entry_at = COALESCE(first_entry_at, ?), last_entry_at = ? WHERE id = ?').run(scannedAt, scannedAt, ticket.id);
    })();
    const updated = serializeTicket(getTicketById(ticket.id));
    sheetsUpdateTicket(updated).catch((err) => console.error('Sheet update error:', err.message));
    const repeat = updated.entry_count > 1;
    res.json({ message: repeat ? `Entry allowed (visit ${updated.entry_count}).` : 'Entry allowed. Welcome!', repeat, ticket: updated });
  } catch (error) { next(error); }
});

app.get('/api/admin/sheets/config', requireAdmin, (req, res) => {
  res.json({ config: getSheetsConfig() });
});

app.post('/api/admin/sheets/config', requireAdmin, (req, res) => {
  const updated = saveSheetsConfig(req.body || {});
  res.json({ message: 'Google Sheets configuration saved.', config: updated });
});

app.post('/api/admin/sheets/test', requireAdmin, async (req, res) => {
  if (req.body && (req.body.webhookUrl !== undefined || req.body.sheetName !== undefined)) {
    saveSheetsConfig(req.body);
  }
  const result = await testSheetsConnection();
  if (!result.ok) {
    return res.status(400).json({ error: result.error || 'Connection failed.' });
  }
  res.json({ message: result.message, details: result.details });
});

app.post('/api/admin/sheets/push', requireAdmin, async (req, res) => {
  try {
    const tickets = db.prepare('SELECT * FROM tickets ORDER BY id ASC').all().map(serializeTicket);
    const result = await syncAllTickets(tickets);
    res.json({ message: `Successfully pushed ${result.count} tickets to Google Sheet.`, result });
  } catch (error) {
    res.status(502).json({ error: error.message || 'Could not sync tickets to Google Sheet.' });
  }
});

app.post('/api/admin/sheets/pull', requireAdmin, async (req, res) => {
  try {
    const sheetTickets = await fetchTicketsFromSheet();
    let imported = 0;
    let updated = 0;
    db.transaction(() => {
      for (const t of sheetTickets) {
        if (!t.ticket_code) continue;
        const code = cleanText(t.ticket_code).toUpperCase();
        const existing = getTicketByCode(code);
        if (existing) {
          db.prepare('UPDATE tickets SET full_name = ?, phone = ?, entry_count = ? WHERE id = ?')
            .run(cleanText(t.full_name) || existing.full_name, cleanText(t.phone) || existing.phone, Number(t.entry_count || existing.entry_count), existing.id);
          updated++;
        } else {
          const email = normalizeEmail(t.email);
          if (!validEmail(email)) continue;
          const emailExists = db.prepare('SELECT id FROM tickets WHERE email = ?').get(email);
          if (emailExists) continue;
          const issued = t.issued_at || new Date().toISOString();
          const valid = t.valid_until || new Date(Date.now() + TICKET_VALID_DAYS * 86400000).toISOString();
          db.prepare(`INSERT INTO tickets (full_name, email, phone, ticket_code, issued_at, valid_until, entry_count, email_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(cleanText(t.full_name) || 'Guest', email, cleanText(t.phone) || '-', code, issued, valid, Number(t.entry_count || 0), cleanText(t.email_status) || 'not_sent');
          imported++;
        }
      }
    })();
    res.json({ message: `Import complete: ${imported} imported, ${updated} updated.`, imported, updated });
  } catch (error) {
    res.status(502).json({ error: error.message || 'Could not pull tickets from Google Sheet.' });
  }
});

app.get('/api/admin/sheets/template', requireAdmin, (req, res) => {
  res.json({ template: getAppsScriptTemplate() });
});

/* ---- Google Account / Mailer Endpoints ---- */
app.get('/api/admin/mail/config', requireAdmin, (req, res) => {
  const cfg = getMailConfig();
  res.json({
    configured: cfg.configured,
    user: cfg.user || '',
    fromName: cfg.fromName || '',
    host: cfg.host || '',
    port: cfg.port || 587,
    isGmail: !cfg.host || cfg.host.includes('gmail')
  });
});

app.post('/api/admin/mail/config', requireAdmin, async (req, res, next) => {
  try {
    const user = cleanText(req.body.user, 180).toLowerCase();
    const pass = cleanText(req.body.pass, 100).replace(/\s+/g, '');
    const fromName = cleanText(req.body.fromName, 100) || 'CAIPSD Events - The Islamia University of Bahawalpur';
    const host = cleanText(req.body.host, 100);
    const port = Number(req.body.port || 587);

    if (!user || !pass) {
      return res.status(400).json({ error: 'Please enter both your Gmail address and 16-character Google App Password.' });
    }
    if (!validEmail(user)) {
      return res.status(400).json({ error: 'Please enter a valid Gmail / Google email address.' });
    }

    // Verify SMTP connection live with Google/SMTP
    try {
      await verifyMailConfig(user, pass, host, port);
    } catch (verifyError) {
      console.error('SMTP verification failed:', verifyError.message);
      return res.status(400).json({
        error: `Google connection test failed: ${verifyError.message}. Make sure 2-Step Verification is active on your Google account and you have generated a 16-character App Password.`
      });
    }

    setSetting('smtp_user', user);
    setSetting('smtp_pass', pass);
    setSetting('mail_from_name', fromName);
    if (host) setSetting('smtp_host', host);
    if (port) setSetting('smtp_port', String(port));

    res.json({
      message: 'Google account connected successfully! You can now send emails to all students in 1 click.',
      config: {
        configured: true,
        user,
        fromName
      }
    });
  } catch (error) { next(error); }
});

app.post('/api/admin/mail/disconnect', requireAdmin, (req, res) => {
  deleteSetting('smtp_user');
  deleteSetting('smtp_pass');
  deleteSetting('smtp_host');
  deleteSetting('smtp_port');
  deleteSetting('mail_from_name');
  deleteSetting('mail_from');
  res.json({ message: 'Google account disconnected successfully.' });
});

app.post('/api/admin/mail/test', requireAdmin, async (req, res, next) => {
  try {
    const cfg = getMailConfig();
    const to = cleanText(req.body.to, 180) || cfg.user || req.session.adminEmail;
    if (!validEmail(to)) {
      return res.status(400).json({ error: 'Please enter a valid recipient email address for the test.' });
    }
    if (mailConfigured()) {
      try {
        await sendTestEmail(to);
        return res.json({ message: `Test email sent successfully to ${to}!` });
      } catch (smtpErr) {
        console.warn('SMTP test email failed, attempting Google Web App fallback:', smtpErr.message);
      }
    }
    // Fallback to attached Google Web App
    try {
      await sendTestEmailViaSheet(to);
      return res.json({ message: `Test email sent successfully to ${to} via Google Web App!` });
    } catch (sheetErr) {
      return res.status(502).json({ error: `Test email failed: ${sheetErr.message}. Ensure your Google Account is connected.` });
    }
  } catch (error) { next(error); }
});

app.get('/api/admin/export.csv', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM tickets ORDER BY id').all().map(serializeTicket);
  const label = { valid: 'Valid - not entered', checked_in: 'Entered', expired: 'Expired' };
  const headers = ['Participant', 'Email', 'Phone', 'Ticket ID', 'Issued at', 'Valid until', 'Status', 'Entries', 'First entry', 'Last entry', 'Email status'];
  const values = rows.map((r) => [r.full_name, r.email, r.phone, r.ticket_code, r.issued_at, r.valid_until, label[r.status], r.entry_count, r.first_entry_at || '', r.last_entry_at || '', r.email_status]);
  const escapeCsv = (value) => {
    let text = String(value ?? '');
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`; // Prevent spreadsheet formula injection.
    return `"${text.replace(/"/g, '""')}"`;
  };
  const csv = [headers, ...values].map((line) => line.map(escapeCsv).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="caipsd-tickets.csv"');
  res.send('﻿' + csv);
});

app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found.' }));
app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'public', '404.html')));
app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

function purgeExpiredSessions() {
  try { db.prepare('DELETE FROM sessions WHERE expired <= ?').run(Date.now()); } catch (error) { console.error('Session cleanup failed:', error); }
}

function start() {
  purgeExpiredSessions();
  const cleanup = setInterval(purgeExpiredSessions, 60 * 60 * 1000);
  cleanup.unref();
  const server = app.listen(PORT, () => {
    console.log(`CAIPSD Event Management is running at http://localhost:${PORT}`);
    console.log(`Admin sign-in: ${process.env.ADMIN_EMAIL || 'admin@caipsd.org'}`);
  });
  const shutdown = (signal) => {
    console.log(`${signal} received. Shutting down…`);
    server.close(() => { try { db.close(); } catch { /* already closed */ } process.exit(0); });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  ['SIGINT', 'SIGTERM'].forEach((signal) => process.on(signal, () => shutdown(signal)));
  process.on('SIGHUP', () => { console.log('SIGHUP received, ignoring to stay active.'); });
  return server;
}

if (require.main === module) start();

module.exports = { app, start };
