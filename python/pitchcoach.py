"""
PitchCoach Python 工具链 —— 核心算法

与 web/js/ 下的 JS 实现**完全同构**，产生同样的评分口径，
这样"实时练唱"和"离线批量分析"不会出现两套标准。

模块内容：
  · load_audio        解码任意音频（mp3/flac/ogg/wav/m4a 经 soundfile / ffmpeg）
  · detect_pitch      批量 YIN（FFT 加速），返回逐帧 f0
  · clean_frames      置信度门限 + 中值 + 去八度
  · build_reference   帧序列 → 参考轨道（等间隔栅格）
  · save_reference / load_reference   JSON 序列化
  · score_take        与 JS 同一套评分模型
  · rank_takes        多录音排序

依赖：numpy, scipy, soundfile
可选：demucs（人声分离）、torchcrepe（更高精度）
"""

from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field, asdict
from typing import Iterable, Sequence

import numpy as np

try:
    import soundfile as sf
except ImportError as e:  # pragma: no cover
    raise SystemExit("需要 soundfile：pip install soundfile") from e


# ══════════════════════════════════════════════════════════
# 常量（与 JS 保持一致）
# ══════════════════════════════════════════════════════════

PITCH_MIN_HZ = 60.0
PITCH_MAX_HZ = 1400.0
HOP_SEC = 0.02                    # 参考轨道栅格
ANALYSIS_HOP_SEC = 0.01           # 音频分析的滑窗步长
WINDOW_SIZE = 2048
SILENCE_RMS = 0.0012

SCORE_MODES = {
    "strict": {"key": "strict", "name": "专业模式", "tol": 25},
    "exact":  {"key": "exact",  "name": "标准模式", "tol": 50},
    "loose":  {"key": "loose",  "name": "宽松模式", "tol": 100},
}


# ══════════════════════════════════════════════════════════
# 音频 I/O
# ══════════════════════════════════════════════════════════

def load_audio(path: str, target_sr: int = 48000) -> tuple[np.ndarray, int]:
    """
    读取音频为单声道 float32（范围 -1..1）。
    soundfile 支持 wav/flac/ogg/mp3；其他（m4a/aac/wma）走 ffmpeg。
    返回 (samples, sample_rate)
    """
    try:
        data, sr = sf.read(path, dtype="float32", always_2d=True)
    except Exception:
        data, sr = _load_via_ffmpeg(path)

    # 多声道平均
    mono = data.mean(axis=1) if data.ndim > 1 else data

    if sr != target_sr:
        mono = resample(mono, sr, target_sr)
        sr = target_sr

    return mono.astype(np.float32), sr


def _load_via_ffmpeg(path: str) -> tuple[np.ndarray, int]:
    ff = shutil.which("ffmpeg")
    if not ff:
        try:
            import imageio_ffmpeg
            ff = imageio_ffmpeg.get_ffmpeg_exe()
        except Exception:
            raise RuntimeError(
                f"无法解码 {os.path.basename(path)}。请安装 ffmpeg 或改用 wav/flac/mp3。"
            )
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        out = tmp.name
    try:
        subprocess.run(
            [ff, "-y", "-v", "error", "-i", path, "-ac", "1", "-ar", "48000", out],
            check=True,
        )
        data, sr = sf.read(out, dtype="float32", always_2d=True)
        return data, sr
    finally:
        try:
            os.unlink(out)
        except OSError:
            pass


def resample(x: np.ndarray, sr_in: int, sr_out: int) -> np.ndarray:
    """多相重采样（整数比优先，质量比 librosa 默认更高且更快）"""
    if sr_in == sr_out or len(x) == 0:
        return x
    from math import gcd
    from scipy.signal import resample_poly
    g = gcd(int(sr_in), int(sr_out))
    up, down = int(sr_out // g), int(sr_in // g)
    return resample_poly(x, up, down).astype(np.float32)


def save_wav(path: str, x: np.ndarray, sr: int) -> None:
    sf.write(path, np.clip(x, -1.0, 1.0), sr, subtype="PCM_16")


# ══════════════════════════════════════════════════════════
# 音高检测 —— 批量 YIN
# ══════════════════════════════════════════════════════════

def _frame_signal(x: np.ndarray, win: int, hop: int) -> np.ndarray:
    """切帧，返回形状 (n_frames, win)"""
    n = max(0, (len(x) - win) // hop + 1)
    if n <= 0:
        return np.zeros((0, win), dtype=np.float32)
    idx = np.arange(win)[None, :] + hop * np.arange(n)[:, None]
    return x[idx]


def _batch_autocorr(frames: np.ndarray) -> np.ndarray:
    """批量自相关（零填充线性），返回 (n_frames, win)"""
    n_frames, win = frames.shape
    nfft = 1
    while nfft < win * 2:
        nfft <<= 1
    spec = np.fft.rfft(frames, n=nfft, axis=1)
    power = spec.real ** 2 + spec.imag ** 2
    ac = np.fft.irfft(power, n=nfft, axis=1)
    return ac[:, :win]


def detect_pitch(
    x: np.ndarray,
    sr: int,
    hop_sec: float = ANALYSIS_HOP_SEC,
    win: int = WINDOW_SIZE,
    threshold: float = 0.15,
    min_hz: float = PITCH_MIN_HZ,
    max_hz: float = PITCH_MAX_HZ,
    chunk: int = 400,
    progress=None,
) -> dict:
    """
    批量 YIN 检测。

    返回 dict：
      t      (n,) 每帧起始时间（秒）
      hz     (n,) 基频，0 表示无声
      midi   (n,) MIDI 浮点值，0 表示无声
      conf   (n,) 置信度 0..1
      rms    (n,) 短时能量
      voiced (n,) bool
    """
    hop = max(1, int(round(hop_sec * sr)))
    x = np.asarray(x, dtype=np.float32)

    frames = _frame_signal(x, win, hop)
    n_frames = frames.shape[0]

    if n_frames == 0:
        return _empty_pitch()

    rms = np.sqrt(np.mean(frames ** 2, axis=1) + 1e-12)

    tau_min = max(2, int(sr / max_hz))
    tau_max = min(win - 2, int(math.ceil(sr / min_hz)))
    taus = np.arange(tau_max + 1)

    # 前缀能量，用于 O(1) 取区间和
    sq = frames.astype(np.float64) ** 2
    cum = np.concatenate([np.zeros((n_frames, 1)), np.cumsum(sq, axis=1)], axis=1)

    hz_out = np.zeros(n_frames, dtype=np.float32)
    conf_out = np.zeros(n_frames, dtype=np.float32)
    voiced_out = np.zeros(n_frames, dtype=bool)

    for start in range(0, n_frames, chunk):
        end = min(n_frames, start + chunk)
        blk = frames[start:end]
        nb = blk.shape[0]
        ac = _batch_autocorr(blk)  # (nb, win)

        # 差分函数 d(τ) = E[left] + E[right] - 2·r(τ)
        #   E[left]  = Σ_{j=0..win-τ-1} x[j]²  = cum[win-τ] - cum[0]
        #   E[right] = Σ_{j=τ..win-1}    x[j]²  = cum[win]   - cum[τ]
        # 用 np.take 沿 axis=1 做二维 gather，避免花式索引的维度错位。
        cb = cum[start:end]                                # (nb, win+1)
        e_left = np.take(cb, win - taus, axis=1) - cb[:, 0:1]      # (nb, T)
        e_right = cb[:, win:win + 1] - np.take(cb, taus, axis=1)   # (nb, T)
        d = np.maximum(0.0, e_left + e_right - 2.0 * ac[:, :tau_max + 1])

        # CMND 归一化
        cs = np.cumsum(d, axis=1)
        with np.errstate(divide="ignore", invalid="ignore"):
            cmnd = np.where(cs > 1e-12, d * taus[None, :] / cs, 1.0)
        cmnd[:, 0] = 1.0

        # 逐帧找第一个低于阈值的局部极小
        for i in range(nb):
            frame_rms = rms[start + i]
            if frame_rms < SILENCE_RMS:
                continue
            row = cmnd[i]
            seg = row[tau_min:tau_max]
            if seg.size == 0:
                continue

            below = np.nonzero(seg < threshold)[0]
            if below.size:
                k = int(below[0]) + tau_min
                # 滑向局部极小
                while k + 1 <= tau_max and row[k + 1] < row[k]:
                    k += 1
                tau_sel = k
            else:
                # 无清晰周期：退回全局最优，若仍很差则判为无声
                j = int(np.argmin(seg)) + tau_min
                if row[j] > 0.35:
                    continue
                tau_sel = j

            # 抛物线插值
            s0 = row[tau_sel - 1] if tau_sel - 1 >= 0 else row[tau_sel]
            s1 = row[tau_sel]
            s2 = row[tau_sel + 1] if tau_sel + 1 <= tau_max else s1
            den = s0 - 2 * s1 + s2
            shift = 0.0
            if abs(den) > 1e-12:
                shift = float(np.clip((s0 - s2) / (2 * den), -1.0, 1.0))

            f = sr / (tau_sel + shift)
            conf = float(np.clip(1.0 - s1, 0.0, 1.0))

            if conf > 0.55 and min_hz * 0.98 <= f <= max_hz * 1.02:
                hz_out[start + i] = f
                conf_out[start + i] = conf
                voiced_out[start + i] = True

        if progress:
            progress(min(1.0, end / n_frames))

    # 谐波校验：抑制高八度误判
    hz_out = _fix_octave_harmonic(x, sr, hop, win, hz_out, voiced_out)

    midi = np.zeros(n_frames, dtype=np.float32)
    m = hz_out > 0
    midi[m] = 69.0 + 12.0 * np.log2(hz_out[m] / 440.0)

    t = np.arange(n_frames) * hop / sr
    return {"t": t, "hz": hz_out, "midi": midi, "conf": conf_out, "rms": rms, "voiced": voiced_out}


def _fix_octave_harmonic(x, sr, hop, win, hz, voiced) -> np.ndarray:
    """
    对每个有声帧，比较 f 与 f/2 处的谱能量。
    f/2 能量显著更强 → 说明检测到的是二次谐波，降八度。
    """
    idx = np.nonzero(voiced)[0]
    if idx.size == 0:
        return hz

    out = hz.copy()
    nfft = win
    bin_hz = sr / nfft
    half = nfft // 2

    # 分块算谱
    frames = _frame_signal(x, win, hop)
    for s in range(0, idx.size, 512):
        sub = idx[s:s + 512]
        blk = frames[sub]
        spec = np.abs(np.fft.rfft(blk * np.hanning(win)[None, :], n=nfft, axis=1))[:, :half]
        for j, fi in enumerate(sub):
            f = float(out[fi])
            fh = f / 2.0
            if fh < PITCH_MIN_HZ:
                continue
            b1 = f / bin_hz
            b2 = fh / bin_hz
            if b2 < 1 or b1 >= half - 1:
                continue
            e_full = _peak_mag(spec[j], b1)
            e_half = _peak_mag(spec[j], b2)
            if e_half > e_full * 1.35 and e_half > 1e-4:
                out[fi] = fh
    return out


def _peak_mag(row: np.ndarray, bin_pos: float) -> float:
    i0 = int(math.floor(bin_pos))
    if i0 < 1 or i0 + 1 >= row.size:
        return 0.0
    a, b, c = row[i0 - 1], row[i0], row[i0 + 1]
    # 三点抛物线峰值
    den = a - 2 * b + c
    if abs(den) > 1e-12:
        shift = float(np.clip((a - c) / (2 * den), -1.0, 1.0))
    else:
        shift = 0.0
    frac = bin_pos - i0
    return float(max(b, (a + b + c) / 3.0) * (1 - frac) + b * frac)


def _empty_pitch() -> dict:
    z = np.zeros(0, dtype=np.float32)
    return {"t": z, "hz": z, "midi": z, "conf": z, "rms": z,
            "voiced": np.zeros(0, dtype=bool)}


# ══════════════════════════════════════════════════════════
# 清理
# ══════════════════════════════════════════════════════════

def clean_frames(pitch: dict, min_conf: float = 0.6, smooth: bool = True) -> dict:
    """置信度门限 + 3 点中值 + 去八度跳变。返回新 dict，不改原数据。"""
    out = {k: (v.copy() if isinstance(v, np.ndarray) else v) for k, v in pitch.items()}
    voiced = out["voiced"]
    midi = out["midi"]

    low_conf = (out["conf"] < min_conf) & voiced
    voiced[low_conf] = False
    midi[low_conf] = 0.0

    n = len(midi)
    if not smooth or n < 3:
        return out

    src = np.where(voiced, midi, np.nan)

    # 3 点中值去毛刺
    for i in range(1, n - 1):
        if not voiced[i]:
            continue
        w = src[i - 1:i + 2]
        w = w[~np.isnan(w)]
        if w.size >= 2:
            med = float(np.median(w))
            if 0.7 < abs(med - src[i]) < 6.0:
                midi[i] = med

    # 去八度：与前后 3 帧中值相差约 ±12 半音则折回
    for i in range(3, n - 3):
        if not voiced[i]:
            continue
        w = np.where(voiced[i - 3:i + 4], midi[i - 3:i + 4], np.nan)
        w = w[~np.isnan(w)]
        if w.size < 4:
            continue
        med = float(np.median(w))
        diff = midi[i] - med
        if abs(abs(diff) - 12.0) < 1.2:
            midi[i] -= math.copysign(12.0, diff)

    out["midi"] = midi
    return out


# ══════════════════════════════════════════════════════════
# 参考轨道
# ══════════════════════════════════════════════════════════

@dataclass
class Reference:
    title: str
    duration: float
    hop: float
    midi: np.ndarray
    voiced: np.ndarray
    energy: np.ndarray | None = None
    notes: list = field(default_factory=list)
    source: str = "audio"

    # 派生字段
    range_low: float = 48.0
    range_high: float = 72.0
    voiced_ratio: float = 0.0

    def __post_init__(self):
        vals = self.midi[self.voiced]
        if vals.size:
            self.range_low = float(np.percentile(vals, 2))
            self.range_high = float(np.percentile(vals, 98))
        self.voiced_ratio = float(self.voiced.mean()) if self.voiced.size else 0.0

    def at(self, t: float) -> float | None:
        idx = int(round(t / self.hop))
        if idx < 0 or idx >= self.midi.size:
            return None
        return float(self.midi[idx]) if self.voiced[idx] else None


def build_reference(pitch: dict, hop: float = HOP_SEC, title: str = "reference",
                    snap: bool = False, snap_amount: float = 0.65,
                    source: str = "audio") -> Reference:
    """把逐帧检测结果压到等间隔栅格上，做成参考轨道"""
    t = pitch["t"]
    midi = pitch["midi"]
    voiced = pitch["voiced"]
    rms = pitch["rms"]

    if t.size == 0:
        return Reference(title, 0.0, hop, np.zeros(0, dtype=np.float32),
                         np.zeros(0, dtype=bool))

    duration = float(t[-1] + hop)
    n = max(1, int(math.ceil(duration / hop)) + 1)
    out_midi = np.zeros(n, dtype=np.float32)
    out_voiced = np.zeros(n, dtype=bool)
    out_energy = np.zeros(n, dtype=np.float32)

    rms_ref = float(np.percentile(rms, 95)) if rms.size else 1.0
    rms_ref = max(rms_ref, 1e-4)

    # 每个栅格取最近的帧
    grid_t = np.arange(n) * hop
    nearest = np.searchsorted(t, grid_t)
    nearest = np.clip(nearest, 0, t.size - 1)
    for i in range(n):
        j = int(nearest[i])
        # 距离太远则跳过
        if abs(float(t[j]) - float(grid_t[i])) > hop * 1.2:
            continue
        if voiced[j] and midi[j] > 0:
            out_midi[i] = midi[j]
            out_voiced[i] = True
            out_energy[i] = min(1.0, float(rms[j]) / rms_ref)

    # 修补 ±2 栅格的孤立空洞
    for i in range(2, n - 2):
        if not out_voiced[i] and out_voiced[i - 2] and out_voiced[i + 2]:
            out_voiced[i] = True
            out_midi[i] = (out_midi[i - 2] + out_midi[i + 2]) / 2

    if snap:
        m = out_voiced
        out_midi[m] = out_midi[m] + (np.round(out_midi[m]) - out_midi[m]) * snap_amount

    notes = extract_notes(out_midi, out_voiced, hop)

    return Reference(
        title=title, duration=duration, hop=hop,
        midi=out_midi, voiced=out_voiced, energy=out_energy,
        notes=notes, source=source,
    )


def extract_notes(midi: np.ndarray, voiced: np.ndarray, hop: float,
                  min_dur: float = 0.08) -> list:
    """把连续同音高栅格合成音符段"""
    notes = []
    start = -1
    cur = 0
    n = midi.size
    for i in range(n + 1):
        on = i < n and bool(voiced[i])
        q = int(round(float(midi[i]))) if on else None
        if start < 0:
            if on:
                start, cur = i, q
        elif not on or q != cur:
            dur = (i - start) * hop
            if dur >= min_dur:
                seg = midi[start:i]
                notes.append({
                    "start": start * hop,
                    "end": i * hop,
                    "midi": float(np.median(seg)),
                    "label": cur,
                })
            if on:
                start, cur = i, q
            else:
                start = -1
    return notes


def save_reference(ref: Reference, path: str) -> None:
    data = {
        "version": 1,
        "title": ref.title,
        "duration": ref.duration,
        "hop": ref.hop,
        "midi": [round(float(v), 4) for v in ref.midi],
        "voiced": [int(v) for v in ref.voiced],
        "energy": [round(float(v), 3) for v in (ref.energy if ref.energy is not None else [])],
        "notes": ref.notes,
        "source": ref.source,
        "range": [ref.range_low, ref.range_high],
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)


def load_reference(path: str) -> Reference:
    with open(path, "r", encoding="utf-8") as f:
        d = json.load(f)
    energy = d.get("energy") or []
    return Reference(
        title=d.get("title", "reference"),
        duration=float(d["duration"]),
        hop=float(d.get("hop", HOP_SEC)),
        midi=np.asarray(d["midi"], dtype=np.float32),
        voiced=np.asarray(d["voiced"], dtype=bool),
        energy=np.asarray(energy, dtype=np.float32) if len(energy) else None,
        notes=d.get("notes") or [],
        source=d.get("source", "audio"),
    )


# ══════════════════════════════════════════════════════════
# 评分（与 JS 同构）
# ══════════════════════════════════════════════════════════

def _fold_octave(dev: float) -> tuple[float, int]:
    d, fixed = dev, 0
    for _ in range(3):
        if abs(abs(d) - 1200.0) < 300.0:
            d -= round(d / 1200.0) * 1200.0
            fixed += 1
        else:
            break
    return d, fixed


def _estimate_octave_shift(raw_devs: np.ndarray) -> int:
    vals = raw_devs[~np.isnan(raw_devs)]
    if vals.size == 0:
        return 0
    k = np.round(vals / 1200.0)
    near = np.abs(vals - k * 1200.0) < 400.0
    if not near.any():
        return 0
    ks, counts = np.unique(k[near], return_counts=True)
    best = ks[int(np.argmax(counts))]
    ratio = counts.max() / vals.size
    return int(best) if ratio >= 0.55 else 0


def _smooth_devs(devs: np.ndarray) -> None:
    """5 点中值，邻域离散度 < 150¢ 才替换"""
    src = devs.copy()
    n = devs.size
    for i in range(2, n - 2):
        if np.isnan(src[i]):
            continue
        w = src[i - 2:i + 3]
        w = w[~np.isnan(w)]
        if w.size < 3:
            continue
        if float(w.max() - w.min()) < 150.0:
            devs[i] = float(np.median(w))


def score_take(ref: Reference, pitch: dict, mode: str = "exact",
               start_time: float = 0.0) -> dict:
    """
    把一条录音的逐帧检测结果与参考轨道比对打分。
    返回与 JS 版 scoreTake 字段一致的 dict。
    """
    m = SCORE_MODES.get(mode, SCORE_MODES["exact"])
    tol = m["tol"]
    hop = ref.hop

    t = pitch["t"] + start_time
    midi = pitch["midi"]
    voiced = pitch["voiced"]
    n = t.size
    if n == 0:
        return _empty_score(m)

    idx = np.round(t / hop).astype(np.int64)
    valid = (idx >= 0) & (idx < ref.midi.size)
    ref_midis = np.zeros(n, dtype=np.float32)
    ref_voiced = np.zeros(n, dtype=bool)
    ref_midis[valid] = ref.midi[idx[valid]]
    ref_voiced[valid] = ref.voiced[idx[valid]]

    you_voiced = voiced & (midi > 0)

    voiced_ref_count = int(ref_voiced.sum())
    both = ref_voiced & you_voiced
    both_count = int(both.sum())

    raw = np.full(n, np.nan, dtype=np.float32)
    raw[both] = (midi[both] - ref_midis[both]) * 100.0

    shift = _estimate_octave_shift(raw)
    devs = np.full(n, np.nan, dtype=np.float32)
    oct_fixed = 0
    for i in np.nonzero(~np.isnan(raw))[0]:
        d = float(raw[i]) - shift * 1200.0
        d, f = _fold_octave(d)
        devs[i] = d
        oct_fixed += f

    _smooth_devs(devs)

    sigma = tol * 0.6
    scored = ~np.isnan(devs)
    vals = devs[scored]
    quality = np.exp(-0.5 * (vals / sigma) ** 2) if vals.size else np.zeros(0)
    in_tol = int(np.sum(np.abs(vals) < tol)) if vals.size else 0

    denom = max(1, voiced_ref_count)
    frame_quality = float(quality.sum()) / denom if vals.size else 0.0
    pitch_accuracy = in_tol / denom

    coverage = min(1.0, both_count / voiced_ref_count) if voiced_ref_count else 0.0

    if vals.size:
        mean_signed = float(vals.mean())
        stdev = float(vals.std())
    else:
        mean_signed = stdev = 0.0

    stability = float(np.clip(1 - stdev / (tol * 2.5), 0, 1))
    total = (frame_quality * 0.55 + pitch_accuracy * 0.20
             + coverage * 0.15 + stability * 0.10) * 100.0

    # 分档配色
    bands = np.full(n, "", dtype=object)
    abs_v = np.abs(vals)
    b = np.full(vals.size, "off", dtype=object)
    b[abs_v <= tol * 2] = "sharp"
    b[abs_v <= tol] = "ok"
    b[abs_v <= tol * 0.5] = "great"
    b[abs_v <= tol * 0.25] = "perfect"
    bands[scored] = b
    bands[ref_voiced & ~you_voiced] = "missed"
    bands[~ref_voiced & you_voiced] = "extra"
    bands[~ref_voiced & ~you_voiced] = "silent"

    counts = {"perfect": 0, "great": 0, "ok": 0, "sharp": 0, "off": 0,
              "missed": 0, "extra": 0, "silent": 0}
    for key in counts:
        counts[key] = int(np.sum(bands == key))

    phrases = _phrase_scores(devs, ref_voiced, frame_hop=n_frame_hop(t), tol=tol, window_sec=2.0)
    worst = sorted(phrases, key=lambda p: p["score"])[:5]

    return {
        "mode": m["key"],
        "total": round(float(total), 1),
        "pitchAccuracy": float(pitch_accuracy),
        "frameQuality": float(frame_quality),
        "coverage": float(coverage),
        "stdev": stdev,
        "segBias": 0.0,
        "octaveFixed": int(oct_fixed),
        "octaveShift": int(shift),
        "frames": int(n),
        "counts": counts,
        "meanSignedCents": mean_signed,
        "meanAbsCents": float(np.abs(vals).mean()) if vals.size else 0.0,
        "medianAbsCents": float(np.median(np.abs(vals))) if vals.size else 0.0,
        "p90AbsCents": float(np.percentile(np.abs(vals), 90)) if vals.size else 0.0,
        "devs": devs,
        "refMidis": ref_midis,
        "refVoiced": ref_voiced,
        "bands": bands,
        "phraseScores": phrases,
        "worst": worst,
    }


def n_frame_hop(t: np.ndarray) -> float:
    """从时间数组推回帧步长（录音可能是 10ms 一帧，参考是 20ms 栅格）"""
    if t.size < 2:
        return ANALYSIS_HOP_SEC
    return float(t[1] - t[0])


def _phrase_scores(devs: np.ndarray, ref_voiced: np.ndarray, frame_hop: float,
                   tol: float, window_sec: float = 2.0) -> list:
    win = max(1, int(round(window_sec / frame_hop)))
    n = devs.size
    sigma = tol * 0.6
    out = []
    for i0 in range(0, n, win):
        i1 = min(n - 1, i0 + win - 1)
        sl = slice(i0, i1 + 1)
        ref_cnt = int(ref_voiced[sl].sum())
        if ref_cnt == 0:
            continue
        d = devs[sl]
        ok = ~np.isnan(d)
        scored = int(ok.sum())
        if scored:
            q = float(np.exp(-0.5 * (d[ok] / sigma) ** 2).sum()) / scored
            mean_abs = float(np.abs(d[ok]).mean())
            mean_signed = float(d[ok].mean())
        else:
            q = mean_abs = mean_signed = 0.0
        cover = min(1.0, scored / ref_cnt)
        score = int(round(np.clip((q * 0.8 + cover * 0.2) * 100.0, 0, 100)))
        out.append({
            "t0": i0 * frame_hop,
            "t1": (i1 + 1) * frame_hop,
            "score": score,
            "meanAbs": mean_abs,
            "meanSigned": mean_signed,
            "coverage": cover,
        })
    return out


def _empty_score(mode: dict) -> dict:
    return {
        "mode": mode["key"], "total": 0.0, "pitchAccuracy": 0.0,
        "frameQuality": 0.0, "coverage": 0.0, "stdev": 0.0, "segBias": 0.0,
        "octaveFixed": 0, "octaveShift": 0, "frames": 0,
        "counts": {k: 0 for k in
                   ["perfect", "great", "ok", "sharp", "off", "missed", "extra", "silent"]},
        "meanSignedCents": 0.0, "meanAbsCents": 0.0,
        "medianAbsCents": 0.0, "p90AbsCents": 0.0,
        "devs": np.zeros(0, dtype=np.float32),
        "refMidis": np.zeros(0, dtype=np.float32),
        "refVoiced": np.zeros(0, dtype=bool),
        "bands": np.zeros(0, dtype=object),
        "phraseScores": [], "worst": [],
    }


def rank_takes(ref: Reference, takes: Sequence[tuple[str, dict]],
               mode: str = "exact") -> list[dict]:
    """
    多条录音排名
    takes: [(name, pitch_dict), ...]
    返回按总分降序的结果列表
    """
    results = []
    for name, pitch in takes:
        s = score_take(ref, pitch, mode=mode)
        results.append({
            "name": name,
            "total": s["total"],
            "pitchAccuracy": s["pitchAccuracy"],
            "coverage": s["coverage"],
            "meanSignedCents": s["meanSignedCents"],
            "meanAbsCents": s["meanAbsCents"],
            "stdev": s["stdev"],
            "octaveShift": s["octaveShift"],
            "score": s,
        })
    results.sort(key=lambda r: r["total"], reverse=True)
    return results


# ══════════════════════════════════════════════════════════
# 音名工具
# ══════════════════════════════════════════════════════════

_NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def midi_to_name(m: float) -> str:
    if not np.isfinite(m):
        return "--"
    r = int(round(m))
    return _NOTE_NAMES[r % 12] + str(r // 12 - 1)


def midi_to_hz(m: float) -> float:
    return 440.0 * (2.0 ** ((m - 69.0) / 12.0))


def hz_to_midi(hz: float) -> float:
    if hz <= 0:
        return 0.0
    return 69.0 + 12.0 * math.log2(hz / 440.0)


def fmt_time(sec: float) -> str:
    if not np.isfinite(sec) or sec < 0:
        sec = 0.0
    m = int(sec // 60)
    s = sec - m * 60
    return f"{m}:{s:04.1f}"
