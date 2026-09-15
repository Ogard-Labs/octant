import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeProviderInstanceId } from "@octant/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeAcpDriver } from "./acpDriver";
import { makeAcpProcessLive } from "./acpProcess";
import { acpProviderProfiles } from "./acpProfiles";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

const enabled = process.env.OCTANT_DEVIN_SMOKE === "1";
const binaryPath = process.env.OCTANT_DEVIN_BINARY ?? "/opt/homebrew/bin/devin";
const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000371");

describe("installed Devin runtime", () => {
  it.skipIf(!enabled)(
    "uses provider-owned authentication for a non-generating connection check and cleanup",
    async () => {
      const managedHome = await realpath(await mkdtemp(join(tmpdir(), "octant-devin-smoke-")));
      const registry = new ProviderRuntimeRegistry();
      const driver = makeAcpDriver({
        profile: acpProviderProfiles.devin,
        instanceId,
        binaryPath,
        managedHome,
        process: makeAcpProcessLive(),
        runtimeRegistry: registry,
      });
      try {
        const probe = await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));
        expect(probe.readiness).toBe("ready");
        expect(probe.detectedVersion).toMatch(/^\d+\.\d+\.\d+$/);
        expect(probe.models.length).toBeGreaterThan(0);
        expect(registry.activeSessionCount(instanceId)).toBe(0);
      } finally {
        await registry.closeAll();
        await rm(managedHome, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
