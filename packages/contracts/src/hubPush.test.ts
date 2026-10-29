import { describe, expect, it } from "vitest";
import { decodeHubMembershipChangedPayload } from "./hubMembership";
import {
  HUB_PUSH_BODY_MAX_BYTES,
  decodeHubPushAnswer,
  decodeHubPushCopy,
  decodeHubPushGrantAnswer,
  decodeHubPushHandoff,
  decodeHubPushSwitchRequest,
} from "./hubPush";

const handoff = {
  body: '{"capability":"v1.k1.x","envelope":{}}',
  hostKey: "aG9zdC1rZXk",
  timestamp: "2026-10-29T08:00:00.000Z",
  signature: "c2lnbmF0dXJl",
};

describe("hub push wire shapes", () => {
  it("decodes a signed delivery request with a gateway only when the spoke names a custom one", () => {
    expect(decodeHubPushHandoff(handoff).body).toBe(handoff.body);
    expect(
      decodeHubPushHandoff({ ...handoff, gatewayUrl: "http://127.0.0.1:8080" }).gatewayUrl,
    ).toBe("http://127.0.0.1:8080");
    expect(() => decodeHubPushHandoff({ ...handoff, gatewayUrl: "http://example.com" })).toThrow();
  });

  it("refuses a body that is too large to be a sealed delivery and any field it does not take", () => {
    expect(() =>
      decodeHubPushHandoff({ ...handoff, body: "x".repeat(HUB_PUSH_BODY_MAX_BYTES + 1) }),
    ).toThrow();
    for (const extra of ["envelope", "capability", "threadId", "memberId"]) {
      expect(() => decodeHubPushHandoff({ ...handoff, [extra]: "x" })).toThrow();
    }
  });

  it("decodes the gateway's relayed answer and refuses a status that is not an HTTP status", () => {
    expect(decodeHubPushAnswer({ status: "forwarded", gatewayStatus: 202 }).gatewayStatus).toBe(
      202,
    );
    expect(
      decodeHubPushAnswer({ status: "forwarded", gatewayStatus: 429, code: "rate-limited" }).code,
    ).toBe("rate-limited");
    expect(() => decodeHubPushAnswer({ status: "forwarded", gatewayStatus: 0 })).toThrow();
    expect(() =>
      decodeHubPushAnswer({ status: "forwarded", gatewayStatus: 202, message: "text" }),
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
        pushReason: "rate-limited",
      }).pushReason,
    ).toBe("rate-limited");
    expect(() =>
      decodeHubMembershipChangedPayload({
        change: "push-forwarded",
        actingPrincipal: { kind: "local-window" },
        pushReason: "the envelope was bad",
      }),
    ).toThrow();
  });
});
