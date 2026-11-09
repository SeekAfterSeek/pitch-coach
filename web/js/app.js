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

import { AudioEngine, TakeRecorder, decodeFile, analyzeBuffer } from './audio.js';
import { parseVocal } from './compare.js';
import {
  detectKey, buildScore, flattenScore, jianpuHtml, placeholderLyrics, groupPhrases,
} from './notation.js';
import { scorePracticeWords, groupWordsByLine, lineSummary } from './practice.js';
import { uid, fmtTime, clamp } from './util.js';
import {
  saveVocal, listVocals, getVocal, getVocalAudio,
  renameVocal, deleteVocal, clearVocals, vocalSubtitle,
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
  parsed: null,         // { ref, notes, frames, duration, silent }
  key: null,            // detectKey 结果
  lyricText: '',        // 用户编辑的歌词（按行）
  score: null,          // buildScore 结果（逐字谱）

  lastPractice: null,   // { words, byLine, summary }
  lastPair: { a: null, b: null },

  history: [],
  pair: { a: null, b: null },

  audio: null,
  audioUrl: null,
  countdown: 0,        // 练唱倒计时剩余秒
  countdownRAF: 0,
};

/* ══════════════════ DOM ══════════════════ */

const $ = (id) => document.getElementById(id);
const el = {};
function cacheEls() {
  for (const id of [
    'sessionPill','statusDot','statusText','btnMic','btnHelp',
    'stageSteps','stageHero','heroIcon','heroTitle','heroDesc','stageActions','btnRecordRef',
    'recordStrip','recDot','recLabel','recTimer','micMeter','btnStopRec',
    'parseStrip','parseTitle','parseSub','parseBar',
    'parsedCard','parsedBadge','parsedTitle','parsedKey','keyName','keyJianpu',
    'lyricEditor','parsedBlock','scoreInfo','jpSheet','btnPractice','btnRerecord',
    'karaoke','kCount','kPrevLine','kCurLine','kNextLine','kProgressFill','kHint',
    'resultWrap','resultTitle','resultSub','btnPlayA','btnPlayB','btnStopAudio','btnAgain',
    'lyricResult',
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

/* ══════════════════ 录音 ══════════════════ */

async function startRecording(kind) {
  await ensureMic();
  if (S.recorder?.active) return;
  S.recKind = kind;
  S.recorder = new TakeRecorder(S.engine);
  S.recorder.start();
  S.recStartCtx = S.recorder.t0;

  show(el.recordStrip, true);
  show(el.parsedCard, false);
  show(el.resultWrap, false);
  show(el.karaoke, false);
  show(el.stageActions, false);
  el.recLabel.textContent = kind === 'ref' ? '录入参考人声…' : '练唱中…';
  S.phase = kind === 'ref' ? 'rec-ref' : 'rec-practice';
  setStep(kind === 'ref' ? 1 : 3);

  if (kind === 'practice') {
    // 进入练唱：先 3-2-1 倒计时，再开始逐字卡拉OK + 录音
    startCountdown(() => loop());
  } else {
    loop();
  }
}

/** 3-2-1 倒计时：显示在卡拉OK面板，结束后执行 cb（开始画逐字） */
function startCountdown(cb) {
  show(el.karaoke, true);
  el.kPrevLine.innerHTML = '';
  el.kNextLine.innerHTML = '';
  el.kHint.textContent = '准备…';
  el.kProgressFill.style.width = '0%';
  S.countdown = 3;
  const tick = () => {
    if (S.countdown <= 0) {
      el.kCount.classList.add('hidden');
      el.kHint.textContent = '跟着高亮的字唱';
      cb();
      return;
    }
    el.kCount.classList.remove('hidden');
    el.kCount.textContent = String(S.countdown);
    // 重新触发动画
    el.kCount.style.animation = 'none';
    void el.kCount.offsetWidth;
    el.kCount.style.animation = '';
    S.countdown -= 1;
    S.countdownRAF = setTimeout(tick, 1000);
  };
  tick();
}

function loop() {
  if (!S.recorder?.active) return;
  const f = S.engine.tick();
  if (f) {
    S.recorder.push(f);
    el.micMeter.style.width = Math.round(clamp(S.engine.peakLevel() * 260, 0, 100)) + '%';
    const elapsed = Math.max(0, f.t - S.recStartCtx);
    el.recTimer.textContent = fmtTime(elapsed);
    if (S.recKind === 'practice') updateKaraoke(elapsed);
  }
  S.recRAF = requestAnimationFrame(loop);
}

/** 练唱中：逐字高亮当前句，显示每字的简谱与节拍 */
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

  const renderLine = (line, active) => {
    if (!line) return '';
    return line.units.map((u) => {
      const on = active && vt >= u.start && vt < u.end;
      return `<span class="k-unit${on ? ' on' : ''}${vt > u.end ? ' done' : ''}">
        <span class="k-jp">${jianpuHtml(u.jianpu)}</span>
        <span class="k-beat">${escapeHtml(u.beat)}</span>
        <span class="k-char">${escapeHtml(u.char || '○')}</span>
      </span>`;
    }).join('');
  };

  el.kPrevLine.innerHTML = renderLine(prev, false);
  el.kCurLine.innerHTML = renderLine(cur, true);
  el.kNextLine.innerHTML = renderLine(next, false);

  // 整句进度条
  const span = Math.max(0.1, cur.end - cur.start);
  const p = clamp((vt - cur.start) / span, 0, 1);
  el.kProgressFill.style.width = (p * 100).toFixed(1) + '%';
  // 距离下一句开始的倒计时提示
  if (next && vt < cur.end) {
    const toNext = Math.max(0, cur.end - vt);
    el.kHint.textContent = `本句还剩 ${toNext.toFixed(1)}s`;
  } else {
    el.kHint.textContent = '跟着高亮的字唱';
  }
}

async function stopRecording() {
  if (!S.recorder?.active) return;
  cancelAnimationFrame(S.recRAF);
  clearTimeout(S.countdownRAF);
  const rec = S.recorder;
  S.recorder = null;
  const out = await rec.stop();
  show(el.recordStrip, false);
  show(el.karaoke, false);
  const frames = normalizeFrames(out.frames);
  if (!frames.length) {
    toast('没录到声音，请重试', 'err');
    resetToIdle();
    return;
  }
  if (S.recKind === 'ref') await commitReference(out.blob, frames);
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
  S.parsed = parsed;
  S.key = detectKey(parsed.notes);
  const phrases = groupPhrases(parsed.notes);
  S.lyricText = placeholderLyrics(phrases);   // ○ 占位，用户可编辑
  S.score = buildScore(parsed.notes, S.key, S.lyricText);
  S.lastPair.a = rec.id;
  renderParsedCard();
  S.phase = 'ready';
  setStep(3);
}

/** 解析卡：只渲染 ① 调性 ② 歌词编辑器 ③ 简谱 */
function renderParsedCard() {
  el.keyName.textContent = S.key.name;
  el.keyJianpu.textContent = S.key.jianpuKey + ' · ' + S.score.bpm + ' BPM';
  el.lyricEditor.value = S.lyricText;
  el.scoreInfo.textContent = `${S.key.jianpuKey} · ${S.score.noteCount} 个音 · ${S.score.lines.length} 句`;
  renderJianpuSheet();
  el.heroIcon.textContent = '🎼';
  el.heroTitle.textContent = '解析完成';
  el.heroDesc.textContent = '确认调性、填好歌词、看懂简谱，然后点「练唱开始」。';
  show(el.parsedCard, true);
  show(el.stageActions, false);
}

/** 简谱表：按乐句分行，每字显示简谱符号 + 节拍 + 歌词字 */
function renderJianpuSheet() {
  const s = S.score;
  el.jpSheet.innerHTML = s.lines.map((line) => `
    <div class="jp-line">
      <div class="jp-row jp-notes">${line.units.map((u) =>
        `<span class="jp-cell"><span class="jp-note">${jianpuHtml(u.jianpu)}</span><span class="jp-beat">${escapeHtml(u.beat)}</span></span>`).join('')}</div>
      <div class="jp-row jp-lyric">${line.units.map((u) => `<span class="jp-ch">${escapeHtml(u.char || '○')}</span>`).join('')}</div>
    </div>`).join('');
}

/** 用户编辑歌词 → 重建逐字谱 + 简谱表（实时） */
function onLyricEdit() {
  S.lyricText = el.lyricEditor.value;
  S.score = buildScore(S.parsed.notes, S.key, S.lyricText);
  renderJianpuSheet();
  el.scoreInfo.textContent = `${S.key.jianpuKey} · ${S.score.noteCount} 个音 · ${S.score.lines.length} 句`;
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
  el.resultTitle.textContent = '这一遍唱得怎么样';
  el.resultSub.textContent = `共 ${st.total} 字 · 唱到 ${st.sung} · 偏高 ${st.high} · 偏低 ${st.low} · 偏快 ${st.early} · 偏慢 ${st.late} · 没唱到 ${st.missed}`;
  el.btnPlayA.disabled = !S.lastPair.a;
  el.btnPlayB.disabled = !S.lastPair.b;

  const lines = S.lastPractice.byLine;
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
          <button class="btn tiny" data-act="a" title="设为 A 参考">A</button>
          <button class="btn tiny" data-act="b" title="设为 B 对比">B</button>
          <button class="btn tiny ghost" data-act="play" title="播放">▶</button>
          <button class="btn tiny ghost" data-act="rename" title="重命名">✎</button>
          <button class="btn tiny ghost" data-act="del" title="删除">✕</button>
        </div>`;
      card.querySelectorAll('button').forEach((b) => {
        b.addEventListener('click', (e) => { e.stopPropagation(); onHistAction(b.dataset.act, v); });
      });
      card.addEventListener('dblclick', () => onHistAction('rename', v));
      el.histList.appendChild(card);
    }
  }
  renderPair();
}

async function onHistAction(act, v) {
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
  const phrases = groupPhrases(parsed.notes);
  const lyricText = placeholderLyrics(phrases);
  const score = buildScore(parsed.notes, key, lyricText);
  const r = scorePracticeWords(flattenScore(score), key, vb.frames, { tol: S.tol });

  await animateParse();
  hideParse();
  S.lastPractice = { ...r, byLine: groupWordsByLine(r.words) };
  S.lastPair = { a, b };
  S.refVocal = va; S.parsed = parsed; S.key = key; S.score = score; S.lyricText = lyricText;
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
  S.phase = 'idle';
  S.refVocal = null; S.parsed = null; S.key = null; S.score = null; S.lyricText = '';
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
  el.btnStopRec.addEventListener('click', () => stopRecording().catch((e) => toast('录音处理失败：' + e.message, 'err', 6000)));
  el.btnPractice.addEventListener('click', () => {
    if (!S.parsed || !S.score) { toast('请先录入参考人声', 'err'); return; }
    startRecording('practice').catch(() => {});
  });
  el.btnRerecord.addEventListener('click', () => startRecording('ref').catch(() => {}));
  el.btnAgain.addEventListener('click', () => {
    if (!S.parsed) { resetToIdle(); return; }
    startRecording('practice').catch(() => {});
  });

  // 歌词编辑 → 实时重建逐字谱
  el.lyricEditor.addEventListener('input', onLyricEdit);

  el.btnPlayA.addEventListener('click', () => S.lastPair.a && playVocal(S.lastPair.a));
  el.btnPlayB.addEventListener('click', () => S.lastPair.b && playVocal(S.lastPair.b));
  el.btnStopAudio.addEventListener('click', stopAudio);

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
    setLyrics(text) { if (el.lyricEditor) { el.lyricEditor.value = text; onLyricEdit(); } return S.score; },
    // 预览 K 歌视图（不依赖麦克风）：显示倒计时，并把指定时刻的逐字高亮画出来
    previewKaraoke(atSec = 0.2) {
      show(el.parsedCard, false);
      show(el.resultWrap, false);
      show(el.stageActions, false);
      startCountdown(() => updateKaraoke(atSec));
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
        lyricText: S.lyricText, score: S.score,
        parsedHidden: el.parsedCard.classList.contains('hidden'),
        resultHidden: el.resultWrap.classList.contains('hidden'),
        karaokeHidden: el.karaoke.classList.contains('hidden'),
        keyName: el.keyName.textContent, lyricEditorValue: el.lyricEditor.value,
        jpSheet: el.jpSheet.textContent.trim(), jpCells: el.jpSheet.querySelectorAll('.jp-cell').length,
        resultText: el.lyricResult.textContent.trim(),
        lrCells: el.lyricResult.querySelectorAll('.lr-cell').length,
        lrLines: el.lyricResult.querySelectorAll('.lr-line').length,
        historyCount: S.history.length,
        practiceSummary: S.lastPractice?.summary,
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
