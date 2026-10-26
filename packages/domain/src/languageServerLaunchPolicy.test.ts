import { describe, expect, it } from "vitest";
import { CodeLanguageRefusalReason } from "@octant/contracts/code-language";
import type { ExtensionLanguageServerClass } from "@octant/contracts/extensions";
import type { ProviderExecutionPolicy } from "@octant/contracts/providers";
import {
  decideLanguageServerLaunch,
  type LanguageServerHostPlatform,
  type LanguageServerLaunchDecision,
} from "./languageServerLaunchPolicy";
import type { PrincipalKind } from "./remoteAccessPolicy";

const classes: ReadonlyArray<ExtensionLanguageServerClass> = ["static", "repo-tooling"];
const postures: ReadonlyArray<ProviderExecutionPolicy> = [
  "plan",
  "approval-gated",
  "auto-accept-edits",
  "full-access",
];
const platforms: ReadonlyArray<LanguageServerHostPlatform> = ["macos", "linux", "windows", "other"];
const principals: ReadonlyArray<PrincipalKind> = ["local-window", "remote-device"];
const approvals = ["granted", "absent"] as const;

describe("language server launch policy", () => {
  it("launches a static server read-only, exec-locked, and offline in every Code posture, Plan included", () => {
    for (const posture of postures) {
      expect(
        decideLanguageServerLaunch({
          launchClass: "static",
          posture,
          platform: "linux",
          startedBy: "remote-device",
          shellCommandApproval: "absent",
        }),
      ).toEqual({
        status: "launch",
        shape: {
          launchClass: "static",
          confinement: "bubblewrap",
          checkout: "read-only",
          toolchainRoots: "none",
          writes: "private-cache",
          execution: "own-binary-only",
          forkFilter: "seccomp-no-fork",
          network: "none",
        },
      });
    }
    expect(
      decideLanguageServerLaunch({
        launchClass: "static",
        posture: "plan",
        platform: "macos",
        startedBy: "local-window",
        shellCommandApproval: "absent",
      }),
    ).toEqual({
      status: "launch",
      shape: {
        launchClass: "static",
        confinement: "seatbelt",
        checkout: "read-only",
        toolchainRoots: "none",
        writes: "private-cache",
        execution: "own-binary-only",
        forkFilter: "none",
        network: "none",
      },
    });
  });

  it("launches an approved repo-tooling server from a local window outside Plan, proxied under the Project's rules", () => {
    for (const posture of ["approval-gated", "auto-accept-edits", "full-access"] as const) {
      expect(
        decideLanguageServerLaunch({
          launchClass: "repo-tooling",
          posture,
          platform: "macos",
          startedBy: "local-window",
          shellCommandApproval: "granted",
        }),
      ).toEqual({
        status: "launch",
        shape: {
          launchClass: "repo-tooling",
          confinement: "seatbelt",
          checkout: "read-write",
          toolchainRoots: "declared",
          writes: "checkout-and-private-cache",
          execution: "confined-as-terminal",
          forkFilter: "none",
          network: "proxied-under-project-rules",
        },
      });
    }
  });

  it("refuses a repo-tooling server in Plan even when approved and started at the host", () => {
    expect(
      decideLanguageServerLaunch({
        launchClass: "repo-tooling",
        posture: "plan",
        platform: "linux",
        startedBy: "local-window",
        shellCommandApproval: "granted",
      }),
    ).toEqual({ status: "refused", reason: "plan-read-only" });
  });

  it("refuses a paired device that would start a repo-tooling server, even with an approval on record", () => {
    expect(
      decideLanguageServerLaunch({
        launchClass: "repo-tooling",
        posture: "full-access",
        platform: "linux",
        startedBy: "remote-device",
        shellCommandApproval: "granted",
      }),
    ).toEqual({ status: "refused", reason: "local-host-required" });
  });

  it("refuses a repo-tooling server that has no shell-command approval, whatever the posture", () => {
    expect(
      decideLanguageServerLaunch({
        launchClass: "repo-tooling",
        posture: "full-access",
        platform: "macos",
        startedBy: "local-window",
        shellCommandApproval: "absent",
      }),
    ).toEqual({ status: "refused", reason: "approval-required" });
  });

  it("refuses every class on a platform without a confinement backend", () => {
    for (const launchClass of classes) {
      for (const platform of ["windows", "other"] as const) {
        expect(
          decideLanguageServerLaunch({
            launchClass,
            posture: "full-access",
            platform,
            startedBy: "local-window",
            shellCommandApproval: "granted",
          }),
        ).toEqual({ status: "refused", reason: "unsupported-platform" });
      }
    }
  });

  it("refuses only with reasons the language read contract can carry to the editor", () => {
    const reasons = new Set<string>();
    for (const launchClass of classes) {
      for (const posture of postures) {
        for (const platform of platforms) {
          for (const startedBy of principals) {
            for (const shellCommandApproval of approvals) {
              const decision = decideLanguageServerLaunch({
                launchClass,
                posture,
                platform,
                startedBy,
                shellCommandApproval,
              });
              if (decision.status === "refused") reasons.add(decision.reason);
            }
          }
        }
      }
    }
    expect([...reasons].sort()).toEqual([
      "approval-required",
      "local-host-required",
      "plan-read-only",
      "unsupported-platform",
    ]);
    for (const reason of reasons) {
      expect(CodeLanguageRefusalReason.literals).toContain(reason);
    }
  });

  it("holds the launch-class table for every class, posture, platform, starter, and approval", () => {
    // Written from the specification's table rather than from the policy, so
    // a change to either shows up here as a mismatch.
    const expected = (input: {
      readonly launchClass: ExtensionLanguageServerClass;
      readonly posture: ProviderExecutionPolicy;
      readonly platform: LanguageServerHostPlatform;
      readonly startedBy: PrincipalKind;
      readonly shellCommandApproval: "granted" | "absent";
    }): "launch" | Extract<LanguageServerLaunchDecision, { status: "refused" }>["reason"] => {
      if (input.platform !== "macos" && input.platform !== "linux") return "unsupported-platform";
      if (input.launchClass === "static") return "launch";
      if (input.posture === "plan") return "plan-read-only";
      if (input.startedBy !== "local-window") return "local-host-required";
      if (input.shellCommandApproval !== "granted") return "approval-required";
      return "launch";
    };
    const mismatches: Array<unknown> = [];
    for (const launchClass of classes) {
      for (const posture of postures) {
        for (const platform of platforms) {
          for (const startedBy of principals) {
            for (const shellCommandApproval of approvals) {
              const input = { launchClass, posture, platform, startedBy, shellCommandApproval };
              const decision = decideLanguageServerLaunch(input);
              const actual = decision.status === "launch" ? "launch" : decision.reason;
              const network =
                decision.status === "launch" ? decision.shape.network : "not-launched";
              const want = expected(input);
              const wantNetwork =
                want !== "launch"
                  ? "not-launched"
                  : launchClass === "static"
                    ? "none"
                    : "proxied-under-project-rules";
              if (actual !== want || network !== wantNetwork) {
                mismatches.push({ input, actual, network });
              }
            }
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});
