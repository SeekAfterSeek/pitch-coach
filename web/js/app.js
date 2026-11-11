/**
 * 人声对比工作室 —— 主控制器
 * ═══════════════════════════════════════════════════════════
 * 产品逻辑：
 *   ① 上来第一个按钮「录入参考人声」→ 录完自动解析
 *      → 解析结果【只显示三块】：调性（什么调）/ 歌词（可编辑）/ 简谱
 *   ② 「练唱开始」→ 像全民K歌：3-2-1 倒计时、逐字显示歌词+简谱+节拍
 *      → 「停止录音」→ 自动对比
 *      → 结果【只显示一篇歌词】：每字上下两排（原唱简谱 / 我唱简谱）+ 高了低了快了慢了
 *   ③ 所有录音进历史；任意两段可互选 A/B 对比
 *
 * 复用底层：audio.js、compare.js、notation.js、practice.js、history.js、util.js
 */

import { AudioEngine, TakeRecorder, decodeFile, analyzeBuffer, playMidiTone, estimateAudioStartOffset } from './audio.js';
import { parseVocal } from './compare.js';
import {
  detectKey, buildScore, flattenScore, jianpuHtml, jianpuTitle,
  placeholderLyrics, groupPhrases, scoreCharMap,
} from './notation.js';
import { scorePracticeWords, groupWordsByLine, lineSummary } from './practice.js';
import { alignTextToPhrases, realignLyricsToScore, cleanLyricChars } from './lyrics.js';
import { startSpeech, speechAvailable } from './speech.js';
import {
  identifySong, searchLyrics, searchLyricsByQuery, getLyricsById,
  getAuddToken, setAuddToken, splitSongLines, lrcToPlainLines,
} from './song-identify.js';
import { uid, fmtTime, clamp } from './util.js';
import {
  saveVocal, listVocals, getVocal, getVocalAudio,
  renameVocal, deleteVocal, clearVocals, vocalSubtitle,
  saveVocalSnapshot, getVocalSnapshot, rewriteFrames,
} from './history.js';

/* ══════════════════ 状态 ══════════════════ */

const S = {
  phase: 'idle',        // idle | rec-ref | parse-ref | ready | rec-practice | parse-practice | result
  micOn: false,
  engine: null,
  recorder: null,
  recKind: null,        // 'ref' | 'practice'
  recRAF: 0,
  recStartCtx: 0,
  tol: 50,

  refVocal: null,       // 当前参考历史记录（含 frames）
  refBlob: null,        // 刚录进去的参考原声 Blob（解析卡里能播放）
  parsed: null,         // { ref, notes, frames, duration, silent }
  key: null,            // detectKey 结果
  lyricText: '',        // 用户编辑的歌词（按行）
  score: null,          // buildScore 结果（逐字谱）
  charMap: null,        // 按音符全局顺序的逐字歌词（精确钉字）
  lineBreaks: null,     // 按用户标点的排版行切点（音符全局索引）
  groups: null,         // groupPhrases(parsed.notes) 结果（节奏骨架，重排用）
  lyricsDraft: '',      // 编辑框里的草稿（未确定）
  lyricsConfirmed: false,
  speech: null,         // 录音期间的语音识别控制器
  speechText: '',       // 本轮识别到的歌词文本

  lastPractice: null,   // { words, byLine, summary }
  lastPair: { a: null, b: null },

  history: [],
  pair: { a: null, b: null },

  audio: null,
  audioUrl: null,
  countdown: 0,        // 练唱倒计时剩余秒
  countdownRAF: 0,
  refAudioOffset: 0,   // 录下音频起点相对音高帧时间轴的偏移（秒）
  // 解析卡里播放"刚录的原声"：独立播放器 + 逐音符亮格
  refAudio: null,
  refAudioUrl: null,
  refPlayRAF: 0,
  refPlaying: false,
  // 结果页小鸟音符图：当前亮起的列 + 单音试听的振荡器句柄
  nbPlayingIdx: null,
  nbPlayRAF: 0,
  toneOsc: null,
};

/* ══════════════════ DOM ══════════════════ */

const $ = (id) => document.getElementById(id);
const el = {};
function cacheEls() {
  for (const id of [
    'sessionPill','statusDot','statusText','btnMic','btnHelp',
    'stageSteps','stageHero','heroIcon','heroTitle','heroDesc','stageActions','btnRecordRef',
    'preLyricInput','btnDictate','dictateStatus',
    'recordStrip','recDot','recLabel','recTimer','micMeter','btnStopRec',
    'parseStrip','parseTitle','parseSub','parseBar',
    'parsedCard','parsedBadge','parsedTitle','parsedKey','keyName','keyJianpu',
    'btnPlayRef','btnStopRef','refPlayHint','refPlayFill',
    'lyricEditor','btnRecognize','btnRealign','btnConfirmLyrics','lyricStatus',
    'btnIdentify','songMask','btnCloseSong','songTitle','songStep','songResult','songLines',
    'btnUseLines','manualQuery','btnSearchQuery',
    'scoreInfo','jpSheet','jpCellEditor','cellHint','btnPractice','btnRerecord',
    'karaoke','kCount','kPrevLine','kCurLine','kNextLine','kProgressFill','kHint','kBirds',
    'resultWrap','resultTitle','resultSub','btnPlayA','btnPlayB','btnStopAudio','btnAgain',
    'lyricResult','noteBlocks','recSpeech','keyVerdict',
    'histCount','histSelect','selA','selB','btnComparePair','btnClearPair',
    'histList','btnImportAudio','importAudioInput','btnClearAll',
    'helpMask','btnCloseHelp','toastWrap',
  ]) el[id] = $(id);
}

/* ══════════════════ 小工具 ══════════════════ */

function toast(msg, kind = '', ms = 3200) {
  const d = document.createElement('div');
  d.className = 'toast ' + kind;
  d.textContent = msg;
  el.toastWrap.appendChild(d);
  setTimeout(() => d.remove(), ms);
}
function setStatus(text, on = false) {
  el.statusText.textContent = text;
  el.statusDot.classList.toggle('on', on);
}
function show(node, yes) {
  if (!node) return;
  if (node === el.helpMask) node.classList.toggle('open', !!yes);
  else node.classList.toggle('hidden', !yes);
}
function setStep(n) {
  el.stageSteps.querySelectorAll('.step').forEach((s) => {
    const k = Number(s.dataset.step);
    s.classList.toggle('active', k === n);
    s.classList.toggle('done', k < n);
  });
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
/** 录音帧 t 从 0 开始（AudioContext 是绝对时间） */
function normalizeFrames(frames) {
  if (!frames.length) return [];
  const t0 = frames[0].t;
  return frames.map((f) => ({ ...f, t: f.t - t0 }));
}

/* ══════════════════ 麦克风 ══════════════════ */

async function ensureMic() {
  if (S.micOn) return;
  if (!S.engine) S.engine = new AudioEngine();
  try {
    await S.engine.startMic();
    S.micOn = true;
    setStatus('麦克风已连接', true);
    el.btnMic.textContent = '麦克风已开 ✓';
    el.btnMic.disabled = true;
    el.btnMic.classList.add('ok');
  } catch (e) {
    setStatus('麦克风不可用');
    toast('无法开启麦克风：' + e.message + '（需要 https 或 localhost，并允许权限）', 'err', 6000);
    throw e;
  }
}

/* ══════════════════ 录前歌词听写（语音转文字） ══════════════════ */

let dictate = null;     // 听写控制器（不入 S，避免被 reset 清掉）
let dictateBase = '';   // 已固化的听写文本（final 句逐句累积）

/** 开/关听写：念歌词 → 自动转文字填进预填框；
 *  说完一句停一下 = 自动加标点断句（final 段落之间补逗号/句号）。 */
function toggleDictate() {
  if (dictate) {
    // 正在听写 → 停止：收尾补句号
    const t = dictate.stop();
    dictate = null;
    el.btnDictate.classList.remove('ok');
    el.btnDictate.textContent = '🎙️ 语音转文字·念歌词';
    el.dictateStatus.classList.remove('listening');
    if (el.preLyricInput) {
      let v = el.preLyricInput.value.trim();
      if (v && !/[。！？.!?]$/.test(v)) v += '。';
      el.preLyricInput.value = v;
    }
    el.dictateStatus.textContent = t ? '✓ 听写完成，可继续手动修改' : '（没识别到内容）';
    el.dictateStatus.classList.toggle('ok', !!t);
    return;
  }
  if (!speechAvailable()) {
    toast('此浏览器不支持语音识别，请手动输入歌词', 'err');
    return;
  }
  // 确保麦克风可用（听写和录音共用）
  ensureMic().then(() => {
    dictateBase = el.preLyricInput?.value.trim() || '';
    el.preLyricInput?.focus();
    dictate = startSpeech({
      onPartial: (t) => {
        el.dictateStatus.classList.add('listening');
        el.dictateStatus.textContent = `🎙️ 正在听写：${(t || '').slice(-24)}`;
        // 实时上屏：已确认部分 + 识别中的尾巴
        if (el.preLyricInput) el.preLyricInput.value = dictateBase ? dictateBase + '，' + t : (t || '');
      },
      onFinal: (t) => {
        // 一句 final 落地 → 固化成 base，下一句前面补逗号（标点断句）
        if (t) {
          dictateBase = dictateBase ? dictateBase + '，' + t : t;
          if (el.preLyricInput) el.preLyricInput.value = dictateBase;
        }
      },
      onError: (msg) => {
        if (msg === 'not-allowed' || msg === 'service-not-allowed') {
          el.dictateStatus.textContent = '麦克风权限被拒，无法听写';
        }
      },
    });
    if (dictate) {
      el.btnDictate.classList.add('ok');
      el.btnDictate.textContent = '⏹ 停止听写';
      el.dictateStatus.textContent = '🎙️ 正在听写… 念完一句停一下自动断句';
    }
  }).catch(() => {});
}

async function startRecording(kind) {
  await ensureMic();
  if (S.recorder?.active) return;
  S.recKind = kind;
  S.recorder = new TakeRecorder(S.engine);
  S.recorder.start();
  S.recStartCtx = S.recorder.t0;

  stopRefPlayback();
  show(el.recordStrip, true);
  show(el.parsedCard, false);
  show(el.resultWrap, false);
  show(el.karaoke, false);
  show(el.stageActions, false);
  el.recLabel.textContent = kind === 'ref' ? '录入参考人声…' : '练唱中…';
  S.phase = kind === 'ref' ? 'rec-ref' : 'rec-practice';
  setStep(kind === 'ref' ? 1 : 3);

  // 录参考人声时并行开语音识别，自动取到歌词；识别有动静就实时显示
  if (kind === 'ref' && speechAvailable()) {
    S.speechText = '';
    el.recSpeech.classList.remove('hidden', 'listening');
    el.recSpeech.innerHTML = '<span class="listening">🎤 正在识别歌词…（唱两句停一下识别更准；识别不到也能手填）</span>';
    S.speech = startSpeech({
      onPartial: (t) => {
        S.speechText = t;
        el.recSpeech.classList.add('listening');
        el.recSpeech.innerHTML = t ? `<b>已识别：</b>${escapeHtml(t.slice(-40))}` : '<span class="listening">🎤 正在识别歌词…</span>';
      },
      onFinal: (t) => {
        S.speechText = t;
        el.recSpeech.innerHTML = `<b>已识别：</b>${escapeHtml(t.slice(-40))}`;
      },
      onError: (msg) => {
        if (msg === 'not-allowed' || msg === 'service-not-allowed') {
          el.recSpeech.textContent = '🎤 识别权限被拒，唱完手动填歌词即可';
        } else if (msg === 'no-speech') {
          el.recSpeech.classList.add('listening');
          el.recSpeech.textContent = '🎤 没听到唱词（长间隔正常，会自动续听）…';
        }
      },
    });
  }

  if (kind === 'practice') {
    // 进入练唱：先铺上原唱鸟起伏图（歌词高低起伏一眼可见），
    // 随后逐句用三个闪烁点提示进句
    show(el.karaoke, true);
    renderKaraokeBirds();
    el.kPrevLine.innerHTML = '';
    el.kNextLine.innerHTML = '';
    el.kCurLine.innerHTML = '';
    el.kHint.textContent = '准备… 看到三个点亮起倒数，全灭就开口进句';
    el.kProgressFill.style.width = '0%';
    loop();
  } else {
    loop();
  }
}

/** 练唱视图里的原唱鸟起伏图：只画当前句 ± 前后各一句的鸟，
 *  当前句的鸟亮色大号、前后句淡化——唱到哪看哪，不被整首干扰。 */
function renderKaraokeBirds(li = 0) {
  const lines = S.score?.lines || [];
  if (!lines.length) { el.kBirds.innerHTML = ''; return; }
  const show = [li - 1, li, li + 1].filter((k) => k >= 0 && k < lines.length);
  const pxPerSec = 26;
  const beatSec = S.score?.beatSec || 0.5;
  const durPx = (ms) => clamp(Math.round((ms / 1000) / beatSec * pxPerSec), 6, 120);
  el.kBirds.innerHTML = show.map((k) => {
    const line = lines[k];
    const isCur = k === li;
    const cells = line.units.map((u) => {
      const top = birdTopPct(u.midi);
      const cloud = durPx(Math.max(1, (u.end - u.start) * 1000));
      return `<div class="k-bird-col" data-note-idx="${u.noteIdx}" data-start="${u.start}" data-end="${u.end}">
        <div class="nb-bird ref" style="top:${top}%">🐦<b class="nb-jp">${escapeHtml(u.jianpu.symbol)}</b><span class="nb-cloud ref" style="width:${cloud}px"></span></div>
        <div class="k-bird-ch">${escapeHtml(u.char || '○')}</div>
      </div>`;
    }).join('');
    return `<div class="k-bird-line${isCur ? ' cur' : ''}">${cells}</div>`;
  }).join('');
}

function loop() {
  if (!S.recorder?.active) return;
  const f = S.engine.tick();
  if (f) {
    S.recorder.push(f);
    el.micMeter.style.width = Math.round(clamp(S.engine.peakLevel() * 260, 0, 100)) + '%';
    // 帧时间戳已是"窗口中心"，与 recorder.t0 同基准，直接相减即相对录音起点的时刻，
    // 也就是与谱子（同样从录音起点起算）同一条时间轴。
    const elapsed = Math.max(0, f.t - S.recStartCtx);
    el.recTimer.textContent = fmtTime(elapsed);
    if (S.recKind === 'practice') updateKaraoke(elapsed);
  }
  S.recRAF = requestAnimationFrame(loop);
}

/** 练唱中：逐字高亮当前句，显示每字的简谱与节拍。
 *  歌词是主角：当前字大号白字放中间最亮，音符退居其上作小字提示。
 *  ★ 高亮判定用"当前时刻落在哪个音符的起止区间"——为了让短音符也不漏闪，
 *    区间在相邻音符之间做 Voronoi 外扩（不留空档），并把容差放宽到 ±80ms。 */
function updateKaraoke(vt) {
  const score = S.score;
  if (!score?.lines?.length) return;
  const lines = score.lines;

  // 找当前行
  let li = lines.findIndex((l) => vt >= l.start - 0.3 && vt < l.end + 0.3);
  if (li < 0) {
    // 还没到第一句 / 已经唱完：找下一个最近的
    li = lines.findIndex((l) => vt < l.start);
    if (li < 0) li = lines.length - 1;
  }
  const cur = lines[li], prev = lines[li - 1], next = lines[li + 1];

  /** 某个字位此刻是否是"正在唱"的那个：
   *  与相邻字位按中点划界（不留空档），再叠加 ±80ms 的容差，
   *  避免帧间隔/渲染节流导致短音符整段被跳过。 */
  const isOn = (units, j) => {
    const u = units[j];
    if (!u) return false;
    const prevU = units[j - 1];
    const nextU = units[j + 1];
    const lo = prevU ? (prevU.end + u.start) / 2 : u.start - 0.08;
    const hi = nextU ? (u.end + nextU.start) / 2 : u.end + 0.08;
    return vt >= lo - 0.08 && vt < hi;
  };

  const renderLine = (line, active) => {
    if (!line) return '';
    return line.units.map((u, j) => {
      const on = active && isOn(line.units, j);
      const done = active && vt > u.end;
      return `<span class="k-unit${on ? ' on' : ''}${done ? ' done' : ''}" title="${escapeHtml(jianpuTitle(u.jianpu))}">
        <span class="k-jp">${jianpuHtml(u.jianpu)}<i class="k-beat">${escapeHtml(u.beat)}</i></span>
        <span class="k-char">${escapeHtml(u.char || '○')}</span>
      </span>`;
    }).join('');
  };

  el.kPrevLine.innerHTML = renderLine(prev, false);
  el.kCurLine.innerHTML = renderLine(cur, true);
  el.kNextLine.innerHTML = renderLine(next, false);

  // 换句时刷新鸟图（当前句的鸟大号高亮）；句内给正在唱的那个鸟描边
  if (el.kBirds.dataset.line !== String(cur.index)) {
    renderKaraokeBirds(cur.index);
    el.kBirds.dataset.line = String(cur.index);
  }
  el.kBirds.querySelectorAll('.k-bird-col.glow').forEach((n) => n.classList.remove('glow'));
  const curIdx = cur.units.findIndex((u, j) => isOn(cur.units, j));
  const birdCol = curIdx >= 0
    ? el.kBirds.querySelector(`.k-bird-col[data-note-idx="${cur.units[curIdx].noteIdx}"]`)
    : null;
  if (birdCol) birdCol.classList.add('glow');

  // 整句进度条
  const span = Math.max(0.1, cur.end - cur.start);
  const p = clamp((vt - cur.start) / span, 0, 1);
  el.kProgressFill.style.width = (p * 100).toFixed(1) + '%';

  // 「什么时候开始唱这一句」：距句起音 ≤3s 时显示三个闪烁点倒数，
  // 点一颗颗熄灭，全灭 = 进句开口。开始唱后显示"本句还剩 X s"。
  const dots = (n) => Array.from({ length: 3 }, (_, i) =>
    `<i class="k-dot${i < n ? '' : ' off'}"></i>`).join('');
  if (next && vt >= cur.end && vt < next.phraseStart) {
    // 句间空档：等下一句，三个点倒数到 next 起音
    const left = Math.max(0, next.phraseStart - vt);
    const n = Math.min(3, Math.ceil(left));
    el.kHint.innerHTML = `第 ${next.phraseNo} 句 · ${dots(n)} ${n} · 点灭即开口`;
  } else if (vt < cur.phraseStart - 0.05 && cur.phraseStart - vt <= 3.0) {
    // 开头还没到第一句
    const left = Math.max(0, cur.phraseStart - vt);
    const n = Math.min(3, Math.ceil(left));
    el.kHint.innerHTML = `第 ${cur.phraseNo} 句 · ${dots(n)} ${n} · 点灭即开口`;
  } else if (vt >= cur.phraseStart - 0.05 && vt < cur.end) {
    const toNext = Math.max(0, cur.end - vt);
    el.kHint.innerHTML = `第 ${cur.phraseNo} 句 · <b class="k-go">唱！</b> 本句还剩 ${toNext.toFixed(1)}s`;
  } else {
    el.kHint.innerHTML = '跟着高亮的字唱';
  }
}

async function stopRecording() {
  if (!S.recorder?.active) return;
  cancelAnimationFrame(S.recRAF);
  clearTimeout(S.countdownRAF);
  const rec = S.recorder;
  S.recorder = null;
  const out = await rec.stop();
  // 收掉语音识别，拿到这一轮识别到的歌词
  if (S.speech) {
    const t = S.speech.stop();
    if (t) S.speechText = t;
    S.speech = null;
  }
  el.recSpeech.classList.add('hidden');
  show(el.recordStrip, false);
  show(el.karaoke, false);
  // 注意：TakeRecorder 产出的帧已经是【相对录音起点】的时间（与音频同轴），
  // 不能再 normalize（那会按"首个采样"重新归零，又引入几十毫秒偏移）。
  const frames = out.frames;
  if (!frames.length) {
    toast('没录到声音，请重试', 'err');
    resetToIdle();
    return;
  }
  if (S.recKind === 'ref') {
    await commitReference(out.blob, frames);
  }
  else await commitPractice(out.blob, frames);
}

/* ══════════════════ 参考人声：保存 + 自动解析 ══════════════════ */

async function commitReference(blob, frames) {
  S.phase = 'parse-ref';
  showParse('正在解析参考人声…', '提取调性、歌词结构、简谱');
  setStep(2);

  const duration = frames[frames.length - 1].t - frames[0].t;
  const parsed = parseVocal(frames, { title: '参考人声' });
  const rec = await saveVocal({
    blob, frames, duration,
    label: '参考 · ' + new Date().toLocaleString('zh-CN', { hour12: false }),
    role: 'reference', noteCount: parsed.notes.length,
  });
  S._refRecId = rec.id;   // 确定歌词时把快照挂到这条记录上
  S.history = await listVocals();
  renderHistory();
  await animateParse();
  hideParse();

  if (parsed.silent) {
    toast('这段几乎没检测到人声，请重录', 'err', 5000);
    await deleteVocal(rec.id);
    S.history = await listVocals();
    renderHistory();
    resetToIdle();
    return;
  }

  S.refVocal = { ...rec, frames };
  S.refBlob = blob || null;     // 解析卡里能回放这段刚录的原声
  S.parsed = parsed;
  S.key = detectKey(parsed.notes);
  S.groups = groupPhrases(parsed.notes);
  const counts = S.groups.map((p) => p.length);

  // 音频起点校正：MediaRecorder 的 blob 起点与音高帧时间轴可能有几十毫秒差，
  // 用 RMS 包络互相关求出来，回放亮格时补上，让"听到的"和"亮起的"同步。
  S.refAudioOffset = 0;
  if (blob && !blob._offsetTried) {
    blob._offsetTried = true;
    try {
      if (!S.engine) S.engine = new AudioEngine();
      await S.engine.ensureContext();
      const buf = await decodeFile(S.engine.ctx, blob);
      const est = await estimateAudioStartOffset(buf, frames);
      S.refAudioOffset = est.ok ? est.offset : 0;
      if (est.ok) console.log(`[同步] 音频起点偏移校正 ${(est.offset * 1000).toFixed(0)}ms (corr ${est.corr.toFixed(2)})`);
    } catch { /* 解码失败就不校正，偏移为 0 */ }
  }

  // 歌词来源优先级：
  // ① 录前已填歌词（最准——字数、断句都是你定的，直接按你的结构对齐）
  // ② 录音时语音识别到的文本
  // ③ 占位符 ○
  const preLyrics = (el.preLyricInput?.value || '').trim();
  let draft = placeholderLyrics(S.groups);
  let status = '未识别到歌词，用占位符 ○ 也能先练，或直接改上面文字';
  let statusKind = '';
  S.charMap = null; S.lineBreaks = null;
  if (preLyrics) {
    // 录前歌词：先按用户断句重排（字↔音符对应 + 按标点排版），一步到位
    const r = realignLyricsToScore(preLyrics, S.groups);
    draft = r.text;
    S.charMap = r.charMap;
    S.lineBreaks = r.lineBreaks;
    status = `已按你录前填的歌词对齐（${r.totalChars} 字 ↔ ${r.noteCount} 音符，${r.userPhrases} 句），请核对后点「确定歌词」`;
    statusKind = 'ok';
  } else if (S.speechText && S.speechText.trim()) {
    draft = alignTextToPhrases(S.speechText, counts);
    status = '已自动识别歌词，请核对/修改，然后点「确定歌词」';
    statusKind = 'ok';
  }
  S.lyricText = draft;
  S.lyricsDraft = draft;
  S.lyricsConfirmed = false;
  S.score = buildScore(parsed.notes, S.key, S.lyricText,
    S.charMap ? { charMap: S.charMap, lineBreaks: S.lineBreaks } : {});
  if (!S.charMap) S.charMap = scoreCharMap(S.score);   // 逐字对应格 / 重排都基于它
  S.lastPair.a = rec.id;
  // 参考解析快照：历史「打开」时能恢复这一版的解析卡（歌词/谱子）
  saveVocalSnapshot(rec.id, { lyricText: S.lyricText, charMap: S.charMap, confirmed: false });
  renderParsedCard(status, statusKind);
  // 录前歌词只用一次：解析消费完就清空预填框，避免下一轮误用
  if (el.preLyricInput) el.preLyricInput.value = '';
  S.phase = 'ready';
  setStep(3);
}

/** 解析卡：① 调性 ② 原声播放 ③ 歌词编辑器 ④ 简谱 ⑤ 逐字对应格 */
function renderParsedCard(status, statusKind = '') {
  el.keyName.textContent = S.key.name;
  el.keyJianpu.textContent = S.key.jianpuKey + ' · ' + S.score.bpm + ' BPM';
  el.lyricEditor.value = S.lyricText;
  el.scoreInfo.textContent = `${S.key.jianpuKey} · ${S.score.noteCount} 个音 · ${S.score.lines.length} 句`;
  el.lyricStatus.textContent = status || '改完歌词点「确定歌词」，练唱时就显示真实歌词';
  el.lyricStatus.className = 'lyric-status' + (statusKind ? ' ' + statusKind : '');
  el.btnRecognize.disabled = !speechAvailable();
  if (!speechAvailable()) el.btnRecognize.title = '此浏览器不支持语音识别，请手动填写';
  el.btnPlayRef.disabled = !S.refBlob;
  if (!S.refBlob) el.refPlayHint.textContent = '本轮没有存下原声音频，重录一次即可边听边看';
  else el.refPlayHint.textContent = '听着原声看简谱，唱到哪个音符就会亮哪一格';
  renderJianpuSheet();
  renderCellEditor();
  renderBirdsRefOnly();     // 解析完就给一张「原唱鸟起伏图」——旋律长什么样先看见
  el.heroIcon.textContent = '🎼';
  el.heroTitle.textContent = '解析完成';
  el.heroDesc.textContent = '边听原声看简谱亮格 → 改好歌词点「重新解析匹配」→ 逐格核对 → 点「确定歌词」再练唱。';
  show(el.parsedCard, true);
  show(el.stageActions, false);
}

/** 解析卡里的「原唱鸟起伏图」：只有青色原唱歌排成旋律形状，
 *  播放原声时当前鸟亮起；练唱后同一张图会补上你的粉色鸟。 */
function renderBirdsRefOnly() {
  const units = flattenScore(S.score);
  stopBirdGlow();
  if (!units.length) { el.noteBlocks.innerHTML = ''; return; }
  const pxPerSec = 26;
  const beatSec = S.score?.beatSec || 0.5;
  const durPx = (ms) => clamp(Math.round((ms / 1000) / beatSec * pxPerSec), 6, 140);
  el.noteBlocks.innerHTML = units.map((u, i) => {
    const top = birdTopPct(u.midi);
    const cloud = durPx(Math.max(1, (u.end - u.start) * 1000));
    return `<div class="nb-col" data-idx="${i}" data-note-idx="${u.noteIdx}" data-start="${u.start}" data-end="${u.end}"
        title="第 ${i + 1} 音 · ${escapeHtml(u.jianpu.symbol)} · ${u.beat} · 起音 ${u.start.toFixed(1)}s · 点此听音">
      <div class="nb-bird ref" style="top:${top}%">🐦<b class="nb-jp">${escapeHtml(u.jianpu.symbol)}</b><span class="nb-cloud ref" style="width:${cloud}px"></span></div>
      <div class="nb-ch">${escapeHtml(u.char || '○')}</div>
    </div>`;
  }).join('');
  el.noteBlocks.style.setProperty('--nb-cell-w', '64px');
  // 点鸟听那一个音；播放原声时当前鸟亮起
  el.noteBlocks.querySelectorAll('.nb-col').forEach((col) => {
    col.addEventListener('click', () => {
      const u = units[Number(col.dataset.idx)];
      if (!u || !S.engine?.ctx) return;
      try { S.toneOsc?.stop?.(); } catch { /* noop */ }
      playMidiTone(u.midi, S.engine.ctx, { dur: 0.5 });
    });
  });
}

/** 播放原声时：解析卡的鸟图亮当前列；结果页的鸟图亮当前列 */
function glowRefBirdAt(t) {
  const cols = [...el.noteBlocks.querySelectorAll('.nb-col')];
  if (!cols.length) return;
  const idx = cols.findIndex((c) => t >= Number(c.dataset.start) && t < Number(c.dataset.end));
  el.noteBlocks.querySelectorAll('.nb-col.on').forEach((n) => n.classList.remove('on'));
  if (idx >= 0) {
    cols[idx].classList.add('on');
    cols[idx].scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }
}

/** 简谱表：按乐句分行，每字显示简谱符号 + 节拍 + 歌词字。
 *  每个格带 data-note-idx（全局音符序号），供播放原声时逐格高亮。 */
function renderJianpuSheet() {
  const s = S.score;
  el.jpSheet.innerHTML = s.lines.map((line) => `
    <div class="jp-line" data-line="${line.index}">
      <div class="jp-row jp-notes">${line.units.map((u) =>
        `<span class="jp-cell" data-note-idx="${u.noteIdx}" title="${escapeHtml(jianpuTitle(u.jianpu))}"><span class="jp-note">${jianpuHtml(u.jianpu)}</span><span class="jp-beat">${escapeHtml(u.beat)}</span></span>`).join('')}</div>
      <div class="jp-row jp-lyric">${line.units.map((u) => `<span class="jp-ch" data-note-idx="${u.noteIdx}">${escapeHtml(u.char || '○')}</span>`).join('')}</div>
    </div>`).join('');
}

/** 逐字对应格：一个音符一个输入框，上排原唱简谱 + 节拍 + 起音时刻，下面能直接改字 */
function renderCellEditor() {
  const s = S.score;
  el.jpCellEditor.innerHTML = s.lines.map((line) => `
    <div class="jce-line" data-line="${line.index}">
      <span class="jce-no">第${line.phraseNo}句</span>
      <div class="jce-cells">${line.units.map((u) => `
        <label class="jce-cell" data-note-idx="${u.noteIdx}" title="${escapeHtml(jianpuTitle(u.jianpu))}">
          <span class="jce-jp">${jianpuHtml(u.jianpu)}</span>
          <span class="jce-beat">${escapeHtml(u.beat)}</span>
          <span class="jce-time">${u.start.toFixed(1)}s</span>
          <input class="jce-input" data-note-idx="${u.noteIdx}" maxlength="4" value="${escapeHtml(u.char || '○')}" spellcheck="false">
        </label>`).join('')}</div>
    </div>`).join('');
  el.jpCellEditor.querySelectorAll('.jce-input').forEach((inp) => {
    inp.addEventListener('input', onCellEdit);
  });
}

/** 逐格改字：只动这一个音符上的字，charMap 立即同步（不重排、不影响别的格） */
function onCellEdit(e) {
  const idx = Number(e.target.dataset.noteIdx);
  const cs = cleanLyricChars(e.target.value);
  const ch = cs.length ? cs.join('') : '○';
  if (!S.charMap) S.charMap = scoreCharMap(S.score);
  S.charMap[idx] = ch;
  // 同步文本草稿（按行拼回去），并局部刷新简谱表 + 状态
  S.lyricsDraft = charMapToText(S.score, S.charMap);
  el.lyricEditor.value = S.lyricsDraft;
  S.lyricsConfirmed = false;
  S.score = buildScore(S.parsed.notes, S.key, S.lyricsDraft, { charMap: S.charMap });
  renderJianpuSheet();
  el.lyricStatus.textContent = `第 ${idx + 1} 个音符上的字已改成「${ch}」，点「确定歌词」生效`;
  el.lyricStatus.className = 'lyric-status';
}

/** charMap（按音符全局顺序）→ 按乐句分行的文本 */
function charMapToText(score, charMap) {
  let k = 0;
  return (score.lines || []).map((line) => {
    const n = line.units.length;
    const seg = charMap.slice(k, k + n);
    k += n;
    return seg.join('');
  }).join('\n');
}

/** 用户编辑歌词框 → 更新草稿 + 实时重排简谱（尚未确定） */
function onLyricEdit() {
  S.lyricsDraft = el.lyricEditor.value;
  S.lyricsConfirmed = false;
  el.lyricStatus.textContent = '歌词已修改：点「重新解析匹配」按节奏重钉，或点「确定歌词」直接生效';
  el.lyricStatus.className = 'lyric-status';
  // 实时预览：用草稿重建谱子，让简谱下面的歌词跟着变
  S.score = buildScore(S.parsed.notes, S.key, S.lyricsDraft);
  S.charMap = scoreCharMap(S.score);
  renderJianpuSheet();
  renderCellEditor();
}

/**
 * 「重新解析匹配」：拿第一次录的原声解析出的节奏骨架，把用户改过的歌词
 * 重新按【每句实际演唱时长】占比切分、逐字钉到每个音符上。
 * 输出 charMap 精确记录「哪个字对应哪个音符」，再重建逐字谱。
 */
function realignLyrics() {
  if (!S.parsed || !S.key || !S.groups?.length) { toast('请先录入参考人声', 'err'); return; }
  const text = el.lyricEditor.value;
  const r = realignLyricsToScore(text, S.groups);
  if (!r.charMap.length) { toast('歌词是空的，先填点字', 'err'); return; }
  S.charMap = r.charMap;
  S.lineBreaks = r.lineBreaks;
  S.lyricsDraft = r.text;
  el.lyricEditor.value = r.text;
  // 两步分离：charMap = 字↔音符对应（第一性），lineBreaks = 按用户标点排版（美观）
  S.score = buildScore(S.parsed.notes, S.key, r.text, { charMap: S.charMap, lineBreaks: S.lineBreaks });
  S.lyricsConfirmed = false;
  renderJianpuSheet();
  renderCellEditor();
  el.scoreInfo.textContent = `${S.key.jianpuKey} · ${S.score.noteCount} 个音 · ${S.score.lines.length} 句`;
  el.lyricStatus.textContent = `✓ 已重新匹配：${r.totalChars} 字 ↔ ${r.noteCount} 个音符一一对应，按你的 ${r.userPhrases} 句标点排版，请逐格核对后点「确定歌词」`;
  el.lyricStatus.className = 'lyric-status ok';
  toast('字音一一对应完成，已按你的标点排版', 'ok');
  return r;
}

/** 「确定歌词」：把草稿 + 逐字对应正式写入，重建逐字谱（练唱/结果都用它） */
function confirmLyrics() {
  if (!S.parsed || !S.key) return;
  S.lyricText = S.lyricsDraft || el.lyricEditor.value;
  // 以逐字对应格为准：charMap 才是"哪个字对应哪个音符"的真相
  if (!S.charMap || S.charMap.length !== S.parsed.notes.length) {
    const r = realignLyricsToScore(S.lyricText, S.groups);
    S.charMap = r.charMap.length ? r.charMap : scoreCharMap(S.score);
    S.lineBreaks = r.lineBreaks;
  }
  S.lyricText = charMapToText(S.score, S.charMap);
  S.lyricsConfirmed = true;
  S.score = buildScore(S.parsed.notes, S.key, S.lyricText, { charMap: S.charMap, lineBreaks: S.lineBreaks });
  // 快照已确定的歌词+谱子：历史「打开」时完整恢复
  if (S.refVocal?.id) saveVocalSnapshot(S.refVocal.id, {
    lyricText: S.lyricText, charMap: S.charMap, lineBreaks: S.lineBreaks, confirmed: true,
  });
  renderJianpuSheet();
  renderCellEditor();
  el.lyricEditor.value = S.lyricText;
  el.scoreInfo.textContent = `${S.key.jianpuKey} · ${S.score.noteCount} 个音 · ${S.score.lines.length} 句`;
  el.lyricStatus.textContent = '✓ 歌词已确定，练唱时显示这些字（逐字对应已锁定）';
  el.lyricStatus.className = 'lyric-status ok';
  toast('歌词已确定', 'ok');
  return { text: S.lyricText, confirmed: true };
}

/** 「识别歌词」：重新识别一遍（复用最近一次参考录音期间的识别文本；
 *  若没有则提示用户可重录参考，或直接在框里改） */
function recognizeLyrics() {
  if (!speechAvailable()) { toast('此浏览器不支持语音识别，请手动填写歌词', 'err'); return; }
  if (S.speechText && S.speechText.trim()) {
    const counts = (S.groups || groupPhrases(S.parsed.notes)).map((p) => p.length);
    const aligned = alignTextToPhrases(S.speechText, counts);
    el.lyricEditor.value = aligned;
    onLyricEdit();
    el.lyricStatus.textContent = '已用录音时识别到的歌词自动填入，请核对后点「确定歌词」';
    el.lyricStatus.className = 'lyric-status ok';
    toast('已填入识别到的歌词', 'ok');
    return;
  }
  toast('这一段没识别到歌词，直接手动填即可；也可「重录参考」再试', '', 4500);
}

/* ══════════════════ 听歌识曲 · 选歌词 ══════════════════ */

function showSongModal(open) {
  el.songMask.classList.toggle('open', !!open);
  if (open) return;
  el.songResult.innerHTML = '';
  el.songLines.innerHTML = '';
  el.songLines.classList.add('hidden');
  el.btnUseLines.classList.add('hidden');
  el.manualQuery.classList.add('hidden');
  el.btnSearchQuery.classList.add('hidden');
}

/** 渲染歌词候选列表（识曲命中 / 手动搜索共用） */
function renderSongCandidates(rows, hint) {
  el.songStep.textContent = hint || '找到这些候选，点一首取歌词：';
  el.songResult.innerHTML = rows.length ? '' : '<p class="song-step">没找到匹配的歌词，试试下面手动搜索。</p>';
  el.songResult.querySelectorAll('.song-cand').forEach((n) => n.remove());
  for (const r of rows.slice(0, 6)) {
    const d = document.createElement('div');
    d.className = 'song-cand';
    d.innerHTML = `
      ${r._art ? `<img src="${escapeHtml(r._art)}" alt="">` : ''}
      <div class="sc-main"><b>${escapeHtml(r.trackName)}</b><small>${escapeHtml(r.artistName)}${r.albumName ? ' · ' + escapeHtml(r.albumName) : ''}</small></div>
      <span class="sc-dur">${r.duration ? fmtTime(r.duration) : ''}</span>`;
    d.addEventListener('click', () => {
      el.songResult.querySelectorAll('.song-cand.sel').forEach((x) => x.classList.remove('sel'));
      d.classList.add('sel');
      showLinePicker(r);
    });
    el.songResult.appendChild(d);
  }
  if (rows.length) {
    el.manualQuery.classList.remove('hidden');
    el.btnSearchQuery.classList.remove('hidden');
  }
}

/** 选中一首 → 展示整首歌词的句子清单，用户勾选要唱的几句 */
function showLinePicker(rec) {
  const plain = (rec.plainLyrics || '').trim();
  const lines = plain ? splitSongLines(plain) : (rec.syncedLyrics ? splitSongLines(lrcToPlainLines(rec.syncedLyrics).join('\n')) : []);
  if (!lines.filter((l) => !l.blank).length) {
    el.songStep.textContent = '这首没有可用的歌词文本，请手输歌词';
    return;
  }
  el.songStep.textContent = `《${rec.trackName}》· ${rec.artistName} —— 勾选你要唱的几句（顺序就是演唱顺序），然后点「用选中的句子」`;
  el.songLines.innerHTML = lines.map((l) => l.blank
    ? '<div class="song-line blank"></div>'
    : `<label class="song-line"><input type="checkbox" value="${escapeHtml(l.text)}"><span>${escapeHtml(l.text)}</span></label>`).join('');
  el.songLines.classList.remove('hidden');
  el.btnUseLines.classList.remove('hidden');
  el.songLines.dataset.track = `${rec.trackName}|${rec.artistName}`;
}

/** 把勾选的句子写进歌词框并按节奏重排 */
function useSelectedLines() {
  const picked = [...el.songLines.querySelectorAll('input:checked')]
    .map((i) => i.value.trim()).filter(Boolean);
  if (!picked.length) { toast('先勾选至少一句歌词', 'err'); return; }
  el.lyricEditor.value = picked.join('\n');
  showSongModal(false);
  onLyricEdit();
  // 直接按标点/节奏重排入谱，用户只需核对再确定
  realignLyrics();
  el.lyricStatus.textContent = `已从《${el.songLines.dataset.track.split('|')[0]}》取 ${picked.length} 句歌词并按节奏匹配，请核对后点「确定歌词」`;
  el.lyricStatus.className = 'lyric-status ok';
  toast(`已取 ${picked.length} 句歌词`, 'ok');
}

/** 主流程：识曲 → 取歌词候选 → 选句 */
async function identifyAndPick() {
  showSongModal(true);
  el.songTitle.textContent = '🎧 听歌识曲 · 选歌词';
  el.songResult.innerHTML = '';
  el.songLines.classList.add('hidden');
  el.btnUseLines.classList.add('hidden');

  // 没配 token：先引导注册/填 token，同时给手动搜索的口子
  if (!getAuddToken()) {
    el.songStep.innerHTML = `两步走：<br>① 到 <a href="https://dashboard.audd.io/" target="_blank" rel="noreferrer" style="color:var(--cyan)">dashboard.audd.io</a> 免费注册一个 api_token（听歌识曲用）<br>
      ② 把 token 粘进来（只存在你本机浏览器）：<br>
      <input type="text" id="auddTokenInput" class="song-query" style="margin-top:8px" placeholder="粘贴 AudD api_token">
      <div class="sel-actions" style="margin-top:8px">
        <button class="btn small primary" id="btnSaveToken">保存并识曲</button>
        <button class="btn small ghost" id="btnSkipIdentify">跳过识曲，直接搜歌词</button>
      </div>`;
    el.manualQuery.classList.add('hidden');
    el.btnSearchQuery.classList.add('hidden');
    const saveBtn = document.getElementById('btnSaveToken');
    const skipBtn = document.getElementById('btnSkipIdentify');
    saveBtn?.addEventListener('click', async () => {
      const t = document.getElementById('auddTokenInput').value.trim();
      if (!t) { toast('先粘贴 token', 'err'); return; }
      setAuddToken(t);
      el.songStep.textContent = '正在识别你唱的是哪首歌…';
      await runIdentify();
    });
    skipBtn?.addEventListener('click', async () => {
      el.songStep.textContent = '直接搜歌词：输入歌名或关键词';
      el.manualQuery.classList.remove('hidden');
      el.btnSearchQuery.classList.remove('hidden');
      el.manualQuery.focus();
    });
    return;
  }
  await runIdentify();
}

async function runIdentify() {
  if (!S.refBlob) {
    el.songStep.textContent = '本轮没有存下原声音频（用测试钩子注入的帧没有音频），直接搜歌词即可';
    el.manualQuery.classList.remove('hidden');
    el.btnSearchQuery.classList.remove('hidden');
    return;
  }
  el.songStep.textContent = '🎧 正在把录音片段发给听歌识曲（几秒钟）…';
  const m = await identifySong(S.refBlob);
  if (!m) {
    el.songStep.textContent = '没识别出是哪首歌（清唱/哼唱识曲命中率有限）。直接搜歌词：输入歌名或关键词';
    el.manualQuery.classList.remove('hidden');
    el.btnSearchQuery.classList.remove('hidden');
    el.manualQuery.focus();
    return;
  }
  el.songStep.innerHTML = `识别到：<b>${escapeHtml(m.title)}</b> · ${escapeHtml(m.artist)} —— 正在取歌词…`;
  const rows = await searchLyrics({ title: m.title, artist: m.artist, duration: m.duration });
  if (rows.length) { renderSongCandidates(rows, `识别到《${m.title}》· ${m.artist}，点一首取歌词：`); return; }
  // 歌名直搜没有 → 再用「歌名 歌手」当关键词搜
  const rows2 = await searchLyricsByQuery(`${m.title} ${m.artist}`);
  renderSongCandidates(rows2, `识别到《${m.title}》· ${m.artist}，但精确匹配没找到歌词，这些是近似结果：`);
}

/* ══════════════════ 解析卡：播放刚录的原声 + 逐音符亮格 ══════════════════ */

function clearRefHighlight() {
  el.jpSheet.querySelectorAll('.jp-on').forEach((n) => n.classList.remove('jp-on'));
  el.jpSheet.querySelectorAll('.jp-line-on').forEach((n) => n.classList.remove('jp-line-on'));
  el.jpCellEditor.querySelectorAll('.jce-on').forEach((n) => n.classList.remove('jce-on'));
  el.jpCellEditor.querySelectorAll('.jce-line-on').forEach((n) => n.classList.remove('jce-line-on'));
}

/** 把播放时刻 t 对应的音符格高亮（简谱表 + 逐字对应格同步） */
function highlightRefAt(t) {
  clearRefHighlight();
  const units = flattenScore(S.score);
  let cur = null;
  for (const u of units) if (t >= u.start && t < u.end) { cur = u; break; }
  if (!cur) return;
  const sel = (root) => root.querySelectorAll(`[data-note-idx="${cur.noteIdx}"]`);
  sel(el.jpSheet).forEach((n) => n.classList.add('jp-on'));
  sel(el.jpCellEditor).forEach((n) => n.classList.add('jce-on'));
  const l1 = el.jpSheet.querySelector(`.jp-line[data-line="${cur.lineIndex}"]`);
  if (l1) l1.classList.add('jp-line-on');
  const l2 = el.jpCellEditor.querySelector(`.jce-line[data-line="${cur.lineIndex}"]`);
  if (l2) l2.classList.add('jce-line-on');
}

function stopRefPlayback() {
  cancelAnimationFrame(S.refPlayRAF);
  if (S.refAudio) { S.refAudio.pause(); S.refAudio.currentTime = 0; }
  S.refPlaying = false;
  el.btnStopRef.disabled = true;
  el.btnPlayRef.disabled = !S.refBlob;
  el.refPlayFill.style.width = '0%';
  el.refPlayHint.textContent = '听着原声看简谱，唱到哪个音符就会亮哪一格';
  clearRefHighlight();
}

async function playRefAudio() {
  if (!S.refBlob) { toast('本轮没有存下原声音频，重录一次即可边听边看', 'err'); return; }
  stopAudio();               // 别和结果页的播放器撞车
  stopRefPlayback();
  if (S.refAudioUrl) URL.revokeObjectURL(S.refAudioUrl);
  S.refAudioUrl = URL.createObjectURL(S.refBlob);
  if (!S.refAudio) {
    S.refAudio = new Audio();
    S.refAudio.addEventListener('ended', () => stopRefPlayback());
  }
  S.refAudio.src = S.refAudioUrl;
  try { await S.refAudio.play(); }
  catch (e) { toast('播放失败：' + e.message, 'err'); stopRefPlayback(); return; }
  S.refPlaying = true;
  el.btnPlayRef.disabled = true;
  el.btnStopRef.disabled = false;
  const total = Math.max(0.1, S.score?.duration || S.parsed?.duration || 1);
  // 音频时刻 → 谱子时刻：补上录下的音频起点与音高帧时间轴之间的偏移
  const off = S.refAudioOffset || 0;
  const tick = () => {
    if (!S.refPlaying || !S.refAudio) return;
    const at = S.refAudio.currentTime;
    const t = at + off;
    highlightRefAt(t);
    el.refPlayFill.style.width = (clamp(at / total, 0, 1) * 100).toFixed(1) + '%';
    el.refPlayHint.textContent = `原声 ${at.toFixed(1)}s / ${total.toFixed(1)}s · 亮起的格就是此刻唱到的音符`;
    S.refPlayRAF = requestAnimationFrame(tick);
  };
  tick();
}

function showParse(title, sub) {
  el.parseTitle.textContent = title;
  el.parseSub.textContent = sub;
  el.parseBar.style.width = '0%';
  show(el.parseStrip, true);
  show(el.stageActions, false);
  show(el.parsedCard, false);
  show(el.resultWrap, false);
  show(el.karaoke, false);
}
function hideParse() { show(el.parseStrip, false); el.parseBar.style.width = '100%'; }
function animateParse() {
  return new Promise((resolve) => {
    let p = 0;
    const step = () => {
      p = Math.min(1, p + 0.18 + Math.random() * 0.15);
      el.parseBar.style.width = Math.round(p * 100) + '%';
      if (p < 1) setTimeout(step, 60); else setTimeout(resolve, 160);
    };
    step();
  });
}

/* ══════════════════ 练唱：保存 + 自动对比 ══════════════════ */

async function commitPractice(blob, frames) {
  S.phase = 'parse-practice';
  showParse('正在对比这一遍…', '逐字比对简谱、音高与节奏');
  const duration = frames[frames.length - 1].t - frames[0].t;
  const rec = await saveVocal({
    blob, frames, duration,
    label: '练唱 · ' + new Date().toLocaleString('zh-CN', { hour12: false }),
    role: 'take',
  });
  S.history = await listVocals();
  renderHistory();

  const units = flattenScore(S.score);
  const r = scorePracticeWords(units, S.key, frames, { tol: S.tol });
  S.lastPractice = { ...r, byLine: groupWordsByLine(r.words) };
  S.lastPair.b = rec.id;
  // 练唱快照：当时用的参考、歌词/谱子、逐字结果——历史「打开」能完整回放这一遍
  saveVocalSnapshot(rec.id, {
    refId: S.refVocal?.id || S.lastPair.a || null,
    lyricText: S.lyricText, charMap: S.charMap, lineBreaks: S.lineBreaks,
    confirmed: S.lyricsConfirmed,
    result: { words: r.words, summary: r.summary, align: r.align, transposition: r.transposition },
  });
  await animateParse();
  hideParse();
  renderResult();
  S.phase = 'result';
  setStep(3);
}

/** 结果：只显示一篇歌词，每字上下两排（原唱简谱 / 我唱简谱）+ 高低快慢 */
function renderResult() {
  clearTimeout(S.countdownRAF);
  S.countdown = 0;
  show(el.karaoke, false);
  show(el.recordStrip, false);
  show(el.resultWrap, true);
  show(el.parsedCard, false);
  show(el.stageActions, false);
  el.heroIcon.textContent = '📝';
  el.heroTitle.textContent = '这一遍唱完了';
  el.heroDesc.textContent = '下面是整篇歌词；每个字上排是原唱简谱、下排是你唱的简谱。';

  const st = S.lastPractice.summary;
  const al = S.lastPractice.align;
  const tp = S.lastPractice.transposition;
  el.resultTitle.textContent = '这一遍唱得怎么样';
  el.resultSub.textContent = `共 ${st.total} 字 · 唱到 ${st.sung} · 偏高 ${st.high} · 偏低 ${st.low} · 偏快 ${st.early} · 偏慢 ${st.late} · 没唱到 ${st.missed}`
    + (al?.aligned ? ` · 已自动对齐 ${Math.round(-al.shift * 1000)}ms` : '');
  // 调性判定横幅：你整体换调了吗？换调后音程还对吗？
  if (tp?.applied) {
    const ok = tp.consistent;
    el.keyVerdict.className = 'key-verdict show ' + (ok ? 'good' : 'bad');
    el.keyVerdict.innerHTML = ok
      ? `🎯 ${escapeHtml(tp.verdict)} —— 你用自己的调唱对了旋律（原唱 ${escapeHtml(S.key?.name || '')}）`
      : `⚠️ ${escapeHtml(tp.verdict)} —— 旋律形状错了（原唱 ${escapeHtml(S.key?.name || '')}），看下面逐字标注`;
  } else {
    el.keyVerdict.className = 'key-verdict show good';
    el.keyVerdict.innerHTML = `🎯 同调演唱（${escapeHtml(S.key?.name || '')}）${st.high + st.low === 0 ? '，没跑调' : '，个别字偏高/偏低见下方标注'}`;
  }
  el.btnPlayA.disabled = !S.lastPair.a;
  el.btnPlayB.disabled = !S.lastPair.b;

  const lines = S.lastPractice.byLine;
  renderNoteBirds();
  el.lyricResult.innerHTML = lines.map((line) => {
    const cells = line.units.map((u) => {
      const cls = u.status === 'missed' ? 'missed' : (u.band || 'perfect');
      const tag = u.status === 'missed' ? '没唱到' : (u.pitch === '准' ? '' : u.pitch);
      const timingTag = u.status === 'sung' && !/节奏准/.test(u.timing) ? u.timing : '';
      return `<span class="lr-cell ${cls}">
        <span class="lr-ref">${escapeHtml(u.refNum)}</span>
        <span class="lr-char">${escapeHtml(u.char || '○')}</span>
        <span class="lr-my">${escapeHtml(u.myNum)}</span>
        <span class="lr-tag">${escapeHtml([tag, timingTag].filter(Boolean).join(' · '))}</span>
      </span>`;
    }).join('');
    return `<div class="lr-line"><div class="lr-cells">${cells}</div>
      <div class="lr-summary">${escapeHtml(lineSummary(line))}</div></div>`;
  }).join('');
  el.resultWrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ══════════════════ 小鸟音符对照图（不用曲线：高低位置 + 简谱数字） ══════════════════
 * 借鉴全民K歌"逐音符标准答案 + 原唱/你的线对照"的判定与可视化思路，
 * 但按要求不用曲线：每个音符是一只"小鸟"——唱得越高飞得越高，
 * 鸟身上写简谱数字。上（青色）= 原唱鸟，下（绿色）= 你唱的鸟。
 * 点小鸟反复听那一个音；播放 A/B 时当前列会亮。 */

/** 一屏内的小鸟高度范围（音高 → top%）：给 2 个八度的显示窗口 */
const BIRD_LO = 55;   // G3
const BIRD_HI = 79;   // G5

function birdTopPct(midi) {
  const m = Math.max(BIRD_LO - 2, Math.min(BIRD_HI + 2, midi));
  const p = (m - BIRD_LO) / (BIRD_HI - BIRD_LO);      // 0..1
  return clamp((1 - p) * 88 + 6, 6, 94);              // 6%..94%，越高音越靠上
}

/** 你唱的鸟的位置 = 原唱鸟位置 + 偏差放大：±1 半音 ≈ ±9% 高度（半个音程间隔），
 *  "差半音"视觉上正好差一档，重合=准、偏高=飞得比原唱歌高、偏低=低，一眼可读。 */
function myBirdTopPct(refMidi, userMidi) {
  const devSemi = clamp((userMidi - refMidi) * 9, -22, 22);   // 半音→%，封顶 ±22%
  return clamp(birdTopPct(refMidi) - devSemi, 4, 96);
}

function stopBirdGlow() {
  if (S.nbPlayingIdx == null) return;
  el.noteBlocks.querySelectorAll('.nb-col.on').forEach((n) => n.classList.remove('on'));
  S.nbPlayingIdx = null;
  cancelAnimationFrame(S.nbPlayRAF);
}

/** 播放 A/B 音频时高亮"此刻唱到的那一列小鸟" */
function glowBirdAt(t) {
  const cols = [...el.noteBlocks.querySelectorAll('.nb-col')];
  if (!cols.length) return;
  const idx = cols.findIndex((c) => t >= Number(c.dataset.start) && t < Number(c.dataset.end));
  el.noteBlocks.querySelectorAll('.nb-col.on').forEach((n) => n.classList.remove('on'));
  if (idx >= 0) {
    cols[idx].classList.add('on');
    cols[idx].scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }
}

/** 点一只小鸟：重复试听那一个音（参考的音高；没唱到的列听原唱音） */
function auditionBird(idx) {
  const words = S.lastPractice?.words || [];
  const w = words[idx];
  if (!w) return;
  const midi = w.userMidi ?? w.midi;
  if (!S.engine?.ctx) { ensureMic().catch(() => {}); return; }
  try { S.toneOsc?.stop?.(); } catch { /* noop */ }
  playMidiTone(midi, S.engine.ctx, { dur: 0.5 });
}

/** 渲染小鸟音符对照图 */
function renderNoteBirds() {
  const words = S.lastPractice?.words || [];
  stopBirdGlow();
  if (!words.length) { el.noteBlocks.innerHTML = ''; return; }

  const cellW = 64;
  const tol = S.tol ?? 50;
  const pxPerSec = 26;   // 云彩长度比例尺：1 拍 ≈ 26px（按 beatSec 折算）
  const beatSec = S.score?.beatSec || 0.5;
  const durPx = (ms) => clamp(Math.round((ms / 1000) / beatSec * pxPerSec), 6, 140);
  el.noteBlocks.innerHTML = words.map((w, i) => {
    const refTop = birdTopPct(w.midi);
    const band = w.band || 'perfect';
    const sung = w.status === 'sung';
    const devC = sung && w.userMidi != null ? (w.userMidi - w.midi) * 100 : null;
    const timingMs = sung ? (w.timingMs ?? 0) : null;
    // 严丝合缝 = 音准 ±tol 内 且 节奏 ±90ms 内：两鸟完全覆盖成一只
    const merged = sung && devC != null && Math.abs(devC) <= tol && Math.abs(timingMs) <= 90;
    const myTop = sung ? myBirdTopPct(w.midi, w.userMidi ?? w.midi) : refTop;
    // 左右偏差 = 节奏：唱早了鸟在左、唱晚了鸟在右，缝隙即快/慢多少
    const dx = sung ? clamp((timingMs || 0) * 0.12, -26, 26) : 0;
    // 云彩 = 这个音唱了多长（气息）：原唱云 vs 你唱的云，一样长才严丝合缝
    const refCloud = durPx(w.refDurMs ?? (u2ms(w)));
    const myCloud = sung ? durPx(w.userDurMs ?? 0) : 0;
    const durDiff = sung ? Math.round(((w.userDurMs ?? 0) - (w.refDurMs ?? 0)) / 100) * 0.1 : null;
    const durTag = sung && durDiff != null && Math.abs(durDiff) >= 0.2
      ? (durDiff > 0 ? ` 长${durDiff.toFixed(1)}s` : ` 短${Math.abs(durDiff).toFixed(1)}s`) : '';
    const devTxt = sung && w.dev != null ? `${w.dev > 0 ? '+' : ''}${Math.round(w.dev)}¢` : (sung ? '' : '没唱到');
    const timTxt = sung && timingMs != null && Math.abs(timingMs) > 90
      ? (timingMs < 0 ? ' 快' : ' 慢') : '';
    const cloud = (cls, wpx) => `<span class="nb-cloud ${cls}" style="width:${wpx}px"></span>`;
    const bird = merged
      ? `<div class="nb-bird merged ${band}" style="top:${refTop}%" title="两只鸟碰在一起开出了花 = 又准又稳（差 ${Math.round(devC)}¢）">
           🌸<b class="nb-jp">${escapeHtml(w.refNum)}</b><b class="nb-jp my">${escapeHtml(w.myNum || '—')}</b>${cloud('', refCloud)}</div>`
      : `<div class="nb-bird ref" style="top:${refTop}%">🐦<b class="nb-jp">${escapeHtml(w.refNum)}</b>${cloud('ref', refCloud)}</div>` +
        (sung
          ? `<div class="nb-bird my ${band}" style="top:${myTop}%;left:calc(50% + ${dx.toFixed(1)}px)" title="上下=音高偏差 左右=快慢 云=气息长短">🐦<b class="nb-jp">${escapeHtml(w.myNum || '—')}</b>${cloud('my', Math.max(myCloud, 8))}</div>`
          : `<div class="nb-bird my missed" style="top:${refTop}%" title="没唱到">🫥</div>`);
    return `<div class="nb-col ${sung ? '' : 'missed'}" data-idx="${i}" data-start="${w.start}" data-end="${w.end}"
        title="第 ${i + 1} 音 · 原唱 ${escapeHtml(w.refNum)} · 你 ${sung ? escapeHtml(w.myNum || '—') : '没唱到'} · ${escapeHtml(w.pitch || '')}${devTxt ? ' ' + devTxt : ''}${timTxt}${durTag ? ' · 气息' + durTag : ''} · 点此听音">
      ${bird}
      <div class="nb-ch">${escapeHtml(w.char || '○')}</div>
    </div>`;
  }).join('');

  function u2ms(w) { return Math.max(1, (w.end - w.start) * 1000); }

  el.noteBlocks.style.setProperty('--nb-cell-w', cellW + 'px');
  // 点列 = 反复试听那一个音
  el.noteBlocks.querySelectorAll('.nb-col').forEach((col) => {
    col.addEventListener('click', () => auditionBird(Number(col.dataset.idx)));
  });
}

/** 播放结果页音频（A=参考 / B=这次）并联动小鸟列高亮 */
async function playResultAudio(which) {
  const id = which === 'a' ? S.lastPair.a : S.lastPair.b;
  if (!id) return;
  const blob = await getVocalAudio(id);
  if (!blob) { toast('这段没有可播放的音频', 'err'); return; }
  stopAudio();
  stopBirdGlow();
  if (S.audioUrl) URL.revokeObjectURL(S.audioUrl);
  S.audioUrl = URL.createObjectURL(blob);
  if (!S.audio) {
    S.audio = new Audio();
    S.audio.addEventListener('ended', () => { el.btnStopAudio.disabled = true; stopBirdGlow(); });
  }
  S.audio.src = S.audioUrl;
  await S.audio.play().catch((e) => { toast('播放失败：' + e.message, 'err'); return; });
  el.btnStopAudio.disabled = false;
  const tick = () => {
    if (!S.audio || S.audio.paused || S.audio.ended) return;
    glowBirdAt(S.audio.currentTime);
    S.nbPlayRAF = requestAnimationFrame(tick);
  };
  tick();
}

/* ══════════════════ 历史：打开 / 时间轴自愈 ══════════════════ */

/**
 * 用录音音频校正一条历史记录的帧时间轴（老录音自愈）。
 *
 * 旧版把 AudioContext 绝对时间写进了帧；现在以【音频为真相】：
 *   - 帧时间 = 相对首帧（和音频都从按下录音起算，只差首采样那一小段）
 *   - 再用 RMS 包络互相关求出剩余起点差，把帧整体平移
 * 校正后写回 IndexedDB，以后打开就是对的。
 *
 * @param {Array} frames 原始帧
 * @param {Blob|null} blob 对应音频
 * @returns {{frames:Array, offset:number, fixed:boolean}}
 */
async function healFrames(frames, blob) {
  if (!frames?.length) return { frames: [], offset: 0, fixed: false };
  const absLike = frames[0].t > 60;   // 绝对时间戳（>60s）说明是老数据
  let out = frames.map((f) => ({ ...f }));

  // ① 绝对时间 → 相对时间
  if (absLike) {
    const t0 = frames[0].t;
    out = out.map((f) => ({ ...f, t: f.t - t0 }));
  }
  // ② 再按音频包络精修起点（老数据和新数据都能受益）
  let offset = 0;
  if (blob) {
    try {
      if (!S.engine) S.engine = new AudioEngine();
      await S.engine.ensureContext();
      const buf = await decodeFile(S.engine.ctx, blob);
      const est = await estimateAudioStartOffset(buf, out);
      if (est.ok && Math.abs(est.offset) > 0.005) {
        offset = est.offset;
        out = out.map((f) => ({ ...f, t: f.t + offset }));
      }
    } catch { /* 解不了就只做 ① */ }
  }
  return { frames: out, offset, fixed: absLike || Math.abs(offset) > 0.005 };
}

/** 打开一条历史录音：恢复当时的解析卡（歌词/谱子）或练唱结果 */
async function openVocal(id) {
  const v = await getVocal(id);
  if (!v) { toast('这条录音数据缺失', 'err'); return; }
  showParse('正在打开这段录音…', v.label);
  const blob = await getVocalAudio(id).catch(() => null);
  const { frames, offset, fixed } = await healFrames(v.frames, blob);
  if (fixed) {
    await rewriteFrames(id, frames).catch(() => {});
    S.history = await listVocals(); renderHistory();
  }
  hideParse();
  if (offset) console.log(`[历史] ${v.label} 时间轴校正 ${(offset * 1000).toFixed(0)}ms`);

  const snap = v.meta?.snapshot || null;

  // 练唱记录：恢复当时的结果视图（需要它的参考）
  if (v.role === 'take' && snap?.result) {
    const refId = snap.refId;
    const refRec = refId ? await getVocal(refId) : S.refVocal;
    if (refRec) {
      const refFrames = refRec.frames && refRec.frames[0]
        ? (refRec.frames[0].t > 60
          ? refRec.frames.map((f) => ({ ...f, t: f.t - refRec.frames[0].t }))
          : refRec.frames)
        : [];
      const parsed = parseVocal(refFrames, { title: refRec.label || '参考' });
      const key = detectKey(parsed.notes);
      const groups = groupPhrases(parsed.notes);
      const lyricText = snap.lyricText || placeholderLyrics(groups);
      const score = buildScore(parsed.notes, key, lyricText,
        snap.charMap ? { charMap: snap.charMap, lineBreaks: snap.lineBreaks } : {});
      S.refVocal = { ...refRec, frames: refFrames };
      S.parsed = parsed; S.key = key; S.groups = groups;
      S.score = score; S.lyricText = lyricText;
      S.charMap = snap.charMap || scoreCharMap(score);
      S.lineBreaks = snap.lineBreaks || null;
      S.lyricsConfirmed = !!snap.confirmed;
      S.refBlob = await getVocalAudio(refId).catch(() => null);
      S.refAudioOffset = 0;
      // 用存下的逐字结果直接重建结果视图
      const r = snap.result;
      S.lastPractice = {
        words: r.words, summary: r.summary, align: r.align,
        transposition: r.transposition, byLine: groupWordsByLine(r.words),
      };
      S.lastPair = { a: refId || null, b: id };
      renderResult();
      S.phase = 'result';
      setStep(3);
      toast(fixed ? '已打开（时间轴已校正）' : '已打开这一遍练唱', 'ok');
      return;
    }
  }

  // 参考记录 / 无结果快照：恢复解析卡
  const parsed = parseVocal(frames, { title: v.label });
  if (parsed.silent) { toast('这段几乎没检测到人声', 'err'); return; }
  const key = detectKey(parsed.notes);
  const groups = groupPhrases(parsed.notes);
  S.refVocal = { ...v, frames };
  S.refBlob = blob;
  S.refAudioOffset = 0;   // healFrames 已把帧对齐到音频，无需再补
  S.parsed = parsed;
  S.key = key;
  S.groups = groups;
  const lyricText = snap?.lyricText || placeholderLyrics(groups);
  S.lyricText = lyricText;
  S.lyricsDraft = lyricText;
  S.charMap = snap?.charMap || null;
  S.lineBreaks = snap?.lineBreaks || null;
  S.lyricsConfirmed = !!snap?.confirmed;
  S.score = buildScore(parsed.notes, key, lyricText,
    S.charMap ? { charMap: S.charMap, lineBreaks: S.lineBreaks } : {});
  if (!S.charMap) S.charMap = scoreCharMap(S.score);
  S.lastPair.a = id;
  renderParsedCard(
    fixed ? '✓ 已从历史打开（时间轴已校正，回放亮格与练唱提示都会对齐）'
      : '✓ 已从历史打开',
    'ok'
  );
  S.phase = 'ready';
  setStep(3);
  toast(fixed ? '已打开，时间轴已自动校正' : '已打开这段录音', 'ok');
}

/* ══════════════════ 历史：任意两段互比 ══════════════════ */

function renderHistory() {
  el.histCount.textContent = S.history.length;
  if (!S.history.length) {
    el.histList.innerHTML = '<div class="empty">还没有录音。点左边「录入参考人声」开始。</div>';
  } else {
    el.histList.innerHTML = '';
    for (const v of S.history) {
      const isA = S.pair.a === v.id, isB = S.pair.b === v.id;
      const card = document.createElement('div');
      card.className = 'hist-item' + (isA ? ' sel-a' : '') + (isB ? ' sel-b' : '');
      card.innerHTML = `
        <div class="hi-tags">
          ${isA ? '<span class="hi-tag a">A 参考</span>' : ''}
          ${isB ? '<span class="hi-tag b">B 对比</span>' : ''}
          <span class="hi-role">${v.role === 'reference' ? '参考' : v.role === 'import' ? '导入' : '练唱'}</span>
        </div>
        <div class="hi-main">
          <b class="hi-label" title="双击重命名">${escapeHtml(v.label)}</b>
          <small>${escapeHtml(vocalSubtitle(v))}</small>
        </div>
        <div class="hi-actions">
          <button class="btn tiny primary" data-act="open" title="打开：看这段的原声/歌词/谱子/结果">打开</button>
          <button class="btn tiny" data-act="a" title="设为 A 参考">A</button>
          <button class="btn tiny" data-act="b" title="设为 B 对比">B</button>
          <button class="btn tiny ghost" data-act="play" title="播放">▶</button>
          <button class="btn tiny ghost" data-act="rename" title="重命名">✎</button>
          <button class="btn tiny ghost" data-act="del" title="删除">✕</button>
        </div>`;
      card.querySelectorAll('button').forEach((b) => {
        b.addEventListener('click', (e) => { e.stopPropagation(); onHistAction(b.dataset.act, v); });
      });
      // 点卡片任意空白处 = 打开这段（和"打开"按钮等价，最好点）
      card.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        onHistAction('open', v).catch((err) => toast('打开失败：' + err.message, 'err', 5000));
      });
      card.style.cursor = 'pointer';
      card.addEventListener('dblclick', () => onHistAction('rename', v));
      el.histList.appendChild(card);
    }
  }
  renderPair();
}

async function onHistAction(act, v) {
  if (act === 'open') { await openVocal(v.id); return; }
  if (act === 'a') { S.pair.a = v.id; if (S.pair.b === v.id) S.pair.b = null; }
  else if (act === 'b') { S.pair.b = v.id; if (S.pair.a === v.id) S.pair.a = null; }
  else if (act === 'play') { await playVocal(v.id); return; }
  else if (act === 'rename') {
    const name = prompt('给这段录音起个名字：', v.label);
    if (name && name.trim()) {
      await renameVocal(v.id, name.trim());
      S.history = await listVocals(); renderHistory();
    }
    return;
  }
  else if (act === 'del') {
    if (!confirm(`删除「${v.label}」？`)) return;
    await deleteVocal(v.id);
    if (S.pair.a === v.id) S.pair.a = null;
    if (S.pair.b === v.id) S.pair.b = null;
    S.history = await listVocals(); renderHistory();
    return;
  }
  renderHistory();
}

function renderPair() {
  const a = S.history.find((v) => v.id === S.pair.a);
  const b = S.history.find((v) => v.id === S.pair.b);
  show(el.histSelect, !!(a || b));
  el.selA.textContent = a ? a.label : '（未选）';
  el.selB.textContent = b ? b.label : '（未选）';
  el.btnComparePair.disabled = !(a && b && a.id !== b.id);
}

/** 任意两段互比：用 A 的音符重建调性/逐字谱，再逐字比 B */
async function comparePair() {
  const a = S.pair.a, b = S.pair.b;
  if (!a || !b || a === b) return;
  showParse('正在对比解析…', '加载两段人声、重建谱子、逐字比对');
  const [va, vb] = await Promise.all([getVocal(a), getVocal(b)]);
  if (!va || !vb) { hideParse(); toast('录音数据缺失', 'err'); return; }

  const parsed = parseVocal(va.frames, { title: va.label });
  if (parsed.silent) { hideParse(); toast('A 参考几乎没检测到人声', 'err'); return; }
  const key = detectKey(parsed.notes);
  const groups = groupPhrases(parsed.notes);
  const counts = groups.map((p) => p.length);
  // 若 A 就是当前参考且已确定歌词，沿用真实歌词；否则用占位符
  const lyricText = (a === S.refVocal?.id && S.lyricsConfirmed && S.lyricText)
    ? alignTextToPhrases(S.lyricText, counts)
    : placeholderLyrics(groups);
  const score = buildScore(parsed.notes, key, lyricText);
  const r = scorePracticeWords(flattenScore(score), key, vb.frames, { tol: S.tol });

  await animateParse();
  hideParse();
  S.lastPractice = { ...r, byLine: groupWordsByLine(r.words), align: r.align };
  S.lastPair = { a, b };
  S.refVocal = va; S.parsed = parsed; S.key = key; S.score = score; S.lyricText = lyricText;
  S.groups = groups; S.charMap = scoreCharMap(score); S.lineBreaks = null; S.lyricsConfirmed = false;
  S.refBlob = await getVocalAudio(a).catch(() => null);
  renderResult();
  S.phase = 'result';
  setStep(3);
}

/* ══════════════════ 导入音频文件 ══════════════════ */

async function importAudioFile(file) {
  await ensureMic();
  showParse('正在分析音频…', file.name);
  try {
    const buf = await decodeFile(S.engine.ctx, file);
    const raw = await analyzeBuffer(S.engine.ctx, buf, { hopSec: 0.01 });
    const frames = normalizeFrames(raw);
    const parsed = parseVocal(frames, { title: file.name });
    const duration = frames.length ? frames[frames.length - 1].t - frames[0].t : 0;
    await saveVocal({
      blob: file, frames, duration,
      label: file.name.replace(/\.[^.]+$/, ''),
      role: 'import', noteCount: parsed.notes.length,
    });
    S.history = await listVocals();
    renderHistory();
    hideParse();
    toast('已导入并加入录音历史，可以设为 A/B 对比', 'ok');
  } catch (e) {
    hideParse();
    toast('导入失败：' + e.message, 'err', 6000);
  }
}

/* ══════════════════ 播放 ══════════════════ */

function stopAudio() {
  if (S.audio) { S.audio.pause(); S.audio.currentTime = 0; }
  el.btnStopAudio.disabled = true;
  stopBirdGlow();
}
async function playVocal(id) {
  const blob = await getVocalAudio(id);
  if (!blob) { toast('这段没有可播放的音频', 'err'); return; }
  playBlob(blob);
}
function playBlob(blob) {
  stopAudio();
  if (S.audioUrl) URL.revokeObjectURL(S.audioUrl);
  S.audioUrl = URL.createObjectURL(blob);
  if (!S.audio) {
    S.audio = new Audio();
    S.audio.addEventListener('ended', () => { el.btnStopAudio.disabled = true; });
  }
  S.audio.src = S.audioUrl;
  S.audio.play().catch((e) => toast('播放失败：' + e.message, 'err'));
  el.btnStopAudio.disabled = false;
}

/* ══════════════════ 复位 ══════════════════ */

function resetToIdle() {
  stopRefPlayback();
  stopBirdGlow();
  // 听写还在跑就停掉
  if (dictate) { dictate.stop(); dictate = null; }
  dictateBase = '';
  el.btnDictate.classList.remove('ok');
  el.btnDictate.textContent = '🎙️ 语音转文字·念歌词';
  el.dictateStatus.textContent = '';
  S.phase = 'idle';
  S.refVocal = null; S.refBlob = null; S.parsed = null; S.key = null; S.score = null; S.lyricText = '';
  S.charMap = null; S.lineBreaks = null; S.groups = null;
  S.lyricsDraft = ''; S.lyricsConfirmed = false; S.speechText = ''; S.speech = null;
  setStep(1);
  el.heroIcon.textContent = '🎤';
  el.heroTitle.textContent = '先录一段纯人声';
  el.heroDesc.textContent = '这段会作为「参考」。录完自动解析出调性、歌词结构和简谱，然后你再清唱一遍来对比。';
  show(el.parsedCard, false); show(el.parseStrip, false); show(el.recordStrip, false);
  show(el.resultWrap, false); show(el.karaoke, false); show(el.stageActions, true);
  el.btnRecordRef.disabled = false;
}

/* ══════════════════ 事件绑定 ══════════════════ */

function bind() {
  el.btnMic.addEventListener('click', () => ensureMic().catch(() => {}));
  el.btnHelp.addEventListener('click', () => show(el.helpMask, true));
  el.btnCloseHelp.addEventListener('click', () => show(el.helpMask, false));
  el.helpMask.addEventListener('click', (e) => { if (e.target === el.helpMask) show(el.helpMask, false); });

  el.btnRecordRef.addEventListener('click', () => startRecording('ref').catch(() => {}));
  // 录前歌词的语音转文字（听写）：念一句停一下自动加标点
  el.btnDictate.addEventListener('click', toggleDictate);
  el.btnStopRec.addEventListener('click', () => stopRecording().catch((e) => toast('录音处理失败：' + e.message, 'err', 6000)));
  el.btnPractice.addEventListener('click', () => {
    if (!S.parsed || !S.score) { toast('请先录入参考人声', 'err'); return; }
    // 没点「确定歌词」也直接开练：把编辑框当前内容按节奏重排并自动锁定
    if (!S.lyricsConfirmed) {
      el.lyricEditor.value = el.lyricEditor.value;
      realignLyrics();
      confirmLyrics();
    }
    startRecording('practice').catch(() => {});
  });
  el.btnRerecord.addEventListener('click', () => startRecording('ref').catch(() => {}));
  el.btnAgain.addEventListener('click', () => {
    if (!S.parsed) { resetToIdle(); return; }
    startRecording('practice').catch(() => {});
  });

  // 歌词：编辑 → 实时预览；识别 → 自动填；重新解析匹配 → 按节奏重钉；确定 → 正式生效
  el.lyricEditor.addEventListener('input', onLyricEdit);
  el.btnRecognize.addEventListener('click', recognizeLyrics);
  el.btnRealign.addEventListener('click', realignLyrics);
  el.btnConfirmLyrics.addEventListener('click', confirmLyrics);
  // 听歌识曲 → 取歌词 → 勾选要唱的句子
  el.btnIdentify.addEventListener('click', () => identifyAndPick().catch((e) => { showSongModal(false); toast('识曲失败：' + e.message, 'err', 6000); }));
  el.btnCloseSong.addEventListener('click', () => showSongModal(false));
  el.songMask.addEventListener('click', (e) => { if (e.target === el.songMask) showSongModal(false); });
  el.btnUseLines.addEventListener('click', useSelectedLines);
  el.btnSearchQuery.addEventListener('click', async () => {
    const q = el.manualQuery.value.trim();
    if (!q) { toast('输入歌名或关键词', 'err'); return; }
    el.songStep.textContent = '正在搜索歌词…';
    const rows = await searchLyricsByQuery(q);
    renderSongCandidates(rows, `「${q}」的候选：`);
  });
  // 解析卡里回放刚录的原声：边听边看简谱逐音符亮格
  el.btnPlayRef.addEventListener('click', () => playRefAudio().catch((e) => toast('播放失败：' + e.message, 'err')));
  el.btnStopRef.addEventListener('click', stopRefPlayback);

  el.btnPlayA.addEventListener('click', () => playResultAudio('a').catch((e) => toast('播放失败：' + e.message, 'err')));
  el.btnPlayB.addEventListener('click', () => playResultAudio('b').catch((e) => toast('播放失败：' + e.message, 'err')));
  el.btnStopAudio.addEventListener('click', () => { stopAudio(); stopBirdGlow(); });

  el.btnComparePair.addEventListener('click', () => comparePair().catch((e) => {
    hideParse(); toast('对比失败：' + e.message, 'err', 6000);
  }));
  el.btnClearPair.addEventListener('click', () => { S.pair = { a: null, b: null }; renderHistory(); });

  el.btnImportAudio.addEventListener('click', () => el.importAudioInput.click());
  el.importAudioInput.addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) importAudioFile(f).catch((err) => { hideParse(); toast('导入失败：' + err.message, 'err'); });
    e.target.value = '';
  });
  el.btnClearAll.addEventListener('click', async () => {
    if (!S.history.length) return;
    if (!confirm('清空全部录音历史？此操作不可撤销。')) return;
    stopAudio();
    await clearVocals();
    S.history = []; S.pair = { a: null, b: null };
    renderHistory(); resetToIdle();
    toast('已清空', 'ok');
  });
}

/* ══════════════════ 测试钩子 ══════════════════ */

function installTestHooks() {
  window.__STUDIO = {
    S,
    async commitReferenceFrames(frames, label = '参考') {
      await commitReference(null, normalizeFrames(frames));
      return { phase: S.phase, key: S.key, score: S.score, lyricText: S.lyricText };
    },
    // 模拟"录前填歌词"：写入预填框再注入参考（解析将按预填结构对齐）
    async setPreLyricsAndCommit(text, frames) {
      if (el.preLyricInput) el.preLyricInput.value = text;
      await commitReference(null, normalizeFrames(frames));
      return {
        lyricText: S.lyricText, charMap: S.charMap, lineBreaks: S.lineBreaks,
        status: el.lyricStatus.textContent,
        lines: S.score?.lines?.length, lineChars: S.score?.lines?.map((l) => l.units.map((u) => u.char).join('')),
      };
    },
    getPreLyrics: () => el.preLyricInput?.value ?? '',
    // 听写状态探针（真实听写需要麦克风+网络，CDP 只能验证 UI 装配）
    dictateState: () => ({
      hasBtn: !!el.btnDictate, hasStatus: !!el.dictateStatus,
      btnText: el.btnDictate.textContent,
      speechOk: speechAvailable(),
      running: !!dictate,
    }),
    // 历史打开 / 时间轴自愈
    async openVocal(id) { await openVocal(id); return { phase: S.phase, lyricText: S.lyricText, lines: S.score?.lines?.length }; },
    healFrames: (frames, blob) => healFrames(frames, blob),
    hasOpenBtn: () => !!document.querySelector('.hist-item button[data-act="open"]'),
    setLyrics(text) { if (el.lyricEditor) { el.lyricEditor.value = text; onLyricEdit(); } return S.score; },
    realignLyrics() { return realignLyrics(); },
    confirmLyrics() { return confirmLyrics(); },
    // 逐格改字：把某个音符上的字改掉
    setCellChar(idx, ch) {
      const inp = el.jpCellEditor.querySelector(`.jce-input[data-note-idx="${idx}"]`);
      if (!inp) return null;
      inp.value = ch;
      onCellEdit({ target: inp });
      return S.charMap[idx];
    },
    // 模拟"解析卡里播放原声到 t 秒"：返回此刻高亮的格
    highlightRefAt(t) {
      highlightRefAt(t);
      return {
        jpOn: [...el.jpSheet.querySelectorAll('.jp-on')].map((n) => Number(n.dataset.noteIdx)),
        cellOn: [...el.jpCellEditor.querySelectorAll('.jce-on')].map((n) => Number(n.dataset.noteIdx)),
        hint: el.refPlayHint.textContent,
      };
    },
    stopRefPlayback,
    glowBirdAt,
    // ── 听歌识曲钩子：CDP 测试用 mock 数据驱动选句流程 ──
    openSongPicker: () => identifyAndPick(),
    // 直接注入歌词候选（绕过网络）
    injectSongCandidates(rows) {
      showSongModal(true);
      renderSongCandidates(rows, '（测试注入的候选）');
      return document.querySelectorAll('.song-cand').length;
    },
    // 直接注入一首歌的整首歌词，进入选句界面
    injectLyricsForPick(plain, trackName = '测试歌', artistName = '测试歌手') {
      showLinePicker({ trackName, artistName, plainLyrics: plain, syncedLyrics: null, duration: 0 });
      return el.songLines.querySelectorAll('input[type="checkbox"]').length;
    },
    // 勾选第 i 行句子（0-based，跳过空行）并应用
    pickLineAndUse(idxList) {
      const boxes = [...el.songLines.querySelectorAll('input[type="checkbox"]')];
      for (const i of idxList) if (boxes[i]) boxes[i].checked = true;
      useSelectedLines();
      return { editor: el.lyricEditor.value, status: el.lyricStatus.textContent };
    },
    setAuddToken: (t) => { setAuddToken(t); return true; },
    identifySong: (blob) => identifySong(blob),
    // 模拟"本轮存下了原声音频"：让播放按钮可用（CDP 里无真实 MediaRecorder）
    simulateRefBlob() {
      S.refBlob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/webm' });
      el.btnPlayRef.disabled = false;
      el.refPlayHint.textContent = '听着原声看简谱，唱到哪个音符就会亮哪一格';
      return true;
    },
    // 模拟"录音时识别到歌词"：注入识别文本并重建解析卡
    setRecognizedLyrics(text) {
      S.speechText = text;
      el.lyricEditor.value = alignTextToPhrases(text, (S.groups || groupPhrases(S.parsed.notes)).map((p) => p.length));
      onLyricEdit();
      return el.lyricEditor.value;
    },
    speechAvailable,
    // 预览 K 歌视图（不依赖麦克风）：铺鸟图 + 进句提示，并把指定时刻的逐字高亮画出来
    previewKaraoke(atSec = 0.2) {
      show(el.parsedCard, false);
      show(el.resultWrap, false);
      show(el.stageActions, false);
      show(el.karaoke, true);
      renderKaraokeBirds(0);
      el.kBirds.dataset.line = '0';
      updateKaraoke(atSec);
      return { hidden: el.karaoke.classList.contains('hidden') };
    },
    renderKaraokeAt(atSec) { updateKaraoke(atSec); return el.kCurLine.innerHTML; },
    async commitPracticeFrames(frames) {
      await commitPractice(null, normalizeFrames(frames));
      return { phase: S.phase, practice: S.lastPractice };
    },
    async comparePairIds(a, b) { S.pair = { a, b }; await comparePair(); return S.lastPractice; },
    async importFrames(frames, label = '导入') {
      const norm = normalizeFrames(frames);
      const parsed = parseVocal(norm, { title: label });
      const rec = await saveVocal({ blob: null, frames: norm, duration: norm[norm.length-1].t - norm[0].t, label, role: 'import', noteCount: parsed.notes.length });
      S.history = await listVocals(); renderHistory();
      return rec.id;
    },
    getState() {
      return {
        phase: S.phase, key: S.key?.name, jianpuKey: S.key?.jianpuKey,
        lyricText: S.lyricText, score: S.score, charMap: S.charMap,
        parsedHidden: el.parsedCard.classList.contains('hidden'),
        resultHidden: el.resultWrap.classList.contains('hidden'),
        karaokeHidden: el.karaoke.classList.contains('hidden'),
        keyName: el.keyName.textContent, lyricEditorValue: el.lyricEditor.value,
        lyricStatus: el.lyricStatus.textContent, lyricsConfirmed: S.lyricsConfirmed,
        hasRecognizeBtn: !!el.btnRecognize, hasRealignBtn: !!el.btnRealign,
        hasConfirmBtn: !!el.btnConfirmLyrics, hasPlayRefBtn: !!el.btnPlayRef,
        hasIdentifyBtn: !!el.btnIdentify,
        refBlob: !!S.refBlob,
        jpLegend: (document.querySelector('.jp-legend') || {}).textContent,
        jpSheet: el.jpSheet.textContent.trim(), jpCells: el.jpSheet.querySelectorAll('.jp-cell').length,
        jceInputs: el.jpCellEditor.querySelectorAll('.jce-input').length,
        jceCells: el.jpCellEditor.querySelectorAll('.jce-cell').length,
        phraseStarts: (S.score?.lines || []).map((l) => l.phraseStart),
        resultText: el.lyricResult.textContent.trim(),
        lrCells: el.lyricResult.querySelectorAll('.lr-cell').length,
        lrLines: el.lyricResult.querySelectorAll('.lr-line').length,
        nbCols: el.noteBlocks.querySelectorAll('.nb-col').length,
        nbBirds: el.noteBlocks.querySelectorAll('.nb-bird').length,
        nbColTops: [...el.noteBlocks.querySelectorAll('.nb-col')].map((c) => {
          const myEl = c.querySelector('.nb-bird.my');
          const bandClass = myEl ? [...myEl.classList].find((x) => ['perfect','ok','sharp','off','missed'].includes(x)) : '';
          const leftPx = myEl ? (myEl.style.left.match(/calc\(50% \+ (-?[\d.]+)px\)/)?.[1] ?? null) : null;
          return {
            ref: Number(c.querySelector('.nb-bird.ref')?.style.top.replace('%', '') || 0),
            my: Number(myEl?.style.top.replace('%', '') || 0),
            band: bandClass || '',
            dx: leftPx != null ? Number(leftPx) : 0,
          };
        }),
        // 单音试听 / 播放联动
        auditionBird(i) {
          auditionBird(i);
          return { idx: i, midi: S.lastPractice?.words?.[i]?.midi, hasCtx: !!S.engine?.ctx };
        },
        glowBirdAt,
        historyCount: S.history.length,
        practiceSummary: S.lastPractice?.summary,
        practiceAlign: S.lastPractice?.align,
      };
    },
    listHistory: () => S.history,
  };
}

/* ══════════════════ 启动 ══════════════════ */

async function init() {
  cacheEls();
  bind();
  installTestHooks();
  S.history = await listVocals();
  renderHistory();
  resetToIdle();
  console.log('[人声对比工作室] ready');
}
init().catch((e) => { console.error(e); toast('初始化失败：' + e.message, 'err', 8000); });
