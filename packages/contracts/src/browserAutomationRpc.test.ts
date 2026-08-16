import { describe, expect, it } from "vitest";
import {
  decodeBrowserAutomationSnapshot,
  decodeBrowserContextCreateCommand,
  decodeBrowserContextInspectCommand,
  decodeBrowserContextStopCommand,
  decodeBrowserThreadScope,
} from "./browserAutomationRpc";

const authority = {
  hostId: "10000000-0000-4000-8000-000000000001",
  mode: "work",
  projectId: "20000000-0000-4000-8000-000000000001",
  rootId: "30000000-0000-4000-8000-000000000001",
  providerInstanceId: "40000000-0000-4000-8000-000000000001",
  extension: { kind: "core" },
} as const;

describe("browser automation RPC", () => {
  it("decodes a server-resolved thread authority scope", () => {
    expect(
      decodeBrowserThreadScope({
        threadId: "50000000-0000-4000-8000-000000000001",
        authority,
      }).authority,
    ).toEqual(authority);
  });

  it("decodes a normalized create command", () => {
    const command = decodeBrowserContextCreateCommand({
      threadId: "50000000-0000-4000-8000-000000000001",
      action: {
        actionId: "60000000-0000-4000-8000-000000000001",
        correlationId: "70000000-0000-4000-8000-000000000001",
        capability: { id: "browser-automation", version: 1 },
        authority,
        intent: "Open an isolated browser context.",
        approval: { kind: "not-required" },
      },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 300_000,
      },
    });
    expect(command.action.capability.id).toBe("browser-automation");
  });

  it("requires the owning thread for inspect and stop commands", () => {
    const contextId = "60000000-0000-4000-8000-000000000001";
    const threadId = "50000000-0000-4000-8000-000000000001";
    expect(decodeBrowserContextInspectCommand({ contextId, threadId })).toMatchObject({
      contextId,
      threadId,
    });
    expect(decodeBrowserContextStopCommand({ contextId, threadId })).toMatchObject({
      contextId,
      threadId,
    });
    expect(() => decodeBrowserContextInspectCommand({ contextId })).toThrow();
    expect(() => decodeBrowserContextStopCommand({ contextId })).toThrow();
  });

  it("decodes all truthful renderer states without raw browser content", () => {
    for (const status of [
      "ready",
      "running",
      "waiting",
      "unavailable",
      "interrupted",
      "failed",
      "stale",
    ] as const) {
      expect(
        decodeBrowserAutomationSnapshot({
          status,
          threadId: "50000000-0000-4000-8000-000000000001",
          evidence: [],
        }).status,
      ).toBe(status);
    }
  });
});
