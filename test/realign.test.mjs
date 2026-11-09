/**
 * 节奏感知的「重新解析匹配」单元测试
 * 输入：用户改过的歌词 + 第一次录音解析出的乐句节奏骨架
 * 输出：charMap —— 按音符全局顺序精确钉死「哪个字对应哪个音符」
 */
import { realignLyricsToScore, alignTextToPhrases, cleanLyricChars } from '../web/js/lyrics.js';
import { buildScore, groupPhrases, detectKey, scoreCharMap } from '../web/js/notation.js';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, extra); }
}
const N = (spec) => spec.map(([midi, start, end]) => ({ midi, start, end }));

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

console.log('\n── 按节奏切分连续文本（不是按音符数硬切）──');
{
  const r = realignLyricsToScore('一闪一闪亮晶晶', GROUPS);
  ok('charMap 长度 = 音符数 7', r.charMap.length === 7, JSON.stringify(r.charMap));
  ok('第1句 4 字', r.perLine[0].length === 4, JSON.stringify(r.perLine));
  ok('第2句 3 字', r.perLine[1].length === 3, JSON.stringify(r.perLine));
  ok('总字数 7', r.totalChars === 7, String(r.totalChars));
  ok('noteCount=7 / phraseCount=2', r.noteCount === 7 && r.phraseCount === 2);
  ok('第1字=一 第4字=闪', r.charMap[0] === '一' && r.charMap[3] === '闪', JSON.stringify(r.charMap));
  ok('第5字=亮 第7字=晶', r.charMap[4] === '亮' && r.charMap[6] === '晶', JSON.stringify(r.charMap));
  // 唱得更久的句子分到更多字：2.0s vs 1.5s → 4:3
  ok('长句分到更多字', r.perLine[0].join('').length >= r.perLine[1].join('').length);
}

console.log('\n── 用户手动分行（行数=乐句数）完全尊重 ──');
{
  const r = realignLyricsToScore('小星星\n亮晶晶', GROUPS);
  ok('第1行取用户第1行', r.perLine[0].join('').startsWith('小星星'), JSON.stringify(r.perLine));
  ok('第2行取用户第2行', r.perLine[1].join('').startsWith('亮晶晶'), JSON.stringify(r.perLine));
  ok('不足补○', r.perLine[0].includes('○') || r.perLine[1].includes('○'), JSON.stringify(r.perLine));
}

console.log('\n── 字数 > 音符数：多出的字并进最长音符 ──');
{
  // 5 个等长音符，给 8 个字 → 前 5 一字一音，多出 3 字并进某格
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

console.log('\n── charMap 精确钉字进 buildScore ──');
{
  const r = realignLyricsToScore('一闪一闪亮晶晶', GROUPS);
  const score = buildScore(NOTES, KEY, r.text, { charMap: r.charMap });
  const flat = scoreCharMap(score);
  ok('score 逐字 = charMap（哪个字对应哪个音符一致）',
    JSON.stringify(flat) === JSON.stringify(r.charMap), JSON.stringify(flat));
  ok('第2句第2音（全局第6音）的字=晶', flat[5] === '晶', JSON.stringify(flat));
  ok('每字带 noteIdx 可反查', score.lines.every((l) => l.units.every((u) => Number.isInteger(u.noteIdx))));
  ok('每句带 phraseStart', score.lines.every((l) => Number.isFinite(l.phraseStart)));
  ok('phraseStart 是这句首音时刻', score.lines[0].phraseStart === 0 && score.lines[1].phraseStart === 3,
    JSON.stringify(score.lines.map((l) => l.phraseStart)));
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
