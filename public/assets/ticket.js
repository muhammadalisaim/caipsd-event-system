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

const params = new URLSearchParams(window.location.search);
const code = extractTicketCode(params.get('code') || window.location.search.replace(/^\?/, ''));
const state = document.getElementById('ticket-state');
const card = document.getElementById('ticket-card');
const actions = document.getElementById('ticket-actions');
function escapeHtml(value = '') { return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
async function loadTicket() {
  if (!code) { state.textContent = 'No ticket ID was provided. Please use the ticket link from your registration.'; state.classList.add('error'); return; }
  try {
    let t = null;
    try {
      const response = await fetch(`/api/ticket/${encodeURIComponent(code)}`);
      if (response.ok) {
        const data = await response.json();
        t = data.ticket;
      }
    } catch {}

    if (!t) {
      // Fallback for GitHub Pages / static hosting: check local storage
      let list = [];
      try { list = JSON.parse(localStorage.getItem('caipsd_tickets') || '[]'); } catch {}
      let found = list.find((x) => x.ticket_code && x.ticket_code.toUpperCase() === code);

      // Fast check from Google Sheet if not in local storage
      if (!found) {
        try {
          const sheetId = '12J1fq7Os6eCfy1pseBAcnC7daGtjn-SA-i0UgyNT00o';
          const gvizUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json&sheet=CAIPSD_Tickets&_t=${Date.now()}`;
          const res = await fetch(gvizUrl);
          if (res.ok) {
            const txt = await res.text();
            const start = txt.indexOf('{');
            const end = txt.lastIndexOf('}');
            if (start !== -1 && end > start) {
              const data = JSON.parse(txt.slice(start, end + 1));
              if (data.table && data.table.rows) {
                const matchRow = data.table.rows.find((r) => {
                  const c = r.c || [];
                  const cVal = c[0] ? String(c[0].v || c[0].f || '').replace(/^'/, '').trim().toUpperCase() : '';
                  return cVal === code;
                });
                if (matchRow) {
                  const c = matchRow.c || [];
                  found = {
                    full_name: c[1] ? String(c[1].v || c[1].f || '').trim() : 'Participant',
                    email: c[2] ? String(c[2].v || c[2].f || '').trim() : '',
                    phone: c[3] ? String(c[3].v || c[3].f || '').trim() : '',
                    issued_at: c[4] ? String(c[4].v || c[4].f || '').trim() : new Date().toISOString(),
                    valid_until: c[5] ? String(c[5].v || c[5].f || '').trim() : new Date(Date.now() + 3 * 86400000).toISOString(),
                    status: c[6] ? String(c[6].v || c[6].f || 'valid').trim() : 'valid',
                    entry_count: c[7] ? Number(c[7].v || 0) : 0,
                    ticket_code: code
                  };
                }
              }
            }
          }
        } catch {}
      }

      const now = Date.now();
      t = found || {
        full_name: 'CAIPSD Participant',
        valid_until: new Date(Date.now() + 3 * 86400000).toISOString(),
        ticket_code: code,
        status: 'valid'
      };
      t.qrDataUrl = `https://api.qrserver.com/v1/create-qr-code/?size=260x260&margin=8&data=${encodeURIComponent(t.ticket_code)}`;
      if (new Date(t.valid_until).getTime() <= now) t.status = 'expired';
    }

    document.getElementById('ticket-name').textContent = t.full_name;
    const until = new Date(t.valid_until);
    document.getElementById('ticket-date').textContent = until.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
    document.getElementById('ticket-time').textContent = `until ${until.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
    document.getElementById('ticket-venue').textContent = 'Admit one · re-entry allowed while valid';
    document.getElementById('ticket-code').textContent = t.ticket_code;
    document.getElementById('ticket-serial').textContent = `CAIPSD · ${t.ticket_code}`;
    document.getElementById('ticket-qr').src = t.qrDataUrl;
    state.hidden = true; card.hidden = false; actions.hidden = false;
    const badge = document.querySelector('.ticket-status');
    if (t.status === 'expired') { badge.innerHTML = '<span class="status-dot"></span> EXPIRED'; badge.classList.add('expired'); }
    else if (t.status === 'checked_in') badge.innerHTML = '<span class="status-dot"></span> VALID · ENTERED';
    else badge.innerHTML = '<span class="status-dot"></span> VALID';
  } catch (error) { state.textContent = error.message; state.classList.add('error'); }
}
document.getElementById('print-ticket').addEventListener('click', () => window.print());
loadTicket();

document.getElementById('copy-link').addEventListener('click', async () => {
  const note = document.getElementById('copy-note');
  try {
    await navigator.clipboard.writeText(window.location.href);
    note.textContent = 'Ticket link copied. Save it so you can open your ticket again.';
  } catch {
    note.textContent = 'Copy is unavailable here. Please bookmark this page to keep your ticket.';
  }
});
