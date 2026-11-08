const { getSetting, setSetting } = require('./db');

const PERMANENT_WEBHOOK_URL = 'https://script.google.com/macros/s/AKfycbzodcplXRQvdPQlWLPeQbGOZdomvehyFGo4wG5K_9ugWSGuFKN-sRy6hfA6cq5AV-ds2Q/exec';
const PERMANENT_SPREADSHEET_ID = '12J1fq7Os6eCfy1pseBAcnC7daGtjn-SA-i0UgyNT00o';
const PERMANENT_SHEET_NAME = 'CAIPSD_Tickets';

const SHEET_HEADERS = [
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

function extractSpreadsheetId(input) {
  if (!input) return PERMANENT_SPREADSHEET_ID;
  const match = String(input).match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (match) return match[1];
  return String(input).trim();
}

function getSheetsConfig() {
  const webhookUrl = getSetting('google_sheets_webhook_url') || process.env.GOOGLE_SHEETS_WEBHOOK_URL || PERMANENT_WEBHOOK_URL;
  const autoSyncRaw = getSetting('google_sheets_auto_sync') ?? process.env.GOOGLE_SHEETS_AUTO_SYNC ?? '1';
  const autoSync = autoSyncRaw === '1' || autoSyncRaw === 'true' || autoSyncRaw === true;
  const sheetName = getSetting('google_sheets_sheet_name') || process.env.GOOGLE_SHEETS_SHEET_NAME || PERMANENT_SHEET_NAME;
  const lastSyncAt = getSetting('google_sheets_last_sync_at') || null;
  const spreadsheetId = extractSpreadsheetId(
    getSetting('google_sheets_spreadsheet_id') || process.env.GOOGLE_SHEETS_SPREADSHEET_ID || PERMANENT_SPREADSHEET_ID
  );
  const spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;

  return {
    configured: true,
    webhookUrl,
    autoSync,
    sheetName,
    lastSyncAt,
    spreadsheetId,
    spreadsheetUrl
  };
}

function saveSheetsConfig(data) {
  if (data.webhookUrl !== undefined) {
    setSetting('google_sheets_webhook_url', String(data.webhookUrl || '').trim());
  }
  if (data.autoSync !== undefined) {
    setSetting('google_sheets_auto_sync', data.autoSync ? '1' : '0');
  }
  if (data.sheetName !== undefined) {
    setSetting('google_sheets_sheet_name', String(data.sheetName || '').trim() || DEFAULT_SHEET_NAME);
  }
  if (data.spreadsheetId !== undefined) {
    const cleanedId = extractSpreadsheetId(data.spreadsheetId);
    setSetting('google_sheets_spreadsheet_id', cleanedId);
    if (cleanedId) {
      setSetting('google_sheets_sheet_url', `https://docs.google.com/spreadsheets/d/${cleanedId}/edit`);
    }
  }
  return getSheetsConfig();
}

function ticketToRow(t) {
  return [
    t.ticket_code || '',
    t.full_name || '',
    t.email || '',
    t.phone || '',
    t.issued_at || '',
    t.valid_until || '',
    t.status || 'valid',
    t.entry_count ?? 0,
    t.first_entry_at || '',
    t.last_entry_at || '',
    t.email_status || 'not_sent'
  ];
}

async function sendWebhook(action, payload = {}) {
  const config = getSheetsConfig();
  if (!config.webhookUrl) {
    throw new Error('Google Sheets Webhook URL is not configured. Please deploy the Apps Script Web App.');
  }

  const response = await fetch(config.webhookUrl, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action,
      sheetName: config.sheetName,
      spreadsheetId: config.spreadsheetId,
      timestamp: new Date().toISOString(),
      ...payload
    })
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!response.ok || (data && data.status === 'error')) {
    const errorMsg = data && data.message ? data.message : `Webhook request failed (${response.status})`;
    throw new Error(errorMsg);
  }

  return data;
}

async function testConnection() {
  const config = getSheetsConfig();

  if (config.webhookUrl) {
    try {
      const res = await sendWebhook('ping');
      return {
        ok: true,
        message: res.message || 'Connected to Google Sheet successfully via Webhook!',
        details: res
      };
    } catch (error) {
      if (config.spreadsheetId) {
        const canRead = await testSpreadsheetRead(config.spreadsheetId);
        if (canRead) {
          return {
            ok: true,
            message: `Google Sheet (ID: ${config.spreadsheetId}) is attached and accessible. Webhook ping error: ${error.message}`,
            readOnly: true
          };
        }
      }
      return {
        ok: false,
        error: error.message || 'Could not connect to Google Sheet Webhook.'
      };
    }
  }

  if (config.spreadsheetId) {
    const canRead = await testSpreadsheetRead(config.spreadsheetId);
    if (canRead) {
      return {
        ok: true,
        message: `Google Sheet attached successfully! (ID: ${config.spreadsheetId}) — Public read is active. Deploy Web App to enable live write sync.`,
        readOnly: true,
        spreadsheetUrl: config.spreadsheetUrl
      };
    }
    return {
      ok: false,
      error: `Could not reach Google Sheet (${config.spreadsheetId}). Ensure link sharing is enabled.`
    };
  }

  return {
    ok: false,
    error: 'Neither Google Sheet URL nor Webhook URL is configured.'
  };
}

async function testSpreadsheetRead(spreadsheetId) {
  try {
    const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv`;
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    return res.ok;
  } catch {
    return false;
  }
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length <= 1) return [];

  const parseLine = (line) => {
    const items = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (c === ',' && !inQuotes) {
        items.push(cur.trim());
        cur = '';
      } else {
        cur += c;
      }
    }
    items.push(cur.trim());
    return items;
  };

  const rows = lines.map(parseLine);
  if (rows.length <= 1) return [];

  const tickets = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r[0]) continue;
    tickets.push({
      ticket_code: String(r[0] || '').replace(/^'/, ''),
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
  return tickets;
}

async function appendTicket(ticket) {
  const config = getSheetsConfig();
  if (!config.webhookUrl || !config.autoSync) return;

  try {
    await sendWebhook('appendTicket', {
      ticket: {
        id: ticket.id,
        ticket_code: ticket.ticket_code,
        full_name: ticket.full_name,
        email: ticket.email,
        phone: ticket.phone,
        issued_at: ticket.issued_at,
        valid_until: ticket.valid_until,
        status: ticket.status || 'valid',
        entry_count: ticket.entry_count || 0,
        email_status: ticket.email_status || 'not_sent'
      },
      row: ticketToRow(ticket),
      headers: SHEET_HEADERS
    });
  } catch (error) {
    console.error('Google Sheets auto-sync failed (appendTicket):', error.message);
  }
}

async function updateTicket(ticket) {
  const config = getSheetsConfig();
  if (!config.webhookUrl || !config.autoSync) return;

  try {
    await sendWebhook('updateTicket', {
      ticketCode: ticket.ticket_code,
      ticket: {
        id: ticket.id,
        ticket_code: ticket.ticket_code,
        full_name: ticket.full_name,
        email: ticket.email,
        phone: ticket.phone,
        issued_at: ticket.issued_at,
        valid_until: ticket.valid_until,
        status: ticket.status,
        entry_count: ticket.entry_count,
        first_entry_at: ticket.first_entry_at,
        last_entry_at: ticket.last_entry_at,
        email_status: ticket.email_status
      },
      row: ticketToRow(ticket)
    });
  } catch (error) {
    console.error('Google Sheets auto-sync failed (updateTicket):', error.message);
  }
}

async function cancelTicket(ticketCode) {
  const config = getSheetsConfig();
  if (!config.webhookUrl || !config.autoSync) return;

  try {
    await sendWebhook('cancelTicket', { ticketCode });
  } catch (error) {
    console.error('Google Sheets auto-sync failed (cancelTicket):', error.message);
  }
}

async function syncAllTickets(tickets) {
  const config = getSheetsConfig();
  if (!config.webhookUrl) {
    throw new Error('To push tickets to Google Sheet, please deploy the Web App script and paste its URL.');
  }

  const rows = tickets.map(ticketToRow);
  const result = await sendWebhook('syncAll', {
    headers: SHEET_HEADERS,
    rows
  });

  const now = new Date().toISOString();
  setSetting('google_sheets_last_sync_at', now);
  return { ...result, syncedAt: now, count: rows.length };
}

async function fetchTicketsFromSheet() {
  const config = getSheetsConfig();

  if (config.webhookUrl) {
    try {
      const result = await sendWebhook('getAll');
      if (result && Array.isArray(result.tickets)) {
        return result.tickets;
      }
    } catch (err) {
      if (!config.spreadsheetId) throw err;
    }
  }

  if (config.spreadsheetId) {
    const csvUrl = `https://docs.google.com/spreadsheets/d/${config.spreadsheetId}/export?format=csv`;
    const response = await fetch(csvUrl, { redirect: 'follow' });
    if (!response.ok) {
      throw new Error(`Failed to read Google Sheet CSV (HTTP ${response.status}). Ensure the sheet link is shared.`);
    }
    const csvText = await response.text();
    return parseCsv(csvText);
  }

  throw new Error('Google Sheets is not configured. Please provide a Spreadsheet ID or Webhook URL.');
}

function getAppsScriptTemplate(customSpreadsheetId) {
  const targetId = customSpreadsheetId || getSheetsConfig().spreadsheetId || DEFAULT_SPREADSHEET_ID;
  return `/**
 * Google Apps Script for CAIPSD Event Management Portal
 * Spreadsheet: https://docs.google.com/spreadsheets/d/${targetId}/edit
 * 
 * Instructions:
 * 1. Open your sheet: https://docs.google.com/spreadsheets/d/${targetId}/edit
 * 2. Click Extensions > Apps Script
 * 3. Replace all editor code with this script and Save.
 * 4. Click Deploy > New deployment > Type: Web app
 * 5. Set "Execute as: Me" and "Who has access: Anyone"
 * 6. Click Deploy, Authorize access, and copy the Web App URL into your CAIPSD portal.
 */

var TARGET_SPREADSHEET_ID = "${targetId}";

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

    return respondJson({ status: 'error', message: 'Unknown action: ' + action });
  } catch (err) {
    return respondJson({ status: 'error', message: err.toString() });
  } finally {
    lock.releaseLock();
  }
}

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || 'ping';
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
}

module.exports = {
  SHEET_HEADERS,
  PERMANENT_SPREADSHEET_ID,
  DEFAULT_SPREADSHEET_ID: PERMANENT_SPREADSHEET_ID,
  PERMANENT_WEBHOOK_URL,
  extractSpreadsheetId,
  getSheetsConfig,
  saveSheetsConfig,
  testConnection,
  appendTicket,
  updateTicket,
  cancelTicket,
  syncAllTickets,
  fetchTicketsFromSheet,
  getAppsScriptTemplate
};
