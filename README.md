Lingua — одноранговый видеозвонок на PeerJS/WebRTC. Все файлы в одном каталоге. Загрузите содержимое каталога в корень GitHub-репозитория; Vercel развернет статический сайт. Гостевая ссылка сохраняется на устройстве организатора; для ее работы организатор должен быть онлайн. Web Push и TURN пока не реализованы. API-ключи не сохраняются сайтом, iOS Passwords может предлагать автозаполнение. Не публикуйте ключи в GitHub.


Connection revision: retain persistent room link; retry guest DataConnection up to four times, 12-second open timeout, 24-second host handshake timeout; recovery via PeerJS reconnect; 3 public STUN endpoints; PeerJS reliable shim disabled. No TURN relay included. Tested by JS syntax only, not real phones.


## PeerJS connection repair (2026-11-04)
- PeerJS negotiation errors are handled per DataConnection, rather than destroying the host Peer.
- Only one active guest data-channel offer is negotiated at a time, with a 32-second window per attempt.
- PeerJS `peer-unavailable` is treated as transient during guest connection attempts; retry uses the permanent host ID.
- Host refuses duplicate concurrent handshake requests and retains its signaling registration.
- Debug line includes PeerJS error type and a short nonsecret error description.
- A full functional test still requires two real devices; READY deployment alone is not validation.
