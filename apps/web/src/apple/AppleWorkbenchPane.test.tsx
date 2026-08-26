import type { AppleDiscoverySnapshot } from "@octant/contracts/apple-toolchain-rpc";
import {
  decodeAppleRuntimeSnapshot,
  type AppleRuntimeSnapshot,
} from "@octant/contracts/apple-toolchain";
import { beforeAll, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

let AppleWorkbenchPane: (props: Record<string, unknown>) => React.ReactNode;

beforeAll(async () => {
  const path = "./AppleWorkbenchPane";
  const loaded = await import(path).catch(() => undefined);
  expect(loaded).toBeDefined();
  expect(loaded?.AppleWorkbenchPane).toBeTypeOf("function");
  AppleWorkbenchPane = loaded!.AppleWorkbenchPane;
});

const authority = {
  hostId: "4f70656e-4f72-4269-9474-4c6f63616c31",
  mode: "code",
  projectId: "90000000-0000-4000-8000-000000000001",
  providerInstanceId: "90000000-0000-4000-8000-000000000002",
  extension: { kind: "core" },
} as const;
const toolchain = {
  toolchainId: "90000000-0000-4000-8000-000000000003",
  xcodeVersion: "16.4",
  swiftVersion: "6.1",
  available: true,
  sdks: [
    {
      canonicalName: "iphonesimulator18.5",
      displayName: "iOS Simulator 18.5",
      platform: "ios",
      version: "18.5",
    },
  ],
  discoveredAt: "2026-07-27T20:00:00.000Z",
} as const;
const discovery: AppleDiscoverySnapshot = {
  toolchain: toolchain as never,
  workspace: {
    actionId: "90000000-0000-4000-8000-000000000004" as never,
    correlationId: "90000000-0000-4000-8000-000000000005" as never,
    authority: authority as never,
    projectPath: "Fixture.xcodeproj",
    projectKind: "xcode-project",
    schemes: ["Fixture"],
    configurations: ["Debug"],
    targets: ["Fixture", "FixtureTests"],
    sourceRevision: "a".repeat(40),
    discoveredAt: "2026-07-27T20:00:00.000Z" as never,
  },
  simulators: [
    {
      simulatorId: "90000000-0000-4000-8000-000000000006" as never,
      name: "iPhone 16",
      platform: "ios",
      runtimeVersion: "18.5",
      state: "booted",
      udid: "90000000-0000-4000-8000-000000000006",
    },
  ],
};

function runtimeSnapshot(): AppleRuntimeSnapshot {
  return decodeAppleRuntimeSnapshot({
    sequence: 1,
    snapshotAt: "2026-07-27T20:00:03.000Z",
    toolchain,
    simulators: discovery.simulators,
    active: [],
    recentEvidence: [],
  });
}

describe("AppleWorkbenchPane", () => {
  it("renders normalized toolchain, Simulator, progress, and evidence state", () => {
    const runtime: AppleRuntimeSnapshot = {
      sequence: 3,
      snapshotAt: "2026-07-27T20:00:03.000Z" as never,
      toolchain: toolchain as never,
      simulators: discovery.simulators,
      active: [
        {
          actionId: "90000000-0000-4000-8000-000000000007" as never,
          correlationId: "90000000-0000-4000-8000-000000000008" as never,
          authority: authority as never,
          kind: "test",
          state: "running",
          step: "testing",
          sequence: 2,
          updatedAt: "2026-07-27T20:00:02.000Z" as never,
        },
      ],
      recentEvidence: [
        {
          actionId: "90000000-0000-4000-8000-000000000009" as never,
          correlationId: "90000000-0000-4000-8000-000000000010" as never,
          authority: authority as never,
          kind: "build",
          outcome: "timed-out",
          diagnostics: [{ severity: "error", message: "Compile exceeded the action budget." }],
          artifacts: [{ kind: "log", reference: "apple-log-safe" }],
          cleanup: "uncertain",
          durationMs: 120000,
          completedAt: "2026-07-27T20:00:01.000Z" as never,
        },
      ],
    };
    const html = renderToStaticMarkup(
      <AppleWorkbenchPane status="ready" discovery={discovery} runtime={runtime} />,
    );
    expect(html).toContain("Xcode 16.4");
    expect(html).toContain("iPhone 16");
    expect(html).toContain("Testing");
    expect(html).toContain("Timed out");
    expect(html).toContain("Cleanup uncertain");
    expect(html).toContain("apple-log-safe");
  });

  it("runs and cancels Apple actions from the workbench itself", async () => {
    const { fireEvent, render, screen } = await import("@testing-library/react");
    const { vi } = await import("vitest");
    const onRun = vi.fn();
    const onCancel = vi.fn();
    const runtime: AppleRuntimeSnapshot = {
      sequence: 1,
      snapshotAt: "2026-07-27T20:00:03.000Z" as never,
      toolchain: toolchain as never,
      simulators: discovery.simulators,
      active: [
        {
          actionId: "90000000-0000-4000-8000-000000000007" as never,
          correlationId: "90000000-0000-4000-8000-000000000008" as never,
          authority: authority as never,
          kind: "test",
          state: "running",
          step: "testing",
          sequence: 2,
          updatedAt: "2026-07-27T20:00:02.000Z" as never,
        },
      ],
      recentEvidence: [],
    };
    render(
      <AppleWorkbenchPane
        discovery={discovery}
        onCancel={onCancel}
        onRun={onRun}
        runtime={runtime}
        status="ready"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Build Fixture" }));
    expect(onRun).toHaveBeenCalledWith({ kind: "build" });

    fireEvent.click(screen.getByRole("button", { name: "Run Fixture on iPhone 16" }));
    expect(onRun).toHaveBeenCalledWith({
      kind: "run",
      simulatorId: discovery.simulators[0]!.simulatorId,
    });

    fireEvent.click(screen.getByRole("button", { name: "Capture the iPhone 16 screen" }));
    expect(onRun).toHaveBeenCalledWith({
      kind: "screenshot",
      simulatorId: discovery.simulators[0]!.simulatorId,
    });

    fireEvent.click(screen.getByRole("button", { name: "Shut down iPhone 16" }));
    expect(onRun).toHaveBeenCalledWith({
      kind: "shutdown",
      simulatorId: discovery.simulators[0]!.simulatorId,
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel Test" }));
    expect(onCancel).toHaveBeenCalledWith(runtime.active[0]!.actionId);
  });

  it("keeps peer scheme and Simulator actions from all reading as the primary button", async () => {
    const { render, screen } = await import("@testing-library/react");
    const { vi } = await import("vitest");
    const runtime: AppleRuntimeSnapshot = {
      sequence: 1,
      snapshotAt: "2026-07-27T20:00:03.000Z" as never,
      toolchain: toolchain as never,
      simulators: discovery.simulators,
      active: [
        {
          actionId: "90000000-0000-4000-8000-000000000007" as never,
          correlationId: "90000000-0000-4000-8000-000000000008" as never,
          authority: authority as never,
          kind: "test",
          state: "running",
          step: "testing",
          sequence: 2,
          updatedAt: "2026-07-27T20:00:02.000Z" as never,
        },
      ],
      recentEvidence: [],
    };
    render(
      <AppleWorkbenchPane
        discovery={discovery}
        onCancel={vi.fn()}
        onRun={vi.fn()}
        runtime={runtime}
        status="ready"
      />,
    );

    expect(screen.getByRole("button", { name: "Build Fixture" })).toHaveAttribute(
      "data-variant",
      "secondary",
    );
    expect(screen.getByRole("button", { name: "Test Fixture" })).toHaveAttribute(
      "data-variant",
      "secondary",
    );
    expect(screen.getByRole("button", { name: "Run Fixture on iPhone 16" })).toHaveAttribute(
      "data-variant",
      "secondary",
    );
    expect(screen.getByRole("button", { name: "Shut down iPhone 16" })).toHaveAttribute(
      "data-variant",
      "destructive",
    );
    expect(screen.getByRole("button", { name: "Cancel Test" })).toHaveAttribute(
      "data-variant",
      "ghost",
    );
  });

  it("offers only what a Simulator in that state can actually do", async () => {
    const { render, screen } = await import("@testing-library/react");
    const { vi } = await import("vitest");
    const shutdown = {
      ...discovery,
      simulators: [{ ...discovery.simulators[0]!, state: "shutdown" as const }],
    };
    render(
      <AppleWorkbenchPane
        discovery={shutdown}
        onRun={vi.fn()}
        runtime={
          {
            sequence: 1,
            snapshotAt: "2026-07-27T20:00:03.000Z",
            toolchain,
            simulators: shutdown.simulators,
            active: [],
            recentEvidence: [],
          } as never
        }
        status="ready"
      />,
    );

    expect(screen.getByRole("button", { name: "Boot iPhone 16" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Capture the iPhone 16 screen" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Shut down iPhone 16" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Run Fixture on iPhone 16" }),
    ).not.toBeInTheDocument();
  });

  it("renders unavailable and interrupted states without claiming success", () => {
    expect(renderToStaticMarkup(<AppleWorkbenchPane status="unavailable" />)).toContain(
      "Apple toolchain unavailable",
    );
    expect(renderToStaticMarkup(<AppleWorkbenchPane status="interrupted" />)).toContain(
      "Apple action interrupted",
    );
  });

  it("shows an unavailable live frame on a host without Apple tooling", () => {
    const html = renderToStaticMarkup(
      <AppleWorkbenchPane
        liveFrame={{
          status: "unavailable",
          reason: "toolchain-missing",
          title: "Simulator is unavailable",
          message:
            "Install or select Xcode and an iOS Simulator runtime on the Mac that owns this Code thread, then retry.",
        }}
        status="unavailable"
      />,
    );
    expect(html).toContain("Simulator is unavailable");
    expect(html).not.toContain("<video");
  });

  it("does not shut down the destination when the live frame unmounts", async () => {
    const { render } = await import("@testing-library/react");
    const { vi } = await import("vitest");
    const onRun = vi.fn();
    const view = render(
      <AppleWorkbenchPane
        discovery={discovery}
        liveFrame={{
          status: "live",
          simulatorId: discovery.simulators[0]!.simulatorId,
          name: "iPhone 16",
          screen: { kind: "pending" },
          title: "Live · iPhone 16",
          message: "The destination is live.",
        }}
        onRun={onRun}
        runtime={runtimeSnapshot()}
        status="ready"
      />,
    );
    view.unmount();
    expect(onRun).not.toHaveBeenCalled();
  });

  it("labels stale-after-restart instead of showing the destination as live", () => {
    const html = renderToStaticMarkup(
      <AppleWorkbenchPane
        liveFrame={{
          status: "stale-after-restart",
          simulatorId: discovery.simulators[0]!.simulatorId,
          name: "iPhone 16",
          lastScreen: { reference: "apple-screenshot-before-restart" },
          title: "Simulator is stale after restart",
          message: "Ownership was reconciled after a host restart.",
        }}
        status="ready"
        discovery={discovery}
        runtime={runtimeSnapshot()}
      />,
    );
    expect(html).toContain("stale after restart");
    expect(html).toContain('data-status="stale-after-restart"');
    expect(html).not.toContain('data-status="live"');
  });
});
