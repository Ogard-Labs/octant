import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type ProviderModelId,
} from "@octant/contracts";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeOpenCodeDriver } from "./openCodeDriver";
import { makeOpenCodeProcessLive } from "./openCodeProcess";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

const enabled = process.env.OCTANT_OPENCODE_SMOKE === "1";

describe("real OpenCode integration", () => {
  it.skipIf(!enabled)(
    "runs only with OCTANT_OPENCODE_SMOKE=1 because it starts the installed authenticated CLI",
    async () => {
      const binaryPath = findExecutable("opencode");
      expect(binaryPath, "enabled smoke requires an installed OpenCode CLI").not.toBeNull();
      const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000301");
      const sessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000302");
      const registry = new ProviderRuntimeRegistry();
      const driver = makeOpenCodeDriver({
        instanceId,
        binaryPath: binaryPath!,
        process: makeOpenCodeProcessLive({ startupTimeoutMs: 20_000 }),
        runtimeRegistry: registry,
        idleLeaseMs: 0,
        permissionPersistence: () => "current-session",
      });
      const projectRoot = process.cwd();
      const probe = await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));
      expect(probe.readiness).toBe("ready");
      expect(probe.detectedVersion).toMatch(/^\d+\.\d+\.\d+/);
      expect(probe.models.length).toBeGreaterThan(0);

      await Effect.runPromise(
        Effect.scoped(
          driver.acquire({ instanceId, projectRoot }).pipe(
            Effect.flatMap((connection) =>
              connection
                .start({
                  sessionId,
                  modelId: probe.models[0]!.id as ProviderModelId,
                  executionPolicy: "plan",
                })
                .pipe(Effect.tap(() => connection.interrupt(sessionId))),
            ),
          ),
        ),
      );
      await registry.closeAll();
      expect(registry.hasRuntime(instanceId)).toBe(false);
    },
    60_000,
  );
});

function findExecutable(name: string): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching the inherited PATH without invoking a shell.
    }
  }
  return undefined;
}
