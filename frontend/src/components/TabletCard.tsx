import type { FormEvent } from "react";
import type { EditableField, FieldConflict, Replica } from "../types";
import { shortDigest, vectorLabel } from "../lib/replica";

interface TabletCardProps {
  replica: Replica;
  conflicts: FieldConflict[];
  active?: boolean;
  busy: boolean;
  onToggleConnection: (online: boolean) => void;
  onSync: () => void;
  onEdit: (field: EditableField, value: string) => void;
}

const priorities = ["Routine", "Watch", "Urgent"];
const statuses = ["Inspection in progress", "Needs follow-up", "Ready for service"];

export function TabletCard({
  replica,
  conflicts,
  active = false,
  busy,
  onToggleConnection,
  onSync,
  onEdit,
}: TabletCardProps) {
  const observationConflict = conflicts.find((conflict) => conflict.field === "observation");

  function submitObservation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const next = String(data.get("observation") ?? "").trim();
    if (!next || next === replica.state.observation) return;
    onEdit("observation", next);
  }

  return (
    <article
      className={`tablet-card tablet-card--${replica.actorId === "tablet-north" ? "north" : "south"}${active ? " tablet-card--active" : ""}`}
      aria-label={`${replica.label} replica`}
    >
      <header className="tablet-card__header">
        <div>
          <p className="eyebrow">Worker&apos;s tablet · {replica.location}</p>
          <h3>{replica.label}</h3>
        </div>
        <button
          className={`connection-switch ${replica.online ? "is-online" : "is-offline"}`}
          type="button"
          role="switch"
          aria-checked={replica.online}
          aria-label={`${replica.label} network connection`}
          disabled={busy}
          onClick={() => onToggleConnection(!replica.online)}
        >
          <span aria-hidden="true" />
          {replica.online ? "Online" : "Offline"}
        </button>
      </header>

      <div className="tablet-card__screen">
        <div className="record-heading">
          <div>
            <span>Inspection report</span>
            <strong>PUMP-07</strong>
          </div>
          <span className={`queue-pill ${replica.pending.length ? "has-items" : ""}`}>
            {replica.pending.length
              ? `${replica.pending.length} ${replica.pending.length === 1 ? "edit" : "edits"} waiting to send`
              : "All edits sent"}
          </span>
        </div>

        <dl className="record-grid">
          <div>
            <dt>Site</dt>
            <dd>{replica.state.site_name}</dd>
          </div>
          <div>
            <dt>Priority</dt>
            <dd>{replica.state.priority}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{replica.state.status}</dd>
          </div>
        </dl>

        <section className={`observation-box ${observationConflict ? "has-conflict" : ""}`}>
          <div className="observation-box__label">
            <span>Worker&apos;s inspection note</span>
            {observationConflict && <strong>Both offline notes saved</strong>}
          </div>
          <p>{observationConflict ? "Two notes are waiting for your review." : (replica.state.observation ?? "No note yet.")}</p>
          {observationConflict && (
            <ul className="candidate-mini-list">
              {observationConflict.candidates.map((candidate) => (
                <li key={candidate.operation_id}>
                  <span>{candidate.actor_id.replace("tablet-", "Tablet ")}</span>
                  {candidate.value}
                </li>
              ))}
            </ul>
          )}
        </section>

        <details className="replica-technical">
          <summary>View technical sync details</summary>
          <div className="replica-proof-row">
            <div>
              <span>Changes this tablet has seen</span>
              <strong>{vectorLabel(replica.vector)}</strong>
            </div>
            <div>
              <span>Record fingerprint</span>
              <strong>{shortDigest(replica.digest)}</strong>
            </div>
          </div>
        </details>
      </div>

      <details className="manual-editor">
        <summary>Optional: edit this tablet yourself</summary>
        <p>
          The edit is written to this tablet first. {replica.online ? "It will then sync to the server." : "It will wait here until signal returns."}
        </p>
        <div className="manual-editor__selects">
          <label>
            <span>Priority</span>
            <select
              value={replica.state.priority}
              disabled={busy}
              onChange={(event) => onEdit("priority", event.target.value)}
            >
              {priorities.map((priority) => <option key={priority}>{priority}</option>)}
            </select>
          </label>
          <label>
            <span>Status</span>
            <select
              value={replica.state.status}
              disabled={busy}
              onChange={(event) => onEdit("status", event.target.value)}
            >
              {statuses.map((status) => <option key={status}>{status}</option>)}
            </select>
          </label>
        </div>
        <form onSubmit={submitObservation}>
          <label>
            <span>Observation</span>
            <textarea
              key={replica.state.observation}
              name="observation"
              defaultValue={replica.state.observation ?? ""}
              disabled={busy}
              rows={3}
              required
            />
          </label>
          <button className="button button--compact" type="submit" disabled={busy}>
            Save on this tablet
          </button>
        </form>
      </details>

      <footer className="tablet-card__footer">
        <span>
          {replica.lastSyncAt
            ? `Last updated from server ${new Date(replica.lastSyncAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
            : "No server update yet"}
        </span>
        <button
          type="button"
          className="text-button"
          disabled={busy || !replica.online}
          onClick={onSync}
        >
          Check for updates →
        </button>
      </footer>
    </article>
  );
}
