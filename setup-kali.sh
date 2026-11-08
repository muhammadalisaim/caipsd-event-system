#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js and npm are required. Install Node.js 18.18+ first, then run this script again."
  exit 1
fi

node -e "const [major, minor] = process.versions.node.split('.').map(Number); if (major < 18 || (major === 18 && minor < 18)) { console.error('Node.js 18.18 or later is required. Current version: ' + process.versions.node); process.exit(1); }"

if [[ ! -f .env ]]; then
  echo "Create your first CAIPSD administrator account."
  read -r -p "Admin email [admin@caipsd.org]: " ADMIN_EMAIL_INPUT
  ADMIN_EMAIL_INPUT="${ADMIN_EMAIL_INPUT:-admin@caipsd.org}"
  ADMIN_PASSWORD_INPUT="$(node -e "process.stdout.write(require('crypto').randomBytes(24).toString('base64url'))")"
  SESSION_SECRET="$(node -e "process.stdout.write(require('crypto').randomBytes(48).toString('hex'))")"
  umask 077
  cat > .env <<ENVVARS
PORT=3000
NODE_ENV=development
SESSION_SECRET=${SESSION_SECRET}
ADMIN_EMAIL=${ADMIN_EMAIL_INPUT}
ADMIN_PASSWORD=${ADMIN_PASSWORD_INPUT}
TICKET_VALID_DAYS=3
# To email tickets from your mailbox, add SMTP_USER and SMTP_PASS (see README) and restart.
ENVVARS
  echo
  echo "Created .env with a private administrator account. Save these credentials now:"
  echo "Admin email:    ${ADMIN_EMAIL_INPUT}"
  echo "Admin password: ${ADMIN_PASSWORD_INPUT}"
  echo
else
  echo "Using the existing .env configuration."
fi

mkdir -p data
npm install

echo
echo "Setup complete. Start the CAIPSD app with:"
echo "  npm start"
echo
echo "Ticket portal:        http://localhost:3000"
