/* 通用工具：音高换算、数值处理、小工具 */

export const A4 = 440;

/** 频率 → MIDI 浮点音高 */
export function hzToMidi(hz, a4 = A4) {
  if (!hz || hz <= 0) return 0;
  return 69 + 12 * Math.log2(hz / a4);
}

/** MIDI 浮点音高 → 频率 */
export function midiToHz(m, a4 = A4) {
  return a4 * Math.pow(2, (m - 69) / 12);
}

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** MIDI → 音名，如 60 → "C4" */
export function midiToName(m) {
  if (!Number.isFinite(m)) return '--';
  const r = Math.round(m);
  const oct = Math.floor(r / 12) - 1;
  return NAMES[((r % 12) + 12) % 12] + oct;
}

/** 只取音名（不含八度） */
export function midiToPitchClass(m) {
  const r = Math.round(m);
  return NAMES[((r % 12) + 12) % 12];
}

/** 音分差：两音高之间相差多少 cents */
export function centsBetween(mA, mB) {
  return (mA - mB) * 100;
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** 中位数（会修改传入数组顺序，调用方自备副本） */
export function median(arr) {
  if (!arr.length) return 0;
  const a = arr.slice().sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

export function mean(arr) {
  if (!arr.length) return 0;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

/** 分位数 p ∈ [0,1] */
export function quantile(arr, p) {
  if (!arr.length) return 0;
  const a = arr.slice().sort((x, y) => x - y);
  const idx = clamp(Math.round(p * (a.length - 1)), 0, a.length - 1);
  return a[idx];
}

/** 一维中值滤波（去毛刺） */
export function medianFilter(arr, radius = 1) {
  if (radius < 1 || arr.length < 3) return arr;
  const out = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    const lo = Math.max(0, i - radius);
    const hi = Math.min(arr.length - 1, i + radius);
    const win = [];
    for (let j = lo; j <= hi; j++) if (Number.isFinite(arr[j])) win.push(arr[j]);
    out[i] = win.length ? median(win) : arr[i];
  }
  return out;
}

/** 格式化秒 → m:ss.s */
export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/** 音分 → 显示文本 */
export function fmtCents(c) {
  if (!Number.isFinite(c)) return '--';
  const v = Math.round(c);
  return (v > 0 ? '+' : '') + v + '¢';
}

/** 线性插值取值：给定时序数组取值 */
export function sampleAt(times, values, t) {
  if (!times.length) return null;
  if (t <= times[0]) return values[0];
  if (t >= times[times.length - 1]) return values[values.length - 1];
  let lo = 0, hi = times.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid; else hi = mid;
  }
  const t0 = times[lo], t1 = times[hi];
  const v0 = values[lo], v1 = values[hi];
  if (v0 == null || v1 == null || t1 === t0) return v0 ?? v1;
  const f = (t - t0) / (t1 - t0);
  return v0 + (v1 - v0) * f;
}

export function uid(prefix = 'id') {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** 节流：每帧最多执行一次 */
export function rafThrottle(fn) {
  let queued = false, lastArgs = null;
  return (...args) => {
    lastArgs = args;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn(...lastArgs);
    });
  };
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
