import { render, screen } from "@testing-library/react";
import { decodeLocalServerSnapshot } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { DockThreadOverviewContent } from "./DockThreadOverviewContent";

const threadA = "10000000-0000-4000-8000-0000000000a1";
const threadB = "10000000-0000-4000-8000-0000000000b2";
const projectId = "10000000-0000-4000-8000-000000000001";

const reading = vi.hoisted(() => ({ snapshot: undefined as unknown }));

vi.mock("../environment/useLocalServersController", () => ({
  useLocalServersController: () => ({ status: "ready", snapshot: reading.snapshot }),
}));

function snapshotFor(threadId: string) {
  return decodeLocalServerSnapshot({
    threadId,
    projectId,
    currentCheckout: [
      {
        listenerId: `lsn_${"a".repeat(32)}`,
        port: 5377,
        url: "http://127.0.0.1:5377/",
        processName: "node",
        framework: "vite",
        attribution: "current-checkout",
        startSource: "unknown",
        bindScope: "loopback",
        health: "listening",
        openAvailable: true,
        stop: { status: "unavailable", reason: "Not started by Octant" },
      },
    ],
    other: [],
    observedAt: "2026-10-21T07:00:00.000Z",
  });
}

function renderOverview(threadId: string) {
  return render(
    <DockThreadOverviewContent
      boardRevision={0}
      mode="code"
      onOpenEnvironment={vi.fn()}
      onOpenReview={vi.fn()}
      onOpenRunning={vi.fn()}
      projectName="Octant"
      running={[]}
      threadId={threadId}
    />,
  );
}

describe("the dock overview's local servers", () => {
  it("never shows a reading taken for another thread", () => {
    reading.snapshot = snapshotFor(threadA);
    const { unmount } = renderOverview(threadA);
    expect(screen.getByRole("region", { name: "Local servers" })).toHaveTextContent("vite");
    unmount();

    // The controller still holds thread A's reading while it reads thread B.
    renderOverview(threadB);
    expect(screen.queryByRole("region", { name: "Local servers" })).toBeNull();
  });
});
