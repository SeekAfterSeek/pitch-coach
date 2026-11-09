/**
 * compare.js 单元自测：任意两段人声的解析 / 对齐 / 整体评分 / 逐音符诊断
 * 用合成帧验证，不依赖浏览器与麦克风。
 */
import {
  parseVocal, alignVocals, shiftFrames, diagnoseNotes,
  compareVocals, compareBand, compareSummary,
} from '../web/js/compare.js';
import { HOP_SEC, SCORE_MODES } from '../web/js/reference.js';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, extra); }
}

/** 造帧：spec = [[midi, start, end], ...]，midi=0 表示无声 */
function makeFrames(spec) {
  const frames = [];
  for (const [midi, s, e] of spec) {
    for (let t = s; t < e; t += HOP_SEC) {
      frames.push({ t, midi, voiced: midi > 0, rms: 0.2, confidence: 0.9 });
    }
  }
  return frames;
}
const A = () => makeFrames([[60, 0, 1], [64, 1, 2], [67, 2, 3]]); // C4 E4 G4

console.log('\n── parseVocal：解析一段纯人声 ──');
{
  const p = parseVocal(A());
  ok('生成参考轨', !!p.ref && p.ref.frames > 0);
  ok('时长 ≈3s', Math.abs(p.duration - 3) < 0.2, p.duration);
  ok('提取到 3 个音符', p.notes.length === 3, p.notes.length);
  ok('第一个音符 = C4', Math.round(p.notes[0].midi) === 60, p.notes[0]?.midi);
  ok('非静音', p.silent === false);
  ok('全静音被判 silent', parseVocal(makeFrames([[0, 0, 2]])).silent === true);
}

console.log('\n── compareBand 分档 ──');
{
  ok('0¢ = perfect', compareBand(0, 50) === 'perfect');
  ok('40¢ = ok', compareBand(40, 50) === 'ok');
  ok('90¢ = sharp', compareBand(90, 50) === 'sharp');
  ok('200¢ = off', compareBand(200, 50) === 'off');
}

console.log('\n── shiftFrames：时间平移不改原数组 ──');
{
  const f = makeFrames([[60, 0, 0.2]]);
  const sh = shiftFrames(f, 0.5);
  ok('平移后首个 t = 0.5', Math.abs(sh[0].t - 0.5) < 1e-9, sh[0].t);
  ok('原数组不变', f[0].t === 0, f[0].t);
}

console.log('\n── alignVocals：整体晚开口应被对齐 ──');
{
  const ref = parseVocal(A()).ref;
  // B 整体晚 0.4s，且尾部截短一点
  const late = makeFrames([[60, 0.4, 1.4], [64, 1.4, 2.4], [67, 2.4, 3.4]]);
  const al = alignVocals(ref, late, { minCorr: 0.2 });
  ok('估计出接近 -0.4s 的偏移', Math.abs(al.offset + 0.4) < 0.12, al.offset);
  ok('对齐可用', al.aligned === true, JSON.stringify(al));
}

console.log('\n── diagnoseNotes：逐音符偏高/偏低/漏唱/快/慢 ──');
{
  const notes = parseVocal(A()).notes;
  // 完美
  const d1 = diagnoseNotes(notes, A(), { mode: SCORE_MODES.exact });
  ok('3 个音符都唱到', d1.filter((d) => d.status === 'sung').length === 3, JSON.stringify(d1.map(d=>d.status)));
  ok('全部音准', d1.every((d) => d.status !== 'sung' || Math.abs(d.dev) < 1), JSON.stringify(d1.map(d=>d.dev)));
  ok('文案含音名', /C4/.test(d1[0].text), d1[0].text);

  // 整体高一个半音（60→61 等）
  const sharp = makeFrames([[61, 0, 1], [65, 1, 2], [68, 2, 3]]);
  const d2 = diagnoseNotes(notes, sharp, { mode: SCORE_MODES.exact });
  ok('偏高被识别（dev>0）', d2.every((d) => d.dev > 0), JSON.stringify(d2.map(d=>d.dev)));
  ok('偏高文案', /偏高|跑高/.test(d2[0].text), d2[0].text);

  // 偏低
  const flat = makeFrames([[59, 0, 1], [63, 1, 2], [66, 2, 3]]);
  const d3 = diagnoseNotes(notes, flat, { mode: SCORE_MODES.exact });
  ok('偏低被识别（dev<0）', d3.every((d) => d.dev < 0), JSON.stringify(d3.map(d=>d.dev)));

  // 漏唱最后一个音（第三窗口 2-3s 无声）
  const miss = makeFrames([[60, 0, 0.92], [64, 1.02, 1.95]]);
  const d4 = diagnoseNotes(notes, miss, { mode: SCORE_MODES.exact });
  ok('漏唱被识别', d4.filter((d) => d.status === 'missed').length === 1, JSON.stringify(d4.map(d=>d.status)));
  ok('漏唱文案 = 没唱到', d4[2].text === '没唱到', d4[2].text);

  // 整体早唱 0.15s（在 reach 内）
  const early = makeFrames([[60, -0.15, 0.85], [64, 0.85, 1.85], [67, 1.85, 2.85]]);
  const d5 = diagnoseNotes(notes, early, { mode: SCORE_MODES.exact });
  ok('早唱 timing<0', d5[0].timing < 0, d5[0].timing);

  // 整体晚唱 0.2s
  const late = makeFrames([[60, 0.2, 1.2], [64, 1.2, 2.2], [67, 2.2, 3.2]]);
  const d6 = diagnoseNotes(notes, late, { mode: SCORE_MODES.exact });
  ok('晚唱 timing>0', d6[0].timing > 0, d6[0].timing);
}

console.log('\n── compareVocals：完整对比 ──');
{
  const perfect = compareVocals(A(), A(), { snap: true });
  ok('ok=true', perfect.ok === true);
  ok('有总分', perfect.score && typeof perfect.score.total === 'number');
  ok('完美对比总分高', perfect.score.total >= 90, perfect.score.total);
  ok('准音率 100%', Math.round(perfect.score.pitchAccuracy * 100) === 100, perfect.score.pitchAccuracy);
  ok('有逐音符诊断', perfect.notes.length === 3, perfect.notes.length);
  ok('有 B 着色轨迹', perfect.trackFrames.length > 0);
  ok('有参考轨', !!perfect.ref);
  ok('有摘要文案', typeof compareSummary(perfect) === 'string' && compareSummary(perfect).includes('总分'), compareSummary(perfect));

  // 偏高对比：整体分下降、偏高统计>0
  const sharp = compareVocals(A(), makeFrames([[61,0,1],[65,1,2],[68,2,3]]), { snap: true });
  ok('偏高使总分下降', sharp.score.total < perfect.score.total, `${sharp.score.total} vs ${perfect.score.total}`);
  ok('偏高统计 high>0', sharp.stats.high > 0, sharp.stats.high);

  // 漏唱对比：missed>0，覆盖度<1
  const miss = compareVocals(A(), makeFrames([[60,0,0.92],[64,1.02,1.95]]), { snap: true });
  ok('漏唱 missed>0', miss.stats.missed > 0, miss.stats.missed);
  ok('漏唱覆盖度<1', miss.score.coverage < 1, miss.score.coverage);

  // 空参考 → ok=false
  const empty = compareVocals(makeFrames([[0,0,2]]), A());
  ok('空参考返回 ok=false', empty.ok === false, JSON.stringify(empty.ok));

  // 八度差异：整体高八度不应明显扣分（scoreTake 内部折算）
  const octave = compareVocals(A(), makeFrames([[72,0,1],[76,1,2],[79,2,3]]), { snap: true });
  ok('整体高八度得分仍高', octave.score.total >= 85, octave.score.total);
}

console.log(`\ncompare.test: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
