/** Fixed synthetic backing-file credential test in the owned networkless guest. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rm, stat } from "node:fs/promises";
import { runLinuxMediationBroker } from "../../apps/server/src/process/linuxMediationBroker";
import { secretGuardMediationPolicy } from "../../apps/server/src/process/secretGuard";

export async function measureOverlayActor(): Promise<void> {
  const root = "/tmp/octant-policy-broker";
  const owner = new AbortController();
  const maximum = setTimeout(() => owner.abort(), 15_000);
  let ended: Awaited<ReturnType<typeof runLinuxMediationBroker>> | undefined;
  let inspected = false;
  let unmounted = false;
  let cleaned = false;
  try {
    const setup = spawnSync("/overlayfs-fixture", ["mount-actor"], {
      stdio: "inherit",
      timeout: 4_000,
    });
    assert.equal(setup.status, 0);
    // Classify the real lower objects, so only the backing-file read under
    // OverlayFS's credential override can identify the protected inode.
    ended = await runLinuxMediationBroker({
      nativeExecutable: "/octant-mediation",
      command: "/overlayfs-actor-workload",
      args: [],
      policy: secretGuardMediationPolicy({
        platform: "linux",
        homeDirectory: `${root}/overlay/lower`,
        ownAccountPaths: [],
      }),
      signal: owner.signal,
    });
    const inspection = spawnSync("/overlayfs-fixture", ["inspect-actor-unmount"], {
      stdio: "inherit",
      timeout: 4_000,
    });
    inspected = inspection.status === 0;
    unmounted = inspected;
  } finally {
    clearTimeout(maximum);
    owner.abort();
    if (!unmounted) {
      unmounted =
        spawnSync("/overlayfs-fixture", ["unmount"], {
          stdio: "inherit",
          timeout: 4_000,
        }).status === 0;
    }
    // Never recurse into a mount whose retirement was not confirmed.
    if (unmounted) {
      await rm(root, { recursive: true, force: true });
      try {
        await stat(root);
      } catch (error) {
        cleaned =
          typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
      }
    }
  }
  const passed =
    ended?.status === "exited" && ended.code === 0 && inspected && unmounted && cleaned;
  console.log(
    JSON.stringify({
      status: passed ? "measured-overlayfs-actor" : "failed-overlayfs-actor",
      ended,
      inspected,
      unmounted,
      cleaned,
      controllerJitDefaults: true,
      controllerRuntime: "node",
      controllerVersion: process.versions.node,
      actualBubblewrapBuilder: false,
      productionReady: false,
    }),
  );
  process.exit(passed ? 0 : 1);
}
