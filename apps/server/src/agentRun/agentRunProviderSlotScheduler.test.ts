import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunProviderSlotScheduler } from "./agentRunProviderSlotScheduler";

afterEach(() => vi.useRealTimers());

function fixture() {
  vi.useFakeTimers({ now: 1_000_000 });
  let freed: ((providerInstanceId: string) => void) | undefined;
  const rounds: Array<{ readonly mayTry: (providerInstanceId: string) => boolean }> = [];
  const scheduler = new AgentRunProviderSlotScheduler({
    orchestration: {
      hasProviderSlotWaiters: () => true,
      retryProviderSlotWaiters: (_nowMs, options) => {
        if (options?.mayTry !== undefined) rounds.push({ mayTry: options.mayTry });
      },
    },
    onCapacityFreed: (listener) => {
      freed = listener;
      return () => undefined;
    },
    pollMs: 5_000,
    graceMs: 2_000,
  });
  scheduler.start();
  return { scheduler, rounds, free: (providerInstanceId: string) => freed?.(providerInstanceId) };
}

describe("the schedule of children waiting for a provider slot", () => {
  it("leaves a slot freed on one provider to the person without holding back another provider's helpers", () => {
    const { scheduler, rounds, free } = fixture();
    free("busy");

    scheduler.retryNow();

    const round = rounds.at(-1);
    expect(round?.mayTry("busy")).toBe(false);
    expect(round?.mayTry("quiet")).toBe(true);
    vi.advanceTimersByTime(2_000);
    scheduler.retryNow();
    expect(rounds.at(-1)?.mayTry("busy")).toBe(true);
    scheduler.stop();
  });

  it("keeps asking on the poll while turns keep ending somewhere else, so no wait is postponed for good", () => {
    const { scheduler, rounds, free } = fixture();
    free("busy");
    vi.advanceTimersByTime(2_000);
    const afterGrace = rounds.length;
    expect(afterGrace).toBeGreaterThan(0);

    // A busy provider frees a slot every second; a quiet one's helpers still
    // get their round on the poll, expiry included.
    for (let second = 0; second < 12; second++) {
      vi.advanceTimersByTime(1_000);
      free("busy");
    }

    expect(rounds.length).toBeGreaterThan(afterGrace);
    expect(rounds.every((round) => round.mayTry("quiet"))).toBe(true);
    scheduler.stop();
  });
});
