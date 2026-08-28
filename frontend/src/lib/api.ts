import type {
  DocumentSnapshot,
  FieldConflict,
  InspectionState,
  OperationEnvelope,
  SyncRequest,
  SyncResponse,
  VersionVector,
} from "../types";

const configuredBase = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, "") ?? "";

function apiUrl(path: string): string {
  return `${configuredBase}${path}`;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { detail?: string };
      if (body.detail) detail = body.detail;
    } catch {
      // The status line remains the most useful fallback for a non-JSON failure.
    }
    throw new Error(detail);
  }

  return (await response.json()) as T;
}

function normalizeState(value: unknown): InspectionState {
  const state = (value ?? {}) as Partial<InspectionState>;
  return {
    site_name: state.site_name ?? "Unknown site",
    priority: state.priority ?? "Routine",
    status: state.status ?? "Inspection in progress",
    observation: state.observation ?? null,
  };
}

function normalizeVector(value: unknown): VersionVector {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, counter]) => typeof counter === "number" && Number.isFinite(counter))
      .map(([actor, counter]) => [actor, counter as number]),
  );
}

function normalizeConflicts(value: unknown): FieldConflict[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((conflict): conflict is FieldConflict => {
      if (!conflict || typeof conflict !== "object") return false;
      const candidate = conflict as Partial<FieldConflict>;
      return typeof candidate.field === "string" && Array.isArray(candidate.candidates);
    })
    .map((conflict) => ({ ...conflict, candidates: conflict.candidates ?? [] }));
}

export function normalizeDocument(value: unknown): DocumentSnapshot {
  const document = (value ?? {}) as Partial<DocumentSnapshot>;
  return {
    document_id: document.document_id ?? "inspection-pump-07",
    state: normalizeState(document.state),
    version_vector: normalizeVector(document.version_vector),
    state_digest: document.state_digest ?? "",
    server_sequence: document.server_sequence ?? 0,
    conflicts: normalizeConflicts(document.conflicts),
  };
}

export function normalizeSync(value: unknown): SyncResponse {
  const raw = (value ?? {}) as Partial<SyncResponse>;
  return {
    ...normalizeDocument(raw),
    accepted_operation_ids: Array.isArray(raw.accepted_operation_ids)
      ? raw.accepted_operation_ids
      : [],
    duplicate_operation_ids: Array.isArray(raw.duplicate_operation_ids)
      ? raw.duplicate_operation_ids
      : [],
    operations: Array.isArray(raw.operations) ? (raw.operations as OperationEnvelope[]) : [],
    sync_mode: raw.sync_mode === "snapshot" ? "snapshot" : "incremental",
    snapshot: raw.snapshot ? normalizeDocument(raw.snapshot) : null,
  };
}

export async function getDocument(documentId: string): Promise<DocumentSnapshot> {
  return normalizeDocument(await requestJson(`/api/v1/documents/${documentId}`));
}

export async function syncDocument(
  documentId: string,
  request: SyncRequest,
): Promise<SyncResponse> {
  return normalizeSync(
    await requestJson(`/api/v1/documents/${documentId}/sync`, {
      method: "POST",
      body: JSON.stringify(request),
    }),
  );
}

export async function resetDemo(): Promise<DocumentSnapshot> {
  await requestJson("/api/v1/demo/reset", { method: "POST" });
  return getDocument("inspection-pump-07");
}

export async function getOperations(documentId: string): Promise<OperationEnvelope[]> {
  const response = await requestJson<
    OperationEnvelope[] | { items?: OperationEnvelope[]; operations?: OperationEnvelope[] }
  >(
    `/api/v1/documents/${documentId}/operations`,
  );
  return Array.isArray(response) ? response : (response.operations ?? response.items ?? []);
}

export function streamUrl(documentId: string): string {
  const configured = import.meta.env.VITE_WS_BASE_URL?.replace(/\/$/, "");
  if (configured) return `${configured}/api/v1/documents/${documentId}/stream`;

  const base = configuredBase
    ? new URL(configuredBase, window.location.href)
    : new URL(window.location.href);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = `/api/v1/documents/${documentId}/stream`;
  base.search = "";
  base.hash = "";
  return base.toString();
}
