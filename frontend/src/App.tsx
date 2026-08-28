import { useCallback, useEffect, useRef, useState } from "react";
import { ProofPanel } from "./components/ProofPanel";
import { TabletCard } from "./components/TabletCard";
import { Timeline } from "./components/Timeline";
import {
  getDocument,
  getOperations,
  normalizeDocument,
  resetDemo,
  streamUrl,
  syncDocument,
} from "./lib/api";
import {
  applySyncResponse,
  createReplica,
  queueOperation,
  shortDigest,
  vectorLabel,
} from "./lib/replica";
import { clearReplicas, loadReplicas, saveReplicas } from "./lib/storage";
import {
  DOCUMENT_ID,
  type ActorId,
  type ConnectionState,
  type DemoPhase,
  type DocumentSnapshot,
  type EditableField,
  type Replica,
  type SyncReceipt,
  type TimelineEntry,
  type TimelineTone,
} from "./types";

const pause = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

function initialReplicas(): Replica[] {
  const stored = loadReplicas();
  if (
    stored?.length === 2 &&
    stored.some((replica) => replica.actorId === "tablet-north") &&
    stored.some((replica) => replica.actorId === "tablet-south")
  ) {
    return stored;
  }
  return [createReplica("tablet-north"), createReplica("tablet-south")];
}

function phaseCopy(phase: DemoPhase): { number: string; label: string; title: string; body: string } {
  switch (phase) {
    case "resetting":
      return {
        number: "1 / 5",
        label: "Starting together",
        title: "Both tablets load the same inspection report.",
        body: "FieldMerge reads one saved report from the server and puts the same copy on both test tablets.",
      };
    case "offline-editing":
      return {
        number: "2 / 5",
        label: "Internet disconnected",
        title: "Each worker saves a different note while offline.",
        body: "The notes are stored on the tablets first. The server has not received either note yet.",
      };
    case "reconnecting":
      return {
        number: "3 / 5",
        label: "Internet restored",
        title: "Both tablets send their saved notes to FieldMerge.",
        body: "Tablet South reconnects first and Tablet North second. FieldMerge keeps both notes instead of letting the last connection erase one.",
      };
    case "conflict":
      return {
        number: "4 / 5",
        label: "Your turn",
        title: "Two valid notes need one human decision.",
        body: "Because both notes were written offline, software cannot know which wording is correct. Review them and choose the final report below.",
      };
    case "resolving":
      return {
        number: "5 / 5",
        label: "Saving your decision",
        title: "The final note is being sent to both tablets.",
        body: "FieldMerge saves your approved wording on the server, then updates both devices with the same report.",
      };
    case "proved":
      return {
        number: "Done",
        label: "Demo complete",
        title: "Both tablets now show the same final report.",
        body: "No offline note was silently erased. The two tablets and the database now have the same record fingerprint.",
      };
    case "error":
      return {
        number: "!",
        label: "Demo stopped",
        title: "The server connection was interrupted.",
        body: "Restore the backend connection and run the demo again. Any unsent work is still visible on its tablet.",
      };
    default:
      return {
        number: "Ready",
        label: "Guided demo · two clicks total",
        title: "Start the demo. It pauses when it needs your decision.",
        body: "Your first click runs the offline and reconnect steps. After you review the two saved notes, your second click sends one final report to both tablets.",
      };
  }
}

const demoSteps = [
  "Load the same report",
  "Save two notes offline",
  "Reconnect both tablets",
  "You review the notes",
  "Everyone gets the final report",
];

function phaseStep(phase: DemoPhase): number {
  switch (phase) {
    case "offline-editing": return 1;
    case "reconnecting": return 2;
    case "conflict": return 3;
    case "resolving": return 4;
    case "proved": return 5;
    default: return 0;
  }
}

function App() {
  const [replicas, setReplicas] = useState<Replica[]>(initialReplicas);
  const replicasRef = useRef(replicas);
  const [server, setServer] = useState<DocumentSnapshot | null>(null);
  const [phase, setPhase] = useState<DemoPhase>("ready");
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [receipt, setReceipt] = useState<SyncReceipt | null>(null);
  const [operationCount, setOperationCount] = useState(0);
  const [streamState, setStreamState] = useState<ConnectionState>("connecting");
  const [backendReady, setBackendReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolutionText, setResolutionText] = useState("");
  const conflictLoggedRef = useRef(false);

  const replaceReplicas = useCallback((next: Replica[] | ((current: Replica[]) => Replica[])) => {
    const value = typeof next === "function" ? next(replicasRef.current) : next;
    replicasRef.current = value;
    setReplicas(value);
    saveReplicas(value);
  }, []);

  const addTimeline = useCallback((
    source: string,
    title: string,
    detail: string,
    tone: TimelineTone,
    extras?: Pick<TimelineEntry, "operationId" | "sequence">,
  ) => {
    const entry: TimelineEntry = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      source,
      title,
      detail,
      tone,
      ...extras,
    };
    setTimeline((current) => [...current, entry]);
  }, []);

  const refreshOperationCount = useCallback(async () => {
    try {
      const operations = await getOperations(DOCUMENT_ID);
      setOperationCount(operations.length);
    } catch {
      // The primary sync result remains usable if the optional audit count cannot refresh.
    }
  }, []);

  const performSync = useCallback(async (replica: Replica) => {
    if (!replica.online) throw new Error(`${replica.label} has no signal.`);
    const response = await syncDocument(DOCUMENT_ID, {
      client_id: replica.actorId,
      known_vector: replica.vector,
      pending_operations: replica.pending,
    });
    const updated = applySyncResponse(replica, response);
    replaceReplicas((current) =>
      current.map((candidate) => candidate.actorId === replica.actorId ? updated : candidate),
    );
    setServer(response);
    setBackendReady(true);
    setError(null);
    const nextReceipt: SyncReceipt = {
      actorId: replica.actorId,
      accepted: response.accepted_operation_ids,
      duplicates: response.duplicate_operation_ids,
      returnedOperations: response.operations.length,
      syncMode: response.sync_mode,
      sequence: response.server_sequence,
      digest: response.state_digest,
      at: new Date().toISOString(),
    };
    setReceipt((current) =>
      response.accepted_operation_ids.length > 0 ||
      response.duplicate_operation_ids.length > 0 ||
      current === null
        ? nextReceipt
        : current,
    );
    addTimeline(
      replica.label,
      response.accepted_operation_ids.length
        ? `${response.accepted_operation_ids.length} saved change reached the server`
        : "This tablet downloaded the latest report",
      response.operations.length
        ? `${response.operations.length} change${response.operations.length === 1 ? "" : "s"} from another device ${response.operations.length === 1 ? "was" : "were"} returned.`
        : "The server confirmed that this tablet is up to date.",
      replica.actorId === "tablet-north" ? "north" : "south",
      { sequence: response.server_sequence },
    );
    if (response.conflicts.length > 0 && !conflictLoggedRef.current) {
      conflictLoggedRef.current = true;
      addTimeline(
        "FieldMerge",
        "Both offline notes were kept for review",
        "Neither worker could see the other note while offline, so FieldMerge saved both instead of silently choosing one.",
        "conflict",
        { sequence: response.server_sequence },
      );
    }
    void refreshOperationCount();
    return { replica: updated, response };
  }, [addTimeline, refreshOperationCount, replaceReplicas]);

  useEffect(() => {
    let active = true;
    async function loadServer() {
      try {
        const hasPendingWork = replicasRef.current.some((replica) => replica.pending.length > 0);
        const document = hasPendingWork
          ? await getDocument(DOCUMENT_ID)
          : await resetDemo();
        if (!active) return;
        setServer(document);
        setBackendReady(true);
        setError(null);
        if (!hasPendingWork) {
          replaceReplicas(
            replicasRef.current.map((replica) => createReplica(replica.actorId, document)),
          );
        }
        void refreshOperationCount();
      } catch (cause) {
        if (!active) return;
        setBackendReady(false);
        setError(cause instanceof Error ? cause.message : "Backend is unavailable.");
      }
    }
    void loadServer();
    return () => { active = false; };
  }, [refreshOperationCount, replaceReplicas]);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;

    function connect() {
      if (disposed) return;
      setStreamState("connecting");
      socket = new WebSocket(streamUrl(DOCUMENT_ID));
      socket.onopen = () => setStreamState("live");
      socket.onmessage = (event) => {
        try {
          const raw = JSON.parse(String(event.data)) as Record<string, unknown>;
          const candidate = raw.document ?? raw.snapshot ?? raw;
          if (candidate && typeof candidate === "object" && "state" in candidate) {
            setServer(normalizeDocument(candidate));
            setBackendReady(true);
          }
        } catch {
          // Unknown notification types do not replace the last verified snapshot.
        }
      };
      socket.onerror = () => setStreamState("offline");
      socket.onclose = () => {
        setStreamState("offline");
        if (!disposed) reconnectTimer = window.setTimeout(connect, 1800);
      };
    }

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, []);

  useEffect(() => {
    if (phase !== "conflict") return;
    const timer = window.setTimeout(() => {
      document.getElementById("resolution-panel")?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    }, 150);
    return () => window.clearTimeout(timer);
  }, [phase]);

  async function startGuidedProof() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setTimeline([]);
    setReceipt(null);
    setResolutionText("");
    setPhase("resetting");
    conflictLoggedRef.current = false;
    clearReplicas();

    try {
      const baseline = await resetDemo();
      setServer(baseline);
      await refreshOperationCount();
      let north = { ...createReplica("tablet-north", baseline), online: false };
      let south = { ...createReplica("tablet-south", baseline), online: false };
      replaceReplicas([north, south]);
      addTimeline(
        "FieldMerge server",
        "Both tablets loaded the same inspection report",
        "Tablet North and Tablet South received the same starting report from the database.",
        "server",
        { sequence: baseline.server_sequence },
      );

      await pause(900);
      setPhase("offline-editing");
      north = queueOperation(
        north,
        "observation",
        "Seal leak increased to a steady drip during load test.",
      );
      south = queueOperation(
        south,
        "observation",
        "Motor housing vibration is above the normal field range.",
      );
      replaceReplicas([north, south]);
      addTimeline(
        north.label,
        "North saved a note without internet",
        "The note is stored in this browser as one unsent change. The server has not received it yet.",
        "north",
        { operationId: north.pending.at(-1)?.operation_id },
      );
      addTimeline(
        south.label,
        "South saved a different note without internet",
        "This note is also waiting on its own tablet. Neither worker could see the other worker’s note.",
        "south",
        { operationId: south.pending.at(-1)?.operation_id },
      );

      await pause(1_000);
      setPhase("reconnecting");
      south = { ...south, online: true };
      replaceReplicas([north, south]);
      addTimeline(
        south.label,
        "South reconnected first",
        "Its saved note is now sent through the real API and stored on the server.",
        "south",
      );
      south = (await performSync(south)).replica;

      await pause(1_000);
      north = { ...north, online: true };
      replaceReplicas([north, south]);
      addTimeline(
        north.label,
        "North reconnected second",
        "Its independently written note is sent next. Reconnecting last is not allowed to erase South’s note.",
        "north",
      );
      const northSync = await performSync(north);
      north = northSync.replica;

      south = replicasRef.current.find((replica) => replica.actorId === "tablet-south") ?? south;
      south = (await performSync(south)).replica;
      const conflict = northSync.response.conflicts.find((item) => item.field === "observation");
      const values = conflict?.candidates.map((candidate) => candidate.value) ?? [
        "Seal leak increased; motor vibration is above normal.",
      ];
      setResolutionText(values.join(" "));
      setPhase("conflict");
    } catch (cause) {
      setPhase("error");
      setBackendReady(false);
      setError(cause instanceof Error ? cause.message : "The guided proof could not complete.");
    } finally {
      setBusy(false);
    }
  }

  async function resolveConflict() {
    const value = resolutionText.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    setPhase("resolving");
    try {
      let north = replicasRef.current.find((replica) => replica.actorId === "tablet-north");
      if (!north) throw new Error("Tablet North replica is missing.");
      north = { ...north, online: true };
      north = queueOperation(north, "observation", value, "resolve");
      replaceReplicas((current) =>
        current.map((replica) => replica.actorId === north?.actorId ? north : replica),
      );
      addTimeline(
        "You",
        "Final report wording approved",
        "FieldMerge asks for a person only because both offline notes could be valid. Your choice is now being saved.",
        "conflict",
        { operationId: north.pending.at(-1)?.operation_id },
      );
      north = (await performSync(north)).replica;
      let south = replicasRef.current.find((replica) => replica.actorId === "tablet-south");
      if (!south) throw new Error("Tablet South replica is missing.");
      south = { ...south, online: true };
      replaceReplicas((current) =>
        current.map((replica) => replica.actorId === south?.actorId ? south : replica),
      );
      south = (await performSync(south)).replica;
      const latest = await getDocument(DOCUMENT_ID);
      setServer(latest);
      const converged = north.digest === latest.state_digest && south.digest === latest.state_digest;
      if (!converged || latest.conflicts.length > 0) {
        throw new Error("The server has not yet confirmed convergence.");
      }
      addTimeline(
        "FieldMerge server",
        "Both tablets received the approved report",
        "Tablet North, Tablet South, and the database now have the same saved content.",
        "success",
        { sequence: latest.server_sequence },
      );
      setPhase("proved");
    } catch (cause) {
      setPhase("error");
      setError(cause instanceof Error ? cause.message : "Conflict resolution failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleConnection(actorId: ActorId, online: boolean) {
    const current = replicasRef.current.find((replica) => replica.actorId === actorId);
    if (!current || busy) return;
    const updated = { ...current, online };
    replaceReplicas((all) => all.map((replica) => replica.actorId === actorId ? updated : replica));
    addTimeline(
      current.label,
      online ? "Network connection restored" : "Device moved out of signal range",
      online
        ? `${current.pending.length} queued local change${current.pending.length === 1 ? " is" : "s are"} ready to synchronize.`
        : "New edits will stay in this browser replica until the connection returns.",
      actorId === "tablet-north" ? "north" : "south",
    );
    if (online) {
      setBusy(true);
      try {
        await performSync(updated);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Sync failed.");
      } finally {
        setBusy(false);
      }
    }
  }

  async function handleManualEdit(actorId: ActorId, field: EditableField, value: string) {
    const current = replicasRef.current.find((replica) => replica.actorId === actorId);
    if (!current || busy) return;
    const updated = queueOperation(current, field, value);
    replaceReplicas((all) => all.map((replica) => replica.actorId === actorId ? updated : replica));
    const operation = updated.pending.at(-1);
    addTimeline(
      current.label,
      `${field.replace("_", " ")} edited locally`,
      current.online
        ? "The local operation is now being sent through the sync API."
        : "The operation is safely queued on this offline tablet.",
      actorId === "tablet-north" ? "north" : "south",
      { operationId: operation?.operation_id },
    );
    if (current.online) {
      setBusy(true);
      try {
        await performSync(updated);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Sync failed.");
      } finally {
        setBusy(false);
      }
    }
  }

  async function handleManualSync(actorId: ActorId) {
    const replica = replicasRef.current.find((candidate) => candidate.actorId === actorId);
    if (!replica || busy) return;
    setBusy(true);
    try {
      await performSync(replica);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sync failed.");
    } finally {
      setBusy(false);
    }
  }

  const copy = phaseCopy(phase);
  const serverConflict = server?.conflicts.find((conflict) => conflict.field === "observation");
  const serverObservation = serverConflict
    ? `${serverConflict.candidates.length} offline notes saved — waiting for your decision`
    : (server?.state.observation ?? "Waiting for backend");
  const activeActor = phase === "offline-editing" ? "tablet-south" : phase === "reconnecting" ? "tablet-north" : undefined;

  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="brand" href="#top" aria-label="FieldMerge home">
          <span>FM</span>
          <div>
            <strong>FieldMerge</strong>
            <small>Offline inspection sync</small>
          </div>
        </a>
        <div className={`backend-status ${backendReady ? "is-ready" : "is-unavailable"}`} role="status">
          <i aria-hidden="true" />
          {backendReady ? "Server connected" : "Server unavailable"}
          {server && <span>update #{server.server_sequence}</span>}
        </div>
      </header>

      <main id="top">
        <section className="hero">
          <div className="hero__copy">
            <p className="eyebrow">Software that protects work during internet loss</p>
            <h1>Two workers edit the same report offline.</h1>
            <p className="hero__lede">
              FieldMerge saves each worker&apos;s changes on their device. When internet returns, it sends every change to the server, keeps disagreements for review, and updates everyone with the same approved report.
            </p>
            <p className="hero__risk"><strong>The problem it prevents:</strong> a normal “last save wins” system can silently erase the other worker&apos;s note.</p>
            <div className="hero__facts" aria-label="Project facts">
              <span><i /> Works while a device is offline</span>
              <span><i /> Stores every change in PostgreSQL</span>
              <span><i /> Updates both devices live</span>
            </div>
          </div>
          <div className="hero__promise">
            <p className="eyebrow">The guided demo starts here</p>
            <strong>Watch FieldMerge keep one offline note from erasing another.</strong>
            <p>You click once. The page creates two offline edits, reconnects both test tablets, and pauses when it needs your decision.</p>
            <a className="hero-cta" href="#live-proof">
              <span>Go to the guided demo</span>
              <small>One click · no setup · then one decision</small>
              <b aria-hidden="true">↓</b>
            </a>
          </div>
        </section>

        <section className="request-path" aria-labelledby="path-title">
          <div className="request-path__intro">
            <p className="eyebrow">What FieldMerge does</p>
            <h2 id="path-title">Save offline. Sync later. Lose nothing.</h2>
          </div>
          <ol>
            <li><span>01</span><strong>Worker taps Save</strong><small>The device keeps the change without internet</small></li>
            <li><span>02</span><strong>Internet returns</strong><small>The device sends its unsent changes</small></li>
            <li><span>03</span><strong>Server stores each change</strong><small>Repeated requests cannot create duplicates</small></li>
            <li><span>04</span><strong>FieldMerge checks edits</strong><small>Independent notes are kept for human review</small></li>
            <li><span>05</span><strong>Everyone receives the result</strong><small>Both devices get the approved report</small></li>
          </ol>
        </section>

        <section className="live-proof" id="live-proof" aria-labelledby="demo-title">
          <div className="demo-control">
            <div className="demo-control__phase" aria-live="polite">
              <span>{copy.number}</span>
              <div>
                <p className="eyebrow">{copy.label}</p>
                <h2 id="demo-title">{copy.title}</h2>
                <p>{copy.body}</p>
              </div>
            </div>
            <div className="demo-control__actions">
              {phase === "conflict" ? (
                <>
                  <span className="action-hint">Your decision is the only manual step.</span>
                  <a className="button button--primary" href="#resolution-panel">
                    Review both notes
                    <span aria-hidden="true">↓</span>
                  </a>
                </>
              ) : (
                <>
                  <button
                    className="button button--primary"
                    type="button"
                    disabled={busy || !backendReady}
                    onClick={() => void startGuidedProof()}
                  >
                    {busy ? "Demo running…" : phase === "proved" || phase === "error" ? "Run the demo again" : "Start the guided demo"}
                    <span aria-hidden="true">→</span>
                  </button>
                  <span className="action-hint">Steps 1–3 run automatically. The demo pauses at step 4 for you.</span>
                </>
              )}
              {!backendReady && <small>The demo needs the local server before it can start.</small>}
            </div>
          </div>

          <ol className="demo-progress" aria-label="Guided demo steps">
            {demoSteps.map((step, index) => {
              const currentStep = phaseStep(phase);
              const completed = currentStep > index;
              const active = phase !== "proved" && currentStep === index;
              return (
                <li className={`${completed ? "is-complete" : ""}${active ? " is-active" : ""}`} key={step}>
                  <span>{completed ? "✓" : index + 1}</span>
                  <strong>{step}</strong>
                </li>
              );
            })}
          </ol>

          <div className="demo-reality">
            <div>
              <span>Shown as a test scenario</span>
              <strong>Two field tablets losing and regaining signal</strong>
              <p>Both tablet screens are represented side by side in this browser so you can follow them together.</p>
            </div>
            <div>
              <span>Actually happening</span>
              <strong>Offline queues, API requests, database writes, and live updates</strong>
              <p>Reconnection uses the real FastAPI service and PostgreSQL database running with this project.</p>
            </div>
          </div>

          {error && (
            <div className="error-banner" role="alert">
              <strong>The demo stopped because the server did not respond.</strong>
              <span>{error}</span>
            </div>
          )}

          {phase === "conflict" && serverConflict && (
            <section className="resolution-panel" id="resolution-panel" aria-labelledby="resolution-title">
              <div className="resolution-panel__intro">
                <p className="eyebrow">Step 4 of 5 · Your input is needed</p>
                <h2 id="resolution-title">Keep one note or combine both.</h2>
                <p>
                  The workers edited the same report while neither could see the other&apos;s work. FieldMerge saved both notes. You decide what the shared report should say.
                </p>
              </div>
              <div className="resolution-candidates">
                {serverConflict.candidates.map((candidate, index) => (
                  <button
                    type="button"
                    key={candidate.operation_id}
                    onClick={() => setResolutionText(candidate.value)}
                  >
                    <span>{String(index + 1).padStart(2, "0")} · {candidate.actor_id.replace("tablet-", "Tablet ")}</span>
                    <strong>{candidate.value}</strong>
                    <small>Use only this note</small>
                  </button>
                ))}
              </div>
              <label className="resolution-input">
                <span>Final report wording</span>
                <textarea
                  rows={3}
                  value={resolutionText}
                  onChange={(event) => setResolutionText(event.target.value)}
                />
              </label>
              <button
                className="button button--resolve"
                type="button"
                disabled={busy || !resolutionText.trim()}
                onClick={() => void resolveConflict()}
              >
                {busy ? "Updating both tablets…" : "Save final report and update both tablets"}
                <span aria-hidden="true">→</span>
              </button>
              <details className="resolution-technical">
                <summary>View technical detail</summary>
                <p>The server records one resolution operation that references both saved notes. The original notes remain in the operation history.</p>
              </details>
            </section>
          )}

          <div className="replica-grid">
            {replicas.map((replica) => (
              <TabletCard
                key={replica.actorId}
                replica={replica}
                conflicts={server?.conflicts ?? []}
                active={activeActor === replica.actorId}
                busy={busy || phase === "conflict" || phase === "resolving"}
                onToggleConnection={(online) => void handleToggleConnection(replica.actorId, online)}
                onSync={() => void handleManualSync(replica.actorId)}
                onEdit={(field, value) => void handleManualEdit(replica.actorId, field, value)}
              />
            ))}
          </div>

          <section className={`server-copy ${serverConflict ? "server-copy--conflict" : ""}`} aria-label="Shared report on the server">
            <div className="server-copy__identity">
              <p className="eyebrow">Shared report on the server</p>
              <h3>Inspection PUMP-07</h3>
              <span>Stored in PostgreSQL</span>
            </div>
            <div className="server-copy__observation">
              <span>Server&apos;s current note</span>
              <strong>{serverObservation}</strong>
            </div>
            <div className="server-copy__meta">
              <span>Changes received</span>
              <strong>{server ? vectorLabel(server.version_vector) : "Waiting"}</strong>
              <span>Record fingerprint</span>
              <code>{shortDigest(server?.state_digest ?? null)}</code>
            </div>
          </section>

          <div className="evidence-grid">
            <Timeline entries={timeline} />
            <ProofPanel
              server={server}
              replicas={replicas}
              streamState={streamState}
              operationCount={operationCount}
              receipt={receipt}
              proved={phase === "proved"}
            />
          </div>
        </section>

        <section className="explanation" aria-labelledby="explanation-title">
          <div>
            <p className="eyebrow">Why an edit is not lost</p>
            <h2 id="explanation-title">How FieldMerge handles offline work safely.</h2>
          </div>
          <div className="explanation__cards">
            <article>
              <span>01</span>
              <h3>Give every change a unique ID</h3>
              <p>If a tablet sends the same saved change twice, the server recognizes it and stores it only once.</p>
            </article>
            <article>
              <span>02</span>
              <h3>Remember what each worker had seen</h3>
              <p>This reveals whether an edit replaced an older value or was written independently while another device was offline.</p>
            </article>
            <article>
              <span>03</span>
              <h3>Ask a person only when needed</h3>
              <p>Routine fields merge automatically. Two independent inspection notes stay visible until a person approves the final wording.</p>
            </article>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <div>
          <strong>FieldMerge</strong>
          <span>Keep working offline. Reconnect without losing an edit.</span>
        </div>
        <p>Test inspection only · real local API and database · no production field data</p>
      </footer>
    </div>
  );
}

export default App;
