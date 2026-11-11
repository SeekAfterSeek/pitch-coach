/**
 * 用【真实录音历史】做验证（不是合成音频）。
 * 直接驱动用户实际使用的 8756 页面，从 IndexedDB 读真实记录，
 * 跑：打开 → 时间轴校正 → 解析 → 回放亮格 → 练唱对比，并输出真实数据指标。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const URL_ = 'http://127.0.0.1:8756/';
const PORT = 9361;
// 复用真实用户 profile（Default），才能读到用户真实录的音
const CHROME_USER_DATA = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
// 注意：不能在 Chrome 正在运行时用同一个 user-data-dir 启动第二个实例，
// 所以复制一份 profile 出来用（只复制 IndexedDB 相关目录到临时 profile）。
const PROFILE = path.join(os.tmpdir(), 'pc-real-copy-' + Date.now());
function copyRealProfile() {
  fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });
  const src = path.join(CHROME_USER_DATA, 'Default', 'IndexedDB');
  const dst = path.join(PROFILE, 'Default', 'IndexedDB');
  if (fs.existsSync(src)) fs.cpSync(src, dst, { recursive: true });
  const srcLS = path.join(CHROME_USER_DATA, 'Default', 'Local Storage');
  if (fs.existsSync(srcLS)) fs.cpSync(srcLS, path.join(PROFILE, 'Default', 'Local Storage'), { recursive: true });
}
copyRealProfile();
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
await send('Runtime.enable');
await sleep(2500);

console.log('════════ 1. 读真实录音历史 ════════');
const hist = await evalr(`(async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('pitchcoach_vocal_v1', 1);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const all = await new Promise((res, rej) => {
    const r = db.transaction('vocals','readonly').objectStore('vocals').getAll();
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const blobs = await new Promise((res, rej) => {
    const r = db.transaction('blobs','readonly').objectStore('blobs').getAll();
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const blobMap = new Map(blobs.map(b => [b.id, b.blob]));
  return all.map(v => ({
    id: v.id, label: v.label, role: v.role, createdAt: v.createdAt,
    duration: v.duration, noteCount: v.noteCount, voicedRatio: v.voicedRatio,
    hasAudio: !!blobMap.get(v.id), audioSize: blobMap.get(v.id)?.size || 0,
    audioType: blobMap.get(v.id)?.type || '',
    framesFirstT: v.packed ? null : null,
    packedSize: v.packed?.length || v.packed?.t?.length || 0,
    hasSnapshot: !!v.meta?.snapshot,
    snapLyric: v.meta?.snapshot?.lyricText?.slice(0, 30) || null,
    framesFixed: !!v.meta?.framesFixed,
  })).sort((a,b) => b.createdAt - a.createdAt);
})()`);
if (hist?.__exception) { console.log('读取失败:', hist.__exception); proc.kill('SIGKILL'); process.exit(1); }
console.log(`真实记录 ${hist.length} 条：`);
for (const v of hist) {
  console.log(`  [${v.role}] ${v.label}`);
  console.log(`     时长 ${v.duration?.toFixed?.(2) ?? v.duration}s · ${v.noteCount}音 · 有声${Math.round((v.voicedRatio||0)*100)}% · 音频${v.hasAudio ? (v.audioSize/1024).toFixed(0)+'KB '+v.audioType : '无'} · 快照${v.hasSnapshot?'有':'无'} · 已修${v.framesFixed?'是':'否'}`);
  if (v.snapLyric) console.log(`     存下来的歌词: ${v.snapLyric}`);
}

if (!hist.length) {
  console.log('\n⚠️ 这个 profile 里没有录音。需要用你实际使用页面的那个浏览器 profile。');
  proc.kill('SIGKILL'); process.exit(0);
}

console.log('\n════════ 2. 检查真实帧时间轴（是否老格式）════════');
const frameInfo = await evalr(`(async () => {
  const db = await new Promise((res) => { const r = indexedDB.open('pitchcoach_vocal_v1',1); r.onsuccess=()=>res(r.result); });
  const all = await new Promise((res) => { const r = db.transaction('vocals','readonly').objectStore('vocals').getAll(); r.onsuccess=()=>res(r.result); });
  const out = [];
  for (const v of all) {
    const p = v.packed;
    if (!p || !p.t) { out.push({ id: v.id, label: v.label, err: 'no packed.t' }); continue; }
    const t0 = p.t[0], tN = p.t[p.t.length-1];
    out.push({ id: v.id, label: v.label, role: v.role, n: p.t.length,
      t0, tN, absolute: t0 > 60, span: tN - t0, duration: v.duration });
  }
  return out;
})()`);
for (const f of frameInfo) {
  if (f.err) { console.log(`  ${f.label}: ${f.err}`); continue; }
  console.log(`  ${f.label}: ${f.n}帧 · t0=${f.t0?.toFixed(3)} → tN=${f.tN?.toFixed(3)} · 跨度${f.span?.toFixed(2)}s · 记录时长${f.duration?.toFixed?.(2)}s · ${f.absolute ? '★老格式(绝对时间)' : '相对时间'}`);
}

proc.kill('SIGKILL'); ws.close();
process.exit(0);
