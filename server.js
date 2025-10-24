import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 6969;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'notepad.txt');

// Ensure data directory exists
fs.mkdirSync(DATA_DIR, { recursive: true });

// Load initial content
let content = '';
try {
  content = fs.readFileSync(DATA_FILE, 'utf8');
} catch (e) {
  content = '';
}

/**
 * SSE client management
 */
const clients = new Set(); // each entry: { id, res }
let nextClientId = 1;

function sseSend(res, event, data) {
  if (event) res.write(`event: ${event}\n`);
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  res.write(`data: ${payload}\n\n`);
}

function broadcast(event, data) {
  for (const client of clients) {
    try {
      sseSend(client.res, event, data);
    } catch {
      // Ignore write errors; connection cleanup happens on 'close'
    }
  }
}

function handleSSE(req, res) {
  const id = nextClientId++;
  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(': connected\n\n');

  const client = { id, res };
  clients.add(client);

  // Send initial content immediately
  sseSend(res, 'content', { content });

  req.on('close', () => {
    clients.delete(client);
  });
}

function serveIndex(res) {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  fs.readFile(indexPath, (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Server error');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
}

function serveContent(res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ content }));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      // Basic guard: limit to ~5MB
      if (body.length > 5 * 1024 * 1024) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function handleSave(req, res) {
  try {
    const body = await parseBody(req);
    let text = '';
    const ct = req.headers['content-type'] || '';
    if (ct.includes('application/json')) {
      const parsed = JSON.parse(body || '{}');
      text = typeof parsed.content === 'string' ? parsed.content : '';
    } else if (ct.includes('text/plain')) {
      text = body;
    } else {
      // Fallback: try JSON first, else treat as raw
      try {
        const parsed = JSON.parse(body || '{}');
        text = typeof parsed.content === 'string' ? parsed.content : body;
      } catch {
        text = body;
      }
    }

    if (typeof text !== 'string') text = '';

    // Only write and broadcast if changed
    if (text !== content) {
      content = text;
      fs.writeFile(DATA_FILE, content, 'utf8', () => {});
      broadcast('content', { content });
    }

    res.writeHead(204);
    res.end();
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad Request');
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // CORS preflight simple support
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    return serveIndex(res);
  }
  if (req.method === 'GET' && url.pathname === '/events') {
    return handleSSE(req, res);
  }
  if (req.method === 'GET' && url.pathname === '/content') {
    return serveContent(res);
  }
  if (req.method === 'POST' && url.pathname === '/save') {
    return handleSave(req, res);
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Notepad listening at http://localhost:${PORT}`);
});

// Watch the file for external changes and broadcast updates
function startFileWatcher() {
  const FILE_NAME = path.basename(DATA_FILE);
  const DIR_NAME = path.dirname(DATA_FILE);

  // Track last self-write to avoid redundant reads immediately after /save
  let lastSelfWriteAt = 0;
  const SELF_WRITE_SILENCE_MS = 400; // within this window, ignore watcher events

  // Monkey-patch write to note self-writes (without changing behavior)
  const originalWriteFile = fs.writeFile;
  fs.writeFile = function patchedWriteFile(file, data, options, cb) {
    // Normalize optional args
    if (typeof options === 'function') {
      cb = options; // eslint-disable-line no-param-reassign
      options = undefined; // eslint-disable-line no-param-reassign
    }
    if (file === DATA_FILE) {
      lastSelfWriteAt = Date.now();
    }
    return originalWriteFile.call(fs, file, data, options, cb);
  };

  // Debounced reload from disk
  let debounceTimer = null;
  async function reloadFromDisk(reason) {
    // Ignore shortly after our own writes
    if (Date.now() - lastSelfWriteAt < SELF_WRITE_SILENCE_MS) return;
    let disk = '';
    try {
      disk = fs.readFileSync(DATA_FILE, 'utf8');
    } catch {
      // If deleted or unreadable, treat as empty
      disk = '';
    }
    if (disk !== content) {
      content = disk;
      broadcast('content', { content });
    }
  }

  function scheduleReload(reason) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => reloadFromDisk(reason), 120);
  }

  // 1) Polling watcher is very reliable across editors and atomic renames
  fs.watchFile(DATA_FILE, { interval: 300 }, (curr, prev) => {
    if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) {
      scheduleReload('stat-change');
    }
  });

  // 2) Event watcher on the directory to catch renames/creates/deletes
  try {
    const dirWatcher = fs.watch(DIR_NAME, (eventType, filename) => {
      if (filename && path.basename(filename) === FILE_NAME) {
        // Any rename/change affecting our file
        scheduleReload(`fswatch-${eventType}`);
      }
    });
    // If the directory watcher errors, we still have watchFile as a safety net
    dirWatcher.on('error', () => {/* ignore */});
  } catch {
    // If fs.watch fails (rare), the polling watcher remains in effect
  }
}

startFileWatcher();
