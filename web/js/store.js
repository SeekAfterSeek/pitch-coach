/**
 * 本地存储：录音、评分结果、曲库
 * - 录音音频（webm blob）与逐帧数据存 IndexedDB（体积大）
 * - 曲库元数据与设置存 localStorage；曲库的音频 Blob 也存 IndexedDB
 * 全部本地，不上传任何数据。
 */

const DB_NAME = 'pitchcoach';
const DB_VER = 2;                  // v2：新增 trackAudio，存导入歌曲的音频
const STORE_TAKES = 'takes';
const STORE_BLOBS = 'blobs';
const STORE_TRACK_AUDIO = 'trackAudio';
const LS_TRACKS = 'pc.tracks.v1';
const LS_SETTINGS = 'pc.settings.v1';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_TAKES)) {
        const s = db.createObjectStore(STORE_TAKES, { keyPath: 'id' });
        s.createIndex('trackId', 'trackId', { unique: false });
        s.createIndex('createdAt', 'createdAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_BLOBS)) {
        db.createObjectStore(STORE_BLOBS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_TRACK_AUDIO)) {
        db.createObjectStore(STORE_TRACK_AUDIO, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

function req2p(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* ────────────── 录音 ────────────── */

/**
 * 保存一条录音
 * @param {object} take {id, trackId, trackTitle, label, frames, score, duration, createdAt, offset}
 * @param {Blob} blob
 */
export async function saveTake(take, blob) {
  const db = await openDB();
  // 帧数据压缩成 Float32（JSON 太大）
  const packed = packFrames(take.frames);
  const record = {
    ...take,
    frames: undefined,
    packed,
    hasAudio: !!blob,
    audioType: blob?.type || '',
    size: blob?.size || 0,
  };
  await req2p(tx(db, STORE_TAKES, 'readwrite').put(record));
  if (blob) {
    await req2p(tx(db, STORE_BLOBS, 'readwrite').put({ id: take.id, blob }));
  }
  return record;
}

export async function listTakes(trackId = null) {
  const db = await openDB();
  const all = await req2p(tx(db, STORE_TAKES, 'readonly').getAll());
  const list = trackId ? all.filter((t) => t.trackId === trackId) : all;
  list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return list;
}

export async function getTake(id) {
  const db = await openDB();
  const rec = await req2p(tx(db, STORE_TAKES, 'readonly').get(id));
  if (!rec) return null;
  return { ...rec, frames: unpackFrames(rec.packed) };
}

export async function getTakeAudio(id) {
  const db = await openDB();
  const rec = await req2p(tx(db, STORE_BLOBS, 'readonly').get(id));
  return rec?.blob || null;
}

export async function deleteTake(id) {
  const db = await openDB();
  await req2p(tx(db, STORE_TAKES, 'readwrite').delete(id));
  await req2p(tx(db, STORE_BLOBS, 'readwrite').delete(id)).catch(() => {});
}

export async function clearAll() {
  const db = await openDB();
  await req2p(tx(db, STORE_TAKES, 'readwrite').clear());
  await req2p(tx(db, STORE_BLOBS, 'readwrite').clear());
}

/* ── 帧打包 ──
 * 每帧 4 个字段：t(float32, 秒) midi(float32) voiced(uint8) rms(float32)
 * 打包成一个 ArrayBuffer，体积约为 JSON 的 1/8
 */
export function packFrames(frames) {
  const n = frames.length;
  const stride = 4;
  const f32 = new Float32Array(n * stride);
  for (let i = 0; i < n; i++) {
    const f = frames[i];
    const o = i * stride;
    f32[o] = f.t;
    f32[o + 1] = f.midi || 0;
    f32[o + 2] = f.voiced ? 1 : 0;
    f32[o + 3] = f.rms || 0;
  }
  return f32.buffer;
}

export function unpackFrames(buffer) {
  if (!buffer) return [];
  const f32 = new Float32Array(buffer);
  const n = f32.length / 4;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    out[i] = {
      t: f32[o],
      midi: f32[o + 1],
      voiced: f32[o + 2] > 0.5,
      rms: f32[o + 3],
    };
  }
  return out;
}

/* ────────────── 自定义曲库 ──────────────
 *
 * 关键：音频 Blob 绝对不能放进 localStorage。
 * JSON.stringify(Blob) 会得到 "{}"，存下去就是一个空对象——
 * 刷新页面后曲目还在，但 createObjectURL({}) 失败，播放毫无声音。
 * 所以拆成两处：
 *   localStorage  ← 元数据（标题、时长、参考轨道、有无音频）
 *   IndexedDB     ← 音频 Blob（体积大，支持二进制）
 */

export function loadTracks() {
  try {
    const list = JSON.parse(localStorage.getItem(LS_TRACKS) || '[]');
    // 清洗历史脏数据：把残留的空 blob 对象删掉
    for (const t of list) {
      if (t.audioBlob && !(t.audioBlob instanceof Blob)) {
        t.hasAudio = t.hasAudio || false;
        delete t.audioBlob;
      }
    }
    return list;
  } catch { return []; }
}

/** 只序列化元数据，剥掉所有非 JSON 值（尤其是 Blob） */
function serializeTrack(track) {
  const out = { ...track };
  delete out.audioBlob;
  delete out._blob;
  // 记录是否带有音频，供加载时判断
  out.hasAudio = !!(track.audioBlob || track.hasAudio);
  return out;
}

export function saveTracks(list) {
  localStorage.setItem(LS_TRACKS, JSON.stringify(list.map(serializeTrack)));
}

/**
 * 新增/更新曲目。
 * 若 track.audioBlob 是真 Blob，会被异步写进 IndexedDB。
 */
export async function addTrack(track) {
  const list = loadTracks();
  const i = list.findIndex((t) => t.id === track.id);
  const meta = serializeTrack(track);
  if (i >= 0) list[i] = meta; else list.push(meta);
  saveTracks(list);

  if (track.audioBlob instanceof Blob) {
    await putTrackAudio(track.id, track.audioBlob);
  }
  return list;
}

export async function removeTrack(id) {
  const list = loadTracks().filter((t) => t.id !== id);
  saveTracks(list);
  await deleteTrackAudio(id).catch(() => {});
  return list;
}

/* ── 曲目音频（IndexedDB）── */

export async function putTrackAudio(id, blob) {
  const db = await openDB();
  await req2p(tx(db, STORE_TRACK_AUDIO, 'readwrite').put({ id, blob }));
}

export async function getTrackAudio(id) {
  const db = await openDB();
  const rec = await req2p(tx(db, STORE_TRACK_AUDIO, 'readonly').get(id));
  return rec?.blob || null;
}

export async function deleteTrackAudio(id) {
  const db = await openDB();
  await req2p(tx(db, STORE_TRACK_AUDIO, 'readwrite').delete(id));
}

/** 清空曲库音频 */
export async function clearTrackAudio() {
  const db = await openDB();
  await req2p(tx(db, STORE_TRACK_AUDIO, 'readwrite').clear());
}

/**
 * 加载所有曲目并补齐音频 Blob（从 IndexedDB 读回来）
 * 返回的对象里 audioBlob 是真正的 Blob，可以直接 createObjectURL
 */
export async function loadTracksWithAudio() {
  const list = loadTracks();
  for (const t of list) {
    if (t.hasAudio) {
      try {
        const blob = await getTrackAudio(t.id);
        if (blob) t.audioBlob = blob;
        else t.hasAudio = false;   // 音频丢失，标记出来
      } catch {
        t.hasAudio = false;
      }
    }
  }
  return list;
}

/* ────────────── 设置 ────────────── */

export const DEFAULT_SETTINGS = {
  scoreMode: 'exact',
  tolerance: 50,
  transpose: 0,
  latencyMs: 0,
  autoCalibrate: true,
  clickTrack: false,
  playReference: true,
  // 导入的人声音轨本身响度就比合成器低，0.55 听着会太小。
  // 默认给满，用户嫌吵可以自己调。
  referenceVolume: 0.9,
  micVolume: 1,
  showRealtimeScore: true,
  minConfidence: 0.6,
  windowSec: 6,
};

const LS_MIGRATED = 'pc.migrated.v1';

export function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}'); } catch { saved = {}; }

  // 一次性迁移：旧版默认音量 0.55 对导入的人声音轨太小，
  // 老用户 localStorage 里存着旧值，光改默认值对他们无效。
  // 只迁移"从未手动调过"的情况（值正好等于旧默认值）。
  try {
    if (localStorage.getItem(LS_MIGRATED) !== '1') {
      if (saved.referenceVolume === 0.55) saved.referenceVolume = 0.9;
      localStorage.setItem(LS_MIGRATED, '1');
    }
  } catch { /* 忽略 */ }

  return { ...DEFAULT_SETTINGS, ...saved };
}

export function saveSettings(s) {
  localStorage.setItem(LS_SETTINGS, JSON.stringify(s));
}

/* ────────────── 导出 ────────────── */

export function downloadJSON(name, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  triggerDownload(name, blob);
}

export function downloadBlob(name, blob) {
  triggerDownload(name, blob);
}

function triggerDownload(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
