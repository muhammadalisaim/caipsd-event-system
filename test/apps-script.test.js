/*
 * Runs the real google-apps-script.js inside a sandbox with fake Google services,
 * so the email code can be verified without deploying anything.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

function makeSandbox() {
  const sent = [];
  const fetched = [];
  const output = (text) => ({ text, setMimeType() { return this; }, getContent() { return text; } });
  const sheet = { getLastRow: () => 1, getRange: () => ({ setValue() {} }) };
  const context = {
    sent, fetched,
    ContentService: { createTextOutput: output, MimeType: { JSON: 'json' } },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => sheet, getSheets: () => [sheet], insertSheet: () => sheet, getName: () => 'x', getId: () => 'x' }) },
    Utilities: {
      base64Decode: (text) => Buffer.from(text, 'base64'),
      newBlob: (bytes, type, name) => ({ bytes, type, name, setName(n) { this.name = n; return this; } })
    },
    UrlFetchApp: { fetch: (url) => { fetched.push(url); return { getBlob: () => ({ bytes: Buffer.from('x'), type: 'image/png', setName(n) { this.name = n; return this; } }) }; } },
    GmailApp: { sendEmail: (to, subject, body, options) => sent.push({ to, subject, body, options }) },
    MailApp: { sendEmail: (options) => sent.push({ to: options.to, subject: options.subject, body: options.body, options }) },
    Logger: { log() {} }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'google-apps-script.js'), 'utf8'), context);
  return context;
}
const post = (ctx, payload) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(payload) } }).getContent());
const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');

test('ticket email carries the QR as an inline image and as an attachment', () => {
  const ctx = makeSandbox();
  const result = post(ctx, { action: 'sendTicketEmail', to: 'Student@Example.com', ticketCode: '0123456789abcdef', fullName: 'Ali Khan', qrPngBase64: PNG_B64, viewLink: 'https://tickets.example.org/ticket.html?code=0123456789ABCDEF' });
  assert.equal(result.status, 'ok');
  assert.equal(ctx.sent.length, 1);
  const mail = ctx.sent[0];
  assert.equal(mail.to, 'student@example.com');
  assert.match(mail.subject, /0123456789ABCDEF/);
  assert.ok(mail.options.inlineImages.ticketqr, 'inline image present');
  assert.equal(mail.options.attachments.length, 1);
  assert.ok(mail.options.htmlBody.includes('cid:ticketqr'));
  assert.ok(mail.options.htmlBody.includes('https://tickets.example.org/ticket.html?code=0123456789ABCDEF'));
  assert.equal(ctx.fetched.length, 0, 'no third-party QR service is needed when the server sends the image');
});

test('without a ready QR image the script falls back to a QR service', () => {
  const ctx = makeSandbox();
  const result = post(ctx, { action: 'sendTicketEmail', to: 'a@example.com', ticketCode: '0123456789ABCDEF', fullName: 'Ali' });
  assert.equal(result.status, 'ok');
  assert.equal(ctx.fetched.length, 1);
  assert.ok(ctx.sent[0].options.inlineImages.ticketqr);
});

test('names are HTML-escaped and bad input is rejected', () => {
  const ctx = makeSandbox();
  post(ctx, { action: 'sendTicketEmail', to: 'a@example.com', ticketCode: '0123456789ABCDEF', fullName: '<script>alert(1)</script>', qrPngBase64: PNG_B64 });
  assert.ok(!ctx.sent[0].options.htmlBody.includes('<script>'));
  assert.ok(ctx.sent[0].options.htmlBody.includes('&lt;script&gt;'));
  assert.equal(post(ctx, { action: 'sendTicketEmail', to: 'not-an-email', ticketCode: '0123456789ABCDEF' }).status, 'error');
  assert.equal(post(ctx, { action: 'sendTicketEmail', to: 'a@example.com', ticketCode: '../etc' }).status, 'error');
  assert.equal(ctx.sent.length, 1);
});

test('a link that is not http(s) is ignored', () => {
  const ctx = makeSandbox();
  post(ctx, { action: 'sendTicketEmail', to: 'a@example.com', ticketCode: '0123456789ABCDEF', fullName: 'Ali', qrPngBase64: PNG_B64, viewLink: 'javascript:alert(1)' });
  assert.ok(!ctx.sent[0].options.htmlBody.includes('javascript:'));
});

test('with WEBHOOK_SECRET set, only callers that know it can send emails or read tickets', () => {
  const ctx = makeSandbox();
  vm.runInContext('WEBHOOK_SECRET = "s3cret"', ctx);
  const body = { action: 'sendTicketEmail', to: 'a@example.com', ticketCode: '0123456789ABCDEF', fullName: 'Ali', qrPngBase64: PNG_B64 };
  assert.match(post(ctx, body).message, /Unauthorized/);
  assert.match(post(ctx, { ...body, secret: 'wrong' }).message, /Unauthorized/);
  assert.equal(post(ctx, { ...body, secret: 's3cret' }).status, 'ok');
  assert.equal(ctx.sent.length, 1);

  const denied = JSON.parse(ctx.doGet({ parameter: { action: 'getAll' } }).getContent());
  assert.match(denied.message, /Unauthorized/);
  const ping = JSON.parse(ctx.doGet({ parameter: { action: 'ping' } }).getContent());
  assert.equal(ping.status, 'ok');
});
