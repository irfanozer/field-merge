import type { ConnectionState, DocumentSnapshot, Replica, SyncReceipt } from "../types";
import { shortDigest, vectorLabel } from "../lib/replica";

interface ProofPanelProps {
  server: DocumentSnapshot | null;
  replicas: Replica[];
  streamState: ConnectionState;
  operationCount: number;
  receipt: SyncReceipt | null;
  proved: boolean;
}

export function ProofPanel({
  server,
  replicas,
  streamState,
  operationCount,
  receipt,
  proved,
}: ProofPanelProps) {
  const north = replicas.find((replica) => replica.actorId === "tablet-north");
  const south = replicas.find((replica) => replica.actorId === "tablet-south");
  const digestsMatch = Boolean(
    server?.state_digest &&
    north?.digest === server.state_digest &&
    south?.digest === server.state_digest,
  );
  const resultVerified = proved && digestsMatch && server?.conflicts.length === 0;
  const reviewNeeded = Boolean(server?.conflicts.length);
  const resultTitle = resultVerified
    ? "Verified: both tablets match the server."
    : reviewNeeded
      ? "Both offline notes are stored."
      : "Shared report on the server";

  return (
    <aside className={`proof-panel ${proved ? "proof-panel--proved" : ""}`} aria-labelledby="proof-title">
      <header>
        <div>
          <p className="eyebrow">How you know it worked</p>
          <h2 id="proof-title">{resultTitle}</h2>
        </div>
        <span className={`stream-badge stream-badge--${streamState}`}>
          <i aria-hidden="true" />
          {streamState === "live" ? "Live updates connected" : streamState === "connecting" ? "Live updates connecting" : "Live updates offline"}
        </span>
      </header>

      <p className="proof-intro">
        These values come from the API and PostgreSQL. The browser is displaying the server&apos;s saved result.
      </p>
      <p className="proof-intro"><strong>Server&apos;s saved note: </strong>{server?.state.observation ?? (reviewNeeded ? "Competing notes are waiting for review." : "Waiting for the server.")}</p>

      <dl className="proof-metrics">
        <div>
          <dt>Changes stored in database</dt>
          <dd>{operationCount}</dd>
        </div>
        <div>
          <dt>Latest server update</dt>
          <dd>{server?.server_sequence ?? "Waiting"}</dd>
        </div>
        <div>
          <dt>Notes waiting for review</dt>
          <dd>{server?.conflicts.length ?? "Waiting"}</dd>
        </div>
        <div>
          <dt>Last sync result</dt>
          <dd>{receipt ? receipt.accepted.length ? `${receipt.accepted.length} saved` : "Up to date" : "Waiting"}</dd>
        </div>
      </dl>

      <details className="proof-technical">
        <summary>View technical verification</summary>
        <div className="proof-code">
          <div>
            <span>Server change history</span>
            <code>{server ? vectorLabel(server.version_vector) : "Waiting for API"}</code>
          </div>
          <div>
            <span>Server record fingerprint</span>
            <code>{shortDigest(server?.state_digest ?? null)}</code>
          </div>
          {receipt && (
            <div>
              <span>Latest API response</span>
              <code>
                {receipt.syncMode} · {receipt.returnedOperations} returned · update {receipt.sequence}
              </code>
            </div>
          )}
        </div>
      </details>

      <div className={`digest-verdict ${resultVerified ? "is-matched" : ""}`}>
        <span aria-hidden="true">{resultVerified ? "✓" : reviewNeeded ? "2" : "…"}</span>
        <div>
          <strong>{resultVerified ? "Both tablets match the server" : reviewNeeded ? "The server kept the competing notes" : "Save and send your notes to compare the copies"}</strong>
          <p>
            {resultVerified
              ? "Tablet North, Tablet South, and PostgreSQL report the same record fingerprint."
              : reviewNeeded
                ? "Both independently written notes are stored and waiting for your decision."
                : "After you approve the final report, matching fingerprints will confirm that every copy has identical content."}
          </p>
        </div>
      </div>
    </aside>
  );
}
