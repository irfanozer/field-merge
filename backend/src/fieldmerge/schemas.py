from datetime import datetime
from enum import StrEnum
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

ActorId = Annotated[str, Field(min_length=1, max_length=64, pattern=r"^[a-zA-Z0-9_-]+$")]
DocumentId = Annotated[str, Field(min_length=1, max_length=128, pattern=r"^[a-zA-Z0-9_-]+$")]
VersionVector = dict[str, Annotated[int, Field(ge=0)]]


class MergeField(StrEnum):
    SITE_NAME = "site_name"
    PRIORITY = "priority"
    STATUS = "status"
    OBSERVATION = "observation"


class OperationKind(StrEnum):
    SET = "set"
    RESOLVE = "resolve"


class OperationInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    operation_id: UUID
    actor_id: ActorId
    actor_counter: Annotated[int, Field(ge=1)]
    context: VersionVector = Field(default_factory=dict)
    field: MergeField
    kind: OperationKind = OperationKind.SET
    value: Annotated[str, Field(min_length=1, max_length=4_000)]
    created_at: datetime

    @field_validator("value")
    @classmethod
    def strip_value(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("value cannot be blank")
        return stripped

    @model_validator(mode="after")
    def validate_operation(self) -> "OperationInput":
        if self.kind == OperationKind.RESOLVE and self.field != MergeField.OBSERVATION:
            raise ValueError("resolve operations are only valid for observation")
        if self.context.get(self.actor_id, 0) >= self.actor_counter:
            raise ValueError("an operation context cannot contain its own dot")
        return self


class OperationView(OperationInput):
    server_sequence: int
    received_at: datetime


class ConflictCandidate(BaseModel):
    operation_id: UUID
    actor_id: str
    actor_counter: int
    value: str
    created_at: datetime


class FieldConflict(BaseModel):
    field: Literal["observation"] = "observation"
    candidates: list[ConflictCandidate]


class MaterializedDocument(BaseModel):
    document_id: str
    state: dict[str, Any]
    conflicts: list[FieldConflict]
    version_vector: VersionVector
    state_digest: str
    server_sequence: int


class SyncRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    client_id: ActorId
    known_vector: VersionVector = Field(default_factory=dict)
    pending_operations: list[OperationInput] = Field(default_factory=list)


class SnapshotView(BaseModel):
    document_id: str
    server_sequence: int
    state: dict[str, Any]
    conflicts: list[FieldConflict]
    version_vector: VersionVector
    state_digest: str
    created_at: datetime


class SyncResponse(MaterializedDocument):
    accepted_operation_ids: list[UUID]
    duplicate_operation_ids: list[UUID]
    operations: list[OperationView]
    sync_mode: Literal["incremental", "snapshot"]
    snapshot: SnapshotView | None = None


class OperationLogResponse(BaseModel):
    document_id: str
    operations: list[OperationView]
    count: int


class CompactResponse(BaseModel):
    snapshot: SnapshotView
    retained_audit_operations: int


class ResetResponse(BaseModel):
    document: MaterializedDocument
    seeded_operation_ids: list[UUID]


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"
    service: str = "fieldmerge-backend"


class StreamMessage(BaseModel):
    type: Literal["document.committed"] = "document.committed"
    document: MaterializedDocument
