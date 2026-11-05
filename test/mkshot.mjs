import { spawn } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const PORT=9337, PROFILE=path.join(os.tmpdir(),"pc-shot-"+Date.now());
const CHROME="C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const proc=spawn(CHROME,[`--remote-debugging-port=${PORT}`,`--user-data-dir=${PROFILE}`,"--no-first-run","--window-size=1500,950","--hide-scrollbars","http://127.0.0.1:8756/"],{stdio:"ignore"});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let wsUrl;
for(let i=0;i<60;i++){try{const r=await fetch(`http://127.0.0.1:${PORT}/json/list`);const l=await r.json();const p=l.find(t=>t.type==="page"&&t.url.includes("127.0.0.1"));if(p){wsUrl=p.webSocketDebuggerUrl;break}}catch{}await sleep(250)}
const ws=new WebSocket(wsUrl); await new Promise(r=>ws.addEventListener("open",r));
let id=0; const pend=new Map();
ws.addEventListener("message",e=>{const m=JSON.parse(e.data); if(m.id&&pend.has(m.id)){const{res}=pend.get(m.id);pend.delete(m.id);res(m.result)}});
const send=(method,params={})=>{const i=++id;ws.send(JSON.stringify({id:i,method,params}));return new Promise(res=>pend.set(i,{res}))};
const ev=async expr=>{const r=await send("Runtime.evaluate",{expression:expr,returnByValue:true,awaitPromise:true,userGesture:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description);return r.result.value};
await send("Runtime.enable"); await sleep(2000);

// 注入一条 85 分左右的"演唱"
await ev(`(async()=>{
  const {S}=window.__PC;
  const {scoreTake,SCORE_MODES}=await import("./js/reference.js");
  const ref=S.ref; const frames=[];
  for(let t=0;t<ref.duration;t+=0.01){
    const m=ref.at(t);
    if(m==null){frames.push({t,midi:0,voiced:false,rms:0.02});continue}
    const seg=Math.floor(t/2); const bias=[0.04,-0.06,0.12,0.02,-0.09,0.15,-0.03,0.05][seg%8];
    frames.push({t,midi:m+bias+(Math.random()-0.5)*0.06,voiced:true,rms:0.2});
  }
  const s=scoreTake(ref,frames,{mode:SCORE_MODES.exact});
  window.__PC.setTakeForView(frames,s);
  const withBand=frames.map((f,i)=>({...f,band:s.bands[i]}));
  window.__PC.S.micOn=true;
  window.__PC.roll.live=frames[40];
  return {total:s.total};
})()`);

// 设置表盘到某个偏差
await ev(`(()=>{const g=window.__PC.gauge; g.set(18,true,"E4","E4"); g.smooth=18; g.draw();})()`);
await sleep(600);

// 实时视图截图
let r=await send("Page.captureScreenshot",{format:"png",clip:await ev(`(()=>{const el=document.querySelector("#view-live .roll-panel");const b=el.getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,height:b.height,scale:1}})()`)});
fs.writeFileSync("shots/product-roll.png",Buffer.from(r.data,"base64"));

// 左侧面板
r=await send("Page.captureScreenshot",{format:"png",clip:await ev(`(()=>{const el=document.querySelector("#view-live .gauge-panel");const b=el.getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,height:b.height,scale:1}})()`)});
fs.writeFileSync("shots/product-gauge.png",Buffer.from(r.data,"base64"));

// 全屏
r=await send("Page.captureScreenshot",{format:"png"});
fs.writeFileSync("shots/product-full.png",Buffer.from(r.data,"base64"));
console.log("done");
ws.close(); await sleep(200); proc.kill(); try{fs.rmSync(PROFILE,{recursive:true,force:true})}catch{}
process.exit(0);
