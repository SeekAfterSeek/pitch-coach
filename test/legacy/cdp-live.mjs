/**
 * 端到端实时链路验证：用 Chrome 假麦克风喂入「演唱」音频，
 * 走完整 getUserMedia → AnalyserNode → YIN → 实时比对 → 录音 → 评分 → 排行
 *
 * 用法：node test/cdp-live.mjs --wav=path/to/sing.wav
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.join('=') || true];
  })
);

const URL = args.url || 'http://127.0.0.1:8756/';
const WAV = path.resolve(args.wav || path.join(__dirname, '..', 'samples', 'fake-mic-scale.wav'));
const PORT = Number(args.port || 9334);
const OUTDIR = path.resolve(args.outdir || path.join(__dirname, '..', 'shots'));
const PROFILE = path.join(os.tmpdir(), 'pc-live-' + Date.now());

if (!fs.existsSync(WAV)) {
  console.error('missing wav: ' + WAV);
  process.exit(1);
}

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => fs.existsSync(p));

const chromeArgs = [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--window-size=1500,950',
  '--hide-scrollbars',
  // 假麦克风：把 wav 当作麦克风输入
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  `--use-file-for-fake-audio-capture=${WAV}`,
  '--autoplay-policy=no-user-gesture-required',
  URL,
];

const proc = spawn(CHROME, chromeArgs, { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWs() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const p = list.find((t) => t.type === 'page' && t.url.includes('127.0.0.1'));
      if (p?.webSocketDebuggerUrl) return p.webSocketDebuggerUrl;
    } catch { /* wait */ }
    await sleep(250);
  }
  throw new Error('CDP not ready');
}

const wsUrl = await getWs();
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res);
  ws.addEventListener('error', rej);
});

let msgId = 0;
const pending = new Map();
const events = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  } else if (m.method) events.push(m);
});

function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)); }
    }, 40000);
  });
}

async function evaluate(expr) {
  const r = await send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true, userGesture: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  }
  return r.result.value;
}

async function shot(name, selector) {
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
  const r = await send('Page.captureScreenshot', {
    format: 'png',
    ...(clip ? { clip } : {}),
  });
  const f = path.join(OUTDIR, name);
  fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
  return f;
}

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await sleep(2000);

const report = { checks: [], logs: [], shots: [], trace: [] };

function check(name, ok, value) {
  report.checks.push({ name, ok: !!ok, value });
}

try {
  // ── 1. 开启麦克风 ──
  await evaluate(`document.getElementById('btnMic').click()`);
  await sleep(2500);

  const micState = await evaluate(`(() => {
    const S = window.__PC.S;
    return {
      micOn: S.micOn,
      hasStream: !!S.engine.stream,
      tracks: S.engine.stream ? S.engine.stream.getAudioTracks().length : 0,
      label: S.engine.stream?.getAudioTracks?.()[0]?.label || '',
      sampleRate: S.engine.sampleRate,
      ctxState: S.engine.ctx?.state,
      detector: !!S.engine.detector,
      latency: S.settings.latencyMs,
    };
  })()`);
  check('麦克风已连接', micState.micOn && micState.hasStream, `${micState.tracks} 轨 / ${micState.sampleRate}Hz / ${micState.ctxState}`);
  check('AudioContext 已运行', micState.ctxState === 'running', micState.ctxState);
  check('检测器已实例化', micState.detector === true, micState.detector);

  // ── 2. 等几秒，看是否真的检测到音高 ──
  const t0 = Date.now();
  let sawVoiced = false;
  let maxConf = 0;
  const hzSamples = [];
  for (let i = 0; i < 24; i++) {
    await sleep(250);
    const f = await evaluate(`(() => {
      const S = window.__PC.S;
      const fr = S.engine.frame;
      return fr ? { t: fr.t, midi: fr.midi, hz: fr.hz, conf: fr.confidence, rms: fr.rms, voiced: fr.voiced } : null;
    })()`);
    if (f) {
      maxConf = Math.max(maxConf, f.conf || 0);
      if (f.voiced && f.hz > 0) {
        sawVoiced = true;
        hzSamples.push(f.hz);
      }
      report.trace.push({ ...f, hz: f.hz ? Number(f.hz.toFixed(1)) : 0, midi: f.midi ? Number(f.midi.toFixed(2)) : 0 });
    }
  }

  check('从假麦克风检测到音高', sawVoiced, sawVoiced
    ? `${hzSamples.length} 次有声 / 最高置信度 ${maxConf.toFixed(2)}`
    : '未检测到 — 检查假麦克风参数');

  if (hzSamples.length) {
    const lo = Math.min(...hzSamples);
    const hi = Math.max(...hzSamples);
    check('音高在合理人声范围', lo > 100 && hi < 1100, `${lo.toFixed(0)}–${hi.toFixed(0)} Hz`);
  }

  // ── 3. 实时统计是否在累积 ──
  // 注意：这一步还没点"播放参考"，所以处于调音模式，得分栏应显示"调音"而非数字。
  const stats = await evaluate(`(() => {
    const el = document.getElementById('liveScore');
    return {
      scoreText: el.textContent.trim(),
      coachText: document.getElementById('coachText').textContent,
      meterW: document.getElementById('micMeter').style.width,
      gaugeHasNote: document.getElementById('gauge') ? true : false,
    };
  })()`);
  check('未播放时明确显示"调音"模式（不是空白/破折号）',
    stats.scoreText === '调音', `显示「${stats.scoreText}」`);
  check('电平表有响应', parseFloat(stats.meterW) > 1, stats.meterW);
  report.coachSample = stats.coachText;

  await shot('live-mic.png');

  // ── 4. 播放参考 + 录音，完整走一遍 ──
  await evaluate(`window.__PC.selectTrack('scale-c')`);
  await sleep(400);
  await evaluate(`document.getElementById('btnPlay').click()`);
  await sleep(600);
  await evaluate(`document.getElementById('btnRec').click()`);
  report.recordingStarted = await evaluate(`window.__PC.S.recording`);

  // 录 8 秒
  for (let i = 0; i < 8; i++) {
    await sleep(1000);
    const s = await evaluate(`(() => {
      const S = window.__PC.S;
      return {
        songT: S.clock ? Number(S.clock().toFixed(2)) : null,
        frames: S.recFrames.length,
        score: document.getElementById('liveScore').textContent,
        acc: document.getElementById('liveAccuracy').textContent,
        coach: document.getElementById('coachText').textContent,
        hist: S.histBins.reduce((a,b)=>a+b,0),
      };
    })()`);
    report.trace.push({ phase: 'rec', sec: i + 1, ...s });
  }

  await shot('live-recording.png', '#view-live .roll-panel');

  const recState = await evaluate(`(() => {
    const S = window.__PC.S;
    return { frames: S.recFrames.length, songT: S.clock ? S.clock() : null };
  })()`);
  check('录音帧在累积', recState.frames > 300, `${recState.frames} 帧 @ songT ${recState.songT?.toFixed(1)}s`);

  // 停止录音
  await evaluate(`document.getElementById('btnRec').click()`);
  await sleep(2500);

  const takeSaved = await evaluate(`(async () => {
    const S = window.__PC.S;
    return {
      takes: S.takes.length,
      view: S.view,
      selected: S.selectedTake,
      recSec: (S.takes[0]?.duration || 0).toFixed(1),
      total: document.getElementById('rsTotal').textContent,
      acc: document.getElementById('rsAcc').textContent,
      cover: document.getElementById('rsCover').textContent,
      dev: document.getElementById('rsDev').textContent,
      phrases: document.querySelectorAll('#phraseGrid .phrase-cell').length,
      notes: document.querySelectorAll('#coachNotes li').length,
      notesText: [...document.querySelectorAll('#coachNotes li')].map(l => l.textContent),
    };
  })()`);
  check('录音已保存', takeSaved.takes >= 1, `${takeSaved.takes} 条`);
  check('自动跳转复盘视图', takeSaved.view === 'review', takeSaved.view);
  check('复盘显示总分', takeSaved.total !== '—', `总分 ${takeSaved.total} / 准音 ${takeSaved.acc} / 覆盖 ${takeSaved.cover} / 偏差 ${takeSaved.dev}`);
  check('逐句热力图已生成', takeSaved.phrases >= 2,
    `${takeSaved.phrases} 段（录音 ${takeSaved.recSec}，2 秒一段）`);
  check('诊断建议已生成', takeSaved.notes >= 2, `${takeSaved.notes} 条`);
  report.coachNotes = takeSaved.notesText;

  await sleep(500);
  await shot('review.png');

  // ── 5. 再录一条（故意差一点）验证排行 ──
  await evaluate(`document.querySelector('[data-view="live"]').click()`);
  await sleep(400);
  await evaluate(`document.getElementById('btnPlay').click()`);
  await sleep(300);
  await evaluate(`document.getElementById('btnRec').click()`);
  await sleep(6000);
  await evaluate(`document.getElementById('btnRec').click()`);
  await sleep(2500);

  const rank = await evaluate(`(() => {
    const S = window.__PC.S;
    const items = [...document.querySelectorAll('#takeList .take-item')].map(el => ({
      score: el.querySelector('.take-score')?.textContent?.trim(),
      badge: el.querySelector('.take-badge')?.textContent?.trim() || '',
      info: el.querySelector('.take-info small')?.textContent?.trim(),
    }));
    return { count: S.takes.length, items };
  })()`);
  check('两条以上录音可排序', rank.count >= 2, `${rank.count} 条`);
  check('标记了最准的一条', rank.items.some((i) => i.badge === '最准'),
    rank.items.map((i) => `${i.score}分${i.badge ? '(' + i.badge + ')' : ''}`).join(' / '));

  await shot('review-rank.png');

  // ── 6. 控制台错误 ──
  const errs = events.filter((e) =>
    e.method === 'Runtime.exceptionThrown'
    || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
  );
  report.logs = errs.map((e) =>
    e.params.exceptionDetails?.exception?.description
    || e.params.exceptionDetails?.text
    || e.params.entry?.text
  );
  check('无 JS 运行时错误', report.logs.length === 0, report.logs.slice(0, 2).join(' | ') || '无');

} catch (e) {
  report.error = e.message;
  try { await shot('error.png'); } catch { /* noop */ }
}

const failed = report.checks.filter((c) => !c.ok);
console.log(JSON.stringify({
  summary: `${report.checks.length - failed.length}/${report.checks.length} 通过`,
  failed: failed.map((f) => `${f.name}: ${f.value}`),
  checks: report.checks,
  coachNotes: report.coachNotes,
  coachSample: report.coachSample,
  logs: report.logs,
  shots: report.shots,
  error: report.error,
}, null, 2));

// 存完整 trace 供分析
fs.writeFileSync(path.join(OUTDIR, 'live-trace.json'), JSON.stringify(report, null, 2));

ws.close();
await sleep(200);
try { proc.kill(); } catch { /* noop */ }
try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* noop */ }
process.exit(failed.length || report.error ? 1 : 0);
