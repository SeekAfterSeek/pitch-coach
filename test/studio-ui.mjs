/**
 * 端到端验证：人声对比工作室（全新单页流程）
 * 用 CDP 打开本地服务，通过 __STUDIO 钩子注入合成帧，绕过麦克风。
 * 运行：node test/studio-ui.mjs  （需先 node server.mjs 8756）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const URL = 'http://127.0.0.1:8756/';
const PORT = 9343;
const PROFILE = path.join(os.tmpdir(), 'pc-studio-' + Date.now());
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
].find((p) => fs.existsSync(p));

const proc = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check',
  '--disable-features=Translate,MediaRouter',
  '--window-size=1500,950', '--hide-scrollbars', URL,
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const page = (await r.json()).find((t) => t.type === 'page' && t.url.includes('127.0.0.1'));
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
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); } }, 30000);
    });
  }
}

const ws = new WebSocket(await getWsUrl());
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
const cdp = new CDP(ws);
await cdp.send('Runtime.enable');
await cdp.send('Console.enable');
await sleep(2200);

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
const errors = [];
// 收集控制台错误
cdp.send('Runtime.consoleAPICalled', {}).catch(() => {});

/** 合成参考帧：C4(60) E4(64) G4(67)，各 1 秒 */
const REF = (() => {
  const a = []; const spec = [[60, 0, 1], [64, 1, 2], [67, 2, 3]];
  for (const [m, s, e] of spec) for (let t = s; t < e; t += 0.02) a.push({ t, midi: m, voiced: m > 0, rms: 0.2, confidence: 0.9 });
  return JSON.stringify(a);
})();
/** 完美清唱 */
const PERFECT = REF;
/** 整体高一个半音 */
const SHARP = (() => {
  const a = []; const spec = [[61, 0, 1], [65, 1, 2], [68, 2, 3]];
  for (const [m, s, e] of spec) for (let t = s; t < e; t += 0.02) a.push({ t, midi: m, voiced: m > 0, rms: 0.2, confidence: 0.9 });
  return JSON.stringify(a);
})();

console.log('\n── 初始态：单页、第一个按钮 = 录入参考人声 ──');
const init = await evaluate(`window.__STUDIO.getState()`);
check('初始 phase=idle', init.phase === 'idle', init.phase);
check('历史为空', init.historyCount === 0, String(init.historyCount));
check('主操作区可见', init.stageActionsHidden === false, JSON.stringify(init.stageActionsHidden));
check('结果区隐藏', init.resultHidden === true);
const firstBtn = await evaluate(`(() => {
  const b = document.querySelector('#stageActions .btn');
  return { text: b?.textContent.trim(), id: b?.id };
})()`);
check('第一个按钮是「录入参考人声」', /录入参考人声/.test(firstBtn.text || ''), JSON.stringify(firstBtn));
check('页面已无「曲库 / 实时练唱 / 录音复盘」标签', await evaluate(`!document.querySelector('.tabs') && !document.getElementById('view-library')`));

console.log('\n── 录入参考人声 → 自动解析 ──');
await evaluate(`window.__STUDIO.commitReferenceFrames(${REF})`);
await sleep(400);
const afterRef = await evaluate(`window.__STUDIO.getState()`);
check('phase=ready（解析完成）', afterRef.phase === 'ready', afterRef.phase);
check('历史 +1', afterRef.historyCount === 1, String(afterRef.historyCount));
check('解析结果卡可见', afterRef.parsedHidden === false);
check('出现「练唱开始」按钮', afterRef.practiceBtnExists === true);
check('出现「停止录音」按钮', afterRef.stopBtnExists === true);
const practiceText = await evaluate(`document.getElementById('btnPractice').textContent.trim()`);
check('练唱按钮文案正确', /练唱开始/.test(practiceText), practiceText);
const parsedStats = await evaluate(`document.getElementById('parsedStats').textContent`);
check('解析卡显示音符/音域', /音符/.test(parsedStats) && /C/.test(parsedStats), parsedStats);

console.log('\n── 练唱 → 停止 → 自动对比解析 ──');
await evaluate(`window.__STUDIO.commitPracticeFrames(${PERFECT})`);
await sleep(400);
const afterPerfect = await evaluate(`window.__STUDIO.getState()`);
check('phase=result', afterPerfect.phase === 'result', afterPerfect.phase);
check('结果区可见', afterPerfect.resultHidden === false);
check('总分条有内容', afterPerfect.scoreBand.length > 0, afterPerfect.scoreBand);
check('逐音符诊断有行', afterPerfect.diagRows === 3, String(afterPerfect.diagRows));
check('历史 +2（参考 + 清唱）', afterPerfect.historyCount === 2, String(afterPerfect.historyCount));
const perfectTotal = await evaluate(`window.__STUDIO.getState().lastResult.score.total`);
check('完美清唱总分高（≥90）', perfectTotal >= 90, String(perfectTotal));

console.log('\n── 偏高清唱对比：分数下降、偏高统计 ──');
await evaluate(`window.__STUDIO.commitPracticeFrames(${SHARP})`);
await sleep(300);
const sharpState = await evaluate(`window.__STUDIO.getState().lastResult`);
check('偏高使总分下降', sharpState.score.total < perfectTotal, `${sharpState.score.total} vs ${perfectTotal}`);
check('偏高统计 high>0', sharpState.stats.high > 0, String(sharpState.stats.high));

console.log('\n── 历史任意两段互比 ──');
const ids = await evaluate(`window.__STUDIO.listHistory().map(v=>v.id)`);
check('历史 ≥3 条', ids.length >= 3, String(ids.length));
// 用两条导入的帧做互比
const idA = await evaluate(`window.__STUDIO.importFrames(${REF}, '导入A')`);
const idB = await evaluate(`window.__STUDIO.importFrames(${SHARP}, '导入B')`);
const pair = await evaluate(`window.__STUDIO.comparePairIds('${idA}','${idB}')`);
await sleep(300);
const pairState = await evaluate(`window.__STUDIO.getState()`);
check('互比后 phase=result', pairState.phase === 'result', pairState.phase);
check('互比结果 ok=true', pair.ok === true, JSON.stringify(pair.ok));
check('互比结果有总分', typeof pair.score?.total === 'number', String(pair.score?.total));
check('互比偏高被识别', pair.stats?.high > 0, String(pair.stats?.high));
check('结果标题显示 A/B 标签', /A 参考/.test(await evaluate(`document.getElementById('resultSub').textContent`)));

console.log('\n── 播放按钮 / 清空选择 ──');
check('播放 A/B 按钮可用', await evaluate(`!document.getElementById('btnPlayA').disabled && !document.getElementById('btnPlayB').disabled`));

console.log('\n── 无 JS 运行时错误 ──');
const hadErrors = await evaluate(`(() => window.__err ? true : false)()`);
check('无未捕获异常', hadErrors === false);

console.log(`\nstudio-ui: ${pass} passed, ${fail} failed`);
if (fail) console.log('FAILURES:', fails.join('; '));
proc.kill('SIGKILL');
ws.close();
process.exit(fail ? 1 : 0);
