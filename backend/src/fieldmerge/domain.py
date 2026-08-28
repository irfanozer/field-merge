import hashlib
import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from fieldmerge.schemas import MergeField, OperationInput, OperationKind


@dataclass(frozen=True, slots=True)
class DomainOperation:
    operation_id: str
    actor_id: str
    actor_counter: int
    context: dict[str, int]
    field: str
    kind: str
    value: str
    created_at: datetime

    @classmethod
    def from_input(cls, operation: OperationInput) -> "DomainOperation":
        return cls(
            operation_id=str(operation.operation_id),
            actor_id=operation.actor_id,
            actor_counter=operation.actor_counter,
            context=dict(operation.context),
            field=operation.field.value,
            kind=operation.kind.value,
            value=operation.value,
            created_at=operation.created_at,
        )


@dataclass(frozen=True, slots=True)
class Materialized:
    state: dict[str, Any]
    conflicts: list[dict[str, Any]]
    version_vector: dict[str, int]
    state_digest: str


def happened_before(first: DomainOperation, second: DomainOperation) -> bool:
    """Return whether ``second`` had observed ``first`` before it was created."""

    return second.context.get(first.actor_id, 0) >= first.actor_counter


def causally_maximal(operations: list[DomainOperation]) -> list[DomainOperation]:
    """Remove operations superseded by a causally later operation."""

    return [
        candidate
        for candidate in operations
        if not any(
            candidate.operation_id != other.operation_id and happened_before(candidate, other)
            for other in operations
        )
    ]


def stable_dot_key(operation: DomainOperation) -> tuple[int, str, str]:
    """Stable tie-breaker for concurrent scalar operations."""

    return operation.actor_counter, operation.actor_id, operation.operation_id


def operation_is_covered(operation: DomainOperation, vector: dict[str, int]) -> bool:
    return vector.get(operation.actor_id, 0) >= operation.actor_counter


def vector_covers(covering: dict[str, int], covered: dict[str, int]) -> bool:
    return all(covering.get(actor, 0) >= counter for actor, counter in covered.items())


def build_version_vector(operations: list[DomainOperation]) -> dict[str, int]:
    vector: dict[str, int] = {}
    for operation in operations:
        vector[operation.actor_id] = max(vector.get(operation.actor_id, 0), operation.actor_counter)
    return dict(sorted(vector.items()))


def materialize(operations: list[DomainOperation]) -> Materialized:
    """Materialize state from an unordered operation set.

    Server arrival sequence is deliberately absent from this algorithm. Causal
    context and the operation dot are the only ordering inputs.
    """

    operations = list({operation.operation_id: operation for operation in operations}.values())
    state: dict[str, Any] = {
        MergeField.SITE_NAME.value: None,
        MergeField.PRIORITY.value: None,
        MergeField.STATUS.value: None,
        MergeField.OBSERVATION.value: None,
    }
    conflicts: list[dict[str, Any]] = []

    for field in (
        MergeField.SITE_NAME.value,
        MergeField.PRIORITY.value,
        MergeField.STATUS.value,
    ):
        field_operations = [operation for operation in operations if operation.field == field]
        maxima = causally_maximal(field_operations)
        if maxima:
            state[field] = max(maxima, key=stable_dot_key).value

    observation_operations = [
        operation for operation in operations if operation.field == MergeField.OBSERVATION.value
    ]
    observation_maxima = sorted(causally_maximal(observation_operations), key=stable_dot_key)
    if len(observation_maxima) == 1:
        state[MergeField.OBSERVATION.value] = observation_maxima[0].value
    elif observation_maxima:
        state[MergeField.OBSERVATION.value] = None
        conflicts.append(
            {
                "field": MergeField.OBSERVATION.value,
                "candidates": [
                    {
                        "operation_id": operation.operation_id,
                        "actor_id": operation.actor_id,
                        "actor_counter": operation.actor_counter,
                        "value": operation.value,
                        "created_at": operation.created_at.isoformat(),
                    }
                    for operation in observation_maxima
                ],
            }
        )

    version_vector = build_version_vector(operations)
    digest_conflicts = [
        {
            "field": conflict["field"],
            "candidates": [
                {
                    key: candidate[key]
                    for key in ("operation_id", "actor_id", "actor_counter", "value")
                }
                for candidate in conflict["candidates"]
            ],
        }
        for conflict in conflicts
    ]
    digest_payload = {"conflicts": digest_conflicts, "state": state}
    digest = hashlib.sha256(
        json.dumps(digest_payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    return Materialized(
        state=state,
        conflicts=conflicts,
        version_vector=version_vector,
        state_digest=digest,
    )


def unresolved_observation_candidates(
    operations: list[DomainOperation],
) -> list[DomainOperation]:
    observations = [
        operation for operation in operations if operation.field == MergeField.OBSERVATION.value
    ]
    maxima = causally_maximal(observations)
    return maxima if len(maxima) > 1 else []


def resolution_covers_candidates(
    resolution: DomainOperation, candidates: list[DomainOperation]
) -> bool:
    if resolution.kind != OperationKind.RESOLVE.value:
        return False
    return all(happened_before(candidate, resolution) for candidate in candidates)


def _json_ready(value: object) -> object:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, list):
        return [_json_ready(item) for item in value]
    if isinstance(value, dict):
        return {key: _json_ready(item) for key, item in value.items()}
    return value
