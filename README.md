# CAIPSD Event Ticket Portal

A single organizer portal for issuing event tickets. Enter a participant's **name, phone number and email**, and the system generates a unique QR ticket, saves it, and (optionally) emails it from your own mailbox. On the day, scan the QR code at the entrance to allow entry.

There is no public registration: only organizers who sign in can issue tickets.

## How it works

1. Sign in at `/admin.html` (the site root redirects there).
2. Click **Issue ticket**, enter name, email and phone, and generate. The ticket is saved to the database and, if email is configured, sent to the participant with the QR code embedded.
3. Each ticket is **valid for 3 days** from the moment it is issued (`TICKET_VALID_DAYS`). Within that time it can be scanned for entry as many times as needed. Expired or cancelled tickets are rejected.
4. At the entrance open **Entry check-in** and scan the QR code (or type the 16-character ticket ID).

## Features

- Ticket issuing: one ticket per email address, with full validation
- Unique QR ticket per participant, stored in SQLite (`data/caipsd.sqlite`)
- Email delivery from your own mailbox (Gmail or any SMTP provider), with **Send / Resend** per ticket
- Ticket validity window (default 3 days) with automatic expiry
- Camera QR scanner (bundled locally, works without internet) and manual ID entry
- Entry log: number of entries, first and last entry time per ticket
- Search and filter tickets (valid / entered / expired), cancel a ticket, export CSV
- Hardened server: strict CSP, login rate limiting, session cleanup, production safety checks
- Automated API tests (`npm test`)

## Requirements

Node.js 18.18 or later and npm.

## Setup

```bash
npm install
cp .env.example .env     # then edit .env
npm start
```

Kali Linux users can run `./setup-kali.sh` instead; it generates a strong admin password and session secret. Open `http://localhost:3000`.

### Email setup (Gmail)

1. Turn on 2-Step Verification for your Google account.
2. Create an App password at <https://myaccount.google.com/apppasswords>.
3. In `.env` set:

   ```env
   SMTP_USER=yourname@gmail.com
   SMTP_PASS=your16characterapppassword
   MAIL_FROM_NAME=CAIPSD Events
   ```

4. Restart the server. The portal's Overview page shows "Connected" when email is ready.

For other providers also set `SMTP_HOST`, `SMTP_PORT` and `SMTP_SECURE`. Set `APP_URL` (the public address of the portal) to add an "Open ticket online" button to the email.

Without email settings the portal still works: tickets are saved and can be opened or printed from **Tickets → View**.

## Configuration

| Variable | Purpose |
| --- | --- |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Organizer login (change later with `npm run reset-admin`) |
| `SESSION_SECRET` | Long random string; required in production |
| `TICKET_VALID_DAYS` | Ticket validity after issuing (default 3) |
| `SMTP_USER`, `SMTP_PASS`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` | Email delivery |
| `MAIL_FROM`, `MAIL_FROM_NAME` | Sender address / display name |
| `APP_URL` | Public URL used in emailed ticket links |
| `EVENT_TIMEZONE` | Time zone for dates in emails (default `Asia/Karachi`) |
| `TRUST_PROXY` | Set to `1` behind a reverse proxy |
| `DB_PATH` | Custom SQLite file location |

## Event day

- Keep **Entry check-in** open on the entrance device. Camera scanning needs `localhost` or HTTPS.
- Green result: entry allowed. Amber: the ticket was already used earlier but is still valid (re-entry). Red: expired, cancelled or invalid.
- Use one central server for all check-in devices so every scan uses the same database.

## Data and backup

Everything is stored in `data/caipsd.sqlite`. Back it up regularly and never delete it once tickets are issued. Ticket numbers are random 16-character codes; the public ticket page shows only the name, validity and QR, never email or phone.

## Production notes

Run with `NODE_ENV=production` behind HTTPS and set `TRUST_PROXY=1`. The server refuses to start without a strong `SESSION_SECRET` and a non-default `ADMIN_PASSWORD`. `GET /api/health` can be used for monitoring.

## Development

```bash
npm test         # API tests (in-memory database, emails captured instead of sent)
npm run check    # syntax check
```

## Upgrading from the workshop version

Earlier versions used public registration and workshops. Those tables are no longer used, so old registrations are not shown. New tickets use a separate table, and your existing `data/` file can be kept.

## Structure

```text
caipsd-event-system/
├── server.js        # API and security setup
├── db.js            # SQLite schema
├── mailer.js        # ticket email (SMTP)
├── reset-admin.js
├── setup-kali.sh
├── test/api.test.js
└── public/
    ├── admin.html   # the portal (issue tickets, list, scan)
    ├── ticket.html  # printable ticket view
    ├── 404.html
    └── assets/
```
