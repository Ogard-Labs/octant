import type { SshTargetConnectionState } from "@octant/contracts/ssh-target";

/**
 * How this host reconnects to an SSH target on its own after an attested
 * session dropped. Canonical: docs/design/remote-ssh-environments.md §
 * Disconnect, reconnect, and restart.
 *
 * Each attempt is a whole connection: the pin written again from the journal,
 * the executor's introduction, and a new attestation, exactly as the first
 * connection. The policy only paces the attempts and says when to stop; it
 * never admits anything.
 */

/**
 * Attempts after one drop before the host stops and waits for the person.
 * With the delays below they span about three minutes, which outlasts a
 * network change or a target's sshd restarting without retrying forever
 * against a machine that is off.
 */
export const SSH_RECONNECT_MAX_ATTEMPTS = 8;

/** The wait before the first attempt, doubling for each later one. */
export const SSH_RECONNECT_FIRST_DELAY_MS = 1_000;

/** The longest wait between two attempts. */
export const SSH_RECONNECT_MAX_DELAY_MS = 60_000;

/**
 * Each wait varies by up to this share either way, so the targets of one Mac
 * that lost its network together do not all dial again in the same instant.
 */
export const SSH_RECONNECT_JITTER_RATIO = 0.2;

/**
 * A reconnected session must hold this long before a later drop starts a
 * fresh count. One that drops sooner continues the count it reconnected in,
 * so a target that attests and drops again and again still stops after
 * `SSH_RECONNECT_MAX_ATTEMPTS`.
 */
export const SSH_RECONNECT_STABLE_MS = 60_000;

/** A connection that ended or never came up; what an attempt can end in short of connected. */
export type SshTargetLostState = Exclude<
  SshTargetConnectionState,
  "connected" | "not-connected" | "reconnecting"
>;

/** The wait before attempt `attempt` (1 is the first), with `random` in [0, 1). */
export function sshReconnectDelayMs(attempt: number, random: () => number): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 32));
  const base = Math.min(SSH_RECONNECT_FIRST_DELAY_MS * 2 ** exponent, SSH_RECONNECT_MAX_DELAY_MS);
  const jitter = 1 + SSH_RECONNECT_JITTER_RATIO * (2 * random() - 1);
  return Math.round(base * jitter);
}

/**
 * Whether another attempt could end differently. Only a target that could not
 * be reached may come back by itself. A changed host key, a refused sign-in,
 * and a missing or mismatched executor each need the person, and attempting
 * again would only repeat the refusal; a changed key is never retried in the
 * hope that the pinned one returns, because the pin is never relaxed.
 */
export function sshReconnectHeals(state: SshTargetLostState): boolean {
  return state === "unreachable";
}

/** What the host does after an attempt that did not connect. */
export type SshReconnectStep =
  | { readonly kind: "attempt"; readonly attempt: number; readonly delayMs: number }
  | { readonly kind: "stop" };

/**
 * The next step after `attemptsMade` attempts, the last of which ended in
 * `lastState` (absent before the first attempt, right after the drop).
 */
export function nextSshReconnectStep(input: {
  readonly attemptsMade: number;
  readonly lastState?: SshTargetLostState;
  readonly random: () => number;
}): SshReconnectStep {
  if (input.lastState !== undefined && !sshReconnectHeals(input.lastState)) return { kind: "stop" };
  if (input.attemptsMade >= SSH_RECONNECT_MAX_ATTEMPTS) return { kind: "stop" };
  const attempt = input.attemptsMade + 1;
  return { kind: "attempt", attempt, delayMs: sshReconnectDelayMs(attempt, input.random) };
}
