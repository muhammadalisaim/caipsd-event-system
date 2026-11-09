const fs = require('fs');
const path = require('path');
const { getSetting, setSetting } = require('./db');

const PERMANENT_WEBHOOK_URL = 'https://script.google.com/macros/s/AKfycbzodcplXRQvdPQlWLPeQbGOZdomvehyFGo4wG5K_9ugWSGuFKN-sRy6hfA6cq5AV-ds2Q/exec';
const PERMANENT_SPREADSHEET_ID = '12J1fq7Os6eCfy1pseBAcnC7daGtjn-SA-i0UgyNT00o';
const PERMANENT_SHEET_NAME = 'CAIPSD_Tickets';

const WEBHOOK_TIMEOUT_MS = Number(process.env.GOOGLE_WEBHOOK_TIMEOUT_MS || 30000);

const SHEET_HEADERS = [
  'Ticket ID',
  'Full Name',
  'Issued At',
  'Valid Until',
  'Status',
  'Entries',
  'First Entry',
  'Last Entry'
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
    setSetting('google_sheets_sheet_name', String(data.sheetName || '').trim() || PERMANENT_SHEET_NAME);
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
  const code = t.ticket_code ? `'${String(t.ticket_code).replace(/^'/, '')}` : '';
  return [
    code,
    t.full_name || '',
    t.issued_at || '',
    t.valid_until || '',
    t.status || 'valid',
    t.entry_count ?? 0,
    t.first_entry_at || '',
    t.last_entry_at || ''
  ];
}

function groupTicketsByParticipant(tickets) {
  const groups = new Map();
  for (const t of tickets) {
    if (!t) continue;
    const rawName = String(t.full_name || 'Participant').trim();
    if (rawName.toLowerCase() === 'full name' || rawName.toLowerCase() === 'ticket id' || String(t.ticket_code).toUpperCase() === 'TICKET ID') {
      continue;
    }
    const baseName = rawName.replace(/\s*\((?:Day\s*\d+|Day\d+)\)$/i, '').trim();
    const issuedMinute = t.issued_at ? t.issued_at.slice(0, 16) : '';
    const key = `${baseName.toLowerCase()}::${issuedMinute}`;
    if (!groups.has(key)) {
      groups.set(key, {
        baseName,
        email: t.email || '',
        phone: t.phone || '',
        tickets: []
      });
    }
    const grp = groups.get(key);
    const match = (t.full_name || '').match(/\(Day\s*(\d+)\)/i);
    const dayNum = match ? parseInt(match[1], 10) : 0;
    const alreadyHasDay = dayNum > 0 && grp.tickets.some((existing) => {
      const em = (existing.full_name || '').match(/\(Day\s*(\d+)\)/i);
      return em && parseInt(em[1], 10) === dayNum;
    });
    if (!alreadyHasDay) {
      if (!grp.email && t.email) grp.email = t.email;
      if (!grp.phone && t.phone) grp.phone = t.phone;
      grp.tickets.push(t);
    }
  }

  for (const g of groups.values()) {
    g.tickets.sort((a, b) => {
      const matchA = (a.full_name || '').match(/\(Day\s*(\d+)\)/i);
      const matchB = (b.full_name || '').match(/\(Day\s*(\d+)\)/i);
      const dayA = matchA ? parseInt(matchA[1], 10) : 0;
      const dayB = matchB ? parseInt(matchB[1], 10) : 0;
      if (dayA !== dayB) return dayA - dayB;
      return (a.id || 0) - (b.id || 0);
    });
  }

  return Array.from(groups.values());
}

function participantGroupToRow(group) {
  const tickets = group.tickets;
  if (!tickets || tickets.length === 0) return [];
  if (tickets.length === 1) {
    const t = tickets[0];
    const code = t.ticket_code ? `'${String(t.ticket_code).replace(/^'/, '')}` : '';
    return [
      code,
      group.baseName || t.full_name || '',
      t.issued_at || '',
      t.valid_until || '',
      t.status || 'valid',
      t.entry_count ?? 0,
      t.first_entry_at || '',
      t.last_entry_at || ''
    ];
  }

  const codeStr = tickets.map((t, idx) => {
    const m = (t.full_name || '').match(/\(Day\s*(\d+)\)/i);
    const dayLabel = m ? `Day ${m[1]}` : `Day ${idx + 1}`;
    return `${dayLabel}: ${String(t.ticket_code).replace(/^'/, '')}`;
  }).join(' | ');

  const totalEntries = tickets.reduce((sum, t) => sum + (Number(t.entry_count) || 0), 0);
  const totalMax = tickets.length;

  const entriesBreakdown = tickets.map((t, idx) => {
    const m = (t.full_name || '').match(/\(Day\s*(\d+)\)/i);
    const dayLabel = m ? `Day ${m[1]}` : `Day ${idx + 1}`;
    return `${dayLabel}: ${Number(t.entry_count) || 0}`;
  }).join(', ');
  const entriesStr = `${totalEntries}/${totalMax} (${entriesBreakdown})`;

  const allUsed = tickets.every((t) => (Number(t.entry_count) || 0) >= 1);
  const anyUsed = tickets.some((t) => (Number(t.entry_count) || 0) >= 1);
  let statusStr = 'valid';
  if (allUsed) {
    statusStr = `Completed (${totalEntries}/${totalMax})`;
  } else if (anyUsed) {
    const enteredDays = tickets
      .filter((t) => (Number(t.entry_count) || 0) >= 1)
      .map((t, idx) => {
        const m = (t.full_name || '').match(/\(Day\s*(\d+)\)/i);
        return m ? `Day ${m[1]}` : `Day ${idx + 1}`;
      }).join(', ');
    statusStr = `${enteredDays} Entered`;
  }

  const validUntil = tickets[0].valid_until || '';
  const issuedAt = tickets[0].issued_at || '';
  const firstEntries = tickets.map(t => t.first_entry_at).filter(Boolean);
  const lastEntries = tickets.map(t => t.last_entry_at).filter(Boolean);
  const firstEntry = firstEntries.length ? firstEntries.sort()[0] : '';
  const lastEntry = lastEntries.length ? lastEntries.sort().reverse()[0] : '';

  return [
    `'${codeStr}`,
    group.baseName,
    issuedAt,
    validUntil,
    statusStr,
    entriesStr,
    firstEntry,
    lastEntry
  ];
}

async function sendWebhook(action, payload = {}) {
  const config = getSheetsConfig();
  if (!config.webhookUrl) {
    throw new Error('Google Sheets Webhook URL is not configured. Please deploy the Apps Script Web App.');
  }

  const secret = process.env.GOOGLE_WEBHOOK_SECRET || '';
  let response;
  try {
    response = await fetch(config.webhookUrl, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      body: JSON.stringify({
        action,
        sheetName: config.sheetName,
        spreadsheetId: config.spreadsheetId,
        timestamp: new Date().toISOString(),
        ...(secret ? { secret } : {}),
        ...payload
      })
    });
  } catch (error) {
    if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new Error('Google did not answer in time. Please try again in a moment.');
    }
    throw new Error(`Could not reach Google (${error.message}).`);
  }

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (data && data.raw !== undefined && /<html|<!doctype/i.test(String(data.raw))) {
    throw new Error('Google returned a web page instead of data. Re-deploy the Apps Script as "Execute as: Me" and "Who has access: Anyone", then try again.');
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

async function appendTicket(ticketOrTickets) {
  const config = getSheetsConfig();
  if (!config.webhookUrl || !config.autoSync) return;

  try {
    const list = Array.isArray(ticketOrTickets) ? ticketOrTickets : [ticketOrTickets];
    if (list.length === 0) return;
    const groups = groupTicketsByParticipant(list);
    for (const g of groups) {
      const rep = g.tickets[0];
      const row = participantGroupToRow(g);
      await sendWebhook('appendTicket', {
        fullName: g.baseName,
        ticketCode: rep.ticket_code,
        ticket: {
          id: rep.id,
          ticket_code: rep.ticket_code,
          full_name: g.baseName,
          email: g.email || rep.email,
          phone: g.phone || rep.phone,
          issued_at: rep.issued_at,
          valid_until: rep.valid_until,
          status: rep.status || 'valid',
          entry_count: rep.entry_count || 0,
          email_status: rep.email_status || 'not_sent'
        },
        row,
        headers: SHEET_HEADERS
      });
    }
  } catch (error) {
    console.error('Google Sheets auto-sync failed (appendTicket):', error.message);
  }
}

async function updateTicket(ticket, allParticipantTickets = null) {
  const config = getSheetsConfig();
  if (!config.webhookUrl || !config.autoSync) return;

  try {
    let row;
    let baseName = ticket.full_name;
    if (Array.isArray(allParticipantTickets) && allParticipantTickets.length > 0) {
      const groups = groupTicketsByParticipant(allParticipantTickets);
      if (groups.length > 0) {
        row = participantGroupToRow(groups[0]);
        baseName = groups[0].baseName;
      }
    }
    if (!row) {
      row = ticketToRow(ticket);
    }

    await sendWebhook('updateTicket', {
      ticketCode: ticket.ticket_code,
      fullName: baseName,
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
      row
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

async function sendTicketEmailViaSheet(ticket, { qrPngBase64, viewLink } = {}) {
  const config = getSheetsConfig();
  if (!config.webhookUrl) throw new Error('Google Web App URL is not configured.');
  return sendWebhook('sendTicketEmail', {
    ticket,
    to: ticket.email,
    ticketCode: ticket.ticket_code,
    fullName: ticket.full_name,
    ...(qrPngBase64 ? { qrPngBase64 } : {}),
    ...(viewLink ? { viewLink } : {})
  });
}

async function sendTestEmailViaSheet(to) {
  const config = getSheetsConfig();
  if (!config.webhookUrl) throw new Error('Google Web App URL is not configured.');
  return sendWebhook('sendTestEmail', { to });
}

async function syncAllTickets(tickets) {
  const config = getSheetsConfig();
  if (!config.webhookUrl) {
    throw new Error('To push tickets to Google Sheet, please deploy the Web App script and paste its URL.');
  }

  const groups = groupTicketsByParticipant(tickets);
  const rows = groups.map(participantGroupToRow);
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

/**
 * The Apps Script lives in ONE file (google-apps-script.js) so the portal,
 * the README and the "Copy Google Apps Script" button can never drift apart.
 */
function getAppsScriptTemplate(customSpreadsheetId) {
  const targetId = customSpreadsheetId || getSheetsConfig().spreadsheetId || PERMANENT_SPREADSHEET_ID;
  const source = fs.readFileSync(path.join(__dirname, 'google-apps-script.js'), 'utf8');
  return source.split(PERMANENT_SPREADSHEET_ID).join(targetId);
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
  sendTicketEmailViaSheet,
  sendTestEmailViaSheet,
  getAppsScriptTemplate,
  groupTicketsByParticipant,
  participantGroupToRow
};
