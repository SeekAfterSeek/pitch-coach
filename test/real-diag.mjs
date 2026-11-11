/**
 * 真实练唱 vs 真实参考：诊断偏差来源
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const URL_ = 'http://127.0.0.1:8756/';
const PORT = 9372;
const CHROME_USER_DATA = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
const PROFILE = path.join(os.tmpdir(), 'pc-diag2-' + Date.now());
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

const ids = await evalr(`(async () => {
  const db = await new Promise((res) => { const r = indexedDB.open('pitchcoach_vocal_v1',1); r.onsuccess=()=>res(r.result); });
  const all = await new Promise((res) => { const r = db.transaction('vocals','readonly').objectStore('vocals').getAll(); r.onsuccess=()=>res(r.result); });
  const take = all.filter(x=>x.role==='take').sort((a,b)=>b.createdAt-a.createdAt)[0];
  return { takeId: take.id, refId: take.meta?.snapshot?.refId, label: take.label };
})()`);
console.log('练唱记录:', JSON.stringify(ids));

// 打开（触发重分析）
await evalr(`window.__STUDIO.openVocal('${ids.takeId}')`);
await sleep(1200);

console.log('\n════ 两条录音的实际音域对比 ════');
const cmp = await evalr(`(async () => {
  const ref = await window.__STUDIO.getVocalFrames('${ids.refId}');
  const take = await window.__STUDIO.getVocalFrames('${ids.takeId}');
  const stat = (fs) => {
    const v = fs.filter(f=>f.voiced&&f.midi>0).map(f=>f.midi).sort((a,b)=>a-b);
    const q = p => v[Math.floor(p*(v.length-1))];
    return { n: v.length, p10:+q(.1).toFixed(1), p50:+q(.5).toFixed(1), p90:+q(.9).toFixed(1) };
  };
  return { ref: stat(ref), take: stat(take) };
})()`);
console.log(JSON.stringify(cmp, null, 1));
const refP50 = cmp.ref.p50, takeP50 = cmp.take.p50;
console.log(`中位音高差: ${(takeP50 - refP50).toFixed(1)} 半音`);

console.log('\n════ 逐字偏差按"折回八度"后是否收敛 ════');
const folded = await evalr(`(() => {
  const w = (window.__STUDIO.S.lastPractice?.words||[]).filter(x=>x.dev!=null);
  const vals = w.map(x=>x.dev);
  // 折回最近的整八度（±12 半音的倍数）后看剩余偏差
  const foldedVals = vals.map(d => {
    const semi = d/100;
    const k = Math.round(semi/12);
    return (semi - k*12)*100;
  });
  const s = a => { const b=[...a].sort((x,y)=>x-y); const q=p=>b[Math.floor(p*(b.length-1))]; return {p10:+q(.1).toFixed(0),p50:+q(.5).toFixed(0),p90:+q(.9).toFixed(0)}; };
  const octaveJumps = vals.filter(d => Math.abs(d/100) >= 6).length;
  return { raw: s(vals), folded: s(foldedVals), octaveJumps, total: vals.length };
})()`);
console.log(JSON.stringify(folded));

proc.kill('SIGKILL'); ws.close();
process.exit(0);
