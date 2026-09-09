import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, getDocument } from "./api";

describe("API request failures", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("retains the HTTP status so confirmed validation failures can be repaired safely", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: "Context changed" }), { status: 422 })));
    await expect(getDocument("test")).rejects.toMatchObject({ status: 422, message: "Context changed" });
    await expect(getDocument("test")).rejects.toBeInstanceOf(ApiError);
  });

  it("times out a stalled request instead of leaving every Save button locked", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })));
    const result = expect(getDocument("test")).rejects.toThrow("Your saved edits are still on the tablet");
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });
});
