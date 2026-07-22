// ==========================================================================
// اللعبة الرئيسية — الطاولة الافتراضية، توزيع الكروت، الإنذارات، المؤقت،
// عجلة الحظ، ونظام الجولات المتعددة (تسكيت + اغتيال + حماية + شات المافيا)
// ==========================================================================
import {
  ref, set, update, get, onValue, off, remove, push
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";
import { db } from "./firebase-init.js";

/* ---------------- helpers ---------------- */
function mgUid(){ return 'p_' + Math.random().toString(36).slice(2,10); }
function mgCode(){ return String(Math.floor(1000 + Math.random()*9000)); }
function mgInitials(name){ return (name||'?').trim().slice(0,1).toUpperCase(); }
function esc(s){ const d=document.createElement('div'); d.innerText = s==null?'':s; return d.innerHTML; }

const MG_ROLE_META = {
  assassin:  { label:'مافيا (اغتيال)', icon:'🔫', color:'#e17b84' },
  silencer:  { label:'مافيا (تسكيت)',  icon:'🗡️', color:'#e17b84' },
  protector: { label:'الحامية',        icon:'🛡️', color:'#7fc9a0' },
  sheikh:    { label:'الشيخ',          icon:'🕯️', color:'#c9a24b' },
  citizen:   { label:'مواطن صالح',     icon:'👤', color:'#c9a24b' },
};
const MG_MAFIA_ROLES = ['assassin','silencer'];

/* صوت + اهتزاز */
let mgAudioCtx = null;
function mgEnsureAudio(){
  try{
    if(!mgAudioCtx){ mgAudioCtx = new (window.AudioContext||window.webkitAudioContext)(); }
    else if(mgAudioCtx.state==='suspended'){ mgAudioCtx.resume(); }
  }catch(e){}
}
function mgFireCue(){
  try{ if(navigator.vibrate) navigator.vibrate([160]); }catch(e){}
  try{
    if(mgAudioCtx){
      const osc=mgAudioCtx.createOscillator(), gain=mgAudioCtx.createGain();
      osc.type='sine'; osc.frequency.value=540;
      gain.gain.setValueAtTime(0.0001, mgAudioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.22, mgAudioCtx.currentTime+0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, mgAudioCtx.currentTime+0.4);
      osc.connect(gain); gain.connect(mgAudioCtx.destination);
      osc.start(); osc.stop(mgAudioCtx.currentTime+0.42);
    }
  }catch(e){}
}

/* ---------------- state ---------------- */
let mg = {
  myId: null, myName: '', isHost: false, roomCode: null,
  view: 'landing',
  error: '',
  selectedSeatId: null,
  cardFlipped: false,
  roleAcknowledged: false,
  pendingVerdict: null,
};
let mgRoom = null;       // mainGames/{code}
let mgActions = null;    // mainActions/{code} — أفعال الجولة الحالية
let mgHistory = {};      // mainHistory/{code} — نتائج كل الجولات السابقة {round: result}
let mgChat = [];         // mainChat/{code} — شات المافيا (اغتيال + تسكيت مع بعض)
let mgChatDraft = '';
let mgTargetDraft = '';
let mgPrevSilencer = false, mgPrevSheikh = false, mgPrevAssassin = false, mgPrevProtector = false;
let unsubMgRoom=null, unsubMgActions=null, unsubMgHistory=null, unsubMgChat=null;

/* ---------------- استمرارية الجلسة عبر الريفرش (localStorage — موقع حقيقي مش Artifact) ---------------- */
function mgSaveSession(){
  try{ localStorage.setItem('mg_session', JSON.stringify({roomCode:mg.roomCode, myId:mg.myId, myName:mg.myName, isHost:mg.isHost})); }catch(e){}
}
function mgClearSession(){
  try{ localStorage.removeItem('mg_session'); }catch(e){}
}
function mgTryRestoreSession(){
  try{
    const raw = localStorage.getItem('mg_session');
    if(!raw) return;
    const s = JSON.parse(raw);
    if(s && s.roomCode && s.myId){
      mg.roomCode = s.roomCode; mg.myId = s.myId; mg.myName = s.myName||''; mg.isHost = !!s.isHost;
      mgAttach(s.roomCode);
    }
  }catch(e){}
}

/* ---------------- Firebase live listeners ---------------- */
function mgAttach(code){
  mgDetach();
  mgPrevSilencer=false; mgPrevSheikh=false; mgPrevAssassin=false; mgPrevProtector=false;
  unsubMgRoom = onValue(ref(db,'mainGames/'+code), snap=>{
    mgRoom = snap.val();
    mgRender();
  });
  unsubMgActions = onValue(ref(db,'mainActions/'+code), snap=>{
    const na = snap.val() || {silencerDecided:false, silencedSeatId:null, assassinDecided:false, killedSeatId:null, protectorDecided:false, protectedSeatId:null, sheikhAsked:false, sheikhTargetSeatId:null, sheikhVerdict:null};
    if(na.silencerDecided && !mgPrevSilencer) mgFireCue();
    if(na.sheikhAsked && !mgPrevSheikh) mgFireCue();
    if(na.assassinDecided && !mgPrevAssassin) mgFireCue();
    if(na.protectorDecided && !mgPrevProtector) mgFireCue();
    mgPrevSilencer = !!na.silencerDecided;
    mgPrevSheikh = !!na.sheikhAsked;
    mgPrevAssassin = !!na.assassinDecided;
    mgPrevProtector = !!na.protectorDecided;
    mgActions = na;
    mgRender();
  });
  unsubMgHistory = onValue(ref(db,'mainHistory/'+code), snap=>{
    mgHistory = snap.val() || {};
    mgRender();
  });
  unsubMgChat = onValue(ref(db,'mainChat/'+code), snap=>{
    const val = snap.val() || {};
    mgChat = Object.values(val).sort((a,b)=>a.ts-b.ts);
    mgRender();
  });
}
function mgDetach(){
  if(unsubMgRoom){ off(ref(db,'mainGames/'+mg.roomCode)); unsubMgRoom=null; }
  if(unsubMgActions){ off(ref(db,'mainActions/'+mg.roomCode)); unsubMgActions=null; }
  if(unsubMgHistory){ off(ref(db,'mainHistory/'+mg.roomCode)); unsubMgHistory=null; }
  if(unsubMgChat){ off(ref(db,'mainChat/'+mg.roomCode)); unsubMgChat=null; }
}

/* ---------------- إعداد الطاولة وتوزيع الكروت ---------------- */
async function mgCreateTable(hostName, namesRaw, counts){
  const names = namesRaw.split('\n').map(s=>s.trim()).filter(Boolean);
  if(names.length < 3){ mg.error='لازم ٣ مقاعد على الأقل.'; mgRender(); return; }
  const sum = counts.assassin+counts.silencer+counts.protector+counts.sheikh;
  if(sum > names.length){ mg.error='مجموع الأدوار أكبر من عدد المقاعد.'; mgRender(); return; }

  mg.myId = mgUid();
  mg.myName = hostName || 'الحكم';
  mg.isHost = true;
  const code = mgCode();
  const seats = {};
  names.forEach((name,i)=>{
    seats['seat_'+i] = { order:i, name, role:null, playerId:null, warnings:0, status:'active' };
  });
  await set(ref(db,'mainGames/'+code), {
    code, hostId: mg.myId, createdAt: Date.now(),
    roleCounts: counts, dealt:false, round:1, phase:'night', seats
  });
  await set(ref(db,'mainActions/'+code), mgFreshActionsObj());
  await remove(ref(db,'mainHistory/'+code));
  await remove(ref(db,'mainChat/'+code));
  mg.roomCode = code;
  mg.view = 'host-table';
  mg.error='';
  mgAttach(code);
  mgSaveSession();
}

function mgFreshActionsObj(){
  return {
    silencerDecided:false, silencedSeatId:null,
    assassinDecided:false, killedSeatId:null,
    protectorDecided:false, protectedSeatId:null,
    sheikhAsked:false, sheikhTargetSeatId:null, sheikhVerdict:null
  };
}

async function mgDealCards(){
  if(!mgRoom) return;
  const seatIds = Object.keys(mgRoom.seats).filter(id=>mgRoom.seats[id].status==='active');
  for(let i=seatIds.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [seatIds[i],seatIds[j]]=[seatIds[j],seatIds[i]]; }
  const c = mgRoom.roleCounts;
  const pool = [];
  for(let i=0;i<c.assassin;i++) pool.push('assassin');
  for(let i=0;i<c.silencer;i++) pool.push('silencer');
  for(let i=0;i<c.protector;i++) pool.push('protector');
  for(let i=0;i<c.sheikh;i++) pool.push('sheikh');
  while(pool.length < seatIds.length) pool.push('citizen');

  const updates = {};
  seatIds.forEach((id,i)=>{ updates[`seats/${id}/role`] = pool[i]; });
  updates['dealt'] = true;
  updates['round'] = 1;
  updates['phase'] = 'night';
  await update(ref(db,'mainGames/'+mg.roomCode), updates);
  await set(ref(db,'mainActions/'+mg.roomCode), mgFreshActionsObj());
  await remove(ref(db,'mainHistory/'+mg.roomCode));
  await remove(ref(db,'mainChat/'+mg.roomCode));
  timerResetRoundLock();
}

/* ---------------- إدارة المقاعد (إنذار / إزالة / إقصاء) ---------------- */
async function mgAddWarning(seatId){
  const seat = mgRoom.seats[seatId];
  if(!seat || seat.status!=='active') return;
  const w = (seat.warnings||0)+1;
  if(w>=3){
    await update(ref(db,`mainGames/${mg.roomCode}/seats/${seatId}`), { warnings:3, status:'removed' });
  }else{
    await update(ref(db,`mainGames/${mg.roomCode}/seats/${seatId}`), { warnings:w });
  }
}
async function mgRemoveSeat(seatId){
  await update(ref(db,`mainGames/${mg.roomCode}/seats/${seatId}`), { status:'removed' });
}
async function mgRestoreSeat(seatId){
  await update(ref(db,`mainGames/${mg.roomCode}/seats/${seatId}`), { status:'active', warnings:0 });
}
// إقصاء نتيجة تصويت النهار — منفصل عن نظام الإنذارات
async function mgEliminateVote(seatId){
  await update(ref(db,`mainGames/${mg.roomCode}/seats/${seatId}`), { status:'removed' });
  mg.selectedSeatId = null;
  mgRender();
}

/* ---------------- انضمام لاعب لمقعد ---------------- */
async function mgJoinSeat(code, seatId, name){
  code = code.trim();
  const snap = await get(ref(db,'mainGames/'+code));
  const r = snap.val();
  if(!r){ mg.error='ما في طاولة بهاد الكود.'; mgRender(); return; }
  if(!seatId){ mg.error='اختار مقعدك من القائمة.'; mgRender(); return; }
  const myId = mgUid();
  await update(ref(db,`mainGames/${code}/seats/${seatId}`), { playerId: myId });
  mg.myId = myId; mg.myName = name; mg.isHost = false; mg.roomCode = code;
  mg.view = 'player-table'; mg.error='';
  mgAttach(code);
  mgSaveSession();
}

/* ---------------- أفعال الليل ---------------- */
async function mgSubmitSilence(targetSeatId){
  await update(ref(db,`mainActions/${mg.roomCode}`), { silencedSeatId: targetSeatId, silencerDecided:true });
}
async function mgSubmitAssassin(targetSeatId){
  await update(ref(db,`mainActions/${mg.roomCode}`), { killedSeatId: targetSeatId, assassinDecided:true });
}
async function mgSubmitProtect(targetSeatId){
  await update(ref(db,`mainActions/${mg.roomCode}`), { protectedSeatId: targetSeatId, protectorDecided:true });
}
async function mgSubmitSheikh(targetSeatId){
  const targetSeat = mgRoom.seats[targetSeatId];
  const isMafia = targetSeat && MG_MAFIA_ROLES.includes(targetSeat.role);
  const verdict = isMafia ? 'مافيا' : 'بريء';
  await update(ref(db,`mainActions/${mg.roomCode}`), { sheikhTargetSeatId: targetSeatId, sheikhAsked:true, sheikhVerdict: verdict });
  mg.pendingVerdict = { verdict };
  mgRender();
}

async function mgSendChat(text){
  const msgRef = push(ref(db,'mainChat/'+mg.roomCode));
  await set(msgRef, { senderId: mg.myId, senderName: mg.myName, text, ts: Date.now() });
}

/* ---------------- إنهاء الليل وحساب نتيجة الجولة ---------------- */
async function mgFinishNight(){
  const snap = await get(ref(db,'mainActions/'+mg.roomCode));
  const a = snap.val() || {};
  const round = mgRoom.round || 1;

  const silencedSeat = a.silencedSeatId ? mgRoom.seats[a.silencedSeatId] : null;

  let assassinActed = false, killedName = null;
  let protectorActed = false, protectorCorrect = null;

  if(round >= 2){
    protectorActed = !!a.protectorDecided;
    assassinActed = !!a.assassinDecided;
    if(assassinActed && a.killedSeatId){
      const victimSeat = mgRoom.seats[a.killedSeatId];
      const saved = protectorActed && a.protectedSeatId === a.killedSeatId;
      protectorCorrect = protectorActed ? saved : null;
      killedName = saved ? null : (victimSeat ? victimSeat.name : null);
    }
  }

  const result = {
    round,
    silencedName: silencedSeat ? silencedSeat.name : null,
    sheikhAsked: !!a.sheikhAsked,
    sheikhVerdict: a.sheikhVerdict || null,
    assassinActed, killedName,
    protectorActed, protectorCorrect,
    computedAt: Date.now()
  };
  await set(ref(db,`mainHistory/${mg.roomCode}/${round}`), result);
  await update(ref(db,'mainGames/'+mg.roomCode), { phase:'day' });
}

/* ---------------- بدء الجولة القادمة ---------------- */
async function mgStartNextRound(){
  const nextRound = (mgRoom.round||1) + 1;
  await update(ref(db,'mainGames/'+mg.roomCode), { round: nextRound, phase:'night' });
  await set(ref(db,'mainActions/'+mg.roomCode), mgFreshActionsObj());
  await remove(ref(db,'mainChat/'+mg.roomCode));
  timerResetRoundLock();
  mg.selectedSeatId = null;
  mgRender();
}

/* ---------------- عجلة الحظ (محلية بشاشة الهوست) ---------------- */
let wheelSpinning = false;
let wheelResultName = null;
function mgSpinWheel(){
  if(wheelSpinning || !mgRoom) return;
  const activeSeats = Object.values(mgRoom.seats).filter(s=>s.status==='active').sort((a,b)=>a.order-b.order);
  if(activeSeats.length < 2) return;
  wheelSpinning = true;
  wheelResultName = null;
  mgRender();
  const winnerIndex = Math.floor(Math.random()*activeSeats.length);
  const wheelEl = document.getElementById('mg-wheel-disc');
  const sliceAngle = 360/activeSeats.length;
  const targetAngle = 360*6 + (360 - (winnerIndex*sliceAngle + sliceAngle/2));
  if(wheelEl){
    wheelEl.style.transition = 'transform 4.2s cubic-bezier(.15,.85,.25,1)';
    wheelEl.style.transform = `rotate(${targetAngle}deg)`;
  }
  setTimeout(()=>{
    wheelSpinning = false;
    wheelResultName = activeSeats[winnerIndex].name;
    mgFireCue();
    mgRender();
  }, 4300);
}

/* ---------------- مؤقت الجلسة (عدّاد تنازلي، محلي بشاشة الهوست، بمدة ثابتة لكل جولة) ---------------- */
let timerDuration = null;   // بالثواني — يوم يتقفل لهالجولة
let timerRemaining = 0;
let timerRunning = false;
let timerFrozen = false;
let timerHandle = null;
let timerLockedRound = null;

function timerChooseDuration(sec){
  if(timerLockedRound === (mgRoom?mgRoom.round:null)) return;
  timerDuration = sec;
  timerRemaining = sec;
  timerLockedRound = mgRoom ? mgRoom.round : null;
  mgRender();
}
function timerTick(){
  timerRemaining--;
  if(timerRemaining <= 0){
    timerRemaining = 0;
    if(timerHandle){ clearInterval(timerHandle); timerHandle=null; }
    timerRunning = false;
    mgFireCue();
    mgRender();
    return;
  }
  mgRenderTimerOnly();
}
function timerStart(){
  if(timerRunning || timerDuration==null || timerRemaining<=0) return;
  timerRunning = true; timerFrozen = false;
  timerHandle = setInterval(timerTick, 1000);
  mgRender();
}
function timerPauseFreeze(){
  if(!timerRunning) return;
  timerRunning = false; timerFrozen = true;
  if(timerHandle){ clearInterval(timerHandle); timerHandle=null; }
  mgRender();
}
function timerResume(){
  if(!timerFrozen) return;
  timerFrozen = false;
  timerStart();
}
function timerReset(){
  timerRunning=false; timerFrozen=false;
  if(timerHandle){ clearInterval(timerHandle); timerHandle=null; }
  timerRemaining = timerDuration || 0;
  mgRender();
}
function timerResetRoundLock(){
  timerDuration=null; timerRemaining=0; timerRunning=false; timerFrozen=false; timerLockedRound=null;
  if(timerHandle){ clearInterval(timerHandle); timerHandle=null; }
}
function fmtTime(s){
  const m = Math.floor(s/60), sec = s%60;
  return String(m).padStart(2,'0')+':'+String(sec).padStart(2,'0');
}
function mgRenderTimerOnly(){
  const el = document.getElementById('mg-timer-display');
  if(el) el.textContent = fmtTime(timerRemaining);
}

/* ---------------- render ---------------- */
function mgRender(){
  const app = document.getElementById('mainGameApp');
  if(!app) return;
  app.innerHTML = mgBuildView();
  const isLandingHome = !mg.roomCode && mg.view==='landing';
  document.body.classList.toggle('home-bg', isLandingHome);
  mgWireEvents();
}

function mgWireEvents(){
  const scope = document.getElementById('mainGameApp');
  if(!scope) return;
  scope.querySelectorAll('[data-act]').forEach(el=>{
    el.onclick = async ()=>{
      mgEnsureAudio();
      const act = el.getAttribute('data-act');
      const val = el.getAttribute('data-val');
      await mgHandleAction(act, val);
    };
  });
  const targetInput = scope.querySelector('#mg-target-search');
  if(targetInput){ targetInput.oninput = (e)=>{ mgTargetDraft = e.target.value; }; }
  const chatInput = scope.querySelector('#mg-chat-input');
  if(chatInput){
    chatInput.oninput = (e)=>{ mgChatDraft = e.target.value; };
    chatInput.onkeydown = (e)=>{ if(e.key==='Enter'){ mgEnsureAudio(); mgHandleAction('mg-chat-send', null); } };
  }
  const chatScroll = scope.querySelector('#mg-chat-scroll');
  if(chatScroll){ chatScroll.scrollTop = chatScroll.scrollHeight; }
}

async function mgHandleAction(act, val){
  if(act==='mg-go-host-setup'){ mg.view='host-setup'; mg.error=''; mgRender(); return; }
  if(act==='mg-go-join'){ mg.view='player-join'; mg.error=''; mgRender(); return; }
  if(act==='mg-go-home'){ mgResetLocal(); return; }

  if(act==='mg-create-table'){
    const hostName = document.getElementById('mg-hostname').value || 'الحكم';
    const namesRaw = document.getElementById('mg-seat-names').value;
    const counts = {
      assassin: parseInt(document.getElementById('mg-c-assassin').value,10)||0,
      silencer: parseInt(document.getElementById('mg-c-silencer').value,10)||0,
      protector: parseInt(document.getElementById('mg-c-protector').value,10)||0,
      sheikh: parseInt(document.getElementById('mg-c-sheikh').value,10)||0,
    };
    await mgCreateTable(hostName, namesRaw, counts);
    return;
  }
  if(act==='mg-select-seat'){ mg.selectedSeatId = (mg.selectedSeatId===val)?null:val; mgRender(); return; }
  if(act==='mg-warn'){ await mgAddWarning(val); return; }
  if(act==='mg-remove-seat'){ await mgRemoveSeat(val); return; }
  if(act==='mg-restore-seat'){ await mgRestoreSeat(val); return; }
  if(act==='mg-eliminate-vote'){ await mgEliminateVote(val); return; }
  if(act==='mg-deal'){ await mgDealCards(); return; }
  if(act==='mg-finish-night'){ await mgFinishNight(); return; }
  if(act==='mg-next-round'){ await mgStartNextRound(); return; }
  if(act==='mg-spin'){ mgSpinWheel(); return; }

  if(act==='mg-timer-pick'){ timerChooseDuration(parseInt(val,10)); return; }
  if(act==='mg-timer-start'){ timerStart(); return; }
  if(act==='mg-timer-pause'){ timerPauseFreeze(); return; }
  if(act==='mg-timer-resume'){ timerResume(); return; }
  if(act==='mg-timer-reset'){ timerReset(); return; }

  if(act==='mg-pick-seat-join'){
    const nameInput = document.getElementById('mg-my-name');
    const name = nameInput ? nameInput.value.trim() : '';
    const codeInput = document.getElementById('mg-join-code');
    const code = codeInput ? codeInput.value.trim() : '';
    if(!name){ mg.error='اكتب اسمك أولاً.'; mgRender(); return; }
    await mgJoinSeat(code, val, name);
    return;
  }
  if(act==='mg-search-join-code'){
    const codeInput = document.getElementById('mg-join-code');
    const code = codeInput ? codeInput.value.trim() : '';
    if(!code){ mg.error='اكتب كود الطاولة.'; mgRender(); return; }
    const snap = await get(ref(db,'mainGames/'+code));
    const r = snap.val();
    if(!r){ mg.error='ما في طاولة بهاد الكود.'; mgRender(); return; }
    mg.error=''; mg._joinPreview = r; mg.roomCodeDraft = code;
    mgRender();
    return;
  }
  if(act==='mg-ack-role'){ mg.roleAcknowledged=true; mgRender(); return; }
  if(act==='mg-flip-card'){ mg.cardFlipped = !mg.cardFlipped; mgRender(); return; }
  if(act==='mg-silence-submit'){
    if(mgMyRole()!=='silencer') return;
    if(mgActions && mgActions.silencerDecided) return;
    await mgSubmitSilence(val);
    return;
  }
  if(act==='mg-assassin-submit'){
    if(mgMyRole()!=='assassin') return;
    if(mgActions && mgActions.assassinDecided) return;
    await mgSubmitAssassin(val);
    return;
  }
  if(act==='mg-protect-submit'){
    if(mgMyRole()!=='protector') return;
    if(mgActions && mgActions.protectorDecided) return;
    await mgSubmitProtect(val);
    return;
  }
  if(act==='mg-sheikh-submit'){
    if(mgActions && mgActions.sheikhAsked) return;
    await mgSubmitSheikh(val);
    return;
  }
  if(act==='mg-close-verdict'){ mg.pendingVerdict=null; mgRender(); return; }
  if(act==='mg-chat-send'){
    const box = document.getElementById('mg-chat-input');
    const text = (box?box.value:mgChatDraft).trim();
    if(!text) return;
    mgChatDraft='';
    await mgSendChat(text);
    mgRender();
    return;
  }
}

function mgResetLocal(){
  mgDetach();
  timerResetRoundLock();
  mg = { myId:null, myName:'', isHost:false, roomCode:null, view:'landing', error:'', selectedSeatId:null, cardFlipped:false, roleAcknowledged:false, pendingVerdict:null };
  mgRoom=null; mgActions=null; mgHistory={}; mgChat=[];
  mgClearSession();
  mgRender();
}

function mgMySeat(){
  if(!mgRoom) return null;
  return Object.entries(mgRoom.seats||{}).find(([id,s])=>s.playerId===mg.myId) || null;
}
function mgMyRole(){
  const found = mgMySeat();
  return found ? found[1].role : null;
}

/* ---------------- views ---------------- */
function mgBuildView(){
  if(!mg.roomCode){
    if(mg.view==='host-setup') return mgViewHostSetup();
    if(mg.view==='player-join') return mgViewPlayerJoin();
    return mgViewLanding();
  }
  if(mg.isHost) return mgViewHostFlow();
  return mgViewPlayerFlow();
}

function mgViewLanding(){
  return `
  <div class="card">
    <p class="eyebrow">طاولة المافيا</p>
    <h1>وحدة تحكم كاملة لجلسة الليلة</h1>
    <p class="desc">طاولة افتراضية بمقاعد اللاعبين، توزيع كروت، إنذارات، مؤقت، عجلة حظ، ونظام جولات كامل. للجولة السريعة بس (تسكيت وسؤال بدون طاولة)، فيك تفتح "إدارة جولة سريعة" من القائمة الجانبية.</p>
    <div class="btn-stack">
      <button class="btn btn-primary" data-act="mg-go-host-setup">أنا الحكم — أفتح طاولة جديدة</button>
      <button class="btn btn-ghost" data-act="mg-go-join">عندي كود، بدي أقعد عالطاولة</button>
    </div>
  </div>`;
}

function mgViewHostSetup(){
  return `
  <div class="card">
    <p class="eyebrow">إعداد الطاولة</p>
    <h1>رتّب المقاعد والأدوار</h1>
    ${mg.error?`<div class="err">${esc(mg.error)}</div>`:''}
    <div class="field">
      <label class="flabel">اسمك (كحكم)</label>
      <input type="text" id="mg-hostname" value="الحكم">
    </div>
    <div class="field">
      <label class="flabel">أسماء المقاعد — بترتيب جلوسهم الحقيقي، اسم بكل سطر</label>
      <textarea id="mg-seat-names" rows="6" placeholder="محمد&#10;سارة&#10;خالد&#10;لينا&#10;..." style="width:100%; background:rgba(0,0,0,.28); border:1px solid var(--line); color:var(--paper); font-family:'Almarai',sans-serif; font-size:15px; padding:12px; border-radius:10px; resize:vertical;"></textarea>
    </div>
    <div class="row">
      <div class="field"><label class="flabel">🔫 مافيا اغتيال</label><input type="number" id="mg-c-assassin" min="0" value="0"></div>
      <div class="field"><label class="flabel">🗡️ مافيا تسكيت</label><input type="number" id="mg-c-silencer" min="0" value="1"></div>
    </div>
    <div class="row">
      <div class="field"><label class="flabel">🛡️ الحامية</label><input type="number" id="mg-c-protector" min="0" value="1"></div>
      <div class="field"><label class="flabel">🕯️ الشيخ</label><input type="number" id="mg-c-sheikh" min="0" value="1"></div>
    </div>
    <p class="footer-note">الباقي بيصيروا مواطنين صالحين تلقائيًا. مافيا الاغتيال والحامية بيبلشوا فعليًا من الجولة الثانية.</p>
    <div class="btn-stack">
      <button class="btn btn-blood" data-act="mg-create-table">إنشاء الطاولة</button>
      <button class="btn btn-ghost" data-act="mg-go-home">رجوع</button>
    </div>
  </div>`;
}

function mgViewPlayerJoin(){
  const preview = mg._joinPreview;
  return `
  <div class="card">
    <p class="eyebrow">الانضمام للطاولة</p>
    <h1>لاقي مقعدك</h1>
    ${mg.error?`<div class="err">${esc(mg.error)}</div>`:''}
    <div class="field">
      <label class="flabel">اسمك</label>
      <input type="text" id="mg-my-name" placeholder="مثلاً: سارة">
    </div>
    <div class="field">
      <label class="flabel">كود الطاولة</label>
      <input type="text" id="mg-join-code" inputmode="numeric" maxlength="4" placeholder="مثلاً: 4821">
    </div>
    <div class="btn-stack" style="margin-bottom:16px;">
      <button class="btn btn-ghost" data-act="mg-search-join-code">دور على الطاولة</button>
    </div>
    ${preview? `
      <p class="flabel">اختار مقعدك من القائمة:</p>
      <div class="targets">
        ${Object.entries(preview.seats).sort((a,b)=>a[1].order-b[1].order).map(([id,s])=>`
          <div class="target-btn" data-act="${s.playerId?'':'mg-pick-seat-join'}" data-val="${id}" style="${s.playerId?'opacity:.4; pointer-events:none;':''}">
            <span class="avatar">${esc(mgInitials(s.name))}</span> ${esc(s.name)} ${s.playerId?'<span class="tag">(مأخوذ)</span>':''}
          </div>`).join('')}
      </div>
    ` : ''}
    <div class="btn-stack" style="margin-top:16px;">
      <button class="btn btn-ghost" data-act="mg-go-home">رجوع</button>
    </div>
  </div>`;
}

/* ---------------- host table ---------------- */
function mgSeatPositions(n){
  const pts = [];
  for(let i=0;i<n;i++){
    const angle = (i * (360/n)) - 90;
    const rad = angle * Math.PI/180;
    pts.push({ x: 50 + 42*Math.cos(rad), y: 50 + 40*Math.sin(rad) });
  }
  return pts;
}

function mgViewHostFlow(){
  if(!mgRoom) return `<div class="card"><p class="desc">جاري التحميل...</p><button class="btn btn-ghost" data-act="mg-go-home" style="margin-top:12px;">رجوع للرئيسية</button></div>`;
  return mgViewHostTable();
}

function mgViewHostTable(){
  const seatsArr = Object.entries(mgRoom.seats).sort((a,b)=>a[1].order-b[1].order);
  const positions = mgSeatPositions(seatsArr.length);
  const selected = mg.selectedSeatId ? mgRoom.seats[mg.selectedSeatId] : null;
  const a = mgActions || {};
  const activeCount = seatsArr.filter(([id,s])=>s.status==='active').length;
  const round = mgRoom.round||1;
  const phase = mgRoom.phase||'night';

  return `
  <div class="card">
    <p class="eyebrow">لوحة الحكم — كود ${esc(mgRoom.code)}</p>
    <h1>الجولة ${round} — ${phase==='night'?'ليل 🌙':'نهار ☀️'}</h1>

    <div class="oval-wrap">
      <div class="oval-table">
        ${seatsArr.map(([id,s],i)=>`
          <div class="seat ${s.status} ${mg.selectedSeatId===id?'selected':''} ${a.silencedSeatId===id?'is-silenced':''}"
               style="left:${positions[i].x}%; top:${positions[i].y}%;"
               data-act="mg-select-seat" data-val="${id}">
            <div class="seat-name">${esc(s.name)}</div>
            <div class="seat-warn">${'●'.repeat(s.warnings||0)}${'○'.repeat(3-(s.warnings||0))}</div>
          </div>`).join('')}
      </div>
    </div>

    ${selected? `
    <div class="seat-actions">
      <div class="seat-actions-title">${esc(selected.name)}</div>
      <div class="btn-row">
        <button class="btn btn-ghost" data-act="mg-warn" data-val="${mg.selectedSeatId}">⚠️ إنذار (${selected.warnings||0}/3)</button>
        ${selected.status==='active'?
          `<button class="btn btn-ghost" data-act="mg-remove-seat" data-val="${mg.selectedSeatId}">🚫 إزالة</button>`:
          `<button class="btn btn-ghost" data-act="mg-restore-seat" data-val="${mg.selectedSeatId}">↩️ استرجاع</button>`}
        ${phase==='day' && selected.status==='active' ?
          `<button class="btn btn-blood" data-act="mg-eliminate-vote" data-val="${mg.selectedSeatId}">🗳️ إقصاء (تصويت)</button>` : ''}
      </div>
    </div>` : `<p class="footer-note">دوس على أي مقعد لإدارته${phase==='day'?' أو لإقصائه بالتصويت':''}.</p>`}

    <hr class="div">
    <div class="team-list" style="margin-bottom:12px;">
      🔫 ${mgRoom.roleCounts.assassin} &nbsp;·&nbsp; 🗡️ ${mgRoom.roleCounts.silencer} &nbsp;·&nbsp; 🛡️ ${mgRoom.roleCounts.protector} &nbsp;·&nbsp; 🕯️ ${mgRoom.roleCounts.sheikh} &nbsp;·&nbsp; 👤 ${activeCount - mgRoom.roleCounts.assassin - mgRoom.roleCounts.silencer - mgRoom.roleCounts.protector - mgRoom.roleCounts.sheikh}
    </div>
    <button class="btn btn-primary" data-act="mg-deal" style="margin-bottom:10px;">${mgRoom.dealt?'إعادة توزيع الكروت 🔄 (يبدأ الجولة من ١)':'توزيع الكروت 🎴'}</button>

    ${mgRoom.dealt && phase==='night' ? mgHostNightPanel(round, a) : ''}
    ${mgRoom.dealt && phase==='day' ? mgHostDayPanel(round) : ''}

    <hr class="div">
    ${mgTimerPanel()}
    <hr class="div">
    ${mgWheelPanel(seatsArr)}
  </div>
  ${timerFrozen? `
    <div class="freeze-overlay">
      <div class="freeze-msg">⏸️ الوقت متوقف</div>
      <button class="btn btn-primary" data-act="mg-timer-resume" style="width:auto; padding:12px 28px; margin-top:16px;">▶️ استئناف</button>
    </div>` : ''}`;
}

function mgHostNightPanel(round, a){
  return `
    <hr class="div">
    <p class="flabel">تقدّم الليل — الجولة ${round}</p>
    <div class="progress-line"><span>قرار المافيا (تسكيت)</span><span>${a.silencerDecided?'تم':'بالانتظار'}</span></div>
    <div class="bar-track"><div class="bar-fill" style="width:${a.silencerDecided?100:0}%"></div></div>
    <div class="progress-line"><span>سؤال الشيخ</span><span>${a.sheikhAsked?'تم':'بالانتظار'}</span></div>
    <div class="bar-track"><div class="bar-fill" style="width:${a.sheikhAsked?100:0}%"></div></div>
    ${round>=2? `
    <div class="progress-line"><span>قرار المافيا (اغتيال)</span><span>${a.assassinDecided?'تم':'بالانتظار'}</span></div>
    <div class="bar-track"><div class="bar-fill" style="width:${a.assassinDecided?100:0}%"></div></div>
    <div class="progress-line"><span>قرار الحامية</span><span>${a.protectorDecided?'تم':'بالانتظار'}</span></div>
    <div class="bar-track"><div class="bar-fill" style="width:${a.protectorDecided?100:0}%"></div></div>
    ` : ''}
    <button class="btn btn-blood" data-act="mg-finish-night" style="margin-top:10px;">كشف نتيجة الليلة للجميع</button>
    ${mgHistory[round]? mgResultBannerHtml(mgHistory[round]) : ''}
  `;
}

function mgHostDayPanel(round){
  const prev = mgHistory[round];
  return `
    <hr class="div">
    <p class="flabel">النهار — تقرير الليلة</p>
    ${prev? mgResultBannerHtml(prev) : ''}
    <p class="footer-note">دوس على أي مقعد فوق واضغط "إقصاء (تصويت)" لما الجماعة يتفقوا مين طلع بالتصويت.</p>
    <button class="btn btn-primary" data-act="mg-next-round" style="margin-top:10px;">ابدأ الجولة القادمة ▶️</button>
  `;
}

function mgResultBannerHtml(r){
  const isMafia = r.sheikhVerdict==='مافيا';
  const lines = [];
  lines.push(`🤐 ${r.silencedName? esc(r.silencedName)+' تسكّت' : 'محدا تسكّت'}`);
  lines.push(r.sheikhAsked? (isMafia? '🗡️ الشيخ سأل عن رجل مافيا' : '🕊️ الشيخ سأل عن رجل صالح') : '🕯️ الشيخ ما سأل');
  if(r.protectorActed){
    lines.push(r.protectorCorrect? '🛡️ البنت حمت صح ✅' : '🛡️ البنت حمت غلط ❌');
  }
  if(r.assassinActed){
    lines.push(r.killedName? `🔫 ${esc(r.killedName)} تم اغتياله` : '🔫 محدا انغتال (تم الإنقاذ)');
  }
  return `<div class="team-list" style="margin-top:12px; border-color:rgba(156,36,48,.3); line-height:2;">${lines.join('<br>')}</div>`;
}

function mgTimerPanel(){
  const round = mgRoom ? (mgRoom.round||1) : 1;
  const locked = timerLockedRound === round;
  return `
  <p class="flabel">⏱️ مؤقت الجولة</p>
  ${!locked? `
    <p class="footer-note" style="margin-top:0;">اختار مدة هالجولة (تتقفل بعد الاختيار):</p>
    <div class="btn-row">
      <button class="btn btn-ghost" data-act="mg-timer-pick" data-val="45">45 ثانية</button>
      <button class="btn btn-ghost" data-act="mg-timer-pick" data-val="60">دقيقة</button>
      <button class="btn btn-ghost" data-act="mg-timer-pick" data-val="90">دقيقة ونص</button>
    </div>
  ` : `
    <div style="text-align:center; font-family:'Tajawal',sans-serif; font-weight:900; font-size:40px; color:var(--brass); margin:8px 0;" id="mg-timer-display">${fmtTime(timerRemaining)}</div>
    <div class="btn-row">
      ${!timerRunning && !timerFrozen? `<button class="btn btn-primary" data-act="mg-timer-start">▶️ ابدأ</button>`:''}
      ${timerRunning? `<button class="btn btn-blood" data-act="mg-timer-pause">⏸️ تجميد</button>`:''}
      ${timerFrozen? `<button class="btn btn-primary" data-act="mg-timer-resume">▶️ استئناف</button>`:''}
      <button class="btn btn-ghost" data-act="mg-timer-reset">🔄 تصفير</button>
    </div>
  `}`;
}

function mgWheelPanel(seatsArr){
  const active = seatsArr.filter(([id,s])=>s.status==='active');
  const sliceAngle = 360/Math.max(active.length,1);
  return `
  <p class="flabel">🎡 عجلة الحظ — مين يبدأ الحكي</p>
  <div class="wheel-wrap">
    <div class="wheel-pointer">▼</div>
    <div class="wheel-disc" id="mg-wheel-disc" style="background: conic-gradient(${active.map((s,i)=> (i%2===0?'#9c2430':'#161211') + ' ' + (i*sliceAngle)+'deg ' + ((i+1)*sliceAngle)+'deg').join(',')});">
      ${active.map((s,i)=>{
        const mid = (i*sliceAngle)+(sliceAngle/2);
        return `<span class="wheel-label" style="transform: rotate(${mid}deg) translateY(-78px) rotate(${-mid}deg);">${esc(s[1].name)}</span>`;
      }).join('')}
    </div>
  </div>
  <button class="btn btn-primary" data-act="mg-spin" style="margin-top:10px;">${wheelSpinning?'عم تدور...':'أدر العجلة'}</button>
  ${wheelResultName? `<div class="reveal-badge badge-blood" style="margin-top:12px; display:block; text-align:center;">🎙️ ${esc(wheelResultName)} بيبدأ الحكي!</div>` : ''}`;
}

/* ---------------- player table ---------------- */
function mgRoundTag(){
  if(!mgRoom) return '';
  return `<div style="text-align:center; color:var(--brass-dim); font-size:12px; margin-bottom:8px; letter-spacing:.5px;">🌒 الجولة ${mgRoom.round||1}</div>`;
}

function mgMafiaChatPanel(){
  return `
    <hr class="div">
    <div class="mafia-chat">
      <div class="chat-title">🗡️ نقاش سرّي بين المافيا (اغتيال + تسكيت)</div>
      <div class="chat-messages" id="mg-chat-scroll">
        ${mgChat.length===0? `<div class="chat-empty">ابدأوا الحكي، محدا غيركم شايف هالمكان 🤫</div>`:''}
        ${mgChat.map(m=>`
          <div class="chat-bubble ${m.senderId===mg.myId?'me':''}">
            <span class="chat-sender">${esc(m.senderName)}</span>
            <span class="chat-text">${esc(m.text)}</span>
          </div>`).join('')}
      </div>
      <div class="chat-input-row">
        <input type="text" id="mg-chat-input" placeholder="اكتب رسالة لرفاقك بالمافيا..." value="${esc(mgChatDraft)}">
        <button class="btn btn-primary chat-send" data-act="mg-chat-send">↑</button>
      </div>
    </div>`;
}

function mgViewPlayerFlow(){
  return mgRoundTag() + mgViewPlayerTableInner();
}

function mgViewPlayerTableInner(){
  if(!mgRoom) return `<div class="card"><p class="desc">جاري التحميل...</p><button class="btn btn-ghost" data-act="mg-go-home" style="margin-top:12px;">رجوع للرئيسية</button></div>`;
  const found = mgMySeat();
  if(!found) return `<div class="card"><p class="desc">جاري ربط مقعدك...</p></div>`;
  const [seatId, seat] = found;
  const round = mgRoom.round||1;

  if(seat.status==='removed'){
    return `
    <div class="card">
      <p class="eyebrow">طُردت من الطاولة</p>
      <h1>وصلت لـ ٣ إنذارات أو تم إقصاؤك بالتصويت</h1>
      <p class="desc">خرجت من هالجولة. تقدر تتفرج على الباقي مع رفاقك.</p>
    </div>`;
  }

  if(!mgRoom.dealt){
    return `
    <div class="card">
      <p class="eyebrow">${esc(seat.name)}</p>
      <h1>بانتظار الحكم يوزّع الكروت</h1>
      <div class="spotlight-scene"><div class="eye"></div></div>
    </div>`;
  }

  if(!mg.cardFlipped){
    return `
    <div class="card">
      <p class="eyebrow">${esc(seat.name)}</p>
      <h1>كرتك جاهزة</h1>
      <p class="desc">دوس على الكرت لتشوف دورك بسرّية، ودوسه مرة تانية لتخفيه.</p>
      <div class="flip-card" data-act="mg-flip-card">
        <div class="flip-card-inner">
          <div class="flip-face flip-back">🂠</div>
        </div>
      </div>
    </div>`;
  }

  const meta = MG_ROLE_META[seat.role] || MG_ROLE_META.citizen;
  if(!mg.roleAcknowledged){
    return `
    <div class="card">
      <p class="eyebrow">${esc(seat.name)}</p>
      <h1>دورك الليلة</h1>
      <div class="flip-card flipped" data-act="mg-flip-card">
        <div class="flip-card-inner">
          <div class="flip-face flip-front" style="--role-color:${meta.color};">
            <div class="role-icon" style="font-size:34px;">${meta.icon}</div>
            <div class="role-name">${meta.label}</div>
          </div>
        </div>
      </div>
      <div class="btn-stack" style="margin-top:16px;">
        <button class="btn btn-primary" data-act="mg-ack-role">فهمت، أخفي الكرت وكمّل</button>
      </div>
    </div>`;
  }

  // مافيا (تسكيت أو اغتيال) — شات مشترك، قرارات منفصلة
  if(seat.role==='silencer' || seat.role==='assassin'){
    const isSilencer = seat.role==='silencer';
    const canActThisRound = isSilencer || round>=2;
    const decided = isSilencer ? (mgActions && mgActions.silencerDecided) : (mgActions && mgActions.assassinDecided);
    const chatPanel = mgMafiaChatPanel();

    if(!canActThisRound){
      return `
      <div class="card">
        <p class="eyebrow">${meta.label}</p>
        <h1>ما إلك فعل هالجولة بعد</h1>
        <p class="desc">دورك بيبلش فعليًا من الجولة الثانية. هلق بس تقدر تتناقش مع رفيقك بالمافيا.</p>
        ${chatPanel}
      </div>`;
    }
    if(decided){
      return `
      <div class="card">
        <p class="eyebrow">${meta.label}</p>
        <h1>قررت لهالليلة</h1>
        <p class="desc">استنى الباقي، وفيك تكمّل تتناقش مع رفيقك.</p>
        ${chatPanel}
      </div>`;
    }
    const others = Object.entries(mgRoom.seats).filter(([id,s])=> s.status==='active' && !MG_MAFIA_ROLES.includes(s.role) && id!==seatId);
    const act = isSilencer ? 'mg-silence-submit' : 'mg-assassin-submit';
    return `
    <div class="card">
      <p class="eyebrow">${meta.label}</p>
      <h1>مين بدك ${isSilencer?'تسكّت':'تغتال'} الليلة؟</h1>
      <p class="desc">اختيارك نهائي، بيقفل فورًا.</p>
      <div class="targets">
        ${others.map(([id,s])=>`<div class="target-btn" data-act="${act}" data-val="${id}"><span class="avatar">${esc(mgInitials(s.name))}</span> ${esc(s.name)}</div>`).join('')}
      </div>
      ${chatPanel}
    </div>`;
  }

  // الحامية
  if(seat.role==='protector'){
    if(round < 2) return mgWaitingScreen(round);
    const decided = mgActions && mgActions.protectorDecided;
    if(decided) return mgWaitingScreen(round);
    const others = Object.entries(mgRoom.seats).filter(([id,s])=> s.status==='active');
    return `
    <div class="card">
      <p class="eyebrow">الحامية</p>
      <h1>مين بدك تحمي الليلة؟</h1>
      <p class="desc">اختيارك نهائي، بيقفل فورًا.</p>
      <div class="targets">
        ${others.map(([id,s])=>`<div class="target-btn" data-act="mg-protect-submit" data-val="${id}"><span class="avatar">${esc(mgInitials(s.name))}</span> ${esc(s.name)}</div>`).join('')}
      </div>
    </div>`;
  }

  // الشيخ
  if(seat.role==='sheikh'){
    const asked = mgActions && mgActions.sheikhAsked;
    if(mg.pendingVerdict){
      const isMafia = mg.pendingVerdict.verdict==='مافيا';
      return `
      <div class="modal-back">
        <div class="verdict-card">
          <div class="verdict-icon">${isMafia?'🗡️':'🕊️'}</div>
          <div class="verdict-title" style="color:${isMafia?'#e17b84':'#7fc9a0'}">${isMafia?'مافيا!':'بريء'}</div>
          <div class="verdict-sub">خلي هالمعلومة بسرّك.</div>
          <button class="btn btn-primary" data-act="mg-close-verdict">فهمت</button>
        </div>
      </div>
      <div class="card"><p class="desc">جاري كشف الحقيقة سرّاً...</p></div>`;
    }
    if(asked) return mgWaitingScreen(round);
    const others = Object.entries(mgRoom.seats).filter(([id,s])=> s.status==='active' && id!==seatId);
    return `
    <div class="card">
      <p class="eyebrow">الشيخ</p>
      <h1>عن مين بدك تسأل؟</h1>
      <p class="desc">سؤال واحد بس هالليلة.</p>
      <div class="targets">
        ${others.map(([id,s])=>`<div class="target-btn" data-act="mg-sheikh-submit" data-val="${id}"><span class="avatar">${esc(mgInitials(s.name))}</span> ${esc(s.name)}</div>`).join('')}
      </div>
    </div>`;
  }

  return mgWaitingScreen(round);
}

function mgWaitingScreen(round){
  const currentResult = mgHistory[round];
  if(currentResult){
    return `
    <div class="card">
      <p class="eyebrow">كشف نتيجة الليلة</p>
      <h1>الصباح وصل...</h1>
      ${mgResultBannerHtml(currentResult)}
      <p class="hint" style="margin-top:14px;">استنوا الحكم يكمّل اللعبة.</p>
    </div>`;
  }
  const prevResult = round>1 ? mgHistory[round-1] : null;
  return `
  <div class="card">
    <p class="eyebrow">انتظار</p>
    <h1>الليل مستمر... خلّي عينيك مسكرة</h1>
    <div class="spotlight-scene">
      <div style="text-align:center;">
        <div class="eye"></div>
        <div class="dots"><span></span><span></span><span></span></div>
      </div>
    </div>
    <p class="desc" style="text-align:center;">خلصت جزئيتك. استنى الحكم.</p>
    ${prevResult? `<hr class="div"><p class="flabel">تقرير الجولة ${round-1}</p>${mgResultBannerHtml(prevResult)}` : ''}
  </div>`;
}

mgTryRestoreSession();
mgRender();
