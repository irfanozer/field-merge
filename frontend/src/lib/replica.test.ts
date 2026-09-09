import { describe, expect, it } from "vitest";
import type { DocumentSnapshot, SyncResponse } from "../types";
import { applySyncResponse, createReplica, queueOperation } from "./replica";

const snapshot: DocumentSnapshot = {
  document_id: "inspection-pump-07",
  state: {
    site_name: "North Pump Station",
    priority: "High",
    status: "Inspection in progress",
    observation: "Seal is stable; monitor vibration.",
  },
  conflicts: [],
  version_vector: { baseline: 4 },
  state_digest: "baseline-digest",
  server_sequence: 4,
};

describe("local replica", () => {
  it("preserves values and counters for edits that the server has not acknowledged", () => {
    const first = queueOperation(createReplica("tablet-north", snapshot), "observation", "First note.");
    const second = queueOperation(first, "observation", "A newer unsent note.");
    const response: SyncResponse = {
      ...snapshot,
      state: { ...snapshot.state, observation: "First note." },
      version_vector: { baseline: 4, "tablet-north": 1 },
      state_digest: "server-only-digest",
      accepted_operation_ids: [first.pending[0].operation_id],
      duplicate_operation_ids: [], operations: [], sync_mode: "incremental",
    };
    const updated = applySyncResponse(second, response);
    expect(updated.pending).toHaveLength(1);
    expect(updated.state.observation).toBe("A newer unsent note.");
    expect(updated.vector["tablet-north"]).toBe(2);
    expect(updated.digest).toBeNull();
    expect(updated.nextCounter).toBe(3);
  });

  it("creates an offline operation with the context known before its dot", () => {
    const replica = createReplica("tablet-north", snapshot);
    const edited = queueOperation(
      { ...replica, online: false },
      "observation",
      "Seal leak increased.",
      "set",
      "00000000-0000-4000-8000-000000000001",
      "2026-08-28T14:00:00.000Z",
    );

    expect(edited.pending).toHaveLength(1);
    expect(edited.pending[0]).toMatchObject({
      actor_id: "tablet-north",
      actor_counter: 1,
      context: { baseline: 4 },
      value: "Seal leak increased.",
    });
    expect(edited.vector).toEqual({ baseline: 4, "tablet-north": 1 });
    expect(edited.digest).toBeNull();
  });

  it("removes accepted work and adopts the authoritative digest", () => {
    const queued = queueOperation(
      createReplica("tablet-north", snapshot),
      "priority",
      "Urgent",
      "set",
      "00000000-0000-4000-8000-000000000002",
    );
    const response: SyncResponse = {
      ...snapshot,
      state: { ...snapshot.state, priority: "Urgent" },
      version_vector: { baseline: 4, "tablet-north": 1 },
      state_digest: "committed-digest",
      server_sequence: 5,
      accepted_operation_ids: ["00000000-0000-4000-8000-000000000002"],
      duplicate_operation_ids: [],
      operations: [],
      sync_mode: "incremental",
      snapshot: null,
    };

    const synchronized = applySyncResponse(queued, response);

    expect(synchronized.pending).toEqual([]);
    expect(synchronized.state.priority).toBe("Urgent");
    expect(synchronized.digest).toBe("committed-digest");
    expect(synchronized.nextCounter).toBe(2);
  });

  it("uses a compacted snapshot as the catch-up base", () => {
    const oldReplica = createReplica("tablet-south");
    const response: SyncResponse = {
      ...snapshot,
      state: { ...snapshot.state, status: "Ready for service" },
      version_vector: { baseline: 4, "tablet-north": 2 },
      state_digest: "post-snapshot-digest",
      server_sequence: 7,
      accepted_operation_ids: [],
      duplicate_operation_ids: [],
      operations: [],
      sync_mode: "snapshot",
      snapshot: {
        ...snapshot,
        state: { ...snapshot.state, priority: "Watch" },
      },
    };

    const synchronized = applySyncResponse(oldReplica, response);

    expect(synchronized.lastSyncMode).toBe("snapshot");
    expect(synchronized.state).toEqual(response.state);
    expect(synchronized.vector).toEqual(response.version_vector);
  });
});
