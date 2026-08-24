#!/usr/bin/env node
/*
 * dev-proxy.mjs
 *
 * Single local origin in front of the API (4000) and frontend (5173), so a
 * single ngrok tunnel exposes both — one public URL for the SDK's
 * `apiBaseUrl` and `webviewBaseUrl` (same host, different paths) instead of
 * two independent tunnels that can die independently of each other.
 *
 * Routing is a fixed path-prefix list matching backend/src/app.ts's mounts
 * (/docs, /auth, /sdk, /surface, /agent, /admin) plus /socket.io for the
 * realtime chat connection; everything else — the built frontend,
 * /embed/support — goes to the frontend server. Update PROXY_API_PREFIXES if
 * app.ts ever mounts a new top-level route.
 */
import http from 'node:http';
import httpProxy from 'http-proxy';

const PROXY_PORT = Number(process.env.DEV_PROXY_PORT ?? 8787);
const API_TARGET = `http://localhost:${process.env.API_PORT ?? 4000}`;
const WEB_TARGET = `http://localhost:${process.env.WEB_PORT ?? 5173}`;
const API_PREFIXES = ['/docs', '/auth', '/sdk', '/surface', '/agent', '/admin', '/socket.io'];

const proxy = httpProxy.createProxyServer({ ws: true });
proxy.on('error', (err, _req, res) => {
  console.error('[dev-proxy] upstream error:', err.message);
  if (res && !res.headersSent && 'writeHead' in res) {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('dev-proxy: upstream unavailable');
  }
});

const targetFor = (url) =>
  API_PREFIXES.some((prefix) => url === prefix || url.startsWith(`${prefix}/`))
    ? API_TARGET
    : WEB_TARGET;

const server = http.createServer((req, res) => {
  proxy.web(req, res, { target: targetFor(req.url ?? '/') });
});

// Socket.io's realtime connection upgrades to a WebSocket — must be proxied too.
server.on('upgrade', (req, socket, head) => {
  proxy.ws(req, socket, head, { target: targetFor(req.url ?? '/') });
});

server.listen(PROXY_PORT, () => {
  console.log(`[dev-proxy] listening on :${PROXY_PORT} -> api=${API_TARGET} web=${WEB_TARGET}`);
});
