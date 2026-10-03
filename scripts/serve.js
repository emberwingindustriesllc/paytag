#!/usr/bin/env node
/*
 * Zero-dependency static file server for local development.
 *
 * PayTag has no build step, so this just serves the repo root over HTTP so you
 * can test wallet connection against a real origin (http://localhost counts as
 * a secure context, so the clipboard API works in development).
 *
 * Usage: npm start   (optionally PORT=8080 npm start)
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT) || 4321;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

function send(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(url.parse(req.url).pathname || '/');
  } catch (e) {
    return send(res, 400, 'Bad request');
  }

  if (pathname === '/') pathname = '/index.html';

  // Resolve inside ROOT only — refuse anything that escapes via ../
  const target = path.resolve(ROOT, '.' + pathname);
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
    return send(res, 403, 'Forbidden');
  }

  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      return send(res, 404, 'Not found: ' + pathname);
    }
    const type = TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    fs.createReadStream(target).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log('PayTag dev server  ->  http://localhost:' + PORT);
  console.log('Ctrl+C to stop.');
});