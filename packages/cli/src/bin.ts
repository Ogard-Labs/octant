#!/usr/bin/env bun
import { runStatusCommand } from "./status";
import { runWebCommand } from "./web";
import { resolveServerRunOptions, runServerRunCommand } from "./serverRun";
import { resolveHostRuntimePaths, ServicePolicyStore } from "@octant/host-runtime";
import { homedir, tmpdir } from "node:os";
import { runServerLifecycleCommand, type ServerLifecycleAction } from "./serverLifecycle";
import {
  createHostHeadlessUpgradePorts,
  resolveHeadlessArtifactCliCommand,
  runHeadlessArtifactCliCommand,
} from "./artifactCommand";
import { join } from "node:path";
import { openLocalControlSession, type OpenedLocalControlSession } from "./localControl";
import { resolveProjectCliCommand, runProjectCliCommand } from "./projectCommand";
import { resolveAgentCliCommand, runAgentCliCommand } from "./agentCommand";
import {
  resolveAuthCliCommand,
  resolvePairCliCommand,
  runRemoteAccessCliCommand,
  type RemoteAccessCliCommand,
} from "./remoteAccessCommand";

interface ParsedArgs {
  readonly command: string;
  readonly flags: Readonly<Record<string, string | boolean>>;
  readonly positional: readonly string[];
}

export function parseArgs(argv: readonly string[]): ParsedArgs | undefined {
  const [command, ...rest] = argv;
  if (command === undefined) return undefined;
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[name] = next;
        i += 1;
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { command, flags, positional };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args === undefined) {
    printUsage();
    return 1;
  }
  if (hasInvalidLifecyclePositionals(args.command, args.positional)) {
    printUsage();
    return 1;
  }
  if (args.command === "web") {
    const result = await runWebCommand({
      bridgeSecret: process.env.OCTANT_DESKTOP_BRIDGE_SECRET,
      hostname: typeof args.flags.hostname === "string" ? args.flags.hostname : undefined,
      port: typeof args.flags.port === "string" ? Number(args.flags.port) : undefined,
      noOpen: args.flags["no-open"] === true,
      dev: args.flags.dev === true,
      servicePolicyStore: new ServicePolicyStore({
        path: resolveCliHostRuntimePaths().servicePolicyPath,
      }),
    });
    return result.kind === "opened" || result.kind === "served" || result.kind === "dev" ? 0 : 1;
  }
  if (
    args.command === "server" &&
    isLifecycleAction(args.positional[0]) &&
    args.positional.length === 1 &&
    !(args.positional[0] === "status" && ("hostname" in args.flags || "port" in args.flags))
  ) {
    const action = args.positional[0];
    const logs = action === "logs" ? parseLogOptions(args.flags) : undefined;
    if (action === "logs" && logs === undefined) {
      printUsage();
      return 1;
    }
    if (action !== "logs" && Object.keys(args.flags).length > 0) {
      printUsage();
      return 1;
    }
    try {
      const paths = resolveCliHostRuntimePaths();
      const followAbortController = logs?.follow === true ? new AbortController() : undefined;
      const stopFollowing = () => followAbortController?.abort();
      if (followAbortController !== undefined) {
        process.once("SIGINT", stopFollowing);
        process.once("SIGTERM", stopFollowing);
      }
      let report;
      try {
        report = await runServerLifecycleCommand({
          action,
          paths,
          policyStore: new ServicePolicyStore({ path: paths.servicePolicyPath }),
          stdout: process.stdout,
          ...(logs === undefined ? {} : { logs }),
          ...(followAbortController === undefined ? {} : { signal: followAbortController.signal }),
        });
      } finally {
        if (followAbortController !== undefined) {
          process.removeListener("SIGINT", stopFollowing);
          process.removeListener("SIGTERM", stopFollowing);
        }
      }
      return action === "logs" ||
        report.state === "ready" ||
        report.state === "stopped" ||
        report.state === "disabled"
        ? 0
        : 1;
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }
  if (args.command === "server" && args.positional[0] === "status") {
    const report = await runStatusCommand({
      hostname: typeof args.flags.hostname === "string" ? args.flags.hostname : undefined,
      port: typeof args.flags.port === "string" ? Number(args.flags.port) : undefined,
    });
    return report.status === "ready" ? 0 : 1;
  }
  if (
    args.command === "server" &&
    (args.positional[0] === "install" ||
      args.positional[0] === "upgrade" ||
      args.positional[0] === "uninstall")
  ) {
    try {
      const paths = resolveCliHostRuntimePaths();
      const artifactCommand = resolveHeadlessArtifactCliCommand(args.positional, args.flags, {
        installRoot: process.env.OCTANT_INSTALL_ROOT ?? join(paths.stateDirectory, "install"),
        dataDirectory: paths.dataDirectory,
      });
      if (artifactCommand === undefined) {
        printUsage();
        return 1;
      }
      return await runHeadlessArtifactCliCommand({
        command: artifactCommand,
        runtime: {
          platform: process.platform,
          arch: process.arch,
          wireVersion: "1",
        },
        dataDirectory: paths.dataDirectory,
        ports: createHostHeadlessUpgradePorts(paths),
        stdout: process.stdout,
        stderr: process.stderr,
      });
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }
  if (args.command === "server" && args.positional[0] === "run") {
    const options = resolveServerRunOptions(args.flags, args.positional);
    if (options === undefined) {
      printUsage();
      return 1;
    }
    return await runServerRunCommand(options);
  }
  if (args.command === "agent" || args.command === "harness") {
    const command = resolveAgentCliCommand(args.command, args.positional, args.flags);
    if (command === undefined) {
      printUsage();
      return 1;
    }
    return await withLocalControlSession((session) =>
      runAgentCliCommand({
        command,
        session,
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
        interactive: process.stdout.isTTY === true && process.stdin.isTTY === true,
      }),
    );
  }
  if (args.command === "project") {
    const command = resolveProjectCliCommand(args.positional, args.flags);
    if (command === undefined) {
      printUsage();
      return 1;
    }
    return await withLocalControlSession((session) =>
      runProjectCliCommand({
        command,
        session,
        cwd: process.cwd(),
        stdout: process.stdout,
        stderr: process.stderr,
      }),
    );
  }
  if (args.command === "pair" || args.command === "auth") {
    const command: RemoteAccessCliCommand | undefined =
      args.command === "pair"
        ? resolvePairCliCommand(args.positional, args.flags)
        : resolveAuthCliCommand(args.positional, args.flags);
    if (command === undefined) {
      printUsage();
      return 1;
    }
    return await withLocalControlSession((session) =>
      runRemoteAccessCliCommand({
        command,
        session,
        stdout: process.stdout,
        stderr: process.stderr,
      }),
    );
  }
  if (args.command === "status") {
    const report = await runStatusCommand({
      hostname: typeof args.flags.hostname === "string" ? args.flags.hostname : undefined,
      port: typeof args.flags.port === "string" ? Number(args.flags.port) : undefined,
    });
    return report.status === "ready" ? 0 : 1;
  }
  printUsage();
  return 1;
}

async function withLocalControlSession(
  run: (session: OpenedLocalControlSession) => Promise<number>,
): Promise<number> {
  const session = await openLocalControlSession({
    host: { env: process.env, platform: process.platform, home: homedir() },
  });
  if (session.kind === "refuses") {
    process.stderr.write(`${session.reason}\n`);
    return 1;
  }
  try {
    return await run(session);
  } finally {
    await session.close();
  }
}

function resolveCliHostRuntimePaths() {
  return resolveHostRuntimePaths({
    env: process.env,
    platform: process.platform,
    home: homedir(),
    temporaryDirectory: tmpdir(),
    uid: process.getuid?.() ?? 0,
  });
}

function printUsage(): void {
  process.stdout.write(
    [
      "Octant CLI",
      "",
      "Usage:",
      "  octant web [--no-open] [--dev] [--hostname <host>] [--port <port>]",
      "  octant server status [--hostname <host>] [--port <port>]",
      "  octant server run [--port <port>]",
      "  octant server start|stop|restart|enable|disable",
      "  octant server logs [--since <ISO-8601>] [--limit <n>] [--follow]",
      "  octant server install --artifact <path> [--install-root <path>]",
      "  octant server upgrade --artifact <path> [--install-root <path>]",
      "  octant server uninstall [--install-root <path>] [--data-dir <path>] [--remove-data --confirm <exact-data-dir>]",
      "  octant agent [--mode auto|chat|work|code] [--project <name>] [--thread <id>] [--prompt <text>] [--title <title>] [--last] [--json] [--plain] [--quiet] [--theme system|light|dark|octant]",
      "  octant harness slots [--json]",
      "  octant harness session <thread-id> [--json]",
      "  octant project add <path> [--type work|code] [--name <name>]",
      "  octant project remove <name>",
      "  octant project rename <name> <new name>",
      "  octant pair [--source loopback|lan-private|tailscale]",
      "  octant auth list",
      "  octant auth revoke <device-id> | --all",
      "  octant status [--hostname <host>] [--port <port>]",
      "",
    ].join("\n"),
  );
  process.stdout.write("\n");
}

export function hasInvalidLifecyclePositionals(
  command: string,
  positional: readonly string[],
): boolean {
  return command === "server" && isLifecycleAction(positional[0]) && positional.length !== 1;
}

function isLifecycleAction(value: string | undefined): value is ServerLifecycleAction {
  return (
    value === "start" ||
    value === "stop" ||
    value === "restart" ||
    value === "status" ||
    value === "enable" ||
    value === "disable" ||
    value === "logs"
  );
}

function parseLogOptions(
  flags: Readonly<Record<string, string | boolean>>,
): { readonly since?: string; readonly limit?: number; readonly follow?: boolean } | undefined {
  for (const name of Object.keys(flags)) {
    if (name !== "since" && name !== "limit" && name !== "follow") return undefined;
  }
  if (flags.since !== undefined && typeof flags.since !== "string") return undefined;
  const rawLimit = flags.limit;
  if (rawLimit !== undefined && (typeof rawLimit !== "string" || !/^\d+$/.test(rawLimit))) {
    return undefined;
  }
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000)) {
    return undefined;
  }
  return {
    ...(typeof flags.since === "string" ? { since: flags.since } : {}),
    ...(limit === undefined ? {} : { limit }),
    ...(flags.follow === true ? { follow: true } : {}),
  };
}

if (import.meta.main) {
  const code = await main();
  if (code !== 0) process.exit(code);
}
