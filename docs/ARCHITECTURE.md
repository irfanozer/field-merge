# Architecture and merge design

## System boundaries

FieldMerge has four clear state owners:

1. A browser replica owns edits created on that tablet while it is offline.
2. The FastAPI service validates operations and applies deterministic merge
   policies.
3. PostgreSQL owns the canonical operation log, snapshots, and materialized
   document state.
4. WebSocket connections receive notifications about state that has already
   committed; they do not create authoritative state.

The browser can disappear between any two requests. A pending operation keeps
the same UUID and actor counter across retries, allowing the API to treat an
uncertain delivery as an idempotent retry.

## Causality, not arrival time

An operation dot is `(actor_id, actor_counter)`. Its `context` is the version
vector the device had observed before it created the operation.

For operation A and operation B:

- A happened before B when B's context contains A's dot.
- B happened before A when A's context contains B's dot.
- Otherwise they are concurrent.

The server sequence is useful for storage, inspection, and incremental
transport. It is not used to decide which concurrent edit wins. This distinction
is why reconnecting Tablet South before Tablet North produces the same merged
record as the opposite order.

## Field policies

`site_name`, `priority`, and `status` are scalar registers. When two maximal
operations are concurrent, a stable comparison of their operation dots selects
the visible value. The losing operation remains inspectable in the log.

`observation` is a multi-value register. Concurrent maximal values are returned
as an explicit conflict because combining or choosing those sentences would
invent user intent. A `resolve` operation is valid only when its context covers
all conflict candidates known to the server.

Merge policy is selected by the server's schema, never by arbitrary text sent
from a client.

## Synchronization transaction

`POST /api/v1/documents/{document_id}/sync` performs one database transaction:

1. Lock the document's synchronization row.
2. Validate each pending operation and its actor counter.
3. Insert unseen operations; classify identical retries as duplicates.
4. Recompute affected fields from causally maximal operations.
5. Advance the authoritative version vector and server sequence.
6. Persist materialized state and its canonical SHA-256 digest.
7. Commit.
8. Publish a WebSocket notification containing the committed snapshot.

The response includes operations the requesting replica has not covered in its
known vector. The device applies those operations locally, updates its known
vector, and persists the replica before clearing acknowledged queue items.

## Idempotency invariants

- An operation UUID identifies one immutable envelope.
- One actor/counter dot identifies one immutable operation.
- Re-sending the same envelope does not create a second log row.
- Reusing an UUID or dot with different content is rejected.
- Applying the same set of valid operations in any order yields the same state.

These rules cover the common "the connection failed after the server may have
committed" case without requiring a distributed transaction with a device.

## Snapshot and compaction path

Incremental synchronization is ideal while the client vector is covered by the
retained operation window. Compaction records the current materialized state,
version vector, digest, and server sequence as a snapshot.

When a replica is older than the retained log, the server responds in snapshot
mode. The client installs that snapshot, applies operations after the snapshot,
then submits its own pending operations. Pending operations are not discarded
merely because the server compacted history.

## Failure behavior

| Failure | Observable behavior |
| --- | --- |
| Browser offline | Edits remain in the local operation queue |
| Response lost after commit | Same operation retries and is classified duplicate |
| Devices reconnect in reverse order | Final digest remains identical |
| Concurrent observation edits | Both candidates remain visible |
| Stale conflict resolution | Rejected until it covers every current candidate |
| WebSocket interruption | HTTP sync remains authoritative; reconnect refreshes state |
| Old client after compaction | Snapshot catch-up replaces missing retained history |

## Data trust boundary

Browser timestamps and labels are descriptive only. The backend validates IDs,
allowed actors, operation kinds, fields, counters, context shape, and payload
limits. PostgreSQL constraints provide a second line of defense for uniqueness
and referential integrity.

