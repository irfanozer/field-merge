from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, WebSocket, WebSocketDisconnect, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from fieldmerge.config import Settings
from fieldmerge.db import session_from_app
from fieldmerge.schemas import (
    CompactResponse,
    HealthResponse,
    MaterializedDocument,
    OperationLogResponse,
    ResetResponse,
    SyncRequest,
    SyncResponse,
)
from fieldmerge.service import (
    DEMO_DOCUMENT_ID,
    compact_document,
    get_document,
    get_operation_log,
    reset_demo,
    sync_document,
    websocket_payload,
)
from fieldmerge.streams import StreamManager

Session = Annotated[AsyncSession, Depends(session_from_app)]

health_router = APIRouter(tags=["health"])
documents_router = APIRouter(prefix="/api/v1/documents", tags=["documents"])
demo_router = APIRouter(prefix="/api/v1/demo", tags=["demo"])


def _require_public_demo_document(document_id: str, settings: Settings) -> None:
    if settings.public_demo_mode and document_id != DEMO_DOCUMENT_ID:
        from fieldmerge.service import ServiceError

        raise ServiceError(status.HTTP_404_NOT_FOUND, "document was not found")


@health_router.get("/health/live", response_model=HealthResponse)
async def live() -> HealthResponse:
    return HealthResponse()


@health_router.get("/health/ready", response_model=HealthResponse)
async def ready(session: Session) -> HealthResponse:
    await session.execute(text("SELECT 1"))
    return HealthResponse()


@documents_router.get("/{document_id}", response_model=MaterializedDocument)
async def read_document(
    document_id: str, request: Request, session: Session
) -> MaterializedDocument:
    _require_public_demo_document(document_id, request.app.state.settings)
    return await get_document(session, document_id)


@documents_router.post("/{document_id}/sync", response_model=SyncResponse)
async def synchronize(
    document_id: str,
    request_body: SyncRequest,
    request: Request,
    session: Session,
) -> SyncResponse:
    _require_public_demo_document(document_id, request.app.state.settings)
    if len(request_body.pending_operations) > request.app.state.settings.max_pending_operations:
        from fieldmerge.service import ServiceError

        raise ServiceError(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            "pending operation batch exceeds the configured limit",
        )
    response = await sync_document(
        session,
        document_id,
        request_body,
        max_log_operations=request.app.state.settings.max_log_operations,
    )
    manager: StreamManager = request.app.state.stream_manager
    document = MaterializedDocument.model_validate(response.model_dump())
    await manager.broadcast(document_id, websocket_payload(document))
    return response


@documents_router.get(
    "/{document_id}/operations",
    response_model=OperationLogResponse,
)
async def read_operation_log(
    document_id: str,
    request: Request,
    session: Session,
    limit: Annotated[int, Query(ge=1, le=10_000)] = 1_000,
) -> OperationLogResponse:
    _require_public_demo_document(document_id, request.app.state.settings)
    return await get_operation_log(session, document_id, limit=limit)


@documents_router.post("/{document_id}/compact", response_model=CompactResponse)
async def compact(document_id: str, request: Request, session: Session) -> CompactResponse:
    _require_public_demo_document(document_id, request.app.state.settings)
    return await compact_document(session, document_id)


@demo_router.post("/reset", response_model=ResetResponse)
async def reset(request: Request, session: Session) -> ResetResponse:
    response = await reset_demo(session)
    manager: StreamManager = request.app.state.stream_manager
    await manager.broadcast(DEMO_DOCUMENT_ID, websocket_payload(response.document))
    return response


@documents_router.websocket("/{document_id}/stream")
async def stream_document(document_id: str, websocket: WebSocket) -> None:
    settings = websocket.app.state.settings
    if settings.public_demo_mode:
        origin = websocket.headers.get("origin")
        origin_allowed = origin is not None and (
            "*" in settings.cors_origins or origin in settings.cors_origins
        )
        if document_id != DEMO_DOCUMENT_ID or not origin_allowed:
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return
    manager: StreamManager = websocket.app.state.stream_manager
    factory: async_sessionmaker[AsyncSession] = websocket.app.state.session_factory
    await manager.connect(document_id, websocket)
    try:
        async with factory() as session:
            initial = await get_document(session, document_id)
        await websocket.send_json(websocket_payload(initial))
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await manager.disconnect(document_id, websocket)
