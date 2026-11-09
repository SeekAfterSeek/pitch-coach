/**
 * practice.js 单元自测：逐字对比（原唱简谱 / 我唱简谱 / 高低 / 快慢 / 漏唱）
 */
import { detectKey, buildScore, flattenScore } from '../web/js/notation.js';
import { scorePracticeWords, groupWordsByLine, lineSummary, practiceBand, estimatePracticeOffset } from '../web/js/practice.js';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, extra); }
}
const N = (spec) => spec.map(([midi, start, end]) => ({ midi, start, end }));
/** 造练唱帧：spec = [[midi,start,end], ...]，midi=0 无声 */
const F = (spec) => {
  const a = [];
  for (const [midi, s, e] of spec) for (let t = s; t < e; t += 0.02) a.push({ t, midi, voiced: midi > 0, rms: 0.2, confidence: 0.9 });
  return a;
};

// 参考：C 大调 5 个音，一句"一闪一闪亮 晶晶"对应 1 2 3 4 5
const notes = N([
  [60,0,0.5],[62,0.5,1],[64,1,1.5],[65,1.5,2],
  [67,3,3.5],[69,3.5,4],[71,4,4.5],
]);
const key = detectKey(notes);
const score = buildScore(notes, key, '一闪一闪\n亮晶晶', { beatSec: 0.5 });
const units = flattenScore(score);

console.log('\n── 逐字谱结构 ──');
{
  ok('7 个字位', units.length === 7, String(units.length));
  ok('分 2 行', groupWordsByLine(scorePracticeWords(units, key, F([])).words).length === 2);
  ok('第1字=一 简谱 1', units[0].char === '一' && units[0].jianpu.digit === '1', JSON.stringify(units[0]));
}

console.log('\n── 完美清唱：原唱/我唱简谱一致、全准 ──');
{
  const perfect = F([[60,0,0.5],[62,0.5,1],[64,1,1.5],[65,1.5,2],[67,3,3.5],[69,3.5,4],[71,4,4.5]]);
  const r = scorePracticeWords(units, key, perfect, { tol: 50 });
  ok('全部唱到', r.summary.sung === 7 && r.summary.missed === 0, JSON.stringify(r.summary));
  ok('每个字 myNum == refNum', r.words.every((w) => w.myNum === w.refNum), JSON.stringify(r.words.map((w)=>[w.refNum,w.myNum])));
  ok('全准（accurate=7）', r.summary.accurate === 7, String(r.summary.accurate));
  ok('无高/低/快/慢', r.summary.high===0&&r.summary.low===0&&r.summary.early===0&&r.summary.late===0);
  ok('lineSummary = 唱得很准', lineSummary(groupWordsByLine(r.words)[0]) === '唱得很准', lineSummary(groupWordsByLine(r.words)[0]));
}

console.log('\n── 整体高一个半音：偏高、我唱简谱升一级 ──');
{
  const sharp = F([[61,0,0.5],[63,0.5,1],[65,1,1.5],[66,1.5,2],[68,3,3.5],[70,3.5,4],[72,4,4.5]]);
  const r = scorePracticeWords(units, key, sharp, { tol: 50 });
  ok('high=7', r.summary.high === 7, String(r.summary.high));
  ok('第1字 pitch=偏高', r.words[0].pitch === '偏高', r.words[0].pitch);
  ok('我唱简谱与目标不同', r.words[0].myNum !== r.words[0].refNum, `${r.words[0].refNum} vs ${r.words[0].myNum}`);
  ok('lineSummary 含偏高', /偏高/.test(lineSummary(groupWordsByLine(r.words)[0])), lineSummary(groupWordsByLine(r.words)[0]));
}

console.log('\n── 整体低：偏低 ──');
{
  const flat = F([[59,0,0.5],[61,0.5,1],[63,1,1.5],[64,1.5,2],[66,3,3.5],[68,3.5,4],[70,4,4.5]]);
  const r = scorePracticeWords(units, key, flat, { tol: 50 });
  ok('low=7', r.summary.low === 7, String(r.summary.low));
  ok('第1字 pitch=偏低', r.words[0].pitch === '偏低', r.words[0].pitch);
}

console.log('\n── 漏唱后半句 ──');
{
  const miss = F([[60,0,0.48],[62,0.5,0.98],[64,1,1.48],[65,1.5,1.98]]);
  const r = scorePracticeWords(units, key, miss, { tol: 50 });
  ok('missed=3', r.summary.missed === 3, String(r.summary.missed));
  ok('漏唱字 myNum=—', r.words[6].myNum === '—', r.words[6].myNum);
  ok('漏唱字 text=没唱到', r.words[6].text === '没唱到', r.words[6].text);
}

console.log('\n── 自动时间对齐（修复"全没唱到"） ──');
{
  // 整段晚开口 0.8s：不该判成全漏唱，对齐后应该基本全唱到
  const delayed = F([[60,0.8,1.3],[62,1.3,1.8],[64,1.8,2.3],[65,2.3,2.8],[67,3.8,4.3],[69,4.3,4.8],[71,4.8,5.3]]);
  const off = estimatePracticeOffset(units, delayed);
  ok('估计出接近 -0.8s 的偏移', Math.abs(off.shift + 0.8) < 0.15, JSON.stringify(off));
  ok('对齐可用', off.aligned === true);
  const r = scorePracticeWords(units, key, delayed, { tol: 50 });
  ok('对齐后不再"全没唱到"（sung≥6）', r.summary.sung >= 6, JSON.stringify(r.summary));
  ok('对齐后 missed 少', r.summary.missed <= 1, String(r.summary.missed));
  ok('结果带 align 信息', r.align && r.align.aligned === true);
}

console.log('\n── 快 / 慢（关掉自动对齐，测逐字节奏） ──');
{
  const early = F([[60,-0.12,0.38],[62,0.5,1],[64,1,1.5],[65,1.5,2],[67,3,3.5],[69,3.5,4],[71,4,4.5]]);
  const rE = scorePracticeWords(units, key, early, { tol: 50, autoAlign: false });
  ok('早唱 timingMs<0 / 快了', rE.words[0].timingMs < 0 && /快了/.test(rE.words[0].timing), JSON.stringify([rE.words[0].timingMs, rE.words[0].timing]));
  const late = F([[60,0.2,0.7],[62,0.7,1.2],[64,1.2,1.7],[65,1.7,2.2],[67,3,3.5],[69,3.5,4],[71,4,4.5]]);
  const rL = scorePracticeWords(units, key, late, { tol: 50, autoAlign: false });
  ok('晚唱 偏慢统计>0', rL.summary.late > 0, String(rL.summary.late));
}

console.log('\n── practiceBand ──');
{
  ok('0¢=perfect', practiceBand(0,50)==='perfect');
  ok('40¢=ok', practiceBand(40,50)==='ok');
  ok('90¢=sharp', practiceBand(90,50)==='sharp');
  ok('200¢=off', practiceBand(200,50)==='off');
}

console.log(`\npractice.test: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
