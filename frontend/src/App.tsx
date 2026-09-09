import { useCallback, useEffect, useRef, useState } from "react";
import { TabletCard, type TabletEdit } from "./components/TabletCard";
import { Timeline } from "./components/Timeline";
import { ProofPanel } from "./components/ProofPanel";
import { ApiError, getDocument, getOperations, normalizeDocument, resetDemo, streamUrl, syncDocument } from "./lib/api";
import { applySyncResponse, createReplica, queueOperation } from "./lib/replica";
import { loadReplicas, saveReplicas } from "./lib/storage";
import { DOCUMENT_ID, type ActorId, type ConnectionState, type DocumentSnapshot, type Replica, type SyncReceipt, type TimelineEntry } from "./types";

type Action = "loading" | "sending" | "resolving" | "resetting" | null;
const steps = ["Write offline", "Send saved notes", "Review together", "Same report"];
const offlinePair = (snapshot?: DocumentSnapshot) =>
  (["tablet-north", "tablet-south"] as ActorId[]).map((id) => ({ ...createReplica(id, snapshot), online: false }));

function initialReplicas(): Replica[] {
  const stored = loadReplicas();
  return stored?.length === 2 && stored.some((r) => r.actorId === "tablet-north") && stored.some((r) => r.actorId === "tablet-south")
    ? stored
    : offlinePair();
}

function App() {
  const [replicas, setReplicas] = useState(initialReplicas);
  const replicasRef = useRef(replicas);
  const [server, setServer] = useState<DocumentSnapshot | null>(null);
  const [action, setAction] = useState<Action>("loading");
  const lock = useRef(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamState, setStreamState] = useState<ConnectionState>("connecting");
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [receipt, setReceipt] = useState<SyncReceipt | null>(null);
  const [verifiedDigest, setVerifiedDigest] = useState<string | null>(null);
  const [operationCount, setOperationCount] = useState(0);
  const [activity, setActivity] = useState("Reading the shared report from the server…");
  const [resolutionText, setResolutionText] = useState("");
  const [drafts, setDrafts] = useState<Record<string, boolean>>({});
  const [editorVersion, setEditorVersion] = useState(0);
  const [confirmReset, setConfirmReset] = useState(false);
  const [storageWarning, setStorageWarning] = useState(false);

  const replaceReplicas = useCallback((next: Replica[]) => {
    replicasRef.current = next;
    setReplicas(next);
    setStorageWarning(!saveReplicas(next));
  }, []);

  const log = useCallback((source: string, title: string, detail: string, sequence?: number) => {
    setTimeline((items) => [...items, {
      id: crypto.randomUUID(), at: new Date().toISOString(), source, title, detail, sequence, tone: "neutral",
    }]);
  }, []);

  const adoptServer = useCallback((snapshot: DocumentSnapshot) => {
    setServer((current) => !current || snapshot.server_sequence >= current.server_sequence ? snapshot : current);
  }, []);

  const refreshCount = useCallback(async () => {
    try { setOperationCount((await getOperations(DOCUMENT_ID)).length); }
    catch { /* The optional history count does not control synchronization. */ }
  }, []);

  const readInitial = useCallback(async (isActive: () => boolean = () => true) => {
    try {
      const snapshot = await getDocument(DOCUMENT_ID);
      if (!isActive()) return;
      adoptServer(snapshot);
      if (!replicasRef.current.some((r) => r.pending.length)) {
        replaceReplicas(offlinePair(snapshot));
        setEditorVersion((value) => value + 1);
      }
      setReady(true);
      setError(null);
      setActivity("Tablets are offline. Saving stays in this browser until you reconnect.");
      void refreshCount();
    } catch (cause) {
      if (!isActive()) return;
      setError(cause instanceof Error ? cause.message : "Could not read the report.");
      setActivity("The server could not be reached. Saved changes stay on their tablets.");
    } finally {
      if (isActive()) setAction(null);
    }
  }, [adoptServer, refreshCount, replaceReplicas]);

  useEffect(() => {
    let active = true;
    void readInitial(() => active);
    return () => { active = false; };
  }, [readInitial]);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let timer: number | undefined;
    function connect() {
      if (disposed) return;
      setStreamState("connecting");
      socket = new WebSocket(streamUrl(DOCUMENT_ID));
      socket.onopen = () => { if (!disposed) setStreamState("live"); };
      socket.onmessage = (event) => {
        if (disposed) return;
        try {
          const raw = JSON.parse(String(event.data)) as Record<string, unknown>;
          const value = raw.document ?? raw.snapshot ?? raw;
          if (value && typeof value === "object" && "state" in value) adoptServer(normalizeDocument(value));
        } catch { /* Ignore notifications that are not document snapshots. */ }
      };
      socket.onerror = () => { if (!disposed) setStreamState("offline"); };
      socket.onclose = () => {
        if (!disposed) { setStreamState("offline"); timer = window.setTimeout(connect, 1800); }
      };
    }
    connect();
    return () => { disposed = true; window.clearTimeout(timer); socket?.close(); };
  }, [adoptServer]);

  async function performSync(actorId: ActorId) {
    const replica = replicasRef.current.find((r) => r.actorId === actorId)!;
    setActivity(`${replica.label} → sync API → database. Waiting for the server's response…`);
    const response = await syncDocument(DOCUMENT_ID, {
      client_id: actorId, known_vector: replica.vector, pending_operations: replica.pending,
    });
    const latest = replicasRef.current.find((r) => r.actorId === actorId)!;
    const updated = applySyncResponse({ ...latest, online: true }, response);
    replaceReplicas(replicasRef.current.map((r) => r.actorId === actorId ? updated : r));
    adoptServer(response);
    setReady(true);
    setReceipt({
      actorId, accepted: response.accepted_operation_ids, duplicates: response.duplicate_operation_ids,
      returnedOperations: response.operations.length, syncMode: response.sync_mode,
      sequence: response.server_sequence, digest: response.state_digest, at: new Date().toISOString(),
    });
    log(replica.label, response.accepted_operation_ids.length ? "Server saved the changes" : "Latest report received",
      `POST /api/v1/documents/${DOCUMENT_ID}/sync · ${response.accepted_operation_ids.length} accepted · ${response.duplicate_operation_ids.length} already stored`, response.server_sequence);
    return response;
  }

  function saveTablet(actorId: ActorId, edits: TabletEdit[]) {
    if (lock.current || action) return;
    let replica = replicasRef.current.find((r) => r.actorId === actorId)!;
    for (const edit of edits) replica = queueOperation({ ...replica, online: false }, edit.field, edit.value);
    replaceReplicas(replicasRef.current.map((r) => r.actorId === actorId ? replica : r));
    setVerifiedDigest(null);
    setError(null);
    setActivity(`${replica.label} saved locally. No request was sent to the server.`);
    log(replica.label, "Saved on the tablet", `${edits.length} local change(s) queued. No network request.`);
  }

  async function runAction(kind: Action, work: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setAction(kind);
    setError(null);
    try { await work(); }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : "The request failed.");
      setActivity("The request did not finish. Check the message above before retrying.");
    } finally { lock.current = false; setAction(null); }
  }

  async function syncBoth() {
    await runAction("sending", async () => {
      // Send both original offline queues before downloading the final shared result.
      await performSync("tablet-north");
      await performSync("tablet-south");
      await performSync("tablet-north");
      const latest = await getDocument(DOCUMENT_ID);
      adoptServer(latest);
      if (!latest.conflicts.length && replicasRef.current.every((r) => !r.pending.length && r.digest === latest.state_digest)) {
        setVerifiedDigest(latest.state_digest);
      }
      setActivity(latest.conflicts.length
        ? "Both notes reached the database. Choose the wording everyone should receive."
        : "Both tablets downloaded the server's report.");
      void refreshCount();
    });
  }

  const conflict = server?.conflicts.find((item) => item.field === "observation");
  const hasPending = replicas.some((r) => r.pending.length > 0);
  const savedNotes = replicas.filter((r) => r.pending.some((op) => op.field === "observation")).length;
  const hasDrafts = Object.values(drafts).some(Boolean);
  const complete = Boolean(verifiedDigest && verifiedDigest === server?.state_digest && !conflict && !hasPending &&
    replicas.every((r) => r.digest === server.state_digest));
  const review = Boolean(conflict && (!hasPending || action === "resolving"));
  const progress = complete ? 4 : review || action === "resolving" ? 2 : action === "sending" || savedNotes === 2 ? 1 : 0;
  const busy = action !== null;

  async function approveNote() {
    if (!resolutionText.trim() || resolutionText.trim().length > 4000 || !conflict || hasDrafts) return;
    const candidateIds = conflict.candidates.map((c) => c.operation_id).sort().join(",");
    await runAction("resolving", async () => {
      const refreshed = await performSync("tablet-north");
      const currentIds = refreshed.conflicts.find((item) => item.field === "observation")?.candidates.map((c) => c.operation_id).sort().join(",");
      if (candidateIds !== currentIds) throw new Error("The shared notes changed. Review the latest notes before saving.");
      const north = replicasRef.current.find((r) => r.actorId === "tablet-north")!;
      const updated = queueOperation(north, "observation", resolutionText.trim(), "resolve");
      replaceReplicas(replicasRef.current.map((r) => r.actorId === updated.actorId ? updated : r));
      try {
        await performSync("tablet-north");
      } catch (cause) {
        if (cause instanceof ApiError && cause.status === 422) {
          // A validation rejection guarantees this resolution was not stored.
          // Restore only that operation's pre-submit replica; keep the wording editable.
          replaceReplicas(replicasRef.current.map((r) => r.actorId === north.actorId ? north : r));
          await performSync("tablet-north");
          throw new Error("The shared notes changed before your decision could be saved. Your wording is kept below. Review the latest notes and try again.");
        }
        throw cause;
      }
      await performSync("tablet-south");
      const verified = await getDocument(DOCUMENT_ID);
      adoptServer(verified);
      if (verified.conflicts.length || replicasRef.current.some((r) => r.pending.length || r.digest !== verified.state_digest)) {
        throw new Error("The copies do not match yet. Send again to fetch the latest report.");
      }
      setVerifiedDigest(verified.state_digest);
      setActivity("Confirmed by the server: both tablets have the same final report.");
      log("Server", "All three copies match", "Both tablet fingerprints match the document read back from the API.", verified.server_sequence);
      void refreshCount();
    });
  }

  async function startAnotherPair() {
    await runAction("loading", async () => {
      const latest = await getDocument(DOCUMENT_ID);
      adoptServer(latest);
      replaceReplicas(offlinePair(latest));
      setReceipt(null);
      setVerifiedDigest(null);
      setResolutionText("");
      setDrafts({});
      setEditorVersion((value) => value + 1);
      setActivity("A fresh pair of offline editors is ready. Previous notes remain in the server history.");
    });
  }

  async function restartDemo() {
    await runAction("resetting", async () => {
      const snapshot = await resetDemo();
      setServer(snapshot);
      replaceReplicas(offlinePair(snapshot));
      setReceipt(null);
      setVerifiedDigest(null);
      setResolutionText("");
      setDrafts({});
      setTimeline([]);
      setEditorVersion((value) => value + 1);
      setConfirmReset(false);
      setActivity("Demo reset. Write a note on each offline tablet.");
      void refreshCount();
    });
  }

  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="brand" href="#top"><span>FM</span><strong>FieldMerge</strong></a>
        <span className={`backend-status ${ready && !error ? "is-ready" : ""}`}><i aria-hidden="true" />{error ? "Check last request" : ready ? "Server connected" : busy ? "Connecting…" : "Server unavailable"}</span>
      </header>
      <main id="top">
        <section className="intro">
          <p className="eyebrow">Try an offline inspection</p>
          <h1>No internet. Two notes. Neither lost.</h1>
          <p>Two workers inspect the same pump without a connection. Write a note on each tablet, then reconnect them. FieldMerge keeps both notes and asks you what the shared report should say.</p>
          <small>These are two simulated tablets in your browser, connected to a real API and database.</small>
        </section>

        <section id="live-proof" className="demo" aria-label="Hands-on offline demo">
          <ol className="demo-progress" aria-label="Demo progress">
            {steps.map((label, index) => <li key={label} className={progress > index ? "is-complete" : progress === index ? "is-active" : ""} aria-current={progress === index ? "step" : undefined}>
              <span>{progress > index ? "✓" : index + 1}</span>{label}
            </li>)}
          </ol>
          <div className="next-step">
            <div>
              <p className="eyebrow">{complete ? "Done" : review ? "Your decision" : "Your next step"}</p>
              <h2>{complete ? "Both tablets have the same report." : review ? "Choose one note or combine them below." : savedNotes === 2 ? "Both notes are saved. Bring the tablets online." : "Write and save a different note on each tablet."}</h2>
              <p>{hasDrafts ? "Save your changes on the tablet before sending." : complete ? "The result was read back from the server and checked against both tablets." : review ? "Neither worker had seen the other's note. The server kept both." : `${savedNotes} of 2 tablets have an unsent note. Saving does not send anything yet.`}</p>
            </div>
            {complete ? <button className="button button--primary" disabled={busy} onClick={() => void startAnotherPair()}>Write another pair</button>
              : !review && <button className="button button--primary" disabled={busy || !ready || hasDrafts || (savedNotes < 2 && !receipt && !(error && hasPending))} onClick={() => void syncBoth()}>
                {action === "sending" ? "Sending saved changes…" : error && (hasPending || receipt) ? "Retry sending saved changes" : "Reconnect & send notes"}
              </button>}
          </div>

          {error && <div className="error-banner" role="alert"><strong>Something needs attention.</strong> {error}
            {!ready && <button className="text-button" disabled={busy} onClick={() => { setAction("loading"); void readInitial(); }}>Retry connection</button>}
          </div>}
          {storageWarning && <p className="error-banner" role="alert">Browser storage is unavailable. Edits are held in memory only. Keep this page open until they are sent.</p>}

          <div className="tablet-grid">
            {replicas.map((replica) => <TabletCard key={`${replica.actorId}-${editorVersion}`} replica={replica}
              busy={busy} ready={ready || replica.pending.length > 0} complete={complete}
              onSave={(edits) => saveTablet(replica.actorId, edits)}
              onDraftChange={(dirty) => setDrafts((current) => ({ ...current, [replica.actorId]: dirty }))} />)}
          </div>

          <section className="request-path" aria-labelledby="path-title">
            <div className="request-path__heading"><h2 id="path-title">Where your changes go</h2><span>{hasPending ? "Waiting on the tablets" : action === "sending" || action === "resolving" ? "Syncing" : receipt ? "Server response received" : "Nothing sent yet"}</span></div>
            <ol><li><strong>1. Tablet</strong><small>Saves in this browser</small></li><li><strong>2. Sync API</strong><small>Receives your changes</small></li><li><strong>3. Database</strong><small>Keeps the saved notes</small></li><li><strong>4. Both tablets</strong><small>Download the shared report</small></li></ol>
            <p className="request-activity" role="status">{activity}</p>
          </section>

          {review && conflict && <section className="resolution-panel" id="resolution-panel" aria-labelledby="resolution-title">
            <p className="eyebrow">Both notes were saved</p><h2 id="resolution-title">What should the shared note say?</h2>
            <div className="resolution-candidates">
              {conflict.candidates.map((candidate) => <button type="button" key={candidate.operation_id} disabled={busy} onClick={() => setResolutionText(candidate.value)}>
                <span>{candidate.actor_id.replace("tablet-", "Tablet ")}</span><strong>{candidate.value}</strong><small>Use this note</small>
              </button>)}
            </div>
            <button className="text-button" disabled={busy} onClick={() => setResolutionText(conflict.candidates.map((candidate) => candidate.value).join(" "))}>Combine both notes</button>
            <label className="resolution-input">Final shared note<textarea rows={3} maxLength={4000} value={resolutionText} disabled={busy} onChange={(event) => setResolutionText(event.target.value)} placeholder="Choose a note above, combine them, or write your own wording." /></label>
            {resolutionText.trim().length > 4000 && <p role="alert">The combined note is too long. Shorten it to 4,000 characters before saving.</p>}
            {hasDrafts && <p>Save the unsaved draft on its tablet before approving the shared note.</p>}
            <button className="button button--primary" disabled={busy || hasDrafts || !resolutionText.trim() || resolutionText.trim().length > 4000} onClick={() => void approveNote()}>{action === "resolving" ? "Saving your decision…" : "Save & update both tablets"}</button>
          </section>}

          <details className="technical-details">
            <summary>
              <span className="technical-details__intro">
                <strong>See how the backend works</strong>
                <span>Requests, server report &amp; history</span>
              </span>
              <span className="technical-details__toggle" aria-hidden="true">
                <span className="technical-details__show">Show details <b>+</b></span>
                <span className="technical-details__hide">Hide details <b>−</b></span>
              </span>
            </summary>
            <p>The tablet connection is simulated, so this page stays online. Saved changes only leave a tablet when you press Reconnect. API requests and database writes are real. Live server notifications do not automatically overwrite an offline tablet.</p>
            <code>POST /api/v1/documents/{DOCUMENT_ID}/sync</code>
            <ProofPanel server={server} replicas={replicas} streamState={streamState} operationCount={operationCount} receipt={receipt} proved={complete} />
            <Timeline entries={timeline} />
            <div className="reset-controls">
              {confirmReset ? <><p>This clears the shared demo's server history and your local saved edits and drafts. Other visitors use the same test report.</p><button className="button button--danger" disabled={busy} onClick={() => void restartDemo()}>Confirm reset</button><button className="text-button" onClick={() => setConfirmReset(false)}>Cancel</button></>
                : <button className="text-button" disabled={busy} onClick={() => setConfirmReset(true)}>Reset shared demo</button>}
            </div>
          </details>
        </section>
      </main>
      <footer className="site-footer">Fictional inspection · shared demo · please do not enter personal information</footer>
    </div>
  );
}

export default App;
