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

const N = (spec) => { const a = []; for (const [m,s,e] of spec) for (let t=s;t<e;t+=0.02) a.push({t,midi:m,voiced:m>0,rms:0.2,confidence:0.9}); return JSON.stringify(a); };
const REF = N([[60,0,0.5],[62,0.5,1],[64,1,1.5],[65,1.5,2],[67,3,3.5],[69,3.5,4],[71,4,4.5]]);
const SHARP = N([[61,0,0.5],[63,0.5,1],[65,1,1.5],[66,1.5,2],[68,3,3.5],[70,3.5,4],[72,4,4.5]]);

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const out = path.resolve('docs/' + name);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
  console.log('  📸', out);
}

await shot('studio-1-idle.png');
// 解析卡：模拟识别到歌词 + 重新解析匹配 + 逐格改字 + 确定 + 播放原声亮格
await evaluate(`window.__STUDIO.commitReferenceFrames(${REF})`);
await sleep(350);
await evaluate(`window.__STUDIO.simulateRefBlob()`);
await evaluate(`window.__STUDIO.setRecognizedLyrics('一闪一闪亮晶晶')`);
await evaluate(`window.__STUDIO.realignLyrics()`);
await evaluate(`window.__STUDIO.highlightRefAt(0.6)`);   // 让某一格亮着，截图能看见
await sleep(100);
await shot('studio-2-parsed.png');
// 往下滚，露出「逐字对应格」（一个音符一个可改输入框）
await evaluate(`(() => { const c=document.getElementById('jpCellEditor');
  c.scrollIntoView({block:'center'}); return c.getBoundingClientRect().top; })()`);
await sleep(120);
await shot('studio-2b-cells.png');
await evaluate(`document.getElementById('stage').scrollTo(0,0)`);
// K歌练唱视图（倒计时结束后的逐字高亮）
await evaluate(`window.__STUDIO.previewKaraoke(0.6)`);
await sleep(150);
await evaluate(`window.__STUDIO.renderKaraokeAt(0.6)`);
await evaluate(`document.getElementById('kCount').classList.add('hidden')`);
await sleep(80);
await shot('studio-3-karaoke.png');
// 结果：一篇歌词上下两排（用识别+确定的真实歌词）
await evaluate(`window.__STUDIO.commitReferenceFrames(${REF})`);
await sleep(300);
await evaluate(`window.__STUDIO.setRecognizedLyrics('一闪一闪亮晶晶')`);
await evaluate(`window.__STUDIO.confirmLyrics()`);
await evaluate(`window.__STUDIO.commitPracticeFrames(${SHARP})`);
await sleep(300);
await shot('studio-4-result.png');

proc.kill('SIGKILL'); ws.close();
