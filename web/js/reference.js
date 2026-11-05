/**
 * 参考旋律（Reference Melody）模型 + 比对评分
 *
 * 参考轨道三种来源：
 *   1. 内置示例旋律（demo 曲目，纯正弦合成，无版权问题）
 *   2. MIDI 文件（.mid / .midi）—— 解析出音符后求包络
 *   3. 音频文件（原唱 / 清唱 / 伴奏人声轨）—— 用同一套 YIN 提取 f0
 *   4. 手动录制的"标准音"—— 用自己唱一遍作为参考
 *
 * 统一内部表示：等间隔时间栅格上的 MIDI 浮点音高序列 + 是否有声标记。
 * 栅格步长默认 20ms（50 帧/秒），与实时检测帧率对齐。
 */

import { midiToHz, hzToMidi, sampleAt, median, quantile, clamp, mean } from './util.js';

export const HOP_SEC = 0.02; // 20ms 栅格

/** 参考轨道对象 */
export class Reference {
  /**
   * @param {object} o
   * @param {string} o.title
   * @param {number} o.duration
   * @param {number} o.hop        栅格步长（秒）
   * @param {Float32Array} o.midi  每个栅格的 MIDI 值，无声处为 0
   * @param {Uint8Array} o.voiced  每个栅格是否有声
   * @param {Float32Array} [o.energy] 相对能量 0..1（用于显示力度）
   * @param {Array} [o.notes] 可选：音符段列表 [{start,end,midi}]
   */
  constructor(o) {
    this.title = o.title || '未命名';
    this.duration = o.duration;
    this.hop = o.hop || HOP_SEC;
    this.midi = o.midi;
    this.voiced = o.voiced;
    this.energy = o.energy || null;
    this.notes = o.notes || null;
    this.source = o.source || 'unknown';

    // 缓存音域统计
    const vals = [];
    for (let i = 0; i < this.midi.length; i++) if (this.voiced[i]) vals.push(this.midi[i]);
    this.range = vals.length
      ? { low: quantile(vals, 0.02), high: quantile(vals, 0.98) }
      : { low: 48, high: 72 };

    // 有声帧占比
    const total = this.voiced.length || 1;
    this.voicedRatio = vals.length / total;
  }

  get frames() { return this.midi.length; }

  /** 取 t 秒处的参考音高（MIDI 浮点）；无声返回 null */
  at(t) {
    const idx = Math.round(t / this.hop);
    if (idx < 0 || idx >= this.midi.length) return null;
    return this.voiced[idx] ? this.midi[idx] : null;
  }

  /** 区间 [t0, t1] 的平均音高（用于显示"当前应唱的音"） */
  atWindow(t0, t1) {
    const i0 = Math.max(0, Math.round(t0 / this.hop));
    const i1 = Math.min(this.midi.length - 1, Math.round(t1 / this.hop));
    const vals = [];
    for (let i = i0; i <= i1; i++) if (this.voiced[i]) vals.push(this.midi[i]);
    return vals.length ? median(vals) : null;
  }
}

/**
 * 从"逐帧检测结果序列"构建参考轨道
 * @param {Array<{t:number,midi:number,voiced:boolean,rms:number}>} frames
 */
export function referenceFromFrames(frames, opts = {}) {
  const hop = opts.hop || HOP_SEC;
  const title = opts.title || '未命名';
  if (!frames.length) {
    return new Reference({ title, duration: 0, hop, midi: new Float32Array(0), voiced: new Uint8Array(0) });
  }

  const duration = frames[frames.length - 1].t + hop;
  const n = Math.max(1, Math.ceil(duration / hop) + 1);
  const midi = new Float32Array(n);
  const voiced = new Uint8Array(n);
  const energy = new Float32Array(n);
  const rmsMax = Math.max(0.0001, quantile(frames.map((f) => f.rms || 0), 0.95));

  let cursor = 0;
  for (let i = 0; i < n; i++) {
    const t = i * hop;
    // 取落在该栅格附近的帧
    while (cursor + 1 < frames.length && frames[cursor + 1].t <= t + hop * 0.5) cursor++;
    const f = frames[cursor];
    if (f && Math.abs(f.t - t) <= hop * 1.2 && f.voiced && f.midi > 0) {
      midi[i] = f.midi;
      voiced[i] = 1;
      energy[i] = clamp((f.rms || 0) / rmsMax, 0, 1);
    }
  }

  // 短时缺口修补：±2 栅格内的孤立空洞补齐（避免视觉断裂）
  for (let i = 2; i < n - 2; i++) {
    if (!voiced[i] && voiced[i - 2] && voiced[i + 2]) {
      voiced[i] = 1;
      midi[i] = (midi[i - 2] + midi[i + 2]) / 2;
    }
  }

  // 量化到半音（可选）：参考音高通常会做半音吸附，让显示更干净
  if (opts.snap) {
    const snapAmt = opts.snapAmount ?? 0.65;
    for (let i = 0; i < n; i++) {
      if (!voiced[i]) continue;
      const r = Math.round(midi[i]);
      midi[i] = midi[i] + (r - midi[i]) * snapAmt;
    }
  }

  return new Reference({
    title, duration, hop, midi, voiced, energy,
    notes: opts.notes || extractNotes(midi, voiced, hop),
    source: opts.source || 'audio',
  });
}

/** 把连续同音高的栅格合并成音符段 */
export function extractNotes(midi, voiced, hop, minDur = 0.08) {
  const notes = [];
  let start = -1, cur = 0;
  for (let i = 0; i <= midi.length; i++) {
    const on = i < midi.length && voiced[i];
    const q = on ? Math.round(midi[i]) : null;
    if (start < 0) {
      if (on) { start = i; cur = q; }
    } else if (!on || q !== cur) {
      const dur = (i - start) * hop;
      if (dur >= minDur) {
        const vals = [];
        for (let j = start; j < i; j++) vals.push(midi[j]);
        notes.push({ start: start * hop, end: i * hop, midi: median(vals), label: cur });
      }
      if (on) { start = i; cur = q; } else { start = -1; }
    }
  }
  return notes;
}

export const SCORE_MODES = {
  exact: { key: 'exact', name: '严格模式', tol: 50, label: '半音内' },
  loose: { key: 'loose', name: '宽松模式', tol: 100, label: '宽松（±1 半音）' },
  strict: { key: 'strict', name: '专业模式', tol: 25, label: '专业（±25 音分）' },
};

/**
 * 单帧偏差 → 分档 + 连续得分
 *
 * 得分用高斯衰减而不是硬分档：
 *   value = exp(-0.5 · (dev / (tol·0.6))²)
 * 这样 0¢→1.00、12¢→0.92、25¢→0.71、50¢→0.25、100¢→0.004，
 * 单调、无平台期，不会出现"刚好卡在容差边界也拿满分"的问题。
 * band 只用于可视化配色，不参与算分。
 *
 * @returns {{absCents:number, band:string, value:number}} value 为 0..1 的帧得分
 */
export function frameScore(devCents, mode) {
  const abs = Math.abs(devCents);
  const tol = mode.tol;
  const sigma = tol * 0.6;
  const value = Math.exp(-0.5 * (devCents / sigma) ** 2);

  let band;
  if (abs <= tol * 0.25) band = 'perfect';
  else if (abs <= tol * 0.5) band = 'great';
  else if (abs <= tol) band = 'ok';
  else if (abs <= tol * 2) band = 'sharp';
  else band = 'off';

  return { absCents: abs, band, value };
}

/** 八度折叠：把 ±1200 附近的大偏差收回到八度内，返回折叠后的音分 */
function foldOctave(devCents) {
  let d = devCents;
  let fixed = 0;
  // 反复折叠，防止两三个八度的误判
  for (let k = 0; k < 3; k++) {
    if (Math.abs(Math.abs(d) - 1200) < 260) {
      d -= Math.round(d / 1200) * 1200;
      fixed++;
    } else break;
  }
  return { dev: d, fixed };
}

/**
 * 把一段录音（逐帧检测结果）与参考轨道对齐并打分
 *
 * @param {Reference} ref
 * @param {Array<{t:number,midi:number,voiced:boolean,rms:number}>} take 录音帧
 * @param {object} opts
 * @returns 完整评分结果
 */
export function scoreTake(ref, take, opts = {}) {
  const mode = opts.mode || SCORE_MODES.exact;
  const hop = ref.hop;
  const startT = opts.startTime ?? 0; // 录音在参考时间轴上的起点

  // —— 时间对齐：录音帧时间 + startT → 参考栅格 ——
  const n = take.length;
  if (!n) return emptyResult(mode);

  const refMidis = new Float32Array(n);
  const refVoiced = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const t = take[i].t + startT;
    const idx = Math.round(t / hop);
    if (idx >= 0 && idx < ref.midi.length && ref.voiced[idx]) {
      refMidis[i] = ref.midi[idx];
      refVoiced[i] = 1;
    }
  }

  // —— 第一遍：算原始偏差（八度处理放在后面统一做）——
  const devs = new Float32Array(n).fill(NaN);
  const bands = new Array(n).fill(null);
  let voicedRef = 0, voicedYou = 0, bothVoiced = 0;
  const rawDevs = new Float32Array(n).fill(NaN);

  for (let i = 0; i < n; i++) {
    const rv = refVoiced[i], yv = take[i].voiced && take[i].midi > 0;
    if (rv) voicedRef++;
    if (yv) voicedYou++;
    if (rv && yv) {
      bothVoiced++;
      rawDevs[i] = (take[i].midi - refMidis[i]) * 100;
    }
  }

  // —— 八度处理 ——
  // 两档：
  //   a) 整首系统性移八度（男声唱女声歌、参考轨是另一八度）→ 视为"换八度演唱"，不扣分
  //   b) 零散的八度误判（检测跳八度）→ 逐帧折回
  const octInfo = estimateOctaveShift(rawDevs, n);
  const octaveShift = octInfo.shift;
  let octaveFixed = 0;

  for (let i = 0; i < n; i++) {
    const raw = rawDevs[i];
    if (Number.isNaN(raw)) continue;
    let d = raw - octaveShift * 1200;
    // 剩余零散八度跳变
    for (let k = 0; k < 3; k++) {
      if (Math.abs(Math.abs(d) - 1200) < 300) { d -= Math.round(d / 1200) * 1200; octaveFixed++; }
      else break;
    }
    devs[i] = d;
  }

  // —— 第二遍：压制单帧毛刺后算分 ——
  smoothDeviations(devs, n);

  let sumScore = 0, sumAbs = 0, sumSigned = 0, scored = 0;
  let inTol = 0;

  // 注意：分母统一用"参考有声帧数"，而不是"双方都有声帧数"。
  // 这样漏唱既不会抬高准音率、也不会抬高帧质量——漏唱就是零分贡献。
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(devs[i])) {
      const rv = refVoiced[i], yv = take[i].voiced && take[i].midi > 0;
      bands[i] = rv && !yv ? 'missed' : (!rv && yv ? 'extra' : 'silent');
      continue;
    }
    const fs = frameScore(devs[i], mode);
    bands[i] = fs.band;
    sumScore += fs.value;
    sumAbs += fs.absCents;
    sumSigned += devs[i];
    scored++;
    if (fs.absCents < mode.tol) inTol++;
  }

  const denom = Math.max(1, voicedRef);
  const frameQuality = sumScore / denom;   // 漏唱的帧贡献 0
  const pitchAccuracy = inTol / denom;     // 同理

  // —— 长段统计：按音符段汇总，避免单帧抖动干扰 ——
  const segments = [];
  {
    let curStart = -1;
    for (let i = 0; i <= n; i++) {
      const on = i < n && !Number.isNaN(devs[i]);
      if (on && curStart < 0) curStart = i;
      if (!on && curStart >= 0) {
        segments.push({ i0: curStart, i1: i - 1 });
        curStart = -1;
      }
    }
  }

  const coverage = voicedRef ? Math.min(1, bothVoiced / voicedRef) : 0;

  // 稳定性：偏差的抖动（标准差）
  const stdev = (() => {
    if (!scored) return 0;
    const m = sumSigned / scored;
    let v = 0, cnt = 0;
    for (let i = 0; i < n; i++) {
      if (Number.isNaN(devs[i])) continue;
      const d = devs[i] - m;
      v += d * d; cnt++;
    }
    return Math.sqrt(v / Math.max(1, cnt));
  })();

  // 长音平均偏差（每段平均偏差再取绝对值的平均）：惩罚"系统性跑调"
  const segBias = (() => {
    const arr = [];
    for (const s of segments) {
      if (s.i1 - s.i0 < 8) continue; // 太短的段忽略
      let sum = 0, c = 0;
      for (let i = s.i0; i <= s.i1; i++) { sum += devs[i]; c++; }
      arr.push(Math.abs(sum / c));
    }
    return arr.length ? mean(arr) : 0;
  })();

  // 最终分（0-100）
  //   55% 帧质量（高斯衰减，能区分 5¢ 和 25¢）
  //   20% 准音率（落在容差内的比例，直观）
  //   15% 覆盖度（唱没唱，防止只唱准的几个音）
  //   10% 稳定性（抖动惩罚）
  const stabilityScore = clamp(1 - stdev / (mode.tol * 2.5), 0, 1);
  const total = (
    frameQuality * 0.55 +
    pitchAccuracy * 0.20 +
    coverage * 0.15 +
    stabilityScore * 0.10
  ) * 100;

  // 分档统计
  const bandCount = { perfect: 0, great: 0, ok: 0, sharp: 0, off: 0, missed: 0, extra: 0, silent: 0 };
  for (const b of bands) if (b) bandCount[b]++;

  // 逐段得分（给热力图）
  // 注意：用录音帧自身的步长，不要用参考栅格 hop——
  // 录音是 10ms 一帧，参考可能是 20ms 一格，混用会让时间轴翻倍。
  const frameHop = n > 1 ? (take[1].t - take[0].t) : hop;
  const phraseScores = computePhraseScores(devs, refVoiced, Math.abs(frameHop) || hop, 2.0, mode.tol);

  // 最差的若干片段（给"哪里唱错了"提示）
  const worst = [...phraseScores].sort((a, b) => a.score - b.score).slice(0, 5);

  return {
    mode: mode.key,
    total: Math.round(total * 10) / 10,
    pitchAccuracy,
    precisionScore: frameQuality,
    frameQuality,
    coverage,
    stdev,
    segBias,
    octaveFixed,
    frames: n,
    counts: bandCount,
    meanSignedCents: scored ? sumSigned / scored : 0,
    meanAbsCents: scored ? sumAbs / scored : 0,
    medianAbsCents: scored ? quantile(Array.from(devs).filter(Number.isFinite), 0.5) : 0,
    p90AbsCents: scored ? quantile(Array.from(devs).filter(Number.isFinite), 0.9) : 0,
    refMidis,
    refVoiced,
    devs,
    bands,
    phraseScores,
    worst,
    segments,
    startTime: startT,
  };
}

/** 八度平移量估计：投票决定整首歌是否移了 N 个八度 */
function estimateOctaveShift(rawDevs, n) {
  const votes = new Map();
  let cnt = 0;
  for (let i = 0; i < n; i++) {
    const d = rawDevs[i];
    if (Number.isNaN(d)) continue;
    cnt++;
    const k = Math.round(d / 1200);
    if (Math.abs(d - k * 1200) < 400) { // 只有接近整数八度才投票
      votes.set(k, (votes.get(k) || 0) + 1);
    }
  }
  if (!votes.size || !cnt) return { shift: 0, ratio: 0 };
  let bestK = 0, bestC = 0;
  for (const [k, c] of votes) if (c > bestC) { bestK = k; bestC = c; }
  // 至少 55% 的帧支持，才认为是真八度平移（否则是零散误判，按帧折）
  const ratio = bestC / cnt;
  return { shift: ratio >= 0.55 ? bestK : 0, ratio };
}

/**
 * 平滑：5 点中值。
 * 只在邻域离散度 < 1.5 半音时替换，避免把真实的换音阶跃抹平。
 */
function smoothDeviations(devs, n) {
  const src = Float32Array.from(devs);
  const tmp = [];
  for (let i = 2; i < n - 2; i++) {
    if (Number.isNaN(src[i])) continue;
    tmp.length = 0;
    for (let j = i - 2; j <= i + 2; j++) {
      if (!Number.isNaN(src[j])) tmp.push(src[j]);
    }
    if (tmp.length < 3) continue;
    tmp.sort((a, b) => a - b);
    const spread = tmp[tmp.length - 1] - tmp[0];
    if (spread < 150) devs[i] = tmp[tmp.length >> 1];
  }
}

/**
 * 逐段得分（2 秒窗口）
 * 用与总分一致的分数形态：帧质量 × 覆盖度
 */
function computePhraseScores(devs, refVoiced, frameHop, windowSec = 2, tol = 50) {
  const win = Math.max(1, Math.round(windowSec / frameHop));
  const n = devs.length;
  const out = [];
  const sigma = tol * 0.6;

  for (let i0 = 0; i0 < n; i0 += win) {
    const i1 = Math.min(n - 1, i0 + win - 1);
    let quality = 0, scored = 0, refCnt = 0, sumAbs = 0, sumSigned = 0;
    for (let i = i0; i <= i1; i++) {
      if (refVoiced[i]) refCnt++;
      if (!Number.isNaN(devs[i])) {
        quality += Math.exp(-0.5 * (devs[i] / sigma) ** 2);
        sumAbs += Math.abs(devs[i]);
        sumSigned += devs[i];
        scored++;
      }
    }
    if (!refCnt) continue;
    const frameQ = scored ? quality / scored : 0;
    const cover = Math.min(1, scored / refCnt);
    const score = Math.round((frameQ * 0.8 + cover * 0.2) * 100);
    out.push({
      i0, i1,
      t0: i0 * frameHop,
      t1: (i1 + 1) * frameHop,
      score: clamp(score, 0, 100),
      meanAbs: scored ? sumAbs / scored : 0,
      meanSigned: scored ? sumSigned / scored : 0,
      coverage: cover,
    });
  }
  return out;
}

function emptyResult(mode) {
  return {
    mode: mode.key, total: 0, pitchAccuracy: 0, precisionScore: 0, frameQuality: 0, coverage: 0,
    stdev: 0, segBias: 0, octaveFixed: 0, frames: 0,
    counts: { perfect: 0, great: 0, ok: 0, sharp: 0, off: 0, missed: 0, extra: 0, silent: 0 },
    meanSignedCents: 0, meanAbsCents: 0, medianAbsCents: 0, p90AbsCents: 0,
    refMidis: new Float32Array(0), refVoiced: new Uint8Array(0),
    devs: new Float32Array(0), bands: [], phraseScores: [], worst: [],
    segments: [], startTime: 0,
  };
}

/* ─────────────── MIDI 解析（极简 SMF 阅读器）─────────────── */

/**
 * 解析标准 MIDI 文件，合并所有轨道为一条旋律
 * @returns {{notes:Array<{start:number,end:number,midi:number,velocity:number}>, duration:number, name:string}}
 */
export function parseMidi(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  let pos = 0;
  const readStr = (n) => {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(dv.getUint8(pos++));
    return s;
  };
  const readVar = () => {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const b = dv.getUint8(pos++);
      v = (v << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    return v;
  };

  if (readStr(4) !== 'MThd') throw new Error('不是 MIDI 文件');
  const hlen = dv.getUint32(pos); pos += 4;
  const format = dv.getUint16(pos); pos += 2;
  const ntrks = dv.getUint16(pos); pos += 2;
  const division = dv.getUint16(pos); pos += 2;
  pos += Math.max(0, hlen - 6);

  let ppq = division & 0x8000 ? 480 : division; // SMPTE 时基罕见，退回 480
  const notes = [];
  let trackName = '';
  let maxTick = 0;

  for (let track = 0; track < ntrks && pos + 8 <= dv.byteLength; track++) {
    const id = readStr(4);
    const len = dv.getUint32(pos); pos += 4;
    if (id !== 'MTrk') { pos += len; continue; }
    const end = pos + len;
    let tick = 0, running = 0;
    const opened = new Map();
    while (pos < end) {
      tick += readVar();
      maxTick = Math.max(maxTick, tick);
      let status = dv.getUint8(pos);
      if (status & 0x80) { pos++; if (status < 0xF0) running = status; }
      else { status = running; }

      const type = status & 0xF0;
      const ch = status & 0x0f;

      if (status === 0xFF) {
        const meta = dv.getUint8(pos++);
        const mlen = readVar();
        if (meta === 0x03 && mlen < 128) {
          let s = '';
          for (let i = 0; i < mlen; i++) s += String.fromCharCode(dv.getUint8(pos + i));
          if (!trackName) trackName = s;
        }
        pos += mlen;
      } else if (status === 0xF0 || status === 0xF7) {
        const slen = readVar();
        pos += slen;
      } else if (type === 0x90) {
        const note = dv.getUint8(pos++);
        const vel = dv.getUint8(pos++);
        if (vel > 0) opened.set(note, { tick, vel });
        else {
          const o = opened.get(note);
          if (o) {
            notes.push({ startTick: o.tick, endTick: tick, midi: note, velocity: o.vel });
            opened.delete(note);
          }
        }
      } else if (type === 0x80) {
        const note = dv.getUint8(pos++);
        pos++; // vel
        const o = opened.get(note);
        if (o) {
          notes.push({ startTick: o.tick, endTick: tick, midi: note, velocity: o.vel });
          opened.delete(note);
        }
      } else if (type === 0xC0 || type === 0xD0) {
        pos += 1;
      } else {
        pos += 2;
      }
    }
    pos = end;
  }

  const secPerTick = 0.5 / ppq; // 假定 120 BPM 四分音符；MIDI 变速未处理（对本用途足够）
  const out = notes
    .map((n) => ({
      start: n.startTick * secPerTick,
      end: n.endTick * secPerTick,
      midi: n.midi,
      velocity: n.velocity / 127,
    }))
    .filter((n) => n.end > n.start)
    .sort((a, b) => a.start - b.start);

  const duration = maxTick * secPerTick;
  return { notes: out, duration, name: trackName || 'MIDI 旋律' };
}

/** MIDI 音符列表 → 参考轨道（直接铺在栅格上，音符之间留空隙） */
export function referenceFromNotes(notes, duration, opts = {}) {
  const hop = opts.hop || HOP_SEC;
  const n = Math.max(1, Math.ceil(duration / hop) + 1);
  const midi = new Float32Array(n);
  const voiced = new Uint8Array(n);
  const energy = new Float32Array(n);

  for (const note of notes) {
    const i0 = Math.max(0, Math.round(note.start / hop));
    const i1 = Math.min(n - 1, Math.round(note.end / hop) - 1);
    for (let i = i0; i <= i1; i++) {
      // 同栅格多个音时取最高的（旋律通常是最高声部）
      if (!voiced[i] || note.midi > midi[i]) {
        midi[i] = note.midi;
        voiced[i] = 1;
        energy[i] = note.velocity ?? 0.8;
      }
    }
  }

  return new Reference({
    title: opts.title || 'MIDI 参考',
    duration,
    hop,
    midi,
    voiced,
    energy,
    notes: notes.map((x) => ({ start: x.start, end: x.end, midi: x.midi, label: Math.round(x.midi) })),
    source: 'midi',
  });
}

export { midiToHz, hzToMidi, sampleAt };
