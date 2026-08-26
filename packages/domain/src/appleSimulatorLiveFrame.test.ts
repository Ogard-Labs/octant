import { describe, expect, it } from "vitest";
import type { AppleBuildEvidence, AppleSimulatorRecord } from "@octant/contracts";
import {
  APPLE_HOST_RESTART_RECONCILIATION_NOTE,
  appleLiveFrameIsStaleAfterRestart,
  latestAppleScreenshotEvidence,
  presentAppleSimulatorLiveFrame,
  type AppleSimulatorLiveFrameInput,
} from "./appleSimulatorLiveFrame";

const threadA =
  "00000000-0000-4000-8000-000000000001" as AppleSimulatorLiveFrameInput["boundThreadId"];
const threadB =
  "00000000-0000-4000-8000-000000000002" as AppleSimulatorLiveFrameInput["boundThreadId"];
const checkoutA =
  "00000000-0000-4000-8000-000000000011" as AppleSimulatorLiveFrameInput["boundCheckoutId"];
const checkoutB =
  "00000000-0000-4000-8000-000000000012" as AppleSimulatorLiveFrameInput["boundCheckoutId"];
const simulatorId = "00000000-0000-4000-8000-000000000021" as AppleSimulatorRecord["simulatorId"];

const booted: AppleSimulatorRecord = {
  simulatorId,
  name: "iPhone 16",
  platform: "ios",
  runtimeVersion: "18.5",
  state: "booted",
  udid: "00000000-0000-4000-8000-000000000021",
};

function input(overrides?: Partial<AppleSimulatorLiveFrameInput>): AppleSimulatorLiveFrameInput {
  return {
    discovering: false,
    interrupted: false,
    toolchainAvailable: true,
    frameAttach: { kind: "attachable" },
    simulators: [booted],
    boundThreadId: threadA,
    boundCheckoutId: checkoutA,
    visibleThreadId: threadA,
    visibleCheckoutId: checkoutA,
    restartReconciled: false,
    ...overrides,
  };
}

describe("presentAppleSimulatorLiveFrame", () => {
  it("reports setup while the toolchain is still being discovered", () => {
    expect(presentAppleSimulatorLiveFrame(input({ discovering: true }))).toMatchObject({
      status: "setup",
    });
  });

  it("reports unavailable on a host without an Apple toolchain", () => {
    const frame = presentAppleSimulatorLiveFrame(
      input({
        toolchainAvailable: false,
        simulators: [],
        frameAttach: {
          kind: "not-attachable",
          reason: "This client cannot attach a live Simulator frame.",
        },
      }),
    );
    expect(frame).toMatchObject({
      status: "unavailable",
      reason: "toolchain-missing",
    });
    expect(frame.status === "unavailable" ? frame.message : "").toMatch(/Xcode/);
  });

  it("does not leak another thread's Simulator into the visible pane", () => {
    expect(
      presentAppleSimulatorLiveFrame(
        input({
          visibleThreadId: threadB,
          visibleCheckoutId: checkoutB,
          latestScreenshot: { simulatorId, reference: "apple-screenshot-thread-a" },
        }),
      ),
    ).toMatchObject({
      status: "unavailable",
      reason: "thread-mismatch",
    });
  });

  it("labels a booting destination instead of claiming it is live", () => {
    expect(
      presentAppleSimulatorLiveFrame(input({ simulators: [{ ...booted, state: "booting" }] })),
    ).toMatchObject({
      status: "booting",
      name: "iPhone 16",
    });
  });

  it("shows a live frame from host-held screenshot evidence, never as a video", () => {
    const frame = presentAppleSimulatorLiveFrame(
      input({
        latestScreenshot: { simulatorId, reference: "apple-screenshot-live" },
      }),
    );
    expect(frame).toEqual({
      status: "live",
      simulatorId,
      name: "iPhone 16",
      screen: { kind: "screenshot", reference: "apple-screenshot-live" },
      title: "Live · iPhone 16",
      message:
        "Showing the latest host-held screen capture for this thread. This is not a video stream.",
    });
  });

  it("keeps remote and headless clients from attaching a fake live frame", () => {
    expect(
      presentAppleSimulatorLiveFrame(
        input({
          frameAttach: {
            kind: "not-attachable",
            reason:
              "This client cannot attach a live Simulator frame. Open the thread on the Mac that owns the destination.",
          },
        }),
      ),
    ).toMatchObject({
      status: "unavailable",
      reason: "not-attachable",
    });
  });

  it("labels stale-after-restart instead of showing the destination as live", () => {
    const frame = presentAppleSimulatorLiveFrame(
      input({
        restartReconciled: true,
        latestScreenshot: { simulatorId, reference: "apple-screenshot-before-restart" },
      }),
    );
    expect(frame.status).toBe("stale-after-restart");
    expect(frame.status === "stale-after-restart" ? frame.lastScreen : undefined).toEqual({
      reference: "apple-screenshot-before-restart",
    });
  });

  it("reports an interrupted frame without claiming success", () => {
    expect(presentAppleSimulatorLiveFrame(input({ interrupted: true }))).toMatchObject({
      status: "interrupted",
    });
  });
});

describe("apple live-frame restart evidence", () => {
  const authority = {
    hostId: "00000000-0000-4000-8000-000000000031",
    mode: "code",
    projectId: "00000000-0000-4000-8000-000000000032",
    providerInstanceId: "00000000-0000-4000-8000-000000000033",
    extension: { kind: "core" },
  } as const;

  function evidence(overrides: Partial<AppleBuildEvidence>): AppleBuildEvidence {
    return {
      actionId: "00000000-0000-4000-8000-000000000041" as AppleBuildEvidence["actionId"],
      correlationId: "00000000-0000-4000-8000-000000000042" as AppleBuildEvidence["correlationId"],
      authority: authority as AppleBuildEvidence["authority"],
      kind: "run",
      outcome: "interrupted",
      simulatorId,
      diagnostics: [],
      artifacts: [],
      cleanup: "complete",
      durationMs: 1,
      completedAt: "2026-07-27T20:00:00.000Z" as AppleBuildEvidence["completedAt"],
      ...overrides,
    };
  }

  it("treats host-restart reconciliation as stale until a later screen is verified", () => {
    const restarted = evidence({
      diagnostics: [{ severity: "note", message: APPLE_HOST_RESTART_RECONCILIATION_NOTE }],
      completedAt: "2026-07-27T20:00:10.000Z" as AppleBuildEvidence["completedAt"],
    });
    const previousScreen = evidence({
      kind: "screenshot",
      outcome: "succeeded",
      artifacts: [{ kind: "screenshot", reference: "apple-screenshot-old" }],
      completedAt: "2026-07-27T19:59:00.000Z" as AppleBuildEvidence["completedAt"],
    });
    expect(appleLiveFrameIsStaleAfterRestart([previousScreen, restarted])).toBe(true);
    const laterScreen = evidence({
      kind: "screenshot",
      outcome: "succeeded",
      artifacts: [{ kind: "screenshot", reference: "apple-screenshot-new" }],
      completedAt: "2026-07-27T20:00:20.000Z" as AppleBuildEvidence["completedAt"],
    });
    expect(appleLiveFrameIsStaleAfterRestart([previousScreen, restarted, laterScreen])).toBe(false);
    expect(latestAppleScreenshotEvidence([previousScreen, laterScreen])?.reference).toBe(
      "apple-screenshot-new",
    );
  });
});
