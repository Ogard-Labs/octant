import { describe, expect, it, vi } from "vitest";
import { createHostWorktreeBranchSuggester } from "./worktreeBranchSuggester";

// The driver would start a real provider; what is under test is who may reach it.
vi.mock("./providers", () => ({ makeConfiguredProviderDriver: () => ({}) }));
const complete = vi.hoisted(() => vi.fn());
vi.mock("../harness/nativeHarnessSingleShot", () => ({ completeOnceOutcome: complete }));
const record = vi.hoisted(() => vi.fn());
vi.mock("../shield/shieldUsageLedger", () => ({ recordUnplannedUsage: record }));

const provider = "00000000-0000-4000-8000-000000000001" as never;
const model = "model-a" as never;

function suggester(
  overrides: {
    readonly readiness?: string;
    readonly allowed?: boolean;
    readonly enabled?: boolean;
    readonly projectType?: "code" | "chat";
    readonly admit?: () => { status: "refused" } | { status: "admitted" };
  } = {},
) {
  const admit = vi.fn(overrides.admit ?? (() => ({ status: "admitted" as const })));
  const settle = vi.fn();
  const port = createHostWorktreeBranchSuggester({
    persistence: {
      readProviderInstance: () => ({
        id: provider,
        enabled: overrides.enabled ?? true,
        driverKind: "codex",
        configuration: { kind: "codex-cli", binaryPath: "codex" },
        displayName: "Account",
      }),
      readProviderCatalog: () => ({ models: [{ id: model }] }),
      readProject: () => ({
        type: overrides.projectType ?? "code",
        lifecycle: "active",
      }),
    } as never,
    providerRuntimeRegistry: {
      observedState: () => ({ readiness: overrides.readiness ?? "ready" }),
    } as never,
    isProjectPolicyTargetAllowed: () => overrides.allowed ?? true,
    configuredDriverOptions: () => ({}) as never,
    providerDataDirectory: "/data",
    spendCeiling: { admit, settle, abandon: vi.fn() } as never,
  });
  return { port, admit, settle };
}

const input = {
  projectId: "00000000-0000-4000-8000-0000000000a1" as never,
  providerInstanceId: provider,
  modelId: model,
  draft: "Fix the login redirect",
};

describe("createHostWorktreeBranchSuggester", () => {
  it("declines without a model call when the provider is not ready, disabled, or not allowed for the Project", async () => {
    for (const overrides of [
      { readiness: "needs-authentication" },
      { enabled: false },
      { allowed: false },
      { projectType: "chat" as const },
    ]) {
      const { port, admit } = suggester(overrides);
      const result = await port.suggest(input);
      expect(result.status, JSON.stringify(overrides)).toBe("refused");
      expect(admit).not.toHaveBeenCalled();
    }
  });

  it("declines as spend-limited when the Project's ceilings refuse the request", async () => {
    const { port } = suggester({ admit: () => ({ status: "refused" }) });
    await expect(port.suggest(input)).resolves.toEqual({
      status: "refused",
      reason: "spend-limited",
    });
  });

  it("asks for the reservation against the Project with a bounded token estimate that is not a turn", async () => {
    const { port, admit } = suggester();
    await port.suggest(input).catch(() => undefined);
    expect(admit).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: String(input.projectId),
        threadType: "code-thread",
        countsAsTurn: false,
        estimatedCostUsdMicros: "unknown",
        turnUpperBoundTokens: 4_000,
      }),
    );
  });

  it("records the spend under the Project before its reservation is released", async () => {
    const { port, settle } = suggester();
    const usage = { inputTokens: 40, outputTokens: 6 };
    complete.mockImplementationOnce(
      async ({ onSend }: { readonly onSend?: (sent: boolean) => void }) => {
        onSend?.(true);
        return { status: "completed", text: "fix login redirect", usage };
      },
    );
    await port.suggest(input);
    expect(record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        aggregateId: String(input.projectId),
        providerInstanceId: provider,
        modelId: model,
        usage,
      }),
    );
    expect(record.mock.invocationCallOrder[0]).toBeLessThan(
      settle.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("stops the model call when the person's request goes away", async () => {
    const { port } = suggester();
    const request = new AbortController();
    complete.mockImplementationOnce(
      ({ signal }: { readonly signal?: AbortSignal }) =>
        new Promise((resolve) => {
          signal?.addEventListener("abort", () => resolve({ status: "failed" }));
        }),
    );
    const suggestion = port.suggest({ ...input, signal: request.signal });
    request.abort();
    await expect(suggestion).resolves.toEqual({ status: "failed" });
  });
});
