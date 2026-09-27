import { describe, expect, it } from "vitest";
import {
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

describe("UpdateAgentRunPolicySettings", () => {
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
