/* 迭代式 radix-2 FFT（原地、预计算位反转与旋转因子） */

export class FFT {
  constructor(n) {
    if ((n & (n - 1)) !== 0) throw new Error('FFT size must be power of two: ' + n);
    this.n = n;
    this.rev = new Uint32Array(n);
    let bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r = (r << 1) | ((i >> b) & 1);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n >> 1);
    this.sin = new Float64Array(n >> 1);
    for (let i = 0; i < (n >> 1); i++) {
      const a = (-2 * Math.PI * i) / n;
      this.cos[i] = Math.cos(a);
      this.sin[i] = Math.sin(a);
    }
  }

  /** 正向变换，re/im 长度必须等于 n */
  transform(re, im) {
    const n = this.n, rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const cos = this.cos, sin = this.sin;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const c = cos[k], s = sin[k];
          const l = j + half;
          const tre = re[l] * c - im[l] * s;
          const tim = re[l] * s + im[l] * c;
          re[l] = re[j] - tre;
          im[l] = im[j] - tim;
          re[j] += tre;
          im[j] += tim;
        }
      }
    }
  }

  inverse(re, im) {
    const n = this.n;
    // 共轭 → 正向 → 共轭 / n
    for (let i = 0; i < n; i++) im[i] = -im[i];
    this.transform(re, im);
    const inv = 1 / n;
    for (let i = 0; i < n; i++) {
      re[i] *= inv;
      im[i] = -im[i] * inv;
    }
  }
}

/**
 * 自相关：r[τ] = Σ_{j} x[j]·x[j+τ]（零填充线性自相关）
 * 输入长度 W，输出长度 W（τ = 0..W-1）
 */
export class Autocorrelator {
  constructor(w) {
    this.w = w;
    let n = 1;
    while (n < w * 2) n <<= 1;
    this.n = n;
    this.fft = new FFT(n);
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
    this.out = new Float64Array(w);
  }

  run(x) {
    const { n, re, im, w, out } = this;
    re.fill(0); im.fill(0);
    for (let i = 0; i < w; i++) re[i] = x[i];
    this.fft.transform(re, im);
    for (let i = 0; i < n; i++) {
      re[i] = re[i] * re[i] + im[i] * im[i];
      im[i] = 0;
    }
    this.fft.inverse(re, im);
    for (let t = 0; t < w; t++) out[t] = re[t];
    return out;
  }
}

/** 实数频谱幅值（用于音量/谐波分析），长度 n/2 */
export class Spectrum {
  constructor(n) {
    this.n = n;
    this.fft = new FFT(n);
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
    this.mag = new Float64Array(n >> 1);
  }
  run(x) {
    const { n, re, im, mag } = this;
    re.fill(0); im.fill(0);
    for (let i = 0; i < n; i++) re[i] = x[i] || 0;
    this.fft.transform(re, im);
    for (let i = 0; i < (n >> 1); i++) mag[i] = Math.hypot(re[i], im[i]);
    return mag;
  }
}
