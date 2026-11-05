'use strict';
const $=id=>document.getElementById(id);
const languages=new Set([...$('language').options].map(x=>x.value));
let invitation=null;
try{const h=new URLSearchParams(location.hash.slice(1));if(h.has('call')){if(!/^lingua-[a-f0-9]{32}$/.test(h.get('call')||'')||!/^[a-f0-9]{64}$/.test(h.get('secret')||''))throw Error();invitation={id:h.get('call'),secret:h.get('secret')};}}catch{$('status').textContent='Приглашение повреждено. Попросите новую ссылку.';}
const guest=new URLSearchParams(location.hash.slice(1)).has('call');
function permanentRoom(){let saved;try{saved=JSON.parse(localStorage.getItem('lingua.permanent.room.v1')||'null');}catch{}if(saved&&/^lingua-[a-f0-9]{32}$/.test(saved.id)&&/^[a-f0-9]{64}$/.test(saved.secret))return saved;const value={id:'lingua-'+randomHex(16),secret:randomHex(32)};localStorage.setItem('lingua.permanent.room.v1',JSON.stringify(value));return value;}
async function shareInvitation(url){const data={title:'Lingua — видеозвонок',text:'Приглашаю на видеозвонок Lingua',url};if(navigator.share){try{await navigator.share(data);return true;}catch(e){if(e.name==='AbortError')return false;}}try{await navigator.clipboard.writeText(url);status('Ссылка скопирована. Отправьте её через мессенджер.');return true;}catch{status('Скопируйте ссылку приглашения и отправьте её собеседнику.');$('linkBox').hidden=false;$('inviteLink').hidden=false;$('copy').hidden=false;return false;}}
if(guest)$('language').value='vi';
let hostAudio=null;
let local=null,remote=null,peer=null,channel=null,call=null,expectedGuest=null,secret=null,authorized=false,connected=false,epoch=0;
let peerPrefs={consent:false,language:'en'},translationEnabled=true,aiEpoch=0,sessions=[],pendingConnections=new Set(),invitationTimer,callTimer,captionTimer,recoveryTimer;
let debugSeq=0;
function debug(stage,detail=''){
 const safe=String(detail).replace(/lingua-[a-f0-9]{32}/g,'[peer-id]').replace(/[a-f0-9]{64}/g,'[secret]').slice(0,110);
 const line=`DEBUG ${++debugSeq} · ${stage}${safe?' · '+safe:''}`;
 const el=$('debugLine');if(el)el.textContent=line;
 console.info('[Lingua]',line);
}
// ICE servers. STUN only discovers public addresses; when the two devices cannot reach each other
// directly (Wi-Fi client isolation, no NAT hairpinning, mobile CGNAT) only a TURN relay works.
// TURN credentials are short-lived and come from /api/turn (middleware.js → Cloudflare Realtime TURN);
// the Cloudflare API token never reaches the browser. STATIC_TURN_SERVERS is an optional manual fallback, e.g.
// {urls:['turn:turn.example.com:3478?transport=udp','turns:turn.example.com:443?transport=tcp'],username:'USER',credential:'PASSWORD'}
const STATIC_TURN_SERVERS=[];
const STUN_SERVERS=[{urls:['stun:stun.l.google.com:19302','stun:stun1.l.google.com:19302']}];
const FALLBACK_STUN=[{urls:'stun:stun.cloudflare.com:3478'}];
let iceServers=[...STUN_SERVERS,...FALLBACK_STUN,...STATIC_TURN_SERVERS];
let turnState=STATIC_TURN_SERVERS.length?'static':'loading',turnFetchedAt=0,turnRefreshMs=2*3600*1000,turnLoading=null;
function hasTurn(){return iceServers.some(s=>[].concat(s.urls).some(u=>/^turns?:/i.test(String(u))));}
function loadTurn(){
 if(turnLoading)return turnLoading;
 turnLoading=(async()=>{
  const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),6000);
  try{
   const r=await fetch('/api/turn',{cache:'no-store',credentials:'same-origin',signal:ctrl.signal});
   const body=await r.json().catch(()=>({}));
   if(!r.ok||!Array.isArray(body.iceServers))throw Error(String(body.error||'http-'+r.status));
   const fetched=body.iceServers.filter(s=>s&&s.urls&&[].concat(s.urls).length);
   iceServers=[...STUN_SERVERS,...fetched,...STATIC_TURN_SERVERS];
   turnFetchedAt=Date.now();
   if(Number(body.ttl)>0)turnRefreshMs=Math.min(2*3600*1000,Number(body.ttl)*1000/3);
   turnState=hasTurn()?'cloudflare':'none-in-response';
  }catch(e){
   turnState=(STATIC_TURN_SERVERS.length?'static, ':'')+'no ('+String(e?.name==='AbortError'?'timeout':e?.message||'error').slice(0,40)+')';
  }finally{clearTimeout(timer);turnLoading=null;}
  // PeerJS reads peer.options.config for every new RTCPeerConnection, so fresh credentials apply without a new Peer.
  if(peer&&!peer.destroyed&&peer.options?.config)peer.options.config.iceServers=iceServers;
  debug('turn',turnState);updateDiagnostics();
 })();
 return turnLoading;
}
// The organiser's page stays open for a long time: refresh TURN credentials well before they expire.
function turnStale(){return !turnFetchedAt||Date.now()-turnFetchedAt>turnRefreshMs;}
setInterval(()=>{if(peer&&!peer.destroyed&&turnStale())loadTurn();},60*1000);
// iOS pauses timers in the background; check again as soon as the page is visible.
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&peer&&!peer.destroyed&&turnStale())loadTurn();});
// Diagnostic switch: add "&relay=1" (guest) or "#relay=1" (host) to the address to allow only TURN relay paths.
const RELAY_ONLY=new URLSearchParams(location.hash.slice(1)).get('relay')==='1';
// Live diagnostics. These values are intentionally free of peer IDs, IP addresses, tokens and API keys.
const diagnostics={peer:'idle',data:'idle',ice:'n/a',signal:'n/a',cand:'',fail:''};
const monitoredConnections=new WeakSet(),transportWatches=new WeakMap();
let watchedConnection=null;
function updateDiagnostics(changes={}){
 Object.assign(diagnostics,changes);
 const peerEl=$('debugPeerData'),rtcEl=$('debugRtc'),candEl=$('debugIce'),failEl=$('debugIceFail');
 if(peerEl)peerEl.textContent=`PEER: ${diagnostics.peer} · DATA: ${diagnostics.data}${RELAY_ONLY?' · RELAY-ONLY':''}`;
 if(rtcEl)rtcEl.textContent=`ICE: ${diagnostics.ice} · SIGNAL: ${diagnostics.signal} · TURN: ${turnState}`;
 if(candEl){candEl.textContent=diagnostics.cand;candEl.hidden=!diagnostics.cand;}
 if(failEl){failEl.textContent=diagnostics.fail;failEl.hidden=!diagnostics.fail;}
}
function addressKind(a){if(!a)return 'hidden';if(/\.local$/i.test(a))return 'mdns';if(a.includes(':'))return 'v6';return 'v4';}
function countSdpCandidates(sdp,into){
 for(const line of String(sdp||'').split(/\r?\n/)){
  if(!line.startsWith('a=candidate:'))continue;
  const p=line.split(' '),typ=p[p.indexOf('typ')+1]||'?';
  into[`${typ}/${(p[2]||'?').toLowerCase()}/${addressKind(p[4])}`]=(into[`${typ}/${(p[2]||'?').toLowerCase()}/${addressKind(p[4])}`]||0)+1;
 }
}
// Summarises candidate types, transport, address kind (v4/v6/mdns) and candidate-pair states. No addresses are shown.
async function iceSummary(rtc){
 const fromStats={local:{},remote:{}},fromSdp={local:{},remote:{}},pairs={};let selected=false;
 const add=(o,k)=>{o[k]=(o[k]||0)+1;};
 try{(await rtc.getStats()).forEach(s=>{
  if(s.type==='local-candidate'||s.type==='remote-candidate')add(fromStats[s.type==='local-candidate'?'local':'remote'],`${s.candidateType||'?'}/${(s.protocol||'?').toLowerCase()}/${addressKind(s.address||s.ip)}`);
  else if(s.type==='candidate-pair'){add(pairs,s.state||'?');if(s.state==='succeeded'&&s.nominated)selected=true;}
 });}catch{}
 countSdpCandidates(rtc.localDescription?.sdp,fromSdp.local);countSdpCandidates(rtc.remoteDescription?.sdp,fromSdp.remote);
 const total=o=>Object.values(o).reduce((a,b)=>a+b,0);
 const best=k=>total(fromStats[k])>=total(fromSdp[k])?fromStats[k]:fromSdp[k];
 const fmt=o=>Object.entries(o).map(([k,v])=>v>1?k+'×'+v:k).join(' ')||'none';
 return `L: ${fmt(best('local'))} | R: ${fmt(best('remote'))} | PAIRS: ${fmt(pairs)} | GATHER: ${rtc.iceGatheringState}${selected?' | SELECTED':''}`;
}
function transportFail(c,reason){transportWatches.get(c)?.fail(reason);}
function watchDataTransport(c,tag){
 if(!c||monitoredConnections.has(c))return;
 monitoredConnections.add(c);watchedConnection=c;
 const mine=()=>watchedConnection===c;
 updateDiagnostics({data:'connecting',ice:'pending',signal:'pending',cand:''});
 const started=Date.now();let rtc=null,poll=null,done=false,opened=false,last='';
 const snap=async()=>{
  if(!rtc||rtc.signalingState==='closed')return;
  const text=await iceSummary(rtc);if(rtc.signalingState==='closed')return;
  last=`${rtc.iceConnectionState} · ${text}`;
  if(mine())updateDiagnostics({cand:'CAND '+text});
  console.info('[Lingua] ICE',tag,last);
 };
 const stop=()=>{done=true;clearInterval(poll);};
 let failed=false;
 const fail=reason=>{
  if(failed)return;failed=true;
  if(!opened&&last)updateDiagnostics({fail:`LAST FAIL (${tag}, ${reason}, ${Math.round((Date.now()-started)/1000)}s): ${last}`});
  stop();
 };
 transportWatches.set(c,{fail});
 const attach=()=>{
  if(done)return;
  rtc=c.peerConnection;
  if(!rtc){if(Date.now()-started<15000)setTimeout(attach,200);else if(mine())updateDiagnostics({ice:'not-created',signal:'not-created'});return;}
  const state=()=>{
   if(!mine())return;
   const ice=rtc.iceConnectionState||'unknown';
   // PeerJS closes the connection inside its own "failed" handler; keep "failed" visible instead of "closed".
   if(ice==='closed'&&diagnostics.ice==='failed')return;
   updateDiagnostics({ice,signal:rtc.signalingState||'unknown'});
  };
  state();
  for(const ev of ['iceconnectionstatechange','signalingstatechange','connectionstatechange','icegatheringstatechange'])rtc.addEventListener(ev,()=>{state();snap();});
  poll=setInterval(()=>{if(done||rtc.signalingState==='closed'||Date.now()-started>120000){stop();return;}snap();},1500);
  snap();
 };
 attach();
 c.on('open',()=>{opened=true;if(mine())updateDiagnostics({data:'open',fail:''});snap().finally(stop);});
 c.on('error',e=>{
  const type=e?.type||'unknown';
  if(mine())updateDiagnostics({data:'error',...(type==='negotiation-failed'?{ice:'failed'}:{})});
  fail(type);
 });
 c.on('close',()=>{if(mine())updateDiagnostics({data:'closed'});fail('closed');});
}
function status(t){$('status').textContent=t;}
function aiStatus(t){$('aiStatus').textContent=t;if(!guest)send({type:'ai-status',text:t});}
function send(m){if(channel?.open)channel.send(m);}
function randomHex(n){return [...crypto.getRandomValues(new Uint8Array(n))].map(v=>v.toString(16).padStart(2,'0')).join('');}
function prefs(){return {language:$('language').value,consent:$('consent').checked};}
function validPrefs(m){return !!m&&languages.has(m.language)&&typeof m.consent==='boolean';}
let joinAttempt=0;
let dataRetryTimer=null,signalRetryTimer=null,hostConnectionTimer=null;
let dataAttempt=0;
const MAX_DATA_ATTEMPTS=3;
const DATA_NEGOTIATION_TIMEOUT=32000;
let retryGeneration=0;
// The organiser may be briefly offline (e.g. iOS suspends Safari while the link is sent via WhatsApp).
// "peer-unavailable" therefore does not consume a WebRTC attempt; it has its own, longer budget.
const MAX_HOST_MISSING=24;
let hostMissing=0,signalAttempts=0;
function clearConnectionTimers(){clearTimeout(dataRetryTimer);clearTimeout(signalRetryTimer);signalRetryTimer=null;clearTimeout(hostConnectionTimer);}
function peerOnline(p){return !!(p&&!p.destroyed&&!p.disconnected&&p.open);}
// One reconnect schedule per Peer; repeated "disconnected" events do not restart the counter.
function signalReconnect(p){
 if(peer!==p||p.destroyed||connected||signalRetryTimer)return;
 const delay=signalAttempts?Math.min(2500*signalAttempts,10000):1200;
 signalRetryTimer=setTimeout(()=>{
  signalRetryTimer=null;
  if(peer!==p||p.destroyed||connected||peerOnline(p))return;
  if(++signalAttempts>6){debug('peer:reconnect-exhausted');status('Нет связи с сервером PeerJS. Обновите страницу, сохранив прежнюю ссылку.');return;}
  debug('peer:reconnect',String(signalAttempts));status('Восстанавливаем связь с сервером PeerJS…');
  try{if(p.disconnected)p.reconnect();}catch(e){debug('peer:reconnect-error',e?.type||e?.message||'unknown');}
  signalReconnect(p);
 },delay);
}
// iOS often drops the signaling socket while Safari is in the background; reconnect as soon as the page is visible again.
document.addEventListener('visibilitychange',()=>{
 if(document.visibilityState!=='visible'||!peer||peer.destroyed||connected)return;
 if(!peerOnline(peer)){debug('page:visible-reconnect');signalAttempts=0;clearTimeout(signalRetryTimer);signalRetryTimer=null;try{if(peer.disconnected)peer.reconnect();}catch{}signalReconnect(peer);}
});
function guestDataConnect(p){
 if(!guest||peer!==p||p.destroyed||authorized||connected)return;
 if(!peerOnline(p)){debug('guest:waiting-peer');signalReconnect(p);dataRetryTimer=setTimeout(()=>guestDataConnect(p),3000);return;}
 if(dataAttempt>=MAX_DATA_ATTEMPTS){
  debug('guest:attempts-exhausted');updateDiagnostics({data:'timeout'});
  status(hasTurn()?'Не удалось установить соединение WebRTC даже через TURN. Проверьте настройки TURN-сервера.':'Устройства не смогли соединиться напрямую. Для этой сети нужен TURN-сервер.');
  return;
 }
 dataAttempt++;
 const attemptNo=dataAttempt;
 const generation=++retryGeneration;
 clearTimeout(dataRetryTimer);
 // Crucial: never negotiate two simultaneous data channels to the same host.
 if(channel){const previous=channel;channel=null;try{previous.close();}catch{}}
 debug('guest:data-attempt',String(attemptNo));
 status('Шаг 2/4: согласовываем канал ('+attemptNo+'/'+MAX_DATA_ATTEMPTS+')…');
 let c;
 try{c=p.connect(invitation.id,{reliable:true,serialization:'json'});}catch(e){debug('guest:connect-throw',e?.message||'unknown');dataRetryTimer=setTimeout(()=>guestDataConnect(p),3500);return;}
 channel=c;watchDataTransport(c,'guest');
 const current=()=>channel===c&&peer===p&&generation===retryGeneration&&!authorized&&!connected;
 const retry=(reason)=>{
  if(!current())return;
  debug('guest:retry',reason);
  clearTimeout(dataRetryTimer);
  ++retryGeneration;
  channel=null;
  transportFail(c,reason);
  try{c.close();}catch{}
  updateDiagnostics({data:'retrying',ice:'n/a',signal:'n/a'});
  if(peerOnline(p))dataRetryTimer=setTimeout(()=>guestDataConnect(p),3500);
  else {signalReconnect(p);dataRetryTimer=setTimeout(()=>guestDataConnect(p),5000);}
 };
 c.on('open',()=>{
  if(!current())return;
  hostMissing=0;
  debug('guest:data-open');updateDiagnostics({data:'open'});
  status('Шаг 3/4: организатор найден; ожидаем подтверждения…');
  c.send({type:'hello',secret:invitation.secret,...prefs()});
  clearTimeout(dataRetryTimer);
  dataRetryTimer=setTimeout(()=>retry('no-accept'),18000);
 });
 c.on('data',m=>{
  if(!current()||m?.type!=='accepted'||!validPrefs(m))return;
  clearTimeout(dataRetryTimer);debug('guest:accepted');authorized=true;
  peerPrefs={language:m.language,consent:m.consent};bindChannel(c);
  status('Шаг 4/4: ожидаем видеозвонок…');deadline();
  send({type:'prefs',...prefs()});send({type:'ready'});
 });
 c.on('error',e=>{
  if(!current())return;
  debug('guest:data-error',(e?.type||e?.name||'unknown')+':'+String(e?.message||'').slice(0,70));
  updateDiagnostics({data:'error'});retry('error');
 });
 c.on('close',()=>{if(!current())return;debug('guest:data-close');retry('closed');});
 // ICE can require substantially longer than 12 s on iOS; never overlap offers.
 dataRetryTimer=setTimeout(()=>retry('negotiation-timeout'),DATA_NEGOTIATION_TIMEOUT);
}

let captionId=null;
function clearCaption(){clearTimeout(captionTimer);captionId=null;$('subtitle').textContent='Здесь появится перевод речи собеседника';$('original').textContent='';for(const suffix of ['Previous','Oldest']){$('caption'+suffix).hidden=true;$('subtitle'+suffix).textContent=$('original'+suffix).textContent='';}}
function showCaption(text,original='',id='legacy'){if(typeof text!=='string')return;
 if(captionId!==null&&id!==captionId){$('subtitleOldest').textContent=$('subtitlePrevious').textContent;$('originalOldest').textContent=$('originalPrevious').textContent;$('captionOldest').hidden=$('captionPrevious').hidden;$('subtitlePrevious').textContent=$('subtitle').textContent;$('originalPrevious').textContent=$('original').textContent;$('captionPrevious').hidden=false;}
 captionId=id;$('subtitle').textContent=text.slice(-1000);$('original').textContent=typeof original==='string'?original.slice(-600):'';
}

async function prepareAudio(){if(!hostAudio)hostAudio=new AudioContext();await hostAudio.resume();}
function renderRole(){
 $('hostKey').hidden=guest;$('translationSettings').hidden=guest;$('guestNote').hidden=!guest;$('invite').hidden=guest;$('join').hidden=!guest;$('translate').hidden=guest;$('stopAI').hidden=guest;
 if(guest){$('join').textContent='Chấp nhận lời mời';$('waiting').querySelector('p').textContent='Выберите язык и подключитесь к разговору.';$('inviteTitle').textContent='Входящий звонок Lingua';$('inviteHelp').textContent='Нажмите «Принять приглашение». Браузер запросит камеру и микрофон.';status('Вы гость. Подключение начнётся только после нажатия кнопки.');}
}
renderRole();
async function media(){if(local)return local;const e=epoch;const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:{facingMode:'user',width:{ideal:1280}}});if(e!==epoch){stream.getTracks().forEach(t=>t.stop());throw Error('Подключение отменено');}local=stream;$('local').srcObject=stream;$('mic').disabled=$('cam').disabled=false;$('media').textContent='Камера подключена';return stream;}
function action(id,fn){$(id).onclick=async()=>{const b=$(id);b.disabled=true;$('connectionError').textContent='';try{await fn();}catch(e){status(e.name==='NotAllowedError'?'Разрешите доступ к камере и микрофону в настройках браузера.':e.message||'Не удалось выполнить действие.');}finally{b.disabled=false;}};}
function peerFailure(type){
 const messages={
 'peer-unavailable':'Организатор временно не обнаружен. Ссылка остаётся прежней.',
 'network':'Нет связи с сервером подключения PeerJS. Проверьте интернет или попробуйте другую сеть.',
 'server-error':'Сервер подключения PeerJS недоступен. Попробуйте позже.',
 'socket-error':'Не удалось открыть соединение с PeerJS. Попробуйте другую сеть.',
 'socket-closed':'Соединение с сервером PeerJS закрылось. Попробуйте подключиться снова.',
 'browser-incompatible':'Браузер не поддерживает нужные функции звонка. Откройте ссылку в Safari или Chrome.',
 'webrtc':'Не удалось согласовать прямое соединение WebRTC. Попробуйте другую сеть.',
 'unavailable-id':'Этот идентификатор уже зарегистрирован в другой вкладке.',
 'invalid-id':'Ошибка адреса подключения. Обновите страницу.',
 'invalid-key':'Сервер PeerJS отклонил настройки подключения. Это не ошибка ключа Gemini или DeepSeek.',
 'ssl-unavailable':'Сервер подключения не поддерживает защищённое соединение.'
 };
 return messages[type]||'Не удалось подключиться. Повторите попытку с прежней ссылкой.';
}
function createPeer(id){return new Promise((resolve,reject)=>{
 debug('peer:create',guest?'guest':'host');
 updateDiagnostics({peer:'connecting',data:'idle',ice:'n/a',signal:'n/a'});
 // Shared STUN/TURN settings on both devices. Do not create duplicate Peer instances.
 if(RELAY_ONLY&&!hasTurn())debug('config:relay-only-without-turn');
 const p=new Peer(id,{host:'0.peerjs.com',port:443,path:'/',secure:true,debug:0,
  config:{iceServers,iceTransportPolicy:RELAY_ONLY?'relay':'all'}});
 peer=p;
 let ready=false,finished=false;
 const timer=setTimeout(()=>{
  if(ready||peer!==p)return;
  const message='Сервер PeerJS не подтвердил регистрацию.';
  debug('peer:open-timeout');updateDiagnostics({peer:'timeout'});
  if(!finished){finished=true;reject(Error(message));}
  end(message);
 },18000);
 p.on('open',()=>{
  debug('peer:open');updateDiagnostics({peer:'connected'});
  ready=true;clearTimeout(timer);clearTimeout(signalRetryTimer);signalRetryTimer=null;signalAttempts=0;
  if(peer!==p){p.destroy();return;}
  if(!finished){finished=true;resolve(p);}
  else if(guest&&!authorized&&!connected&&!channel){dataRetryTimer=setTimeout(()=>guestDataConnect(p),1000);}
 });
 p.on('error',error=>{
  if(peer!==p)return;
  const type=String(error?.type||error?.name||'unknown');
  debug('peer:error',type+':'+String(error?.message||'').slice(0,80));
  $('connectionError').textContent='Код PeerJS: '+type.slice(0,50);
  // These errors concern one WebRTC/DataConnection attempt, NOT the Peer registration.
  if(type==='negotiation-failed'||type==='webrtc'||type==='peer-unavailable'){
   if(guest&&!authorized&&!connected){
    if(channel){const c=channel;channel=null;++retryGeneration;clearTimeout(dataRetryTimer);transportFail(c,type);try{c.close();}catch{}}
    if(type==='peer-unavailable'){
     // The organiser is not registered right now: this is not a failed WebRTC negotiation.
     dataAttempt=Math.max(0,dataAttempt-1);
     if(++hostMissing>=MAX_HOST_MISSING){debug('guest:host-offline');updateDiagnostics({data:'host-offline'});status('Организатор не в сети. Попросите его открыть Lingua, нажать «Пригласить» и нажмите «Принять приглашение» снова.');return;}
     updateDiagnostics({data:'host-offline'});
     status('Организатор не в сети. Попросите его вернуться на страницу Lingua и не сворачивать Safari. Ищем снова…');
    }else{status('Ошибка согласования WebRTC. Пробуем снова…');updateDiagnostics({data:'retrying'});}
    dataRetryTimer=setTimeout(()=>guestDataConnect(p),type==='peer-unavailable'?5000:4000);
   }else if(!guest&&!connected){status('Канал гостя не согласован. Организатор остаётся доступен по прежней ссылке.');}
   return;
  }
  if(['network','socket-error','socket-closed'].includes(type)){
   updateDiagnostics({peer:'disconnected'});signalReconnect(p);return;
  }
  if(type==='unavailable-id'&& !guest){
   status('Идентификатор организатора занят. Закройте другие вкладки Lingua и перезагрузите страницу.');
  }else status(peerFailure(type));
  if(!ready){clearTimeout(timer);if(!finished){finished=true;reject(Error(peerFailure(type)));}}
 });
 p.on('disconnected',()=>{
  debug('peer:disconnected');updateDiagnostics({peer:'disconnected'});
  if(peer!==p)return;
  if(connected){status('Сигнализация временно недоступна; текущий видеозвонок продолжается.');return;}
  signalReconnect(p);
 });
});}

function watchCall(c){debug('media:call',guest?'incoming':'outgoing');call=c;c.on('stream',s=>{debug('media:stream');if(call!==c)return;remote=s;connected=true;window.linguaChat?.connected();clearTimeout(invitationTimer);clearTimeout(callTimer);$('remote').srcObject=s;$('remote').play().catch(()=>status('Нажмите на видео для воспроизведения звука.'));$('waiting').hidden=true;$('connection').textContent='● Прямое соединение';setTimeout(()=>showRoute(c),1500);status('Вы на связи. Ключ используется только в браузере организатора.');$('linkBox').hidden=true;if(!guest)restartAI();});c.on('close',()=>{if(call===c)dropPeer('Собеседник завершил звонок.');});c.on('error',()=>{if(call===c)dropPeer('Соединение прервалось.');});c.peerConnection?.addEventListener('connectionstatechange',()=>{if(call!==c)return;const state=c.peerConnection.connectionState;debug('webrtc:state',state);clearTimeout(recoveryTimer);if(state==='failed')dropPeer('Не удалось восстановить прямое соединение.');else if(state==='disconnected'){status('Связь временно потеряна. Ждём восстановления…');recoveryTimer=setTimeout(()=>{if(call===c&&c.peerConnection.connectionState==='disconnected')dropPeer('Не удалось восстановить прямое соединение.');},12000);}else if(state==='connected')status('Вы на связи. Ключ используется только в браузере организатора.');});}
// Shows whether the media flows directly or through the TURN relay (from the selected ICE candidate pair).
async function showRoute(c){
 const rtc=c?.peerConnection;if(!rtc||call!==c)return;
 try{
  const stats=await rtc.getStats();let pair=null;
  stats.forEach(s=>{if(s.type==='transport'&&s.selectedCandidatePairId)pair=stats.get(s.selectedCandidatePairId);});
  if(!pair)stats.forEach(s=>{if(!pair&&s.type==='candidate-pair'&&s.state==='succeeded'&&s.nominated)pair=s;});
  if(!pair||call!==c)return;
  const relay=[stats.get(pair.localCandidateId),stats.get(pair.remoteCandidateId)].some(x=>x?.candidateType==='relay');
  $('connection').textContent=relay?'● Соединение через TURN':'● Прямое соединение';
  debug('media:route',relay?'relay':'direct');
 }catch{}
}
function bindChannel(c){debug('data:authorized');channel=c;c.on('data',m=>{if(channel!==c||!authorized||!m||typeof m!=='object')return;
 if(m.type==='chat'||m.type==='chat-result'||m.type==='chat-provider'){window.linguaChat?.receive(m);return;}
 if(m.type==='prefs'&&validPrefs(m)){peerPrefs={language:m.language,consent:m.consent};if(!guest)restartAI();}
 if(!guest&&m.type==='ready'&&expectedGuest===c.peer&&!call){status('Гость готов. Устанавливаем видео…');watchCall(peer.call(expectedGuest,local));}
 if(guest&&m.type==='caption')showCaption(m.text,m.original,typeof m.id==='string'?m.id.slice(0,100):'legacy');
 if(guest&&m.type==='ai-status'&&typeof m.text==='string')$('aiStatus').textContent=m.text.slice(0,180);
 if(m.type==='clear')clearCaption();
 if(m.type==='end')dropPeer('Собеседник завершил звонок.');
 });c.on('close',()=>{if(channel===c)dropPeer('Соединение с собеседником закрыто.');});c.on('error',()=>{if(channel===c)dropPeer('Ошибка канала связи. Подключитесь заново.');});}
function deadline(){clearTimeout(callTimer);callTimer=setTimeout(()=>{if(!connected)dropPeer('Тайм-аут WebRTC: соединение не установлено за 40 секунд. Повторите попытку.');},40000);}
// Guest: a failure ends the session. Host: drop only the guest and keep the PeerJS registration,
// camera and keys, so the permanent link keeps working without pressing «Пригласить» again.
function dropPeer(message){if(guest||!peer){end(message);return;}resetHostRoom(message);}
function resetHostRoom(message){
 debug('host:room-reset');
 send({type:'end'});
 clearTimeout(callTimer);clearTimeout(recoveryTimer);
 const c=call,d=channel;call=channel=null;authorized=connected=false;expectedGuest=null;
 stopSessions(true);window.linguaChat?.clear();
 try{c?.close();}catch{}try{d?.close();}catch{}
 pendingConnections.forEach(x=>{try{x.close();}catch{}});pendingConnections.clear();
 remote?.getTracks().forEach(t=>t.stop());remote=null;$('remote').srcObject=null;$('waiting').hidden=false;
 peerPrefs={consent:false,language:'en'};
 $('connection').textContent='○ Ожидаем собеседника';$('aiStatus').textContent='Перевод выключен';
 updateDiagnostics({data:'idle',ice:'n/a',signal:'n/a',cand:''});
 status(message+' Ссылка остаётся действительной: гость может подключиться снова.');
}
action('media',async()=>{await media();status(guest?'Камера готова. Нажмите «Подключиться к звонку».':'Камера готова. Введите ключ и создайте ссылку.');});
action('invite',async()=>{
 if(guest)return;if(peer){if($('inviteLink').value)await shareInvitation($('inviteLink').value);return;}
 await prepareAudio();await media();const room=permanentRoom();await loadTurn();const p=await createPeer(room.id);secret=room.secret;translationEnabled=true;
 p.on('call',c=>c.close());
 p.on('connection',c=>{
 debug('host:incoming-data');
 if(authorized){debug('host:busy-rejected');c.on('open',()=>c.close());return;}
 // The guest only starts a new attempt after abandoning the previous one, so the newest attempt wins.
 for(const old of pendingConnections){debug('host:stale-replaced');pendingConnections.delete(old);transportFail(old,'superseded');try{old.close();}catch{}}
 pendingConnections.add(c);watchDataTransport(c,'host');
 let settled=false;
 let timer=setTimeout(()=>{debug('host:data-timeout');transportFail(c,'timeout');pendingConnections.delete(c);try{c.close();}catch{}},DATA_NEGOTIATION_TIMEOUT+5000);
 c.on('open',()=>{debug('host:data-open');updateDiagnostics({data:'open'});});
 c.on('error',e=>{debug('host:data-error',(e?.type||'unknown')+':'+String(e?.message||'').slice(0,65));clearTimeout(timer);pendingConnections.delete(c);updateDiagnostics({data:'error'});if(!authorized&&e?.type==='negotiation-failed')status(hasTurn()?'Гость пытался подключиться, но WebRTC не нашёл маршрут даже через TURN. Ожидаем новую попытку.':'Гость пытался подключиться, но устройства не смогли соединиться напрямую. Для этой сети нужен TURN-сервер.');});
 c.on('close',()=>{clearTimeout(timer);pendingConnections.delete(c);if(!authorized&&pendingConnections.size===0)updateDiagnostics({data:'idle',ice:'n/a',signal:'n/a'});});
 c.on('data',m=>{
  debug('host:hello',m?.type||'unknown');if(settled)return;
  if(peer!==p||authorized||!m||m.type!=='hello'||m.secret!==secret||!validPrefs(m)){debug('host:hello-rejected');c.close();return;}
  settled=true;clearTimeout(timer);pendingConnections.delete(c);
  debug('host:accepted-hello');authorized=true;expectedGuest=c.peer;peerPrefs={language:m.language,consent:m.consent};
  clearTimeout(invitationTimer);bindChannel(c);send({type:'accepted',...prefs()});
  $('connection').textContent='○ Гость найден';status('Гость подтверждён. Ожидаем готовности к видеозвонку…');$('linkBox').hidden=true;deadline();
 });
 });
 const u=new URL(location.href);u.hash=new URLSearchParams({call:p.id,secret}).toString();$('inviteLink').value=u.href;$('linkBox').hidden=true;$('connection').textContent='○ Ожидаем собеседника';status('Приглашение готово. Оставьте страницу открытой.');debug('host:waiting-guest');await shareInvitation(u.href);
});
action('join',async()=>{
 if(!guest)return;
 if(peer&&!connected){end('Повторяем подключение по прежней ссылке…');}
 if(peer)return;
 const attempt=++joinAttempt;if(!invitation)throw Error('Приглашение повреждено. Попросите новую ссылку.');status('Шаг 1/4: запускаем камеру…');await media();status('Шаг 2/4: соединяемся с сервером PeerJS…');await loadTurn();const p=await createPeer('lingua-'+randomHex(16));
 p.on('connection',c=>c.on('open',()=>c.close()));
 p.on('call',c=>{debug('guest:incoming-call');if(c.peer!==invitation.id||call){c.close();return;}c.answer(local);watchCall(c);});
 dataAttempt=0;hostMissing=0;guestDataConnect(p);
});
action('copy',async()=>{if(!$('inviteLink').value)throw Error('Создайте ссылку.');await navigator.clipboard.writeText($('inviteLink').value);status('Ссылка скопирована. Отправьте её собеседнику.');});
$('mic').onclick=()=>{const t=local?.getAudioTracks()[0];if(t){t.enabled=!t.enabled;$('mic').textContent='Микрофон: '+(t.enabled?'вкл.':'выкл.');}};
$('cam').onclick=()=>{const t=local?.getVideoTracks()[0];if(t){t.enabled=!t.enabled;$('cam').textContent='Видео: '+(t.enabled?'вкл.':'выкл.');}};
$('remote').onclick=()=>$('remote').play().catch(()=>{});
function updatePrefs(){send({type:'prefs',...prefs()});if(!guest)restartAI();}
$('consent').onchange=updatePrefs;$('language').onchange=()=>{if(guest)$('join').textContent=({vi:'Chấp nhận lời mời',en:'Accept invitation',ru:'Принять приглашение'})[$('language').value]||'Accept invitation';updatePrefs();};
function stopSessions(clear=false){aiEpoch++;const old=sessions;sessions=[];old.forEach(s=>s.close());if(clear){clearCaption();send({type:'clear'});}$('stopAI').disabled=true;}
function end(message='Звонок завершён. Ключ, титры и ссылка очищены.'){
 epoch++;clearConnectionTimers();dataAttempt=0;window.linguaKeyManager?.clearSession?.();window.linguaKeyChecks?.clear();window.linguaChat?.clear();clearTimeout(invitationTimer);clearTimeout(callTimer);clearTimeout(recoveryTimer);send({type:'end'});authorized=connected=false;stopSessions(true);hostAudio?.close().catch(()=>{});hostAudio=null;const c=call,p=peer,d=channel;call=peer=channel=null;c?.close();d?.close();pendingConnections.forEach(c=>c.close());pendingConnections.clear();p?.destroy();local?.getTracks().forEach(t=>t.stop());remote?.getTracks().forEach(t=>t.stop());local=remote=null;secret=expectedGuest=null;peerPrefs={consent:false,language:'en'};
 $('local').srcObject=$('remote').srcObject=null;$('chatGeminiKey').value=$('deepseekKey').value=$('credential').value=$('inviteLink').value='';$('linkBox').hidden=true;$('waiting').hidden=false;$('consent').checked=false;$('mic').disabled=$('cam').disabled=true;$('mic').textContent='Микрофон: вкл.';$('cam').textContent='Видео: вкл.';$('media').textContent='Проверить камеру';$('connection').textContent='○ Не подключено';$('aiStatus').textContent='Перевод выключен';$('invite').disabled=$('join').disabled=false;status(message);
}
$('hangup').onclick=()=>end();window.addEventListener('pagehide',()=>end());
async function startStream(stream,target,toGuest,generation){
 let source=null,node=null,provider=null,gate=null,closed=false;
 const entry={close(){if(closed)return;closed=true;provider?.close();gate?.clear();if(node){node.port.onmessage=null;node.disconnect();}source?.disconnect();}};sessions.push(entry);
 const failure=code=>{if(closed||generation!==aiEpoch)return;stopSessions();translationEnabled=false;aiStatus(code==='quota'?'Лимит Gemini исчерпан. Проверьте квоту и оплату.':code==='slow'?'Перевод не успевает за разговором. Проверьте сеть и включите перевод заново.':'Перевод остановлен. Проверьте ключ и доступ к выбранным моделям, затем включите перевод заново.');};
 try{
 const audio=hostAudio;if(!audio||audio.state!=='running')throw Error();await audio.audioWorklet.addModule('./pcm.js');if(closed||generation!==aiEpoch)return;
 provider=TranslationProviders.create($('provider').value||'gemini-live',{key:$('credential').value.trim(),target,onReady(){if(closed)return;entry.ready=true;if(sessions.length&&sessions.every(s=>s.ready))aiStatus('● Перевод включён · один ключ организатора');},onCaption(text,original,turn=0){if(closed||generation!==aiEpoch)return;const id=generation+':'+turn;if(toGuest)send({type:'caption',text,original,id});else showCaption(text,original,id);},onError:failure,onEnding(){aiStatus('Gemini скоро закроет сессию. Организатор сможет включить перевод повторно.');}});
 gate=new SilenceGate({enabled:$('vad').checked,threshold:Number($('vadLevel').value)||.004,onAudio:buffer=>provider.audio(buffer),onEnd:()=>provider.endAudio()});
 source=audio.createMediaStreamSource(stream);node=new AudioWorkletNode(audio,'pcm');source.connect(node);node.connect(audio.destination);
 node.port.onmessage=e=>{if(!closed&&provider.ready&&generation===aiEpoch)gate.push(e.data);};provider.connect();
 }catch{failure('provider');}
}
async function restartAI(){
 if(guest)return;stopSessions();if(!translationEnabled||!connected)return;
 if(!$('credential').value.trim()){aiStatus('Организатору нужно ввести Gemini API-ключ.');return;}
 const generation=aiEpoch;const jobs=[];if(peerPrefs.consent)jobs.push({stream:remote,language:$('language').value,toGuest:false});if($('consent').checked)jobs.push({stream:local,language:peerPrefs.language,toGuest:true});
 if(!jobs.length){aiStatus('Для перевода каждый участник должен разрешить обработку своего голоса.');return;}
 $('stopAI').disabled=false;aiStatus('Подключаем перевод '+jobs.length+' направлений…');await Promise.all(jobs.map(j=>startStream(j.stream,j.language,j.toGuest,generation)));
}
action('translate',async()=>{if(!connected)throw Error('Сначала подключите собеседника.');await prepareAudio();translationEnabled=true;await restartAI();});
$('stopAI').onclick=()=>{translationEnabled=false;stopSessions();aiStatus('Организатор остановил перевод. Видеозвонок продолжается.');};

for(const id of ['provider','vad','vadLevel'])$(id).onchange=()=>{if(!guest)restartAI();};
