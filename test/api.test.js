process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret';
process.env.ADMIN_EMAIL = 'admin@test.org';
process.env.ADMIN_PASSWORD = 'TestPassword123!';
process.env.SMTP_JSON = '1'; // capture emails in-memory instead of sending
process.env.TICKET_VALID_DAYS = '2';

const test = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../server');
const { db } = require('../db');
const { buildMessage } = require('../mailer');

let server; let base; let cookie = '';
test.before(() => new Promise((resolve) => {
  server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => server.close(resolve)));

async function call(path, { method = 'GET', body, auth = true, redirect = 'follow' } = {}) {
  const res = await fetch(base + path, {
    method, redirect,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(auth && cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const type = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, data: type.includes('json') ? await res.json() : await res.text() };
}
const person = { fullName: 'Ayesha Khan', email: 'Ayesha@Example.com', phone: '+92 300 1234567' };

test('public registration is gone; root goes to the portal', async () => {
  assert.equal((await call('/api/register', { method: 'POST', body: person, auth: false })).status, 404);
  assert.equal((await call('/api/workshops', { auth: false })).status, 404);
  const root = await call('/', { redirect: 'manual', auth: false });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), '/admin.html');
});

test('admin routes require login', async () => {
  for (const [path, method] of [['/api/admin/summary', 'GET'], ['/api/admin/tickets', 'GET'], ['/api/admin/tickets', 'POST'], ['/api/admin/check-in', 'POST']]) {
    assert.equal((await call(path, { method, auth: false, body: method === 'POST' ? {} : undefined })).status, 401, path);
  }
});

test('login rejects wrong password and accepts the right one', async () => {
  assert.equal((await call('/api/admin/login', { method: 'POST', auth: false, body: { email: 'admin@test.org', password: 'nope' } })).status, 401);
  assert.equal((await call('/api/admin/login', { method: 'POST', auth: false, body: { email: 'admin@test.org', password: 'TestPassword123!' } })).status, 200);
});

test('ticket validation', async () => {
  const post = (body) => call('/api/admin/tickets', { method: 'POST', body });
  assert.equal((await post({ fullName: '' })).status, 400);
  assert.equal((await post({ fullName: 'A' })).status, 400);
});

let ticket; let ticketId;
test('issues a ticket by participant name', async () => {
  const r = await call('/api/admin/tickets', { method: 'POST', body: { fullName: 'Ayesha Khan' } });
  assert.equal(r.status, 201);
  ticket = r.data.ticket; ticketId = ticket.id;
  assert.match(ticket.ticket_code, /^[A-F0-9]{16}$/);
  assert.equal(ticket.full_name, 'Ayesha Khan');
  const days = Math.round((new Date(ticket.valid_until) - new Date(ticket.issued_at)) / 86400000);
  assert.ok(days >= 2);
});

test('bulk issue tickets by list of names', async () => {
  const r = await call('/api/admin/tickets/bulk', { method: 'POST', body: { names: 'Bilal Ahmed\nFatima Noor\nUsman Ali' } });
  assert.equal(r.status, 201);
  assert.equal(r.data.count, 3);
  assert.equal(r.data.tickets.length, 3);
});

test('public ticket page loads without error', async () => {
  const r = await call(`/api/ticket/${ticket.ticket_code}`, { auth: false });
  assert.equal(r.status, 200);
  assert.match(r.data.ticket.qrDataUrl, /^data:image\/png/);
  assert.equal(r.data.ticket.full_name, 'Ayesha Khan');
  assert.equal((await call('/api/ticket/NOTAREALTICKET00', { auth: false })).status, 404);
});

test('gate check-in allows 1 scan on Day 1 and blocks second scan on the same day', async () => {
  const first = await call('/api/admin/check-in', { method: 'POST', body: { ticketCode: ticket.ticket_code } });
  assert.equal(first.status, 200);
  assert.equal(first.data.dayNumber, 1);
  assert.equal(first.data.repeat, false);

  // Second scan today -> must be rejected (409)
  const secondToday = await call('/api/admin/check-in', { method: 'POST', body: { ticketCode: ticket.ticket_code } });
  assert.equal(secondToday.status, 409);
  assert.ok(secondToday.data.alreadyScannedToday);

  // Invalid formats and unknown codes
  assert.equal((await call('/api/admin/check-in', { method: 'POST', body: { ticketCode: 'zzz' } })).status, 400);
  assert.equal((await call('/api/admin/check-in', { method: 'POST', body: { ticketCode: '0000000000000000' } })).status, 404);
});

test('gate check-in allows 1 scan on Day 2, and blocks third scan', async () => {
  // Simulate Day 1 entry occurred yesterday
  db.prepare('UPDATE entries SET scanned_at = ? WHERE ticket_id = ?').run(new Date(Date.now() - 86400000).toISOString(), ticketId);

  // Day 2 scan -> allowed (visit 2)
  const day2Scan = await call('/api/admin/check-in', { method: 'POST', body: { ticketCode: ticket.ticket_code } });
  assert.equal(day2Scan.status, 200);
  assert.equal(day2Scan.data.dayNumber, 2);
  assert.equal(day2Scan.data.repeat, true);

  // Repeated scan on Day 2 -> rejected (409 already scanned today)
  const day2Repeat = await call('/api/admin/check-in', { method: 'POST', body: { ticketCode: ticket.ticket_code } });
  assert.equal(day2Repeat.status, 409);

  // Third scan simulation (both days used, new day) -> rejected (409 limit reached)
  db.prepare('UPDATE entries SET scanned_at = ? WHERE id = (SELECT id FROM entries WHERE ticket_id = ? ORDER BY id DESC LIMIT 1)').run(new Date(Date.now() - 40000000).toISOString(), ticketId);
  const thirdScan = await call('/api/admin/check-in', { method: 'POST', body: { ticketCode: ticket.ticket_code } });
  assert.equal(thirdScan.status, 409);
  assert.ok(thirdScan.data.limitReached);
});

test('expired tickets are rejected', async () => {
  db.prepare('UPDATE tickets SET valid_until = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), ticketId);
  const r = await call('/api/admin/check-in', { method: 'POST', body: { ticketCode: ticket.ticket_code } });
  assert.equal(r.status, 410);
  const list = await call('/api/admin/tickets?status=expired');
  assert.equal(list.data.tickets.length, 1);
  const pub = await call(`/api/ticket/${ticket.ticket_code}`, { auth: false });
  assert.equal(pub.data.ticket.status, 'expired');
});

test('summary counts and search', async () => {
  const s = await call('/api/admin/summary');
  assert.deepEqual({ total: s.data.total, expired: s.data.expired, awaiting: s.data.awaiting }, { total: 4, expired: 1, awaiting: 3 });
  assert.equal((await call('/api/admin/tickets?q=bilal')).data.tickets.length, 1);
  assert.equal((await call('/api/admin/tickets?q=%25')).data.tickets.length, 0);
});

test('cancelling a ticket invalidates its QR', async () => {
  assert.equal((await call(`/api/admin/tickets/${ticketId}`, { method: 'DELETE' })).status, 200);
  assert.equal((await call(`/api/ticket/${ticket.ticket_code}`, { auth: false })).status, 404);
  assert.equal((await call('/api/admin/check-in', { method: 'POST', body: { ticketCode: ticket.ticket_code } })).status, 404);
});

test('CSV export neutralises formulas', async () => {
  await call('/api/admin/tickets', { method: 'POST', body: { fullName: '=cmd|calc', email: 'f@example.com', phone: '+92 300 0000000', sendEmail: false } });
  const r = await call('/api/admin/export.csv');
  assert.equal(r.status, 200);
  assert.ok(r.data.includes(`"'=cmd|calc"`));
});

test('portal, ticket page, 404 page and vendored scanner are served', async () => {
  assert.equal((await call('/admin.html', { auth: false })).status, 200);
  assert.equal((await call('/ticket.html', { auth: false })).status, 200);
  assert.equal((await call('/vendor/html5-qrcode/html5-qrcode.min.js', { auth: false })).status, 200);
  const nf = await call('/nope', { auth: false });
  assert.equal(nf.status, 404); assert.ok(String(nf.data).includes('404'));
  assert.equal((await call('/api/nope', { auth: false })).status, 404);
});

test('Google Sheets integration endpoints and configuration', async () => {
  const { getSheetsConfig, getAppsScriptTemplate } = require('../sheets');
  const tpl = getAppsScriptTemplate();
  assert.ok(tpl.includes('function doPost(e)'));
  assert.ok(tpl.includes('action === \'syncAll\''));
  assert.ok(tpl.includes('action === \'sendTicketEmail\''));
  assert.ok(tpl.includes('action === \'sendTestEmail\''));

  const initial = getSheetsConfig();
  assert.equal(typeof initial.configured, 'boolean');

  // Save config via admin endpoint
  const saveRes = await call('/api/admin/sheets/config', {
    method: 'POST',
    body: { webhookUrl: 'https://script.google.com/macros/s/example/exec', sheetName: 'EventTickets', autoSync: true }
  });
  assert.equal(saveRes.status, 200);
  assert.equal(saveRes.data.config.sheetName, 'EventTickets');
  assert.equal(saveRes.data.config.configured, true);

  // Fetch config via admin endpoint
  const getRes = await call('/api/admin/sheets/config');
  assert.equal(getRes.status, 200);
  assert.equal(getRes.data.config.sheetName, 'EventTickets');

  // Fetch template
  const templateRes = await call('/api/admin/sheets/template');
  assert.equal(templateRes.status, 200);
  assert.ok(templateRes.data.template.includes('SpreadsheetApp'));
});

test('Google mail config and 1-click email-all endpoints', async () => {
  // Test config retrieval
  const mailConfigRes = await call('/api/admin/mail/config');
  assert.equal(mailConfigRes.status, 200);
  assert.equal(typeof mailConfigRes.data.configured, 'boolean');

  // Test mail validation
  const badMailRes = await call('/api/admin/mail/config', {
    method: 'POST',
    body: { user: 'not-an-email', pass: 'secret' }
  });
  assert.equal(badMailRes.status, 400);

  // Test sending a test email (SMTP_JSON is active in test)
  const testMailRes = await call('/api/admin/mail/test', {
    method: 'POST',
    body: { to: 'organizer@caipsd.org' }
  });
  assert.equal(testMailRes.status, 200);
  assert.ok(testMailRes.data.message.includes('Test email sent successfully'));

  // Test 1-click bulk emailing all students
  const emailAllRes = await call('/api/admin/tickets/email-all', {
    method: 'POST',
    body: { mode: 'pending' }
  });
  assert.equal(emailAllRes.status, 200);
  assert.equal(typeof emailAllRes.data.sent, 'number');
  assert.equal(typeof emailAllRes.data.total, 'number');
});

test('configurable duration (2, 3, 4 days) and check-in limits', async () => {
  // Test getting and updating default duration
  const getDur = await call('/api/admin/settings/duration');
  assert.equal(getDur.status, 200);
  assert.equal(typeof getDur.data.validDays, 'number');

  const setDur = await call('/api/admin/settings/duration', {
    method: 'POST',
    body: { validDays: 4 }
  });
  assert.equal(setDur.status, 200);
  assert.equal(setDur.data.validDays, 4);

  // Issue ticket using the new default (4 days)
  const t4Res = await call('/api/admin/tickets', {
    method: 'POST',
    body: { fullName: 'Hamza Tariq' }
  });
  assert.equal(t4Res.status, 201);
  const t4 = t4Res.data.ticket;
  assert.equal(t4.max_days, 4);

  // Issue ticket explicitly overriding to 3 days
  const t3Res = await call('/api/admin/tickets', {
    method: 'POST',
    body: { fullName: 'Zainab Bibi', days: 3 }
  });
  assert.equal(t3Res.status, 201);
  const t3 = t3Res.data.ticket;
  assert.equal(t3.max_days, 3);

  // Verify 3-day ticket allows Day 1, Day 2, Day 3 and blocks Day 4
  // Day 1
  const d1 = await call('/api/admin/check-in', { method: 'POST', body: { ticketCode: t3.ticket_code } });
  assert.equal(d1.status, 200);
  assert.equal(d1.data.dayNumber, 1);
  assert.equal(d1.data.maxDays, 3);

  // Simulate Day 2
  db.prepare('UPDATE entries SET scanned_at = ? WHERE ticket_id = ?').run(new Date(Date.now() - 86400000 * 2).toISOString(), t3.id);
  const d2 = await call('/api/admin/check-in', { method: 'POST', body: { ticketCode: t3.ticket_code } });
  assert.equal(d2.status, 200);
  assert.equal(d2.data.dayNumber, 2);

  // Simulate Day 3
  db.prepare('UPDATE entries SET scanned_at = ? WHERE id = (SELECT id FROM entries WHERE ticket_id = ? ORDER BY id DESC LIMIT 1)').run(new Date(Date.now() - 86400000).toISOString(), t3.id);
  const d3 = await call('/api/admin/check-in', { method: 'POST', body: { ticketCode: t3.ticket_code } });
  assert.equal(d3.status, 200);
  assert.equal(d3.data.dayNumber, 3);
  assert.ok(d3.data.message.includes('Final Day'));

  // Day 4 attempt -> blocked because max_days is 3
  db.prepare('UPDATE entries SET scanned_at = ? WHERE id = (SELECT id FROM entries WHERE ticket_id = ? ORDER BY id DESC LIMIT 1)').run(new Date(Date.now() - 40000000).toISOString(), t3.id);
  const d4 = await call('/api/admin/check-in', { method: 'POST', body: { ticketCode: t3.ticket_code } });
  assert.equal(d4.status, 409);
  assert.ok(d4.data.limitReached);
  assert.equal(d4.data.maxDays, 3);

  // Reset duration back to 2 days
  await call('/api/admin/settings/duration', { method: 'POST', body: { validDays: 2 } });
});
