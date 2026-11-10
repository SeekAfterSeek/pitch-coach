/**
 * 听歌识曲 + 歌词获取
 * ═══════════════════════════════════════════════════════════
 * 用户录的参考人声如果「其实是唱某首歌」，不用每次手输歌词：
 *   1. identifySong(blob) —— 把录音片段发给 AudD 听歌识曲 API，
 *      拿到 歌名 / 歌手（Shazam 同源曲库）。需要用户在 https://dashboard.audd.io/
 *      免费注册一个 api_token（免费额度每天可用，test token 每天有限次）。
 *   2. searchLyrics(title, artist, duration) —— 用歌名/歌手查 lrclib.net
 *      （免费公开歌词库，CORS 开放、无需 key），拿到整首歌词（纯文本/LRC）。
 *   3. pickLines(plainLyrics) —— 用户勾选要唱的几句，拼成歌词文本
 *      交给「重新解析匹配」钉到谱子上。
 *
 * 网络不可用 / 没配 token / 没识别到 → 全部优雅降级：
 *   返回 null，UI 提示走手输歌词的老路。识别是辅助，不是唯一来源。
 */

const AUDD_API = 'https://api.audd.io/';
const LRCLIB_API = 'https://lrclib.net';
const LRCLIB_UA = 'PitchCoach-Studio v1.0 (local singing trainer)';

/** 读用户配置的 AudD token（localStorage，本机保存） */
export function getAuddToken() {
  try { return localStorage.getItem('pc_audd_token') || ''; } catch { return ''; }
}
export function setAuddToken(t) {
  try { t ? localStorage.setItem('pc_audd_token', t) : localStorage.removeItem('pc_audd_token'); } catch { /* noop */ }
}

/**
 * 听歌识曲：把录音 blob 发给 AudD
 * @param {Blob} blob 录音（webm/opus 可以直接发，AudD 接受常见音频格式）
 * @param {{token?:string, api?:string}} opts
 * @returns {Promise<{title:string, artist:string, album:string, duration:number,
 *                     artwork:string}|null>} 没识别到/出错返回 null
 */
export async function identifySong(blob, opts = {}) {
  const token = opts.token || getAuddToken();
  if (!token) return null;
  try {
    const fd = new FormData();
    fd.append('api_token', token);
    fd.append('file', blob, 'clip.webm');
    fd.append('return', 'apple_music,spotify');
    const res = await fetch(AUDD_API, { method: 'POST', body: fd });
    if (!res.ok) return null;
    const j = await res.json();
    const m = j?.result;
    if (!m || m === 'No result' || !m.title) return null;
    return {
      title: String(m.title || '').trim(),
      artist: String(m.artist || '').trim(),
      album: String(m.album || '').trim(),
      duration: Number(m.duration_sec) || 0,
      artwork: String(m.apple_music?.artwork?.url || m.spotify?.album?.images?.[0]?.url || '')
        .replace('{w}', '160').replace('{h}', '160'),
    };
  } catch { return null; }
}

/**
 * 用歌名/歌手查歌词（lrclib，免费公开、无需 key、CORS 开放）
 * @param {{title:string, artist?:string, duration?:number}} want
 * @returns {Promise<Array<{id:number, trackName:string, artistName:string,
 *            duration:number, plainLyrics:string, syncedLyrics:string}>>}
 *          按相关度排好（synced 优先、歌名/歌手相符优先、时长接近优先）
 */
export async function searchLyrics(want = {}) {
  if (!want.title) return [];
  const q = new URLSearchParams();
  if (want.artist) q.set('artist_name', want.artist);
  q.set('track_name', want.title);
  const rows = await lrclibFetch(`/api/search?${q}`);
  return rankLyricRows(rows || [], want);
}

/** 关键词搜（歌名拿不准时用） */
export async function searchLyricsByQuery(q) {
  if (!q || !q.trim()) return [];
  const rows = await lrclibFetch(`/api/search?q=${encodeURIComponent(q.trim())}`);
  return rankLyricRows(rows || [], { title: q.trim() });
}

/** 直接按 id 拿整条歌词记录 */
export async function getLyricsById(id) {
  return lrclibFetch(`/api/get/${id}`);
}

async function lrclibFetch(path) {
  try {
    const res = await fetch(LRCLIB_API + path, { headers: { 'Lrclib-Client': LRCLIB_UA } });
    if (!res.ok) return [];
    return await res.json();
  } catch { return []; }
}

/** 给 lrclib 搜索结果打分排序（有同步歌词/歌名相符/时长接近优先） */
function rankLyricRows(rows, want = {}) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[\s\-_()（）[\]【】,·:：'"“”!！?？]/g, '');
  const wantTitle = norm(want.title);
  const wantArtist = norm(want.artist);
  return rows
    .filter((r) => (r.plainLyrics || '').trim() || (r.syncedLyrics || '').trim())
    .map((r) => {
      let s = 0;
      if ((r.syncedLyrics || '').trim()) s += 30;
      const t = norm(r.trackName), a = norm(r.artistName);
      if (t && wantTitle) {
        if (t === wantTitle) s += 25;
        else if (t.includes(wantTitle) || wantTitle.includes(t)) s += 12;
        else s -= 8;
      }
      if (a && wantArtist) {
        if (a === wantArtist) s += 20;
        else if (a.includes(wantArtist) || wantArtist.includes(a)) s += 10;
      }
      if (Number.isFinite(want.duration) && want.duration > 0 && Number(r.duration) > 0) {
        const d = Math.abs(Number(r.duration) - want.duration);
        s += d <= 3 ? 15 : d <= 8 ? 8 : d <= 20 ? 0 : -10;
      }
      return { ...r, _score: s };
    })
    .sort((x, y) => y._score - x._score);
}

/**
 * 从整首纯文本歌词里拆出"一句一行"（标点即句子边界，句尾标点保留供分句用）
 * @param {string} plain 整首歌词（多行）
 * @returns {Array<{text:string, blank:boolean}>} 行列表（含空行分隔段落的标记）
 */
export function splitSongLines(plain) {
  return String(plain || '').replace(/\r\n?/g, '\n').split('\n')
    .map((raw) => ({ raw, text: raw.trim(), blank: !raw.trim() }));
}

/** LRC 文本 → 纯文本行（去 [mm:ss.xx] 时间戳） */
export function lrcToPlainLines(lrc) {
  return String(lrc || '').replace(/\r\n?/g, '\n').split('\n')
    .map((l) => l.replace(/^\s*\[(\d{1,3}):(\d{1,2})(?:[.:]\d{1,3})?\]\s*/, '').trim())
    .filter((x) => x && !/^(作词|作曲|编曲|制作人|混音|录音|吉他|贝斯|鼓|和声|发行|厂牌)/.test(x));
}
