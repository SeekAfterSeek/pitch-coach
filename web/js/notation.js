/**
 * 调性推断 + 简谱生成（无 DOM，可在 Node 里单测）
 * ═══════════════════════════════════════════════════════════
 * 输入：参考人声解析出的音符序列 [{start,end,midi,label}]（来自 extractNotes）
 *
 * 1) detectKey   —— 用 Krumhansl–Schmuckler 音级轮廓相关法推断大/小调，
 *                    输出「C 大调 / A 小调 …」这样的 ABCDEFG 调名，
 *                    并给出首调简谱的调号（1=C 等）。
 * 2) notesToJianpu —— 把每个音符转成首调简谱：1 2 3 4 5 6 7 + 升降号 + 八度点 + 时值。
 * 3) groupPhrases  —— 按音符间的空档把旋律切成乐句，供歌词/简谱分行显示。
 */

import { clamp } from './util.js';

const PC_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Krumhansl–Schmuckler 调性轮廓（index 0 = 主音）
const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/** Pearson 相关系数 */
function pearson(a, b) {
  const n = a.length;
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb = sb / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/**
 * 调性推断
 * @param {Array<{start,end,midi}>} notes
 * @returns {{tonic:string, tonicPc:number, mode:'major'|'minor', name:string,
 *           jianpuKey:string, confidence:number, runnerUp:string}}
 */
export function detectKey(notes) {
  if (!notes || !notes.length) {
    return { tonic: 'C', tonicPc: 0, mode: 'major', name: 'C 大调',
      jianpuKey: '1=C', confidence: 0, runnerUp: '—' };
  }

  // 时长加权的音级直方图（pitch-class profile）
  const hist = new Array(12).fill(0);
  for (const n of notes) {
    const pc = ((Math.round(n.midi) % 12) + 12) % 12;
    const dur = Math.max(0.01, (n.end ?? n.start + 0.5) - n.start);
    hist[pc] += dur;
  }

  const scores = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    // 旋转直方图，让候选主音落在模板 index 0
    const rot = new Array(12);
    for (let i = 0; i < 12; i++) rot[i] = hist[(tonic + i) % 12];
    scores.push({ tonic, mode: 'major', r: pearson(rot, KS_MAJOR) });
    scores.push({ tonic, mode: 'minor', r: pearson(rot, KS_MINOR) });
  }
  scores.sort((a, b) => b.r - a.r);
  const best = scores[0], second = scores[1];

  // 大/小调相关非常接近时（关系大小调共享音级），轻微偏向大调，
  // 并用「最低 / 最长音是否落在候选主音」做一次纠偏。
  let chosen = best;
  if (Math.abs(best.r - second.r) < 0.03) {
    const preferMajor = scores.find((s) => s.mode === 'major' && Math.abs(s.r - best.r) < 0.03);
    if (preferMajor) chosen = preferMajor;
  }

  const tonic = PC_NAMES[chosen.tonic];
  const mode = chosen.mode;
  const name = `${tonic} ${mode === 'major' ? '大调' : '小调'}`;
  // 首调简谱调号：大调 1=主音；小调按关系大调记谱（1 = 小调主音 + 3 半音）
  const doPc = mode === 'major' ? chosen.tonic : (chosen.tonic + 3) % 12;
  const jianpuKey = `1=${PC_NAMES[doPc]}`;
  const runnerUp = `${PC_NAMES[second.tonic]} ${second.mode === 'major' ? '大调' : '小调'}`;

  return {
    tonic, tonicPc: chosen.tonic, mode, name, jianpuKey,
    doPc,
    confidence: clamp(best.r, 0, 1),
    margin: Math.max(0, best.r - second.r),
    runnerUp,
  };
}

// 相对「1(do)」的 12 个半音 → 纯数字唱名 + 直观的半音箭头
// 不用 b6 / #4 这类字母（用户看不懂），改用「数字 + ↑/↓」表示比该音高/低半音。
// 例：b6 → 6↓、#4 → 4↑、#1 → 1↑。八度高低仍用 ˙ / . 点表示。
const DEGREE = [
  { d: '1' }, { d: '1', nudge: '↑' }, { d: '2' }, { d: '3', nudge: '↓' },
  { d: '3' }, { d: '4' }, { d: '4', nudge: '↑' }, { d: '5' },
  { d: '6', nudge: '↓' }, { d: '6' }, { d: '7', nudge: '↓' }, { d: '7' },
];

// 1 2 3 4 5 6 7 各自相对 do 的半音数（用于求八度）
const DEGREE_SEMI = [0, 2, 4, 5, 7, 9, 11];

/** 统一的「任意 MIDI → 首调简谱」内核 */
function midiToJianpuCore(midi, doPc) {
  // 把 do 放在 C4=60 一带作为中八度基准
  const doMidi = 60 + doPc;
  const q = Math.round(midi);
  const rel = ((q - doPc) % 12 + 12) % 12;      // 相对 do 的半音级
  const deg = DEGREE[rel];
  const digit = deg.d;
  const nudge = deg.nudge || '';                 // ↑ / ↓ / ''
  const digitSemi = DEGREE_SEMI[Number(digit) - 1] ?? 0;
  // 变化音的半音跟着箭头修正
  const semi = digitSemi + (nudge === '↑' ? 1 : nudge === '↓' ? -1 : 0);
  const baseMidi = doMidi + semi;
  // 以「do 所在八度」为 0，用 ±6 半音容差判定八度点
  const octave = Math.floor((q - baseMidi + 6) / 12);
  const dots = octave > 0 ? '˙'.repeat(Math.min(3, octave))
    : octave < 0 ? '̣'.repeat(Math.min(3, -octave)) : '';
  return {
    digit, nudge, octave,
    // 纯数字 + 直观箭头 + 八度点，无字母
    symbol: digit + nudge + dots,
    dotted: dots,
    // 兼容旧字段
    accidental: '',
    midi,
  };
}

/** 一个简谱符号的可读中文说明（用于 tooltip） */
export function jianpuTitle(sym) {
  if (!sym) return '';
  const oct = sym.octave > 0 ? '高' + sym.octave + '个八度' : sym.octave < 0 ? '低' + (-sym.octave) + '个八度' : '中音区';
  const half = sym.nudge === '↑' ? '，偏高半音' : sym.nudge === '↓' ? '，偏低半音' : '';
  return `${sym.digit} ${oct}${half}`;
}

/**
 * 音符序列 → 简谱符号序列
 * @param {Array<{start,end,midi}>} notes
 * @param {object} key detectKey 的返回（用其中的 doPc）
 */
export function notesToJianpu(notes, key) {
  const doPc = key?.doPc ?? key?.tonicPc ?? 0;
  return (notes || []).map((n) => {
    const sym = midiToJianpuCore(n.midi, doPc);
    const dur = Math.max(0.01, (n.end ?? n.start + 0.5) - n.start);
    return { ...sym, dur, midi: n.midi, t: n.start };
  });
}

/**
 * 按音符间空档切成乐句
 * @param {Array<{start,end,midi}>} notes
 * @param {{gapSec?:number, maxPerLine?:number}} opts
 * @returns {Array<Array>} 每行一个音符数组
 */
export function groupPhrases(notes, opts = {}) {
  const gap = opts.gapSec ?? 0.45;
  const maxPerLine = opts.maxPerLine ?? 8;
  if (!notes?.length) return [];
  const lines = [];
  let cur = [notes[0]];
  for (let i = 1; i < notes.length; i++) {
    const prev = notes[i - 1], n = notes[i];
    const space = n.start - (prev.end ?? prev.start + 0.5);
    if (space > gap || cur.length >= maxPerLine) {
      lines.push(cur); cur = [n];
    } else cur.push(n);
  }
  if (cur.length) lines.push(cur);
  return lines;
}

/** 生成占位歌词：每音符一个「○」占位符，按乐句分行 */
export function placeholderLyrics(phrases) {
  return phrases.map((line) => '○'.repeat(line.length)).join('\n');
}

/* ── 节拍 ── */

const BEAT_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];
const BEAT_LABEL = {
  0.25: '¼拍', 0.5: '½拍', 0.75: '¾拍', 1: '1拍',
  1.5: '1½拍', 2: '2拍', 3: '3拍', 4: '4拍',
};

/** 时长 → 量化拍数 */
export function quantizeBeats(v) {
  let best = BEAT_STEPS[0];
  for (const s of BEAT_STEPS) if (Math.abs(s - v) < Math.abs(best - v)) best = s;
  return best;
}

export function beatLabel(b) {
  return BEAT_LABEL[b] || (b >= 4 ? '4拍' : `${b}拍`);
}

/**
 * 把「音符序列 + 调性 + 用户歌词」编译成逐字谱。
 *
 * 每个音符 = 一个「字位」：用户歌词按乐句逐行填入，一行字数与音符数对齐
 * （多了并进最后一格、少了补 ○）。每格带：
 *   - 歌词字
 *   - 首调简谱符号（1 2 3 5 …，含升降号与八度）
 *   - 节拍（¼ / ½ / 1 / 2 拍）
 *   - 起止时间（驱动练唱时的倒计时与逐字高亮）
 *
 * @param {Array<{start,end,midi}>} notes
 * @param {object} key detectKey 结果
 * @param {string} lyricText 用户编辑的歌词（按行对应乐句）
 * @param {{gapSec?, maxPerLine?, beatSec?}} opts
 */
export function buildScore(notes, key, lyricText, opts = {}) {
  if (!notes?.length) {
    return { key, bpm: 0, beatSec: 0.5, lines: [], noteCount: 0, unitCount: 0, duration: 0 };
  }

  const jp = notesToJianpu(notes, key);
  const durOf = (n) => Math.max(0.02, (n.end ?? n.start + 0.5) - n.start);
  const durs = notes.map(durOf).sort((a, b) => a - b);
  // 一拍 = 音符时长的中位数（从演唱速度反推），可外部指定
  const beatSec = opts.beatSec ?? durs[durs.length >> 1] ?? 0.5;
  const bpm = Math.round(60 / Math.max(0.1, beatSec));

  // 给每个音符标上全局序号，切句后仍能取回它对应的简谱符号
  const indexed = notes.map((n, gi) => ({ ...n, _gi: gi }));
  const groups = groupPhrases(indexed, {
    gapSec: opts.gapSec ?? 0.42,
    maxPerLine: opts.maxPerLine ?? 8,
  });
  const inputLines = String(lyricText || '').split(/\r?\n/);
  // charMap：按【音符全局顺序】给出的逐字歌词（realignLyricsToScore 的产物）。
  // 传了它就以它为准 —— 这样"哪个字对应哪个音符"是精确钉死的，
  // 而不是靠文本换行重新猜一遍。
  const charMap = Array.isArray(opts.charMap) && opts.charMap.length >= notes.length
    ? opts.charMap : null;

  const lines = groups.map((group, li) => {
    let assigned;
    if (charMap) {
      assigned = group.map((note) => charMap[note._gi] || '○');
    } else {
      const raw = (inputLines[li] || '').replace(/\s+/g, '');
      const chars = [...raw].filter((c) => !/^[\p{P}\p{S}]+$/u.test(c));
      const n = group.length;
      // 一字一音符对齐；多余并进最后一格，不足补占位
      assigned = [];
      for (let i = 0; i < n; i++) {
        if (i < chars.length - (n - 1) && i < n - 1) assigned.push(chars[i]);
        else if (i === n - 1) assigned.push(chars.slice(i).join('') || '○');
        else assigned.push(chars[i] ?? '○');
      }
    }

    const units = group.map((note, j) => {
      const d = durOf(note);
      const beats = quantizeBeats(d / beatSec);
      return {
        char: assigned[j],
        jianpu: jp[note._gi],            // 全局索引，不能用作曲内 j
        beatNum: beats,
        beat: beatLabel(beats),
        start: note.start,
        end: note.end ?? note.start + d,
        midi: note.midi,
        noteIdx: note._gi,
      };
    });

    const lineStart = group[0].start;
    const lineEnd = Math.max(...group.map((x) => x.end ?? x.start + 0.5));
    return {
      index: li,
      phraseNo: li + 1,          // 第几句（练唱时"第 N 句开始"提示用）
      phraseStart: lineStart,    // 这句的开始时刻（倒计时 3-2-1 的锚点）
      start: lineStart,
      end: lineEnd,
      units,
    };
  });

  return {
    key,
    bpm,
    beatSec,
    jianpuKey: key?.jianpuKey || '1=C',
    lines,
    noteCount: notes.length,
    unitCount: lines.reduce((s, l) => s + l.units.length, 0),
    duration: Math.max(...notes.map((x) => x.end ?? x.start + 0.5)),
    charMap: charMap ? charMap.slice() : null,
  };
}

/** 从一份已编译的 score 里取出「按音符全局顺序」的逐字歌词，
 *  供编辑器把"每个字对应哪个音符"逐格摊开。 */
export function scoreCharMap(score) {
  return flattenScore(score).map((u) => u.char || '○');
}

/** 简谱符号的 HTML 片段（八度点画在数字上/下方，半音用 ↑↓ 角标） */
export function jianpuHtml(sym) {
  const up = sym.octave > 0 ? `<sup class="jp-dots">${'˙'.repeat(Math.min(3, sym.octave))}</sup>` : '';
  const down = sym.octave < 0 ? `<sub class="jp-dots">${'.'.repeat(Math.min(3, -sym.octave))}</sub>` : '';
  const nudge = sym.nudge ? `<span class="jp-nudge">${sym.nudge}</span>` : '';
  return `${sym.digit}${nudge}${up}${down}`;
}

/**
 * 任意 MIDI → 首调简谱符号（把"我实际唱的音"翻成简谱）
 * 与 notesToJianpu 同一套口径（doPc 一致），可直接上下两排比对。
 */
export function midiToJianpu(midi, key) {
  return midiToJianpuCore(midi, key?.doPc ?? key?.tonicPc ?? 0);
}

/** 把 buildScore 的多行谱展平成一维字位数组（带全局 index / 行号） */
export function flattenScore(score) {
  const out = [];
  let i = 0;
  for (const line of score.lines || []) {
    for (const u of line.units) {
      out.push({ ...u, index: i, lineIndex: line.index, lineStart: line.start, lineEnd: line.end });
      i++;
    }
  }
  return out;
}

export { PC_NAMES };
