"""Loopback-only WebSocket server for the real PowerShell client regression tests.

The fixture never loads FieldMerge, touches a database, or contacts a remote
service. It only returns synthetic snapshots and logs handshake/client events.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
from pathlib import Path

from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosed
from websockets.http11 import Request, Response

PREVIEW_ORIGIN = "https://preview.fieldmerge.invalid"
CUSTOM_ORIGIN = "https://fieldmerge.example.invalid"
DOCUMENT_ID = "inspection-pump-07"


async def run(ready_file: Path, log_file: Path) -> None:
    def record(**event: object) -> None:
        with log_file.open("a", encoding="utf-8") as log:
            log.write(json.dumps(event) + "\n")

    async def request_hook(
        connection: ServerConnection, request: Request
    ) -> Response | None:
        record(event="request", path=request.path, origin=request.headers.get("Origin"))
        if request.path == "/handshake-timeout":
            # A broken cancellation path is still bounded by this fixture.
            await asyncio.sleep(8)
        return None

    def response_hook(
        connection: ServerConnection, request: Request, response: Response
    ) -> None:
        record(event="response", path=request.path, status=response.status_code)

    async def handler(connection: ServerConnection) -> None:
        assert connection.request is not None
        path = connection.request.path
        record(event="connected", path=path)
        received = 0
        try:
            snapshot = {
                "type": "document.committed",
                "document": {"document_id": DOCUMENT_ID, "state": {"note": "fixture"}},
            }
            if path == "/wrong-document":
                snapshot["document"]["document_id"] = "not-the-demo"  # type: ignore[index]
            elif path == "/wrong-event":
                snapshot["type"] = "unexpected.event"
            elif path == "/early-close":
                await connection.close(code=1008, reason="fixture policy")
                return
            elif path == "/message-timeout":
                # Let client cancellation end this wait. A missing cancellation
                # cannot leave the local test process blocked indefinitely.
                await asyncio.wait_for(connection.wait_closed(), timeout=8)
                return

            payload = json.dumps(snapshot, ensure_ascii=False)
            if path == "/fragmented":
                # Exercise both WebSocket fragmentation and multiple 8192-byte
                # ReceiveAsync calls before EndOfMessage becomes true.
                payload = payload[:-1] + ', "padding": "' + ("x" * 20000) + '"}'
                await connection.send(
                    [payload[:23], payload[23:10240], payload[10240:]]
                )
            elif path == "/binary":
                await connection.send(payload.encode("utf-8"))
            else:
                await connection.send(payload)

            async for _message in connection:
                received += 1
                record(event="unexpected-client-message", path=path)
        except (ConnectionClosed, TimeoutError):
            pass
        finally:
            record(event="closed", path=path, client_messages=received)

    # Expected policy rejection and client Abort are test outcomes, not server
    # errors. Keep stderr usable for actual fixture startup diagnostics.
    logger = logging.getLogger("fieldmerge.websocket.fixture")
    logger.setLevel(logging.CRITICAL)
    async with serve(
        handler,
        "127.0.0.1",
        0,
        origins=[PREVIEW_ORIGIN, CUSTOM_ORIGIN],
        process_request=request_hook,
        process_response=response_hook,
        compression=None,
        ping_interval=None,
        close_timeout=1,
        logger=logger,
    ) as server:
        port = server.sockets[0].getsockname()[1]
        # Announce readiness atomically, after the loopback listener is active.
        pending_file = ready_file.with_suffix(".pending")
        pending_file.write_text(json.dumps({"port": port}), encoding="utf-8")
        pending_file.replace(ready_file)
        # Safety net if a failed test runner cannot terminate its child process.
        await asyncio.sleep(60)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ready-file", required=True, type=Path)
    parser.add_argument("--log-file", required=True, type=Path)
    args = parser.parse_args()
    asyncio.run(run(args.ready_file, args.log_file))


if __name__ == "__main__":
    main()
