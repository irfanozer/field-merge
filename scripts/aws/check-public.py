"""Verify the public AWS entry point, then exercise persisted synchronization.

The synchronization test resets the fixed fictional inspection before and after
its run. Do not use this check against a database containing real field work.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit

import httpx


def base_url() -> str:
    value = os.environ.get("FIELDMERGE_SMOKE_URL", "").rstrip("/")
    parsed = urlsplit(value)
    local_http = parsed.scheme == "http" and parsed.hostname in {
        "localhost",
        "127.0.0.1",
        "::1",
    }
    if (
        not parsed.hostname
        or (parsed.scheme != "https" and not local_http)
        or parsed.username
        or parsed.password
        or parsed.path
        or parsed.query
        or parsed.fragment
    ):
        raise RuntimeError(
            "FIELDMERGE_SMOKE_URL must be an HTTPS origin, or HTTP localhost for testing"
        )
    return value


def check_entrypoints(client: httpx.Client) -> None:
    page = client.get("/")
    page.raise_for_status()
    if (
        "text/html" not in page.headers.get("content-type", "")
        or "FieldMerge" not in page.text
    ):
        raise RuntimeError("The public entry point did not return the FieldMerge page")

    required_headers = {
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "referrer-policy": "strict-origin-when-cross-origin",
    }
    for header, expected in required_headers.items():
        if page.headers.get(header, "").lower() != expected.lower():
            raise RuntimeError(f"Missing or unexpected browser protection: {header}")
    csp = page.headers.get("content-security-policy", "")
    for rule in ("default-src 'self'", "frame-ancestors 'none'", "wss:"):
        if rule not in csp:
            raise RuntimeError(f"The content security policy is missing {rule}")
    if "max-age=" not in page.headers.get("strict-transport-security", ""):
        raise RuntimeError("The entry point is missing HTTP Strict Transport Security")
    if "camera=()" not in page.headers.get("permissions-policy", ""):
        raise RuntimeError("The entry point is missing its permissions policy")

    for path in ("/healthz", "/health/ready", "/api/v1/documents/inspection-pump-07"):
        response = client.get(path)
        response.raise_for_status()
        if "no-store" not in response.headers.get("cache-control", "").lower():
            raise RuntimeError(f"Dynamic response does not prohibit caching: {path}")
        if "hit from cloudfront" in response.headers.get("x-cache", "").lower():
            raise RuntimeError(f"CloudFront returned a cached dynamic response: {path}")
        if response.headers.get("age", "0") != "0":
            raise RuntimeError(f"Dynamic response has a nonzero cache age: {path}")
        if path != "/healthz":
            if "application/json" not in response.headers.get("content-type", ""):
                raise RuntimeError(
                    f"API response was replaced with a frontend page: {path}"
                )
            response.json()


def main() -> None:
    target = base_url()
    print(
        "Checking FieldMerge HTML, browser protections, readiness, and uncached API..."
    )
    with httpx.Client(base_url=target, timeout=20, follow_redirects=False) as client:
        check_entrypoints(client)
    print("Checking a real saved edit and its matching WebSocket update...")
    subprocess.run(
        [sys.executable, str(Path(__file__).resolve().parents[1] / "smoke.py")],
        env={**os.environ, "FIELDMERGE_SMOKE_URL": target},
        check=True,
    )
    print("FieldMerge public deployment checks passed.")


if __name__ == "__main__":
    main()
