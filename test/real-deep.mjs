/**
 * 用真实录音深挖两个问题：
 *  A. 练唱结果 meanAbsCents=350（偏差 3.5 个半音）是否正常？—— 需要区分"整体移调"和"真跑调"
 *  B. 真实参考里音符之间空隙分布如何（决定高亮外扩是否够）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const URL_ = 'http://127.0.0.1:8756/';
const PORT = 9363;
const CHROME_USER_DATA = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
const PROFILE = path.join(os.tmpdir(), 'pc-real2-' + Date.now());
fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });
for (const sub of ['IndexedDB', 'Local Storage']) {
  const src = path.join(CHROME_USER_DATA, 'Default', sub);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(PROFILE, 'Default', sub), { recursive: true });
}
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const proc = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required', URL_,
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getWsUrl() {
  for (let i = 0; i < 50; i++) {
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
const send = (method, params = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((res) => pending.set(i, res)); };
const evalr = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) return { __exception: r.exceptionDetails.exception?.description };
  return r.result?.value;
};
await send('Runtime.enable');
await sleep(2500);

// 打开最近一次真实参考
const refId = await evalr(`(async () => {
  const db = await new Promise((res) => { const r = indexedDB.open('pitchcoach_vocal_v1',1); r.onsuccess=()=>res(r.result); });
  const all = await new Promise((res) => { const r = db.transaction('vocals','readonly').objectStore('vocals').getAll(); r.onsuccess=()=>res(r.result); });
  return all.filter(x=>x.role==='reference').sort((a,b)=>b.createdAt-a.createdAt)[0].id;
})()`);
await evalr(`window.__STUDIO.openVocal('${refId}')`);
await sleep(600);

console.log('════ A. 真实参考的音符间距分布（决定高亮外扩）════');
const gaps = await evalr(`(() => {
  const us = window.__STUDIO.S.score.lines.flatMap(l=>l.units);
  const g = [];
  for (let i=1;i<us.length;i++) g.push(+(us[i].start - us[i-1].end).toFixed(3));
  g.sort((a,b)=>a-b);
  const q = p => g[Math.floor(p*(g.length-1))];
  return { n: g.length, min: g[0], p50: q(.5), p90: q(.9), max: g[g.length-1],
    over025: g.filter(x=>x>0.25).length, over05: g.filter(x=>x>0.5).length,
    top: g.slice(-6) };
})()`);
console.log(JSON.stringify(gaps));

console.log('\n════ B. 真实练唱的移调判定（区分"换调"vs"跑调"）════');
const takeId = await evalr(`(async () => {
  const db = await new Promise((res) => { const r = indexedDB.open('pitchcoach_vocal_v1',1); r.onsuccess=()=>res(r.result); });
  const all = await new Promise((res) => { const r = db.transaction('vocals','readonly').objectStore('vocals').getAll(); r.onsuccess=()=>res(r.result); });
  return all.filter(x=>x.role==='take').sort((a,b)=>b.createdAt-a.createdAt)[0].id;
})()`);
await evalr(`window.__STUDIO.openVocal('${takeId}')`);
await sleep(600);
const tp = await evalr(`JSON.stringify(window.__STUDIO.S.lastPractice.transposition)`);
console.log('transposition:', tp);
const verdict = await evalr(`document.getElementById('keyVerdict').textContent`);
console.log('页面判定横幅:', verdict);
const devs = await evalr(`(() => {
  const w = window.__STUDIO.S.lastPractice.words.filter(x=>x.dev!=null);
  const d = w.map(x=>Math.round(x.dev)).sort((a,b)=>a-b);
  const q = p => d[Math.floor(p*(d.length-1))];
  return { n: d.length, min: d[0], p10: q(.1), p50: q(.5), p90: q(.9), max: d[d.length-1] };
})()`);
console.log('逐字偏差分布(音分):', JSON.stringify(devs));

proc.kill('SIGKILL'); ws.close();
process.exit(0);
