/** 歌词文本 → 逐句对齐 单元测试 */
import { alignTextToPhrases, cleanLyricChars } from '../web/js/lyrics.js';
import { jianpuTitle, notesToJianpu, detectKey } from '../web/js/notation.js';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, extra); }
}

console.log('\n── cleanLyricChars 去标点 ──');
{
  ok('去标点空白', cleanLyricChars('一 闪，一闪！').join('') === '一闪一闪', cleanLyricChars('一 闪，一闪！').join(''));
}

console.log('\n── alignTextToPhrases 连续文本按句切 ──');
{
  const counts = [4, 3];
  const out = alignTextToPhrases('一闪一闪亮晶晶', counts);
  ok('切成 2 行', out.split('\n').length === 2, out);
  ok('第1行 4 字 = 一闪一闪', out.split('\n')[0] === '一闪一闪', out.split('\n')[0]);
  ok('第2行 3 字 = 亮晶晶', out.split('\n')[1] === '亮晶晶', out.split('\n')[1]);
}
{
  const out = alignTextToPhrases('两只老虎跑得快', [4, 3]);
  ok('另一段歌词也按 4/3 切', out.split('\n')[0].length === 4 && out.split('\n')[1].length === 3, out);
}
console.log('\n── 用户按行写时优先按行 ──');
{
  const out = alignTextToPhrases('小星星\n亮晶晶', [4, 3]);
  ok('第1行取用户第1行（不足补○）', out.split('\n')[0].length === 4, out);
  ok('第2行取用户第2行', /亮晶晶/.test(out.split('\n')[1]), out);
}
console.log('\n── 字数不齐 ──');
{
  ok('字数不足补○', /○/.test(alignTextToPhrases('一', [4])), alignTextToPhrases('一', [4]));
  const many = alignTextToPhrases('一闪一闪亮晶晶满天都是小星星', [4]);
  ok('字数超出并入末字', many.length >= 4, many);
}
console.log('\n── jianpuTitle 中文说明 ──');
{
  const key = detectKey([{ midi: 60, start: 0, end: 1 }]);
  const s = notesToJianpu([{ midi: 68, start: 0, end: 1 }], key)[0]; // 6↓
  ok('符号无字母', !/[a-zA-Z]/.test(s.symbol), s.symbol);
  ok('说明含「偏低半音」', /偏低半音/.test(jianpuTitle(s)), jianpuTitle(s));
}

console.log(`\nlyrics-align.test: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
