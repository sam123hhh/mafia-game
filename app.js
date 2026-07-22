// ==========================================================================
// ليلة المافيا — منطق اللعبة، مربوط بقاعدة بيانات Firebase Realtime Database
// ==========================================================================

import {
  ref, set, update, get, onValue, off, remove, push
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";
import { db } from "./firebase-init.js";

/* ---------------- helpers ---------------- */
function uid(){ return 'p_' + Math.random().toString(36).slice(2,10); }
function genCode(){ return String(Math.floor(1000 + Math.random()*9000)); }
function initials(name){ return (name||'?').trim().slice(0,1).toUpperCase(); }
function esc(s){ const d=document.createElement('div'); d.innerText = s==null?'':s; return d.innerHTML; }

/* ---------------- إشارة اهتزاز/صوت لكل الأجهزة (بديل عن كلام الحكم وقت العيون المغمضة) ---------------- */
let audioCtx = null;
function ensureAudio(){
  try{
    if(!audioCtx){ audioCtx = new (window.AudioContext||window.webkitAudioContext)(); }
    else if(audioCtx.state === 'suspended'){ audioCtx.resume(); }
  }catch(e){ /* المتصفح ما بيدعم، ولا مشكلة */ }
}
function fireCue(){
  try{ if(navigator.vibrate){ navigator.vibrate([160]); } }catch(e){}
  try{
    if(audioCtx){
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 540;
      gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.22, audioCtx.currentTime+0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime+0.4);
      osc.connect(gain); gain.connect(audioCtx.destination);
      osc.start(); osc.stop(audioCtx.currentTime+0.42);
    }
  }catch(e){}
}

const ROLE_META = {
  mafia:          { label:'مافيا (صاحب القرار)', icon:'🗡️', color:'#e17b84', glow:'rgba(156,36,48,.45)' },
  mafia_teammate: { label:'مافيا (نقاش فقط)',    icon:'🤐', color:'#e17b84', glow:'rgba(156,36,48,.45)' },
  sheikh:    { label:'الشيخ',   icon:'🕯️', color:'#c9a24b', glow:'rgba(201,162,75,.4)' },
  protector: { label:'الحامية', icon:'🛡️', color:'#7fc9a0', glow:'rgba(63,125,92,.4)' },
  citizen:   { label:'مواطن صالح', icon:'👤', color:'#c9a24b', glow:'rgba(201,162,75,.3)' },
};

/* ---------------- runtime state (in-memory only) ---------------- */
let S = {
  myId: null,
  myName: '',
  roomCode: null,
  isHost: false,
  view: 'home',
  roleAcknowledged: false,
  sheikhResultAck: false,
  pendingVerdict: null,
  error: '',
};

let room = null, actions = null, result = null;
let mafiaChat = [];
let joinSelectedRole = null;
let sheikhSearchError = '';
let sheikhTargetDraft = '';
let chatDraft = '';

let unsubRoom = null, unsubActions = null, unsubResult = null, unsubChat = null;

/* ---------------- Firebase live listeners (replaces polling) ---------------- */
let prevMafiaDecided = false, prevSheikhSubmitted = false;

function attachListeners(code){
  detachListeners();
  prevMafiaDecided = false;
  prevSheikhSubmitted = false;
  const roomRef = ref(db, 'rooms/'+code);
  const actionsRef = ref(db, 'actions/'+code);
  const resultRef = ref(db, 'result/'+code);
  const chatRef = ref(db, 'mafiaChat/'+code);

  unsubRoom = onValue(roomRef, snap=>{
    const val = snap.val();
    room = normalizeRoom(val);
    render();
  });
  unsubActions = onValue(actionsRef, snap=>{
    const newActions = snap.val() || {mafiaVotes:{}, mafiaDecided:false, sheikhTarget:null, sheikhVerdict:null, sheikhSubmitted:false};
    if(newActions.mafiaDecided && !prevMafiaDecided){ fireCue(); }
    if(newActions.sheikhSubmitted && !prevSheikhSubmitted){ fireCue(); }
    prevMafiaDecided = !!newActions.mafiaDecided;
    prevSheikhSubmitted = !!newActions.sheikhSubmitted;
    actions = newActions;
    render();
  });
  unsubResult = onValue(resultRef, snap=>{
    result = snap.val();
    render();
  });
  unsubChat = onValue(chatRef, snap=>{
    const val = snap.val() || {};
    mafiaChat = Object.values(val).sort((a,b)=>a.ts-b.ts);
    render();
  });
}
function detachListeners(){
  if(unsubRoom){ off(ref(db,'rooms/'+S.roomCode)); unsubRoom=null; }
  if(unsubActions){ off(ref(db,'actions/'+S.roomCode)); unsubActions=null; }
  if(unsubResult){ off(ref(db,'result/'+S.roomCode)); unsubResult=null; }
  if(unsubChat){ off(ref(db,'mafiaChat/'+S.roomCode)); unsubChat=null; }
}

// Firebase stores players as an object keyed by id; we turn that into an array for easy rendering.
function normalizeRoom(val){
  if(!val) return null;
  const playersObj = val.players || {};
  const playersArr = Object.entries(playersObj).map(([id, p]) => ({ id, ...p }));
  return { ...val, players: playersArr };
}

/* ---------------- actions (all writes go straight to Firebase) ---------------- */
function qtSaveSession(){
  try{ localStorage.setItem('qt_session', JSON.stringify({roomCode:S.roomCode, myId:S.myId, myName:S.myName, isHost:S.isHost})); }catch(e){}
}
function qtClearSession(){
  try{ localStorage.removeItem('qt_session'); }catch(e){}
}
function qtTryRestoreSession(){
  try{
    const raw = localStorage.getItem('qt_session');
    if(!raw) return;
    const s = JSON.parse(raw);
    if(s && s.roomCode && s.myId){
      S.roomCode = s.roomCode; S.myId = s.myId; S.myName = s.myName||''; S.isHost = !!s.isHost;
      attachListeners(s.roomCode);
    }
  }catch(e){}
}

async function createRoom(hostName){
  S.myId = uid();
  S.myName = hostName || 'الحكم';
  S.isHost = true;
  const code = genCode();
  await set(ref(db, 'rooms/'+code), {
    code,
    phase: 'lobby',
    hostId: S.myId,
    createdAt: Date.now(),
    players: {}
  });
  S.roomCode = code;
  S.view = 'host-lobby';
  attachListeners(code);
  qtSaveSession();
}

async function joinRoom(code, name, role){
  code = code.trim();
  S.error = '';
  const snap = await get(ref(db, 'rooms/'+code));
  const r = normalizeRoom(snap.val());
  if(!r){ S.error = 'ما في غرفة بهاد الكود. تأكد من الرقم.'; render(); return; }
  if(r.phase !== 'lobby'){ S.error = 'اللعبة بدأت أو خلصت، اطلب من الحكم غرفة جديدة.'; render(); return; }
  const cleanName = name.trim();
  if(r.players.some(p=>p.name.trim().toLowerCase()===cleanName.toLowerCase())){
    S.error = 'في حدا فوت بنفس الاسم قبلك، ضيف حرف يميّزك (مثلاً: محمد٢).';
    render(); return;
  }
  const myId = uid();
  // writing to our own unique key — safe even if many people join at the same instant
  await set(ref(db, `rooms/${code}/players/${myId}`), { name: cleanName || 'لاعب', role, isHost:false });
  S.myId = myId;
  S.myName = cleanName || 'لاعب';
  S.isHost = false;
  S.roomCode = code;
  S.view = 'player-lobby';
  attachListeners(code);
  qtSaveSession();
}

async function startGame(){
  if(!room) return;
  if(room.players.length < 2){
    S.error = 'لازم لاعبَين على الأقل ينضموا قبل ما تبدأ.';
    render(); return;
  }
  const mafiaCount = room.players.filter(p=>p.role==='mafia').length;
  if(mafiaCount < 1){
    S.error = 'ولا حدا كتب إنو هو مافيا. تأكدوا كل واحد دخل هويته الصح من كرته.';
    render(); return;
  }
  S.error = '';
  await set(ref(db, 'actions/'+room.code), { mafiaVotes:{}, mafiaDecided:false, sheikhTarget:null, sheikhVerdict:null, sheikhSubmitted:false });
  await update(ref(db, 'rooms/'+room.code), { phase: 'night' });
}

async function submitMafiaVote(targetId){
  // قرار واحد نهائي: نكتب الاختيار ونقفل الليل على المافيا بنفس اللحظة
  await update(ref(db, `actions/${S.roomCode}`), {
    [`mafiaVotes/${S.myId}`]: targetId,
    mafiaDecided: true
  });
}

async function submitSheikhTarget(targetId){
  const targetPlayer = room.players.find(p=>p.id===targetId);
  const isMafia = targetPlayer && targetPlayer.role === 'mafia';
  const verdict = isMafia ? 'مافيا' : 'بريء';
  await update(ref(db, `actions/${S.roomCode}`), {
    sheikhTarget: targetId,
    sheikhVerdict: verdict,
    sheikhSubmitted: true
  });
  S.pendingVerdict = { name: targetPlayer ? targetPlayer.name : '؟', verdict };
  render();
}

function tally(mafiaVotes){
  const counts = {};
  Object.values(mafiaVotes||{}).forEach(t=>{ counts[t] = (counts[t]||0)+1; });
  let best=null, bestCount=-1;
  Object.entries(mafiaVotes||{}).forEach(([voter, target])=>{
    if(counts[target] > bestCount){ best = target; bestCount = counts[target]; }
  });
  return best;
}

async function finishNight(){
  const snap = await get(ref(db, 'actions/'+room.code));
  const a = snap.val() || {mafiaVotes:{}, sheikhTarget:null, sheikhVerdict:null};
  const silencedId = tally(a.mafiaVotes);
  const silencedName = silencedId ? (room.players.find(p=>p.id===silencedId)||{}).name : null;
  const res = {
    silencedId: silencedId || null,
    silencedName: silencedName || null,
    // عمدًا ما منخزّن اسم الشخص يلي سأل عنه الشيخ ولا اسم الشيخ — بس النتيجة العامة
    sheikhAsked: !!a.sheikhTarget,
    sheikhVerdict: a.sheikhVerdict || null,
    computedAt: Date.now()
  };
  await set(ref(db, 'result/'+room.code), res);
  await update(ref(db, 'rooms/'+room.code), { phase: 'reveal' });
}

async function endRound(){
  await update(ref(db, 'rooms/'+room.code), { phase: 'end' });
}

// كل رسالة إلها مفتاح فريد (push) عشان ما تصير رسالتين تكتبان بنفس اللحظة تلغي بعض
async function sendMafiaChat(text){
  const msgRef = push(ref(db, 'mafiaChat/'+S.roomCode));
  await set(msgRef, { senderId: S.myId, senderName: S.myName, text, ts: Date.now() });
}

// host-only: wipes the whole room from the database (تنظيف بعد ما تخلص اللعبة)
async function deleteRoom(code){
  await remove(ref(db, 'rooms/'+code));
  await remove(ref(db, 'actions/'+code));
  await remove(ref(db, 'result/'+code));
  await remove(ref(db, 'mafiaChat/'+code));
}

function resetLocal(){
  detachListeners();
  S = { myId:null, myName:'', roomCode:null, isHost:false, view:'home', roleAcknowledged:false, sheikhResultAck:false, pendingVerdict:null, error:'' };
  room=null; actions=null; result=null; mafiaChat=[]; chatDraft='';
  qtClearSession();
  render();
}

/* ---------------- render ---------------- */
function render(){
  const app = document.getElementById('quickToolApp');
  if(!app) return; // اللوحة مسكرة/مش موجودة بالـ DOM هلق
  app.innerHTML = buildView();
  wireEvents();
}

function wireEvents(){
  const scope = document.getElementById('quickToolApp');
  if(!scope) return;
  scope.querySelectorAll('[data-act]').forEach(el=>{
    el.onclick = async (e)=>{
      ensureAudio(); // لازم إذن المستخدم قبل ما نقدر نشغّل صوت لاحقًا
      const act = el.getAttribute('data-act');
      const val = el.getAttribute('data-val');
      await handleAction(act, val, el);
    };
  });
  const sheikhInput = scope.querySelector('#inp-sheikh-target');
  if(sheikhInput){
    sheikhInput.oninput = (e)=>{ sheikhTargetDraft = e.target.value; };
    sheikhInput.onkeydown = (e)=>{ if(e.key==='Enter'){ ensureAudio(); handleAction('sheikh-submit', null); } };
  }
  const chatInput = scope.querySelector('#inp-chat');
  if(chatInput){
    chatInput.oninput = (e)=>{ chatDraft = e.target.value; };
    chatInput.onkeydown = (e)=>{ if(e.key==='Enter'){ ensureAudio(); handleAction('chat-send', null); } };
  }
  const chatScroll = scope.querySelector('#chat-scroll');
  if(chatScroll){ chatScroll.scrollTop = chatScroll.scrollHeight; }
}

async function handleAction(act, val, el){
  if(act==='go-host-setup'){ S.view='host-setup'; render(); return; }
  if(act==='go-join'){ S.view='join'; S.error=''; joinSelectedRole=null; render(); return; }
  if(act==='go-home'){ resetLocal(); return; }

  if(act==='create-room'){
    const hostName = document.getElementById('inp-hostname').value || 'الحكم';
    await createRoom(hostName);
    return;
  }
  if(act==='pick-role'){ joinSelectedRole = val; render(); return; }
  if(act==='join-room'){
    const code = document.getElementById('inp-code').value;
    const name = document.getElementById('inp-name').value;
    if(!name.trim()){ S.error='اكتب اسمك أولاً.'; render(); return; }
    if(!code.trim()){ S.error='اكتب كود الغرفة.'; render(); return; }
    if(!joinSelectedRole){ S.error='اختار الهوية المكتوبة على كرتك.'; render(); return; }
    await joinRoom(code, name, joinSelectedRole);
    return;
  }
  if(act==='start-game'){ await startGame(); return; }
  if(act==='ack-role'){ S.roleAcknowledged = true; render(); return; }
  if(act==='mafia-vote'){
    if(myRole()!=='mafia') return; // بس صاحب القرار يقدر يسكت
    if(actions && actions.mafiaDecided) return; // قرار واحد نهائي
    await submitMafiaVote(val);
    return;
  }
  if(act==='chat-send'){
    const box = document.getElementById('inp-chat');
    const text = (box ? box.value : chatDraft).trim();
    if(!text) return;
    chatDraft = '';
    await sendMafiaChat(text);
    render();
    return;
  }
  if(act==='sheikh-submit'){
    if(actions && actions.sheikhSubmitted){ return; } // قفل نهائي: سؤال واحد بس بالليلة
    const raw = document.getElementById('inp-sheikh-target').value.trim();
    sheikhSearchError = '';
    if(!raw){ sheikhSearchError = 'اكتب اسم الشخص أولاً.'; render(); return; }
    const match = room.players.find(p => p.id!==S.myId && p.name.trim().toLowerCase()===raw.toLowerCase());
    if(!match){ sheikhSearchError = 'ما لقيت هيك اسم بالغرفة، تأكد تكتبه بالضبط متل ما سجّله.'; render(); return; }
    await submitSheikhTarget(match.id);
    return;
  }
  if(act==='close-verdict'){ S.pendingVerdict=null; S.sheikhResultAck=true; sheikhTargetDraft=''; render(); return; }
  if(act==='finish-night'){ await finishNight(); S.roleAcknowledged=false; S.sheikhResultAck=false; return; }
  if(act==='end-round'){ await endRound(); return; }
  if(act==='new-game'){
    if(S.isHost && room){ await deleteRoom(room.code); }
    resetLocal();
    return;
  }
}

function myRole(){
  if(!room) return null;
  const me = room.players.find(p=>p.id===S.myId);
  return me ? me.role : null;
}

function buildView(){
  if(!S.roomCode){
    if(S.view==='host-setup') return viewHostSetup();
    if(S.view==='join') return viewJoin();
    return viewHome();
  }
  if(S.isHost) return viewHostFlow();
  return viewPlayerFlow();
}

/* ---------------- HOME / SETUP / JOIN ---------------- */
function viewHome(){
  return `
  <div class="card">
    <p class="eyebrow">ملف القضية</p>
    <h1>مين رح يقود الجولة الأولى الليلة؟</h1>
    <p class="desc">إذا ما في حدا يقدر يقود اللعبة وأعينكم مغمضة، هاد الموقع بيسكّت المافيا ويسأل الشيخ نيابة عنكم، ويكشف النتيجة لكل الجوالات بنفس اللحظة.</p>
    <div class="btn-stack">
      <button class="btn btn-primary" data-act="go-host-setup">أنا الحكم — أفتح غرفة جديدة</button>
      <button class="btn btn-ghost" data-act="go-join">عندي كود، بدي أنضم كلاعب</button>
    </div>
    <p class="footer-note">ملاحظة: لا تحدّث الصفحة (Refresh) بعد ما تنضم، لأنك بتفقد مكانك باللعبة.</p>
  </div>`;
}

function viewHostSetup(){
  return `
  <div class="card">
    <p class="eyebrow">إعداد الغرفة</p>
    <h1>افتح غرفة الليلة</h1>
    <p class="desc">ما بتحتاج تحدد أدوار هون — كل واحد رح يكتب هويته الحقيقية من كرته لما ينضم.</p>
    ${S.error?`<div class="err">${esc(S.error)}</div>`:''}
    <div class="field">
      <label class="flabel">اسمك (كحكم)</label>
      <input type="text" id="inp-hostname" placeholder="مثلاً: أبو خالد" value="الحكم">
    </div>
    <div class="btn-stack">
      <button class="btn btn-primary" data-act="create-room">إنشاء الغرفة</button>
      <button class="btn btn-ghost" data-act="go-home">رجوع</button>
    </div>
  </div>`;
}

function viewJoin(){
  const roleOptions = [
    {key:'citizen',        label:'مواطن صالح',        icon:'👤'},
    {key:'mafia',          label:'مافيا (صاحب القرار)', icon:'🗡️'},
    {key:'mafia_teammate', label:'مافيا (نقاش فقط)',   icon:'🤐'},
    {key:'sheikh',         label:'الشيخ',              icon:'🕯️'},
    {key:'protector',      label:'الحامية',            icon:'🛡️'},
  ];
  return `
  <div class="card">
    <p class="eyebrow">الانضمام للغرفة</p>
    <h1>ادخل باسمك وكود الغرفة</h1>
    ${S.error?`<div class="err">${esc(S.error)}</div>`:''}
    <div class="field">
      <label class="flabel">اسمك</label>
      <input type="text" id="inp-name" placeholder="مثلاً: سارة" autofocus>
    </div>
    <div class="field">
      <label class="flabel">كود الغرفة</label>
      <input type="text" id="inp-code" inputmode="numeric" placeholder="مثلاً: 4821" maxlength="4">
    </div>
    <div class="field">
      <label class="flabel">شو المكتوب على كرتك؟ (اختار بصدق 🤫)</label>
      <div class="targets">
        ${roleOptions.map(r=>`
          <div class="target-btn ${joinSelectedRole===r.key?'selected':''}" data-act="pick-role" data-val="${r.key}">
            <span class="avatar">${r.icon}</span> ${r.label}
          </div>`).join('')}
      </div>
    </div>
    <div class="btn-stack">
      <button class="btn btn-primary" data-act="join-room">انضمام</button>
      <button class="btn btn-ghost" data-act="go-home">رجوع</button>
    </div>
    <p class="footer-note">لأمانة اللعبة: اختار نفس الدور المكتوب فعليًا على كرتك بالواقع.</p>
  </div>`;
}

/* ---------------- HOST FLOW ---------------- */
function viewHostFlow(){
  if(!room) return `<div class="card"><p class="desc">جاري التحميل...</p></div>`;
  if(room.phase==='lobby') return hostLobby();
  if(room.phase==='night') return hostNight();
  if(room.phase==='reveal') return revealScreen(true);
  if(room.phase==='end') return endScreen(true);
  return `<div class="card"><p class="desc">...</p></div>`;
}

function hostLobby(){
  const tallyObj = {mafia:0, mafia_teammate:0, sheikh:0, protector:0, citizen:0};
  room.players.forEach(p=>{ if(tallyObj[p.role]!==undefined) tallyObj[p.role]++; });
  const canStart = room.players.length >= 2 && tallyObj.mafia >= 1;
  return `
  <div class="card">
    <p class="eyebrow">غرفة الانتظار</p>
    <h1>شارك الكود مع أصحابك</h1>
    <div class="code-display">
      <div class="num">${esc(room.code)}</div>
      <div class="cap">كود الغرفة</div>
    </div>
    ${S.error?`<div class="err">${esc(S.error)}</div>`:''}
    <div class="count-badge">منضم الآن: ${room.players.length} لاعب</div>
    <ul class="plist">
      ${room.players.map(p=>`<li><span class="avatar">${esc(initials(p.name))}</span> ${esc(p.name)}</li>`).join('')}
    </ul>
    <p class="footer-note">عدد الأدوار رح يظهرلك دفعة وحدة بعد ما تدوس "ابدأ" — عشان محدا يقدر يخمّن دور حدا من ترتيب الانضمام.</p>
    <div class="btn-stack" style="margin-top:18px;">
      <button class="btn btn-blood" data-act="start-game" ${canStart?'':'disabled'}>ابدأ الليلة الأولى</button>
      <button class="btn btn-ghost" data-act="go-home">إلغاء الغرفة</button>
    </div>
  </div>`;
}

function hostNight(){
  const a = actions || {mafiaVotes:{}, mafiaDecided:false, sheikhSubmitted:false};
  const tallyObj = {mafia:0, mafia_teammate:0, sheikh:0, protector:0, citizen:0};
  room.players.forEach(p=>{ if(tallyObj[p.role]!==undefined) tallyObj[p.role]++; });
  const hasSheikh = tallyObj.sheikh > 0;
  const mafiaDone = a.mafiaDecided ? 1 : 0;
  const sheikhDone = hasSheikh ? (a.sheikhSubmitted?1:0) : null;
  return `
  <div class="card">
    <p class="eyebrow">مراقبة الحكم</p>
    <h1>الليل نازل على البلدة...</h1>
    <p class="desc">كل واحد شايف دوره هلق على جواله. صاحب قرار المافيا بيختار مين يسكّت، والشيخ بيسأل عن حدا. تقدر تنهي الليل بأي وقت.</p>

    <div class="team-list" style="margin-bottom:16px;">
      🗡️ مافيا (قرار): <b>${tallyObj.mafia}</b> &nbsp;·&nbsp; 🤐 مافيا (نقاش): <b>${tallyObj.mafia_teammate}</b> &nbsp;·&nbsp; 🕯️ شيخ: <b>${tallyObj.sheikh}</b> &nbsp;·&nbsp; 🛡️ حامية: <b>${tallyObj.protector}</b> &nbsp;·&nbsp; 👤 مواطنين: <b>${tallyObj.citizen}</b>
      <br><span style="font-size:12px;">(العدد النهائي بعد قفل الغرفة — للتأكد إنو مطابق للكروت الموزّعة)</span>
    </div>

    <div class="progress-line"><span>قرار المافيا</span><span>${mafiaDone? 'تم':'بالانتظار'}</span></div>
    <div class="bar-track"><div class="bar-fill" style="width:${mafiaDone?100:0}%"></div></div>

    ${hasSheikh ? `
    <div class="progress-line"><span>سؤال الشيخ</span><span>${sheikhDone? 'تم':'بالانتظار'}</span></div>
    <div class="bar-track"><div class="bar-fill" style="width:${sheikhDone?100:0}%"></div></div>
    ` : ''}

    <div class="btn-stack" style="margin-top:10px;">
      <button class="btn btn-blood" data-act="finish-night">إنهاء الليل وكشف النتيجة للجميع</button>
    </div>
    <p class="footer-note">ما تحتاج تستنى الكل — إذا اتأخر حدا فيك تكشف بأي لحظة.</p>
  </div>`;
}

/* ---------------- PLAYER FLOW ---------------- */
function viewPlayerFlow(){
  if(!room) return `<div class="card"><p class="desc">جاري التحميل...</p></div>`;
  if(room.phase==='lobby') return playerLobby();
  if(room.phase==='night') return playerNight();
  if(room.phase==='reveal') return revealScreen(false);
  if(room.phase==='end') return endScreen(false);
  return `<div class="card"><p class="desc">...</p></div>`;
}

function playerLobby(){
  return `
  <div class="card">
    <p class="eyebrow">غرفة الانتظار</p>
    <h1>وصلت! بانتظار باقي اللاعبين</h1>
    <div class="spotlight-scene"><div class="eye"></div></div>
    <div class="count-badge">داخل الغرفة: ${room.players.length} لاعب</div>
    <ul class="plist">
      ${room.players.map(p=>`<li><span class="avatar">${esc(initials(p.name))}</span> ${esc(p.name)} ${p.id===S.myId?'<span class="tag">(أنت)</span>':''}</li>`).join('')}
    </ul>
    <p class="footer-note">الحكم رح يبدأ اللعبة لما يجهز الجميع. خلّي الجوال قدامك.</p>
  </div>`;
}

// شاشة انتظار موحّدة 100%: أي حدا يخلص دوره (مافيا قررت، الشيخ سأل، مواطن أو حامية من البداية)
// بيوصل لنفس الشاشة بالضبط — بدون أي كلمة أو أيقونة تكشف الدور، حتى لو تبادلتوا التلفونات.
function waitingScreen(){
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
    <p class="desc" style="text-align:center;">خلصت جزئيتك. استنى الحكم يعلن نتيجة الليلة للجميع.</p>
  </div>`;
}

function playerNight(){
  const role = myRole();
  if(!role) return `<div class="card"><p class="desc">جاري التحميل...</p></div>`;

  if(!S.roleAcknowledged){
    const meta = ROLE_META[role];
    const isMafiaTeam = role==='mafia' || role==='mafia_teammate';
    const teammates = isMafiaTeam ? room.players.filter(p=> (p.role==='mafia'||p.role==='mafia_teammate') && p.id!==S.myId) : [];
    return `
    <div class="card">
      <p class="eyebrow">تأكيد الهوية</p>
      <h1>هاي هويتك يلي سجّلتها</h1>
      <div class="stamp-wrap">
        <div class="stamp" style="--role-color:${meta.color}; --role-glow:${meta.glow};">
          <div class="role-icon">${meta.icon}</div>
          <div class="role-name">${meta.label}</div>
        </div>
      </div>
      ${teammates.length? `<div class="team-list">رفاقك بالمافيا: <b>${teammates.map(t=>esc(t.name)).join('، ')}</b></div>` : ''}
      <div class="btn-stack" style="margin-top:18px;">
        <button class="btn btn-primary" data-act="ack-role">شفت دوري، أغمض عيوني الآن</button>
      </div>
    </div>`;
  }

  if(role==='mafia' || role==='mafia_teammate'){
    const isBoss = role==='mafia';
    const decided = actions && actions.mafiaDecided;
    // أول ما يتقرر القرار، الكل (صاحب القرار ورفاقه) بيوصلوا لنفس شاشة الانتظار الموحّدة
    if(decided) return waitingScreen();

    const chatPanel = `
      <hr class="div">
      <div class="mafia-chat">
        <div class="chat-title">🗡️ نقاش سرّي بين المافيا</div>
        <div class="chat-messages" id="chat-scroll">
          ${mafiaChat.length===0 ? `<div class="chat-empty">ابدأوا الحكي، محدا غيركم شايف هالمكان 🤫</div>` : ''}
          ${mafiaChat.map(m=>`
            <div class="chat-bubble ${m.senderId===S.myId?'me':''}">
              <span class="chat-sender">${esc(m.senderName)}</span>
              <span class="chat-text">${esc(m.text)}</span>
            </div>`).join('')}
        </div>
        <div class="chat-input-row">
          <input type="text" id="inp-chat" placeholder="اكتب رسالة لرفاقك بالمافيا..." value="${esc(chatDraft)}">
          <button class="btn btn-primary chat-send" data-act="chat-send">↑</button>
        </div>
      </div>`;

    if(isBoss){
      const others = room.players.filter(p=> p.role!=='mafia' && p.role!=='mafia_teammate');
      return `
      <div class="card">
        <p class="eyebrow">دور المافيا</p>
        <h1>مين بدك تسكّت الليلة؟</h1>
        <p class="desc">القرار إلك لحالك. اختار الشخص — انتبه، اختيارك نهائي وبيقفل فورًا.</p>
        <div class="targets">
          ${others.map(p=>`
            <div class="target-btn" data-act="mafia-vote" data-val="${p.id}">
              <span class="avatar">${esc(initials(p.name))}</span> ${esc(p.name)}
            </div>`).join('')}
        </div>
        ${chatPanel}
      </div>`;
    }

    // عضو مافيا للنقاش فقط — يشوف الشات، ما إله زر تسكيت خالص
    return `
    <div class="card">
      <p class="eyebrow">دور المافيا</p>
      <h1>ساعد رفيقك يقرر</h1>
      <p class="desc">أنت هون بس تتناقش — صاحب القرار غيرك رح يسكت لحاله ولما يقرر بتوصلك نفس شاشة الانتظار.</p>
      ${chatPanel}
    </div>`;
  }

  if(role==='sheikh'){
    const done = actions && actions.sheikhSubmitted;
    if(S.pendingVerdict){
      const isMafia = S.pendingVerdict.verdict==='مافيا';
      return `
      <div class="modal-back">
        <div class="verdict-card">
          <div class="verdict-icon">${isMafia?'🗡️':'🕊️'}</div>
          <div class="verdict-title" style="color:${isMafia?'#e17b84':'#7fc9a0'}">${esc(S.pendingVerdict.name)}: ${isMafia?'مافيا!':'بريء'}</div>
          <div class="verdict-sub">خلي هالمعلومة بسرّك... لحد وقتها.</div>
          <button class="btn btn-primary" data-act="close-verdict">فهمت، أغمض عيوني</button>
        </div>
      </div>
      <div class="card"><p class="desc">جاري كشف الحقيقة لك سرّاً...</p></div>`;
    }
    // مرة وحدة بس بالليلة: أول ما ينسأل، بيوصل لنفس شاشة الانتظار الموحّدة
    if(done) return waitingScreen();
    return `
    <div class="card">
      <p class="eyebrow">دور الشيخ</p>
      <h1>عن مين بدك تسأل؟</h1>
      <p class="desc">اكتب اسم الشخص متل ما سجّله بالضبط — انتبه، بتقدر تسأل مرة وحدة بس هالليلة.</p>
      ${sheikhSearchError?`<div class="err">${esc(sheikhSearchError)}</div>`:''}
      <div class="field">
        <label class="flabel">اسم الشخص</label>
        <input type="text" id="inp-sheikh-target" placeholder="مثلاً: محمد" value="${esc(sheikhTargetDraft)}">
      </div>
      <div class="btn-stack">
        <button class="btn btn-primary" data-act="sheikh-submit">اسأل عنه</button>
      </div>
    </div>`;
  }

  // مواطن صالح أو حامية: ما إلهم شي يعملوه، فعلى طول نفس شاشة الانتظار الموحّدة
  return waitingScreen();
}

/* ---------------- REVEAL & END ---------------- */
function revealScreen(isHostView){
  if(!result) return `<div class="card"><p class="desc">جاري حساب النتيجة...</p></div>`;
  const silenced = result.silencedName;
  const hasSheikh = room.players.some(p=>p.role==='sheikh');
  const sheikhAsked = !!result.sheikhAsked;
  const isMafia = result.sheikhVerdict==='مافيا';
  return `
  <div class="card">
    <p class="eyebrow">كشف نتيجة الليلة</p>
    <h1>الصباح وصل...</h1>

    <div class="reveal-block d1">
      <div class="reveal-label">تم تسكيته الليلة</div>
      ${silenced?
        `<div class="reveal-name">${esc(silenced)}</div><div class="reveal-badge badge-blood">🤐 مُسكَّت</div>`
        : `<div class="reveal-name">لا أحد</div><div class="reveal-badge badge-neutral">لم تتفق المافيا</div>`}
    </div>

    ${hasSheikh ? `
    <hr class="div">
    <div class="reveal-block d2">
      <div class="reveal-label">سؤال الشيخ</div>
      ${sheikhAsked ? `
        <div class="reveal-badge ${isMafia?'badge-blood':'badge-green'}" style="font-size:16px;">${isMafia? '🗡️ الشيخ سأل عن رجل مافيا' : '🕊️ الشيخ سأل عن رجل صالح'}</div>
      ` : `<div class="reveal-name">لم يسأل الشيخ</div><div class="reveal-badge badge-neutral">— </div>`}
    </div>` : ''}

    ${isHostView? `
    <div class="btn-stack" style="margin-top:10px;">
      <button class="btn btn-primary" data-act="end-round">تم، أكملوا اللعبة بالطريقة العادية</button>
    </div>` : `<p class="hint">استنوا الحكم يكمّل اللعبة عادي من هون.</p>`}
  </div>`;
}

function endScreen(isHostView){
  return `
  <div class="card">
    <p class="eyebrow">انتهت الجولة الأولى</p>
    <h1>✅ خلصت مهمة الموقع للجولة الأولى</h1>
    <p class="desc">هلق كمّلوا اللعبة بالطريقة العادية (نهار، تصويت، إلخ) بدون الموقع. إذا بدكم تبدأو غرفة جديدة من الصفر:</p>
    <div class="btn-stack">
      <button class="btn btn-primary" data-act="new-game">${isHostView?'ابدأ غرفة جديدة':'رجوع للرئيسية'}</button>
    </div>
  </div>`;
}

qtTryRestoreSession();
render();
