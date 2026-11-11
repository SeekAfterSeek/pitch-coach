/**
 * 用【用户真实录音】跑完整验证：打开 → 时间轴校正 → 解析 → 回放亮格 → 练唱对比
 * 复用用户 Chrome Default profile 的 IndexedDB 副本。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const URL_ = 'http://127.0.0.1:8756/';
const PORT = 9362;
const CHROME_USER_DATA = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
const PROFILE = path.join(os.tmpdir(), 'pc-real-' + Date.now());
fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });
for (const sub of ['IndexedDB', 'Local Storage']) {
  const src = path.join(CHROME_USER_DATA, 'Default', sub);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(PROFILE, 'Default', sub), { recursive: true });
}
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => fs.existsSync(p));
const proc = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check',
  '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
  URL_,
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
const send = (method, params = {}) => {
  const i = ++id; ws.send(JSON.stringify({ id: i, method, params }));
  return new Promise((res) => pending.set(i, res));
};
const evalr = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) return { __exception: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return r.result?.value;
};
await send('Runtime.enable'); await send('Console.enable');
await sleep(2500);

console.log('════════ 1. 真实帧数据结构 ════════');
const struct = await evalr(`(async () => {
  const db = await new Promise((res) => { const r = indexedDB.open('pitchcoach_vocal_v1',1); r.onsuccess=()=>res(r.result); });
  const all = await new Promise((res) => { const r = db.transaction('vocals','readonly').objectStore('vocals').getAll(); r.onsuccess=()=>res(r.result); });
  const v = all.find(x => x.role === 'reference' && x.noteCount > 50) || all[0];
  const p = v.packed;
  return { label: v.label, role: v.role, packedKeys: Object.keys(p || {}),
    types: Object.fromEntries(Object.entries(p || {}).map(([k,val]) => [k, val?.constructor?.name || typeof val])),
    lengths: Object.fromEntries(Object.entries(p || {}).map(([k,val]) => [k, val?.length ?? null])) };
})()`);
console.log(JSON.stringify(struct, null, 1));

console.log('\n════════ 2. 打开真实参考录音：解析 + 歌词对齐 ════════');
const refId = await evalr(`(async () => {
  const db = await new Promise((res) => { const r = indexedDB.open('pitchcoach_vocal_v1',1); r.onsuccess=()=>res(r.result); });
  const all = await new Promise((res) => { const r = db.transaction('vocals','readonly').objectStore('vocals').getAll(); r.onsuccess=()=>res(r.result); });
  const v = all.filter(x => x.role === 'reference').sort((a,b)=>b.createdAt-a.createdAt)[0];
  return v.id;
})()`);
console.log('参考记录 id:', refId);

const opened = await evalr(`window.__STUDIO.openVocal('${refId}')`);
console.log('打开结果:', JSON.stringify(opened));
await sleep(500);
const st = await evalr(`window.__STUDIO.getState()`);
console.log('state:', JSON.stringify({ phase: st.phase, key: st.key, jpCells: st.jpCells, lines: st.score?.lines?.length }));

console.log('\n════════ 3. 真实原声回放：亮格是否命中（不应有大段空档）════════');
const sweep = await evalr(`(() => {
  const units = window.__STUDIO.S.score.lines.flatMap(l => l.units);
  const total = window.__STUDIO.S.score.duration;
  const gaps = [];
  let lastHit = null, hitCount = 0;
  for (let t = 0; t <= total; t += 0.02) {
    window.__STUDIO.highlightRefAt(t);
    const on = document.querySelectorAll('#jpSheet .jp-on').length;
    if (on > 0) { hitCount++; lastHit = t; }
    else if (t > units[0].start && t < units[units.length-1].end) gaps.push(+t.toFixed(2));
  }
  return { duration: total, totalSamples: Math.round(total/0.02), hitCount,
    gapCount: gaps.length, gapSample: gaps.slice(0, 8),
    firstUnit: units[0].start, lastUnitEnd: units[units.length-1].end };
})()`);
console.log('回放扫描:', JSON.stringify(sweep));

console.log('\n════════ 4. 真实练唱：逐字对比是否完整（不漏字）════════');
const takeId = await evalr(`(async () => {
  const db = await new Promise((res) => { const r = indexedDB.open('pitchcoach_vocal_v1',1); r.onsuccess=()=>res(r.result); });
  const all = await new Promise((res) => { const r = db.transaction('vocals','readonly').objectStore('vocals').getAll(); r.onsuccess=()=>res(r.result); });
  const v = all.filter(x => x.role === 'take').sort((a,b)=>b.createdAt-a.createdAt)[0];
  return v.id;
})()`);
console.log('练唱记录 id:', takeId);
const opened2 = await evalr(`window.__STUDIO.openVocal('${takeId}')`);
console.log('打开练唱结果:', JSON.stringify(opened2));
await sleep(400);
const st2 = await evalr(`window.__STUDIO.getState()`);
console.log('结果视图:', JSON.stringify({ phase: st2.phase, lrCells: st2.lrCells, nbCols: st2.nbCols, summary: st2.practiceSummary }));

proc.kill('SIGKILL'); ws.close();
process.exit(0);
