/**
 * 回归测试：导入歌曲的音频持久化与播放
 *
 * 覆盖三个曾经真实存在的 bug：
 *   B1. addTrack 把 Blob 塞进 localStorage → JSON 序列化成 {}，刷新后音频丢失
 *   B2. play() 对导入曲目误走合成器分支 → scheduleNotes(null) 抛 TypeError，静默无声音
 *   B3. 「跟唱参考音」开关只存设置，从不作用于播放
 *
 * 用法：先启动服务器，再 node test/audio-persist.test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.TEST_CDP_PORT || 9371);
const PROFILE = path.join(os.tmpdir(), 'pc-audiotest-' + Date.now());
const BASE = process.env.PC_BASE || 'http://127.0.0.1:8756/';

// 测试用音频：优先用仓库自带的合成样本，避免依赖用户音乐库
const TEST_AUDIO = path.join(__dirname, '..', 'samples', 'fake-mic-scale.wav');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${name} ${detail}`); }
}

if (!fs.existsSync(TEST_AUDIO)) {
  console.error('缺少测试音频：' + TEST_AUDIO);
  console.error('先运行：python python/pitchcoach_cli.py demo -o samples/demo-scale.wav');
  process.exit(1);
}

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => fs.existsSync(p));

if (!CHROME) { console.error('找不到 Chrome'); process.exit(1); }

const proc = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--window-size=1400,900',
  '--autoplay-policy=no-user-gesture-required',
  BASE,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const p = list.find((t) => t.type === 'page' && t.url.includes('127.0.0.1'));
      if (p?.webSocketDebuggerUrl) return p.webSocketDebuggerUrl;
    } catch { /* wait */ }
    await sleep(250);
  }
  throw new Error('CDP not ready');
}

const wsUrl = await getWsUrl();
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res);
  ws.addEventListener('error', rej);
});

let msgId = 0;
const pending = new Map();
const events = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { res } = pending.get(m.id);
    pending.delete(m.id);
    res(m.result);
  } else if (m.method) {
    events.push(m);
  }
});

function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res) => pending.set(id, { res }));
}

async function ev(expr) {
  const r = await send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true, userGesture: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  }
  return r.result.value;
}

await send('Runtime.enable');
await sleep(2500);

console.log('\n── B1：音频必须存进 IndexedDB，不能进 localStorage ──');

// /api/file 只允许读用户目录（安全设计），测试音频在项目目录里，
// 所以直接把字节以 base64 注入页面。
const audioB64 = fs.readFileSync(TEST_AUDIO).toString('base64');

const imp = await ev(`(async () => {
  const bin = atob(${JSON.stringify(audioB64)});
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const blob = new Blob([arr], { type: 'audio/wav' });
  const file = new File([blob], 'persist-test.wav', { type: 'audio/wav' });
  const t = await window.__PC.importForTest(file, { title: '持久化测试', range: 'auto', snap: true });

  const { getTrackAudio } = await import('./js/store.js');
  const back = await getTrackAudio(t.id);
  const ls = JSON.parse(localStorage.getItem('pc.tracks.v1') || '[]');

  return {
    id: t.id,
    srcSize: t.audioBlob?.size ?? -1,
    idbSize: back?.size ?? -1,
    lsHasBlobKey: ls[0] ? ('audioBlob' in ls[0]) : null,
    lsHasAudioFlag: ls[0]?.hasAudio ?? null,
  };
})()`);

check('导入时拿到了音频 Blob', imp.srcSize > 0, `${imp.srcSize} 字节`);
check('音频已写入 IndexedDB', imp.idbSize === imp.srcSize, `IDB ${imp.idbSize} vs 源 ${imp.srcSize}`);
check('localStorage 不含 audioBlob 字段', imp.lsHasBlobKey === false, `含: ${imp.lsHasBlobKey}`);
check('localStorage 记录了 hasAudio 标记', imp.lsHasAudioFlag === true, `${imp.lsHasAudioFlag}`);

console.log('\n── 刷新页面 ──');
events.length = 0;
await send('Page.reload');
await sleep(4000);

console.log('\n── B1 续：刷新后音频仍然完整 ──');

const after = await ev(`(() => {
  const S = window.__PC.S;
  const t = S.customTracks[0];
  const b = t?.audioBlob;
  return {
    count: S.customTracks.length,
    title: t?.title,
    blobIsBlob: b instanceof Blob,
    blobSize: b instanceof Blob ? b.size : -1,
  };
})()`);

check('刷新后曲目还在', after.count >= 1, `${after.count} 条`);
check('刷新后 audioBlob 是真 Blob（不是空对象）', after.blobIsBlob === true);
check('刷新后音频大小与导入时一致', after.blobSize === imp.srcSize, `${after.blobSize} vs ${imp.srcSize}`);

console.log('\n── B2：导入曲目必须走音频模式，不能误入合成器分支 ──');

const play = await ev(`(async () => {
  const S = window.__PC.S;
  const t = S.customTracks[0];
  window.__PC.selectTrack(t.id);
  await new Promise(r => setTimeout(r, 500));
  window.__PC.play();
  await new Promise(r => setTimeout(r, 2500));
  const el = S.audioEl;
  return {
    playing: S.playing,
    hasEl: !!el,
    src: el ? el.src.slice(0, 20) : '',
    readyState: el?.readyState ?? -1,
    duration: el?.duration ?? null,
    paused: el?.paused ?? null,
    currentTime: el?.currentTime ?? null,
    errorCode: el?.error?.code ?? null,
  };
})()`);

check('播放状态为 playing', play.playing === true);
check('audio 元素已创建并绑定 src', play.hasEl && play.src.startsWith('blob:'), play.src);
check('音频已就绪（readyState=4）', play.readyState === 4, `readyState=${play.readyState}`);
check('时长解析正确', Number.isFinite(play.duration) && play.duration > 1, `${play.duration}`);
check('确实在播放（未暂停、时间在走）', play.paused === false && play.currentTime > 0.2,
  `paused=${play.paused} t=${play.currentTime}`);

// 直接测量输出电平，确认真的有声
const meter = await ev(`(async () => {
  const S = window.__PC.S;
  const ctx = S.engine.ctx;
  let peak = 0;
  try {
    const src = ctx.createMediaElementSource(S.audioEl);
    const an = ctx.createAnalyser();
    an.fftSize = 2048;
    src.connect(an);
    an.connect(ctx.destination);
    const buf = new Float32Array(an.fftSize);
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 100));
      an.getFloatTimeDomainData(buf);
      for (const v of buf) peak = Math.max(peak, Math.abs(v));
    }
  } catch (e) {
    return { err: e.message, peak: 0 };
  }
  return { peak, vol: S.audioEl.volume, muted: S.audioEl.muted };
})()`);

check('输出电平非零（真的有声）', meter.peak > 0.01,
  `peak=${(meter.peak || 0).toFixed(4)} ${meter.err || ''}`);
check('默认音量够大（≥0.8）', (meter.vol ?? 0) >= 0.8, `volume=${meter.vol}`);
check('没有处于静音状态', meter.muted === false);

console.log('\n── B3：跟唱参考音开关必须真正生效 ──');

const toggle = await ev(`(async () => {
  const S = window.__PC.S;
  const cb = document.getElementById('cbReference');
  const before = { muted: S.audioEl.muted, vol: S.audioEl.volume };

  cb.checked = false;
  cb.dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 250));
  const off = { muted: S.audioEl.muted, vol: S.audioEl.volume };

  cb.checked = true;
  cb.dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 250));
  const on = { muted: S.audioEl.muted, vol: S.audioEl.volume };

  return { before, off, on };
})()`);

check('关闭开关 → 立刻静音', toggle.off.muted === true && toggle.off.vol === 0,
  JSON.stringify(toggle.off));
check('打开开关 → 立刻恢复有声', toggle.on.muted === false && toggle.on.vol > 0,
  JSON.stringify(toggle.on));

console.log('\n── 无 JS 运行时错误 ──');
const errs = events
  .filter((e) => e.method === 'Runtime.exceptionThrown')
  .map((e) => e.params.exceptionDetails?.exception?.description);
check('控制台无异常', errs.length === 0, errs.slice(0, 2).join(' | '));

// 收尾
await ev(`window.__PC.stopPlayback && window.__PC.stopPlayback()`).catch(() => {});
ws.close();
await sleep(200);
try { proc.kill(); } catch { /* noop */ }
try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* noop */ }

console.log('\n' + '═'.repeat(50));
console.log(`  ${pass} / ${pass + fail}`);
if (fail) {
  console.log('  失败:');
  for (const f of failures) console.log('   · ' + f);
}
console.log('═'.repeat(50));
process.exit(fail ? 1 : 0);
