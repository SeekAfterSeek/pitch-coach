import { spawn } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const PORT=9389, PROFILE=path.join(os.tmpdir(),"pc-three-"+Date.now());
const CHROME="C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const WAV="D:/DSH/workspace/SMALL RESULT/pitch-coach/samples/fake-mic-scale.wav";
const proc=spawn(CHROME,[`--remote-debugging-port=${PORT}`,`--user-data-dir=${PROFILE}`,"--no-first-run","--window-size=1500,950","--hide-scrollbars","--use-fake-ui-for-media-stream","--use-fake-device-for-media-stream",`--use-file-for-fake-audio-capture=${WAV}`,"--autoplay-policy=no-user-gesture-required","http://127.0.0.1:8756/"],{stdio:"ignore"});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let wsUrl;
for(let i=0;i<80;i++){try{const r=await fetch(`http://127.0.0.1:${PORT}/json/list`);const l=await r.json();const p=l.find(t=>t.type==="page"&&t.url.includes("127.0.0.1"));if(p){wsUrl=p.webSocketDebuggerUrl;break}}catch{}await sleep(250)}
const ws=new WebSocket(wsUrl); await new Promise(r=>ws.addEventListener("open",r));
let id=0; const pend=new Map(); const evts=[];
ws.addEventListener("message",e=>{const m=JSON.parse(e.data); if(m.id&&pend.has(m.id)){const{res}=pend.get(m.id);pend.delete(m.id);res(m.result)} else if(m.method) evts.push(m)});
const send=(method,params={})=>{const i=++id;ws.send(JSON.stringify({id:i,method,params}));return new Promise(res=>pend.set(i,{res}))};
const ev=async expr=>{const r=await send("Runtime.evaluate",{expression:expr,returnByValue:true,awaitPromise:true,userGesture:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value};
await send("Runtime.enable");
// 等应用真正初始化完（window.__PC 出现）
for (let i = 0; i < 40; i++) {
  const ready = await ev(`typeof window.__PC !== "undefined"`).catch(() => false);
  if (ready) break;
  await sleep(300);
}
await sleep(600);

console.log("═══ 问题1：麦克风开关 ═══");
const before = await ev(`(()=>({
  micText: document.getElementById('btnMic').textContent.trim(),
  offHidden: document.getElementById('btnMicOff').hidden,
}))()`);
console.log("  开启前:", JSON.stringify(before));

await ev(`document.getElementById('btnMic').click()`);
await sleep(2500);
const afterOn = await ev(`(()=>({
  micText: document.getElementById('btnMic').textContent.trim(),
  offHidden: document.getElementById('btnMicOff').hidden,
  micOn: window.__PC.S.micOn,
  streamAlive: !!window.__PC.S.engine.stream,
}))()`);
console.log("  开启后:", JSON.stringify(afterOn));

await ev(`document.getElementById('btnMicOff').click()`);
await sleep(1200);
const afterOff = await ev(`(()=>({
  micText: document.getElementById('btnMic').textContent.trim(),
  offHidden: document.getElementById('btnMicOff').hidden,
  micOn: window.__PC.S.micOn,
  streamGone: !window.__PC.S.engine.stream,
  meter: document.getElementById('micMeter').style.width,
  status: document.getElementById('statusText').textContent,
}))()`);
console.log("  关闭后:", JSON.stringify(afterOff));

console.log("\n═══ 问题2：此刻应唱 ═══");
const note0 = await ev(`(()=>({
  pitch: document.getElementById('nowPitch').textContent,
  sub: document.getElementById('nowSub').textContent,
}))()`);
console.log("  未播放:", JSON.stringify(note0));

await ev(`document.getElementById('btnMic').click()`);
await sleep(2000);
await ev(`document.getElementById('btnPlay').click()`);
await sleep(2500);
const note1 = await ev(`(()=>({
  pitch: document.getElementById('nowPitch').textContent,
  cents: document.getElementById('nowCents').textContent,
  sub: document.getElementById('nowSub').textContent,
  cls: document.getElementById('nowNote').className,
}))()`);
console.log("  播放中:", JSON.stringify(note1));

// 卷帘是否画出音名（检查像素分布变化）
const names = await ev(`(()=>{
  const c=document.getElementById('roll');
  const ctx=c.getContext('2d');
  const d=ctx.getImageData(0,0,c.width,c.height).data;
  let dark=0;
  for(let i=0;i<d.length;i+=4*13){
    // 灰条上的深色字
    if(d[i]<60&&d[i+1]<70&&d[i+2]<80) dark++;
  }
  return {darkPixels: dark};
})()`);
console.log("  卷帘深色像素(音名文字):", JSON.stringify(names));

console.log("\n═══ 问题3：录音回放停止 ═══");
// 录音
await ev(`document.getElementById('btnRec').click()`);
await sleep(5000);
await ev(`document.getElementById('btnRec').click()`);
await sleep(3000);
const rec = await ev(`(()=>({
  view: window.__PC.S.view,
  playBtn: document.getElementById('btnPlayTake').textContent.trim(),
  stopBtnDisabled: document.getElementById('btnStopTake').disabled,
}))()`);
console.log("  录音后:", JSON.stringify(rec));

// 播放录音
await ev(`document.getElementById('btnPlayTake').click()`);
await sleep(1500);
const playing = await ev(`(()=>({
  playBtn: document.getElementById('btnPlayTake').textContent.trim(),
  stopBtnDisabled: document.getElementById('btnStopTake').disabled,
  audioPlaying: window.__PC.S.takeAudio ? !window.__PC.S.takeAudio.paused : false,
}))()`);
console.log("  播放中:", JSON.stringify(playing));

// 点停止
await ev(`document.getElementById('btnStopTake').click()`);
await sleep(800);
const stopped = await ev(`(()=>({
  playBtn: document.getElementById('btnPlayTake').textContent.trim(),
  stopBtnDisabled: document.getElementById('btnStopTake').disabled,
  audioGone: !window.__PC.S.takeAudio,
  paused: true,
}))()`);
console.log("  停止后:", JSON.stringify(stopped));

const errs = evts.filter(e=>e.method==='Runtime.exceptionThrown').map(e=>e.params.exceptionDetails?.exception?.description);
console.log("\nERRORS:", errs.length?errs.slice(0,3):"none");

const r=await send("Page.captureScreenshot",{format:"png"});
fs.writeFileSync("shots/three-fixes.png",Buffer.from(r.data,"base64"));
ws.close(); await sleep(200); proc.kill(); try{fs.rmSync(PROFILE,{recursive:true,force:true})}catch{}
process.exit(0);
