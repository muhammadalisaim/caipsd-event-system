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
const { db, isTicketCancelled } = require('../db');
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
  db.prepare('UPDATE tickets SET issued_at = ?, event_date = ? WHERE id = ?').run(new Date(Date.now() - 86400000).toISOString(), new Date().toISOString().slice(0, 10), ticket2Id);

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

  // Issue ticket using the new default (4 days validity -> 4 tickets generated)
  const t4Res = await call('/api/admin/tickets', {
    method: 'POST',
    body: { fullName: 'Hamza Tariq' }
  });
  assert.equal(t4Res.status, 201);
  assert.equal(t4Res.data.tickets.length, 4);
  assert.equal(t4Res.data.tickets[0].full_name, 'Hamza Tariq (Day 1)');
  assert.equal(t4Res.data.tickets[3].full_name, 'Hamza Tariq (Day 4)');
  const t4 = t4Res.data.ticket;
  assert.equal(t4.max_days, 1);
  assert.ok(new Date(t4.valid_until) > new Date(t4.issued_at));

  // Issue ticket explicitly with days: 3 -> 3 tickets generated
  const t3Res = await call('/api/admin/tickets', {
    method: 'POST',
    body: { fullName: 'Zainab Bibi', days: 3 }
  });
  assert.equal(t3Res.status, 201);
  assert.equal(t3Res.data.tickets.length, 3);
  assert.equal(t3Res.data.tickets[0].full_name, 'Zainab Bibi (Day 1)');
  assert.equal(t3Res.data.tickets[1].full_name, 'Zainab Bibi (Day 2)');
  assert.equal(t3Res.data.tickets[2].full_name, 'Zainab Bibi (Day 3)');
  const t3 = t3Res.data.ticket;
  assert.equal(t3.max_days, 1);

  // Day 3 ticket cannot be scanned on Day 1
  const day3Early = await call('/api/admin/check-in', { method: 'POST', body: { ticketCode: t3Res.data.tickets[2].ticket_code } });
  assert.equal(day3Early.status, 409);
  assert.ok(day3Early.data.dayEarly);

  // Day 1 scan -> allowed
  const d1 = await call('/api/admin/check-in', { method: 'POST', body: { ticketCode: t3.ticket_code } });
  assert.equal(d1.status, 200);
  assert.equal(d1.data.dayNumber, 1);

  // Repeated scan -> blocked because 1 ticket allows 1 entry
  const d2 = await call('/api/admin/check-in', { method: 'POST', body: { ticketCode: t3.ticket_code } });
  assert.equal(d2.status, 409);
  assert.ok(d2.data.alreadyUsed);

  // Gate Active Day mode allows verifying Day 2 and Day 3 passes directly
  const day3OnGate2 = await call('/api/admin/check-in', { method: 'POST', body: { ticketCode: t3Res.data.tickets[2].ticket_code, activeDay: 2 } });
  assert.equal(day3OnGate2.status, 409);
  assert.match(day3OnGate2.data.error, /Day 3 Ticket/);

  const day2OnGate2 = await call('/api/admin/check-in', { method: 'POST', body: { ticketCode: t3Res.data.tickets[1].ticket_code, activeDay: 2 } });
  assert.equal(day2OnGate2.status, 200);

  const day3OnGate3 = await call('/api/admin/check-in', { method: 'POST', body: { ticketCode: t3Res.data.tickets[2].ticket_code, activeDay: 3 } });
  assert.equal(day3OnGate3.status, 200);

  // Reset duration back to 2 days
  await call('/api/admin/settings/duration', { method: 'POST', body: { validDays: 2 } });
});

test('issues tickets with explicit startDate and calculates daily event dates', async () => {
  const r = await call('/api/admin/tickets', {
    method: 'POST',
    body: {
      fullName: 'Kamran Ali',
      days: 3,
      startDate: '2026-11-26'
    }
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.tickets.length, 3);
  assert.equal(r.data.tickets[0].event_date, '2026-11-26');
  assert.equal(r.data.tickets[1].event_date, '2026-11-27');
  assert.equal(r.data.tickets[2].event_date, '2026-11-28');
  assert.ok(new Date(r.data.tickets[0].valid_until) >= new Date('2026-11-28T23:59:59.000Z'));

  // Test bulk with startDate
  const bulkRes = await call('/api/admin/tickets/bulk', {
    method: 'POST',
    body: {
      names: 'Maryam\nShahzad',
      days: 2,
      startDate: '2026-12-01'
    }
  });
  assert.equal(bulkRes.status, 201);
  assert.equal(bulkRes.data.tickets.length, 4);
  assert.equal(bulkRes.data.tickets[0].event_date, '2026-12-01');
  assert.equal(bulkRes.data.tickets[1].event_date, '2026-12-02');
});

test('security: input email validation rejects invalid email formats', async () => {
  const badEmailRes = await call('/api/admin/tickets', {
    method: 'POST',
    body: { fullName: 'Ali Test', email: 'not-a-valid-email' }
  });
  assert.equal(badEmailRes.status, 400);
  assert.match(badEmailRes.data.error, /valid email/i);
});

test('security: CSRF origin verification blocks requests from unauthorized origins', async () => {
  const evilRes = await fetch(base + '/api/admin/tickets', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      Origin: 'https://evil-attacker-site.com'
    },
    body: JSON.stringify({ fullName: 'Malicious Attacker' })
  });
  assert.equal(evilRes.status, 403);
  const data = await evilRes.json();
  assert.match(data.error, /forbidden/i);
});

test('security: admin password change endpoint enforces authentication and validation', async () => {
  // Unauthenticated attempt
  const noAuth = await call('/api/admin/change-password', {
    method: 'POST',
    auth: false,
    body: { currentPassword: 'TestPassword123!', newPassword: 'NewSecurePassword123!' }
  });
  assert.equal(noAuth.status, 401);

  // Short new password (< 8 chars)
  const shortPass = await call('/api/admin/change-password', {
    method: 'POST',
    body: { currentPassword: 'TestPassword123!', newPassword: 'short' }
  });
  assert.equal(shortPass.status, 400);

  // Wrong current password
  const wrongCurrent = await call('/api/admin/change-password', {
    method: 'POST',
    body: { currentPassword: 'WrongPassword!', newPassword: 'NewSecurePassword123!' }
  });
  assert.equal(wrongCurrent.status, 401);

  // Successful change
  const success = await call('/api/admin/change-password', {
    method: 'POST',
    body: { currentPassword: 'TestPassword123!', newPassword: 'NewSecurePassword123!' }
  });
  assert.equal(success.status, 200);

  // Verify new password works for login
  const loginNew = await call('/api/admin/login', {
    method: 'POST',
    auth: false,
    body: { email: 'admin@test.org', password: 'NewSecurePassword123!' }
  });
  assert.equal(loginNew.status, 200);

  // Revert password back to original test password
  await call('/api/admin/change-password', {
    method: 'POST',
    body: { currentPassword: 'NewSecurePassword123!', newPassword: 'TestPassword123!' }
  });
});

test('security: persistent cancellation prevents resurrection of deleted ticket', async () => {
  const { isTicketCancelled } = require('../db');
  // Issue a test ticket
  const issueRes = await call('/api/admin/tickets', {
    method: 'POST',
    body: { fullName: 'Cancel Check Attendee' }
  });
  assert.equal(issueRes.status, 201);
  const tCode = issueRes.data.ticket.ticket_code;
  const tId = issueRes.data.ticket.id;

  // Cancel the ticket
  const delRes = await call(`/api/admin/tickets/${tId}`, { method: 'DELETE' });
  assert.equal(delRes.status, 200);

  // Verify it is recorded in the permanent cancelled_tickets table
  assert.equal(isTicketCancelled(tCode), true);

  // Verify check-in is immediately denied
  const checkinRes = await call('/api/admin/check-in', {
    method: 'POST',
    body: { ticketCode: tCode }
  });
  assert.equal(checkinRes.status, 404);
});

test('automatic day detection permits Day 1 today and denies Day 2 pass without activeDay parameter', async () => {
  // Issue 2-day pass starting today
  const issueRes = await call('/api/admin/tickets', {
    method: 'POST',
    body: { fullName: 'Auto Detection Attendee', days: 2 }
  });
  assert.equal(issueRes.status, 201);
  const tickets = issueRes.data.tickets;
  assert.equal(tickets.length, 2);

  const day1Ticket = tickets[0];
  const day2Ticket = tickets[1];

  // Check-in Day 1 ticket today without sending activeDay: should succeed automatically
  const day1Checkin = await call('/api/admin/check-in', {
    method: 'POST',
    body: { ticketCode: day1Ticket.ticket_code }
  });
  assert.equal(day1Checkin.status, 200);
  assert.match(day1Checkin.data.message, /Day 1 check-in successful/);

  // Check-in Day 2 ticket today without sending activeDay: should be denied because it's for tomorrow
  const day2Checkin = await call('/api/admin/check-in', {
    method: 'POST',
    body: { ticketCode: day2Ticket.ticket_code }
  });
  assert.equal(day2Checkin.status, 409);
  assert.match(day2Checkin.data.error, /Day 2 Ticket! This ticket can only be used on Day 2/);
  assert.equal(day2Checkin.data.dayEarly, true);
});

test('bulk delete tickets by ids and delete all tickets', async () => {
  // Issue multiple participants
  const res1 = await call('/api/admin/tickets', {
    method: 'POST',
    body: { fullName: 'Batch User One', days: 1 }
  });
  const res2 = await call('/api/admin/tickets', {
    method: 'POST',
    body: { fullName: 'Batch User Two', days: 1 }
  });
  const res3 = await call('/api/admin/tickets', {
    method: 'POST',
    body: { fullName: 'Batch User Three', days: 1 }
  });

  const id1 = res1.data.ticket.id;
  const id2 = res2.data.ticket.id;
  const id3 = res3.data.ticket.id;
  const code1 = res1.data.ticket.ticket_code;

  // Batch delete user 1 and user 2
  const delBatch = await call('/api/admin/tickets', {
    method: 'DELETE',
    body: { ids: [id1, id2] }
  });
  assert.equal(delBatch.status, 200);
  assert.equal(delBatch.data.count, 2);
  assert.equal(isTicketCancelled(code1), true);

  // Check remaining tickets
  const listAfterBatch = await call('/api/admin/tickets');
  assert.equal(listAfterBatch.status, 200);
  const remainingIds = listAfterBatch.data.tickets.map((t) => t.id);
  assert.ok(!remainingIds.includes(id1));
  assert.ok(!remainingIds.includes(id2));
  assert.ok(remainingIds.includes(id3));

  // Delete all tickets
  const delAll = await call('/api/admin/tickets', {
    method: 'DELETE',
    body: { all: true }
  });
  assert.equal(delAll.status, 200);

  // List should now be completely empty
  const listAfterAll = await call('/api/admin/tickets');
  assert.equal(listAfterAll.status, 200);
  assert.equal(listAfterAll.data.tickets.length, 0);
});

test('security: AES-256-GCM encrypts smtp_pass at rest in SQLite and decrypts on retrieval', () => {
  const { setSetting, getSetting, encryptSecret, decryptSecret } = require('../db');
  const plainSecret = 'mySecretAppPassword16Char';
  setSetting('smtp_pass', plainSecret);

  // Directly inspect raw stored value in SQLite table
  const row = db.prepare("SELECT value FROM settings WHERE key = 'smtp_pass'").get();
  assert.ok(row.value.startsWith('enc:gcm:'), 'Stored value must be encrypted with enc:gcm: prefix');
  assert.notEqual(row.value, plainSecret, 'Raw password must never be stored in plain text');

  // getSetting should transparently decrypt
  assert.equal(getSetting('smtp_pass'), plainSecret);

  // Direct encrypt/decrypt helpers
  const enc = encryptSecret('helloWorld');
  assert.ok(enc.startsWith('enc:gcm:'));
  assert.equal(decryptSecret(enc), 'helloWorld');
});

test('security: admin password change revokes other active sessions across devices', async () => {
  // Insert a mock session from a second device
  db.prepare('INSERT INTO sessions (sid, sess, expired) VALUES (?, ?, ?)').run('other-device-session-xyz', '{"adminId":1}', Date.now() + 3600000);
  assert.ok(db.prepare("SELECT 1 FROM sessions WHERE sid = 'other-device-session-xyz'").get());

  // Current admin updates password
  const res = await call('/api/admin/change-password', {
    method: 'POST',
    body: { currentPassword: 'TestPassword123!', newPassword: 'BrandNewPassword999!' }
  });
  assert.equal(res.status, 200);

  // The other device session must now be revoked
  const otherSession = db.prepare("SELECT 1 FROM sessions WHERE sid = 'other-device-session-xyz'").get();
  assert.equal(otherSession, undefined, 'Other device session must be purged from database');

  // Restore original password for remaining tests
  await call('/api/admin/change-password', {
    method: 'POST',
    body: { currentPassword: 'BrandNewPassword999!', newPassword: 'TestPassword123!' }
  });
});

test('tickets pagination: supports page and limit parameters, returns total and pages', async () => {
  // Issue 5 participants (10 passes)
  for (let i = 1; i <= 5; i++) {
    await call('/api/admin/tickets', {
      method: 'POST',
      body: { fullName: `Attendee ${i}`, sendEmail: false }
    });
  }

  // Fetch page 1 with limit 4
  const p1 = await call('/api/admin/tickets?page=1&limit=4');
  assert.equal(p1.status, 200);
  assert.equal(p1.data.tickets.length, 4);
  assert.equal(p1.data.total, 10);
  assert.equal(p1.data.page, 1);
  assert.equal(p1.data.limit, 4);
  assert.equal(p1.data.pages, 3);

  // Fetch page 3 with limit 4 (should return remaining 2 passes)
  const p3 = await call('/api/admin/tickets?page=3&limit=4');
  assert.equal(p3.status, 200);
  assert.equal(p3.data.tickets.length, 2);
  assert.equal(p3.data.page, 3);
});

test('gate station authorization endpoints: authorize with PIN, status check, and lock', async () => {
  let gateCookie = '';
  const gateCall = async (path, opts = {}) => {
    const res = await fetch(base + path, {
      method: opts.method || 'GET',
      headers: {
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        ...(gateCookie ? { Cookie: gateCookie } : {})
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) gateCookie = setCookie.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() };
  };

  // Initially unauthenticated
  const statusBefore = await gateCall('/api/gate/status');
  assert.equal(statusBefore.data.authorized, false);

  // Attempt unlock with invalid PIN
  const wrongUnlock = await gateCall('/api/gate/authorize', { method: 'POST', body: { pin: '0000' } });
  assert.equal(wrongUnlock.status, 401);

  // Unlock with correct Gate PIN ('2211')
  const okUnlock = await gateCall('/api/gate/authorize', { method: 'POST', body: { pin: '2211' } });
  assert.equal(okUnlock.status, 200);
  assert.equal(okUnlock.data.success, true);

  // Station is now authorized
  const statusAfter = await gateCall('/api/gate/status');
  assert.equal(statusAfter.data.authorized, true);

  // Lock station
  const lockRes = await gateCall('/api/gate/lock', { method: 'POST' });
  assert.equal(lockRes.status, 200);

  // Station is locked again
  const statusLocked = await gateCall('/api/gate/status');
  assert.equal(statusLocked.data.authorized, false);
});




