"""Exercise the actual private AWS proxy; the CI overlay is loopback-only.

This check uses real local containers, not AWS or GitHub. The public release
check separately exercises CloudFront, origin TLS, and Caddy's secret guard.
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse

import httpx
import websockets
from websockets.exceptions import InvalidStatus

ROOT = Path(__file__).resolve().parents[2]


async def verify_origin_boundary(base_url: str) -> None:
    async with httpx.AsyncClient(base_url=base_url, timeout=15) as client:
        response = await client.get(
            "/api/v1/documents/inspection-pump-07", headers={"Origin": base_url}
        )
        response.raise_for_status()
        if response.headers.get("access-control-allow-origin") != base_url:
            raise AssertionError(
                "The approved browser Origin was not preserved through Nginx"
            )

    endpoint = (
        f"ws://{urlparse(base_url).netloc}/api/v1/documents/inspection-pump-07/stream"
    )
    for origin in ("https://untrusted.invalid", None):
        try:
            async with websockets.connect(endpoint, origin=origin, open_timeout=10):
                raise AssertionError(
                    f"Unsafe WebSocket Origin was accepted: {origin!r}"
                )
        except InvalidStatus as error:
            if error.response.status_code != 403:
                raise AssertionError(
                    "Expected an explicit 403 for an unsafe Origin"
                ) from error


def main() -> None:
    base_url = os.environ.get("FIELDMERGE_SMOKE_URL", "").rstrip("/")
    if base_url != "http://127.0.0.1:18080":
        raise ValueError(
            "The AWS runtime CI check may contact only its loopback fixture"
        )
    subprocess.run([sys.executable, str(ROOT / "scripts/smoke.py")], check=True)
    asyncio.run(verify_origin_boundary(base_url))
    print("AWS runtime proxy passed HTTP, database, WebSocket, and Origin checks.")


if __name__ == "__main__":
    main()
