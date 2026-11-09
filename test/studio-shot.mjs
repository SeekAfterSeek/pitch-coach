/** 给新界面截图，人工核对渲染。运行：node test/studio-shot.mjs */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const URL = 'http://127.0.0.1:8756/';
const PORT = 9344;
const PROFILE = path.join(os.tmpdir(), 'pc-shot-' + Date.now());
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
].find((p) => fs.existsSync(p));
const proc = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1500,950',
  '--hide-scrollbars', URL,
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getWsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const p = (await r.json()).find((t) => t.type === 'page' && t.url.includes('127.0.0.1'));
      if (p?.webSocketDebuggerUrl) return p.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
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
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
  return r.result?.value;
}
await send('Page.enable');
await sleep(2000);

const REF = (() => {
  const a = []; const spec = [[60,0,1],[64,1,2],[67,2,3]];
  for (const [m,s,e] of spec) for (let t=s;t<e;t+=0.02) a.push({t,midi:m,voiced:true,rms:0.2,confidence:0.9});
  return JSON.stringify(a);
})();
const SHARP = (() => {
  const a = []; const spec = [[61,0,1],[65,1,2],[68,2,3]];
  for (const [m,s,e] of spec) for (let t=s;t<e;t+=0.02) a.push({t,midi:m,voiced:true,rms:0.2,confidence:0.9});
  return JSON.stringify(a);
})();

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const out = path.resolve('docs/' + name);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
  console.log('  📸', out);
}

// 初始态
await shot('studio-1-idle.png');
// 解析完成
await evaluate(`window.__STUDIO.commitReferenceFrames(${REF})`);
await sleep(400);
await shot('studio-2-parsed.png');
// 对比结果
await evaluate(`window.__STUDIO.commitPracticeFrames(${SHARP})`);
await sleep(400);
await shot('studio-3-result.png');

proc.kill('SIGKILL'); ws.close();
