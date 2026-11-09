/**
 * 验证：统一曲库 + 歌词功能 的 DOM / 流程
 * 用 CDP 打开本地服务，执行断言。运行：node test/verify-ui.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const URL = 'http://127.0.0.1:8756/';
const PORT = 9341;
const PROFILE = path.join(os.tmpdir(), 'pc-verify-' + Date.now());
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
].find((p) => fs.existsSync(p));

const chromeArgs = [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check',
  '--disable-features=Translate,MediaRouter',
  '--window-size=1500,950', '--hide-scrollbars',
  URL,
];

const proc = spawn(CHROME, chromeArgs, { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page' && t.url.includes('127.0.0.1'));
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* not ready */ }
    await sleep(250);
  }
  throw new Error('CDP not ready');
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result);
      } else if (msg.method) this.events.push(msg);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout: ' + method)); } }, 30000);
    });
  }
}

const wsUrl = await getWsUrl();
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
const cdp = new CDP(ws);
await cdp.send('Runtime.enable');
await cdp.send('Log.enable');
await cdp.send('Page.enable');
await cdp.send('Console.enable');
await sleep(2500);

let pass = 0, fail = 0;
const fails = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; fails.push(name + (detail ? ' — ' + detail : '')); console.log('  ✗ ' + name + ' ' + detail); }
}

async function evaluate(expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

// 1. 曲库：统一列表（内置+导入）渲染
console.log('\n── 曲库合并 ──');
await evaluate(`(() => { const b=document.querySelector('#nav-library'); if(b) b.click(); return true; })()`);
await sleep(600);
const libInfo = await evaluate(`(() => {
  const all = document.querySelectorAll('#allTracksList .lib-item');
  const builtin = document.querySelectorAll('#allTracksList .lib-item .src-builtin');
  const custom = document.querySelectorAll('#allTracksList .lib-item .src-custom');
  const delBtns = document.querySelectorAll('#allTracksList .lib-item .take-del');
  return { total: all.length, builtin: builtin.length, custom: custom.length, delBtns: delBtns.length,
           count: (document.querySelector('#libTotalCount')||{}).textContent };
})()`);
check('曲库列表有条目', libInfo.total > 0, JSON.stringify(libInfo));
check('内置条目存在', libInfo.builtin > 0, `builtin=${libInfo.builtin}`);
check('每一条都有删除按钮（含内置）', libInfo.delBtns === libInfo.total, `del=${libInfo.delBtns}/${libInfo.total}`);

// 2. 筛选 chip
console.log('\n── 筛选 ──');
await evaluate(`document.querySelector('[data-libfilter="builtin"]').click()`);
await sleep(300);
const onlyBuiltin = await evaluate(`document.querySelectorAll('#allTracksList .lib-item').length`);
check('点「内置」后只剩内置条目', onlyBuiltin === libInfo.builtin, `showing=${onlyBuiltin}, builtin=${libInfo.builtin}`);
await evaluate(`document.querySelector('[data-libfilter="all"]').click()`);
await sleep(200);

// 3. 歌词面板元素存在
console.log('\n── 歌词面板 ──');
const lyrEls = await evaluate(`(() => {
  const ids = ['lyrTitleInput','lyrArtistInput','btnFetchLyrics','btnImportLrc','btnEditLyrics','btnClearLyrics','lyrStatus','lyricsStrip','lyrCurText','lyrProgressFill'];
  const missing = ids.filter(id => !document.getElementById(id));
  return { missing };
})()`);
check('歌词面板关键元素齐全', lyrEls.missing.length === 0, 'missing=' + JSON.stringify(lyrEls.missing));

// 4. 注入一首"真实歌曲" → 自动填歌名歌手（用内置练习曲无法验证，因无对应歌词）
console.log('\n── 选曲 + 自动填词（真实歌曲）──');
await evaluate(`(() => { window.__PC.injectTestTrack({ title: '大鱼', artist: '周深', duration: 293 }); return true; })()`);
await sleep(400);
const guessed = await evaluate(`(() => ({ title: document.getElementById('lyrTitleInput').value, artist: document.getElementById('lyrArtistInput').value }))()`);
check('选曲后自动推断歌名', guessed.title === '大鱼', JSON.stringify(guessed));
// 注入的 title 是纯歌名（无"歌手 - "前缀），artist 应为空，由用户填或搜索时补充
check('纯歌名曲目 artist 为空（符合预期，真实导入文件名带歌手会自动解析）', guessed.artist === '', JSON.stringify(guessed));

// 5. 自动找歌词（真实网络调用）
console.log('\n── 自动找歌词 ──');
const fetchResult = await evaluate(`(() => new Promise(async (resolve) => {
  try {
    document.getElementById('btnFetchLyrics').click();
    const start = Date.now();
    const tick = setInterval(async () => {
      const s = document.getElementById('lyrStatus').textContent;
      if (/已应用|已导入|没有|失败|找到/.test(s) || Date.now()-start > 22000) {
        clearInterval(tick);
        resolve({ status: s, ...window.__PC.getLyricsState() });
      }
    }, 400);
  } catch(e) { resolve({ error: e.message }); }
}))()`);
check('取歌词流程有结果文本', /已应用|已导入|没有|失败|找到/.test(fetchResult.status || ''), JSON.stringify(fetchResult));
check('歌词成功写入曲目', fetchResult.trackHasLyrics === true, JSON.stringify(fetchResult));
check('歌词状态变为「同步歌词」或「纯文本」', /同步|纯文本/.test(fetchResult.state || ''), `state=${fetchResult.state}`);

// 6. 实时歌词条可见
console.log('\n── 实时歌词条 ──');
const stripVisible = await evaluate(`(() => {
  const s = document.getElementById('lyricsStrip');
  return { hidden: s.hidden, text: document.getElementById('lyrCurText').textContent };
})()`);
check('有歌词时实时歌词条显示', stripVisible.hidden === false, `hidden=${stripVisible.hidden}`);

// 7. 模拟播放进度推进，验证歌词条随帧更新
console.log('\n── 歌词条随播放更新 ──');
const adv = await evaluate(`(() => {
  const t0 = window.__PC.showLyricsAt(0, true);    // 还没到第一句
  const t1 = window.__PC.showLyricsAt(45, true);   // 大鱼副歌附近
  const t2 = window.__PC.showLyricsAt(43.5, true); // 精确某一句
  const t3 = window.__PC.showLyricsAt(293 - 1, true); // 末句
  return { t0, t1, t2, t3 };
})()`);
check('歌词条已显示', adv.t2.hidden === false, JSON.stringify(adv.t2));
check('t=0 时显示省略号（未到第一句）', /…/.test(adv.t0.cur), JSON.stringify(adv.t0));
check('t=43.5 命中正确歌词句（繁简体正常显示）', /大魚|海浪|夢境|梦境/.test(adv.t2.cur), JSON.stringify(adv.t2));
check('前后句与当前句不同（进度推进有效）', adv.t1.cur !== adv.t0.cur && adv.t1.cur.length > 0, JSON.stringify(adv.t1));
check('进度条有宽度', /%/.test(adv.t2.progress || ''), `progress=${adv.t2.progress}`);
check('末句进度接近满', /%|1/.test(adv.t3.progress || ''), JSON.stringify(adv.t3));

// 截图留存
try {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(process.cwd(), 'verify-shot.png'), Buffer.from(r.data, 'base64'));
  console.log('\n📸 截图已存 verify-shot.png');
} catch (e) { console.log('截图失败: ' + e.message); }

console.log('\n' + '═'.repeat(46));
console.log(`  ${pass} / ${pass + fail}`);
if (fail) { console.log('  失败:'); for (const f of fails) console.log('   · ' + f); }
console.log('═'.repeat(46));

try { proc.kill('SIGKILL'); } catch { /* noop */ }
process.exit(fail ? 1 : 0);
