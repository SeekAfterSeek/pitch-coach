/**
 * CDP 驱动脚本：启动 Chrome（远程调试）→ 打开 PitchCoach → 截图 → 执行诊断
 * 用法：node test/cdp.mjs [--url=...] [--out=...] [--evalFile=...]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.join('=') || true];
  })
);

const URL = args.url || 'http://127.0.0.1:8756/';
const OUT = args.out || path.join(process.cwd(), 'shot.png');
const PORT = Number(args.port || 9333);
const PROFILE = args.profile || path.join(os.tmpdir(), 'pc-cdp-' + Date.now());
const EXTRA = args.extra ? String(args.extra).split(',').filter(Boolean) : [];

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
].find((p) => fs.existsSync(p));

if (!CHROME) {
  console.error('Chrome not found');
  process.exit(1);
}

const chromeArgs = [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=Translate,MediaRouter',
  '--window-size=1500,950',
  '--hide-scrollbars',
  ...EXTRA,
  URL,
];

const proc = spawn(CHROME, chromeArgs, { detached: false, stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page' && t.url.includes('127.0.0.1'));
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* not ready */ }
    await sleep(250);
  }
  throw new Error('CDP not ready');
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('timeout: ' + method));
        }
      }, 30000);
    });
  }
}

const wsUrl = await getWsUrl();
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res);
  ws.addEventListener('error', rej);
});

const cdp = new CDP(ws);
await cdp.send('Runtime.enable');
await cdp.send('Log.enable');
await cdp.send('Page.enable');
await cdp.send('Console.enable');

await sleep(1800);

// 收集控制台错误
const logs = [];
async function drainLogs() {
  const evs = cdp.events.splice(0);
  for (const e of evs) {
    if (e.method === 'Runtime.exceptionThrown') {
      logs.push('EXCEPTION: ' + (e.params.exceptionDetails?.exception?.description
        || e.params.exceptionDetails?.text));
    } else if (e.method === 'Runtime.consoleAPICalled') {
      const txt = (e.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
      logs.push(`console.${e.params.type}: ${txt}`);
    } else if (e.method === 'Log.entryAdded') {
      logs.push(`log.${e.params.entry.level}: ${e.params.entry.text}`);
    }
  }
}

async function evaluate(expr) {
  const r = await cdp.send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  }
  return r.result.value;
}

async function shot(file, selector = null) {
  let clip = null;
  if (selector) {
    const box = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()`);
    if (box) clip = { ...box, scale: 1 };
  }
  const r = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    ...(clip ? { clip } : {}),
  });
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  return file;
}

/* ═════════ 执行 ═════════ */

const report = { url: URL, logs: [], checks: [], shots: [] };

try {
  await drainLogs();

  // 1. 基本加载
  const title = await evaluate('document.title');
  const ready = await evaluate('typeof window.__PC !== "undefined"');
  report.checks.push({ name: '页面标题', ok: title.includes('PitchCoach'), value: title });
  report.checks.push({ name: '应用初始化', ok: ready === true, value: ready });

  // 2. 模块与参考轨道
  const info = await evaluate(`(() => {
    const S = window.__PC.S;
    return {
      track: S.track?.title,
      refOk: !!S.ref,
      refDur: S.ref?.duration,
      refNotes: S.ref?.notes?.length,
      rollW: window.__PC.roll.w,
      rollH: window.__PC.roll.h,
      canvasW: document.getElementById('roll').width,
      tiles: document.querySelectorAll('.track-card').length,
    };
  })()`);
  report.checks.push({ name: '默认曲目已加载', ok: !!info.track, value: info.track });
  report.checks.push({ name: '参考轨道已构建', ok: info.refOk && info.refDur > 5, value: `${info.refDur?.toFixed(1)}s / ${info.refNotes} 音符` });
  report.checks.push({ name: '卷帘画布已就绪', ok: info.canvasW > 300, value: `${info.rollW}x${info.rollH} (canvas ${info.canvasW})` });
  report.checks.push({ name: '曲目条已渲染', ok: info.tiles >= 6, value: info.tiles });

  // 3. 渲染检查：卷帘是否真的画了东西（非纯背景）
  const painted = await evaluate(`(() => {
    const c = document.getElementById('roll');
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const colors = new Set();
    let nonBg = 0;
    for (let i = 0; i < d.length; i += 4 * 37) {
      colors.add(d[i] + ',' + d[i+1] + ',' + d[i+2]);
      if (d[i] > 40 || d[i+1] > 50 || d[i+2] > 60) nonBg++;
    }
    return { colors: colors.size, nonBg };
  })()`);
  report.checks.push({ name: '卷帘有实际绘制内容', ok: painted.colors > 5 && painted.nonBg > 50, value: `${painted.colors} 色 / ${painted.nonBg} 亮点` });

  // 4. 表盘渲染
  const gaugePainted = await evaluate(`(() => {
    const c = document.getElementById('gauge');
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let nz = 0;
    for (let i = 3; i < d.length; i += 4 * 29) if (d[i] > 10) nz++;
    return { nz, w: c.width, h: c.height };
  })()`);
  report.checks.push({ name: '表盘已绘制', ok: gaugePainted.nz > 100, value: `${gaugePainted.w}x${gaugePainted.h}, ${gaugePainted.nz} 不透明采样` });

  // 5. 视图切换
  await evaluate(`document.querySelector('[data-view="review"]').click()`);
  await sleep(400);
  const reviewVisible = await evaluate(`document.getElementById('view-review').classList.contains('active')`);
  report.checks.push({ name: '切换到复盘视图', ok: reviewVisible === true, value: reviewVisible });

  await evaluate(`document.querySelector('[data-view="library"]').click()`);
  await sleep(400);
  const libItems = await evaluate(`document.querySelectorAll('#allTracksList .lib-item').length`);
  report.checks.push({ name: '曲库列表渲染', ok: libItems >= 6, value: libItems });

  // 曲库搜索 / 筛选
  const libFilterWork = await evaluate(`(() => {
    const chip = document.querySelector('[data-libfilter="builtin"]');
    if (!chip) return { ok: false, reason: 'no chip' };
    chip.click();
    const afterBuiltin = document.querySelectorAll('#allTracksList .lib-item').length;
    document.querySelector('[data-libfilter="all"]').click();
    const afterAll = document.querySelectorAll('#allTracksList .lib-item').length;
    return { ok: afterAll >= afterBuiltin && afterBuiltin > 0, afterBuiltin, afterAll };
  })()`);
  report.checks.push({
    name: '曲库筛选可用',
    ok: libFilterWork.ok === true,
    value: `内置 ${libFilterWork.afterBuiltin} / 全部 ${libFilterWork.afterAll}`,
  });

  // 6. 设置抽屉
  await evaluate(`document.getElementById('btnSettings').click()`);
  await sleep(350);
  const drawerOpen = await evaluate(`document.getElementById('settingsDrawer').classList.contains('open')`);
  report.checks.push({ name: '设置抽屉可打开', ok: drawerOpen === true, value: drawerOpen });
  await evaluate(`document.getElementById('btnCloseSettings').click()`);
  await sleep(250);

  // 7. 帮助弹窗
  await evaluate(`document.getElementById('btnHelp').click()`);
  await sleep(300);
  const helpOpen = await evaluate(`document.getElementById('helpMask').classList.contains('open')`);
  report.checks.push({ name: '帮助弹窗可打开', ok: helpOpen === true, value: helpOpen });
  await evaluate(`document.getElementById('btnCloseHelp').click()`);
  await sleep(200);

  // 8. 回实时视图截图
  await evaluate(`document.querySelector('[data-view="live"]').click()`);
  await sleep(500);
  report.shots.push(await shot(path.join(path.dirname(OUT), 'live.png')));

  // 9. 注入一段"演唱"数据，验证评分与卷帘绘制
  const inject = await evaluate(`(async () => {
    const { S, roll } = window.__PC;
    const { scoreTake, SCORE_MODES } = await import('./js/reference.js');

    // 用参考旋律 + 少量偏差伪造一次演唱
    const ref = S.ref;
    const frames = [];
    for (let t = 0; t < ref.duration; t += 0.01) {
      const m = ref.at(t);
      if (m == null) { frames.push({ t, midi: 0, voiced: false, rms: 0.02 }); continue; }
      const dev = 0.18 + (Math.random() - 0.5) * 0.1;
      frames.push({ t, midi: m + dev, voiced: true, rms: 0.2 });
    }
    const score = scoreTake(ref, frames, { mode: SCORE_MODES.exact });

    // 画到卷帘
    const withBand = frames.map((f, i) => ({ ...f, band: score.bands[i] }));
    roll.setTake({ frames: withBand, offset: 0, phraseScores: score.phraseScores });
    roll.setReview(ref.duration);
    roll.draw();

    return {
      total: score.total,
      acc: score.pitchAccuracy,
      cov: score.coverage,
      meanSigned: score.meanSignedCents,
      phrases: score.phraseScores.length,
      bands: score.counts,
    };
  })()`);
  report.checks.push({
    name: '偏差 +18¢ 的演唱评分合理',
    ok: inject.total > 65 && inject.total < 95,
    value: `${inject.total} 分 (准音 ${(inject.acc * 100).toFixed(0)}%, 偏差 ${inject.meanSigned.toFixed(0)}¢)`,
  });
  report.checks.push({ name: '逐句分析已生成', ok: inject.phrases >= 3, value: inject.phrases });

  await sleep(300);
  report.shots.push(await shot(path.join(path.dirname(OUT), 'roll-injected.png'), '#view-live .roll-panel'));

  // 10. 完美演唱对比
  const perfect = await evaluate(`(async () => {
    const { S } = window.__PC;
    const { scoreTake, SCORE_MODES } = await import('./js/reference.js');
    const ref = S.ref;
    const frames = [];
    for (let t = 0; t < ref.duration; t += 0.01) {
      const m = ref.at(t);
      frames.push(m == null
        ? { t, midi: 0, voiced: false, rms: 0.02 }
        : { t, midi: m, voiced: true, rms: 0.2 });
    }
    const s = scoreTake(ref, frames, { mode: SCORE_MODES.exact });
    return { total: s.total, acc: s.pitchAccuracy };
  })()`);
  report.checks.push({ name: '完美演唱接近满分', ok: perfect.total > 95, value: `${perfect.total} 分` });

  // 11. 播放功能（无麦克风也能合成）
  await evaluate(`document.getElementById('btnPlay').click()`);
  await sleep(1200);
  const playingState = await evaluate(`(() => {
    const S = window.__PC.S;
    return { playing: S.playing, clock: S.clock ? S.clock() : null };
  })()`);
  report.checks.push({ name: '参考音播放启动', ok: playingState.playing === true, value: `时钟 ${playingState.clock?.toFixed(2)}s` });
  await evaluate(`window.__PC.stopPlayback()`);
  await sleep(300);

  await drainLogs();
} catch (e) {
  report.error = e.message;
  try { await drainLogs(); } catch { /* noop */ }
}

report.logs = logs;

// 截图
try {
  report.shots.push(await shot(OUT));
} catch (e) {
  report.shotError = e.message;
}

console.log(JSON.stringify(report, null, 2));

ws.close();
await sleep(200);
try { proc.kill(); } catch { /* noop */ }
// 清理 profile
try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* noop */ }
process.exit(report.error ? 1 : 0);
