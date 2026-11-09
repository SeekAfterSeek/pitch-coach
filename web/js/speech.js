/**
 * 歌词识别（浏览器原生 Web Speech API，无需联网服务在本进程内）
 * ═══════════════════════════════════════════════════════════
 * 在"录入参考人声"录音的同时开一个 SpeechRecognition，把唱/念的词
 * 转成文本，解析完成后自动填进歌词框。识别不到就退回占位符，
 * 用户始终可以手动编辑并「确定」。
 *
 * 说明：Chrome 的 webkitSpeechRecognition 在部分环境需要联网、且对唱歌
 * 识别率有限，所以它是"辅助自动填词"，不是唯一来源——编辑框永远可改。
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
  const rec = new Ctor();
  rec.lang = opts.lang || 'zh-CN';
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  let finalText = '';
  let partial = '';
  let active = true;

  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      const txt = r[0]?.transcript || '';
      if (r.isFinal) finalText += txt;
      else interim += txt;
    }
    partial = interim;
    opts.onPartial?.(finalText + interim);
  };
  rec.onerror = (e) => {
    // 'no-speech' 之类不必打断流程，交给用户手动填
    opts.onError?.(e.error || '识别出错');
  };
  rec.onend = () => { active = false; };

  try { rec.start(); } catch (e) {
    opts.onError?.('无法启动语音识别：' + e.message);
    return null;
  }

  return {
    stop() {
      active = false;
      try { rec.stop(); } catch { /* noop */ }
      return (finalText + partial).trim();
    },
    active: () => active,
    text: () => (finalText + partial).trim(),
  };
}
