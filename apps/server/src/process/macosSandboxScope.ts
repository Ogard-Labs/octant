import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxPolicySelection } from "@octant/contracts/sandbox-policy";

export interface MacosSandboxScope {
  readonly executable: string;
  readonly directory: string;
  readonly epoch: string;
}

export function macosSandboxScopeExecutable(): string | undefined {
  const configured = process.env.OCTANT_SANDBOX_SCOPE_PATH;
  const candidates =
    configured === undefined
      ? [
          fileURLToPath(
            new URL("../../../desktop/dist/native/octant-sandbox-scope", import.meta.url),
          ),
          fileURLToPath(new URL("../../desktop/dist/native/octant-sandbox-scope", import.meta.url)),
        ]
      : [configured];
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    try {
      const canonical = realpathSync(candidate);
      const identity = statSync(canonical);
      if (!identity.isFile() || identity.nlink !== 1 || (identity.mode & 0o022) !== 0) continue;
      accessSync(canonical, constants.X_OK);
      return canonical;
    } catch {
      /* An unavailable installed runtime cannot admit a selected policy. */
    }
  }
  return undefined;
}

export function macosSandboxScopeAvailable(): boolean {
  if (process.platform !== "darwin") return false;
  const executable = macosSandboxScopeExecutable();
  return (
    executable !== undefined &&
    spawnSync(executable, ["--check"], { timeout: 3000, stdio: "ignore" }).status === 0
  );
}

export function prepareMacosSandboxScope(
  authorityDirectory: string,
  selection: SandboxPolicySelection,
): MacosSandboxScope {
  const executable = macosSandboxScopeExecutable();
  if (executable === undefined)
    throw new Error("The native sandbox scope executable is unavailable.");
  const directory = join(realpathSync(authorityDirectory), "sandbox-scopes");
  mkdirSync(directory, { mode: 0o700, recursive: true });
  const recovered = spawnSync(executable, ["--reap", directory, "--stale"], {
    encoding: "utf8",
    timeout: 10000,
    stdio: "ignore",
  });
  if (recovered.status !== 0)
    throw new Error("A previous native sandbox scope could not be revoked.");
  return {
    executable,
    directory,
    epoch: createHash("sha256").update(selection.context.sessionId).digest("hex"),
  };
}

export function macosSandboxScopeIdentity(
  authorityDirectory: string,
  selection: SandboxPolicySelection,
): MacosSandboxScope | undefined {
  const executable = macosSandboxScopeExecutable();
  if (executable === undefined) return undefined;
  return {
    executable,
    directory: join(realpathSync(authorityDirectory), "sandbox-scopes"),
    epoch: createHash("sha256").update(selection.context.sessionId).digest("hex"),
  };
}

export async function revokeMacosSandboxScope(
  scope: MacosSandboxScope,
  owner?: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const args =
      owner === undefined
        ? ["--reap", scope.directory, scope.epoch]
        : ["--reap-owner", scope.directory, scope.epoch, String(owner)];
    const child = spawn(scope.executable, args, { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Native sandbox scope revocation timed out."));
    }, 10000);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Native sandbox scope revocation could not start."));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else
        reject(new Error("Native sandbox scope cleanup is uncertain; admission remains blocked."));
    });
  });
}
