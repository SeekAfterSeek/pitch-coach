/**
 * 真实录音验收：用用户实际录的 13 条记录跑完整链路，检查
 *   1. 音高范围是否回到人声区间（不再出现 A1/E6）
 *   2. 原声回放亮格是否全程有高亮（gap=0）
 *   3. 练唱逐字对比是否合理（不再是 ±1500 音分的乱码）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const URL_ = 'http://127.0.0.1:8756/';
const PORT = 9371;
const CHROME_USER_DATA = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
const PROFILE = path.join(os.tmpdir(), 'pc-verify-' + Date.now());
fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });
for (const sub of ['IndexedDB', 'Local Storage']) {
  const src = path.join(CHROME_USER_DATA, 'Default', sub);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(PROFILE, 'Default', sub), { recursive: true });
}
const proc = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
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
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
const send = (method, params = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((res) => pending.set(i, res)); };
const evalr = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) return { __exception: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return r.result?.value;
};
await send('Runtime.enable');
await sleep(2500);

let pass = 0, fail = 0;
const chk = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${detail}`); }
};

const list = await evalr(`(async () => {
  const db = await new Promise((res) => { const r = indexedDB.open('pitchcoach_vocal_v1',1); r.onsuccess=()=>res(r.result); });
  const all = await new Promise((res) => { const r = db.transaction('vocals','readonly').objectStore('vocals').getAll(); r.onsuccess=()=>res(r.result); });
  return all.map(v => ({ id: v.id, label: v.label, role: v.role })).sort((a,b)=>(a.createdAt||0)-(b.createdAt||0));
})()`);
console.log(`真实录音 ${list.length} 条，逐条验收：\n`);

console.log('── 1. 音高范围回到人声区间（E2~C6 = midi 40~84）──');
console.log('   （先打开记录触发重分析写回，再读帧——直接读库是旧帧）');
const refs = list.filter((v) => v.role === 'reference');
const takes = list.filter((v) => v.role === 'take');
let badRange = 0;
for (const v of refs) {
  await evalr(`window.__STUDIO.openVocal('${v.id}')`);
  await sleep(500);
  const r = await evalr(`(async () => {
    const fs = await window.__STUDIO.getVocalFrames('${v.id}');
    if (!fs) return null;
    const voiced = fs.filter(f=>f.voiced&&f.midi>0);
    if (!voiced.length) return { n: 0 };
    const ms = voiced.map(f=>f.midi);
    return { n: voiced.length, min: Math.min(...ms), max: Math.max(...ms) };
  })()`);
  if (!r || !r.n) { console.log(`  - ${v.label}: 无有声帧`); continue; }
  const ok = r.min >= 38 && r.max <= 86;
  if (!ok) badRange++;
  console.log(`  ${ok ? '✓' : '✗'} ${v.label}: midi ${r.min.toFixed(1)}~${r.max.toFixed(1)} (${r.n}帧)`);
}
chk(`所有参考录音音高在合理范围（${refs.length - badRange}/${refs.length}）`, badRange === 0, `越界 ${badRange} 条`);

console.log('\n── 2. 真实原声回放：全程都有高亮（gap=0）──');
let totalGaps = 0, checked = 0;
for (const v of refs.slice(-4)) {   // 最近 4 条参考
  await evalr(`window.__STUDIO.openVocal('${v.id}')`);
  await sleep(400);
  const r = await evalr(`(() => {
    const s = window.__STUDIO.S.score;
    if (!s || !s.lines.length) return null;
    const units = s.lines.flatMap(l=>l.units);
    let gaps = 0, n = 0;
    for (let t = 0; t <= s.duration; t += 0.02) {
      n++;
      window.__STUDIO.highlightRefAt(t);
      if (document.querySelectorAll('#jpSheet .jp-on').length === 0) gaps++;
    }
    return { gaps, n, dur: +s.duration.toFixed(1), units: units.length };
  })()`);
  if (!r) { console.log(`  - ${v.label}: 无谱`); continue; }
  checked++;
  totalGaps += r.gaps;
  console.log(`  ${r.gaps === 0 ? '✓' : '✗'} ${v.label}: ${r.units}音/${r.dur}s，${r.n}采样点，空档 ${r.gaps}`);
}
chk(`回放全程有高亮（${checked} 条真实录音）`, totalGaps === 0, `累计空档 ${totalGaps}`);

console.log('\n── 3. 真实练唱逐字对比是否合理 ──');
const tp = takes[takes.length - 1];
if (tp) {
  await evalr(`window.__STUDIO.openVocal('${tp.id}')`);
  await sleep(600);
  const s = await evalr(`window.__STUDIO.getState()`);
  const devs = await evalr(`(() => {
    const w = (window.__STUDIO.S.lastPractice?.words||[]).filter(x=>x.dev!=null);
    if (!w.length) return null;
    const d = w.map(x=>Math.round(x.dev)).sort((a,b)=>a-b);
    const q = p => d[Math.floor(p*(d.length-1))];
    return { n: d.length, min: d[0], p10: q(.1), p50: q(.5), p90: q(.9), max: d[d.length-1] };
  })()`);
  console.log(`  ${tp.label}`);
  console.log(`  结果: ${s.lrCells} 字 / 鸟图 ${s.nbCols} 列`);
  console.log(`  汇总: ${JSON.stringify(s.practiceSummary)}`);
  console.log(`  偏差分布: ${JSON.stringify(devs)}`);
  const verdict = await evalr(`document.getElementById('keyVerdict').textContent`);
  console.log(`  判定横幅: ${verdict}`);
  chk('练唱结果有逐字数据', (s.lrCells || 0) > 0, String(s.lrCells));
  chk('偏差分布收敛（p50 在 ±400 内）', devs && Math.abs(devs.p50) < 400, JSON.stringify(devs));
}

console.log(`\n════════ 真实录音验收: ${pass} passed, ${fail} failed ════════`);
proc.kill('SIGKILL'); ws.close();
process.exit(fail ? 1 : 0);
