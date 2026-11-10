/** 探针：注入 REF 参考 + SHARP 练唱，打印每只鸟的实际 style.top / left */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const URL_ = 'http://127.0.0.1:8756/';
const PORT = 9347;
const PROFILE = path.join(os.tmpdir(), 'pc-probe-' + Date.now());
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
].find((p) => fs.existsSync(p));
const proc = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1500,950', URL_,
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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
}
await sleep(2000);

const N = (spec) => { const a = []; for (const [m, s, e] of spec) for (let t = s; t < e; t += 0.02) a.push({ t, midi: m, voiced: m > 0, rms: 0.2, confidence: 0.9 }); return JSON.stringify(a); };
const REF = N([[60,0,0.5],[62,0.5,1],[64,1,1.5],[65,1.5,2],[67,3,3.5],[69,3.5,4],[71,4,4.5]]);
const SHARP = N([[61,0,0.5],[63,0.5,1],[65,1,1.5],[66,1.5,2],[68,3,3.5],[70,3.5,4],[72,4,4.5]]);

await evaluate(`window.__STUDIO.commitReferenceFrames(${REF})`);
await sleep(400);
await evaluate(`window.__STUDIO.commitPracticeFrames(${SHARP})`);
await sleep(400);

const probe = await evaluate(`(() => {
  const words = window.__STUDIO.S.lastPractice.words;
  const birds = [...document.querySelectorAll('.nb-col')].map((c, i) => {
    const ref = c.querySelector('.nb-bird.ref');
    const my = c.querySelector('.nb-bird.my');
    const merged = c.querySelector('.nb-bird.merged');
    return {
      i,
      refTop: ref ? ref.style.top : null,
      myTop: my ? my.style.top : null,
      myLeft: my ? my.style.left : null,
      merged: !!merged,
      refMidi: words[i]?.midi, userMidi: words[i]?.userMidi,
      devC: words[i]?.dev != null ? Math.round(words[i].dev) : null,
      timingMs: words[i]?.timingMs != null ? Math.round(words[i].timingMs) : null,
      userDurMs: words[i]?.userDurMs, refDurMs: words[i]?.refDurMs,
      rect: { ref: ref ? Math.round(ref.getBoundingClientRect().top) : null,
              my: my ? Math.round(my.getBoundingClientRect().top) : null,
              colTop: Math.round(c.getBoundingClientRect().top),
              colH: Math.round(c.getBoundingClientRect().height) },
    };
  });
  return birds;
})()`);
console.log(JSON.stringify(probe, null, 1));
proc.kill('SIGKILL'); ws.close();
process.exit(0);
