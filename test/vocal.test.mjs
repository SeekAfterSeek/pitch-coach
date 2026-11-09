/**
 * vocal.js 单元自测：参考解析 + 逐字对齐 + 清唱打分
 * 用合成音符 / 合成清唱帧验证，不依赖浏览器与麦克风。
 */
import { analyzeVocal, alignLyricsToVocal, scoreVocalTake, vocalUnitText, vocalBand } from '../web/js/vocal.js';
import { referenceFromFrames } from '../web/js/reference.js';
import { HOP_SEC } from '../web/js/reference.js';

let passed = 0, failed = 0;
function ok(name, cond, extra='') {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, extra); }
}

// ——— 造一段参考帧：C4(60) 0-1s, E4(64) 1-2s, G4(67) 2-3s，然后 3-4s 间奏(无声) ———
function makeFrames(spec) {
  const frames = [];
  for (const [midi, s, e] of spec) {
    for (let t = s; t < e; t += HOP_SEC) {
      frames.push({ t, midi, voiced: midi > 0, rms: 0.2, confidence: 0.9 });
    }
  }
  return frames;
}

// 1) analyzeVocal：能从帧生成参考旋律
{
  const frames = makeFrames([[60,0,1],[64,1,2],[67,2,3]]);
  const { ref, notes } = analyzeVocal(frames, { title: 't' });
  ok('analyzeVocal 时长 ≈3s', Math.abs(ref.duration - 3) < 0.2, ref.duration);
  ok('analyzeVocal 提取到 3 个音符', notes.length >= 3, notes.length);
  ok('第一个音符是 C4', Math.round(notes[0].midi) === 60, notes[0]?.midi);
}

// 2) alignLyricsToVocal：歌词按时间对齐到旋律
{
  const frames = makeFrames([[60,0,1],[64,1,2],[67,2,3]]); // 假设每字一拍
  const { ref } = analyzeVocal(frames);
  // 一行一个字，正好 0-3s
  const lyric = '[00:00.00]你\n[00:01.00]好\n[00:02.00]呀';
  const units = alignLyricsToVocal(lyric, ref, 3);
  ok('对齐出 3 个可唱单元', units.filter(u=>!u.isRest).length === 3, JSON.stringify(units));
  ok('单元1 目标音高 = C4', units[0].midi === 60, units[0].midi);
  ok('单元2 目标音高 = E4', units.find(u=>u.char==='好')?.midi === 64);
  ok('单元3 目标音高 = G4', units.find(u=>u.char==='呀')?.midi === 67);
}

// 3) 间奏 → rest 单元
{
  const frames = makeFrames([[60,0,1],[0,1,2],[67,2,3]]); // 1-2s 无声
  const { ref } = analyzeVocal(frames);
  const lyric = '[00:00.00]你\n[00:01.00]～\n[00:02.00]呀';
  const units = alignLyricsToVocal(lyric, ref, 3);
  const rest = units.find(u=>u.char==='～');
  ok('间奏标记为 rest', rest && rest.isRest === true, JSON.stringify(rest));
}

// 4) scoreVocalTake：清唱准、偏高、漏唱
{
  const frames = makeFrames([[60,0,1],[64,1,2],[67,2,3]]);
  const { ref } = analyzeVocal(frames);
  const lyric = '[00:00.00]你\n[00:01.00]好\n[00:02.00]呀';
  const units = alignLyricsToVocal(lyric, ref, 3);

  // 完美清唱：每个字唱准
  const perfectTake = makeFrames([[60,0,1],[64,1,2],[67,2,3]]);
  const r1 = scoreVocalTake(units, perfectTake, { mode: { tol: 50 } });
  ok('完美清唱准音率 1', r1.accuracy === 1, r1.accuracy);
  ok('完美清唱总分高', r1.totalScore >= 95, r1.totalScore);

  // 偏高一个半音(60→61)
  const sharpTake = makeFrames([[61,0,1],[64,1,2],[67,2,3]]);
  const r2 = scoreVocalTake(units, sharpTake, { mode: { tol: 50 } });
  ok('偏高被识别', r2.units[0].status === 'sung' && r2.units[0].dev > 0, r2.units[0].dev);

  // 漏唱最后一字（第三字窗口 2.0-3.0s 内完全无声；干扰音放在窗口外 3.2s）
  const missedTake = makeFrames([[60,0,0.92],[64,1.02,1.95],[55,3.2,3.4]]);
  const r3 = scoreVocalTake(units, missedTake, { mode: { tol: 50 } });
  ok('漏唱被识别', r3.missed === 1, r3.missed);
}

// 5) 节奏：唱快 / 唱慢
{
  const frames = makeFrames([[60,0,1]]);
  const { ref } = analyzeVocal(frames);
  const lyric = '[00:00.00]一';
  const units = alignLyricsToVocal(lyric, ref, 1);
  // 在 0.0s 之前 0.1s 起唱（落在 ±0.12s 窗口内）→ 快了
  const early = [{ t: -0.1, midi: 60, voiced: true, rms: 0.2 }];
  const rE = scoreVocalTake(units, early, { mode: { tol: 50 } });
  ok('早唱 → timing<0', rE.units[0].timing < 0, rE.units[0]?.timing);
  const late = [{ t: 0.1, midi: 60, voiced: true, rms: 0.2 }];
  const rL = scoreVocalTake(units, late, { mode: { tol: 50 } });
  ok('晚唱 → timing>0', rL.units[0].timing > 0, rL.units[0]?.timing);
}

// 6) vocalUnitText 文案
{
  const frames = makeFrames([[60,0,1],[64,1,2],[67,2,3]]);
  const { ref } = analyzeVocal(frames);
  const units = alignLyricsToVocal('[00:00.00]你\n[00:01.00]好\n[00:02.00]呀', ref, 3);
  const r = scoreVocalTake(units, frames, { mode: { tol: 50 } });
  const txt = vocalUnitText(r.units[0], 50);
  ok('诊断文案含音名', /C4/.test(txt), txt);
}

// 7) vocalBand 分档
{
  ok('vocalBand 0¢ = perfect', vocalBand(0,50) === 'perfect');
  ok('vocalBand 60¢ = off (sharp under ±2tol)', vocalBand(60,50) === 'sharp');
  ok('vocalBand -30¢ = ok', vocalBand(-30,50) === 'ok');
}

console.log(`\nvocal.test: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
