import { describe, expect, it } from "vitest";
import { attemptCanForceStop } from "./attemptForceStop";

const snapshot = {
  instances: [],
  observedStates: [
    { instanceId: "claude-1", capabilities: { forceStop: "supported" } },
    { instanceId: "codex-1", capabilities: { forceStop: "unsupported" } },
  ],
} as never;

describe("offering Force stop for the running attempt", () => {
  it("follows the provider the attempt runs on, not the thread's saved provider", () => {
    // A multi-model pool can run one attempt on Claude while the thread's saved
    // provider is Codex; the escape hatch has to match the process that is stuck.
    expect(attemptCanForceStop(snapshot, { providerInstanceId: "claude-1" } as never)).toBe(true);
    expect(attemptCanForceStop(snapshot, { providerInstanceId: "codex-1" } as never)).toBe(false);
  });

  it("offers nothing without an attempt, a snapshot, or an observation for its provider", () => {
    expect(attemptCanForceStop(snapshot, undefined)).toBe(false);
    expect(attemptCanForceStop(undefined, { providerInstanceId: "claude-1" } as never)).toBe(false);
    expect(attemptCanForceStop(snapshot, { providerInstanceId: "other" } as never)).toBe(false);
  });
});
