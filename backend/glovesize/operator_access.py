"""Access control for operator-only endpoints (validation mode and research records).

These endpoints store and delete study data, so being switched on is not enough to use them:

* **No token configured (default):** only direct requests from this machine are served. The
  client address must be loopback, the ``Host`` header must name localhost (this blocks DNS
  rebinding from a web page), and requests carrying proxy headers are refused, because behind a
  reverse proxy every client looks local.
* **``GLOVESIZE_OPERATOR_TOKEN`` set (at least 32 characters):** requests from anywhere must
  send ``Authorization: Bearer <token>``. Use this only behind HTTPS.
* **State-changing requests** (POST, DELETE) must also send ``X-Glovesize-Operator: 1``. A
  custom header forces a CORS preflight, so another web page cannot submit or delete records
  through the operator's browser.
"""

from __future__ import annotations

import hmac
import ipaddress
import os
from typing import Literal

from fastapi import HTTPException, Request

TOKEN_ENV = "GLOVESIZE_OPERATOR_TOKEN"
MIN_TOKEN_LENGTH = 32
CSRF_HEADER = "x-glovesize-operator"
# Any of these means the request came through a proxy or tunnel (e.g. Cloudflare Tunnel), not
# from a browser on this machine.
PROXY_HEADERS = (
    "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip",
    "cf-connecting-ip", "cf-ray", "true-client-ip", "cdn-loop",
)  # fmt: skip
LOCAL_HOSTNAMES = {"localhost", "127.0.0.1", "::1"}


def operator_token() -> str | None:
    token = os.environ.get(TOKEN_ENV, "").strip()
    if not token:
        return None
    if len(token) < MIN_TOKEN_LENGTH:
        raise ValueError(f"{TOKEN_ENV} must be at least {MIN_TOKEN_LENGTH} characters")
    return token


def access_mode() -> Literal["localhost", "token"]:
    return "token" if operator_token() else "localhost"


def _is_loopback(host: str | None) -> bool:
    try:
        return host is not None and ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _host_name(request: Request) -> str:
    host = request.headers.get("host", "")
    if host.startswith("["):  # [::1]:8080
        return host[1 : host.find("]")]
    return host.rsplit(":", 1)[0] if host.count(":") == 1 else host


def require_operator(request: Request) -> None:
    """Raise 401/403 unless the request may use operator endpoints (see module docstring)."""
    if request.method not in ("GET", "HEAD") and request.headers.get(CSRF_HEADER) != "1":
        raise HTTPException(status_code=403, detail=f"missing {CSRF_HEADER} header")
    token = operator_token()
    if token is not None:
        sent = request.headers.get("authorization", "")
        if not hmac.compare_digest(sent.encode(), f"Bearer {token}".encode()):
            raise HTTPException(
                status_code=401, detail="operator token required", headers={"WWW-Authenticate": "Bearer"}
            )
        return
    local = (
        _is_loopback(request.client.host if request.client else None)
        and _host_name(request).lower() in LOCAL_HOSTNAMES
        and not any(h in request.headers for h in PROXY_HEADERS)
    )
    if not local:
        raise HTTPException(
            status_code=403,
            detail=f"operator endpoints are restricted to localhost; set {TOKEN_ENV} to allow authenticated remote access",
        )
