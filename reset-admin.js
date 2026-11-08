require('dotenv').config();
const bcrypt = require('bcryptjs');
const { db } = require('./db');

const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const password = String(process.env.ADMIN_PASSWORD || '');

if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Set a valid ADMIN_EMAIL in .env first.');
  process.exit(1);
}
if (password.length < 10) {
  console.error('Set an ADMIN_PASSWORD of at least 10 characters in .env first.');
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 12);
const current = db.prepare('SELECT id FROM admins ORDER BY id LIMIT 1').get();
if (current) {
  db.prepare('UPDATE admins SET email = ?, password_hash = ? WHERE id = ?').run(email, hash, current.id);
  console.log(`Organizer credentials updated for ${email}.`);
} else {
  db.prepare('INSERT INTO admins (email, password_hash) VALUES (?, ?)').run(email, hash);
  console.log(`Organizer account created for ${email}.`);
}
