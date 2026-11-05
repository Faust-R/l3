Lingua — одноранговый видеозвонок на PeerJS/WebRTC. Все файлы в одном каталоге. Загрузите содержимое каталога в корень GitHub-репозитория; Vercel развернет статический сайт. Гостевая ссылка сохраняется на устройстве организатора; для ее работы организатор должен быть онлайн. Web Push и TURN пока не реализованы. API-ключи не сохраняются сайтом, iOS Passwords может предлагать автозаполнение. Не публикуйте ключи в GitHub.


Connection revision: retain persistent room link; retry guest DataConnection up to four times, 12-second open timeout, 24-second host handshake timeout; recovery via PeerJS reconnect; 3 public STUN endpoints; PeerJS reliable shim disabled. No TURN relay included. Tested by JS syntax only, not real phones.


## PeerJS connection repair (2026-11-04)
- PeerJS negotiation errors are handled per DataConnection, rather than destroying the host Peer.
- Only one active guest data-channel offer is negotiated at a time, with a 32-second window per attempt.
- PeerJS `peer-unavailable` is treated as transient during guest connection attempts; retry uses the permanent host ID.
- Host refuses duplicate concurrent handshake requests and retains its signaling registration.
- Debug line includes PeerJS error type and a short nonsecret error description.
- A full functional test still requires two real devices; READY deployment alone is not validation.


## ICE diagnostics and TURN preparation (2026-11-05)
- Root cause analysis: in PeerJS 1.5.5 `negotiation-failed` is emitted only when `iceConnectionState` becomes `failed`. SDP offer/answer and candidate exchange work; no candidate pair succeeds. The old screen showed `ICE: checking` because the diagnostic listener ran after the connection had already been removed.
- New debug lines: `CAND L: … | R: … | PAIRS: … | GATHER: …` (candidate type/protocol/address kind for local and remote side, candidate-pair states) and `LAST FAIL (…)` with the snapshot of the last failed attempt. No IP addresses or IDs are displayed.
  - `host/udp/mdns` = address hidden behind a `.local` name; `srflx` = public address found via STUN; `relay` = TURN; `R: none` = no remote candidates arrived.
- TURN: add servers to `TURN_SERVERS` at the top of `app.js`. `&relay=1` in the guest link (or `#relay=1` on the host page) forces relay-only mode to verify the TURN server.
- Host keeps its PeerJS registration after a guest failure or hang-up; the permanent link works again without pressing «Пригласить».
- A newer guest attempt replaces an older unfinished one on the host (previously the second attempt was rejected as a duplicate).
- `peer-unavailable` (host offline / Safari in background) no longer consumes WebRTC attempts; the guest keeps searching for about 4 minutes. The page reconnects to PeerJS when it becomes visible again.
- Reconnect counter fixed; invite link becomes visible when share and clipboard both fail; debug styles moved to `style.css` (CSP blocked inline styles).
- Tested in two Chromium instances with a local PeerJS server: direct connection, host offline then online, no direct route (relay-only without TURN), guest hang-up and rejoin. Not tested on real iPhones.


## Cloudflare TURN (2026-11-05)
- `middleware.js` (Vercel Routing Middleware, root of the project, no `api/` folder) answers `GET /api/turn` with short-lived credentials from Cloudflare Realtime TURN (`generate-ice-servers`). Port 53 URLs are removed, as Cloudflare documents they are blocked by browsers. `package.json` only sets `"type": "module"`, which Vercel requires for middleware without a framework.
- Vercel environment variables (Production and Preview), then redeploy:
  - `CLOUDFLARE_TURN_KEY_ID` — Turn Token ID of the TURN key
  - `CLOUDFLARE_TURN_API_TOKEN` — API token of the TURN key (never commit it)
  - `TURN_TTL_SECONDS` — optional, default 43200 (12 h)
- Both devices fetch credentials before creating the Peer. The host refreshes them every 2 hours (and when the page becomes visible) by updating `peer.options.config`, which PeerJS reads for every new connection.
- If `/api/turn` fails the app continues with STUN only; the debug line shows `TURN: no (<reason>)`, e.g. `not-configured`, `cloudflare-401`, `http-404`.
- The connection label shows `● Соединение через TURN` when the selected candidate pair uses the relay.
- Cross-site requests to `/api/turn` are refused (Sec-Fetch-Site). This blocks other web pages, not scripted clients; Cloudflare usage is visible in its dashboard.
- Tested locally: middleware with mocked Cloudflare responses; two Chromium instances through a local TURN server in relay-only mode; fallback with `/api/turn` missing. Not yet tested against the real Cloudflare API or on iPhones.
