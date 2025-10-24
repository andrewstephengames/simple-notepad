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
      // Write to disk and, after write completes, update the watcher's snapshot
      fs.writeFile(DATA_FILE, content, 'utf8', (err) => {
        // best-effort: update the watcher snapshot so we don't treat this as an external change
        try {
          fileWatcher && typeof fileWatcher.setLastSavedContent === 'function' && fileWatcher.setLastSavedContent(content);
        } catch {}
      });
      // Broadcast to clients immediately (in-memory is authoritative until disk proves otherwise)
      broadcast('content', { content });
    }

    res.writeHead(204);
    res.end();
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad Request');
  }
}

function serveText(res) {
  // Return the persisted text/plain content on disk. If read fails, return empty body.
  fs.readFile(DATA_FILE, 'utf8', (err, data) => {
    if (err) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(data);
  });
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
  if (req.method === 'GET' && url.pathname === '/text') {
    return serveText(res);
  }
  if (req.method === 'POST' && url.pathname === '/save') {
    return handleSave(req, res);
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Notepad listening at http://0.0.0.0:${PORT}`);
});

// Watch the file for external changes and broadcast updates.
// This implementation avoids monkey-patching and instead uses a snapshot
// of the last content we wrote (`lastSavedContent`) to suppress self-writes,
// combines `fs.watch` + `fs.watchFile` + directory watch, and debounces events.
function startFileWatcher() {
  const FILE_NAME = path.basename(DATA_FILE);
  const DIR_NAME = path.dirname(DATA_FILE);

  // Snapshot of the last content we intentionally saved to disk.
  // Updated by handleSave when we write to disk.
  let lastSavedContent = content;

  // Debounce timer
  let debounceTimer = null;
  function scheduleReload(reason) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => reloadFromDisk(reason), 120);
  }

  function reloadFromDisk(reason) {
    let disk = '';
    try {
      disk = fs.readFileSync(DATA_FILE, 'utf8');
    } catch {
      disk = '';
    }

    // If the disk content equals what we last saved, ignore (self-write).
    if (disk === lastSavedContent) return;

    // If the disk content is different from in-memory content, update and broadcast.
    if (disk !== content) {
      content = disk;
      lastSavedContent = disk;
      broadcast('content', { content });
    }
  }

  // Always use polling as a reliable baseline (works with atomic rename editors)
  try {
    fs.watchFile(DATA_FILE, { interval: 300 }, (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) {
        scheduleReload('stat-change');
      }
    });
  } catch (e) {
    // If watchFile fails (very rare), we still try other watchers below
  }

  // Watch the file directly if possible (faster notifications)
  try {
    let fileWatcher = fs.watch(DATA_FILE, (eventType) => {
      // eventType: 'change' or 'rename'
      scheduleReload(`file-${eventType}`);
      // If file was renamed/replaced, attempt to re-establish the watcher
      if (eventType === 'rename') {
        // Close old watcher and re-open after short delay
        try { fileWatcher.close(); } catch {}
        setTimeout(() => {
          try { fileWatcher = fs.watch(DATA_FILE, (t) => scheduleReload(`file-${t}`)); } catch {}
        }, 200);
      }
    });
    fileWatcher.on('error', () => { /* ignore - fallback to watchFile */ });
  } catch (e) {
    // Ignore - fallback to watchFile and dir watch
  }

  // Watch the directory for create/delete/rename events that affect the file
  try {
    const dirWatcher = fs.watch(DIR_NAME, (eventType, filename) => {
      if (filename && path.basename(filename) === FILE_NAME) {
        scheduleReload(`dir-${eventType}`);
      }
    });
    dirWatcher.on('error', () => {/* ignore */});
  } catch (e) {
    // ignore
  }

  // Expose a small helper to allow the save handler to tell the watcher what we wrote.
  return {
    setLastSavedContent(text) { lastSavedContent = text; }
  };
}

const fileWatcher = startFileWatcher();
