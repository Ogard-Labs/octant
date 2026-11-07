import { afterEach, expect, it, vi } from "vitest";
import {
  createMobileChatWithFirstTurn,
  listAllHostsMobileInbox,
  loadMobileChatThread,
} from "@octant/client-runtime";
import { createOfflineMobileDemo } from "./offlineMobileDemo";

afterEach(() => vi.unstubAllGlobals());
it("keeps sample interactions offline and resets them on a new demo visit", async () => {
  const network = vi.fn(() => {
    throw new Error("Demo attempted a network connection");
  });
  vi.stubGlobal("fetch", network);
  const scenario = createOfflineMobileDemo();
  expect(scenario.offlineDemo).toBe(true);
  const transport = scenario.transports[0];
  if (transport === undefined) throw new Error("Expected a sample transport");
  const before = await listAllHostsMobileInbox(scenario.transports);
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
