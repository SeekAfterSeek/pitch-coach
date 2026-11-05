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
    // 位反转重排：展开成 8 路，减少循环内分支与数组边界检查
    let i = 0;
    for (; i + 7 < n; i += 8) {
      let j;
      j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
      j = rev[i + 1]; if (j > i + 1) { let t = re[i + 1]; re[i + 1] = re[j]; re[j] = t; t = im[i + 1]; im[i + 1] = im[j]; im[j] = t; }
      j = rev[i + 2]; if (j > i + 2) { let t = re[i + 2]; re[i + 2] = re[j]; re[j] = t; t = im[i + 2]; im[i + 2] = im[j]; im[j] = t; }
      j = rev[i + 3]; if (j > i + 3) { let t = re[i + 3]; re[i + 3] = re[j]; re[j] = t; t = im[i + 3]; im[i + 3] = im[j]; im[j] = t; }
      j = rev[i + 4]; if (j > i + 4) { let t = re[i + 4]; re[i + 4] = re[j]; re[j] = t; t = im[i + 4]; im[i + 4] = im[j]; im[j] = t; }
      j = rev[i + 5]; if (j > i + 5) { let t = re[i + 5]; re[i + 5] = re[j]; re[j] = t; t = im[i + 5]; im[i + 5] = im[j]; im[j] = t; }
      j = rev[i + 6]; if (j > i + 6) { let t = re[i + 6]; re[i + 6] = re[j]; re[j] = t; t = im[i + 6]; im[i + 6] = im[j]; im[j] = t; }
      j = rev[i + 7]; if (j > i + 7) { let t = re[i + 7]; re[i + 7] = re[j]; re[j] = t; t = im[i + 7]; im[i + 7] = im[j]; im[j] = t; }
    }
    for (; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const cos = this.cos, sin = this.sin;
    // 蝶形运算：外层按 size 展开，最内层 4 路展开减少循环开销
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let base = 0; base < n; base += size) {
        const end = base + half;
        let j = base, k = 0;
        for (; j + 3 < end; j += 4, k += 4 * step) {
          const c0 = cos[k], s0 = sin[k];
          const c1 = cos[k + step], s1 = sin[k + step];
          const c2 = cos[k + 2 * step], s2 = sin[k + 2 * step];
          const c3 = cos[k + 3 * step], s3 = sin[k + 3 * step];

          const l0 = j + half;
          const tre0 = re[l0] * c0 - im[l0] * s0;
          const tim0 = re[l0] * s0 + im[l0] * c0;
          re[l0] = re[j] - tre0; im[l0] = im[j] - tim0;
          re[j] += tre0; im[j] += tim0;

          const l1 = l0 + 1;
          const tre1 = re[l1] * c1 - im[l1] * s1;
          const tim1 = re[l1] * s1 + im[l1] * c1;
          re[l1] = re[j + 1] - tre1; im[l1] = im[j + 1] - tim1;
          re[j + 1] += tre1; im[j + 1] += tim1;

          const l2 = l0 + 2;
          const tre2 = re[l2] * c2 - im[l2] * s2;
          const tim2 = re[l2] * s2 + im[l2] * c2;
          re[l2] = re[j + 2] - tre2; im[l2] = im[j + 2] - tim2;
          re[j + 2] += tre2; im[j + 2] += tim2;

          const l3 = l0 + 3;
          const tre3 = re[l3] * c3 - im[l3] * s3;
          const tim3 = re[l3] * s3 + im[l3] * c3;
          re[l3] = re[j + 3] - tre3; im[l3] = im[j + 3] - tim3;
          re[j + 3] += tre3; im[j + 3] += tim3;
        }
        for (; j < end; j++, k += step) {
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
    // 只清尾部（零填充区），前半段直接覆盖写。
    // 原来 re.fill(0)+im.fill(0) 每帧要清 8192 个元素，
    // 而实际只有 [w, n) 需要清零——这一处占了自相关一半以上的时间。
    for (let i = 0; i < w; i++) re[i] = x[i];
    re.fill(0, w);
    im.fill(0);

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
