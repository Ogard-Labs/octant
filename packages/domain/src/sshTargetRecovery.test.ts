import { describe, expect, it } from "vitest";
import {
  REMOTE_CODE_THREAD_FULL_ACCESS_UNAVAILABLE,
  describeSshAdmissionRefusal,
  remoteCodeTurnReadiness,
} from "./sshTargetRecovery";

const admitted = { status: "admitted" } as const;

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
