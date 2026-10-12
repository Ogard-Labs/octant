import { describe, expect, it } from "vitest";
import { decodeProviderInstance } from "@octant/contracts";
import {
  accountPlanUsageKey,
  claudePlanUsageStateDirectory,
  perModelWeeklyWindowId,
  planUsageStatusFromProcess,
  planUsageUtilizationFromPercent,
  planUsageUtilizationFromShare,
  planUsageWindowStatus,
} from "./providerAccountPlanUsage";

const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";

function claudeAccount(configuration: Record<string, unknown>) {
  return decodeProviderInstance({
    id: firstId,
    displayName: "Claude",
    driverKind: "claude",
    configuration: {
      kind: "claude-agent-sdk",
      binaryPath: "/opt/homebrew/bin/claude",
      ...configuration,
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: "2026-10-11T12:00:00.000Z",
    updatedAt: "2026-10-11T12:00:00.000Z",
  });
}

describe("provider account plan usage", () => {
  it("keeps plan usage for a subscription account only, under the directory it runs from", () => {
    const assigned = `/Users/example/.claude-accounts/${firstId}`;

    expect(
      claudePlanUsageStateDirectory(
        claudeAccount({ authentication: "subscription" }),
        "/Users/example",
      ),
    ).toBe("/Users/example/.claude");
    expect(
      claudePlanUsageStateDirectory(
        claudeAccount({ authentication: "subscription", configDirectory: assigned }),
        "/Users/example",
      ),
    ).toBe(assigned);
    // The same account after a switch to an API key keeps its directory. Its
    // old plan windows must not be read back as limits on the key.
    expect(
      claudePlanUsageStateDirectory(
        claudeAccount({ authentication: "api-key", configDirectory: assigned }),
        "/Users/example",
      ),
    ).toBeUndefined();
  });

  it("isolates snapshots by instance and the state directory that session ran under", () => {
    expect(
      accountPlanUsageKey({
        instanceId: firstId,
        stateDirectory: "/Users/example/.claude/",
      }),
    ).toBe(`${firstId}:/Users/example/.claude`);
    expect(
      accountPlanUsageKey({
        instanceId: firstId,
        stateDirectory: `/Users/example/.claude-accounts/${firstId}`,
      }),
    ).not.toBe(
      accountPlanUsageKey({
        instanceId: firstId,
        stateDirectory: "/Users/example/.claude",
      }),
    );
    expect(
      accountPlanUsageKey({
        instanceId: firstId,
        stateDirectory: "/Users/example/.claude",
      }),
    ).not.toBe(
      accountPlanUsageKey({
        instanceId: secondId,
        stateDirectory: "/Users/example/.claude",
      }),
    );
  });

  it("refuses a key that would collapse two accounts into one bucket", () => {
    expect(() => accountPlanUsageKey({ instanceId: firstId, stateDirectory: "   " })).toThrow(
      /state directory/,
    );
    expect(() =>
      accountPlanUsageKey({ instanceId: "  ", stateDirectory: "/Users/example/.claude" }),
    ).toThrow(/instance/);
  });

  it("projects a process percent into the 0–1 share the rest of Octant already stores", () => {
    expect(planUsageUtilizationFromPercent(87)).toBe(0.87);
    expect(planUsageUtilizationFromPercent(0)).toBe(0);
    expect(planUsageUtilizationFromPercent(140)).toBe(1);
    expect(planUsageUtilizationFromPercent(-1)).toBeUndefined();
    expect(planUsageUtilizationFromShare(0.4)).toBe(0.4);
    expect(planUsageUtilizationFromShare(2)).toBe(1);
  });

  it("names window status from utilization or the process's own allowed/warning/rejected", () => {
    expect(planUsageWindowStatus(undefined)).toBe("allowed");
    expect(planUsageWindowStatus(0.79)).toBe("allowed");
    expect(planUsageWindowStatus(0.8)).toBe("warning");
    expect(planUsageWindowStatus(1)).toBe("exhausted");
    expect(planUsageStatusFromProcess("allowed")).toBe("allowed");
    expect(planUsageStatusFromProcess("allowed_warning")).toBe("warning");
    expect(planUsageStatusFromProcess("rejected")).toBe("exhausted");
  });

  it("keeps a per-model weekly window labeled as that model, not a shared weekly bucket", () => {
    expect(perModelWeeklyWindowId("Opus")).toBe("per_model:Opus");
    expect(perModelWeeklyWindowId("  ")).toBe("per_model");
  });
});
