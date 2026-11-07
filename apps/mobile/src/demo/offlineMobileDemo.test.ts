import { afterEach, expect, it, vi } from "vitest";
import {
  createMobileChatWithFirstTurn,
  listAllHostsMobileInbox,
  loadMobileChatThread,
} from "@octant/client-runtime";
import { createOfflineMobileDemo } from "./offlineMobileDemo";
import { runChatEventLoop } from "../inbox/thread/chatEventLoop";

vi.mock("react-native", () => ({ AppState: { currentState: "active" } }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("keeps sample interactions offline and resets them on a new demo visit", async () => {
  class NativeResponse extends Response {}
  Object.defineProperty(NativeResponse, "json", { value: undefined });
  vi.stubGlobal("Response", NativeResponse);
  const network = vi.fn(() => {
    throw new Error("Demo attempted a network connection");
  });
  vi.stubGlobal("fetch", network);
  const scenario = createOfflineMobileDemo();
  expect(scenario.offlineDemo).toBe(true);
  const transport = scenario.transports[0];
  if (transport === undefined) throw new Error("Expected a sample transport");
  const before = await listAllHostsMobileInbox(scenario.transports);
  expect(before.failures).toEqual([]);
  expect(before.rows.length).toBeGreaterThan(0);
  const row = await createMobileChatWithFirstTurn({ transport, prompt: "Plan a sample task" });
  expect((await listAllHostsMobileInbox(scenario.transports)).rows).toHaveLength(
    before.rows.length + 1,
  );
  const thread = await loadMobileChatThread(transport, row.threadId);
  expect(thread.contents).toEqual(
    expect.arrayContaining([expect.objectContaining({ role: "user", body: "Plan a sample task" })]),
  );
  expect((await listAllHostsMobileInbox(createOfflineMobileDemo().transports)).rows).toHaveLength(
    before.rows.length,
  );
  expect(network).not.toHaveBeenCalled();
});

it("keeps an offline sample thread connected when native responses cannot expose a stream body", async () => {
  class NativeResponse extends Response {
    constructor(body?: BodyInit | null, init?: ResponseInit) {
      super(body, init);
      Object.defineProperty(this, "body", { value: undefined });
    }
  }
  vi.stubGlobal("Response", NativeResponse);
  vi.useFakeTimers();
  const transport = createOfflineMobileDemo().transports[0];
  if (transport === undefined) throw new Error("Expected a sample transport");
  const controller = new AbortController();
  const reconnecting = vi.fn();
  const loop = runChatEventLoop({
    transport,
    threadId: "40000000-0000-4000-8000-000000000001",
    startSequence: 0,
    signal: controller.signal,
    onView: () => undefined,
    onReconnecting: reconnecting,
  });
  try {
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reconnecting).not.toHaveBeenCalledWith(true);
  } finally {
    controller.abort();
    await loop;
  }
});
