/**
 * 录音历史（纯人声）
 * ═══════════════════════════════════════════════════════════
 * 每次录入一段人声 = 一条历史记录：
 *   - 音频 Blob（webm/opus）→ IndexedDB 的 blobs store（二进制，不进 localStorage）
 *   - 逐帧音高数据（Float32 打包）→ IndexedDB 的 vocals store
 *   - 元数据（名称/时长/创建时间/角色/音域/有声占比）→ 同一条记录
 *
 * 全部本地，不上传。所有写入都返回 Promise。
 */

import { packFrames, unpackFrames } from './store.js';
import { uid, fmtTime } from './util.js';

const DB_NAME = 'pitchcoach_vocal_v1';
const DB_VER = 1;
const S_VOCALS = 'vocals';
const S_BLOBS = 'blobs';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(S_VOCALS)) {
        const s = db.createObjectStore(S_VOCALS, { keyPath: 'id' });
        s.createIndex('createdAt', 'createdAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(S_BLOBS)) {
        db.createObjectStore(S_BLOBS, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function req2p(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * 保存一条人声录音
 * @param {{blob:Blob, frames:Array, duration:number, label?:string, role?:string, meta?:object}} input
 * @returns 完整的记录（含解包后的 frames，便于直接用）
 */
export async function saveVocal(input) {
  const id = uid('voc');
  const createdAt = Date.now();
  const frames = input.frames || [];
  const voiced = frames.filter((f) => f.voiced && f.midi > 0);
  const midis = voiced.map((f) => f.midi);
  const low = midis.length ? Math.min(...midis) : 0;
  const high = midis.length ? Math.max(...midis) : 0;
  const rec = {
    id,
    createdAt,
    label: input.label || `录音 ${new Date(createdAt).toLocaleString('zh-CN', { hour12: false })}`,
    role: input.role || 'take',           // 'reference' | 'take' | 'import'
    duration: input.duration || (frames.length ? frames[frames.length - 1].t - frames[0].t : 0),
    noteCount: input.noteCount || 0,
    voicedRatio: frames.length ? voiced.length / frames.length : 0,
    lowMidi: low, highMidi: high,
    size: input.blob?.size || 0,
    audioType: input.blob?.type || '',
    hasAudio: !!input.blob,
    packed: packFrames(frames),
    meta: input.meta || {},
  };
  const db = await openDB();
  await req2p(db.transaction(S_VOCALS, 'readwrite').objectStore(S_VOCALS).put(rec));
  if (input.blob) {
    await req2p(db.transaction(S_BLOBS, 'readwrite').objectStore(S_BLOBS).put({ id, blob: input.blob }));
  }
  return { ...rec, frames };
}

/** 保存/更新一条录音的快照（歌词、谱子对应、练唱结果——历史「打开」用） */
export async function saveVocalSnapshot(id, snapshot) {
  const db = await openDB();
  const store = db.transaction(S_VOCALS, 'readwrite').objectStore(S_VOCALS);
  const rec = await req2p(store.get(id));
  if (!rec) return null;
  rec.meta = { ...(rec.meta || {}), snapshot: { ...(rec.meta?.snapshot || {}), ...snapshot } };
  await req2p(store.put(rec));
  return rec;
}

/** 取一条录音的快照（无则 null） */
export async function getVocalSnapshot(id) {
  const db = await openDB();
  const rec = await req2p(db.transaction(S_VOCALS, 'readonly').objectStore(S_VOCALS).get(id));
  return rec?.meta?.snapshot || null;
}

/** 列出全部历史（按时间倒序），不含解包帧 */
export async function listVocals() {
  const db = await openDB();
  const all = await req2p(db.transaction(S_VOCALS, 'readonly').objectStore(S_VOCALS).getAll());
  // 元信息里去掉 packed（体积大），前端列表不需要
  return all
    .map(({ packed, ...rest }) => rest)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * 重写一条录音的帧时间轴（老录音兼容）。
 *
 * 旧版本把 AudioContext 绝对时间存进了帧，下游各自归一导致回放/练唱错位。
 * 打开历史记录时用这段音频重新对齐：以音频为真相，把帧时间整体平移，
 * 并把修好的帧写回 IndexedDB，下次打开就是对的。
 *
 * @param {string} id
 * @param {Array} newFrames 修正后的帧（t 从录音起点 0 起算）
 */
export async function rewriteFrames(id, newFrames) {
  const db = await openDB();
  const store = db.transaction(S_VOCALS, 'readwrite').objectStore(S_VOCALS);
  const rec = await req2p(store.get(id));
  if (!rec) return null;
  rec.packed = packFrames(newFrames);
  rec.meta = { ...(rec.meta || {}), framesFixed: true };
  await req2p(store.put(rec));
  return rec;
}

/** 取一条完整记录（含 frames） */
export async function getVocal(id) {
  const db = await openDB();
  const rec = await req2p(db.transaction(S_VOCALS, 'readonly').objectStore(S_VOCALS).get(id));
  if (!rec) return null;
  return { ...rec, frames: unpackFrames(rec.packed) };
}

/** 取音频 Blob（用于播放） */
export async function getVocalAudio(id) {
  const db = await openDB();
  const rec = await req2p(db.transaction(S_BLOBS, 'readonly').objectStore(S_BLOBS).get(id));
  return rec?.blob || null;
}

/** 重命名 */
export async function renameVocal(id, label) {
  const db = await openDB();
  const store = db.transaction(S_VOCALS, 'readwrite').objectStore(S_VOCALS);
  const rec = await req2p(store.get(id));
  if (!rec) return null;
  rec.label = label;
  await req2p(store.put(rec));
  return rec;
}

/** 删除一条 */
export async function deleteVocal(id) {
  const db = await openDB();
  await req2p(db.transaction(S_VOCALS, 'readwrite').objectStore(S_VOCALS).delete(id));
  await req2p(db.transaction(S_BLOBS, 'readwrite').objectStore(S_BLOBS).delete(id)).catch(() => {});
}

/** 清空全部 */
export async function clearVocals() {
  const db = await openDB();
  await req2p(db.transaction(S_VOCALS, 'readwrite').objectStore(S_VOCALS).clear());
  await req2p(db.transaction(S_BLOBS, 'readwrite').objectStore(S_BLOBS).clear());
}

/** 给列表用的简短描述 */
export function vocalSubtitle(v) {
  const bits = [fmtTime(v.duration)];
  if (v.lowMidi && v.highMidi) {
    // 音名在列表里用 util 会引入循环，这里用简单换算
    const nm = (m) => {
      const N = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
      return N[((Math.round(m) % 12) + 12) % 12] + (Math.floor(Math.round(m) / 12) - 1);
    };
    bits.push(`${nm(v.lowMidi)}–${nm(v.highMidi)}`);
  }
  if (v.noteCount) bits.push(`${v.noteCount} 音`);
  bits.push(`${Math.round((v.voicedRatio || 0) * 100)}% 有声`);
  return bits.join(' · ');
}
