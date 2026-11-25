const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
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
    email TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    ticket_code TEXT NOT NULL UNIQUE,
    group_id TEXT,
    issued_at TEXT NOT NULL,
    valid_until TEXT NOT NULL,
    entry_count INTEGER NOT NULL DEFAULT 0,
    max_days INTEGER NOT NULL DEFAULT 2,
    first_entry_at TEXT,
    last_entry_at TEXT,
    email_status TEXT NOT NULL DEFAULT 'not_sent',
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

  CREATE TABLE IF NOT EXISTS cancelled_tickets (
    ticket_code TEXT PRIMARY KEY,
    cancelled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_tickets_code ON tickets(ticket_code);
  CREATE INDEX IF NOT EXISTS idx_tickets_valid ON tickets(valid_until);
  CREATE INDEX IF NOT EXISTS idx_entries_ticket ON entries(ticket_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expired ON sessions(expired);
  CREATE INDEX IF NOT EXISTS idx_cancelled_tickets_code ON cancelled_tickets(ticket_code);
`);

// Migration: add max_days column if missing
try {
  db.exec("ALTER TABLE tickets ADD COLUMN max_days INTEGER NOT NULL DEFAULT 2");
} catch {}

// Migration: add event_date column if missing
try {
  db.exec("ALTER TABLE tickets ADD COLUMN event_date TEXT");
} catch {}

// Migration: add group_id column if missing
try {
  db.exec("ALTER TABLE tickets ADD COLUMN group_id TEXT");
} catch {}
try {
  db.exec("CREATE INDEX IF NOT EXISTS idx_tickets_group ON tickets(group_id)");
} catch {}

// Backfill group_id for existing tickets where group_id is NULL
try {
  const unassigned = db.prepare("SELECT id, full_name, email, issued_at FROM tickets WHERE group_id IS NULL OR group_id = '' ORDER BY id ASC").all();
  if (unassigned && unassigned.length > 0) {
    const groups = new Map();
    for (const t of unassigned) {
      const baseName = (t.full_name || '').replace(/\s*\((?:Day\s*\d+|Day\d+)\)$/i, '').trim().toLowerCase();
      const dateKey = (t.issued_at || '').slice(0, 10);
      const key = `${baseName}::${t.email || ''}::${dateKey}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t.id);
    }
    const updateStmt = db.prepare("UPDATE tickets SET group_id = ? WHERE id = ?");
    db.transaction(() => {
      for (const ids of groups.values()) {
        const gid = crypto.randomBytes(8).toString('hex');
        for (const id of ids) {
          updateStmt.run(gid, id);
        }
      }
    })();
  }
} catch (eGid) { console.warn('group_id backfill notice:', eGid.message); }


// Migration: remove unique constraint on email if present in existing table
try {
  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tickets'").get();
  if (tableSql && tableSql.sql && (tableSql.sql.includes('email TEXT NOT NULL UNIQUE') || tableSql.sql.includes('email TEXT UNIQUE'))) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE tickets_migrated (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        full_name TEXT NOT NULL,
        email TEXT DEFAULT '',
        phone TEXT DEFAULT '',
        ticket_code TEXT NOT NULL UNIQUE,
        issued_at TEXT NOT NULL,
        valid_until TEXT NOT NULL,
        entry_count INTEGER NOT NULL DEFAULT 0,
        first_entry_at TEXT,
        last_entry_at TEXT,
        email_status TEXT NOT NULL DEFAULT 'not_sent',
        emailed_at TEXT,
        email_error TEXT
      );
      INSERT INTO tickets_migrated (id, full_name, email, phone, ticket_code, issued_at, valid_until, entry_count, first_entry_at, last_entry_at, email_status, emailed_at, email_error)
        SELECT id, full_name, COALESCE(email, ''), COALESCE(phone, ''), ticket_code, issued_at, valid_until, entry_count, first_entry_at, last_entry_at, COALESCE(email_status, 'not_sent'), emailed_at, email_error FROM tickets;
      DROP TABLE tickets;
      ALTER TABLE tickets_migrated RENAME TO tickets;
      CREATE INDEX IF NOT EXISTS idx_tickets_code ON tickets(ticket_code);
      CREATE INDEX IF NOT EXISTS idx_tickets_valid ON tickets(valid_until);
      PRAGMA foreign_keys = ON;
    `);
  }
} catch (e) {
  console.warn('Migration check:', e.message);
}

function initializeAdmin(email, password) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail || !password) throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD are required.');
  const existing = db.prepare('SELECT id, email, password_hash FROM admins WHERE email = ?').get(normalizedEmail);
  if (!existing) {
    const hash = bcrypt.hashSync(password, 12);
    db.prepare('INSERT INTO admins (email, password_hash) VALUES (?, ?)').run(normalizedEmail, hash);
    console.log(`Admin account created for ${normalizedEmail}`);
  } else if (!bcrypt.compareSync(password, existing.password_hash)) {
    const hash = bcrypt.hashSync(password, 12);
    db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hash, existing.id);
    console.log(`Admin password updated for ${normalizedEmail}`);
  }
}

let ephemeralDevSecret = null;
function getEncryptionKey() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SESSION_SECRET must be set and at least 32 characters long for encryption.');
    }
    if (!ephemeralDevSecret) {
      ephemeralDevSecret = crypto.randomBytes(32).toString('hex');
      console.warn('WARNING: SESSION_SECRET is missing or under 32 characters. Generated ephemeral random key for encryption in development/test mode.');
    }
    return crypto.createHash('sha256').update(ephemeralDevSecret).digest();
  }
  return crypto.createHash('sha256').update(secret).digest();
}

function encryptSecret(plainText) {
  if (plainText === null || plainText === undefined) return '';
  const str = String(plainText);
  if (!str) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(str, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `enc:gcm:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptSecret(cipherText) {
  if (!cipherText) return '';
  const str = String(cipherText);
  if (!str.startsWith('enc:gcm:')) {
    return str;
  }
  try {
    const parts = str.split(':');
    if (parts.length !== 5) return str;
    const iv = Buffer.from(parts[2], 'hex');
    const authTag = Buffer.from(parts[3], 'hex');
    const encrypted = Buffer.from(parts[4], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(), iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (err) {
    console.error('Failed to decrypt secret:', err.message);
    return '';
  }
}

let stmtGetSetting;
let stmtSetSetting;

function getSetting(key, defaultValue = null) {
  try {
    if (!stmtGetSetting) stmtGetSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
    const row = stmtGetSetting.get(key);
    if (!row) return defaultValue;
    if (key === 'smtp_pass') {
      return decryptSecret(row.value) || defaultValue;
    }
    return row.value;
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
  let valToStore = String(value ?? '');
  if (key === 'smtp_pass' && valToStore) {
    valToStore = encryptSecret(valToStore);
  }
  stmtSetSetting.run(key, valToStore);
}

function deleteSetting(key) {
  try {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  } catch { /* ignore */ }
}

let stmtIsCancelled;
let stmtRecordCancelled;

function isTicketCancelled(code) {
  if (!code) return false;
  try {
    if (!stmtIsCancelled) stmtIsCancelled = db.prepare('SELECT 1 FROM cancelled_tickets WHERE ticket_code = ?');
    return Boolean(stmtIsCancelled.get(String(code).toUpperCase()));
  } catch {
    return false;
  }
}

function recordTicketCancelled(code) {
  if (!code) return;
  try {
    if (!stmtRecordCancelled) {
      stmtRecordCancelled = db.prepare(`
        INSERT INTO cancelled_tickets (ticket_code, cancelled_at)
        VALUES (?, CURRENT_TIMESTAMP)
        ON CONFLICT(ticket_code) DO NOTHING
      `);
    }
    stmtRecordCancelled.run(String(code).toUpperCase());
  } catch {}
}

function updateAdminPassword(email, newPasswordHash) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  return db.prepare('UPDATE admins SET password_hash = ? WHERE email = ?').run(newPasswordHash, normalizedEmail);
}

module.exports = {
  db,
  initializeAdmin,
  getSetting,
  setSetting,
  deleteSetting,
  isTicketCancelled,
  recordTicketCancelled,
  updateAdminPassword,
  encryptSecret,
  decryptSecret
};

