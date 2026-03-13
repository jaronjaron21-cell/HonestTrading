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
const AUTH_USERNAME = String(process.env.APP_USERNAME || 'HonestTrading');
const AUTH_PASSWORD = String(process.env.APP_PASSWORD || 'smw08083');
const AUTH_REALM = String(process.env.AUTH_REALM || 'HonestTrading');

const DEFAULT_STORE = {
  asin_master: null,
  asin_warehouse: null,
  sqp_keywords: null,
  sqp_warehouse: null,
  sqp_import_audit: null,
  updated_at: null
};
const ALLOWED_STORE_KEYS = new Set([
  'asin_master',
  'asin_warehouse',
  'sqp_keywords',
  'sqp_warehouse',
  'sqp_import_audit'
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

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(text);
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

function parseBasicAuthHeader(headerValue) {
  const raw = String(headerValue || '');
  if (!raw) return null;
  const parts = raw.split(/\s+/);
  if (parts.length < 2 || String(parts[0]).toLowerCase() !== 'basic') return null;

  let decoded = '';
  try {
    decoded = Buffer.from(parts[1], 'base64').toString('utf8');
  } catch (error) {
    return null;
  }
  const sepIndex = decoded.indexOf(':');
  if (sepIndex < 0) return null;

  return {
    username: decoded.slice(0, sepIndex),
    password: decoded.slice(sepIndex + 1)
  };
}

function isAuthenticatedRequest(req, urlObj) {
  if (urlObj.pathname === '/api/health') return true;
  const credentials = parseBasicAuthHeader(req.headers.authorization);
  if (!credentials) return false;
  return secureEquals(credentials.username, AUTH_USERNAME)
    && secureEquals(credentials.password, AUTH_PASSWORD);
}

function sendAuthChallenge(req, res, urlObj) {
  const isApiRequest = String(urlObj.pathname || '').startsWith('/api/');
  if (isApiRequest) {
    sendJson(res, 401, { ok: false, error: 'Authentication required.' });
    return;
  }
  res.writeHead(401, {
    'WWW-Authenticate': `Basic realm="${AUTH_REALM}", charset="UTF-8"`,
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end('Authentication required.');
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

  if (!isAuthenticatedRequest(req, urlObj)) {
    sendAuthChallenge(req, res, urlObj);
    return;
  }

  if (handleApi(req, res, urlObj)) return;
  handleStatic(req, res, urlObj);
});

server.listen(PORT, () => {
  ensureStoreFile();
  console.log(`CTS reporting server running at http://127.0.0.1:${PORT}`);
});
