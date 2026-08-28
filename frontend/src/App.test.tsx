import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

const documentResponse = {
  document_id: "inspection-pump-07",
  state: {
    site_name: "North Pump Station",
    priority: "High",
    status: "Inspection in progress",
    observation: "Seal is stable; monitor vibration.",
  },
  conflicts: [],
  version_vector: { baseline: 4 },
  state_digest: "b74d9f45a681d5b7",
  server_sequence: 4,
};

describe("FieldMerge recruiter demo", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.endsWith("/operations")
        ? { document_id: "inspection-pump-07", operations: [], count: 0 }
        : documentResponse;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("explains the product and its real request path before manual controls", async () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "Two workers edit the same report offline." })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Save offline. Sync later. Lose nothing." })).toBeVisible();
    expect(screen.getByText("Stores every change in PostgreSQL")).toBeVisible();
    expect(screen.getAllByText("Tablet North").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Tablet South").length).toBeGreaterThan(0);

    await waitFor(() => expect(screen.getByText("Server connected")).toBeVisible());
    expect(screen.getByRole("button", { name: /Start the guided demo/i })).toBeEnabled();
  });

  it("labels the server evidence as backend-issued proof", async () => {
    render(<App />);

    await waitFor(() => expect(screen.getByText("update #4")).toBeVisible());
    expect(screen.getByRole("heading", { name: "Waiting for the guided demo." })).toBeVisible();
    expect(screen.getByText("Shared report on the server")).toBeVisible();
    expect(screen.getByText("View technical verification")).toBeVisible();
  });
});
