import { createDefaultDeviceKeyStore, createRemoteSessionBridge } from "@octant/client-runtime";
import { decodeCodeThreadId } from "@octant/contracts/code";
import { describe, expect, it, vi } from "vitest";
import { ORIGIN, readyPairedBridge } from "../host/pairedComputerTestBridge.test-support";
import { canvasClientFor, createRemoteProductClients } from "./remoteProductClients";

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

  it("restores a cleaned-up worktree over the session, with no window capability to send", async () => {
    const sent: URL[] = [];
    const bridge = await readyPairedBridge(sent);
    const thread = decodeCodeThreadId("a1b2c3d4-0000-4000-8000-000000000001");
    await createRemoteProductClients(bridge)
      .worktrees?.restore(thread)
      .catch(() => undefined);
    const restore = sent.find((url) => url.pathname === "/api/code/cleaned-up-worktrees/restore");
    expect(restore?.origin).toBe(ORIGIN);
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

  describe("the Canvas controls only the host's own person has", () => {
    const personControls = [
      "networkAccess",
      "setNetworkAccess",
      "renewNetworkPage",
      "exportOffers",
      "prepareExport",
      "decideExport",
      "dismissExportNotice",
      "revokePublicShare",
      "publicLinkSettings",
      "setPublicLinkSettings",
      "comments",
      "comment",
      "listDesignSystems",
      "applyDesignSystem",
    ] as const;
    const clients = () =>
      createRemoteProductClients(
        createRemoteSessionBridge({
          fetch: vi.fn(),
          deviceKeyStore: createDefaultDeviceKeyStore(),
        }),
      );

    it("gives a person-paired browser the network switch, public links, export approval, comments and design-system switch", () => {
      const canvas = canvasClientFor(clients(), true);
      for (const control of personControls) expect(canvas[control]).toBeTypeOf("function");
    });

    it("never gives a person-paired browser the host's native folder picker", () => {
      const canvas = canvasClientFor(clients(), true);
      expect(canvas).not.toHaveProperty("chooseExportFolder");
      expect(canvas).not.toHaveProperty("exportFolder");
    });

    it("offers a hub-introduced, restricted or read-only browser none of them", () => {
      const canvas = canvasClientFor(clients(), false);
      for (const control of personControls) expect(canvas).not.toHaveProperty(control);
    });
  });
});
