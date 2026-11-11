/**
 * 深挖真实练唱对齐失败：对比真实参考 vs 真实练唱的时间轴/音高
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const URL_ = 'http://127.0.0.1:8756/';
const PORT = 9364;
const CHROME_USER_DATA = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
const PROFILE = path.join(os.tmpdir(), 'pc-real3-' + Date.now());
fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });
for (const sub of ['IndexedDB', 'Local Storage']) {
  const src = path.join(CHROME_USER_DATA, 'Default', sub);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(PROFILE, 'Default', sub), { recursive: true });
}
const proc = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', '--use-fake-ui-for-media-stream', URL_,
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
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
const send = (method, params = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((res) => pending.set(i, res)); };
const evalr = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) return { __exception: r.exceptionDetails.exception?.description };
  return r.result?.value;
};
await send('Runtime.enable');
await sleep(2500);

console.log('════ 真实记录时间轴快照 ════');
const recs = await evalr(`(async () => {
  const db = await new Promise((res) => { const r = indexedDB.open('pitchcoach_vocal_v1',1); r.onsuccess=()=>res(r.result); });
  const all = await new Promise((res) => { const r = db.transaction('vocals','readonly').objectStore('vocals').getAll(); r.onsuccess=()=>res(r.result); });
  // 用 getVocal 解包
  const out = [];
  for (const v of all) {
    const full = await window.__STUDIO.getVocalFrames(v.id);
    if (!full || !full.length) { out.push({label:v.label, err:'no frames'}); continue; }
    const voiced = full.filter(f=>f.voiced&&f.midi>0);
    out.push({
      label: v.label, role: v.role, created: new Date(v.createdAt).toLocaleString('zh-CN',{hour12:false}),
      n: full.length, t0: +full[0].t.toFixed(3), tN: +full[full.length-1].t.toFixed(3),
      voicedN: voiced.length, voicedRatio: +(voiced.length/full.length).toFixed(2),
      midiMin: voiced.length ? Math.min(...voiced.map(f=>f.midi)) : null,
      midiMax: voiced.length ? Math.max(...voiced.map(f=>f.midi)) : null,
      firstVoicedT: voiced.length ? +voiced[0].t.toFixed(2) : null,
      lastVoicedT: voiced.length ? +voiced[voiced.length-1].t.toFixed(2) : null,
    });
  }
  return out;
})()`);
for (const r of recs) console.log(JSON.stringify(r));

proc.kill('SIGKILL'); ws.close();
process.exit(0);
