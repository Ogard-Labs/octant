import type { AppleDiscoverySnapshot } from "@octant/contracts/apple-toolchain-rpc";
import type { AppleRuntimeSnapshot } from "@octant/contracts/apple-toolchain";
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

  it("renders unavailable and interrupted states without claiming success", () => {
    expect(renderToStaticMarkup(<AppleWorkbenchPane status="unavailable" />)).toContain(
      "Apple toolchain unavailable",
    );
    expect(renderToStaticMarkup(<AppleWorkbenchPane status="interrupted" />)).toContain(
      "Apple action interrupted",
    );
  });
});
