import { describe, expect, it } from "vitest";
import {
  agentRunWorkingTimeLimitMinutes,
  DEFAULT_AGENT_RUN_POLICY_SETTINGS,
  decodeAgentRunPolicySettings,
  decodeUpdateAgentRunPolicySettings,
} from "./agentRunSettings";

describe("AgentRunPolicySettings", () => {
  it("decodes a valid settings record", () => {
    const decoded = decodeAgentRunPolicySettings({
      creationPosture: "automatic",
      version: 3,
      updatedAt: "2026-08-01T10:00:00.000Z",
    });
    expect(decoded.creationPosture).toBe("automatic");
    expect(decoded.version).toBe(3);
  });

  it("rejects a posture outside off/ask/automatic", () => {
    expect(() =>
      decodeAgentRunPolicySettings({
        creationPosture: "always",
        version: 1,
        updatedAt: "2026-08-01T10:00:00.000Z",
      }),
    ).toThrow();
  });

  it("lets the thread's agent start subagents unless a person turned them off", () => {
    expect(DEFAULT_AGENT_RUN_POLICY_SETTINGS.creationPosture).toBe("automatic");
  });
});

describe("a helper's working-time limit", () => {
  const stored: { readonly workingTimeLimitMinutes?: number } = {};

  it("is 120 minutes until a person chooses another", () => {
    expect(agentRunWorkingTimeLimitMinutes(stored, { threadAtFullAccess: false })).toBe(120);
    expect(
      agentRunWorkingTimeLimitMinutes(
        { ...stored, workingTimeLimitMinutes: 45 },
        { threadAtFullAccess: true },
      ),
    ).toBe(45);
  });

  it("is none only when the person chose that and the thread has Full access", () => {
    const lifted = { ...stored, noWorkingTimeLimitAtFullAccess: true };
    expect(agentRunWorkingTimeLimitMinutes(lifted, { threadAtFullAccess: true })).toBe("none");
    expect(agentRunWorkingTimeLimitMinutes(lifted, { threadAtFullAccess: false })).toBe(120);
  });
});

describe("UpdateAgentRunPolicySettings", () => {
  it("accepts only a bounded person-chosen working-time limit", () => {
    expect(
      decodeUpdateAgentRunPolicySettings({
        creationPosture: "automatic",
        expectedVersion: 0,
        workingTimeLimitMinutes: 90,
      }),
    ).toMatchObject({ workingTimeLimitMinutes: 90 });
    for (const value of [0, 241, 1.5])
      expect(() =>
        decodeUpdateAgentRunPolicySettings({
          creationPosture: "automatic",
          expectedVersion: 0,
          workingTimeLimitMinutes: value,
        }),
      ).toThrow();
  });
  it("lets a person lift the working-time limit for Full access threads", () => {
    expect(
      decodeUpdateAgentRunPolicySettings({
        creationPosture: "automatic",
        expectedVersion: 0,
        noWorkingTimeLimitAtFullAccess: true,
      }),
    ).toMatchObject({ noWorkingTimeLimitAtFullAccess: true });
  });

  it("accepts only a bounded person-chosen wait for a full provider", () => {
    expect(
      decodeUpdateAgentRunPolicySettings({
        creationPosture: "automatic",
        expectedVersion: 0,
        providerSlotWaitMinutes: 45,
      }),
    ).toMatchObject({ providerSlotWaitMinutes: 45 });
    for (const value of [0, 241, 1.5])
      expect(() =>
        decodeUpdateAgentRunPolicySettings({
          creationPosture: "automatic",
          expectedVersion: 0,
          providerSlotWaitMinutes: value,
        }),
      ).toThrow();
  });

  it("decodes a valid update command with an expected version", () => {
    const decoded = decodeUpdateAgentRunPolicySettings({
      creationPosture: "off",
      expectedVersion: 2,
    });
    expect(decoded.creationPosture).toBe("off");
    expect(decoded.expectedVersion).toBe(2);
  });

  it("refuses Ask as a choice now that no one starts a subagent by hand", () => {
    expect(() =>
      decodeUpdateAgentRunPolicySettings({ creationPosture: "ask", expectedVersion: 2 }),
    ).toThrow();
  });

  it("rejects excess properties", () => {
    expect(() =>
      decodeUpdateAgentRunPolicySettings({
        creationPosture: "off",
        expectedVersion: 2,
        mixedVendor: true,
      }),
    ).toThrow();
  });
});
