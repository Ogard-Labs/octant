import { RemotePairingFailure } from "@octant/client-runtime";
import { describe, expect, it } from "vitest";
import {
  PAIRING_POLL_BACKOFF_MS,
  PAIRING_POLL_INTERVAL_MS,
  PAIRING_UNREACHABLE_MESSAGE,
  pairingFailureMessage,
  pairingPollDelayMs,
  pairingStatusFailureKeepsClaim,
} from "./pairingStatusPolicy";

describe("Pairing failure handling", () => {
  it("shows the host's own message for a refused pairing", () => {
    expect(pairingFailureMessage(new RemotePairingFailure("invalid", "Ticket expired."))).toBe(
      "Ticket expired.",
    );
  });

  it("tells the person to check the network when the computer cannot be reached", () => {
    expect(pairingFailureMessage(new TypeError("Network request failed"))).toBe(
      PAIRING_UNREACHABLE_MESSAGE,
    );
  });

  it("keeps the claim when the status check was rate limited or unreachable", () => {
    const failed = (category: "rate-limited" | "unavailable" | "denied" | "expired" | "invalid") =>
      ({ kind: "failed", category, message: "x" }) as const;
    expect(pairingStatusFailureKeepsClaim(failed("rate-limited"))).toBe(true);
    expect(pairingStatusFailureKeepsClaim(failed("unavailable"))).toBe(true);
    expect(pairingStatusFailureKeepsClaim(failed("denied"))).toBe(false);
    expect(pairingStatusFailureKeepsClaim(failed("expired"))).toBe(false);
    expect(pairingStatusFailureKeepsClaim(failed("invalid"))).toBe(false);
  });

  it("polls every two seconds and backs off to five after a rate limit", () => {
    expect(pairingPollDelayMs("ok")).toBe(PAIRING_POLL_INTERVAL_MS);
    expect(pairingPollDelayMs("rate-limited")).toBe(PAIRING_POLL_BACKOFF_MS);
    expect(PAIRING_POLL_INTERVAL_MS).toBe(2_000);
    expect(PAIRING_POLL_BACKOFF_MS).toBe(5_000);
  });
});
