import { describe, expect, it } from "vitest";
import type { SshTargetStatus } from "@octant/contracts/ssh-target";
import {
  REMOTE_CODE_THREAD_FULL_ACCESS_UNAVAILABLE,
  REMOTE_CODE_THREAD_PROVIDER_UNAVAILABLE,
  describeSshAdmissionRefusal,
  remoteCodeProviderOffer,
  remoteCodeTurnReadiness,
  remotePlacedAgentReadiness,
} from "./sshTargetRecovery";

const admitted = { status: "admitted" } as const;

describe("remoteCodeProviderOffer and remotePlacedAgentReadiness", () => {
  const agent = "81000000-0000-4000-8000-000000000001";
  const status = (
    runtimePath: "set" | "missing",
    decision: SshTargetStatus["admission"][number]["decision"],
  ) =>
    ({
      target: { id: "55555555-5555-4555-8555-555555555555" },
      connection: "connected",
      admission: [
        { posture: "plan", decision: admitted },
        { posture: "approval-gated", decision: admitted },
      ],
      placeableRuntimes: [
        {
          providerInstanceId: agent,
          runtimePath,
          admission: [
            { posture: "plan", decision },
            { posture: "approval-gated", decision },
          ],
        },
      ],
    }) as never;

  it("offers an agent the host listed placeable with its path set, and is ready where its runtime is admitted", () => {
    expect(remoteCodeProviderOffer(status("set", admitted), agent)).toEqual({ status: "offered" });
    expect(remotePlacedAgentReadiness(status("set", admitted), agent, "plan")).toEqual({
      status: "ready",
    });
  });

  it("names the command that sets a missing path, and refuses an agent the host did not list or cannot place there", () => {
    expect(remoteCodeProviderOffer(status("missing", admitted), agent)).toEqual({
      status: "unavailable",
      message: `Set where this provider's runtime is on the SSH target before it runs there: octant ssh-target runtime 55555555-5555-4555-8555-555555555555 ${agent} <path>.`,
    });
    expect(
      remoteCodeProviderOffer(status("set", admitted), "81000000-0000-4000-8000-000000000002"),
    ).toEqual({ status: "unavailable", message: REMOTE_CODE_THREAD_PROVIDER_UNAVAILABLE });
    expect(remoteCodeProviderOffer(undefined, agent)).toMatchObject({ status: "unavailable" });
    // A macOS target refuses a placed runtime in every posture, so the agent
    // is not offered there at all, whatever its path.
    expect(
      remoteCodeProviderOffer(
        status("set", { status: "refused", reason: "runtime-not-attestable" }),
        agent,
      ),
    ).toEqual({
      status: "unavailable",
      message: describeSshAdmissionRefusal({ status: "refused", reason: "runtime-not-attestable" }),
    });
    expect(remotePlacedAgentReadiness(status("set", admitted), agent, "full-access")).toEqual({
      status: "unavailable",
      message: REMOTE_CODE_THREAD_FULL_ACCESS_UNAVAILABLE,
    });
  });
});

describe("remoteCodeTurnReadiness", () => {
  it("is ready only while the host reports the target connected and the posture admitted", () => {
    expect(
      remoteCodeTurnReadiness(
        {
          connection: "connected",
          admission: [
            { posture: "plan", decision: admitted },
            { posture: "approval-gated", decision: admitted },
          ],
        },
        "approval-gated",
      ),
    ).toEqual({ status: "ready" });
  });

  it("says the target is not connected while the host has no session to it", () => {
    expect(
      remoteCodeTurnReadiness(
        { connection: "not-connected", admission: [{ posture: "plan", decision: admitted }] },
        "plan",
      ),
    ).toEqual({
      status: "unavailable",
      message: describeSshAdmissionRefusal({ status: "refused", reason: "target-unreachable" }),
    });
  });

  it("carries the host's own refusal of the posture", () => {
    expect(
      remoteCodeTurnReadiness(
        {
          connection: "connected",
          admission: [
            {
              posture: "approval-gated",
              decision: { status: "refused", reason: "confinement-backend-missing" },
            },
          ],
        },
        "approval-gated",
      ),
    ).toEqual({
      status: "unavailable",
      message: "The target has no working bubblewrap. Install bubblewrap on the target.",
    });
  });

  it("is never ready for Full access, a removed target, or a posture the host did not report", () => {
    const connected = {
      connection: "connected" as const,
      admission: [{ posture: "plan" as const, decision: admitted }],
    };
    expect(remoteCodeTurnReadiness(connected, "full-access")).toEqual({
      status: "unavailable",
      message: REMOTE_CODE_THREAD_FULL_ACCESS_UNAVAILABLE,
    });
    expect(remoteCodeTurnReadiness(undefined, "plan")).toMatchObject({ status: "unavailable" });
    expect(remoteCodeTurnReadiness(connected, "approval-gated")).toMatchObject({
      status: "unavailable",
    });
  });
});
