import { decodeProviderInstanceId, decodeProviderObservedState } from "@octant/contracts";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000001");
const otherId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000002");

const capabilities = {
  streaming: "supported",
  resume: "supported",
  interruption: "supported",
  approvals: "supported",
  userQuestions: "supported",
  reasoning: "supported",
  usage: "supported",
  toolActivity: "supported",
  fileChanges: "supported",
  diffs: "supported",
  taskProgress: "supported",
  nativeChildAgents: "supported",
  nativeAttachments: "supported",
  nativeWebResearch: "supported",
  appManagedTools: "supported",
  citations: "supported",
} as const;

describe("ProviderRuntimeRegistry", () => {
  it("stores observed state independently from durable configuration", () => {
    const registry = new ProviderRuntimeRegistry();
    const observed = decodeProviderObservedState({
      instanceId,
      readiness: "ready",
      processState: "running",
      models: [],
      capabilities,
      observedAt: "2026-07-14T10:00:00.000Z",
    });
    registry.setObservedState(observed);
    expect(registry.observedStates()).toEqual([observed]);
    registry.clearObservedState(instanceId);
    expect(registry.observedStates()).toEqual([]);
  });

  it("stores runtime-only compatible protocol observations and clears them on invalidation", async () => {
    const registry = new ProviderRuntimeRegistry();
    registry.setCompatibleProtocol(instanceId, "chat-completions");
    expect(registry.compatibleProtocol(instanceId)).toBe("chat-completions");
    await registry.invalidateRuntime(instanceId);
    expect(registry.compatibleProtocol(instanceId)).toBeUndefined();
  });

  it("tracks active sessions per instance without allowing negative counts", () => {
    const registry = new ProviderRuntimeRegistry();
    registry.setActiveSessionCount(instanceId, 2);
    expect(registry.activeSessionCount(instanceId)).toBe(2);
    expect(registry.activeSessionCount(otherId)).toBe(0);
    expect(() => registry.setActiveSessionCount(instanceId, -1)).toThrow(/non-negative/i);
  });

  it("projects bounded aggregate activity and attention facts", () => {
    const registry = new ProviderRuntimeRegistry();
    const observed = decodeProviderObservedState({
      instanceId,
      readiness: "degraded",
      processState: "running",
      models: [],
      capabilities,
      observedAt: "2026-07-14T10:00:00.000Z",
    });
    registry.setObservedState(observed);
    registry.setActiveSessionCount(instanceId, 3);

    expect(registry.activeSessionTotal()).toBe(3);
    expect(registry.attentionRequired()).toBe(true);
  });

  it("shares an in-flight runtime for one instance and isolates different instances", async () => {
    const registry = new ProviderRuntimeRegistry();
    let starts = 0;
    const start = async () => ({
      value: { runtime: ++starts },
      close: async () => undefined,
    });
    const values = await Effect.runPromise(
      Effect.scoped(
        Effect.all([
          registry.acquireRuntime(instanceId, { start, idleMs: 30_000 }),
          registry.acquireRuntime(instanceId, { start, idleMs: 30_000 }),
          registry.acquireRuntime(otherId, { start, idleMs: 30_000 }),
        ]),
      ),
    );
    expect(values).toEqual([{ runtime: 1 }, { runtime: 1 }, { runtime: 2 }]);
    expect(starts).toBe(2);
    await registry.closeAll();
  });

  it("releases idle runtimes and atomically invalidates unexpected exits", async () => {
    const registry = new ProviderRuntimeRegistry();
    let closeCount = 0;
    let exit!: () => void;
    const exited = new Promise<void>((resolve) => {
      exit = resolve;
    });
    const observed = decodeProviderObservedState({
      instanceId,
      readiness: "ready",
      processState: "running",
      models: [],
      capabilities,
      observedAt: "2026-07-14T10:00:00.000Z",
    });
    registry.setObservedState(observed);
    let invalidations = 0;
    registry.onRuntimeInvalidated(instanceId, () => {
      invalidations += 1;
    });
    await Effect.runPromise(
      Effect.scoped(
        registry.acquireRuntime(instanceId, {
          idleMs: 5,
          start: async () => ({
            value: { runtime: 1 },
            exited,
            close: async () => {
              closeCount += 1;
            },
          }),
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(closeCount).toBe(1);

    await Effect.runPromise(
      Effect.scoped(
        registry
          .acquireRuntime(instanceId, {
            idleMs: 30_000,
            start: async () => ({ value: { runtime: 2 }, exited, close: async () => undefined }),
          })
          .pipe(
            Effect.tap(() =>
              Effect.promise(async () => {
                exit();
                await Promise.resolve();
              }),
            ),
          ),
      ),
    );
    await Promise.resolve();
    expect(registry.observedState(instanceId)).toBeUndefined();
    expect(invalidations).toBe(1);
    expect(registry.hasRuntime(instanceId)).toBe(false);
  });

  it("preserves typed startup failures while redacting unknown errors", async () => {
    const registry = new ProviderRuntimeRegistry();
    const typed = await Effect.runPromise(
      Effect.scoped(
        Effect.exit(
          registry.acquireRuntime(instanceId, {
            idleMs: 0,
            start: async () =>
              Promise.reject({
                category: "invalid-configuration",
                message: "OpenCode binary path is invalid.",
              }),
          }),
        ),
      ),
    );
    expect(String(typed)).toContain("invalid-configuration");
    const unknown = await Effect.runPromise(
      Effect.scoped(
        Effect.exit(
          registry.acquireRuntime(otherId, {
            idleMs: 0,
            start: async () => Promise.reject(new Error("private path")),
          }),
        ),
      ),
    );
    expect(String(unknown)).toContain("unavailable");
    expect(String(unknown)).not.toContain("private path");
  });

  it("invalidates an idle runtime before a configuration-dependent restart", async () => {
    const registry = new ProviderRuntimeRegistry();
    const close = vi.fn(async () => undefined);
    await Effect.runPromise(
      Effect.scoped(
        registry.acquireRuntime(instanceId, {
          idleMs: 30_000,
          start: async () => ({ value: "old-runtime", close }),
        }),
      ),
    );
    expect(registry.hasRuntime(instanceId)).toBe(true);
    await registry.invalidateRuntime(instanceId);
    expect(close).toHaveBeenCalledOnce();
    expect(registry.hasRuntime(instanceId)).toBe(false);
  });

  it("rejects explicit runtime invalidation while sessions are active", async () => {
    const registry = new ProviderRuntimeRegistry();
    registry.setActiveSessionCount(instanceId, 1);
    await expect(registry.invalidateRuntime(instanceId)).rejects.toMatchObject({
      message: "Stop active sessions before changing this provider runtime.",
    });
  });

  it("persists provider process ownership and removes it on close", async () => {
    const receiptDirectory = await mkdtemp(join(tmpdir(), "octant-provider-receipts-"));
    try {
      const registry = new ProviderRuntimeRegistry({
        receiptDirectory,
        processIdentity: async () => `sha256:${"a".repeat(64)}`,
      });
      await Effect.runPromise(
        Effect.scoped(
          registry.acquireRuntime(instanceId, {
            idleMs: 30_000,
            start: async () => ({
              value: { client: "consumer-value" },
              pid: 4321,
              close: async () => undefined,
            }),
          }),
        ),
      );
      expect(await readdir(receiptDirectory)).toHaveLength(1);
      await registry.closeAll();
      expect(await readdir(receiptDirectory)).toHaveLength(0);
    } finally {
      await rm(receiptDirectory, { recursive: true, force: true });
    }
  });

  it("persists provider ownership while runtime startup is still pending", async () => {
    const receiptDirectory = await mkdtemp(join(tmpdir(), "octant-provider-receipts-"));
    try {
      let releaseStartup!: () => void;
      const startupComplete = new Promise<void>((resolve) => {
        releaseStartup = resolve;
      });
      let resolveExit!: () => void;
      const exited = new Promise<void>((resolve) => {
        resolveExit = resolve;
      });
      const registry = new ProviderRuntimeRegistry({
        receiptDirectory,
        processIdentity: async () => `sha256:${"a".repeat(64)}`,
      });
      const acquired = Effect.runPromise(
        Effect.scoped(
          registry.acquireRuntime(instanceId, {
            idleMs: 30_000,
            start: async (onProcessStarted) => {
              const receipt = await onProcessStarted!({ pid: 4321, exited });
              await startupComplete;
              return {
                value: { client: "consumer-value" },
                pid: 4321,
                exited,
                receipt,
                close: async () => {
                  resolveExit();
                },
              };
            },
          }),
        ),
      );

      await vi.waitFor(async () => expect(await readdir(receiptDirectory)).toHaveLength(1));
      releaseStartup();
      await acquired;
      await registry.closeAll();
      await vi.waitFor(async () => expect(await readdir(receiptDirectory)).toHaveLength(0));
    } finally {
      await rm(receiptDirectory, { recursive: true, force: true });
    }
  });

  it("retains provider receipts when runtime cleanup fails", async () => {
    const receiptDirectory = await mkdtemp(join(tmpdir(), "octant-provider-receipts-"));
    try {
      const registry = new ProviderRuntimeRegistry({
        receiptDirectory,
        processIdentity: async () => `sha256:${"a".repeat(64)}`,
      });
      await Effect.runPromise(
        Effect.scoped(
          registry.acquireRuntime(instanceId, {
            idleMs: 30_000,
            start: async () => ({
              value: { client: "consumer-value" },
              pid: 4321,
              close: async () => {
                throw new Error("provider cleanup failed");
              },
            }),
          }),
        ),
      );

      await expect(registry.closeAll()).rejects.toThrow("provider cleanup failed");
      expect(await readdir(receiptDirectory)).toHaveLength(1);
    } finally {
      await rm(receiptDirectory, { recursive: true, force: true });
    }
  });

  it("observes recoverable idle cleanup failures instead of leaking a rejected promise", async () => {
    const registry = new ProviderRuntimeRegistry();
    const close = vi.fn(async () => {
      throw new Error("idle provider cleanup failed");
    });
    await Effect.runPromise(
      Effect.scoped(
        registry.acquireRuntime(instanceId, {
          idleMs: 1,
          start: async () => ({ value: "runtime", close }),
        }),
      ),
    );

    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(registry.hasRuntime(instanceId)).toBe(false);
    await expect(registry.closeAll()).resolves.toBeUndefined();
  });

  it("retains directly tracked receipts until the process group is gone", async () => {
    const receiptDirectory = await mkdtemp(join(tmpdir(), "octant-provider-receipts-"));
    try {
      let groupExists = true;
      let resolveExit!: () => void;
      const exited = new Promise<void>((resolve) => {
        resolveExit = resolve;
      });
      const registry = new ProviderRuntimeRegistry({
        receiptDirectory,
        processIdentity: async () => `sha256:${"a".repeat(64)}`,
        processGroupExists: () => groupExists,
        shutdownTimeoutMs: 20,
      });

      await registry.trackProcess(instanceId, { pid: 4321, exited });
      expect(await readdir(receiptDirectory)).toHaveLength(1);
      resolveExit();
      await Promise.resolve();
      expect(await readdir(receiptDirectory)).toHaveLength(1);

      groupExists = false;
      await vi.waitFor(async () => expect(await readdir(receiptDirectory)).toHaveLength(0));
    } finally {
      await rm(receiptDirectory, { recursive: true, force: true });
    }
  });

  it("revokes trusted observations and notifies listeners when runtime cleanup fails", async () => {
    const registry = new ProviderRuntimeRegistry();
    registry.setObservedState(
      decodeProviderObservedState({
        instanceId,
        readiness: "ready",
        processState: "running",
        models: [
          {
            id: "model-1",
            displayName: "Model One",
            source: "discovered",
            verification: "verified",
            reasoning: "supported",
            inputModalities: ["text"],
            options: [],
          },
        ],
        capabilities,
        observedAt: "2026-07-14T10:00:00.000Z",
      }),
    );
    const invalidated = vi.fn();
    registry.onRuntimeInvalidated(instanceId, invalidated);
    await Effect.runPromise(
      Effect.scoped(
        registry.acquireRuntime(instanceId, {
          idleMs: 30_000,
          start: async () => ({
            value: "uncertain-runtime",
            close: async () => {
              throw new Error("private cleanup detail");
            },
          }),
        }),
      ),
    );

    await expect(registry.invalidateRuntime(instanceId)).rejects.toThrow("private cleanup detail");
    expect(registry.observedState(instanceId)).toBeUndefined();
    expect(invalidated).toHaveBeenCalledOnce();
    expect(registry.hasRuntime(instanceId)).toBe(false);
  });
});
