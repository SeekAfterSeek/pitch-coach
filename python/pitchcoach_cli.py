#!/usr/bin/env python
"""
PitchCoach 命令行工具

用法：
  # 从一首歌里提取参考旋律（人声轨）
  python pitchcoach_cli.py extract song.mp3 -o ref.json --title "我的歌" --snap

  # 分析一条录音，给出分数和诊断
  python pitchcoach_cli.py score take1.wav --ref ref.json
  python pitchcoach_cli.py score take1.wav --ref ref.json --json out.json --plot out.png

  # 多条录音排名（找出哪次唱得最准）
  python pitchcoach_cli.py rank take1.wav take2.wav take3.wav --ref ref.json

  # 分离人声（需要 demucs）
  python pitchcoach_cli.py separate song.mp3 -o ./stems

  # 导出钢琴卷帘图
  python pitchcoach_cli.py plot take1.wav --ref ref.json -o roll.png
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys

import numpy as np

# Windows 控制台默认 GBK，输出音名/进度条会崩。强制 UTF-8。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pitchcoach as pc


# ══════════════════════════════════════════════════════════
# 子命令：extract
# ══════════════════════════════════════════════════════════

def cmd_extract(args):
    print(f"读取 {args.input} …")
    x, sr = pc.load_audio(args.input, args.sr)
    print(f"  {len(x)/sr:.1f}s / {sr}Hz，峰值 {np.abs(x).max():.3f}")

    if np.abs(x).max() < 0.01:
        print("  ⚠ 音频几乎无声，检查文件", file=sys.stderr)

    print("检测音高 …")
    pitch = pc.detect_pitch(
        x, sr,
        hop_sec=args.hop,
        min_hz=args.min_hz,
        max_hz=args.max_hz,
        progress=lambda p: _progress(p, "  分析"),
    )
    print()

    voiced = pitch["voiced"]
    print(f"  有声帧 {voiced.sum()} / {voiced.size} ({voiced.mean()*100:.1f}%)")

    cleaned = pc.clean_frames(pitch, min_conf=args.min_conf)
    ref = pc.build_reference(
        cleaned,
        hop=pc.HOP_SEC,
        title=args.title or os.path.splitext(os.path.basename(args.input))[0],
        snap=args.snap,
        source="audio",
    )

    if ref.voiced_ratio < 0.03:
        print("  ⚠ 几乎没有检测到音高。若这是纯伴奏，请先用人声分离（separate 子命令）。",
              file=sys.stderr)

    pc.save_reference(ref, args.output)
    print(f"\n已保存参考轨道 → {args.output}")
    print(f"  时长 {ref.duration:.1f}s · 音域 {pc.midi_to_name(ref.range_low)}–{pc.midi_to_name(ref.range_high)}")
    print(f"  音符段 {len(ref.notes)} 个 · 有声占比 {ref.voiced_ratio*100:.0f}%")

    if args.report:
        _print_note_histogram(ref)


def _print_note_histogram(ref):
    print("\n音高分布（前 12 个最常见音）：")
    vals = ref.midi[ref.voiced]
    if vals.size == 0:
        print("  （无）")
        return
    rounded = np.round(vals).astype(int)
    uniq, counts = np.unique(rounded, return_counts=True)
    order = np.argsort(-counts)[:12]
    total = counts.sum()
    for i in order:
        name = pc.midi_to_name(uniq[i])
        pct = counts[i] / total * 100
        bar = "█" * max(1, int(pct / 2))
        print(f"  {name:>4} {bar:<50} {pct:5.1f}%")


# ══════════════════════════════════════════════════════════
# 子命令：score
# ══════════════════════════════════════════════════════════

def cmd_score(args):
    ref = pc.load_reference(args.ref)
    print(f"参考轨道：{ref.title}  ({ref.duration:.1f}s, {len(ref.notes)} 个音符段)")

    x, sr = pc.load_audio(args.input, args.sr)
    print(f"录音：{os.path.basename(args.input)}  {len(x)/sr:.1f}s")

    pitch = pc.detect_pitch(
        x, sr, hop_sec=pc.ANALYSIS_HOP_SEC,
        min_hz=args.min_hz, max_hz=args.max_hz,
        progress=lambda p: _progress(p, "  分析"),
    )
    print()
    pitch = pc.clean_frames(pitch, min_conf=args.min_conf)

    offset = 0.0
    if args.align:
        offset = _estimate_offset(ref, pitch, max_lag=args.max_lag)
        print(f"  自动对齐偏移：{offset:+.2f}s")

    score = pc.score_take(ref, pitch, mode=args.mode, start_time=offset)
    _print_score(score, ref)

    if args.json:
        out = {
            "file": args.input,
            "reference": args.ref,
            "mode": score["mode"],
            "offset": offset,
            "total": score["total"],
            "pitchAccuracy": score["pitchAccuracy"],
            "frameQuality": score["frameQuality"],
            "coverage": score["coverage"],
            "stdev": score["stdev"],
            "meanSignedCents": score["meanSignedCents"],
            "meanAbsCents": score["meanAbsCents"],
            "medianAbsCents": score["medianAbsCents"],
            "p90AbsCents": score["p90AbsCents"],
            "octaveShift": score["octaveShift"],
            "octaveFixed": score["octaveFixed"],
            "counts": score["counts"],
            "phraseScores": score["phraseScores"],
            "worst": score["worst"],
        }
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=2)
        print(f"\n结果已写入 {args.json}")

    if args.plot:
        _plot_roll(ref, pitch, score, args.plot, offset)
        print(f"钢琴卷帘图 → {args.plot}")


def _print_score(score, ref):
    t = score["total"]
    bar_len = int(t / 2)
    print()
    print("  " + "═" * 58)
    print(f"   总分  {t:5.1f}   {'█' * bar_len}{'·' * (50 - bar_len)}")
    print("  " + "═" * 58)
    print(f"   准音率 {score['pitchAccuracy']*100:5.1f}%   "
          f"帧质量 {score['frameQuality']*100:5.1f}%   "
          f"覆盖度 {score['coverage']*100:5.1f}%")
    print(f"   平均偏差 {score['meanSignedCents']:+6.1f}¢   "
          f"平均绝对 {score['meanAbsCents']:5.1f}¢   "
          f"中位 {score['medianAbsCents']:5.1f}¢   "
          f"P90 {score['p90AbsCents']:5.1f}¢")
    print(f"   稳定性 σ {score['stdev']:5.1f}¢")
    if score["octaveShift"]:
        print(f"   ⓘ 整体移了 {score['octaveShift']:+d} 个八度演唱（已按八度等价计分）")
    if score["octaveFixed"]:
        print(f"   ⓘ 修正 {score['octaveFixed']} 个零散八度误判帧")

    c = score["counts"]
    print(f"\n   分档：perfect {c['perfect']} · great {c['great']} · ok {c['ok']} · "
          f"sharp {c['sharp']} · off {c['off']} · missed {c['missed']} · extra {c['extra']}")

    phrases = score["phraseScores"]
    if phrases:
        print("\n   逐句（2 秒窗口）：")
        for i, ph in enumerate(phrases):
            s = ph["score"]
            mark = "✓" if s >= 85 else "·" if s >= 70 else "!" if s >= 50 else "✗"
            blocks = "▇" * max(1, s // 10)
            print(f"     {mark} {pc.fmt_time(ph['t0']):>6}  {s:3d}  {blocks:<10} "
                  f"偏差 {ph['meanSigned']:+6.1f}¢")

    worst = [w for w in score["worst"] if w["score"] < 60]
    if worst:
        times = "、".join(f"{pc.fmt_time(w['t0'])}–{pc.fmt_time(w['t1'])}" for w in worst[:3])
        print(f"\n   ⚠ 需要重点练：{times}")

    # 诊断
    print("\n   诊断：")
    for line in _diagnose(score, ref):
        print("     · " + line)


def _diagnose(score, ref):
    out = []
    t = score["total"]
    if t >= 90:
        out.append("音准接近专业水准，可以挑战更难的曲目。")
    elif t >= 75:
        out.append("大方向对，个别段落需要单独练。")
    elif t >= 55:
        out.append("旋律记得住，但音高控制还没形成肌肉记忆。")
    else:
        out.append("建议从长音开始，先把单音唱准再练整句。")

    bias = score["meanSignedCents"]
    if abs(bias) > 18:
        direction = "偏高" if bias > 0 else "偏低"
        cause = "喉咙太紧、气息推得急" if bias > 0 else "气息支撑不足、靠嗓子顶"
        out.append(f"整体{direction} {abs(bias):.0f}¢（约 {abs(bias)/100:.2f} 个半音），"
                   f"系统性偏差，通常是{cause}。")

    if score["stdev"] > 45:
        out.append(f"抖动大（σ={score['stdev']:.0f}¢），长音气息不稳。")
    if score["coverage"] < 0.6:
        out.append(f"有 {(1-score['coverage'])*100:.0f}% 的参考音没唱到，"
                   f"检查麦克风距离或把参考音调小。")

    b = score["counts"]
    total_bands = max(1, sum(b.values()))
    if (b["off"] + b["sharp"]) / total_bands > 0.35:
        out.append("超过三分之一的音偏离半个半音以上，先练音程关系。")
    if not out:
        out.append("没有发现明显问题。")
    return out


def _estimate_offset(ref, pitch, max_lag=6.0, step=0.05):
    """互相关找录音相对参考的时间偏移"""
    midi = pitch["midi"]
    voiced = pitch["voiced"]
    t = pitch["t"]
    hop = ref.hop

    idx_all = np.round((t[:, None] + np.arange(-max_lag, max_lag + 1e-9, step)[None, :]) / hop)
    best_off, best_corr = 0.0, -1.0
    for k, off in enumerate(np.arange(-max_lag, max_lag + 1e-9, step)):
        idx = idx_all[:, k].astype(int)
        ok = voiced & (idx >= 0) & (idx < ref.midi.size)
        if ok.sum() < 20:
            continue
        ok &= ref.voiced[np.clip(idx, 0, ref.midi.size - 1)]
        if ok.sum() < 20:
            continue
        d = np.abs(midi[ok] - ref.midi[idx[ok]]) * 100
        corr = np.clip(1 - d / 150, 0, 1).mean()
        if corr > best_corr:
            best_corr, best_off = corr, float(off)
    return best_off


# ══════════════════════════════════════════════════════════
# 子命令：rank
# ══════════════════════════════════════════════════════════

def cmd_rank(args):
    ref = pc.load_reference(args.ref)
    print(f"参考：{ref.title} ({ref.duration:.1f}s, {len(ref.notes)} 段)\n")

    takes = []
    for path in args.inputs:
        print(f"分析 {os.path.basename(path)} …", end="", flush=True)
        x, sr = pc.load_audio(path, args.sr)
        pitch = pc.detect_pitch(x, sr, hop_sec=pc.ANALYSIS_HOP_SEC,
                                min_hz=args.min_hz, max_hz=args.max_hz)
        pitch = pc.clean_frames(pitch, min_conf=args.min_conf)
        offset = _estimate_offset(ref, pitch) if args.align else 0.0
        takes.append((os.path.basename(path), pitch, offset))
        print(f" {len(x)/sr:.1f}s")

    results = pc.rank_takes(ref, [(n, p) for n, p, _ in takes], mode=args.mode)

    # 把 offset 带回来
    off_map = {n: o for n, _, o in takes}
    for r in results:
        r["offset"] = off_map[r["name"]]

    print("\n" + "═" * 68)
    print(f"  {'名次':<5}{'录音':<26}{'总分':>6}{'准音率':>8}{'覆盖':>7}{'偏差':>9}")
    print("─" * 68)
    for i, r in enumerate(results, 1):
        medal = "🥇" if i == 1 else "🥈" if i == 2 else "🥉" if i == 3 else "  "
        name = r["name"][:24]
        print(f"  {medal}{i:<3}{name:<26}{r['total']:6.1f}"
              f"{r['pitchAccuracy']*100:7.1f}%{r['coverage']*100:6.0f}%"
              f"{r['meanSignedCents']:+8.1f}¢")
    print("═" * 68)

    if results:
        best = results[0]
        print(f"\n  最准的一条：{best['name']}（{best['total']:.1f} 分）")
        print(f"  与最差一条相差 {best['total'] - results[-1]['total']:.1f} 分")

        # 对比诊断
        if len(results) > 1:
            print("\n  差距分析：")
            b = best["score"]
            w = results[-1]["score"]
            d_bias = w["meanSignedCents"] - b["meanSignedCents"]
            if abs(d_bias) > 10:
                print(f"    · 偏差方向：最好的一条 {b['meanSignedCents']:+.0f}¢，"
                      f"最差的一条 {w['meanSignedCents']:+.0f}¢")
            if w["stdev"] > b["stdev"] * 1.3:
                print(f"    · 稳定性：最差的一条抖动更大（σ {w['stdev']:.0f} vs {b['stdev']:.0f}）")
            if w["coverage"] < b["coverage"] - 0.1:
                print(f"    · 完整度：最差的一条漏唱更多（{w['coverage']*100:.0f}% vs {b['coverage']*100:.0f}%）")

    if args.json:
        out = [{
            "rank": i + 1,
            "name": r["name"],
            "total": r["total"],
            "pitchAccuracy": r["pitchAccuracy"],
            "coverage": r["coverage"],
            "meanSignedCents": r["meanSignedCents"],
            "meanAbsCents": r["meanAbsCents"],
            "stdev": r["stdev"],
            "offset": r["offset"],
        } for i, r in enumerate(results)]
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=2)
        print(f"\n  排名已写入 {args.json}")


# ══════════════════════════════════════════════════════════
# 子命令：separate（人声分离）
# ══════════════════════════════════════════════════════════

def cmd_separate(args):
    try:
        import torch  # noqa: F401
    except ImportError:
        print("人声分离需要 demucs：\n  pip install demucs torch\n", file=sys.stderr)
        print("提示：也可以直接用带人声的音频做参考（extract 子命令），"
              "或先在网上找现成的伴奏/人声分轨。", file=sys.stderr)
        sys.exit(1)

    os.makedirs(args.output, exist_ok=True)
    print(f"用 Demucs 分离 {args.input} …（首次运行会下载模型约 80MB）")
    cmd = [
        sys.executable, "-m", "demucs",
        "--two-stems", "vocals",
        "-n", args.model,
        "-o", args.output,
    ]
    if args.device:
        cmd += ["-d", args.device]
    cmd.append(args.input)

    r = subprocess.run(cmd)
    if r.returncode != 0:
        print("分离失败", file=sys.stderr)
        sys.exit(r.returncode)

    # 找到输出
    stem = os.path.splitext(os.path.basename(args.input))[0]
    for root, _, files in os.walk(args.output):
        for f in files:
            if f == "vocals.wav":
                found = os.path.join(root, f)
                print(f"\n人声轨 → {found}")
                print(f"下一步：\n  python pitchcoach_cli.py extract \"{found}\" -o ref.json --snap")
                return
    print("完成，但没找到 vocals.wav，请检查输出目录")


# ══════════════════════════════════════════════════════════
# 子命令：plot
# ══════════════════════════════════════════════════════════

def cmd_plot(args):
    pid = load_pitch_cache(args.input, args)
    ref = pc.load_reference(args.ref)
    offset = _estimate_offset(ref, pid) if args.align else 0.0
    score = pc.score_take(ref, pid, mode=args.mode, start_time=offset)
    _plot_roll(ref, pid, score, args.output, offset, title=os.path.basename(args.input))
    print(f"图已保存 → {args.output}")


_pitch_cache = {}


def load_pitch_cache(path, args):
    key = (path, getattr(args, "min_conf", 0.6))
    if key in _pitch_cache:
        return _pitch_cache[key]
    x, sr = pc.load_audio(path, getattr(args, "sr", 48000))
    p = pc.detect_pitch(x, sr, hop_sec=pc.ANALYSIS_HOP_SEC,
                        min_hz=getattr(args, "min_hz", pc.PITCH_MIN_HZ),
                        max_hz=getattr(args, "max_hz", pc.PITCH_MAX_HZ),
                        progress=lambda v: _progress(v, "  分析"))
    print()
    p = pc.clean_frames(p, min_conf=getattr(args, "min_conf", 0.6))
    _pitch_cache[key] = p
    return p


def _plot_roll(ref, pitch, score, out_path, offset=0.0, title=""):
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        from matplotlib.patches import Rectangle
    except ImportError:
        print("需要 matplotlib：pip install matplotlib", file=sys.stderr)
        return

    # 中文字体
    for f in ["Microsoft YaHei", "SimHei", "PingFang SC", "DejaVu Sans"]:
        try:
            matplotlib.rcParams["font.sans-serif"] = [f]
            break
        except Exception:
            continue
    matplotlib.rcParams["axes.unicode_minus"] = False

    lo = min(ref.range_low, float(np.nanmin(pitch["midi"][pitch["voiced"]])) if pitch["voiced"].any() else ref.range_low) - 3
    hi = max(ref.range_high, float(np.nanmax(pitch["midi"][pitch["voiced"]])) if pitch["voiced"].any() else ref.range_high) + 3
    lo, hi = max(24, lo), min(100, hi)

    dur = max(ref.duration, float(pitch["t"][-1]) if pitch["t"].size else ref.duration)
    fig, (ax, ax2) = plt.subplots(
        2, 1, figsize=(14, 7), sharex=True,
        gridspec_kw={"height_ratios": [4, 1], "hspace": 0.08},
    )
    fig.patch.set_facecolor("#0b0f16")

    # 参考旋律
    hop = ref.hop
    idx = np.nonzero(ref.voiced)[0]
    for i in idx:
        ax.add_patch(Rectangle(
            (i * hop, ref.midi[i] - 0.34), hop * 1.02, 0.68,
            color="#96a6be", alpha=0.38, linewidth=0,
        ))

    # 音高轨迹（按偏差着色）
    devs = score["devs"]
    tol = pc.SCORE_MODES[score["mode"]]["tol"]
    colors = np.full(devs.size, "#25e08a", dtype=object)
    a = np.abs(devs)
    colors[a > tol * 0.25] = "#5fe3a1"
    colors[a > tol * 0.5] = "#ffd166"
    colors[a > tol] = "#ff9f43"
    colors[a > tol * 2] = "#ff4d5e"

    for i in range(devs.size):
        if np.isnan(devs[i]):
            continue
        x0 = pitch["t"][i] + offset
        ax.plot([x0, x0 + pc.ANALYSIS_HOP_SEC],
                [pitch["midi"][i], pitch["midi"][i]],
                color=colors[i], linewidth=2.6, solid_capstyle="round")

    # 音名刻度
    ticks, labels = [], []
    for m in range(int(np.floor(lo)), int(np.ceil(hi)) + 1):
        if m % 12 == 0:
            ticks.append(m)
            labels.append(pc.midi_to_name(m))
    ax.set_yticks(ticks)
    ax.set_yticklabels(labels, color="#8fa2ba", fontsize=9)
    ax.set_ylim(lo, hi)
    ax.set_xlim(0, dur)
    ax.grid(axis="y", color="#8fa2ba", alpha=0.16, linewidth=0.7)
    ax.set_facecolor("#0b0f16")
    for spine in ax.spines.values():
        spine.set_color("#22303f")

    ax.set_title(
        f"{title or ref.title}    总分 {score['total']:.1f}  ·  "
        f"准音率 {score['pitchAccuracy']*100:.0f}%  ·  "
        f"平均偏差 {score['meanSignedCents']:+.0f}¢",
        color="#e8eef8", fontsize=13, pad=12,
    )

    # 逐句热力条
    for ph in score["phraseScores"]:
        s = ph["score"]
        c = "#25e08a" if s >= 85 else "#ffd166" if s >= 70 else "#ff9f43" if s >= 50 else "#ff4d5e"
        ax2.add_patch(Rectangle((ph["t0"], 0), ph["t1"] - ph["t0"], 1,
                                color=c, alpha=0.8, linewidth=0))
        ax2.text((ph["t0"] + ph["t1"]) / 2, 0.5, str(s), ha="center", va="center",
                 color="#07110b", fontsize=8, fontweight="bold")

    ax2.set_ylim(0, 1)
    ax2.set_yticks([])
    ax2.set_facecolor("#0b0f16")
    ax2.set_xlabel("时间（秒）", color="#8fa2ba")
    ax2.tick_params(colors="#8fa2ba", labelsize=9)
    for spine in ax2.spines.values():
        spine.set_color("#22303f")

    from matplotlib.patches import Patch
    handles = [Patch(color="#96a6be", alpha=0.5, label="参考旋律"),
               Patch(color="#25e08a", label="准"),
               Patch(color="#ffd166", label="略偏"),
               Patch(color="#ff9f43", label="跑调"),
               Patch(color="#ff4d5e", label="偏差大")]
    ax.legend(handles=handles, loc="upper right", framealpha=0.15,
              facecolor="#0b0f16", edgecolor="#22303f", labelcolor="#c8d6e8",
              fontsize=9, ncol=5)

    fig.savefig(out_path, dpi=130, facecolor="#0b0f16", bbox_inches="tight")
    plt.close(fig)


# ══════════════════════════════════════════════════════════
# 子命令：demo（生成合成测试音频，验证链路）
# ══════════════════════════════════════════════════════════

def cmd_demo(args):
    """生成一段合成「演唱」音频 + 参考轨，用于验证整条链路"""
    sr = 48000
    notes = [(60, 0.0, 0.5), (62, 0.5, 0.5), (64, 1.0, 0.5),
             (65, 1.5, 0.5), (67, 2.0, 0.5), (69, 2.5, 0.5),
             (71, 3.0, 0.5), (72, 3.5, 0.9)]
    dur = 4.6
    n = int(dur * sr)
    x = np.zeros(n, dtype=np.float32)

    detune = args.detune_cents

    for midi, t0, d in notes:
        f = pc.midi_to_hz(midi) * (2 ** (detune / 1200))
        i0, i1 = int(t0 * sr), min(n, int((t0 + d) * sr))
        tt = np.arange(i1 - i0) / sr
        env = np.minimum(1, tt / 0.012) * np.minimum(1, (d - tt) / 0.05)
        env = np.clip(env, 0, 1)
        vib = 1 + args.vibrato * np.sin(2 * np.pi * 5.5 * tt)
        ph = 2 * np.pi * f * np.cumsum(vib) / sr
        sig = (np.sin(ph) + 0.30 * np.sin(2 * ph) + 0.14 * np.sin(3 * ph))
        x[i0:i1] += (0.38 * env * sig).astype(np.float32)

    # 加一点底噪
    if args.noise > 0:
        x += (np.random.randn(n) * args.noise).astype(np.float32)

    out = args.output
    pc.save_wav(out, x, sr)
    print(f"合成演唱音频 → {out}（{dur:.1f}s, 偏差 {detune:+.0f}¢）")

    pitch = pc.detect_pitch(x, sr, hop_sec=pc.ANALYSIS_HOP_SEC)
    pitch = pc.clean_frames(pitch, min_conf=0.6)
    ref = pc.build_reference(pitch, snap=True, title="demo")
    ref_path = os.path.splitext(out)[0] + "-ref.json"
    pc.save_reference(ref, ref_path)
    print(f"参考轨道 → {ref_path}")
    print(f"\n验证：\n  python pitchcoach_cli.py score \"{out}\" --ref \"{ref_path}\"")


# ══════════════════════════════════════════════════════════
# 工具
# ══════════════════════════════════════════════════════════

_last_pct = [-1]


def _progress(p, prefix=""):
    pct = int(p * 100)
    if pct == _last_pct[0]:
        return
    _last_pct[0] = pct
    n = pct // 3
    sys.stdout.write(f"\r{prefix} [{'█' * n}{'·' * (33 - n)}] {pct:3d}%")
    sys.stdout.flush()


# ══════════════════════════════════════════════════════════
# CLI
# ══════════════════════════════════════════════════════════

def build_parser():
    p = argparse.ArgumentParser(
        prog="pitchcoach",
        description="PitchCoach 命令行 —— 练唱音准分析与录音排名",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument("--sr", type=int, default=48000, help="重采样目标（默认 48000）")

    sub = p.add_subparsers(dest="cmd", required=True)

    # extract
    e = sub.add_parser("extract", help="从音频提取参考旋律")
    e.add_argument("input")
    e.add_argument("-o", "--output", required=True, help="输出 ref.json")
    e.add_argument("--title", default="")
    e.add_argument("--hop", type=float, default=pc.ANALYSIS_HOP_SEC,
                   help="分析滑窗步长（秒）")
    e.add_argument("--min-hz", type=float, default=pc.PITCH_MIN_HZ)
    e.add_argument("--max-hz", type=float, default=pc.PITCH_MAX_HZ)
    e.add_argument("--min-conf", type=float, default=0.6)
    e.add_argument("--snap", action="store_true", help="参考音高吸附到半音")
    e.add_argument("--report", action="store_true", help="打印音高分布")
    e.set_defaults(func=cmd_extract)

    # score
    s = sub.add_parser("score", help="给一条录音打分")
    s.add_argument("input")
    s.add_argument("--ref", required=True)
    s.add_argument("--mode", default="exact", choices=list(pc.SCORE_MODES))
    s.add_argument("--min-hz", type=float, default=pc.PITCH_MIN_HZ)
    s.add_argument("--max-hz", type=float, default=pc.PITCH_MAX_HZ)
    s.add_argument("--min-conf", type=float, default=0.6)
    s.add_argument("--align", action="store_true", help="自动对齐时间偏移")
    s.add_argument("--max-lag", type=float, default=6.0)
    s.add_argument("--json", default="")
    s.add_argument("--plot", default="")
    s.set_defaults(func=cmd_score)

    # rank
    r = sub.add_parser("rank", help="多条录音排名")
    r.add_argument("inputs", nargs="+")
    r.add_argument("--ref", required=True)
    r.add_argument("--mode", default="exact", choices=list(pc.SCORE_MODES))
    r.add_argument("--min-hz", type=float, default=pc.PITCH_MIN_HZ)
    r.add_argument("--max-hz", type=float, default=pc.PITCH_MAX_HZ)
    r.add_argument("--min-conf", type=float, default=0.6)
    r.add_argument("--align", action="store_true")
    r.add_argument("--json", default="")
    r.set_defaults(func=cmd_rank)

    # separate
    sp = sub.add_parser("separate", help="人声分离（需要 demucs）")
    sp.add_argument("input")
    sp.add_argument("-o", "--output", default="stems")
    sp.add_argument("-n", "--model", default="htdemucs")
    sp.add_argument("-d", "--device", default="")
    sp.set_defaults(func=cmd_separate)

    # plot
    pl = sub.add_parser("plot", help="导出钢琴卷帘图")
    pl.add_argument("input")
    pl.add_argument("--ref", required=True)
    pl.add_argument("-o", "--output", required=True)
    pl.add_argument("--mode", default="exact", choices=list(pc.SCORE_MODES))
    pl.add_argument("--min-hz", type=float, default=pc.PITCH_MIN_HZ)
    pl.add_argument("--max-hz", type=float, default=pc.PITCH_MAX_HZ)
    pl.add_argument("--min-conf", type=float, default=0.6)
    pl.add_argument("--align", action="store_true")
    pl.set_defaults(func=cmd_plot)

    # demo
    d = sub.add_parser("demo", help="生成合成测试音频")
    d.add_argument("-o", "--output", default="demo.wav")
    d.add_argument("--detune-cents", type=float, default=0.0)
    d.add_argument("--vibrato", type=float, default=0.004)
    d.add_argument("--noise", type=float, default=0.002)
    d.set_defaults(func=cmd_demo)

    return p


def main():
    args = build_parser().parse_args()
    try:
        args.func(args)
    except KeyboardInterrupt:
        print("\n中断", file=sys.stderr)
        sys.exit(130)
    except Exception as e:
        print(f"\n错误：{e}", file=sys.stderr)
        if os.environ.get("PC_DEBUG"):
            raise
        sys.exit(1)


if __name__ == "__main__":
    main()
