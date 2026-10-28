import { describe, expect, it } from "vitest";
import {
  SSH_RECONNECT_MAX_ATTEMPTS,
  SSH_RECONNECT_MAX_DELAY_MS,
  nextSshReconnectStep,
  type SshTargetLostState,
} from "./sshTargetReconnectPolicy";

describe("SSH target reconnect pacing", () => {
  it("waits longer before each attempt, within its jitter and ceiling, and stops after the last", () => {
    const waits = (random: () => number) => {
      const delays: number[] = [];
      for (let made = 0; ; made += 1) {
        const step = nextSshReconnectStep({
          attemptsMade: made,
          ...(made === 0 ? {} : { lastState: "unreachable" as const }),
          random,
        });
        if (step.kind === "stop") break;
        expect(step.attempt).toBe(made + 1);
        delays.push(step.delayMs);
      }
      return delays;
    };
    expect(waits(() => 0.5)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
    expect(waits(() => 0)).toHaveLength(SSH_RECONNECT_MAX_ATTEMPTS);
    expect(Math.min(...waits(() => 0))).toBe(800);
    expect(Math.max(...waits(() => 0.999_999))).toBeLessThanOrEqual(
      SSH_RECONNECT_MAX_DELAY_MS * 1.2,
    );
  });

  it("stops at once after a refusal another attempt cannot heal", () => {
    const needsThePerson: ReadonlyArray<SshTargetLostState> = [
      "host-key-changed",
      "authentication-refused",
      "executor-missing",
      "executor-version-mismatch",
    ];
    for (const lastState of needsThePerson) {
      expect(nextSshReconnectStep({ attemptsMade: 1, lastState, random: () => 0.5 })).toEqual({
        kind: "stop",
      });
    }
  });
});
