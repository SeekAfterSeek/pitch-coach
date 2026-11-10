/**
 * 歌词识别（浏览器原生 Web Speech API）
 * ═══════════════════════════════════════════════════════════
 * 在"录入参考人声"录音的同时开一个 SpeechRecognition，把唱/念的词
 * 转成文本，解析完成后自动填进歌词框。
 *
 * 实战加固（针对"录了很多识别不到歌词"）：
 *  1. Chrome 的识别器有"几秒没声就自动 onend"的习惯 → 自动重启，
 *     直到主动 stop() 为止（整段录音期间保持活着）
 *  2. 报错不放弃：'no-speech' / 'aborted' / 'network' 全部静默重启，
 *     只有 'not-allowed'（权限被拒）才真正停
 *  3. 歌词是断续唱的 → final 结果很可能一句一句蹦，全部累积不覆盖；
 *     每次变化都回调 onPartial，解析卡上能看到"正在识别…"
 *  4. 识别是辅助路径：识别不到永远可手动填 / 粘贴整段歌词
 */

/** 是否可用 */
export function speechAvailable() {
  return typeof window !== 'undefined' &&
    (typeof window.SpeechRecognition !== 'undefined' || typeof window.webkitSpeechRecognition !== 'undefined');
}

/**
 * 开始一段识别，返回控制器
 * @param {{lang?:string, onPartial?:(text:string)=>void, onFinal?:(text:string)=>void,
 *          onError?:(msg:string)=>void}} opts
 * @returns {{stop:()=>string, active:()=>boolean, text:()=>string}|null}
 */
export function startSpeech(opts = {}) {
  if (!speechAvailable()) { opts.onError?.('此浏览器不支持语音识别，请手动填写歌词'); return null; }
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;

  let finalText = '';
  let partial = '';
  let active = true;       // 用户还没点停止
  let engineOn = false;    // 识别器当前是否在跑
  let restartTimer = 0;
  let rec = null;

  const spawn = () => {
    if (!active) return;
    try { rec = new Ctor(); } catch { return; }
    rec.lang = opts.lang || 'zh-CN';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const txt = r[0]?.transcript || '';
        if (r.isFinal) {
          // 每段 final 独立累积（歌词断续唱，一句一句蹦）
          finalText += txt;
        } else {
          interim += txt;
        }
      }
      partial = interim;
      opts.onPartial?.(finalText + interim);
      if (interim === '' ) {
        // 只在有新 final 落地时通知 onFinal，避免每帧刷
        opts.onFinal?.(finalText);
      }
    };
    rec.onerror = (e) => {
      const err = e.error || '识别出错';
      // not-allowed = 权限被拒，别再重启了；其余静默
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        active = false;
        opts.onError?.(err);
      } else {
        opts.onError?.(err);
      }
    };
    rec.onend = () => {
      engineOn = false;
      if (!active) return;
      // Chrome 唱歌间隔大 / 短语后几秒就 onend → 自动重启保持活着
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => { if (active) { try { rec.start(); engineOn = true; } catch { /* noop */ } } }, 350);
    };

    try { rec.start(); engineOn = true; } catch (e) {
      opts.onError?.('无法启动语音识别：' + e.message);
      return;
    }
  };
  spawn();

  return {
    stop() {
      active = false;
      clearTimeout(restartTimer);
      try { rec?.stop(); } catch { /* noop */ }
      return (finalText + partial).trim();
    },
    active: () => active,
    text: () => (finalText + partial).trim(),
  };
}
