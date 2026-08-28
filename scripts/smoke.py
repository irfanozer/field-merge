from __future__ import annotations

import asyncio
import json
import os
from datetime import UTC, datetime
from urllib.parse import urlparse
from uuid import uuid4

import httpx
import websockets

DOCUMENT_ID = "inspection-pump-07"


def required_base_url() -> str:
    value = os.environ.get("FIELDMERGE_SMOKE_URL", "").rstrip("/")
    if not value.startswith(("http://", "https://")):
        raise RuntimeError("FIELDMERGE_SMOKE_URL must be an absolute HTTP or HTTPS URL")
    return value


def websocket_url(base_url: str) -> str:
    parsed = urlparse(base_url)
    scheme = "wss" if parsed.scheme == "https" else "ws"
    return f"{scheme}://{parsed.netloc}/api/v1/documents/{DOCUMENT_ID}/stream"


async def run() -> None:
    base_url = required_base_url()
    operation_id = str(uuid4())
    async with httpx.AsyncClient(base_url=base_url, timeout=20) as client:
        reset = await client.post("/api/v1/demo/reset")
        reset.raise_for_status()
        document = await client.get(f"/api/v1/documents/{DOCUMENT_ID}")
        document.raise_for_status()
        snapshot = document.json()

        try:
            async with websockets.connect(
                websocket_url(base_url),
                origin=base_url,
                open_timeout=15,
                close_timeout=5,
            ) as stream:
                initial = json.loads(await asyncio.wait_for(stream.recv(), timeout=15))
                if initial.get("document", {}).get("document_id") != DOCUMENT_ID:
                    raise RuntimeError("WebSocket did not return the expected initial document")

                response = await client.post(
                    f"/api/v1/documents/{DOCUMENT_ID}/sync",
                    json={
                        "client_id": "release-smoke",
                        "known_vector": snapshot["version_vector"],
                        "pending_operations": [
                            {
                                "operation_id": operation_id,
                                "actor_id": "release-smoke",
                                "actor_counter": 1,
                                "context": snapshot["version_vector"],
                                "field": "status",
                                "kind": "set",
                                "value": "Release verification completed",
                                "created_at": datetime.now(UTC).isoformat(),
                            }
                        ],
                    },
                )
                response.raise_for_status()
                synchronized = response.json()
                if operation_id not in synchronized["accepted_operation_ids"]:
                    raise RuntimeError("The API did not accept the verification operation")

                committed = json.loads(await asyncio.wait_for(stream.recv(), timeout=15))
                if (
                    committed.get("document", {}).get("state_digest")
                    != synchronized["state_digest"]
                ):
                    raise RuntimeError("WebSocket and HTTP returned different committed states")

            operation_log = await client.get(f"/api/v1/documents/{DOCUMENT_ID}/operations")
            operation_log.raise_for_status()
            persisted_ids = {item["operation_id"] for item in operation_log.json()["operations"]}
            if operation_id not in persisted_ids:
                raise RuntimeError("The verification operation was not read back from PostgreSQL")
        finally:
            cleanup = await client.post("/api/v1/demo/reset")
            cleanup.raise_for_status()

    print("Live smoke test passed: HTTP, PostgreSQL, and WebSocket state agree.")


if __name__ == "__main__":
    asyncio.run(run())
