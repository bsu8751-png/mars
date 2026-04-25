/* =========================================================
   MARS CLIMATE RADAR — app.js  v2.0
   ─────────────────────────────────────────────────────────
   핵심 구현:
   ① video.getBoundingClientRect() 로 실제 화면 좌표 획득
   ② CSS transform/object-fit 보정 (scaleX, scaleY)
   ③ base 좌표(xPct,yPct)를 center 기준 cos/sin 회전 변환
   ④ translate3d(...) 로 overlay 위치 적용 (left/top 미사용)
   ⑤ 콘솔: slotId, video.currentTime, computedX, computedY
   ⑥ 데이터: 5s 폴링 + 150~250ms 보간
   ========================================================= */
'use strict';

const D2R = Math.PI / 180;
const VIDEO_W = 1936, VIDEO_H = 1060;
const SPHERE_CX_PCT = 0.50, SPHERE_CY_PCT = 0.50, SPHERE_R_PCT = 0.435;
const ROT_SPEED = 0.16;

// 경도 슬롯 (10° 간격)
const LON_SLOTS = [];
for (let lon = 0; lon < 360; lon += 10) {
  for (let lat = -60; lat <= 60; lat += 20) {
    if (lat === 0) continue;
    LON_SLOTS.push({ lon, lat, id: `lon${lon}_lat${lat}` });
  }
}

// 화성 기후 스테이션
const STATIONS_BASE = [
  { id:'VAL', lat: 45.0, lon:  12.0, ld:'N', od:'E', temp:-72.8, pres:6.1 },
  { id:'PER', lat:-45.0, lon:-12.0,  ld:'S', od:'W', temp:-86.6, pres:5.8 },
  { id:'BLV', lat: 88.0, lon:  15.0, ld:'N', od:'E', temp:-45.3, pres:7.2 },
  { id:'ARS', lat:-88.0, lon:-15.0,  ld:'S', od:'W', temp:-88.0, pres:5.2 },
];
const BOX_POS = [
  { side:'L', xR:-0.92, yR:-0.30 },
  { side:'R', xR: 0.64, yR:-0.40 },
  { side:'R', xR: 0.64, yR: 0.08 },
  { side:'L', xR:-0.92, yR: 0.42 },
];

const S = {
  playing:false, muted:true, gridVisible:true, dataVisible:true,
  glitchOn:true, lonVisible:true, speed:1.0, frameCount:0,
  fps:0, fpsFrames:0, fpsTimer:0, lastPoll:-9999,
  stations: STATIONS_BASE.map(b=>({...b, dispTemp:b.temp, targTemp:b.temp,
    dispPres:b.pres, targPres:b.pres, lerpT0:0, lerpDur:200})),
  logLines:[],
};

const video         = document.getElementById('mars-video');
const videoWrapper  = document.getElementById('video-wrapper');
const overlayCanvas = document.getElementById('overlay-canvas');
const glitchCanvas  = document.getElementById('glitch-canvas');
const overlayLayer  = document.getElementById('overlay-layer');
const leaderSvg     = document.getElementById('leader-svg');
const logContent    = document.getElementById('log-content');
const fpsDisplay    = document.getElementById('fps-display');
const utcTime       = document.getElementById('utc-time');
const btnPlay       = document.getElementById('btn-play');
const btnMute       = document.getElementById('btn-mute');
const volSlider     = document.getElementById('vol-slider');
const speedSlider   = document.getElementById('speed-slider');
const speedVal      = document.getElementById('speed-val');
const toggleGrid    = document.getElementById('toggle-grid');
const toggleData    = document.getElementById('toggle-data');
const toggleGlitch  = document.getElementById('toggle-glitch');
const toggleLon     = document.getElementById('toggle-lonlabels');
const btnShare      = document.getElementById('btn-share');
const shareToast    = document.getElementById('share-toast');
const octx = overlayCanvas.getContext('2d');
const gctx = glitchCanvas.getContext('2d');

let lonLabelEls=[], dataBoxEls=[], leaderLineEls=[];

function buildOverlayElements() {
  lonLabelEls.forEach(e=>e.remove());
  dataBoxEls.forEach(e=>e.remove());
  leaderSvg.innerHTML='';
  lonLabelEls=[]; dataBoxEls=[]; leaderLineEls=[];

  for (const sl of LON_SLOTS) {
    const el=document.createElement('div');
    el.style.cssText='position:absolute;top:0;left:0;font-family:\'Share Tech Mono\',monospace;font-size:clamp(7px,0.7vw,9.5px);color:rgba(160,232,255,0.82);white-space:nowrap;pointer-events:none;will-change:transform;transform-origin:0 0;text-shadow:0 0 5px rgba(0,200,255,0.35);line-height:1;z-index:6;';
    let v=sl.lon%180; if(v<0)v+=180;
    el.textContent=v+'°';
    el.dataset.lon=sl.lon; el.dataset.lat=sl.lat; el.dataset.sid=sl.id;
    overlayLayer.appendChild(el);
    lonLabelEls.push(el);
  }

  for (let i=0;i<S.stations.length;i++) {
    const sd=S.stations[i];
    const box=document.createElement('div');
    box.style.cssText='position:absolute;top:0;left:0;min-width:96px;padding:7px 10px 8px;border:1px solid rgba(0,229,255,0.62);background:rgba(2,12,44,0.86);backdrop-filter:blur(8px);pointer-events:none;will-change:transform;transform-origin:0 0;box-shadow:0 0 18px rgba(0,180,255,0.12);z-index:7;';
    box.innerHTML=`<div style="font-family:'Orbitron',monospace;font-size:clamp(9px,1vw,12px);font-weight:700;color:#00e5ff;letter-spacing:0.18em;text-shadow:0 0 9px rgba(0,229,255,0.38);margin-bottom:3px;">${sd.id}</div><div style="font-family:'Share Tech Mono',monospace;font-size:clamp(7.5px,0.78vw,10px);color:#fff;line-height:1.65;"><span style="color:#4dd9ff">${Math.abs(sd.lat).toFixed(1)}°${sd.ld}</span></div><div style="font-family:'Share Tech Mono',monospace;font-size:clamp(7.5px,0.78vw,10px);color:#fff;line-height:1.65;"><span style="color:#4dd9ff">${Math.abs(sd.lon).toFixed(1)}°${sd.od}</span></div><div style="font-family:'Share Tech Mono',monospace;font-size:clamp(7.5px,0.78vw,10px);color:#fff;line-height:1.65;">T <span class="tv" style="color:#4dd9ff">${sd.dispTemp.toFixed(1)}°C</span></div>`;
    overlayLayer.appendChild(box);
    dataBoxEls.push(box);

    const ln=document.createElementNS('http://www.w3.org/2000/svg','line');
    ln.setAttribute('stroke','rgba(0,229,255,0.38)');
    ln.setAttribute('stroke-width','1');
    ln.setAttribute('stroke-dasharray','5,3');
    leaderSvg.appendChild(ln);
    leaderLineEls.push(ln);
  }
}

// 3D 투영: 구면 좌표 → 영상 내 비율 좌표
function projectToVideo(latDeg, lonDeg, rotAngle) {
  const lat=latDeg*D2R, lon=lonDeg*D2R+rotAngle;
  const x3= Math.cos(lat)*Math.sin(lon);
  const y3=-Math.sin(lat);
  const z3= Math.cos(lat)*Math.cos(lon);
  const fov=2.4, sc=fov/(fov+z3);
  const xPct=SPHERE_CX_PCT+x3*SPHERE_R_PCT*sc*(VIDEO_H/VIDEO_W);
  const yPct=SPHERE_CY_PCT+y3*SPHERE_R_PCT*sc;
  return {xPct,yPct,z:z3,sc,visible:z3>-0.10};
}

// video.getBoundingClientRect() 기반 실제 표시 영역 계산
function getVideoDisplayRect() {
  const vRect=video.getBoundingClientRect();
  const wRect=videoWrapper.getBoundingClientRect();
  const cW=vRect.width, cH=vRect.height;
  const vAsp=VIDEO_W/VIDEO_H, cAsp=cW/cH;
  let dW,dH,dX,dY;
  if(cAsp>vAsp){dH=cH;dW=cH*vAsp;dX=(cW-dW)/2;dY=0;}
  else{dW=cW;dH=cW/vAsp;dX=0;dY=(cH-dH)/2;}
  const offX=vRect.left-wRect.left, offY=vRect.top-wRect.top;
  return {
    x:offX+dX, y:offY+dY, w:dW, h:dH,
    toScreen:(xPct,yPct)=>({x:offX+dX+xPct*dW, y:offY+dY+yPct*dH}),
  };
}

// ═══════════════════════════════════════════════════════════
//  매 프레임 overlay 위치 갱신 (rAF 내부에서 호출)
// ═══════════════════════════════════════════════════════════
function updateOverlayPositions(rotAngle) {
  const vt=video.currentTime;
  const dr=getVideoDisplayRect();
  const cX=dr.x+SPHERE_CX_PCT*dr.w;
  const cY=dr.y+SPHERE_CY_PCT*dr.h;
  const Rs=SPHERE_R_PCT*dr.h;
  const batch=[];

  // 경도 숫자 레이블
  if(S.lonVisible){
    for(const el of lonLabelEls){
      const lonDeg=parseFloat(el.dataset.lon);
      const latDeg=parseFloat(el.dataset.lat);
      const slotId=el.dataset.sid;
      const p=projectToVideo(latDeg,lonDeg,rotAngle);
      if(!p.visible){el.style.opacity='0';continue;}
      const {x:computedX,y:computedY}=dr.toScreen(p.xPct,p.yPct);
      const alpha=Math.max(0,Math.min(0.86,(p.z+0.10)*1.7));
      el.style.opacity=alpha.toFixed(3);
      // ④ translate3d 적용
      el.style.transform=`translate3d(${computedX.toFixed(2)}px,${computedY.toFixed(2)}px,0) translate(-50%,-50%)`;
      // ⑤ 샘플 로그
      if(Math.random()<0.0012){
        const msg=`[${slotId}] t=${vt.toFixed(3)}s x=${computedX.toFixed(2)} y=${computedY.toFixed(2)}`;
        batch.push(msg); console.log(msg);
      }
    }
  } else {
    lonLabelEls.forEach(el=>{el.style.opacity='0';});
  }

  // 데이터 박스
  if(S.dataVisible){
    for(let i=0;i<S.stations.length;i++){
      const sd=S.stations[i], box=dataBoxEls[i], ln=leaderLineEls[i], bp=BOX_POS[i];
      const p=projectToVideo(sd.lat,sd.lon,rotAngle);
      const {x:sfX,y:sfY}=dr.toScreen(p.xPct,p.yPct);
      const bX=cX+bp.xR*Rs, bY=cY+bp.yR*Rs;
      box.style.transform=`translate3d(${bX.toFixed(2)}px,${bY.toFixed(2)}px,0)`;
      box.style.opacity='1';
      const tv=box.querySelector('.tv');
      if(tv)tv.textContent=sd.dispTemp.toFixed(1)+'°C';
      const bw=box.offsetWidth||96, bh=box.offsetHeight||66;
      const lx1=bp.side==='L'?bX+bw:bX, ly1=bY+bh/2;
      ln.setAttribute('x1',lx1.toFixed(1)); ln.setAttribute('y1',ly1.toFixed(1));
      ln.setAttribute('x2',sfX.toFixed(1)); ln.setAttribute('y2',sfY.toFixed(1));
      const msg=`[${sd.id}] t=${vt.toFixed(3)}s x=${sfX.toFixed(2)} y=${sfY.toFixed(2)}`;
      batch.push(msg); console.log(msg);
    }
  } else {
    dataBoxEls.forEach(b=>{b.style.opacity='0';});
    leaderLineEls.forEach(l=>{l.setAttribute('x1','0');l.setAttribute('x2','0');});
  }

  // 패널 로그
  for(const m of batch) S.logLines.push(m);
  if(S.logLines.length>100) S.logLines=S.logLines.slice(-100);
  if(batch.length>0&&logContent){
    logContent.innerHTML=S.logLines.map(l=>`<div>${l}</div>`).join('');
    logContent.scrollTop=logContent.scrollHeight;
  }
}

function resizeCanvases(){
  const r=videoWrapper.getBoundingClientRect();
  overlayCanvas.width=r.width; overlayCanvas.height=r.height;
  glitchCanvas.width=r.width;  glitchCanvas.height=r.height;
}

function drawGrid(){
  if(!S.gridVisible){octx.clearRect(0,0,overlayCanvas.width,overlayCanvas.height);return;}
  const W=overlayCanvas.width,H=overlayCanvas.height;
  octx.clearRect(0,0,W,H);
  const vAsp=VIDEO_W/VIDEO_H,cAsp=W/H;
  let vw,vh,vx,vy;
  if(cAsp>vAsp){vh=H;vw=H*vAsp;vx=(W-vw)/2;vy=0;}
  else{vw=W;vh=W/vAsp;vx=0;vy=(H-vh)/2;}
  octx.save();
  octx.strokeStyle='rgba(0,229,255,0.08)';octx.lineWidth=0.5;octx.setLineDash([3,6]);
  for(let i=0;i<=12;i++){const x=vx+(vw/12)*i;octx.beginPath();octx.moveTo(x,vy);octx.lineTo(x,vy+vh);octx.stroke();}
  for(let j=0;j<=8;j++){const y=vy+(vh/8)*j;octx.beginPath();octx.moveTo(vx,y);octx.lineTo(vx+vw,y);octx.stroke();}
  octx.setLineDash([]);octx.strokeStyle='rgba(0,229,255,0.28)';octx.lineWidth=1;
  const bL=14;
  [[vx,vy],[vx+vw,vy],[vx,vy+vh],[vx+vw,vy+vh]].forEach(([cx,cy],idx)=>{
    const sx=idx%2===0?1:-1,sy=idx<2?1:-1;
    octx.beginPath();octx.moveTo(cx+sx*bL,cy);octx.lineTo(cx,cy);octx.lineTo(cx,cy+sy*bL);octx.stroke();
  });
  octx.restore();
}

let glitchTimer=0;
function drawGlitch(ts){
  if(!S.glitchOn){gctx.clearRect(0,0,glitchCanvas.width,glitchCanvas.height);return;}
  const W=glitchCanvas.width,H=glitchCanvas.height;
  if(ts-glitchTimer>(2000+Math.random()*4000)){
    glitchTimer=ts;gctx.clearRect(0,0,W,H);
    const slices=2+Math.floor(Math.random()*4);
    for(let s=0;s<slices;s++){
      const y=Math.random()*H,h=1+Math.random()*4,shift=(Math.random()-0.5)*20;
      gctx.fillStyle=`rgba(0,${Math.floor(180+Math.random()*75)},${Math.floor(Math.random()*40)},${0.12+Math.random()*0.2})`;
      gctx.fillRect(shift,y,W,h);
    }
    setTimeout(()=>gctx.clearRect(0,0,W,H),80+Math.random()*120);
  }
}

const BASE={tempMain:-68.35,presMain:767.89,windMain:0.576,tauMain:1.324,
  ingT:-61.6,ingP:753,ingTau:1.71,olyT:-45.7,olyP:691,olyTau:0.49,
  curT:-64.5,curP:764,curTau:0.79,ls:242.9,rng:7.68};
const history={
  pressure:Array.from({length:40},(_,i)=>BASE.presMain+Math.sin(i*0.3)*8),
  temp:Array.from({length:40},(_,i)=>BASE.tempMain+Math.cos(i*0.25)*5),
  tau:Array.from({length:40},(_,i)=>BASE.tauMain+Math.sin(i*0.4)*0.2),
  wind:Array.from({length:40},(_,i)=>BASE.windMain+Math.abs(Math.sin(i*0.5))*0.3),
};
function fmt(v,d){return v>=0?v.toFixed(d):'−'+Math.abs(v).toFixed(d);}
function setText(id,v){const e=document.getElementById(id);if(e)e.textContent=v;}

function updateClimateData(){
  const now=Date.now()/1000;
  const temp=BASE.tempMain+Math.sin(now*0.05)*4+(Math.random()-0.5)*0.5;
  const pres=BASE.presMain+Math.sin(now*0.03)*12+(Math.random()-0.5)*1;
  const wind=Math.max(0.1,BASE.windMain+Math.sin(now*0.08)*0.2+(Math.random()-0.5)*0.05);
  const tau=Math.max(0.1,BASE.tauMain+Math.sin(now*0.04)*0.3+(Math.random()-0.5)*0.03);
  const ls=(BASE.ls+(now*0.001))%360;
  const rng=BASE.rng+Math.sin(now*0.07)*0.5;
  const ingT=BASE.ingT+Math.sin(now*0.06)*3;
  const ingP=BASE.ingP+Math.sin(now*0.04)*10;
  const ingTau=Math.max(0.1,BASE.ingTau+Math.sin(now*0.05)*0.2);
  const olyT=BASE.olyT+Math.cos(now*0.05)*2;
  const olyP=BASE.olyP+Math.cos(now*0.04)*8;
  const olyTau=Math.max(0.1,BASE.olyTau+Math.cos(now*0.06)*0.1);
  const curT=BASE.curT+Math.sin(now*0.07+1)*3;
  const curP=BASE.curP+Math.sin(now*0.05+1)*9;
  const curTau=Math.max(0.1,BASE.curTau+Math.sin(now*0.04+1)*0.15);
  setText('temp-main',fmt(temp,2)+' °C');setText('pres-main',fmt(pres,2)+' Pa');
  setText('wind-main',fmt(wind,3)+' m/s');setText('tau-main',fmt(tau,3));
  setText('pres-left',fmt(pres,2));setText('temp-left',fmt(temp,2));
  setText('tau-left',fmt(tau,3));setText('wind-left',fmt(wind,3));
  setText('ls-val',fmt(ls,1)+'°');setText('rng-val',fmt(rng,2)+' NM');
  setText('ing-t',fmt(ingT,1)+'°C');setText('ing-p',Math.round(ingP)+' Pa');setText('ing-tau',fmt(ingTau,2));
  setText('oly-t',fmt(olyT,1)+'°C');setText('oly-p',Math.round(olyP)+' Pa');setText('oly-tau',fmt(olyTau,2));
  setText('cur-t',fmt(curT,1)+'°C');setText('cur-p',Math.round(curP)+' Pa');setText('cur-tau',fmt(curTau,2));
  history.pressure.push(pres);history.pressure.shift();
  history.temp.push(temp);history.temp.shift();
  history.tau.push(tau);history.tau.shift();
  history.wind.push(wind);history.wind.shift();
  drawSparkline('spark-pressure',history.pressure,'#00e5ff');
  drawSparkline('spark-temp',history.temp,'#00e5ff');
  drawSparkline('spark-tau',history.tau,'#00e5ff');
  drawSparkline('spark-wind',history.wind,'#00e5ff');
}

function drawSparkline(id,data,color){
  const canvas=document.getElementById(id);if(!canvas)return;
  const ctx=canvas.getContext('2d');const W=canvas.width,H=canvas.height;
  ctx.clearRect(0,0,W,H);
  const mn=Math.min(...data),mx=Math.max(...data),rng=mx-mn||1;
  ctx.beginPath();
  data.forEach((v,i)=>{const x=(i/(data.length-1))*W,y=H-((v-mn)/rng)*(H-4)-2;i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);});
  ctx.strokeStyle=color;ctx.lineWidth=1.2;ctx.globalAlpha=0.7;ctx.stroke();ctx.globalAlpha=1;
}

function pollStations(now){
  if(now-S.lastPoll<5000)return;
  S.lastPoll=now;
  for(let i=0;i<S.stations.length;i++){
    const sd=S.stations[i],b=STATIONS_BASE[i];
    sd.targTemp=b.temp+(Math.random()-0.5)*3.5;
    sd.targPres=b.pres+(Math.random()-0.5)*0.35;
    sd.lerpT0=now; sd.lerpDur=150+Math.random()*100;
  }
}
function lerpStations(now){
  for(const sd of S.stations){
    const t=Math.min(1,(now-sd.lerpT0)/sd.lerpDur);
    const e=t<0.5?2*t*t:-1+(4-2*t)*t;
    sd.dispTemp+=(sd.targTemp-sd.dispTemp)*e*0.10;
    sd.dispPres+=(sd.targPres-sd.dispPres)*e*0.10;
  }
}

function updateClock(){
  const now=new Date();
  const hh=String(now.getUTCHours()).padStart(2,'0');
  const mm=String(now.getUTCMinutes()).padStart(2,'0');
  const ss=String(now.getUTCSeconds()).padStart(2,'0');
  if(utcTime)utcTime.textContent=`${hh}:${mm}:${ss} UTC`;
}
function updateFPS(now){
  S.fpsFrames++;
  if(now-S.fpsTimer>=1000){S.fps=S.fpsFrames;S.fpsFrames=0;S.fpsTimer=now;if(fpsDisplay)fpsDisplay.textContent=S.fps+' FPS';}
}
function updateFrameCounter(){
  const frame=Math.floor(video.currentTime*30);
  const fc=document.querySelector('#frame-counter .val');if(fc)fc.textContent=String(frame).padStart(4,'0');
  const fcf=document.querySelector('#frame-counter-foot .val');if(fcf)fcf.textContent=String(frame).padStart(4,'0');
}

function setPlayIcon(playing){
  const icon=document.getElementById('play-icon');if(!icon)return;
  icon.setAttribute('d',playing?'M6 19h4V5H6v14zm8-14v14h4V5h-4z':'M8 5v14l11-7z');
  if(btnPlay)btnPlay.setAttribute('aria-label',playing?'일시정지':'재생');
}
function togglePlay(){
  if(video.paused){video.play().then(()=>{S.playing=true;setPlayIcon(true);}).catch(()=>{});}
  else{video.pause();S.playing=false;setPlayIcon(false);}
}
function toggleMute(){
  S.muted=!S.muted;video.muted=S.muted;
  const icon=document.getElementById('mute-icon');if(!icon)return;
  icon.setAttribute('d',S.muted?'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z':'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z');
}
function toggleLayer(btn,key){
  S[key]=!S[key];btn.classList.toggle('active',S[key]);btn.setAttribute('aria-pressed',S[key]);
}

if(btnPlay)btnPlay.addEventListener('click',togglePlay);
if(btnMute)btnMute.addEventListener('click',toggleMute);
if(volSlider)volSlider.addEventListener('input',()=>{video.volume=parseFloat(volSlider.value);});
if(speedSlider)speedSlider.addEventListener('input',()=>{
  S.speed=parseFloat(speedSlider.value);video.playbackRate=S.speed;
  if(speedVal)speedVal.textContent=S.speed.toFixed(1)+'x';
});
if(toggleGrid)toggleGrid.addEventListener('click',()=>toggleLayer(toggleGrid,'gridVisible'));
if(toggleData)toggleData.addEventListener('click',()=>toggleLayer(toggleData,'dataVisible'));
if(toggleGlitch)toggleGlitch.addEventListener('click',()=>toggleLayer(toggleGlitch,'glitchOn'));
if(toggleLon)toggleLon.addEventListener('click',()=>toggleLayer(toggleLon,'lonVisible'));
if(btnShare)btnShare.addEventListener('click',()=>{
  const url=location.href;
  if(navigator.share){navigator.share({title:'Mars Climate Radar',url}).catch(()=>{});}
  else{navigator.clipboard.writeText(url).then(()=>{if(shareToast){shareToast.textContent='링크 복사됨!';setTimeout(()=>{shareToast.textContent='';},2000);}}).catch(()=>{});}
});
document.addEventListener('keydown',e=>{if(e.code==='Space'&&e.target===document.body){e.preventDefault();togglePlay();}});
window.addEventListener('resize',()=>resizeCanvases());
const ro=new ResizeObserver(()=>resizeCanvases());
ro.observe(videoWrapper);

let clockTimer=0,dataTimer=0;

function loop(timestamp){
  S.frameCount++;
  updateFPS(timestamp);
  if(timestamp-clockTimer>1000){clockTimer=timestamp;updateClock();updateFrameCounter();}
  if(timestamp-dataTimer>1500){dataTimer=timestamp;updateClimateData();}
  pollStations(timestamp);
  lerpStations(timestamp);
  drawGrid();
  drawGlitch(timestamp);
  // 핵심: video.currentTime → 회전각 → overlay 위치 갱신
  const rotAngle=video.currentTime*ROT_SPEED;
  updateOverlayPositions(rotAngle);
  requestAnimationFrame(loop);
}

function init(){
  resizeCanvases();
  buildOverlayElements();
  video.muted=true;
  video.play().then(()=>{S.playing=true;setPlayIcon(true);}).catch(()=>{
    console.log('[MARS RADAR] 자동 재생 차단됨 — 재생 버튼을 눌러주세요');
  });
  updateClock();
  updateClimateData();
  requestAnimationFrame(loop);
}

if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',init);}
else{init();}
