/**
 * 音分表盘 —— 圆形指针表，实时显示"你比标准音高了几音分"
 * 中心为 0（准），向左为偏低（flat），向右为偏高（sharp）
 * 外圈色带：绿(±25) → 黄(±50) → 橙(±100) → 红(>100)
 */

import { clamp } from './util.js';

export class CentsGauge {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.value = 0;
    this.target = 0;
    this.smooth = 0;
    this.active = false;
    this.noteName = '--';
    this.refName = '--';
    this.maxCents = 100;
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const size = Math.max(140, Math.floor(Math.min(rect.width, rect.height)));
    this.dpr = Math.min(2.5, window.devicePixelRatio || 1);
    this.size = size;
    this.canvas.width = Math.floor(size * this.dpr);
    this.canvas.height = Math.floor(size * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  set(cents, active, noteName, refName) {
    if (active && Number.isFinite(cents)) {
      this.target = clamp(cents, -this.maxCents, this.maxCents);
    }
    this.active = active;
    if (noteName !== undefined) this.noteName = noteName;
    if (refName !== undefined) this.refName = refName;
  }

  /** 每帧调用：指数平滑指针 */
  step() {
    const k = this.active ? 0.28 : 0.12;
    this.smooth += (this.target - this.smooth) * k;
    if (Math.abs(this.smooth - this.target) < 0.05) this.smooth = this.target;
  }

  draw() {
    const ctx = this.ctx;
    const S = this.size;
    if (!S) return;
    const cx = S / 2, cy = S / 2;
    const R = S * 0.42;

    ctx.clearRect(0, 0, S, S);

    // 起始角：从 150° 到 390°（即 -120°..+120°，开口朝下）
    const start = Math.PI * (150 / 180);
    const end = Math.PI * (390 / 180);
    const span = end - start;

    // —— 外圈色带 ——
    const bands = [
      { from: -100, to: -50, color: '#ff9f43' },
      { from: -50, to: -25, color: '#ffd166' },
      { from: -25, to: 25, color: '#25e08a' },
      { from: 25, to: 50, color: '#ffd166' },
      { from: 50, to: 100, color: '#ff9f43' },
    ];
    const arcW = S * 0.055;
    for (const b of bands) {
      const a0 = start + ((b.from + this.maxCents) / (2 * this.maxCents)) * span;
      const a1 = start + ((b.to + this.maxCents) / (2 * this.maxCents)) * span;
      ctx.beginPath();
      ctx.arc(cx, cy, R, a0, a1);
      ctx.strokeStyle = b.color;
      ctx.lineWidth = arcW;
      ctx.lineCap = 'butt';
      ctx.globalAlpha = this.active ? 0.95 : 0.35;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // —— 刻度 ——
    ctx.save();
    for (let c = -100; c <= 100; c += 10) {
      const a = start + ((c + this.maxCents) / (2 * this.maxCents)) * span;
      const isMajor = c % 50 === 0;
      const r0 = R - arcW / 2 - 4;
      const r1 = r0 - (isMajor ? 9 : 4);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.strokeStyle = isMajor ? 'rgba(210,225,245,0.65)' : 'rgba(160,180,205,0.3)';
      ctx.lineWidth = isMajor ? 1.6 : 1;
      ctx.stroke();
    }
    ctx.restore();

    // —— 指针 ——
    const a = start + ((this.smooth + this.maxCents) / (2 * this.maxCents)) * span;
    const needleLen = R - arcW / 2 - 12;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(a);
    ctx.beginPath();
    ctx.moveTo(-6, 0);
    ctx.lineTo(needleLen, 0);
    ctx.strokeStyle = this.active ? this.bandColor(this.smooth) : 'rgba(140,160,185,0.5)';
    ctx.lineWidth = Math.max(2.5, S * 0.018);
    ctx.lineCap = 'round';
    ctx.shadowBlur = this.active ? 12 : 0;
    ctx.shadowColor = this.bandColor(this.smooth);
    ctx.stroke();
    ctx.restore();

    // 中心圆点
    ctx.beginPath();
    ctx.arc(cx, cy, S * 0.045, 0, Math.PI * 2);
    ctx.fillStyle = '#1a2330';
    ctx.fill();
    ctx.strokeStyle = 'rgba(160,185,215,0.5)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // —— 中央数值 ——
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const hasNote = this.active && this.noteName && this.noteName !== '--';
    ctx.font = `600 ${Math.round(S * 0.14)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.fillStyle = hasNote ? '#eaf2ff' : 'rgba(180,200,225,0.35)';
    ctx.fillText(hasNote ? this.noteName : '--', cx, cy + S * 0.16);

    if (hasNote) {
      const v = Math.round(this.smooth);
      ctx.font = `600 ${Math.round(S * 0.075)}px ui-monospace, monospace`;
      ctx.fillStyle = this.bandColor(this.smooth);
      ctx.fillText((v > 0 ? '+' : '') + v + '¢', cx, cy + S * 0.29);
    }

    ctx.font = `500 ${Math.round(S * 0.045)}px system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(150,175,205,0.55)';
    ctx.fillText('偏低', cx - R * 0.72, cy + S * 0.30);
    ctx.fillText('偏高', cx + R * 0.72, cy + S * 0.30);

    // 参考音名（应唱）
    if (this.refName && this.refName !== '--') {
      ctx.font = `500 ${Math.round(S * 0.05)}px ui-monospace, monospace`;
      ctx.fillStyle = 'rgba(255,209,102,0.75)';
      ctx.fillText('应唱 ' + this.refName, cx, cy - S * 0.26);
    }
    ctx.restore();
  }

  bandColor(c) {
    const a = Math.abs(c);
    if (a <= 25) return '#25e08a';
    if (a <= 50) return '#ffd166';
    if (a <= 100) return '#ff9f43';
    return '#ff4d5e';
  }
}
