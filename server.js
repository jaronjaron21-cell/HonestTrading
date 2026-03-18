#!/usr/bin/env node

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const ROOT_DIR = __dirname;
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT_DIR, 'data');
const STORE_PATH = path.join(DATA_DIR, 'storage.json');
const PORT = Number(process.env.PORT || 4173);
const MAX_BODY_BYTES = 20 * 1024 * 1024;
const AUTH_ENABLED = String(process.env.AUTH_ENABLED || 'true').toLowerCase() === 'true';

const AUTH_USERNAME = String(process.env.APP_USERNAME || 'HT-Admin');
const AUTH_PASSWORD = String(process.env.APP_PASSWORD || 'smw08083');
const SESSION_COOKIE_NAME = String(process.env.SESSION_COOKIE_NAME || 'cts_session');
const SESSION_MAX_AGE_SEC = Number(process.env.SESSION_MAX_AGE_SEC || 60 * 60 * 24 * 7);
const DEFAULT_LOGIN_REDIRECT = '/shopify-page.html';

const sessions = new Map();

const DEFAULT_STORE = {
  asin_master: null,
  asin_warehouse: null,
  sqp_keywords: null,
  sqp_warehouse: null,
  sqp_import_audit: null,
  sqp_week_cache: null,
  updated_at: null
};

const ALLOWED_STORE_KEYS = new Set([
  'asin_master',
  'asin_warehouse',
  'sqp_keywords',
  'sqp_warehouse',
  'sqp_import_audit',
  'sqp_week_cache'
]);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8'
};

function logStorageConfiguration() {
  const resolvedDataDir = path.resolve(DATA_DIR);
  const resolvedStorePath = path.resolve(STORE_PATH);
  const nodeEnv = String(process.env.NODE_ENV || '').toLowerCase();

  console.log(`[storage] DATA_DIR=${resolvedDataDir}`);
  console.log(`[storage] STORAGE_PATH=${resolvedStorePath}`);

  if (nodeEnv === 'production' && resolvedDataDir !== '/data') {
    console.warn('[storage] WARNING: NODE_ENV=production but DATA_DIR is not /data. Volume persistence may be misconfigured.');
  }
}

function ensureStoreFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(STORE_PATH)) {
    fs.writeFileSync(STORE_PATH, JSON.stringify(DEFAULT_STORE, null, 2), 'utf8');
  }
}

function readStore() {
  ensureStoreFile();
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...DEFAULT_STORE };
    }
    return { ...DEFAULT_STORE, ...parsed };
  } catch (error) {
    return { ...DEFAULT_STORE };
  }
}

function writeStore(store) {
  ensureStoreFile();
  const payload = JSON.stringify(store, null, 2);
  const tempPath = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tempPath, payload, 'utf8');
  fs.renameSync(tempPath, STORE_PATH);
}

function sendJson(res, statusCode, payload, extraHeaders) {
  const body = JSON.stringify(payload);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...(extraHeaders || {})
  };
  res.writeHead(statusCode, headers);
  res.end(body);
}

function sendText(res, statusCode, text, extraHeaders) {
  const body = String(text || '');
  const headers = {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...(extraHeaders || {})
  };
  res.writeHead(statusCode, headers);
  res.end(body);
}

function sendHtml(res, statusCode, html, extraHeaders) {
  const body = String(html || '');
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    ...(extraHeaders || {})
  };
  res.writeHead(statusCode, headers);
  res.end(body);
}

function sendRedirect(res, location, statusCode, extraHeaders) {
  const headers = {
    Location: location,
    'Cache-Control': 'no-store',
    ...(extraHeaders || {})
  };
  res.writeHead(statusCode || 302, headers);
  res.end('');
}

function secureEquals(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch (error) {
    return false;
  }
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function collapseWhitespace(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function parseCookies(req) {
  const raw = String((req && req.headers && req.headers.cookie) || '');
  const result = {};
  if (!raw) return result;

  raw.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx <= 0) return;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!key) return;
    try {
      result[key] = decodeURIComponent(value);
    } catch (error) {
      result[key] = value;
    }
  });

  return result;
}

function buildSetCookie(name, value, req, maxAgeSec) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push('Path=/');
  parts.push('HttpOnly');
  parts.push('SameSite=Lax');

  if (Number.isFinite(maxAgeSec)) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`);
  }

  const forwardedProto = String((req && req.headers && req.headers['x-forwarded-proto']) || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const isSecure = forwardedProto === 'https' || !!(req && req.socket && req.socket.encrypted);
  if (isSecure) parts.push('Secure');

  return parts.join('; ');
}

function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (!session || !session.expiresAt || session.expiresAt <= now) {
      sessions.delete(token);
    }
  }
}

function createSession(username) {
  cleanupExpiredSessions();
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_MAX_AGE_SEC * 1000;
  sessions.set(token, {
    username: String(username || ''),
    createdAt: Date.now(),
    expiresAt
  });
  return token;
}

function getSessionFromRequest(req) {
  cleanupExpiredSessions();
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token) return null;

  const session = sessions.get(token);
  if (!session) return null;
  if (!session.expiresAt || session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }

  return {
    token,
    username: session.username,
    expiresAt: session.expiresAt
  };
}

function destroySession(token) {
  if (!token) return;
  sessions.delete(token);
}

function normalizeStoreKey(key) {
  const text = String(key || '').trim().toLowerCase();
  return text.replace(/[^a-z0-9_]/g, '_');
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });

    req.on('error', reject);
  });
}

function sanitizePathname(pathname) {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (error) {
    decoded = pathname;
  }

  if (decoded === '/') {
    if (fs.existsSync(path.join(ROOT_DIR, 'shopify-page.html'))) return '/shopify-page.html';
    if (fs.existsSync(path.join(ROOT_DIR, 'index.html'))) return '/index.html';
    return '/';
  }

  const normalized = path.posix.normalize(decoded).replace(/^\/+/, '');
  if (!normalized || normalized.startsWith('..')) return null;
  return `/${normalized}`;
}

function isApiRequest(pathname) {
  return String(pathname || '').startsWith('/api/');
}

function normalizeNextPath(rawNext) {
  const fallback = DEFAULT_LOGIN_REDIRECT;
  const input = String(rawNext || '').trim();
  if (!input) return fallback;
  if (input[0] !== '/' || input.startsWith('//')) return fallback;

  try {
    const parsed = new URL(input, 'http://localhost');
    const normalizedPath = path.posix.normalize(parsed.pathname || '/');
    if (!normalizedPath.startsWith('/')) return fallback;
    if (normalizedPath.startsWith('/login') || normalizedPath.startsWith('/auth/')) return fallback;
    return normalizedPath + (parsed.search || '');
  } catch (error) {
    return fallback;
  }
}

function renderLoginPage(nextPath, hasError) {
  const safeNext = escapeHtml(nextPath || DEFAULT_LOGIN_REDIRECT);
  const errorHtml = hasError
    ? "<div class='cts-login-error'>Invalid username or password.</div>"
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>HonestTrading Login</title>
  <link rel="icon" type="image/svg+xml" href="/assets/honesty-favicon.svg" />
  <link rel="shortcut icon" href="/assets/honesty-favicon.svg" />
  <style>
    :root {
      --bg: #e9eefc;
      --card: #ffffff;
      --ink: #10213f;
      --muted: #677a9d;
      --line: #d8e2f5;
      --primary: #2759dd;
      --primary-2: #1f4fcf;
      --primary-soft: #eff4ff;
      --danger-bg: #ffecef;
      --danger-line: #f2b7c2;
      --danger-text: #9a3448;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Inter", "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--ink);
      padding: 26px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .cts-login-shell {
      width: min(1240px, 100%);
      min-height: min(760px, calc(100vh - 52px));
      border-radius: 28px;
      overflow: hidden;
      display: grid;
      grid-template-columns: minmax(0, 1.1fr) minmax(360px, 0.9fr);
      background: var(--card);
      border: 1px solid var(--line);
      box-shadow: 0 34px 72px rgba(33, 53, 101, 0.2);
    }

    .cts-login-left {
      position: relative;
      overflow: hidden;
      color: #f5f9ff;
      padding: 56px 52px 44px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      background:
        radial-gradient(1200px 540px at -10% -4%, rgba(255, 255, 255, 0.18), transparent 52%),
        radial-gradient(880px 420px at 100% 0%, rgba(104, 148, 255, 0.34), transparent 58%),
        linear-gradient(145deg, #153aa6 0%, #2056d8 45%, #2e67eb 100%);
      border-right: 1px solid rgba(255, 255, 255, 0.15);
    }

    .cts-login-left::before {
      content: "";
      position: absolute;
      inset: 0;
      background:
        radial-gradient(180% 80% at 24% 110%, rgba(4, 23, 85, 0.44), transparent 70%),
        repeating-radial-gradient(
          circle at 8% 80%,
          transparent 0 58px,
          rgba(255, 255, 255, 0.09) 58px 61px
        );
      pointer-events: none;
    }

    .cts-login-brand {
      margin: 0;
      font-size: 42px;
      line-height: 1.05;
      letter-spacing: -0.02em;
      font-weight: 800;
      text-wrap: balance;
    }

    .cts-login-sub {
      margin: 0;
      max-width: 500px;
      font-size: 34px;
      line-height: 1.08;
      font-weight: 700;
      letter-spacing: -0.01em;
      color: rgba(245, 249, 255, 0.95);
      text-wrap: balance;
    }

    .cts-login-copy {
      margin: 0;
      max-width: 460px;
      color: rgba(242, 248, 255, 0.86);
      font-size: 28px;
      line-height: 1.34;
      font-weight: 500;
    }

    .cts-login-foot {
      position: relative;
      z-index: 1;
      font-size: 14px;
      color: rgba(239, 246, 255, 0.8);
      letter-spacing: 0.01em;
    }

    .cts-login-right {
      background: #ffffff;
      padding: clamp(26px, 3.8vw, 56px);
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .cts-login-card {
      width: min(420px, 100%);
      display: grid;
      gap: 18px;
    }

    .cts-login-card-brand {
      margin: 0;
      font-size: 26px;
      font-weight: 800;
      letter-spacing: -0.01em;
    }

    .cts-login-error {
      background: var(--danger-bg);
      border: 1px solid var(--danger-line);
      color: var(--danger-text);
      border-radius: 12px;
      font-size: 14px;
      padding: 10px 12px;
      font-weight: 600;
    }

    .cts-login-title {
      margin: 6px 0 2px;
      font-size: 46px;
      line-height: 1.02;
      letter-spacing: -0.02em;
      font-weight: 800;
      color: #091837;
      text-wrap: balance;
    }

    .cts-login-desc {
      margin: 0 0 8px;
      color: var(--muted);
      font-size: 15px;
      line-height: 1.45;
    }

    .cts-login-form {
      display: grid;
      gap: 14px;
    }

    .cts-login-field {
      display: grid;
      gap: 8px;
    }

    .cts-login-label {
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #607295;
    }

    .cts-login-input {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 12px;
      height: 52px;
      padding: 0 14px;
      font-size: 18px;
      font-family: inherit;
      color: #0f2144;
      outline: none;
      transition: border-color .16s ease, box-shadow .16s ease, background-color .16s ease;
      background: #ffffff;
    }

    .cts-login-input:focus {
      border-color: var(--primary);
      box-shadow: 0 0 0 3px rgba(39, 89, 221, 0.2);
      background: var(--primary-soft);
    }

    .cts-login-btn {
      margin-top: 6px;
      width: 100%;
      height: 54px;
      border: 0;
      border-radius: 12px;
      background: linear-gradient(145deg, var(--primary), var(--primary-2));
      color: #ffffff;
      font-size: 18px;
      font-family: inherit;
      font-weight: 700;
      letter-spacing: 0.01em;
      cursor: pointer;
      transition: transform .14s ease, filter .14s ease;
    }

    .cts-login-btn:hover,
    .cts-login-btn:focus-visible {
      filter: brightness(1.04);
      transform: translateY(-1px);
      outline: none;
    }

    .cts-login-note {
      margin: 0;
      text-align: center;
      color: var(--muted);
      font-size: 13px;
    }

    @media (max-width: 920px) {
      body {
        padding: 0;
      }

      .cts-login-shell {
        width: 100%;
        min-height: 100vh;
        border-radius: 0;
        grid-template-columns: 1fr;
      }

      .cts-login-left {
        min-height: 320px;
        padding: 32px 26px;
      }

      .cts-login-brand {
        font-size: 34px;
      }

      .cts-login-sub {
        font-size: 28px;
      }

      .cts-login-copy {
        font-size: 22px;
      }

      .cts-login-right {
        padding: 26px;
      }
    }
  </style>
</head>
<body>
  <div class="cts-login-shell">
    <section class="cts-login-left">
      <p class="cts-login-foot">© ${new Date().getUTCFullYear()} HonestTrading. All rights reserved.</p>
    </section>

    <section class="cts-login-right">
      <div class="cts-login-card">
        <p class="cts-login-card-brand">HonestTrading</p>
        <h2 class="cts-login-title">Welcome Back!</h2>
        ${errorHtml}
        <form class="cts-login-form" method="post" action="/auth/login">
          <input type="hidden" name="next" value="${safeNext}" />
          <label class="cts-login-field">
            <span class="cts-login-label">Username</span>
            <input class="cts-login-input" type="text" name="username" autocomplete="username" required />
          </label>
          <label class="cts-login-field">
            <span class="cts-login-label">Password</span>
            <input class="cts-login-input" type="password" name="password" autocomplete="current-password" required />
          </label>
          <button class="cts-login-btn" type="submit">Login Now</button>
        </form>
        <p class="cts-login-note">Restricted access for approved team members.</p>
      </div>
    </section>
  </div>
</body>
</html>`;
}

function isPublicRoute(pathname) {
  const route = String(pathname || '');
  return route === '/api/health'
    || route === '/login'
    || route === '/auth/login'
    || route === '/auth/logout';
}

function handleAuthRoutes(req, res, urlObj) {
  const pathname = String(urlObj.pathname || '');

  if (!AUTH_ENABLED) {
    if (pathname === '/login' || pathname === '/auth/login' || pathname === '/auth/logout') {
      sendRedirect(res, DEFAULT_LOGIN_REDIRECT, 302);
      return true;
    }
    return false;
  }

  if (pathname === '/login') {
    if (req.method !== 'GET') {
      sendText(res, 405, 'Method Not Allowed');
      return true;
    }

    const session = getSessionFromRequest(req);
    const nextPath = normalizeNextPath(urlObj.searchParams.get('next'));
    if (session) {
      sendRedirect(res, nextPath, 302);
      return true;
    }

    const hasError = String(urlObj.searchParams.get('error') || '') === '1';
    sendHtml(res, 200, renderLoginPage(nextPath, hasError));
    return true;
  }

  if (pathname === '/auth/login') {
    if (req.method !== 'POST') {
      sendText(res, 405, 'Method Not Allowed');
      return true;
    }

    readRequestBody(req).then((rawBody) => {
      const contentType = String(req.headers['content-type'] || '').toLowerCase();
      const acceptHeader = String(req.headers.accept || '').toLowerCase();
      const wantsJson = acceptHeader.includes('application/json') || contentType.includes('application/json');

      let username = '';
      let password = '';
      let nextRaw = '';

      if (contentType.includes('application/json')) {
        const payload = rawBody ? JSON.parse(rawBody) : {};
        username = collapseWhitespace(payload && payload.username);
        password = String(payload && payload.password || '');
        nextRaw = String(payload && payload.next || '');
      } else {
        const form = new URLSearchParams(rawBody || '');
        username = collapseWhitespace(form.get('username'));
        password = String(form.get('password') || '');
        nextRaw = String(form.get('next') || '');
      }

      const nextPath = normalizeNextPath(nextRaw || urlObj.searchParams.get('next'));
      const ok = secureEquals(username, AUTH_USERNAME) && secureEquals(password, AUTH_PASSWORD);

      if (!ok) {
        if (wantsJson) {
          sendJson(res, 401, { ok: false, error: 'Invalid username or password.' });
          return;
        }
        sendRedirect(res, `/login?error=1&next=${encodeURIComponent(nextPath)}`, 303);
        return;
      }

      const token = createSession(AUTH_USERNAME);
      const setCookie = buildSetCookie(SESSION_COOKIE_NAME, token, req, SESSION_MAX_AGE_SEC);

      if (wantsJson) {
        sendJson(res, 200, { ok: true, redirect: nextPath }, { 'Set-Cookie': setCookie });
        return;
      }

      sendRedirect(res, nextPath, 303, { 'Set-Cookie': setCookie });
    }).catch((error) => {
      sendJson(res, 400, { ok: false, error: error.message || 'Invalid login payload.' });
    });

    return true;
  }

  if (pathname === '/auth/logout') {
    const cookies = parseCookies(req);
    const token = cookies[SESSION_COOKIE_NAME];
    if (token) destroySession(token);

    const clearCookie = buildSetCookie(SESSION_COOKIE_NAME, '', req, 0);
    const nextPath = normalizeNextPath(urlObj.searchParams.get('next'));

    if (isApiRequest(pathname)) {
      sendJson(res, 200, { ok: true, redirect: '/login' }, { 'Set-Cookie': clearCookie });
      return true;
    }

    sendRedirect(res, `/login?next=${encodeURIComponent(nextPath)}`, 303, {
      'Set-Cookie': clearCookie
    });
    return true;
  }

  return false;
}

function enforceAuth(req, res, urlObj) {
  if (!AUTH_ENABLED) return false;
  if (isPublicRoute(urlObj.pathname)) return false;

  const session = getSessionFromRequest(req);
  if (session) return false;

  if (isApiRequest(urlObj.pathname)) {
    sendJson(res, 401, { ok: false, error: 'Authentication required.' });
    return true;
  }

  const nextPath = normalizeNextPath((urlObj.pathname || '/') + (urlObj.search || ''));
  sendRedirect(res, `/login?next=${encodeURIComponent(nextPath)}`, 302);
  return true;
}

function handleApi(req, res, urlObj) {
  if (urlObj.pathname === '/api/health') {
    if (req.method !== 'GET') {
      sendText(res, 405, 'Method Not Allowed');
      return true;
    }
    sendJson(res, 200, { ok: true, status: 'healthy' });
    return true;
  }

  if (!urlObj.pathname.startsWith('/api/storage')) {
    return false;
  }

  const store = readStore();
  const keyPart = urlObj.pathname.slice('/api/storage'.length).replace(/^\/+/, '');

  if (!keyPart) {
    if (req.method !== 'GET') {
      sendText(res, 405, 'Method Not Allowed');
      return true;
    }
    sendJson(res, 200, { ok: true, data: store });
    return true;
  }

  const storeKey = normalizeStoreKey(keyPart);
  if (!storeKey) {
    sendJson(res, 400, { ok: false, error: 'Invalid store key.' });
    return true;
  }
  if (!ALLOWED_STORE_KEYS.has(storeKey)) {
    sendJson(res, 400, { ok: false, error: 'Unsupported store key.' });
    return true;
  }

  if (req.method === 'GET') {
    const value = Object.prototype.hasOwnProperty.call(store, storeKey) ? store[storeKey] : null;
    sendJson(res, 200, {
      ok: true,
      key: storeKey,
      data: value,
      updated_at: store.updated_at || null
    });
    return true;
  }

  if (req.method === 'PUT') {
    readRequestBody(req).then((rawBody) => {
      let payload = {};
      if (rawBody.trim()) {
        payload = JSON.parse(rawBody);
      }

      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        sendJson(res, 400, { ok: false, error: 'Body must be a JSON object with a data property.' });
        return;
      }

      if (!Object.prototype.hasOwnProperty.call(payload, 'data')) {
        sendJson(res, 400, { ok: false, error: 'Missing data field.' });
        return;
      }

      const nextStore = { ...store };
      nextStore[storeKey] = payload.data;
      nextStore.updated_at = new Date().toISOString();
      writeStore(nextStore);

      sendJson(res, 200, {
        ok: true,
        key: storeKey,
        data: nextStore[storeKey],
        updated_at: nextStore.updated_at
      });
    }).catch((error) => {
      sendJson(res, 400, { ok: false, error: error.message || 'Invalid request body.' });
    });
    return true;
  }

  sendText(res, 405, 'Method Not Allowed');
  return true;
}

function handleStatic(req, res, urlObj) {
  const safePath = sanitizePathname(urlObj.pathname);
  if (!safePath) {
    sendText(res, 400, 'Bad Request');
    return;
  }

  const absolutePath = path.join(ROOT_DIR, safePath);
  if (!absolutePath.startsWith(ROOT_DIR)) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  fs.stat(absolutePath, (statError, stat) => {
    if (statError || !stat || !stat.isFile()) {
      sendText(res, 404, 'Not Found');
      return;
    }

    const ext = path.extname(absolutePath).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': 'no-store'
    });

    const stream = fs.createReadStream(absolutePath);
    stream.on('error', () => {
      sendText(res, 500, 'Internal Server Error');
    });
    stream.pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (handleAuthRoutes(req, res, urlObj)) return;
  if (enforceAuth(req, res, urlObj)) return;
  if (handleApi(req, res, urlObj)) return;

  handleStatic(req, res, urlObj);
});

server.listen(PORT, () => {
  ensureStoreFile();
  logStorageConfiguration();
  console.log(`CTS reporting server running at http://127.0.0.1:${PORT}`);
});
