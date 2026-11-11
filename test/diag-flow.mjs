/** 诊断：打开页面收集控制台错误，并注入一次参考解析复现「解析歌词跑不通」 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const URL_ = 'http://127.0.0.1:8756/';
const PORT = 9352;
const PROFILE = path.join(os.tmpdir(), 'pc-diag-' + Date.now());
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
const errors = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  }
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    errors.push(m.params.entry.text);
  }
});
await send('Runtime.enable'); await send('Console.enable'); await send('Log.enable');
await sleep(3000);

const evalr = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) return { __exception: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return r.result?.value;
};

console.log('__STUDIO type:', await evalr('typeof window.__STUDIO'));
console.log('init:', await evalr(`window.__STUDIO ? JSON.stringify({phase: window.__STUDIO.S.phase, history: window.__STUDIO.S.history.length}) : 'NO HOOKS'`));

const N = (spec) => { const a = []; for (const [m, s, e] of spec) for (let t = s; t < e; t += 0.02) a.push({ t, midi: m, voiced: m > 0, rms: 0.2, confidence: 0.9 }); return JSON.stringify(a); };
const REF = N([[60,0,0.5],[62,0.5,1],[64,1,1.5],[65,1.5,2],[67,3,3.5],[69,3.5,4],[71,4,4.5]]);

console.log('\n── 注入参考（复现解析流程） ──');
const r1 = await evalr(`window.__STUDIO.commitReferenceFrames(${REF}).then(x => JSON.stringify({ phase: x.phase, key: x.key?.name, notes: x.score?.noteCount, lines: x.score?.lines?.length }))`);
console.log('commitReference:', JSON.stringify(r1));

console.log('\n── 改歌词 + 重新解析匹配（复现歌词解析流程） ──');
const r2 = await evalr(`(() => {
  try {
    window.__STUDIO.setLyrics('一闪一闪，亮晶晶');
    const r = window.__STUDIO.realignLyrics();
    return JSON.stringify({ charMapLen: r?.charMap?.length, breaks: r?.lineBreaks, text: r?.text });
  } catch (e) { return JSON.stringify({ __error: e.message, __stack: e.stack?.split('\\n').slice(0,3).join(' | ') }); }
})()`);
console.log('realignLyrics:', r2);

console.log('\n── 确定歌词 ──');
const r3 = await evalr(`(() => {
  try { const x = window.__STUDIO.confirmLyrics(); return JSON.stringify({ text: x?.text?.slice(0,20), confirmed: x?.confirmed }); }
  catch (e) { return JSON.stringify({ __error: e.message, __stack: e.stack?.split('\\n').slice(0,3).join(' | ') }); }
})()`);
console.log('confirmLyrics:', r3);

console.log('\n── 练唱注入（复现结果流程） ──');
const r4 = await evalr(`window.__STUDIO.commitPracticeFrames(${REF}).then(x => JSON.stringify({ phase: x.phase, sung: x.practice?.summary?.sung }))`);
console.log('commitPractice:', JSON.stringify(r4));

console.log('\n── 页面渲染状态 ──');
console.log('card visible:', await evalr(`!document.getElementById('parsedCard').classList.contains('hidden')`));
console.log('lyricStatus:', await evalr(`document.getElementById('lyricStatus').textContent`));
console.log('sheet cells:', await evalr(`document.querySelectorAll('#jpSheet .jp-cell').length`));

console.log('\n── 全程捕获的控制台错误 ──');
console.log(errors.length ? errors.join('\n') : '(none)');
proc.kill('SIGKILL'); ws.close();
process.exit(0);
