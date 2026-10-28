#!/usr/bin/env bun
import { runStatusCommand } from "./status";
import { runWebCommand } from "./web";
import { resolveServerRunOptions, runServerRunCommand } from "./serverRun";
import { resolveHostRuntimePaths, ServicePolicyStore } from "@octant/host-runtime";
import { homedir, networkInterfaces, tmpdir, userInfo } from "node:os";
import { readDiskEncryption } from "./diskEncryption";
import { resolveHubCliCommand, runHubCliCommand, type HubCliCommand } from "./hubCommand";
import {
  createHubBootService,
  createUserServiceManager,
  nodeServiceCommandRunner,
  type HubBootService,
  type ServiceCommandRunner,
  type UserServiceManager,
} from "./serviceManager";
import { createInterface } from "node:readline/promises";
import { formatMissingLinuxHostTools, missingLinuxHostTools } from "./linuxHostTools";
import { runServerLifecycleCommand, type ServerLifecycleAction } from "./serverLifecycle";
import {
  createHostHeadlessUpgradePorts,
  resolveHeadlessArtifactCliCommand,
  runHeadlessArtifactCliCommand,
} from "./artifactCommand";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { openLocalControlSession, type OpenedLocalControlSession } from "./localControl";
import { resolveProjectCliCommand, runProjectCliCommand } from "./projectCommand";
import { resolveAgentCliCommand, runAgentCliCommand } from "./agentCommand";
import { runMcpCliCommand } from "./mcpCommand";
import {
  executorStartCommand,
  isExecutorStdioInvocation,
  runExecutorCommand,
} from "./executorCommand";
import { resolveSshTargetCliCommand, runSshTargetCliCommand } from "./sshTargetCommand";
import {
  readAllStdin,
  readHiddenLineFromTerminal,
  resolveProviderKeyCliCommand,
  runProviderKeyCliCommand,
} from "./providerKeyCommand";
import {
  resolveProviderSignInCliCommand,
  runProviderSignInCliCommand,
  type ProviderSignInCliCommand,
} from "./providerSignInCommand";
import {
  resolveAuthCliCommand,
  resolveListenerCliCommand,
  resolvePairCliCommand,
  resolveServerPairingFlags,
  runRemoteAccessCliCommand,
  runServerPairing,
  type ServerPairingOptions,
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
  if (args.command === "executor") {
    // Standard output is the SSH session's protocol from the first byte, so
    // a wrong invocation is reported on standard error only.
    if (!isExecutorStdioInvocation(process.argv.slice(3))) {
      process.stderr.write("Usage: octant executor --stdio\n");
      return 1;
    }
    return await runExecutorCommand(executorStartCommand(import.meta.url, process.execPath));
  }
  if (args.command === "mcp") {
    // Before anything that resolves a data directory or opens a host session:
    // this command's only inputs are the two grant variables.
    return await runMcpCliCommand(process.argv.slice(3), {
      environment: process.env,
      input: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
    });
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
    // `--pair` belongs to `start` alone; anywhere else it stays an unknown flag.
    const split = action === "start" ? resolveServerPairingFlags(args.flags) : { rest: args.flags };
    if (split === undefined) {
      printUsage();
      return 1;
    }
    const lifecycleFlags = split.rest;
    const logs = action === "logs" ? parseLogOptions(lifecycleFlags) : undefined;
    if (action === "logs" && logs === undefined) {
      printUsage();
      return 1;
    }
    if (action !== "logs" && Object.keys(lifecycleFlags).length > 0) {
      printUsage();
      return 1;
    }
    if (action === "start" || action === "restart" || action === "enable")
      warnAboutLinuxHostTools();
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
      const succeeded =
        action === "logs" ||
        report.state === "ready" ||
        report.state === "stopped" ||
        report.state === "disabled";
      if (!succeeded) return 1;
      return split.pairing === undefined ? 0 : await runPairFlow(split.pairing);
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
    // `--pair` is `install`'s alone; `upgrade` and `uninstall` keep it unknown.
    const split =
      args.positional[0] === "install"
        ? resolveServerPairingFlags(args.flags)
        : { rest: args.flags };
    if (split === undefined) {
      printUsage();
      return 1;
    }
    if (args.positional[0] !== "uninstall") warnAboutLinuxHostTools();
    try {
      const paths = resolveCliHostRuntimePaths();
      const artifactCommand = resolveHeadlessArtifactCliCommand(args.positional, split.rest, {
        installRoot: process.env.OCTANT_INSTALL_ROOT ?? join(paths.stateDirectory, "install"),
        dataDirectory: paths.dataDirectory,
      });
      if (artifactCommand === undefined) {
        printUsage();
        return 1;
      }
      const installed = await runHeadlessArtifactCliCommand({
        command: artifactCommand,
        runtime: {
          platform: process.platform,
          arch: process.arch,
          wireVersion: "1",
        },
        dataDirectory: paths.dataDirectory,
        stateDirectory: paths.stateDirectory,
        ports: createHostHeadlessUpgradePorts(paths),
        stdout: process.stdout,
        stderr: process.stderr,
      });
      if (installed !== 0 || split.pairing === undefined) return installed;
      // The service must run the installed copy, not the unpacked download this
      // process came from: the managed unit records the CLI that writes it.
      const started = await startInstalledHost(artifactCommand.installRoot);
      if (started !== 0) return started;
      return await runPairFlow(split.pairing);
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
    return await withLocalControlSession(
      (session) =>
        runAgentCliCommand({
          command,
          session,
          stdin: process.stdin,
          stdout: process.stdout,
          stderr: process.stderr,
          interactive: process.stdout.isTTY === true && process.stdin.isTTY === true,
        }),
      { startHost: true },
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
  if (args.command === "provider" && args.positional[0] === "sign-in") {
    const command = resolveProviderSignInCliCommand(args.positional, args.flags);
    if (command === undefined) {
      printUsage();
      return 1;
    }
    return await runProviderSignInFlow(command);
  }
  if (args.command === "provider") {
    const command = resolveProviderKeyCliCommand(args.positional, args.flags);
    if (command === undefined) {
      printUsage();
      return 1;
    }
    return await withLocalControlSession((session) =>
      runProviderKeyCliCommand({
        command,
        session,
        key: {
          interactive: process.stdin.isTTY === true,
          readHidden: (prompt) => readHiddenLineFromTerminal(process.stdin, process.stderr, prompt),
          readStdin: () => readAllStdin(process.stdin),
        },
        platform: process.platform,
        stdout: process.stdout,
        stderr: process.stderr,
      }),
    );
  }
  if (args.command === "ssh-target") {
    const command = resolveSshTargetCliCommand(args.positional, args.flags);
    if (command === undefined) {
      printUsage();
      return 1;
    }
    const prompt =
      process.stdin.isTTY === true
        ? createInterface({ input: process.stdin, output: process.stdout })
        : undefined;
    try {
      return await withLocalControlSession((session) =>
        runSshTargetCliCommand({
          command,
          session,
          stdout: process.stdout,
          stderr: process.stderr,
          ask: prompt === undefined ? undefined : (question) => prompt.question(question),
        }),
      );
    } finally {
      prompt?.close();
    }
  }
  if (args.command === "pair" || args.command === "auth" || args.command === "listener") {
    const command: RemoteAccessCliCommand | undefined =
      args.command === "pair"
        ? resolvePairCliCommand(args.positional, args.flags)
        : args.command === "listener"
          ? resolveListenerCliCommand(args.positional, args.flags)
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
  if (args.command === "hub") {
    const command = resolveHubCliCommand(args.positional, args.flags);
    if (command === undefined) {
      printUsage();
      return 1;
    }
    return await runHubFlow(command);
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

/** Missing host programs are told once, up front, and never installed or fatal. */
function warnAboutLinuxHostTools(): void {
  const notice = formatMissingLinuxHostTools(missingLinuxHostTools());
  if (notice !== undefined) process.stderr.write(notice);
}

function isNotRunning(reason: string): boolean {
  return reason.startsWith("Octant is not running");
}

/** Starts the host the way `octant server start` does; the message says why it could not. */
async function startHostForCommand(): Promise<string | undefined> {
  try {
    const paths = resolveCliHostRuntimePaths();
    const report = await runServerLifecycleCommand({
      action: "start",
      paths,
      policyStore: new ServicePolicyStore({ path: paths.servicePolicyPath }),
      stdout: { write: () => undefined },
    });
    return report.state === "ready" ? undefined : report.message;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function withLocalControlSession(
  run: (session: OpenedLocalControlSession) => Promise<number>,
  options: { readonly startHost?: boolean } = {},
): Promise<number> {
  const host = { env: process.env, platform: process.platform, home: homedir() };
  let session = await openLocalControlSession({ host });
  if (session.kind === "refuses" && options.startHost === true && isNotRunning(session.reason)) {
    // The same start `octant server start` performs, then a short wait for
    // the host to write its local control files.
    process.stderr.write("Octant is not running here; starting it…\n");
    const started = await startHostForCommand();
    if (started !== undefined) {
      process.stderr.write(`${started}\n`);
      return 1;
    }
    for (let attempt = 0; attempt < 40 && session.kind === "refuses"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      session = await openLocalControlSession({ host });
    }
  }
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

/** Runs `server start` from `<install-root>/current`, so the service records that copy. */
function startInstalledHost(installRoot: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(join(installRoot, "current", "bin", "octant"), ["server", "start"], {
      stdio: "inherit",
    });
    child.once("error", (error) => {
      process.stderr.write(`${error.message}\n`);
      resolve(1);
    });
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

/** The host half of `--pair`, once the service is running. */
async function runPairFlow(options: ServerPairingOptions): Promise<number> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  // Closing the input without an answer ends the question rather than hanging it.
  const closed = new Promise<undefined>((resolve) =>
    prompt.once("close", () => resolve(undefined)),
  );
  try {
    return await withLocalControlSession(
      (session) =>
        runServerPairing({
          options,
          session,
          stdout: process.stdout,
          stderr: process.stderr,
          networkInterfaces,
          ask: (question) => Promise.race([prompt.question(question), closed]),
        }),
      { startHost: true },
    );
  } finally {
    prompt.close();
  }
}

/** `octant hub`: questions need a terminal; the administrator step runs only when asked for. */
async function runHubFlow(command: HubCliCommand): Promise<number> {
  const paths = resolveCliHostRuntimePaths();
  const uid = process.getuid?.() ?? 0;
  const serviceOptions = { paths, uid };
  const prompt =
    process.stdin.isTTY === true
      ? createInterface({ input: process.stdin, output: process.stdout })
      : undefined;
  const closed =
    prompt === undefined
      ? undefined
      : new Promise<undefined>((resolve) => prompt.once("close", () => resolve(undefined)));
  try {
    let bootService: HubBootService | undefined;
    let loginService: UserServiceManager | undefined;
    if (process.platform === "darwin" || process.platform === "linux") {
      bootService = createHubBootService({ ...serviceOptions, userName: userInfo().username });
      loginService = createUserServiceManager(serviceOptions);
    }
    return await withLocalControlSession((session) =>
      runHubCliCommand({
        command,
        session,
        stdout: process.stdout,
        stderr: process.stderr,
        platform: process.platform,
        ...(bootService === undefined ? {} : { bootService }),
        loginService: {
          install: async () => await loginService?.install(),
          enable: async () => await loginService?.enable(),
        },
        administrator: administratorRunner,
        diskEncryption: () =>
          readDiskEncryption({
            platform: process.platform,
            dataDirectory: paths.dataDirectory,
            runner: nodeServiceCommandRunner,
          }),
        ...(prompt === undefined || closed === undefined
          ? {}
          : { ask: (question: string) => Promise.race([prompt.question(question), closed]) }),
      }),
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    prompt?.close();
  }
}

/** Runs an administrator command with the terminal attached, so the password prompt works. */
const administratorRunner: ServiceCommandRunner = {
  run: (command, args) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, [...args], { stdio: "inherit" });
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve({ stdout: "", stderr: "" }) : reject(new Error(`exit ${code}`)),
      );
    }),
};

/** `octant provider sign-in`: the terms question needs a terminal; the code does not. */
async function runProviderSignInFlow(command: ProviderSignInCliCommand): Promise<number> {
  const interactive = process.stdin.isTTY === true;
  const prompt = interactive
    ? createInterface({ input: process.stdin, output: process.stdout })
    : undefined;
  const closed =
    prompt === undefined
      ? undefined
      : new Promise<undefined>((resolve) => prompt.once("close", () => resolve(undefined)));
  try {
    return await withLocalControlSession((session) =>
      runProviderSignInCliCommand({
        command,
        session,
        ask:
          prompt === undefined || closed === undefined
            ? undefined
            : (question) => Promise.race([prompt.question(question), closed]),
        stdout: process.stdout,
        stderr: process.stderr,
      }),
    );
  } finally {
    prompt?.close();
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
      "  octant server start [--pair [--hostname <address>] [--port <port>] [--cert <path> --key <path>]]",
      "  octant server stop|restart|enable|disable",
      "  octant server logs [--since <ISO-8601>] [--limit <n>] [--follow]",
      "  octant server install --artifact <path> [--install-root <path>] [--pair [--hostname <address>] [--port <port>] [--cert <path> --key <path>]]",
      "  octant server upgrade --artifact <path> [--install-root <path>]",
      "  octant server uninstall [--install-root <path>] [--data-dir <path>] [--remove-data --confirm <exact-data-dir>]",
      "  octant agent [--mode auto|chat|work|code] [--project <name>] [--thread <id>] [--prompt <text>] [--title <title>] [--model <model or endpoint/model>] [--last] [--json] [--plain] [--quiet] [--theme system|light|dark|octant]",
      "  octant harness slots [--json]",
      "  octant harness session <thread-id> [--json]",
      "  octant harness agents <thread-id> [<n>|<id>] [--json]",
      "  octant project add <path> [--type work|code] [--name <name>]",
      "  octant project remove <name>",
      "  octant project rename <name> <new name>",
      "  octant project access <name> full-access|approval-gated",
      "  octant provider key set <instance> [--replace] [--stdin]",
      "  octant provider key status|remove <instance>",
      "  octant provider remove <instance>",
      "  octant provider sign-in <instance>",
      "  octant listener [status]",
      "  octant listener enable --hostname <lan-or-tailscale-address> --port <port> --cert <path> --key <path>",
      "  octant listener disable",
      "  octant hub status",
      "  octant hub enable [--install-service]",
      "  octant hub disable [--remove-service]",
      "  octant hub join-code [--owner]",
      "  octant hub join <code> [--items <roster,status,introduce,wake,owners,standby,push,provision,act|none>]",
      "  octant hub grant [--items <list>|none]",
      "  octant hub leave",
      "  octant hub remove <member-id-or-name>",
      "  octant ssh-target [list]",
      "  octant ssh-target add <destination> --executor <path-of-octant-on-target> [--fingerprint <SHA256:...>]",
      "  octant ssh-target repin <target-id> [--fingerprint <SHA256:...>]",
      "  octant ssh-target connect|remove <target-id>",
      "  octant ssh-target runtime <target-id> <provider-instance-id> <path-of-runtime-on-target>",
      "  octant ssh-target bind <target-id> <remote-root> --name <name>",
      "  octant ssh-target projects",
      "  octant ssh-target files <project-id> [directory]",
      "  octant ssh-target read <project-id> <path>",
      "  octant ssh-target status <project-id>",
      "  octant ssh-target diff <project-id> [path]",
      "  octant ssh-target worktrees",
      "  octant ssh-target worktree add <project-id> <name>",
      "  octant ssh-target worktree remove <worktree-id>",
      "  octant executor --stdio",
      "  octant pair [--source loopback|lan-private|tailscale]",
      "  octant pair requests",
      "  octant pair approve|deny <ticket-id>",
      "  octant auth list",
      "  octant auth revoke <device-id> | --all",
      "  octant status [--hostname <host>] [--port <port>]",
      "  octant mcp",
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
