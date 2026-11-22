import { createDefaultDeviceKeyStore, createRemoteSessionBridge } from "@octant/client-runtime";
import { decodeCodeThreadId } from "@octant/contracts/code";
import { describe, expect, it, vi } from "vitest";
import { ORIGIN, readyPairedBridge } from "../host/pairedComputerTestBridge.test-support";
import { createRemoteProductClients } from "./remoteProductClients";

describe("remote product clients", () => {
  it("lets a paired browser read a person's saved decision answers and never write them", () => {
    const bridge = createRemoteSessionBridge({
      fetch: vi.fn(),
      deviceKeyStore: createDefaultDeviceKeyStore(),
    });
    const { canvas } = createRemoteProductClients(bridge);
    expect(canvas.choiceAnswers).toBeTypeOf("function");
    expect(canvas).not.toHaveProperty("reviseChoiceAnswers");
    expect(canvas).not.toHaveProperty("comment");
  });

  it("polls paired Code events without losing the thread cursor", async () => {
    const sent: URL[] = [];
    const bridge = await readyPairedBridge(sent);
    expect(createRemoteProductClients(bridge).code.threadEvents).toBeUndefined();

    const clients = createRemoteProductClients(bridge, { threadEvents: "poll" });
    const thread = decodeCodeThreadId("a1b2c3d4-0000-4000-8000-000000000001");
    for await (const frame of clients.code.subscribe(thread, 4, new AbortController().signal)) {
      void frame;
    }

    const read = sent.find((url) => url.pathname === `/api/code/threads/${thread}/events`);
    expect(read?.origin).toBe(ORIGIN);
    expect(read?.searchParams.get("wait")).toBe("0");
    expect(read?.searchParams.get("afterSequence")).toBe("4");
    expect(clients.code.threadEvents).toBe("poll");
  });

  it("offers a paired browser a server Project's preview but no port forward onto the host's loopback", () => {
    const bridge = createRemoteSessionBridge({
      fetch: vi.fn(),
      deviceKeyStore: createDefaultDeviceKeyStore(),
    });
    const { serverProjects } = createRemoteProductClients(bridge);
    expect(serverProjects?.previewCommand).toBeTypeOf("function");
    expect(serverProjects).not.toHaveProperty("forwardCommand");
    expect(serverProjects).not.toHaveProperty("forwardRead");
  });
});
