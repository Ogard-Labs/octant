import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { decodeHostId, LOCAL_HOST_ID, type HostIdentity } from "@octant/contracts/host";
import type { RemoteCodeSurfaceProps } from "../remote/RemoteWorkspace";
import { HOST_ID, readyPairedBridge } from "./pairedComputerTestBridge.test-support";

const surfaces: RemoteCodeSurfaceProps[] = [];
vi.mock("../remote/RemoteWorkspace", () => ({
  RemoteCodeSurface: (props: RemoteCodeSurfaceProps) => {
    surfaces.push(props);
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
  const bridge = await readyPairedBridge(sent, { actsAsHostPerson });
  render(
    <PairedComputerCodeSurface
      bridge={bridge}
      hosts={hosts}
      selectedHostId={LAPTOP}
      onSelectHost={() => undefined}
    />,
  );
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
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
