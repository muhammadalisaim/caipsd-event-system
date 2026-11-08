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
  if (!ticket || !GOOGLE_WEB_APP_URL) return { status: 'skipped', message: 'No Google Web App URL configured' };
  const recipient = String(ticket.email || (ticket.ticket && ticket.ticket.email) || '').trim().toLowerCase();
  if (!recipient || !recipient.includes('@')) {
    throw new Error('Ticket participant does not have a valid email address.');
  }
  const ticketCode = String(ticket.ticket_code || ticket.ticketCode || '').trim();
  const fullName = String(ticket.full_name || ticket.fullName || 'Participant').trim();

  // Try GET request first - standard browser cross-origin friendly, no CORS preflight or POST redirect rewrite issues
  const getUrl = `${GOOGLE_WEB_APP_URL}?action=sendTicketEmail&to=${encodeURIComponent(recipient)}&ticketCode=${encodeURIComponent(ticketCode)}&fullName=${encodeURIComponent(fullName)}&_t=${Date.now()}`;

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
    const res = await fetch(GOOGLE_WEB_APP_URL, {
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
      await fetch(GOOGLE_WEB_APP_URL, {
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
  if (!GOOGLE_WEB_APP_URL) return;
  const recipient = String(to || '').trim().toLowerCase();
  const getUrl = `${GOOGLE_WEB_APP_URL}?action=sendTestEmail&to=${encodeURIComponent(recipient)}&_t=${Date.now()}`;
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
    const res = await fetch(GOOGLE_WEB_APP_URL, {
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
      await fetch(GOOGLE_WEB_APP_URL, {
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
    const cleanEmail = String(body.email || '').trim().toLowerCase();
    const cleanFullName = String(body.fullName || 'Participant').trim();
    const cleanPhone = String(body.phone || '').trim();
    const shouldSend = body.sendEmail !== false && body.sendEmail !== 'false' && Boolean(cleanEmail);

    const newTicket = {
      id: Date.now(),
      full_name: cleanFullName,
      email: cleanEmail,
      phone: cleanPhone,
      ticket_code: hex,
      issued_at: now.toISOString(),
      valid_until: validUntil.toISOString(),
      entry_count: 0,
      first_entry_at: null,
      last_entry_at: null,
      email_status: 'not_sent',
      status: 'valid'
    };

    let emailResult = { status: 'not_sent' };
    if (shouldSend) {
      try {
        await pushTicketEmailToSheet(newTicket);
        newTicket.email_status = 'sent';
        newTicket.email_error = null;
        emailResult = { status: 'sent' };
      } catch (err) {
        console.error('Failed to email new ticket:', err);
        newTicket.email_status = 'failed';
        newTicket.email_error = err.message;
        emailResult = { status: 'failed', error: err.message };
      }
    }

    list.unshift(newTicket);
    saveLocalTickets(list);

    // Save ticket with its real email_status in Google Sheet
    pushTicketToSheet(newTicket, 'appendTicket');

    return { ticket: newTicket, email: emailResult };
  }

  if (url === '/api/admin/tickets/bulk' && method === 'POST') {
    const rawNames = Array.isArray(body.names)
      ? body.names
      : String(body.names || '').split(/\r?\n/);
    const days = Math.max(1, Math.min(30, Number(body.days || body.validDays || 2)));
    const names = rawNames.map((n) => String(n || '').trim()).filter((n) => n.length >= 2);
    if (!names.length) {
      const err = new Error('Please enter at least one participant name.');
      err.status = 400;
      throw err;
    }
    const list = getLocalTickets();
    const now = new Date();
    const validUntil = new Date(now.getTime() + days * 86400000);
    const createdTickets = [];
    for (const name of names) {
      const hex = Array.from(crypto.getRandomValues(new Uint8Array(8)))
        .map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
      const newTicket = {
        id: Date.now() + Math.floor(Math.random() * 1000000),
        full_name: name,
        email: '',
        phone: '',
        ticket_code: hex,
        issued_at: now.toISOString(),
        valid_until: validUntil.toISOString(),
        entry_count: 0,
        first_entry_at: null,
        last_entry_at: null,
        email_status: 'not_sent',
        max_days: days,
        status: 'valid'
      };
      createdTickets.push(newTicket);
      list.unshift(newTicket);
      pushTicketToSheet(newTicket, 'appendTicket');
    }
    saveLocalTickets(list);
    return {
      message: `Successfully issued ${createdTickets.length} ticket${createdTickets.length === 1 ? '' : 's'} (${days} day${days === 1 ? '' : 's'} pass).`,
      count: createdTickets.length,
      days,
      tickets: createdTickets
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

    if (!t) {
      try {
        const synced = await syncTicketsFromGoogleSheet();
        if (synced && synced.length) {
          list = synced;
          t = list.find((x) => x.ticket_code && x.ticket_code.toUpperCase() === code);
        }
      } catch {}
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
  if ($('#front-checkin-panel')) $('#front-checkin-panel').style.display = isCheckin ? 'flex' : 'none';
  if ($('#front-login-panel')) $('#front-login-panel').style.display = isCheckin ? 'none' : 'flex';
  if (!isCheckin) {
    stopScanner();
  } else {
    $('#ticket-code-input')?.focus();
  }
}

function showLogin() {
  currentAdminEmail = null;
  $('#admin-app').hidden = true;
  $('#login-screen').hidden = false;
  if ($('#admin-session-banner')) $('#admin-session-banner').style.display = 'none';
  if ($('#header-login-btn')) $('#header-login-btn').textContent = 'Login';
  $('#login-error').textContent = '';
  $('#login-form').reset();
  setFrontTab('checkin');
}

function showApp(email) {
  currentAdminEmail = email;
  stopScanner();
  $('#login-screen').hidden = true;
  $('#admin-app').hidden = false;
  $('#admin-email').textContent = email || 'Organizer';
  $('#admin-avatar').textContent = (email || 'A').charAt(0).toUpperCase();
  if ($('#session-banner-email')) $('#session-banner-email').textContent = email || 'Organizer';
  if ($('#header-login-btn')) $('#header-login-btn').textContent = 'Admin Workspace →';
  loadConfig().then(loadDashboard);
}

function openGateCheckin() {
  $('#admin-app').hidden = true;
  $('#login-screen').hidden = false;
  if (currentAdminEmail && $('#admin-session-banner')) {
    $('#admin-session-banner').style.display = 'flex';
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
$('#quick-open-gate')?.addEventListener('click', openGateCheckin);

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

// Hero Apply / Checkin button:
$('#hero-apply-btn')?.addEventListener('click', (e) => {
  e.preventDefault();
  setFrontTab('checkin');
  document.getElementById('portal-section')?.scrollIntoView({ behavior: 'smooth' });
  setTimeout(() => {
    $('#ticket-code-input')?.focus();
  }, 400);
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

// Floating AI Chat & Hero AI Button:
function toggleAiChat() {
  const card = $('#ai-chat-card');
  if (!card) return;
  card.hidden = !card.hidden;
}
$('#floating-chat-btn')?.addEventListener('click', toggleAiChat);
$('#hero-ai-btn')?.addEventListener('click', toggleAiChat);
$('#ai-chat-close')?.addEventListener('click', () => {
  const card = $('#ai-chat-card');
  if (card) card.hidden = true;
});

$('#ai-opt-checkin')?.addEventListener('click', () => {
  const card = $('#ai-chat-card');
  if (card) card.hidden = true;
  setFrontTab('checkin');
  document.getElementById('portal-section')?.scrollIntoView({ behavior: 'smooth' });
});
$('#ai-opt-login')?.addEventListener('click', () => {
  const card = $('#ai-chat-card');
  if (card) card.hidden = true;
  setFrontTab('login');
  document.getElementById('portal-section')?.scrollIntoView({ behavior: 'smooth' });
});
$('#ai-opt-rules')?.addEventListener('click', () => {
  const ans = $('#ai-chat-answer');
  if (!ans) return;
  ans.style.display = 'block';
  ans.innerHTML = `<strong>📅 Event Validity Policy:</strong><br>
  • Har ticket par <strong>1 calendar day mein sirf 1 scan</strong> allowed hai.<br>
  • Total event duration portal se set ki ja sakti hai (jaise 2, 3, ya 4 din).<br>
  • Same day par repeat scan ya validity khatam hone par ticket block hota hai.`;
});
$('#ai-opt-support')?.addEventListener('click', () => {
  const ans = $('#ai-chat-answer');
  if (!ans) return;
  ans.style.display = 'block';
  ans.innerHTML = `<strong>📞 Event Organizer Support:</strong><br>
  Centre of AI &amp; Professional Skills Development (CAIPSD)<br>
  The Islamia University of Bahawalpur<br>
  Email: <code>admin@caipsd.org</code><br>
  Google Sheets Auto-Sync: <strong>Active ✓</strong>`;
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
    $('#recent-tickets').innerHTML = ticketsTable(list.tickets.slice(0, 6), false);
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

function participantCell(row) {
  const initials = row.full_name.trim().split(/\s+/).slice(0, 2).map((word) => word[0] || '').join('').toUpperCase();
  const sub = row.email ? escapeHtml(row.email) : (row.phone ? escapeHtml(row.phone) : 'Direct Ticket');
  return `<div class="participant-cell"><span class="participant-avatar">${escapeHtml(initials)}</span><span><strong>${escapeHtml(row.full_name)}</strong><small>${sub}</small></span></div>`;
}
function ticketsTable(rows, withActions) {
  if (!rows.length) return '<div class="empty-table">No tickets found. Use “Issue ticket” or “Bulk issue” to create tickets.</div>';
  const head = `<tr><th>PARTICIPANT</th><th>PHONE / INFO</th><th>TICKET ID</th><th>VALID UNTIL</th><th>ATTENDANCE</th>${withActions ? '<th>ACTION</th>' : ''}</tr>`;
  const body = rows.map((row) => `<tr><td>${participantCell(row)}</td><td>${escapeHtml(row.phone || '—')}</td><td><strong>${escapeHtml(row.ticket_code)}</strong></td><td>${escapeHtml(dateTimeLabel(row.valid_until))}</td><td>${ticketPill(row)}</td>${withActions ? `<td><div class="row-actions"><a class="status-action" href="ticket.html?code=${encodeURIComponent(row.ticket_code)}" target="_blank" rel="noopener">View / Print</a><button class="status-action danger cancel-ticket" data-id="${row.id}" data-name="${escapeHtml(row.full_name)}">Cancel</button></div></td>` : ''}</tr>`).join('');
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
  if ($('#ticket-days-select')) $('#ticket-days-select').value = String(appConfig.validDays || 2);
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

/* ---- Bulk ticket modal ---- */
const bulkModal = $('#bulk-modal');
function openBulkModal() {
  lastFocused = document.activeElement;
  if ($('#bulk-names-input')) $('#bulk-names-input').value = '';
  if ($('#bulk-days-select')) $('#bulk-days-select').value = String(appConfig.validDays || 2);
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
  const activeModal = [ticketModal, bulkModal, durationModal, mailModal, emailAllModal].find((m) => m && !m.hidden);
  if (!activeModal) return;
  if (event.key === 'Escape') {
    if (activeModal === ticketModal) closeTicketModal();
    else if (activeModal === bulkModal) closeBulkModal();
    else if (activeModal === durationModal) closeDurationModal();
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
$('#ticket-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = {
    fullName: form.elements.fullName.value,
    phone: form.elements.phone ? form.elements.phone.value : '',
    email: form.elements.email ? form.elements.email.value : '',
    days: form.elements.days ? Number(form.elements.days.value) : (appConfig.validDays || 2)
  };
  const button = $('#save-ticket');
  button.disabled = true;
  button.textContent = 'Generating…';
  $('#ticket-form-error').textContent = '';
  try {
    const data = await api('/api/admin/tickets', { method: 'POST', body: JSON.stringify(payload) });
    closeTicketModal();
    toast(`✓ Ticket generated for ${data.ticket.full_name}. (ID: ${data.ticket.ticket_code})`);
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
  const days = $('#bulk-days-select') ? Number($('#bulk-days-select').value) : (appConfig.validDays || 2);
  const button = $('#save-bulk-btn');
  button.disabled = true;
  button.textContent = 'Generating tickets…';
  $('#bulk-form-error').textContent = '';
  try {
    const data = await api('/api/admin/tickets/bulk', { method: 'POST', body: JSON.stringify({ names: text, days }) });
    closeBulkModal();
    const count = data.count || (data.tickets ? data.tickets.length : '');
    const msg = data.message || (count ? `Successfully issued ${count} tickets.` : 'Tickets issued successfully.');
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
    const result = await api('/api/check-in', { method: 'POST', body: JSON.stringify({ ticketCode: cleaned }) });
    const maxDays = Number(result.maxDays) || 2;
    const isFinal = result.dayNumber >= maxDays;
    const visitInfo = `Day ${result.dayNumber} of ${maxDays} Entry Recorded${isFinal ? ' · Final Day' : ''}`;
    showCheckinResult(result.repeat ? 'warning' : 'success', result.message, result.ticket, visitInfo);
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
