import { describe, expect, it } from "vitest";
import { decodeHubMembershipChangedPayload } from "./hubMembership";
import {
  decodeHubPushAnswer,
  decodeHubPushCopy,
  decodeHubPushGrantAnswer,
  decodeHubPushHandoffV2,
  decodeHubPushSwitchRequest,
} from "./hubPush";

const handoff = {
  version: 2 as const,
  platform: "ios" as const,
  token: "a".repeat(64),
  message: {
    type: "alert" as const,
    alert: {
      version: 2 as const,
      kind: "waiting" as const,
      hostId: "11111111-1111-4111-8111-111111111111",
      threadId: "00000000-0000-4000-8000-000000000001",
      mode: "code" as const,
      title: "Waiting for you",
      body: "On Studio Mac",
      collapseId: "q2HnS1wZcV0k3fA8uYt7Rg",
      urgency: "high" as const,
      sequence: 1,
      occurredAt: "2026-11-28T08:00:00.000Z",
    },
  },
};

describe("hub push wire shapes", () => {
  it("decodes a v2 direct push handoff and refuses extra fields or v1 shapes", () => {
    expect(decodeHubPushHandoffV2(handoff).message.type).toBe("alert");
    expect(() => decodeHubPushHandoffV2({ ...handoff, version: 1 })).toThrow();
    expect(() =>
      decodeHubPushHandoffV2({
        body: '{"capability":"v1.k1.x"}',
        hostKey: "key",
        timestamp: "2026-11-28T08:00:00.000Z",
        signature: "sig",
      }),
    ).toThrow();
    for (const extra of ["gatewayUrl", "memberId", "secret"]) {
      expect(() => decodeHubPushHandoffV2({ ...handoff, [extra]: "x" })).toThrow();
    }
  });

  it("decodes the direct delivery outcome and refuses unexpected fields", () => {
    expect(decodeHubPushAnswer({ status: "forwarded", outcome: "accepted" })).toEqual({
      status: "forwarded",
      outcome: "accepted",
    });
    expect(decodeHubPushAnswer({ status: "forwarded", outcome: "destination-gone" })).toEqual({
      status: "forwarded",
      outcome: "destination-gone",
    });
    expect(() => decodeHubPushAnswer({ status: "forwarded", outcome: "unknown" })).toThrow();
    expect(() =>
      decodeHubPushAnswer({ status: "forwarded", outcome: "accepted", message: "text" }),
    ).toThrow();
  });

  it("decodes the grant answer, the standby's copy of the switch, and the person's switch", () => {
    expect(decodeHubPushGrantAnswer({ status: "granted" }).status).toBe("granted");
    expect(decodeHubPushCopy({ enabled: true }).enabled).toBe(true);
    expect(decodeHubPushSwitchRequest({ enabled: false }).enabled).toBe(false);
    expect(() => decodeHubPushSwitchRequest({})).toThrow();
  });

  it("journals a forward as a size and a reason word, with nothing that could carry content", () => {
    expect(
      decodeHubMembershipChangedPayload({
        change: "push-refused",
        actingPrincipal: { kind: "peer", memberId: "11111111-1111-4111-8111-111111111111" },
        pushBytes: 900,
        pushReason: "update-member",
      }).pushReason,
    ).toBe("update-member");
    expect(() =>
      decodeHubMembershipChangedPayload({
        change: "push-forwarded",
        actingPrincipal: { kind: "local-window" },
        pushReason: "the payload was bad",
      }),
    ).toThrow();
  });
});
