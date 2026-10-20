import { isRemotePairingFailure, type RemotePairingStatus } from "@octant/client-runtime";

export const PAIRING_UNREACHABLE_MESSAGE =
  "Couldn't reach the computer. Make sure the phone and the computer are on the same network or Tailscale, then scan again.";

/** Fast enough to feel instant after approval, slow enough for the host's status rate limit. */
export const PAIRING_POLL_INTERVAL_MS = 2_000;
export const PAIRING_POLL_BACKOFF_MS = 5_000;

/** A thrown pairing error becomes its own message; anything else means the computer was unreachable. */
export function pairingFailureMessage(error: unknown): string {
  return isRemotePairingFailure(error) ? error.message : PAIRING_UNREACHABLE_MESSAGE;
}

type FailedStatus = Extract<RemotePairingStatus, { kind: "failed" }>;

/**
 * A refused or unreachable status check says nothing about the claim itself, so
 * the ticket stays pending and the person can check again. Denied, expired and
 * invalid claims are final.
 */
export function pairingStatusFailureKeepsClaim(status: FailedStatus): boolean {
  return status.category === "rate-limited" || status.category === "unavailable";
}

export function pairingPollDelayMs(lastCheck: "ok" | "rate-limited"): number {
  return lastCheck === "rate-limited" ? PAIRING_POLL_BACKOFF_MS : PAIRING_POLL_INTERVAL_MS;
}
