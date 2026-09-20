import { spawn } from "node:child_process";

/**
 * Starts a process that is not expected to exit, such as `emulator -avd`.
 * The caller waits on adb for readiness instead of this handle.
 */
export function spawnDetachedProcess(input: {
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
}): Promise<{ readonly kind: "spawned" } | { readonly kind: "unavailable"; readonly message: string }> {
  const command = input.argv[0];
  if (command === undefined) {
    return Promise.resolve({
      kind: "unavailable",
      message: "emulator is unavailable on this host.",
    });
  }
  try {
    const child = spawn(command, input.argv.slice(1), {
      cwd: input.cwd,
      // The emulator binary is absolute; qemu next to it still consults PATH
      // and HOME. Overlay the SDK variables onto the host environment rather
      // than replacing it, or the process cannot start.
      env: { ...process.env, ...input.environment },
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", () => undefined);
    if (child.pid === undefined) {
      return Promise.resolve({
        kind: "unavailable",
        message: "emulator is unavailable on this host.",
      });
    }
    child.unref();
    return Promise.resolve({ kind: "spawned" });
  } catch {
    return Promise.resolve({
      kind: "unavailable",
      message: "emulator is unavailable on this host.",
    });
  }
}
