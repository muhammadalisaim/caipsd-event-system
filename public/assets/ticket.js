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
                  return cVal === code || cVal.includes(code);
                });
                if (matchRow) {
                  const c = matchRow.c || [];
                  const getV = (col) => (col ? String(col.v !== undefined ? col.v : (col.f !== undefined ? col.f : '')).trim() : '');
                  const rawCodeStr = getV(c[0]).replace(/^'/, '');
                  const dayM = rawCodeStr.match(new RegExp(`Day\\s*(\\d+)\\s*:\\s*${code}`, 'i'));
                  const rawPerson = getV(c[1]) || 'Participant';
                  const basePerson = rawPerson.replace(/\s*\((?:Day\s*\d+|Day\d+)\)$/i, '').trim();
                  const displayName = dayM ? `${basePerson} (Day ${dayM[1]})` : rawPerson;

                  const val2 = getV(c[2]);
                  const is11 = val2.includes('@') || (c.length > 9 && !val2.includes('-') && !val2.includes('T'));
                  found = {
                    full_name: displayName,
                    email: is11 ? val2 : '',
                    phone: is11 ? getV(c[3]) : '',
                    issued_at: is11 ? getV(c[4]) : val2,
                    valid_until: is11 ? getV(c[5]) : getV(c[3]),
                    status: (is11 ? getV(c[6]) : getV(c[4])) || 'valid',
                    entry_count: Number((is11 ? getV(c[7]) : getV(c[5])) || 0),
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
    const dayMatch = (t.full_name || '').match(/\(Day\s*(\d+)\)/i);
    const entryText = dayMatch ? `Day ${dayMatch[1]} Pass · Single Entry` : 'Admit one · Single Entry';
    document.getElementById('ticket-venue').textContent = entryText;
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
