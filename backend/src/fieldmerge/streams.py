import asyncio
from collections import defaultdict
from typing import Any

from fastapi import WebSocket


class StreamManager:
    """In-process WebSocket fan-out for committed document notifications."""

    def __init__(self) -> None:
        self._connections: dict[str, set[WebSocket]] = defaultdict(set)
        self._lock = asyncio.Lock()

    async def connect(self, document_id: str, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            self._connections[document_id].add(websocket)

    async def disconnect(self, document_id: str, websocket: WebSocket) -> None:
        async with self._lock:
            connections = self._connections.get(document_id)
            if connections is None:
                return
            connections.discard(websocket)
            if not connections:
                self._connections.pop(document_id, None)

    async def broadcast(self, document_id: str, message: dict[str, Any]) -> None:
        async with self._lock:
            connections = tuple(self._connections.get(document_id, ()))
        stale: list[WebSocket] = []
        for websocket in connections:
            try:
                await websocket.send_json(message)
            except RuntimeError:
                stale.append(websocket)
        for websocket in stale:
            await self.disconnect(document_id, websocket)
