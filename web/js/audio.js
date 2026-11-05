/**
 * 音频引擎：麦克风采集、逐帧音高检测、录音、离线文件分析、WAV 导出
 *
 * 采集链：getUserMedia → MediaStreamSource → AnalyserNode(fftSize=2048)
 *        rAF 循环里 getFloatTimeDomainData → PitchDetector
 * 录音：  MediaRecorder 录 webm/opus，同时并行记录音高帧
 * 离线：  decodeAudioData → 固定 hop 滑动窗 → 同一 PitchDetector
 */

import { PitchDetector } from './pitch.js';
import { hzToMidi } from './util.js';

/** 麦克风约束：必须关掉自动增益/降噪/回声消除，否则音高会被 DSP 拉偏 */
export const MIC_CONSTRAINTS = {
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1,
    sampleRate: 48000,
  },
  video: false,
};

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.stream = null;
    this.source = null;
    this.analyser = null;
    this.detector = null;
    this.buf = null;
    this.running = false;
    this.sampleRate = 48000;
    this.windowSize = 2048;
    this.frame = null; // 最新检测结果
    this.history = []; // {t, midi, confidence, rms}
    this.startedAt = 0;
    this.latencySec = 0;
  }

  async ensureContext() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive', sampleRate: 48000 });
    this.sampleRate = this.ctx.sampleRate;
    return this.ctx;
  }

  get deviceLatency() {
    if (!this.ctx) return 0;
    const base = this.ctx.baseLatency || 0;
    const out = this.ctx.outputLatency || 0;
    return base + out;
  }

  async startMic() {
    await this.ensureContext();
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    this.stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    this.source = this.ctx.createMediaStreamSource(this.stream);

    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = this.windowSize;
    analyser.smoothingTimeConstant = 0;
    this.source.connect(analyser);
    // 注意：不要把麦克风连到 destination，否则会啸叫
    this.analyser = analyser;
    this.buf = new Float32Array(analyser.fftSize);

    this.detector = new PitchDetector(this.sampleRate, { window: this.windowSize });
    this.running = true;
    this.startedAt = this.ctx.currentTime;
    this.history = [];
    return this.stream;
  }

  stopMic() {
    this.running = false;
    if (this.stream) {
      for (const tr of this.stream.getTracks()) tr.stop();
      this.stream = null;
    }
    if (this.source) {
      try { this.source.disconnect(); } catch { /* noop */ }
      this.source = null;
    }
    this.analyser = null;
  }

  /** 取当前一帧并检测；未运行时返回 null */
  tick() {
    if (!this.running || !this.analyser) return null;
    this.analyser.getFloatTimeDomainData(this.buf);
    const r = this.detector.detect(this.buf);
    // t 为 AudioContext 绝对时间；对齐参考时间轴由 app 层用 origin 换算
    const t = this.ctx.currentTime;
    const f = {
      t,
      midi: r.voiced ? r.midi : 0,
      hz: r.voiced ? r.hz : 0,
      confidence: r.confidence,
      rms: r.rms,
      voiced: r.voiced,
    };
    this.frame = f;
    // 保留最近 30s 的实时历史，用于滚动画布
    this.history.push(f);
    if (this.history.length > 3000) this.history.splice(0, 1000);
    return f;
  }

  /** 峰值电平（0..1），给电平表用 */
  peakLevel() {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.buf);
    let peak = 0;
    for (let i = 0; i < this.buf.length; i++) {
      const v = Math.abs(this.buf[i]);
      if (v > peak) peak = v;
    }
    return Math.min(1, peak);
  }

  async close() {
    this.stopMic();
    if (this.ctx) {
      try { await this.ctx.close(); } catch { /* noop */ }
      this.ctx = null;
    }
  }
}

/**
 * 录音器：MediaRecorder 存档 + 并行音高帧
 */
export class TakeRecorder {
  constructor(engine) {
    this.engine = engine;
    this.recorder = null;
    this.chunks = [];
    this.frames = [];
    this.t0 = 0;
    this.active = false;
    this.mimeType = '';
  }

  get supported() {
    return typeof MediaRecorder !== 'undefined';
  }

  start() {
    if (!this.engine.stream) throw new Error('麦克风未开启');
    const types = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
    ];
    this.mimeType = types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
    this.chunks = [];
    this.frames = [];
    this.recorder = new MediaRecorder(this.engine.stream, this.mimeType
      ? { mimeType: this.mimeType, audioBitsPerSecond: 128000 }
      : { audioBitsPerSecond: 128000 });
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start(250);
    this.t0 = this.engine.ctx.currentTime;
    this.active = true;
  }

  /** 每帧调用，累积音高帧 */
  push(frame) {
    if (!this.active || !frame) return;
    this.frames.push({
      t: frame.t,
      midi: frame.midi,
      voiced: frame.voiced,
      confidence: frame.confidence,
      rms: frame.rms,
    });
  }

  async stop() {
    if (!this.active) return null;
    this.active = false;
    const rec = this.recorder;
    const done = new Promise((resolve) => {
      rec.onstop = () => resolve();
    });
    try { rec.stop(); } catch { /* noop */ }
    await done;
    const blob = new Blob(this.chunks, { type: this.mimeType || 'audio/webm' });
    const duration = this.frames.length
      ? this.frames[this.frames.length - 1].t - this.frames[0].t
      : 0;
    this.recorder = null;
    return { blob, frames: this.frames, duration, mimeType: this.mimeType };
  }
}

/* ───────────────── 离线文件分析 ───────────────── */

/**
 * 解码任意音频文件为 AudioBuffer
 */
export async function decodeFile(ctx, file) {
  const ab = await file.arrayBuffer();
  return await ctx.decodeAudioData(ab);
}

/**
 * 离线分析整段音频，产出逐帧音高
 * @param {AudioContext} ctx
 * @param {AudioBuffer} buffer
 * @param {{hopSec?:number, windowSize?:number, minHz?:number, maxHz?:number, progress?:(p:number)=>void}} opts
 */
export async function analyzeBuffer(ctx, buffer, opts = {}) {
  const sr = buffer.sampleRate;
  const win = opts.windowSize || 2048;
  const hopSec = opts.hopSec ?? 0.01;
  const hop = Math.max(1, Math.round(hopSec * sr));

  const detector = new PitchDetector(sr, {
    window: win,
    minHz: opts.minHz,
    maxHz: opts.maxHz,
    threshold: opts.threshold,
  });

  // 多声道取平均（人声通常在中间声道）
  const chCount = buffer.numberOfChannels;
  const mono = new Float32Array(buffer.length);
  for (let c = 0; c < chCount; c++) {
    const d = buffer.getChannelData(c);
    const w = 1 / chCount;
    for (let i = 0; i < d.length; i++) mono[i] += d[i] * w;
  }

  const frames = [];
  const total = Math.max(1, Math.floor((mono.length - win) / hop));
  let nextReport = 0;

  for (let i = 0; i < total; i++) {
    const off = i * hop;
    detector.detect(mono.subarray(off, off + win));
    const r = detector.result;
    frames.push({
      t: off / sr,
      midi: r.voiced ? r.midi : 0,
      hz: r.voiced ? r.hz : 0,
      voiced: r.voiced,
      confidence: r.confidence,
      rms: r.rms,
    });
    if (opts.progress && i >= nextReport) {
      opts.progress(i / total);
      nextReport = i + Math.max(1, Math.floor(total / 60));
      if (i % 500 === 0) await new Promise((res) => setTimeout(res, 0)); // 让出主线程
    }
  }

  if (opts.progress) opts.progress(1);
  return frames;
}

/**
 * 后处理：中值滤波 + 置信度门限 + 去八度跳变
 * 用于把原始 f0 序列变成可用的参考旋律
 */
export function cleanFrames(frames, opts = {}) {
  const minConf = opts.minConfidence ?? 0.6;
  const out = frames.map((f) => ({ ...f }));

  // 置信度/音量门限
  for (const f of out) {
    if (f.confidence < minConf && f.voiced) {
      f.voiced = false;
      f.midi = 0;
    }
  }

  // 3 点中值滤波（仅在有声帧上）
  const n = out.length;
  const src = out.map((f) => (f.voiced ? f.midi : NaN));
  for (let i = 1; i < n - 1; i++) {
    if (!out[i].voiced) continue;
    const win = [];
    for (let j = i - 1; j <= i + 1; j++) if (Number.isFinite(src[j])) win.push(src[j]);
    if (win.length >= 2) {
      win.sort((a, b) => a - b);
      const med = win[win.length >> 1];
      // 只修正离谱的毛刺
      if (Math.abs(med - src[i]) > 0.7 && Math.abs(med - src[i]) < 6) {
        out[i].midi = med;
      }
    }
  }

  // 去八度：与前后各 3 帧的中位数比较
  for (let i = 3; i < n - 3; i++) {
    if (!out[i].voiced) continue;
    const win = [];
    for (let j = i - 3; j <= i + 3; j++) if (out[j].voiced) win.push(out[j].midi);
    if (win.length < 4) continue;
    win.sort((a, b) => a - b);
    const med = win[win.length >> 1];
    const diff = out[i].midi - med;
    if (Math.abs(Math.abs(diff) - 12) < 1.2) {
      out[i].midi -= Math.sign(diff) * 12;
    }
  }

  return out;
}

/**
 * 自动对齐：找出录音相对参考的时间偏移
 *
 * 单纯的最优化相关度有个致命问题：只要滑动窗口足够长，总能找到某个
 * 偏移让"音高碰巧对上半音"，于是"唱错内容"也会得到 1.00 的置信度。
 *
 * 所以这里做三件事：
 *   1. 严格要求"整段轮廓"匹配——用连续帧的轮廓相关，而不是逐帧独立打分
 *   2. 惩罚重叠帧数太少的偏移（避免尾巴对头）
 *   3. 返回 corr = 最佳得分 − 次佳得分（区分度），只有真正唯一匹配才算数
 *
 * @param {Reference} ref
 * @param {Array} frames
 * @param {{maxLagSec?:number, stepSec?:number, minOverlap?:number}} opts
 * @returns {{offset:number, corr:number, ambiguity:number, overlap:number}}
 */
export function estimateOffset(ref, frames, opts = {}) {
  const maxLag = opts.maxLagSec ?? 6;
  const step = opts.stepSec ?? 0.05;
  const hop = ref.hop;
  const minOverlap = opts.minOverlap ?? 40;

  const n = frames.length;
  if (!n) return { offset: 0, corr: 0, ambiguity: 0, overlap: 0 };

  const takeVals = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    takeVals[i] = frames[i].voiced && frames[i].midi > 0 ? frames[i].midi : NaN;
  }

  const lagSteps = Math.max(1, Math.round(maxLag / step));
  const results = [];

  for (let k = -lagSteps; k <= lagSteps; k++) {
    const off = k * step;
    let sum = 0, cnt = 0;

    for (let i = 0; i < n; i++) {
      const v = takeVals[i];
      if (!Number.isFinite(v)) continue;
      const idx = Math.round((frames[i].t + off) / hop);
      if (idx < 0 || idx >= ref.midi.length || !ref.voiced[idx]) continue;
      const d = Math.abs(v - ref.midi[idx]) * 100;

      // 只有真正在 ±1 半音内的才贡献分数；
      // 用陡峭的核函数（50¢ 全分，100¢ 零分），不给"碰巧隔半音"留空间
      if (d < 100) sum += 1 - d / 100;
      cnt++;
    }

    if (cnt < minOverlap) continue;
    // 重叠比例惩罚：对齐后应该覆盖录音的大部分
    const overlapRatio = cnt / n;
    const corr = (sum / cnt) * Math.min(1, overlapRatio / 0.5);
    results.push({ offset: off, corr, overlap: cnt });
  }

  if (!results.length) return { offset: 0, corr: 0, ambiguity: 0, overlap: 0 };

  results.sort((a, b) => b.corr - a.corr);
  const best = results[0];

  // 区分度：最佳与"远离最佳"的次佳之差
  const rival = results.find(
    (r) => Math.abs(r.offset - best.offset) > 1.0
  );
  const ambiguity = rival ? Math.max(0, best.corr - rival.corr) : best.corr;

  return {
    offset: best.offset,
    corr: best.corr,
    ambiguity,
    overlap: best.overlap,
  };
}

/** WAV 编码（16bit PCM） */
export function encodeWav(channels, sampleRate) {
  const numCh = channels.length;
  const len = channels[0].length;
  const bytesPerSample = 2;
  const blockAlign = numCh * bytesPerSample;
  const dataSize = len * blockAlign;
  const buf = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(buf);

  const wstr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, 'RIFF');
  dv.setUint32(4, 36 + dataSize, true);
  wstr(8, 'WAVE');
  wstr(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, numCh, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * blockAlign, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, 16, true);
  wstr(36, 'data');
  dv.setUint32(40, dataSize, true);

  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      dv.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/** AudioBuffer → WAV Blob */
export function bufferToWav(buffer) {
  const chs = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chs.push(buffer.getChannelData(c));
  return encodeWav(chs, buffer.sampleRate);
}
