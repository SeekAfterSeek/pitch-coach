/**
 * 钢琴卷帘 / 音高轨迹渲染器
 *
 * 两种模式：
 *   live    —— 滚动条模式，当前时刻固定在左侧 78% 处，往右是历史，往左是「将唱」
 *   review  —— 全景模式，整首歌压缩进画布，用于复盘
 *
 * 视觉约定（K 歌软件通行做法）：
 *   灰色竖条  = 参考旋律（原唱调在哪）
 *   彩色光带  = 你的音高轨迹
 *   绿色区    = 在容差内
 *   黄色区    = 跑了一点点
 *   红色区    = 明显跑调
 */

import { clamp, hzToMidi, midiToName } from './util.js';

export class PianoRoll {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.dpr = Math.min(2.5, window.devicePixelRatio || 1);

    this.view = { t0: 0, t1: 10 };     // 可视时间窗
    this.range = { lo: 48, hi: 76 };   // 可视音域（MIDI）
    this.mode = 'live';
    this.cursorT = 0;

    this.ref = null;
    this.take = null;
    this.live = null;

    this.showLabels = true;
    this.showGrid = true;
    this.zoomX = 1;

    // 颜色
    this.colors = {
      bg: '#0b0f16',
      lane: ['#111823', '#0d141d'],
      gridStrong: 'rgba(120,150,190,0.20)',
      gridWeak: 'rgba(90,115,150,0.10)',
      refBar: 'rgba(168,186,212,0.78)',
      refBarActive: 'rgba(255,210,120,0.85)',
      cursor: 'rgba(255,255,255,0.75)',
      perfect: '#25e08a',
      great: '#5fe3a1',
      ok: '#ffd166',
      sharp: '#ff9f43',
      off: '#ff4d5e',
      missed: 'rgba(255,77,94,0.35)',
      extra: 'rgba(140,120,255,0.55)',
      label: 'rgba(200,214,232,0.55)',
    };

    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(320, Math.floor(rect.width));
    const h = Math.max(200, Math.floor(rect.height));
    this.dpr = Math.min(2.5, window.devicePixelRatio || 1);
    this.canvas.width = Math.floor(w * this.dpr);
    this.canvas.height = Math.floor(h * this.dpr);
    this.w = w;
    this.h = h;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  setReference(ref) {
    this.ref = ref;
    if (ref) {
      const lo = Math.floor(ref.range.low) - 3;
      const hi = Math.ceil(ref.range.high) + 3;
      this.range = { lo: Math.max(24, lo), hi: Math.min(100, hi) };
      this.view.t0 = 0;
      this.view.t1 = Math.min(ref.duration, this.windowSpan());
    }
  }

  setTake(take) { this.take = take; }

  setLive(frame, windowSec) {
    this.live = frame;
    if (this.mode !== 'live') return;
    if (windowSec) {
      // 保持窗口长度
      const span = this.view.t1 - this.view.t0;
      if (Math.abs(span - windowSec) > 0.01) {
        this.view.t1 = this.view.t0 + windowSec;
      }
    }
  }

  windowSpan() {
    return this.mode === 'live' ? 6 : (this.ref?.duration || 10);
  }

  /** 设置滚动视图，让 cursor 落在画布 25% 处 */
  followCursor(t, spanSec = 6) {
    this.mode = 'live';
    const cursorFrac = 0.25;
    this.view.t0 = t - spanSec * cursorFrac;
    this.view.t1 = this.view.t0 + spanSec * this.zoomX;
  }

  setReview(spanSec = null) {
    this.mode = 'review';
    this.view.t0 = 0;
    this.view.t1 = spanSec ?? (this.ref?.duration || this.take?.duration || 10);
  }

  /* ── 坐标换算 ── */
  xOf(t) {
    return ((t - this.view.t0) / (this.view.t1 - this.view.t0)) * this.w;
  }
  tOf(x) {
    return this.view.t0 + (x / this.w) * (this.view.t1 - this.view.t0);
  }
  yOf(midi) {
    const { lo, hi } = this.range;
    return this.h - ((midi - lo) / (hi - lo)) * this.h;
  }
  midiOf(y) {
    const { lo, hi } = this.range;
    return lo + ((this.h - y) / this.h) * (hi - lo);
  }
  semitoneHeight() {
    return this.h / (this.range.hi - this.range.lo);
  }

  /* ── 主绘制 ── */
  draw() {
    const ctx = this.ctx;
    const { w, h } = this;
    if (!w || !h) return;

    ctx.fillStyle = this.colors.bg;
    ctx.fillRect(0, 0, w, h);

    this.drawLanes();
    if (this.showGrid) this.drawGrid();
    this.drawRefBars();
    if (this.mode === 'review' && this.take) {
      this.drawTakeDeviationHeat();
    }
    this.drawTrack();
    if (this.mode === 'live') this.drawCursor();
    this.drawAxis();
  }

  drawLanes() {
    const ctx = this.ctx;
    const { lo, hi } = this.range;
    const sh = this.semitoneHeight();
    for (let m = Math.floor(lo); m <= Math.ceil(hi); m++) {
      const y = this.yOf(m + 1);
      const isBlack = [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);
      ctx.fillStyle = isBlack ? this.colors.lane[1] : this.colors.lane[0];
      ctx.fillRect(0, y, this.w, sh + 0.5);
    }
  }

  drawGrid() {
    const ctx = this.ctx;
    ctx.save();
    // 八度线
    ctx.strokeStyle = this.colors.gridStrong;
    ctx.lineWidth = 1;
    for (let m = Math.ceil(this.range.lo); m <= this.range.hi; m++) {
      if (m % 12 !== 0) continue;
      const y = Math.round(this.yOf(m)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(this.w, y);
      ctx.stroke();
    }
    // 时间竖线
    const span = this.view.t1 - this.view.t0;
    let step = 1;
    if (span > 40) step = 10;
    else if (span > 20) step = 5;
    else if (span > 8) step = 2;
    else if (span > 4) step = 1;
    else step = 0.5;
    ctx.strokeStyle = this.colors.gridWeak;
    const start = Math.floor(this.view.t0 / step) * step;
    for (let t = start; t <= this.view.t1; t += step) {
      if (t < this.view.t0) continue;
      const x = Math.round(this.xOf(t)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.h);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawRefBars() {
    const ref = this.ref;
    if (!ref) return;
    const ctx = this.ctx;
    const sh = this.semitoneHeight();
    const activeMidi = this.activeRefMidi();

    const hop = ref.hop;
    const iStart = Math.max(0, Math.floor(this.view.t0 / hop) - 1);
    const iEnd = Math.min(ref.midi.length - 1, Math.ceil(this.view.t1 / hop) + 1);

    const barH = Math.max(4, sh * 0.95);
    const showNames = sh >= 13;   // 行高够才标音名，否则糊成一团
    const pads = [];

    const flush = (a, b) => {
      if (a < 0 || b < a) return;
      const midi = ref.midi[a];
      const y = this.yOf(midi + 1.0);
      const x0 = this.xOf(a * hop);
      const x1 = this.xOf((b + 1) * hop);
      const w = Math.max(2, x1 - x0);

      // 底色（不透明一点，让"原唱在哪"一眼可见）
      ctx.fillStyle = this.colors.refBar;
      roundRect(ctx, x0, y + (sh - barH) / 2, w, barH, 2);
      ctx.fill();

      // 描边：让灰条边界清晰，不与背景糊在一起
      ctx.strokeStyle = 'rgba(190,210,235,0.55)';
      ctx.lineWidth = 1;
      roundRect(ctx, x0 + 0.5, y + (sh - barH) / 2 + 0.5, Math.max(1, w - 1), barH - 1, 2);
      ctx.stroke();

      pads.push({ x0, x1, midi, w });

      // 当前应唱音：高亮
      if (this.mode === 'live' && activeMidi != null && Math.abs(midi - activeMidi) < 0.25) {
        const cx = this.xOf(this.cursorT);
        ctx.fillStyle = this.colors.refBarActive;
        roundRect(ctx, cx, y + (sh - barH) / 2, Math.max(2, x1 - cx), barH, 2);
        ctx.fill();
      }
    };

    let curQ = null, segStart = -1;
    for (let i = iStart; i <= iEnd; i++) {
      const on = ref.voiced[i];
      const q = on ? Math.round(ref.midi[i] * 2) / 2 : null;
      if (segStart < 0) {
        if (on) { segStart = i; curQ = q; }
      } else if (!on || q !== curQ) {
        flush(segStart, i - 1);
        if (on) { segStart = i; curQ = q; } else { segStart = -1; }
      }
    }
    if (segStart >= 0) flush(segStart, iEnd);

    // 音名标注：写在足够宽的灰条上，让人直接看出"这里该唱 C4"
    if (showNames) {
      ctx.save();
      ctx.font = `${Math.min(11, Math.max(8, Math.floor(sh * 0.62)))}px ui-monospace, monospace`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      for (const p of pads) {
        if (p.w < 22) continue;                       // 太窄放不下
        const y = this.yOf(p.midi + 1.0) + sh / 2;
        if (y < 6 || y > this.h - 4) continue;
        ctx.fillStyle = 'rgba(20,28,38,0.9)';
        ctx.fillText(midiToName(p.midi), Math.max(p.x0 + 3, 2), y);
      }
      ctx.restore();
    }
  }

  activeRefMidi() {
    const ref = this.ref;
    if (!ref) return null;
    const idx = Math.round(this.cursorT / ref.hop);
    if (idx < 0 || idx >= ref.midi.length) return null;
    return ref.voiced[idx] ? ref.midi[idx] : null;
  }

  /** 音分偏差 → 颜色 */
  bandColor(band) {
    switch (band) {
      case 'perfect': return this.colors.perfect;
      case 'great': return this.colors.great;
      case 'ok': return this.colors.ok;
      case 'sharp': return this.colors.sharp;
      case 'off': return this.colors.off;
      case 'missed': return this.colors.missed;
      case 'extra': return this.colors.extra;
      default: return this.colors.missed;
    }
  }

  /** 轨迹绘制（复盘/全景模式） */
  drawTrack() {
    const ctx = this.ctx;
    if (this.mode === 'live') {
      this.drawLiveTrack();
      return;
    }
    // review：画 take 的完整轨迹
    const take = this.take;
    if (!take || !take.frames?.length) return;
    const frames = take.frames;
    const sh = this.semitoneHeight();

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(2, Math.min(7, sh * 0.5));

    // 按"连续同色段"收集，最后统一落笔。
    // 之前每个点都判断变色，导致最后一段没有终结条件而丢失。
    let pts = [];
    let band = null;
    let prevMidi = null;

    const flush = () => {
      if (pts.length === 1) {
        const [x, y] = pts[0];
        ctx.fillStyle = this.bandColor(band || 'ok');
        ctx.beginPath();
        ctx.arc(x, y, Math.max(1.5, ctx.lineWidth / 2), 0, Math.PI * 2);
        ctx.fill();
      } else if (pts.length > 1) {
        ctx.strokeStyle = this.bandColor(band || 'ok');
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k][0], pts[k][1]);
        ctx.stroke();
      }
      pts = [];
    };

    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const t = f.t + (take.offset || 0);
      if (t < this.view.t0 - 0.1 || t > this.view.t1 + 0.1) {
        flush(); band = null; prevMidi = null; continue;
      }
      if (!f.voiced || !f.midi) { flush(); band = null; prevMidi = null; continue; }

      // 音高跳变（≥5 个半音）多半是检测跳八度或换音瞬间，
      // 不能连成一条直线——否则会画出贯穿全屏的竖直尖刺，看着像严重跑调。
      if (prevMidi != null && Math.abs(f.midi - prevMidi) >= 5) {
        flush();
        band = null;
      }
      prevMidi = f.midi;

      const b = f.band || 'ok';
      if (band !== null && b !== band) flush();
      band = b;
      pts.push([this.xOf(t), this.yOf(f.midi)]);
    }
    flush();
    ctx.restore();
  }

  drawLiveTrack() {
    const ctx = this.ctx;
    const history = this.liveHistory;
    if (!history || !history.length) return;
    const sh = this.semitoneHeight();

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(2.5, Math.min(9, sh * 0.55));
    ctx.shadowBlur = 10;
    ctx.shadowColor = 'rgba(37,224,138,0.35)';

    let pts = [];
    let band = null;
    let prevMidi = null;
    const flush = () => {
      if (pts.length > 1) {
        ctx.strokeStyle = this.bandColor(band || 'ok');
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.stroke();
      }
      pts = [];
    };

    for (const f of history) {
      const t = f.t;
      if (t < this.view.t0 - 0.05 || t > this.view.t1 + 0.05) {
        flush(); band = null; prevMidi = null; continue;
      }
      if (!f.voiced || !f.midi) { flush(); band = null; prevMidi = null; continue; }

      // 音高跳变 ≥5 半音不连线，避免跳八度瞬间画出贯穿全屏的竖线
      if (prevMidi != null && Math.abs(f.midi - prevMidi) >= 5) {
        flush();
        band = null;
      }
      prevMidi = f.midi;

      const b = f.band || 'ok';
      if (band !== null && b !== band) flush();
      band = b;
      pts.push([this.xOf(t), this.yOf(f.midi)]);
    }
    flush();
    ctx.restore();

    // 当前点光晕
    const cur = this.live;
    if (cur && cur.voiced && cur.midi) {
      const x = this.xOf(cur.t);
      const y = this.yOf(cur.midi);
      if (x >= -20 && x <= this.w + 20) {
        const r = Math.max(4, Math.min(11, sh * 0.6));
        const g = ctx.createRadialGradient(x, y, 0, x, y, r * 3);
        const col = this.bandColor(cur.band || 'ok');
        g.addColorStop(0, col);
        g.addColorStop(0.35, hexA(col, 0.55));
        g.addColorStop(1, hexA(col, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r * 3, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(x, y, r * 0.42, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  strokePath(pts, color, band) {
    const ctx = this.ctx;
    if (pts.length === 1) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(pts[0][0], pts[0][1], ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
  }

  /** 复盘：底部偏差热力条 */
  drawTakeDeviationHeat() {
    const take = this.take;
    if (!take?.phraseScores?.length) return;
    const ctx = this.ctx;
    const barH = 6;
    const y = this.h - barH;
    for (const ph of take.phraseScores) {
      const t0 = ph.t0 + (take.offset || 0);
      const t1 = ph.t1 + (take.offset || 0);
      const x0 = this.xOf(t0), x1 = this.xOf(t1);
      if (x1 < 0 || x0 > this.w) continue;
      const s = ph.score / 100;
      ctx.fillStyle = s > 0.85 ? 'rgba(37,224,138,0.75)'
        : s > 0.65 ? 'rgba(255,209,102,0.75)'
        : s > 0.4 ? 'rgba(255,159,67,0.8)'
        : 'rgba(255,77,94,0.85)';
      ctx.fillRect(Math.max(0, x0), y, Math.max(1, x1 - x0 - 1), barH);
    }
  }

  drawCursor() {
    const ctx = this.ctx;
    const x = this.xOf(this.cursorT);
    if (x < -2 || x > this.w + 2) return;
    ctx.save();
    ctx.strokeStyle = this.colors.cursor;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, this.h);
    ctx.stroke();
    ctx.restore();
  }

  drawAxis() {
    const ctx = this.ctx;
    const sh = this.semitoneHeight();
    if (!this.showLabels) return;
    if (sh < 9) return; // 太密不画

    ctx.save();
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';

    const { lo, hi } = this.range;
    for (let m = Math.ceil(lo); m <= Math.floor(hi); m++) {
      if (m % 12 !== 0) continue;
      const y = this.yOf(m + 0.5);
      ctx.fillStyle = 'rgba(150,170,195,0.6)';
      ctx.fillText(midiToName(m), 4, y);
    }
    ctx.restore();

    // 顶部时间轴
    ctx.save();
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillStyle = 'rgba(150,170,195,0.55)';
    const span = this.view.t1 - this.view.t0;
    let step = span > 40 ? 10 : span > 20 ? 5 : span > 8 ? 2 : 1;
    const start = Math.floor(Math.max(0, this.view.t0) / step) * step;
    for (let t = start; t <= this.view.t1; t += step) {
      const x = this.xOf(t);
      if (x < 10 || x > this.w - 20) continue;
      ctx.fillText(t.toFixed(0) + 's', x + 3, 10);
    }
    ctx.restore();
  }

  /** 点击定位 */
  hitTest(px) {
    return this.tOf(px);
  }
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function hexA(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r},${g},${b},${a})`;
}
