# FieldMerge synchronization contract

FieldMerge demonstrates one specific offline-first problem: two field tablets can
edit the same inspection while disconnected and later converge without silently
discarding either technician's work.

## Demo record

The built-in record is `inspection-pump-07`. It represents a shared equipment
inspection with these merge policies:

| Field | Policy | Behavior |
| --- | --- | --- |
| `site_name` | Last writer wins | Concurrent values use a stable operation-dot tie-breaker. |
| `priority` | Last writer wins | Concurrent values use a stable operation-dot tie-breaker. |
| `status` | Last writer wins | Concurrent values use a stable operation-dot tie-breaker. |
| `observation` | Multi-value register | Concurrent values remain visible until a person resolves them. |

The scalar policy is deterministic, not arrival-order dependent. The
`observation` policy deliberately exposes genuine ambiguity instead of inventing
an answer.

## Operation envelope

```json
{
  "operation_id": "UUID generated once on the device",
  "actor_id": "tablet-north",
  "actor_counter": 4,
  "context": {"tablet-north": 3, "tablet-south": 2},
  "field": "observation",
  "kind": "set",
  "value": "Seal leak is increasing.",
  "created_at": "2026-08-28T14:30:00Z"
}
```

`(actor_id, actor_counter)` is the operation dot. `context` is the version
vector the device had seen before making the edit. The server accepts an
operation at most once by `operation_id` and also rejects re-use of a dot for a
different operation.

An operation A happened before B when B's context contains A's dot. Operations
that do not contain one another are concurrent. Merge decisions are calculated
from causal relationships and stable identifiers, so reconnect order does not
change the final result.

`kind: "resolve"` is used only for a human-approved conflict resolution. Its
context must include every candidate being resolved.

## HTTP API

### `GET /api/v1/documents/{document_id}`

Returns the authoritative materialized record, its version vector, state digest,
latest server sequence, and any explicit conflicts.

### `POST /api/v1/documents/{document_id}/sync`

Request:

```json
{
  "client_id": "tablet-north",
  "known_vector": {"tablet-north": 3},
  "pending_operations": []
}
```

Response:

```json
{
  "document_id": "inspection-pump-07",
  "accepted_operation_ids": [],
  "duplicate_operation_ids": [],
  "operations": [],
  "version_vector": {},
  "state": {},
  "state_digest": "sha256",
  "server_sequence": 0,
  "sync_mode": "incremental"
}
```

The returned operations are every server operation not covered by the client's
known vector. A client applies them locally, advances its vector, and reaches the
same materialized state as the server.

### `GET /api/v1/documents/{document_id}/operations`

Returns the inspectable operation log in server-sequence order. Sequence is an
audit/transport cursor only; merge semantics do not depend on arrival order.

### `POST /api/v1/documents/{document_id}/compact`

Stores a snapshot at the current server sequence. Sync clients that are older
than the retained log receive `sync_mode: "snapshot"` with the snapshot and the
remaining operations.

### `POST /api/v1/demo/reset`

Resets only the fixed demonstration inspection and seeds its baseline. This is
kept separate from normal synchronization endpoints.

### `WS /api/v1/documents/{document_id}/stream`

Publishes committed document snapshots after synchronization. WebSocket messages
are notifications of already-persisted backend state, never browser-generated
proof.

## Frontend local replica

Each visible tablet owns a browser-persisted replica containing:

- its materialized record;
- its known version vector;
- its next actor counter; and
- operations queued while offline.

The guided proof disconnects both tablets, creates concurrent edits, reconnects
them in reverse order, displays the observation conflict, resolves it explicitly,
and then proves equality using the state digest returned by the backend.

## Non-goals

This is a synchronization-engine demonstration, not a complete field-service
product. Authentication, tenant isolation, attachments, and mobile packaging are
deployment/product concerns outside this build.
