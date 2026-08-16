import { describe, expect, it } from "vitest";
import type { ExtensionSnapshot } from "@octant/contracts/extension-rpc";
import { ExtensionApiService } from "./extensionApiService";
import type { ExtensionLifecycleService } from "./extensionLifecycleService";
import type { ResolvedExtensionPackage } from "./packageInspector";

const emptySnapshot: ExtensionSnapshot = {
  sequence: 0 as never,
  snapshotAt: "2026-07-28T12:00:00.000Z" as never,
  packages: [],
  collisions: [],
};

function noopLifecycle(): ExtensionLifecycleService {
  return {
    snapshot: () => emptySnapshot,
    install: async () => emptySnapshot,
    update: async () => emptySnapshot,
    rollback: async () => emptySnapshot,
    disable: async () => emptySnapshot,
    uninstall: async () => emptySnapshot,
    reconcileStartup: async () => emptySnapshot,
    setSourceTrust: async () => emptySnapshot,
    setPluginDesired: async () => emptySnapshot,
    setComponentDesired: async () => emptySnapshot,
  } as unknown as ExtensionLifecycleService;
}

describe("extension inspect abort propagation", () => {
  it("threads request abort to in-flight resolver and returns interrupted without retaining inspection", async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const resolver = {
      resolve: async (_command: never, signal?: AbortSignal): Promise<ResolvedExtensionPackage> => {
        observedSignal = signal;
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        await new Promise<void>((_, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
          setTimeout(() => reject(new Error("timeout")), 5000);
        });
        throw new DOMException("Aborted", "AbortError");
      },
    };
    const service = new ExtensionApiService({ lifecycle: noopLifecycle(), resolver });

    const resultPromise = service.execute(
      {
        kind: "inspect-package",
        source: { kind: "catalog", catalogId: "octant", entryId: "fixture" },
      } as never,
      controller.signal,
    );

    setTimeout(() => controller.abort(), 10);

    const result = await resultPromise;
    expect(result.kind).toBe("extension-command-failed");
    expect((result as { failure: { category: string } }).failure.category).toBe("interrupted");
    expect(observedSignal).toBe(controller.signal);

    // Verify no inspection was retained: an install attempt must require inspection.
    const installResult = await service.execute({
      kind: "install-package",
      extensionId: "x",
      packageId: "y",
      version: "1.0.0",
      digest: "sha256:0",
    } as never);
    expect(installResult.kind).toBe("extension-command-failed");
    expect((installResult as { failure: { category: string } }).failure.category).toBe("stale");
  });
});
