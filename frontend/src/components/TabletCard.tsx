import { useState, type FormEvent } from "react";
import type { EditableField, Replica } from "../types";

export interface TabletEdit { field: EditableField; value: string }

interface TabletCardProps {
  replica: Replica;
  busy: boolean;
  ready: boolean;
  complete: boolean;
  onSave: (edits: TabletEdit[]) => void;
  onDraftChange: (dirty: boolean) => void;
}

export function TabletCard({ replica, busy, ready, complete, onSave, onDraftChange }: TabletCardProps) {
  const [note, setNote] = useState(() => replica.pending.filter((op) => op.field === "observation").at(-1)?.value ?? "");
  const [priority, setPriority] = useState(replica.state.priority);
  const [status, setStatus] = useState(replica.state.status);
  const [saved, setSaved] = useState(replica.pending.length > 0);
  const [message, setMessage] = useState("");
  const north = replica.actorId === "tablet-north";
  const conflict = replica.conflicts?.find((item) => item.field === "observation");

  function changed(nextNote: string, nextPriority: string, nextStatus: string) {
    onDraftChange(Boolean(
      (nextNote.trim() && nextNote.trim() !== replica.state.observation) ||
      nextPriority !== replica.state.priority || nextStatus !== replica.state.status,
    ));
    setMessage("");
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const edits: TabletEdit[] = [];
    if (note.trim() && note.trim() !== replica.state.observation) edits.push({ field: "observation", value: note.trim() });
    if (priority !== replica.state.priority) edits.push({ field: "priority", value: priority });
    if (status !== replica.state.status) edits.push({ field: "status", value: status });
    if (!edits.length) {
      setMessage(saved ? "No new changes to save." : "Write a new note before saving.");
      return;
    }
    onSave(edits);
    onDraftChange(false);
    setSaved(true);
    setMessage("Saved on this tablet. It has not been sent yet.");
  }

  return (
    <article className={`tablet tablet--${north ? "north" : "south"}`} aria-label={replica.label}>
      <div className="tablet__camera" aria-hidden="true" />
      <div className="tablet__screen">
        <header className="tablet__header">
          <div><span className="eyebrow">{replica.location}</span><h3>{replica.label}</h3></div>
          <span className={`connection-label ${replica.online ? "online" : "offline"}`}>
            <i aria-hidden="true" />{replica.online ? "Connected" : "Offline"}
          </span>
        </header>
        <div className="tablet__body">
          <p className="tablet__record">PUMP-07 <span>Inspection note</span></p>
          {complete || conflict ? (
            <div className="tablet__report">
              <span className="eyebrow">{conflict ? "Downloaded from the server" : "Shared report"}</span>
              {conflict ? <>
                <h4>Both notes arrived.</h4>
                <p>They describe the same inspection differently. Choose the shared wording below.</p>
                <a className="button button--secondary" href="#resolution-panel">Review both notes ↓</a>
              </> : <><p className="final-note">{replica.state.observation}</p><span className="saved-label">✓ Matches the server</span></>}
            </div>
          ) : (
            <form onSubmit={save}>
              <label htmlFor={`${replica.actorId}-note`}>What did you notice?</label>
              <textarea
                id={`${replica.actorId}-note`}
                value={note}
                onChange={(event) => { setNote(event.target.value); changed(event.target.value, priority, status); }}
                placeholder={north ? "For example: water is leaking near the seal." : "For example: the motor is vibrating more than usual."}
                rows={4}
                maxLength={2000}
                disabled={busy || !ready}
              />
              <details className="tablet__fields">
                <summary>Priority and status</summary>
                <div className="field-pair">
                  <label>Priority<select value={priority} disabled={busy || !ready} onChange={(event) => { setPriority(event.target.value); changed(note, event.target.value, status); }}>
                    {[...new Set([replica.state.priority, "Routine", "High", "Watch", "Urgent"])].map((value) => <option key={value}>{value}</option>)}
                  </select></label>
                  <label>Status<select value={status} disabled={busy || !ready} onChange={(event) => { setStatus(event.target.value); changed(note, priority, event.target.value); }}>
                    {[...new Set([replica.state.status, "Inspection in progress", "Needs follow-up", "Ready for service"])].map((value) => <option key={value}>{value}</option>)}
                  </select></label>
                </div>
              </details>
              <button className="button button--tablet" type="submit" disabled={busy || !ready}>
                {busy ? "Sync in progress…" : "Save on this tablet"}
              </button>
              <p className="save-feedback" role="status">{message || (saved ? "Saved here. Ready to send." : "Type your own note. Examples are not added for you.")}</p>
            </form>
          )}
        </div>
        <footer className="tablet__footer">
          <span>{replica.pending.length ? `${replica.pending.length} unsent ${replica.pending.length === 1 ? "change" : "changes"}` : "No unsent changes"}</span>
          <span>{replica.pending.length ? "Stored in this browser" : replica.online ? "Server copy received" : "Ready for your note"}</span>
        </footer>
      </div>
      <div className="tablet__home" aria-hidden="true" />
    </article>
  );
}
