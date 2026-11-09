import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { listenerKeyTransitionPayload, LISTENER_KEY_TRANSITION_WINDOW_MS } from "@octant/domain";
import { Schema } from "effect";
import { ListenerKeyTransition } from "@octant/contracts";
import { listenerTrustAfterResponse, stageListenerKeyTransition } from "./listenerKeyTransition";
import { judgeListenerCertificate, type ListenerOriginTrust } from "./remoteListenerTrust";

const origin = "https://100.64.0.7:8443";
const hostId = "4f751d04-2b47-49e1-aac9-b3e99049a729";
const at = Date.parse("2026-11-07T10:00:00.000Z");

function fixture() {
  const old = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const next = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const oldSpki = old.publicKey.export({ type: "spki", format: "der" });
  const oldPin = `sha256-${createHash("sha256").update(oldSpki).digest("base64url")}`;
  const newPin = `sha256-${createHash("sha256")
    .update(next.publicKey.export({ type: "spki", format: "der" }))
    .digest("base64url")}`;
  const unsigned = Schema.decodeUnknownSync(ListenerKeyTransition.omit("signature"))({
    version: 1,
    hostId,
    origin,
    oldPin,
    newPin,
    oldPublicKey: oldSpki.toString("base64url"),
    preparedAt: new Date(at).toISOString(),
    expiresAt: new Date(at + LISTENER_KEY_TRANSITION_WINDOW_MS).toISOString(),
  });
  const transition = {
    ...unsigned,
    signature: sign("sha256", Buffer.from(listenerKeyTransitionPayload(unsigned)), {
      key: old.privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url"),
  };
  const trust: ListenerOriginTrust = { current: { kind: "pinned", pin: oldPin } };
  return { transition, trust, oldPin, newPin };
}

describe("signed listener key transition", () => {
  it("accepts only the recorded old key's host-bound seven-day delegation and promotes the new key", async () => {
    const { transition, trust, newPin } = fixture();
    const staged = await stageListenerKeyTransition({
      value: transition,
      origin,
      hostId,
      trust,
      now: at,
    });
    expect(staged.status).toBe("staged");
    if (staged.status !== "staged") throw new Error("expected staged trust");
    expect(
      judgeListenerCertificate({
        trust: staged.trust,
        servedPin: newPin,
        platformTrusted: false,
        now: at + 1,
      }),
    ).toEqual({ status: "accepted", trust: { current: { kind: "pinned", pin: newPin } } });
    expect(
      judgeListenerCertificate({ trust, servedPin: newPin, platformTrusted: true, now: at }),
    ).toEqual({ status: "refused", reason: "pin-mismatch" });
    expect(
      judgeListenerCertificate({
        trust: staged.trust,
        servedPin: newPin,
        platformTrusted: true,
        now: at + LISTENER_KEY_TRANSITION_WINDOW_MS,
      }),
    ).toEqual({ status: "refused", reason: "pin-mismatch" });
  });

  it("refuses changed hosts, origins, keys, signatures, expired and extended windows without trusting the new pin", async () => {
    const { transition, trust } = fixture();
    const cases = [
      { ...transition, hostId: "11111111-1111-4111-8111-111111111111" },
      { ...transition, origin: "https://100.64.0.8:8443" },
      { ...transition, newPin: fixture().newPin },
      { ...transition, oldPublicKey: fixture().transition.oldPublicKey },
      { ...transition, signature: "A".repeat(86) },
      { ...transition, expiresAt: new Date(at + 8 * 86400000).toISOString() },
      { ...transition, unexpected: true },
    ];
    for (const value of cases)
      expect(await stageListenerKeyTransition({ value, origin, hostId, trust, now: at })).toEqual({
        status: "refused",
      });
    expect(
      await stageListenerKeyTransition({
        value: transition,
        origin,
        hostId,
        trust,
        now: at + LISTENER_KEY_TRANSITION_WINDOW_MS,
      }),
    ).toEqual({ status: "refused" });
    expect(
      await stageListenerKeyTransition({
        value: transition,
        origin,
        hostId,
        trust: fixture().trust,
        now: at,
      }),
    ).toEqual({ status: "refused" });
  });

  it("withdraws an unactivated stage only on a trusted response and ignores malformed announcements", async () => {
    const { transition, trust } = fixture();
    const staged = await listenerTrustAfterResponse({
      header: Buffer.from(JSON.stringify(transition)).toString("base64url"),
      origin,
      hostId,
      trust,
      now: at,
    });
    expect(staged.staged?.until).toBe(transition.expiresAt);
    expect(
      await listenerTrustAfterResponse({ header: "none", origin, hostId, trust: staged, now: at }),
    ).toEqual(trust);
    expect(
      await listenerTrustAfterResponse({
        header: "broken",
        origin,
        hostId,
        trust: staged,
        now: at,
      }),
    ).toEqual(staged);
  });
});
