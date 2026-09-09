# Hands-on FieldMerge demo

## Explain it in one sentence

FieldMerge lets two workers write inspection notes without internet, sends both
when they reconnect, and keeps conflicting notes for a person to review.

## Try it

1. Write a different note on each tablet. The example text is a placeholder,
   not a saved note.
2. Press **Save on this tablet** on each screen. Each tablet now shows an
   unsent change. These saves stay in your browser.
3. Press **Reconnect & send notes**. The tablets send their queued operations
   through the sync API. The database keeps both independently written notes.
4. Choose one saved note, press **Combine both notes**, or write your own final
   wording. Nothing is selected automatically.
5. Press **Save & update both tablets**. The page reads the result back from
   the server and checks that both tablet copies match it.
6. To try again without deleting history, press **Write another pair**.

The four-step tracker shows where you are. **Where your changes go** explains
the path from browser storage to API, database, and back to the tablets.
**See how the backend works** contains request receipts, the server's report fingerprint,
and the activity history.

Priority and status are available inside each tablet. Changing them does not
save immediately: the same **Save on this tablet** button saves all changed
fields. Save any unfinished draft before sending or approving a shared note.

## What is real

The two tablet screens and their offline connections are simulated in one
browser. The page itself stays connected. Each tablet has its own state and
queue, persisted in browser storage when storage is available.

Sending uses real HTTP requests to FastAPI and real PostgreSQL writes.
WebSocket notifications update the server view, not an offline tablet.
A tablet receives a new report through an explicit sync request. The final
check compares both tablet fingerprints with a separate API readback.

## Failure and retry

A failed or timed-out sync keeps unacknowledged operations queued. Sending
again uses the same operation IDs so the server can recognize duplicates.
An edit is not called synchronized until the server acknowledges it.

Reloading does not reset the shared record. Saved, unsent notes are restored
from browser storage. Unsaved typing is only a draft; press Save before
refreshing. If storage is blocked, the page warns that local edits will only
last while the page stays open.

If another visitor changes the notes during review, refresh and review the new
candidates before approving a resolution. A rejected resolution keeps its
wording editable instead of endlessly resending an invalid operation.

## Shared test data

This is a public demonstration with one fictional inspection, not isolated
accounts. Other visitors can change the shared record. Do not enter personal
information. **Reset shared demo**, under the technical details, requires
confirmation and clears shared history and this browser's edits and drafts.
