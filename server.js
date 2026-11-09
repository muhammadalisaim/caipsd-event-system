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
const TICKET_VALID_DAYS = Math.max(1, Number(process.env.TICKET_VALID_DAYS || 2));

function getDefaultValidDays() {
  const saved = getSetting('ticket_valid_days');
  if (saved && !Number.isNaN(Number(saved))) return Math.max(1, Math.min(30, Number(saved)));
  return TICKET_VALID_DAYS;
}

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
// Cross-origin access is OFF by default (the portal and its API share one origin).
// To let another website call this API, list it in ALLOWED_ORIGINS (comma separated).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
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
      connectSrc: ["'self'", 'https://script.google.com', 'https://script.googleusercontent.com', 'https://docs.google.com'],
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
const checkinLimiter = rateLimit({ windowMs: 5 * 60 * 1000, limit: 600, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many scans from this device. Please wait a moment.' } });
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
function getLocalDateString(date = new Date(), timeZone = process.env.EVENT_TIMEZONE || 'Asia/Karachi') {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}
function getEventDay1Date() {
  const custom = getSetting('event_start_date');
  if (custom && /^\d{4}-\d{2}-\d{2}$/.test(custom)) return custom;
  try {
    const firstEntry = db.prepare('SELECT scanned_at FROM entries ORDER BY id ASC LIMIT 1').get();
    if (firstEntry && firstEntry.scanned_at) {
      return getLocalDateString(new Date(firstEntry.scanned_at));
    }
  } catch {}
  return null;
}
const cancelledCodes = new Set();

function ticketStatus(row, now = Date.now()) {
  if (new Date(row.valid_until).getTime() <= now) return 'expired';
  const maxDays = Number(row.max_days) || Math.max(1, Math.round((new Date(row.valid_until) - new Date(row.issued_at)) / 86400000));
  if (row.entry_count >= maxDays) return 'completed';
  if (row.entry_count > 0) return 'checked_in';
  return 'valid';
}
function serializeTicket(row) { return { ...row, status: ticketStatus(row) }; }
function publicTicket(row) {
  const { id, email, phone, email_status, emailed_at, email_error, ...rest } = row; // eslint-disable-line no-unused-vars
  return { ...rest, status: ticketStatus(row) };
}
function getTicketById(id) { return db.prepare('SELECT * FROM tickets WHERE id = ?').get(id); }
function getTicketByCode(code) { return db.prepare('SELECT * FROM tickets WHERE ticket_code = ?').get(code); }
function qrOptions(width) { return { width, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#14213D', light: '#FFFFFF' } }; }

/* ---- Email delivery -------------------------------------------------------
   Two channels, tried in this order:
   1. "smtp"          your Gmail / SMTP account (App Password)
   2. "google-script" the attached Google Apps Script (sends from the Sheet owner's Gmail)
   Tickets are emailed automatically when they are created; either channel is enough. */
function emailChannel() {
  if (mailConfigured()) return 'smtp';
  if (getSheetsConfig().webhookUrl) return 'google-script';
  return 'none';
}
function emailAvailable() { return emailChannel() !== 'none'; }
function ticketViewLink(ticket) {
  const base = String(process.env.APP_URL || '').trim().replace(/\/$/, '');
  return base ? `${base}/ticket.html?code=${ticket.ticket_code}` : '';
}
function markEmailSent(ticket, channel) {
  db.prepare("UPDATE tickets SET email_status='sent', emailed_at=?, email_error=NULL WHERE id=?").run(new Date().toISOString(), ticket.id);
  return { status: 'sent', channel };
}
function markEmailFailed(ticket, message) {
  const clean = cleanText(message, 400);
  db.prepare("UPDATE tickets SET email_status='failed', email_error=? WHERE id=?").run(clean, ticket.id);
  return { status: 'failed', error: clean };
}

async function emailTicket(ticket) {
  let png;
  try { png = await QRCode.toBuffer(ticket.ticket_code, qrOptions(320)); }
  catch (error) { return markEmailFailed(ticket, `Could not create the QR code: ${error.message}`); }

  const failures = [];
  if (mailConfigured()) {
    try {
      await sendTicketEmail(ticket, png);
      return markEmailSent(ticket, 'smtp');
    } catch (error) {
      console.warn('SMTP ticket email failed:', error.message);
      failures.push(`Gmail/SMTP: ${error.message}`);
    }
  }
  if (getSheetsConfig().webhookUrl) {
    try {
      await sendTicketEmailViaSheet(ticket, { qrPngBase64: png.toString('base64'), viewLink: ticketViewLink(ticket) });
      return markEmailSent(ticket, 'google-script');
    } catch (error) {
      console.warn('Google Script ticket email failed:', error.message);
      failures.push(`Google Script: ${error.message}`);
    }
  }
  if (!failures.length) failures.push('Email is not configured.');
  return markEmailFailed(ticket, failures.join(' | '));
}

// Tickets that are not in this database yet (issued from the Google Sheet) are looked up there.
// A short cache stops a flood of wrong codes from hammering Google.
const SHEET_CACHE_MS = 15000;
let sheetTicketCache = { at: 0, tickets: [] };
async function getSheetTicketsCached() {
  if (Date.now() - sheetTicketCache.at < SHEET_CACHE_MS) return sheetTicketCache.tickets;
  try {
    const tickets = await fetchTicketsFromSheet();
    sheetTicketCache = { at: Date.now(), tickets };
    return tickets;
  } catch (error) {
    sheetTicketCache = { at: Date.now(), tickets: [] };
    throw error;
  }
}
function isoOr(value, fallback) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback;
}
function sheetTicketCancelled(row) { return /cancel/i.test(String((row && row.status) || '')); }

app.get('/api/health', (req, res) => res.json({ status: 'ok', app: 'CAIPSD Event Management' }));

app.get('/api/ticket/:code', ticketLimiter, async (req, res) => {
  const code = cleanText(req.params.code, 32).toUpperCase();
  if (!/^[A-F0-9]{16}$/.test(code)) return res.status(404).json({ error: 'Ticket not found.' });
  const ticket = getTicketByCode(code);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });
  try {
    const qrDataUrl = await QRCode.toDataURL(code, qrOptions(240));
    const baseName = ticket.full_name.replace(/\s*\((?:Day\s*\d+|Day\d+)\)$/i, '').trim();
    const issuedMin = (ticket.issued_at || '').slice(0, 16);

    const siblings = db.prepare(`
      SELECT * FROM tickets
      WHERE (full_name = ? OR full_name LIKE ?)
      AND substr(issued_at, 1, 16) = ?
      ORDER BY full_name ASC, id ASC
    `).all(baseName, `${baseName} (%`, issuedMin);

    const list = siblings.length > 0 ? siblings : [ticket];
    const ticketsWithQr = await Promise.all(list.map(async (t) => {
      const qr = t.ticket_code === code ? qrDataUrl : await QRCode.toDataURL(t.ticket_code, qrOptions(240));
      return { ...publicTicket(t), qrDataUrl: qr };
    }));

    res.json({
      ticket: { ...publicTicket(ticket), qrDataUrl },
      tickets: ticketsWithQr
    });
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
    validDays: getDefaultValidDays(),
    mail: {
      configured: emailAvailable(),
      channel: emailChannel(),
      smtpConfigured: mailConfigured(),
      from: mailConfigured() ? fromAddress() : null,
      user: mailCfg.user || null,
      fromName: mailCfg.fromName,
      isGmail: !mailCfg.host || mailCfg.host.includes('gmail')
    },
    sheets: getSheetsConfig()
  });
});

app.get('/api/admin/settings/duration', requireAdmin, (req, res) => {
  res.json({ validDays: getDefaultValidDays() });
});

app.post('/api/admin/settings/duration', requireAdmin, (req, res) => {
  const days = Math.max(1, Math.min(30, Number(req.body.validDays || req.body.days || 2)));
  setSetting('ticket_valid_days', String(days));
  res.json({ validDays: days, message: `Default event duration set to ${days} day${days === 1 ? '' : 's'}.` });
});

app.get('/api/admin/summary', requireAdmin, (req, res) => {
  const now = new Date().toISOString();
  const count = (sql, ...params) => db.prepare(sql).get(...params).count;
  const total = count('SELECT COUNT(*) AS count FROM tickets');
  const expired = count('SELECT COUNT(*) AS count FROM tickets WHERE valid_until <= ?', now);
  const entered = count('SELECT COUNT(*) AS count FROM tickets WHERE entry_count > 0 AND valid_until > ?', now);
  const day1Entered = count('SELECT COUNT(*) AS count FROM tickets WHERE entry_count = 1 AND valid_until > ?', now);
  const day2Entered = count('SELECT COUNT(*) AS count FROM tickets WHERE entry_count >= 2 AND valid_until > ?', now);
  const awaiting = count('SELECT COUNT(*) AS count FROM tickets WHERE entry_count = 0 AND valid_until > ?', now);
  res.json({ total, entered, day1Entered, day2Entered, awaiting, expired });
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
    const rawFullName = cleanText(req.body.fullName, 100);
    const email = cleanText(req.body.email, 180).toLowerCase();
    const phone = cleanText(req.body.phone, 30);
    const days = Math.max(1, Math.min(30, Number(req.body.days || req.body.validDays || getDefaultValidDays())));
    if (!rawFullName || rawFullName.length < 2) {
      return res.status(400).json({ error: 'Please enter the participant full name.' });
    }

    const baseName = rawFullName.replace(/\s*\((?:Day\s*\d+|Day\d+)\)$/i, '').trim();
    const issued = new Date();
    const validUntil = new Date(issued.getTime() + Math.max(days, 2) * 24 * 60 * 60 * 1000);

    const insertStmt = db.prepare(`INSERT INTO tickets (full_name, email, phone, ticket_code, issued_at, valid_until, max_days) VALUES (?, ?, ?, ?, ?, ?, 1)`);
    const createdTickets = [];

    db.transaction(() => {
      for (let day = 1; day <= days; day++) {
        const ticketCode = crypto.randomBytes(8).toString('hex').toUpperCase();
        const r = insertStmt.run(`${baseName} (Day ${day})`, email || '', phone || '', ticketCode, issued.toISOString(), validUntil.toISOString());
        createdTickets.push(getTicketById(Number(r.lastInsertRowid)));
      }
    })();

    const wantsEmail = req.body.sendEmail !== false && req.body.sendEmail !== 'false' && Boolean(email);
    const emailConfigured = emailAvailable();
    let emailResult = { status: 'not_sent', skipped: wantsEmail ? 'not_configured' : 'declined' };
    if (wantsEmail && emailConfigured) {
      for (let i = 0; i < createdTickets.length; i++) {
        emailResult = await emailTicket(createdTickets[i]);
        createdTickets[i] = getTicketById(createdTickets[i].id);
      }
    }

    // Auto-sync tickets to Google Sheet in background (1 row per participant)
    sheetsAppendTicket(createdTickets.map(serializeTicket)).catch((err) => console.error(`Sheet append error (${baseName}):`, err.message));

    const ticket1 = createdTickets[0];
    const ticket2 = createdTickets[1];

    res.status(201).json({
      message: `${createdTickets.length} ticket${createdTickets.length === 1 ? '' : 's'} generated for ${baseName} (${createdTickets.length} daily pass${createdTickets.length === 1 ? '' : 'es'}).`,
      ticket: serializeTicket(ticket1),
      ticket2: ticket2 ? serializeTicket(ticket2) : undefined,
      tickets: createdTickets.map(serializeTicket),
      email: emailResult
    });
  } catch (error) { next(error); }
});

app.post('/api/admin/tickets/bulk', requireAdmin, async (req, res, next) => {
  try {
    const rawNames = Array.isArray(req.body.names)
      ? req.body.names
      : String(req.body.names || '').split(/\r?\n/);
    const days = Math.max(1, Math.min(30, Number(req.body.days || req.body.validDays || getDefaultValidDays())));

    const names = rawNames
      .map((n) => cleanText(n, 100))
      .filter((n) => n.length >= 2);

    if (names.length === 0) {
      return res.status(400).json({ error: 'Please provide at least one valid participant name.' });
    }

    const issued = new Date();
    const validUntil = new Date(issued.getTime() + Math.max(days, 2) * 24 * 60 * 60 * 1000);
    const insertStmt = db.prepare(`INSERT INTO tickets (full_name, email, phone, ticket_code, issued_at, valid_until, max_days) VALUES (?, '', '', ?, ?, ?, 1)`);

    const createdTickets = [];
    db.transaction(() => {
      for (const name of names) {
        const baseName = name.replace(/\s*\((?:Day\s*\d+|Day\d+)\)$/i, '').trim();
        for (let day = 1; day <= days; day++) {
          const ticketCode = crypto.randomBytes(8).toString('hex').toUpperCase();
          const r = insertStmt.run(`${baseName} (Day ${day})`, ticketCode, issued.toISOString(), validUntil.toISOString());
          createdTickets.push(getTicketById(Number(r.lastInsertRowid)));
        }
      }
    })();

    // Auto-sync all tickets to Google Sheet in one clean batch
    const allCurrentTickets = db.prepare('SELECT * FROM tickets ORDER BY id ASC').all().map(serializeTicket);
    syncAllTickets(allCurrentTickets).catch((err) => console.error('Sheet bulk syncAll error:', err.message));

    res.status(201).json({
      message: `Successfully issued ${createdTickets.length} tickets (${names.length} participant${names.length === 1 ? '' : 's'} × ${days} pass${days === 1 ? '' : 'es'}).`,
      count: createdTickets.length,
      participantCount: names.length,
      days,
      tickets: createdTickets.map(serializeTicket)
    });
  } catch (error) { next(error); }
});

app.post('/api/admin/tickets/:id/send', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const ticket = Number.isInteger(id) ? getTicketById(id) : null;
    if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });
    if (!emailAvailable()) return res.status(503).json({ error: 'Email is not configured. Please connect your Google / Gmail account in the portal.' });
    const result = await emailTicket(ticket);
    const updated = serializeTicket(getTicketById(id));
    sheetsUpdateTicket(updated).catch((err) => console.error('Sheet update error:', err.message));
    if (result.status === 'failed') return res.status(502).json({ error: `Email could not be sent: ${result.error}`, ticket: updated });
    res.json({ message: `Ticket emailed to ${ticket.email}.`, ticket: updated });
  } catch (error) { next(error); }
});

app.post('/api/admin/tickets/email-all', requireAdmin, async (req, res, next) => {
  try {
    if (!emailAvailable()) {
      return res.status(503).json({ error: 'Email is not configured. Please connect your Google / Gmail account in the portal.' });
    }
    const mode = req.body && req.body.mode === 'all' ? 'all' : 'pending';
    const tickets = mode === 'all'
      ? db.prepare("SELECT * FROM tickets WHERE email != '' ORDER BY id ASC").all()
      : db.prepare("SELECT * FROM tickets WHERE email != '' AND (email_status IS NULL OR email_status != 'sent') ORDER BY id ASC").all();

    if (tickets.length === 0) {
      return res.json({
        total: 0,
        sent: 0,
        failed: 0,
        message: mode === 'all' ? 'No tickets with email addresses found.' : 'All students have already received their tickets!'
      });
    }

    let sent = 0;
    let failed = 0;
    for (const t of tickets) {
      const r = await emailTicket(t);
      if (r.status === 'sent') sent++;
      else failed++;
    }

    res.json({
      total: tickets.length,
      sent,
      failed,
      message: `Delivered ${sent} ticket${sent === 1 ? '' : 's'}${failed ? ` (${failed} failed)` : ''}.`
    });
  } catch (error) { next(error); }
});

app.delete('/api/admin/tickets/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid ticket.' });
  const existing = getTicketById(id);
  if (!existing) return res.status(404).json({ error: 'Ticket not found.' });
  cancelledCodes.add(existing.ticket_code);
  const result = db.prepare('DELETE FROM tickets WHERE id = ?').run(id);
  if (!result.changes) return res.status(404).json({ error: 'Ticket not found.' });
  sheetsCancelTicket(existing.ticket_code).catch((err) => console.error('Sheet cancel error:', err.message));
  res.json({ message: 'Ticket cancelled. Its QR code will no longer work.' });
});

async function handleCheckinRequest(req, res, next) {
  try {
    const code = extractTicketCode(req.body.ticketCode);
    const match = code.match(/^[A-F0-9]{16}$/);
    if (!match) return res.status(400).json({ error: 'Enter a valid ticket code or scan a CAIPSD ticket QR.' });
    if (cancelledCodes.has(match[0])) {
      return res.status(404).json({ error: 'Ticket not found. This ticket is invalid or was cancelled.' });
    }
    let ticket = getTicketByCode(match[0]);
    if (!ticket) {
      try {
        const sheetTickets = await getSheetTicketsCached();
        const found = sheetTickets.find((x) => x.ticket_code && x.ticket_code.toUpperCase() === match[0]);
        if (found && sheetTicketCancelled(found)) {
          return res.status(404).json({ error: 'Ticket not found. This ticket is invalid or was cancelled.' });
        }
        if (found) {
          const issued = isoOr(found.issued_at, new Date().toISOString());
          const validUntil = isoOr(found.valid_until, new Date(Date.now() + getDefaultValidDays() * 86400000).toISOString());
          db.prepare(`INSERT OR IGNORE INTO tickets (full_name, email, phone, ticket_code, issued_at, valid_until, entry_count, first_entry_at, last_entry_at, email_status, max_days) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            found.full_name || 'Participant',
            found.email || '',
            found.phone || '',
            match[0],
            issued,
            validUntil,
            found.entry_count || 0,
            found.first_entry_at || null,
            found.last_entry_at || null,
            found.email_status || 'not_sent',
            getDefaultValidDays()
          );
          ticket = getTicketByCode(match[0]);
        }
      } catch (err) { console.warn('Sheet lookup during check-in failed:', err.message); }
    }
    if (!ticket) return res.status(404).json({ error: 'Ticket not found. This ticket is invalid or was cancelled.' });
    const now = new Date();
    if (new Date(ticket.valid_until).getTime() <= now.getTime()) {
      return res.status(410).json({ error: 'This ticket has expired.', ticket: serializeTicket(ticket) });
    }

    const maxDays = Number(ticket.max_days) || 1;

    // 1. Total entries limit: 1 ticket sirf 1 bar he use ho sakta hai
    if (ticket.entry_count >= maxDays) {
      return res.status(409).json({
        error: 'Already used ticket! Yeh ticket pehle hi use ho chuka hai (Entry Denied).',
        alreadyUsed: true,
        limitReached: true,
        maxDays,
        ticket: serializeTicket(ticket)
      });
    }

    // 2. Day N Ticket restriction: Day N ticket can only be used on Day N!
    const dayMatch = (ticket.full_name || '').match(/\(Day\s*(\d+)\)/i);
    const passDay = dayMatch ? parseInt(dayMatch[1], 10) : 1;
    let currentEventDay = 1;
    if (req.body.activeDay && req.body.activeDay !== 'auto') {
      currentEventDay = Math.max(1, parseInt(req.body.activeDay, 10) || 1);
    } else {
      const todayLocal = getLocalDateString(now);
      const issuedLocal = getLocalDateString(new Date(ticket.issued_at));
      const day1Date = getEventDay1Date() || issuedLocal;

      try {
        const d1 = new Date(day1Date + 'T00:00:00');
        const dt = new Date(todayLocal + 'T00:00:00');
        const diffDays = Math.floor((dt - d1) / (24 * 60 * 60 * 1000));
        currentEventDay = Math.max(1, diffDays + 1);
      } catch {}
    }

    if (currentEventDay < passDay) {
      return res.status(409).json({
        error: `Day ${passDay} Ticket! Yeh ticket sirf Day ${passDay} par use ho sakta hai (Entry Denied).`,
        alreadyUsed: false,
        day2Early: passDay === 2,
        dayEarly: true,
        passDay,
        currentEventDay,
        maxDays,
        ticket: serializeTicket(ticket)
      });
    }

    if (dayMatch && passDay < currentEventDay) {
      return res.status(409).json({
        error: `Day ${passDay} Ticket! Yeh ticket Day ${passDay} ke liye tha (Entry Denied).`,
        alreadyUsed: (ticket.entry_count || 0) > 0,
        dayExpired: true,
        passDay,
        currentEventDay,
        maxDays,
        ticket: serializeTicket(ticket)
      });
    }

    // 3. 1 scan per calendar day
    const todayLocal = getLocalDateString(now);
    const todayIso = now.toISOString().slice(0, 10);
    const pastEntries = db.prepare('SELECT scanned_at FROM entries WHERE ticket_id = ? ORDER BY id ASC').all(ticket.id);
    let alreadyScannedToday = false;
    if (pastEntries.length > 0) {
      alreadyScannedToday = pastEntries.some((entry) => {
        const d = new Date(entry.scanned_at);
        return getLocalDateString(d) === todayLocal || entry.scanned_at.slice(0, 10) === todayIso;
      });
    } else if (ticket.last_entry_at) {
      const d = new Date(ticket.last_entry_at);
      if (getLocalDateString(d) === todayLocal || ticket.last_entry_at.slice(0, 10) === todayIso) {
        alreadyScannedToday = true;
      }
    }

    if (alreadyScannedToday) {
      return res.status(409).json({
        error: 'Already used ticket! Yeh ticket aaj pehle hi use ho chuka hai (Entry Denied).',
        alreadyUsed: true,
        alreadyScannedToday: true,
        maxDays,
        ticket: serializeTicket(ticket)
      });
    }

    const scannedAt = now.toISOString();
    db.transaction(() => {
      db.prepare('INSERT INTO entries (ticket_id, scanned_at) VALUES (?, ?)').run(ticket.id, scannedAt);
      db.prepare('UPDATE tickets SET entry_count = entry_count + 1, first_entry_at = COALESCE(first_entry_at, ?), last_entry_at = ? WHERE id = ?').run(scannedAt, scannedAt, ticket.id);
    })();
    const updated = serializeTicket(getTicketById(ticket.id));
    const baseName = (ticket.full_name || '').replace(/\s*\((?:Day\s*\d+|Day\d+)\)$/i, '').trim();
    const siblingTickets = db.prepare('SELECT * FROM tickets WHERE full_name LIKE ? OR full_name = ?').all(`${baseName}%`, baseName).map(serializeTicket);
    sheetsUpdateTicket(updated, siblingTickets).catch((err) => console.error('Sheet update error:', err.message));

    const dayNumber = updated.entry_count;
    const dayTag = dayMatch ? `Day ${passDay}` : 'Pass';
    const message = `Entry allowed! Welcome (${dayTag} check-in successful).`;

    res.json({
      message,
      dayNumber,
      maxDays,
      repeat: dayNumber > 1,
      ticket: updated
    });
  } catch (error) { next(error); }
}

app.post('/api/check-in', checkinLimiter, handleCheckinRequest);
app.post('/api/admin/check-in', requireAdmin, handleCheckinRequest);

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
        if (sheetTicketCancelled(t)) continue;
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
          const issued = isoOr(t.issued_at, new Date().toISOString());
          const valid = isoOr(t.valid_until, new Date(Date.now() + TICKET_VALID_DAYS * 86400000).toISOString());
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
