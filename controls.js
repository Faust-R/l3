'use strict';
(()=>{
 const checks=new Map();let revision=0;
 function cancel(kind){const old=checks.get(kind);if(old){old.cancelled=true;old.provider?.close();old.translator?.close();old.cancel?.();checks.delete(kind);}$(kind==='voice'?'checkVoice':'checkChat').disabled=false;$(kind+'KeyStatus').textContent='';}
 function probeLive(job,mode,key){return new Promise((resolve,reject)=>{job.cancel=()=>reject(Error('cancelled'));job.provider=TranslationProviders.create(mode,{key,target:'vi',onReady:resolve,onCaption(){},onError:code=>reject(Error(code)),onEnding:()=>reject(Error('connection'))});job.provider.connect();});}
 async function check(kind){cancel(kind);const job={cancelled:false,revision};checks.set(kind,job);const button=$(kind==='voice'?'checkVoice':'checkChat'),out=$(kind+'KeyStatus');
 const deepseek=kind==='chat'&&$('chatProvider').value==='deepseek';const key=(kind==='voice'?$('credential').value:deepseek?$('deepseekKey').value:($('chatGeminiKey').value||$('credential').value)).trim();
 if(!key){out.textContent='Введите ключ';return;}button.disabled=true;out.textContent='Проверяем…';out.dataset.state='pending';
 try{if(kind==='voice'){await probeLive(job,$('provider').value,key);job.provider.close();if($('provider').value==='gemini-text'){job.translator=new GeminiTextTranslator(key,'vi');await job.translator.translate('Hello');}}else{job.translator=deepseek?new DeepSeekTextTranslator(key,'vi'):new GeminiTextTranslator(key,'vi');await job.translator.translate('Hello');}
 if(!job.cancelled&&job.revision===revision){out.textContent='Ключ и модель доступны';out.dataset.state='ok';}
 }catch(error){if(!job.cancelled&&job.revision===revision){out.textContent=deepseek?chatError(error.message):'Ошибка проверки: ключ, доступ к модели или сеть';out.dataset.state='error';}}
 finally{job.provider?.close();job.translator?.close();if(checks.get(kind)===job){checks.delete(kind);button.disabled=false;}}
 }
 $('checkVoice').onclick=()=>check('voice');$('checkChat').onclick=()=>check('chat');
 for(const id of ['credential','provider'])$(id).addEventListener(id==='provider'?'change':'input',()=>{cancel('voice');if(id==='credential')cancel('chat');});
 for(const id of ['chatProvider','deepseekKey','chatGeminiKey'])$(id).addEventListener(id==='chatProvider'?'change':'input',()=>cancel('chat'));
 window.linguaKeyChecks={clear(){revision++;cancel('voice');cancel('chat');}};
})();
(()=>{
 const tile=$('selfPreview'),stage=tile.parentElement;let drag=null,x=1,y=0.15;
 function position(){const w=Math.max(0,stage.clientWidth-tile.offsetWidth-16),h=Math.max(0,stage.clientHeight-tile.offsetHeight-16);tile.style.left=(8+x*w)+'px';tile.style.top=(8+y*h)+'px';tile.style.right='auto';}
 tile.addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();drag={id:e.pointerId,startX:e.clientX,startY:e.clientY,x,y};tile.setPointerCapture(e.pointerId);});
 tile.addEventListener('pointermove',e=>{if(!drag||drag.id!==e.pointerId)return;x=Math.max(0,Math.min(1,drag.x+(e.clientX-drag.startX)/Math.max(1,stage.clientWidth-tile.offsetWidth-16)));y=Math.max(0,Math.min(1,drag.y+(e.clientY-drag.startY)/Math.max(1,stage.clientHeight-tile.offsetHeight-16)));position();});
 for(const event of ['pointerup','pointercancel','lostpointercapture'])tile.addEventListener(event,()=>{drag=null;});
 tile.addEventListener('keydown',e=>{const delta={ArrowLeft:[-.05,0],ArrowRight:[.05,0],ArrowUp:[0,-.05],ArrowDown:[0,.05]}[e.key];if(!delta)return;e.preventDefault();x=Math.max(0,Math.min(1,x+delta[0]));y=Math.max(0,Math.min(1,y+delta[1]));position();});
 new ResizeObserver(position).observe(stage);position();
})();
