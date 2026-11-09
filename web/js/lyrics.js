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

/* ────────────── 歌词识别结果 → 逐句歌词 ────────────── */

/** 去掉标点、空白、语气拖音，只留可唱字符 */
export function cleanLyricChars(text) {
  return [...String(text || '')].filter((c) => !/^[\s\p{P}\p{S}]+$/u.test(c));
}

/**
 * 把一段识别出来的连续文本，按"乐句数 / 每句音符数"分配成逐行歌词。
 *
 * 例：谱子分 2 句、音符数 [4,3]，识别到「一闪一闪亮晶晶」7 字
 *     → ['一闪一闪', '亮晶晶']（正好一字一音符，用户可在框里改）
 *
 * 策略：
 *  - 用户若自己按行写了文本，优先按用户分行
 *  - 否则按每句音符数比例切分连续文本
 *  - 字数与音符数不齐：多了并进末字、少了补 ○
 *
 * @param {string} text 识别/粘贴的文本
 * @param {Array<number>} lineNoteCounts 每句的音符数
 * @returns {string} 逐行歌词文本（\n 分隔）
 */
export function alignTextToPhrases(text, lineNoteCounts) {
  const counts = lineNoteCounts || [];
  if (!counts.length) return '';
  const userLines = String(text || '').replace(/\r\n?/g, '\n').split('\n').map((x) => x.trim()).filter((x) => x && !/^[○\s]+$/.test(x));

  let chunks;
  if (userLines.length >= counts.length) {
    // 用户已按行写：取前 N 行
    chunks = userLines.slice(0, counts.length);
  } else {
    // 连续文本：按每句音符数比例切
    const chars = cleanLyricChars(text);
    chunks = [];
    let ci = 0;
    const total = counts.reduce((a, b) => a + b, 0) || 1;
    for (let i = 0; i < counts.length; i++) {
      let take = Math.max(1, Math.round((counts[i] / total) * chars.length));
      if (i === counts.length - 1) take = chars.length - ci; // 末句吃掉余数
      take = Math.min(take, Math.max(0, chars.length - ci));
      chunks.push(chars.slice(ci, ci + take).join(''));
      ci += take;
    }
  }

  // 每行补齐/截断到该句音符数
  return chunks.map((line, i) => {
    const cs = cleanLyricChars(line);
    const n = counts[i];
    const out = [];
    for (let j = 0; j < n; j++) {
      if (j === n - 1) out.push(cs.slice(j).join('') || '○');
      else out.push(cs[j] ?? '○');
    }
    return out.join('');
  }).join('\n');
}

/* ────────────── 节奏感知的「重新解析匹配」 ────────────── */

/**
 * 把用户改过的歌词，按第一次录音解析出的「节奏骨架」重新钉到每个音符上。
 *
 * 与 alignTextToPhrases 的区别（后者只按"每句音符数"比例硬切）：
 *   - 乐句边界来自音频里音符间的大空档（groupPhrases 的结果）
 *   - 连续歌词按【每句实际演唱时长】占比切分，而不是按音符个数占比
 *     —— 唱得久的句子理应分到更多字，这才叫"按节奏"
 *   - 用户在框里手动换的行数正好等于乐句数时，完全尊重用户的分句
 *   - 句内字数 > 音符数：多出的字并进【时值最长】的音符（长音拖字/转音）
 *     字数 ≤ 音符数：一字一音符，其余补 ○（用户可在逐格编辑器里补字）
 *
 * 输出 charMap 是"按音符全局顺序展平的字数组"，可直接喂给
 * buildScore(notes, key, text, { charMap })，保证"哪个字对应哪个音符"精确可查。
 *
 * @param {string} text 用户歌词框里的文本（可含换行）
 * @param {Array<Array>} groups groupPhrases(notes) 的结果，音符含 start/end
 * @returns {{text:string, charMap:Array<string>, perLine:Array<Array<string>>,
 *            phraseCount:number, totalChars:number, noteCount:number}}
 */
export function realignLyricsToScore(text, groups, opts = {}) {
  const g = groups || [];
  const noteCount = g.reduce((s, x) => s + x.length, 0);
  if (!noteCount) {
    return { text: '', charMap: [], perLine: [], phraseCount: 0, totalChars: 0, noteCount: 0 };
  }

  // 1) 清洗用户输入：按行收集可唱字符，丢掉空行 / 纯占位行
  const raw = String(text || '').replace(/\r\n?/g, '\n').split('\n')
    .map((l) => cleanLyricChars(l))
    .filter((cs) => cs.length && !cs.every((c) => c === '○'));

  // 2) 每句的节奏权重 = 该句实际演唱跨度（时长），不是音符个数
  const spans = g.map((line) => {
    const st = Math.min(...line.map((n) => n.start));
    const en = Math.max(...line.map((n) => n.end ?? n.start + 0.5));
    return Math.max(0.01, en - st);
  });
  const totalSpan = spans.reduce((a, b) => a + b, 0) || 1;

  // 3) 字符分配到各句
  let perLineChars;
  if (raw.length === g.length) {
    // 用户手动分的行数正好等于乐句数 → 尊重用户分句
    perLineChars = raw.slice(0, g.length);
  } else {
    // 连续文本 / 行数不符 → 按演唱时长占比切分（按节奏）
    const chars = raw.flat();
    perLineChars = [];
    let ci = 0;
    for (let i = 0; i < g.length; i++) {
      let take = i === g.length - 1
        ? chars.length - ci
        : Math.max(1, Math.round((spans[i] / totalSpan) * chars.length));
      take = Math.min(Math.max(take, 0), Math.max(0, chars.length - ci));
      perLineChars.push(chars.slice(ci, ci + take));
      ci += take;
    }
  }

  // 4) 句内把字符钉到每个音符
  const perLine = g.map((line, i) => assignCharsToNotes(perLineChars[i] || [], line));
  const charMap = perLine.flat();
  const outText = perLine.map((cs) => cs.join('')).join('\n');

  return {
    text: outText,
    charMap,
    perLine,
    phraseCount: g.length,
    totalChars: raw.flat().length,
    noteCount,
  };
}

/** 句内分配：字数 > 音符 → 多余字并进最长音符；字数 ≤ 音符 → 一字一音符，其余 ○ */
function assignCharsToNotes(chars, notes) {
  const n = notes.length;
  const out = new Array(n).fill('○');
  if (!chars || !chars.length) return out;
  if (chars.length <= n) {
    for (let i = 0; i < chars.length; i++) out[i] = chars[i];
    return out;
  }
  for (let i = 0; i < n; i++) out[i] = chars[i];
  let li = 0, ld = -Infinity;
  for (let i = 0; i < n; i++) {
    const d = (notes[i].end ?? notes[i].start + 0.5) - notes[i].start;
    if (d > ld) { ld = d; li = i; }
  }
  out[li] = out[li] + chars.slice(n).join('');
  return out;
}
