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
import { spawn, spawnSync } from 'node:child_process';
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
  '.opus': 'audio/ogg',
  '.wma': 'audio/x-ms-wma',
  '.ape': 'audio/x-ape',
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

    // ── API：扫描本地音乐目录 ──
    if (pathname === '/api/scan') {
      return await handleScan(u, res);
    }
    // ── API：流式读取本地音频（供浏览器导入）──
    if (pathname === '/api/file') {
      return await handleFileStream(u, res);
    }
    // ── API：人声分离（调用 python + demucs）──
    if (pathname === '/api/separate/status') {
      return await handleSeparateStatus(res);
    }
    if (pathname === '/api/separate' && req.method === 'POST') {
      return await handleSeparate(req, res);
    }
    if (pathname === '/api/separate/job') {
      return await handleSeparateJob(u, res);
    }
    if (pathname === '/api/separate/file') {
      return await handleSeparateFileStream(u, res);
    }
    // ── API：歌词搜索（代理 lrclib.net，避免浏览器跨域）──
    if (pathname === '/api/lyrics/search') {
      return await handleLyricsSearch(u, res);
    }

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

/* ══════════ 本地音乐库扫描 ══════════ */

const AUDIO_EXT = new Set([
  '.mp3', '.flac', '.ogg', '.wav', '.m4a', '.aac', '.wma', '.opus', '.ape',
]);
// QQ 音乐/网易云的加密格式后缀，扫到时提示需要转换
const ENCRYPTED_EXT = new Set([
  '.mflac', '.mflac0', '.mgg', '.mgg1', '.mgg0', '.qmc0', '.qmc2', '.qmc3',
  '.qmcflac', '.qmcogg', '.tkm', '.bkcmp3', '.bkcflac', '.ncm', '.kwm',
]);

const DEFAULT_ROOTS = [
  process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Music') : null,
  process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Music', 'VipSongsDownload') : null,
  process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Downloads') : null,
  process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Desktop') : null,
].filter(Boolean);

/** 递归扫描，带深度与数量上限，避免卡死 */
async function walk(dir, opts, state) {
  if (state.count >= opts.maxFiles) return;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (state.count >= opts.maxFiles) return;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (state.depth >= opts.maxDepth) continue;
      if (/^(node_modules|\.git|\$RECYCLE\.BIN|System Volume Information)$/i.test(e.name)) continue;
      state.depth++;
      await walk(full, opts, state);
      state.depth--;
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      const isAudio = AUDIO_EXT.has(ext);
      const isEnc = ENCRYPTED_EXT.has(ext);
      if (!isAudio && !isEnc) continue;
      let size = 0;
      try { size = (await fsp.stat(full)).size; } catch { continue; }
      state.count++;
      state.items.push({
        path: full,
        name: e.name,
        ext,
        size,
        encrypted: isEnc,
        mtime: 0,
      });
    }
  }
}

async function handleScan(u, res) {
  const custom = u.searchParams.get('dir');
  const roots = custom ? [custom] : DEFAULT_ROOTS;
  const maxDepth = Number(u.searchParams.get('depth') || 4);
  const maxFiles = Number(u.searchParams.get('limit') || 3000);

  const state = { count: 0, depth: 0, items: [] };
  const opts = { maxDepth, maxFiles };

  for (const r of roots) {
    const st = await fsp.stat(r).catch(() => null);
    if (st && st.isDirectory()) {
      await walk(r, opts, state);
    }
  }

  // 按文件名排序
  state.items.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

  send(res, 200, JSON.stringify({
    roots,
    scanned: state.count,
    encrypted: state.items.filter((i) => i.encrypted).length,
    items: state.items,
  }), { 'Content-Type': 'application/json; charset=utf-8' });
}

/** 流式返回本地绝对路径的音频（限制在允许的根目录内，防路径穿越） */
async function handleFileStream(u, res) {
  const p = u.searchParams.get('path');
  if (!p) return send(res, 400, 'missing path');

  const resolved = path.resolve(p);

  // 安全：只允许读音频文件，且必须在用户目录内
  const userHome = (process.env.USERPROFILE || '').toLowerCase();
  const lower = resolved.toLowerCase();
  if (userHome && !lower.startsWith(userHome)) {
    return send(res, 403, 'path outside user home');
  }
  const ext = path.extname(resolved).toLowerCase();
  if (!AUDIO_EXT.has(ext)) {
    return send(res, 403, 'not an audio file: ' + ext);
  }

  const stat = await fsp.stat(resolved).catch(() => null);
  if (!stat || !stat.isFile()) return send(res, 404, 'not found');

  const type = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(resolved).pipe(res);
}

/* ══════════ 人声分离（Demucs 桥接） ══════════ */

const SEPARATE_OUT = path.join(__dirname, '.separated');
// 分离任务表：id → {状态, 进度日志, 输出文件, 错误}
const sepJobs = new Map();

/** 找到可用的 python（优先 DSH 自带运行时） */
function findPython() {
  const cands = [
    process.env.PC_PYTHON,
    process.env.DSH_PYTHON,
    'C:\\Users\\Lenovo\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe',
    'python',
    'python3',
  ].filter(Boolean);
  for (const c of cands) {
    try {
      if (c.includes('\\') || c.includes('/')) {
        if (fs.existsSync(c)) return c;
      } else {
        return c; // 交给 PATH
      }
    } catch { /* noop */ }
  }
  return null;
}

let sepCapability = null;
async function detectSeparateCapability() {
  if (sepCapability) return sepCapability;
  const py = findPython();
  if (!py) {
    sepCapability = { available: false, reason: '找不到 Python', python: null };
    return sepCapability;
  }
  try {
    const r = spawnSync(py, ['-c', 'import torch, demucs; print("ok")'], {
      timeout: 20000,
      encoding: 'utf8',
      windowsHide: true,
    });
    const ok = (r.stdout || '').includes('ok');
    sepCapability = {
      available: ok,
      python: py,
      reason: ok ? '' : '未安装 demucs/torch（pip install demucs torch）',
    };
  } catch (e) {
    sepCapability = { available: false, python: py, reason: e.message };
  }
  return sepCapability;
}

async function handleSeparateStatus(res) {
  const cap = await detectSeparateCapability();
  send(res, 200, JSON.stringify({
    ...cap,
    // CPU 上大约是 2-4 倍实时
    estimateNote: 'CPU 分离约为音频时长的 2-4 倍，4 分钟歌需要 10-20 分钟',
  }), { 'Content-Type': 'application/json; charset=utf-8' });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

async function handleSeparate(req, res) {
  const cap = await detectSeparateCapability();
  if (!cap.available) {
    return send(res, 503, JSON.stringify({
      ok: false,
      error: '人声分离不可用：' + cap.reason,
    }), { 'Content-Type': 'application/json; charset=utf-8' });
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return send(res, 400, JSON.stringify({ ok: false, error: 'bad json' }));
  }

  const src = body.path;
  if (!src) return send(res, 400, JSON.stringify({ ok: false, error: 'missing path' }));

  const resolved = path.resolve(src);
  const userHome = (process.env.USERPROFILE || '').toLowerCase();
  if (userHome && !resolved.toLowerCase().startsWith(userHome)) {
    return send(res, 403, JSON.stringify({ ok: false, error: 'path outside user home' }));
  }
  const st = await fsp.stat(resolved).catch(() => null);
  if (!st || !st.isFile()) {
    return send(res, 404, JSON.stringify({ ok: false, error: 'file not found' }));
  }

  const jobId = crypto.randomBytes(6).toString('hex');
  const outDir = path.join(SEPARATE_OUT, jobId);
  await fsp.mkdir(outDir, { recursive: true });

  const job = {
    id: jobId,
    status: 'running',
    log: [],
    startedAt: Date.now(),
    vocals: null,
    error: null,
    srcName: path.basename(resolved),
  };
  sepJobs.set(jobId, job);

  // 异步跑 demucs，立刻返回 jobId
  const py = cap.python;
  const proc = spawn(py, [
    '-m', 'demucs',
    '--two-stems', 'vocals',
    '-n', 'htdemucs',
    '--mp3',
    '-o', outDir,
    resolved,
  ], { windowsHide: true });

  const pushLog = (line) => {
    const s = String(line).trim();
    if (!s) return;
    job.log.push(s);
    if (job.log.length > 200) job.log.splice(0, 100);
    // 解析 demucs 的进度百分比
    const m = /(\d+)%/.exec(s);
    if (m) job.progress = Number(m[1]);
  };

  proc.stdout.on('data', (d) => d.toString().split(/\r?\n/).forEach(pushLog));
  proc.stderr.on('data', (d) => d.toString().split(/\r?\n/).forEach(pushLog));

  proc.on('close', async (code) => {
    if (code !== 0) {
      job.status = 'failed';
      job.error = 'demucs 退出码 ' + code;
      return;
    }
    // 找 vocals 文件
    const found = await findVocals(outDir);
    if (!found) {
      job.status = 'failed';
      job.error = '没找到 vocals 输出';
      return;
    }
    job.vocals = found;
    job.status = 'done';
  });

  proc.on('error', (e) => {
    job.status = 'failed';
    job.error = e.message;
  });

  send(res, 200, JSON.stringify({ ok: true, jobId }), {
    'Content-Type': 'application/json; charset=utf-8',
  });
}

async function findVocals(dir) {
  let result = null;
  async function walk(d) {
    let ents;
    try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (/^vocals\.(mp3|wav|flac|ogg)$/i.test(e.name)) result = full;
    }
  }
  await walk(dir);
  return result;
}

/** 查询分离任务进度 */
async function handleSeparateJob(u, res) {
  const id = u.searchParams.get('id');
  const job = sepJobs.get(id);
  if (!job) {
    return send(res, 404, JSON.stringify({ ok: false, error: 'job not found' }), {
      'Content-Type': 'application/json; charset=utf-8',
    });
  }
  send(res, 200, JSON.stringify({
    ok: true,
    id: job.id,
    status: job.status,
    progress: job.progress ?? 0,
    elapsedSec: Math.round((Date.now() - job.startedAt) / 1000),
    srcName: job.srcName,
    error: job.error,
    logTail: job.log.slice(-6),
  }), { 'Content-Type': 'application/json; charset=utf-8' });
}

async function handleSeparateFileStream(u, res) {
  const jobId = u.searchParams.get('job');
  const job = sepJobs.get(jobId);
  if (!job || !job.vocals) return send(res, 404, 'not ready');
  const stat = await fsp.stat(job.vocals).catch(() => null);
  if (!stat) return send(res, 404, 'gone');
  const ext = path.extname(job.vocals).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(job.vocals).pipe(res);
}

/* ══════════ 歌词搜索（代理 lrclib.net） ══════════ */

const LRCLIB = 'https://lrclib.net';
const LYRICS_UA = 'PitchCoach/1.0 (https://github.com/SeekAfterSeek/pitch-coach)';

async function handleLyricsSearch(u, res) {
  const title = (u.searchParams.get('title') || '').trim();
  const artist = (u.searchParams.get('artist') || '').trim();

  if (!title && !artist) {
    return send(res, 400, JSON.stringify({ ok: false, error: '缺少 title/artist' }), {
      'Content-Type': 'application/json; charset=utf-8',
    });
  }

  const json = (obj) => send(res, 200, JSON.stringify(obj), {
    'Content-Type': 'application/json; charset=utf-8',
  });

  try {
    const results = [];

    // 策略 1：先试精确接口（要求歌名歌手完全一致，命中率低但最准）
    if (title && artist) {
      try {
        const url = `${LRCLIB}/api/get?` + new URLSearchParams({
          track_name: title, artist_name: artist,
        });
        const r = await fetch(url, {
          headers: { 'User-Agent': LYRICS_UA },
          signal: AbortSignal.timeout(12000),
        });
        if (r.ok) {
          const one = await r.json();
          if (one && (one.syncedLyrics || one.plainLyrics)) results.push(one);
        }
      } catch { /* 精确接口不中很正常 */ }
    }

    // 策略 2：分别用几种组合搜索，合并去重
    const queries = [];
    if (title && artist) queries.push(`${title} ${artist}`);
    if (title) queries.push(title);

    const seen = new Set(results.map((x) => x.id));
    for (const q of queries) {
      try {
        const url = `${LRCLIB}/api/search?` + new URLSearchParams({ q });
        const r = await fetch(url, {
          headers: { 'User-Agent': LYRICS_UA },
          signal: AbortSignal.timeout(15000),
        });
        if (!r.ok) continue;
        const arr = await r.json();
        if (!Array.isArray(arr)) continue;
        for (const it of arr) {
          if (it?.id && !seen.has(it.id)) {
            seen.add(it.id);
            results.push(it);
          }
        }
      } catch { /* 单个查询失败不影响其它 */ }
      // 已经有足够候选就不再多查
      if (results.length >= 25) break;
    }

    json({ ok: true, count: results.length, results });
  } catch (e) {
    json({ ok: false, error: e.message, results: [] });
  }
}

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
