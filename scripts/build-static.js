#!/usr/bin/env node
/**
 * Keeps the GitHub Pages copy (repo root) in sync with the server copy (public/).
 *   npm run build:static
 * public/ is the source of truth. This script rewrites absolute paths to relative ones
 * so the same pages also work from https://<user>.github.io/<repo>/ and from a file.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pub = path.join(root, 'public');

function toRelative(html) {
  return html
    .replace(/(href|src)="\/vendor\/html5-qrcode\/html5-qrcode\.min\.js"/g, '$1="assets/html5-qrcode.min.js"')
    .replace(/(href|src)="\/admin\.html"/g, '$1="index.html"')
    .replace(/(href|src)="\/assets\//g, '$1="assets/')
    .replace(/(href|src)="\/(ticket|404)\.html/g, '$1="$2.html');
}

const pages = [['admin.html', 'index.html'], ['ticket.html', 'ticket.html'], ['404.html', '404.html']];
for (const [from, to] of pages) {
  fs.writeFileSync(path.join(root, to), toRelative(fs.readFileSync(path.join(pub, from), 'utf8')));
}

fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
for (const file of fs.readdirSync(path.join(pub, 'assets'))) {
  fs.copyFileSync(path.join(pub, 'assets', file), path.join(root, 'assets', file));
}
console.log('Static site (index.html, ticket.html, 404.html, assets/) refreshed from public/.');
