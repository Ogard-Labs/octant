import { decodeUtcTimestamp } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  AGENT_RUN_PROVIDER_SLOT_WAIT_LIMIT_MS,
  agentRunProviderSlotWaitExpired,
} from "./agentRunProviderSlotPolicy";

const parkedAt = decodeUtcTimestamp("2026-10-17T10:00:00.000Z");
const waiting = { lifecycleStatus: "waiting", updatedAt: parkedAt } as const;

describe("a child waiting for a provider slot", () => {
  it("has waited as long as it may once the limit has passed since it parked", () => {
    const parkedMs = Date.parse(parkedAt);
    expect(agentRunProviderSlotWaitExpired(waiting, parkedMs)).toBe(false);
    expect(
      agentRunProviderSlotWaitExpired(
        waiting,
        parkedMs + AGENT_RUN_PROVIDER_SLOT_WAIT_LIMIT_MS - 1,
      ),
    ).toBe(false);
    expect(
      agentRunProviderSlotWaitExpired(waiting, parkedMs + AGENT_RUN_PROVIDER_SLOT_WAIT_LIMIT_MS),
    ).toBe(true);
    expect(
      agentRunProviderSlotWaitExpired(
        { ...waiting, lifecycleStatus: "running" },
        parkedMs + AGENT_RUN_PROVIDER_SLOT_WAIT_LIMIT_MS,
      ),
    ).toBe(false);
  });
});
