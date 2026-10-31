import type { CodeThread, ProviderModelId } from "@octant/contracts";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import type { ShieldCall } from "@octant/domain/shield-judge-policy";
import { describe, expect, it, vi } from "vitest";
import { createHostShield, shieldRoutesApprovals, type HostShieldDependencies } from "./hostShield";

const threadId = "00000000-0000-4000-8000-000000000061";
const providerInstanceId = "00000000-0000-4000-8000-0000000000e6";
const thread = (fields: Partial<CodeThread> = {}) =>
  ({
    id: threadId,
    lifecycle: "active",
    projectId: "00000000-0000-4000-8000-0000000000b6",
    providerInstanceId,
    modelId: "big-model",
    executionPolicy: "approval-gated",
    autoApprove: true,
    ...fields,
  }) as unknown as CodeThread;

const command = (text: string): ShieldCall => ({
  tool: "bash",
  kind: "command",
  command: text,
  approvalClass: "shell-commands",
  paths: [],
  urls: [],
  arguments: JSON.stringify({ command: text }),
  workingDirectory: "/Users/dev/app",
});

function hostShieldWith(stored: CodeThread, overrides: Partial<HostShieldDependencies> = {}) {
  return createHostShield({
    readCodeThread: () => stored,
    providerCapabilities: () => ({ harnessAutoReview: "unsupported" }),
    routesApprovals: () => true,
    catalog: () => [
      { id: "big-model" as ProviderModelId, displayName: "Big" },
      { id: "fast-mini" as ProviderModelId, displayName: "Fast mini" },
    ],
    resolveDriver: () => ({}) as ProviderDriver,
    tainted: () => false,
    personMessages: () => ["Show me the status."],
    scratchRoot: "/tmp/octant-shield-scratch",
    clock: () => "2026-10-31T00:00:00.000Z",
    ...overrides,
  });
}

describe("Octant Shield as the host wires it", () => {
  it("reviews an Octant Harness thread at Auto, with the provider's smallest model", async () => {
    const shield = hostShieldWith(thread());
    const decision = await shield.review({
      threadId,
      call: command("git status"),
      boundRoot: "/Users/dev/app",
    });
    expect(decision).toMatchObject({ verdict: "allow", rule: "read-only-git" });
  });

  it("leaves Ask first, Plan and Full access to their own approvers", async () => {
    for (const fields of [
      { autoApprove: false },
      { executionPolicy: "plan" as const },
      { executionPolicy: "full-access" as const },
    ]) {
      const shield = hostShieldWith(thread(fields));
      expect(
        await shield.review({ threadId, call: command("git status"), boundRoot: "/Users/dev/app" }),
      ).toBeUndefined();
    }
  });

  it("leaves a provider's own reviewer in place by default", async () => {
    const shield = hostShieldWith(thread(), {
      providerCapabilities: () => ({ harnessAutoReview: "supported" }),
    });
    expect(
      await shield.review({ threadId, call: command("git status"), boundRoot: "/Users/dev/app" }),
    ).toBeUndefined();
  });

  it("follows the running turn's narrowed posture, not only the stored one", async () => {
    const shield = hostShieldWith(thread(), { readTurnExecutionPolicy: () => "plan" });
    expect(
      await shield.review({ threadId, call: command("git status"), boundRoot: "/Users/dev/app" }),
    ).toBeUndefined();
  });

  it("is unavailable where the runtime does not route its prompts or no driver resolves", () => {
    expect(
      hostShieldWith(thread(), { routesApprovals: () => false }).availableFor(
        providerInstanceId as never,
      ),
    ).toBe(false);
    expect(
      hostShieldWith(thread(), { resolveDriver: () => undefined }).availableFor(
        providerInstanceId as never,
      ),
    ).toBe(false);
    expect(hostShieldWith(thread()).availableFor(providerInstanceId as never)).toBe(true);
  });

  it("counts a model call against the thread's spend ceilings", async () => {
    const admit = vi.fn(() => ({
      status: "admitted" as const,
      reservedTokens: 4_096,
      reservations: [],
    }));
    const settle = vi.fn();
    const recordUsage = vi.fn();
    const shield = hostShieldWith(thread(), {
      spendCeiling: { admit, settle, abandon: vi.fn() },
      recordUsage,
      // A driver that cannot be acquired leaves the model unreached.
      resolveDriver: () =>
        ({
          acquire: () => {
            throw new Error("not reachable");
          },
        }) as unknown as ProviderDriver,
    });
    const decision = await shield.review({
      threadId,
      call: command("make lint"),
      boundRoot: "/Users/dev/app",
    });
    expect(decision).toMatchObject({ verdict: "ask", stage: "fail-closed" });
    expect(admit).toHaveBeenCalledWith(
      expect.objectContaining({ threadId, threadType: "code-thread", countsAsTurn: false }),
    );
    // A call that reported nothing is still recorded, as unreported spend,
    // before its reservation is released.
    expect(recordUsage).toHaveBeenCalledExactlyOnceWith({
      threadId,
      model: { providerInstanceId, modelId: "fast-mini" },
      usage: undefined,
    });
    expect(settle).toHaveBeenCalledExactlyOnceWith({ reservationId: expect.any(String) });
    expect(recordUsage.mock.invocationCallOrder[0]).toBeLessThan(
      settle.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("shows decisions on the transcript once the Code runtime is wired", () => {
    const shield = hostShieldWith(thread());
    const decision = {
      reviewer: "octant-shield" as const,
      verdict: "allow" as const,
      stage: "fast-allow" as const,
      reason: "A read.",
      latencyMs: 0,
      decidedAt: "2026-10-31T00:00:00.000Z" as never,
    };
    expect(() =>
      shield.recordOnTranscript?.({ threadId, summary: "read", decision }),
    ).not.toThrow();
    const record = vi.fn();
    shield.showDecisionsWith(record);
    shield.recordOnTranscript?.({ threadId, summary: "read", decision });
    expect(record).toHaveBeenCalledWith({ threadId, summary: "read", decision });
  });

  it("reviews every runtime that sends its prompts to Octant, and none that decides alone", () => {
    for (const kind of [
      "openai-compatible",
      "ollama",
      "claude",
      "codex",
      "opencode",
      "pi",
      "kilo",
    ]) {
      expect(shieldRoutesApprovals(kind as never), kind).toBe(true);
    }
    for (const kind of ["oh-my-pi", "openai-image"]) {
      expect(shieldRoutesApprovals(kind as never), kind).toBe(false);
    }
  });
});
