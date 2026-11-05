/**
 * 歌词模块自测：解析、索引、候选打分、文件名推断
 * 运行：node test/lyrics.test.mjs
 */

import {
  parseLRC, toIntervals, lineAt, rankLyricCandidates,
  isUsableLyrics, guessTitleArtist, distributeByLines,
} from '../web/js/lyrics.js';

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  ✗ ${name} ${detail}`); }
}
function section(t) { console.log(`\n── ${t} ──`); }

/* ═══════════ LRC 解析 ═══════════ */
section('LRC 解析');
{
  const lrc = `[ti:大鱼]
[ar:周深]
[00:00.00]大鱼 - 周深
[00:14.42]词：尹约
[00:28.85]曲：钱雷
[00:43.27]海浪无声将夜幕深深淹没
[00:50.12]漫过天空尽头的角落
[00:57.00]大鱼在梦境的缝隙里游过`;

  const lines = parseLRC(lrc);
  check('解析出行数 > 0', lines.length > 0, `${lines.length} 行`);
  check('时间升序排列', lines.every((l, i) => i === 0 || lines[i - 1].time <= l.time));

  const first = lines.find((l) => l.text.includes('海浪无声'));
  check('时间戳精度正确（43.27s）', first && Math.abs(first.time - 43.27) < 0.01,
    first ? first.time : 'not found');

  check('过滤掉了作词/作曲元信息',
    !lines.some((l) => l.time < 30 && /^(词|曲)[:：]/.test(l.text)));

  // 毫秒三位格式
  const lrc2 = '[00:12.345]三位毫秒';
  const p2 = parseLRC(lrc2);
  check('三位毫秒 [mm:ss.xxx]', Math.abs(p2[0].time - 12.345) < 0.001, `${p2[0]?.time}`);

  // 同一行多个时间戳（重复副歌）
  const lrc3 = '[00:10.00][01:30.00]重复的副歌';
  const p3 = parseLRC(lrc3);
  check('多时间戳展开为多行', p3.length === 2, `${p3.length}`);
  check('多时间戳时间都正确',
    Math.abs(p3[0].time - 10) < 0.01 && Math.abs(p3[1].time - 90) < 0.01);

  // 无时间戳的纯文本
  const p4 = parseLRC('只有歌词没有时间\n第二行');
  check('无时间戳返回空数组', p4.length === 0, `${p4.length}`);

  // 空输入
  check('空输入不崩溃', parseLRC('').length === 0 && parseLRC(null).length === 0);
}

/* ═══════════ 区间与查找 ═══════════ */
section('时间轴索引');
{
  const lines = [
    { time: 10, text: '第一句' },
    { time: 20, text: '第二句' },
    { time: 30, text: '第三句' },
  ];
  const iv = toIntervals(lines, 40);
  check('区间数量正确', iv.length === 3);
  check('第一句区间 [10,20]', iv[0].start === 10 && iv[0].end === 20);
  check('最后一句延伸到总时长', iv[2].end === 40, `${iv[2].end}`);

  check('t=5 尚无歌词', lineAt(iv, 5).index === -1);
  check('t=10 命中第一句', lineAt(iv, 10).line?.text === '第一句');
  check('t=15 仍在第一句', lineAt(iv, 15).line?.text === '第一句');
  check('t=20 切到第二句', lineAt(iv, 20).line?.text === '第二句');
  check('t=25 进度 0.5', Math.abs(lineAt(iv, 25).progress - 0.5) < 0.01,
    `${lineAt(iv, 25).progress}`);
  check('t=100 停在最后一句', lineAt(iv, 100).line?.text === '第三句');
  check('空歌词不崩溃', lineAt([], 10).line === null && lineAt(null, 10).line === null);

  // 二分查找正确性：逐秒验证
  let allOk = true;
  for (let t = 0; t <= 45; t += 1) {
    const r = lineAt(iv, t);
    const expect = t < 10 ? null : t < 20 ? '第一句' : t < 30 ? '第二句' : '第三句';
    if ((r.line?.text ?? null) !== expect) { allOk = false; break; }
  }
  check('逐秒遍历结果全部正确', allOk);
}

/* ═══════════ 候选打分 ═══════════ */
section('自动匹配打分');
{
  const want = { title: '大鱼', artist: '周深', duration: 293 };

  const results = [
    // 完美：同步 + 歌名歌手时长全对
    { trackName: '大鱼', artistName: '周深', duration: 293, syncedLyrics: '[00:01.00]a\n[00:02.00]b\n[00:03.00]c\n[00:04.00]d\n[00:05.00]e\n[00:06.00]f' },
    // 伴奏版：有时间轴但应该被压下去
    { trackName: '大鱼 (Instrumental)', artistName: '周深', duration: 293, syncedLyrics: '[00:01.00]x' },
    // 无同步歌词
    { trackName: '大鱼', artistName: '周深', duration: 293, plainLyrics: '纯文本' },
    // 歌手不对、时长差很多
    { trackName: '大鱼', artistName: '某翻唱歌手', duration: 200, syncedLyrics: '[00:01.00]z'.repeat(7) },
    // 完全不相干
    { trackName: '完全无关的歌', artistName: '别人', duration: 300, syncedLyrics: '[00:01.00]q\n[00:02.00]w' },
  ];

  const ranked = rankLyricCandidates(results, want);
  check('返回结果按分数降序',
    ranked.every((r, i) => i === 0 || ranked[i - 1]._score >= r._score));

  check('第一名是同步 + 歌名歌手时长都对的',
    ranked[0].trackName === '大鱼' && ranked[0].artistName === '周深' && !!ranked[0].syncedLyrics,
    ranked[0].trackName);

  const instr = ranked.find((r) => /Instrumental/i.test(r.trackName));
  check('伴奏版被压到后面（低于正常版）',
    instr._score < ranked[0]._score, `${instr._score} vs ${ranked[0]._score}`);

  const noSync = ranked.find((r) => !r.syncedLyrics && r.plainLyrics);
  check('无同步歌词的排在同步版之后', noSync._score < ranked[0]._score);

  check('isUsableLyrics 认可最佳候选', isUsableLyrics(ranked[0]) === true);
  check('isUsableLyrics 否决不存在的', isUsableLyrics(null) === false);
  check('isUsableLyrics 否决无同步歌词的', isUsableLyrics(noSync) === false);
}

/* ═══════════ 文件名推断 ═══════════ */
section('文件名推断歌名歌手');
{
  const cases = [
    ['周深 - 大眠 (清唱版).ogg', '周深', '大眠'],
    ['周深 - 年轮 (Live).flac', '周深', '年轮'],
    ['周深 - 东北摇篮曲 (2024 9_29Hz巡回演唱会沈阳站).ogg', '周深', '东北摇篮曲'],
    ['毛不易 _ 周深 - Got It (Live).ogg', '毛不易 / 周深', 'Got It'],
    ['陈楚生 _ 周深 - 凄美地 (Live).ogg', '陈楚生 / 周深', '凄美地'],
    ['没有分隔符的歌名.ogg', '', '没有分隔符的歌名'],
  ];
  for (const [file, wantArtist, wantTitle] of cases) {
    const r = guessTitleArtist(file);
    check(`「${file.slice(0, 28)}」→ ${r.artist || '(无)'} / ${r.title}`,
      r.title === wantTitle && (wantArtist === '' || r.artist === wantArtist),
      `得到 artist=${r.artist} title=${r.title}`);
  }

  const withVer = guessTitleArtist('周深 - 大鱼 (Live).ogg');
  check('版本标记被收集', /live/i.test(withVer.versions), withVer.versions);
}

/* ═══════════ 纯文本兜底 ═══════════ */
section('纯文本按行分配时间');
{
  const plain = '第一行歌词\n第二行比较长一些\n第三行';
  const d = distributeByLines(plain, 30);
  check('行数正确', d.length === 3);
  check('时间单调递增', d.every((x, i) => i === 0 || d[i - 1].time <= x.time));
  check('首行从 0 开始', d[0].time === 0);
  check('末行早于总时长', d[2].time < 30, `${d[2].time}`);
  check('空文本返回空', distributeByLines('', 30).length === 0);
}

console.log('\n' + '═'.repeat(50));
console.log(`  ${pass} / ${pass + fail}`);
if (fail) {
  console.log('  失败:');
  for (const f of failures) console.log('   · ' + f);
}
console.log('═'.repeat(50));
process.exit(fail ? 1 : 0);
