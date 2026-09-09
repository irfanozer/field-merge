import {
  BASELINE_STATE,
  type ActorId,
  type DocumentSnapshot,
  type EditableField,
  type InspectionState,
  type OperationEnvelope,
  type OperationKind,
  type Replica,
  type SyncResponse,
  type VersionVector,
} from "../types";

export function copyState(state: InspectionState): InspectionState {
  return { ...state };
}

export function copyVector(vector: VersionVector): VersionVector {
  return { ...vector };
}

export function createReplica(
  actorId: ActorId,
  snapshot?: DocumentSnapshot,
): Replica {
  const isNorth = actorId === "tablet-north";
  const vector = snapshot?.version_vector ?? {};
  return {
    actorId,
    label: isNorth ? "Tablet North" : "Tablet South",
    location: isNorth ? "Pump platform" : "Control room",
    online: true,
    state: copyState(snapshot?.state ?? BASELINE_STATE),
    vector: copyVector(vector),
    nextCounter: (vector[actorId] ?? 0) + 1,
    pending: [],
    digest: snapshot?.state_digest ?? null,
    lastSyncAt: snapshot ? new Date().toISOString() : null,
    lastSyncMode: snapshot ? "incremental" : null,
    conflicts: snapshot?.conflicts ?? [],
  };
}

export function queueOperation(
  replica: Replica,
  field: EditableField,
  value: string,
  kind: OperationKind = "set",
  operationId = crypto.randomUUID(),
  createdAt = new Date().toISOString(),
): Replica {
  const counter = replica.nextCounter;
  const operation: OperationEnvelope = {
    operation_id: operationId,
    actor_id: replica.actorId,
    actor_counter: counter,
    context: copyVector(replica.vector),
    field,
    kind,
    value,
    created_at: createdAt,
  };

  return {
    ...replica,
    state: { ...replica.state, [field]: value },
    vector: { ...replica.vector, [replica.actorId]: counter },
    nextCounter: counter + 1,
    pending: [...replica.pending, operation],
    digest: null,
  };
}

export function applySyncResponse(replica: Replica, response: SyncResponse): Replica {
  const completed = new Set([
    ...response.accepted_operation_ids,
    ...response.duplicate_operation_ids,
  ]);
  const remaining = replica.pending.filter(
    (operation) => !completed.has(operation.operation_id),
  );

  const snapshotBase = response.snapshot
    ? {
        state: copyState(response.snapshot.state),
        vector: copyVector(response.snapshot.version_vector),
      }
    : { state: copyState(replica.state), vector: copyVector(replica.vector) };

  // The response's top-level state is authoritative after all post-snapshot operations.
  // Starting from the snapshot here makes the catch-up transition explicit while the
  // final overlay avoids duplicating backend merge policy in an untrusted browser.
  const materializedState = { ...snapshotBase.state, ...response.state };
  const materializedVector = { ...snapshotBase.vector, ...response.version_vector };
  for (const operation of remaining) {
    materializedState[operation.field] = operation.value;
    materializedVector[operation.actor_id] = Math.max(
      materializedVector[operation.actor_id] ?? 0,
      operation.actor_counter,
    );
  }

  return {
    ...replica,
    state: materializedState,
    vector: materializedVector,
    nextCounter: Math.max(
      replica.nextCounter,
      (response.version_vector[replica.actorId] ?? 0) + 1,
    ),
    pending: remaining,
    digest: remaining.length ? null : response.state_digest,
    conflicts: response.conflicts,
    lastSyncAt: new Date().toISOString(),
    lastSyncMode: response.sync_mode,
  };
}

export function vectorLabel(vector: VersionVector): string {
  const entries = Object.entries(vector).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return "No operations seen";
  return entries
    .map(([actor, counter]) => `${actor.replace("tablet-", "")} ${counter}`)
    .join(" · ");
}

export function shortDigest(digest: string | null): string {
  if (!digest) return "Not verified";
  return digest.length > 16 ? `${digest.slice(0, 8)}…${digest.slice(-6)}` : digest;
}

export function shortOperationId(operationId: string): string {
  return operationId.length > 12 ? `${operationId.slice(0, 8)}…` : operationId;
}
