import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");

/** The restriction segment prevents loader environment variables from running
 * workload code before the helper has entered the selected Seatbelt profile. */
export async function buildSandboxScope(
  source = resolve(repositoryRoot, "apps/desktop/native/sandbox-scope/OctantSandboxScope.c"),
  destination = resolve(repositoryRoot, "apps/desktop/dist/native/octant-sandbox-scope"),
  architecture: "arm64" | "x86_64" = "arm64",
): Promise<void> {
  if (process.platform !== "darwin") return;
  await mkdir(dirname(destination), { recursive: true });
  const child = spawn(
    "/usr/bin/xcrun",
    [
      "clang",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-arch",
      architecture,
      "-mmacosx-version-min=14.0",
      "-Wl,-sectcreate,__RESTRICT,__restrict,/dev/null",
      "-o",
      destination,
      source,
    ],
    { stdio: "inherit" },
  );
  const [exitCode] = await once(child, "exit");
  if (exitCode !== 0) throw new Error("Octant sandbox scope build failed.");
  await chmod(destination, 0o755);
}

if (import.meta.main) await buildSandboxScope();
