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
check('简谱无字母 b/#（改数字+↑↓）', await evaluate(`(() => { const s=window.__STUDIO.getState().score; return s.lines.every(l=>l.units.every(u=>!/[a-zA-Zb#]/.test(u.jianpu.symbol))); })()`));
check('简谱有图例说明 ↑↓', /↑/.test(s1.jpLegend || '') && /↓/.test(s1.jpLegend || ''), s1.jpLegend);
check('结果卡里没有旧版统计块', await evaluate(`!document.getElementById('parsedStats') && !document.getElementById('roll')`));

console.log('\n── 歌词：识别 / 可编辑 / 确定 ──');
const edited = await evaluate(`(() => {
  window.__STUDIO.setLyrics('一闪一闪\\n亮晶晶');
  const st = window.__STUDIO.getState();
  return { val: st.lyricEditorValue, chars: st.score.lines.map(l=>l.units.map(u=>u.char).join('')), cells: st.jpCells,
           hasRecognize: st.hasRecognizeBtn, hasRealign: st.hasRealignBtn, hasConfirm: st.hasConfirmBtn,
           hasPlayRef: st.hasPlayRefBtn };
})()`);
check('有「识别歌词」按钮', edited.hasRecognize === true);
check('有「重新解析匹配」按钮', edited.hasRealign === true);
check('有「确定歌词」按钮', edited.hasConfirm === true);
check('有「播放我刚录的原声」按钮', edited.hasPlayRef === true);
check('歌词写入「一闪一闪」', edited.chars[0] === '一闪一闪', JSON.stringify(edited.chars));
check('歌词写入「亮晶晶」', edited.chars[1] === '亮晶晶', JSON.stringify(edited.chars));
check('编辑后简谱格数不变', edited.cells === 7, String(edited.cells));
const confirmed = await evaluate(`window.__STUDIO.confirmLyrics()`);
check('点「确定歌词」后 confirmed=true', confirmed.confirmed === true);
check('确定后歌词生效', /一闪一闪/.test(confirmed.text), confirmed.text);
// 模拟录音时识别到的连续文本 → 自动逐句对齐
const recognized = await evaluate(`window.__STUDIO.setRecognizedLyrics('一闪一闪亮晶晶')`);
check('识别到的连续文本按句切成两行', recognized.split('\n')[0] === '一闪一闪' && recognized.split('\n')[1] === '亮晶晶', recognized);
await evaluate(`window.__STUDIO.confirmLyrics()`);

console.log('\n── 解析卡：播放原声时逐音符亮格 + 逐字对应格 ──');
// 逐字对应格：一个音符一个可改输入框
const cellState = await evaluate(`(() => { const st = window.__STUDIO.getState();
  return { inputs: st.jceInputs, cells: st.jceCells, phraseStarts: st.phraseStarts }; })()`);
check('逐字对应格有 7 个可编辑输入框', cellState.inputs === 7, String(cellState.inputs));
check('逐字对应格有 7 个音符格', cellState.cells === 7, String(cellState.cells));
check('乐句起点可查（第1句0s / 第2句3s）', cellState.phraseStarts[0] === 0 && cellState.phraseStarts[1] === 3,
  JSON.stringify(cellState.phraseStarts));
// 模拟播放到 0.2s（第1个音符）：简谱表 + 逐字格同步高亮第 0 格
const hi0 = await evaluate(`window.__STUDIO.highlightRefAt(0.2)`);
check('播放 0.2s 高亮第 1 个音符（简谱表）', hi0.jpOn.includes(0), JSON.stringify(hi0.jpOn));
check('播放 0.2s 高亮第 1 个音符（逐字格）', hi0.cellOn.includes(0), JSON.stringify(hi0.cellOn));
// 3.2s 落在 [67, 3, 3.5) = 第 2 句首音（全局索引 4）；3.6s 落在下一个音（索引 5）
const hi4 = await evaluate(`window.__STUDIO.highlightRefAt(3.2)`);
check('播放 3.2s 高亮第 2 句首音（全局索引 4）', hi4.jpOn.includes(4) && hi4.cellOn.includes(4), JSON.stringify(hi4));
// 每个音符有「简谱格 + 歌词格」两个元素同亮，去重后应只落在当前这一个音符
check('高亮去重后只落在当前一个音符', new Set(hi4.jpOn).size === 1, JSON.stringify(hi4.jpOn));
const hi5 = await evaluate(`window.__STUDIO.highlightRefAt(3.6)`);
check('播放 3.6s 高亮切到下一个音符（索引 5）', hi5.jpOn.includes(5), JSON.stringify(hi5.jpOn));
await evaluate(`window.__STUDIO.stopRefPlayback()`);
// 注入"本轮存下原声音频"后播放按钮可用
const canPlay = await evaluate(`(() => { window.__STUDIO.simulateRefBlob(); const st=window.__STUDIO.getState();
  return { blob: st.refBlob, disabled: document.getElementById('btnPlayRef').disabled }; })()`);
check('有原声音频时播放按钮可用', canPlay.blob === true && canPlay.disabled === false, JSON.stringify(canPlay));

console.log('\n── 改歌词 → 重新解析匹配 → 逐格改 → 确定 ──');
// 用户把歌词改成另一段（连续文本，长度不同），点「重新解析匹配」
const realign = await evaluate(`(() => {
  window.__STUDIO.setLyrics('两只老虎跑得快');
  const r = window.__STUDIO.realignLyrics();
  const st = window.__STUDIO.getState();
  return { r, charMap: st.charMap, editor: st.lyricEditorValue, status: st.lyricStatus };
})()`);
check('重排后 charMap 长度 = 7 个音符', realign.charMap?.length === 7, JSON.stringify(realign.charMap));
check('重排后歌词换成「两只老虎跑得快」', /两只老虎/.test(realign.editor), realign.editor);
check('重排状态提示按节奏匹配', /按原声节奏重新匹配/.test(realign.status), realign.status);
check('重排结果按句分行', realign.r?.phraseCount === 2, JSON.stringify(realign.r));
// 逐格改：把第 0 个音符上的字改成「喵」
const cellEdit = await evaluate(`(() => { const c = window.__STUDIO.setCellChar(0, '喵'); const st = window.__STUDIO.getState();
  return { c, map0: st.charMap[0], editor: st.lyricEditorValue, inputs: st.jceInputs }; })()`);
check('逐格改字写入 charMap 第 0 格', cellEdit.map0 === '喵', JSON.stringify(cellEdit));
check('逐格改字同步回歌词文本框', /喵/.test(cellEdit.editor), cellEdit.editor);
check('逐格改后输入框数不变', cellEdit.inputs === 7, String(cellEdit.inputs));
const confirmed2 = await evaluate(`window.__STUDIO.confirmLyrics()`);
check('确定后逐字对应锁定', /喵/.test(confirmed2.text), confirmed2.text);

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
// 「什么时候开始唱每一句」：第 2 句起音前的 3-2-1 提词
const cueHint = await evaluate(`(() => { window.__STUDIO.renderKaraokeAt(1.9);
  return document.getElementById('kHint').textContent; })()`);
check('下一句起音前给「第 2 句 · 3-2-1 准备起唱」', /第 2 句/.test(cueHint) && /准备起唱/.test(cueHint), cueHint);
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

console.log('\n── 小鸟音符对照图：飞得越高音越高，重合=准，点鸟听音，播放亮列 ──');
// （当前 DOM 是偏高清唱的结果：+100¢ 超出 ±50¢ 容差 → 全部不重合）
const nb = await evaluate(`(() => { const st = window.__STUDIO.getState();
  return { cols: st.nbCols, birds: st.nbBirds, tops: st.nbColTops }; })()`);
check('小鸟图有 7 列', nb.cols === 7, String(nb.cols));
check('偏高清唱是两只分开的鸟（14 只）', nb.birds === 14, String(nb.birds));
check('每列都有判定框色', nb.tops.every((t) => t.band !== ''), JSON.stringify(nb.tops.map(t=>t.band)));
check('偏高清唱不出现重合鸟（merged=0）', await evaluate(`document.querySelectorAll('.nb-bird.merged').length === 0`));
// 偏高清唱（+100¢ = 1 半音 ≈ +9% 高度）→ 你的鸟应明显飞得比原唱鸟高（my top < ref top）
const hi = await evaluate(`(() => { const st = window.__STUDIO.getState();
  const tops = st.nbColTops;
  return { refLow: tops[0].ref, myLow: tops[0].my, refHigh: tops[Math.max(...st.score.lines[1].units.map(u=>u.noteIdx))].ref }; })()`);
check('高音鸟飞得比低音鸟高（top 更小）', hi.refHigh < hi.refLow, JSON.stringify(hi));
check('偏高时你的鸟比原唱鸟飞得高（my < ref）', hi.myLow < hi.refLow - 4, JSON.stringify(hi));
// 点鸟试听（无麦克风引擎时安全返回）
const aud = await evaluate(`(() => { const st = window.__STUDIO.getState(); return st.auditionBird(0); })()`);
check('点鸟试听返回音高信息', aud.midi > 0, JSON.stringify(aud));
// 播放联动高亮：glowBirdAt(0.2) 应点亮第 0 列
const glow = await evaluate(`(() => { window.__STUDIO.glowBirdAt(0.2);
  return document.querySelectorAll('.nb-col.on').length; })()`);
check('播放到 0.2s 亮起当前列', glow === 1, String(glow));
await evaluate(`window.__STUDIO.glowBirdAt(99)`); // 越界不崩
check('越界时刻不崩、无亮列', await evaluate(`document.querySelectorAll('.nb-col.on').length === 0`));

console.log('\n── 自动时间对齐：整体晚开口不再"全没唱到" ──');
// 整段晚 0.8s 的完美清唱
const DELAYED = N([[60,0.8,1.3],[62,1.3,1.8],[64,1.8,2.3],[65,2.3,2.8],[67,3.8,4.3],[69,4.3,4.8],[71,4.8,5.3]]);
await evaluate(`window.__STUDIO.commitPracticeFrames(${DELAYED})`);
await sleep(300);
const sd = await evaluate(`window.__STUDIO.getState()`);
check('对齐后唱到 ≥6 字（不是全漏）', sd.practiceSummary.sung >= 6, JSON.stringify(sd.practiceSummary));
check('对齐后漏唱 ≤1', sd.practiceSummary.missed <= 1, String(sd.practiceSummary.missed));
check('结果标注已自动对齐', sd.practiceAlign?.aligned === true, JSON.stringify(sd.practiceAlign));

console.log('\n── 完美清唱：两鸟相碰开花 🌸（重合=又准又稳）──');
// 完美清唱（与参考完全一致）→ 每列都该合并成 1 只鸟（音准+节奏都在容差内）
await evaluate(`window.__STUDIO.commitPracticeFrames(${PERFECT})`);
await sleep(300);
const mergedPerfect = await evaluate(`document.querySelectorAll('.nb-bird.merged').length`);
check('完美清唱 7 列全部开花（merged=7）', mergedPerfect === 7, String(mergedPerfect));
check('花朵身标两个简谱（原唱+你唱）', await evaluate(`(() => {
  const b = document.querySelector('.nb-bird.merged');
  return b.textContent.includes('🌸') && b.querySelectorAll('.nb-jp').length === 2; })()`));
const singlePerfect = await evaluate(`(() => { const st = window.__STUDIO.getState(); return st.nbBirds; })()`);
check('完美清唱总鸟数 = 7（全是单只重合鸟）', singlePerfect === 7, String(singlePerfect));
check('完美清唱每只鸟都有云彩（气息长度）', await evaluate(`(() => {
  const cs = [...document.querySelectorAll('.nb-bird .nb-cloud')];
  return cs.length === 7 && cs.every(c => c.getBoundingClientRect().width > 5); })()`));
// 早/晚唱的清唱：前半句准时、后半句拖 0.35s（局部拖拍，整体对齐抹不平）
// → 拖拍的字鸟左右错开（dx>0 且不重合），准时的字仍重合；云彩始终在
const DRAG = N([[60,0,0.5],[62,0.5,1],[64,1,1.5],[65,1.5,2],[67,3.35,3.85],[69,3.85,4.35],[71,4.35,4.85]]);
await evaluate(`window.__STUDIO.commitPracticeFrames(${DRAG})`);
await sleep(300);
const nbD = await evaluate(`(() => { const st = window.__STUDIO.getState();
  return { tops: st.nbColTops, merged: document.querySelectorAll('.nb-bird.merged').length }; })()`);
check('局部拖拍 → 部分列没开花（0 < merged < 7）', nbD.merged > 0 && nbD.merged < 7,
  JSON.stringify({ merged: nbD.merged, dx: nbD.tops.map(t=>t.dx) }));
check('拖拍字的鸟往右错开（dx > 0）', nbD.tops.some((t) => t.dx > 5), JSON.stringify(nbD.tops.map(t=>t.dx)));

console.log('\n── 历史任意两段互比 ──');
const idA = await evaluate(`window.__STUDIO.importFrames(${REF}, '导入A')`);
const idB = await evaluate(`window.__STUDIO.importFrames(${SHARP}, '导入B')`);
const pair = await evaluate(`window.__STUDIO.comparePairIds('${idA}','${idB}')`);
await sleep(300);
const s5 = await evaluate(`window.__STUDIO.getState()`);
check('互比后 phase=result', s5.phase === 'result', s5.phase);
check('互比结果有字', s5.lrCells > 0, String(s5.lrCells));
check('互比偏高被识别', s5.practiceSummary.high > 0, String(s5.practiceSummary.high));
check('互比结果也有小鸟图', s5.nbCols === s5.lrCells, `${s5.nbCols} vs ${s5.lrCells}`);

console.log('\n── 播放按钮 / 无异常 ──');
check('播放 A/B 按钮可用', await evaluate(`!document.getElementById('btnPlayA').disabled && !document.getElementById('btnPlayB').disabled`));
check('无未捕获异常', await evaluate(`(() => !window.__err)()`));

console.log(`\nstudio-ui: ${pass} passed, ${fail} failed`);
if (fail) console.log('FAILURES:', fails.join('; '));
proc.kill('SIGKILL'); ws.close();
process.exit(fail ? 1 : 0);
