# Single container: the FastAPI backend serves the built React app and /api on one port.
# Used by Coolify (Build Pack: Dockerfile). See docs/DEPLOY_COOLIFY.md.

# ---- Stage 1: build the frontend -------------------------------------------------------
FROM node:22-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
# postinstall (scripts/setup-assets.mjs) copies the MediaPipe wasm + OpenCV.js into public/ and
# downloads the hand-landmarker model (sha256-checked) if models/ is absent, so the build needs
# outbound internet once. Nothing is fetched at runtime.
COPY frontend/scripts ./scripts
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- Stage 2: runtime ----------------------------------------------------------------------
FROM python:3.11-slim AS runtime
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1
WORKDIR /app

# Runtime dependencies only (the pinned file also lists test and lint tools).
COPY backend/requirements.txt /tmp/requirements.txt
RUN grep -Ev '^(pytest|ruff|httpx)==' /tmp/requirements.txt > /tmp/runtime.txt \
    && pip install -r /tmp/runtime.txt \
    && rm /tmp/requirements.txt /tmp/runtime.txt

# REPO_ROOT is resolved from the package location, so keep the repo layout: /app/backend,
# /app/config, /app/frontend/dist. The calibration config is baked into the image, unchanged.
COPY backend/glovesize ./backend/glovesize
COPY config ./config
COPY --from=frontend /app/frontend/dist ./frontend/dist

# /data: where study records go when validation mode is switched on (a Coolify persistent volume mounted there starts
# out owned by this user, so the app can write to it). Unused, and empty, while validation mode is off.
RUN useradd --no-create-home --uid 10001 app && mkdir -p /data && chown app /data
USER app
ENV PYTHONPATH=/app/backend PORT=8000
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import os,urllib.request;urllib.request.urlopen('http://127.0.0.1:%s/api/health'%os.environ.get('PORT','8000'),timeout=4)"

# No --proxy-headers: the operator endpoints refuse proxied requests on purpose (they are off
# by default here), and uvicorn's default only trusts forwarded headers from 127.0.0.1.
CMD ["sh", "-c", "exec python -m uvicorn glovesize.api:app --host 0.0.0.0 --port ${PORT}"]
