import { spawnSync } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import { ProcessConfinementError } from "./seatbeltProfile";

/**
 * The capsule a Linux Plan turn's shell commands run in, nested inside the
 * runtime's own Bubblewrap capsule.
 *
 * On Linux the runtime and the shell it starts share one capsule, and that
 * capsule must give the runtime its network, its account folder and its
 * sign-in (`.credentials.json`, or an API key in its environment). macOS holds
 * a shell away from all three with rules judged by the program asking; one
 * Bubblewrap capsule cannot tell the programs apart. So each command gets a
 * capsule of its own, started from the runtime's: the system folders and the
 * Project's folders read-only, no network namespace but loopback, no home
 * folder and so no account folder or sign-in file, an environment cleared of
 * everything but the variables named here, the launch's private temporary
 * directory the only writable folder, all capabilities dropped and
 * Bubblewrap's no-new-privileges. Everything it binds comes from the outer
 * capsule's view, so whatever that capsule hides stays hidden.
 */

/** System folders a command reads programs and libraries from. */
const SYSTEM_FOLDERS = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/etc", "/opt"];

/**
 * The only variables a command starts with. The runtime's environment holds
 * its API key or sign-in token and the proxy that reaches its provider; none
 * of that is passed on. Git's variables keep it from reading the home
 * folder's configuration, which is not there.
 */
const COMMAND_ENVIRONMENT = {
  PATH: "/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin",
  LANG: "C.UTF-8",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
} as const;

export interface LinuxPlanShellCapsuleInput {
  readonly bwrapPath: string;
  /** The shell that runs the command string, inside the capsule. */
  readonly shell: string;
  /** The Project's folders, bound read-only at their own paths. */
  readonly readRoots: ReadonlyArray<string>;
  /** The launch's private temporary directory, the one writable folder. */
  readonly temporaryDirectory: string;
}

/**
 * The Bubblewrap arguments for one command, up to the `--chdir` the wrapper
 * adds at run time from the directory the runtime started it in.
 */
export function linuxPlanShellCapsuleArgs(
  input: LinuxPlanShellCapsuleInput,
): ReadonlyArray<string> {
  for (const path of [input.bwrapPath, input.shell, input.temporaryDirectory, ...input.readRoots]) {
    if (!isAbsolute(path)) {
      throw new ProcessConfinementError(
        "invalid-configuration",
        "The Plan shell capsule needs absolute paths.",
      );
    }
  }
  const args: string[] = [
    // A user, network, PID, IPC, UTS and cgroup namespace of its own: the
    // runtime's network and processes are out of reach.
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--cap-drop",
    "ALL",
    "--clearenv",
  ];
  for (const folder of SYSTEM_FOLDERS) {
    if (isDirectory(folder)) args.push("--ro-bind", folder, folder);
  }
  // The runtime's capsule leaves `/proc/sys` uncovered so this one can mount
  // its own `/proc` (`startsNestedCapsules`); this capsule covers it instead.
  args.push("--proc", "/proc", "--ro-bind", "/proc/sys", "/proc/sys");
  args.push("--dev", "/dev", "--tmpfs", "/tmp");
  for (const root of input.readRoots) {
    if (isDirectory(root)) args.push("--ro-bind", root, root);
  }
  args.push("--bind", input.temporaryDirectory, input.temporaryDirectory);
  for (const [name, value] of Object.entries(COMMAND_ENVIRONMENT)) {
    args.push("--setenv", name, value);
  }
  args.push(
    "--setenv",
    "HOME",
    input.temporaryDirectory,
    "--setenv",
    "TMPDIR",
    input.temporaryDirectory,
  );
  return args;
}

/**
 * Writes the program the runtime runs each command through
 * (`CLAUDE_CODE_SHELL_PREFIX`) into `directory`, which the outer capsule
 * binds read-only so neither the runtime nor a command can rewrite it.
 *
 * The runtime starts `<prefix> '<command string>'` from its own shell, so the
 * command string arrives as the one argument and runs only in the nested
 * capsule. A capsule that cannot be built fails the command: Bubblewrap exits
 * before it starts anything, and nothing runs in the runtime's capsule
 * instead.
 */
export function writeLinuxPlanShellPrefix(
  directory: string,
  input: LinuxPlanShellCapsuleInput,
): string {
  if (directory === input.temporaryDirectory || isInside(directory, input.temporaryDirectory)) {
    throw new ProcessConfinementError(
      "invalid-configuration",
      "The Plan shell capsule's program must sit outside the folder commands may write.",
    );
  }
  const args = linuxPlanShellCapsuleArgs(input);
  const script = [
    "#!/bin/sh",
    // Written by Octant for one Plan launch; the runtime passes the command
    // string as the only argument.
    `exec ${[input.bwrapPath, ...args].map(quote).join(" ")} --chdir "$PWD" -- ${quote(input.shell)} -c "$1"`,
    "",
  ].join("\n");
  const path = join(directory, "plan-shell");
  writeFileSync(path, script, { mode: 0o500 });
  return path;
}

let probed: boolean | undefined;

/**
 * Whether this host can start a capsule inside a capsule, read once per
 * server process. An unprivileged user namespace inside another is what the
 * nested capsule needs; a host that runs Octant as root cannot map its user
 * inside one (measured on bwrap 0.9.0: "setting up uid map: Operation not
 * permitted"), and a kernel with nested user namespaces off cannot either.
 * Where it fails, a Linux Plan turn is offered no shell at all.
 */
export function linuxPlanShellCapsuleAvailable(bwrapPath: string): boolean {
  if (probed !== undefined) return probed;
  if (!existsSync(bwrapPath)) {
    probed = false;
    return probed;
  }
  const inner = [
    bwrapPath,
    "--unshare-all",
    "--die-with-parent",
    "--cap-drop",
    "ALL",
    ...SYSTEM_FOLDERS.filter(isDirectory).flatMap((folder) => ["--ro-bind", folder, folder]),
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--",
    "/bin/true",
  ];
  const result = spawnSync(
    bwrapPath,
    [
      "--unshare-all",
      "--die-with-parent",
      "--cap-drop",
      "ALL",
      "--ro-bind",
      "/",
      "/",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--",
      ...inner,
    ],
    { stdio: "ignore", timeout: 5_000 },
  );
  probed = result.status === 0;
  return probed;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isInside(path: string, folder: string): boolean {
  return path.startsWith(`${folder}${sep}`);
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
