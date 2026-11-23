# CAIPSD Event System — Quick Guide & Documentation 🎫

A lightweight, secure event ticketing & gate check-in system built for **CAIPSD — The Islamia University of Bahawalpur**.

---

## 1. 🔑 Credentials & Access

| Resource | URL / Access | Credentials |
|---|---|---|
| **Admin Portal (Server)** | `http://localhost:3000/admin.html` | **Email:** `admin@caipsd.org`<br>**Password:** `Event@2211` |
| **Admin Portal (GitHub Pages)** | `https://muhammadalisaim.github.io/caipsd-event-system/` | **Email:** `admin@caipsd.org`<br>**Password:** `Event@2211` |
| **Google Sheet Database** | Via Portal button (`Live Sheet ↗`) | **Unlock Password:** `Event@2211` |

---

## 2. 🚀 Quick Start (Running the System)

### Mode A: Node.js Backend Server (Recommended)
```bash
# 1. Install dependencies (first time only)
npm install

# 2. Start the server
npm start
# Server runs at: http://localhost:3000
```

### Mode B: GitHub Pages / Static Hosting (No Node required)
Open `index.html` directly in any web browser or deploy the repository root to GitHub Pages. Works with localStorage and direct Google Sheets integration.

---

## 3. 🎟️ Issuing Tickets

1. Open **Admin Portal** → Sign in with `admin@caipsd.org` / `Event@2211`.
2. **Single Participant**:
   - Click **Issue Ticket**.
   - Enter **Name**, **Email**, **Phone**, and **Duration (e.g. 2 Days)**.
   - Generates dedicated daily passes: `(Day 1 Pass)` and `(Day 2 Pass)`.
   - Optionally auto-emails the passes with embedded QR codes.
3. **Bulk Import**:
   - Paste a list of names (one per line) → Instantly generates passes for all participants.
   - Each participant is assigned a unique `group_id` so ticket codes never cross-leak.

---

## 4. 🚪 Entrance Gate Check-in Rules

- Open **Gate Check-in** (`⌗ Gate Check-in` on the portal).
- Use camera QR scanner or enter the 16-character Ticket ID.

### Security & Entry Rules:
1. **Day 1 Ticket on Day 1**: ✅ Allowed (`Entry allowed! Welcome`).
2. **Day 2 Ticket on Day 1**: ❌ Denied (`Day 2 Ticket! This ticket can only be used on Day 2`).
3. **Day 1 Ticket on Day 2**: ❌ Denied (`Day 1 Ticket! This ticket was only valid for Day 1`).
4. **Repeat scan on the same calendar day**: ❌ Denied (`Already used ticket!`).
5. **Rate Limiting**: Protected against brute force (600 scans / 5 mins).
6. **Privacy**: Public scanner responses never leak attendee emails or phone numbers.

---

## 5. 📊 Google Sheets Auto-Sync

- All tickets automatically sync in the background to the Google Sheet.
- Clicking **Live Sheet ↗** prompts for the password (`Event@2211`).
- The password is authenticated securely on the server before redirecting to the private spreadsheet URL.

---

## 6. 🛠️ Useful Commands

```bash
# Run automated tests (46 passing tests)
npm test

# Verify code syntax & rebuild static assets
npm run check

# Synchronize public/ to root for GitHub Pages
npm run build:static

# Reset admin credentials
node reset-admin.js
```
