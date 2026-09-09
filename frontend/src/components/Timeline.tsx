import type { TimelineEntry } from "../types";
import { shortOperationId } from "../lib/replica";

interface TimelineProps {
  entries: TimelineEntry[];
}

export function Timeline({ entries }: TimelineProps) {
  return (
    <section className="timeline-panel" aria-labelledby="timeline-title">
      <header className="section-heading section-heading--compact">
        <div>
          <p className="eyebrow">Real activity from this demo</p>
          <h2 id="timeline-title">What happened, in order</h2>
        </div>
        <span className="record-count">{entries.length} updates</span>
      </header>

      {entries.length === 0 ? (
        <div className="timeline-empty">
          <span>01</span>
          <p>Your local saves and completed sync requests will appear here.</p>
        </div>
      ) : (
        <ol className="timeline-list">
          {entries.map((entry, index) => (
            <li className={`timeline-entry timeline-entry--${entry.tone}`} key={entry.id}>
              <div className="timeline-index">{String(index + 1).padStart(2, "0")}</div>
              <div className="timeline-copy">
                <div className="timeline-meta">
                  <span>{entry.source}</span>
                  <time dateTime={entry.at}>
                    {new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  </time>
                </div>
                <strong>{entry.title}</strong>
                <p>{entry.detail}</p>
                {(entry.operationId || entry.sequence !== undefined) && (
                  <details className="timeline-technical">
                    <summary>Technical record</summary>
                    <div className="timeline-ids">
                      {entry.operationId && <span>change ID {shortOperationId(entry.operationId)}</span>}
                      {entry.sequence !== undefined && <span>server update {entry.sequence}</span>}
                    </div>
                  </details>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
