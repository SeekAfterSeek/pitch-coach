/**
 * 「重新解析匹配」两步分离的单元测试
 *   第一步【第一性】：字↔音符一一对应（charMap）
 *   第二步【排版】：按用户标点句数决定谱子行切点（lineBreaks）
 * 核心原则：对应正确第一，排版美观在后；排版绝不破坏对应。
 */
import { realignLyricsToScore, alignTextToPhrases, cleanLyricChars } from '../web/js/lyrics.js';
import { buildScore, groupPhrases, detectKey, scoreCharMap } from '../web/js/notation.js';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, extra); }
}
const N = (spec) => spec.map(([midi, start, end]) => ({ midi, start, end }));
/** 展平 perLine（按行）→ 应等于 charMap（按音符顺序） */
const flatOf = (r) => r.perLine.flat();

// 两句：第1句 4 个音 / 唱 2.0s，第2句 3 个音 / 唱 1.5s（中间空档 1s）
const NOTES = N([
  [60, 0, 0.5], [62, 0.5, 1], [64, 1, 1.5], [65, 1.5, 2],
  [67, 3, 3.5], [69, 3.5, 4], [71, 4, 4.5],
]);
const GROUPS = groupPhrases(NOTES, { gapSec: 0.45 });
const KEY = detectKey(NOTES);

console.log('\n── 节奏骨架 ──');
ok('切成 2 句', GROUPS.length === 2, String(GROUPS.length));
ok('第1句 4 音 / 第2句 3 音', GROUPS[0].length === 4 && GROUPS[1].length === 3);

console.log('\n── 第一步：字↔音符一一对应（第一性）──');
{
  const r = realignLyricsToScore('一闪一闪亮晶晶', GROUPS);
  ok('charMap 长度 = 音符数 7', r.charMap.length === 7, JSON.stringify(r.charMap));
  ok('总字数 7', r.totalChars === 7, String(r.totalChars));
  ok('字按顺序钉进音符流：第1字=一 第4字=闪', r.charMap[0] === '一' && r.charMap[3] === '闪', JSON.stringify(r.charMap));
  ok('第5字=亮 第7字=晶', r.charMap[4] === '亮' && r.charMap[6] === '晶', JSON.stringify(r.charMap));
  ok('perLine 展平 = charMap（排版不破坏对应）', JSON.stringify(flatOf(r)) === JSON.stringify(r.charMap));
}

console.log('\n── 第二步：按用户标点排版（美观在后）──');
{
  // 用户写 1 个标点 = 2 句 → 谱子行切点应切成 2 行（虽然音频空档也是 2 句，这是巧合场景）
  const r = realignLyricsToScore('一闪一闪，亮晶晶', GROUPS);
  ok('识别到标点分句', r.byPunctuation === true && r.userPhrases === 2, JSON.stringify({ b: r.byPunctuation, u: r.userPhrases }));
  ok('排版行数 = 用户句数 2', r.lineBreaks.length === 2 && r.perLine.length === 2, JSON.stringify(r.lineBreaks));
  ok('第1行含「一闪一闪」', r.perLine[0].join('') === '一闪一闪', JSON.stringify(r.perLine));
  ok('第2行含「亮晶晶」', r.perLine[1].join('') === '亮晶晶', JSON.stringify(r.perLine));
  ok('对应关系仍在：charMap[0]=一', r.charMap[0] === '一', JSON.stringify(r.charMap));
  ok('lineBreaks 末项 = noteCount', r.lineBreaks[r.lineBreaks.length - 1] === 7, JSON.stringify(r.lineBreaks));

  // 用户写 3 个标点句（句数 ≠ 音频乐句数 2）→ 排版仍按用户的 3 句，对应不被破坏
  const r3 = realignLyricsToScore('一闪，一闪亮，晶晶', GROUPS);
  ok('3 个标点句 → 3 行排版', r3.perLine.length === 3, JSON.stringify(r3.perLine));
  ok('3 行排版下对应仍完整', JSON.stringify(flatOf(r3)) === JSON.stringify(r3.charMap), JSON.stringify(r3.charMap));
  ok('总字数不丢', r3.totalChars === 7, String(r3.totalChars));
}

console.log('\n── 用户手动分行（无标点）也按行排版 ──');
{
  const r = realignLyricsToScore('小星星\n亮晶晶', GROUPS);
  ok('2 行排版', r.perLine.length === 2, JSON.stringify(r.perLine));
  ok('第1行含「小星星」', r.perLine[0].join('').startsWith('小星星'), JSON.stringify(r.perLine));
  ok('不足补○', r.charMap.includes('○'), JSON.stringify(r.charMap));
  ok('对应完整', JSON.stringify(flatOf(r)) === JSON.stringify(r.charMap));
}

console.log('\n── 字数 > 音符数：多出的字并进时值最长的音符 ──');
{
  const g = [N([[60, 0, 0.5], [62, 0.5, 1], [64, 1, 1.5], [65, 1.5, 2], [67, 2, 2.5]])];
  const r = realignLyricsToScore('一二三四五六七八', g);
  ok('charMap 仍 5 格', r.charMap.length === 5, JSON.stringify(r.charMap));
  ok('有某格并了多字', r.charMap.some((c) => c.length > 1), JSON.stringify(r.charMap));
  ok('总字数不丢', r.charMap.join('').length === 8, r.charMap.join(''));
  // 最长音符（人为拉长第3音）应吃下多余字
  const g2 = [N([[60, 0, 0.5], [62, 0.5, 1], [64, 1, 2.5], [65, 2.5, 3], [67, 3, 3.5]])];
  const r2 = realignLyricsToScore('一二三四五六七八', g2);
  ok('多余字并进时值最长的音符', r2.charMap[2].length > 1, JSON.stringify(r2.charMap));
}

console.log('\n── 字数 < 音符数：补 ○ ──');
{
  const r = realignLyricsToScore('一', GROUPS);
  ok('charMap 长度仍 7', r.charMap.length === 7, JSON.stringify(r.charMap));
  ok('其余补○', r.charMap.filter((c) => c === '○').length === 6, JSON.stringify(r.charMap));
}

console.log('\n── charMap + lineBreaks 一起进 buildScore ──');
{
  const r = realignLyricsToScore('一闪一闪，亮晶晶', GROUPS);
  const score = buildScore(NOTES, KEY, r.text, { charMap: r.charMap, lineBreaks: r.lineBreaks });
  const flat = scoreCharMap(score);
  ok('score 逐字 = charMap（对应穿透排版保持一致）',
    JSON.stringify(flat) === JSON.stringify(r.charMap), JSON.stringify(flat));
  ok('谱子行数 = 用户句数 2', score.lines.length === 2, String(score.lines.length));
  ok('第1行字=一闪一闪', score.lines[0].units.map((u) => u.char).join('') === '一闪一闪',
    JSON.stringify(score.lines[0].units.map((u) => u.char)));
  ok('第2行字=亮晶晶', score.lines[1].units.map((u) => u.char).join('') === '亮晶晶',
    JSON.stringify(score.lines[1].units.map((u) => u.char)));
  ok('每字带 noteIdx 可反查', score.lines.every((l) => l.units.every((u) => Number.isInteger(u.noteIdx))));
  ok('每句带 phraseStart', score.lines.every((l) => Number.isFinite(l.phraseStart)));

  // 排版独立于对应：换一种断句（3 句），charMap 应不变
  const r3 = realignLyricsToScore('一闪，一闪亮，晶晶', GROUPS);
  const score3 = buildScore(NOTES, KEY, r3.text, { charMap: r3.charMap, lineBreaks: r3.lineBreaks });
  ok('3 句排版 → 谱子 3 行', score3.lines.length === 3, String(score3.lines.length));
  ok('不同断句下字音对应完全相同（对应第一性）',
    JSON.stringify(r3.charMap) === JSON.stringify(r.charMap),
    JSON.stringify({ a: r3.charMap, b: r.charMap }));
}

console.log('\n── 与旧 alignTextToPhrases 的差异（空行/占位行被忽略）──');
{
  const r = realignLyricsToScore('一闪一闪\n\n○○○\n亮晶晶', GROUPS);
  ok('空行/占位行不占句子', r.perLine.length === 2, JSON.stringify(r.perLine));
  ok('cleanLyricChars 去标点', cleanLyricChars('一 闪，一闪！').join('') === '一闪一闪');
  ok('旧函数仍可用', alignTextToPhrases('一闪一闪亮晶晶', [4, 3]).split('\n')[0] === '一闪一闪');
}

console.log(`\nrealign.test: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
