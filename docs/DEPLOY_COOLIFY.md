# Deploying to Coolify (ocv.valgrowlabs.com)

One container serves everything: the FastAPI backend serves the built React app and `/api/*`
on the same origin, so there is no CORS setup and no separate frontend host. The root
`Dockerfile` builds it. This is an **unvalidated prototype**; nothing here changes the
measurement, calibration or validation settings.

## Coolify setup

1. **DNS.** Add an `A` record `ocv.valgrowlabs.com` pointing at the Coolify server's public IP
   (if the domain is on Cloudflare, start with the proxy off until the certificate is issued).
2. **New resource** → *Public/Private Repository* → pick `ValGrow-Labs/OPEN-CV`
   (private repos need the Coolify GitHub App or a deploy key), branch `main`.
3. **Build Pack:** `Dockerfile`. Base directory `/`. Dockerfile location `/Dockerfile`.
4. **Ports Exposes:** `8000`.
5. **Domains:** `https://ocv.valgrowlabs.com`. Coolify's proxy issues the Let's Encrypt
   certificate. HTTPS is required: the camera only works on a secure origin.
6. **Health check** (optional; the image already has one): path `/api/health`, port `8000`.
7. **Environment variables:** none are needed. Leave all `GLOVESIZE_*` variables unset. In
   particular do not set `GLOVESIZE_VALIDATION_ENABLED`, `GLOVESIZE_RESEARCH_ENABLED`,
   `GLOVESIZE_PILOT_REMOTE_ENABLED` or `GLOVESIZE_OPERATOR_TOKEN`: that keeps study-record
   collection off and no images or records are stored.
8. **Deploy.** The first build takes a few minutes (it installs npm packages and downloads the
   MediaPipe hand model once, sha256-checked).
9. Optional: enable *Auto Deploy* (GitHub webhook) so pushes to `main` redeploy.

## Check it

- `https://ocv.valgrowlabs.com/api/health` returns `{"status":"ok",...}`.
- Open the site on a phone, allow the camera, and run a scan.

## Notes

- The `/api` proxy is not trusting `X-Forwarded-*` headers on purpose: the operator-only
  endpoints refuse proxied requests, and they are off anyway.
- No volume is needed. The service stores nothing.
- The Vercel and Render deployments are unaffected. Retire them only when you decide to.
- To run the same image locally: `docker build -t glovesize .` then
  `docker run --rm -p 8000:8000 glovesize` and open http://localhost:8000
  (the camera works on `localhost`).
