import { describe, expect, it } from "vitest";
import { ORIGIN, readyPairedBridge } from "./pairedComputerTestBridge.test-support";
import { createPairedComputerCodeClients } from "./pairedComputerCodeClients";

describe("a paired computer's Code clients", () => {
  it("send Code reads over that computer's session and read thread events without waiting", async () => {
    const sent: URL[] = [];
    const clients = createPairedComputerCodeClients(await readyPairedBridge(sent));
    const thread = "a1b2c3d4-0000-4000-8000-000000000001";

    for await (const frame of clients.code.subscribe(
      thread as never,
      4,
      new AbortController().signal,
    )) {
      void frame;
    }

    expect(clients.code.threadEvents).toBe("poll");
    const read = sent.find((url) => url.pathname === `/api/code/threads/${thread}/events`);
    // The read goes to the paired computer's origin over its signed session and
    // asks it not to hold the read open.
    expect(read?.origin).toBe(ORIGIN);
    expect(read?.searchParams.get("wait")).toBe("0");
    expect(read?.searchParams.get("afterSequence")).toBe("4");
  });
});
