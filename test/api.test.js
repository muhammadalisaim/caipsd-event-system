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

let ticket; let ticket2; let ticketId; let ticket2Id;
test('issues a ticket pair (Day 1 & Day 2) by participant name', async () => {
  const r = await call('/api/admin/tickets', { method: 'POST', body: { fullName: 'Ayesha Khan' } });
  assert.equal(r.status, 201);
  ticket = r.data.ticket; ticketId = ticket.id;
  ticket2 = r.data.ticket2; ticket2Id = ticket2.id;
  assert.match(ticket.ticket_code, /^[A-F0-9]{16}$/);
  assert.match(ticket2.ticket_code, /^[A-F0-9]{16}$/);
  assert.equal(ticket.full_name, 'Ayesha Khan (Day 1)');
  assert.equal(ticket2.full_name, 'Ayesha Khan (Day 2)');
  assert.equal(ticket.max_days, 1);
  assert.equal(ticket2.max_days, 1);
});

test('bulk issue tickets creates 2 passes per participant name', async () => {
  const r = await call('/api/admin/tickets/bulk', { method: 'POST', body: { names: 'Bilal Ahmed\nFatima Noor\nUsman Ali' } });
  assert.equal(r.status, 201);
  assert.equal(r.data.count, 6);
  assert.equal(r.data.tickets.length, 6);
  assert.equal(r.data.participantCount, 3);
});

test('public ticket page loads without error', async () => {
  const r = await call(`/api/ticket/${ticket.ticket_code}`, { auth: false });
  assert.equal(r.status, 200);
  assert.match(r.data.ticket.qrDataUrl, /^data:image\/png/);
  assert.equal(r.data.ticket.full_name, 'Ayesha Khan (Day 1)');
  assert.equal((await call('/api/ticket/NOTAREALTICKET00', { auth: false })).status, 404);
});

test('gate check-in allows 1 scan on Day 1 and blocks Day 2 ticket on Day 1', async () => {
  // Attempting to scan Day 2 ticket on Day 1 -> rejected (409)
  const day2Early = await call('/api/admin/check-in', { method: 'POST', body: { ticketCode: ticket2.ticket_code } });
  assert.equal(day2Early.status, 409);
  assert.ok(day2Early.data.day2Early);

  // Day 1 ticket scan -> allowed
  const first = await call('/api/admin/check-in', { method: 'POST', body: { ticketCode: ticket.ticket_code } });
  assert.equal(first.status, 200);
  assert.equal(first.data.dayNumber, 1);
  assert.equal(first.data.repeat, false);

  // Second scan of Day 1 ticket -> rejected (409 already used)
  const secondToday = await call('/api/admin/check-in', { method: 'POST', body: { ticketCode: ticket.ticket_code } });
  assert.equal(secondToday.status, 409);
  assert.ok(secondToday.data.alreadyUsed);

  // Invalid formats and unknown codes
  assert.equal((await call('/api/admin/check-in', { method: 'POST', body: { ticketCode: 'zzz' } })).status, 400);
  assert.equal((await call('/api/admin/check-in', { method: 'POST', body: { ticketCode: '0000000000000000' } })).status, 404);
});

test('gate check-in allows Day 2 ticket on Day 2 and blocks repeated scan', async () => {
  // Simulate Day 1 was yesterday
  db.prepare('UPDATE entries SET scanned_at = ? WHERE ticket_id = ?').run(new Date(Date.now() - 86400000).toISOString(), ticketId);
  db.prepare('UPDATE tickets SET issued_at = ? WHERE id = ?').run(new Date(Date.now() - 86400000).toISOString(), ticket2Id);

  // Day 2 scan -> allowed
  const day2Scan = await call('/api/admin/check-in', { method: 'POST', body: { ticketCode: ticket2.ticket_code } });
  assert.equal(day2Scan.status, 200);
  assert.equal(day2Scan.data.dayNumber, 1); // 1st entry of Day 2 pass

  // Repeated scan of Day 2 ticket -> rejected (409 already used)
  const day2Repeat = await call('/api/admin/check-in', { method: 'POST', body: { ticketCode: ticket2.ticket_code } });
  assert.equal(day2Repeat.status, 409);
  assert.ok(day2Repeat.data.alreadyUsed);

  // Attempting to re-use Day 1 ticket on Day 2 -> rejected (409 already used)
  const day1Recheck = await call('/api/admin/check-in', { method: 'POST', body: { ticketCode: ticket.ticket_code } });
  assert.equal(day1Recheck.status, 409);
  assert.ok(day1Recheck.data.alreadyUsed);
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
  assert.deepEqual({ total: s.data.total, expired: s.data.expired, awaiting: s.data.awaiting }, { total: 8, expired: 1, awaiting: 6 });
  assert.equal((await call('/api/admin/tickets?q=bilal')).data.tickets.length, 2);
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
  assert.ok(r.data.includes(`"'=cmd|calc`));
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

  // Issue ticket using the new default (4 days validity)
  const t4Res = await call('/api/admin/tickets', {
    method: 'POST',
    body: { fullName: 'Hamza Tariq' }
  });
  assert.equal(t4Res.status, 201);
  const t4 = t4Res.data.ticket;
  assert.equal(t4.max_days, 1);
  assert.ok(new Date(t4.valid_until) > new Date(t4.issued_at));

  // Issue ticket explicitly with days parameter
  const t3Res = await call('/api/admin/tickets', {
    method: 'POST',
    body: { fullName: 'Zainab Bibi', days: 3 }
  });
  assert.equal(t3Res.status, 201);
  const t3 = t3Res.data.ticket;
  assert.equal(t3.max_days, 1);

  // Day 1 scan -> allowed
  const d1 = await call('/api/admin/check-in', { method: 'POST', body: { ticketCode: t3.ticket_code } });
  assert.equal(d1.status, 200);
  assert.equal(d1.data.dayNumber, 1);

  // Repeated scan -> blocked because 1 ticket allows 1 entry
  const d2 = await call('/api/admin/check-in', { method: 'POST', body: { ticketCode: t3.ticket_code } });
  assert.equal(d2.status, 409);
  assert.ok(d2.data.alreadyUsed);

  // Reset duration back to 2 days
  await call('/api/admin/settings/duration', { method: 'POST', body: { validDays: 2 } });
});
