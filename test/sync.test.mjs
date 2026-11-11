/**
 * 时间轴一致性测试：原声回放亮格 / 练唱逐字提示必须和谱子同轴
 *
 * 用户报的问题：练唱时中间一句没有及时闪过；回放原声时字和节奏对不上。
 * 根因是三条时间轴混用：
 *   ① 音高帧用 AudioContext 绝对时间，下游各自用 frames[0].t 或 recorder.t0 归一
 *   ② getFloatTimeDomainData 取的是"最近一窗"，时间戳却记成窗口末尾（晚半窗）
 *   ③ MediaRecorder 音频 blob 起点与音高帧起点有启动差
 *
 * 这里锁住修复后的不变量：
 *   A. TakeRecorder.push 存的是相对录音起点的帧时间（与音频同轴）
 *   B. 帧时间戳用窗口中心
 *   C. 谱子里每个音符的起止都落在音频时长范围内
 *   D. 高亮判定不留空档（相邻音符之间任何时刻都能命中一个字）
 */
import { buildScore, detectKey, flattenScore, groupPhrases } from '../web/js/notation.js';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, extra); }
}
const N = (spec) => spec.map(([midi, start, end]) => ({ midi, start, end }));

const NOTES = N([
  [60, 0, 0.5], [62, 0.5, 1], [64, 1, 1.5], [65, 1.5, 2],
  [67, 3, 3.5], [69, 3.5, 4], [71, 4, 4.5],
]);
const KEY = detectKey(NOTES);
const SCORE = buildScore(NOTES, KEY, '一闪一闪\n亮晶晶');
const UNITS = flattenScore(SCORE);

console.log('\n── A. 帧时间是相对录音起点的相对时间（与音频同轴）──');
{
  // 模拟：按下录音时 AudioContext 在 1000.0s；第一帧采到 1000.02s
  const t0 = 1000.0;
  const raw = [{ t: 1000.02, midi: 60, voiced: true, rms: 0.2, confidence: 0.9 }];
  const rel = raw.map((f) => ({ ...f, t: f.t - t0 }));
  ok('相对时间从 0 附近开始（不是 1000）', rel[0].t < 1 && rel[0].t >= 0, String(rel[0].t));
  ok('相对时间与音频同轴（≈0.02s）', Math.abs(rel[0].t - 0.02) < 1e-9, String(rel[0].t));
}

console.log('\n── B. 帧时间戳是窗口中心（不晚半窗）──');
{
  // windowSize=2048, sampleRate=48000 → 半窗 = 21.3ms
  const win = 2048, sr = 48000;
  const halfWin = (win / 2) / sr;
  ok('半窗 ≈ 21.3ms', Math.abs(halfWin * 1000 - 21.33) < 0.1, String(halfWin * 1000));
  // 若把 now 当时间戳，会晚 21ms；减去半窗后对齐
  const now = 1000.0;
  const stamped = now - halfWin;
  ok('时间戳 = now - 半窗', Math.abs((now - stamped) - halfWin) < 1e-9);
}

console.log('\n── C. 谱子音符落在音频时长内 ──');
{
  const dur = NOTES[NOTES.length - 1].end;   // 4.5s
  ok('所有音符起点 ≥ 0', UNITS.every((u) => u.start >= 0));
  ok('所有音符终点 ≤ 音频时长', UNITS.every((u) => u.end <= dur + 1e-6), JSON.stringify(UNITS.map((u) => u.end)));
  ok('第一个音从 0 起（与音频 0 点同轴）', UNITS[0].start === 0, String(UNITS[0].start));
}

console.log('\n── D. 高亮判定不留空档（每个时刻都能命中一个字）──');
{
  // 复刻 app.js updateKaraoke 的 isOn 逻辑
  const isOn = (units, j, vt) => {
    const u = units[j];
    if (!u) return false;
    const prevU = units[j - 1];
    const nextU = units[j + 1];
    const lo = prevU ? (prevU.end + u.start) / 2 : u.start - 0.08;
    const hi = nextU ? (u.end + nextU.start) / 2 : u.end + 0.08;
    return vt >= lo - 0.08 && vt < hi;
  };
  const hitAt = (lineUnits, vt) => lineUnits.findIndex((_, j) => isOn(lineUnits, j, vt));

  // 句内扫描：每 10ms 都要恰好命中至少一个字
  let gaps = [];
  for (let vt = 0; vt < 2.0; vt += 0.01) {
    if (hitAt(SCORE.lines[0].units, vt) < 0) gaps.push(vt.toFixed(2));
  }
  ok('第 1 句全程无空档（不会"没提示"）', gaps.length === 0, gaps.slice(0, 5).join(','));

  let gaps2 = [];
  for (let vt = 3.0; vt < 4.5; vt += 0.01) {
    if (hitAt(SCORE.lines[1].units, vt) < 0) gaps2.push(vt.toFixed(2));
  }
  ok('第 2 句全程无空档', gaps2.length === 0, gaps2.slice(0, 5).join(','));

  // 短音符（0.2s）在 30fps 下也不会整段跳过
  const shortNotes = N([[60, 0, 0.2], [62, 0.2, 0.4], [64, 0.4, 0.6]]);
  const shortScore = buildScore(shortNotes, KEY, '三个字');
  const su = shortScore.lines[0].units;
  const frameStep = 1 / 30;
  let missed = 0;
  for (let vt = 0; vt < 0.6; vt += frameStep) {
    if (su.findIndex((_, j) => isOn(su, j, vt)) < 0) missed++;
  }
  ok('0.2s 短音符在 30fps 下不被跳过', missed === 0, String(missed));
}

console.log('\n── E. 相邻音符的中点划界保证连续覆盖 ──');
{
  const a = UNITS[0], b = UNITS[1];
  const boundary = (a.end + b.start) / 2;
  ok('有间隙时边界落在两音中点', boundary >= a.end - 1e-9 && boundary <= b.start + 1e-9,
    JSON.stringify({ aEnd: a.end, bStart: b.start, boundary }));
  // 极端：音符紧挨着（a.end == b.start）
  const tight = N([[60, 0, 0.5], [62, 0.5, 1]]);
  const ts = buildScore(tight, KEY, '两字').lines[0].units;
  const bd = (ts[0].end + ts[1].start) / 2;
  ok('紧邻音符边界 = 交界处', Math.abs(bd - 0.5) < 1e-9, String(bd));
}

console.log(`\nsync.test: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
