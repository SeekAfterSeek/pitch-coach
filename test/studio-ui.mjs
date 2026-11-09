/**
 * 端到端验证：人声对比工作室（新版三块结果 + K歌练唱 + 歌词上下两排结果）
 * CDP 打开本地服务，通过 __STUDIO 钩子注入合成帧，绕过麦克风。
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
    } catch {}
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

/** C 大调 7 音：一句 4 音（一闪一闪），一句 3 音（亮晶晶） */
const N = (spec) => { const a = []; for (const [m, s, e] of spec) for (let t = s; t < e; t += 0.02) a.push({ t, midi: m, voiced: m > 0, rms: 0.2, confidence: 0.9 }); return JSON.stringify(a); };
const REF = N([[60,0,0.5],[62,0.5,1],[64,1,1.5],[65,1.5,2],[67,3,3.5],[69,3.5,4],[71,4,4.5]]);
const PERFECT = REF;
const SHARP = N([[61,0,0.5],[63,0.5,1],[65,1,1.5],[66,1.5,2],[68,3,3.5],[70,3.5,4],[72,4,4.5]]);

console.log('\n── 初始态：单页、第一个按钮 = 录入参考人声 ──');
const init = await evaluate(`window.__STUDIO.getState()`);
check('初始 phase=idle', init.phase === 'idle', init.phase);
check('主操作区可见', await evaluate(`!document.getElementById('stageActions').classList.contains('hidden')`));
const firstBtn = await evaluate(`(() => { const b=document.querySelector('#stageActions .btn'); return b?.textContent.trim(); })()`);
check('第一个按钮是「录入参考人声」', /录入参考人声/.test(firstBtn || ''), firstBtn);
check('无旧版标签', await evaluate(`!document.querySelector('.tabs') && !document.getElementById('view-library')`));

console.log('\n── ① 录入参考人声 → 解析结果只三块 ──');
await evaluate(`window.__STUDIO.commitReferenceFrames(${REF})`);
await sleep(400);
const s1 = await evaluate(`window.__STUDIO.getState()`);
check('phase=ready', s1.phase === 'ready', s1.phase);
check('解析卡可见', s1.parsedHidden === false);
check('调性显示 C 大调', /C 大调/.test(s1.keyName), s1.keyName);
check('简谱调号 1=C', s1.jianpuKey === '1=C', s1.jianpuKey);
check('有可编辑歌词框', await evaluate(`!!document.getElementById('lyricEditor') && !document.getElementById('lyricEditor').disabled`));
check('歌词初始为占位○', /○/.test(s1.lyricEditorValue), s1.lyricEditorValue);
check('简谱表有 7 个格子', s1.jpCells === 7, String(s1.jpCells));
check('简谱表含 1 2 3（唱名）', /1/.test(s1.jpSheet) && /2/.test(s1.jpSheet) && /3/.test(s1.jpSheet), s1.jpSheet.slice(0,80));
check('结果卡里没有旧版统计块', await evaluate(`!document.getElementById('parsedStats') && !document.getElementById('roll')`));

console.log('\n── 歌词可编辑，且重建逐字谱 ──');
const edited = await evaluate(`(() => {
  window.__STUDIO.setLyrics('一闪一闪\\n亮晶晶');
  const st = window.__STUDIO.getState();
  return { val: st.lyricEditorValue, chars: st.score.lines.map(l=>l.units.map(u=>u.char).join('')), cells: st.jpCells };
})()`);
check('歌词写入「一闪一闪」', edited.chars[0] === '一闪一闪', JSON.stringify(edited.chars));
check('歌词写入「亮晶晶」', edited.chars[1] === '亮晶晶', JSON.stringify(edited.chars));
check('编辑后简谱格数不变', edited.cells === 7, String(edited.cells));

console.log('\n── ② 练唱：K歌倒计时 + 逐字高亮（不显示其他） ──');
const kBefore = await evaluate(`document.getElementById('karaoke').classList.contains('hidden')`);
check('默认不显示卡拉OK', kBefore === true);
// 用预览钩子（不依赖麦克风）显示倒计时 + 卡拉OK面板
await evaluate(`window.__STUDIO.previewKaraoke(0.2)`);
await sleep(120);
const kState = await evaluate(`(() => {
  const k = document.getElementById('karaoke');
  const c = document.getElementById('kCount');
  return { hidden: k.classList.contains('hidden'), count: c.textContent };
})()`);
check('出现卡拉OK面板', kState.hidden === false);
check('显示 3-2-1 倒计时', /^[321]$/.test(kState.count || ''), kState.count);
// 直接渲染某一时刻的逐字高亮
const kHtml = await evaluate(`window.__STUDIO.renderKaraokeAt(0.2)`);
check('当前句渲染出逐字单元', /k-unit/.test(kHtml), kHtml.slice(0,80));
check('高亮字含简谱', /k-jp/.test(kHtml) && /[1-7]/.test(kHtml), kHtml.slice(0,80));
check('高亮字含节拍', /k-beat/.test(kHtml) && /拍/.test(kHtml), kHtml.slice(0,80));
check('高亮字含歌词', /k-char/.test(kHtml));
check('有当前字高亮', /k-unit on/.test(kHtml), kHtml.slice(0,120));
const kHigh = await evaluate(`(() => {
  const st = window.__STUDIO.getState();
  return st.score.lines[0].units.map(u => ({ char: u.char, jp: u.jianpu.symbol, beat: u.beat }));
})()`);
check('每字有歌词', kHigh.every((u)=>u.char && u.char.length>0));
check('每字有简谱音符', kHigh.every((u)=>/[1-7]/.test(u.jp)), JSON.stringify(kHigh.map(u=>u.jp)));
check('每字有节拍', kHigh.every((u)=>/拍/.test(u.beat)), JSON.stringify(kHigh.map(u=>u.beat)));
check('练唱时不显示卷帘/统计', await evaluate(`!document.getElementById('stageRoll') && !document.getElementById('scoreBand')`));
// 清掉倒计时定时器，避免干扰后续流程
await evaluate(`window.__STUDIO.S.countdownRAF && clearTimeout(window.__STUDIO.S.countdownRAF)`).catch(()=>{});

console.log('\n── ③ 练唱结束 → 结果只显示一篇歌词（上下两排） ──');
// 重新用干净流程：注入完美清唱
await evaluate(`window.__STUDIO.commitReferenceFrames(${REF})`);
await sleep(350);
await evaluate(`window.__STUDIO.setLyrics('一闪一闪\\n亮晶晶')`);
await evaluate(`window.__STUDIO.commitPracticeFrames(${PERFECT})`);
await sleep(350);
const s3 = await evaluate(`window.__STUDIO.getState()`);
check('phase=result', s3.phase === 'result', s3.phase);
check('结果区可见', s3.resultHidden === false);
check('结果显示 7 个字（一篇歌词）', s3.lrCells === 7, String(s3.lrCells));
check('结果按 2 行显示', s3.lrLines === 2, String(s3.lrLines));
const resultChars = await evaluate(`[...document.querySelectorAll('.lr-line')].map(l => [...l.querySelectorAll('.lr-char')].map(c=>c.textContent).join('')).join('|')`);
check('歌词字按顺序组成「一闪一闪 / 亮晶晶」', /一闪一闪/.test(resultChars) && /亮晶晶/.test(resultChars), resultChars);
const cellHtml = await evaluate(`document.querySelector('.lr-cell').innerHTML`);
check('每字有上排「原唱简谱」', /lr-ref/.test(cellHtml), cellHtml.slice(0,120));
check('每字有下排「我唱简谱」', /lr-my/.test(cellHtml), cellHtml.slice(0,120));
check('每字有歌词', /lr-char/.test(cellHtml));
check('结果里没有总分/卷帘等旧元素', await evaluate(`!document.getElementById('scoreBand') && !document.getElementById('resultRoll') && !document.getElementById('diagList')`));

console.log('\n── 偏高清唱：标出偏高、上下排简谱不同 ──');
await evaluate(`window.__STUDIO.commitPracticeFrames(${SHARP})`);
await sleep(300);
const s4 = await evaluate(`window.__STUDIO.getState()`);
check('偏高统计 high>0', s4.practiceSummary.high > 0, String(s4.practiceSummary.high));
const tagText = await evaluate(`document.querySelector('.lr-cell .lr-tag').textContent`);
check('字上标出「偏高」', /偏高/.test(tagText), tagText);
const pairNums = await evaluate(`(() => { const c=document.querySelector('.lr-cell'); return { ref:c.querySelector('.lr-ref').textContent, my:c.querySelector('.lr-my').textContent }; })()`);
check('上排原唱简谱 ≠ 下排我唱简谱', pairNums.ref !== pairNums.my, JSON.stringify(pairNums));

console.log('\n── 历史任意两段互比 ──');
const idA = await evaluate(`window.__STUDIO.importFrames(${REF}, '导入A')`);
const idB = await evaluate(`window.__STUDIO.importFrames(${SHARP}, '导入B')`);
const pair = await evaluate(`window.__STUDIO.comparePairIds('${idA}','${idB}')`);
await sleep(300);
const s5 = await evaluate(`window.__STUDIO.getState()`);
check('互比后 phase=result', s5.phase === 'result', s5.phase);
check('互比结果有字', s5.lrCells > 0, String(s5.lrCells));
check('互比偏高被识别', s5.practiceSummary.high > 0, String(s5.practiceSummary.high));

console.log('\n── 播放按钮 / 无异常 ──');
check('播放 A/B 按钮可用', await evaluate(`!document.getElementById('btnPlayA').disabled && !document.getElementById('btnPlayB').disabled`));
check('无未捕获异常', await evaluate(`(() => !window.__err)()`));

console.log(`\nstudio-ui: ${pass} passed, ${fail} failed`);
if (fail) console.log('FAILURES:', fails.join('; '));
proc.kill('SIGKILL'); ws.close();
process.exit(fail ? 1 : 0);
