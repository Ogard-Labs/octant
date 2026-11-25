import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { decodeHostId, LOCAL_HOST_ID, type HostIdentity } from "@octant/contracts/host";
import { decodeImageGenerationScopeId, decodeVideoJobId } from "@octant/contracts";
import { useContext, type ContextType } from "react";
import { ComposerStashScopeContext } from "../composer/ComposerStashControls";
import type { RemoteCodeSurfaceProps } from "../remote/RemoteWorkspace";
import { VideoClientContext } from "../video/ThreadVideoClips";
import { HOST_ID, ORIGIN, readyPairedBridge } from "./pairedComputerTestBridge.test-support";

const surfaces: RemoteCodeSurfaceProps[] = [];
const videoClients: Array<ContextType<typeof VideoClientContext>> = [];
const draftScopes: Array<ContextType<typeof ComposerStashScopeContext>> = [];
vi.mock("../remote/RemoteWorkspace", () => ({
  RemoteCodeSurface: (props: RemoteCodeSurfaceProps) => {
    surfaces.push(props);
    videoClients.push(useContext(VideoClientContext));
    draftScopes.push(useContext(ComposerStashScopeContext));
    return <p>Paired computer's Code</p>;
  },
}));

const { PairedComputerCodeSurface } = await import("./PairedComputerCodeSurface");

const LAPTOP = decodeHostId(HOST_ID);
const hosts: ReadonlyArray<HostIdentity> = [
  { hostId: LOCAL_HOST_ID, displayName: "This Mac", health: "healthy", capabilities: ["code"] },
  { hostId: LAPTOP, displayName: "Laptop", health: "healthy", capabilities: ["code"] },
];

async function surfaceFor(actsAsHostPerson: boolean, sent: URL[] = []) {
  surfaces.length = 0;
  videoClients.length = 0;
  draftScopes.length = 0;
  const bridge = await readyPairedBridge(sent, { actsAsHostPerson });
  const thisComputer = { list: vi.fn(), clipUrl: vi.fn() };
  render(
    <VideoClientContext.Provider value={thisComputer}>
      <PairedComputerCodeSurface
        bridge={bridge}
        hosts={hosts}
        selectedHostId={LAPTOP}
        onSelectHost={() => undefined}
      />
    </VideoClientContext.Provider>,
  );
  return thisComputer;
}

describe("a paired computer's Code start screen", () => {
  it("offers the start form once that computer says this device acts as its person", async () => {
    await surfaceFor(true);
    await waitFor(() => expect(surfaces.at(-1)?.actsAsHostPerson).toBe(true));
    const latest = surfaces.at(-1);
    // Threads are followed by short reads, and the page's address, which names
    // a thread on this computer, never opens one on the other.
    expect(latest?.clients.code.threadEvents).toBe("poll");
    expect(latest?.followsContinuationLink).toBe(false);
    expect(latest?.connected).toBe(true);
  });

  it("shows the threads without a start form to a device that computer restricts", async () => {
    await surfaceFor(false);
    await waitFor(() => expect(surfaces.length).toBeGreaterThan(0));
    // Give the standing read time to answer; it must stay restricted.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(surfaces.every((props) => props.actsAsHostPerson === false)).toBe(true);
    expect(videoClients.every((client) => client === undefined)).toBe(true);
    expect(draftScopes.at(-1)).toMatchObject({ host: HOST_ID, reconcilePurges: undefined });
  });

  it("lists and opens video clips through the paired computer's session", async () => {
    const scopeId = decodeImageGenerationScopeId("d4000000-0000-4000-8000-000000000002");
    const jobId = decodeVideoJobId("d4000000-0000-4000-8000-000000000003");
    const sent: URL[] = [];
    const thisComputer = await surfaceFor(true, sent);
    await waitFor(() => expect(surfaces.at(-1)?.actsAsHostPerson).toBe(true));
    const paired = videoClients.at(-1);

    await expect(paired?.list({ threadKind: "code-thread", scopeId })).resolves.toEqual({
      jobs: [],
    });
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:paired-clip");
    try {
      await expect(paired?.clipUrl(jobId)).resolves.toMatchObject({ url: "blob:paired-clip" });
      expect(createObjectURL).toHaveBeenCalledOnce();
      const clip = createObjectURL.mock.calls[0]?.[0];
      if (clip === undefined || !("arrayBuffer" in clip))
        throw new Error("The player did not receive a clip blob.");
      expect(new Uint8Array(await clip.arrayBuffer())).toEqual(Uint8Array.of(1, 2, 3));
    } finally {
      createObjectURL.mockRestore();
    }
    const videoRequests = sent.filter((url) => url.pathname.startsWith("/api/video/"));
    expect(videoRequests.map((url) => [url.origin, url.pathname])).toEqual([
      [ORIGIN, "/api/video/jobs"],
      [ORIGIN, "/api/video/clip"],
      [ORIGIN, "/api/video/clip"],
      [ORIGIN, "/api/video/clip"],
    ]);
    expect(videoRequests[0]?.searchParams.get("scopeId")).toBe(String(scopeId));
    expect(thisComputer.list).not.toHaveBeenCalled();
    expect(thisComputer.clipUrl).not.toHaveBeenCalled();
  });

  it("lists a thread's MCP tool approvals on that computer, so one Needs you opens can be answered there", async () => {
    const sent: URL[] = [];
    await surfaceFor(true, sent);
    await waitFor(() => expect(surfaces.at(-1)?.actsAsHostPerson).toBe(true));
    const client = surfaces.at(-1)?.extensionClient;
    expect(client?.toolGrantsAvailable).toBe(true);
    await client?.listToolApprovals().catch(() => undefined);
    expect(sent.some((url) => url.pathname === "/api/extensions/tool-approvals")).toBe(true);
  });

  it("reads confirmed purges from a computer that paired this device at Full", async () => {
    vi.stubGlobal("indexedDB", {});
    try {
      const sent: URL[] = [];
      await surfaceFor(true, sent);
      await waitFor(() =>
        expect(sent.some((url) => url.pathname === "/api/host-control/thread-retention")).toBe(
          true,
        ),
      );
      expect(draftScopes.at(-1)).toMatchObject({
        host: HOST_ID,
        reconcilePurges: expect.any(Function),
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
