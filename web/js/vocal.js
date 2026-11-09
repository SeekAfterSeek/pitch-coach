/**
 * 教唱工作流：参考人声解析 + 逐字对齐 + 清唱比对
 *
 * 流程
 * ────
 * 1) 录入参考：纯人声录音 → 提取旋律（音符序列，每个音符有起止 + 音高）
 * 2) 歌词对齐：把歌词（LRC / 纯文本）按时间铺到旋律上，
 *    产出 lyricUnits：每个可唱字符 → {char, start, end, midi(目标音高)}
 * 3) 清唱跟练：用户清唱 → 逐帧检测 → 与每个 lyricUnit 比音高(高/低/准)与时值(快/慢/漏)
 *
 * 说明：逐字"歌词内容"来自用户提供的歌词（参考全民 K 歌——歌词是输入，不是凭空识别）。
 * 旋律（每个字的音高与节奏）则完全由这段纯人声录音解析得出。
 */

import { cleanFrames } from './audio.js';
import { referenceFromFrames, extractNotes, HOP_SEC, SCORE_MODES } from './reference.js';
import { midiToName, mean, clamp } from './util.js';
import { toIntervals, parseLRC, distributeByLines } from './lyrics.js';

/**
 * 解析一段参考人声的逐帧结果，产出参考旋律 + 音符
 * @param {Array<{t,midi,voiced,rms,confidence}>} frames
 */
export function analyzeVocal(frames, opts = {}) {
  const minConf = opts.minConfidence ?? 0.45;
  const cleaned = cleanFrames(
    frames.map((f) => ({ ...f })),
    { minConfidence: minConf, aggressive: false }
  );
  const ref = referenceFromFrames(cleaned, {
    title: opts.title || '参考人声',
    snap: opts.snap ?? true,
    snapAmount: opts.snapAmount ?? 0.55,
    source: 'vocal',
  });
  const notes = ref.notes && ref.notes.length
    ? ref.notes
    : extractNotes(ref.midi, ref.voiced, ref.hop);
  return { ref, notes, frames: cleaned };
}

/** 把歌词行转成区间，并去掉空白/纯元信息 */
function lyricIntervals(text, duration) {
  const lines = parseLRC(text);
  if (lines.length) return toIntervals(lines, duration);
  // 纯文本：按行数估算时间轴
  const est = distributeByLines(text, duration || 120);
  return est.length ? toIntervals(est, duration) : [];
}

/**
 * 把歌词对齐到参考旋律，逐字产出"谱子"
 *
 * 对齐策略：
 *  - 每行歌词取时间区间 [start, end]
 *  - 找出落在该区间内（或与之交叠）的音符
 *  - 把该行可唱字符（去掉标点/空白）按音符时长比例分配到各音符
 *  - 每个音符 → 一个或多个字符单元，单元记录音符的起止与目标音高
 *  - 该行若没有音符（间奏/换气）→ 整行作为"休止/非唱"单元
 *
 * @param {string} lyricText
 * @param {Reference} ref
 * @param {number} duration 参考人声总时长（秒）
 * @returns {Array<{char,start,end,midi,lineIndex,isRest}>}
 */
export function alignLyricsToVocal(lyricText, ref, duration) {
  const intervals = lyricIntervals(lyricText, duration);
  const notes = (ref.notes && ref.notes.length)
    ? ref.notes
    : extractNotes(ref.midi, ref.voiced, ref.hop);

  const units = [];
  intervals.forEach((iv, li) => {
    const lineNotes = notes
      .filter((n) => n.end > iv.start && n.start < iv.end)
      .sort((a, b) => a.start - b.start);

    // 可唱字符：去标点、去空白（中文标点用 \p{P} 覆盖）
    const chars = [...iv.text].filter((c) => !/^[\s\p{P}]+$/u.test(c));

    if (!lineNotes.length || !chars.length) {
      units.push({
        char: iv.text || '♪',
        start: iv.start,
        end: iv.end,
        midi: lineNotes.length ? Math.round(lineNotes[0].midi) : null,
        lineIndex: li,
        isRest: true,
      });
      return;
    }

    const totalDur = lineNotes.reduce((s, n) => s + (n.end - n.start), 0) || 1;
    let ci = 0;
    for (const n of lineNotes) {
      const w = (n.end - n.start) / totalDur;
      let cnt = Math.max(1, Math.round(w * chars.length));
      let take = Math.min(cnt, chars.length - ci);
      if (take <= 0) break;
      const seg = chars.slice(ci, ci + take).join('');
      ci += take;
      units.push({
        char: seg,
        start: n.start,
        end: n.end,
        midi: Math.round(n.midi),
        lineIndex: li,
        isRest: false,
      });
      if (ci >= chars.length) break;
    }
    // 四舍五入造成的余数字符，追加到最后一个单元
    if (ci < chars.length && units.length) {
      units[units.length - 1].char += chars.slice(ci).join('');
    }
  });

  return units;
}

/** 音分偏差 → 分档（与参考评分同口径） */
export function vocalBand(devCents, tol) {
  const abs = Math.abs(devCents);
  if (abs <= tol * 0.25) return 'perfect';
  if (abs <= tol * 0.5) return 'great';
  if (abs <= tol) return 'ok';
  if (abs <= tol * 2) return 'sharp';
  return 'off';
}

/**
 * 把一次清唱的逐帧结果与参考逐字单元比对
 * @param {Array} units alignLyricsToVocal 的产出
 * @param {Array<{t,midi,voiced,rms}>} takeFrames 清唱帧
 * @param {{mode?, tol?}} opts
 */
export function scoreVocalTake(units, takeFrames, opts = {}) {
  const mode = opts.mode || SCORE_MODES.exact;
  const tol = opts.tol ?? mode.tol;
  const reach = 0.12; // 早/晚唱容忍：超出本音节边界 ±reach 仍算"唱到，但偏早/偏晚"

  // —— 按音节边界做时间分区（Voronoi）：相邻两字的边界取它们端点中点，
  // 这样每个字只拥有自己音节区间内的帧，上一个字的尾音不会污染下一个字。
  const seg = units.map((u, i) => {
    const prevEnd = i > 0 ? units[i - 1].end : -Infinity;
    const nextStart = i < units.length - 1 ? units[i + 1].start : Infinity;
    return {
      lo: (prevEnd === -Infinity) ? u.start - reach : (prevEnd + u.start) / 2,
      hi: (nextStart === Infinity) ? u.end + reach : (u.end + nextStart) / 2,
    };
  });

  const scored = units.map((u, i) => {
    if (u.isRest || u.midi == null) {
      return { ...u, status: 'rest', dev: null, band: null, timing: null, coverage: 0 };
    }
    const { lo, hi } = seg[i];
    // ext：音节分区（含 ±reach 余量）内所有帧，用于判定"有没有唱到"与起音时刻
    const ext = takeFrames.filter((f) => f.t >= lo - 0.02 && f.t < hi + 0.02);
    const wfExt = ext.filter((f) => f.voiced && f.midi > 0);

    if (!wfExt.length) {
      return { ...u, status: 'missed', dev: null, band: null, timing: null, coverage: 0 };
    }

    // 音高平均值优先取"严格落在音节主区间 [start,end]"的帧（更干净）；
    // 主区间无声（唱得太早/太晚，全在边界余量内）则退回分区帧，并标记 weak。
    const inside = ext.filter((f) => f.t >= u.start && f.t < u.end && f.voiced && f.midi > 0);
    const avgSrc = inside.length ? inside : wfExt;
    const avg = avgSrc.reduce((a, f) => a + f.midi, 0) / avgSrc.length;
    const dev = (avg - u.midi) * 100;
    const onset = wfExt[0].t;
    const timing = onset - u.start; // <0 唱快了(早)，>0 唱慢了(晚)
    const inWin = takeFrames.filter((f) => f.t >= lo && f.t < hi);
    const coverage = inWin.length ? wfExt.length / inWin.length : 0;

    return {
      ...u,
      status: 'sung',
      userAvg: avg,
      dev,
      band: vocalBand(dev, tol),
      timing,
      coverage,
      weak: !inside.length,
    };
  });

  const sung = scored.filter((s) => s.status === 'sung');
  const missed = scored.filter((s) => s.status === 'missed').length;
  const rest = scored.filter((s) => s.status === 'rest').length;
  const total = scored.length;

  const acc = total ? sung.filter((s) => Math.abs(s.dev) <= tol).length / total : 0;
  const meanAbs = sung.length ? mean(sung.map((s) => Math.abs(s.dev))) : 0;
  const meanTiming = sung.length ? mean(sung.map((s) => s.timing)) : 0;
  const early = sung.filter((s) => s.timing < -0.08).length;
  const late = sung.filter((s) => s.timing > 0.08).length;
  const totalScore = total
    ? Math.round(
        (sung.reduce((a, s) => a + Math.exp(-0.5 * (s.dev / (tol * 0.6)) ** 2), 0) / total) * 100
      )
    : 0;

  return {
    units: scored,
    total,
    sung: sung.length,
    missed,
    rest,
    accuracy: acc,
    meanAbsCents: meanAbs,
    meanTiming,
    early,
    late,
    totalScore,
    tol,
  };
}

/** 给单个单元生成中文诊断文案 */
export function vocalUnitText(u, tol) {
  if (u.status === 'rest') return '（间奏 / 换气）';
  if (u.status === 'missed') return '没唱到';
  const target = midiToName(u.midi);
  const you = midiToName(u.userAvg);
  const abs = Math.abs(u.dev);
  let pitch;
  if (abs <= tol * 0.5) pitch = '准';
  else if (u.dev > 0) pitch = abs >= tol * 2 ? '跑高了' : '偏高';
  else pitch = abs >= tol * 2 ? '跑低了' : '偏低';

  let timing;
  if (Math.abs(u.timing) <= 0.08) timing = '节奏准';
  else if (u.timing < 0) timing = `快了 ${Math.round(-u.timing * 1000)}ms`;
  else timing = `慢了 ${Math.round(u.timing * 1000)}ms`;

  return `目标 ${target} · 你 ${you} · ${pitch}（${Math.round(u.dev)}¢） · ${timing}`;
}

export { midiToName, clamp };
