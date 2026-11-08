# CAIPSD Event Ticket Portal

A single organizer portal for issuing event tickets. Enter a participant's **name, phone number and email**, and the system generates a unique QR ticket, saves it, and (optionally) emails it from your own mailbox. On the day, scan the QR code at the entrance to allow entry.

There is no public registration: only organizers who sign in can issue tickets.

## How it works

1. Sign in at `/admin.html` (the site root redirects there).
2. Click **Issue ticket**, enter name, email and phone, and generate. The ticket is saved and **emailed to the participant automatically** with its QR code (the "email now" box is ticked by default; untick it to issue a ticket without sending).
3. Each ticket is **valid for 3 days** from the moment it is issued (`TICKET_VALID_DAYS`). Within that time it can be scanned for entry as many times as needed. Expired or cancelled tickets are rejected.
4. At the entrance open **Entry check-in** and scan the QR code (or type the 16-character ticket ID).

## Features

- Ticket issuing: one ticket per email address, with full validation
- Unique QR ticket per participant, stored in SQLite (`data/caipsd.sqlite`)
- **Automatic email on every new ticket** (QR image inside the mail + attached PNG), with **Send / Resend** per ticket and a **1-click "Email all"**
- Two email channels with automatic fallback: your Gmail/SMTP account, or the attached Google Apps Script
- Clear "Sent / Failed" status per ticket, with the reason when an email fails
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

### Email through the Google Script (no password needed)

If you do not set `SMTP_USER` / `SMTP_PASS`, tickets are emailed by the Apps Script attached to your Google Sheet, from the Gmail account that owns the Sheet.

1. Open the Sheet → **Extensions → Apps Script**, paste the contents of `google-apps-script.js` (or press **Copy Google Apps Script** in the portal) and Save.
2. Choose **authorizeAndSendTestEmail** in the function list, press **Run** and allow the permissions (one time).
3. **Deploy → Manage deployments → Edit (pencil) → Version: New version → Deploy**. Access must be "Anyone", execute as "Me".
4. Press **Send Test Email** in the portal. If it arrives, new tickets will be emailed automatically.

**Important:** after changing the script you must deploy a **new version** (step 3), otherwise Google keeps running the old one.

Limits: a normal Gmail account can send about 100 emails/day from Apps Script (Google Workspace: about 1,500). For bigger events use the Gmail/SMTP channel or issue tickets in batches.

Without any email channel the portal still works: tickets are saved and can be opened or printed from **Tickets → View**.

## Two ways to host

| | Node server (recommended) | GitHub Pages (static) |
| --- | --- | --- |
| Files used | `public/` served by `server.js` | repo root (`index.html`, `assets/`) |
| Login | Real organizer account | **None** - the page cannot keep a secret |
| Data | SQLite database | browser storage + Google Sheet |
| Email | SMTP or Google Script | Google Script only |

Use the Node server for real events. The static site is convenient for demos, but anyone who can open it can use it, and the Google Script URL is visible in the page source.

After you change anything in `public/`, run `npm run build:static` to refresh the root copy used by GitHub Pages (`npm run check` does it too).

### Lock down the Google Script (Node server only)

Set `WEBHOOK_SECRET` at the top of `google-apps-script.js` and the same text as `GOOGLE_WEBHOOK_SECRET` in `.env`, then deploy a new version. Afterwards only your server can send mail or read tickets through the script. (Do not do this if you also use the GitHub Pages version - it would stop working.)

## Configuration

| Variable | Purpose |
| --- | --- |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Organizer login (change later with `npm run reset-admin`) |
| `SESSION_SECRET` | Long random string; required in production |
| `TICKET_VALID_DAYS` | Ticket validity after issuing (default 3) |
| `SMTP_USER`, `SMTP_PASS`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` | Email delivery |
| `MAIL_FROM`, `MAIL_FROM_NAME` | Sender address / display name |
| `APP_URL` | Public URL used in emailed ticket links |
| `GOOGLE_SHEETS_WEBHOOK_URL`, `GOOGLE_SHEETS_SPREADSHEET_ID` | Google Script web-app URL and Sheet (defaults built in) |
| `GOOGLE_WEBHOOK_SECRET` | Shared secret with the Apps Script (see above) |
| `ALLOWED_ORIGINS` | Other websites allowed to call the API (default: none) |
| `EVENT_TIMEZONE` | Time zone for dates in emails (default `Asia/Karachi`) |
| `TRUST_PROXY` | Set to `1` behind a reverse proxy |
| `DB_PATH` | Custom SQLite file location |

## Event day

- Keep **Entry check-in** open on the entrance device. Camera scanning needs `localhost` or HTTPS.
- Green result: entry allowed. Amber: the ticket was already used earlier but is still valid (re-entry). Red: expired, cancelled or invalid.
- Use one central server for all check-in devices so every scan uses the same database.
- Cancelled tickets are rejected even if they are still listed in the Google Sheet.
- Gate scanning is limited to 600 scans per 5 minutes per device address.

## Data and backup

Everything is stored in `data/caipsd.sqlite`. Back it up regularly and never delete it once tickets are issued. Ticket numbers are random 16-character codes; the public ticket page shows only the name, validity and QR, never email or phone.

## Production notes

Run with `NODE_ENV=production` behind HTTPS and set `TRUST_PROXY=1`. The server refuses to start without a strong `SESSION_SECRET` and a non-default `ADMIN_PASSWORD`. `GET /api/health` can be used for monitoring.

## Development

```bash
npm test               # API + email + Apps Script tests (in-memory database, nothing is really sent)
npm run check          # syntax check + refresh the GitHub Pages copy
npm run build:static   # copy public/ to the repo root for GitHub Pages
```

`npm test` also runs `google-apps-script.js` inside a sandbox with fake Google services, so the email code is verified without deploying it.

## Upgrading from the workshop version

Earlier versions used public registration and workshops. Those tables are no longer used, so old registrations are not shown. New tickets use a separate table, and your existing `data/` file can be kept.

## Structure

```text
caipsd-event-system/
├── server.js        # API and security setup
├── db.js            # SQLite schema
├── mailer.js        # ticket email (SMTP)
├── sheets.js        # Google Sheet / Google Script client
├── google-apps-script.js   # the ONE copy of the Apps Script (paste into Google)
├── scripts/build-static.js # public/ -> repo root for GitHub Pages
├── reset-admin.js
├── setup-kali.sh
├── test/            # api, email (Google Script) and Apps Script tests
└── public/
    ├── admin.html   # the portal (issue tickets, list, scan)
    ├── ticket.html  # printable ticket view
    ├── 404.html
    └── assets/
```
