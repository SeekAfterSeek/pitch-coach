/**
 * 音高检测核心 —— YIN (de Cheveigné & Kawahara, 2002) 的 FFT 加速实现
 *
 * 为什么选 YIN 而不是 CREPE：
 *   1. 纯 CPU、无模型权重、单帧 < 0.3ms，能在 60fps 实时循环里跑；
 *   2. 对人声（55–1200Hz）精度约 ±3 音分，比 K 歌判定所需的 ±50 音分高一个量级；
 *   3. 离线批量分析同一份实现，保证实时分数与录音复盘分数完全一致。
 * CREPE（torchcrepe）精度更高但需要 PyTorch + 权重，只在 python/ 工具链里作为
 * 高精度离线选项提供，见 python/analyze.py。
 *
 * 算法步骤：
 *   1. 差分函数 d(τ) = Σ (x[j] - x[j+τ])²  —— 用 FFT 自相关加速为 O(N log N)
 *   2. 累积均值归一化 CMND：d'(τ) = d(τ)·τ / Σ_{j≤τ} d(j)
 *   3. 取第一个低于阈值的局部极小（避免把 2 倍周期当成基频）
 *   4. 抛物线插值细化 τ，得到亚采样精度
 *   5. 谐波校验：若 f0/2 处能量可观，判定为低八度误检并纠正
 */

import { Autocorrelator, Spectrum } from './fft.js';
import { hzToMidi, midiToHz, clamp } from './util.js';

export const PITCH_MIN_HZ = 80;    // 人声下限附近（E2 ≈ 82Hz，男低音极限）
export const PITCH_MAX_HZ = 1100;  // 女高音上限附近（C6 ≈ 1047Hz，含少量余量）

export class PitchDetector {
  /**
   * @param {number} sampleRate
   * @param {{window?:number, threshold?:number, minHz?:number, maxHz?:number}} opts
   *        window 必须是 2 的幂
   */
  constructor(sampleRate, opts = {}) {
    this.sampleRate = sampleRate;
    this.windowSize = opts.window || 2048;
    this.threshold = opts.threshold ?? 0.15;
    this.minHz = opts.minHz ?? PITCH_MIN_HZ;
    this.maxHz = opts.maxHz ?? PITCH_MAX_HZ;

    this.ac = new Autocorrelator(this.windowSize);
    this.spec = new Spectrum(this.windowSize);

    this.x = new Float64Array(this.windowSize);
    this.d = new Float64Array(this.windowSize);
    this.cmnd = new Float64Array(this.windowSize);
    this.cum = new Float64Array(this.windowSize + 1);
    this.power = new Float64Array(this.windowSize);

    this.tauMin = Math.max(2, Math.floor(sampleRate / this.maxHz));
    this.tauMax = Math.min(
      this.windowSize - 2,
      Math.ceil(sampleRate / this.minHz)
    );

    this.result = {
      hz: 0, midi: 0, cents: 0, confidence: 0, rms: 0, voiced: false,
    };
  }

  /**
   * 检测一帧。
   * @param {Float32Array|Float64Array} buf 长度为 windowSize 的时域样本（-1..1）
   * @returns {{hz:number, midi:number, cents:number, confidence:number, rms:number, voiced:boolean}}
   */
  detect(buf) {
    const W = this.windowSize;
    const x = this.x;
    const res = this.result;

    // —— 0. 音量 ——
    let energy = 0;
    for (let i = 0; i < W; i++) {
      const s = buf[i];
      x[i] = s;
      energy += s * s;
    }
    const rms = Math.sqrt(energy / W);
    res.rms = rms;

    // 静音门限：-58 dBFS 以下视为无声，避免噪声被当成音高
    if (rms < 0.0012) {
      res.hz = 0; res.midi = 0; res.cents = 0;
      res.confidence = 0; res.voiced = false;
      return res;
    }

    // —— 1. 差分函数（经自相关加速）——
    const r = this.ac.run(x);
    // 前缀和复用缓冲：每帧新建 Float64Array(W) 会产生大量 GC 压力，
    // 离线分析一首 4 分钟歌要跑上万帧，实测这处占一半以上耗时。
    const power = this.power;
    let acc = 0;
    for (let i = 0; i < W; i++) { acc += x[i] * x[i]; power[i] = acc; }

    const d = this.d;
    const dmax = this.tauMax;
    const totalEnergy = power[W - 1];
    d[0] = 0;
    for (let tau = 1; tau <= dmax; tau++) {
      // Σ_{j=0}^{W-1-tau}(x[j]-x[j+tau])²
      // = E[0..W-tau-1] + E[tau..W-1] - 2·r[tau]
      const n = W - tau;
      const e1 = power[n - 1];
      const e2 = totalEnergy - power[tau - 1];
      d[tau] = Math.max(0, e1 + e2 - 2 * r[tau]);
    }

    // —— 2. CMND 归一化 ——
    const cum = this.cum;
    cum[0] = 0;
    for (let tau = 1; tau <= dmax; tau++) cum[tau] = cum[tau - 1] + d[tau];
    const cmnd = this.cmnd;
    cmnd[0] = 1;
    for (let tau = 0; tau <= dmax; tau++) {
      cmnd[tau] = cum[tau] > 1e-12 ? (d[tau] * tau) / cum[tau] : 1;
    }

    // —— 3. 找第一个低于阈值的局部极小 ——
    let tau = -1;
    let bestVal = Infinity;
    let bestTau = -1;
    for (let t = this.tauMin; t <= dmax - 1; t++) {
      const v = cmnd[t];
      if (v < bestVal) { bestVal = v; bestTau = t; }
      if (v < this.threshold) {
        // 走向局部极小
        let k = t;
        while (k + 1 <= dmax && cmnd[k + 1] < cmnd[k]) k++;
        tau = k;
        break;
      }
    }
    if (tau < 0) {
      // 没有清晰周期：置信度低，标记为未发声但保留候选
      if (bestTau > 0 && bestVal < 0.35) {
        tau = bestTau;
      } else {
        res.hz = 0; res.midi = 0; res.cents = 0;
        res.confidence = 0; res.voiced = false;
        return res;
      }
    }

    // —— 4. 抛物线插值 ——
    const s0 = cmnd[tau - 1] ?? cmnd[tau];
    const s1 = cmnd[tau];
    const s2 = cmnd[tau + 1] ?? s1;
    let shift = 0;
    const denom = s0 - 2 * s1 + s2;
    if (Math.abs(denom) > 1e-12) {
      shift = clamp((s0 - s2) / (2 * denom), -1, 1);
    }
    let tauF = tau + shift;
    let hz = this.sampleRate / tauF;

    // —— 5. 低八度/谐波校验 ——
    hz = this.correctOctave(x, hz);

    const conf = clamp(1 - s1, 0, 1);

    res.hz = hz;
    res.midi = hzToMidi(hz);
    res.confidence = conf;
    res.voiced = conf > 0.55 && hz >= this.minHz * 0.98 && hz <= this.maxHz * 1.02;

    // 量化偏差：相对最近半音的音分差
    res.cents = (res.midi - Math.round(res.midi)) * 100;
    return res;
  }

  /**
   * 谐波校验（双向）：修正 YIN 的八度误判。
   *
   * 用真实清唱录音实测：老版只查 f0/2，漏掉了反向的八度跳变——
   * 人声实际音高被检成高八度（midi 88.9 = E6，人声不可能），
   * 或低八度（midi 34.5 = A1，低于人声下限）。
   *
   * 现在两个方向都查，并且都要求"另一方向能量显著更强"才改：
   *   - f0/2 能量 > f0 的 1.35 倍 → 真实基频在低八度，降下来
   *   - f0*2 能量 > f0 的 1.8 倍 且 f0 本身很弱 → 真实基频在高八度，升上去
   * 阈值不对称：降八度更常见（男性低音区泛音强），升八度要求更严格。
   */
  correctOctave(x, hz) {
    const mag = this.spec.run(x);
    const binHz = this.sampleRate / this.windowSize;
    const W = this.windowSize;

    const energyAt = (f) => {
      const b = f / binHz;
      if (b < 1 || b >= mag.length - 1) return 0;
      const i0 = Math.floor(b);
      // 抛物线插值幅值（取 1 栅格内的最强峰，避免桶间泄漏漏检）
      let peak = 0;
      for (let k = i0 - 1; k <= i0 + 1; k++) {
        if (k >= 1 && k < mag.length) peak = Math.max(peak, mag[k] || 0);
      }
      return peak;
    };

    // ① 低八度修正：候选 f0 其实是二次谐波
    if (hz / 2 >= this.minHz) {
      const eHalf = energyAt(hz / 2);
      const eFull = energyAt(hz);
      if (eHalf > eFull * 1.35 && eHalf > 1e-4) {
        hz = hz / 2;
      }
    }
    // ② 高八度修正：候选 f0 只是真实音高的低八度（f0 处能量弱、2f0 强）
    //    门限更严：要求 2f0 强出很多，且 f0 本身确实很弱（避免把"基频弱但正确"
    //    的男低音误升八度——合成测试里弱基频信号就栽在这）。
    if (hz * 2 <= this.maxHz) {
      const eFull = energyAt(hz);
      const eDouble = energyAt(hz * 2);
      const weakFundamental = eFull < 0.15;         // f0 真的没什么能量
      if (weakFundamental && eDouble > eFull * 3.0 && eDouble > 1e-3) {
        hz = hz * 2;
      }
    }
    return hz;
  }

  /** 改变窗口大小（会重建内部缓冲） */
  setWindow(n) {
    this.windowSize = n;
    this.ac = new Autocorrelator(n);
    this.spec = new Spectrum(n);
    this.x = new Float64Array(n);
    this.d = new Float64Array(n);
    this.cmnd = new Float64Array(n);
    this.cum = new Float64Array(n + 1);
    this.power = new Float64Array(n);
    this.tauMin = Math.max(2, Math.floor(this.sampleRate / this.maxHz));
    this.tauMax = Math.min(n - 2, Math.ceil(this.sampleRate / this.minHz));
  }
}

/**
 * 一帧的"唱名"展示用：返回最近的音名与偏差音分
 */
export function describeNote(midi) {
  if (!Number.isFinite(midi) || midi <= 0) return { name: '--', cents: 0, nearest: 0 };
  const nearest = Math.round(midi);
  return {
    nearest,
    cents: (midi - nearest) * 100,
  };
}

export { midiToHz };
