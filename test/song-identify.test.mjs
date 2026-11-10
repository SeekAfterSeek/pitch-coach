/** song-identify.js 单元测试：歌词行拆分 / LRC 清洗（网络部分只测降级路径） */
import { splitSongLines, lrcToPlainLines } from '../web/js/song-identify.js';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, extra); }
}

console.log('\n── splitSongLines 整首歌词拆行 ──');
{
  const plain = '一闪一闪亮晶晶\n满天都是小星星\n\n挂在天上放光明\n好像许多小眼睛';
  const lines = splitSongLines(plain);
  ok('拆出 5 行（含 1 空行）', lines.length === 5, String(lines.length));
  ok('第 1 行文本', lines[0].text === '一闪一闪亮晶晶', lines[0].text);
  ok('空行标记 blank', lines[2].blank === true);
  ok('非空行 blank=false', lines[0].blank === false);
}

console.log('\n── lrcToPlainLines 去 LRC 时间戳 ──');
{
  const lrc = '[00:17.12]一闪一闪亮晶晶\n[00:21.50]满天都是小星星\n[00:25.00]\n[00:00.00]作词：某人';
  const lines = lrcToPlainLines(lrc);
  ok('去时间戳', lines[0] === '一闪一闪亮晶晶', JSON.stringify(lines));
  ok('丢掉空时间戳行', lines.length === 2, String(lines.length));
  ok('丢掉元信息行', !lines.some((l) => /作词/.test(l)), JSON.stringify(lines));
}

console.log(`\nsong-identify.test: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
