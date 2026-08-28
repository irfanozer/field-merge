import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

class TestWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readyState = TestWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(url: string | URL) {
    this.url = String(url);
    queueMicrotask(() => {
      this.readyState = TestWebSocket.OPEN;
      this.onopen?.(new Event("open"));
    });
  }

  close() {
    this.readyState = TestWebSocket.CLOSED;
  }

  send() {
    // The FieldMerge stream is server-to-browser only.
  }
}

vi.stubGlobal("WebSocket", TestWebSocket);

if (!globalThis.crypto?.randomUUID) {
  let nextId = 0;
  vi.stubGlobal("crypto", {
    randomUUID: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`,
  });
}
