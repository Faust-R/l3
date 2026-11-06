'use strict';
// API keys are never stored by the site (no localStorage, no server).
// Each key sits in its own small login-style form: a hidden user name («Gemini API» / «DeepSeek API»)
// plus a password field. Safari and the iPhone «Пароли» app treat it as a login for this site:
// tapping the field offers the saved key, and «Проверить» lets Safari offer to save or update it.
// The form is submitted into an about:blank iframe: Safari sees a real form submission,
// while nothing is sent over the network.
(()=>{
 const site=$('keySite');if(site)site.textContent=location.host||'—';
 for(const form of document.querySelectorAll('.key-form')){
  form.addEventListener('submit',e=>{
   const input=form.querySelector('input[type=password]');
   const value=input.value.trim();if(value!==input.value)input.value=value;
   window.linguaKeyChecks?.run(form.dataset.check);
   if(!value)e.preventDefault();
  });
 }
 window.linguaKeyManager={clearSession(){}};
})();
