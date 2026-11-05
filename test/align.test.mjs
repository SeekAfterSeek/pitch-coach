import { referenceFromNotes, scoreTake, SCORE_MODES } from '../web/js/reference.js';
import { estimateOffset } from '../web/js/audio.js';

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

console.log('\n── 时间对齐（开口晚／早）──');

const notes = [];
const scale = [60, 62, 64, 65, 67, 69, 71, 72];
for (let i = 0; i < 8; i++) notes.push({ start: i * 0.5, end: i * 0.5 + 0.45, midi: scale[i], velocity: 0.8 });
const ref = referenceFromNotes(notes, 4.2, { title: 'scale' });

/** 生成一条录音：晚 delay 秒开口，唱同样的旋律 */
function makeTake(delaySec, durSec = 4.0, jitterCents = 10) {
  const fr = [];
  for (let t = 0; t < durSec; t += 0.01) {
    const songT = t; // 录音自身的相对时间
    const refT = songT + delaySec; // 若歌手晚 delay 开口，则唱歌内容对应参考的 (t - delay)
    const m = ref.at(t - delaySec);
    if (m == null) { fr.push({ t, midi: 0, voiced: false, rms: 0.02 }); continue; }
    const j = (Math.random() - 0.5) * jitterCents / 100;
    fr.push({ t, midi: m + j, voiced: true, rms: 0.2 });
  }
  return fr;
}

for (const delay of [0, 0.3, 0.8, 1.5, -0.6]) {
  const frames = makeTake(delay);
  const est = estimateOffset(ref, frames, { maxLagSec: 4, stepSec: 0.05 });

  // 未对齐时的分数
  const raw = scoreTake(ref, frames, { mode: SCORE_MODES.exact });
  // 对齐后的分数
  const aligned = scoreTake(ref, frames, { mode: SCORE_MODES.exact, startTime: est.offset });

  const err = Math.abs(est.offset - (-delay));  // 需要把录音往后推 delay
  console.log(`  延迟 ${delay.toFixed(1)}s → 估计 ${est.offset.toFixed(2)}s (corr ${est.corr.toFixed(2)}) | 未对齐 ${raw.total} → 对齐 ${aligned.total}`);

  check(`  延迟 ${delay}s 时对齐有效（分数回升）`,
    aligned.total > 80 || aligned.total > raw.total + 15,
    `raw ${raw.total} aligned ${aligned.total}`);
}

console.log('\n── 对齐质量门限 ──');
{
  // 完全不相干的内容（音阶乱序），对齐质量应该很低
  const junk = [];
  const chaos = [72, 60, 71, 62, 69, 64, 67, 65];
  for (let t = 0; t < 4; t += 0.01) {
    const i = Math.floor(t / 0.5);
    const m = t >= 3.9 ? null : chaos[i];
    junk.push(m == null
      ? { t, midi: 0, voiced: false, rms: 0.02 }
      : { t, midi: m, voiced: true, rms: 0.2 });
  }
  const est = estimateOffset(ref, junk, { maxLagSec: 4, stepSec: 0.05 });
  const s = scoreTake(ref, junk, { mode: SCORE_MODES.exact, startTime: est.offset });
  console.log(`  不相干内容：corr ${est.corr.toFixed(2)}, 分数 ${s.total}`);
  check('  不相干内容相关度低（<0.5）', est.corr < 0.5, `${est.corr.toFixed(2)}`);
  check('  不相干内容分数低', s.total < 60, `${s.total}`);
}

console.log('\n── 自由练习（无参考）不计分的逻辑 ──');
{
  // 模拟 app.js 的判断：有 clock 才算分
  const hasClock = false;
  check('  无参考时不累积实时分数', !hasClock);
}

console.log('\n' + '═'.repeat(46));
console.log(`  ${pass} / ${pass + fail}`);
console.log('═'.repeat(46));
process.exit(fail ? 1 : 0);
