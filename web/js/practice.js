/**
 * 练唱逐字对比（无 DOM，可单测）
 * ═══════════════════════════════════════════════════════════
 * 输入：
 *   - units：buildScore 展平后的字位（每个字带 char / jianpu(原唱简谱) /
 *            beat(节拍) / start,end / midi(目标音高)）
 *   - key：detectKey 结果（用于把"我唱的音"翻成简谱）
 *   - takeFrames：练唱录音的逐帧音高 {t,midi,voiced,rms,confidence}
 *   - opts.tol：音准容差（音分，默认 50）
 *
 * 输出：每个字的诊断
 *   - char 歌词字
 *   - refNum 原唱简谱（如 "1" / "4↑" / "5˙"，纯数字+↑↓+八度点）
 *   - myNum  我唱的简谱（同上；没唱到为 '—'）
 *   - pitch  偏高 / 偏低 / 准 / 没唱到
 *   - timing 快了 / 慢了 / 节奏准（含毫秒）
 *   - band   用于着色
 *
 * 判定口径（与 compare.js 一致）：
 *   - 按字位边界做 Voronoi 分区，避免相邻字尾音串味
 *   - 音高取严格落在 [start,end) 内的有声帧均值
 *   - 起音时刻 = 分区内首个有声帧；与 start 之差即快/慢
 */

import { midiToJianpu } from './notation.js';
import { mean, clamp } from './util.js';

export function practiceBand(devCents, tol) {
  const abs = Math.abs(devCents);
  if (abs <= tol * 0.5) return 'perfect';
  if (abs <= tol) return 'ok';
  if (abs <= tol * 2) return 'sharp';
  return 'off';
}

/** 单字诊断文案 */
export function practiceWordText(r, tol) {
  if (r.status === 'missed') return '没唱到';
  const pitch = r.pitch;                 // 准 / 偏高 / 偏低
  const timing = r.timing;               // 节奏准 / 快了 Xms / 慢了 Xms
  return `${pitch} · ${timing}`;
}

/**
 * 估计练唱录音相对参考谱的整体时间平移量。
 *
 * 「全没唱到」多半不是真没唱，而是开口早/晚了几百毫秒——Voronoi 分区
 * 落在字位之外当然判 missed。这里用音高轮廓相关把整段录音平移到谱子上：
 *   对每个候选 off，把帧时间 + off，看它落在哪个字位、音高是否接近该字目标。
 * 取匹配最好的 off 返回（单位秒）。相关度太低则不平移，避免瞎对齐。
 *
 * @param {Array} units 逐字谱（含 start,end,midi）
 * @param {Array} frames 练唱帧
 * @param {{maxLagSec?, stepSec?}} opts
 * @returns {{shift:number, corr:number, aligned:boolean}}
 */
export function estimatePracticeOffset(units, frames, opts = {}) {
  const voiced = (frames || []).filter((f) => f.voiced && f.midi > 0);
  if (!voiced.length || !units?.length) return { shift: 0, corr: 0, aligned: false };

  const targetAt = (t) => {
    for (const u of units) if (t >= u.start && t < u.end) return u.midi;
    return null;
  };

  const maxLag = opts.maxLagSec ?? 4;
  const step = opts.stepSec ?? 0.05;
  let best = { shift: 0, corr: 0 };

  for (let off = -maxLag; off <= maxLag; off += step) {
    let hit = 0, total = 0;
    for (const f of voiced) {
      const tgt = targetAt(f.t + off);
      if (tgt == null) continue;
      total++;
      const d = Math.abs(f.midi - tgt) * 100;
      if (d < 100) hit += 1 - d / 100;   // 半音内给分，越准越高
    }
    if (!total) continue;
    // 归一化 + 覆盖惩罚（对齐后应覆盖录音大部分有声帧）
    const ratio = total / voiced.length;
    const corr = (hit / total) * Math.min(1, ratio / 0.5);
    if (corr > best.corr) best = { shift: off, corr };
  }
  return { ...best, aligned: best.corr >= (opts.minCorr ?? 0.25) };
}

/** 把帧按 shift 平移（refT = t + shift） */
export function shiftPracticeFrames(frames, shift) {
  if (!shift) return frames;
  return frames.map((f) => ({ ...f, t: f.t + shift }));
}

/**
 * @param {Array} units flattenScore(score)
 * @param {object} key detectKey 结果
 * @param {Array} takeFrames
 * @param {{tol?, reach?}} opts
 */
export function scorePracticeWords(units, key, takeFrames, opts = {}) {
  const tol = opts.tol ?? 50;
  const reach = opts.reach ?? 0.14;

  if (!units?.length) {
    return { words: [], summary: { total: 0, sung: 0, missed: 0, high: 0, low: 0, early: 0, late: 0, accurate: 0 }, align: { shift: 0, aligned: false } };
  }

  // —— 自动时间对齐：先整体平移到参考谱，再逐字判定 ——
  let frames = takeFrames || [];
  let align = { shift: 0, corr: 0, aligned: false };
  if (opts.autoAlign !== false) {
    align = estimatePracticeOffset(units, frames, opts);
    if (align.aligned) frames = shiftPracticeFrames(frames, align.shift);
  }

  const voiced = frames.filter((f) => f.voiced && f.midi > 0);

  // Voronoi 分区
  const bounds = units.map((u, i) => {
    const prevEnd = i > 0 ? units[i - 1].end : -Infinity;
    const nextStart = i < units.length - 1 ? units[i + 1].start : Infinity;
    return {
      lo: prevEnd === -Infinity ? u.start - reach : (prevEnd + u.start) / 2,
      hi: nextStart === Infinity ? u.end + reach : (u.end + nextStart) / 2,
    };
  });

  const words = units.map((u, i) => {
    const { lo, hi } = bounds[i];
    const seg = voiced.filter((f) => f.t >= lo - 0.02 && f.t < hi + 0.02);
    const refNum = u.jianpu?.symbol || '—';

    if (!seg.length) {
      return {
        ...u, refNum, myNum: '—', status: 'missed',
        pitch: '没唱到', timing: '—', band: 'missed',
        dev: null, userMidi: null, timingMs: null, userDurMs: 0,
        refDurMs: Math.max(1, (u.end - u.start) * 1000),
        text: '没唱到',
      };
    }

    const inside = seg.filter((f) => f.t >= u.start && f.t < u.end);
    const src = inside.length ? inside : seg;
    let userMidi = mean(src.map((f) => f.midi));

    // ★ 八度折叠：YIN 在真人清唱上会偶发跳八度（真实录音实测：83 字里 40 字受影响）。
    // 唱高八度/低八度是正常艺术处理（男声唱女声歌），不该判成"跑到 12 个半音外"。
    // 这里把用户实际音高折回最接近目标音的八度，再看偏差。
    // 注意：只折整八度，半音级偏差照样如实报出。
    const oct = Math.round((userMidi - u.midi) / 12);
    if (oct !== 0) userMidi -= oct * 12;

    const mySym = midiToJianpu(userMidi, key).symbol;
    const dev = (userMidi - u.midi) * 100;
    const onset = seg[0].t;
    const timingMs = (onset - u.start) * 1000;

    // 你这个音实际唱了多久：从起音开始，连续有声（间隔 ≤0.15s）就算同一音，
    // 断气/换气就截断——长音气息短一截会如实反映。
    let lastT = seg[0].t;
    for (let k = 1; k < seg.length; k++) {
      if (seg[k].t - lastT > 0.15) break;
      lastT = seg[k].t;
    }
    const userDurMs = Math.max(0, (lastT - onset) * 1000);

    const abs = Math.abs(dev);
    let pitch;
    if (abs <= tol * 0.5) pitch = '准';
    else if (dev > 0) pitch = '偏高';
    else pitch = '偏低';

    let timing;
    if (Math.abs(timingMs) <= 90) timing = '节奏准';
    else if (timingMs < 0) timing = `快了 ${Math.round(-timingMs)}ms`;
    else timing = `慢了 ${Math.round(timingMs)}ms`;

    const band = practiceBand(dev, tol);
    return {
      ...u,
      refNum, myNum: mySym,
      status: 'sung', pitch, timing, band,
      dev, userMidi, timingMs, userDurMs,
      refDurMs: Math.max(1, (u.end - u.start) * 1000),
      text: practiceWordText({ status: 'sung', pitch, timing }, tol),
    };
  });

  const sung = words.filter((w) => w.status === 'sung');
  const summary = {
    total: words.length,
    sung: sung.length,
    missed: words.filter((w) => w.status === 'missed').length,
    high: sung.filter((w) => w.dev > tol).length,
    low: sung.filter((w) => w.dev < -tol).length,
    early: sung.filter((w) => w.timingMs < -90).length,
    late: sung.filter((w) => w.timingMs > 90).length,
    accurate: sung.filter((w) => Math.abs(w.dev) <= tol * 0.5).length,
    meanAbsCents: sung.length ? mean(sung.map((w) => Math.abs(w.dev))) : 0,
    meanTimingMs: sung.length ? mean(sung.map((w) => w.timingMs)) : 0,
  };

  // —— 调性对比：你整体是不是换了个调在唱 ——
  // 中位偏差 ≈ ±100¢ 的整数倍（±50¢ 容差）→ 你整体移了 N 个半音；
  // 折算回去后逐字残差都小 = 你是"整体移调但没跑调"；
  // 折算后残差仍大 = 旋律本身唱错了（跑调）。
  const transposition = detectTransposition(sung, tol);

  return { words, summary, align, transposition };
}

/**
 * 检测整体移调：你把整首搬高了/搬低了几个半音，旋律形状本身唱对了没有。
 *
 * 判定逻辑（正是用户要的）：
 *   原唱 C 调唱 123，你 D 调也唱 123 → 每字偏差都是 +100¢ → 移调 +2 半音，
 *   折算后逐字残差 ≈ 0 → 「整体移高 2 半音，音程关系正确 = 没跑调」
 *   原唱唱 122，你唱 123 → 偏差是 [+100,+100,0] → 中位 +100 但残差 50¢
 *   → 「整体移高 2 半音，但第 2 音音程错了 = 跑调」
 *
 * @param {Array} words 已唱字的诊断（含 dev、refNum/myNum）
 * @param {number} tol 音准容差（音分）
 * @returns {{shiftSemi:number, applied:boolean, consistent:boolean,
 *            residualOff:number, residualTotal:number,
 *            verdict:string, detail:string}}
 */
export function detectTransposition(words, tol = 50) {
  if (!words || words.length < 3) {
    return { shiftSemi: 0, applied: false, consistent: true, residualOff: 0, residualTotal: 0,
      verdict: '', detail: '样本太少，不做调性判定' };
  }
  const devs = words.map((w) => w.dev).sort((a, b) => a - b);
  const med = devs[Math.floor(devs.length / 2)];
  // 中位偏差接近某个整百（半音）才认为有整体移调意图
  const shiftSemi = Math.round(med / 100);
  const cand = shiftSemi * 100;
  const applied = shiftSemi !== 0 && Math.abs(med - cand) <= tol && words.filter((w) => Math.abs(w.dev - cand) <= tol).length >= words.length * 0.6;

  if (!applied) {
    // 没有整体移调：逐字判定就是最终判定
    const off = words.filter((w) => Math.abs(w.dev) > tol).length;
    return { shiftSemi: 0, applied: false, consistent: off === 0,
      residualOff: off, residualTotal: words.length,
      verdict: off === 0 ? '' : '',
      detail: off === 0 ? '同调演唱' : '同调演唱，个别字跑调（见下面逐字标注）' };
  }

  // 有整体移调：折算回去看"音程关系"唱对没有
  const residual = words.map((w) => w.dev - cand);
  const residualOff = residual.filter((d) => Math.abs(d) > tol).length;
  const consistent = residualOff === 0;
  const dir = shiftSemi > 0 ? '高' : '低';
  const verdict = consistent
    ? `整体移${dir} ${Math.abs(shiftSemi)} 半音，音程全对 = 没跑调`
    : `整体移${dir} ${Math.abs(shiftSemi)} 半音，但 ${residualOff}/${words.length} 字音程错了 = 跑调`;
  return {
    shiftSemi, applied: true, consistent,
    residualOff, residualTotal: words.length,
    verdict, detail: verdict,
  };
}

/** 把逐字结果按原来的行重新分组，供"显示一篇歌词"用 */
export function groupWordsByLine(words) {
  const map = new Map();
  for (const w of words) {
    if (!map.has(w.lineIndex)) map.set(w.lineIndex, { index: w.lineIndex, start: w.lineStart, end: w.lineEnd, units: [] });
    map.get(w.lineIndex).units.push(w);
  }
  return [...map.values()].sort((a, b) => a.index - b.index);
}

/** 整句汇总文案（如"一闪一闪偏高、亮晶晶偏慢"） */
export function lineSummary(line) {
  const sung = line.units.filter((u) => u.status === 'sung');
  const missed = line.units.filter((u) => u.status === 'missed').length;
  const high = sung.filter((u) => u.dev > 50).length;
  const low = sung.filter((u) => u.dev < -50).length;
  const early = sung.filter((u) => u.timingMs < -90).length;
  const late = sung.filter((u) => u.timingMs > 90).length;
  const parts = [];
  if (high) parts.push(`${high} 字偏高`);
  if (low) parts.push(`${low} 字偏低`);
  if (early) parts.push(`${early} 字偏快`);
  if (late) parts.push(`${late} 字偏慢`);
  if (missed) parts.push(`${missed} 字没唱到`);
  if (!parts.length) return '唱得很准';
  return parts.join('、');
}

export { clamp };
