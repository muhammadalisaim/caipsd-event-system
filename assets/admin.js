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
  const maxDays = Number(ticket.max_days) || 2;
  if (ticket.entry_count >= maxDays) return pill('open', `Completed (${ticket.entry_count}/${maxDays})`);
  if (ticket.entry_count > 0) return pill('checked_in', `Day ${ticket.entry_count} Entered (${ticket.entry_count}/${maxDays})`);
  return pill('draft', `Not Entered (0/${maxDays})`);
}
function toast(message, type = 'success') {
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = message;
  $('#toast-region').appendChild(node);
  setTimeout(() => node.remove(), 5000);
}
// Static mode = no Node server behind this page (GitHub Pages or a file opened from disk).
// On a real server the page always talks to the server API, so it cannot be bypassed from the address bar.
const isStaticHost = Boolean(
  window.location.protocol === 'file:' ||
  window.location.hostname.endsWith('github.io')
);

const GOOGLE_WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbzodcplXRQvdPQlWLPeQbGOZdomvehyFGo4wG5K_9ugWSGuFKN-sRy6hfA6cq5AV-ds2Q/exec';

// The Apps Script text lives in google-apps-script.js (one copy, served next to this site).
async function loadAppsScriptCode() {
  const response = await fetch('google-apps-script.js', { cache: 'no-store' });
  if (!response.ok) throw new Error('Could not load google-apps-script.js');
  return response.text();
}

function getLocalTickets() {
  try {
    const raw = localStorage.getItem('caipsd_tickets');
    if (raw) {
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        const seenCodes = new Set();
        const seenPersonDays = new Set();
        const cleaned = [];
        for (const t of list) {
          if (!t || !t.ticket_code) continue;
          const code = String(t.ticket_code).toUpperCase();
          if (seenCodes.has(code)) continue;
          seenCodes.add(code);

          const baseName = String(t.full_name || '').replace(/\s*\((?:Day\s*\d+|Day\d+)\)$/i, '').trim().toLowerCase();
          const m = (t.full_name || '').match(/\(Day\s*(\d+)\)/i);
          const dayNum = m ? parseInt(m[1], 10) : 0;
          if (dayNum > 0 && baseName) {
            const personDayKey = `${baseName}::Day${dayNum}`;
            if (seenPersonDays.has(personDayKey)) continue;
            seenPersonDays.add(personDayKey);
          }
          cleaned.push(t);
        }
        if (cleaned.length !== list.length) {
          try {
            localStorage.setItem('caipsd_tickets', JSON.stringify(cleaned));
          } catch {}
        }
        return cleaned;
      }
    }
  } catch {}
  return [
    {
      id: 1,
      full_name: 'Muhammad Ali Saim (Day 1)',
      email: 'saimmalik4728@gmail.com',
      phone: '03287617476',
      ticket_code: '720F8E1D323E64A4',
      issued_at: '2026-11-09T14:18:21.829Z',
      valid_until: '2026-11-12T14:18:21.829Z',
      entry_count: 0,
      first_entry_at: null,
      last_entry_at: null,
      email_status: 'sent',
      status: 'valid'
    },
    {
      id: 2,
      full_name: 'Muhammad Ali Saim (Day 2)',
      email: 'saimmalik4728@gmail.com',
      phone: '03287617476',
      ticket_code: '99151C9C3B36D4FA',
      issued_at: '2026-11-09T14:18:21.829Z',
      valid_until: '2026-11-12T14:18:21.829Z',
      entry_count: 0,
      first_entry_at: null,
      last_entry_at: null,
      email_status: 'sent',
      status: 'valid'
    },
    {
      id: 3,
      full_name: 'Muhammad Ali Saim (Day 3)',
      email: 'saimmalik4728@gmail.com',
      phone: '03287617476',
      ticket_code: '637990B2FD9603D1',
      issued_at: '2026-11-09T14:18:21.829Z',
      valid_until: '2026-11-12T14:18:21.829Z',
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

function isSameCalendarDay(d1, d2) {
  if (!d1 || !d2) return false;
  const a = new Date(d1);
  const b = new Date(d2);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return false;
  const localMatch = a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const utcMatch = a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
  return localMatch || utcMatch;
}

function getLocalDateString(date = new Date(), timeZone = 'Asia/Karachi') {
  try {
    const d = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date;
    if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
    const y = parts.find((p) => p.type === 'year')?.value;
    const m = parts.find((p) => p.type === 'month')?.value;
    const day = parts.find((p) => p.type === 'day')?.value;
    if (y && m && day) return `${y}-${m}-${day}`;
  } catch {}
  try {
    const d = new Date(date);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function getGoogleWebAppUrl() {
  return localStorage.getItem('caipsd_sheets_webhook_url') || GOOGLE_WEB_APP_URL;
}

function formatGroupSheetRow(group) {
  const tickets = group.tickets;
  if (!tickets || tickets.length === 0) return [];
  if (tickets.length === 1) {
    const t = tickets[0];
    return [
      `'${t.ticket_code}`,
      group.baseName || t.full_name || '',
      t.issued_at || '',
      t.valid_until || '',
      t.status || 'valid',
      t.entry_count != null ? t.entry_count : 0,
      t.first_entry_at || '',
      t.last_entry_at || ''
    ];
  }

  const codeStr = tickets.map((t, idx) => {
    const m = (t.full_name || '').match(/\(Day\s*(\d+)\)/i);
    const dayLabel = m ? `Day ${m[1]}` : `Day ${idx + 1}`;
    return `${dayLabel}: ${t.ticket_code}`;
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
    const enteredDays = tickets.filter((t) => (Number(t.entry_count) || 0) >= 1).map((t, idx) => {
      const m = (t.full_name || '').match(/\(Day\s*(\d+)\)/i);
      return m ? `Day ${m[1]}` : `Day ${idx + 1}`;
    }).join(', ');
    statusStr = `${enteredDays} Entered`;
  }

  const firstEntries = tickets.map(t => t.first_entry_at).filter(Boolean);
  const lastEntries = tickets.map(t => t.last_entry_at).filter(Boolean);
  const firstEntry = firstEntries.length ? firstEntries.sort()[0] : '';
  const lastEntry = lastEntries.length ? lastEntries.sort().reverse()[0] : '';

  return [
    `'${codeStr}`,
    group.baseName,
    tickets[0].issued_at || '',
    tickets[0].valid_until || '',
    statusStr,
    entriesStr,
    firstEntry,
    lastEntry
  ];
}

function pushTicketToSheet(ticketOrTickets, type = 'appendTicket') {
  const url = getGoogleWebAppUrl();
  if (!ticketOrTickets || !url) return Promise.resolve({ status: 'skipped' });

  let tickets = Array.isArray(ticketOrTickets) ? ticketOrTickets : [ticketOrTickets];
  const list = getLocalTickets();
  const rawFirst = tickets[0];
  const rawName = String(rawFirst.full_name || '').replace(/\s*\((?:Day\s*\d+|Day\d+)\)$/i, '').trim();
  const issuedMin = rawFirst.issued_at ? String(rawFirst.issued_at).slice(0, 16) : '';

  if (tickets.length === 1 && list.length > 0) {
    const siblings = list.filter((x) => {
      const xBase = String(x.full_name || '').replace(/\s*\((?:Day\s*\d+|Day\d+)\)$/i, '').trim();
      const xMin = x.issued_at ? String(x.issued_at).slice(0, 16) : '';
      return xBase.toLowerCase() === rawName.toLowerCase() && (!issuedMin || !xMin || xMin === issuedMin);
    });
    const dayMap = new Map();
    for (const sib of siblings) {
      const m = (sib.full_name || '').match(/\(Day\s*(\d+)\)/i);
      const d = m ? parseInt(m[1], 10) : 0;
      if (!dayMap.has(d)) dayMap.set(d, sib);
    }
    const deduped = Array.from(dayMap.values());
    if (deduped.length > 0) {
      tickets = deduped;
    }
  }
  const groups = groupTicketsByParticipant(tickets);
  const group = groups[0] || { baseName: rawName, tickets };
  const row = formatGroupSheetRow(group);

  const payload = {
    action: type === 'append' ? 'appendTicket' : (type === 'update' ? 'updateTicket' : type),
    sheetName: 'CAIPSD_Tickets',
    fullName: group.baseName,
    ticketCode: rawFirst.ticket_code,
    ticket: rawFirst,
    row: row
  };
  return fetch(url, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload)
  }).then(async (res) => {
    try {
      const data = await res.json();
      return data;
    } catch {
      return { status: 'ok' };
    }
  }).catch(async () => {
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
        mode: 'no-cors'
      });
    } catch {}
    return { status: 'ok' };
  });
}

async function syncAllTicketsToSheet(tickets) {
  const url = getGoogleWebAppUrl();
  if (!url) return { status: 'skipped', message: 'No Google Web App URL configured' };
  const groups = groupTicketsByParticipant(tickets || []);
  const rows = groups.map(formatGroupSheetRow);
  const payload = {
    action: 'syncAll',
    sheetName: 'CAIPSD_Tickets',
    headers: ['Ticket ID', 'Full Name', 'Issued At', 'Valid Until', 'Status', 'Entries', 'First Entry', 'Last Entry'],
    rows: rows
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });
    return await res.json();
  } catch (err) {
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
        mode: 'no-cors'
      });
      return { status: 'ok', message: `Synced ${rows.length} participants to Google Sheet.` };
    } catch (e2) {
      console.warn('Sync to sheet failed:', e2);
      return { status: 'error', message: err.message };
    }
  }
}

async function pushTicketEmailToSheet(ticket) {
  const url = getGoogleWebAppUrl();
  if (!ticket || !url) return { status: 'skipped', message: 'No Google Web App URL configured' };
  const recipient = String(ticket.email || (ticket.ticket && ticket.ticket.email) || '').trim().toLowerCase();
  if (!recipient || !recipient.includes('@')) {
    throw new Error('Ticket participant does not have a valid email address.');
  }
  const ticketCode = String(ticket.ticket_code || ticket.ticketCode || '').trim();
  const fullName = String(ticket.full_name || ticket.fullName || 'Participant').trim();

  // Try GET request first - standard browser cross-origin friendly, no CORS preflight or POST redirect rewrite issues
  const getUrl = `${url}?action=sendTicketEmail&to=${encodeURIComponent(recipient)}&ticketCode=${encodeURIComponent(ticketCode)}&fullName=${encodeURIComponent(fullName)}&_t=${Date.now()}`;

  let result = null;
  let fetchError = null;

  try {
    const res = await fetch(getUrl, { cache: 'no-store' });
    const text = await res.text();
    try {
      result = JSON.parse(text);
    } catch {
      if (text.includes('Ticket email delivered') || text.includes('"status":"ok"')) {
        result = { status: 'ok', message: `Ticket emailed to ${recipient}` };
      }
    }
  } catch (err) {
    fetchError = err;
  }

  if (result && result.status === 'ok') {
    return result;
  }

  // Fallback to POST
  const payload = {
    action: 'sendTicketEmail',
    sheetName: 'CAIPSD_Tickets',
    to: recipient,
    ticketCode: ticketCode,
    fullName: fullName,
    ticket: {
      ...ticket,
      email: recipient,
      ticket_code: ticketCode,
      full_name: fullName
    }
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });
    const text = await res.text();
    try {
      result = JSON.parse(text);
    } catch {
      if (text.includes('Ticket email delivered') || text.includes('"status":"ok"')) {
        result = { status: 'ok', message: `Ticket emailed to ${recipient}` };
      }
    }
  } catch (err) {
    fetchError = err;
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
        mode: 'no-cors'
      });
      result = { status: 'ok', message: `Ticket email dispatched to ${recipient}` };
    } catch (e2) {
      throw new Error(`Could not deliver email: ${fetchError?.message || e2.message}`);
    }
  }

  if (result && result.status === 'error') {
    throw new Error(result.message || 'Google Mail Error');
  }
  return result || { status: 'ok', message: `Ticket emailed to ${recipient}` };
}

async function pushTestEmailToSheet(to) {
  const url = getGoogleWebAppUrl();
  if (!url) return;
  const recipient = String(to || '').trim().toLowerCase();
  const getUrl = `${url}?action=sendTestEmail&to=${encodeURIComponent(recipient)}&_t=${Date.now()}`;
  let result = null;
  let fetchError = null;

  try {
    const res = await fetch(getUrl, { cache: 'no-store' });
    const text = await res.text();
    try {
      result = JSON.parse(text);
    } catch {
      if (text.includes('"status":"ok"') || text.includes('Test email delivered')) {
        result = { status: 'ok', message: `Test email sent to ${recipient}` };
      }
    }
  } catch (err) {
    fetchError = err;
  }

  if (result && result.status === 'ok') {
    return result;
  }

  const payload = {
    action: 'sendTestEmail',
    to: recipient
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });
    const text = await res.text();
    try {
      result = JSON.parse(text);
    } catch {
      if (text.includes('"status":"ok"')) result = { status: 'ok', message: `Test email sent to ${recipient}` };
    }
  } catch (err) {
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
        mode: 'no-cors'
      });
      result = { status: 'ok', message: `Test email dispatched to ${recipient}` };
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
      function parseRowItem(c, i) {
        const getV = (col) => {
          if (!col) return '';
          if (typeof col === 'object') return String(col.v !== undefined ? col.v : (col.f !== undefined ? col.f : '')).trim();
          return String(col).trim();
        };
        const rawCode = getV(c[0]).replace(/^'/, '').trim();
        const rawName = getV(c[1]) || 'Participant';
        if (!rawCode || rawCode.length < 8 || rawCode.toLowerCase().includes('ticket id') || rawName.toLowerCase().includes('full name')) return [];

        const baseName = rawName.replace(/\s*\((?:Day\s*\d+|Day\d+)\)$/i, '').trim() || 'Participant';
        const val2 = getV(c[2]);
        const is11 = val2.includes('@') || (c.length > 9 && !val2.includes('-') && !val2.includes('T'));
        const email = is11 ? val2 : '';
        const phone = is11 ? getV(c[3]) : '';
        const issued = (is11 ? getV(c[4]) : val2) || new Date().toISOString();
        const valid = (is11 ? getV(c[5]) : getV(c[3])) || new Date(Date.now() + 3 * 86400000).toISOString();
        const status = (is11 ? getV(c[6]) : getV(c[4])) || 'valid';
        const entryCount = Number((is11 ? getV(c[7]) : getV(c[5])) || 0);
        const firstEntry = (is11 ? getV(c[8]) : getV(c[6])) || null;
        const lastEntry = (is11 ? getV(c[9]) : getV(c[7])) || null;

        const dayMatches = Array.from(rawCode.matchAll(/Day\s*(\d+)\s*:\s*([A-Za-z0-9]{8,32})/gi));
        if (dayMatches.length > 0) {
          const seenDays = new Map();
          for (const m of dayMatches) {
            const d = parseInt(m[1], 10);
            if (!seenDays.has(d)) {
              seenDays.set(d, m[2].toUpperCase());
            }
          }
          return Array.from(seenDays.entries()).map(([dayNum, code], dIdx) => ({
            id: Date.now() + i * 100 + dIdx,
            ticket_code: code,
            full_name: `${baseName} (Day ${dayNum})`,
            email,
            phone,
            issued_at: issued,
            valid_until: valid,
            status: status === 'cancelled' ? 'cancelled' : 'valid',
            entry_count: entryCount > 0 ? 1 : 0,
            first_entry_at: firstEntry,
            last_entry_at: lastEntry,
            email_status: 'not_sent',
            max_days: 1
          }));
        }

        return [{
          id: Date.now() + i,
          ticket_code: rawCode.toUpperCase(),
          full_name: rawName,
          email,
          phone,
          issued_at: issued,
          valid_until: valid,
          status,
          entry_count: entryCount,
          first_entry_at: firstEntry,
          last_entry_at: lastEntry,
          email_status: 'not_sent',
          max_days: 1
        }];
      }

      if (url.includes('gviz/tq')) {
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start !== -1 && end > start) {
          const json = JSON.parse(text.slice(start, end + 1));
          if (json.table && Array.isArray(json.table.rows)) {
            imported = json.table.rows.flatMap((r, i) => parseRowItem(r.c || [], i) || []);
          }
        }
      } else {
        const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
        if (lines.length > 1) {
          for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(',').map((x) => x.replace(/^["']|["']$/g, '').trim());
            const parsed = parseRowItem(cols, i);
            if (parsed && parsed.length) imported.push(...parsed);
          }
        }
      }

      if (imported.length > 0) {
        const map = new Map();
        const importedPersons = new Set();
        imported.forEach((t) => {
          map.set(t.ticket_code.toUpperCase(), t);
          const base = String(t.full_name || '').replace(/\s*\((?:Day\s*\d+|Day\d+)\)$/i, '').trim().toLowerCase();
          if (base) importedPersons.add(base);
        });
        const list = getLocalTickets();
        list.forEach((t) => {
          const k = t.ticket_code.toUpperCase();
          const base = String(t.full_name || '').replace(/\s*\((?:Day\s*\d+|Day\d+)\)$/i, '').trim().toLowerCase();
          if (!map.has(k) && !importedPersons.has(base)) {
            map.set(k, t);
          }
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
    const rawFullName = String(body.fullName || 'Participant').trim();
    const baseName = rawFullName.replace(/\s*\((?:Day\s*\d+|Day\d+)\)$/i, '').trim();
    const cleanEmail = String(body.email || '').trim().toLowerCase();
    const cleanPhone = String(body.phone || '').trim();
    const days = Math.max(1, Math.min(30, Number(body.days || body.validDays || appConfig.validDays || 2)));
    const now = new Date();
    const rawStartDate = String(body.startDate || body.eventDate || '').trim();
    let eventStart;
    if (rawStartDate && /^\d{4}-\d{2}-\d{2}$/.test(rawStartDate)) {
      eventStart = new Date(rawStartDate + 'T00:00:00');
    } else {
      eventStart = new Date(getLocalDateString(now) + 'T00:00:00');
    }
    const endDayMs = eventStart.getTime() + (days - 1) * 86400000;
    const validUntil = new Date(Math.max(now.getTime() + 86400000, endDayMs + 86400000 + 23 * 3600000 + 59 * 60000));
    const shouldSend = body.sendEmail !== false && body.sendEmail !== 'false' && Boolean(cleanEmail);

    const createdTickets = [];
    for (let day = 1; day <= days; day++) {
      const dayDateObj = new Date(eventStart.getTime() + (day - 1) * 86400000);
      const dayDateStr = getLocalDateString(dayDateObj);
      const hex = Array.from(crypto.getRandomValues(new Uint8Array(8))).map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
      const t = {
        id: Date.now() + day,
        full_name: `${baseName} (Day ${day})`,
        email: cleanEmail,
        phone: cleanPhone,
        ticket_code: hex,
        issued_at: now.toISOString(),
        valid_until: validUntil.toISOString(),
        event_date: dayDateStr,
        entry_count: 0,
        first_entry_at: null,
        last_entry_at: null,
        email_status: 'not_sent',
        max_days: 1,
        status: 'valid'
      };
      createdTickets.push(t);
    }

    let emailResult = { status: 'not_sent' };
    if (shouldSend) {
      try {
        for (const t of createdTickets) {
          await pushTicketEmailToSheet(t);
          t.email_status = 'sent';
        }
        emailResult = { status: 'sent' };
      } catch (err) {
        console.error('Failed to email new ticket:', err);
        emailResult = { status: 'failed', error: err.message };
      }
    }

    for (let i = createdTickets.length - 1; i >= 0; i--) {
      list.unshift(createdTickets[i]);
    }
    saveLocalTickets(list);
    pushTicketToSheet(createdTickets, 'appendTicket');

    return {
      message: `${days} ticket${days === 1 ? '' : 's'} generated for ${baseName} (${days} daily pass${days === 1 ? '' : 'es'}).`,
      ticket: createdTickets[0],
      ticket2: createdTickets[1] || undefined,
      tickets: createdTickets,
      email: emailResult
    };
  }

  if (url === '/api/admin/tickets/bulk' && method === 'POST') {
    const rawNames = Array.isArray(body.names)
      ? body.names
      : String(body.names || '').split(/\r?\n/);
    const days = Math.max(1, Math.min(30, Number(body.days || body.validDays || appConfig.validDays || 2)));
    const names = rawNames.map((n) => String(n || '').trim()).filter((n) => n.length >= 2);
    if (!names.length) {
      const err = new Error('Please enter at least one participant name.');
      err.status = 400;
      throw err;
    }
    const list = getLocalTickets();
    const now = new Date();
    const rawStartDate = String(body.startDate || body.eventDate || '').trim();
    let eventStart;
    if (rawStartDate && /^\d{4}-\d{2}-\d{2}$/.test(rawStartDate)) {
      eventStart = new Date(rawStartDate + 'T00:00:00');
    } else {
      eventStart = new Date(getLocalDateString(now) + 'T00:00:00');
    }
    const endDayMs = eventStart.getTime() + (days - 1) * 86400000;
    const validUntil = new Date(Math.max(now.getTime() + 86400000, endDayMs + 86400000 + 23 * 3600000 + 59 * 60000));
    const createdTickets = [];
    for (const name of names) {
      const baseName = name.replace(/\s*\((?:Day\s*\d+|Day\d+)\)$/i, '').trim();
      for (let day = 1; day <= days; day++) {
        const dayDateObj = new Date(eventStart.getTime() + (day - 1) * 86400000);
        const dayDateStr = getLocalDateString(dayDateObj);
        const hex = Array.from(crypto.getRandomValues(new Uint8Array(8)))
          .map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
        const newTicket = {
          id: Date.now() + Math.floor(Math.random() * 10000000),
          full_name: `${baseName} (Day ${day})`,
          email: '',
          phone: '',
          ticket_code: hex,
          issued_at: now.toISOString(),
          valid_until: validUntil.toISOString(),
          event_date: dayDateStr,
          entry_count: 0,
          first_entry_at: null,
          last_entry_at: null,
          email_status: 'not_sent',
          max_days: 1,
          status: 'valid'
        };
        createdTickets.push(newTicket);
        list.unshift(newTicket);
      }
    }
    saveLocalTickets(list);
    // Push all tickets in one clean batch to Google Sheet
    syncAllTicketsToSheet(list).catch(() => {});
    return {
      message: `Successfully issued ${createdTickets.length} tickets (${names.length} participants × ${days} passes).`,
      count: createdTickets.length,
      participantCount: names.length,
      days,
      tickets: createdTickets
    };
  }

  if (url === '/api/admin/sheets/push' && method === 'POST') {
    const list = getLocalTickets();
    const result = await syncAllTicketsToSheet(list);
    return {
      message: `Successfully pushed ${list.length} tickets to Google Sheet.`,
      count: list.length,
      result
    };
  }

  if (url === '/api/admin/settings/duration') {
    if (method === 'POST') {
      const days = Math.max(1, Math.min(30, Number(body.validDays || body.days || 2)));
      localStorage.setItem('caipsd_ticket_days', String(days));
      return { validDays: days, message: `Default event duration set to ${days} day${days === 1 ? '' : 's'}.` };
    }
    return { validDays: Number(localStorage.getItem('caipsd_ticket_days')) || 2 };
  }

  if ((url === '/api/admin/check-in' || url === '/api/check-in') && method === 'POST') {
    const code = extractTicketCode(body.ticketCode);
    if (!code) {
      const err = new Error('Enter a valid ticket code or scan a CAIPSD ticket QR.');
      err.status = 400;
      throw err;
    }
    let list = getLocalTickets();
    let t = list.find((x) => x.ticket_code && x.ticket_code.toUpperCase() === code);

    // Sync latest status from Google Sheet before checkin to guarantee cross-device consistency
    try {
      const synced = await syncTicketsFromGoogleSheet();
      if (synced && synced.length) {
        list = synced;
        const fresh = list.find((x) => x.ticket_code && x.ticket_code.toUpperCase() === code);
        if (fresh) t = fresh;
      }
    } catch {}

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

    const maxDays = Number(t.max_days) || 1;
    if ((t.entry_count || 0) >= maxDays) {
      const err = new Error('Already used ticket! Yeh ticket pehle hi use ho chuka hai (Entry Denied).');
      err.status = 409;
      err.data = { ticket: t, limitReached: true, alreadyUsed: true, maxDays };
      throw err;
    }

    // Day N restriction: Day N ticket can only be used on Day N!
    const dayMatch = (t.full_name || '').match(/\(Day\s*(\d+)\)/i);
    const passDay = dayMatch ? parseInt(dayMatch[1], 10) : 1;
    let currentEventDay = 1;
    if (body.activeDay && body.activeDay !== 'auto') {
      currentEventDay = Math.max(1, parseInt(body.activeDay, 10) || 1);
    } else {
      const todayStr = getLocalDateString(now);
      let day1Date = null;
      if (t.event_date && /^\d{4}-\d{2}-\d{2}$/.test(t.event_date)) {
        try {
          const passDate = new Date(t.event_date + 'T00:00:00');
          const d1Obj = new Date(passDate.getTime() - (passDay - 1) * 86400000);
          day1Date = getLocalDateString(d1Obj);
        } catch {}
      }
      if (!day1Date) {
        const issuedStr = getLocalDateString(new Date(t.issued_at));
        let earliestEntryDate = null;
        for (const item of list) {
          if (item.first_entry_at) {
            const ed = getLocalDateString(new Date(item.first_entry_at));
            if (!earliestEntryDate || ed < earliestEntryDate) earliestEntryDate = ed;
          }
        }
        day1Date = earliestEntryDate || issuedStr;
      }
      try {
        const d1 = new Date(day1Date + 'T00:00:00');
        const dt = new Date(todayStr + 'T00:00:00');
        const diffDays = Math.floor((dt - d1) / (24 * 60 * 60 * 1000));
        currentEventDay = Math.max(1, diffDays + 1);
      } catch {}
    }

    if (currentEventDay < passDay) {
      const err = new Error(`Day ${passDay} Ticket! Yeh ticket sirf Day ${passDay} par use ho sakta hai (Entry Denied).`);
      err.status = 409;
      err.data = { ticket: t, day2Early: passDay === 2, dayEarly: true, passDay, currentEventDay, alreadyUsed: false, maxDays };
      throw err;
    }

    if (dayMatch && passDay < currentEventDay) {
      const err = new Error(`Day ${passDay} Ticket! Yeh ticket Day ${passDay} ke liye tha (Entry Denied).`);
      err.status = 409;
      err.data = { ticket: t, dayExpired: true, passDay, currentEventDay, alreadyUsed: (t.entry_count || 0) > 0, maxDays };
      throw err;
    }

    // 1-scan-per-calendar-day enforcement: check both local timezone and UTC date
    const alreadyUsedToday = (Number(t.entry_count || 0) > 0) && (
      isSameCalendarDay(t.last_entry_at, now) ||
      isSameCalendarDay(t.first_entry_at, now) ||
      (Array.isArray(t.entry_dates) && t.entry_dates.some((ed) => isSameCalendarDay(ed, now)))
    );

    if (alreadyUsedToday) {
      const err = new Error('Already used ticket! Yeh ticket aaj pehle hi use ho chuka hai (Entry Denied).');
      err.status = 409;
      err.data = { ticket: t, alreadyUsed: true, alreadyScannedToday: true, maxDays };
      throw err;
    }

    const todayStr = now.toISOString().slice(0, 10);
    t.entry_count = (t.entry_count || 0) + 1;
    t.first_entry_at = t.first_entry_at || now.toISOString();
    t.last_entry_at = now.toISOString();
    if (!Array.isArray(t.entry_dates)) {
      t.entry_dates = [];
    }
    if (!t.entry_dates.includes(todayStr)) {
      t.entry_dates.push(todayStr);
    }
    t.status = 'checked_in';
    saveLocalTickets(list);

    try {
      const sheetRes = await pushTicketToSheet(t, 'updateTicket');
      if (sheetRes && (sheetRes.status === 'already_used' || sheetRes.alreadyUsed)) {
        t.entry_count = Math.max(0, t.entry_count - 1);
        saveLocalTickets(list);
        const err = new Error(sheetRes.message || 'Already used ticket! 1 din mein sirf 1 bar entry allowed hai. Next day dobara scan ho sakega.');
        err.status = 409;
        err.data = { ticket: t, alreadyUsed: true, alreadyScannedToday: true, maxDays };
        throw err;
      }
    } catch (sheetErr) {
      if (sheetErr && sheetErr.status === 409) throw sheetErr;
      console.warn('Sheet push non-critical warning:', sheetErr);
    }

    const dayNumber = t.entry_count;
    const dayTag = dayMatch ? `Day ${passDay}` : 'Pass';
    const message = `Entry allowed! Welcome (${dayTag} check-in successful).`;

    return {
      message,
      dayNumber,
      maxDays,
      repeat: false,
      ticket: t
    };
  }

  if (url.startsWith('/api/admin/tickets/') && url.endsWith('/send') && method === 'POST') {
    const rawId = url.split('/')[4];
    const numId = parseInt(rawId, 10);
    const list = getLocalTickets();
    const t = list.find((x) => x.id === numId || String(x.id) === rawId || x.ticket_code === rawId || (x.ticket_code && x.ticket_code.toUpperCase() === rawId.toUpperCase()));
    if (!t) throw new Error('Ticket not found.');
    if (!t.email) throw new Error('Ticket does not have an email address.');
    await pushTicketEmailToSheet(t);
    t.email_status = 'sent';
    t.email_error = null;
    saveLocalTickets(list);
    pushTicketToSheet(t, 'updateTicket');
    return { message: `Ticket emailed to ${t.email}.`, ticket: t };
  }

  if (url === '/api/admin/tickets/email-all' && method === 'POST') {
    const list = getLocalTickets();
    const mode = body.mode || 'pending';
    const targets = list.filter((t) => {
      const em = String(t.email || '').trim().toLowerCase();
      if (!em || !em.includes('@')) return false;
      if (mode === 'pending') return t.email_status !== 'sent';
      return true;
    });

    if (targets.length === 0) {
      return {
        total: 0,
        sent: 0,
        failed: 0,
        message: mode === 'all' ? 'No tickets with email addresses found.' : 'All students have already received their tickets!'
      };
    }

    let sent = 0;
    let failed = 0;
    let lastErr = null;
    for (const t of targets) {
      try {
        await pushTicketEmailToSheet(t);
        t.email_status = 'sent';
        t.email_error = null;
        pushTicketToSheet(t, 'updateTicket');
        sent++;
      } catch (err) {
        console.error('Failed to email ticket in bulk:', t.email, err);
        t.email_status = 'failed';
        t.email_error = err.message;
        failed++;
        lastErr = err;
      }
      if (targets.length > 1) {
        await new Promise((resolve) => setTimeout(resolve, 400));
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
      message: `Completed: ${sent} ticket${sent === 1 ? '' : 's'} emailed successfully!${failed ? ` (${failed} failed)` : ''}`
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
    return { template: await loadAppsScriptCode() };
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

let currentAdminEmail = null;

function setFrontTab(tabName) {
  const isCheckin = tabName === 'checkin';
  $('#tab-checkin-btn')?.classList.toggle('active', isCheckin);
  $('#tab-login-btn')?.classList.toggle('active', !isCheckin);
  document.querySelectorAll('[data-scroll-tab]').forEach((link) => {
    const linkTab = link.getAttribute('data-scroll-tab');
    if (linkTab) {
      link.classList.toggle('active', linkTab === tabName);
    }
  });
  if ($('#front-checkin-panel')) $('#front-checkin-panel').style.display = isCheckin ? 'flex' : 'none';
  if ($('#front-login-panel')) $('#front-login-panel').style.display = isCheckin ? 'none' : 'flex';
  if (!isCheckin) {
    stopScanner();
    setTimeout(() => {
      const pwd = $('#login-password') || $('#login-form input[name="password"]');
      if (pwd) pwd.focus();
    }, 120);
  } else {
    $('#ticket-code-input')?.focus();
  }
}

function showLogin() {
  currentAdminEmail = null;
  $('#admin-app').hidden = true;
  $('#login-screen').hidden = false;
  if ($('#admin-session-banner')) $('#admin-session-banner').style.display = 'none';
  if ($('#header-login-btn')) $('#header-login-btn').style.display = 'none';
  $('#login-error').textContent = '';
  $('#login-form').reset();
  const initTab = location.hash === '#login' ? 'login' : 'checkin';
  setFrontTab(initTab);
}

window.addEventListener('hashchange', () => {
  if (location.hash === '#login') setFrontTab('login');
  else if (location.hash === '#checkin') setFrontTab('checkin');
});

function showApp(email) {
  currentAdminEmail = email;
  stopScanner();
  $('#login-screen').hidden = true;
  $('#admin-app').hidden = false;
  $('#admin-email').textContent = email || 'Organizer';
  $('#admin-avatar').textContent = (email || 'A').charAt(0).toUpperCase();
  if ($('#session-banner-email')) $('#session-banner-email').textContent = email || 'Organizer';
  if ($('#header-login-btn')) {
    $('#header-login-btn').style.display = 'inline-flex';
    $('#header-login-btn').innerHTML = '<span>⚡ Workspace →</span>';
  }
  loadConfig().then(loadDashboard);
}

function openGateCheckin() {
  $('#admin-app').hidden = true;
  $('#login-screen').hidden = false;
  if (currentAdminEmail && $('#admin-session-banner')) {
    $('#admin-session-banner').style.display = 'flex';
  }
  if (currentAdminEmail && $('#header-login-btn')) {
    $('#header-login-btn').style.display = 'inline-flex';
  }
  setFrontTab('checkin');
  document.getElementById('portal-section')?.scrollIntoView({ behavior: 'smooth' });
}

$('#tab-checkin-btn')?.addEventListener('click', () => setFrontTab('checkin'));
$('#tab-login-btn')?.addEventListener('click', () => setFrontTab('login'));
$('#return-admin-btn')?.addEventListener('click', () => {
  stopScanner();
  $('#login-screen').hidden = true;
  $('#admin-app').hidden = false;
});
$('#topbar-gate-btn')?.addEventListener('click', openGateCheckin);
$('#sidebar-gate-btn')?.addEventListener('click', openGateCheckin);
$('#quick-open-gate')?.addEventListener('click', openGateCheckin);
$('#sidebar-duration-btn')?.addEventListener('click', openDurationModal);
$('#quick-duration-action')?.addEventListener('click', openDurationModal);

// Header Login button:
$('#header-login-btn')?.addEventListener('click', () => {
  if (currentAdminEmail) {
    stopScanner();
    $('#login-screen').hidden = true;
    $('#admin-app').hidden = false;
  } else {
    setFrontTab('login');
    document.getElementById('portal-section')?.scrollIntoView({ behavior: 'smooth' });
    setTimeout(() => {
      const pwd = $('#login-form input[name="password"]');
      if (pwd) pwd.focus();
    }, 400);
  }
});

// Mobile menu toggle
$('#mobile-nav-toggle')?.addEventListener('click', () => {
  const menu = $('#mobile-nav-menu');
  if (menu) menu.hidden = !menu.hidden;
});

// Nav links with scroll tab
document.querySelectorAll('[data-scroll-tab]').forEach((el) => {
  el.addEventListener('click', (e) => {
    e.preventDefault();
    const tab = el.getAttribute('data-scroll-tab');
    if (tab) setFrontTab(tab);
    $('#mobile-nav-menu')?.setAttribute('hidden', '');
    document.getElementById('portal-section')?.scrollIntoView({ behavior: 'smooth' });
  });
});

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
  if (viewName === 'attendance') {
    openGateCheckin();
    return;
  }
  if (!['overview', 'tickets', 'sheets'].includes(viewName)) return;
  $$('.view-section').forEach((section) => section.classList.toggle('active', section.id === `view-${viewName}`));
  $$('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.view === viewName));
  $('#breadcrumb-current').textContent = ({ overview: 'Overview', tickets: 'Tickets' })[viewName] || 'Overview';
  $('#sidebar').classList.remove('open');
  if (viewName === 'overview') loadDashboard();
  if (viewName === 'tickets') loadTickets();
}
$$('.nav-item').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
$$('[data-view-link]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.viewLink)));
$('#mobile-menu').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
$$('[data-action="new-ticket"]').forEach((button) => button.addEventListener('click', openTicketModal));
$('#admin-year').textContent = new Date().getFullYear();

async function loadConfig() {
  try { appConfig = await api('/api/admin/config'); } catch (error) { console.error(error); }
  const days = Number(appConfig.validDays) || 2;
  if ($('#valid-days')) $('#valid-days').textContent = days;
  if ($('#topbar-days-label')) $('#topbar-days-label').textContent = `${days} Day${days === 1 ? '' : 's'}`;
  if ($('#setting-duration-select')) $('#setting-duration-select').value = String(days);
  if ($('#ticket-days-select')) $('#ticket-days-select').value = String(days);
  if ($('#bulk-days-select')) $('#bulk-days-select').value = String(days);
  document.querySelectorAll('.dyn-policy-days').forEach((el) => {
    el.textContent = `${days} Day${days === 1 ? '' : 's'}`;
  });
  const configured = Boolean(appConfig.mail && appConfig.mail.configured);
  if ($('#send-email-checkbox')) {
    $('#send-email-checkbox').checked = configured;
    $('#send-email-checkbox').disabled = !configured;
  }
  if ($('#send-email-label')) {
    $('#send-email-label').textContent = configured
      ? 'Email the ticket to the participant automatically'
      : 'Email is not set up yet - connect Google Mail to send tickets automatically';
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
            <p style="margin:0 0 5px;"><span class="ok">● Connected.</span> Sender: <strong>${escapeHtml(appConfig.mail.from || appConfig.mail.user || 'Your Google account (via the attached Google Script)')}</strong></p>
            <p style="margin:0; font-size:12px; color:#64748b;">New tickets are emailed automatically with their QR pass. Use <em>Email all students (1-Click)</em> or <em>Send email</em> on a ticket to resend.</p>
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
    recentTicketsGroups = [];
    const container = $('#recent-tickets');
    container.innerHTML = ticketsTable(list.tickets.slice(0, 6), false, recentTicketsGroups);
    bindTicketsTableEvents(container, recentTicketsGroups);
  } catch (error) { console.error('Dashboard load failed:', error); }
}
function renderStats(s) {
  if ($('#stat-total')) $('#stat-total').textContent = s.total ?? '0';
  if ($('#stat-day1')) $('#stat-day1').textContent = s.day1Entered ?? '0';
  if ($('#stat-day2')) $('#stat-day2').textContent = s.day2Entered ?? '0';
  if ($('#stat-awaiting')) $('#stat-awaiting').textContent = s.awaiting ?? '0';
  if ($('#stat-expired-note')) $('#stat-expired-note').textContent = s.expired ? `${s.expired} ticket${s.expired === 1 ? '' : 's'} expired` : 'Awaiting check-in';
}
async function refreshStats() {
  try { renderStats(await api('/api/admin/summary')); } catch (error) { console.error(error); }
}

let currentTicketsGroups = [];
let recentTicketsGroups = [];
let currentGroupedMap = new Map();
let activeGroupForPrint = null;

function groupTicketsByParticipant(tickets) {
  const groups = new Map();
  for (const t of tickets) {
    if (!t) continue;
    const rawName = String(t.full_name || 'Participant').trim();
    if (rawName.toLowerCase() === 'full name' || rawName.toLowerCase() === 'ticket id' || String(t.ticket_code).toUpperCase() === 'TICKET ID') {
      continue;
    }
    const baseName = rawName.replace(/\s*\((?:Day\s*\d+|Day\d+)\)$/i, '').trim();
    const issuedMinute = t.issued_at ? String(t.issued_at).slice(0, 16) : '';
    const key = `${baseName.toLowerCase()}::${issuedMinute}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        baseName,
        email: t.email || '',
        phone: t.phone || '',
        validUntil: t.valid_until,
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
      if (!grp.validUntil || (t.valid_until && new Date(t.valid_until) > new Date(grp.validUntil))) {
        grp.validUntil = t.valid_until;
      }
      if (!grp.eventDate && t.event_date) grp.eventDate = t.event_date;
      grp.tickets.push(t);
    }
  }

  // Sort each group's tickets: Day 1 first, then Day 2, Day 3, etc.
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

  currentGroupedMap = groups;
  return Array.from(groups.values());
}

function formatEventDateShort(startDateStr, days = 1) {
  if (!startDateStr || !/^\d{4}-\d{2}-\d{2}$/.test(startDateStr)) return '';
  const [y, m, d] = startDateStr.split('-').map(Number);
  const start = new Date(y, m - 1, d);
  const fmtShort = (dt) => dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const fmtFull = (dt) => dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  if (days <= 1) return fmtFull(start);
  const end = new Date(y, m - 1, d + days - 1);
  return `${fmtShort(start)} – ${fmtFull(end)}`;
}

function participantCell(group) {
  const initials = group.baseName.trim().split(/\s+/).slice(0, 2).map((word) => word[0] || '').join('').toUpperCase();
  const sub = group.email ? escapeHtml(group.email) : (group.phone ? escapeHtml(group.phone) : 'Direct Ticket');
  const countBadge = group.tickets.length > 1 ? `<span class="pass-count-badge">${group.tickets.length} Passes</span>` : '';
  return `<div class="participant-cell"><span class="participant-avatar">${escapeHtml(initials)}</span><span><strong>${escapeHtml(group.baseName)}${countBadge}</strong><small>${sub}</small></span></div>`;
}

function groupedPill(group) {
  const allExpired = group.tickets.every((t) => t.status === 'expired' || new Date(t.valid_until).getTime() <= Date.now());
  if (allExpired) return pill('closed', 'Expired');
  const totalEntries = group.tickets.reduce((sum, t) => sum + (Number(t.entry_count) || 0), 0);
  const totalMax = group.tickets.reduce((sum, t) => sum + (Number(t.max_days) || 1), 0);
  if (totalEntries >= totalMax) return pill('open', `Completed (${totalEntries}/${totalMax})`);
  if (totalEntries > 0) return pill('checked_in', `Day ${totalEntries} Entered (${totalEntries}/${totalMax})`);
  return pill('draft', `Not Entered (0/${totalMax})`);
}

function ticketsTable(rows, withActions, groupStorage = null) {
  if (!rows || !rows.length) return '<div class="empty-table">No tickets found. Use “Issue ticket” or “Bulk issue” to create tickets.</div>';
  const groups = (rows[0] && Array.isArray(rows[0].tickets)) ? rows : groupTicketsByParticipant(rows);
  if (groupStorage && Array.isArray(groupStorage)) {
    groupStorage.length = 0;
    groupStorage.push(...groups);
  }
  const head = `<tr><th>PARTICIPANT</th><th>PHONE / INFO</th><th>TICKET ID</th><th>WORKSHOP DATE / VALIDITY</th><th>ATTENDANCE</th>${withActions ? '<th>ACTION</th>' : ''}</tr>`;
  const body = groups.map((g, idx) => {
    let codeHtml;
    if (g.tickets.length > 1) {
      codeHtml = `<div class="grouped-codes">` + g.tickets.map((t, i) => {
        const m = (t.full_name || '').match(/\(Day\s*(\d+)\)/i);
        const label = m ? `Day ${m[1]}` : `Pass ${i + 1}`;
        return `<span>${label}: <code>${escapeHtml(t.ticket_code)}</code></span>`;
      }).join('') + `</div>`;
    } else {
      codeHtml = `<strong>${escapeHtml(g.tickets[0].ticket_code)}</strong>`;
    }
    const firstCode = (g.tickets && g.tickets[0]) ? g.tickets[0].ticket_code : '';
    const eventDateStr = (g.tickets && g.tickets[0] && g.tickets[0].event_date) || g.eventDate;
    const dateCellHtml = eventDateStr
      ? `<strong>${escapeHtml(formatEventDateShort(eventDateStr, g.tickets.length))}</strong><small style="display:block;color:var(--text-muted, #777);font-size:11px;">Expires: ${escapeHtml(dateTimeLabel(g.validUntil))}</small>`
      : `<span>${escapeHtml(dateTimeLabel(g.validUntil))}</span>`;
    const actionsHtml = withActions ? `<td><div class="row-actions"><a class="status-action open-ticket-page" href="ticket.html?code=${encodeURIComponent(firstCode)}" target="_blank" rel="noopener">View / Print</a><button type="button" class="status-action danger cancel-group" data-index="${idx}" data-key="${escapeHtml(g.key)}" data-name="${escapeHtml(g.baseName)}">Cancel</button></div></td>` : '';
    return `<tr class="participant-row" data-index="${idx}" data-key="${escapeHtml(g.key)}" style="cursor:pointer;" title="Click to view passes"><td>${participantCell(g)}</td><td>${escapeHtml(g.phone || '—')}</td><td>${codeHtml}</td><td>${dateCellHtml}</td><td>${groupedPill(g)}</td>${actionsHtml}</tr>`;
  }).join('');
  return `<table class="data-table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function bindTicketsTableEvents(container, groups) {
  if (!container || !groups) return;
  container.querySelectorAll('.open-ticket-page').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.stopPropagation();
    });
  });

  container.querySelectorAll('.participant-row').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('button, a')) return;
      const idx = Number(row.dataset.index);
      const group = groups[idx] || (currentGroupedMap ? currentGroupedMap.get(row.dataset.key) : null);
      if (group && group.tickets && group.tickets[0]) {
        window.open(`ticket.html?code=${encodeURIComponent(group.tickets[0].ticket_code)}`, '_blank');
      }
    });
  });

  container.querySelectorAll('.cancel-group').forEach((button) => {
    button.addEventListener('click', async (e) => {
      e.stopPropagation();
      const idx = Number(button.dataset.index);
      const group = groups[idx] || (currentGroupedMap ? currentGroupedMap.get(button.dataset.key) : null);
      if (!group) return;
      const count = group.tickets.length;
      if (!confirm(`Cancel ${count} ticket${count === 1 ? '' : 's'} for ${group.baseName}? QR code${count === 1 ? '' : 's'} will stop working.`)) return;
      button.disabled = true;
      try {
        for (const t of group.tickets) {
          await api(`/api/admin/tickets/${t.id}`, { method: 'DELETE' });
        }
        toast(`Tickets cancelled for ${group.baseName}.`);
        await loadTickets();
        refreshStats();
      } catch (error) {
        toast(error.message, 'error');
        button.disabled = false;
      }
    });
  });
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
    currentTicketsGroups = [];
    const container = $('#tickets-table');
    container.innerHTML = ticketsTable(data.tickets, true, currentTicketsGroups);
    bindTicketsTableEvents(container, currentTicketsGroups);
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

function updateDatePreview(dateInput, daysSelect, previewEl) {
  if (!previewEl) return;
  const startVal = dateInput ? dateInput.value : '';
  const days = Math.max(1, parseInt(daysSelect?.value, 10) || 1);
  if (!startVal) {
    previewEl.innerHTML = '<span style="opacity:0.8;">📅 Select a workshop start date above</span>';
    return;
  }
  const [y, m, d] = startVal.split('-').map(Number);
  const startDate = new Date(y, m - 1, d);
  const endDate = new Date(y, m - 1, d + days - 1);
  const fmt = (date) => date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const fmtShort = (date) => date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  if (days === 1) {
    previewEl.innerHTML = `<span>📅 <strong>${fmt(startDate)}</strong> (1-Day Workshop Pass)</span>`;
  } else {
    const dayBreakdown = Array.from({ length: days }, (_, i) => {
      const dayDate = new Date(y, m - 1, d + i);
      return `Day ${i + 1}: ${fmtShort(dayDate)}`;
    }).join(' · ');
    previewEl.innerHTML = `<div>📅 <strong>${fmtShort(startDate)} – ${fmt(endDate)}</strong> (${days} Days)</div><div style="font-size:12px;font-weight:500;opacity:0.9;margin-top:2px;">${dayBreakdown}</div>`;
  }
}

function openTicketModal() {
  lastFocused = document.activeElement;
  const form = $('#ticket-form'); form.reset();
  if ($('#ticket-days-select')) $('#ticket-days-select').value = String(appConfig.validDays || 2);
  const dateInput = $('#ticket-start-date');
  if (dateInput) {
    dateInput.value = getLocalDateString(new Date());
  }
  updateDatePreview($('#ticket-start-date'), $('#ticket-days-select'), $('#ticket-date-preview'));
  $('#ticket-form-error').textContent = '';
  ticketModal.hidden = false;
  document.body.style.overflow = 'hidden';
  setTimeout(() => form.elements.fullName.focus(), 50);
}
function closeTicketModal() {
  ticketModal.hidden = true; document.body.style.overflow = '';
  if (lastFocused && lastFocused.focus) lastFocused.focus();
}
$('#close-ticket-modal')?.addEventListener('click', closeTicketModal);
$('#cancel-ticket')?.addEventListener('click', closeTicketModal);
ticketModal?.addEventListener('click', (event) => { if (event.target === ticketModal) closeTicketModal(); });
$('#ticket-start-date')?.addEventListener('input', () => updateDatePreview($('#ticket-start-date'), $('#ticket-days-select'), $('#ticket-date-preview')));
$('#ticket-days-select')?.addEventListener('change', () => updateDatePreview($('#ticket-start-date'), $('#ticket-days-select'), $('#ticket-date-preview')));

/* ---- Bulk ticket modal ---- */
const bulkModal = $('#bulk-modal');
function openBulkModal() {
  lastFocused = document.activeElement;
  if ($('#bulk-names-input')) $('#bulk-names-input').value = '';
  if ($('#bulk-days-select')) $('#bulk-days-select').value = String(appConfig.validDays || 2);
  const bulkDate = $('#bulk-start-date');
  if (bulkDate) {
    bulkDate.value = getLocalDateString(new Date());
  }
  updateDatePreview($('#bulk-start-date'), $('#bulk-days-select'), $('#bulk-date-preview'));
  if ($('#bulk-form-error')) $('#bulk-form-error').textContent = '';
  if (bulkModal) bulkModal.hidden = false;
  document.body.style.overflow = 'hidden';
  setTimeout(() => $('#bulk-names-input')?.focus(), 50);
}
function closeBulkModal() {
  if (bulkModal) bulkModal.hidden = true;
  document.body.style.overflow = '';
  if (lastFocused && lastFocused.focus) lastFocused.focus();
}
$('#close-bulk-modal')?.addEventListener('click', closeBulkModal);
$('#cancel-bulk-modal')?.addEventListener('click', closeBulkModal);
bulkModal?.addEventListener('click', (event) => { if (event.target === bulkModal) closeBulkModal(); });
$('#quick-bulk-tickets')?.addEventListener('click', openBulkModal);
$('#btn-bulk-tickets')?.addEventListener('click', openBulkModal);
$('#overview-bulk-btn')?.addEventListener('click', openBulkModal);
$('#bulk-start-date')?.addEventListener('input', () => updateDatePreview($('#bulk-start-date'), $('#bulk-days-select'), $('#bulk-date-preview')));
$('#bulk-days-select')?.addEventListener('change', () => updateDatePreview($('#bulk-start-date'), $('#bulk-days-select'), $('#bulk-date-preview')));

/* ---- Event Duration Modal ---- */
const durationModal = $('#duration-modal');
function openDurationModal() {
  lastFocused = document.activeElement;
  if ($('#setting-duration-select')) $('#setting-duration-select').value = String(appConfig.validDays || 2);
  if ($('#duration-form-msg')) $('#duration-form-msg').style.display = 'none';
  if (durationModal) durationModal.hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeDurationModal() {
  if (durationModal) durationModal.hidden = true;
  document.body.style.overflow = '';
  if (lastFocused && lastFocused.focus) lastFocused.focus();
}
$('#topbar-duration-btn')?.addEventListener('click', openDurationModal);
$('#close-duration-modal')?.addEventListener('click', closeDurationModal);
$('#cancel-duration-modal')?.addEventListener('click', closeDurationModal);
durationModal?.addEventListener('click', (event) => { if (event.target === durationModal) closeDurationModal(); });

$('#duration-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const select = $('#setting-duration-select');
  const days = Number(select?.value) || 2;
  const btn = $('#save-duration-btn');
  const msg = $('#duration-form-msg');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  if (msg) msg.style.display = 'none';

  try {
    const res = await api('/api/admin/settings/duration', {
      method: 'POST',
      body: JSON.stringify({ validDays: days })
    });
    appConfig.validDays = res.validDays || days;
    if ($('#topbar-days-label')) $('#topbar-days-label').textContent = `${appConfig.validDays} Day${appConfig.validDays === 1 ? '' : 's'}`;
    if ($('#valid-days')) $('#valid-days').textContent = appConfig.validDays;
    if ($('#ticket-days-select')) $('#ticket-days-select').value = String(appConfig.validDays);
    if ($('#bulk-days-select')) $('#bulk-days-select').value = String(appConfig.validDays);
    document.querySelectorAll('.dyn-policy-days').forEach((el) => {
      el.textContent = `${appConfig.validDays} Day${appConfig.validDays === 1 ? '' : 's'}`;
    });
    closeDurationModal();
    toast(`✓ Event duration updated to ${appConfig.validDays} days.`);
  } catch (err) {
    if (msg) {
      msg.textContent = err.message || 'Failed to save duration';
      msg.style.display = 'block';
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = 'Save Duration <span>→</span>';
    }
  }
});

/* ---- View Passes Modal ---- */
const viewPassesModal = $('#view-passes-modal');
function openPassesModal(group) {
  if (!group || !group.tickets || !group.tickets.length) return;
  activeGroupForPrint = group;
  lastFocused = document.activeElement;
  if ($('#view-passes-modal-title')) {
    $('#view-passes-modal-title').innerHTML = `Passes for <em>${escapeHtml(group.baseName)}.</em>`;
  }
  if ($('#view-passes-modal-subcopy')) {
    $('#view-passes-modal-subcopy').textContent = `${group.tickets.length} pass${group.tickets.length === 1 ? '' : 'es'} issued · Valid until ${dateTimeLabel(group.validUntil)}`;
  }

  const container = $('#passes-cards-container');
  if (container) {
    container.innerHTML = group.tickets.map((t) => {
      const dayMatch = (t.full_name || '').match(/\(Day\s*(\d+)\)/i);
      const passTag = dayMatch ? `Day ${dayMatch[1]} Pass` : 'Admission Pass';
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=6&data=${encodeURIComponent(t.ticket_code)}`;
      return `
        <div class="pass-card-item">
          <span class="pass-card-tag">${passTag}</span>
          <div class="pass-card-qr">
            <img src="${qrUrl}" alt="QR code for ${escapeHtml(t.ticket_code)}" />
          </div>
          <div class="pass-card-code">${escapeHtml(t.ticket_code)}</div>
          <div class="pass-card-status">${ticketPill(t)}</div>
          <div class="pass-card-actions">
            <a class="admin-button admin-button-primary" href="ticket.html?code=${encodeURIComponent(t.ticket_code)}" target="_blank" rel="noopener">Open Pass ↗</a>
            <button type="button" class="admin-button admin-button-light copy-single-code" data-code="${escapeHtml(t.ticket_code)}">Copy ID</button>
          </div>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.copy-single-code').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(btn.dataset.code);
          toast(`✓ Copied ${btn.dataset.code}`);
        } catch {
          toast(`ID: ${btn.dataset.code}`);
        }
      });
    });
  }

  const printBtn = $('#print-both-passes-btn');
  if (printBtn) {
    printBtn.innerHTML = `Print All ${group.tickets.length} Passes <span>🖨️</span>`;
  }

  const modal = $('#view-passes-modal') || viewPassesModal;
  if (modal) {
    modal.hidden = false;
    modal.removeAttribute('hidden');
    modal.style.display = 'flex';
  }
  document.body.style.overflow = 'hidden';
}

function closePassesModal() {
  const modal = $('#view-passes-modal') || viewPassesModal;
  if (modal) {
    modal.hidden = true;
    modal.setAttribute('hidden', '');
    modal.style.display = 'none';
  }
  document.body.style.overflow = '';
  if (lastFocused && lastFocused.focus) lastFocused.focus();
}

$('#close-view-passes-modal')?.addEventListener('click', closePassesModal);
$('#close-passes-btn')?.addEventListener('click', closePassesModal);
$('#view-passes-modal')?.addEventListener('click', (event) => {
  const modal = $('#view-passes-modal') || viewPassesModal;
  if (event.target === modal) closePassesModal();
});

function printBothPasses() {
  if (!activeGroupForPrint) return;
  const group = activeGroupForPrint;
  const printWindow = window.open('', '_blank', 'width=850,height=700');
  if (!printWindow) {
    alert('Please allow popups to print passes.');
    return;
  }
  const passesHtml = group.tickets.map((t) => {
    const dayMatch = (t.full_name || '').match(/\(Day\s*(\d+)\)/i);
    const passTag = dayMatch ? `Day ${dayMatch[1]} Pass · Single Entry` : 'Admission Pass · Single Entry';
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=260x260&margin=8&data=${encodeURIComponent(t.ticket_code)}`;
    return `
      <div style="flex:1;min-width:300px;max-width:360px;border:2px solid #14213D;border-radius:12px;padding:20px;text-align:center;box-sizing:border-box;background:#ffffff;">
        <div style="font-size:10px;font-weight:700;letter-spacing:1.5px;color:#8A5A12;text-transform:uppercase;">The Islamia University of Bahawalpur</div>
        <div style="font-size:18px;font-weight:800;color:#14213D;margin-top:4px;">CAIPSD EVENT PASS</div>
        <div style="display:inline-block;padding:3px 12px;background:#14213D;color:#ffffff;border-radius:20px;font-size:11px;font-weight:700;margin:8px 0;">${passTag}</div>
        <div style="font-size:17px;font-weight:700;color:#14213D;margin:8px 0 4px;">${escapeHtml(group.baseName)}</div>
        <div style="margin:12px auto;width:170px;height:170px;border:1px solid #ddd;border-radius:8px;padding:6px;background:#fff;">
          <img src="${qrUrl}" style="width:100%;height:100%;display:block;" />
        </div>
        <div style="font-family:monospace;font-size:16px;font-weight:800;letter-spacing:2px;color:#14213D;margin-top:6px;">${escapeHtml(t.ticket_code)}</div>
        <div style="font-size:11px;color:#555;margin-top:4px;">Present at entrance for scan verification</div>
      </div>
    `;
  }).join('');

  printWindow.document.write(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>CAIPSD Passes - ${escapeHtml(group.baseName)}</title>
        <style>
          @page { size: auto; margin: 15mm; }
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 20px; background: #fff; color: #14213D; }
          .passes-wrap { display: flex; gap: 24px; justify-content: center; flex-wrap: wrap; margin-top: 20px; }
          @media print { .no-print { display: none !important; } }
        </style>
      </head>
      <body>
        <div class="no-print" style="text-align:center;margin-bottom:20px;">
          <button onclick="window.print()" style="padding:10px 24px;font-size:14px;font-weight:700;background:#14213D;color:#fff;border:none;border-radius:8px;cursor:pointer;">Print / Save as PDF 🖨️</button>
        </div>
        <div style="text-align:center;border-bottom:2px solid #E6E0D2;padding-bottom:12px;margin-bottom:20px;">
          <h2 style="margin:0;font-size:22px;color:#14213D;">CAIPSD — The Islamia University of Bahawalpur</h2>
          <p style="margin:4px 0 0;color:#555;font-size:13px;">Official Event Admission Passes for <strong>${escapeHtml(group.baseName)}</strong></p>
        </div>
        <div class="passes-wrap">${passesHtml}</div>
      </body>
    </html>
  `);
  printWindow.document.close();
}

$('#print-both-passes-btn')?.addEventListener('click', printBothPasses);

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
    let scriptCode = '';
    try {
      const res = await api('/api/admin/sheets/template');
      if (res && res.template) scriptCode = res.template;
    } catch {}
    if (!scriptCode) throw new Error('Script not available');

    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(scriptCode);
      toast('✓ Google Apps Script copied to clipboard!');
      alert('✓ Google Apps Script copied to clipboard!\n\nNext steps in your Google Sheet:\n1. Open Extensions > Apps Script\n2. Select All (Ctrl+A), Paste (Ctrl+V), and Save (Ctrl+S)\n3. From the top dropdown, select "authorizeAndSendTestEmail" and click "Run" (▶️)\n4. Click "Review permissions" -> Select your Google Account -> Advanced -> Go to ... (unsafe) -> Allow\n5. Click Deploy > Manage deployments > Edit (pencil icon) > Version: New version > Deploy');
    } else {
      prompt('Copy this Google Apps Script code (Ctrl+C):', scriptCode);
    }
  } catch (err) {
    toast('Could not load the Google Apps Script. Open google-apps-script.js from the project folder and copy it.', 'error');
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
  const activeModal = [ticketModal, bulkModal, durationModal, mailModal, emailAllModal, viewPassesModal].find((m) => m && !m.hidden);
  if (!activeModal) return;
  if (event.key === 'Escape') {
    if (activeModal === ticketModal) closeTicketModal();
    else if (activeModal === bulkModal) closeBulkModal();
    else if (activeModal === durationModal) closeDurationModal();
    else if (activeModal === mailModal) closeMailModal();
    else if (activeModal === emailAllModal) closeEmailAllModal();
    else if (activeModal === viewPassesModal) closePassesModal();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = [...activeModal.querySelectorAll('button, input, select, textarea, a[href]')].filter((el) => !el.disabled);
  if (!focusable.length) return;
  const first = focusable[0]; const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
$('#ticket-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = {
    fullName: form.elements.fullName.value,
    phone: form.elements.phone ? form.elements.phone.value : '',
    email: form.elements.email ? form.elements.email.value : '',
    startDate: form.elements.startDate ? form.elements.startDate.value : '',
    days: form.elements.days ? Number(form.elements.days.value) : (appConfig.validDays || 2)
  };
  const button = $('#save-ticket');
  button.disabled = true;
  button.textContent = 'Generating…';
  $('#ticket-form-error').textContent = '';
  try {
    const data = await api('/api/admin/tickets', { method: 'POST', body: JSON.stringify(payload) });
    closeTicketModal();
    const baseName = data.ticket.full_name.replace(/\s*\((?:Day\s*\d+|Day\d+)\)$/i, '');
    const count = data.tickets ? data.tickets.length : (data.ticket ? 1 : 2);
    toast(`✓ ${count} ticket${count === 1 ? '' : 's'} generated for ${baseName}.`);
    refreshStats();
    if ($('#view-tickets').classList.contains('active')) loadTickets();
    else if ($('#view-overview').classList.contains('active')) loadDashboard();
  } catch (error) { $('#ticket-form-error').textContent = error.message; }
  finally { button.disabled = false; button.innerHTML = 'Generate ticket <span>→</span>'; }
});

$('#bulk-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = $('#bulk-names-input').value.trim();
  if (!text) return;
  const startDate = $('#bulk-start-date') ? $('#bulk-start-date').value : '';
  const days = $('#bulk-days-select') ? Number($('#bulk-days-select').value) : (appConfig.validDays || 2);
  const button = $('#save-bulk-btn');
  button.disabled = true;
  button.textContent = 'Generating tickets…';
  $('#bulk-form-error').textContent = '';
  try {
    const data = await api('/api/admin/tickets/bulk', { method: 'POST', body: JSON.stringify({ names: text, days, startDate }) });
    closeBulkModal();
    const count = data.count || (data.tickets ? data.tickets.length : '');
    const pCount = data.participantCount ? ` (${data.participantCount} participant${data.participantCount === 1 ? '' : 's'} × ${days} passes)` : '';
    const msg = data.message || (count ? `Successfully issued ${count} tickets${pCount}.` : 'Tickets issued successfully.');
    toast(`✓ ${msg}`);
    refreshStats();
    if ($('#view-tickets').classList.contains('active')) loadTickets();
    else if ($('#view-overview').classList.contains('active')) loadDashboard();
  } catch (error) {
    $('#bulk-form-error').textContent = error.message;
  } finally {
    button.disabled = false;
    button.innerHTML = 'Generate All Tickets <span>→</span>';
  }
});

function showCheckinResult(type, message, ticket = null, extra = '') {
  const result = $('#checkin-result');
  result.className = `checkin-result ${type}`;
  const icon = type === 'success' ? '✓' : type === 'warning' ? '⚠' : '✕';
  let detailHtml = '';
  if (ticket) {
    detailHtml = `
      <div class="result-ticket-details">
        <div class="result-attendee-name">${escapeHtml(ticket.full_name)}</div>
        <div class="result-ticket-meta">
          <span class="meta-code">Ticket: <code>${escapeHtml(ticket.ticket_code)}</code></span>
          <span class="meta-date">Valid: ${escapeHtml(dateTimeLabel(ticket.valid_until))}</span>
        </div>
        ${extra ? `<div class="result-ticket-status-pill">${escapeHtml(extra)}</div>` : ''}
      </div>`;
  } else {
    detailHtml = `<small class="result-hint">Check ticket credentials and verify attendance records.</small>`;
  }
  result.innerHTML = `
    <div class="result-icon-badge">${icon}</div>
    <div class="result-body-wrap">
      <strong class="result-headline">${escapeHtml(message)}</strong>
      ${detailHtml}
    </div>`;
}
async function performCheckin(ticketCode) {
  const cleaned = extractTicketCode(ticketCode);
  if (!cleaned) {
    showCheckinResult('error', 'Enter a valid 16-character ticket ID or scan a ticket QR.');
    return;
  }
  const activeDay = $('#scanner-active-day') ? $('#scanner-active-day').value : 'auto';
  const note = $('#scanner-message');
  note.textContent = 'Verifying ticket…';
  note.className = 'scanner-message';
  try {
    const result = await api('/api/check-in', {
      method: 'POST',
      body: JSON.stringify({ ticketCode: cleaned, activeDay })
    });
    const dayMatch = ((result.ticket && result.ticket.full_name) || '').match(/\(Day\s*(\d+)\)/i);
    const visitInfo = dayMatch ? `Day ${dayMatch[1]} Pass · Entry Recorded` : 'Entry Recorded';
    showCheckinResult('success', result.message, result.ticket, visitInfo);
    note.textContent = result.message; note.className = 'scanner-message success';
    $('#ticket-code-input').value = '';
    refreshStats();
  } catch (error) {
    const isDayEarly = Boolean(
      (error.data && (error.data.dayEarly || error.data.day2Early)) ||
      (error.message && error.message.includes('Ticket!') && error.message.includes('sirf Day'))
    );
    const earlyDayNum = (error.data && error.data.passDay) || ((error.message || '').match(/Day\s*(\d+)/i)?.[1]) || '2';
    const isAlreadyUsed = !isDayEarly && Boolean(
      (error.data && (error.data.alreadyUsed || error.data.alreadyScannedToday || error.data.limitReached)) ||
      (error.message && (error.message.includes('already used') || error.message.includes('Already used') || error.message.includes('pehle hi use') || error.message.includes('limit reached')))
    );
    let displayHeadline;
    let badgeText;
    let noteText = error.message;

    if (isDayEarly) {
      displayHeadline = `Day ${earlyDayNum} Ticket! (Entry Denied)`;
      badgeText = `DAY ${earlyDayNum} TICKET · NOT ALLOWED TODAY`;
    } else if (isAlreadyUsed) {
      displayHeadline = 'Already used ticket! (Entry Denied)';
      badgeText = 'ALREADY USED TICKET · ENTRY DENIED';
    } else {
      displayHeadline = error.message;
      badgeText = '';
    }

    showCheckinResult((isDayEarly || isAlreadyUsed) ? 'warning' : 'error', displayHeadline, error.data && error.data.ticket, badgeText);
    note.textContent = noteText;
    note.className = (isDayEarly || isAlreadyUsed) ? 'scanner-message warning' : 'scanner-message error';
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

async function triggerSheetsSync() {
  toast('Syncing tickets with Google Sheet…');
  try {
    const res = await api('/api/admin/sheets/push', { method: 'POST' });
    toast(`✓ ${res.message || 'Tickets synced to Google Sheet successfully!'}`);
  } catch (err) {
    toast(`Google Sheet sync: ${err.message}`, 'error');
  }
}
$('#quick-sheet-sync')?.addEventListener('click', triggerSheetsSync);
$('#btn-sync-tickets-sheets')?.addEventListener('click', triggerSheetsSync);

(async function initialize() {
  if (isStaticHost) {
    syncTicketsFromGoogleSheet().catch(() => {});
  }
  try { const data = await api('/api/admin/me'); showApp(data.admin.email); } catch { showLogin(); }
})();
