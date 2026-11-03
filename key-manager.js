// API keys are deliberately never persisted to localStorage or IndexedDB.
// Safari/iOS Passwords may offer native credential autofill, depending on browser behavior.
(()=>{
 const ids=['credential','chatGeminiKey','deepseekKey'];
 for(const id of ids){const el=document.getElementById(id);if(!el)continue;el.setAttribute('autocomplete','current-password');el.setAttribute('autocapitalize','off');el.setAttribute('spellcheck','false');}
 const vault=document.querySelector('.vault');if(vault)vault.remove();
 const box=document.createElement('p');box.className='hint';box.textContent='Ключи не сохраняются сайтом. Для автозаполнения используйте приложение «Пароли» iPhone; Safari может предложить сохранение. После перезагрузки ключ можно вставить снова.';
 document.getElementById('apiPanel')?.append(box);
 window.linguaKeyManager={clearSession(){}};
})();
