# Testing the app on a real Android phone (HTTPS, same Wi-Fi)

The camera only works on a secure origin, so the phone must open the app over HTTPS. This path serves the
**production build** (the same optimised code Vercel serves) from your PC through one HTTPS address, and keeps the
backend private on the PC.

## How the pieces connect

```
Android Chrome ──HTTPS──▶ vite preview on the PC (:4173, self-signed certificate)
                              │  serves the built app; forwards /api/* to ...
                              └──HTTP, inside the PC only──▶ backend (127.0.0.1:8010)
```

* The built app contains **no API address**. Every request is a relative `/api/...` path, so the phone always talks to
  the page's own origin. There is nothing for the phone to resolve as `localhost`, and no HTTPS-to-HTTP mixed content
  (the HTTP hop is inside the PC). CORS never applies (same origin; the backend only enables CORS when
  `GLOVESIZE_CORS_ORIGINS` is set, and it is not).
* `GLOVESIZE_API_URL` is read **only** by `vite.config.ts`, **when the preview/dev server starts**, as the proxy target.
  It is not a build-time variable: you do not need to set it before `npm run build`.
* The backend listens on `127.0.0.1` only, so it is unreachable from the Wi-Fi and the internet. Only the preview
  port is open to the LAN.
* Operator endpoints (validation, research and pilot records) stay protected. They are switched off by default
  (validation answers "validation mode is disabled", the pilot "is not running"). When validation was switched on in a
  test, the backend answered the PC itself (loopback, `Host` localhost) with 200 and refused a request arriving through
  this proxy with the phone's `Host` (the PC's LAN address) with 403 "operator endpoints are restricted to localhost;
  set GLOVESIZE_OPERATOR_TOKEN to allow authenticated remote access". The customer scan flow works over the LAN.
* Port 8000 is already taken on this PC, so these commands use **8010** for the backend.

## Commands (PowerShell, two windows)

Window 1, the backend:

```powershell
cd C:\Users\pc\Downloads\OPEN-CV\backend
.venv\Scripts\python -m uvicorn glovesize.api:app --host 127.0.0.1 --port 8010
```

Window 2, the app (rebuild whenever the code changed; the API address is set only for the preview server):

```powershell
cd C:\Users\pc\Downloads\OPEN-CV\frontend
npm run build
$env:GLOVESIZE_API_URL = "http://127.0.0.1:8010"
npx vite preview --mode https --host --port 4173
```

Find the PC's Wi-Fi address (it changes between networks; it was 10.62.16.175 when checked):

```powershell
ipconfig | Select-String "IPv4"
```

On the phone (same Wi-Fi, mobile data switched off so the phone does not leave the LAN):

1. Open Chrome and go to `https://<PC address>:4173/?debug` (the `?debug` shows the diagnostics panel on the scan screen).
2. Chrome warns the certificate is not trusted (it is self-signed). Tap **Advanced**, then **Proceed to ... (unsafe)**.
3. Tap **Start Scan**, confirm the coin, then **Start camera** and allow the camera.
4. Read the **Diagnostics** panel (it sits under the camera picture) while you scan.

If the page does not load:

* Windows firewall: allow **Node.js** on **Private** networks when Windows asks. In an administrator PowerShell, a rule
  can be added and removed afterwards (not run for you):
  `New-NetFirewallRule -DisplayName "OPEN-CV preview" -Direction Inbound -Protocol TCP -LocalPort 4173 -Action Allow -Profile Private`
  and `Remove-NetFirewallRule -DisplayName "OPEN-CV preview"`.
* The Wi-Fi must be a **Private** network in Windows, and the router must not isolate clients (guest Wi-Fi usually does).
* On `https://<PC address>:4173/api/health` you should see `{"status":"ok", ...}`; if you do not, the backend in
  window 1 is not running or `GLOVESIZE_API_URL` was not set in window 2.

## No certificate warning, over USB instead

Enable USB debugging on the phone, connect it, and:

```powershell
adb reverse tcp:4173 tcp:4173
cd C:\Users\pc\Downloads\OPEN-CV\frontend
$env:GLOVESIZE_API_URL = "http://127.0.0.1:8010"
npx vite preview --host 127.0.0.1 --port 4173
```

Open `http://localhost:4173/?debug` on the phone: `localhost` counts as a secure origin, so the camera works with no
warning, and the phone's console is visible in desktop Chrome at `chrome://inspect`.

## What the Diagnostics panel shows

`page` (origin, secure context), `device`, `api` (a live request to this page's own `/api/health`: status, milliseconds,
version), `camera` (state, stream size and frame rate, facing, mirrored), `hand`, `coin` (with the reasons it is not
accepted), `frames` (accepted out of target), `checks`, `problem`, `scale`, `tilt`, `3d layer` (on, or why it is off,
with its cost and level), `3d card`, and `webgl` (context lost or creation errors, with times).

## Stop when finished

Close both windows (Ctrl+C). Nothing is exposed afterwards.

## What this does not prove

Fake-camera and software-WebGL tests cannot show that a given Android phone's camera, GPU or browser works. Only a scan
on the real phone can.
