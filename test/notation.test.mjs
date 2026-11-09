/**
 * notation.js 单元自测：调性推断 / 简谱 / 逐字谱（音符+节拍）
 */
import {
  detectKey, notesToJianpu, groupPhrases, placeholderLyrics,
  buildScore, quantizeBeats, beatLabel, jianpuHtml,
} from '../web/js/notation.js';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, extra); }
}

/** 造音符：spec = [[midi, start, end], ...] */
const N = (spec) => spec.map(([midi, start, end]) => ({ midi, start, end }));

console.log('\n── detectKey 调性推断 ──');
{
  // C 大调音阶：C D E F G A B C（含时长）
  const cMajor = N([
    [60,0,0.5],[62,0.5,1],[64,1,1.5],[65,1.5,2],[67,2,2.5],
    [69,2.5,3],[71,3,3.5],[72,3.5,4.5],
  ]);
  const k = detectKey(cMajor);
  ok('C 大调：主音 C', k.tonic === 'C', k.name);
  ok('C 大调：mode=major', k.mode === 'major', k.name);
  ok('简谱调号 1=C', k.jianpuKey === '1=C', k.jianpuKey);
  ok('名字含「大调」', /大调/.test(k.name), k.name);
  ok('confidence > 0.5', k.confidence > 0.5, String(k.confidence));

  // G 大调音阶：G A B C D E F# G
  const gMajor = N([
    [55,0,0.5],[57,0.5,1],[59,1,1.5],[60,1.5,2],[62,2,2.5],
    [64,2.5,3],[66,3,3.5],[67,3.5,4.5],
  ]);
  const kg = detectKey(gMajor);
  ok('G 大调：主音 G', kg.tonic === 'G', kg.name);

  // A 小调音阶：A B C D E F G A（白键，A 小调）
  const aMinor = N([
    [57,0,0.5],[59,0.5,1],[60,1,1.5],[62,1.5,2],[64,2,2.5],
    [65,2.5,3],[67,3,3.5],[69,3.5,4.5],
  ]);
  const ka = detectKey(aMinor);
  ok('A 小调：主音 A', ka.tonic === 'A', ka.name);
  ok('A 小调：mode=minor', ka.mode === 'minor', ka.name);
  ok('小调简谱调号按关系大调 1=C', ka.jianpuKey === '1=C', ka.jianpuKey);

  // 空输入不崩
  ok('空音符返回默认 C 大调', detectKey([]).name === 'C 大调');
}

console.log('\n── notesToJianpu 简谱 ──');
{
  const key = detectKey(N([[60,0,1]])); // 1=C
  const jp = notesToJianpu(N([
    [60,0,0.5],[62,0.5,1],[64,1,1.5],[65,1.5,2],
    [67,2,2.5],[69,2.5,3],[71,3,3.5],
  ]), key);
  ok('C=1', jp[0].digit === '1', jp[0].symbol);
  ok('D=2', jp[1].digit === '2', jp[1].symbol);
  ok('E=3', jp[2].digit === '3', jp[2].symbol);
  ok('F=4', jp[3].digit === '4', jp[3].symbol);
  ok('G=5', jp[4].digit === '5', jp[4].symbol);
  ok('A=6', jp[5].digit === '6', jp[5].symbol);
  ok('B=7', jp[6].digit === '7', jp[6].symbol);
  ok('高八度 C5 → 1 带高点', notesToJianpu(N([[72,0,0.5]]), key)[0].octave === 1, JSON.stringify(notesToJianpu(N([[72,0,0.5]]), key)[0]));
  ok('低八度 C3 → 1 带低点', notesToJianpu(N([[48,0,0.5]]), key)[0].octave === -1);
  ok('半音 → #1', notesToJianpu(N([[61,0,0.5]]), key)[0].digit === '1' && notesToJianpu(N([[61,0,0.5]]), key)[0].accidental === '#');
}

console.log('\n── groupPhrases 乐句切分 ──');
{
  const notes = N([
    [60,0,0.5],[62,0.5,1],[64,1,1.5],         // 句1
    [65,3,3.5],[67,3.5,4],[69,4,4.5],         // 句2（1.5s 空档）
  ]);
  const g = groupPhrases(notes, { gapSec: 0.45 });
  ok('切成 2 句', g.length === 2, String(g.length));
  ok('句1 3 音符', g[0].length === 3);
  ok('句2 3 音符', g[1].length === 3);
  ok('占位歌词按句生成', placeholderLyrics(g) === '○○○\n○○○', placeholderLyrics(g));
}

console.log('\n── quantizeBeats / beatLabel ──');
{
  ok('0.5 = ½拍', beatLabel(quantizeBeats(0.5)) === '½拍');
  ok('1 = 1拍', beatLabel(quantizeBeats(1)) === '1拍');
  ok('2 = 2拍', beatLabel(quantizeBeats(2)) === '2拍');
  ok('0.26 ≈ ¼拍', quantizeBeats(0.26) === 0.25);
}

console.log('\n── buildScore 逐字谱（歌词+简谱+节拍） ──');
{
  const notes = N([
    [60,0,0.5],[62,0.5,1],[64,1,1.5],
    [65,2,2.5],[67,2.5,3],
  ]);
  const key = detectKey(notes);
  const score = buildScore(notes, key, '你好呀\n世界');
  ok('2 行', score.lines.length === 2, String(score.lines.length));
  ok('共 5 个字位', score.unitCount === 5, String(score.unitCount));
  ok('第1行第1字=你', score.lines[0].units[0].char === '你', JSON.stringify(score.lines[0].units.map(u=>u.char)));
  ok('第1行简谱 = 1 2 3', score.lines[0].units.map((u)=>u.jianpu.digit).join('') === '123', score.lines[0].units.map((u)=>u.jianpu.digit).join(''));
  ok('每个字有节拍', score.lines[0].units.every((u)=>u.beat && u.beatNum>0));
  ok('每个字有起止时间', score.lines[0].units.every((u)=>Number.isFinite(u.start) && Number.isFinite(u.end)));
  ok('有 bpm', score.bpm > 0, String(score.bpm));
  ok('歌词不足补占位○', buildScore(notes, key, '').lines[0].units[0].char === '○');
  ok('歌词超出并入末字', (() => {
    const s = buildScore(N([[60,0,1]]), key, '很多很多字');
    return s.lines[0].units[0].char.length > 1;
  })());
  ok('空音符返回空结构', buildScore([], key, 'a').lines.length === 0);
  ok('jianpuHtml 含数字', /1/.test(jianpuHtml(score.lines[0].units[0].jianpu)));
}

console.log(`\nnotation.test: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
