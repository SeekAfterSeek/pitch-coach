/**
 * 内置练习曲目 + 合成器
 *
 * 曲目全部为公有领域（传统民谣/古典片段），或程序化生成的音阶练习，
 * 不含任何受版权保护的当代录音。
 *
 * 每条曲目以音符列表表示，播放时用 WebAudio 合成，同时作为参考轨道。
 */

/** 音名 → MIDI */
const N = {
  C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11,
};

/** "C4" → 60 */
export function nameToMidi(s) {
  const m = /^([A-G]#?)(-?\d)$/.exec(s);
  if (!m) throw new Error('bad note: ' + s);
  return (Number(m[2]) + 1) * 12 + N[m[1]];
}

/** 生成器：把 "C4:1 D4:1 E4:2" 这类简谱式串解析为音符 */
function parseSeq(str, startBeat = 0, bpm = 90) {
  const spb = 60 / bpm;
  const beats = str.trim().split(/\s+/);
  const notes = [];
  let beat = startBeat;
  for (const tok of beats) {
    const [pitch, lenStr] = tok.split(':');
    const len = Number(lenStr || 1);
    if (pitch !== '-') {
      notes.push({
        start: beat * spb,
        end: (beat + len * 0.94) * spb, // 留 6% 空隙，避免连音
        midi: nameToMidi(pitch),
        velocity: 0.8,
      });
    }
    beat += len;
  }
  return { notes, endBeat: beat };
}

function seq(str, opts = {}) {
  const bpm = opts.bpm || 90;
  const { notes, endBeat } = parseSeq(str, 0, bpm);
  return {
    id: opts.id,
    title: opts.title,
    subtitle: opts.subtitle || '',
    bpm,
    notes,
    duration: endBeat * (60 / bpm) + 0.6,
  };
}

/** 五声音阶上行下行（C 大调宫调式） */
const scaleC = seq(
  'C3:1 D3:1 E3:1 G3:1 A3:1 C4:1 D4:1 E4:1 G4:1 A4:1 C5:1 A4:1 G4:1 E4:1 D4:1 C4:1 A3:1 G3:1 E3:1 D3:1 C3:2',
  { id: 'scale-c', title: '五声音阶上下行', subtitle: 'C 宫调式 · 20 音 · 热身', bpm: 96 }
);

/** 大调三度跳进练习 */
const thirds = seq(
  'C4:1 E4:1 D4:1 F4:1 E4:1 G4:1 F4:1 A4:1 G4:1 B4:1 A4:1 C5:1 B4:1 G4:2 E4:1 C4:2',
  { id: 'thirds', title: '三度跳进', subtitle: 'C4–C5 · 音程准确度', bpm: 84 }
);

/** 长音持续练习（气息与稳定性） */
const longTone = seq(
  'G3:4 C4:4 E4:4 G4:4 E4:4 C4:4 G3:4 C4:6',
  { id: 'longtone', title: '长音稳定性', subtitle: '每个音 4 拍 · 看抖动', bpm: 72 }
);

/** 小星星（Twinkle Twinkle Little Star，公有领域） */
const twinkle = seq(
  'C4:1 C4:1 G4:1 G4:1 A4:1 A4:1 G4:2 F4:1 F4:1 E4:1 E4:1 D4:1 D4:1 C4:2 ' +
  'G4:1 G4:1 F4:1 F4:1 E4:1 E4:1 D4:2 G4:1 G4:1 F4:1 F4:1 E4:1 E4:1 D4:2 ' +
  'C4:1 C4:1 G4:1 G4:1 A4:1 A4:1 G4:2 F4:1 F4:1 E4:1 E4:1 D4:1 D4:1 C4:2',
  { id: 'twinkle', title: '小星星', subtitle: '公有领域 · 入门旋律', bpm: 100 }
);

/** 欢乐颂（Beethoven 第9交响曲主题，公有领域） */
const odeToJoy = seq(
  'E4:1 E4:1 F4:1 G4:1 G4:1 F4:1 E4:1 D4:1 C4:1 C4:1 D4:1 E4:1 E4:1.5 D4:0.5 D4:2 ' +
  'E4:1 E4:1 F4:1 G4:1 G4:1 F4:1 E4:1 D4:1 C4:1 C4:1 D4:1 E4:1 D4:1.5 C4:0.5 C4:2',
  { id: 'ode', title: '欢乐颂', subtitle: '公有领域 · 音阶邻近音', bpm: 96 }
);

/** 送别（李叔同词，旋律为公有领域美国民谣 Dreaming of Home and Mother） */
const farewell = seq(
  'G4:2 E4:2 G4:3 A4:1 G4:2 E4:2 G4:3 A4:1 ' +
  'G4:2 E4:2 D4:2 C4:2 D4:2 E4:2 G4:2 A4:2 ' +
  'G4:2 E4:2 D4:2 C4:2 D4:2 E4:2 C4:4',
  { id: 'farewell', title: '送别', subtitle: '公有领域 · 长句连音', bpm: 76 }
);

export const DEMO_TRACKS = [scaleC, thirds, longTone, twinkle, odeToJoy, farewell];

/* ───────────────── 合成播放 ───────────────── */

/**
 * 简易正弦 + 泛音合成器，用于播放参考旋律。
 */
export class ToneSynth {
  constructor(ctx, destination) {
    this.ctx = ctx;
    this.dest = destination || ctx.destination;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0.7;
    this.gain.connect(this.dest);
    this.nodes = [];
  }

  /** 播放一个音符（绝对时间轴） */
  note(midi, when, dur, opts = {}) {
    const ctx = this.ctx;
    const f = 440 * Math.pow(2, (midi - 69) / 12);
    const vol = (opts.velocity ?? 0.8) * 0.32;
    const harmonics = opts.piano ? [1, 0.5, 0.28, 0.16, 0.09, 0.05] : [1, 0.22, 0.08];
    const oscs = harmonics.map((amp, i) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f * (i + 1);
      if (f * (i + 1) > 18000) return null;
      const g = ctx.createGain();
      g.gain.value = 0;
      o.connect(g);
      g.connect(this.gain);
      return { o, g, amp };
    }).filter(Boolean);

    const attack = opts.attack ?? 0.012;
    const release = opts.release ?? 0.09;
    const end = when + dur + release;

    for (const { g, amp } of oscs) {
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(vol * amp, when + attack);
      g.gain.setValueAtTime(vol * amp, Math.max(when + attack, when + dur));
      g.gain.exponentialRampToValueAtTime(0.0001, end);
    }
    for (const { o } of oscs) {
      o.start(when);
      o.stop(end + 0.02);
    }
    this.nodes.push({ end, oscs });
    // 清理
    if (this.nodes.length > 200) {
      this.nodes = this.nodes.filter((n) => n.end > ctx.currentTime + 0.5);
    }
  }

  stopAll() {
    const now = this.ctx.currentTime;
    for (const { oscs } of this.nodes) {
      for (const { o, g } of oscs) {
        try {
          g.gain.cancelScheduledValues(now);
          g.gain.setTargetAtTime(0, now, 0.02);
          o.stop(now + 0.1);
        } catch { /* 已停止 */ }
      }
    }
    this.nodes = [];
  }
}

/** 把音符列表排程到合成器 */
export function scheduleNotes(synth, notes, t0, opts = {}) {
  const transpose = opts.transpose ?? 0;
  for (const n of notes) {
    synth.note(n.midi + transpose, t0 + n.start, n.end - n.start, {
      velocity: n.velocity ?? 0.75,
      piano: true,
    });
  }
}

/** 拍手/节拍器提示音 */
export function scheduleClick(ctx, dest, times, accent = true) {
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'square';
    o.frequency.value = i % 4 === 0 ? 1600 : 1100;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.055);
    o.connect(g); g.connect(dest || ctx.destination);
    o.start(t); o.stop(t + 0.07);
  }
}
