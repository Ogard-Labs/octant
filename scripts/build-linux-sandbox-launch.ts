import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function buildLinuxSandboxLaunch(): void {
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
}

if (import.meta.main) buildLinuxSandboxLaunch();
