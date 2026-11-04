'use strict';
const $=id=>document.getElementById(id);
const languages=new Set([...$('language').options].map(x=>x.value));
let invitation=null;
try{const h=new URLSearchParams(location.hash.slice(1));if(h.has('call')){if(!/^lingua-[a-f0-9]{32}$/.test(h.get('call')||'')||!/^[a-f0-9]{64}$/.test(h.get('secret')||''))throw Error();invitation={id:h.get('call'),secret:h.get('secret')};}}catch{$('status').textContent='Приглашение повреждено. Попросите новую ссылку.';}
const guest=new URLSearchParams(location.hash.slice(1)).has('call');
function permanentRoom(){let saved;try{saved=JSON.parse(localStorage.getItem('lingua.permanent.room.v1')||'null');}catch{}if(saved&&/^lingua-[a-f0-9]{32}$/.test(saved.id)&&/^[a-f0-9]{64}$/.test(saved.secret))return saved;const value={id:'lingua-'+randomHex(16),secret:randomHex(32)};localStorage.setItem('lingua.permanent.room.v1',JSON.stringify(value));return value;}
async function shareInvitation(url){const data={title:'Lingua — видеозвонок',text:'Приглашаю на видеозвонок Lingua',url};if(navigator.share){try{await navigator.share(data);return true;}catch(e){if(e.name==='AbortError')return false;}}try{await navigator.clipboard.writeText(url);status('Ссылка скопирована. Отправьте её через мессенджер.');return true;}catch{status('Скопируйте ссылку приглашения и отправьте её собеседнику.');$('inviteLink').hidden=false;return false;}}
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
// Live diagnostics. These values are intentionally free of peer IDs, tokens and API keys.
const diagnostics={peer:'idle',data:'idle',ice:'n/a',signal:'n/a'};
const monitoredConnections=new WeakSet();
let diagnosticsTimer=null;
function updateDiagnostics(changes={}){
 Object.assign(diagnostics,changes);
 const peerEl=$('debugPeerData'),rtcEl=$('debugRtc');
 if(peerEl)peerEl.textContent=`PEER: ${diagnostics.peer} · DATA: ${diagnostics.data}`;
 if(rtcEl)rtcEl.textContent=`ICE: ${diagnostics.ice} · SIGNAL: ${diagnostics.signal}`;
}
function watchDataTransport(c,tag){
 if(!c||monitoredConnections.has(c))return;
 monitoredConnections.add(c);
 updateDiagnostics({data:'connecting',ice:'pending',signal:'pending'});
 const started=Date.now();
 const inspect=()=>{
  if(!peer||peer.destroyed||(!pendingConnections.has(c)&&channel!==c))return false;
  const rtc=c.peerConnection;
  if(rtc){updateDiagnostics({ice:rtc.iceConnectionState||'unknown',signal:rtc.signalingState||'unknown'});return true;}
  if(Date.now()-started>15000){updateDiagnostics({ice:'not-created',signal:'not-created'});return true;}
  return false;
 };
 const attach=()=>{
  if(!inspect()){if(Date.now()-started<15000)setTimeout(attach,200);return;}
  const rtc=c.peerConnection;if(!rtc)return;
  for(const ev of ['iceconnectionstatechange','signalingstatechange','connectionstatechange'])rtc.addEventListener(ev,()=>{
   if(channel===c||pendingConnections.has(c))updateDiagnostics({ice:rtc.iceConnectionState||'unknown',signal:rtc.signalingState||'unknown'});
  });
 };
 attach();
 c.on('open',()=>{if(channel===c||pendingConnections.has(c))updateDiagnostics({data:'open'});});
 c.on('error',()=>{if(channel===c||pendingConnections.has(c))updateDiagnostics({data:'error'});});
 c.on('close',()=>{if(channel===c||pendingConnections.has(c))updateDiagnostics({data:'closed'});});
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
function clearConnectionTimers(){clearTimeout(dataRetryTimer);clearTimeout(signalRetryTimer);clearTimeout(hostConnectionTimer);}
function peerOnline(p){return !!(p&&!p.destroyed&&!p.disconnected&&p.open);}
function signalReconnect(p){
 if(peer!==p||p.destroyed||connected)return;
 clearTimeout(signalRetryTimer);
 let n=0;
 const retry=()=>{
  if(peer!==p||p.destroyed||connected||peerOnline(p))return;
  if(++n>6){debug('peer:reconnect-exhausted');status('Нет связи с сервером PeerJS. Обновите страницу, сохранив прежнюю ссылку.');return;}
  debug('peer:reconnect',String(n));status('Восстанавливаем связь с сервером PeerJS… попытка '+n);
  try{p.reconnect();}catch(e){debug('peer:reconnect-error',e?.type||e?.message||'unknown');}
  signalRetryTimer=setTimeout(retry,Math.min(2500*n,10000));
 };
 signalRetryTimer=setTimeout(retry,1200);
}
function guestDataConnect(p){
 if(!guest||peer!==p||p.destroyed||authorized||connected)return;
 if(!peerOnline(p)){debug('guest:waiting-peer');signalReconnect(p);dataRetryTimer=setTimeout(()=>guestDataConnect(p),3000);return;}
 if(dataAttempt>=MAX_DATA_ATTEMPTS){
  debug('guest:attempts-exhausted');updateDiagnostics({data:'timeout'});
  status('Не удалось согласовать канал WebRTC. Нажмите «Принять приглашение» для новой попытки.');
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
  try{c.close();}catch{}
  updateDiagnostics({data:'retrying',ice:'n/a',signal:'n/a'});
  if(peerOnline(p))dataRetryTimer=setTimeout(()=>guestDataConnect(p),3500);
  else {signalReconnect(p);dataRetryTimer=setTimeout(()=>guestDataConnect(p),5000);}
 };
 c.on('open',()=>{
  if(!current())return;
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
 // Shared STUN settings on both devices. Do not create duplicate Peer instances.
 const p=new Peer(id,{host:'0.peerjs.com',port:443,path:'/',secure:true,debug:0,
  config:{iceServers:[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}],iceTransportPolicy:'all'}});
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
  ready=true;clearTimeout(timer);clearTimeout(signalRetryTimer);
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
    status(type==='peer-unavailable'?'Организатор пока не обнаружен. Повторяем поиск…':'Ошибка согласования WebRTC. Пробуем снова…');
    if(channel){const c=channel;channel=null;++retryGeneration;clearTimeout(dataRetryTimer);try{c.close();}catch{}}
    updateDiagnostics({data:'retrying'});
    dataRetryTimer=setTimeout(()=>guestDataConnect(p),4000);
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

function watchCall(c){debug('media:call',guest?'incoming':'outgoing');call=c;c.on('stream',s=>{debug('media:stream');if(call!==c)return;remote=s;connected=true;window.linguaChat?.connected();clearTimeout(invitationTimer);clearTimeout(callTimer);$('remote').srcObject=s;$('remote').play().catch(()=>status('Нажмите на видео для воспроизведения звука.'));$('waiting').hidden=true;$('connection').textContent='● Прямое соединение';status('Вы на связи. Ключ используется только в браузере организатора.');$('linkBox').hidden=true;if(!guest)restartAI();});c.on('close',()=>{if(call===c)end('Собеседник завершил звонок.');});c.on('error',()=>{if(call===c)end('Соединение прервалось. Создайте новый звонок.');});c.peerConnection?.addEventListener('connectionstatechange',()=>{if(call!==c)return;const state=c.peerConnection.connectionState;debug('webrtc:state',state);clearTimeout(recoveryTimer);if(state==='failed')end('Не удалось восстановить прямое соединение. Попробуйте другую сеть.');else if(state==='disconnected'){status('Связь временно потеряна. Ждём восстановления…');recoveryTimer=setTimeout(()=>{if(call===c&&c.peerConnection.connectionState==='disconnected')end('Не удалось восстановить прямое соединение. Попробуйте другую сеть.');},12000);}else if(state==='connected')status('Вы на связи. Ключ используется только в браузере организатора.');});}
function bindChannel(c){debug('data:authorized');channel=c;c.on('data',m=>{if(channel!==c||!authorized||!m||typeof m!=='object')return;
 if(m.type==='chat'||m.type==='chat-result'||m.type==='chat-provider'){window.linguaChat?.receive(m);return;}
 if(m.type==='prefs'&&validPrefs(m)){peerPrefs={language:m.language,consent:m.consent};if(!guest)restartAI();}
 if(!guest&&m.type==='ready'&&expectedGuest===c.peer&&!call){status('Гость готов. Устанавливаем видео…');watchCall(peer.call(expectedGuest,local));}
 if(guest&&m.type==='caption')showCaption(m.text,m.original,typeof m.id==='string'?m.id.slice(0,100):'legacy');
 if(guest&&m.type==='ai-status'&&typeof m.text==='string')$('aiStatus').textContent=m.text.slice(0,180);
 if(m.type==='clear')clearCaption();
 if(m.type==='end')end('Собеседник завершил звонок.');
 });c.on('close',()=>{if(channel===c)end('Соединение с собеседником закрыто.');});c.on('error',()=>{if(channel===c)end('Ошибка канала связи. Подключитесь заново.');});}
function deadline(){clearTimeout(callTimer);callTimer=setTimeout(()=>{if(!connected)end('Тайм-аут WebRTC: соединение не установлено за 40 секунд. Повторите попытку.');},40000);}
action('media',async()=>{await media();status(guest?'Камера готова. Нажмите «Подключиться к звонку».':'Камера готова. Введите ключ и создайте ссылку.');});
action('invite',async()=>{
 if(guest)return;if(peer){if($('inviteLink').value)await shareInvitation($('inviteLink').value);return;}
 await prepareAudio();await media();const room=permanentRoom();const p=await createPeer(room.id);secret=room.secret;translationEnabled=true;
 p.on('call',c=>c.close());
 p.on('connection',c=>{
 debug('host:incoming-data');pendingConnections.add(c);watchDataTransport(c,'host');
 if(authorized||pendingConnections.size>1){debug('host:duplicate-rejected');pendingConnections.delete(c);c.on('open',()=>c.close());return;}
 let settled=false;
 let timer=setTimeout(()=>{debug('host:data-timeout');pendingConnections.delete(c);try{c.close();}catch{}},DATA_NEGOTIATION_TIMEOUT+5000);
 c.on('open',()=>{debug('host:data-open');updateDiagnostics({data:'open'});});
 c.on('error',e=>{debug('host:data-error',(e?.type||'unknown')+':'+String(e?.message||'').slice(0,65));clearTimeout(timer);pendingConnections.delete(c);updateDiagnostics({data:'error'});});
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
 const attempt=++joinAttempt;if(!invitation)throw Error('Приглашение повреждено. Попросите новую ссылку.');status('Шаг 1/4: запускаем камеру…');await media();status('Шаг 2/4: соединяемся с сервером PeerJS…');const p=await createPeer('lingua-'+randomHex(16));
 p.on('connection',c=>c.on('open',()=>c.close()));
 p.on('call',c=>{debug('guest:incoming-call');if(c.peer!==invitation.id||call){c.close();return;}watchCall(c);c.answer(local);});
 dataAttempt=0;guestDataConnect(p);
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
