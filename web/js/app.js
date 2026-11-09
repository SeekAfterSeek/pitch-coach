/**
 * 人声对比工作室 —— 主控制器（全新单页流程）
 * ═══════════════════════════════════════════════════════════
 * 产品逻辑（完全弃用曲库/内置曲目/歌词库那一套）：
 *   1. 上来第一个按钮 = 「录入参考人声」
 *   2. 录完 → 自动解析这段人声（音高 + 节奏 → 逐音符谱）
 *   3. 解析后出现「练唱开始」按钮 → 点它开始清唱录音 → 「停止录音」
 *   4. 停止后 → 自动对比解析（对齐 + 整体评分 + 逐音符诊断）
 *   5. 所有录音进「我的录音」历史；任意两段可互选 A/B 对比
 *
 * 复用底层：audio.js（麦克风/录音/离线分析）、compare.js（解析+对比）、
 *          history.js（本地存储）、pianoroll.js（卷帘）、util.js。
 */

import { AudioEngine, TakeRecorder, decodeFile, analyzeBuffer } from './audio.js';
import {
  parseVocal, compareVocals, compareSummary,
} from './compare.js';
import { SCORE_MODES, HOP_SEC } from './reference.js';
import { PianoRoll } from './pianoroll.js';
import {
  uid, fmtTime, fmtCents, midiToName, clamp,
} from './util.js';
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
  mode: 'exact',

  refVocal: null,       // 当前参考（历史记录对象，含 frames）
  parsedRef: null,      // parseVocal 结果
  lastResult: null,     // compareVocals 结果
  lastPair: { a: null, b: null }, // 结果对应的两条历史 id（用于播放）

  history: [],          // 历史元数据列表
  pair: { a: null, b: null },     // 历史互比选择

  audio: null,          // 当前播放的 <audio>
  audioUrl: null,
};

let roll = null;        // 练唱实时卷帘
let resultRoll = null;  // 对比结果卷帘

/* ══════════════════ DOM ══════════════════ */

const $ = (id) => document.getElementById(id);
const el = {};
function cacheEls() {
  for (const id of [
    'sessionPill','statusDot','statusText','btnMic','btnHelp',
    'stageSteps','stageHero','heroIcon','heroTitle','heroDesc','stageActions','btnRecordRef',
    'recordStrip','recDot','recLabel','recTimer','micMeter','btnStopRec',
    'parseStrip','parseTitle','parseSub','parseBar',
    'parsedCard','parsedBadge','parsedTitle','parsedStats','btnPractice','btnRerecord',
    'stageRoll','rollTimecode','roll','nowPitch','nowCents','nowSub',
    'resultWrap','resultTitle','resultSub','btnPlayA','btnPlayB','btnStopAudio','btnAgain',
    'scoreBand','resultStats','resultRoll','diagCount','diagList','worstList','histBars',
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
  // 帮助弹窗用 .open（带过渡），其余面板用 .hidden
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

/** 把录音帧归一化：t 从 0 开始（AudioContext 是绝对时间） */
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

  // 重置卷帘（练唱时显示参考线 + 你的实时声音）
  if (kind === 'practice' && S.parsedRef) {
    roll = roll || new PianoRoll(el.roll);
    roll.resize();
    roll.setReference(S.parsedRef.ref);
    roll.mode = 'live';
    roll.liveHistory = [];
    roll.live = null;
    show(el.stageRoll, true);
  }

  show(el.recordStrip, true);
  show(el.parsedCard, false);
  show(el.resultWrap, false);
  show(el.stageActions, false);
  el.recLabel.textContent = kind === 'ref' ? '录入参考人声…' : '清唱跟练…';
  S.phase = kind === 'ref' ? 'rec-ref' : 'rec-practice';
  setStep(kind === 'ref' ? 1 : 3);
  loop();
}

function loop() {
  if (!S.recorder?.active) return;
  const f = S.engine.tick();
  if (f) {
    S.recorder.push(f);
    // 电平
    const peak = S.engine.peakLevel();
    el.micMeter.style.width = Math.round(clamp(peak * 260, 0, 100)) + '%';
    // 计时
    const elapsed = Math.max(0, f.t - S.recStartCtx);
    el.recTimer.textContent = fmtTime(elapsed);
    // 练唱实时卷帘
    if (S.recKind === 'practice' && roll) {
      const vt = elapsed;
      const idx = Math.round(vt / (S.parsedRef?.ref.hop || HOP_SEC));
      const ref = S.parsedRef?.ref;
      let band = 'ok';
      let refMidi = null;
      if (ref && idx >= 0 && idx < ref.voiced.length && ref.voiced[idx]) {
        refMidi = ref.midi[idx];
        band = f.voiced && f.midi > 0
          ? deviationBand((f.midi - refMidi) * 100, S.mode)
          : 'missed';
      }
      const live = { t: vt, midi: f.voiced ? f.midi : 0, voiced: f.voiced, band };
      roll.live = live;
      roll.liveHistory = roll.liveHistory || [];
      roll.liveHistory.push(live);
      while (roll.liveHistory.length && roll.liveHistory[0].t < vt - 12) roll.liveHistory.shift();
      roll.followCursor(vt, S.recKind === 'practice' ? 8 : 10);
      roll.cursorT = vt;
      roll.draw();
      el.rollTimecode.textContent = fmtTime(vt);
      // 此刻应唱
      if (refMidi != null) {
        el.nowPitch.textContent = midiToName(refMidi);
        el.nowCents.textContent = f.voiced && f.midi > 0 ? fmtCents((f.midi - refMidi) * 100) : '';
        el.nowSub.textContent = f.voiced && f.midi > 0 ? '你的声音叠在参考线上' : '跟着灰色参考线唱';
      } else {
        el.nowPitch.textContent = '♪';
        el.nowCents.textContent = '';
        el.nowSub.textContent = '间奏 / 换气';
      }
    }
  }
  S.recRAF = requestAnimationFrame(loop);
}

function deviationBand(dev, modeKey) {
  const tol = (SCORE_MODES[modeKey] || SCORE_MODES.exact).tol;
  const a = Math.abs(dev);
  if (a <= tol * 0.25) return 'perfect';
  if (a <= tol * 0.5) return 'great';
  if (a <= tol) return 'ok';
  if (a <= tol * 2) return 'sharp';
  return 'off';
}

async function stopRecording() {
  if (!S.recorder?.active) return;
  cancelAnimationFrame(S.recRAF);
  const rec = S.recorder;
  S.recorder = null;
  const out = await rec.stop();
  show(el.recordStrip, false);
  const frames = normalizeFrames(out.frames);

  if (!frames.length) {
    toast('没录到声音，请重试', 'err');
    resetToIdle();
    return;
  }

  if (S.recKind === 'ref') {
    await commitReference(out.blob, frames);
  } else {
    await commitPractice(out.blob, frames);
  }
}

/* ══════════════════ 参考人声：保存 + 自动解析 ══════════════════ */

async function commitReference(blob, frames) {
  S.phase = 'parse-ref';
  showParse('正在解析参考人声…', '提取音高、节奏、音符');
  setStep(2);

  const duration = frames[frames.length - 1].t - frames[0].t;
  const parsed = parseVocal(frames, { title: '参考人声' });

  // 存历史
  const rec = await saveVocal({
    blob, frames, duration,
    label: '参考 · ' + new Date().toLocaleString('zh-CN', { hour12: false }),
    role: 'reference',
    noteCount: parsed.notes.length,
  });
  S.history = await listVocals();
  renderHistory();

  // 短暂展示解析动画，然后出结果卡
  await animateParse();
  hideParse();

  if (parsed.silent) {
    toast('这段几乎没检测到人声（可能没出声），请重录', 'err', 5000);
    await deleteVocal(rec.id);
    S.history = await listVocals();
    renderHistory();
    resetToIdle();
    return;
  }

  S.refVocal = { ...rec, frames };
  S.parsedRef = parsed;
  S.lastPair.a = rec.id;
  showParsedCard(parsed);
  S.phase = 'ready';
  setStep(3);
}

function showParsedCard(parsed) {
  const ref = parsed.ref;
  el.parsedTitle.textContent = '参考人声 · ' + fmtTime(parsed.duration);
  const lo = midiToName(ref.range.low), hi = midiToName(ref.range.high);
  el.parsedStats.innerHTML = `
    <div class="pstat"><label>时长</label><b>${fmtTime(parsed.duration)}</b></div>
    <div class="pstat"><label>音符</label><b>${parsed.notes.length}</b></div>
    <div class="pstat"><label>音域</label><b>${lo}–${hi}</b></div>
    <div class="pstat"><label>有声占比</label><b>${Math.round(ref.voicedRatio * 100)}%</b></div>`;
  el.heroIcon.textContent = '🎼';
  el.heroTitle.textContent = '参考已解析';
  el.heroDesc.textContent = '下面点「练唱开始」，清唱一遍；唱完点「停止录音」即自动对比解析。';
  show(el.parsedCard, true);
  show(el.stageActions, false);
  show(el.stageRoll, false);
}

function showParse(title, sub) {
  el.parseTitle.textContent = title;
  el.parseSub.textContent = sub;
  el.parseBar.style.width = '0%';
  show(el.parseStrip, true);
  show(el.stageActions, false);
  show(el.parsedCard, false);
}
function hideParse() { show(el.parseStrip, false); el.parseBar.style.width = '100%'; }

function animateParse() {
  return new Promise((resolve) => {
    let p = 0;
    const step = () => {
      p = Math.min(1, p + 0.18 + Math.random() * 0.15);
      el.parseBar.style.width = Math.round(p * 100) + '%';
      if (p < 1) setTimeout(step, 60);
      else setTimeout(resolve, 160);
    };
    step();
  });
}

/* ══════════════════ 练唱：保存 + 自动对比 ══════════════════ */

async function commitPractice(blob, frames) {
  S.phase = 'parse-practice';
  showParse('正在对比解析…', '把这一遍与参考人声对齐、逐音符比对');
  show(el.stageRoll, false);

  const duration = frames[frames.length - 1].t - frames[0].t;
  const rec = await saveVocal({
    blob, frames, duration,
    label: '清唱 · ' + new Date().toLocaleString('zh-CN', { hour12: false }),
    role: 'take',
  });
  S.history = await listVocals();
  renderHistory();

  const r = compareVocals(S.refVocal.frames, frames, {
    mode: SCORE_MODES[S.mode],
    title: S.refVocal.label,
  });

  await animateParse();
  hideParse();

  S.lastResult = r;
  S.lastPair.b = rec.id;
  renderResult(r, '参考人声', rec.label);
  S.phase = 'result';
  setStep(3);
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
          <span class="hi-role">${v.role === 'reference' ? '参考' : v.role === 'import' ? '导入' : '清唱'}</span>
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
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          onHistAction(b.dataset.act, v);
        });
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
      S.history = await listVocals();
      renderHistory();
    }
    return;
  }
  else if (act === 'del') {
    if (!confirm(`删除「${v.label}」？`)) return;
    await deleteVocal(v.id);
    if (S.pair.a === v.id) S.pair.a = null;
    if (S.pair.b === v.id) S.pair.b = null;
    S.history = await listVocals();
    renderHistory();
    return;
  }
  renderHistory();
}

function renderPair() {
  const a = S.history.find((v) => v.id === S.pair.a);
  const b = S.history.find((v) => v.id === S.pair.b);
  const any = !!(a || b);
  show(el.histSelect, any);
  el.selA.textContent = a ? a.label : '（未选）';
  el.selB.textContent = b ? b.label : '（未选）';
  el.btnComparePair.disabled = !(a && b && a.id !== b.id);
}

async function comparePair() {
  const a = S.pair.a, b = S.pair.b;
  if (!a || !b || a === b) return;
  showParse('正在对比解析…', '加载两段人声、对齐、逐音符比对');
  const [va, vb] = await Promise.all([getVocal(a), getVocal(b)]);
  if (!va || !vb) { hideParse(); toast('录音数据缺失', 'err'); return; }
  const r = compareVocals(va.frames, vb.frames, {
    mode: SCORE_MODES[S.mode], title: va.label,
  });
  await animateParse();
  hideParse();
  S.lastResult = r;
  S.lastPair = { a, b };
  renderResult(r, va.label, vb.label);
  S.phase = 'result';
  setStep(3);
  el.resultWrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ══════════════════ 导入音频文件 ══════════════════ */

async function importAudioFile(file) {
  await ensureMic(); // 需要 AudioContext 解码
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

/* ══════════════════ 结果渲染 ══════════════════ */

function renderResult(r, labelA, labelB) {
  show(el.resultWrap, true);
  show(el.parsedCard, false);
  show(el.stageActions, false);
  show(el.stageRoll, false);
  el.heroIcon.textContent = '📊';
  el.heroTitle.textContent = '对比完成';
  el.heroDesc.textContent = '下面是这一遍与参考的逐音符差异。想再练一遍点「再录一遍」。';

  if (!r.ok) {
    el.resultTitle.textContent = '无法对比';
    el.resultSub.textContent = r.reason || '—';
    el.scoreBand.innerHTML = '';
    el.resultStats.innerHTML = '';
    el.diagList.innerHTML = '<div class="empty">' + escapeHtml(r.reason || '无结果') + '</div>';
    el.worstList.innerHTML = '';
    return;
  }

  const s = r.score, st = r.stats;
  el.resultTitle.textContent = '对比解析结果';
  el.resultSub.textContent = `A 参考：${labelA}　·　B 对比：${labelB}` + (r.align.aligned ? `　·　自动对齐 ${fmtCents(-r.align.offset * 1000 / 10)}` : '');

  // 总分条
  const grade = s.total >= 90 ? 'A' : s.total >= 75 ? 'B' : s.total >= 60 ? 'C' : s.total >= 40 ? 'D' : 'E';
  const gradeClass = s.total >= 75 ? 'good' : s.total >= 50 ? 'mid' : 'low';
  el.scoreBand.innerHTML = `
    <div class="grade ${gradeClass}">${grade}</div>
    <div class="grade-num"><b>${s.total}</b><span>总分 / 100</span></div>
    <div class="grade-summary">${escapeHtml(compareSummary(r))}</div>`;

  // 统计卡
  const cards = [
    ['准音率', Math.round(s.pitchAccuracy * 100) + '%', s.pitchAccuracy >= 0.8 ? 'ok' : ''],
    ['覆盖度', Math.round(s.coverage * 100) + '%', s.coverage >= 0.8 ? 'ok' : ''],
    ['平均偏差', Math.round(s.meanAbsCents) + '¢', s.meanAbsCents <= 30 ? 'ok' : ''],
    ['稳定性 σ', Math.round(s.stdev) + '¢', s.stdev <= 25 ? 'ok' : ''],
    ['唱到 / 共', `${st.sung} / ${st.noteCount}`, ''],
    ['偏高 / 偏低', `${st.high} / ${st.low}`, st.high + st.low ? 'warn' : ''],
    ['偏快 / 偏慢', `${st.early} / ${st.late}`, (st.early + st.late) ? 'warn' : ''],
    ['漏唱', `${st.missed}`, st.missed ? 'bad' : 'ok'],
  ];
  el.resultStats.innerHTML = cards.map(([k, v, c]) =>
    `<div class="rstat ${c}"><label>${k}</label><b>${v}</b></div>`).join('');

  // 播放按钮
  el.btnPlayA.disabled = !S.lastPair.a;
  el.btnPlayB.disabled = !S.lastPair.b;

  // 结果卷帘
  resultRoll = resultRoll || new PianoRoll(el.resultRoll);
  resultRoll.resize();
  resultRoll.setReference(r.ref);
  resultRoll.setTake({ frames: r.trackFrames, offset: 0, phraseScores: s.phraseScores });
  resultRoll.setReview(r.durationA);
  resultRoll.draw();

  // 逐音符诊断
  el.diagCount.textContent = `(${r.notes.length} 个音符)`;
  el.diagList.innerHTML = '';
  for (let i = 0; i < r.notes.length; i++) {
    const d = r.notes[i];
    const cls = d.status === 'missed' ? 'missed' : (d.band || 'perfect');
    const target = d.target != null ? midiToName(d.target) : '—';
    const time = `${fmtTime(d.start)}`;
    const row = document.createElement('div');
    row.className = 'diag-row ' + cls;
    row.innerHTML = `
      <span class="d-idx">${i + 1}</span>
      <span class="d-time">${time}</span>
      <span class="d-target">${target}</span>
      <span class="d-text">${escapeHtml(d.text || '')}</span>`;
    el.diagList.appendChild(row);
  }

  // 最差片段
  el.worstList.innerHTML = '';
  if (s.worst?.length) {
    for (const w of s.worst.slice(0, 5)) {
      const row = document.createElement('div');
      row.className = 'worst-row';
      row.innerHTML = `<span class="w-time">${fmtTime(w.t0)}–${fmtTime(w.t1)}</span>
        <span class="w-score">${w.score} 分</span>
        <span class="w-note">平均偏差 ${Math.round(w.meanAbs)}¢${w.meanSigned > 8 ? '（偏高）' : w.meanSigned < -8 ? '（偏低）' : ''}</span>`;
      el.worstList.appendChild(row);
    }
  } else {
    el.worstList.innerHTML = '<div class="empty">没有明显问题片段</div>';
  }

  // 偏差分布直方图
  renderHistogram(r.score.counts);
}

function renderHistogram(counts) {
  if (!counts) { el.histBars.innerHTML = ''; return; }
  const keys = ['perfect','great','ok','sharp','off','missed'];
  const labels = { perfect:'准', great:'很准', ok:'小偏', sharp:'跑调', off:'差很远', missed:'没唱' };
  const colors = { perfect:'#25e08a', great:'#5fe3a1', ok:'#ffd166', sharp:'#ff9f43', off:'#ff4d5e', missed:'#6b7f96' };
  const max = Math.max(1, ...keys.map((k) => counts[k] || 0));
  el.histBars.innerHTML = keys.map((k) => {
    const v = counts[k] || 0;
    const h = Math.round((v / max) * 100);
    return `<div class="hb"><div class="hb-bar" style="height:${Math.max(3,h)}%;background:${colors[k]}"></div>
      <span class="hb-num">${v}</span><span class="hb-lab">${labels[k]}</span></div>`;
  }).join('');
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

/* ══════════════════ 复位 / 再录 ══════════════════ */

function resetToIdle() {
  S.phase = 'idle';
  S.refVocal = null;
  S.parsedRef = null;
  setStep(1);
  el.heroIcon.textContent = '🎤';
  el.heroTitle.textContent = '先录一段纯人声';
  el.heroDesc.textContent = '这段会作为「参考」。录完自动解析出它的音高与节奏，然后你再清唱一遍来对比。';
  show(el.parsedCard, false);
  show(el.parseStrip, false);
  show(el.recordStrip, false);
  show(el.resultWrap, false);
  show(el.stageRoll, false);
  show(el.stageActions, true);
  el.btnRecordRef.disabled = false;
}

/* ══════════════════ 事件绑定 ══════════════════ */

function bind() {
  el.btnMic.addEventListener('click', () => ensureMic().catch(() => {}));
  el.btnHelp.addEventListener('click', () => show(el.helpMask, true));
  el.btnCloseHelp.addEventListener('click', () => show(el.helpMask, false));
  el.helpMask.addEventListener('click', (e) => { if (e.target === el.helpMask) show(el.helpMask, false); });

  el.btnRecordRef.addEventListener('click', () => startRecording('ref').catch(() => {}));
  el.btnStopRec.addEventListener('click', () => stopRecording().catch((e) => {
    toast('录音处理失败：' + e.message, 'err', 6000);
  }));
  el.btnPractice.addEventListener('click', () => {
    if (!S.parsedRef) { toast('请先录入参考人声', 'err'); return; }
    startRecording('practice').catch(() => {});
  });
  el.btnRerecord.addEventListener('click', () => startRecording('ref').catch(() => {}));
  el.btnAgain.addEventListener('click', () => {
    if (!S.parsedRef) { resetToIdle(); return; }
    startRecording('practice').catch(() => {});
  });

  // 评分模式
  el.stageRoll.querySelectorAll('[data-mode]').forEach((b) => {
    b.addEventListener('click', () => {
      S.mode = b.dataset.mode;
      el.stageRoll.querySelectorAll('[data-mode]').forEach((x) => x.classList.toggle('active', x === b));
    });
  });

  // 结果播放
  el.btnPlayA.addEventListener('click', () => S.lastPair.a && playVocal(S.lastPair.a));
  el.btnPlayB.addEventListener('click', () => S.lastPair.b && playVocal(S.lastPair.b));
  el.btnStopAudio.addEventListener('click', stopAudio);

  // 历史互比
  el.btnComparePair.addEventListener('click', () => comparePair().catch((e) => {
    hideParse(); toast('对比失败：' + e.message, 'err', 6000);
  }));
  el.btnClearPair.addEventListener('click', () => { S.pair = { a: null, b: null }; renderHistory(); });

  // 导入 / 清空
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
    renderHistory();
    resetToIdle();
    toast('已清空', 'ok');
  });

  window.addEventListener('resize', () => {
    if (roll && !el.stageRoll.classList.contains('hidden')) { roll.resize(); roll.draw(); }
    if (resultRoll && !el.resultWrap.classList.contains('hidden')) { resultRoll.resize(); resultRoll.draw(); }
  });
}

/* ══════════════════ 测试钩子（CDP 端到端用） ══════════════════ */

function installTestHooks() {
  window.__STUDIO = {
    S,
    // 注入合成帧，绕过麦克风，走完整流程
    async commitReferenceFrames(frames, label = '参考') {
      const norm = normalizeFrames(frames);
      await commitReference(null, norm);
      return { phase: S.phase, refId: S.refVocal?.id, notes: S.parsedRef?.notes.length };
    },
    async commitPracticeFrames(frames) {
      const norm = normalizeFrames(frames);
      await commitPractice(null, norm);
      return { phase: S.phase, result: S.lastResult };
    },
    async comparePairIds(a, b) {
      S.pair = { a, b };
      await comparePair();
      return S.lastResult;
    },
    async importFrames(frames, label = '导入') {
      const norm = normalizeFrames(frames);
      const parsed = parseVocal(norm, { title: label });
      const rec = await saveVocal({ blob: null, frames: norm, duration: norm[norm.length-1].t - norm[0].t, label, role: 'import', noteCount: parsed.notes.length });
      S.history = await listVocals(); renderHistory();
      return rec.id;
    },
    getState() {
      return {
        phase: S.phase,
        historyCount: S.history.length,
        refId: S.refVocal?.id,
        lastResult: S.lastResult,
        pair: S.pair,
        heroTitle: el.heroTitle.textContent,
        recordHidden: el.recordStrip.classList.contains('hidden'),
        parseHidden: el.parseStrip.classList.contains('hidden'),
        parsedHidden: el.parsedCard.classList.contains('hidden'),
        resultHidden: el.resultWrap.classList.contains('hidden'),
        stageActionsHidden: el.stageActions.classList.contains('hidden'),
        practiceBtnExists: !!el.btnPractice,
        stopBtnExists: !!el.btnStopRec,
        scoreBand: el.scoreBand.textContent.trim(),
        diagRows: el.diagList.querySelectorAll('.diag-row').length,
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

init().catch((e) => {
  console.error(e);
  toast('初始化失败：' + e.message, 'err', 8000);
});
