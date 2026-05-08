const http     = require('http');
const { spawn }= require('child_process');
const fs       = require('fs');
const path     = require('path');
const { randomUUID } = require('crypto');

const PORT      = process.env.PORT || 3847;
const DOWNLOADS = path.join(__dirname, '..', 'downloads');
const YTDLP     = '/opt/homebrew/bin/yt-dlp';
const FFMPEG    = '/opt/homebrew/bin/ffmpeg';
// Change to 'safari' or 'firefox' if you don't use Chrome
const BROWSER   = 'chrome';

fs.mkdirSync(DOWNLOADS, { recursive: true });

// token → { path, name, created }
const pendingFiles = new Map();

// Clean up stale tokens after 10 min (files stay on disk)
setInterval(() => {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [token, entry] of pendingFiles)
    if (entry.created < cutoff) pendingFiles.delete(token);
}, 60_000);

function isYouTubeUrl(raw) {
  try {
    const u = new URL(raw);
    return ['youtube.com','www.youtube.com','youtu.be','m.youtube.com','music.youtube.com']
      .includes(u.hostname);
  } catch { return false; }
}

function sendSSE(res, obj) {
  try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (_) {}
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Serve the app ────────────────────────────────────────────────
  if (u.pathname === '/') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(500); res.end('Cannot read index.html');
    }
    return;
  }

  // ── Serve JS and CSS files ───────────────────────────────────────
  if (u.pathname.endsWith('.js') || u.pathname.endsWith('.css')) {
    const filePath = path.join(__dirname, u.pathname);
    try {
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath);
        const ext = u.pathname.endsWith('.css') ? 'text/css' : 'text/javascript';
        res.writeHead(200, { 'Content-Type': `${ext}; charset=utf-8` });
        res.end(data);
        return;
      }
    } catch (e) {
      // pass
    }
  }

  // ── Serve icons ───────────────────────────────────────────────────
  const icons = ['/favicon.png', '/favicon.ico', '/favicon-16x16.png', '/favicon-32x32.png', '/apple-touch-icon.png', '/android-chrome-192x192.png', '/android-chrome-512x512.png'];
  if (icons.includes(u.pathname)) {
    const iconPath = path.join(__dirname, 'icons', u.pathname.slice(1));
    try {
      const img = fs.readFileSync(iconPath);
      const ext = u.pathname.endsWith('.ico') ? 'image/x-icon' : 'image/png';
      res.writeHead(200, { 'Content-Type': ext });
      res.end(img);
    } catch {
      res.writeHead(404); res.end();
    }
    return;
  }

  // ── Search  GET /search?q=<query> ───────────────────────────────
  if (u.pathname === '/search') {
    const query = (u.searchParams.get('q') || '').trim();
    if (!query) { res.writeHead(400); res.end('[]'); return; }

    const proc = spawn(YTDLP, [
      `ytsearch8:${query}`,
      '--flat-playlist', '--no-warnings',
      '--print', '%(id)s\t%(title)s\t%(duration_string)s\t%(uploader)s',
    ]);

    let out = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.on('close', () => {
      const results = out.trim().split('\n').filter(Boolean).map(line => {
        const [id, title, duration, channel] = line.split('\t');
        return { id, title: title || '', duration: duration || '', channel: channel || '',
                 thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(results));
    });
    proc.on('error', () => { res.writeHead(500); res.end('[]'); });
    return;
  }

  // ── SSE download  GET /download?url=<youtube-url> ────────────────
  if (u.pathname === '/download') {
    const ytUrl = u.searchParams.get('url') || '';

    if (!isYouTubeUrl(ytUrl)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid YouTube URL' }));
      return;
    }

    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    });

    const reqId       = randomUUID().replace(/-/g, '').slice(0, 12);
    const outTemplate = path.join(DOWNLOADS, `sr_${reqId}_%(title)s.%(ext)s`);

    let finished = false; // guard against req 'close' killing a completed proc

    const proc = spawn(YTDLP, [
      '-f', 'bestaudio/best',
      '-x', '--audio-format', 'mp3', '--audio-quality', '0',
      '--ffmpeg-location', FFMPEG,
      '--no-playlist', '--newline',
      '--cookies-from-browser', BROWSER,
      '-o', outTemplate,
      ytUrl,
    ]);

    const progressRe = /\[download\]\s+([\d.]+)%\s+of\s+\S+\s+at\s+(\S+)\s+ETA\s+(\S+)/;
    let stdoutBuf = '';

    proc.stdout.on('data', data => {
      stdoutBuf += data.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop();
      for (const line of lines) {
        const m = line.match(progressRe);
        if (m) sendSSE(res, { type: 'progress', percent: parseFloat(m[1]), speed: m[2], eta: m[3] });
      }
    });

    let stderrBuf = '';
    proc.stderr.on('data', d => { stderrBuf += d.toString(); });

    proc.on('error', err => {
      finished = true;
      const msg = err.code === 'ENOENT'
        ? `yt-dlp not found at ${YTDLP}`
        : err.message;
      sendSSE(res, { type: 'error', message: msg });
      res.end();
    });

    proc.on('close', code => {
      finished = true;

      if (code !== 0) {
        // Clean up partial files
        try {
          fs.readdirSync(DOWNLOADS)
            .filter(f => f.startsWith(`sr_${reqId}_`))
            .forEach(f => fs.unlink(path.join(DOWNLOADS, f), () => {}));
        } catch (_) {}
        const errLine = stderrBuf.split('\n').find(l => l.includes('ERROR'))
          || `yt-dlp exited with code ${code}`;
        sendSSE(res, { type: 'error', message: errLine.replace(/^.*ERROR:\s*/, '') });
        res.end();
        return;
      }

      // Find the finished mp3 — pattern: sr_<reqId>_<title>.mp3
      const files = fs.readdirSync(DOWNLOADS).filter(f => f.startsWith(`sr_${reqId}_`) && f.endsWith('.mp3'));
      if (files.length === 0) {
        sendSSE(res, { type: 'error', message: 'mp3 not found after download — ffmpeg may have failed' });
        res.end();
        return;
      }

      const finalName = files[0].replace(`sr_${reqId}_`, '').replace(/_/g, ' ');
      const finalPath = path.join(DOWNLOADS, files[0]);
      const token     = randomUUID();
      pendingFiles.set(token, { path: finalPath, name: finalName, created: Date.now() });

      sendSSE(res, { type: 'done', token, name: finalName });
      setTimeout(() => res.end(), 200);
    });

    // Only kill proc if client disconnects before download finishes
    req.on('close', () => { if (!finished) try { proc.kill(); } catch (_) {} });
    return;
  }

  // ── List downloads  GET /files ───────────────────────────────────
  if (u.pathname === '/files') {
    try {
      const entries = fs.readdirSync(DOWNLOADS)
        .filter(f => f.endsWith('.mp3'))
        .map(f => {
          const filePath = path.join(DOWNLOADS, f);
          let size;
          try { size = fs.statSync(filePath).size; } catch { return null; }
          // Strip the sr_<12hex>_ prefix added during download, restore spaces
          const displayName = /^sr_[0-9a-f]{12}_/.test(f)
            ? f.replace(/^sr_[0-9a-f]{12}_/, '').replace(/_/g, ' ')
            : f;
          const token = randomUUID();
          pendingFiles.set(token, { path: filePath, name: displayName, created: Date.now() });
          return { name: displayName, size, token };
        })
        .filter(Boolean);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(entries));
    } catch (e) {
      res.writeHead(500); res.end('[]');
    }
    return;
  }

  // ── Delete a file  DELETE /file?name=<displayName> ──────────────
  if (u.pathname === '/file' && req.method === 'DELETE') {
    const displayName = (u.searchParams.get('name') || '').trim();
    if (!displayName) { res.writeHead(400); res.end('missing name'); return; }
    try {
      const files = fs.readdirSync(DOWNLOADS).filter(f => f.endsWith('.mp3'));
      const match = files.find(f => {
        const dn = /^sr_[0-9a-f]{12}_/.test(f)
          ? f.replace(/^sr_[0-9a-f]{12}_/, '').replace(/_/g, ' ')
          : f;
        return dn === displayName;
      });
      if (!match) { res.writeHead(404); res.end('not found'); return; }
      fs.unlinkSync(path.join(DOWNLOADS, match));
      res.writeHead(204); res.end();
    } catch (e) {
      res.writeHead(500); res.end(e.message);
    }
    return;
  }

  // ── Serve audio by token  GET /file/<token> ──────────────────────
  if (u.pathname.startsWith('/file/')) {
    const token = u.pathname.slice(6);
    const entry = pendingFiles.get(token);
    if (!entry) { res.writeHead(404); res.end('Not found or expired'); return; }

    let stat;
    try { stat = fs.statSync(entry.path); }
    catch { res.writeHead(500); res.end('File missing on disk'); return; }

    res.writeHead(200, {
      'Content-Type':        'audio/mpeg',
      'Content-Length':      stat.size,
      'Content-Disposition': `inline; filename="${encodeURIComponent(entry.name)}"`,
    });
    fs.createReadStream(entry.path).pipe(res);
    res.on('finish', () => pendingFiles.delete(token));
    return;
  }

  res.writeHead(404); res.end();
});

server.listen(PORT, () => {
  console.log(`\n  Slowcort  →  http://localhost:${PORT}\n`);
  if (!fs.existsSync(YTDLP))  console.warn('  ⚠  yt-dlp not found  →  brew install yt-dlp');
  if (!fs.existsSync(FFMPEG)) console.warn('  ⚠  ffmpeg not found   →  brew install ffmpeg');
  console.log('');
});
