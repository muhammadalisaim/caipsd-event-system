/**
 * Google Apps Script for CAIPSD Event Management Portal
 * Spreadsheet: https://docs.google.com/spreadsheets/d/12J1fq7Os6eCfy1pseBAcnC7daGtjn-SA-i0UgyNT00o/edit
 * 
 * Instructions:
 * 1. Open your sheet: https://docs.google.com/spreadsheets/d/12J1fq7Os6eCfy1pseBAcnC7daGtjn-SA-i0UgyNT00o/edit
 * 2. Click Extensions > Apps Script
 * 3. Replace all editor code with this script and Save.
 * 4. Click Deploy > New deployment > Type: Web app
 * 5. Set "Execute as: Me" and "Who has access: Anyone"
 * 6. Click Deploy, Authorize access, and copy the Web App URL into your CAIPSD portal.
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
      var validUntil = t.valid_until || '';
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
