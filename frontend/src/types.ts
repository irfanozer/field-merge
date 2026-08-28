export const DOCUMENT_ID = "inspection-pump-07";

export type ActorId = "tablet-north" | "tablet-south";
export type EditableField = "site_name" | "priority" | "status" | "observation";
export type OperationKind = "set" | "resolve";
export type ConnectionState = "connecting" | "live" | "offline";

export type VersionVector = Record<string, number>;

export interface InspectionState {
  site_name: string;
  priority: string;
  status: string;
  observation: string | null;
}

export interface OperationEnvelope {
  operation_id: string;
  actor_id: string;
  actor_counter: number;
  context: VersionVector;
  field: EditableField;
  kind: OperationKind;
  value: string;
  created_at: string;
  server_sequence?: number;
}

export interface ConflictCandidate {
  operation_id: string;
  actor_id: string;
  actor_counter: number;
  value: string;
  created_at?: string;
}

export interface FieldConflict {
  field: EditableField;
  candidates: ConflictCandidate[];
}

export interface DocumentSnapshot {
  document_id: string;
  state: InspectionState;
  version_vector: VersionVector;
  state_digest: string;
  server_sequence: number;
  conflicts: FieldConflict[];
}

export interface SyncRequest {
  client_id: string;
  known_vector: VersionVector;
  pending_operations: OperationEnvelope[];
}

export interface SyncResponse extends DocumentSnapshot {
  accepted_operation_ids: string[];
  duplicate_operation_ids: string[];
  operations: OperationEnvelope[];
  sync_mode: "incremental" | "snapshot";
  snapshot?: DocumentSnapshot | null;
}

export interface Replica {
  actorId: ActorId;
  label: string;
  location: string;
  online: boolean;
  state: InspectionState;
  vector: VersionVector;
  nextCounter: number;
  pending: OperationEnvelope[];
  digest: string | null;
  lastSyncAt: string | null;
  lastSyncMode: "incremental" | "snapshot" | null;
}

export type TimelineTone = "neutral" | "north" | "south" | "server" | "conflict" | "success";

export interface TimelineEntry {
  id: string;
  at: string;
  source: string;
  title: string;
  detail: string;
  tone: TimelineTone;
  operationId?: string;
  sequence?: number;
}

export interface SyncReceipt {
  actorId: ActorId;
  accepted: string[];
  duplicates: string[];
  returnedOperations: number;
  syncMode: "incremental" | "snapshot";
  sequence: number;
  digest: string;
  at: string;
}

export type DemoPhase =
  | "ready"
  | "resetting"
  | "offline-editing"
  | "reconnecting"
  | "conflict"
  | "resolving"
  | "proved"
  | "error";

export const BASELINE_STATE: InspectionState = {
  site_name: "North Pump Station",
  priority: "High",
  status: "Inspection in progress",
  observation: "Seal is stable; monitor vibration.",
};
