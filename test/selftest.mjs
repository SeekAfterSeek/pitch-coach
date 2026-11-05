/**
 * 自测：不依赖浏览器，直接验证核心算法
 * 运行：node test/selftest.mjs
 */

import { PitchDetector } from '../web/js/pitch.js';
import { FFT } from '../web/js/fft.js';
import { hzToMidi, midiToHz, midiToName, median, quantile } from '../web/js/util.js';
import { referenceFromNotes, scoreTake, SCORE_MODES, Reference, referenceFromFrames } from '../web/js/reference.js';
import { DEMO_TRACKS, nameToMidi } from '../web/js/demo.js';

let pass = 0, fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  ✗ ${name} ${detail}`); }
}

function section(t) { console.log(`\n── ${t} ──`); }

/* ═══════════ 1. FFT ═══════════ */
section('FFT');
{
  const n = 1024;
  const fft = new FFT(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  // 单频正弦：频率 bin = 64
  for (let i = 0; i < n; i++) re[i] = Math.cos(2 * Math.PI * 64 * i / n);
  fft.transform(re, im);
  const mags = [];
  for (let i = 1; i < n / 2; i++) mags.push(Math.hypot(re[i], im[i]));
  const peak = mags.indexOf(Math.max(...mags)) + 1;
  check('单频峰值落在正确 bin', peak === 64, `got ${peak}`);

  // 逆变换还原
  const re2 = Float64Array.from(re), im2 = Float64Array.from(im);
  fft.inverse(re2, im2);
  let err = 0;
  for (let i = 0; i < n; i++) {
    err = Math.max(err, Math.abs(re2[i] - Math.cos(2 * Math.PI * 64 * i / n)));
  }
  check('IFFT(FFT(x)) ≈ x', err < 1e-9, `max err ${err.toExponential(2)}`);
}

/* ═══════════ 2. 音高换算 ═══════════ */
section('音高换算');
{
  check('A4=440 → MIDI 69', Math.abs(hzToMidi(440) - 69) < 1e-9);
  check('MIDI 60 → 261.63Hz', Math.abs(midiToHz(60) - 261.6256) < 0.01);
  check('MIDI 60 → C4', midiToName(60) === 'C4');
  check('MIDI 69 → A4', midiToName(69) === 'A4');
  check('MIDI 61.5 → C#4', midiToName(61) === 'C#4');
  check('往返一致', Math.abs(midiToHz(hzToMidi(330)) - 330) < 1e-9);
}

/* ═══════════ 3. YIN 精度 ═══════════ */
section('YIN 音高检测');
{
  const sr = 48000;
  const W = 2048;
  const det = new PitchDetector(sr, { window: W });

  // 纯正弦
  const cases = [
    { hz: 82.41, name: 'E2' },
    { hz: 110.00, name: 'A2' },
    { hz: 146.83, name: 'D3' },
    { hz: 196.00, name: 'G3' },
    { hz: 261.63, name: 'C4' },
    { hz: 329.63, name: 'E4' },
    { hz: 440.00, name: 'A4' },
    { hz: 523.25, name: 'C5' },
    { hz: 659.26, name: 'E5' },
  ];

  let maxCentsErr = 0;
  for (const c of cases) {
    const buf = new Float32Array(W);
    for (let i = 0; i < W; i++) {
      buf[i] = 0.5 * Math.sin(2 * Math.PI * c.hz * i / sr)
        + 0.15 * Math.sin(4 * Math.PI * c.hz * i / sr)
        + 0.06 * Math.sin(6 * Math.PI * c.hz * i / sr);
    }
    const r = det.detect(buf);
    const err = Math.abs((hzToMidi(r.hz) - hzToMidi(c.hz)) * 100);
    maxCentsErr = Math.max(maxCentsErr, err);
    check(`${c.name} ${c.hz}Hz → ${r.hz.toFixed(2)}Hz (${err.toFixed(2)}¢)`, err < 12 && r.voiced, `err ${err.toFixed(2)}¢ voiced=${r.voiced}`);
  }
  check('全部单音误差 < 12 音分', maxCentsErr < 12, `max ${maxCentsErr.toFixed(2)}¢`);

  // 静音
  const silence = new Float32Array(W);
  const rs = det.detect(silence);
  check('静音判定为无声', rs.voiced === false && rs.hz === 0);

  // 白噪声
  const noise = new Float32Array(W);
  for (let i = 0; i < W; i++) noise[i] = (Math.random() - 0.5) * 0.3;
  const rn = det.detect(noise);
  check('白噪声不产生稳定音高', !rn.voiced || rn.confidence < 0.3, `conf ${rn.confidence?.toFixed(2)}`);

  // 微小偏差：+30 音分的 A4
  const detuned = 440 * Math.pow(2, 30 / 1200);
  const b2 = new Float32Array(W);
  for (let i = 0; i < W; i++) b2[i] = 0.5 * Math.sin(2 * Math.PI * detuned * i / sr);
  const rd = det.detect(b2);
  const devCents = (hzToMidi(rd.hz) - 69) * 100;
  check(`+30¢ 偏差可测出（测得 ${devCents.toFixed(1)}¢）`, Math.abs(devCents - 30) < 8, `got ${devCents.toFixed(1)}`);

  // 低八度误检检查：弱基频 + 强二次谐波
  const lowBuf = new Float32Array(W);
  const f0 = 130.81; // C3
  for (let i = 0; i < W; i++) {
    lowBuf[i] = 0.10 * Math.sin(2 * Math.PI * f0 * i / sr)
      + 0.45 * Math.sin(2 * Math.PI * 2 * f0 * i / sr)
      + 0.20 * Math.sin(2 * Math.PI * 3 * f0 * i / sr);
  }
  const rl = det.detect(lowBuf);
  const midiErr = Math.abs(hzToMidi(rl.hz) - hzToMidi(f0));
  check(`弱基频时不误判为高八度 (${rl.hz.toFixed(1)}Hz vs ${f0}Hz)`, midiErr < 1.2, `off by ${midiErr.toFixed(2)} semitones`);
}

/* ═══════════ 4. 参考轨道构建 ═══════════ */
section('参考轨道');
{
  const notes = [
    { start: 0, end: 0.5, midi: 60, velocity: 0.8 },
    { start: 0.5, end: 1.0, midi: 62, velocity: 0.8 },
    { start: 1.0, end: 1.5, midi: 64, velocity: 0.8 },
  ];
  const ref = referenceFromNotes(notes, 2, { title: 'test' });
  check('参考时长正确', Math.abs(ref.duration - 2) < 0.01, `${ref.duration}`);
  check('参考音域正确', ref.range.low >= 59 && ref.range.high <= 65, `${ref.range.low}–${ref.range.high}`);
  check('t=0.2 处为 C4', Math.abs(ref.at(0.2) - 60) < 0.01, `${ref.at(0.2)}`);
  check('t=0.7 处为 D4', Math.abs(ref.at(0.7) - 62) < 0.01, `${ref.at(0.7)}`);
  check('t=1.9 处无声', ref.at(1.9) === null);
  check('提取出 3 个音符段', ref.notes.length === 3, `${ref.notes.length}`);
}

/* ═══════════ 5. 评分引擎 ═══════════ */
section('评分引擎');
{
  const notes = [];
  for (let i = 0; i < 10; i++) {
    notes.push({ start: i * 0.5, end: i * 0.5 + 0.45, midi: 60 + i, velocity: 0.8 });
  }
  const ref = referenceFromNotes(notes, 5, { title: 'scale' });

  // 完美演唱
  const perfect = [];
  for (let t = 0; t < 5; t += 0.02) {
    const m = ref.at(t);
    perfect.push({ t, midi: m ?? 0, voiced: m != null, rms: 0.2 });
  }
  const sp = scoreTake(ref, perfect, { mode: SCORE_MODES.exact });
  check(`完美演唱得分 > 95（实得 ${sp.total}）`, sp.total > 95, `${sp.total}`);
  check('完美演唱准音率 100%', sp.pitchAccuracy > 0.98, `${sp.pitchAccuracy}`);

  // 全部高 50 音分（半个半音）
  const sharp = perfect.map((f) => ({ ...f, midi: f.voiced ? f.midi + 0.5 : 0 }));
  const ss = scoreTake(ref, sharp, { mode: SCORE_MODES.exact });
  check(`整体 +50¢ 应明显扣分（${ss.total}）`, ss.total < 80, `${ss.total}`);
  check('测出平均偏差 ≈ +50¢', Math.abs(ss.meanSignedCents - 50) < 6, `${ss.meanSignedCents.toFixed(1)}`);

  // 全部低一个全音（200 音分）
  const flat = perfect.map((f) => ({ ...f, midi: f.voiced ? f.midi - 2 : 0 }));
  const sf = scoreTake(ref, flat, { mode: SCORE_MODES.exact });
  check(`整体 -2 半音得分接近 0（${sf.total}）`, sf.total < 30, `${sf.total}`);

  // 一半不唱
  const half = perfect.map((f, i) => (i % 2 === 0 ? f : { ...f, voiced: false, midi: 0 }));
  const sh = scoreTake(ref, half, { mode: SCORE_MODES.exact });
  check(`漏唱一半覆盖率≈50%（${(sh.coverage * 100).toFixed(0)}%）`, Math.abs(sh.coverage - 0.5) < 0.12, `${sh.coverage}`);
  check(`漏唱一半应显著扣分（${sh.total}）`, sh.total < 70, `${sh.total}`);

  // 八度误判应被修正
  const oct = perfect.map((f) => ({ ...f, midi: f.voiced ? f.midi + 12 : 0 }));
  const so = scoreTake(ref, oct, { mode: SCORE_MODES.exact });
  check(`整首高八度演唱被识别并修正（得分 ${so.total}）`, so.total > 85, `${so.total}`);

  // 抖动
  const wobble = perfect.map((f, i) => ({
    ...f,
    midi: f.voiced ? f.midi + (i % 2 ? 0.28 : -0.28) : 0,
  }));
  const sw = scoreTake(ref, wobble, { mode: SCORE_MODES.exact });
  check(`抖动演唱 σ 变大（${sw.stdev.toFixed(1)}）`, sw.stdev > sp.stdev + 15, `${sw.stdev}`);

  // 5 音分与 25 音分必须能区分（不能有平台期）
  const c5 = perfect.map((f) => ({ ...f, midi: f.voiced ? f.midi + 0.05 : 0 }));
  const c25 = perfect.map((f) => ({ ...f, midi: f.voiced ? f.midi + 0.25 : 0 }));
  const s5 = scoreTake(ref, c5, { mode: SCORE_MODES.exact });
  const s25 = scoreTake(ref, c25, { mode: SCORE_MODES.exact });
  check(`5¢(${s5.total}) 与 25¢(${s25.total}) 得分可区分`, s5.total - s25.total > 3, `Δ=${(s5.total - s25.total).toFixed(1)}`);

  // 分数排序：完美 > 5¢ > 25¢ > 50¢ > 200¢
  check(`分数单调：${sp.total} > ${s5.total} > ${s25.total} > ${ss.total} > ${sf.total}`,
    sp.total > s5.total && s5.total > s25.total && s25.total > ss.total && ss.total > sf.total);
}

/* ═══════════ 6. 多条录音排行 ═══════════ */
section('多录音排行');
{
  const notes = [];
  const scale = [60, 62, 64, 65, 67, 69, 71, 72];
  for (let i = 0; i < 8; i++) notes.push({ start: i * 0.5, end: i * 0.5 + 0.45, midi: scale[i], velocity: 0.8 });
  const ref = referenceFromNotes(notes, 4, { title: 'do-re-mi' });

  const make = (offsetCents, jitterCents) => {
    const fr = [];
    for (let t = 0; t < 4; t += 0.02) {
      const m = ref.at(t);
      if (m == null) { fr.push({ t, midi: 0, voiced: false, rms: 0.1 }); continue; }
      const j = (Math.random() - 0.5) * jitterCents / 100; // 抖动以音分给出，换成半音
      fr.push({ t, midi: m + offsetCents / 100 + j, voiced: true, rms: 0.2 });
    }
    return fr;
  };

  const takes = [
    { name: 'A 精准', frames: make(0, 8) },
    { name: 'B 还行', frames: make(12, 20) },
    { name: 'C 偏高', frames: make(45, 30) },
    { name: 'D 跑调', frames: make(-90, 40) },
  ];
  const scored = takes.map((t) => ({ ...t, s: scoreTake(ref, t.frames, { mode: SCORE_MODES.exact }) }));
  scored.sort((a, b) => b.s.total - a.s.total);

  console.log('    排行：' + scored.map((x) => `${x.name}=${x.s.total}`).join(' > '));
  check('排行结果符合预期（精准 > 还行 > 偏高/跑调）',
    scored[0].name.includes('精准') && scored[3].name.includes('跑调'),
    scored.map((x) => x.name).join(','));
  check('分数单调不增', scored.every((x, i) => i === 0 || scored[i - 1].s.total >= x.s.total));
}

/* ═══════════ 7. 内置曲目 ═══════════ */
section('内置曲目');
{
  check('内置曲目数量 ≥ 6', DEMO_TRACKS.length >= 6, `${DEMO_TRACKS.length}`);
  for (const t of DEMO_TRACKS) {
    check(`「${t.title}」有音符且时长合理 (${t.notes.length} 音 / ${t.duration.toFixed(1)}s)`,
      t.notes.length > 0 && t.duration > 1, '');
    // 音符不重叠、时间递增
    let ok = true;
    for (let i = 1; i < t.notes.length; i++) {
      if (t.notes[i].start < t.notes[i - 1].end - 1e-6) { ok = false; break; }
    }
    check(`「${t.title}」音符时间有序不重叠`, ok);
  }
  check('音名解析 C4=60', nameToMidi('C4') === 60);
  check('音名解析 A4=69', nameToMidi('A4') === 69);
  check('音名解析 C#5=73', nameToMidi('C#5') === 73);
}

/* ═══════════ 8. 端到端：合成音频 → 检测 → 评分 ═══════════ */
section('端到端（合成音频）');
{
  const sr = 44100;
  const notes = [
    { start: 0, end: 0.6, midi: 60 },
    { start: 0.6, end: 1.2, midi: 64 },
    { start: 1.2, end: 1.8, midi: 67 },
    { start: 1.8, end: 2.4, midi: 72 },
  ];
  const dur = 2.6;
  const n = Math.floor(dur * sr);
  const sig = new Float32Array(n);
  for (const note of notes) {
    const f = midiToHz(note.midi);
    const i0 = Math.floor(note.start * sr);
    const i1 = Math.min(n, Math.floor(note.end * sr));
    for (let i = i0; i < i1; i++) {
      const t = i / sr;
      const env = Math.min(1, (i - i0) / (0.01 * sr)) * Math.min(1, (i1 - i) / (0.03 * sr));
      sig[i] += 0.4 * env * (
        Math.sin(2 * Math.PI * f * t) +
        0.3 * Math.sin(4 * Math.PI * f * t) +
        0.15 * Math.sin(6 * Math.PI * f * t)
      );
    }
  }

  // 逐帧检测
  const W = 2048, hop = 441;
  const det = new PitchDetector(sr, { window: W });
  const frames = [];
  for (let off = 0; off + W < n; off += hop) {
    det.detect(sig.subarray(off, off + W));
    const r = det.result;
    frames.push({ t: off / sr, midi: r.voiced ? r.midi : 0, voiced: r.voiced, rms: r.rms });
  }

  const detected = frames.filter((f) => f.voiced);
  check(`端到端检测到 ${detected.length} 个有声帧`, detected.length > 30, `${detected.length}/${frames.length}`);

  // 与原音高比对
  let correct = 0, total = 0;
  for (const fdn of detected) {
    const target = notes.find((x) => fdn.t >= x.start && fdn.t < x.end);
    if (!target) continue;
    total++;
    if (Math.abs(fdn.midi - target.midi) < 0.5) correct++;
  }
  const acc = correct / Math.max(1, total);
  check(`检测音高与真值一致率 ${(acc * 100).toFixed(1)}%`, acc > 0.95, `${(acc * 100).toFixed(1)}%`);

  // 用这段作为参考，再用同样内容"演唱"评分
  const ref = referenceFromFrames(frames, { title: 'synth', hop: 0.02 });
  const scored = scoreTake(ref, frames, { mode: SCORE_MODES.exact });
  check(`自我比对得分高（${scored.total}）`, scored.total > 85, `${scored.total}`);
}

/* ═══════════ 9. 性能 ═══════════ */
section('性能');
{
  const sr = 48000, W = 2048;
  const det = new PitchDetector(sr, { window: W });
  const buf = new Float32Array(W);
  for (let i = 0; i < W; i++) buf[i] = 0.4 * Math.sin(2 * Math.PI * 220 * i / sr);

  det.detect(buf); // 预热
  const N = 2000;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) det.detect(buf);
  const per = (performance.now() - t0) / N;
  check(`单帧检测 ${per.toFixed(3)}ms（需 < 5ms 才能 60fps）`, per < 5, `${per.toFixed(3)}ms`);
  console.log(`    理论最高帧率：${Math.round(1000 / per)} fps`);
}

/* ═══════════ 汇总 ═══════════ */
console.log('\n' + '═'.repeat(52));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败 ${fail}:`);
  for (const f of failures) console.log('   · ' + f);
}
console.log('═'.repeat(52));
process.exit(fail ? 1 : 0);
