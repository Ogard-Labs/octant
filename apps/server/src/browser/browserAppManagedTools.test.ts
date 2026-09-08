import { describe, expect, it, vi } from "vitest";
import type { BrowserAutomationSnapshot, ToolActionAuthority } from "@octant/contracts";
import { createBrowserAppManagedTools } from "./browserAppManagedTools";

const windowId = "10000000-0000-4000-8000-000000000001" as never;
const threadId = "20000000-0000-4000-8000-000000000001" as never;
const authority = {
  hostId: "30000000-0000-4000-8000-000000000001",
  mode: "chat",
  providerInstanceId: "40000000-0000-4000-8000-000000000001",
  extension: { kind: "core" },
} as unknown as ToolActionAuthority;

function snapshot(overrides: Partial<BrowserAutomationSnapshot> = {}): BrowserAutomationSnapshot {
  return { status: "ready", threadId, evidence: [], ...overrides } as BrowserAutomationSnapshot;
}

describe("createBrowserAppManagedTools", () => {
  it("offers Chat browser on demand and keeps approval separate from filesystem tools", async () => {
    const create = vi.fn(async () =>
      snapshot({
        status: "running",
        context: {
          contextId: "50000000-0000-4000-8000-000000000001" as never,
          threadId,
          actionId: "60000000-0000-4000-8000-000000000001" as never,
          correlationId: "70000000-0000-4000-8000-000000000001" as never,
          authority,
          policy: {
            profileMode: "isolated",
            allowedOrigins: ["https://example.com"],
            credentialFieldProtection: true,
            maxConcurrentTabs: 8,
            sessionTimeoutMs: 600_000,
          },
          state: "active",
          createdAt: "2026-09-09T10:00:00.000Z" as never,
        },
      }),
    );
    const act = vi.fn(async () =>
      snapshot({ status: "running", observation: { revision: 7 } as never }),
    );
    const approval = vi.fn(async () => "approved" as const);
    const tools = createBrowserAppManagedTools({
      windowId,
      threadId,
      mode: "chat",
      executionPolicy: "approval-gated",
      resolveAuthority: () => authority,
      browser: {
        inspectThread: () => snapshot(),
        create,
        act,
        releaseThread: vi.fn(async () => snapshot()),
      },
      approvals: { request: approval } as never,
      uuid: () => "80000000-0000-4000-8000-000000000001",
    });
    expect(tools.definitions.map((definition) => definition.name)).toEqual(["octant_browser"]);
    const result = await tools.execute({
      name: "octant_browser",
      inputJson: JSON.stringify({ operation: "navigate", url: "https://example.com/path" }),
    });
    expect(result).toMatchObject({
      isError: false,
      result: { page: { observationRevision: 7 } },
    });
    expect(approval).toHaveBeenCalledWith(
      expect.objectContaining({ origin: "https://example.com" }),
    );
    expect(create).toHaveBeenCalledOnce();
  });

  it("does not start a context when approval is unavailable or Chat is in Plan", async () => {
    const create = vi.fn(async () => snapshot());
    const make = (executionPolicy: "approval-gated" | "plan" = "approval-gated") =>
      createBrowserAppManagedTools({
        windowId,
        threadId,
        mode: "chat",
        executionPolicy,
        resolveAuthority: () => authority,
        browser: {
          inspectThread: () => snapshot(),
          create,
          act: vi.fn(async () => snapshot()),
          releaseThread: vi.fn(async () => snapshot()),
        },
        uuid: crypto.randomUUID,
      });
    const missing = await make().execute({
      name: "octant_browser",
      inputJson: JSON.stringify({ operation: "navigate", url: "https://example.com" }),
    });
    expect(missing.result).toEqual({ error: "browser-approval-required" });
    const planned = await make("plan").execute({
      name: "octant_browser",
      inputJson: JSON.stringify({ operation: "navigate", url: "https://example.com" }),
    });
    expect(planned.result).toEqual({ error: "plan-mode-read-only" });
    expect(create).not.toHaveBeenCalled();

    const restricted = createBrowserAppManagedTools({
      windowId,
      threadId,
      mode: "chat",
      executionPolicy: "approval-gated",
      toolConstraints: ["web-search"],
      resolveAuthority: () => authority,
      browser: {
        inspectThread: () => snapshot(),
        create,
        act: vi.fn(async () => snapshot()),
        releaseThread: vi.fn(async () => snapshot()),
      },
      uuid: crypto.randomUUID,
    });
    expect(restricted.definitions).toEqual([]);
    await expect(
      restricted.execute({
        name: "octant_browser",
        inputJson: JSON.stringify({ operation: "navigate", url: "https://example.com" }),
      }),
    ).resolves.toEqual({ result: { error: "tool-unavailable" }, isError: true });
    expect(create).not.toHaveBeenCalled();
  });
});
