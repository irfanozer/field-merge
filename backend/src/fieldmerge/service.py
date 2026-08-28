from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any, cast
from uuid import NAMESPACE_URL, UUID, uuid5

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from fieldmerge.domain import (
    DomainOperation,
    materialize,
    operation_is_covered,
    resolution_covers_candidates,
    unresolved_observation_candidates,
    vector_covers,
)
from fieldmerge.models import DocumentRecord, OperationRecord, SnapshotRecord
from fieldmerge.schemas import (
    CompactResponse,
    FieldConflict,
    MaterializedDocument,
    MergeField,
    OperationInput,
    OperationKind,
    OperationLogResponse,
    OperationView,
    ResetResponse,
    SnapshotView,
    SyncRequest,
    SyncResponse,
)

DEMO_DOCUMENT_ID = "inspection-pump-07"


class ServiceError(Exception):
    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def _domain(record: OperationRecord) -> DomainOperation:
    return DomainOperation(
        operation_id=record.operation_id,
        actor_id=record.actor_id,
        actor_counter=record.actor_counter,
        context=dict(record.context),
        field=record.field,
        kind=record.kind,
        value=record.value,
        created_at=record.created_at,
    )


def _view(record: OperationRecord) -> OperationView:
    return OperationView(
        operation_id=UUID(record.operation_id),
        actor_id=record.actor_id,
        actor_counter=record.actor_counter,
        context=dict(record.context),
        field=record.field,
        kind=record.kind,
        value=record.value,
        created_at=record.created_at,
        server_sequence=record.server_sequence,
        received_at=record.received_at,
    )


def _snapshot_view(snapshot: SnapshotRecord) -> SnapshotView:
    return SnapshotView(
        document_id=snapshot.document_id,
        server_sequence=snapshot.server_sequence,
        state=dict(snapshot.state),
        conflicts=[FieldConflict.model_validate(item) for item in snapshot.conflicts],
        version_vector=dict(snapshot.version_vector),
        state_digest=snapshot.state_digest,
        created_at=snapshot.created_at,
    )


def _document_view(document: DocumentRecord) -> MaterializedDocument:
    return MaterializedDocument(
        document_id=document.document_id,
        state=dict(document.state),
        conflicts=[FieldConflict.model_validate(item) for item in document.conflicts],
        version_vector=dict(document.version_vector),
        state_digest=document.state_digest,
        server_sequence=document.latest_sequence,
    )


async def _get_document(
    session: AsyncSession, document_id: str, *, lock: bool = False
) -> DocumentRecord | None:
    statement = select(DocumentRecord).where(DocumentRecord.document_id == document_id)
    if lock:
        statement = statement.with_for_update()
    return cast(DocumentRecord | None, await session.scalar(statement))


async def _get_operations(session: AsyncSession, document_id: str) -> list[OperationRecord]:
    rows = await session.scalars(
        select(OperationRecord)
        .where(OperationRecord.document_id == document_id)
        .order_by(OperationRecord.server_sequence)
    )
    return list(rows)


def _record_matches_input(record: OperationRecord, operation: OperationInput) -> bool:
    return (
        record.actor_id == operation.actor_id
        and record.actor_counter == operation.actor_counter
        and dict(record.context) == dict(operation.context)
        and record.field == operation.field.value
        and record.kind == operation.kind.value
        and record.value == operation.value
        and _normalized_timestamp(record.created_at) == _normalized_timestamp(operation.created_at)
    )


def _normalized_timestamp(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value
    return value.astimezone(UTC).replace(tzinfo=None)


def _record_from_input(document_id: str, operation: OperationInput) -> OperationRecord:
    return OperationRecord(
        operation_id=str(operation.operation_id),
        document_id=document_id,
        actor_id=operation.actor_id,
        actor_counter=operation.actor_counter,
        context=dict(operation.context),
        field=operation.field.value,
        kind=operation.kind.value,
        value=operation.value,
        created_at=operation.created_at,
    )


async def get_document(session: AsyncSession, document_id: str) -> MaterializedDocument:
    document = await _get_document(session, document_id)
    if document is None:
        raise ServiceError(404, f"document '{document_id}' was not found")
    return _document_view(document)


async def sync_document(
    session: AsyncSession,
    document_id: str,
    request: SyncRequest,
    *,
    max_log_operations: int = 10_000,
) -> SyncResponse:
    async with session.begin():
        document = await _get_document(session, document_id, lock=True)
        existing_records = await _get_operations(session, document_id)
        existing_domains = [_domain(record) for record in existing_records]

        if document is None:
            if not request.pending_operations:
                raise ServiceError(404, f"document '{document_id}' was not found")
            empty = materialize([])
            document = DocumentRecord(
                document_id=document_id,
                state=empty.state,
                conflicts=empty.conflicts,
                version_vector=empty.version_vector,
                state_digest=empty.state_digest,
            )
            session.add(document)
            await session.flush()

        by_id = {record.operation_id: record for record in existing_records}
        by_dot = {(record.actor_id, record.actor_counter): record for record in existing_records}
        accepted: list[OperationRecord] = []
        accepted_ids: list[UUID] = []
        duplicate_ids: list[UUID] = []
        working_domains = list(existing_domains)

        for operation in request.pending_operations:
            operation_id = str(operation.operation_id)
            duplicate = by_id.get(operation_id)
            if duplicate is not None:
                if not _record_matches_input(duplicate, operation):
                    raise ServiceError(
                        409,
                        f"operation_id {operation.operation_id} was reused with different content",
                    )
                duplicate_ids.append(operation.operation_id)
                continue

            dot = (operation.actor_id, operation.actor_counter)
            dot_owner = by_dot.get(dot)
            if dot_owner is not None:
                raise ServiceError(
                    409,
                    "operation dot "
                    f"({operation.actor_id}, {operation.actor_counter}) already belongs to "
                    f"{dot_owner.operation_id}",
                )

            if len(existing_records) + len(accepted) >= max_log_operations:
                raise ServiceError(
                    413,
                    "operation log has reached the configured limit; reset the demo before "
                    "accepting another change",
                )

            domain_operation = DomainOperation.from_input(operation)
            if operation.kind == OperationKind.RESOLVE:
                candidates = unresolved_observation_candidates(working_domains)
                if not candidates:
                    raise ServiceError(422, "there is no observation conflict to resolve")
                if not resolution_covers_candidates(domain_operation, candidates):
                    raise ServiceError(
                        422,
                        "resolution context must include every current observation candidate",
                    )

            record = _record_from_input(document_id, operation)
            session.add(record)
            accepted.append(record)
            accepted_ids.append(operation.operation_id)
            by_id[operation_id] = record
            by_dot[dot] = record
            working_domains.append(domain_operation)

        if accepted:
            await session.flush()

        all_records = [*existing_records, *accepted]
        all_records.sort(key=lambda record: record.server_sequence)
        materialized = materialize([_domain(record) for record in all_records])
        document.state = materialized.state
        document.conflicts = materialized.conflicts
        document.version_vector = materialized.version_vector
        document.state_digest = materialized.state_digest
        document.latest_sequence = (
            all_records[-1].server_sequence if all_records else document.latest_sequence
        )
        await session.flush()

        snapshot = await session.get(SnapshotRecord, document_id)
        use_snapshot = snapshot is not None and not vector_covers(
            request.known_vector, dict(snapshot.version_vector)
        )
        if use_snapshot:
            assert snapshot is not None
            returned_records = [
                record
                for record in all_records
                if record.server_sequence > snapshot.server_sequence
            ]
        else:
            returned_records = [
                record
                for record in all_records
                if not operation_is_covered(_domain(record), request.known_vector)
            ]

        response = SyncResponse(
            **_document_view(document).model_dump(),
            accepted_operation_ids=accepted_ids,
            duplicate_operation_ids=duplicate_ids,
            operations=[_view(record) for record in returned_records],
            sync_mode="snapshot" if use_snapshot else "incremental",
            snapshot=_snapshot_view(snapshot) if use_snapshot and snapshot else None,
        )

    return response


async def get_operation_log(
    session: AsyncSession, document_id: str, *, limit: int = 1_000
) -> OperationLogResponse:
    if await _get_document(session, document_id) is None:
        raise ServiceError(404, f"document '{document_id}' was not found")
    rows = await session.scalars(
        select(OperationRecord)
        .where(OperationRecord.document_id == document_id)
        .order_by(OperationRecord.server_sequence)
        .limit(limit)
    )
    operations = [_view(record) for record in rows]
    return OperationLogResponse(
        document_id=document_id,
        operations=operations,
        count=len(operations),
    )


async def compact_document(session: AsyncSession, document_id: str) -> CompactResponse:
    async with session.begin():
        document = await _get_document(session, document_id, lock=True)
        if document is None:
            raise ServiceError(404, f"document '{document_id}' was not found")
        snapshot = await session.get(SnapshotRecord, document_id)
        now = datetime.now(UTC)
        if snapshot is None:
            snapshot = SnapshotRecord(
                document_id=document_id,
                server_sequence=document.latest_sequence,
                state=dict(document.state),
                conflicts=list(document.conflicts),
                version_vector=dict(document.version_vector),
                state_digest=document.state_digest,
                created_at=now,
            )
            session.add(snapshot)
        else:
            snapshot.server_sequence = document.latest_sequence
            snapshot.state = dict(document.state)
            snapshot.conflicts = list(document.conflicts)
            snapshot.version_vector = dict(document.version_vector)
            snapshot.state_digest = document.state_digest
            snapshot.created_at = now
        document.snapshot_sequence = document.latest_sequence
        await session.flush()
        audit_count = await session.scalar(
            select(func.count(OperationRecord.server_sequence)).where(
                OperationRecord.document_id == document_id
            )
        )
        response = CompactResponse(
            snapshot=_snapshot_view(snapshot),
            retained_audit_operations=int(audit_count or 0),
        )
    return response


def _seed_inputs() -> list[OperationInput]:
    baseline_time = datetime(2026, 8, 28, 12, 0, tzinfo=UTC)
    values: Sequence[tuple[MergeField, str]] = (
        (MergeField.SITE_NAME, "North Pump Station"),
        (MergeField.PRIORITY, "High"),
        (MergeField.STATUS, "Inspection in progress"),
        (MergeField.OBSERVATION, "Seal is stable; monitor vibration."),
    )
    operations: list[OperationInput] = []
    for counter, (field, value) in enumerate(values, start=1):
        operations.append(
            OperationInput(
                operation_id=uuid5(
                    NAMESPACE_URL,
                    f"fieldmerge:{DEMO_DOCUMENT_ID}:seed:{counter}",
                ),
                actor_id="baseline",
                actor_counter=counter,
                context={"baseline": counter - 1} if counter > 1 else {},
                field=field,
                kind=OperationKind.SET,
                value=value,
                created_at=baseline_time,
            )
        )
    return operations


async def reset_demo(session: AsyncSession) -> ResetResponse:
    seeded = _seed_inputs()
    async with session.begin():
        await session.execute(
            delete(SnapshotRecord).where(SnapshotRecord.document_id == DEMO_DOCUMENT_ID)
        )
        await session.execute(
            delete(OperationRecord).where(OperationRecord.document_id == DEMO_DOCUMENT_ID)
        )
        await session.execute(
            delete(DocumentRecord).where(DocumentRecord.document_id == DEMO_DOCUMENT_ID)
        )
        empty = materialize([])
        document = DocumentRecord(
            document_id=DEMO_DOCUMENT_ID,
            state=empty.state,
            conflicts=empty.conflicts,
            version_vector=empty.version_vector,
            state_digest=empty.state_digest,
        )
        session.add(document)
        await session.flush()
        records = [_record_from_input(DEMO_DOCUMENT_ID, operation) for operation in seeded]
        session.add_all(records)
        await session.flush()
        merged = materialize([_domain(record) for record in records])
        document.state = merged.state
        document.conflicts = merged.conflicts
        document.version_vector = merged.version_vector
        document.state_digest = merged.state_digest
        document.latest_sequence = records[-1].server_sequence
        await session.flush()
        response = ResetResponse(
            document=_document_view(document),
            seeded_operation_ids=[operation.operation_id for operation in seeded],
        )
    return response


def websocket_payload(document: MaterializedDocument) -> dict[str, Any]:
    return {"type": "document.committed", "document": document.model_dump(mode="json")}
