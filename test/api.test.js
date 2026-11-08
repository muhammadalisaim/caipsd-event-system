process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret';
process.env.ADMIN_EMAIL = 'admin@test.org';
process.env.ADMIN_PASSWORD = 'TestPassword123!';
process.env.SMTP_JSON = '1'; // capture emails in-memory instead of sending
process.env.TICKET_VALID_DAYS = '3';

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
  assert.equal((await post({ ...person, email: 'bad' })).status, 400);
  assert.equal((await post({ ...person, phone: 'abc' })).status, 400);
  assert.equal((await post({ ...person, fullName: '' })).status, 400);
});

let ticket; let ticketId;
test('issues a ticket valid for 3 days, saves it and emails the QR', async () => {
  const r = await call('/api/admin/tickets', { method: 'POST', body: person });
  assert.equal(r.status, 201);
  ticket = r.data.ticket; ticketId = ticket.id;
  assert.match(ticket.ticket_code, /^[A-F0-9]{16}$/);
  assert.equal(ticket.email, 'ayesha@example.com');
  const days = (new Date(ticket.valid_until) - new Date(ticket.issued_at)) / 86400000;
  assert.equal(days, 3);
  assert.equal(r.data.email.status, 'sent');
  assert.equal(r.data.ticket.email_status, 'sent');
});

test('email message contains the ticket details and an embedded QR', async () => {
  const msg = buildMessage(db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId), Buffer.from('png'));
  assert.equal(msg.to, 'ayesha@example.com');
  assert.ok(msg.html.includes(ticket.ticket_code) && msg.html.includes('cid:ticket-qr'));
  assert.equal(msg.attachments[0].cid, 'ticket-qr');
});

test('one ticket per email address', async () => {
  const dup = await call('/api/admin/tickets', { method: 'POST', body: { ...person, email: 'AYESHA@example.com' } });
  assert.equal(dup.status, 409);
});

test('tickets can be created without emailing, and resent later', async () => {
  const r = await call('/api/admin/tickets', { method: 'POST', body: { fullName: 'Bilal Ahmed', email: 'bilal@example.com', phone: '0300-1112223', sendEmail: false } });
  assert.equal(r.status, 201);
  assert.equal(r.data.email.status, 'not_sent');
  const send = await call(`/api/admin/tickets/${r.data.ticket.id}/send`, { method: 'POST' });
  assert.equal(send.status, 200);
  assert.equal(send.data.ticket.email_status, 'sent');
});

test('public ticket page data hides contact details', async () => {
  const r = await call(`/api/ticket/${ticket.ticket_code}`, { auth: false });
  assert.equal(r.status, 200);
  assert.match(r.data.ticket.qrDataUrl, /^data:image\/png/);
  assert.equal(r.data.ticket.email, undefined);
  assert.equal(r.data.ticket.phone, undefined);
  assert.equal((await call('/api/ticket/NOTAREALTICKET00', { auth: false })).status, 404);
});

test('entry can be scanned repeatedly while the ticket is valid', async () => {
  const first = await call('/api/admin/check-in', { method: 'POST', body: { ticketCode: ticket.ticket_code } });
  assert.equal(first.status, 200);
  assert.equal(first.data.repeat, false);
  const second = await call('/api/admin/check-in', { method: 'POST', body: { ticketCode: `caipsd|ticket|${ticket.ticket_code.toLowerCase()}` } });
  assert.equal(second.status, 200);
  assert.equal(second.data.repeat, true);
  assert.equal(second.data.ticket.entry_count, 2);
  assert.equal((await call('/api/admin/check-in', { method: 'POST', body: { ticketCode: 'zzz' } })).status, 400);
  assert.equal((await call('/api/admin/check-in', { method: 'POST', body: { ticketCode: '0000000000000000' } })).status, 404);
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
  assert.deepEqual({ total: s.data.total, expired: s.data.expired, awaiting: s.data.awaiting }, { total: 2, expired: 1, awaiting: 1 });
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
