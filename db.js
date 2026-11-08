const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'caipsd.sqlite');
if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Cache all prepared statements to eliminate Statement GC finalizer assertion races on Node 24
const originalPrepare = db.prepare.bind(db);
const statementCache = new Map();
db.prepare = function prepare(sql) {
  const key = typeof sql === 'string' ? sql.trim() : sql;
  let stmt = statementCache.get(key);
  if (!stmt) {
    stmt = originalPrepare(key);
    statementCache.set(key, stmt);
  }
  return stmt;
};


db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    phone TEXT NOT NULL,
    ticket_code TEXT NOT NULL UNIQUE,
    issued_at TEXT NOT NULL,
    valid_until TEXT NOT NULL,
    entry_count INTEGER NOT NULL DEFAULT 0,
    first_entry_at TEXT,
    last_entry_at TEXT,
    email_status TEXT NOT NULL DEFAULT 'not_sent' CHECK(email_status IN ('not_sent','sent','failed')),
    emailed_at TEXT,
    email_error TEXT
  );

  CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    scanned_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expired INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_tickets_code ON tickets(ticket_code);
  CREATE INDEX IF NOT EXISTS idx_tickets_valid ON tickets(valid_until);
  CREATE INDEX IF NOT EXISTS idx_entries_ticket ON entries(ticket_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expired ON sessions(expired);
`);

function initializeAdmin(email, password) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail || !password) throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD are required.');
  const existing = db.prepare('SELECT id FROM admins WHERE email = ?').get(normalizedEmail);
  if (!existing) {
    const hash = bcrypt.hashSync(password, 12);
    db.prepare('INSERT INTO admins (email, password_hash) VALUES (?, ?)').run(normalizedEmail, hash);
    console.log(`Admin account created for ${normalizedEmail}`);
  }
}

let stmtGetSetting;
let stmtSetSetting;

function getSetting(key, defaultValue = null) {
  try {
    if (!stmtGetSetting) stmtGetSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
    const row = stmtGetSetting.get(key);
    return row ? row.value : defaultValue;
  } catch {
    return defaultValue;
  }
}

function setSetting(key, value) {
  if (!stmtSetSetting) {
    stmtSetSetting = db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `);
  }
  stmtSetSetting.run(key, String(value ?? ''));
}

function deleteSetting(key) {
  try {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  } catch { /* ignore */ }
}

module.exports = { db, initializeAdmin, getSetting, setSetting, deleteSetting };
