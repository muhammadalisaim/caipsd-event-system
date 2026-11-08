/**
 * Google Apps Script for CAIPSD Event Management Portal
 * Spreadsheet: https://docs.google.com/spreadsheets/d/12J1fq7Os6eCfy1pseBAcnC7daGtjn-SA-i0UgyNT00o/edit
 *
 * Instructions:
 * 1. Open your sheet: https://docs.google.com/spreadsheets/d/12J1fq7Os6eCfy1pseBAcnC7daGtjn-SA-i0UgyNT00o/edit
 * 2. Click Extensions > Apps Script
 * 3. Replace all editor code with this script and Save (Ctrl+S).
 * 4. Select "authorizeAndSendTestEmail" in the top dropdown, click Run, and Allow the permissions (one time only).
 * 5. Click Deploy > Manage deployments > Edit (pencil) > Version: New version > Deploy.
 *    (First time? Deploy > New deployment > Web app > Execute as: Me > Who has access: Anyone)
 */

var TARGET_SPREADSHEET_ID = "12J1fq7Os6eCfy1pseBAcnC7daGtjn-SA-i0UgyNT00o";

/**
 * Public page used for the "View ticket online" button inside the email.
 * (The Node server can override this per email by sending its own APP_URL.)
 */
var VIEW_BASE_URL = "https://muhammadalisaim.github.io/caipsd-event-system/ticket.html";

/**
 * OPTIONAL but recommended when you use the Node.js server:
 * put any long random text here AND the same text in .env as GOOGLE_WEBHOOK_SECRET.
 * Then only your server can send emails / read tickets through this script.
 * Leave it empty ("") if you use the GitHub Pages (static) version - the browser cannot keep a secret.
 */
var WEBHOOK_SECRET = "";

function isAuthorized(secret) {
  if (!WEBHOOK_SECRET) return true;
  return String(secret || '') === WEBHOOK_SECRET;
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

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

function handleSendTicketEmail(sheet, recipient, ticketCode, name, opts) {
  opts = opts || {};
  recipient = String(recipient || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    return respondJson({ status: 'error', message: 'Missing or invalid recipient email: ' + recipient });
  }
  ticketCode = String(ticketCode || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{8,32}$/.test(ticketCode)) {
    return respondJson({ status: 'error', message: 'Invalid ticket code.' });
  }
  name = String(name || 'Participant').trim().slice(0, 100);

  var viewLink = String(opts.viewLink || '').trim();
  if (!/^https?:\/\//i.test(viewLink)) {
    viewLink = VIEW_BASE_URL + '?code=' + encodeURIComponent(ticketCode);
  }

  // QR image: the server sends a ready PNG (best: shown inline, also attached as a file).
  // Fallback for the static site: ask a public QR service for it.
  var qrBlob = null;
  if (opts.qrPngBase64) {
    try {
      qrBlob = Utilities.newBlob(Utilities.base64Decode(String(opts.qrPngBase64)), 'image/png', 'caipsd-ticket-' + ticketCode + '.png');
    } catch (eBlob) { qrBlob = null; }
  }
  if (!qrBlob) {
    try {
      qrBlob = UrlFetchApp.fetch('https://api.qrserver.com/v1/create-qr-code/?size=320x320&margin=8&data=' + encodeURIComponent(ticketCode))
        .getBlob().setName('caipsd-ticket-' + ticketCode + '.png');
    } catch (eQr) { qrBlob = null; }
  }

  var safeName = escapeHtml(name);
  var safeCode = escapeHtml(ticketCode);
  var safeLink = escapeHtml(viewLink);

  var plainText = 'CAIPSD Event Admission Pass\n' +
    'The Islamia University of Bahawalpur\n\n' +
    'Hello ' + name + ',\n\n' +
    'Your official admission pass for the CAIPSD Event is confirmed.\n\n' +
    'Ticket ID: ' + ticketCode + '\n' +
    'View and Download Pass: ' + viewLink + '\n\n' +
    'Please show your QR code pass at the entrance for verification.\n\n' +
    'Best regards,\n' +
    'CAIPSD Event Management Team\n' +
    'The Islamia University of Bahawalpur';

  var qrImgTag = qrBlob
    ? '<img src="cid:ticketqr" width="220" height="220" alt="Ticket QR code" style="display:block;margin:0 auto;border-radius:8px">'
    : '<div style="font-size:13px;color:#64748b">QR image unavailable. Use the button below to open your pass.</div>';

  var html = '<!doctype html><html><body style="margin:0;background:#f3f5f8;font-family:Arial,Helvetica,sans-serif;color:#18243a">' +
    '<table width="100%" cellpadding="0" cellspacing="0" style="padding:28px 12px"><tr><td align="center">' +
    '<table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e8ee">' +
    '<tr><td style="background:#1c304e;color:#ffffff;padding:26px 28px;border-bottom:3px solid #f59d14">' +
    '<div style="font-size:11px;letter-spacing:2px;color:#f59d14;font-weight:700;text-transform:uppercase">The Islamia University of Bahawalpur</div>' +
    '<div style="font-size:22px;font-weight:800;margin-top:6px">CAIPSD Event Ticket</div>' +
    '<div style="font-size:13px;color:#94a3b8;margin-top:2px">Official Admission &amp; QR Pass</div>' +
    '</td></tr>' +
    '<tr><td style="padding:26px 28px">' +
    '<p style="margin:0 0 14px;font-size:15px">Hello <strong>' + safeName + '</strong>,</p>' +
    '<p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#4a566b">Your official admission pass is confirmed. Show the QR pass below at the entrance for camera verification.</p>' +
    '<div style="text-align:center;padding:20px;border:2px dashed #2b5fdc;background:#f8fafc;border-radius:12px">' +
    qrImgTag +
    '<div style="margin-top:14px;font-family:Consolas,monospace;font-size:18px;letter-spacing:3px;font-weight:800;color:#1c304e">' + safeCode + '</div>' +
    '<div style="margin-top:4px;font-size:12px;color:#64748b;font-weight:600">Scan at entrance for fast check-in</div>' +
    '</div>' +
    '<p style="text-align:center;margin:24px 0 0"><a href="' + safeLink + '" style="background:#2b5fdc;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:6px;font-size:13px;font-weight:700;display:inline-block">View Ticket Online &amp; Download Pass</a></p>' +
    '</td></tr>' +
    '<tr><td style="padding:16px 28px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:12px;color:#64748b;text-align:center">' +
    'This ticket is issued by CAIPSD, The Islamia University of Bahawalpur. Please do not share this QR pass with others.' +
    '</td></tr>' +
    '</table></td></tr></table></body></html>';

  var mailSubject = 'Your CAIPSD Event Pass - ' + ticketCode;
  var mailOptions = { htmlBody: html, name: 'CAIPSD Event Management' };
  if (qrBlob) {
    mailOptions.inlineImages = { ticketqr: qrBlob };
    mailOptions.attachments = [qrBlob];
  }

  try {
    try {
      GmailApp.sendEmail(recipient, mailSubject, plainText, mailOptions);
    } catch (eGmail) {
      var fallbackOptions = { to: recipient, subject: mailSubject, body: plainText, htmlBody: html, name: 'CAIPSD Event Management' };
      if (qrBlob) { fallbackOptions.inlineImages = { ticketqr: qrBlob }; fallbackOptions.attachments = [qrBlob]; }
      MailApp.sendEmail(fallbackOptions);
    }

    if (sheet) {
      var rIdx = findRowByTicketCode(sheet, ticketCode);
      if (rIdx > 0) {
        sheet.getRange(rIdx, 11).setValue('sent');
      }
    }

    return respondJson({ status: 'ok', message: 'Ticket email delivered to ' + recipient });
  } catch (err) {
    var errMsg = err.message || err.toString();
    if (errMsg.indexOf('permission') !== -1 || errMsg.indexOf('MailApp') !== -1 || errMsg.indexOf('GmailApp') !== -1) {
      errMsg = 'Google Mail Permission Required: In your Google Sheet, click Extensions > Apps Script, select "authorizeAndSendTestEmail" from top dropdown and click "Run" (▶️), then click "Allow". Then Deploy > Manage deployments > Edit > New version > Deploy.';
    }
    return respondJson({ status: 'error', message: errMsg });
  }
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
    if (!isAuthorized(payload.secret)) {
      return respondJson({ status: 'error', message: 'Unauthorized: wrong or missing webhook secret.' });
    }
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

    if (action === 'formatSheet') {
      formatAndAlignSheet();
      return respondJson({ status: 'ok', message: 'Sheet formatted and aligned successfully.' });
    }

    if (action === 'syncAll') {
      var headers = payload.headers || [
        'Ticket ID', 'Full Name', 'Issued At', 'Valid Until', 'Status', 'Entries', 'First Entry', 'Last Entry'
      ];
      var rows = payload.rows || [];

      sheet.clearContents();
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.getRange(1, 1, 1, headers.length)
        .setFontWeight('bold')
        .setBackground('#0d1930')
        .setFontColor('#FFFFFF')
        .setHorizontalAlignment('center');
      sheet.getRange(1, 2).setHorizontalAlignment('left');
      sheet.setRowHeight(1, 38);
      sheet.setFrozenRows(1);

      if (rows.length > 0) {
        sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
      }
      formatAndAlignSheet();
      return respondJson({ status: 'ok', message: 'Successfully synced ' + rows.length + ' tickets to Google Sheet.', count: rows.length });
    }

    if (action === 'appendTicket' || action === 'append') {
      ensureHeaders(sheet, payload.headers);
      var row = payload.row;
      if (payload.ticket && (!row || row.length !== sheet.getLastColumn())) {
        row = buildRowForTicket(sheet, payload.ticket);
      }
      if (row && row.length) {
        var code = String(row[0] || '').replace(/^'/, '').trim().toUpperCase();
        var existingRowIndex = findRowByTicketCode(sheet, code);
        var cols = Math.min(row.length, sheet.getLastColumn());
        if (existingRowIndex > 0) {
          sheet.getRange(existingRowIndex, 1, 1, cols).setValues([row.slice(0, cols)]);
        } else {
          sheet.appendRow(row.slice(0, cols));
        }
      }
      return respondJson({ status: 'ok', message: 'Ticket saved in Google Sheet.' });
    }

    if (action === 'updateTicket' || action === 'update') {
      var ticketCode = payload.ticketCode || (payload.ticket && payload.ticket.ticket_code);
      var updatedRow = payload.row;
      if (payload.ticket && (!updatedRow || updatedRow.length !== sheet.getLastColumn())) {
        updatedRow = buildRowForTicket(sheet, payload.ticket);
      }
      if (ticketCode && updatedRow) {
        var rowIndex = findRowByTicketCode(sheet, ticketCode);
        var cols = Math.min(updatedRow.length, sheet.getLastColumn());
        if (rowIndex > 0) {
          var existingData = sheet.getRange(rowIndex, 1, 1, sheet.getLastColumn()).getValues()[0];
          var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
          var entriesColIdx = 5;
          var lastEntryColIdx = 7;
          for (var h = 0; h < headers.length; h++) {
            var hName = String(headers[h] || '').trim().toLowerCase();
            if (hName === 'entries') entriesColIdx = h;
            if (hName === 'last entry') lastEntryColIdx = h;
          }

          var existingLastEntry = String(existingData[lastEntryColIdx] || '').trim();
          var existingEntries = Number(existingData[entriesColIdx] || 0);

          var newLastEntry = String(updatedRow[lastEntryColIdx] || '').trim();
          var newEntries = Number(updatedRow[entriesColIdx] || 0);

          if (existingLastEntry && existingEntries > 0) {
            var existingDay = '';
            try {
              existingDay = (new Date(existingLastEntry)).toISOString().slice(0, 10);
            } catch (e) {
              existingDay = String(existingLastEntry).slice(0, 10);
            }
            var incomingDay = '';
            try {
              incomingDay = (new Date(newLastEntry || new Date())).toISOString().slice(0, 10);
            } catch (e) {
              incomingDay = String(newLastEntry || '').slice(0, 10);
            }
            if (existingDay && incomingDay && existingDay === incomingDay && newEntries > existingEntries) {
              return respondJson({
                status: 'already_used',
                alreadyUsed: true,
                alreadyScannedToday: true,
                message: 'Already used ticket! 1 din mein sirf 1 bar entry allowed hai. Next day dobara scan ho sakega.',
                entries: existingEntries
              });
            }
          }

          sheet.getRange(rowIndex, 1, 1, cols).setValues([updatedRow.slice(0, cols)]);
          return respondJson({ status: 'ok', message: 'Row updated.' });
        } else {
          sheet.appendRow(updatedRow.slice(0, cols));
          return respondJson({ status: 'ok', message: 'Row appended.' });
        }
      }
      return respondJson({ status: 'error', message: 'Missing ticketCode or row data' });
    }

    if (action === 'cancelTicket') {
      var cancelCode = payload.ticketCode;
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
      var tickets = [];
      for (var i = 1; i < data.length; i++) {
        var parsed = parseSheetRow(data[i]);
        if (parsed) tickets.push(parsed);
      }
      return respondJson({ status: 'ok', tickets: tickets });
    }

    if (action === 'sendTicketEmail' || action === 'sendEmail') {
      var t = payload.ticket || {};
      var recipient = String(payload.to || t.email || '').trim().toLowerCase();
      var ticketCode = String(payload.ticketCode || t.ticket_code || '').trim();
      var name = String(payload.fullName || t.full_name || 'Participant').trim();
      return handleSendTicketEmail(sheet, recipient, ticketCode, name, { qrPngBase64: payload.qrPngBase64, viewLink: payload.viewLink });
    }

    if (action === 'sendTestEmail') {
      var to = String(payload.to || (payload.ticket && payload.ticket.email) || '').trim().toLowerCase();
      if (!to) {
        try {
          to = Session.getActiveUser().getEmail() || ss.getOwner().getEmail() || 'saimmalik4728@gmail.com';
        } catch (eUser) {
          to = 'saimmalik4728@gmail.com';
        }
      }
      try {
        var testSubject = 'CAIPSD Event System - Email Test';
        var testBody = 'Google Account Connected!\n\nThis test email confirms that your Google Account is successfully connected to the CAIPSD Event Management Portal.\n\nYou can now send ticket QR passes to all students in 1 click.\n\nCAIPSD Events - The Islamia University of Bahawalpur';
        var testHtml = '<div style="font-family:Arial,sans-serif;padding:20px;border-left:4px solid #2b5fdc;">' +
          '<h2 style="color:#1c304e;">Google Account Connected!</h2>' +
          '<p>This test email confirms that your Google Account is successfully connected to the CAIPSD Event Management Portal.</p>' +
          '<p>You can now send ticket QR passes to all students in 1 click.</p>' +
          '<p style="color:#64748b;font-size:12px;">CAIPSD Events - The Islamia University of Bahawalpur</p>' +
          '</div>';

        try {
          GmailApp.sendEmail(to, testSubject, testBody, { htmlBody: testHtml, name: 'CAIPSD Event Management' });
        } catch (eGTest) {
          MailApp.sendEmail({ to: to, subject: testSubject, body: testBody, htmlBody: testHtml, name: 'CAIPSD Event Management' });
        }
        return respondJson({ status: 'ok', message: 'Test email delivered to ' + to });
      } catch (err) {
        var errTestMsg = err.message || err.toString();
        if (errTestMsg.indexOf('permission') !== -1 || errTestMsg.indexOf('MailApp') !== -1 || errTestMsg.indexOf('GmailApp') !== -1) {
          errTestMsg = 'Google Mail Permission Required: In your Google Sheet, click Extensions > Apps Script, select "authorizeAndSendTestEmail" from top dropdown and click "Run" (▶️), then click "Allow".';
        }
        return respondJson({ status: 'error', message: errTestMsg });
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
  if (action !== 'ping' && !isAuthorized(e && e.parameter && e.parameter.secret)) {
    return respondJson({ status: 'error', message: 'Unauthorized: wrong or missing webhook secret.' });
  }

  if (action === 'sendTicketEmail' || action === 'sendEmail') {
    var recipient = (e && e.parameter && (e.parameter.to || e.parameter.email)) || '';
    var ticketCode = (e && e.parameter && (e.parameter.ticketCode || e.parameter.code)) || '';
    var name = (e && e.parameter && (e.parameter.fullName || e.parameter.name)) || 'Participant';
    var ss = getSpreadsheet();
    var sheet = ss.getSheetByName('CAIPSD_Tickets') || ss.getSheets()[0];
    return handleSendTicketEmail(sheet, recipient, ticketCode, name, {});
  }

  if (action === 'sendTestEmail') {
    var to = (e && e.parameter && e.parameter.to) || 'saimmalik4728@gmail.com';
    try {
      var testSubject = 'CAIPSD Event System - Email Test';
      var testBody = 'Google Account Connected!\n\nThis test email confirms that your Google Account is successfully connected to the CAIPSD Event Management Portal.\n\nYou can now send ticket QR passes to all students in 1 click.\n\nCAIPSD Events - The Islamia University of Bahawalpur';
      var testHtml = '<div style="font-family:Arial,sans-serif;padding:20px;border-left:4px solid #2b5fdc;">' +
        '<h2 style="color:#1c304e;">Google Account Connected!</h2>' +
        '<p>This test email confirms that your Google Account is successfully connected to the CAIPSD Event Management Portal.</p>' +
        '<p>You can now send ticket QR passes to all students in 1 click.</p>' +
        '<p style="color:#64748b;font-size:12px;">CAIPSD Events - The Islamia University of Bahawalpur</p>' +
        '</div>';

      try {
        GmailApp.sendEmail(to, testSubject, testBody, { htmlBody: testHtml, name: 'CAIPSD Event Management' });
      } catch (eGTest) {
        MailApp.sendEmail({ to: to, subject: testSubject, body: testBody, htmlBody: testHtml, name: 'CAIPSD Event Management' });
      }
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

function buildRowForTicket(sheet, t) {
  var headers = sheet.getRange(1, 1, 1, Math.min(sheet.getLastColumn() || 8, 15)).getValues()[0];
  var c2 = String(headers[2] || '').trim().toLowerCase();
  if (c2 === 'issued at' || headers.length <= 9) {
    return [
      "'" + t.ticket_code,
      t.full_name || '',
      t.issued_at || '',
      t.valid_until || '',
      t.status || 'valid',
      t.entry_count != null ? t.entry_count : 0,
      t.first_entry_at || '',
      t.last_entry_at || ''
    ];
  }
  return [
    "'" + t.ticket_code,
    t.full_name || '',
    t.email || '',
    t.phone || '',
    t.issued_at || '',
    t.valid_until || '',
    t.status || 'valid',
    t.entry_count != null ? t.entry_count : 0,
    t.first_entry_at || '',
    t.last_entry_at || '',
    t.email_status || 'not_sent'
  ];
}

function parseSheetRow(r) {
  var code = String(r[0] || '').replace(/^'/, '').trim().toUpperCase();
  if (!code || code === 'TICKET ID') return null;
  var name = String(r[1] || 'Participant').trim();
  var val2 = String(r[2] || '').trim();
  var is11 = val2.indexOf('@') !== -1 || (r.length > 9 && val2.indexOf('-') === -1 && val2.indexOf('T') === -1);
  if (is11) {
    return {
      ticket_code: code,
      full_name: name,
      email: val2,
      phone: String(r[3] || ''),
      issued_at: String(r[4] || ''),
      valid_until: String(r[5] || ''),
      status: String(r[6] || 'valid'),
      entry_count: Number(r[7] || 0),
      first_entry_at: String(r[8] || ''),
      last_entry_at: String(r[9] || ''),
      email_status: String(r[10] || 'not_sent')
    };
  }
  return {
    ticket_code: code,
    full_name: name,
    email: '',
    phone: '',
    issued_at: val2,
    valid_until: String(r[3] || ''),
    status: String(r[4] || 'valid'),
    entry_count: Number(r[5] || 0),
    first_entry_at: String(r[6] || ''),
    last_entry_at: String(r[7] || ''),
    email_status: 'not_sent'
  };
}

function ensureHeaders(sheet, customHeaders) {
  if (sheet.getLastRow() === 0) {
    var headers = customHeaders || [
      'Ticket ID', 'Full Name', 'Issued At', 'Valid Until', 'Status', 'Entries', 'First Entry', 'Last Entry'
    ];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#0d1930').setFontColor('#FFFFFF').setHorizontalAlignment('center');
    sheet.getRange(1, 2).setHorizontalAlignment('left');
    sheet.setRowHeight(1, 38);
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

/**
 * ==============================================================================
 * AUTO-ALIGN & FORMAT MENU FOR GOOGLE SHEETS
 * ==============================================================================
 * Jab Google Sheet open hoti hai, top toolbar par "⚡ CAIPSD Event" menu ban jata hai.
 * Wahan se 1-click se sheet ko align aur auto-format kar sakte hain.
 */
function onOpen() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu('⚡ CAIPSD Event')
    .addItem('✨ Align & Auto-Format Sheet', 'formatAndAlignSheet')
    .addItem('🧹 Remove Blank Columns (C & D)', 'formatAndAlignSheet')
    .addItem('🏷️ Restore All Headers (Email & Phone)', 'formatWithAllColumns')
    .addToUi();
}

/**
 * Align & Auto-Format Sheet:
 * - Detects and removes empty blank gap columns (C & D).
 * - Applies Executive Navy header styling (#0d1930) with bold white font and middle vertical alignment.
 * - Formats data rows (Ticket ID centered monospace, Name left-aligned, Dates/Status centered).
 * - Auto-resizes all column widths with comfortable padding.
 * - Deletes excess empty columns (L, M, N...) for a clean app dashboard look.
 */
function formatAndAlignSheet() {
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName("CAIPSD_Tickets") || ss.getSheetByName("Tickets") || ss.getActiveSheet();
  
  var maxCols = sheet.getMaxColumns();
  if (maxCols >= 4) {
    var headerRow = sheet.getRange(1, 1, 1, Math.min(maxCols, 15)).getValues()[0];
    var c1 = String(headerRow[2] || '').trim();
    var d1 = String(headerRow[3] || '').trim();
    
    // If columns C and D are blank, delete them so data shifts left seamlessly
    if (c1 === '' && d1 === '') {
      sheet.deleteColumns(3, 2);
    }
  }

  var cleanHeaders = [
    'Ticket ID',
    'Full Name',
    'Issued At',
    'Valid Until',
    'Status',
    'Entries',
    'First Entry',
    'Last Entry'
  ];
  
  var numCols = cleanHeaders.length;
  sheet.getRange(1, 1, 1, numCols).setValues([cleanHeaders]);
  
  // Style header row
  var headerRange = sheet.getRange(1, 1, 1, numCols);
  headerRange
    .setFontWeight('bold')
    .setFontFamily('Arial')
    .setFontSize(10.5)
    .setFontColor('#FFFFFF')
    .setBackground('#0d1930')
    .setVerticalAlignment('middle')
    .setHorizontalAlignment('center');
  
  // Full Name left aligned
  sheet.getRange(1, 2).setHorizontalAlignment('left');
  
  sheet.setRowHeight(1, 38);
  sheet.setFrozenRows(1);
  
  // Format data rows if they exist
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    var dataRows = lastRow - 1;
    var allData = sheet.getRange(2, 1, dataRows, numCols);
    
    allData
      .setFontFamily('Arial')
      .setFontSize(10)
      .setVerticalAlignment('middle')
      .setFontColor('#1e293b');
      
    for (var r = 2; r <= lastRow; r++) {
      sheet.setRowHeight(r, 32);
    }
    
    // Col 1: Ticket ID (Center, Monospace, Bold)
    sheet.getRange(2, 1, dataRows, 1)
      .setHorizontalAlignment('center')
      .setFontFamily('Courier New')
      .setFontWeight('bold')
      .setFontColor('#0f172a');
      
    // Col 2: Full Name (Left, Bold)
    sheet.getRange(2, 2, dataRows, 1)
      .setHorizontalAlignment('left')
      .setFontWeight('bold');
      
    // Col 3 & 4: Issued At, Valid Until (Center)
    sheet.getRange(2, 3, dataRows, 2)
      .setHorizontalAlignment('center')
      .setFontColor('#475569');
      
    // Col 5: Status (Center, Bold)
    sheet.getRange(2, 5, dataRows, 1)
      .setHorizontalAlignment('center')
      .setFontWeight('bold');
      
    // Col 6: Entries (Center, Bold)
    sheet.getRange(2, 6, dataRows, 1)
      .setHorizontalAlignment('center')
      .setFontWeight('bold');
      
    // Col 7 & 8: First & Last Entry (Center)
    sheet.getRange(2, 7, dataRows, 2)
      .setHorizontalAlignment('center')
      .setFontColor('#475569');
      
    allData.setBorder(true, true, true, true, true, true, '#e2e8f0', SpreadsheetApp.BorderStyle.SOLID);
  }
  
  // Auto-resize columns with generous padding
  sheet.autoResizeColumns(1, numCols);
  for (var c = 1; c <= numCols; c++) {
    var w = sheet.getColumnWidth(c);
    var minW = (c === 1 ? 160 : (c === 2 ? 180 : 120));
    sheet.setColumnWidth(c, Math.max(w + 24, minW));
  }
  
  // Clean up excess columns beyond data columns
  var curMaxCols = sheet.getMaxColumns();
  if (curMaxCols > numCols) {
    sheet.deleteColumns(numCols + 1, curMaxCols - numCols);
  }
  
  try {
    SpreadsheetApp.getActiveSpreadsheet().toast('✓ Sheet aligned and formatted successfully!', 'CAIPSD Event', 4);
  } catch(e) {}
}

/**
 * Restores all 11 columns (including Email & Phone) and applies full alignment
 */
function formatWithAllColumns() {
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName("CAIPSD_Tickets") || ss.getSheetByName("Tickets") || ss.getActiveSheet();
  
  var allHeaders = [
    'Ticket ID',
    'Full Name',
    'Email',
    'Phone',
    'Issued At',
    'Valid Until',
    'Status',
    'Entries',
    'First Entry',
    'Last Entry',
    'Email Status'
  ];
  
  var numCols = allHeaders.length;
  sheet.getRange(1, 1, 1, numCols).setValues([allHeaders]);
  
  var headerRange = sheet.getRange(1, 1, 1, numCols);
  headerRange
    .setFontWeight('bold')
    .setFontFamily('Arial')
    .setFontSize(10.5)
    .setFontColor('#FFFFFF')
    .setBackground('#0d1930')
    .setVerticalAlignment('middle')
    .setHorizontalAlignment('center');
  
  sheet.getRange(1, 2).setHorizontalAlignment('left'); // Full Name
  sheet.getRange(1, 3).setHorizontalAlignment('left'); // Email
  
  sheet.setRowHeight(1, 38);
  sheet.setFrozenRows(1);
  
  sheet.autoResizeColumns(1, numCols);
  for (var c = 1; c <= numCols; c++) {
    var w = sheet.getColumnWidth(c);
    var minW = (c === 1 ? 160 : (c === 2 ? 180 : (c === 3 ? 180 : 120)));
    sheet.setColumnWidth(c, Math.max(w + 24, minW));
  }
  
  var curMaxCols = sheet.getMaxColumns();
  if (curMaxCols > numCols) {
    sheet.deleteColumns(numCols + 1, curMaxCols - numCols);
  }
  
  try {
    SpreadsheetApp.getActiveSpreadsheet().toast('✓ All 11 columns restored and aligned!', 'CAIPSD Event', 4);
  } catch(e) {}
}
