/**
 * 验证：教唱工作流（录入参考人声 → 对齐歌词 → 清唱跟练逐字点评）
 * 用 CDP 打开本地服务，通过 __PC 钩子注入合成帧，绕过麦克风。
 * 运行：node test/vocal-ui.mjs  （需先 node server.mjs 8756）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const URL = 'http://127.0.0.1:8756/';
const PORT = 9342;
const PROFILE = path.join(os.tmpdir(), 'pc-vocal-' + Date.now());
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
].find((p) => fs.existsSync(p));

const chromeArgs = [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check',
  '--disable-features=Translate,MediaRouter',
  '--window-size=1500,950', '--hide-scrollbars',
  URL,
];
const proc = spawn(CHROME, chromeArgs, { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page' && t.url.includes('127.0.0.1'));
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* not ready */ }
    await sleep(250);
  }
  throw new Error('CDP not ready');
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout: ' + method)); } }, 30000);
    });
  }
}

const wsUrl = await getWsUrl();
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
const cdp = new CDP(ws);
await cdp.send('Runtime.enable');
await cdp.send('Console.enable');
await sleep(2500);

let pass = 0, fail = 0; const fails = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; fails.push(name + (detail ? ' — ' + detail : '')); console.log('  ✗ ' + name + ' ' + detail); }
}
async function evaluate(expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

// 造一段参考帧：你(C4 60) 0-1s, 好(E4 64) 1-2s, 呀(G4 67) 2-3s
function makeRefFrames() {
  const arr = [];
  const spec = [[60,0,1],[64,1,2],[67,2,3]];
  for (const [m,s,e] of spec) for (let t=s; t<e; t+=0.02) arr.push({ t, midi:m, voiced:m>0, rms:0.2, confidence:0.9 });
  return JSON.stringify(arr);
}

console.log('\n── 教唱：注入教唱曲目 + 录入参考人声 ──');

// 注入一首教唱曲目（hum 模式等价），并进入教唱
await evaluate(`(() => {
  const id = 'voc-'+Date.now();
  const t = { id, kind:'custom', title:'我的教唱', subtitle:'参考人声', duration:3,
              refData:{ source:'vocal', title:'我的教唱', duration:3, hop:0.02, midi:[], voiced:[] }, audioBlob:null };
  window.__PC.S.customTracks = [...window.__PC.S.customTracks, t];
  window.__PC.selectTrack(id);
  return id;
})()`);
await sleep(500);

const afterSelect = await evaluate(`window.__PC.getVocalState()`);
check('教唱面板可见', afterSelect.panelHidden === false, JSON.stringify(afterSelect));

// 录入参考人声（注入帧）
await evaluate(`window.__PC.buildVocalRefFromFrames(${makeRefFrames()})`);
await sleep(300);
const afterRef = await evaluate(`window.__PC.getVocalState()`);
check('录入后已解析参考人声', afterRef.hasRef === true, JSON.stringify({ step: afterRef.step }));
check('进入对齐步骤', afterRef.step === 'align', afterRef.step);

// 设置歌词并对齐
await evaluate(`window.__PC.setTestLyrics('[00:00.00]你\\n[00:01.00]好\\n[00:02.00]呀')`);
await sleep(200);
await evaluate(`(() => { document.getElementById('btnVocalAlign').click(); return true; })()`);
await sleep(300);
const afterAlign = await evaluate(`window.__PC.getVocalState()`);
check('对齐后生成逐字单元', afterAlign.hasUnits === true, `units=${afterAlign.units?.length}`);
check('单元含目标音高', afterAlign.units && afterAlign.units[0].midi === 60, JSON.stringify(afterAlign.units?.map(u=>u.midi)));
check('进入清唱跟练步骤', afterAlign.step === 'practice', afterAlign.step);

// 完美清唱 → 评分
const perfectTake = makeRefFrames(); // 同一个音高序列 = 完美
await evaluate(`window.__PC.scorePracticeFromFrames(${perfectTake})`);
await sleep(300);
const afterPractice = await evaluate(`window.__PC.getVocalState()`);
check('清唱后展示结果', afterPractice.resultHidden === false, JSON.stringify({ step: afterPractice.step, hidden: afterPractice.resultHidden }));
check('完美清唱准音率 100%', afterPractice.result && Math.round(afterPractice.result.accuracy*100) === 100, JSON.stringify(afterPractice.result?.accuracy));
check('结果汇总文案非空', !!afterPractice.summary, afterPractice.summary);

// 偏高清唱 → 应识别偏差
await evaluate(`window.__PC.scorePracticeFromFrames(${makeRefFrames().replace(/60/g,'61').replace(/64/g,'65').replace(/67/g,'68')})`);
await sleep(200);
const offResult = await evaluate(`window.__PC.getVocalState().result`);
check('偏高清唱被检测到偏差', offResult && offResult.units.some(u=>u.dev>0), JSON.stringify(offResult?.units?.map(u=>u.dev)));

// 漏唱最后一字（在页面外拼好数组字面量再注入，避免类型错误）
function makeMissFrames() {
  const arr = [];
  const spec = [[60,0,0.92],[64,1.02,1.95]];
  for (const [m,s,e] of spec) for (let t=s; t<e; t+=0.02) arr.push({ t, midi:m, voiced:m>0, rms:0.2, confidence:0.9 });
  return JSON.stringify(arr);
}
await evaluate(`window.__PC.scorePracticeFromFrames(${makeMissFrames()})`);
await sleep(200);
const missResult = await evaluate(`window.__PC.getVocalState().result`);
check('漏唱被识别（missed>0）', missResult && missResult.missed >= 1, JSON.stringify({ missed: missResult?.missed }));

console.log(`\nvocal-ui: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILURES:', fails.join('; ')); }
proc.kill('SIGKILL');
ws.close();
process.exit(fail ? 1 : 0);
