import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import {
  decodeAgentRunId,
  decodeAgentRunParentThreadId,
  decodeLocalServerSnapshot,
} from "@octant/contracts";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { DockThreadOverviewContent } from "./DockThreadOverviewContent";
import type { PrivateListenerPublicStatus, RemoteAccessAdministrationBridge } from "./hostBridge";

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

const NOW = Date.parse("2026-10-21T08:00:00.000Z");

function renderOverview(
  threadId: string,
  extra: Partial<ComponentProps<typeof DockThreadOverviewContent>> = {},
) {
  return render(
    <DockThreadOverviewContent
      boardRevision={0}
      mode="code"
      now={NOW}
      onOpenEnvironment={vi.fn()}
      onOpenReview={vi.fn()}
      onOpenRunning={vi.fn()}
      projectName="Octant"
      running={[]}
      threadId={threadId}
      {...extra}
    />,
  );
}

const unused = (): Promise<never> => Promise.reject(new Error("unused in this fixture"));

function childRunClient(entries: ReadonlyArray<ReturnType<typeof childRun>>): AgentRunClient {
  return {
    parentSummary: async (parentThreadId) => ({ parentThreadId, entries }),
    conversation: unused,
    center: unused,
    acknowledge: unused,
    cancel: unused,
    steer: unused,
    retry: unused,
    resume: unused,
    usageResume: unused,
    snapshotCanvas: unused,
  };
}

function childRun(
  runId: string,
  task: string,
  lifecycleStatus: "running" | "completed",
  updatedAt: string,
) {
  return {
    runId: decodeAgentRunId(runId),
    requestId: "40000000-0000-4000-8000-000000000001",
    parentThreadId: decodeAgentRunParentThreadId(threadA),
    role: "review" as const,
    task,
    lifecycleStatus,
    executionKind: "octant-managed" as const,
    usageQuality: "exact" as const,
    resultAcknowledgement: { required: false, acknowledged: false },
    version: 2,
    updatedAt,
  };
}

function listenerStatus(enabled: boolean): PrivateListenerPublicStatus {
  return {
    enabled,
    state: enabled ? "ready" : "disabled",
    hostname: enabled ? "100.64.0.2" : null,
    port: enabled ? 13774 : null,
    origin: enabled ? "https://100.64.0.2:13774" : null,
    exposureClass: enabled ? "tailscale" : null,
    certificateFingerprint: null,
    certificateReady: enabled,
    certificateSource: enabled ? "self-made" : null,
    tlsPin: null,
  };
}

function listenerBridge(enabled: boolean) {
  return {
    getPrivateListenerStatus: vi.fn(async () => listenerStatus(enabled)),
    disablePrivateListener: vi.fn(async () => listenerStatus(false)),
  };
}

function asAdministration(
  bridge: ReturnType<typeof listenerBridge>,
): RemoteAccessAdministrationBridge {
  // The overview only reads the status and turns the listener off.
  return bridge as Partial<RemoteAccessAdministrationBridge> as RemoteAccessAdministrationBridge;
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

describe("the dock overview's outputs", () => {
  it("lists what the thread produced, newest first, and opens the one chosen", async () => {
    const user = userEvent.setup();
    reading.snapshot = undefined;
    const onOpenDocument = vi.fn();
    const handoff = { kind: "file" as const, path: "docs/handoff.md" };
    const plan = { kind: "canvas" as const, canvasId: "canvas-1", title: "Launch plan" };
    renderOverview(threadA, { documents: [handoff, plan], onOpenDocument });

    const card = screen.getByRole("region", { name: "Outputs" });
    const rows = within(card).getAllByRole("button");
    expect(rows.map((row) => row.textContent)).toEqual(["Launch planCanvas", "handoff.mddocs"]);
    await user.click(within(card).getByRole("button", { name: "Open handoff.md" }));
    expect(onOpenDocument).toHaveBeenCalledWith(handoff);
  });

  it("draws no Outputs card for a thread that produced nothing", () => {
    reading.snapshot = undefined;
    renderOverview(threadA, { documents: [], onOpenDocument: vi.fn() });
    expect(screen.queryByRole("region", { name: "Outputs" })).toBeNull();
  });
});

describe("the dock overview's background tasks", () => {
  it("shows running runs with their age and folds the finished ones", async () => {
    const user = userEvent.setup();
    reading.snapshot = undefined;
    const onOpenSubagent = vi.fn();
    renderOverview(threadA, {
      agentRunClient: childRunClient([
        childRun(
          "50000000-0000-4000-8000-000000000001",
          "Check the sync test",
          "running",
          "2026-10-21T07:56:00.000Z",
        ),
        childRun(
          "30000000-0000-4000-8000-000000000001",
          "Draft release notes",
          "completed",
          "2026-10-21T07:00:00.000Z",
        ),
        childRun(
          "30000000-0000-4000-8000-000000000002",
          "Read the crash log",
          "completed",
          "2026-10-21T06:00:00.000Z",
        ),
      ]),
      onOpenSubagent,
    });

    const card = await screen.findByRole("region", { name: "Background tasks" });
    expect(card).toHaveTextContent("1 running");
    const live = within(card).getByRole("button", { name: /^Check the sync test/ });
    expect(live).toHaveTextContent("4m ago");
    expect(within(card).queryByText("Draft release notes")).toBeNull();

    const fold = within(card).getByRole("button", { name: "2 finished" });
    expect(fold).toHaveAttribute("aria-expanded", "false");
    await user.click(fold);
    expect(fold).toHaveAttribute("aria-expanded", "true");
    await user.click(within(card).getByRole("button", { name: /^Draft release notes/ }));
    expect(onOpenSubagent).toHaveBeenCalledWith("30000000-0000-4000-8000-000000000001");
  });

  it("draws no card for a thread that handed nothing off", async () => {
    reading.snapshot = undefined;
    const client = childRunClient([]);
    const read = vi.spyOn(client, "parentSummary");
    renderOverview(threadA, { agentRunClient: client });
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    expect(screen.queryByRole("region", { name: "Background tasks" })).toBeNull();
  });
});

describe("the dock overview's remote access switch", () => {
  it("turns this computer's listener off through the host's own administration", async () => {
    const user = userEvent.setup();
    reading.snapshot = undefined;
    const bridge = listenerBridge(true);
    const onOpenRemoteAccessSettings = vi.fn();
    renderOverview(threadA, {
      remoteAccess: asAdministration(bridge),
      onOpenRemoteAccessSettings,
    });

    const toggle = await screen.findByRole("switch", { name: "Remote access" });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    await vi.waitFor(() => expect(toggle).not.toBeChecked());
    expect(bridge.disablePrivateListener).toHaveBeenCalledTimes(1);
    expect(onOpenRemoteAccessSettings).not.toHaveBeenCalled();
  });

  it("sends the person to Settings to turn the listener on", async () => {
    const user = userEvent.setup();
    reading.snapshot = undefined;
    const bridge = listenerBridge(false);
    const onOpenRemoteAccessSettings = vi.fn();
    renderOverview(threadA, {
      remoteAccess: asAdministration(bridge),
      onOpenRemoteAccessSettings,
    });

    const toggle = await screen.findByRole("switch", { name: "Remote access" });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    expect(onOpenRemoteAccessSettings).toHaveBeenCalledTimes(1);
    expect(bridge.disablePrivateListener).not.toHaveBeenCalled();
  });

  it("offers no switch in a window that does not administer the listener", () => {
    reading.snapshot = undefined;
    renderOverview(threadA, { onOpenRemoteAccessSettings: vi.fn() });
    expect(screen.queryByRole("switch", { name: "Remote access" })).toBeNull();
  });
});
