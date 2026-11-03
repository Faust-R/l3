'use strict';
// Select the invitation screen before the first paint; never read or transmit API keys.
if(new URLSearchParams(location.hash.slice(1)).has('call'))document.documentElement.classList.add('guest-view');
