const params = new URLSearchParams(window.location.search);
const code = params.get('code');
const state = document.getElementById('ticket-state');
const card = document.getElementById('ticket-card');
const actions = document.getElementById('ticket-actions');
function escapeHtml(value = '') { return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
async function loadTicket() {
  if (!code) { state.textContent = 'No ticket ID was provided. Please use the ticket link from your registration.'; state.classList.add('error'); return; }
  try {
    const response = await fetch(`/api/ticket/${encodeURIComponent(code)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Ticket could not be found.');
    const t = data.ticket;
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
