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
 * 把用户改过的歌词钉到音符序列上 —— 两步分离：
 *
 *  第一步【第一性：字↔音符一一对应】
 *    把所有可唱字按「每句字数 : 每句音符数」+ 句时长权重，流式分配到音符流上。
 *    每个字找到它该在的音符；字多并进长音，字少补 ○。这一步与排版无关。
 *
 *  第二步【排版：按用户标点分行】（buildScore 的 lineBreaks 参数消费）
 *    用户写了 N 个标点句 → 音符流被切成 N 行。切点按"每行音符数 ≈ 该句字数
 *    按时长权重摊到的音符数"求出，只影响好看，不碰第一步的对应关系。
 *
 * @param {string} text 用户歌词框里的文本（可含换行和标点）
 * @param {Array<Array>} groups groupPhrases(notes) 的结果（提供音符流与时长权重）
 * @returns {{charMap:Array<string>, lineBreaks:Array<number>, text:string,
 *            perLine:Array<Array<string>>, userPhrases:number,
 *            totalChars:number, noteCount:number, byPunctuation:boolean}}
 */
export function realignLyricsToScore(text, groups, opts = {}) {
  const g = groups || [];
  const noteCount = g.reduce((s, x) => s + x.length, 0);
  if (!noteCount) {
    return { charMap: [], lineBreaks: [], text: '', perLine: [], userPhrases: 0,
      totalChars: 0, noteCount: 0, byPunctuation: false };
  }

  // 1) 收集用户的句子：标点优先，其次手动换行，最后整段当一句
  const punctSplit = splitByPunctuation(String(text || ''));
  const raw = String(text || '').replace(/\r\n?/g, '\n').split('\n')
    .map((l) => cleanLyricChars(l))
    .filter((cs) => cs.length && !cs.every((c) => c === '○'));
  const sentences = punctSplit.length > 1 ? punctSplit
    : (raw.length > 1 ? raw : [cleanLyricChars(String(text || ''))]);
  const userPhrases = sentences.length;

  // 2) 【第一性】把所有字流式钉到音符流上：
  //    每个音符的"应得字数" = 总字数 × (该音符时长权重)，累计取整生成容量表，
  //    字按顺序填进容量里 —— 音程对应关系天然正确，与句子怎么分无关。
  const flatNotes = g.flat();
  const chars = sentences.flat();
  const totalChars = chars.length;
  const capacities = noteCapacities(flatNotes, totalChars);

  const charMap = new Array(noteCount).fill('○');
  let ci = 0;
  for (let ni = 0; ni < noteCount && ci < totalChars; ni++) {
    const cap = capacities[ni];
    if (cap <= 0) continue;
    charMap[ni] = chars.slice(ci, ci + cap).join('');
    ci += cap;
  }
  // 字比音符多且容量吃满还剩 → 并进最后一个有字音符
  if (ci < totalChars) {
    const last = Math.max(0, noteCount - 1);
    charMap[last] = charMap[last] === '○' ? '' : charMap[last];
    charMap[last] += chars.slice(ci).join('');
  }

  // 3) 【排版】按用户句数求行切点：每句音符数 ≈ 该句字数 × 时长权重
  const spans = g.map((line) => {
    const st = Math.min(...line.map((n) => n.start));
    const en = Math.max(...line.map((n) => n.end ?? n.start + 0.5));
    return Math.max(0.01, en - st);
  });
  const totalSpan = spans.reduce((a, b) => a + b, 0) || 1;
  const lineBreaks = computeLineBreaks(sentences, g, spans, totalSpan);

  // 4) 供显示的 perLine / text（排版后的行）
  const perLine = [];
  let si = 0;
  for (let li = 0; li < lineBreaks.length; li++) {
    const end = lineBreaks[li];
    const seg = charMap.slice(si, end);
    perLine.push(seg);
    si = end;
  }
  const outText = perLine.map((cs) => cs.join('')).join('\n');

  return {
    charMap,
    lineBreaks,
    text: outText,
    perLine,
    userPhrases,
    totalChars,
    noteCount,
    byPunctuation: punctSplit.length > 1,
  };
}

/**
 * 每个音符的"应得字数"容量表：总字数按音符时长占比摊到每个音符上，
 * 累计取整保证 Σcap = min(totalChars, noteCount) 且容量分布平滑。
 * 长音天然分到更多字（拖字/转音），短音一字一音。
 */
function noteCapacities(flatNotes, totalChars) {
  const n = flatNotes.length;
  if (totalChars <= n) return flatNotes.map((_, i) => (i < totalChars ? 1 : 0));
  const durs = flatNotes.map((nt) => Math.max(0.02, (nt.end ?? nt.start + 0.5) - nt.start));
  const totalDur = durs.reduce((a, b) => a + b, 0) || 1;
  const caps = [];
  let acc = 0;   // 已分配字数（浮点累计）
  let got = 0;   // 已取整字数
  for (let i = 0; i < n; i++) {
    acc += (durs[i] / totalDur) * totalChars;
    const c = Math.round(acc) - got;   // 这一音分到的字数
    caps.push(Math.max(1, c));
    got += caps[i];
  }
  // 修正取整误差：多退少补到 totalChars
  let diff = got - totalChars;
  let i = n - 1;
  while (diff !== 0 && i >= 0) {
    if (diff > 0 && caps[i] > 1) { caps[i]--; diff--; }
    else if (diff < 0) { caps[i]++; diff++; }
    else i--;
  }
  return caps;
}

/**
 * 按用户句数求排版行切点（音符全局索引数组，升序，末项=noteCount）。
 * 每行音符数 ≈ 该句字数 × (乐句时长权重)，在原乐句边界附近微调，
 * 保证切点落在音符流上、行数正好等于用户句数。
 */
function computeLineBreaks(sentences, groups, spans, totalSpan) {
  const noteCount = groups.reduce((s, x) => s + x.length, 0);
  const K = sentences.length;
  if (K <= 1) return [noteCount];

  // 每个用户句分到的理想音符数
  const totalSentenceChars = Math.max(1, sentences.reduce((a, x) => a + x.length, 0));
  const want = sentences.map((s, k) => {
    const byChars = s.length / totalSentenceChars;
    const bySpan = spans[Math.min(k, spans.length - 1)] / totalSpan;
    return k === K - 1
      ? 0 // 末句吃余数
      : Math.max(1, Math.round(noteCount * (0.6 * byChars + 0.4 * bySpan)));
  });
  const breaks = [];
  let acc = 0;
  for (let k = 0; k < K - 1; k++) {
    acc += want[k];
    // 夹在 [acc-2, acc+2] 且落在音频乐句边界附近（偏移 ≤1 个音符）最优，
    // 但不强制——排版美观优先于乐句边界
    breaks.push(Math.min(Math.max(1, acc), noteCount - (K - 1 - k)));
  }
  // 保证递增且末项 = noteCount
  for (let k = 1; k < breaks.length; k++) {
    if (breaks[k] <= breaks[k - 1]) breaks[k] = breaks[k - 1] + 1;
  }
  breaks.push(noteCount);
  return breaks;
}

/** 按用户歌词里的标点切句：返回每句的可唱字符数组。
 *  「一闪一闪，亮晶晶。」→ [['一','闪','一','闪'], ['亮','晶','晶']]
 *  没有任何分句标点时返回 []。 */
function splitByPunctuation(text) {
  const PUNCT_RE = /[，。！？、；：,.!?;:…—~～]/;
  const parts = String(text || '').replace(/\r\n?/g, '\n').split(PUNCT_RE)
    .map((seg) => cleanLyricChars(seg))
    .filter((cs) => cs.length && !cs.every((c) => c === '○'));
  return parts.length > 1 ? parts : [];
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
