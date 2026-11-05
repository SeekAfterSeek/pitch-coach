/**
 * 本地存储：录音、评分结果、曲库
 * - 录音音频（webm blob）与逐帧数据存 IndexedDB（体积大）
 * - 曲库与设置存 localStorage
 * 全部本地，不上传任何数据。
 */

const DB_NAME = 'pitchcoach';
const DB_VER = 1;
const STORE_TAKES = 'takes';
const STORE_BLOBS = 'blobs';
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

/* ────────────── 自定义曲库 ────────────── */

export function loadTracks() {
  try {
    return JSON.parse(localStorage.getItem(LS_TRACKS) || '[]');
  } catch { return []; }
}

export function saveTracks(list) {
  localStorage.setItem(LS_TRACKS, JSON.stringify(list));
}

export function addTrack(track) {
  const list = loadTracks();
  const i = list.findIndex((t) => t.id === track.id);
  if (i >= 0) list[i] = track; else list.push(track);
  saveTracks(list);
  return list;
}

export function removeTrack(id) {
  const list = loadTracks().filter((t) => t.id !== id);
  saveTracks(list);
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
  referenceVolume: 0.55,
  micVolume: 1,
  showRealtimeScore: true,
  minConfidence: 0.6,
  windowSec: 6,
};

export function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}') };
  } catch { return { ...DEFAULT_SETTINGS }; }
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
