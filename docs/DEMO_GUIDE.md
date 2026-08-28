# One-minute FieldMerge demo guide

## Ten-second explanation

"FieldMerge stops one worker's offline note from overwriting another. This demo
shows two test tablets in one browser, saves a different note on each while they
are offline, sends both to the server when internet returns, asks me to approve
the final wording, and proves both tablets and PostgreSQL now match."

## What is simulated and what is real

The browser represents two field tablets and deliberately shows them losing and
regaining signal. That is the guided test scenario; no physical tablet has to be
disconnected during a portfolio demonstration.

The important system behavior is real:

- each tablet has its own browser-side copy and offline queue;
- reconnecting sends real HTTP requests to FastAPI;
- PostgreSQL stores the operations and materialized report;
- the backend keeps both independently written notes for review;
- WebSocket messages announce committed server updates;
- the final proof compares the content saved on both tablets with the server.

## Guided walkthrough

1. At the top of the page, summarize the problem: two workers edit the same
   report while neither can see the other's work. A normal last-save-wins system
   can silently erase one note.
2. Select **Go to the guided demo**. This scrolls to the interactive section.
3. Select **Start the guided demo**. Steps 1-3 run automatically while the
   five-step tracker remains visible.
4. Watch each tablet change to **Offline** and show **1 edit waiting to send**.
   The notes exist on the devices, but the shared server report has not received
   them yet.
5. The tablets reconnect. The real API sends both notes to PostgreSQL. The page
   pauses at step 4 and moves to **Keep one note or combine both.**
6. Point out that both worker notes are still visible. Choose either note or keep
   the prefilled combined wording, then select **Save final report and update
   both tablets**.
7. End on **Verified: both tablets match the server.** The count of notes waiting
   for review is zero, and the two tablets show the approved report.

The only visitor decision is the final wording. FieldMerge performs saving,
reconnection, server storage, conflict detection, and redistribution.

## What to point at first

- **The five-step tracker** tells a new visitor what is happening now and what
  will happen next.
- **Edits waiting to send** proves the worker can save before the device is
  connected.
- **Shared report on the server** separates local device state from the copy in
  PostgreSQL.
- **Keep one note or combine both** shows that software does not invent a safety
  decision when two workers genuinely disagree.
- **How you know it worked** reports database writes, the latest server update,
  unresolved notes, and the last sync result.

Technical identifiers, version history, record fingerprints, and request
details are available under **View technical sync details** and **View technical
verification**. Open those only when the viewer asks how the result is proven.

## Useful follow-up answers

**Why not just use the newest timestamp?** Device clocks can be wrong, and a
timestamp does not reveal whether one edit saw the other. FieldMerge records
what each tablet had already seen so it can distinguish a later edit from two
independent edits.

**Why does the application ask a person to decide?** Both workers changed the
same inspection note without seeing each other's work. Silently choosing one
could discard important field information. FieldMerge keeps both and asks for
the one decision the software should not guess.

**What happens if a tablet sends the same change twice?** Every change has a
unique ID and per-tablet counter. The API recognizes a retry and does not store
the same change twice.

**Does WebSocket store the result?** No. PostgreSQL and the HTTP synchronization
request are authoritative. WebSocket only tells connected pages that a saved
server update is ready to display. A reconnecting tablet can recover through
HTTP even if it missed a live message.

**Are the two tablets physical devices?** Not in this guided demonstration. They
are two independent logical device copies shown in one browser so a recruiter
can follow both at once. The same synchronization contract can be used by real
clients later.

**Is this a finished field-service product?** No. It is a working
synchronization engine and a bounded public demonstration using one fictional
inspection. Accounts, tenant isolation, attachments, and native mobile
packaging would belong to a full product around this engine.
