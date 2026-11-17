import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export function verifyRelocatableLinuxMediationBundles(root: string): void {
  if (process.platform !== "linux") return;
  const temporary = mkdtempSync(join(tmpdir(), "octant-mediation-bundles-"));
  try {
    for (const [name, expected] of [
      ["linuxMediationWorker.mjs", 0],
      ["linuxMediationSupervisor.mjs", 64],
    ] as const) {
      const relocated = join(temporary, name);
      copyFileSync(resolve(root, "apps/server/dist", name), relocated);
      const result = spawnSync(process.execPath, [relocated], {
        encoding: "utf8",
        timeout: 5_000,
      });
      if (result.status !== expected)
        throw new Error(
          `${name} is not a standalone relocatable runtime (status ${String(result.status)}, signal ${String(result.signal)}): ${result.stderr}`,
        );
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function buildLinuxSandboxLaunch(options: {
  readonly verifyRelocatableBundles: boolean;
}): void {
  if (process.platform !== "linux") return;
  const root = resolve(import.meta.dirname, "..");
  const destination = resolve(root, "apps/server/dist/native/octant-sandbox-launch");
  mkdirSync(dirname(destination), { recursive: true });
  execFileSync(
    "cc",
    [
      "-static",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-o",
      destination,
      resolve(root, "apps/server/native/sandbox-launch/OctantSandboxLaunch.c"),
    ],
    { stdio: "inherit" },
  );
  chmodSync(destination, 0o755);
  const mediation = resolve(root, "apps/server/dist/native/octant-mediation");
  execFileSync(
    "cc",
    [
      "-static",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-o",
      mediation,
      resolve(root, "apps/server/native/linux-mediation/broker.c"),
    ],
    { stdio: "inherit" },
  );
  chmodSync(mediation, 0o755);
  if (options.verifyRelocatableBundles) verifyRelocatableLinuxMediationBundles(root);
}

if (import.meta.main)
  buildLinuxSandboxLaunch({
    verifyRelocatableBundles: process.argv.includes("--verify-relocatable-bundles"),
  });
