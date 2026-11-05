/**
 * PitchCoach 主应用
 *
 * 时间轴约定
 * ─────────────
 * songT  = 歌曲内时间（秒）。参考旋律、你的录音轨迹、评分全部用这条轴。
 * ctxT   = AudioContext.currentTime
 * 两种播放源：
 *   合成器模式（内置曲目）：songT = ctxT - anchor.t0
 *   音频模式（导入歌曲）：songT = anchor.song + (ctxT - anchor.ctx)
 * 麦克风帧带的是 ctxT，统一换算到 songT 之后再比对。
 */

import { AudioEngine, TakeRecorder, decodeFile, analyzeBuffer, cleanFrames, bufferToWav, estimateOffset } from './audio.js';
import { PitchDetector } from './pitch.js';
import {
  Reference, referenceFromFrames, referenceFromNotes, parseMidi,
  scoreTake, SCORE_MODES, extractNotes,
} from './reference.js';
import { DEMO_TRACKS, ToneSynth, scheduleNotes, nameToMidi } from './demo.js';
import { PianoRoll } from './pianoroll.js';
import { CentsGauge } from './gauge.js';
import {
  hzToMidi, midiToName, midiToHz, clamp, fmtCents, fmtTime, median,
  quantile, sampleAt, uid, rafThrottle,
} from './util.js';
import {
  loadSettings, saveSettings, loadTracks, addTrack, removeTrack,
  saveTake, listTakes, getTake, getTakeAudio, deleteTake, clearAll,
  downloadJSON, downloadBlob, DEFAULT_SETTINGS,
} from './store.js';

/* ══════════════════════ 状态 ══════════════════════ */

const S = {
  view: 'live',
  settings: loadSettings(),
  engine: new AudioEngine(),
  synth: null,
  recorder: null,

  // 当前曲目
  track: null,          // {id, title, subtitle, notes?, duration, kind:'builtin'|'custom'}
  ref: null,            // Reference

  // 播放
  playing: false,
  clock: null,          // () => songT
  audioEl: null,
  playingStart: 0,

  // 实时
  liveFrames: [],       // {t(songT), midi, voiced, band, cents}
  sessionScores: [],    // 本次练唱每帧 score
  histBins: new Array(24).fill(0),
  windowSec: 6,

  // 复盘
  takes: [],
  selectedTake: null,
  selectedTakeFrames: null,

  micOn: false,
  recording: false,
  recStartSongT: 0,
  recFrames: [],

  customTracks: [],
  pendingImport: null,
};

/* ══════════════════════ DOM ══════════════════════ */

const $ = (id) => document.getElementById(id);
const el = {
  statusDot: $('statusDot'),
  statusText: $('statusText'),
  tabs: $('tabs'),
  trackTitle: $('trackTitle'),
  trackSub: $('trackSub'),
  liveScore: $('liveScore'),
  liveAccuracy: $('liveAccuracy'),
  liveRange: $('liveRange'),
  histBars: $('histBars'),
  btnPlay: $('btnPlay'),
  btnRec: $('btnRec'),
  btnStop: $('btnStop'),
  btnMic: $('btnMic'),
  micMeter: $('micMeter'),
  latencySlider: $('latencySlider'),
  latencyVal: $('latencyVal'),
  btnAutoLatency: $('btnAutoLatency'),
  roll: $('roll'),
  gauge: $('gauge'),
  rollHint: $('rollHint'),
  rollTimecode: $('rollTimecode'),
  coachBar: $('coachBar'),
  coachText: $('coachText'),
  trackStrip: $('trackStrip'),
  cbReference: $('cbReference'),
  transposeVal: $('transposeVal'),
  takeList: $('takeList'),
  takeCount: $('takeCount'),
  takeFilter: $('takeFilter'),
  reviewTitle: $('reviewTitle'),
  reviewSub: $('reviewSub'),
  rsTotal: $('rsTotal'),
  rsAcc: $('rsAcc'),
  rsCover: $('rsCover'),
  rsDev: $('rsDev'),
  rsStab: $('rsStab'),
  rsOct: $('rsOct'),
  reviewRoll: $('reviewRoll'),
  phraseGrid: $('phraseGrid'),
  coachNotes: $('coachNotes'),
  btnPlayTake: $('btnPlayTake'),
  btnRescore: $('btnRescore'),
  btnExportJSON: $('btnExportJSON'),
  btnExportWav: $('btnExportWav'),
  btnClearTakes: $('btnClearTakes'),
  builtinList: $('builtinList'),
  customList: $('customList'),
  dropZone: $('dropZone'),
  fileInput: $('fileInput'),
  importTitle: $('importTitle'),
  importMode: $('importMode'),
  importRange: $('importRange'),
  importSnap: $('importSnap'),
  importProgress: $('importProgress'),
  importBar: $('importBar'),
  importStatus: $('importStatus'),
  drawerMask: $('drawerMask'),
  settingsDrawer: $('settingsDrawer'),
  helpMask: $('helpMask'),
  toastWrap: $('toastWrap'),

  // 设置面板控件
  setTolerance: $('setTolerance'),
  setToleranceVal: $('setToleranceVal'),
  setConfidence: $('setConfidence'),
  setConfidenceVal: $('setConfidenceVal'),
  setRefVol: $('setRefVol'),
  setRefVolVal: $('setRefVolVal'),
  setLatency: $('setLatency'),
  setLatencyVal: $('setLatencyVal'),
};

const roll = new PianoRoll(el.roll);
const gauge = new CentsGauge(el.gauge);
const reviewRoll = new PianoRoll(el.reviewRoll);

/* ══════════════════════ 工具 ══════════════════════ */

function toast(msg, type = '', ms = 2600) {
  const d = document.createElement('div');
  d.className = 'toast ' + type;
  d.textContent = msg;
  el.toastWrap.appendChild(d);
  setTimeout(() => {
    d.classList.add('out');
    setTimeout(() => d.remove(), 240);
  }, ms);
}

function bandOf(devCents) {
  const tol = S.settings.tolerance;
  const a = Math.abs(devCents);
  if (a <= tol * 0.25) return 'perfect';
  if (a <= tol * 0.5) return 'great';
  if (a <= tol) return 'ok';
  if (a <= tol * 2) return 'sharp';
  return 'off';
}

/**
 * 提示遮罩只在"真的没什么可看"时出现：
 * 没开麦克风、没在播放、也没有可展示的轨迹。
 * 否则会挡住卷帘里刚画出来的内容。
 */
function updateHint() {
  const hasSomethingToShow = S.micOn || S.playing || (S.liveFrames && S.liveFrames.length > 0);
  el.rollHint.classList.toggle('hidden', hasSomethingToShow);
}

function scoreColor(v) {
  if (v >= 85) return 's-high';
  if (v >= 70) return 's-mid';
  if (v >= 50) return 's-low';
  return 's-bad';
}

/* ══════════════════════ 曲目管理 ══════════════════════ */

function allTracks() {
  return [...DEMO_TRACKS.map((t) => ({ ...t, kind: 'builtin' })), ...S.customTracks];
}

function selectTrack(id) {
  const t = allTracks().find((x) => x.id === id);
  if (!t) return;
  stopPlayback();

  S.track = t;
  el.trackTitle.textContent = t.title;
  el.trackSub.textContent = t.subtitle || (t.kind === 'builtin' ? '内置练习' : '自选曲目');

  // 构建参考
  if (t.kind === 'builtin') {
    S.ref = referenceFromNotes(t.notes, t.duration, { title: t.title, source: 'builtin' });
  } else if (t.refData) {
    S.ref = restoreReference(t);
  } else {
    S.ref = null;
  }

  roll.setReference(S.ref);
  applyTransposeToView();
  S.liveFrames = [];
  roll.liveHistory = [];
  S.histBins.fill(0);
  renderHistogram();
  updateRangeLabel();

  el.rollHint.classList.toggle('hidden', !!S.ref && S.micOn || !!S.liveFrames?.length);
  el.btnPlay.disabled = !t;
  el.btnPlay.querySelector('.ico').textContent = '▶';
  el.btnPlay.lastChild.textContent = ' 播放参考';

  renderTrackStrip();
  renderBuiltinList();
  renderCustomList();
  roll.draw();
  resetLiveStats();
}

function applyTransposeToView() {
  if (!S.ref) return;
  const tr = S.settings.transpose;
  el.transposeVal.textContent = tr === 0 ? '原调' : (tr > 0 ? '+' : '') + tr + ' 半音';
  const lo = Math.max(24, Math.floor(S.ref.range.low) - 3 + tr);
  const hi = Math.min(100, Math.ceil(S.ref.range.high) + 3 + tr);
  roll.range = { lo, hi };
  reviewRoll.range = { lo, hi };
}

function refMidiAt(songT) {
  if (!S.ref) return null;
  const m = S.ref.at(songT);
  return m == null ? null : m + S.settings.transpose;
}

function updateRangeLabel() {
  if (!S.ref) { el.liveRange.textContent = '—'; return; }
  const tr = S.settings.transpose;
  el.liveRange.textContent = midiToName(S.ref.range.low + tr) + '–' + midiToName(S.ref.range.high + tr);
}

/* ══════════════════════ 播放 ══════════════════════ */

async function ensureSynth() {
  const ctx = await S.engine.ensureContext();
  if (!S.synth) {
    S.synth = new ToneSynth(ctx, ctx.destination);
    S.synth.gain.gain.value = S.settings.referenceVolume;
  }
  return S.synth;
}

async function play() {
  if (!S.track) { toast('先选一首曲目', 'err'); return; }
  if (S.playing) { stopPlayback(); return; }

  await S.engine.ensureContext();
  if (S.engine.ctx.state === 'suspended') await S.engine.ctx.resume();
  const ctx = S.engine.ctx;

  S.playing = true;
  el.btnPlay.querySelector('.ico').textContent = '■';
  el.btnPlay.lastChild.textContent = ' 停止';
  el.btnStop.disabled = false;
  el.rollHint.classList.add('hidden');

  S.liveFrames = [];
  roll.liveHistory = [];
  S.sessionScores = [];
  S.histBins.fill(0);
  renderHistogram();

  if (S.track.kind === 'builtin' || !S.track.audioBlob) {
    // —— 合成器模式 ——
    const synth = await ensureSynth();
    synth.stopAll();
    synth.gain.gain.value = S.settings.referenceVolume;
    const t0 = ctx.currentTime + 0.25;
    const tr = S.settings.transpose;
    scheduleNotes(synth, S.track.notes, t0, { transpose: tr });
    S.clock = () => ctx.currentTime - t0;
    S.playStartT = 0;
  } else {
    // —— 音频模式 ——
    if (!S.audioEl) {
      S.audioEl = new Audio();
      S.audioEl.preload = 'auto';
    }
    if (!S.audioEl.src || S.audioEl.dataset.trackId !== S.track.id) {
      const url = URL.createObjectURL(S.track.audioBlob);
      S.audioEl.src = url;
      S.audioEl.dataset.trackId = S.track.id;
    }
    S.audioEl.currentTime = 0;
    S.audioEl.volume = S.settings.referenceVolume;
    await S.audioEl.play().catch(() => {});
    const anchor = { ctx: ctx.currentTime, song: S.audioEl.currentTime };
    S.clock = () => anchor.song + (ctx.currentTime - anchor.ctx);
    S.playStartT = 0;
  }

  const dur = S.ref?.duration || S.track.duration || 30;
  S.playEndTimer = setTimeout(() => stopPlayback(true), (dur + 1.2) * 1000);

  toast('开始 · ' + S.track.title, 'ok', 1600);
}

function stopPlayback(natural = false) {
  if (!S.playing) return;
  S.playing = false;
  if (S.synth) S.synth.stopAll();
  if (S.audioEl) { try { S.audioEl.pause(); } catch { /* noop */ } }
  clearTimeout(S.playEndTimer);
  el.btnPlay.querySelector('.ico').textContent = '▶';
  el.btnPlay.lastChild.textContent = ' 播放参考';
  el.btnStop.disabled = !S.recording;
  S.clock = null;

  if (S.recording) {
    if (natural) stopRecording();
    // 用户主动停歌时保留录音状态，让他自己点停止
  }
  updateHint();
}

/* ══════════════════════ 麦克风 ══════════════════════ */

async function enableMic() {
  try {
    await S.engine.startMic();
    S.micOn = true;
    el.btnMic.textContent = '麦克风已开';
    el.btnMic.classList.add('primary');
    el.statusDot.classList.add('on');
    el.statusText.textContent = '麦克风已连接';
    el.rollHint.classList.add('hidden');
    toast('麦克风已开启 · 戴耳机效果更好', 'ok');
    if (S.settings.autoCalibrate) calibrateLatency();

    // 让音频图保持 active
    S.engine.ctx.resume().catch(() => {});
  } catch (err) {
    const msg = err?.name === 'NotAllowedError'
      ? '麦克风权限被拒绝，请在地址栏左侧的图标里允许'
      : err?.name === 'NotFoundError'
        ? '没找到麦克风设备'
        : '麦克风开启失败：' + (err?.message || err);
    toast(msg, 'err', 5000);
  }
}

function calibrateLatency() {
  const d = S.engine.deviceLatency;
  const ms = Math.round(d * 1000);
  S.settings.latencyMs = clamp(ms, -300, 300);
  el.latencySlider.value = S.settings.latencyMs;
  el.latencyVal.textContent = S.settings.latencyMs + ' ms';
  saveSettings(S.settings);
}

/* ══════════════════════ 录音 ══════════════════════ */

async function startRecording() {
  if (!S.micOn) { await enableMic(); if (!S.micOn) return; }
  if (!S.recorder) S.recorder = new TakeRecorder(S.engine);
  try {
    S.recorder.start();
  } catch (e) {
    toast('无法开始录音：' + e.message, 'err');
    return;
  }
  S.recording = true;
  S.recFrames = [];
  // 录音时间基准：有播放时跟歌曲时间轴走；自由练习时用真实流逝时间。
  // 这样不播参考也能录下来并存档。
  S.recOrigin = {
    wall: performance.now(),
    songT: S.clock ? Math.max(0, S.clock()) : 0,
  };
  S.recStartSongT = S.recOrigin.songT;
  el.btnRec.classList.add('on');
  el.btnRec.innerHTML = '<span class="ico">⏹</span> 停止录音';
  el.btnStop.disabled = false;
  el.statusDot.classList.remove('on');
  el.statusDot.classList.add('rec');
  el.statusText.textContent = '录音中…';
  S.liveFrames = [];
  S.sessionScores = [];
  S.histBins.fill(0);
  renderHistogram();
  toast('开始录音', 'ok', 1400);
}

async function stopRecording() {
  if (!S.recording) return;
  S.recording = false;         // 先置位，避免重入
  const framesBefore = S.recFrames.slice();

  let result = null;
  try {
    result = await S.recorder.stop();
  } catch (e) {
    toast('录音结束异常：' + e.message, 'err');
  }

  el.btnRec.classList.remove('on');
  el.btnRec.innerHTML = '<span class="ico">⏺</span> 开始录音';
  el.btnStop.disabled = !S.playing;
  el.statusDot.classList.remove('rec');
  if (S.micOn) el.statusDot.classList.add('on');
  el.statusText.textContent = S.micOn ? '麦克风已连接' : '未连接麦克风';

  // 拿我们自己累积的帧（带 songT），MediaRecorder 的帧没有对齐信息
  const frames = framesBefore.length ? framesBefore : (result?.frames || []);
  if (!frames.length) {
    toast('这段没录到声音', 'err');
    return;
  }

  await saveCurrentTake(result || { blob: null, duration: 0 }, frames);
}

async function saveCurrentTake(result, frames) {
  const trackId = S.track?.id || null;
  const trackTitle = S.track?.title || '自由练唱';
  let score = null;
  let offset = 0;

  if (S.ref && trackId) {
    // 先把帧裁到参考时间轴内，再做自动对齐。
    // 歌手开口晚一拍是常态，不对齐的话分数会完全失真。
    const framesForScore = frames.map((f) => ({
      t: clamp(f.t, 0, S.ref.duration),
      midi: f.midi,
      voiced: f.voiced,
      rms: f.rms,
      confidence: f.confidence,
    }));

    const mode = SCORE_MODES[S.settings.scoreMode] || SCORE_MODES.exact;

    // 自动对齐：先用 0 偏移算一次，若质量差再搜索最佳偏移。
    // 只有"对齐确实让分数明显变好"且"匹配唯一"时才采用，
    // 否则保持原样——避免把唱错的内容硬凑成对齐。
    const raw = scoreTake(S.ref, framesForScore, { mode });
    if (raw.total < 70 && framesForScore.length > 100) {
      const est = estimateOffset(S.ref, framesForScore, { maxLagSec: 4, stepSec: 0.05 });
      if (est.overlap > 60 && est.ambiguity > 0.12 && Math.abs(est.offset) > 0.1) {
        const shifted = scoreTake(S.ref, framesForScore, { mode, startTime: est.offset });
        if (shifted.total > raw.total + 8) {
          offset = est.offset;
          score = shifted;
        }
      }
    }
    if (!score) score = raw;
  }

  const take = {
    id: uid('take'),
    trackId,
    trackTitle,
    label: new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
    createdAt: Date.now(),
    offset,
    // 时长优先用录音帧的跨度（真实唱了多久），而不是 MediaRecorder 的长度
    duration: frames.length > 1 ? Math.max(0, frames[frames.length - 1].t - frames[0].t) : (result.duration || 0),
    frames: frames.map((f) => ({ t: f.t, midi: f.midi, voiced: f.voiced, rms: f.rms })),
    score: score ? {
      total: score.total,
      pitchAccuracy: score.pitchAccuracy,
      coverage: score.coverage,
      meanAbsCents: score.meanAbsCents,
      stdev: score.stdev,
      counts: score.counts,
      phraseScores: score.phraseScores,
      worst: score.worst,
      octaveFixed: score.octaveFixed,
    } : null,
    mode: S.settings.scoreMode,
    transpose: S.settings.transpose,
  };

  await saveTake(take, result.blob);
  await refreshTakes();

  if (score) {
    toast(`录音已保存 · ${Math.round(score.total)} 分`, 'ok', 3200);
  } else {
    toast('录音已保存', 'ok');
  }

  // 自动跳到复盘
  if (S.ref) {
    await selectTake(take.id);
    switchView('review');
  }
}

/* ══════════════════════ 实时循环 ══════════════════════ */

let lastFrameTime = 0;

/**
 * 采样循环（与渲染分离）
 *
 * 关键：录音采样不能依赖 requestAnimationFrame。
 * 浏览器会把后台/失焦标签页的 rAF 节流到 1fps，那样录音会丢 95% 的帧，
 * 分数完全不可用。所以：
 *   · 采样走 setInterval（后台仍然按约 4ms 触发，只是被 clamp 到 ≥1000ms 才知道）
 *   · 实际上用 AudioWorklet 最稳，但这里用"多补几帧"的折中方案：
 *     每次 tick 若发现距上次时间过长，就按 hop 补采若干帧（音频是连续的，
 *     AnalyserNode 只能取当前瞬间，所以补采只能近似为"保持上一个音高"）
 */
let sampleTimer = null;
let lastSampleWall = 0;

function startSampling() {
  if (sampleTimer) return;
  lastSampleWall = performance.now();
  // 4ms 是浏览器定时器最小粒度；实际会被 clamp 到 ~4-16ms
  sampleTimer = setInterval(sampleOnce, 4);
}

function stopSampling() {
  if (sampleTimer) clearInterval(sampleTimer);
  sampleTimer = null;
}

function loop() {
  requestAnimationFrame(loop);
  if (!S.micOn) return;

  // 渲染循环只负责画（rAF 被节流时画面卡住但数据不断）
  const now = performance.now();
  if (now - lastFrameTime > 33) {
    lastFrameTime = now;
    gauge.step();
    roll.draw();
    gauge.draw();
    renderHistogram();
  }
}

/** 单次采样 + 状态更新（由 setInterval 驱动） */
function sampleOnce() {
  if (!S.micOn) return;

  const wallNow = performance.now();
  const gap = wallNow - lastSampleWall;
  lastSampleWall = wallNow;

  const frame = S.engine.tick();
  if (!frame) return;

  // 如果定时器被浏览器节流（后台标签页），实时间隔会被拉长。
  // 录音时按真实间隔补足帧数，避免"唱了 10 秒只录到 1 秒"。
  // 补的帧沿用当前音高——这是近似，但远好于时间轴出现大洞。
  if (S.recording && gap > 60 && S.recFrames.length) {
    const last = S.recFrames[S.recFrames.length - 1];
    const step = 0.01;
    const missing = Math.min(2000, Math.floor((gap / 1000) / step) - 1);
    for (let i = 1; i <= missing; i++) {
      S.recFrames.push({
        t: last.t + i * step,
        midi: last.midi,
        voiced: last.voiced,
        rms: last.rms * 0.98,
        confidence: last.confidence,
        filled: true,
      });
    }
  }

  // 电平表
  el.micMeter.style.width = Math.min(100, frame.rms * 340) + '%';

  const songT = S.clock ? S.clock() : null;
  const tr = S.settings.transpose;
  const latency = S.settings.latencyMs / 1000;

  let refMidi = null;
  let dev = null;
  let band = null;

  if (frame.voiced && songT != null) {
    // —— 跟唱模式：与参考旋律比 ——
    const st = songT - latency;
    refMidi = refMidiAt(st);
    if (refMidi != null) {
      dev = (frame.midi - refMidi) * 100;
      if (Math.abs(Math.abs(dev) - 1200) < 200) {
        const k = Math.round(dev / 1200);
        dev -= k * 1200;
      }
      band = bandOf(dev);
    } else {
      band = 'extra';
    }
  } else if (frame.voiced && frame.midi > 0) {
    // —— 空闲模式：当调音器用，显示相对最近半音的偏差 ——
    const nearest = Math.round(frame.midi);
    refMidi = nearest;
    dev = (frame.midi - nearest) * 100;
    band = bandOf(dev);
  }

  // 更新表盘
  const yourName = frame.voiced && frame.midi > 0 ? midiToName(frame.midi) : '--';
  const refName = refMidi != null ? midiToName(refMidi) : '--';
  gauge.set(dev == null ? 0 : dev, dev != null && Number.isFinite(dev), yourName, refName);

  // 增量统计：只有"跟唱参考"时才计入得分，
  // 空闲调音模式的数据不污染实时得分。
  const counting = S.clock != null;
  // 录音帧时间：跟唱用歌曲时间轴；自由练习用真实流逝时间（从录音开始算）
  const recT = songT != null
    ? songT - latency
    : (performance.now() - (S.recOrigin?.wall ?? performance.now())) / 1000;

  if (dev != null && Number.isFinite(dev) && counting) {
    S.sessionScores.push(dev);
    if (S.sessionScores.length > 20000) S.sessionScores.splice(0, 8000);
    const bin = clamp(Math.floor((dev + 100) / (200 / 24)), 0, 23);
    S.histBins[bin]++;
    if (S.recording) {
      S.recFrames.push({ t: recT, midi: frame.midi, voiced: true, rms: frame.rms, confidence: frame.confidence });
    }
  } else if (S.recording) {
    // 录音期间一律记帧（包括无声），保证时间轴连续
    S.recFrames.push({ t: recT, midi: 0, voiced: false, rms: frame.rms, confidence: frame.confidence });
  }

  // 实时轨迹
  if (songT != null) {
    const rec = {
      t: songT - latency,
      midi: frame.voiced ? frame.midi : 0,
      voiced: frame.voiced,
      band,
    };
    roll.live = rec;
    roll.liveHistory = roll.liveHistory || [];
    roll.liveHistory.push(rec);
    const cutoff = (songT - latency) - 20;
    while (roll.liveHistory.length && roll.liveHistory[0].t < cutoff) roll.liveHistory.shift();

    roll.followCursor(songT - latency, S.windowSec);
    roll.cursorT = songT - latency;
    el.rollTimecode.textContent = fmtTime(Math.max(0, songT));
  } else {
    // 没在播放：自由练唱 / 当调音器，轨迹按真实时间滚
    const t = performance.now() / 1000;
    roll.live = { t, midi: frame.voiced ? frame.midi : 0, voiced: frame.voiced, band };
    roll.liveHistory = roll.liveHistory || [];
    roll.liveHistory.push(roll.live);
    while (roll.liveHistory.length && roll.liveHistory[0].t < t - 20) roll.liveHistory.shift();
    roll.followCursor(t, S.windowSec);
    roll.cursorT = t;
    el.rollTimecode.textContent = '自由练习';
  }

  gauge.step();
  updateLiveStats();
  updateCoach(dev, band, refMidi);
}

function resetLiveStats() {
  S.sessionScores = [];
  S.histBins.fill(0);
  el.liveScore.textContent = '—';
  el.liveAccuracy.textContent = '—';
  el.histBars.innerHTML = '';
}

function updateLiveStats() {
  if (!S.sessionScores.length) {
    // 没在跟唱时（纯麦克风打开 / 自由练习），不显示"—"让人以为坏了，
    // 而是明确告诉用户现在是"调音模式"。
    if (S.micOn && !S.playing) {
      el.liveScore.textContent = '调音';
      el.liveScore.style.color = 'var(--cyan)';
      el.liveAccuracy.textContent = '—';
    } else {
      el.liveScore.textContent = '—';
      el.liveScore.style.color = '';
      el.liveAccuracy.textContent = '—';
    }
    return;
  }
  const tol = S.settings.tolerance;
  const inTol = S.sessionScores.filter((d) => Math.abs(d) <= tol).length;
  const acc = inTol / S.sessionScores.length;
  const quality = S.sessionScores.reduce(
    (a, d) => a + Math.exp(-0.5 * (d / (tol * 0.6)) ** 2), 0
  ) / S.sessionScores.length;
  // 与离线评分同口径：帧质量为主，准音率辅助（实时没有覆盖度概念）
  const score = Math.round((quality * 0.7 + acc * 0.3) * 100);

  el.liveScore.textContent = score;
  el.liveScore.style.color = score >= 85 ? 'var(--green)' : score >= 70 ? 'var(--yellow)' : score >= 50 ? 'var(--orange)' : 'var(--red)';
  el.liveAccuracy.textContent = Math.round(acc * 100) + '%';
}

function renderHistogram() {
  const total = S.histBins.reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...S.histBins);
  if (el.histBars.children.length !== 24) {
    el.histBars.innerHTML = '';
    for (let i = 0; i < 24; i++) {
      const b = document.createElement('div');
      b.className = 'hist-bar';
      el.histBars.appendChild(b);
    }
  }
  for (let i = 0; i < 24; i++) {
    const bar = el.histBars.children[i];
    const h = S.histBins[i] / max;
    bar.style.height = Math.max(2, h * 100) + '%';
    const center = (i + 0.5) / 24 * 200 - 100;
    const a = Math.abs(center);
    bar.style.background = total === 0 ? 'rgba(120,150,190,0.16)'
      : a <= 25 ? 'var(--green)' : a <= 50 ? 'var(--yellow)' : a <= 100 ? 'var(--orange)' : 'var(--red)';
    bar.style.opacity = S.histBins[i] === 0 ? 0.25 : 1;
  }
}

let coachTimer = 0;
let lastCoach = '';

function updateCoach(dev, band, refMidi) {
  const now = performance.now();
  if (now - coachTimer < 220) return;
  coachTimer = now;

  let text = '', cls = '';
  if (dev == null) {
    if (!S.playing) {
      text = '开启麦克风后，这里会实时提示你「偏高 / 偏低 / 刚好」';
    } else if (refMidi == null) {
      text = '这一拍参考里没有音，可以换气';
    } else {
      text = '听参考音，跟着唱';
    }
  } else if (band === 'perfect' || band === 'great') {
    text = `很准 · ${fmtCents(dev)}`;
    cls = 'good';
  } else if (band === 'ok') {
    text = `可以再稳一点 · ${dev > 0 ? '偏高' : '偏低'} ${Math.abs(Math.round(dev))} 音分`;
    cls = 'warn';
  } else if (band === 'sharp') {
    text = `明显${dev > 0 ? '偏高' : '偏低'} ${Math.abs(Math.round(dev))} 音分 · ${dev > 0 ? '试着放松一点往下压' : '气息托住往上抬'}`;
    cls = 'warn';
  } else {
    text = `跑调了 · ${dev > 0 ? '高了' : '低了'} ${Math.abs(Math.round(dev))} 音分（约 ${(Math.abs(dev) / 100).toFixed(1)} 个半音）`;
    cls = 'bad';
  }

  if (text !== lastCoach) {
    el.coachText.textContent = text;
    el.coachBar.className = 'coach-bar ' + cls;
    lastCoach = text;
  }
}

/* ══════════════════════ 复盘 ══════════════════════ */

async function refreshTakes() {
  S.takes = await listTakes();
  renderTakeList();
  renderTakeFilter();
}

function renderTakeFilter() {
  const tracks = new Map();
  for (const t of S.takes) {
    if (t.trackId) tracks.set(t.trackId, t.trackTitle);
  }
  const cur = el.takeFilter.value;
  el.takeFilter.innerHTML = '<option value="">全部曲目</option>';
  for (const [id, title] of tracks) {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = title;
    el.takeFilter.appendChild(o);
  }
  el.takeFilter.value = cur;
}

function renderTakeList() {
  const filter = el.takeFilter.value;
  let list = S.takes;
  if (filter) list = list.filter((t) => t.trackId === filter);

  // 分组内按分数排序，找出最优
  const scored = list.filter((t) => t.score);
  const bestId = scored.length
    ? scored.reduce((a, b) => (b.score.total > a.score.total ? b : a)).id
    : null;

  el.takeCount.textContent = list.length;

  if (!list.length) {
    el.takeList.innerHTML = '<div class="empty">还没有录音。回到「实时练唱」录一条。</div>';
    return;
  }

  // 显示顺序：有分的按分数降序，无分的排后面
  const sorted = [...list].sort((a, b) => {
    const sa = a.score?.total ?? -1;
    const sb = b.score?.total ?? -1;
    if (sb !== sa) return sb - sa;
    return b.createdAt - a.createdAt;
  });

  el.takeList.innerHTML = '';
  for (const t of sorted) {
    const d = document.createElement('div');
    d.className = 'take-item' + (S.selectedTake === t.id ? ' active' : '');
    d.dataset.id = t.id;

    const s = t.score ? Math.round(t.score.total) : null;
    const scoreHtml = s != null
      ? `<div class="take-score ${scoreColor(s)}">${s}</div>`
      : `<div class="take-score" style="color:var(--text-3);font-size:13px">—</div>`;

    const badge = t.id === bestId ? '<span class="take-badge best">最准</span>'
      : (s != null && s < 60 ? '<span class="take-badge">待练</span>' : '');

    d.innerHTML = `
      ${scoreHtml}
      <div class="take-info">
        <b>${escapeHtml(t.trackTitle)}</b>
        <small>${escapeHtml(t.label)} · ${fmtTime(t.duration)}${t.score ? ` · 准音 ${Math.round(t.score.pitchAccuracy * 100)}%` : ''}</small>
      </div>
      ${badge}
      <button class="take-del" title="删除">✕</button>
    `;
    d.addEventListener('click', (e) => {
      if (e.target.classList.contains('take-del')) return;
      selectTake(t.id);
    });
    d.querySelector('.take-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteTake(t.id);
      if (S.selectedTake === t.id) clearReview();
      await refreshTakes();
      toast('已删除', '', 1400);
    });
    el.takeList.appendChild(d);
  }
}

let reviewTakeObj = null;

async function selectTake(id) {
  const full = await getTake(id);
  if (!full) return;
  S.selectedTake = id;
  S.selectedTakeFrames = full.frames;
  reviewTakeObj = full;

  renderTakeList();

  el.reviewTitle.textContent = full.trackTitle;
  el.reviewSub.textContent = `${full.label} · ${fmtTime(full.duration)}` +
    (full.transpose ? ` · ${full.transpose > 0 ? '+' : ''}${full.transpose} 半音` : '');

  // 参考轨道：优先用当前选中的同 id 曲目，否则临时构建
  let ref = S.ref;
  if (!ref || S.track?.id !== full.trackId) {
    const t = allTracks().find((x) => x.id === full.trackId);
    if (t?.kind === 'builtin') {
      ref = referenceFromNotes(t.notes, t.duration, { title: t.title });
    } else if (t?.refData) {
      ref = restoreReference(t);
    } else {
      ref = null;
    }
  }

  // 重新打分（用当前设置）
  let score = null;
  let framesWithBand = full.frames;
  if (ref) {
    const sc = scoreTake(ref, full.frames, { mode: SCORE_MODES[S.settings.scoreMode] || SCORE_MODES.exact });
    score = sc;
    framesWithBand = full.frames.map((f, i) => ({
      ...f,
      band: sc.bands[i] || null,
    }));
  }

  reviewRoll.setReference(ref);
  if (ref) {
    const tr = full.transpose ?? 0;
    reviewRoll.range = {
      lo: Math.max(24, Math.floor(ref.range.low) - 3 + tr),
      hi: Math.min(100, Math.ceil(ref.range.high) + 3 + tr),
    };
  }
  reviewRoll.setTake({ frames: framesWithBand, offset: 0, phraseScores: score?.phraseScores || [] });
  reviewRoll.setReview(ref ? Math.max(ref.duration, full.duration) : full.duration);
  reviewRoll.draw();

  renderReviewStats(score, full);
  renderPhrases(score);
  renderCoachNotes(score, ref, full);

  el.btnPlayTake.disabled = false;
  el.btnRescore.disabled = !ref;
  el.btnExportJSON.disabled = false;
  el.btnExportWav.disabled = !full.hasAudio;
}

function renderReviewStats(score, take) {
  if (!score) {
    el.rsTotal.textContent = '—';
    el.rsAcc.textContent = '—';
    el.rsCover.textContent = '—';
    el.rsDev.textContent = '—';
    const fps = take.frames || [];
    const voiced = fps.filter((f) => f.voiced);
    if (voiced.length) {
      const vals = voiced.map((f) => f.midi);
      const lo = quantile(vals, 0.02), hi = quantile(vals, 0.98);
      el.rsStab.textContent = midiToName(lo) + '–' + midiToName(hi);
    } else {
      el.rsStab.textContent = '—';
    }
    el.rsOct.textContent = '—';
    return;
  }
  el.rsTotal.textContent = Math.round(score.total);
  el.rsTotal.style.color = `var(${score.total >= 85 ? '--green' : score.total >= 70 ? '--yellow' : score.total >= 50 ? '--orange' : '--red'})`;
  el.rsAcc.textContent = Math.round(score.pitchAccuracy * 100) + '%';
  el.rsCover.textContent = Math.round(score.coverage * 100) + '%';
  el.rsDev.textContent = fmtCents(score.meanSignedCents);
  el.rsDev.style.color = Math.abs(score.meanSignedCents) <= 15 ? 'var(--green)'
    : Math.abs(score.meanSignedCents) <= 35 ? 'var(--yellow)' : 'var(--orange)';
  el.rsStab.textContent = 'σ ' + Math.round(score.stdev);
  el.rsOct.textContent = score.octaveFixed;
}

function renderPhrases(score) {
  if (!score?.phraseScores?.length) {
    el.phraseGrid.innerHTML = '<div class="empty">—</div>';
    return;
  }
  el.phraseGrid.innerHTML = '';
  score.phraseScores.forEach((ph, i) => {
    const s = ph.score;
    const color = s >= 85 ? 'rgba(37,224,138,0.8)'
      : s >= 70 ? 'rgba(255,209,102,0.8)'
      : s >= 50 ? 'rgba(255,159,67,0.8)'
      : 'rgba(255,77,94,0.8)';
    const d = document.createElement('div');
    d.className = 'phrase-cell';
    d.style.background = color;
    d.style.color = s >= 70 ? '#07110b' : '#1a0808';
    d.title = `第 ${i + 1} 段 · ${fmtTime(ph.t0)}–${fmtTime(ph.t1)} · 平均偏差 ${Math.round(ph.meanAbs)} 音分`;
    d.innerHTML = `<b>${s}</b><small>${fmtTime(ph.t0)}</small>`;
    el.phraseGrid.appendChild(d);
  });
}

function renderCoachNotes(score, ref, take) {
  el.coachNotes.innerHTML = '';
  const add = (html, hot = false) => {
    const li = document.createElement('li');
    if (hot) li.className = 'hot';
    li.innerHTML = html;
    el.coachNotes.appendChild(li);
  };

  if (!score) {
    add('这条录音没有对应的参考曲目，只能看到音域和稳定性。');
    return;
  }

  const t = score.total;
  add(t >= 90 ? '<b>非常稳。</b>音准已经接近专业水准，可以挑战更难的曲目或更快的段落。'
    : t >= 75 ? '<b>不错。</b>大方向是对的，个别段落需要单独练。'
    : t >= 55 ? '<b>及格线上。</b>旋律记得住，但音高控制还需要建立肌肉记忆。'
    : '<b>先放慢。</b>建议从「长音稳定性」开始，把单音唱准再练整句。');

  const bias = score.meanSignedCents;
  if (Math.abs(bias) > 18) {
    add(`整体${bias > 0 ? '偏高' : '偏低'} <b>${Math.abs(Math.round(bias))} 音分</b>（约 ${(Math.abs(bias) / 100).toFixed(2)} 个半音）。` +
      `这是系统性的，通常是${bias > 0 ? '喉咙太紧、气息推得太急' : '气息支撑不足、音高靠嗓子顶'}。` +
      `可以尝试${bias > 0 ? '降 1 个半音唱' : '升 1 个半音唱'}再对比。`, true);
  } else {
    add(`整体音高偏差居中（${fmtCents(bias)}），没有系统性跑调。`);
  }

  if (score.stdev > 45) {
    add(`抖动偏大（σ=${Math.round(score.stdev)} 音分）。长音时气息不稳，试着用「吸一口气 → 均匀送气」把每个长音唱满。`, true);
  } else if (score.stdev < 20 && score.counts.perfect + score.counts.great > 10) {
    add('音高很稳，波动小。');
  }

  if (score.coverage < 0.6) {
    add(`有 <b>${Math.round((1 - score.coverage) * 100)}%</b> 的参考音符没唱到（漏唱或太轻没被检测到）。检查麦克风距离，或者把参考音调小一点避免盖住你的声音。`);
  }

  const worst = (score.worst || []).filter((w) => w.score < 60).slice(0, 3);
  if (worst.length) {
    const times = worst.map((w) => `${fmtTime(w.t0)}–${fmtTime(w.t1)}`).join('、');
    add(`最需要练的段落：<b>${times}</b>。单独循环这几段。`, true);
  }

  const b = score.counts;
  const offRatio = (b.off + b.sharp) / Math.max(1, Object.values(b).reduce((a, c) => a + c, 0));
  if (offRatio > 0.35) {
    add('超过三分之一的音偏离半个半音以上。建议先用「三度跳进」把音程关系唱熟，再来整首。');
  }

  if (ref && ref.notes && ref.notes.length > 3) {
    add(`这条参考旋律共 <b>${ref.notes.length}</b> 个音，音域 ${midiToName(ref.range.low)}–${midiToName(ref.range.high)}。`);
  }
}

function clearReview() {
  S.selectedTake = null;
  reviewTakeObj = null;
  el.reviewTitle.textContent = '选择一条录音';
  el.reviewSub.textContent = '可以看到逐句偏差、最准/最差的片段';
  ['rsTotal', 'rsAcc', 'rsCover', 'rsDev', 'rsStab', 'rsOct'].forEach((k) => { el[k].textContent = '—'; });
  el.phraseGrid.innerHTML = '<div class="empty">—</div>';
  el.coachNotes.innerHTML = '<li>选择一条录音查看分析</li>';
  el.btnPlayTake.disabled = true;
  el.btnRescore.disabled = true;
  el.btnExportJSON.disabled = true;
  el.btnExportWav.disabled = true;
  renderTakeList();
}

/* ══════════════════════ 导入 ══════════════════════ */

async function handleFile(file) {
  const name = file.name.replace(/\.[^.]+$/, '');
  const isMidi = /\.(mid|midi)$/i.test(file.name);
  const title = el.importTitle.value.trim() || name;

  el.importProgress.hidden = false;
  el.importBar.style.width = '0%';
  el.importStatus.textContent = isMidi ? '解析 MIDI…' : '解码音频…';

  try {
    if (isMidi) {
      const buf = await file.arrayBuffer();
      const midi = parseMidi(buf);
      if (!midi.notes.length) throw new Error('MIDI 里没有音符');
      const ref = referenceFromNotes(midi.notes, midi.duration, { title });
      const track = {
        id: uid('track'),
        kind: 'custom',
        title,
        subtitle: `MIDI · ${midi.notes.length} 个音 · ${fmtTime(midi.duration)}`,
        duration: midi.duration,
        notes: midi.notes.map((n) => ({ ...n, label: Math.round(n.midi) })),
        bpm: 120,
        refData: packReference(ref),
        audioBlob: null,
      };
      S.customTracks = addTrack(track);
      finishImport(track);
      return;
    }

    // —— 音频 ——
    const ctx = await S.engine.ensureContext();
    if (ctx.state === 'suspended') await ctx.resume();
    const audioBuf = await decodeFile(ctx, file);
    el.importStatus.textContent = `已解码 ${fmtTime(audioBuf.duration)} · 分析音高…`;

    const rangeOpt = el.importRange.value;
    const minHz = rangeOpt === 'male' ? 70 : rangeOpt === 'female' ? 160 : undefined;
    const maxHz = rangeOpt === 'male' ? 700 : rangeOpt === 'female' ? 1300 : undefined;

    const raw = await analyzeBuffer(ctx, audioBuf, {
      hopSec: 0.01,
      windowSize: 2048,
      minHz,
      maxHz,
      progress: (p) => {
        el.importBar.style.width = Math.round(p * 100) + '%';
        if (p < 1) el.importStatus.textContent = `分析音高 ${Math.round(p * 100)}%`;
      },
    });

    el.importStatus.textContent = '清理与平滑…';
    const cleaned = cleanFrames(raw, { minConfidence: S.settings.minConfidence });

    // 音频文件的帧→参考轨道（hop 用 0.02 节省空间）
    const ref = referenceFromFrames(cleaned, {
      title,
      hop: 0.02,
      snap: el.importSnap.checked,
      source: 'audio',
    });

    if (ref.voicedRatio < 0.06) {
      throw new Error('几乎没检测到音高。如果是纯伴奏，请换「人声/清唱」或提供带人声的版本。');
    }

    const track = {
      id: uid('track'),
      kind: 'custom',
      title,
      subtitle: `${fmtTime(ref.duration)} · ${midiToName(ref.range.low)}–${midiToName(ref.range.high)} · ${Math.round(ref.voicedRatio * 100)}% 有声`,
      duration: ref.duration,
      notes: null,
      bpm: null,
      refData: packReference(ref),
      audioBlob: file, // File 本身就是 Blob，直接存
    };

    S.customTracks = addTrack(track);
    finishImport(track);
  } catch (err) {
    el.importStatus.textContent = '失败：' + err.message;
    toast('导入失败：' + err.message, 'err', 6000);
  }
}

function finishImport(track) {
  el.importBar.style.width = '100%';
  el.importStatus.textContent = '完成 ✓';
  renderCustomList();
  renderTrackStrip();
  toast('已加入曲库：' + track.title, 'ok');
  setTimeout(() => { el.importProgress.hidden = true; }, 1800);
  selectTrack(track.id);
  switchView('live');
}

/* 参考轨道 ↔ 可存储格式 */
function packReference(ref) {
  return {
    title: ref.title,
    duration: ref.duration,
    hop: ref.hop,
    midi: Array.from(ref.midi),
    voiced: Array.from(ref.voiced),
    energy: ref.energy ? Array.from(ref.energy) : null,
    notes: ref.notes || null,
    source: ref.source,
  };
}

function restoreReference(track) {
  const d = track.refData;
  return new Reference({
    title: d.title || track.title,
    duration: d.duration,
    hop: d.hop,
    midi: new Float32Array(d.midi),
    voiced: new Uint8Array(d.voiced),
    energy: d.energy ? new Float32Array(d.energy) : null,
    notes: d.notes,
    source: d.source,
  });
}

/* ══════════════════════ 渲染 ══════════════════════ */

function renderTrackStrip() {
  el.trackStrip.innerHTML = '';
  for (const t of allTracks()) {
    const d = document.createElement('button');
    d.className = 'track-card' + (S.track?.id === t.id ? ' active' : '');
    d.innerHTML = `<b>${escapeHtml(t.title)}</b><small>${escapeHtml(t.subtitle || '')}</small>`;
    d.addEventListener('click', () => selectTrack(t.id));
    el.trackStrip.appendChild(d);
  }
}

function renderBuiltinList() {
  el.builtinList.innerHTML = '';
  for (const t of DEMO_TRACKS) {
    el.builtinList.appendChild(libItem({ ...t, kind: 'builtin' }, '🎼'));
  }
}

function renderCustomList() {
  if (!S.customTracks.length) {
    el.customList.innerHTML = '<div class="empty">还没有导入的曲目</div>';
    return;
  }
  el.customList.innerHTML = '';
  for (const t of S.customTracks) {
    const item = libItem(t, t.refData?.source === 'midi' ? '🎹' : '🎵');
    const del = document.createElement('button');
    del.className = 'take-del';
    del.textContent = '✕';
    del.title = '移除';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      S.customTracks = removeTrack(t.id);
      if (S.track?.id === t.id) selectTrack(DEMO_TRACKS[0].id);
      renderCustomList();
      renderTrackStrip();
      toast('已移除', '', 1400);
    });
    item.appendChild(del);
    el.customList.appendChild(item);
  }
}

function libItem(t, icon) {
  const d = document.createElement('div');
  d.className = 'lib-item' + (S.track?.id === t.id ? ' active' : '');
  d.innerHTML = `
    <div class="lib-icon">${icon}</div>
    <div class="lib-info">
      <b>${escapeHtml(t.title)}</b>
      <small>${escapeHtml(t.subtitle || '')}</small>
    </div>
  `;
  d.addEventListener('click', () => { selectTrack(t.id); switchView('live'); });
  return d;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ══════════════════════ 视图切换 ══════════════════════ */

function switchView(name) {
  S.view = name;
  for (const t of el.tabs.children) t.classList.toggle('active', t.dataset.view === name);
  document.querySelectorAll('.view').forEach((v) => {
    v.classList.toggle('active', v.id === 'view-' + name);
  });
  if (name === 'review') {
    refreshTakes();
    setTimeout(() => { reviewRoll.resize(); if (reviewTakeObj) selectTake(reviewTakeObj.id); reviewRoll.draw(); }, 30);
  }
  if (name === 'live') {
    setTimeout(() => { roll.resize(); roll.draw(); gauge.resize(); gauge.draw(); }, 30);
  }
}

/* ══════════════════════ 事件绑定 ══════════════════════ */

function bind() {
  el.tabs.addEventListener('click', (e) => {
    const b = e.target.closest('.tab');
    if (b) switchView(b.dataset.view);
  });

  el.btnMic.addEventListener('click', enableMic);
  el.btnPlay.addEventListener('click', play);
  el.btnStop.addEventListener('click', () => {
    stopPlayback();
    if (S.recording) stopRecording();
  });
  el.btnRec.addEventListener('click', () => {
    if (S.recording) stopRecording(); else startRecording();
  });

  el.latencySlider.addEventListener('input', () => {
    S.settings.latencyMs = Number(el.latencySlider.value);
    el.latencyVal.textContent = S.settings.latencyMs + ' ms';
    saveSettings(S.settings);
  });
  el.btnAutoLatency.addEventListener('click', () => {
    calibrateLatency();
    toast('已设为系统延迟 ' + S.settings.latencyMs + ' ms，可按实际微调', 'ok');
  });

  // 卷帘范围
  document.querySelectorAll('[data-range]').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('[data-range]').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      S.windowSec = Number(b.dataset.range);
    });
  });

  // 评分模式
  document.querySelectorAll('[data-mode]').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('[data-mode]').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      S.settings.scoreMode = b.dataset.mode;
      S.settings.tolerance = SCORE_MODES[b.dataset.mode].tol;
      saveSettings(S.settings);
      el.setTolerance.value = S.settings.tolerance;
      el.setToleranceVal.textContent = S.settings.tolerance + '¢';
      toast('评分模式：' + SCORE_MODES[b.dataset.mode].name, '', 1600);
    });
  });

  // 升降调
  $('btnTransposeUp').addEventListener('click', () => {
    if (S.settings.transpose >= 12) return;
    S.settings.transpose++;
    saveSettings(S.settings);
    applyTransposeToView();
    updateRangeLabel();
    if (S.playing) { stopPlayback(); play(); }
  });
  $('btnTransposeDown').addEventListener('click', () => {
    if (S.settings.transpose <= -12) return;
    S.settings.transpose--;
    saveSettings(S.settings);
    applyTransposeToView();
    updateRangeLabel();
    if (S.playing) { stopPlayback(); play(); }
  });

  el.cbReference.addEventListener('change', () => {
    S.settings.playReference = el.cbReference.checked;
    saveSettings(S.settings);
  });

  // 复盘
  el.btnPlayTake.addEventListener('click', async () => {
    if (!reviewTakeObj?.hasAudio) return;
    const blob = await getTakeAudio(reviewTakeObj.id);
    if (!blob) { toast('找不到音频文件', 'err'); return; }
    const url = URL.createObjectURL(blob);
    const a = new Audio(url);
    a.play().catch((e) => toast('播放失败：' + e.message, 'err'));
    a.onended = () => URL.revokeObjectURL(url);
  });

  el.btnRescore.addEventListener('click', async () => {
    if (reviewTakeObj) await selectTake(reviewTakeObj.id);
    toast('已按当前设置重算', '', 1600);
  });

  el.btnExportJSON.addEventListener('click', () => {
    if (!reviewTakeObj) return;
    const out = {
      id: reviewTakeObj.id,
      track: reviewTakeObj.trackTitle,
      createdAt: new Date(reviewTakeObj.createdAt).toISOString(),
      duration: reviewTakeObj.duration,
      score: reviewTakeObj.score,
      mode: reviewTakeObj.mode,
      frames: reviewTakeObj.frames,
    };
    downloadJSON(`pitchcoach-${reviewTakeObj.id}.json`, out);
  });

  el.btnExportWav.addEventListener('click', async () => {
    if (!reviewTakeObj) return;
    const blob = await getTakeAudio(reviewTakeObj.id);
    if (!blob) { toast('找不到音频文件', 'err'); return; }
    try {
      const ctx = await S.engine.ensureContext();
      const ab = await blob.arrayBuffer();
      const buf = await ctx.decodeAudioData(ab);
      downloadBlob(`pitchcoach-${reviewTakeObj.id}.wav`, bufferToWav(buf));
    } catch (e) {
      toast('转换失败：' + e.message, 'err');
    }
  });

  el.btnClearTakes.addEventListener('click', async () => {
    if (!confirm('确定清空全部录音？此操作不可恢复。')) return;
    await clearAll();
    clearReview();
    await refreshTakes();
    toast('已清空', '', 1600);
  });

  el.takeFilter.addEventListener('change', renderTakeList);

  // 导入
  $('btnPickFile').addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', () => {
    const f = el.fileInput.files?.[0];
    if (f) handleFile(f);
    el.fileInput.value = '';
  });
  ['dragenter', 'dragover'].forEach((ev) => {
    el.dropZone.addEventListener(ev, (e) => { e.preventDefault(); el.dropZone.classList.add('hover'); });
  });
  ['dragleave', 'drop'].forEach((ev) => {
    el.dropZone.addEventListener(ev, (e) => { e.preventDefault(); el.dropZone.classList.remove('hover'); });
  });
  el.dropZone.addEventListener('drop', (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f) handleFile(f);
  });

  // 设置抽屉
  $('btnSettings').addEventListener('click', () => {
    el.settingsDrawer.classList.add('open');
    el.drawerMask.classList.add('open');
    syncSettingsUI();
  });
  const closeDrawer = () => {
    el.settingsDrawer.classList.remove('open');
    el.drawerMask.classList.remove('open');
  };
  $('btnCloseSettings').addEventListener('click', closeDrawer);
  el.drawerMask.addEventListener('click', closeDrawer);

  // 帮助
  $('btnHelp').addEventListener('click', () => el.helpMask.classList.add('open'));
  $('btnCloseHelp').addEventListener('click', () => el.helpMask.classList.remove('open'));
  el.helpMask.addEventListener('click', (e) => {
    if (e.target === el.helpMask) el.helpMask.classList.remove('open');
  });

  // 设置项
  const setTol = () => {
    S.settings.tolerance = Number(el.setTolerance.value);
    el.setToleranceVal.textContent = S.settings.tolerance + '¢';
    saveSettings(S.settings);
  };
  el.setTolerance.addEventListener('input', setTol);

  el.setConfidence.addEventListener('input', () => {
    S.settings.minConfidence = Number(el.setConfidence.value);
    el.setConfidenceVal.textContent = S.settings.minConfidence.toFixed(2);
    saveSettings(S.settings);
  });

  el.setRefVol.addEventListener('input', () => {
    S.settings.referenceVolume = Number(el.setRefVol.value);
    el.setRefVolVal.textContent = Math.round(S.settings.referenceVolume * 100) + '%';
    if (S.synth) S.synth.gain.gain.value = S.settings.referenceVolume;
    if (S.audioEl) S.audioEl.volume = S.settings.referenceVolume;
    saveSettings(S.settings);
  });

  el.setLatency.addEventListener('input', () => {
    S.settings.latencyMs = Number(el.setLatency.value);
    el.setLatencyVal.textContent = S.settings.latencyMs + ' ms';
    el.latencySlider.value = S.settings.latencyMs;
    el.latencyVal.textContent = S.settings.latencyMs + ' ms';
    saveSettings(S.settings);
  });

  $('btnExportAll').addEventListener('click', async () => {
    const all = [];
    for (const t of S.takes) {
      const full = await getTake(t.id);
      if (full) all.push({ ...full, frames: full.frames });
    }
    downloadJSON('pitchcoach-all-takes.json', { exportedAt: new Date().toISOString(), takes: all });
  });

  $('btnWipe').addEventListener('click', async () => {
    if (!confirm('清空所有录音和曲目？')) return;
    await clearAll();
    S.customTracks = [];
    saveTracks([]);
    await refreshTakes();
    clearReview();
    toast('已清空', '', 1600);
  });

  // 窗口尺寸
  let rt = 0;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      roll.resize(); reviewRoll.resize();
      gauge.resize();
      roll.draw(); reviewRoll.draw(); gauge.draw();
    }, 120);
  });

  // 键盘
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.code === 'Space') { e.preventDefault(); if (S.playing) stopPlayback(); else play(); }
    if (e.key === 'r' || e.key === 'R') { if (S.recording) stopRecording(); else startRecording(); }
  });
}

function syncSettingsUI() {
  el.setTolerance.value = S.settings.tolerance;
  el.setToleranceVal.textContent = S.settings.tolerance + '¢';
  el.setConfidence.value = S.settings.minConfidence;
  el.setConfidenceVal.textContent = S.settings.minConfidence.toFixed(2);
  el.setRefVol.value = S.settings.referenceVolume;
  el.setRefVolVal.textContent = Math.round(S.settings.referenceVolume * 100) + '%';
  el.setLatency.value = S.settings.latencyMs;
  el.setLatencyVal.textContent = S.settings.latencyMs + ' ms';
  el.latencySlider.value = S.settings.latencyMs;
  el.latencyVal.textContent = S.settings.latencyMs + ' ms';
  el.cbReference.checked = S.settings.playReference;
}

/* ══════════════════════ 初始化 ══════════════════════ */

async function init() {
  bind();

  S.customTracks = loadTracks();
  S.windowSec = S.settings.windowSec || 6;
  el.latencySlider.value = S.settings.latencyMs;
  el.latencyVal.textContent = S.settings.latencyMs + ' ms';
  syncSettingsUI();

  // 评分模式按钮同步
  document.querySelectorAll('[data-mode]').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === S.settings.scoreMode);
  });

  renderTrackStrip();
  renderBuiltinList();
  renderCustomList();

  selectTrack(S.customTracks[0]?.id || DEMO_TRACKS[0].id);
  roll.liveHistory = [];

  await refreshTakes();
  clearReview();

  roll.draw();
  gauge.draw();
  requestAnimationFrame(loop);
  startSampling();

  // 截图/调试用
  window.__PC = {
    S, roll, gauge, reviewRoll, selectTrack, play, stopPlayback,
    updateHint,
    // 供自动化测试注入轨迹
    setTakeForView(frames, score) {
      const withBand = frames.map((f, i) => ({ ...f, band: score.bands[i] }));
      roll.setTake({ frames: withBand, offset: 0, phraseScores: score.phraseScores });
      roll.setReview(S.ref.duration);
      el.rollHint.classList.add('hidden');
      roll.draw();
    },
  };
  console.log('[PitchCoach] ready');
}

init().catch((e) => {
  console.error(e);
  toast('初始化失败：' + e.message, 'err', 8000);
});
