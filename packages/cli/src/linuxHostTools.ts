import { accessSync, constants } from "node:fs";
import { join } from "node:path";

/**
 * A program a Linux host needs and a stock install may lack. Neither blocks the
 * server from starting, so each missing one is reported and nothing is installed.
 */
export interface LinuxHostTool {
  readonly name: string;
  /** What stops working without it, in the words a user would recognise. */
  readonly consequence: string;
  /** Ubuntu and Debian package that provides it. */
  readonly package: string;
}

const LINUX_HOST_TOOLS: ReadonlyArray<LinuxHostTool & { readonly path?: string }> = [
  {
    name: "bwrap",
    // The server confines Work and Code only through this exact path.
    path: "/usr/bin/bwrap",
    package: "bubblewrap",
    consequence: "Work and Code terminals and shell commands will not start",
  },
  {
    name: "lsof",
    package: "lsof",
    consequence: "Running services cannot check this computer for local servers",
  },
];

/**
 * Where the managed service looks for programs. The systemd user unit sets no
 * PATH, so the service gets systemd's default rather than the PATH of the shell
 * that ran `octant`; a tool in `~/.local/bin` or an nvm directory is found by
 * the shell and missed by the service.
 */
const SERVICE_SEARCH_DIRECTORIES: ReadonlyArray<string> = [
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
];

export interface LinuxHostToolProbe {
  readonly platform?: NodeJS.Platform;
  readonly isExecutable?: (path: string) => boolean;
}

/** The tools this Linux host lacks. Any other platform lacks none. */
export function missingLinuxHostTools(
  probe: LinuxHostToolProbe = {},
): ReadonlyArray<LinuxHostTool> {
  if ((probe.platform ?? process.platform) !== "linux") return [];
  const isExecutable = probe.isExecutable ?? canExecute;
  return LINUX_HOST_TOOLS.filter((tool) => {
    const candidates =
      tool.path === undefined
        ? SERVICE_SEARCH_DIRECTORIES.map((directory) => join(directory, tool.name))
        : [tool.path];
    return !candidates.some(isExecutable);
  });
}

/** One notice naming every missing tool and the command that installs them, or `undefined`. */
export function formatMissingLinuxHostTools(
  missing: ReadonlyArray<LinuxHostTool>,
): string | undefined {
  if (missing.length === 0) return undefined;
  const lines = missing.map((tool) => `  ${tool.name}: ${tool.consequence}.`);
  const packages = missing.map((tool) => tool.package).join(" ");
  return [
    "This Linux host is missing:",
    ...lines,
    `Install them with: sudo apt-get install -y ${packages}`,
    "Octant does not install them for you.",
    "",
  ].join("\n");
}

function canExecute(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
