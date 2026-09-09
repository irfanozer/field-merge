import type { Replica } from "../types";

const STORAGE_VERSION = 1;
const STORAGE_KEY = "fieldmerge.demo.replicas.v1";

interface StoredReplicas {
  version: number;
  replicas: Replica[];
}

export function loadReplicas(): Replica[] | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as StoredReplicas;
    if (stored.version !== STORAGE_VERSION || !Array.isArray(stored.replicas)) return null;
    return stored.replicas;
  } catch {
    return null;
  }
}

export function saveReplicas(replicas: Replica[]): boolean {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: STORAGE_VERSION, replicas } satisfies StoredReplicas),
    );
    return true;
  } catch {
    // A private browser session may reject storage. Synchronization still works in memory.
    return false;
  }
}

export function clearReplicas(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // No local data remains actionable when storage is unavailable.
  }
}
