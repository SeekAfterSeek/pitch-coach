# 旧版 UI 测试（已归档）

这些 CDP 测试绑定的是**旧版多标签界面**（`window.__PC`、曲库、内置曲目、
自动找歌词、教唱面板、录音复盘标签）。新版「人声对比工作室」已按产品要求
**完全弃用旧逻辑**（单页、上来就录参考人声、任意两段历史互比），
这些测试所依赖的 DOM 与钩子都不再存在，因此移出主测试目录，仅作历史留存。

| 文件 | 依赖的旧接口 |
|---|---|
| `audio-persist.test.mjs` | `__PC.importForTest` / `selectTrack` / `play` / `S` |
| `verify-ui.mjs` | `__PC.injectTestTrack` / `getLyricsState` / `showLyricsAt` / 曲库 DOM |
| `vocal-ui.mjs` | `__PC.buildVocalRefFromFrames` / `getVocalState` / 教唱面板 |
| `cdp.mjs` / `cdp-live.mjs` | `btnPlay` / `#view-live` / `__PC.roll` / 表盘 |
| `three-fixes.mjs` | `btnPlayTake` / 录音复盘标签 |
| `mkshot.mjs` | 截图脚本（旧版布局） |

## 当前有效的测试

- 纯算法（Node，直接 `node test/xxx.mjs`）：
  - `compare.test.mjs` — 两段人声解析/对齐/评分/逐音符诊断（38 项）
  - `vocal.test.mjs` — 逐字对齐与清唱打分（18 项）
  - `lyrics.test.mjs`（39）、`align.test.mjs`（8）、`selftest.mjs`（61）
- 新版 CDP 端到端（需 `node server.mjs 8756`）：
  - `studio-ui.mjs` — 单页全流程 + 历史互比（29 项）
  - `studio-shot.mjs` — 三个界面截图
