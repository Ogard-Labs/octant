import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { decodeHostId, LOCAL_HOST_ID, type HostIdentity } from "@octant/contracts/host";
import type { RemoteCodeSurfaceProps } from "../remote/RemoteWorkspace";
import { readyPairedBridge } from "./pairedComputerTestBridge.test-support";

const surfaces: RemoteCodeSurfaceProps[] = [];
vi.mock("../remote/RemoteWorkspace", () => ({
  RemoteCodeSurface: (props: RemoteCodeSurfaceProps) => {
    surfaces.push(props);
    return <p>Paired computer's Code</p>;
  },
}));

const { PairedComputerCodeSurface } = await import("./PairedComputerCodeSurface");

const LAPTOP = decodeHostId("22222222-2222-4222-8222-222222222222");
const hosts: ReadonlyArray<HostIdentity> = [
  { hostId: LOCAL_HOST_ID, displayName: "This Mac", health: "healthy", capabilities: ["code"] },
  { hostId: LAPTOP, displayName: "Laptop", health: "healthy", capabilities: ["code"] },
];

async function surfaceFor(actsAsHostPerson: boolean) {
  surfaces.length = 0;
  const bridge = await readyPairedBridge([], { actsAsHostPerson });
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
});
