import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as api from "./lib/api";
import { createReplica, queueOperation } from "./lib/replica";
import { loadReplicas, saveReplicas } from "./lib/storage";
import type { DocumentSnapshot, OperationEnvelope, SyncRequest, SyncResponse } from "./types";

vi.mock("./lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof api>(),
  getDocument: vi.fn(), getOperations: vi.fn(), resetDemo: vi.fn(), syncDocument: vi.fn(),
}));

const baseline: DocumentSnapshot = {
  document_id: "inspection-pump-07",
  state: { site_name: "North Pump Station", priority: "High", status: "Inspection in progress", observation: "Existing shared note." },
  conflicts: [], version_vector: { baseline: 4 }, state_digest: "baseline-digest", server_sequence: 4,
};
let document: DocumentSnapshot;
let operations: OperationEnvelope[];

function syncFixture(_id: string, request: SyncRequest): Promise<SyncResponse> {
  const accepted: string[] = [];
  const duplicates: string[] = [];
  for (const operation of request.pending_operations) {
    if (operations.some((stored) => stored.operation_id === operation.operation_id)) {
      duplicates.push(operation.operation_id);
      continue;
    }
    if (operation.kind === "resolve") {
      const candidates = document.conflicts[0]?.candidates ?? [];
      if (!candidates.length || candidates.some((c) => (operation.context[c.actor_id] ?? 0) < c.actor_counter)) {
        return Promise.reject(new Error("Resolution must have seen every candidate."));
      }
    }
    operations.push(structuredClone(operation));
    accepted.push(operation.operation_id);
    document.server_sequence++;
    document.version_vector[operation.actor_id] = operation.actor_counter;
    if (operation.field !== "observation") document.state[operation.field] = operation.value;
  }
  const notes = operations.filter((operation) => operation.field === "observation");
  const maxima = notes.filter((candidate) => !notes.some((other) =>
    other !== candidate && (other.context[candidate.actor_id] ?? 0) >= candidate.actor_counter,
  ));
  document.conflicts = maxima.length > 1 ? [{
    field: "observation",
    candidates: maxima.map((operation) => ({ operation_id: operation.operation_id, actor_id: operation.actor_id, actor_counter: operation.actor_counter, value: operation.value })),
  }] : [];
  if (maxima.length === 1) document.state.observation = maxima[0].value;
  if (maxima.length > 1) document.state.observation = null;
  document.state_digest = `digest-${document.server_sequence}`;
  return Promise.resolve(structuredClone({
    ...document, accepted_operation_ids: accepted, duplicate_operation_ids: duplicates,
    operations, sync_mode: "incremental",
  } satisfies SyncResponse));
}

function tablet(name: "Tablet North" | "Tablet South") {
  return within(screen.getByRole("article", { name }));
}
function writeNote(name: "Tablet North" | "Tablet South", text: string) {
  fireEvent.change(tablet(name).getByRole("textbox", { name: "What did you notice?" }), { target: { value: text } });
}
function saveNote(name: "Tablet North" | "Tablet South", text: string) {
  writeNote(name, text);
  fireEvent.click(tablet(name).getByRole("button", { name: "Save on this tablet" }));
}
async function mount() {
  render(<App />);
  await waitFor(() => expect(screen.getByText("Server connected")).toBeVisible());
}
async function sendPair() {
  saveNote("Tablet North", "A seal is leaking.");
  saveNote("Tablet South", "The motor is vibrating.");
  fireEvent.click(screen.getByRole("button", { name: "Reconnect & send notes" }));
  await waitFor(() => expect(screen.getByRole("heading", { name: "What should the shared note say?" })).toBeVisible());
}

describe("hands-on FieldMerge demo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    document = structuredClone(baseline);
    operations = [];
    vi.mocked(api.getDocument).mockImplementation(async () => structuredClone(document));
    vi.mocked(api.getOperations).mockImplementation(async () => structuredClone(operations));
    vi.mocked(api.syncDocument).mockImplementation(syncFixture);
    vi.mocked(api.resetDemo).mockImplementation(async () => { document = structuredClone(baseline); operations = []; return structuredClone(document); });
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("opens on empty editable tablets without automatically writing or resetting anything", async () => {
    await mount();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("No internet. Two notes. Neither lost.");
    expect(tablet("Tablet North").getByRole("textbox", { name: "What did you notice?" })).toHaveValue("");
    expect(tablet("Tablet South").getByRole("textbox", { name: "What did you notice?" })).toHaveValue("");
    expect(tablet("Tablet North").getByRole("button", { name: "Save on this tablet" })).toBeEnabled();
    expect(tablet("Tablet North").getByLabelText("Priority")).toHaveValue("High");
    expect(api.resetDemo).not.toHaveBeenCalled();
    expect(api.syncDocument).not.toHaveBeenCalled();
    expect(screen.getByText("See how the backend works").closest("details")).not.toHaveAttribute("open");
  });

  it("makes the backend explanation discoverable and lets the whole summary open and close it", async () => {
    await mount();
    const title = screen.getByText("See how the backend works");
    const summary = title.closest("summary")!;
    const details = title.closest("details")!;
    expect(title).toBeVisible();
    expect(screen.getByText("Requests, server report & history")).toBeVisible();
    expect(details).not.toHaveAttribute("open");
    fireEvent.click(summary);
    expect(details).toHaveAttribute("open");
    expect(screen.getByRole("heading", { name: "Shared report on the server" })).toBeVisible();
    fireEvent.click(summary);
    expect(details).not.toHaveAttribute("open");
    expect(screen.getByRole("heading", { name: "Shared report on the server", hidden: true })).not.toBeVisible();
  });

  it("saves only the user's note locally and protects unsaved drafts before sending", async () => {
    await mount();
    saveNote("Tablet North", "Check the seal.");
    expect(loadReplicas()?.[0].pending[0].value).toBe("Check the seal.");
    expect(tablet("Tablet North").getByText("1 unsent change")).toBeVisible();
    expect(api.syncDocument).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Reconnect & send notes" })).toBeDisabled();
    saveNote("Tablet South", "Check vibration.");
    expect(screen.getByRole("button", { name: "Reconnect & send notes" })).toBeEnabled();
    writeNote("Tablet South", "Updated draft.");
    expect(screen.getByRole("button", { name: "Reconnect & send notes" })).toBeDisabled();
    expect(loadReplicas()?.[1].pending[0].value).toBe("Check vibration.");
  });

  it("explains an empty save instead of silently doing nothing", async () => {
    await mount();
    fireEvent.click(tablet("Tablet North").getByRole("button", { name: "Save on this tablet" }));
    expect(tablet("Tablet North").getByText("Write a new note before saving.")).toBeVisible();
    expect(loadReplicas()?.[0].pending).toHaveLength(0);
  });

  it("saves priority and status through the same explicit Save button", async () => {
    await mount();
    fireEvent.change(tablet("Tablet North").getByLabelText("Priority"), { target: { value: "Urgent" } });
    expect(loadReplicas()?.[0].pending).toHaveLength(0);
    saveNote("Tablet North", "Check the pump.");
    expect(loadReplicas()?.[0].pending.map((op) => op.field)).toEqual(["observation", "priority"]);
    expect(api.syncDocument).not.toHaveBeenCalled();
  });

  it("takes manually written notes through a real-shaped conflict response and a validated resolution", async () => {
    await mount();
    await sendPair();
    expect(operations.filter((op) => op.kind === "set").map((op) => op.value)).toEqual(["A seal is leaking.", "The motor is vibrating."]);
    expect(screen.getByRole("textbox", { name: "Final shared note" })).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Combine both notes" }));
    fireEvent.click(screen.getByRole("button", { name: "Save & update both tablets" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Write another pair" })).toBeEnabled());
    expect(document.conflicts).toHaveLength(0);
    expect(operations.at(-1)).toMatchObject({ kind: "resolve", context: { "tablet-north": 1, "tablet-south": 1 } });
    expect(tablet("Tablet North").getByText("A seal is leaking. The motor is vibrating.")).toBeVisible();
    expect(tablet("Tablet South").getByText("A seal is leaking. The motor is vibrating.")).toBeVisible();
    expect(loadReplicas()?.every((replica) => !replica.pending.length && replica.digest === document.state_digest)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Write another pair" }));
    await waitFor(() => expect(tablet("Tablet North").getByRole("textbox", { name: "What did you notice?" })).toBeEnabled());
    expect(api.resetDemo).not.toHaveBeenCalled();
    expect(operations).toHaveLength(3);
  });

  it("keeps queued notes after a failed send and lets a retry reach review", async () => {
    await mount();
    saveNote("Tablet North", "A seal is leaking.");
    saveNote("Tablet South", "The motor is vibrating.");
    vi.mocked(api.syncDocument).mockRejectedValueOnce(new Error("Network interrupted"));
    fireEvent.click(screen.getByRole("button", { name: "Reconnect & send notes" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Network interrupted"));
    expect(loadReplicas()?.every((replica) => replica.pending.length === 1)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry sending saved changes" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "What should the shared note say?" })).toBeVisible());
    expect(operations).toHaveLength(2);
  });

  it("recovers from a lost response after the server has already stored a note without duplicating it", async () => {
    await mount();
    saveNote("Tablet North", "North note.");
    saveNote("Tablet South", "South note.");
    vi.mocked(api.syncDocument).mockImplementationOnce(async (id, request) => { await syncFixture(id, request); throw new Error("Response lost"); });
    fireEvent.click(screen.getByRole("button", { name: "Reconnect & send notes" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Response lost"));
    expect(operations).toHaveLength(1);
    expect(loadReplicas()?.[0].pending).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry sending saved changes" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "What should the shared note say?" })).toBeVisible());
    expect(operations).toHaveLength(2);
  });

  it("restores offline notes on refresh rather than resetting their server history", async () => {
    const north = queueOperation({ ...createReplica("tablet-north", baseline), online: false }, "observation", "Unsynced work.");
    saveReplicas([north, { ...createReplica("tablet-south", baseline), online: false }]);
    await mount();
    expect(tablet("Tablet North").getByRole("textbox", { name: "What did you notice?" })).toHaveValue("Unsynced work.");
    expect(loadReplicas()?.[0].pending).toHaveLength(1);
    expect(api.resetDemo).not.toHaveBeenCalled();
  });

  it("does not claim completion when the final verification read fails", async () => {
    await mount();
    await sendPair();
    fireEvent.click(screen.getByRole("button", { name: "Combine both notes" }));
    vi.mocked(api.getDocument).mockRejectedValueOnce(new Error("Verification read failed"));
    fireEvent.click(screen.getByRole("button", { name: "Save & update both tablets" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Verification read failed"));
    expect(screen.queryByRole("button", { name: "Write another pair" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry sending saved changes" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Write another pair" })).toBeEnabled());
  });

  it("keeps a rejected resolution editable rather than retrying it forever", async () => {
    await mount();
    await sendPair();
    fireEvent.click(screen.getByRole("button", { name: "Combine both notes" }));
    vi.mocked(api.syncDocument).mockImplementationOnce(syncFixture)
      .mockRejectedValueOnce(new api.ApiError(422, "resolution context changed"));
    fireEvent.click(screen.getByRole("button", { name: "Save & update both tablets" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Your wording is kept below"));
    expect(loadReplicas()?.every((replica) => replica.pending.length === 0)).toBe(true);
    expect(screen.getByRole("textbox", { name: "Final shared note" })).toHaveValue("A seal is leaking. The motor is vibrating.");
    fireEvent.click(screen.getByRole("button", { name: "Save & update both tablets" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Write another pair" })).toBeEnabled());
  });

  it("blocks an oversized combined note before it enters the saved queue", async () => {
    await mount();
    saveNote("Tablet North", "N".repeat(2000));
    saveNote("Tablet South", "S".repeat(2000));
    fireEvent.click(screen.getByRole("button", { name: "Reconnect & send notes" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Combine both notes" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Combine both notes" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Shorten it to 4,000 characters");
    expect(screen.getByRole("button", { name: "Save & update both tablets" })).toBeDisabled();
    expect(loadReplicas()?.every((replica) => replica.pending.length === 0)).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Final shared note" }), { target: { value: "Short approved note." } });
    expect(screen.getByRole("button", { name: "Save & update both tablets" })).toBeEnabled();
  });

  it("does not discard a new draft after only one tablet caught up with the conflict", async () => {
    await mount();
    saveNote("Tablet North", "North note.");
    saveNote("Tablet South", "South note.");
    vi.mocked(api.syncDocument).mockImplementationOnce(syncFixture).mockImplementationOnce(syncFixture)
      .mockRejectedValueOnce(new Error("North did not download the conflict"));
    fireEvent.click(screen.getByRole("button", { name: "Reconnect & send notes" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("North did not download"));
    writeNote("Tablet North", "A draft I have not saved yet.");
    fireEvent.click(screen.getByRole("button", { name: "Combine both notes" }));
    expect(screen.getByRole("button", { name: "Save & update both tablets" })).toBeDisabled();
    expect(tablet("Tablet North").getByRole("textbox", { name: "What did you notice?" })).toHaveValue("A draft I have not saved yet.");
  });

  it("requires an explicit confirmation before resetting the shared record", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Reset shared demo", hidden: true }));
    expect(api.resetDemo).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel", hidden: true }));
    expect(api.resetDemo).not.toHaveBeenCalled();
  });

  it("shows a retry when loading fails instead of permanently disabling the editor", async () => {
    vi.mocked(api.getDocument).mockRejectedValueOnce(new Error("Server unavailable"));
    render(<App />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry connection" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));
    await waitFor(() => expect(tablet("Tablet North").getByRole("button", { name: "Save on this tablet" })).toBeEnabled());
    expect(api.resetDemo).not.toHaveBeenCalled();
  });
});
