from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from fieldmerge.api import demo_router, documents_router, health_router
from fieldmerge.config import Settings, get_settings
from fieldmerge.db import create_engine, create_session_factory
from fieldmerge.models import Base
from fieldmerge.service import DEMO_DOCUMENT_ID, ServiceError, get_document, reset_demo
from fieldmerge.streams import StreamManager


def create_app(settings: Settings | None = None) -> FastAPI:
    configured = settings or get_settings()
    engine = create_engine(configured)
    session_factory = create_session_factory(engine)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        if configured.auto_create_schema:
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
        needs_seed = False
        async with session_factory() as session:
            try:
                await get_document(session, DEMO_DOCUMENT_ID)
            except ServiceError as exc:
                if exc.status_code != 404:
                    raise
                needs_seed = True
        if needs_seed:
            async with session_factory() as session:
                await reset_demo(session)
        yield
        await engine.dispose()

    application = FastAPI(
        title="FieldMerge API",
        version="0.1.0",
        description="Inspectable causal synchronization for intermittently connected devices.",
        lifespan=lifespan,
    )
    application.state.settings = configured
    application.state.engine = engine
    application.state.session_factory = session_factory
    application.state.stream_manager = StreamManager()
    application.add_middleware(
        CORSMiddleware,
        allow_origins=configured.cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type"],
    )
    application.include_router(health_router)
    application.include_router(documents_router)
    application.include_router(demo_router)

    @application.exception_handler(ServiceError)
    async def handle_service_error(_request: Request, exc: ServiceError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})

    return application


app = create_app()


def run() -> None:
    uvicorn.run("fieldmerge.main:app", host="0.0.0.0", port=8000, proxy_headers=True)


if __name__ == "__main__":
    run()
