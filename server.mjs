#!/usr/bin/env node
/**
 * PitchCoach 本地静态服务器（零依赖）
 * - 提供 web/ 目录
 * - 默认端口 8756，被占用时自动 +1
 * - 用 Google Chrome 打开 http://127.0.0.1:<port>/
 *
 * 为什么需要服务器：Chrome 只在安全上下文（https / localhost）下给 getUserMedia 麦克风权限，
 * 直接双击 index.html 用 file:// 打开拿不到麦克风。
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.webm': 'audio/webm',
  '.mid': 'audio/midi',
  '.midi': 'audio/midi',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res, code, body, headers = {}) {
  res.writeHead(code, {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    let pathname = decodeURIComponent(u.pathname);
    if (pathname === '/') pathname = '/index.html';

    const filePath = path.normalize(path.join(ROOT, pathname));
    if (!filePath.startsWith(ROOT)) return send(res, 403, 'forbidden');

    const stat = await fsp.stat(filePath).catch(() => null);
    if (!stat || !stat.isFile()) return send(res, 404, 'not found: ' + pathname);

    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';

    if (stat.size > 4 * 1024 * 1024) {
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': stat.size,
        'Cache-Control': 'no-store',
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    const data = await fsp.readFile(filePath);
    send(res, 200, data, {
      'Content-Type': type,
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
    });
  } catch (err) {
    send(res, 500, 'server error: ' + err.message);
  }
});

function findChrome() {
  const candidates = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  ];
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c; } catch { /* noop */ }
  }
  return null;
}

function listen(port, attempt = 0) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 20) {
      listen(port + 1, attempt + 1);
    } else {
      console.error('[pitch-coach] 启动失败:', err.message);
      process.exit(1);
    }
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log('');
    console.log('  🎤 PitchCoach 练唱音准教练');
    console.log('  ─────────────────────────────');
    console.log('  地址: ' + url);
    console.log('  目录: ' + ROOT);
    console.log('');
    console.log('  按 Ctrl+C 停止');
    console.log('');
    if (process.env.PC_NO_OPEN !== '1' && attempt === 0) {
      const chrome = findChrome();
      if (chrome) {
        spawn(chrome, [url], { detached: true, stdio: 'ignore' }).unref();
        console.log('  已在 Google Chrome 中打开');
      } else {
        console.log('  未找到 Google Chrome，请手动打开上面的地址');
      }
    }
  });
}

const port = Number(process.env.PC_PORT || process.argv[2] || 8756);
listen(port);
