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
  parseLRC, toIntervals, lineAt, rankLyricCandidates, isUsableLyrics,
  guessTitleArtist, distributeByLines,
} from './lyrics.js';
import {
  analyzeVocal, alignLyricsToVocal, scoreVocalTake, vocalUnitText,
} from './vocal.js';
import {
  loadSettings, saveSettings, loadTracks, loadTracksWithAudio, addTrack, removeTrack,
  saveTake, listTakes, getTake, getTakeAudio, deleteTake, clearAll,
  downloadJSON, downloadBlob, DEFAULT_SETTINGS, getTrackAudio, clearTrackAudio,
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

  // 教唱工作流（录入参考人声 → 清唱跟练）
  vocalMode: false,     // 是否处于"教唱"模式
  refVocal: null,       // {ref, notes, frames} 录入的参考人声解析结果
  lyricUnits: null,     // alignLyricsToVocal 的产出（每个字的谱子）
  vocalStep: 'idle',    // 'idle' | 'analyze' | 'align' | 'practice' | 'result'

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
  btnMicOff: $('btnMicOff'),
  nowNote: $('nowNote'),
  nowPitch: $('nowPitch'),
  nowCents: $('nowCents'),
  nowSub: $('nowSub'),
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
  btnStopTake: $('btnStopTake'),
  btnRescore: $('btnRescore'),
  btnExportJSON: $('btnExportJSON'),
  btnExportWav: $('btnExportWav'),
  btnClearTakes: $('btnClearTakes'),
  allTracksList: $('allTracksList'),
  libTotalCount: $('libTotalCount'),
  libFilter: $('libFilter'),
  btnClearBroken: $('btnClearBroken'),
  dropZone: $('dropZone'),
  fileInput: $('fileInput'),
  importTitle: $('importTitle'),
  importMode: $('importMode'),
  importRange: $('importRange'),
  importSnap: $('importSnap'),
  importProgress: $('importProgress'),
  importBar: $('importBar'),
  importStatus: $('importStatus'),
  importArea: $('importArea'),

  // 本地音乐库扫描
  libScanPanel: $('libScanPanel'),
  libScanTitle: $('libScanTitle'),
  libScanSub: $('libScanSub'),
  libScanList: $('libScanList'),
  libScanFilter: $('libScanFilter'),
  libScanSelectAll: $('libScanSelectAll'),
  libScanCount: $('libScanCount'),
  btnScanLib: $('btnScanLib'),
  btnScanRescan: $('btnScanRescan'),
  btnScanClose: $('btnScanClose'),
  btnImportSelected: $('btnImportSelected'),
  scanRange: $('scanRange'),
  batchProgress: $('batchProgress'),
  batchBar: $('batchBar'),
  batchStatus: $('batchStatus'),
  sepEnabled: $('sepEnabled'),
  sepNote: $('sepNote'),

  // 统一曲库
  allTracksList: $('allTracksList'),
  libTotalCount: $('libTotalCount'),
  libFilter: $('libFilter'),
  btnClearBroken: $('btnClearBroken'),

  // 歌词
  lyricsStrip: $('lyricsStrip'),
  lyrPrev: $('lyrPrev'),
  lyrCurText: $('lyrCurText'),
  lyrNext: $('lyrNext'),
  lyrProgressFill: $('lyrProgressFill'),
  lyrState: $('lyrState'),
  lyrTitleInput: $('lyrTitleInput'),
  lyrArtistInput: $('lyrArtistInput'),
  btnFetchLyrics: $('btnFetchLyrics'),
  btnImportLrc: $('btnImportLrc'),
  btnEditLyrics: $('btnEditLyrics'),
  btnClearLyrics: $('btnClearLyrics'),
  lrcFileInput: $('lrcFileInput'),
  lyrStatus: $('lyrStatus'),
  lyrEditor: $('lyrEditor'),
  lyrEditorActions: $('lyrEditorActions'),
  btnSaveLyrics: $('btnSaveLyrics'),
  btnCancelLyrics: $('btnCancelLyrics'),

  // 教唱工作流
  vocalPanel: $('vocalPanel'),
  btnVocalCapture: $('btnVocalCapture'),
  btnVocalAlign: $('btnVocalAlign'),
  btnVocalPractice: $('btnVocalPractice'),
  vocalStatus: $('vocalStatus'),
  vocalResultWrap: $('vocalResultWrap'),
  vocalSummary: $('vocalSummary'),
  vocalResultList: $('vocalResultList'),

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
/**
 * 开局引导遮罩：只在"还没有任何可看内容"时出现。
 * 一旦选了曲目（参考旋律已画出）或开了麦克风，就该让位给卷帘——
 * 遮罩半透明压在上面会让用户看不清旋律。
 */
function updateHint() {
  const hasContent = S.micOn || S.playing || !!S.ref;
  el.rollHint.classList.toggle('hidden', hasContent);
  if (hasContent && !S.micOn) {
    // 有曲目但还没开麦：用状态条提示下一步
    el.coachText.textContent = '点「开启麦克风」授权，然后点「播放参考」跟着唱';
    el.coachBar.className = 'coach-bar';
  }
}

function scoreColor(v) {
  if (v >= 85) return 's-high';
  if (v >= 70) return 's-mid';
  if (v >= 50) return 's-low';
  return 's-bad';
}

/* ══════════════════════ 曲目管理 ══════════════════════ */

function allTracks() {
  return visibleTracks();
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

  // 切歌时清掉教唱会话状态（保留已存盘 vocalRef 在 track 上，切回来还能用）
  S.vocalMode = t.kind === 'custom' && (t.refData?.source === 'vocal' || t.vocalRef);
  S.refVocal = t.vocalRef ? restoreVocalRef(t.vocalRef) : null;
  S.lyricUnits = t.vocalUnits || null;
  S.vocalStep = S.refVocal ? 'align' : 'idle';
  updateVocalUI();
  updateLyricsUI();
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

  // 判断走哪条路：只有"内置曲目且确实有音符数组"才用合成器。
  // 导入的歌曲 notes 是 null，必须走音频模式；
  // 原来的条件 `!S.track.audioBlob` 在音频丢失时会把导入曲目误判成合成器，
  // 进而 scheduleNotes(null) 抛 TypeError，整个播放流程中断——这就是"没声音"的根因。
  const canSynth = Array.isArray(S.track.notes) && S.track.notes.length > 0;
  const isBuiltin = S.track.kind === 'builtin';

  if (isBuiltin && canSynth) {
    // —— 合成器模式 ——
    const synth = await ensureSynth();
    synth.stopAll();
    synth.gain.gain.value = S.settings.playReference === false ? 0 : S.settings.referenceVolume;
    const t0 = ctx.currentTime + 0.25;
    const tr = S.settings.transpose;
    scheduleNotes(synth, S.track.notes, t0, { transpose: tr });
    S.clock = () => ctx.currentTime - t0;
    S.playStartT = 0;
  } else {
    // —— 音频模式 ——
    let blob = S.track.audioBlob;

    // 兜底：如果内存里没有音频（例如刷新后没读到），尝试从 IndexedDB 补回
    if (!(blob instanceof Blob) || blob.size === 0) {
      try {
        const restored = await getTrackAudio(S.track.id);
        if (restored instanceof Blob && restored.size > 0) {
          blob = restored;
          S.track.audioBlob = restored;
        }
      } catch { /* 忽略 */ }
    }

    if (!(blob instanceof Blob) || blob.size === 0) {
      // 音频真的丢了，别假装在播——恢复按钮状态并明确告诉用户
      S.playing = false;
      el.btnPlay.querySelector('.ico').textContent = '▶';
      el.btnPlay.lastChild.textContent = ' 播放参考';
      el.btnStop.disabled = true;
      el.rollHint.classList.remove('hidden');
      toast('这首曲目的音频丢失了（只保留下了旋律线）。请到「曲库」重新导入一次。', 'err', 6000);
      return;
    }

    if (!S.audioEl) {
      S.audioEl = new Audio();
      S.audioEl.preload = 'auto';
      S.audioEl.crossOrigin = 'anonymous';
    }
    if (!S.audioEl.src || S.audioEl.dataset.trackId !== S.track.id) {
      if (S.audioUrl) URL.revokeObjectURL(S.audioUrl);
      S.audioUrl = URL.createObjectURL(blob);
      S.audioEl.src = S.audioUrl;
      S.audioEl.dataset.trackId = S.track.id;
      S.audioEl.load();
    }
    S.audioEl.currentTime = 0;
    S.audioEl.volume = S.settings.playReference === false ? 0 : S.settings.referenceVolume;
    S.audioEl.muted = S.settings.playReference === false;

    try {
      await S.audioEl.play();
    } catch (e) {
      // 自动播放被拦截时给出可操作提示，而不是静默失败
      toast('播放被浏览器拦截了，请再点一次「播放参考」', 'err', 4000);
      S.playing = false;
      el.btnPlay.querySelector('.ico').textContent = '▶';
      el.btnPlay.lastChild.textContent = ' 播放参考';
      return;
    }
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
  // 播放停了，"此刻应唱"也该复位，否则会一直卡在最后一个音上
  updateNowNote(null, null, null);
  updateHint();
}

/* ══════════════════════ 麦克风 ══════════════════════ */

async function enableMic() {
  if (S.micOn) return;
  try {
    await S.engine.startMic();
    S.micOn = true;
    el.btnMic.textContent = '麦克风已开';
    el.btnMic.classList.add('primary');
    el.btnMicOff.hidden = false;
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

/** 关闭麦克风：停止采样、释放设备、复位所有指示 */
function disableMic() {
  if (!S.micOn) return;

  // 正在录音就先收尾，避免留下半条录音
  if (S.recording) {
    stopRecording().catch(() => {});
  }

  S.micOn = false;
  S.engine.stopMic();

  el.btnMic.textContent = '开启麦克风';
  el.btnMic.classList.remove('primary');
  el.btnMicOff.hidden = true;
  el.micMeter.style.width = '0%';
  el.statusDot.classList.remove('on', 'rec');
  el.statusText.textContent = '未连接麦克风';

  // 表盘归零，别留着最后一次的音高让人误会
  gauge.set(0, false, '--', '--');
  gauge.smooth = 0;
  gauge.target = 0;
  gauge.draw();

  S.liveFrames = [];
  S.sessionScores = [];
  S.histBins.fill(0);
  renderHistogram();
  resetLiveStats();
  updateHint();

  toast('麦克风已关闭', '', 1800);
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

  // —— 教唱工作流：录入参考 / 清唱跟练 都走这里，不进普通复盘 ——
  if (S.vocalStep === 'analyze') {
    el.btnRec.classList.remove('on');
    el.btnRec.innerHTML = '<span class="ico">⏺</span> 开始录音';
    await commitVocalCapture(result || { blob: null, duration: 0, frames: [] }, frames);
    return;
  }
  if (S.vocalStep === 'practice') {
    el.btnRec.classList.remove('on');
    el.btnRec.innerHTML = '<span class="ico">⏺</span> 开始录音';
    commitPractice(result || { blob: null, duration: 0, frames: [] }, frames);
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

    // 动态歌词：跟着歌曲时间走
    updateLyricsDisplay(Math.max(0, songT - latency));
  } else {
    // 教唱清唱跟练：没有参考音频，用"开口至今的真实时间"作为时间轴，
    // 让逐字参考条跟着唱到的位置走。
    if (S.vocalStep === 'practice') {
      const wall = S.recording ? (S.recOrigin?.wall ?? performance.now()) : (S.vocalStartWall ?? performance.now());
      if (S.vocalStartWall == null) S.vocalStartWall = wall;
      const vt = (performance.now() - S.vocalStartWall) / 1000;
      updateVocalPracticeDisplay(vt);
      el.rollTimecode.textContent = '清唱 ' + fmtTime(Math.max(0, vt));
    }
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
  updateNowNote(refMidi, frame.voiced ? frame.midi : null, band);
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

/**
 * 停止复盘页的录音回放。
 * 原来只用 new Audio() 播了就丢引用，用户根本停不下来。
 */
function stopTakePlayback() {
  const a = S.takeAudio;
  if (a) {
    try {
      a.pause();
      a.currentTime = 0;
      a.onended = null;
      a.onerror = null;
      a.src = '';
    } catch { /* 忽略 */ }
    S.takeAudio = null;
  }
  if (S.takeAudioUrl) {
    try { URL.revokeObjectURL(S.takeAudioUrl); } catch { /* 忽略 */ }
    S.takeAudioUrl = null;
  }
  el.btnPlayTake.textContent = '▶ 播放';
  el.btnPlayTake.classList.remove('primary');
  el.btnStopTake.disabled = true;
}

/**
 * 「此刻应唱」面板：直接把当前时刻参考旋律的音名写成大字。
 * 卷帘里的灰条是整体的，具体到"这一拍该唱什么"需要单独提示，
 * 否则新用户根本不知道自己在跟什么音。
 */
let lastNowText = '';
function updateNowNote(refMidi, yourMidi, band) {
  let text, cls = '', pitch, cents = '', sub;

  if (refMidi != null) {
    pitch = midiToName(refMidi);
    const singing = yourMidi != null && yourMidi > 0;
    if (singing) {
      let dev = (yourMidi - refMidi) * 100;

      // 先折叠八度：差 900¢ 以上基本是唱到别的音区了，
      // 显示"跑高了 907¢"对用户没意义，要么是整首移八度（正常），
      // 要么是检测跳八度（已折叠）。这里统一折到 ±600¢ 内再描述。
      let octaveNote = '';
      for (let k = 0; k < 3; k++) {
        if (Math.abs(Math.abs(dev) - 1200) < 300) {
          dev -= Math.round(dev / 1200) * 1200;
          octaveNote = '（差一个八度）';
        } else break;
      }

      const abs = Math.abs(dev);
      cents = fmtCents(dev);

      // 超过 200¢（两个半音）就别再掰扯"偏高偏低"了，直接说是别的音。
      // 这种量级的偏差音分数没有参考价值，不显示数值，免得用户对着 -297¢ 发懵。
      if (abs >= 200) {
        cls = '';
        cents = '';
        sub = octaveNote
          ? `你在 ${midiToName(yourMidi)}，差一个八度`
          : `唱到别处去了 · 你在 ${midiToName(yourMidi)}`;
      } else if (band === 'perfect' || band === 'great') {
        cls = 'hit';
        sub = '准，保持住';
      } else if (band === 'ok') {
        sub = dev > 0 ? '稍微高了一点' : '稍微低了一点';
      } else if (band === 'sharp') {
        sub = dev > 0 ? '偏高，往下压' : '偏低，往上抬';
      } else {
        sub = dev > 0 ? '跑高了' : '跑低了';
      }

      if (abs < 200) sub += ` · 你唱 ${midiToName(yourMidi)}`;
    } else {
      sub = '跟着这个音唱';
    }
  } else if (S.playing) {
    pitch = '—';
    cls = 'gap';
    sub = '这里没有参考音，可以换气';
  } else {
    pitch = '—';
    cls = 'gap';
    sub = S.micOn ? '点「播放参考」开始跟唱' : '点「开启麦克风」授权';
  }

  text = pitch + '|' + cents + '|' + sub;
  if (text === lastNowText) return;   // 避免每帧写 DOM
  lastNowText = text;

  el.nowPitch.textContent = pitch;
  el.nowCents.textContent = cents;
  el.nowSub.textContent = sub;
  el.nowNote.className = 'now-note' + (cls ? ' ' + cls : '');
}

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

  // 切换录音时先停掉上一条的回放，避免两条声音叠在一起
  stopTakePlayback();

  el.btnPlayTake.disabled = !full.hasAudio;
  el.btnPlayTake.title = full.hasAudio ? '播放这条录音' : '这条录音只有音高数据，没有音频';
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
    const track = await buildTrackFromBlob(file, {
      title,
      mode: el.importMode.value,
      range: el.importRange.value,
      snap: el.importSnap.checked,
      onProgress: (p, msg) => {
        el.importBar.style.width = Math.round(p * 100) + '%';
        if (msg) el.importStatus.textContent = msg;
      },
    });
    S.customTracks = await addTrack(track);
    finishImport(track);
  } catch (err) {
    el.importStatus.textContent = '失败：' + err.message;
    toast('导入失败：' + err.message, 'err', 6000);
  }
}

/**
 * 从任意 Blob/File 构建一条曲目（音频或 MIDI）
 * 抽出来供单文件导入和批量导入共用。
 */
async function buildTrackFromBlob(file, opts = {}) {
  const name = (opts.title || file.name || '未命名').replace(/\.[^.]+$/, '');
  const isMidi = /\.(mid|midi)$/i.test(file.name || '');
  const report = opts.onProgress || (() => {});

  if (isMidi) {
    report(0.1, '解析 MIDI…');
    const buf = await file.arrayBuffer();
    const midi = parseMidi(buf);
    if (!midi.notes.length) throw new Error('MIDI 里没有音符');
    const ref = referenceFromNotes(midi.notes, midi.duration, { title: name });
    report(1, '完成');
    return {
      id: uid('track'),
      kind: 'custom',
      title: name,
      subtitle: `MIDI · ${midi.notes.length} 个音 · ${fmtTime(midi.duration)}`,
      duration: midi.duration,
      notes: midi.notes.map((n) => ({ ...n, label: Math.round(n.midi) })),
      bpm: 120,
      refData: packReference(ref),
      audioBlob: null,
    };
  }

  // —— 音频 ——
  const ctx = await S.engine.ensureContext();
  if (ctx.state === 'suspended') await ctx.resume();

  report(0.05, '解码音频…');
  const audioBuf = await decodeFile(ctx, file);
  report(0.15, `已解码 ${fmtTime(audioBuf.duration)} · 分析音高…`);

  const rangeOpt = opts.range || 'auto';
  const minHz = rangeOpt === 'male' ? 70 : rangeOpt === 'female' ? 160 : undefined;
  const maxHz = rangeOpt === 'male' ? 700 : rangeOpt === 'female' ? 1300 : undefined;

  const raw = await analyzeBuffer(ctx, audioBuf, {
    hopSec: 0.01,
    windowSize: 2048,
    minHz,
    maxHz,
    progress: (p) => {
      report(0.15 + p * 0.75, `分析音高 ${Math.round(p * 100)}%`);
    },
  });

  report(0.93, '清理与平滑…');
  // 现场版（Live/演唱会/现场）伴奏与观众声干扰大，用更强的平滑。
  // 文件名里带这些标记的自动判定。
  const isLive = /(live|演唱会|现场|巡回|concert)/i.test(name);
  const cleaned = cleanFrames(raw, {
    minConfidence: S.settings.minConfidence,
    aggressive: isLive || opts.aggressive === true,
  });

  const isVocal = opts.mode === 'hum';
  const ref = referenceFromFrames(cleaned, {
    title: name,
    hop: 0.02,
    snap: opts.snap !== false,
    source: isVocal ? 'vocal' : 'audio',
  });

  if (ref.voicedRatio < 0.04) {
    throw new Error('几乎没检测到音高（可能是纯伴奏）');
  }

  report(1, '完成');
  const track = {
    id: uid('track'),
    kind: 'custom',
    title: name,
    subtitle: `${fmtTime(ref.duration)} · ${midiToName(ref.range.low)}–${midiToName(ref.range.high)} · ${Math.round(ref.voicedRatio * 100)}% 有声`,
    duration: ref.duration,
    notes: null,
    bpm: null,
    refData: packReference(ref),
    audioBlob: file,
  };
  // 清唱 / 哼唱模式：导入的就是"参考人声"，直接进入教唱流程
  if (isVocal) {
    track.vocalRef = {
      duration: ref.duration,
      hop: ref.hop,
      midi: Array.from(ref.midi),
      voiced: Array.from(ref.voiced),
      notes: ref.notes,
      source: 'vocal',
    };
    track.subtitle = `参考人声 · ${fmtTime(ref.duration)} · 可作教唱`;
  }
  return track;
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

/* ══════════════════════ 本地音乐库扫描 ══════════════════════ */

const LibScan = {
  items: [],
  selected: new Set(),
  busy: false,
};

async function scanLocalLibrary(force = false) {
  if (LibScan.busy) return;
  LibScan.busy = true;

  el.libScanPanel.hidden = false;
  el.importArea.hidden = true;
  el.libScanTitle.textContent = '正在扫描…';
  el.libScanSub.textContent = '读取 Music / Downloads / Desktop';
  el.libScanList.innerHTML = '<div class="empty">扫描中，请稍候…</div>';

  try {
    const r = await fetch('/api/scan?depth=5&limit=3000');
    if (!r.ok) throw new Error('服务器返回 ' + r.status);
    const data = await r.json();

    LibScan.items = data.items || [];
    LibScan.selected.clear();

    const enc = LibScan.items.filter((i) => i.encrypted).length;
    el.libScanTitle.textContent = `找到 ${LibScan.items.length} 个音频文件`;
    el.libScanSub.textContent = enc > 0
      ? `其中 ${enc} 个是加密格式（需先解密）`
      : `${data.roots.length} 个目录 · 全部可直接导入`;

    renderScanList();
    toast(`扫描到 ${LibScan.items.length} 个音频`, LibScan.items.length ? 'ok' : '', 2200);
  } catch (e) {
    el.libScanTitle.textContent = '扫描失败';
    el.libScanSub.textContent = e.message;
    el.libScanList.innerHTML = `<div class="empty">${escapeHtml(e.message)}<br>请确认是通过 http://127.0.0.1 打开的页面</div>`;
    toast('扫描失败：' + e.message, 'err', 5000);
  } finally {
    LibScan.busy = false;
  }
}

function renderScanList() {
  const kw = (el.libScanFilter.value || '').trim().toLowerCase();
  const list = LibScan.items.filter((it) =>
    !kw || it.name.toLowerCase().includes(kw)
  );

  if (!LibScan.items.length) {
    el.libScanList.innerHTML = '<div class="empty">没有找到音频文件。<br>把歌放进「音乐」文件夹，或者用上面的「选择文件」导入。</div>';
    updateScanCount();
    return;
  }
  if (!list.length) {
    el.libScanList.innerHTML = '<div class="empty">没有匹配的文件</div>';
    updateScanCount();
    return;
  }

  const frag = document.createDocumentFragment();
  for (const it of list) {
    const row = document.createElement('label');
    row.className = 'scan-item';
    const checked = LibScan.selected.has(it.path);
    if (checked) row.classList.add('checked');
    if (it.encrypted) row.classList.add('disabled');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = checked;
    cb.disabled = it.encrypted;
    cb.addEventListener('change', () => {
      if (cb.checked) LibScan.selected.add(it.path);
      else LibScan.selected.delete(it.path);
      row.classList.toggle('checked', cb.checked);
      updateScanCount();
    });

    const nm = document.createElement('span');
    nm.className = 'scan-name';
    nm.textContent = it.name;
    nm.title = it.path;

    const meta = document.createElement('span');
    meta.className = 'scan-meta';
    meta.textContent = fmtSize(it.size);

    row.appendChild(cb);
    row.appendChild(nm);
    row.appendChild(meta);
    if (it.encrypted) {
      const tag = document.createElement('span');
      tag.className = 'scan-tag';
      tag.textContent = '加密';
      row.appendChild(tag);
      row.title = 'QQ音乐/网易云加密格式，需先用转换工具解密';
    }
    frag.appendChild(row);
  }

  el.libScanList.innerHTML = '';
  el.libScanList.appendChild(frag);
  updateScanCount();
}

function updateScanCount() {
  const n = LibScan.selected.size;
  el.libScanCount.textContent = `${n} / ${LibScan.items.length}`;
  el.btnImportSelected.textContent = `导入选中 (${n})`;
  el.btnImportSelected.disabled = n === 0;
  const visible = LibScan.items.filter((i) => !i.encrypted);
  el.libScanSelectAll.checked = visible.length > 0 && n === visible.length;
}

function fmtSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + 'KB';
  return (bytes / 1024 / 1024).toFixed(1) + 'MB';
}

/** 批量导入选中的文件 */
async function importSelected() {
  const paths = [...LibScan.selected];
  if (!paths.length) return;

  const total = paths.length;
  let ok = 0, fail = 0;
  const errors = [];

  el.batchProgress.hidden = false;
  el.btnImportSelected.disabled = true;

  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    const base = p.split(/[\\/]/).pop();
    el.batchBar.style.width = Math.round((i / total) * 100) + '%';
    el.batchStatus.textContent = `(${i + 1}/${total}) ${base}`;

    try {
      let file;
      let srcForSep = null;

      if (el.sepEnabled.checked) {
        // 走人声分离：先在服务器上跑 demucs，再取回人声轨
        srcForSep = p;
        const vocalsBlob = await separateVocals(p, (pct, msg) => {
          el.batchBar.style.width = Math.round(((i + pct * 0.8) / total) * 100) + '%';
          if (msg) el.batchStatus.textContent = `(${i + 1}/${total}) ${base} — ${msg}`;
        });
        file = new File([vocalsBlob], base.replace(/\.[^.]+$/, '') + '-vocals.mp3', {
          type: 'audio/mpeg',
        });
      } else {
        // 通过服务器 API 读取本地文件
        const resp = await fetch('/api/file?path=' + encodeURIComponent(p));
        if (!resp.ok) throw new Error('读取失败 ' + resp.status);
        const blob = await resp.blob();
        file = new File([blob], base, { type: blob.type || 'audio/mpeg' });
      }

      const track = await buildTrackFromBlob(file, {
        title: base,
        range: el.scanRange.value,
        snap: true,
        onProgress: (p2, msg) => {
          const basePct = el.sepEnabled.checked ? 0.8 : 0;
          el.batchBar.style.width = Math.round(((i + basePct + p2 * (1 - basePct)) / total) * 100) + '%';
          if (msg) el.batchStatus.textContent = `(${i + 1}/${total}) ${base} — ${msg}`;
        },
      });

      S.customTracks = await addTrack(track);
      ok++;
    } catch (e) {
      fail++;
      errors.push(`${base}: ${e.message}`);
      console.warn('[batch import]', base, e);
    }
  }

  el.batchBar.style.width = '100%';
  el.batchStatus.textContent = `完成：成功 ${ok} 个${fail ? `，失败 ${fail} 个` : ''}`;
  renderCustomList();
  renderTrackStrip();

  toast(`导入完成：${ok} 个成功${fail ? `，${fail} 个失败` : ''}`, ok ? 'ok' : 'err', 4000);

  if (errors.length) {
    console.warn('[batch import] 失败列表:\n' + errors.join('\n'));
  }

  LibScan.selected.clear();
  renderScanList();

  setTimeout(() => {
    el.batchProgress.hidden = true;
    el.btnImportSelected.disabled = LibScan.selected.size === 0;
  }, 2500);

  if (ok > 0) {
    // 跳到第一条新曲目
    const first = S.customTracks[S.customTracks.length - ok];
    if (first) selectTrack(first.id);
  }
}

/* ══════════════════════ 人声分离（Demucs） ══════════════════════ */

const SEP = { available: false, checked: false, reason: '' };

/** 启动时探测分离能力 */
async function checkSepCapability() {
  try {
    const r = await fetch('/api/separate/status');
    const j = await r.json();
    SEP.available = !!j.available;
    SEP.reason = j.reason || '';
    if (SEP.available) {
      el.sepNote.textContent = '可用';
      el.sepNote.className = 'sep-note ok';
      el.sepEnabled.disabled = false;
    } else {
      el.sepNote.textContent = '不可用';
      el.sepNote.className = 'sep-note off';
      el.sepEnabled.disabled = true;
      el.sepEnabled.parentElement.title = SEP.reason;
    }
  } catch {
    el.sepNote.textContent = '不可用';
    el.sepNote.className = 'sep-note off';
    el.sepEnabled.disabled = true;
  }
  SEP.checked = true;
}

/**
 * 调用服务器上的 demucs 分离人声，返回人声轨 Blob
 * @param {string} path 本地绝对路径
 * @param {(pct:number, msg:string)=>void} onProgress
 */
async function separateVocals(path, onProgress = () => {}) {
  const r = await fetch('/api/separate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!r.ok) {
    let msg = '分离请求失败 ' + r.status;
    try { msg = (await r.json()).error || msg; } catch { /* noop */ }
    throw new Error(msg);
  }
  const { jobId } = await r.json();
  if (!jobId) throw new Error('没有返回任务号');

  // 轮询进度
  const t0 = Date.now();
  let lastPct = 0;
  for (;;) {
    await new Promise((res) => setTimeout(res, 2500));
    const s = await (await fetch('/api/separate/job?id=' + jobId)).json();
    if (!s.ok) throw new Error('任务丢失');

    const elapsed = Math.round((Date.now() - t0) / 1000);
    if (s.status === 'running') {
      // demucs 的百分比是"秒/秒"，映射到 0..1
      const pct = Math.min(0.98, (s.progress || 0) / 100);
      lastPct = Math.max(lastPct, pct);
      onProgress(lastPct, `人声分离 ${Math.round(lastPct * 100)}% (${elapsed}s)`);
      if (elapsed > 1800) throw new Error('分离超时（超过 30 分钟）');
    } else if (s.status === 'done') {
      onProgress(0.8, '分离完成，读取人声轨…');
      const resp = await fetch('/api/separate/file?job=' + jobId);
      if (!resp.ok) throw new Error('读取人声轨失败 ' + resp.status);
      return await resp.blob();
    } else {
      throw new Error(s.error || '分离失败');
    }
  }
}

/* ══════════════════════ 歌词 ══════════════════════ */

/**
 * 歌词挂在曲目对象上：track.lyrics = { text, synced, source, updatedAt }
 * 文本很小，随曲库一起进 localStorage 没问题。
 */
function currentLyrics() {
  return S.track?.lyrics || null;
}

function lyricsIntervals() {
  const ly = currentLyrics();
  if (!ly || !ly.text) return [];
  if (!S._lyrCache || S._lyrCacheFor !== S.track?.id || S._lyrCacheText !== ly.text) {
    const lines = parseLRC(ly.text);
    const dur = S.track?.duration || S.ref?.duration || 300;
    S._lyrCache = toIntervals(lines, dur);
    S._lyrCacheFor = S.track?.id;
    S._lyrCacheText = ly.text;
  }
  return S._lyrCache;
}

async function saveLyricsToTrack(text, synced, source) {
  if (!S.track) return;
  const t = S.track;
  t.lyrics = {
    text,
    synced: !!synced,
    source: source || 'manual',
    updatedAt: Date.now(),
  };

  const idx = S.customTracks.findIndex((x) => x.id === t.id);
  if (idx >= 0) {
    S.customTracks[idx] = t;
    await addTrack(t);
  }

  S._lyrCache = null;
  updateLyricsUI();
  renderAllTracks();
}

function updateLyricsUI() {
  const ly = currentLyrics();

  if (el.lyrState) {
    el.lyrState.textContent = !ly || !ly.text ? '暂无'
      : ly.synced ? '同步歌词' : '纯文本';
    el.lyrState.className = 'lyr-state' + (ly && ly.text ? (ly.synced ? ' ok' : ' warn') : '');
  }

  if (el.lyrEditor && !el.lyrEditor.hidden) return;

  // 搜索框始终跟随当前曲目（用户没在编辑时才覆盖，避免打断输入）
  if (S.track && el.lyrTitleInput && document.activeElement !== el.lyrTitleInput) {
    const guessed = guessTitleArtist(S.track.title || '');
    el.lyrTitleInput.value = guessed.title || S.track.title || '';
    if (el.lyrArtistInput && document.activeElement !== el.lyrArtistInput) {
      el.lyrArtistInput.value = guessed.artist || '';
    }
  }

  if (el.lyricsStrip) {
    el.lyricsStrip.hidden = !(ly && ly.text && S.track);
  }
}

/** 每帧调用：更新动态歌词 */
function updateLyricsDisplay(songT) {
  if (!el.lyricsStrip || el.lyricsStrip.hidden) return;
  const iv = lyricsIntervals();
  if (!iv.length) return;

  const { index, line, progress } = lineAt(iv, songT);

  if (index < 0) {
    el.lyrCurText.textContent = '…';
    el.lyrPrev.textContent = '';
    el.lyrNext.textContent = iv[0]?.text || '';
    el.lyrProgressFill.style.width = '0%';
    return;
  }

  el.lyrCurText.textContent = line.text || '♪';
  el.lyrPrev.textContent = iv[index - 1]?.text || '';
  el.lyrNext.textContent = iv[index + 1]?.text || '';
  el.lyrProgressFill.style.width = Math.round(progress * 100) + '%';
}

async function fetchLyricsForCurrent() {
  if (!S.track) { toast('先选一首歌', 'err'); return; }

  const titleInput = el.lyrTitleInput.value.trim();
  const artistInput = el.lyrArtistInput.value.trim();
  const guessed = guessTitleArtist(S.track.title || '');
  const title = titleInput || guessed.title || S.track.title || '';
  const artist = artistInput || guessed.artist || '';

  el.btnFetchLyrics.disabled = true;
  el.lyrStatus.textContent = `正在搜索「${title}${artist ? ' - ' + artist : ''}」…`;

  try {
    const qs = new URLSearchParams({ title });
    if (artist) qs.set('artist', artist);
    const r = await fetch('/api/lyrics/search?' + qs);
    const data = await r.json();

    if (!data.ok) throw new Error(data.error || '搜索失败');
    if (!data.results?.length) {
      el.lyrStatus.textContent = '没找到歌词。试试只填歌名，去掉 (Live) 之类的版本标记；或者手动导入 .lrc。';
      return;
    }

    const ranked = rankLyricCandidates(data.results, {
      title, artist, duration: S.track.duration || S.ref?.duration,
    });
    const best = ranked.find(isUsableLyrics);

    if (!best) {
      const plain = ranked.find((x) => (x.plainLyrics || '').trim());
      if (plain) {
        const dur = S.track.duration || S.ref?.duration || 240;
        const lines = distributeByLines(plain.plainLyrics, dur);
        const text = lines.map((l) => `[${fmtLrcTime(l.time)}]${l.text}`).join('\n');
        await saveLyricsToTrack(text, false, 'lrclib-plain');
        el.lyrStatus.textContent = `只找到纯文本（${plain.trackName} - ${plain.artistName}），时间轴是估算的。`;
        toast('已导入纯文本歌词（时间轴为估算）', 'warn', 4000);
        return;
      }
      el.lyrStatus.textContent = '找到了同名歌曲，但都没有可用歌词。';
      return;
    }

    await saveLyricsToTrack(best.syncedLyrics, true, 'lrclib');
    el.lyrStatus.textContent =
      `✓ 已应用：${best.trackName} - ${best.artistName}`
      + `（${Math.round(best.duration || 0)}s，匹配度 ${best._score}）`;
    toast('歌词已就位，可以跟唱了', 'ok', 2600);
  } catch (e) {
    el.lyrStatus.textContent = '搜索失败：' + e.message;
    toast('找歌词失败：' + e.message, 'err', 4000);
  } finally {
    el.btnFetchLyrics.disabled = false;
  }
}

function fmtLrcTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

async function importLrcFile(file) {
  if (!S.track) { toast('先选一首歌', 'err'); return; }
  try {
    const text = await readTextSmart(file);
    const lines = parseLRC(text);
    if (!lines.length) {
      toast('这个文件里没有 [mm:ss.xx] 时间戳，不是标准 LRC', 'err', 4500);
      el.lyrStatus.textContent = '解析失败：没找到时间戳格式。';
      return;
    }
    const norm = lines.map((l) => `[${fmtLrcTime(l.time)}]${l.text}`).join('\n');
    await saveLyricsToTrack(norm, true, 'lrc-file');
    el.lyrStatus.textContent = `✓ 已导入 ${lines.length} 行歌词`;
    toast(`已导入 ${lines.length} 行歌词`, 'ok');
  } catch (e) {
    toast('导入失败：' + e.message, 'err');
  }
}

/** 读文本，自动处理 GBK 等常见中文编码 */
async function readTextSmart(file) {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try { return new TextDecoder('gbk').decode(buf); }
    catch { return new TextDecoder('utf-8').decode(buf); }
  }
}

function openLyricsEditor() {
  const ly = currentLyrics();
  el.lyrEditor.value = ly?.text || '';
  el.lyrEditor.hidden = false;
  el.lyrEditorActions.hidden = false;
  el.lyrEditor.focus();
  el.lyrStatus.textContent = '格式：[00:12.34]歌词内容，每行一句。没有时间戳会自动按行数估算。';
}

async function saveLyricsEditor() {
  const text = el.lyrEditor.value.trim();
  if (!text) { el.lyrStatus.textContent = '内容是空的，没保存。'; return; }

  const lines = parseLRC(text);
  const synced = lines.length > 0;
  let finalText = text;

  if (!synced) {
    const dur = S.track?.duration || S.ref?.duration || 240;
    const est = distributeByLines(text, dur);
    finalText = est.map((l) => `[${fmtLrcTime(l.time)}]${l.text}`).join('\n');
  }

  await saveLyricsToTrack(finalText, true, 'manual');
  el.lyrEditor.hidden = true;
  el.lyrEditorActions.hidden = true;
  el.lyrStatus.textContent = synced
    ? `✓ 已保存 ${lines.length} 行（带时间戳）`
    : '✓ 已保存（时间轴按行数估算）';
  toast('歌词已保存', 'ok');
}

async function clearLyrics() {
  if (!S.track) return;
  if (!confirm('清除这首歌的歌词？')) return;

  S.track.lyrics = null;
  const idx = S.customTracks.findIndex((x) => x.id === S.track.id);
  if (idx >= 0) {
    delete S.customTracks[idx].lyrics;
    await addTrack(S.customTracks[idx]);
  }
  S._lyrCache = null;
  updateLyricsUI();
  renderAllTracks();
  el.lyrStatus.textContent = '歌词已清除。';
  toast('已清除', '', 1500);
}

/* ══════════════════════ 教唱工作流（录入参考人声 → 清唱跟练）══════════════════════ */

/** 教唱清唱跟练时的逐字参考条显示（用清唱真实时间轴） */
function updateVocalPracticeDisplay(vt) {
  if (!S.lyricUnits || !S.lyricUnits.length) return;
  const units = S.lyricUnits;
  let curIdx = -1;
  for (let i = 0; i < units.length; i++) {
    if (vt >= units[i].start && vt < units[i].end) { curIdx = i; break; }
  }
  if (curIdx < 0) {
    for (let i = 0; i < units.length; i++) {
      if (vt < units[i].start) { curIdx = i; break; }
    }
  }
  const cur = units[curIdx] || units[units.length - 1];
  const prev = units[curIdx - 1];
  const next = units[curIdx + 1];
  if (el.lyricsStrip) {
    el.lyricsStrip.hidden = false;
    el.lyrPrev.textContent = prev ? prev.char : '';
    el.lyrCurText.textContent = cur ? (cur.char + (cur.midi != null ? ` (${midiToName(cur.midi)})` : '')) : '—';
    el.lyrNext.textContent = next ? next.char : '';
    let prog = 0;
    if (cur && vt >= cur.start && cur.end > cur.start) {
      prog = Math.max(0, Math.min(1, (vt - cur.start) / (cur.end - cur.start)));
    }
    if (el.lyrProgressFill) el.lyrProgressFill.style.width = (prog * 100).toFixed(1) + '%';
  }
}

/**
 * 把一段纯人声录音解析成"参考旋律 + 逐字谱子"
 * @param {Blob} blob 参考人声录音（webm/opus 等，来自 TakeRecorder）
 * @param {Array} frames 并行记录的音高帧 {t,midi,voiced,rms}
 * @param {string} title
 */
async function buildVocalRef(blob, frames, title) {
  el.vocalStatus.textContent = '正在解析参考人声的旋律…';
  // 优先用离线重分析整段录音（更稳），没有可用时退回实时帧
  let analyzed = null;
  if (blob && blob.size) {
    try {
      const ctx = await S.engine.ensureContext();
      const buffer = await blob.arrayBuffer().then((ab) => ctx.decodeAudioData(ab));
      const fr = await analyzeBuffer(ctx, buffer, { hopSec: 0.01, minConfidence: 0.4, progress: (p) => {
        if (p < 1) el.vocalStatus.textContent = `解析旋律 ${Math.round(p * 100)}%`;
      } });
      analyzed = fr;
    } catch (e) {
      console.warn('离线解析失败，用实时帧', e);
    }
  }
  const src = (analyzed && analyzed.length ? analyzed : frames);
  const { ref, notes } = analyzeVocal(src, { title, snap: true, snapAmount: 0.55 });
  return { ref, notes, frames: src };
}

/**
 * 把当前曲目的歌词对齐到参考人声，产出逐字谱子
 */
function alignCurrentLyricsToVocal() {
  const ly = currentLyrics();
  if (!ly || !ly.text || !S.refVocal) {
    toast('先录入参考人声，并准备好歌词', 'err');
    return null;
  }
  const units = alignLyricsToVocal(ly.text, S.refVocal.ref, S.refVocal.ref.duration);
  S.lyricUnits = units;
  return units;
}

/**
 * 步骤1：录入参考人声（从一次录音结果建立 vocalRef）
 * 复用 startRecording/stopRecording 的 TakeRecorder 产物。
 */
async function startVocalCapture() {
  if (!S.track) { toast('先选一首歌（或新建一条教唱）', 'err'); return; }
  S.vocalMode = true;
  S.vocalStep = 'analyze';
  updateVocalUI();
  toast('请清唱/朗读这一段的纯人声，录完点「停止录音」', 'ok', 3000);
  // 确保麦克风在录
  if (!S.micOn) { await enableMic(); if (!S.micOn) return; }
  await startRecording();
}

/**
 * 在录音结束后把这次录音转成参考人声
 * （由 stopRecording 链条调用：若本次处于 vocalStep==='analyze'）
 */
async function commitVocalCapture(blob, frames) {
  const v = await buildVocalRef(blob, frames, S.track?.title || '参考人声');
  S.refVocal = v;
  S.ref = v.ref;
  S.vocalStep = 'align';
  roll.setReference(v.ref);
  applyTransposeToView();
  updateRangeLabel();
  updateVocalUI();
  el.vocalStatus.textContent = `✓ 已解析 ${v.notes.length} 个音 · 时长 ${fmtTime(v.ref.duration)}。现在填歌词或自动找歌词，然后点「对齐歌词」。`;
  toast('参考人声解析完成', 'ok');
  // 持久化到 track（存不下 blob 本身，但存解析结构）
  await persistVocalRef();
}

/** 把 vocalRef / lyricUnits 序列化进当前 track 并存库 */
async function persistVocalRef() {
  if (!S.track || S.track.kind !== 'custom') return;
  const t = S.customTracks.find((x) => x.id === S.track.id);
  if (!t) return;
  if (S.refVocal) {
    t.vocalRef = {
      duration: S.refVocal.ref.duration,
      hop: S.refVocal.ref.hop,
      midi: Array.from(S.refVocal.ref.midi),
      voiced: Array.from(S.refVocal.ref.voiced),
      notes: S.refVocal.notes,
      source: 'vocal',
    };
  }
  if (S.lyricUnits) {
    t.vocalUnits = S.lyricUnits.map((u) => ({
      char: u.char, start: u.start, end: u.end, midi: u.midi,
      lineIndex: u.lineIndex, isRest: u.isRest,
    }));
  }
  await addTrack(t);
  renderAllTracks();
}

/**
 * 步骤2：对齐歌词 → 进入清唱跟练
 */
function enterPractice() {
  if (!S.refVocal) { toast('先录入参考人声', 'err'); return; }
  const units = S.lyricUnits || alignCurrentLyricsToVocal();
  if (!units || !units.length) {
    toast('没有可用的歌词来对齐', 'err');
    return;
  }
  S.lyricUnits = units;
  S.vocalStep = 'practice';
  S.vocalMode = true;
  S.vocalResult = null;
  S.vocalStartWall = null; // 在开始录音时记录
  updateVocalUI();
  // 自动把参考旋律铺到卷帘，并把歌词条打开，方便跟唱
  roll.setReference(S.refVocal.ref);
  applyTransposeToView();
  el.lyricsStrip.hidden = !(units && units.length);
  toast('开始清唱！唱完点「停止录音」看每个字的点评', 'ok', 3200);
  persistVocalRef();
}

/** 清唱结束 → 逐字打分并展示 */
function commitPractice(blob, frames) {
  if (!S.lyricUnits) { toast('还没有对齐歌词', 'err'); return; }
  const r = scoreVocalTake(S.lyricUnits, frames, { mode: SCORE_MODES[S.settings.scoreMode] });
  S.vocalResult = r;
  S.vocalStep = 'result';
  updateVocalUI();
  renderVocalResult(r);
  toast(`清唱完成 · 准音率 ${Math.round(r.accuracy * 100)}%`, 'ok', 3000);
}

/** 渲染逐字点评面板 */
function renderVocalResult(r) {
  const wrap = el.vocalResultList;
  if (!wrap) return;
  wrap.innerHTML = '';
  for (const u of r.units) {
    const row = document.createElement('div');
    row.className = 'vocal-unit' + (u.status === 'missed' ? ' missed' : u.status === 'rest' ? ' rest' : ' ' + (u.band || ''));
    const txt = u.status === 'rest' ? '（间奏）'
      : u.status === 'missed' ? '没唱到'
      : vocalUnitText(u, r.tol);
    row.innerHTML = `
      <span class="v-unit-char">${escapeHtml(u.char)}</span>
      <span class="v-unit-pitch">${u.midi != null ? midiToName(u.midi) : '—'}</span>
      <span class="v-unit-text">${escapeHtml(txt)}</span>
    `;
    wrap.appendChild(row);
  }
  el.vocalSummary.textContent =
    `总分 ${r.totalScore} · 准音率 ${Math.round(r.accuracy * 100)}%`
    + ` · 唱到 ${r.sung}/${r.total} 字`
    + (r.missed ? ` · 漏 ${r.missed}` : '')
    + (r.early || r.late ? ` · 早 ${r.early} / 晚 ${r.late}` : '')
    + ` · 平均偏差 ${Math.round(r.meanAbsCents)}¢`;
}

/** 根据 vocalStep 切换各按钮/面板状态 */
function updateVocalUI() {
  const step = S.vocalStep;
  const hasRef = !!S.refVocal;
  const hasUnits = !!S.lyricUnits && S.lyricUnits.length > 0;
  if (el.btnVocalCapture) {
    el.btnVocalCapture.disabled = !S.track || step === 'analyze' || step === 'practice';
    el.btnVocalCapture.textContent = hasRef ? '重新录入参考人声' : '① 录入参考人声';
  }
  if (el.btnVocalAlign) {
    el.btnVocalAlign.disabled = !hasRef;
    el.btnVocalAlign.textContent = hasUnits ? '重新对齐歌词' : '② 对齐歌词';
  }
  if (el.btnVocalPractice) {
    el.btnVocalPractice.disabled = !hasUnits || step === 'analyze' || step === 'practice';
    el.btnVocalPractice.textContent = '③ 开始清唱跟练';
  }
  if (el.vocalPanel) el.vocalPanel.classList.toggle('hidden', !(S.vocalMode || hasRef));
  if (el.vocalResultWrap) el.vocalResultWrap.classList.toggle('hidden', step !== 'result');
  if (el.vocalStatus && !el.vocalStatus.textContent) {
    el.vocalStatus.textContent = hasRef
      ? '已录入参考人声，填歌词后点「对齐歌词」。'
      : '这是「教唱」模式：先录一段纯人声作为参考，再清唱跟练，逐字点评高/低、快/慢。';
  }
}

/** 参考轨道 ↔ 可存储格式 */
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

/** 从持久化的 vocalRef 数据还原运行期对象 */
function restoreVocalRef(d) {
  if (!d) return null;
  return {
    ref: new Reference({
      title: '参考人声',
      duration: d.duration,
      hop: d.hop,
      midi: new Float32Array(d.midi),
      voiced: new Uint8Array(d.voiced),
      energy: d.energy ? new Float32Array(d.energy) : null,
      notes: d.notes,
      source: 'vocal',
    }),
    notes: d.notes || [],
    frames: [],
  };
}

/* ══════════════════════ 渲染 ══════════════════════ */

function renderTrackStrip() {
  el.trackStrip.innerHTML = '';
  for (const t of visibleTracks()) {
    const d = document.createElement('button');
    d.className = 'track-card' + (S.track?.id === t.id ? ' active' : '');
    d.innerHTML = `<b>${escapeHtml(t.title)}</b><small>${escapeHtml(t.subtitle || '')}</small>`;
    d.addEventListener('click', () => selectTrack(t.id));
    el.trackStrip.appendChild(d);
  }
}

/* ── 统一曲库（内置 + 导入，合并成一个列表）── */

const LibFilter = { mode: 'all', keyword: '' };

/** 内置曲目"删除"= 记进隐藏名单（可恢复），导入曲目则是真删 */
const LS_HIDDEN_BUILTIN = 'pc.hiddenBuiltin.v1';

function loadHiddenBuiltin() {
  try { return new Set(JSON.parse(localStorage.getItem(LS_HIDDEN_BUILTIN) || '[]')); }
  catch { return new Set(); }
}
function saveHiddenBuiltin(set) {
  try { localStorage.setItem(LS_HIDDEN_BUILTIN, JSON.stringify([...set])); } catch { /* noop */ }
}

/** 所有可见曲目（内置 + 导入，排除已隐藏的内置） */
function visibleTracks() {
  const hidden = loadHiddenBuiltin();
  const builtins = DEMO_TRACKS
    .filter((t) => !hidden.has(t.id))
    .map((t) => ({ ...t, kind: 'builtin' }));
  return [...builtins, ...S.customTracks];
}

/** 判断一条曲目是否"有问题"，没问题返回 null */
function trackIssue(t) {
  if (t.kind === 'builtin') return null;
  const isMidi = t.refData?.source === 'midi';
  if (isMidi) return null;
  // 教唱参考人声：即便没有音频 Blob（仅存了旋律），也不算失效
  if (t.refData?.source === 'vocal' || t.vocalRef) {
    if (t.vocalRef && t.vocalRef.midi && t.vocalRef.midi.length) return null;
    if (!(t.audioBlob instanceof Blob)) return '音频缺失';
    return null;
  }
  if (!(t.audioBlob instanceof Blob)) return '音频缺失';
  if (!t.refData) return '旋律未解析';
  return null;
}

function renderAllTracks() {
  const all = visibleTracks();
  const kw = LibFilter.keyword.toLowerCase();

  const list = all.filter((t) => {
    if (LibFilter.mode === 'builtin' && t.kind !== 'builtin') return false;
    if (LibFilter.mode === 'custom' && t.kind !== 'custom') return false;
    if (LibFilter.mode === 'broken' && !trackIssue(t)) return false;
    if (kw && !String(t.title).toLowerCase().includes(kw)) return false;
    return true;
  });

  if (el.libTotalCount) el.libTotalCount.textContent = all.length;

  const brokenCount = all.filter((t) => trackIssue(t)).length;
  if (el.btnClearBroken) {
    el.btnClearBroken.hidden = brokenCount === 0;
    if (brokenCount) el.btnClearBroken.textContent = `一键清理失效曲目 (${brokenCount})`;
  }

  if (!all.length) {
    el.allTracksList.innerHTML = '<div class="empty">曲库是空的。用右边的「扫描本地音乐库」导入，或刷新页面恢复内置练习曲。</div>';
    return;
  }
  if (!list.length) {
    el.allTracksList.innerHTML = '<div class="empty">没有匹配的曲目</div>';
    return;
  }

  el.allTracksList.innerHTML = '';
  for (const t of list) {
    const isBuiltin = t.kind === 'builtin';
    const issue = trackIssue(t);

    const row = document.createElement('div');
    row.className = 'lib-item' + (S.track?.id === t.id ? ' active' : '');
    if (issue) row.classList.add('broken');

    const icon = isBuiltin ? '🎼' : (t.refData?.source === 'midi' ? '🎹' : '🎵');
    const dur = t.duration ? fmtTime(t.duration) : '';

    row.innerHTML = `
      <div class="lib-icon">${icon}</div>
      <div class="lib-info">
        <b>${escapeHtml(t.title)}</b>
        <small>${escapeHtml(t.subtitle || '')}${dur ? ' · ' + dur : ''}</small>
      </div>
    `;

    const badge = document.createElement('span');
    badge.className = 'lib-src ' + (isBuiltin ? 'src-builtin' : 'src-custom');
    badge.textContent = isBuiltin ? '内置' : '导入';
    row.appendChild(badge);

    if (t.lyrics && t.lyrics.text) {
      const lyr = document.createElement('span');
      lyr.className = 'lib-src src-lyrics';
      lyr.textContent = t.lyrics.synced ? '有歌词' : '歌词';
      lyr.title = t.lyrics.synced ? '有同步歌词，可跟唱' : '只有纯文本歌词（时间轴是估算的）';
      row.appendChild(lyr);
    }

    if (issue) {
      const warn = document.createElement('span');
      warn.className = 'scan-tag';
      warn.textContent = issue;
      warn.title = issue === '音频缺失'
        ? '音频文件丢了（旧版本只存了旋律线）。删掉这条，重新导入一次。'
        : '旋律还没解析出来，重新导入一次。';
      row.appendChild(warn);
    }

    const del = document.createElement('button');
    del.className = 'take-del';
    del.textContent = '✕';
    del.title = isBuiltin ? '从列表移除（刷新可恢复）' : '永久删除（含音频与歌词）';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteTrack(t);
    });
    row.appendChild(del);

    row.addEventListener('click', (e) => {
      if (e.target.classList.contains('take-del')) return;
      selectTrack(t.id);
      switchView('live');
    });

    el.allTracksList.appendChild(row);
  }
}

/** 删除一条曲目（内置=隐藏可恢复，导入=彻底删除） */
async function deleteTrack(t) {
  const isBuiltin = t.kind === 'builtin';
  const msg = isBuiltin
    ? `从列表移除「${t.title}」？\n\n这是内置练习曲，刷新页面可以恢复。`
    : `删除「${t.title}」？\n\n音频和歌词会一起删掉，不可恢复。`;
  if (!confirm(msg)) return;

  if (isBuiltin) {
    const hidden = loadHiddenBuiltin();
    hidden.add(t.id);
    saveHiddenBuiltin(hidden);
  } else {
    S.customTracks = await removeTrack(t.id);
  }

  if (S.track?.id === t.id) {
    if (S.audioEl) { try { S.audioEl.pause(); } catch { /* noop */ } }
    if (S.audioUrl) { URL.revokeObjectURL(S.audioUrl); S.audioUrl = null; }
    const next = visibleTracks()[0];
    if (next) selectTrack(next.id);
  }

  renderAllTracks();
  renderTrackStrip();
  toast(isBuiltin ? '已移除（刷新可恢复）' : '已删除', '', 1800);
}

/** 一键清理所有失效曲目 */
async function clearBrokenTracks() {
  const broken = visibleTracks().filter((t) => trackIssue(t));
  if (!broken.length) return;
  if (!confirm(`找到 ${broken.length} 条失效曲目，全部删除？\n\n这些曲目的音频已经丢了，只能重新导入。`)) return;

  for (const t of broken) {
    if (t.kind === 'builtin') {
      const hidden = loadHiddenBuiltin();
      hidden.add(t.id);
      saveHiddenBuiltin(hidden);
    } else {
      S.customTracks = await removeTrack(t.id);
    }
  }
  renderAllTracks();
  renderTrackStrip();
  toast(`已清理 ${broken.length} 条`, 'ok');
}

/**
 * 兼容壳：曲库渲染已统一到 renderAllTracks（支持删除内置曲目、
 * 歌词状态标记、失效曲目清理）。旧调用点仍指向这里。
 */
function renderLibrary() { renderAllTracks(); }
function renderBuiltinList() { renderAllTracks(); }
function renderCustomList() { renderAllTracks(); }


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
  el.btnMicOff.addEventListener('click', disableMic);
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
    // 立即作用于正在播放的音频，而不是等下次
    if (S.audioEl) {
      S.audioEl.muted = !el.cbReference.checked;
      S.audioEl.volume = el.cbReference.checked ? S.settings.referenceVolume : 0;
    }
    if (S.synth) {
      S.synth.gain.gain.value = el.cbReference.checked ? S.settings.referenceVolume : 0;
    }
    toast(el.cbReference.checked ? '参考音已开启' : '参考音已静音（只听自己）', '', 1800);
  });

  // 复盘：录音回放（带停止）
  el.btnPlayTake.addEventListener('click', async () => {
    // 正在播 → 再点一次就停
    if (S.takeAudio && !S.takeAudio.paused) {
      stopTakePlayback();
      return;
    }
    if (!reviewTakeObj?.hasAudio) {
      toast('这条录音没有音频（只有音高数据）', 'err');
      return;
    }
    const blob = await getTakeAudio(reviewTakeObj.id);
    if (!blob) { toast('找不到音频文件', 'err'); return; }

    stopTakePlayback();                       // 先清掉上一条
    const url = URL.createObjectURL(blob);
    const a = new Audio(url);
    S.takeAudio = a;
    S.takeAudioUrl = url;

    a.onended = () => stopTakePlayback();
    a.onerror = () => {
      toast('播放失败，文件可能已损坏', 'err');
      stopTakePlayback();
    };

    try {
      await a.play();
      el.btnPlayTake.textContent = '■ 停止播放';
      el.btnPlayTake.classList.add('primary');
      el.btnStopTake.disabled = false;
    } catch (e) {
      toast('播放被拦截，请再点一次', 'err');
      stopTakePlayback();
    }
  });

  el.btnStopTake.addEventListener('click', stopTakePlayback);

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
    const files = [...(el.fileInput.files || [])];
    el.fileInput.value = '';
    if (!files.length) return;
    if (files.length === 1) {
      handleFile(files[0]);
    } else {
      // 多选：走批量
      (async () => {
        el.importProgress.hidden = false;
        let ok = 0, fail = 0;
        for (let i = 0; i < files.length; i++) {
          el.importBar.style.width = Math.round((i / files.length) * 100) + '%';
          el.importStatus.textContent = `(${i + 1}/${files.length}) ${files[i].name}`;
          try {
            const t = await buildTrackFromBlob(files[i], {
              title: files[i].name,
              mode: el.importMode.value,
              range: el.importRange.value,
              snap: el.importSnap.checked,
            });
            S.customTracks = await addTrack(t);
            ok++;
          } catch (e) {
            fail++;
            console.warn('import fail', files[i].name, e);
          }
        }
        el.importBar.style.width = '100%';
        el.importStatus.textContent = `完成：${ok} 成功${fail ? `，${fail} 失败` : ''}`;
        renderCustomList();
        renderTrackStrip();
        toast(`导入 ${ok} 个${fail ? `，${fail} 个失败` : ''}`, ok ? 'ok' : 'err');
        setTimeout(() => { el.importProgress.hidden = true; }, 2200);
      })();
    }
  });

  // ── 曲库：搜索 / 筛选 / 清理失效 ──
  if (el.libFilter) {
    el.libFilter.addEventListener('input', () => {
      LibView.keyword = el.libFilter.value;
      renderLibrary();
    });
  }
  document.querySelectorAll('[data-libfilter]').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('[data-libfilter]').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      LibView.filter = b.dataset.libfilter;
      renderLibrary();
    });
  });
  if (el.btnClearBroken) {
    el.btnClearBroken.addEventListener('click', async () => {
      const broken = allTracks().filter(trackIsBroken);
      if (!broken.length) return;
      if (!confirm(`清理 ${broken.length} 条音频丢失的曲目？\n（内置曲目和 MIDI 不受影响）`)) return;
      for (const t of broken) {
        S.customTracks = await removeTrack(t.id);
      }
      if (S.track && trackIsBroken(S.track)) selectTrack(DEMO_TRACKS[0].id);
      renderLibrary();
      renderTrackStrip();
      toast(`已清理 ${broken.length} 条`, 'ok', 2000);
    });
  }

  // ── 本地音乐库扫描 ──
  el.btnScanLib.addEventListener('click', () => {
    if (!SEP.checked) checkSepCapability();
    scanLocalLibrary();
  });

  // ── 统一曲库：搜索、筛选、清理 ──
  if (el.libFilter) {
    el.libFilter.addEventListener('input', () => {
      LibFilter.keyword = el.libFilter.value || '';
      renderAllTracks();
    });
  }
  document.querySelectorAll('[data-libfilter]').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('[data-libfilter]').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      LibFilter.mode = b.dataset.libfilter;
      renderAllTracks();
    });
  });
  if (el.btnClearBroken) {
    el.btnClearBroken.addEventListener('click', clearBrokenTracks);
  }

  // ── 歌词 ──
  if (el.btnFetchLyrics) {
    el.btnFetchLyrics.addEventListener('click', fetchLyricsForCurrent);
  }
  if (el.btnImportLrc) {
    el.btnImportLrc.addEventListener('click', () => el.lrcFileInput.click());
  }
  if (el.lrcFileInput) {
    el.lrcFileInput.addEventListener('change', () => {
      const f = el.lrcFileInput.files?.[0];
      el.lrcFileInput.value = '';
      if (f) importLrcFile(f);
    });
  }
  if (el.btnEditLyrics) {
    el.btnEditLyrics.addEventListener('click', openLyricsEditor);
  }
  if (el.btnSaveLyrics) {
    el.btnSaveLyrics.addEventListener('click', saveLyricsEditor);
  }
  if (el.btnCancelLyrics) {
    el.btnCancelLyrics.addEventListener('click', () => {
      el.lyrEditor.hidden = true;
      el.lyrEditorActions.hidden = true;
      el.lyrStatus.textContent = '已取消编辑。';
    });
  }
  if (el.btnClearLyrics) {
    el.btnClearLyrics.addEventListener('click', clearLyrics);

  // 教唱工作流
  if (el.btnVocalCapture) el.btnVocalCapture.addEventListener('click', startVocalCapture);
  if (el.btnVocalAlign) el.btnVocalAlign.addEventListener('click', () => { alignCurrentLyricsToVocal(); enterPractice(); });
  if (el.btnVocalPractice) el.btnVocalPractice.addEventListener('click', enterPractice);
  }

  el.sepEnabled.addEventListener('change', () => {
    if (el.sepEnabled.checked) {
      toast('已开启人声分离：每个文件会多花 2-4 倍时长处理', '', 3200);
    }
  });
  el.btnScanRescan.addEventListener('click', () => scanLocalLibrary(true));
  el.btnScanClose.addEventListener('click', () => {
    el.libScanPanel.hidden = true;
    el.importArea.hidden = false;
  });
  el.libScanFilter.addEventListener('input', renderScanList);
  el.libScanSelectAll.addEventListener('change', () => {
    const visible = LibScan.items.filter((i) => !i.encrypted);
    if (el.libScanSelectAll.checked) {
      for (const it of visible) LibScan.selected.add(it.path);
    } else {
      LibScan.selected.clear();
    }
    renderScanList();
  });
  el.btnImportSelected.addEventListener('click', importSelected);
  ['dragenter', 'dragover'].forEach((ev) => {
    el.dropZone.addEventListener(ev, (e) => { e.preventDefault(); el.dropZone.classList.add('hover'); });
  });
  ['dragleave', 'drop'].forEach((ev) => {
    el.dropZone.addEventListener(ev, (e) => { e.preventDefault(); el.dropZone.classList.remove('hover'); });
  });
  el.dropZone.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    if (files.length === 1) {
      handleFile(files[0]);
    } else {
      // 多文件拖入：逐个导入
      (async () => {
        el.importProgress.hidden = false;
        let ok = 0, fail = 0;
        for (let i = 0; i < files.length; i++) {
          el.importBar.style.width = Math.round((i / files.length) * 100) + '%';
          el.importStatus.textContent = `(${i + 1}/${files.length}) ${files[i].name}`;
          try {
            const t = await buildTrackFromBlob(files[i], {
              title: files[i].name,
              mode: el.importMode.value,
              range: el.importRange.value,
              snap: el.importSnap.checked,
            });
            S.customTracks = await addTrack(t);
            ok++;
          } catch (err) { fail++; }
        }
        el.importBar.style.width = '100%';
        el.importStatus.textContent = `完成：${ok} 成功${fail ? `，${fail} 失败` : ''}`;
        renderCustomList();
        renderTrackStrip();
        toast(`导入 ${ok} 个${fail ? `，${fail} 个失败` : ''}`, ok ? 'ok' : 'err');
        setTimeout(() => { el.importProgress.hidden = true; }, 2200);
      })();
    }
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

  S.customTracks = await loadTracksWithAudio();
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

  // 后台探测人声分离能力（不影响首屏）
  checkSepCapability().catch(() => {});

  // 截图/调试用
  window.__PC = {
    S, roll, gauge, reviewRoll, selectTrack, play, stopPlayback,
    updateHint,
    // 供自动化测试：完整跑一遍导入流程
    async importForTest(file, opts = {}) {
      const t = await buildTrackFromBlob(file, opts);
      S.customTracks = await addTrack(t);
      renderCustomList();
      renderTrackStrip();
      return t;
    },
    // 供自动化测试：注入一首自定义曲目（可带真实歌名/歌手去验证歌词流程）
    injectTestTrack({ title, artist, duration = 240 } = {}) {
      const id = 'test-' + Date.now() + '-' + Math.floor(Math.random() * 1e4);
      const t = {
        id, kind: 'custom', title, subtitle: artist || '',
        duration, refData: { source: 'midi', notes: [] }, audioBlob: null,
      };
      S.customTracks = [...S.customTracks, t];
      // 直接选中（绕过 selectTrack 的列表查找，确保测试曲目一定被选中）
      S.track = t;
      el.trackTitle.textContent = t.title;
      el.trackSub.textContent = t.subtitle || '自选曲目';
      S.ref = null;
      roll.setReference(null);
      renderAllTracks();
      renderTrackStrip();
      updateLyricsUI();
      return t;
    },
    // 供自动化测试：在指定歌曲时刻更新并读取动态歌词
    showLyricsAt(t, forceShow = false) {
      if (forceShow && el.lyricsStrip) el.lyricsStrip.hidden = false;
      updateLyricsDisplay(t);
      return {
        cur: document.getElementById('lyrCurText').textContent,
        prev: document.getElementById('lyrPrev').textContent,
        next: document.getElementById('lyrNext').textContent,
        progress: document.getElementById('lyrProgressFill').style.width,
        hidden: el.lyricsStrip?.hidden,
      };
    },
    getLyricsState() {
      return {
        state: (document.getElementById('lyrState') || {}).textContent,
        stripHidden: document.getElementById('lyricsStrip')?.hidden,
        curText: document.getElementById('lyrCurText')?.textContent,
        trackHasLyrics: !!(S.track && S.track.lyrics && S.track.lyrics.text),
      };
    },
    // 供自动化测试注入轨迹
    setTakeForView(frames, score) {
      const withBand = frames.map((f, i) => ({ ...f, band: score.bands[i] }));
      roll.setTake({ frames: withBand, offset: 0, phraseScores: score.phraseScores });
      roll.setReview(S.ref.duration);
      el.rollHint.classList.add('hidden');
      roll.draw();
    },
    // ── 教唱工作流测试钩子 ──
    // 注入一段参考人声帧并解析（绕过麦克风录音）
    buildVocalRefFromFrames(frames, title = 'ref') {
      return commitVocalCapture({ blob: null, duration: 0, frames: [] }, frames);
    },
    // 设置当前曲目的歌词文本（供对齐用）
    setTestLyrics(text) {
      if (!S.track) return false;
      const t = S.customTracks.find((x) => x.id === S.track.id) || S.track;
      t.lyrics = { text, synced: text.includes('['), source: 'test' };
      S._lyrCache = null;
      updateLyricsUI();
      return true;
    },
    // 注入清唱帧并评分（绕过麦克风录音）
    scorePracticeFromFrames(frames) {
      if (!S.lyricUnits) return null;
      commitPractice({ blob: null, duration: 0, frames: [] }, frames);
      return S.vocalResult;
    },
    getVocalState() {
      return {
        step: S.vocalStep,
        hasRef: !!S.refVocal,
        hasUnits: !!(S.lyricUnits && S.lyricUnits.length),
        units: S.lyricUnits,
        result: S.vocalResult,
        btnCapture: el.btnVocalCapture?.textContent,
        btnAlign: el.btnVocalAlign?.textContent,
        btnPractice: el.btnVocalPractice?.textContent,
        panelHidden: el.vocalPanel?.classList.contains('hidden'),
        resultHidden: el.vocalResultWrap?.classList.contains('hidden'),
        summary: el.vocalSummary?.textContent,
      };
    },
  };
  console.log('[PitchCoach] ready');
}

init().catch((e) => {
  console.error(e);
  toast('初始化失败：' + e.message, 'err', 8000);
});
