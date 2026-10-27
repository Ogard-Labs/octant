import { describe, expect, it } from "vitest";
import type { CodeCheckoutId } from "@octant/contracts/code";
import {
  CodeDebugStartRefusalReason,
  type CodeDebugConfigurationDigest,
} from "@octant/contracts/code-debug";
import type { ExtensionComponentId, ExtensionContentDigest } from "@octant/contracts/extensions";
import type { OctantMode } from "@octant/contracts/modes";
import type { ProviderExecutionPolicy } from "@octant/contracts/providers";
import type { ToolExtensionId } from "@octant/contracts/tool-actions";
import {
  decideDebugSessionStart,
  type DebugAdapterPackageState,
  type DebugConfigurationApproval,
  type DebugSessionHostPlatform,
  type DebugSessionStarter,
  type DebugSessionStartRequest,
} from "./debugSessionStartPolicy";

const checkoutId = "30000000-0000-4000-8000-000000000002" as CodeCheckoutId;
const otherCheckoutId = "30000000-0000-4000-8000-000000000009" as CodeCheckoutId;
const configurationDigest = `sha256:${"c".repeat(64)}` as CodeDebugConfigurationDigest;
const adapter: DebugAdapterPackageState = {
  extensionId: "10000000-0000-4000-8000-000000000001" as ToolExtensionId,
  componentId: "adapter" as ExtensionComponentId,
  packageDigest: `sha256:${"a".repeat(64)}` as ExtensionContentDigest,
  lifecycleVersion: 4,
};
const covering: DebugConfigurationApproval = {
  configurationDigest,
  adapter,
  scope: { kind: "checkout", checkoutId },
};

/** Approvals a Project may hold, named for whether they cover this start. */
const approvalStates: ReadonlyArray<{
  readonly name: string;
  readonly approvals: ReadonlyArray<DebugConfigurationApproval>;
  readonly covers: boolean;
}> = [
  { name: "none", approvals: [], covers: false },
  { name: "this checkout", approvals: [covering], covers: true },
  { name: "the Project", approvals: [{ ...covering, scope: { kind: "project" } }], covers: true },
  {
    name: "another checkout",
    approvals: [{ ...covering, scope: { kind: "checkout", checkoutId: otherCheckoutId } }],
    covers: false,
  },
  {
    name: "an edited configuration",
    approvals: [
      {
        ...covering,
        configurationDigest: `sha256:${"d".repeat(64)}` as CodeDebugConfigurationDigest,
      },
    ],
    covers: false,
  },
  {
    name: "an updated package",
    approvals: [
      {
        ...covering,
        adapter: {
          ...adapter,
          packageDigest: `sha256:${"b".repeat(64)}` as ExtensionContentDigest,
        },
      },
    ],
    covers: false,
  },
  {
    name: "a switched, trusted, or reinstalled package",
    approvals: [{ ...covering, adapter: { ...adapter, lifecycleVersion: 3 } }],
    covers: false,
  },
  {
    name: "another component of the package",
    approvals: [
      { ...covering, adapter: { ...adapter, componentId: "other" as ExtensionComponentId } },
    ],
    covers: false,
  },
];

const platforms: ReadonlyArray<DebugSessionHostPlatform> = ["macos", "linux", "windows", "other"];
const modes: ReadonlyArray<OctantMode> = ["chat", "work", "code"];
const postures: ReadonlyArray<ProviderExecutionPolicy> = [
  "plan",
  "approval-gated",
  "auto-accept-edits",
  "full-access",
];
const starters: ReadonlyArray<DebugSessionStarter> = ["local-window", "remote-device", "agent"];
const configurationStates = ["resolve", "unresolved"] as const;
const debugPortCounts = [0, 1] as const;

function request(overrides: Partial<DebugSessionStartRequest> = {}): DebugSessionStartRequest {
  return {
    platform: "linux",
    mode: "code",
    posture: "approval-gated",
    startedBy: "local-window",
    checkoutId,
    configurationDigest,
    adapter,
    approvals: [covering],
    configurationPaths: "resolve",
    debugPorts: 0,
    ...overrides,
  };
}

describe("debug session start policy", () => {
  it("refuses in the specified order for every platform, mode, posture, starter, approval, and configuration state", () => {
    let combinations = 0;
    for (const platform of platforms) {
      for (const mode of modes) {
        for (const posture of postures) {
          for (const startedBy of starters) {
            for (const approval of approvalStates) {
              for (const configurationPaths of configurationStates) {
                const decision = decideDebugSessionStart(
                  request({
                    platform,
                    mode,
                    posture,
                    startedBy,
                    approvals: approval.approvals,
                    configurationPaths,
                  }),
                );
                // The first reason that applies, in the specification's order.
                const expected =
                  platform !== "macos" && platform !== "linux"
                    ? "unsupported-platform"
                    : mode !== "code"
                      ? "mode-prohibited"
                      : posture === "plan"
                        ? "plan-read-only"
                        : startedBy !== "local-window"
                          ? "local-host-required"
                          : !approval.covers
                            ? "approval-required"
                            : configurationPaths !== "resolve"
                              ? "configuration-invalid"
                              : "launch";
                expect(
                  decision.status === "launch" ? "launch" : decision.reason,
                  `${platform} ${mode} ${posture} ${startedBy} ${approval.name} ${configurationPaths}`,
                ).toBe(expected);
                combinations += 1;
              }
            }
          }
        }
      }
    }
    expect(combinations).toBe(4 * 3 * 4 * 3 * approvalStates.length * 2);
  });

  it("launches the adapter and program in one capsule that writes only the checkout and session state", () => {
    expect(decideDebugSessionStart(request())).toEqual({
      status: "launch",
      shape: {
        confinement: "bubblewrap",
        capsule: "adapter-and-program",
        checkout: "read-write",
        writes: "checkout-and-session-state",
        execution: "confined-as-terminal",
        network: "proxied-under-thread-rules",
        debugPort: "none",
      },
    });
  });

  it("follows the thread's posture for the network: proxied below Full access, open under it", () => {
    for (const posture of ["approval-gated", "auto-accept-edits"] as const) {
      const decision = decideDebugSessionStart(request({ posture, platform: "macos" }));
      expect(decision.status === "launch" ? decision.shape : undefined).toMatchObject({
        confinement: "seatbelt",
        network: "proxied-under-thread-rules",
      });
    }
    const full = decideDebugSessionStart(request({ posture: "full-access" }));
    expect(full.status === "launch" ? full.shape.network : undefined).toBe("allow");
  });

  it("keeps a debug port inside the capsule on Linux and opens only the session's own port on macOS", () => {
    for (const platform of ["macos", "linux"] as const) {
      for (const debugPorts of debugPortCounts) {
        const decision = decideDebugSessionStart(request({ platform, debugPorts }));
        expect(decision.status === "launch" ? decision.shape.debugPort : undefined).toBe(
          debugPorts === 0
            ? "none"
            : platform === "linux"
              ? "inside-capsule-namespace"
              : "host-chosen-localhost-port",
        );
      }
    }
  });

  it("refuses only with reasons a start refusal carries", () => {
    const reasons = new Set<string>(CodeDebugStartRefusalReason.literals);
    for (const platform of platforms) {
      for (const posture of postures) {
        const decision = decideDebugSessionStart(
          request({ platform, posture, startedBy: "agent", approvals: [] }),
        );
        if (decision.status === "refused") expect(reasons.has(decision.reason)).toBe(true);
      }
    }
  });
});
