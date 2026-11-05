/**
 * 歌词：LRC 解析、时间轴索引、自动匹配
 *
 * 设计要点
 * ─────────
 * · LRC 的 [mm:ss.xx] 时间戳是"这句开始唱"的时刻，一句持续到下一句开始
 * · 一条时间戳可能对应多行（重复副歌），要展开
 * · 中文字幕常被切成两句一行，按标点判断是否续接
 * · 自动匹配不能只信 API 的第一条：歌手不同的同曲版本歌词相同，
 *   但纯伴奏版/翻唱改编版会毁掉时间轴，所以要打分挑选
 */

/** 解析一行时间戳，返回毫秒；不是时间戳返回 null */
const TS_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

/**
 * 解析 LRC 文本
 * @param {string} text
 * @returns {Array<{time:number, text:string}>} time 单位秒，按时间升序
 */
export function parseLRC(text) {
  if (!text) return [];
  const out = [];
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // 收集本行所有时间戳
    TS_RE.lastIndex = 0;
    const stamps = [];
    let m;
    let lastEnd = 0;
    while ((m = TS_RE.exec(line)) !== null) {
      const min = Number(m[1]);
      const sec = Number(m[2]);
      let frac = 0;
      if (m[3] !== undefined) {
        const f = m[3];
        frac = f.length === 3 ? Number(f) / 1000 : Number(f) / 100;
      }
      stamps.push(min * 60 + sec + frac);
      lastEnd = m.index + m[0].length;
    }
    if (!stamps.length) continue;

    const content = line.slice(lastEnd).trim();
    for (const t of stamps) {
      out.push({ time: t, text: content });
    }
  }

  out.sort((a, b) => a.time - b.time);

  // 去掉纯元信息行（作词/作曲/编曲…），但保留歌名之外的正文
  const META = /^(作词|作曲|编曲|制作人|出品|监制|混音|录音|吉他|贝斯|鼓|和声|发行|厂牌|词[:：]|曲[:：])/;
  const cleaned = out.filter((l) => !(l.text && META.test(l.text) && l.time < 30));
  return cleaned.length ? cleaned : out;
}

/**
 * 歌词行 → 带结束时间的区间
 * @returns {Array<{start:number,end:number,text:string}>}
 */
export function toIntervals(lines, totalDuration = Infinity) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i];
    const next = lines[i + 1];
    const start = cur.time;
    let end = next ? next.time : start + 4;

    // 最后一句：尽量铺到歌曲结束，而不是只留 4 秒
    if (!next) {
      if (Number.isFinite(totalDuration) && totalDuration > start) {
        end = totalDuration;
      }
    }
    if (end <= start) end = start + 1;
    out.push({ start, end, text: cur.text });
  }
  return out;
}

/**
 * 找当前应该显示哪一句
 * 用二分查找，因为每帧都会调用
 * @returns {{index:number, line:object|null, progress:number}}
 */
export function lineAt(intervals, t) {
  if (!intervals || !intervals.length) return { index: -1, line: null, progress: 0 };

  // 还没到第一句
  if (t < intervals[0].start) {
    return { index: -1, line: null, progress: 0 };
  }
  // 超过最后一句
  const last = intervals[intervals.length - 1];
  if (t >= last.start) {
    const p = last.end > last.start
      ? Math.min(1, (t - last.start) / (last.end - last.start))
      : 1;
    return { index: intervals.length - 1, line: last, progress: p };
  }

  let lo = 0, hi = intervals.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (intervals[mid].start <= t) lo = mid; else hi = mid;
  }
  const cur = intervals[lo];
  const p = cur.end > cur.start
    ? Math.min(1, (t - cur.start) / (cur.end - cur.start))
    : 0;
  return { index: lo, line: cur, progress: p };
}

/* ────────────── 自动匹配评分 ────────────── */

/**
 * 从 lrclib 的搜索结果里挑最合适的一条
 *
 * 评分维度：
 *   + 有同步歌词（没有就只能当纯文本，做不了卡拉OK）
 *   + 歌名相符
 *   + 歌手相符
 *   + 时长接近本地音频（版本越接近，时间轴越准）
 * 惩罚：
 *   - 歌名里带 instrumental / karaoke / 伴奏 / 纯音乐
 *   - 歌词行数太少（可能只是片段）
 *
 * @param {Array} results lrclib /api/search 返回数组
 * @param {{title:string, artist:string, duration:number}} want
 * @returns {Array} 按分数降序，每项加 _score 字段
 */
export function rankLyricCandidates(results, want = {}) {
  const norm = (s) => String(s || '').toLowerCase()
    .replace(/[\s\-_()（）[\]【】,.·:：'"“”‘’!！?？]/g, '');
  const wantTitle = norm(want.title);
  const wantArtist = norm(want.artist);

  const scored = [];
  for (const r of results || []) {
    let score = 0;
    const t = norm(r.trackName);
    const a = norm(r.artistName);

    const synced = (r.syncedLyrics || '').trim();
    if (synced) score += 50;
    else if ((r.plainLyrics || '').trim()) score += 12;
    else continue;                     // 什么歌词都没有，直接丢

    // 歌名匹配
    if (t && wantTitle) {
      if (t === wantTitle) score += 25;
      else if (t.includes(wantTitle) || wantTitle.includes(t)) score += 14;
      else {
        // 完全不相干，权重很低
        score -= 10;
      }
    }

    // 歌手匹配
    if (a && wantArtist) {
      if (a === wantArtist) score += 20;
      else if (a.includes(wantArtist) || wantArtist.includes(a)) score += 10;
    }

    // 时长接近（±3 秒给满分，差越多扣越多）
    if (Number.isFinite(want.duration) && Number.isFinite(r.duration) && r.duration > 0) {
      const diff = Math.abs(r.duration - want.duration);
      if (diff <= 3) score += 18;
      else if (diff <= 8) score += 9;
      else if (diff <= 20) score += 0;
      else score -= 12;
    }

    // 惩罚：伴奏版/纯音乐
    const blob = (r.trackName || '') + ' ' + (r.albumName || '');
    if (/instrumental|karaoke|伴奏|纯音乐|off\s*vocal/i.test(blob)) score -= 40;

    // 惩罚：歌词太短
    const lineCount = synced.split('\n').filter((x) => x.trim()).length;
    if (lineCount > 0 && lineCount < 6) score -= 15;

    scored.push({ ...r, _score: score });
  }

  scored.sort((x, y) => y._score - x._score);
  return scored;
}

/** 判断一首歌是否值得展示为"可用同步歌词" */
export function isUsableLyrics(candidate) {
  return !!(candidate && (candidate.syncedLyrics || '').trim()) && candidate._score > 30;
}

/* ────────────── 从文件名推断歌名/歌手 ────────────── */

/**
 * "周深 - 年轮 (Live).ogg" → { artist: '周深', title: '年轮', versions: 'Live' }
 * "毛不易 _ 周深 - Got It (Live).ogg" → { artist: '毛不易 / 周深', title: 'Got It' }
 */
export function guessTitleArtist(fileName) {
  let s = String(fileName || '').replace(/\.[^.]+$/, '').trim();

  // 抓出括号里的版本标记
  const versions = [];
  s = s.replace(/[（(]([^（）()]*)[）)]/g, (_, inner) => {
    versions.push(inner.trim());
    return '';
  }).trim();

  // 去掉常见的现场标记
  const tail = [];
  s = s.replace(/\b(live|remix|cover|ver\.?|version)\b/gi, (m) => {
    tail.push(m);
    return '';
  }).trim();

  let artist = '';
  let title = s;

  // 先处理 "_" 分隔的多歌手："毛不易 _ 周深 - Got It"
  // 注意 "_" 可能出现在歌名里（如 "9_29Hz"），所以只在 "-" 之前的部分处理
  const dash = s.match(/^(.+?)\s*[-–—]\s*(.+)$/);

  if (dash) {
    const left = dash[1].trim();
    const right = dash[2].trim();

    // 左侧含 "_" 视为多歌手
    const artists = left.split(/\s*_\s*/).map((x) => x.trim()).filter(Boolean);

    // 判断到底哪边是歌手：左侧以 "_" 连接，或右侧明显是歌名时，左歌手右歌名
    if (artists.length > 1) {
      artist = artists.join(' / ');
      title = right;
    } else if (/[_]/.test(left) || left.length <= 12) {
      artist = left;
      title = right;
    } else {
      // 左侧太长，可能是"歌名 - 歌手"格式
      artist = right;
      title = left;
    }
  } else {
    // 没有 "-"：再看有没有 "_" 分隔（如 "周深_大鱼"）
    const us = s.split(/\s*_\s*/).map((x) => x.trim()).filter(Boolean);
    if (us.length === 2) {
      artist = us[0];
      title = us[1];
    }
  }

  return {
    artist: artist.trim(),
    title: title.trim() || s,
    versions: [...versions, ...tail].filter(Boolean).join(' '),
  };
}

/* ────────────── 兜底：纯文本歌词按行均分时间 ────────────── */

/**
 * 没有时间轴时，把纯文本按字数为每行估一个时间。
 * 质量一般，但比完全没歌词好，且用户可以手动修正。
 */
export function distributeByLines(plainText, duration) {
  const lines = String(plainText || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);
  if (!lines.length) return [];

  const totalChars = lines.reduce((a, l) => a + l.length, 0) || 1;
  let t = 0;
  const out = [];
  for (const line of lines) {
    out.push({ time: t, text: line });
    t += (line.length / totalChars) * duration;
  }
  return out;
}
