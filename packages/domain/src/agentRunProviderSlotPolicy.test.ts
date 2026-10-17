import { decodeUtcTimestamp } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  AGENT_RUN_PROVIDER_SLOT_WAIT_LIMIT_MS,
  AGENT_RUN_PROVIDER_SLOT_WAITING_REASON,
  agentRunProviderSlotWaitExpired,
  agentRunWaitsForProviderSlot,
} from "./agentRunProviderSlotPolicy";

const parkedAt = decodeUtcTimestamp("2026-10-17T10:00:00.000Z");
const waiting = {
  lifecycleStatus: "waiting",
  recoveryReason: AGENT_RUN_PROVIDER_SLOT_WAITING_REASON,
  updatedAt: parkedAt,
} as const;

describe("a child waiting for a provider slot", () => {
  it("is recognised by its status and reason together, and by nothing else", () => {
    expect(agentRunWaitsForProviderSlot(waiting)).toBe(true);
    expect(agentRunWaitsForProviderSlot({ ...waiting, lifecycleStatus: "running" })).toBe(false);
    expect(
      agentRunWaitsForProviderSlot({ ...waiting, recoveryReason: "waiting-on-dependencies" }),
    ).toBe(false);
  });

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
