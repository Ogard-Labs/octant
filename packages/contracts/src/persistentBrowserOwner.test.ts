import { describe, expect, it } from "vitest";
import { decodePersistentBrowserLeaseBinding } from "./persistentBrowserOwner";

const binding = {
  ownerId: "10000000-0000-4000-8000-000000000001",
  grantId: "10000000-0000-4000-8000-000000000002",
  executionId: "10000000-0000-4000-8000-000000000003",
  threadId: "10000000-0000-4000-8000-000000000004",
  mode: "code",
  projectId: "10000000-0000-4000-8000-000000000005",
  providerId: "provider",
  modelId: "model",
  authorityRevision: "revision",
  profile: { kind: "personal" },
  origins: ["https://example.com"],
  expiresAt: "2026-11-07T20:30:00.000Z",
};

describe("a persistent native execution receipt", () => {
  it("accepts an exact host owner and HTTPS scope without a renderer identity", () => {
    expect(decodePersistentBrowserLeaseBinding(binding)).toEqual(binding);
    for (const input of [
      { ...binding, windowId: binding.threadId },
      { ...binding, mode: "chat" },
      { ...binding, profile: { kind: "private" } },
      { ...binding, origins: [] },
      { ...binding, origins: ["http://example.com"] },
      { ...binding, origins: ["https://example.com/path"] },
      { ...binding, origins: ["https://user:password@example.com"] },
      { ...binding, origins: ["https://example.com?query=value"] },
    ])
      expect(() => decodePersistentBrowserLeaseBinding(input)).toThrow();
  });
});
