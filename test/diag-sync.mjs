/**
 * 诊断「练唱逐字提示跟不上节奏 / 原声回放亮格错位」：
 * 验证 unify 时基 —— 录音帧时间从 t0 起算（不是绝对 ctx.currentTime），
 * 与 MediaRecorder 录下的音频（也从按下录音起算）同轴。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const URL_ = 'http://127.0.0.1:8756/';
const PORT = 9355;
const PROFILE = path.join(os.tmpdir(), 'pc-sync-' + Date.now());
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => fs.existsSync(p));
const proc = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', URL_,
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getWsUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const p = (await r.json()).find((t) => t.type === 'page');
      if (p?.webSocketDebuggerUrl) return p.webSocketDebuggerUrl;
    } catch {}
    await sleep(300);
  }
  throw new Error('CDP not ready');
}
const ws = new WebSocket(await getWsUrl());
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
let id = 0; const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
});
function send(method, params = {}) {
  const i = ++id; ws.send(JSON.stringify({ id: i, method, params }));
  return new Promise((res) => pending.set(i, res));
}
const evalr = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) return { __exception: r.exceptionDetails.exception?.description };
  return r.result?.value;
};
await send('Runtime.enable');
await sleep(2500);

const N = (spec) => { const a = []; for (const [m, s, e] of spec) for (let t = s; t < e; t += 0.02) a.push({ t, midi: m, voiced: m > 0, rms: 0.2, confidence: 0.9 }); return JSON.stringify(a); };
const REF = N([[60,0,0.5],[62,0.5,1],[64,1,1.5],[65,1.5,2],[67,3,3.5],[69,3.5,4],[71,4,4.5]]);

await evalr(`window.__STUDIO.commitReferenceFrames(${REF})`);
await evalr(`window.__STUDIO.confirmLyrics()`);
// 延迟 0.4s 开口的完美清唱（无自动对齐会怎样 / 有对齐会怎样）
const DELAYED = N([[60,0.4,0.9],[62,0.9,1.4],[64,1.4,1.9],[65,1.9,2.4],[67,3.4,3.9],[69,3.9,4.4],[71,4.4,4.9]]);
await evalr(`window.__STUDIO.commitPracticeFrames(${DELAYED})`);

// 1) 逐字结果：如果时间轴错位，中间的字会大量 missed / timing 离谱
const words = await evalr(`JSON.stringify(window.__STUDIO.S.lastPractice.words.map(w => ({
  char: w.char, ref: w.refNum, my: w.myNum, status: w.status,
  timingMs: w.timingMs != null ? Math.round(w.timingMs) : null,
})))`);
console.log('逐字结果:', words);

// 2) align 信息
console.log('align:', await evalr(`JSON.stringify(window.__STUDIO.S.lastPractice.align)`));

// 3) 模拟原声回放：audio.currentTime 与谱子时刻是否同轴
//    （真实音频从 t=0 播，谱子第一个音也在 t≈0 → highlightRefAt(音频时刻) 应正确）
const hl = await evalr(`(() => {
  const out = [];
  for (const t of [0.2, 0.6, 1.2, 2.1, 3.6, 4.2]) {
    window.__STUDIO.highlightRefAt(t);
    const on = [...document.querySelectorAll('#jpSheet .jp-on')].map(n => Number(n.dataset.noteIdx));
    out.push({ t, on: on[0] ?? null });
  }
  return JSON.stringify(out);
})()`);
console.log('原声回放亮格:', hl);

// 4) 验证 unify 后：S.score 的第一个音符 start 与音频 0 点的关系
console.log('score starts:', await evalr(`JSON.stringify(window.__STUDIO.S.score.lines.map(l => l.phraseStart))`));

proc.kill('SIGKILL'); ws.close();
process.exit(0);
