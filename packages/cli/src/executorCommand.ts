import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  installedArtifactExecutorCommand,
  resolveInstalledArtifactRoot,
  type ServerStartCommand,
} from "./installedArtifact";

/**
 * `octant executor --stdio`: what this host's SSH connection starts on a
 * target. Canonical: docs/design/remote-ssh-environments.md § Executor delivery
 * and identity.
 *
 * Standard output belongs to the protocol from the first byte, so this command
 * writes nothing there itself; it hands the session's standard streams to the
 * executor and exits with it.
 */

export function isExecutorStdioInvocation(argv: readonly string[]): boolean {
  return argv.length === 1 && argv[0] === "--stdio";
}

export function executorStartCommand(
  moduleUrl: string,
  runtimeExecutable: string,
): ServerStartCommand {
  const artifactRoot = resolveInstalledArtifactRoot(moduleUrl);
  if (artifactRoot !== undefined) {
    return installedArtifactExecutorCommand(artifactRoot, runtimeExecutable);
  }
  return {
    command: runtimeExecutable,
    args: [fileURLToPath(new URL("../../../apps/server/src/sshTarget/executorMain.ts", moduleUrl))],
  };
}

export function runExecutorCommand(command: ServerStartCommand): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command.command, [...command.args], {
      env: { ...process.env, ...command.env },
      stdio: "inherit",
    });
    child.once("error", (error) => {
      process.stderr.write(`${error.message}\n`);
      resolve(1);
    });
    child.once("exit", (code) => resolve(code ?? 1));
  });
}
