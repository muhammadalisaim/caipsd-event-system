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
const container = document.getElementById('tickets-container');
const actions = document.getElementById('ticket-actions');
function escapeHtml(value = '') { return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }

function renderTicketCard(t, markSrc) {
  const eventDateObj = t.event_date ? new Date(t.event_date + 'T00:00:00') : null;
  const until = new Date(t.valid_until);

  let formattedDate;
  let dateFieldLabel = 'VALID UNTIL';
  if (eventDateObj && !isNaN(eventDateObj.getTime())) {
    formattedDate = eventDateObj.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
    dateFieldLabel = 'WORKSHOP DATE';
  } else if (!isNaN(until.getTime())) {
    formattedDate = until.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
  } else {
    formattedDate = 'Valid for Event';
  }

  const dayMatch = (t.full_name || '').match(/\(Day\s*(\d+)\)/i);
  const dayTag = dayMatch ? `Day ${dayMatch[1]} Pass` : 'Admission Pass';
  let dateSuffix = '';
  if (eventDateObj && !isNaN(eventDateObj.getTime())) {
    dateSuffix = ` (${eventDateObj.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })})`;
  }
  const entryText = dayMatch ? `Day ${dayMatch[1]} Pass · Single Entry${dateSuffix}` : 'Admit one · Single Entry';

  let statusClass = '';
  let statusText = 'VALID';
  if (t.status === 'expired' || (!isNaN(until.getTime()) && until.getTime() <= Date.now())) {
    statusClass = 'expired';
    statusText = 'EXPIRED';
  } else if (t.status === 'checked_in' || (Number(t.entry_count) || 0) >= 1) {
    statusText = 'VALID · ENTERED';
  }

  const qrUrl = t.qrDataUrl || `https://api.qrserver.com/v1/create-qr-code/?size=260x260&margin=8&data=${encodeURIComponent(t.ticket_code)}`;

  return `
    <section class="ticket-card">
      <div class="ticket-main">
        <div class="ticket-brandline">
          <img src="${escapeHtml(markSrc)}" alt="CAIPSD" class="ticket-mini-logo" />
          <span>CAIPSD <small>THE ISLAMIA UNIVERSITY OF BAHAWALPUR</small></span>
          <span class="ticket-label">${escapeHtml(dayTag.toUpperCase())}</span>
        </div>
        <div class="ticket-workshop-label">EVENT PASS</div>
        <h2>CAIPSD Event Ticket</h2>
        <div class="ticket-details">
          <div><span>ATTENDEE</span><strong>${escapeHtml(t.full_name)}</strong></div>
          <div><span>${dateFieldLabel}</span><strong>${escapeHtml(formattedDate)}</strong></div>
          <div><span>ENTRY</span><strong>${escapeHtml(entryText)}</strong></div>
        </div>
        <div class="ticket-bottom">
          <div><span>TICKET ID</span><strong>${escapeHtml(t.ticket_code)}</strong></div>
          <div class="ticket-status ${statusClass}">
            <span class="status-dot"></span> ${escapeHtml(statusText)}
          </div>
        </div>
      </div>
      <div class="ticket-qr-side">
        <div class="qr-frame">
          <img src="${qrUrl}" alt="Ticket QR code for ${escapeHtml(t.ticket_code)}" />
        </div>
        <strong>Show this QR code</strong>
        <p>Present it at the entrance for quick check-in.</p>
        <span class="qr-divider"></span>
        <span class="qr-serial">CAIPSD · ${escapeHtml(t.ticket_code)}</span>
      </div>
    </section>
  `;
}

async function loadTicket() {
  if (!code) { state.textContent = 'No ticket ID was provided. Please use the ticket link from your registration.'; state.classList.add('error'); return; }
  try {
    let ticketsList = null;

    // 1. Try server API
    try {
      const response = await fetch(`/api/ticket/${encodeURIComponent(code)}`);
      if (response.ok) {
        const data = await response.json();
        if (data.tickets && Array.isArray(data.tickets) && data.tickets.length > 0) {
          ticketsList = data.tickets;
        } else if (data.ticket) {
          ticketsList = [data.ticket];
        }
      }
    } catch {}

    // 2. Check localStorage (static hosting / offline)
    if (!ticketsList || ticketsList.length === 0) {
      let list = [];
      try { list = JSON.parse(localStorage.getItem('caipsd_tickets') || '[]'); } catch {}
      const found = list.find((x) => x.ticket_code && x.ticket_code.toUpperCase() === code);
      if (found) {
        const baseName = String(found.full_name || '').replace(/\s*\((?:Day\s*\d+|Day\d+)\)$/i, '').trim().toLowerCase();
        const issuedMin = (found.issued_at || '').slice(0, 16);
        const siblings = list.filter((x) => {
          const xBase = String(x.full_name || '').replace(/\s*\((?:Day\s*\d+|Day\d+)\)$/i, '').trim().toLowerCase();
          const xMin = (x.issued_at || '').slice(0, 16);
          return xBase === baseName && (!issuedMin || !xMin || xMin === issuedMin);
        });
        const dayMap = new Map();
        for (const sib of siblings) {
          const m = (sib.full_name || '').match(/\(Day\s*(\d+)\)/i);
          const d = m ? parseInt(m[1], 10) : 0;
          if (!dayMap.has(d)) dayMap.set(d, sib);
        }
        const deduped = Array.from(dayMap.values());
        ticketsList = deduped.length > 0 ? deduped : [found];
      }
    }

    // 3. Check Google Sheet if not found yet
    if (!ticketsList || ticketsList.length === 0) {
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
                const rawPerson = getV(c[1]) || 'Participant';
                const basePerson = rawPerson.replace(/\s*\((?:Day\s*\d+|Day\d+)\)$/i, '').trim();

                const val2 = getV(c[2]);
                const is11 = val2.includes('@') || (c.length > 9 && !val2.includes('-') && !val2.includes('T'));
                const issued = is11 ? getV(c[4]) : val2;
                const valid = is11 ? getV(c[5]) : getV(c[3]);
                const status = (is11 ? getV(c[6]) : getV(c[4])) || 'valid';
                const rawEntriesStr = String((is11 ? getV(c[7]) : getV(c[5])) || '').trim();

                const dayMatches = Array.from(rawCodeStr.matchAll(/Day\s*(\d+)\s*:\s*([A-Za-z0-9]{8,32})/gi));
                if (dayMatches.length > 0) {
                  const seenDays = new Map();
                  for (const m of dayMatches) {
                    const d = parseInt(m[1], 10);
                    if (!seenDays.has(d)) seenDays.set(d, m[2].toUpperCase());
                  }
                  ticketsList = Array.from(seenDays.entries()).map(([dayNum, passCode]) => {
                    const dayEntryMatch = rawEntriesStr.match(new RegExp(`Day\\s*${dayNum}\\s*:\\s*(\\d+)`, 'i'));
                    let dayEntries = 0;
                    if (dayEntryMatch) {
                      dayEntries = parseInt(dayEntryMatch[1], 10) || 0;
                    } else if (String(status).toLowerCase().includes(`day ${dayNum} entered`) || String(status).toLowerCase().includes(`day${dayNum} entered`) || String(status).toLowerCase().includes('completed')) {
                      dayEntries = 1;
                    } else {
                      const firstIntMatch = rawEntriesStr.match(/^(\d+)/);
                      if (firstIntMatch && dayNum === 1 && parseInt(firstIntMatch[1], 10) > 0) {
                        dayEntries = 1;
                      }
                    }
                    return {
                      full_name: `${basePerson} (Day ${dayNum})`,
                      ticket_code: passCode,
                      issued_at: issued,
                      valid_until: valid,
                      status: status === 'cancelled' ? 'cancelled' : (dayEntries >= 1 ? 'checked_in' : 'valid'),
                      entry_count: dayEntries
                    };
                  });
                } else {
                  const singleEntryCount = parseInt(rawEntriesStr.replace(/^[^\d]*/, ''), 10) || (String(status).toLowerCase().includes('entered') ? 1 : 0);
                  ticketsList = [{
                    full_name: rawPerson,
                    ticket_code: rawCodeStr.toUpperCase(),
                    issued_at: issued,
                    valid_until: valid,
                    status: status === 'cancelled' ? 'cancelled' : (singleEntryCount >= 1 ? 'checked_in' : status),
                    entry_count: singleEntryCount
                  }];
                }
              }
            }
          }
        }
      } catch {}
    }

    if (!ticketsList || ticketsList.length === 0) {
      ticketsList = [{
        full_name: 'CAIPSD Participant',
        valid_until: new Date(Date.now() + 3 * 86400000).toISOString(),
        ticket_code: code,
        status: 'valid'
      }];
    }

    // Sort: Day 1 first, then Day 2, Day 3...
    ticketsList.sort((a, b) => {
      const mA = (a.full_name || '').match(/\(Day\s*(\d+)\)/i);
      const mB = (b.full_name || '').match(/\(Day\s*(\d+)\)/i);
      const dA = mA ? parseInt(mA[1], 10) : 0;
      const dB = mB ? parseInt(mB[1], 10) : 0;
      return dA - dB;
    });

    // Detect mark logo src
    const headerLogo = document.querySelector('.ticket-header-logo');
    let markSrc = 'assets/caipsd-mark.png';
    if (headerLogo && headerLogo.getAttribute('src')) {
      markSrc = headerLogo.getAttribute('src').replace(/caipsd-logo\.(png|svg)/, 'caipsd-mark.png');
    }

    // Render cards
    container.innerHTML = ticketsList.map((t) => renderTicketCard(t, markSrc)).join('');

    // Update headlines and button
    const kicker = document.getElementById('ticket-kicker');
    const subcopy = document.getElementById('ticket-subcopy');
    const printBtn = document.getElementById('print-ticket');

    if (ticketsList.length > 1) {
      if (kicker) kicker.textContent = `CAIPSD MULTI-DAY EVENT PASS (${ticketsList.length} PASSES)`;
      if (subcopy) subcopy.textContent = 'Show the corresponding daily pass QR code at the entrance on each day of the event.';
      if (printBtn) printBtn.innerHTML = `Print All ${ticketsList.length} Passes / Save as PDF <span>↗</span>`;
    } else {
      if (kicker) kicker.textContent = 'CAIPSD EVENT TICKET';
      if (subcopy) subcopy.textContent = 'Show this QR code at the entrance. It can be scanned any time while the ticket is valid.';
      if (printBtn) printBtn.innerHTML = 'Print / Save as PDF <span>↗</span>';
    }

    state.hidden = true;
    state.style.display = 'none';
    actions.hidden = false;
    actions.removeAttribute('hidden');
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
