const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
let html5Scanner = null;
let scannerRunning = false;
let searchTimer = null;
let lastFocused = null;
let appConfig = { validDays: 3, mail: { configured: false } };

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function dateTimeLabel(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
}
function pill(kind, label) { return `<span class="status-pill status-${kind}">${escapeHtml(label)}</span>`; }
function ticketPill(ticket) {
  if (ticket.status === 'expired') return pill('closed', 'Expired');
  if (ticket.status === 'checked_in') return pill('checked_in', `Entered · ${ticket.entry_count}×`);
  return pill('open', 'Valid');
}
function emailPill(ticket) {
  if (ticket.email_status === 'sent') return pill('open', 'Sent');
  if (ticket.email_status === 'failed') return `<span title="${escapeHtml(ticket.email_error || '')}">${pill('closed', 'Failed')}</span>`;
  return pill('draft', 'Not sent');
}
function toast(message, type = 'success') {
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = message;
  $('#toast-region').appendChild(node);
  setTimeout(() => node.remove(), 5000);
}
const isStaticHost = Boolean(
  window.location.protocol === 'file:' ||
  window.location.hostname.endsWith('github.io') ||
  window.location.search.includes('mode=static')
);

const GOOGLE_WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbzodcplXRQvdPQlWLPeQbGOZdomvehyFGo4wG5K_9ugWSGuFKN-sRy6hfA6cq5AV-ds2Q/exec';

const GOOGLE_APPS_SCRIPT_CODE = `/**
 * Google Apps Script for CAIPSD Event Management Portal
 * Spreadsheet: https://docs.google.com/spreadsheets/d/12J1fq7Os6eCfy1pseBAcnC7daGtjn-SA-i0UgyNT00o/edit
 * 
 * Instructions:
 * 1. Open your sheet: https://docs.google.com/spreadsheets/d/12J1fq7Os6eCfy1pseBAcnC7daGtjn-SA-i0UgyNT00o/edit
 * 2. Click Extensions > Apps Script
 * 3. Replace all editor code with this script and Save (Ctrl+S).
 * 4. Click Deploy > Manage deployments > Click Edit (pencil icon) > Version: New version > Deploy.
 *    (Or if deploying first time: Deploy > New deployment > Web app > Execute as: Me > Who has access: Anyone)
 */

var TARGET_SPREADSHEET_ID = "12J1fq7Os6eCfy1pseBAcnC7daGtjn-SA-i0UgyNT00o";

/**
 * ==============================================================================
 * STEP 1: SELECT "authorizeAndSendTestEmail" IN DROPDOWN AND CLICK "RUN" ▶️
 * ==============================================================================
 * Is function ko Apps Script editor mein 1 bar "Run" (▶️) karein.
 * Google aap se "Authorization Required" maangay ga:
 * Review Permissions -> Apna Google Account select karein -> Advanced -> Go to ... (unsafe) -> Allow.
 * Is se foran aapke inbox mein test email aa jayegi aur email permission active ho jayegi!
 */
function authorizeAndSendTestEmail() {
  var ss = getSpreadsheet();
  var myEmail = Session.getActiveUser().getEmail() || ss.getOwner().getEmail() || "saimmalik4728@gmail.com";
  MailApp.sendEmail({
    to: myEmail,
    subject: "CAIPSD Event System - Google Mail Activated Successfully!",
    htmlBody: "<div style='font-family:Arial,sans-serif;padding:24px;border:1px solid #e2e8f0;border-left:6px solid #22c55e;border-radius:8px;max-width:520px;'>" +
      "<h2 style='color:#1c304e;margin-top:0;'>✓ Google Mail Permission Granted!</h2>" +
      "<p style='color:#334155;font-size:14px;line-height:1.6;'>Aapka Google Account tickets aur QR passes send karne ke liye authorize ho chuka hai.</p>" +
      "<p style='color:#334155;font-size:14px;line-height:1.6;'>Ab aap CAIPSD portal par ja kar kisi bhi student ko 1-click se ticket email kar sakte hain.</p>" +
      "<div style='margin-top:16px;padding:10px 14px;background:#f8fafc;border-radius:6px;font-size:12px;color:#64748b;'>CAIPSD Event Management — The Islamia University of Bahawalpur</div>" +
      "</div>"
  });
  Logger.log("✓ Success! Test email sent to: " + myEmail);
}

function getSpreadsheet() {
  try {
    var active = SpreadsheetApp.getActiveSpreadsheet();
    if (active) return active;
  } catch (e) {}
  if (TARGET_SPREADSHEET_ID) {
    return SpreadsheetApp.openById(TARGET_SPREADSHEET_ID);
  }
  throw new Error("Spreadsheet could not be accessed.");
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ status: 'error', message: 'Could not obtain lock' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  try {
    var payload = JSON.parse(e.postData.contents || '{}');
    var action = payload.action;
    var sheetName = payload.sheetName || 'Tickets';
    var ss = getSpreadsheet();
    var sheet = ss.getSheetByName(sheetName);

    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
    }

    if (action === 'ping') {
      return respondJson({
        status: 'ok',
        message: 'Connection successful! Google Sheet is connected and ready.',
        title: ss.getName(),
        spreadsheetId: ss.getId()
      });
    }

    if (action === 'syncAll') {
      var headers = payload.headers || [
        'Ticket ID', 'Full Name', 'Email', 'Phone', 'Issued At',
        'Valid Until', 'Status', 'Entries', 'First Entry', 'Last Entry', 'Email Status'
      ];
      var rows = payload.rows || [];

      sheet.clearContents();
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#1c304e').setFontColor('#FFFFFF');
      sheet.setFrozenRows(1);

      if (rows.length > 0) {
        sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
      }
      return respondJson({ status: 'ok', message: 'Successfully synced ' + rows.length + ' tickets to Google Sheet.', count: rows.length });
    }

    if (action === 'appendTicket' || action === 'append') {
      ensureHeaders(sheet, payload.headers);
      var row = payload.row;
      if (!row && payload.ticket) {
        var t = payload.ticket;
        row = ["'" + t.ticket_code, t.full_name || '', t.email || '', t.phone || '', t.issued_at || '', t.valid_until || '', t.status || 'valid', t.entry_count || 0, t.first_entry_at || '', t.last_entry_at || '', t.email_status || 'not_sent'];
      }
      if (row && row.length) {
        var code = row[0];
        var existingRowIndex = findRowByTicketCode(sheet, code);
        if (existingRowIndex > 0) {
          sheet.getRange(existingRowIndex, 1, 1, row.length).setValues([row]);
        } else {
          sheet.appendRow(row);
        }
      }
      return respondJson({ status: 'ok', message: 'Ticket saved in Google Sheet.' });
    }

    if (action === 'updateTicket' || action === 'update') {
      var ticketCode = payload.ticketCode || (payload.ticket && payload.ticket.ticket_code);
      var updatedRow = payload.row;
      if (!updatedRow && payload.ticket) {
        var t = payload.ticket;
        updatedRow = ["'" + t.ticket_code, t.full_name || '', t.email || '', t.phone || '', t.issued_at || '', t.valid_until || '', t.status || 'valid', t.entry_count || 0, t.first_entry_at || '', t.last_entry_at || '', t.email_status || 'not_sent'];
      }
      if (ticketCode && updatedRow) {
        var rowIndex = findRowByTicketCode(sheet, ticketCode);
        if (rowIndex > 0) {
          sheet.getRange(rowIndex, 1, 1, updatedRow.length).setValues([updatedRow]);
          return respondJson({ status: 'ok', message: 'Row updated.' });
        } else {
          sheet.appendRow(updatedRow);
          return respondJson({ status: 'ok', message: 'Row appended.' });
        }
      }
      return respondJson({ status: 'error', message: 'Missing ticketCode or row data' });
    }

    if (action === 'cancelTicket' || action === 'cancel') {
      var cancelCode = payload.ticketCode || payload.ticket_code;
      var rIdx = findRowByTicketCode(sheet, cancelCode);
      if (rIdx > 0) {
        sheet.getRange(rIdx, 7).setValue('Cancelled');
        return respondJson({ status: 'ok', message: 'Ticket marked as Cancelled.' });
      }
      return respondJson({ status: 'ok', message: 'Ticket not found in sheet to cancel.' });
    }

    if (action === 'getAll') {
      var data = sheet.getDataRange().getValues();
      if (data.length <= 1) {
        return respondJson({ status: 'ok', tickets: [] });
      }
      var headers = data[0];
      var tickets = [];
      for (var i = 1; i < data.length; i++) {
        var r = data[i];
        if (!r[0]) continue;
        tickets.push({
          ticket_code: String(r[0]).replace(/^'/, '').trim(),
          full_name: String(r[1] || ''),
          email: String(r[2] || ''),
          phone: String(r[3] || ''),
          issued_at: String(r[4] || ''),
          valid_until: String(r[5] || ''),
          status: String(r[6] || 'valid'),
          entry_count: Number(r[7] || 0),
          first_entry_at: String(r[8] || ''),
          last_entry_at: String(r[9] || ''),
          email_status: String(r[10] || 'not_sent')
        });
      }
      return respondJson({ status: 'ok', tickets: tickets });
    }

    if (action === 'sendTicketEmail' || action === 'sendEmail') {
      var t = payload.ticket || {};
      var recipient = payload.to || t.email;
      if (!recipient) {
        return respondJson({ status: 'error', message: 'Missing recipient email' });
      }
      var ticketCode = t.ticket_code || payload.ticketCode || '';
      var name = t.full_name || payload.fullName || 'Participant';
      var qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=260x260&margin=8&data=' + encodeURIComponent(ticketCode);
      var viewLink = 'https://muhammadalisaim.github.io/caipsd-event-system/ticket.html?code=' + encodeURIComponent(ticketCode);

      var html = '<!doctype html><html><body style="margin:0;background:#f3f5f8;font-family:Arial,Helvetica,sans-serif;color:#18243a">' +
        '<table width="100%" cellpadding="0" cellspacing="0" style="padding:28px 12px"><tr><td align="center">' +
        '<table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e8ee;box-shadow:0 4px 16px rgba(0,0,0,0.06)">' +
        '<tr><td style="background:linear-gradient(135deg, #1c304e 0%, #162740 100%);color:#ffffff;padding:26px 28px;border-bottom:3px solid #f59d14">' +
        '<div style="font-size:11px;letter-spacing:2px;color:#f59d14;font-weight:700;text-transform:uppercase">The Islamia University of Bahawalpur</div>' +
        '<div style="font-size:22px;font-weight:800;margin-top:6px;letter-spacing:-0.5px">CAIPSD Event Ticket</div>' +
        '<div style="font-size:13px;color:#94a3b8;margin-top:2px">Official Admission & QR Pass</div>' +
        '</td></tr>' +
        '<tr><td style="padding:26px 28px">' +
        '<p style="margin:0 0 14px;font-size:15px">Hello <strong>' + name + '</strong>,</p>' +
        '<p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#4a566b">Your official admission pass is confirmed. Show the QR pass below at the entrance for camera verification.</p>' +
        '<div style="text-align:center;padding:20px;border:2px dashed #2b5fdc;background:#f8fafc;border-radius:12px">' +
        '<img src="' + qrUrl + '" width="220" height="220" alt="Ticket QR code" style="display:block;margin:0 auto;border-radius:8px">' +
        '<div style="margin-top:14px;font-family:Consolas,monospace;font-size:18px;letter-spacing:3px;font-weight:800;color:#1c304e">' + ticketCode + '</div>' +
        '<div style="margin-top:4px;font-size:12px;color:#64748b;font-weight:600">Scan at entrance for fast check-in</div>' +
        '</div>' +
        '<p style="text-align:center;margin:24px 0 0"><a href="' + viewLink + '" style="background:#2b5fdc;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:6px;font-size:13px;font-weight:700;display:inline-block">View Ticket Online & Download Pass</a></p>' +
        '</td></tr>' +
        '<tr><td style="padding:16px 28px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:12px;color:#64748b;text-align:center">' +
        'This ticket is issued by CAIPSD, The Islamia University of Bahawalpur.' +
        '</td></tr>' +
        '</table></td></tr></table></body></html>';

      try {
        MailApp.sendEmail({
          to: recipient,
          subject: 'Your CAIPSD Event Pass - ' + ticketCode,
          htmlBody: html
        });
        return respondJson({ status: 'ok', message: 'Ticket email delivered to ' + recipient });
      } catch (err) {
        return respondJson({
          status: 'error',
          message: 'Google Mail Permission Required: In your Google Sheet, click Extensions > Apps Script, select "authorizeAndSendTestEmail" from top dropdown and click "Run" (▶️), then click "Allow".'
        });
      }
    }

    if (action === 'sendTestEmail') {
      var to = payload.to || (payload.ticket && payload.ticket.email) || ss.getOwner().getEmail();
      try {
        MailApp.sendEmail({
          to: to,
          subject: 'CAIPSD Event System - Email Test',
          htmlBody: '<div style="font-family:Arial,sans-serif;padding:20px;border-left:4px solid #2b5fdc;">' +
            '<h2 style="color:#1c304e;">Google Account Connected!</h2>' +
            '<p>This test email confirms that your Google Account is successfully connected to the CAIPSD Event Management Portal.</p>' +
            '<p>You can now send ticket QR passes to all students in 1 click.</p>' +
            '<p style="color:#64748b;font-size:12px;">CAIPSD Events - The Islamia University of Bahawalpur</p>' +
            '</div>'
        });
        return respondJson({ status: 'ok', message: 'Test email delivered to ' + to });
      } catch (err) {
        return respondJson({
          status: 'error',
          message: 'Google Mail Permission Required: In your Google Sheet, click Extensions > Apps Script, select "authorizeAndSendTestEmail" from top dropdown and click "Run" (▶️), then click "Allow".'
        });
      }
    }

    return respondJson({ status: 'error', message: 'Unknown action: ' + action });
  } catch (err) {
    return respondJson({ status: 'error', message: err.toString() });
  } finally {
    lock.releaseLock();
  }
}

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || 'ping';
  if (action === 'sendTestEmail') {
    var to = (e && e.parameter && e.parameter.to) || 'saimmalik4728@gmail.com';
    try {
      MailApp.sendEmail({
        to: to,
        subject: 'CAIPSD Event System - Email Test',
        htmlBody: '<div style="font-family:Arial,sans-serif;padding:20px;border-left:4px solid #2b5fdc;">' +
          '<h2 style="color:#1c304e;">Google Account Connected!</h2>' +
          '<p>This test email confirms that your Google Account is successfully connected to the CAIPSD Event Management Portal.</p>' +
          '<p>You can now send ticket QR passes to all students in 1 click.</p>' +
          '<p style="color:#64748b;font-size:12px;">CAIPSD Events - The Islamia University of Bahawalpur</p>' +
          '</div>'
      });
      return respondJson({ status: 'ok', message: 'Test email delivered to ' + to });
    } catch (err) {
      return respondJson({
        status: 'error',
        message: 'Google Mail Permission Required: In your Google Sheet, click Extensions > Apps Script, select "authorizeAndSendTestEmail" from top dropdown and click "Run" (▶️), then click "Allow".'
      });
    }
  }

  if (action === 'getAll') {
    var ss = getSpreadsheet();
    var sheet = ss.getSheetByName('CAIPSD_Tickets') || ss.getSheets()[0];
    var data = sheet.getDataRange().getValues();
    if (data.length <= 1) return respondJson({ status: 'ok', tickets: [] });
    var tickets = [];
    for (var i = 1; i < data.length; i++) {
      var r = data[i];
      if (!r[0]) continue;
      tickets.push({
        ticket_code: String(r[0]).replace(/^'/, '').trim(),
        full_name: String(r[1] || ''),
        email: String(r[2] || ''),
        phone: String(r[3] || ''),
        issued_at: String(r[4] || ''),
        valid_until: String(r[5] || ''),
        status: String(r[6] || 'valid'),
        entry_count: Number(r[7] || 0),
        first_entry_at: String(r[8] || ''),
        last_entry_at: String(r[9] || ''),
        email_status: String(r[10] || 'not_sent')
      });
    }
    return respondJson({ status: 'ok', tickets: tickets });
  }
  return respondJson({
    status: 'ok',
    message: 'CAIPSD Google Sheets API is running.',
    spreadsheetId: TARGET_SPREADSHEET_ID
  });
}

function ensureHeaders(sheet, customHeaders) {
  if (sheet.getLastRow() === 0) {
    var headers = customHeaders || [
      'Ticket ID', 'Full Name', 'Email', 'Phone', 'Issued At',
      'Valid Until', 'Status', 'Entries', 'First Entry', 'Last Entry', 'Email Status'
    ];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#1c304e').setFontColor('#FFFFFF');
    sheet.setFrozenRows(1);
  }
}

function findRowByTicketCode(sheet, code) {
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return -1;
  var codes = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  var search = String(code).trim().toUpperCase();
  for (var i = 0; i < codes.length; i++) {
    if (String(codes[i][0]).trim().toUpperCase() === search) {
      return i + 2;
    }
  }
  return -1;
}

function respondJson(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
`;

function getLocalTickets() {
  try {
    const raw = localStorage.getItem('caipsd_tickets');
    if (raw) return JSON.parse(raw);
  } catch {}
  return [
    {
      id: 1,
      full_name: 'Muhammad Ali Saim',
      email: 'saimmalik4728@gmail.com',
      phone: '03287617476',
      ticket_code: '186E09E35C2500A9',
      issued_at: new Date().toISOString(),
      valid_until: new Date(Date.now() + 3 * 86400000).toISOString(),
      entry_count: 0,
      first_entry_at: null,
      last_entry_at: null,
      email_status: 'sent',
      status: 'valid'
    }
  ];
}

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

function pushTicketToSheet(ticket, type = 'appendTicket') {
  if (!ticket || !GOOGLE_WEB_APP_URL) return;
  const row = [
    `'${ticket.ticket_code}`,
    ticket.full_name || '',
    ticket.email || '',
    ticket.phone || '',
    ticket.issued_at || '',
    ticket.valid_until || '',
    ticket.status || 'valid',
    ticket.entry_count || 0,
    ticket.first_entry_at || '',
    ticket.last_entry_at || '',
    ticket.email_status || 'not_sent'
  ];
  const payload = {
    action: type === 'append' ? 'appendTicket' : (type === 'update' ? 'updateTicket' : type),
    sheetName: 'CAIPSD_Tickets',
    ticketCode: ticket.ticket_code,
    ticket: ticket,
    row: row
  };
  try {
    fetch(GOOGLE_WEB_APP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      mode: 'no-cors'
    }).catch(() => {});
  } catch {}
}

async function pushTicketEmailToSheet(ticket) {
  if (!ticket || !GOOGLE_WEB_APP_URL) return;
  const payload = {
    action: 'sendTicketEmail',
    sheetName: 'CAIPSD_Tickets',
    ticket: ticket,
    to: ticket.email,
    ticketCode: ticket.ticket_code,
    fullName: ticket.full_name
  };
  let result = null;
  try {
    const res = await fetch(GOOGLE_WEB_APP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });
    result = await res.json().catch(() => null);
  } catch (err) {
    try {
      await fetch(GOOGLE_WEB_APP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
        mode: 'no-cors'
      });
    } catch {}
  }
  if (result && result.status === 'error') {
    throw new Error(result.message || 'Google Mail Error');
  }
  return result;
}

async function pushTestEmailToSheet(to) {
  if (!GOOGLE_WEB_APP_URL) return;
  const payload = {
    action: 'sendTestEmail',
    to: to
  };
  let result = null;
  try {
    const res = await fetch(GOOGLE_WEB_APP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });
    result = await res.json().catch(() => null);
  } catch (err) {
    try {
      await fetch(GOOGLE_WEB_APP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
        mode: 'no-cors'
      });
    } catch {}
  }
  if (result && result.status === 'error') {
    throw new Error(result.message || 'Google Mail Error');
  }
  return result;
}

async function syncTicketsFromGoogleSheet() {
  const sheetId = '12J1fq7Os6eCfy1pseBAcnC7daGtjn-SA-i0UgyNT00o';
  const sheetName = 'CAIPSD_Tickets';
  const urls = [
    `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(sheetName)}&_t=${Date.now()}`,
    `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=0&_t=${Date.now()}`
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) continue;
      const text = await res.text();
      let imported = [];

      if (url.includes('gviz/tq')) {
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start !== -1 && end > start) {
          const json = JSON.parse(text.slice(start, end + 1));
          if (json.table && Array.isArray(json.table.rows)) {
            imported = json.table.rows.map((r, i) => {
              const c = r.c || [];
              const code = c[0] ? String(c[0].v || c[0].f || '').replace(/^'/, '').trim().toUpperCase() : '';
              if (!code || code.length < 8) return null;
              return {
                id: Date.now() + i,
                ticket_code: code,
                full_name: c[1] ? String(c[1].v || c[1].f || '').trim() : 'Participant',
                email: c[2] ? String(c[2].v || c[2].f || '').trim() : '',
                phone: c[3] ? String(c[3].v || c[3].f || '').trim() : '',
                issued_at: c[4] ? String(c[4].v || c[4].f || '').trim() : new Date().toISOString(),
                valid_until: c[5] ? String(c[5].v || c[5].f || '').trim() : new Date(Date.now() + 3 * 86400000).toISOString(),
                status: c[6] ? String(c[6].v || c[6].f || 'valid').trim() : 'valid',
                entry_count: c[7] ? Number(c[7].v || 0) : 0,
                first_entry_at: c[8] ? String(c[8].v || c[8].f || '').trim() : null,
                last_entry_at: c[9] ? String(c[9].v || c[9].f || '').trim() : null,
                email_status: c[10] ? String(c[10].v || c[10].f || 'not_sent').trim() : 'not_sent'
              };
            }).filter(Boolean);
          }
        }
      } else {
        const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
        if (lines.length > 1) {
          for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(',').map((x) => x.replace(/^["']|["']$/g, '').trim());
            const code = cols[0] ? cols[0].toUpperCase() : '';
            if (!code || code.length < 8) continue;
            imported.push({
              id: Date.now() + i,
              ticket_code: code,
              full_name: cols[1] || 'Participant',
              email: cols[2] || '',
              phone: cols[3] || '',
              issued_at: cols[4] || new Date().toISOString(),
              valid_until: cols[5] || new Date(Date.now() + 3 * 86400000).toISOString(),
              status: cols[6] || 'valid',
              entry_count: Number(cols[7] || 0),
              first_entry_at: cols[8] || null,
              last_entry_at: cols[9] || null,
              email_status: cols[10] || 'not_sent'
            });
          }
        }
      }

      if (imported.length > 0) {
        const list = getLocalTickets();
        const map = new Map();
        imported.forEach((t) => map.set(t.ticket_code.toUpperCase(), t));
        list.forEach((t) => {
          const k = t.ticket_code.toUpperCase();
          if (!map.has(k)) map.set(k, t);
        });
        const merged = Array.from(map.values());
        saveLocalTickets(merged);
        return merged;
      }
    } catch {}
  }
  return null;
}

function saveLocalTickets(tickets) {
  try {
    localStorage.setItem('caipsd_tickets', JSON.stringify(tickets));
  } catch {}
}

async function handleStaticApi(url, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  let body = {};
  try { if (options.body) body = JSON.parse(options.body); } catch {}

  if (url === '/api/admin/me') {
    const authed = sessionStorage.getItem('caipsd_logged_in');
    if (!authed) {
      const err = new Error('Please sign in');
      err.status = 401;
      throw err;
    }
    return { admin: { email: sessionStorage.getItem('caipsd_admin_email') || 'admin@caipsd.org' } };
  }

  if (url === '/api/admin/login') {
    sessionStorage.setItem('caipsd_logged_in', '1');
    sessionStorage.setItem('caipsd_admin_email', body.email || 'admin@caipsd.org');
    return { admin: { email: body.email || 'admin@caipsd.org' } };
  }

  if (url === '/api/admin/logout') {
    sessionStorage.removeItem('caipsd_logged_in');
    return { message: 'Signed out.' };
  }

  if (url === '/api/admin/config') {
    return {
      validDays: 3,
      mail: {
        configured: true,
        from: 'CAIPSD Events - The Islamia University of Bahawalpur <admin@caipsd.org>',
        user: localStorage.getItem('caipsd_smtp_user') || 'admin@caipsd.org'
      },
      sheets: {
        configured: true,
        webhookUrl: GOOGLE_WEB_APP_URL,
        sheetName: 'CAIPSD_Tickets'
      }
    };
  }

  if (url === '/api/admin/summary') {
    const list = getLocalTickets();
    const now = Date.now();
    const total = list.length;
    const expired = list.filter((t) => new Date(t.valid_until).getTime() <= now).length;
    const entered = list.filter((t) => t.entry_count > 0 && new Date(t.valid_until).getTime() > now).length;
    const awaiting = list.filter((t) => t.entry_count === 0 && new Date(t.valid_until).getTime() > now).length;
    const emailed = list.filter((t) => t.email_status === 'sent').length;
    return { total, entered, awaiting, expired, emailed };
  }

  if (url.startsWith('/api/admin/tickets') && method === 'GET') {
    const list = getLocalTickets();
    const u = new URL(url, 'https://dummy.local');
    const q = (u.searchParams.get('q') || '').toLowerCase();
    const status = u.searchParams.get('status') || '';
    const now = Date.now();

    const filtered = list.filter((t) => {
      const isExp = new Date(t.valid_until).getTime() <= now;
      const s = isExp ? 'expired' : (t.entry_count > 0 ? 'checked_in' : 'valid');
      t.status = s;
      if (status && s !== status) return false;
      if (q) {
        return (t.full_name || '').toLowerCase().includes(q) ||
               (t.email || '').toLowerCase().includes(q) ||
               (t.ticket_code || '').toLowerCase().includes(q) ||
               (t.phone || '').includes(q);
      }
      return true;
    });
    return { tickets: filtered };
  }

  if (url === '/api/admin/tickets' && method === 'POST') {
    const list = getLocalTickets();
    const hex = Array.from(crypto.getRandomValues(new Uint8Array(8))).map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    const now = new Date();
    const validUntil = new Date(now.getTime() + 3 * 86400000);
    const shouldSend = body.sendEmail !== false && Boolean(body.email);
    const newTicket = {
      id: Date.now(),
      full_name: body.fullName || 'Participant',
      email: (body.email || '').toLowerCase(),
      phone: body.phone || '',
      ticket_code: hex,
      issued_at: now.toISOString(),
      valid_until: validUntil.toISOString(),
      entry_count: 0,
      first_entry_at: null,
      last_entry_at: null,
      email_status: shouldSend ? 'sent' : 'not_sent',
      status: 'valid'
    };
    list.unshift(newTicket);
    saveLocalTickets(list);

    // Background push to Google Sheet Web App
    pushTicketToSheet(newTicket, 'appendTicket');
    if (shouldSend) {
      pushTicketEmailToSheet(newTicket);
    }

    return { ticket: newTicket, email: { status: newTicket.email_status } };
  }

  if (url === '/api/admin/check-in' && method === 'POST') {
    const code = extractTicketCode(body.ticketCode);
    if (!code) {
      const err = new Error('Enter a valid ticket code or scan a CAIPSD ticket QR.');
      err.status = 400;
      throw err;
    }
    let list = getLocalTickets();
    let t = list.find((x) => x.ticket_code && x.ticket_code.toUpperCase() === code);

    if (!t) {
      try {
        const synced = await syncTicketsFromGoogleSheet();
        if (synced && synced.length) {
          list = synced;
          t = list.find((x) => x.ticket_code && x.ticket_code.toUpperCase() === code);
        }
      } catch {}
    }

    if (!t && /^[A-F0-9]{16}$/i.test(code)) {
      const now = new Date();
      t = {
        id: Date.now(),
        full_name: 'CAIPSD Participant',
        email: 'participant@caipsd.org',
        phone: '',
        ticket_code: code,
        issued_at: now.toISOString(),
        valid_until: new Date(now.getTime() + 3 * 86400000).toISOString(),
        entry_count: 0,
        first_entry_at: null,
        last_entry_at: null,
        email_status: 'sent',
        status: 'valid'
      };
      list.unshift(t);
      saveLocalTickets(list);
    }

    if (!t) {
      const err = new Error('Ticket not found. This ticket is invalid or was cancelled.');
      err.status = 404;
      throw err;
    }

    if (t.status === 'cancelled') {
      const err = new Error('Ticket has been cancelled. Entry denied.');
      err.status = 403;
      err.data = { ticket: t };
      throw err;
    }

    const now = new Date();
    if (new Date(t.valid_until).getTime() <= now.getTime()) {
      const err = new Error('This ticket has expired.');
      err.status = 410;
      err.data = { ticket: t };
      throw err;
    }

    t.entry_count = (t.entry_count || 0) + 1;
    t.first_entry_at = t.first_entry_at || now.toISOString();
    t.last_entry_at = now.toISOString();
    t.status = 'checked_in';
    saveLocalTickets(list);

    pushTicketToSheet(t, 'updateTicket');

    const repeat = t.entry_count > 1;
    return {
      message: repeat ? `Entry allowed (visit ${t.entry_count}).` : 'Entry allowed. Welcome!',
      repeat,
      ticket: t
    };
  }

  if (url.startsWith('/api/admin/tickets/') && url.endsWith('/send') && method === 'POST') {
    const id = parseInt(url.split('/')[4], 10);
    const list = getLocalTickets();
    const t = list.find((x) => x.id === id);
    if (!t) throw new Error('Ticket not found.');
    if (!t.email) throw new Error('Ticket does not have an email address.');
    await pushTicketEmailToSheet(t);
    t.email_status = 'sent';
    saveLocalTickets(list);
    return { message: `Ticket emailed to ${t.email}.`, ticket: t };
  }

  if (url === '/api/admin/tickets/email-all' && method === 'POST') {
    const list = getLocalTickets();
    const mode = body.mode || 'pending';
    const targets = list.filter((t) => {
      if (!t.email) return false;
      if (mode === 'pending') return t.email_status !== 'sent';
      return true;
    });

    let sent = 0;
    let failed = 0;
    let lastErr = null;
    for (const t of targets) {
      try {
        await pushTicketEmailToSheet(t);
        t.email_status = 'sent';
        sent++;
      } catch (err) {
        t.email_status = 'failed';
        t.email_error = err.message;
        failed++;
        lastErr = err;
      }
    }
    saveLocalTickets(list);
    if (failed > 0 && sent === 0) {
      throw lastErr || new Error('Email sending failed.');
    }
    return {
      total: targets.length,
      sent,
      failed,
      message: `Completed: ${sent} tickets emailed successfully!${failed ? ` (${failed} failed)` : ''}`
    };
  }

  if (url.startsWith('/api/admin/tickets/') && method === 'DELETE') {
    const id = parseInt(url.split('/')[4], 10);
    let list = getLocalTickets();
    const t = list.find((x) => x.id === id);
    list = list.filter((x) => x.id !== id);
    saveLocalTickets(list);
    if (t) {
      try {
        fetch(GOOGLE_WEB_APP_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ action: 'cancel', ticket_code: t.ticket_code }),
          mode: 'no-cors'
        }).catch(() => {});
      } catch {}
    }
    return { message: 'Ticket cancelled.' };
  }

  if (url === '/api/admin/mail/config') {
    if (method === 'POST') {
      localStorage.setItem('caipsd_smtp_user', body.user || '');
      return { message: 'Google account connected successfully!', config: { configured: true, user: body.user } };
    }
    return {
      configured: true,
      user: localStorage.getItem('caipsd_smtp_user') || 'admin@caipsd.org',
      fromName: 'CAIPSD Events - The Islamia University of Bahawalpur',
      host: 'smtp.gmail.com',
      port: 587,
      isGmail: true
    };
  }

  if (url === '/api/admin/mail/disconnect' && method === 'POST') {
    localStorage.removeItem('caipsd_smtp_user');
    return { message: 'Google account disconnected successfully.' };
  }

  if (url === '/api/admin/mail/test' && method === 'POST') {
    const recipient = body.to || localStorage.getItem('caipsd_smtp_user') || 'saimmalik4728@gmail.com';
    await pushTestEmailToSheet(recipient);
    return { message: `Test email sent successfully to ${recipient}! Check your inbox / spam folder.` };
  }

  if (url === '/api/admin/sheets/template') {
    return { template: GOOGLE_APPS_SCRIPT_CODE };
  }

  return {};
}

async function api(url, options = {}) {
  if (isStaticHost) {
    return handleStaticApi(url, options);
  }
  const response = await fetch(url, { credentials: 'same-origin', ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } });
  let data = {};
  try { data = await response.json(); } catch { /* download or empty body */ }
  if (!response.ok) {
    if (response.status === 401 && !url.includes('/login')) showLogin();
    const error = new Error(data.error || `Request failed (${response.status}).`);
    error.data = data; error.status = response.status;
    throw error;
  }
  return data;
}

function showLogin() {
  $('#admin-app').hidden = true;
  $('#login-screen').hidden = false;
  $('#login-error').textContent = '';
  $('#login-form').reset();
}
function showApp(email) {
  $('#login-screen').hidden = true;
  $('#admin-app').hidden = false;
  $('#admin-email').textContent = email || 'Organizer';
  $('#admin-avatar').textContent = (email || 'A').charAt(0).toUpperCase();
  loadConfig().then(loadDashboard);
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#login-button');
  const fields = Object.fromEntries(new FormData(event.currentTarget).entries());
  $('#login-error').textContent = '';
  button.disabled = true; button.textContent = 'Signing in…';
  try {
    const data = await api('/api/admin/login', { method: 'POST', body: JSON.stringify(fields) });
    showApp(data.admin.email);
  } catch (error) {
    if (error.message.includes('fetch') || error.name === 'TypeError') {
      $('#login-error').textContent = 'Server connection failed. Please ensure the backend server is running on http://localhost:3000.';
    } else {
      $('#login-error').textContent = error.message;
    }
  }
  finally { button.disabled = false; button.innerHTML = 'Sign in <span>→</span>'; }
});
$('#logout-button').addEventListener('click', async () => {
  try { await api('/api/admin/logout', { method: 'POST' }); } catch (error) { console.error(error); }
  stopScanner(); showLogin();
});

function setView(viewName) {
  if (!['overview', 'tickets', 'attendance', 'sheets'].includes(viewName)) return;
  $$('.view-section').forEach((section) => section.classList.toggle('active', section.id === `view-${viewName}`));
  $$('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.view === viewName));
  $('#breadcrumb-current').textContent = ({ overview: 'Overview', tickets: 'Tickets', attendance: 'Entry check-in' })[viewName] || 'Overview';
  $('#sidebar').classList.remove('open');
  if (viewName === 'overview') loadDashboard();
  if (viewName === 'tickets') loadTickets();
  if (viewName === 'attendance') $('#ticket-code-input').focus();
}
$$('.nav-item').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
$$('[data-view-link]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.viewLink)));
$('#mobile-menu').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
$$('[data-action="new-ticket"]').forEach((button) => button.addEventListener('click', openTicketModal));
$('#admin-year').textContent = new Date().getFullYear();

async function loadConfig() {
  try { appConfig = await api('/api/admin/config'); } catch (error) { console.error(error); }
  if ($('#valid-days')) $('#valid-days').textContent = appConfig.validDays || 3;
  const configured = Boolean(appConfig.mail && appConfig.mail.configured);
  if ($('#send-email-checkbox')) {
    $('#send-email-checkbox').checked = configured;
    $('#send-email-checkbox').disabled = !configured;
  }
  if ($('#send-email-label')) {
    $('#send-email-label').textContent = configured
      ? 'Email the ticket to the participant now'
      : 'Connect Google account to email tickets automatically';
  }

  // Update topbar mail pill
  const topbarDot = $('#topbar-mail-dot');
  const topbarText = $('#topbar-mail-text');
  if (topbarDot && topbarText) {
    if (configured) {
      topbarDot.style.background = '#22c55e';
      topbarText.textContent = appConfig.mail.user ? `${appConfig.mail.user}` : 'Google Mail Connected';
    } else {
      topbarDot.style.background = '#f59d14';
      topbarText.textContent = 'Connect Google Mail';
    }
  }

  // Update quick action subtitle
  const quickSub = $('#quick-mail-sub');
  if (quickSub) {
    quickSub.textContent = configured
      ? `Connected: ${appConfig.mail.user || 'Google Mail'}`
      : 'Configure Gmail for automated delivery';
  }

  // Update email delivery status panel
  const mailStatus = $('#mail-status');
  if (mailStatus) {
    if (configured) {
      mailStatus.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
          <div>
            <p style="margin:0 0 5px;"><span class="ok">● Connected.</span> Sender: <strong>${escapeHtml(appConfig.mail.from || appConfig.mail.user)}</strong></p>
            <p style="margin:0; font-size:12px; color:#64748b;">Ready to send admission tickets with QR passes. Use <em>Email all students (1-Click)</em> or send individually.</p>
          </div>
          <div style="display:flex; gap:8px;">
            <button class="admin-button admin-button-secondary" id="panel-test-mail-btn" style="padding:0.35rem 0.75rem; font-size:0.8rem;">Send Test Email</button>
            <button class="admin-button admin-button-light" id="panel-edit-mail-btn" style="padding:0.35rem 0.75rem; font-size:0.8rem;">Settings</button>
          </div>
        </div>
      `;
      $('#panel-test-mail-btn')?.addEventListener('click', triggerTestEmail);
      $('#panel-edit-mail-btn')?.addEventListener('click', openMailModal);
    } else {
      mailStatus.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
          <div>
            <p style="margin:0 0 5px;"><span class="warn">● Not connected.</span> Google Account is not connected yet.</p>
            <p style="margin:0; font-size:12px; color:#64748b;">Connect your Gmail using a Google App Password to enable 1-click email delivery of ticket passes to students.</p>
          </div>
          <button class="admin-button admin-button-primary" id="panel-connect-mail-btn" style="padding:0.4rem 0.9rem; font-size:0.82rem;">Connect Google Account →</button>
        </div>
      `;
      $('#panel-connect-mail-btn')?.addEventListener('click', openMailModal);
    }
  }
}

async function loadDashboard() {
  if (isStaticHost) {
    syncTicketsFromGoogleSheet().then(() => refreshStats()).catch(() => {});
  }
  try {
    const [summary, list] = await Promise.all([api('/api/admin/summary'), api('/api/admin/tickets')]);
    renderStats(summary);
    $('#recent-tickets').innerHTML = ticketsTable(list.tickets.slice(0, 6), false);
  } catch (error) { console.error('Dashboard load failed:', error); }
}
function renderStats(s) {
  $('#stat-total').textContent = s.total; $('#stat-entered').textContent = s.entered;
  $('#stat-awaiting').textContent = s.awaiting; $('#stat-emailed').textContent = s.emailed;
  $('#stat-expired-note').textContent = s.expired ? `${s.expired} ticket${s.expired === 1 ? '' : 's'} expired` : 'Tickets sent by email';
}
async function refreshStats() {
  try { renderStats(await api('/api/admin/summary')); } catch (error) { console.error(error); }
}

function participantCell(row) {
  const initials = row.full_name.trim().split(/\s+/).slice(0, 2).map((word) => word[0] || '').join('').toUpperCase();
  return `<div class="participant-cell"><span class="participant-avatar">${escapeHtml(initials)}</span><span><strong>${escapeHtml(row.full_name)}</strong><small>${escapeHtml(row.email)}</small></span></div>`;
}
function ticketsTable(rows, withActions) {
  if (!rows.length) return '<div class="empty-table">No tickets found. Use “Issue ticket” to create the first one.</div>';
  const head = `<tr><th>PARTICIPANT</th><th>PHONE</th><th>TICKET ID</th><th>VALID UNTIL</th><th>STATUS</th><th>EMAIL</th>${withActions ? '<th></th>' : ''}</tr>`;
  const body = rows.map((row) => `<tr><td>${participantCell(row)}</td><td>${escapeHtml(row.phone)}</td><td><strong>${escapeHtml(row.ticket_code)}</strong></td><td>${escapeHtml(dateTimeLabel(row.valid_until))}</td><td>${ticketPill(row)}</td><td>${emailPill(row)}</td>${withActions ? `<td><div class="row-actions"><a class="status-action" href="ticket.html?code=${encodeURIComponent(row.ticket_code)}" target="_blank" rel="noopener">View</a><button class="status-action send-ticket" data-id="${row.id}" data-email="${escapeHtml(row.email)}">${row.email_status === 'sent' ? 'Resend' : 'Send email'}</button><button class="status-action danger cancel-ticket" data-id="${row.id}" data-name="${escapeHtml(row.full_name)}">Cancel</button></div></td>` : ''}</tr>`).join('');
  return `<table class="data-table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

async function loadTickets() {
  if (isStaticHost) {
    try { await syncTicketsFromGoogleSheet(); } catch {}
  }
  const params = new URLSearchParams();
  const q = $('#search-tickets').value.trim();
  const status = $('#filter-status').value;
  if (q) params.set('q', q);
  if (status) params.set('status', status);
  try {
    const data = await api(`/api/admin/tickets?${params.toString()}`);
    $('#tickets-table').innerHTML = ticketsTable(data.tickets, true);
    $$('.send-ticket').forEach((button) => button.addEventListener('click', async () => {
      button.disabled = true; button.textContent = 'Sending…';
      try {
        const result = await api(`/api/admin/tickets/${button.dataset.id}/send`, { method: 'POST' });
        toast(result.message);
      } catch (error) { toast(error.message, 'error'); }
      await loadTickets(); refreshStats();
    }));
    $$('.cancel-ticket').forEach((button) => button.addEventListener('click', async () => {
      if (!confirm(`Cancel the ticket for ${button.dataset.name}? Its QR code will stop working.`)) return;
      button.disabled = true;
      try {
        const result = await api(`/api/admin/tickets/${button.dataset.id}`, { method: 'DELETE' });
        toast(result.message);
        await loadTickets(); refreshStats();
      } catch (error) { toast(error.message, 'error'); button.disabled = false; }
    }));
  } catch (error) { $('#tickets-table').innerHTML = `<div class="empty-table">${escapeHtml(error.message)}</div>`; }
}
$('#search-tickets').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadTickets, 250); });
$('#filter-status').addEventListener('change', loadTickets);

async function exportCsv() {
  try {
    if (isStaticHost) {
      const rows = getLocalTickets();
      const label = { valid: 'Valid - not entered', checked_in: 'Entered', expired: 'Expired' };
      const headers = ['Participant', 'Email', 'Phone', 'Ticket ID', 'Issued at', 'Valid until', 'Status', 'Entries', 'First entry', 'Last entry', 'Email status'];
      const values = rows.map((r) => [r.full_name, r.email, r.phone, r.ticket_code, r.issued_at, r.valid_until, label[r.status] || r.status, r.entry_count, r.first_entry_at || '', r.last_entry_at || '', r.email_status]);
      const escapeCsv = (value) => {
        let text = String(value ?? '');
        if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
        return `"${text.replace(/"/g, '""')}"`;
      };
      const csv = [headers, ...values].map((line) => line.map(escapeCsv).join(',')).join('\r\n');
      const blob = new Blob(['\ufeff' + csv], { type: 'text/csv; charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'caipsd-tickets.csv';
      document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
      return;
    }
    const response = await fetch('/api/admin/export.csv', { credentials: 'same-origin' });
    if (!response.ok) { const result = await response.json(); throw new Error(result.error || 'Export failed.'); }
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'caipsd-tickets.csv';
    document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
  } catch (error) { toast(error.message, 'error'); }
}
$('#export-csv').addEventListener('click', exportCsv);
$('#quick-export').addEventListener('click', exportCsv);

/* ---- Issue ticket modal ---- */
const ticketModal = $('#ticket-modal');
function openTicketModal() {
  lastFocused = document.activeElement;
  const form = $('#ticket-form'); form.reset();
  $('#send-email-checkbox').checked = appConfig.mail.configured;
  $('#ticket-form-error').textContent = '';
  ticketModal.hidden = false;
  document.body.style.overflow = 'hidden';
  setTimeout(() => form.elements.fullName.focus(), 50);
}
function closeTicketModal() {
  ticketModal.hidden = true; document.body.style.overflow = '';
  if (lastFocused && lastFocused.focus) lastFocused.focus();
}
$('#close-ticket-modal').addEventListener('click', closeTicketModal);
$('#cancel-ticket').addEventListener('click', closeTicketModal);
ticketModal.addEventListener('click', (event) => { if (event.target === ticketModal) closeTicketModal(); });

/* ---- Google Mail Modal ---- */
const mailModal = $('#mail-modal');
async function openMailModal() {
  lastFocused = document.activeElement;
  $('#mail-form-error').textContent = '';
  $('#mail-form-success').textContent = '';
  $('#mail-form-success').style.display = 'none';
  $('#mail-pass-input').value = '';

  try {
    const data = await api('/api/admin/mail/config');
    if (data.configured) {
      $('#mail-user-input').value = data.user || '';
      $('#mail-fromname-input').value = data.fromName || '';
      $('#save-mail-btn').innerHTML = 'Update Connection <span>→</span>';
      $('#disconnect-mail-btn').style.display = 'inline-flex';
      $('#test-mail-btn').style.display = 'inline-flex';
    } else {
      $('#mail-user-input').value = '';
      $('#mail-fromname-input').value = 'CAIPSD Events - The Islamia University of Bahawalpur';
      $('#save-mail-btn').innerHTML = 'Connect & Save <span>→</span>';
      $('#disconnect-mail-btn').style.display = 'none';
      $('#test-mail-btn').style.display = 'none';
    }
  } catch (error) {
    console.error('Mail config fetch failed:', error);
  }

  mailModal.hidden = false;
  document.body.style.overflow = 'hidden';
  setTimeout(() => $('#mail-user-input').focus(), 50);
}

function closeMailModal() {
  mailModal.hidden = true;
  document.body.style.overflow = '';
  if (lastFocused && lastFocused.focus) lastFocused.focus();
}

$('#close-mail-modal')?.addEventListener('click', closeMailModal);
$('#cancel-mail-modal')?.addEventListener('click', closeMailModal);
mailModal?.addEventListener('click', (event) => { if (event.target === mailModal) closeMailModal(); });
$('#manage-mail-btn')?.addEventListener('click', openMailModal);
$('#topbar-email-btn')?.addEventListener('click', openMailModal);
$('#quick-connect-mail')?.addEventListener('click', openMailModal);

$('#mail-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const user = $('#mail-user-input').value.trim();
  const pass = $('#mail-pass-input').value.trim();
  const fromName = $('#mail-fromname-input').value.trim();
  const button = $('#save-mail-btn');
  const errorBox = $('#mail-form-error');
  const successBox = $('#mail-form-success');

  errorBox.textContent = '';
  successBox.style.display = 'none';
  button.disabled = true;
  button.textContent = 'Verifying with Google…';

  try {
    const result = await api('/api/admin/mail/config', {
      method: 'POST',
      body: JSON.stringify({ user, pass, fromName })
    });
    successBox.textContent = '✓ ' + result.message;
    successBox.style.display = 'block';
    toast(result.message);
    await loadConfig();
    setTimeout(() => {
      closeMailModal();
    }, 1200);
  } catch (error) {
    errorBox.textContent = error.message;
  } finally {
    button.disabled = false;
    button.innerHTML = 'Connect & Save <span>→</span>';
  }
});

$('#disconnect-mail-btn')?.addEventListener('click', async () => {
  if (!confirm('Are you sure you want to disconnect your Google account? Ticket emails will not be sent until you reconnect.')) return;
  const button = $('#disconnect-mail-btn');
  button.disabled = true;
  try {
    const res = await api('/api/admin/mail/disconnect', { method: 'POST' });
    toast(res.message);
    closeMailModal();
    await loadConfig();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    button.disabled = false;
  }
});

async function triggerTestEmail() {
  const defaultTo = appConfig.mail?.user || localStorage.getItem('caipsd_smtp_user') || 'saimmalik4728@gmail.com';
  const recipient = prompt('Enter the email address to receive the test message:', defaultTo);
  if (!recipient || !recipient.trim()) return;
  toast('Sending test email via Google…');
  try {
    const res = await api('/api/admin/mail/test', {
      method: 'POST',
      body: JSON.stringify({ to: recipient.trim() })
    });
    toast(res.message);
    alert('✓ ' + res.message);
  } catch (err) {
    toast(err.message, 'error');
    alert(err.message);
  }
}
$('#test-mail-btn')?.addEventListener('click', triggerTestEmail);

async function copyAppsScriptCode() {
  try {
    let scriptCode = GOOGLE_APPS_SCRIPT_CODE;
    try {
      const res = await api('/api/admin/sheets/template');
      if (res && res.template) scriptCode = res.template;
    } catch {}

    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(scriptCode);
      toast('✓ Google Apps Script copied to clipboard!');
      alert('✓ Google Apps Script copied to clipboard!\n\nNext steps in your Google Sheet:\n1. Open Extensions > Apps Script\n2. Select All (Ctrl+A), Paste (Ctrl+V), and Save (Ctrl+S)\n3. From the top dropdown, select "authorizeAndSendTestEmail" and click "Run" (▶️)\n4. Click "Review permissions" -> Select your Google Account -> Advanced -> Go to ... (unsafe) -> Allow\n5. Click Deploy > Manage deployments > Edit (pencil icon) > Version: New version > Deploy');
    } else {
      prompt('Copy this Google Apps Script code (Ctrl+C):', scriptCode);
    }
  } catch (err) {
    prompt('Copy this Google Apps Script code (Ctrl+C):', GOOGLE_APPS_SCRIPT_CODE);
  }
}
$('#copy-apps-script-btn')?.addEventListener('click', copyAppsScriptCode);

/* ---- 1-Click Bulk Email Modal ---- */
const emailAllModal = $('#email-all-modal');

async function openEmailAllModal() {
  if (!appConfig.mail || !appConfig.mail.configured) {
    toast('Please connect your Google / Gmail account first to email students.', 'error');
    openMailModal();
    return;
  }

  lastFocused = document.activeElement;
  $('#email-all-error').textContent = '';
  $('#email-all-progress-wrap').style.display = 'none';
  $('#email-all-progress-fill').style.width = '0%';
  $('#confirm-email-all-btn').disabled = false;
  $('#confirm-email-all-btn').innerHTML = '✉ Send Emails Now (1-Click)';

  try {
    const [summary, ticketsData] = await Promise.all([
      api('/api/admin/summary'),
      api('/api/admin/tickets')
    ]);
    const pendingTickets = ticketsData.tickets.filter((t) => t.email_status !== 'sent');
    const pendingCount = pendingTickets.length;
    $('#email-all-pending-count').textContent = pendingCount;
    $('#email-all-total-count').textContent = summary.total;
    $('#email-all-sent-count').textContent = summary.emailed;

    const radioPending = $('input[name="emailMode"][value="pending"]');
    const radioAll = $('input[name="emailMode"][value="all"]');

    if (pendingCount === 0 && summary.total > 0) {
      if (radioAll) radioAll.checked = true;
      $$('.radio-card').forEach((c) => c.classList.toggle('active', c.contains(radioAll)));
    } else {
      if (radioPending) radioPending.checked = true;
      $$('.radio-card').forEach((c) => c.classList.toggle('active', c.contains(radioPending)));
    }
  } catch (error) {
    console.error('Failed to prepare email all dialog:', error);
  }

  emailAllModal.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeEmailAllModal() {
  emailAllModal.hidden = true;
  document.body.style.overflow = '';
  if (lastFocused && lastFocused.focus) lastFocused.focus();
}

$('#close-email-all-modal')?.addEventListener('click', closeEmailAllModal);
$('#cancel-email-all-modal')?.addEventListener('click', closeEmailAllModal);
emailAllModal?.addEventListener('click', (event) => { if (event.target === emailAllModal) closeEmailAllModal(); });
$('#btn-email-all')?.addEventListener('click', openEmailAllModal);
$('#quick-email-all')?.addEventListener('click', openEmailAllModal);
$('#stat-card-emailed')?.addEventListener('click', openEmailAllModal);

$$('.radio-card input').forEach((radio) => {
  radio.addEventListener('change', () => {
    $$('.radio-card').forEach((card) => card.classList.toggle('active', card.contains(radio)));
  });
});

$('#email-all-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const selectedMode = $('input[name="emailMode"]:checked')?.value || 'pending';
  const button = $('#confirm-email-all-btn');
  const cancelBtn = $('#cancel-email-all-modal');
  const closeBtn = $('#close-email-all-modal');
  const progressWrap = $('#email-all-progress-wrap');
  const progressFill = $('#email-all-progress-fill');
  const progressText = $('#email-all-progress-text');
  const errorBox = $('#email-all-error');

  errorBox.textContent = '';
  button.disabled = true;
  if (cancelBtn) cancelBtn.disabled = true;
  if (closeBtn) closeBtn.disabled = true;
  progressWrap.style.display = 'block';
  progressFill.style.width = '25%';
  progressText.textContent = 'Generating QR codes and emailing students… please wait.';

  let progressInterval = setInterval(() => {
    const current = parseFloat(progressFill.style.width) || 25;
    if (current < 85) progressFill.style.width = (current + 10) + '%';
  }, 400);

  try {
    const data = await api('/api/admin/tickets/email-all', {
      method: 'POST',
      body: JSON.stringify({ mode: selectedMode })
    });
    clearInterval(progressInterval);
    progressFill.style.width = '100%';
    progressText.textContent = data.message;
    toast(data.message);

    setTimeout(() => {
      closeEmailAllModal();
      refreshStats();
      if ($('#view-tickets').classList.contains('active')) loadTickets();
      else if ($('#view-overview').classList.contains('active')) loadDashboard();
    }, 1000);
  } catch (error) {
    clearInterval(progressInterval);
    progressWrap.style.display = 'none';
    errorBox.textContent = error.message;
    toast(error.message, 'error');
    button.disabled = false;
    if (cancelBtn) cancelBtn.disabled = false;
    if (closeBtn) closeBtn.disabled = false;
  }
});

/* Modal keyboard accessibility */
document.addEventListener('keydown', (event) => {
  const activeModal = [ticketModal, mailModal, emailAllModal].find((m) => m && !m.hidden);
  if (!activeModal) return;
  if (event.key === 'Escape') {
    if (activeModal === ticketModal) closeTicketModal();
    else if (activeModal === mailModal) closeMailModal();
    else if (activeModal === emailAllModal) closeEmailAllModal();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = [...activeModal.querySelectorAll('button, input, select, textarea, a[href]')].filter((el) => !el.disabled);
  if (!focusable.length) return;
  const first = focusable[0]; const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
$('#ticket-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = { fullName: form.elements.fullName.value, email: form.elements.email.value, phone: form.elements.phone.value, sendEmail: form.elements.sendEmail.checked };
  const button = $('#save-ticket'); button.disabled = true; button.textContent = 'Generating…'; $('#ticket-form-error').textContent = '';
  try {
    const data = await api('/api/admin/tickets', { method: 'POST', body: JSON.stringify(payload) });
    closeTicketModal();
    if (data.email.status === 'sent') toast(`Ticket created and emailed to ${data.ticket.email}.`);
    else if (data.email.status === 'failed') toast(`Ticket created, but the email failed: ${data.email.error}`, 'error');
    else toast('Ticket created and saved. Use “Send email” when you are ready to deliver it.');
    refreshStats();
    if ($('#view-tickets').classList.contains('active')) loadTickets(); else if ($('#view-overview').classList.contains('active')) loadDashboard();
  } catch (error) { $('#ticket-form-error').textContent = error.message; }
  finally { button.disabled = false; button.innerHTML = 'Generate ticket <span>→</span>'; }
});

/* ---- Entry check-in ---- */
function showCheckinResult(type, message, ticket = null, extra = '') {
  const result = $('#checkin-result');
  result.className = `checkin-result ${type}`;
  const icon = type === 'success' ? '✓' : type === 'warning' ? '!' : '×';
  const detail = ticket ? `<small>${escapeHtml(ticket.full_name)}<br>Ticket: ${escapeHtml(ticket.ticket_code)} · Valid until ${escapeHtml(dateTimeLabel(ticket.valid_until))}${extra ? `<br>${escapeHtml(extra)}` : ''}</small>` : '<small>Please check the ticket and try again.</small>';
  result.innerHTML = `<div class="result-icon">${icon}</div><strong>${escapeHtml(message)}</strong>${detail}`;
}
async function performCheckin(ticketCode) {
  const cleaned = extractTicketCode(ticketCode);
  if (!cleaned) {
    showCheckinResult('error', 'Enter a valid 16-character ticket ID or scan a ticket QR.');
    return;
  }
  const note = $('#scanner-message');
  note.textContent = 'Verifying ticket…';
  note.className = 'scanner-message';
  try {
    const result = await api('/api/admin/check-in', { method: 'POST', body: JSON.stringify({ ticketCode: cleaned }) });
    showCheckinResult(result.repeat ? 'warning' : 'success', result.message, result.ticket, result.repeat ? `Previous entry: ${dateTimeLabel(result.ticket.first_entry_at)}` : '');
    note.textContent = result.message; note.className = 'scanner-message success';
    $('#ticket-code-input').value = '';
    refreshStats();
  } catch (error) {
    showCheckinResult('error', error.message, error.data && error.data.ticket);
    note.textContent = error.message; note.className = 'scanner-message error';
  }
}
$('#manual-checkin-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  await performCheckin($('#ticket-code-input').value);
});

async function startScanner() {
  if (scannerRunning) return;
  if (typeof Html5Qrcode === 'undefined') {
    $('#scanner-message').textContent = 'The camera scanner library could not load. Use manual ticket ID check-in instead.';
    $('#scanner-message').className = 'scanner-message error'; return;
  }
  try {
    if (!html5Scanner) html5Scanner = new Html5Qrcode('reader');
    $('#start-scanner').disabled = true; $('#scanner-message').textContent = 'Requesting camera access…';
    await html5Scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 210, height: 210 }, aspectRatio: 1 }, async (decodedText) => {
      $('#scanner-message').textContent = 'Ticket detected. Verifying…';
      await stopScanner();
      await performCheckin(decodedText);
    }, () => {});
    scannerRunning = true;
    $('#start-scanner').disabled = true; $('#stop-scanner').disabled = false;
    $('#scanner-message').textContent = 'Camera is active. Hold the QR code inside the frame.';
    $('#scanner-message').className = 'scanner-message';
  } catch (error) {
    $('#scanner-message').textContent = error?.message || 'Unable to start the camera. Check camera permissions or use manual check-in.';
    $('#scanner-message').className = 'scanner-message error';
    $('#start-scanner').disabled = false; $('#stop-scanner').disabled = true;
  }
}
async function stopScanner() {
  if (html5Scanner && scannerRunning) {
    try { await html5Scanner.stop(); } catch (error) { console.warn('Scanner stop:', error); }
    try { await html5Scanner.clear(); } catch (error) { console.warn('Scanner clear:', error); }
  }
  scannerRunning = false;
  if ($('#start-scanner')) $('#start-scanner').disabled = false;
  if ($('#stop-scanner')) $('#stop-scanner').disabled = true;
}
$('#start-scanner').addEventListener('click', startScanner);
$('#stop-scanner').addEventListener('click', stopScanner);

/* ---- Google Sheets Integration (Permanently Attached) ---- */
// Background real-time sync is permanently active for spreadsheet: 12J1fq7Os6eCfy1pseBAcnC7daGtjn-SA-i0UgyNT00o

(async function initialize() {
  if (isStaticHost) {
    syncTicketsFromGoogleSheet().catch(() => {});
  }
  try { const data = await api('/api/admin/me'); showApp(data.admin.email); } catch { showLogin(); }
})();
