/**
 * 纯人声对比引擎（无 DOM，可在 Node 里单测）
 * ═══════════════════════════════════════════════════════════
 * 输入：两段"逐帧音高检测结果"——录制时由 YIN 实时产出，或离线解码音频产出。
 *   frames = [{ t, midi, voiced, rms, confidence }, ...]
 *
 * 目标：任意两段录音都能互相对比。A 当"参考"，B 当"被对比"，给出：
 *   1) 自动时间对齐（B 可能整体早/晚开口）
 *   2) 整体评分（沿用 scoreTake：帧质量 / 准音率 / 覆盖度 / 稳定性）
 *   3) 逐音符诊断：每个参考音符，B 是偏高/偏低/准、偏早/偏晚、没唱到
 *   4) 时间序列偏差（供卷帘画"你 vs 参考"两条线）
 *   5) 最差片段列表（哪里最需要练）
 *
 * 设计要点：
 *  - 参考轨从 A 的清洗后帧构建（referenceFromFrames + 半音吸附）。
 *  - 两段录音都从 t=0 开始（录制时以"按下开始"为零点），但 B 可能晚开口，
 *    所以先用 estimateOffset 估计 B 相对 A 的整体平移量，再评分。
 *  - 逐音符诊断按"参考音符窗口"分区（Voronoi 边界），避免相邻音符尾音串味。
 *  - 八度差异（男声 vs 女声同一旋律）在 scoreTake 内部已自动折算，不扣分。
 */

import { cleanFrames, estimateOffset } from './audio.js';
import {
  referenceFromFrames, extractNotes, scoreTake, frameScore,
  SCORE_MODES, HOP_SEC,
} from './reference.js';
import { midiToName, mean, clamp, quantile } from './util.js';

/**
 * 把一段原始帧清洗成参考旋律（"解析人声"这一步的产物）
 * @param {Array} frames
 * @param {{title?, minConfidence?, snap?}} opts
 * @returns {{ ref:Reference, notes:Array, frames:Array, duration:number, silent:boolean }}
 */
export function parseVocal(frames, opts = {}) {
  const cleaned = cleanFrames(
    (frames || []).map((f) => ({ ...f })),
    { minConfidence: opts.minConfidence ?? 0.45, aggressive: false }
  );
  const ref = referenceFromFrames(cleaned, {
    title: opts.title || '参考人声',
    hop: HOP_SEC,
    snap: opts.snap ?? true,
    snapAmount: 0.55,
    source: 'vocal',
  });
  const notes = ref.notes && ref.notes.length
    ? ref.notes
    : extractNotes(ref.midi, ref.voiced, ref.hop);
  return {
    ref,
    notes,
    frames: cleaned,
    duration: ref.duration,
    silent: ref.voicedRatio < 0.03,
  };
}

/** 把 B 的帧按 offset 平移到 A 的时间轴上（不改变原数组） */
export function shiftFrames(frames, offset) {
  return frames.map((f) => ({ ...f, t: f.t + offset }));
}

/**
 * 把 B 的帧尾部用"无声帧"补到参考时长。
 * scoreTake 的覆盖度是按 take 自己的帧数算的——如果 B 提前收声，
 * 后面那段参考旋律根本不在打分范围里，漏唱的尾巴会被当成"没发生"。
 * 补静音帧后，这些帧正好落在参考有声栅格上 → 判定 missed → 覆盖度如实下降。
 * B 比参考长时不裁剪（多出的帧落在参考之外，算 extra，不扣分）。
 */
export function padToDuration(frames, refDuration, hop = HOP_SEC) {
  if (!frames.length) {
    const out = [];
    for (let t = 0; t < refDuration; t += hop) {
      out.push({ t, midi: 0, voiced: false, rms: 0, confidence: 1 });
    }
    return out;
  }
  const out = frames.slice();
  const last = out[out.length - 1].t;
  for (let t = last + hop; t < refDuration; t += hop) {
    out.push({ t, midi: 0, voiced: false, rms: 0, confidence: 1 });
  }
  return out;
}

/**
 * 自动对齐 B → A。
 * estimateOffset 返回 offset：把 B 的帧时间加上 offset 后能贴到 A 的栅格上。
 * 若相关度太低（两段根本不是同一段），就不强行平移，避免"碰巧对上"。
 */
export function alignVocals(ref, bFrames, opts = {}) {
  const maxLag = opts.maxLagSec ?? 6;
  const est = estimateOffset(ref, bFrames, {
    maxLagSec: maxLag,
    stepSec: opts.stepSec ?? 0.05,
    minOverlap: opts.minOverlap ?? 30,
  });
  // 对齐质量门限：corr 太低说明两段内容不同，别硬对齐
  const usable = est.corr >= (opts.minCorr ?? 0.28) && est.overlap > 0;
  return {
    offset: usable ? est.offset : 0,
    corr: est.corr,
    ambiguity: est.ambiguity,
    overlap: est.overlap,
    aligned: usable,
  };
}

/** 音分偏差 → 分档（与参考评分同口径） */
export function compareBand(devCents, tol) {
  const abs = Math.abs(devCents);
  if (abs <= tol * 0.25) return 'perfect';
  if (abs <= tol * 0.5) return 'great';
  if (abs <= tol) return 'ok';
  if (abs <= tol * 2) return 'sharp';
  return 'off';
}

/**
 * 逐音符诊断：以 A 的音符为"格子"，看 B 在每个格子里唱得怎样。
 * 每个格子产出 {target, you, dev, band, onset, timing, status, text}
 *   status: 'sung' | 'missed' | 'extra'（B 多唱了、A 这里没声）
 *
 * Voronoi 分区：相邻音符边界取 (上音符.end + 本音符.start)/2，
 * 这样"早唱/晚唱"的帧仍能被归到最近的音符，不会被隔壁音符吞掉。
 */
export function diagnoseNotes(notes, bFrames, opts = {}) {
  const mode = opts.mode || SCORE_MODES.exact;
  const tol = opts.tol ?? mode.tol;
  const reach = opts.reach ?? 0.14; // 早/晚唱的容忍余量（秒）

  if (!notes.length) {
    // A 没有任何音符：B 唱的全算"多唱"
    const v = bFrames.filter((f) => f.voiced && f.midi > 0);
    return v.length
      ? [{ start: 0, end: bFrames[bFrames.length - 1].t, target: null, you: mean(v.map((f) => f.midi)),
           dev: null, band: null, onset: v[0].t, timing: null, status: 'extra', coverage: 1,
           text: '参考里没有旋律，这段是额外唱的' }]
      : [];
  }

  // B 的有声帧（清洗掉明显毛刺：置信度太低或 rms 太小的不算）
  const voicedB = bFrames.filter((f) => f.voiced && f.midi > 0);

  const bounds = notes.map((n, i) => {
    const prevEnd = i > 0 ? notes[i - 1].end : -Infinity;
    const nextStart = i < notes.length - 1 ? notes[i + 1].start : Infinity;
    return {
      lo: prevEnd === -Infinity ? n.start - reach : (prevEnd + n.start) / 2,
      hi: nextStart === Infinity ? n.end + reach : (n.end + nextStart) / 2,
    };
  });

  const diagnosed = notes.map((n, i) => {
    const { lo, hi } = bounds[i];
    const seg = voicedB.filter((f) => f.t >= lo - 0.02 && f.t < hi + 0.02);
    if (!seg.length) {
      return {
        start: n.start, end: n.end, target: n.midi, you: null,
        dev: null, band: null, onset: null, timing: null,
        status: 'missed', coverage: 0,
        text: '没唱到',
      };
    }
    // 音高：优先取严格落在 [start,end) 内的帧
    const inside = seg.filter((f) => f.t >= n.start && f.t < n.end);
    const src = inside.length ? inside : seg;
    const you = mean(src.map((f) => f.midi));
    const dev = (you - n.midi) * 100;
    const onset = seg[0].t;
    const timing = onset - n.start; // <0 早(快), >0 晚(慢)
    const inWin = bFrames.filter((f) => f.t >= lo && f.t < hi);
    const coverage = inWin.length ? seg.length / inWin.length : 0;
    const band = compareBand(dev, tol);
    return {
      start: n.start, end: n.end, target: n.midi, you,
      dev, band, onset, timing,
      status: 'sung', coverage, weak: !inside.length,
    };
  });

  // 生成中文文案
  for (const d of diagnosed) {
    if (d.status === 'missed') { d.text = '没唱到'; continue; }
    if (d.status === 'extra') { continue; }
    const abs = Math.abs(d.dev);
    let pitch;
    if (abs <= tol * 0.5) pitch = '准';
    else if (d.dev > 0) pitch = abs >= tol * 2 ? '跑高了' : '偏高';
    else pitch = abs >= tol * 2 ? '跑低了' : '偏低';
    let timing;
    if (Math.abs(d.timing) <= 0.09) timing = '节奏准';
    else if (d.timing < 0) timing = `快了 ${Math.round(-d.timing * 1000)}ms`;
    else timing = `慢了 ${Math.round(d.timing * 1000)}ms`;
    d.text = `目标 ${midiToName(d.target)} · 你 ${midiToName(d.you)} · ${pitch}（${Math.round(d.dev)}¢） · ${timing}`;
  }
  return diagnosed;
}

/**
 * 主入口：对比任意两段人声。
 *
 * @param {Array} aFrames 参考人声（已录好的历史）—— 会被清洗成参考轨
 * @param {Array} bFrames 被对比的人声（刚录的 / 历史里另一段）
 * @param {{mode?, autoAlign?, offset?, minConfidence?, snap?, title?}} opts
 * @returns 完整结果对象（纯数据，可直接渲染 / JSON 序列化）
 */
export function compareVocals(aFrames, bFrames, opts = {}) {
  const mode = opts.mode || SCORE_MODES.exact;
  const parsed = parseVocal(aFrames, {
    minConfidence: opts.minConfidence,
    snap: opts.snap,
    title: opts.title,
  });

  const empty = {
    ok: false, reason: '参考人声几乎没检测到旋律（可能没出声或全是噪声）',
    score: null, notes: [], align: { offset: 0, corr: 0, aligned: false },
    durationA: parsed.duration, durationB: 0,
  };
  if (parsed.silent || !parsed.ref.frames) return empty;

  // 清洗 B（只做置信度过滤，不做旋律级强平滑，保留真实抖动）
  const bClean = cleanFrames(
    (bFrames || []).map((f) => ({ ...f })),
    { minConfidence: opts.minConfidence ?? 0.45, aggressive: false }
  );
  const durationB = bClean.length ? bClean[bClean.length - 1].t - bClean[0].t : 0;

  // 对齐
  let offset = opts.offset ?? 0;
  let align = { offset, corr: 1, ambiguity: 1, overlap: bClean.length, aligned: false, manual: true };
  if (opts.autoAlign !== false && opts.offset == null) {
    align = alignVocals(parsed.ref, bClean, opts);
    align.manual = false;
    offset = align.offset;
  }

  const bShifted = shiftFrames(bClean, offset);
  // 补静音到参考时长，让"该唱没唱"的尾巴计入覆盖度/漏唱
  const bForScore = padToDuration(bShifted, parsed.duration, parsed.ref.hop);

  // 整体评分（scoreTake 需要逐帧一一对应，用补齐后的 B）
  const score = scoreTake(parsed.ref, bForScore, { mode, startTime: 0 });

  // 逐音符诊断（用平移后的 B）
  const notes = diagnoseNotes(parsed.notes, bShifted, { mode });

  // 汇总逐音符统计
  const sung = notes.filter((n) => n.status === 'sung');
  const missed = notes.filter((n) => n.status === 'missed').length;
  const early = sung.filter((n) => n.timing < -0.09).length;
  const late = sung.filter((n) => n.timing > 0.09).length;
  const high = sung.filter((n) => n.dev > mode.tol).length;
  const low = sung.filter((n) => n.dev < -mode.tol).length;
  const accurate = sung.filter((n) => Math.abs(n.dev) <= mode.tol * 0.5).length;

  // 给卷帘用的"你"轨迹（带 band 着色）
  const trackFrames = bShifted.map((f) => {
    const idx = Math.round(f.t / parsed.ref.hop);
    let band = 'silent';
    if (idx >= 0 && idx < parsed.ref.voiced.length && parsed.ref.voiced[idx]) {
      const dev = (f.midi - parsed.ref.midi[idx]) * 100;
      band = f.voiced && f.midi > 0 ? compareBand(dev, mode.tol) : 'missed';
    } else if (f.voiced && f.midi > 0) {
      band = 'extra';
    }
    return { ...f, band };
  });

  return {
    ok: true,
    mode: mode.key,
    tol: mode.tol,
    score,                       // scoreTake 完整结果（含 bands/devs/phraseScores/worst/counts）
    notes,                       // 逐音符诊断
    align,                       // {offset, corr, aligned, manual}
    ref: parsed.ref,             // 参考轨（供卷帘 setReference）
    trackFrames,                 // B 的着色轨迹（供卷帘 setTake）
    stats: {
      noteCount: notes.length,
      sung: sung.length,
      missed, early, late, high, low, accurate,
      meanAbsCents: sung.length ? mean(sung.map((n) => Math.abs(n.dev))) : 0,
      meanTiming: sung.length ? mean(sung.map((n) => n.timing)) : 0,
    },
    durationA: parsed.duration,
    durationB,
    aFrames: parsed.frames,      // 清洗后的 A（供卷帘显示"参考线"，可选）
  };
}

/** 结果摘要文案（给结果页顶部一行） */
export function compareSummary(r) {
  if (!r || !r.ok) return '无法对比：' + (r?.reason || '无结果');
  const s = r.score, st = r.stats;
  const dir = s.meanSignedCents > 8 ? '整体偏高' : s.meanSignedCents < -8 ? '整体偏低' : '音高居中';
  return `总分 ${s.total} · 准音率 ${Math.round(s.pitchAccuracy * 100)}% · 覆盖 ${Math.round(s.coverage * 100)}% · `
    + `${st.noteCount} 个音里唱到 ${st.sung}、漏 ${st.missed}、偏高 ${st.high}、偏低 ${st.low}、`
    + `偏快 ${st.early}、偏慢 ${st.late} · ${dir}`;
}

export { midiToName, mean, clamp, quantile };
