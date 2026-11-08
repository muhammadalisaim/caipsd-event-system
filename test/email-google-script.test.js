/*
 * Email through the Google Apps Script channel (no SMTP configured).
 * A tiny local server plays the part of the deployed Apps Script web app.
 */
const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret';
process.env.ADMIN_EMAIL = 'admin@test.org';
process.env.ADMIN_PASSWORD = 'TestPassword123!';
delete process.env.SMTP_JSON; // no SMTP: the Google Script is the only email channel
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;
process.env.APP_URL = 'https://tickets.example.org/';
process.env.GOOGLE_WEBHOOK_SECRET = 'shared-secret-123';
process.env.ALLOWED_ORIGINS = 'https://friend.example';

const calls = [];
let emailMode = 'ok'; // 'ok' | 'error'
let sheetRows = [];
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const payload = JSON.parse(body || '{}');
    calls.push(payload);
    res.setHeader('Content-Type', 'application/json');
    if (payload.action === 'sendTicketEmail') {
      if (emailMode === 'error') return res.end(JSON.stringify({ status: 'error', message: 'Google Mail Permission Required' }));
      return res.end(JSON.stringify({ status: 'ok', message: `Ticket email delivered to ${payload.to}` }));
    }
    if (payload.action === 'getAll') return res.end(JSON.stringify({ status: 'ok', tickets: sheetRows }));
    res.end(JSON.stringify({ status: 'ok' }));
  });
});

let server; let base; let cookie = '';
test.before(async () => {
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  process.env.GOOGLE_SHEETS_WEBHOOK_URL = `http://127.0.0.1:${mock.address().port}/exec`;
  const { app } = require('../server');
  await new Promise((resolve) => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => mock.close(resolve));
});

async function call(path, { method = 'GET', body, auth = true, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(auth && cookie ? { Cookie: cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const type = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, data: type.includes('json') ? await res.json() : await res.text() };
}
const emailCalls = () => calls.filter((c) => c.action === 'sendTicketEmail');
const waitForBackgroundSync = () => new Promise((resolve) => setTimeout(resolve, 50));

test('login', async () => {
  const r = await call('/api/admin/login', { method: 'POST', auth: false, body: { email: 'admin@test.org', password: 'TestPassword123!' } });
  assert.equal(r.status, 200);
});

test('email counts as configured when only the Google Script is available', async () => {
  const r = await call('/api/admin/config');
  assert.equal(r.data.mail.configured, true);
  assert.equal(r.data.mail.channel, 'google-script');
  assert.equal(r.data.mail.smtpConfigured, false);
});

let first;
test('a new ticket is emailed automatically, with the QR image, link and secret', async () => {
  const r = await call('/api/admin/tickets', { method: 'POST', body: { fullName: 'Hina Malik', email: 'Hina@Example.com', phone: '0300 1112223' } });
  assert.equal(r.status, 201);
  assert.equal(r.data.email.status, 'sent');
  assert.equal(r.data.email.channel, 'google-script');
  assert.equal(r.data.ticket.email_status, 'sent');
  first = r.data.ticket;

  const sent = emailCalls();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'hina@example.com');
  assert.equal(sent[0].ticketCode, first.ticket_code);
  assert.equal(sent[0].secret, 'shared-secret-123');
  assert.equal(sent[0].viewLink, `https://tickets.example.org/ticket.html?code=${first.ticket_code}`);
  const png = Buffer.from(sent[0].qrPngBase64, 'base64');
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
});

test('a failed email is saved as failed (with the reason) and can be retried', async () => {
  emailMode = 'error';
  const r = await call('/api/admin/tickets', { method: 'POST', body: { fullName: 'Omar Raza', email: 'omar@example.com', phone: '0301 2223334' } });
  assert.equal(r.status, 201);
  assert.equal(r.data.email.status, 'failed');
  assert.match(r.data.email.error, /Permission Required/);
  assert.equal(r.data.ticket.email_status, 'failed');

  const send = await call(`/api/admin/tickets/${r.data.ticket.id}/send`, { method: 'POST' });
  assert.equal(send.status, 502);
  assert.equal(send.data.ticket.email_status, 'failed');

  emailMode = 'ok';
  const retry = await call(`/api/admin/tickets/${r.data.ticket.id}/send`, { method: 'POST' });
  assert.equal(retry.status, 200);
  assert.equal(retry.data.ticket.email_status, 'sent');
});

test('"Email all" sends to tickets that are still waiting', async () => {
  emailMode = 'error';
  const failed = await call('/api/admin/tickets', { method: 'POST', body: { fullName: 'Sana Iqbal', email: 'sana@example.com', phone: '0302 3334445' } });
  assert.equal(failed.data.email.status, 'failed');
  emailMode = 'ok';
  const all = await call('/api/admin/tickets/email-all', { method: 'POST', body: { mode: 'pending' } });
  assert.equal(all.status, 200);
  assert.equal(all.data.sent, 1);
  assert.equal(all.data.failed, 0);
});

test('a ticket can still be created without emailing', async () => {
  const before = emailCalls().length;
  const r = await call('/api/admin/tickets', { method: 'POST', body: { fullName: 'Zain Ali', email: 'zain@example.com', phone: '0303 4445556', sendEmail: false } });
  assert.equal(r.data.email.status, 'not_sent');
  assert.equal(emailCalls().length, before);
});

test('gate check-in never admits a ticket that was cancelled in the Google Sheet', async () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  sheetRows = [
    { ticket_code: 'AAAAAAAAAAAAAAAA', full_name: 'Cancelled Person', email: 'cancelled@example.com', phone: '1', issued_at: new Date().toISOString(), valid_until: future, status: 'Cancelled', entry_count: 0 },
    { ticket_code: 'BBBBBBBBBBBBBBBB', full_name: 'Sheet Only Person', email: 'sheet@example.com', phone: '2', issued_at: new Date().toISOString(), valid_until: future, status: 'valid', entry_count: 0 }
  ];
  const cancelled = await call('/api/check-in', { method: 'POST', auth: false, body: { ticketCode: 'AAAAAAAAAAAAAAAA' } });
  assert.equal(cancelled.status, 404);
  const fine = await call('/api/check-in', { method: 'POST', auth: false, body: { ticketCode: 'BBBBBBBBBBBBBBBB' } });
  assert.equal(fine.status, 200);
  assert.equal(fine.data.ticket.full_name, 'Sheet Only Person');
});

test('public check-in is rate limited and reports a clear error for unknown codes', async () => {
  const r = await call('/api/check-in', { method: 'POST', auth: false, body: { ticketCode: '0123456789ABCDEF' } });
  assert.equal(r.status, 404);
  assert.match(r.data.error, /not found/i);
  assert.ok(r.headers.get('ratelimit') || r.headers.get('ratelimit-policy'), 'rate-limit headers present');
});

test('other websites cannot call the API with credentials unless allow-listed', async () => {
  const stranger = await call('/api/health', { auth: false, headers: { Origin: 'https://evil.example' } });
  assert.equal(stranger.headers.get('access-control-allow-origin'), null);
  assert.equal(stranger.headers.get('access-control-allow-credentials'), null);
  const friend = await call('/api/health', { auth: false, headers: { Origin: 'https://friend.example' } });
  assert.equal(friend.headers.get('access-control-allow-origin'), 'https://friend.example');
  await waitForBackgroundSync();
});
