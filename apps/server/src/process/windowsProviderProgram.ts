import { existsSync, readFileSync } from "node:fs";
import { win32 } from "node:path";

import {
  ProcessConfinementError,
  type ConfinedProcessLaunch,
  type ProcessConfinementPort,
} from "./seatbeltProfile";

/**
 * How a provider program a person configured starts on Windows, with no shell.
 *
 * npm installs a CLI on Windows as a `.cmd` shim (beside a POSIX `sh` script
 * and a `.ps1`), and Windows starts a `.cmd` only through `cmd.exe`, which
 * Octant never uses for a provider: the shim's `%*` hands the arguments to the
 * command interpreter, which would re-read them. So the shim is read instead
 * of run. Its last quoted `%dp0%` path is the program it starts: a `.exe` is
 * started directly, and a `.js` script is started with the `node.exe` beside
 * the shim, else the first on `Path`, which is what the shim itself does. A
 * shim Octant cannot read a program from is refused with the reason, naming
 * the `.exe` to point Settings at.
 */
export type WindowsProviderProgram =
  | { readonly status: "resolved"; readonly command: string; readonly args: ReadonlyArray<string> }
  | { readonly status: "refused"; readonly message: string };

export interface WindowsProviderProgramFiles {
  readonly exists: (path: string) => boolean;
  readonly read: (path: string) => string;
}

const LIVE_FILES: WindowsProviderProgramFiles = {
  exists: existsSync,
  read: (path) => readFileSync(path, "utf8"),
};

/** The shim's own folder, spelled `%dp0%` by npm's cmd-shim and `%~dp0` by others. */
const SHIM_TARGET_PATTERN = /"%~?dp0%?\\?([^"%]+)"/g;
const SCRIPT_EXTENSIONS = new Set([".js", ".cjs", ".mjs"]);
const PROGRAM_EXTENSIONS = new Set([".exe", ".com"]);
const SHIM_EXTENSIONS = new Set([".cmd", ".bat"]);

export function resolveWindowsProviderProgram(input: {
  readonly displayName: string;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly environment: NodeJS.ProcessEnv;
  /** Where the program the person would point Settings at sits, for the refusal. */
  readonly programHint?: string;
  readonly files?: WindowsProviderProgramFiles;
}): WindowsProviderProgram {
  const files = input.files ?? LIVE_FILES;
  const extension = win32.extname(input.executable).toLowerCase();
  if (SCRIPT_EXTENSIONS.has(extension)) {
    return withNode(input, files, input.executable, win32.dirname(input.executable));
  }
  const shim = SHIM_EXTENSIONS.has(extension)
    ? input.executable
    : // npm's extensionless `sh` script and its `.ps1` sit beside the `.cmd`;
      // pointing Settings at either means the shim.
      PROGRAM_EXTENSIONS.has(extension)
      ? undefined
      : siblingShim(input.executable, files);
  if (shim === undefined) {
    return { status: "resolved", command: input.executable, args: input.args };
  }
  let text: string;
  try {
    text = files.read(shim);
  } catch {
    return refused(input, shim, "could not be read");
  }
  const targets = [...text.matchAll(SHIM_TARGET_PATTERN)]
    .map((match) => match[1])
    .filter((target): target is string => target !== undefined)
    .filter((target) => win32.basename(target).toLowerCase() !== "node.exe");
  const target = targets.at(-1);
  if (target === undefined) return refused(input, shim, "names no program Octant can start");
  const program = win32.resolve(win32.dirname(shim), target);
  const targetExtension = win32.extname(program).toLowerCase();
  if (!files.exists(program)) return refused(input, shim, "names a program that is missing");
  if (PROGRAM_EXTENSIONS.has(targetExtension)) {
    return { status: "resolved", command: program, args: input.args };
  }
  if (SCRIPT_EXTENSIONS.has(targetExtension)) {
    return withNode(input, files, program, win32.dirname(shim), shim);
  }
  return refused(input, shim, "starts a program Octant cannot start without a shell");
}

/**
 * The confinement port a provider launch takes on Windows when it runs with no
 * Octant sandbox: the launch as asked, with an npm shim resolved to the
 * program it starts. A shim that cannot be resolved refuses the launch.
 */
export function windowsUnconfinedLaunch(input: {
  readonly displayName: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly programHint?: string;
  readonly files?: WindowsProviderProgramFiles;
}): ProcessConfinementPort {
  return {
    prepare: ({ executable, args }): ConfinedProcessLaunch => {
      const program = resolveWindowsProviderProgram({
        displayName: input.displayName,
        executable,
        args,
        environment: input.environment ?? process.env,
        ...(input.programHint === undefined ? {} : { programHint: input.programHint }),
        ...(input.files === undefined ? {} : { files: input.files }),
      });
      if (program.status === "refused") {
        throw new ProcessConfinementError("invalid-configuration", program.message);
      }
      return { command: program.command, args: program.args };
    },
  };
}

function siblingShim(executable: string, files: WindowsProviderProgramFiles): string | undefined {
  const extension = win32.extname(executable);
  const stem =
    extension.toLowerCase() === ".ps1" ? executable.slice(0, -extension.length) : executable;
  const candidate = `${stem}.cmd`;
  return files.exists(candidate) ? candidate : undefined;
}

function withNode(
  input: Parameters<typeof resolveWindowsProviderProgram>[0],
  files: WindowsProviderProgramFiles,
  script: string,
  shimFolder: string,
  shim?: string,
): WindowsProviderProgram {
  const beside = win32.join(shimFolder, "node.exe");
  const node = files.exists(beside) ? beside : nodeOnPath(input.environment, files);
  if (node === undefined) {
    const named = shim ?? script;
    return {
      status: "refused",
      message: `${input.displayName} is installed as an npm program (${win32.basename(named)}) whose script needs node.exe, which is not on Path. Install Node, or point Settings at ${pointAt(input)}.`,
    };
  }
  return { status: "resolved", command: node, args: [script, ...input.args] };
}

function nodeOnPath(
  environment: NodeJS.ProcessEnv,
  files: WindowsProviderProgramFiles,
): string | undefined {
  const path = Object.entries(environment).find(([name]) => name.toUpperCase() === "PATH")?.[1];
  for (const folder of (path ?? "").split(";")) {
    if (folder.trim() === "" || !win32.isAbsolute(folder)) continue;
    const candidate = win32.join(folder, "node.exe");
    if (files.exists(candidate)) return candidate;
  }
  return undefined;
}

function refused(
  input: Parameters<typeof resolveWindowsProviderProgram>[0],
  shim: string,
  why: string,
): WindowsProviderProgram {
  return {
    status: "refused",
    message: `${input.displayName}'s command shim (${win32.basename(shim)}) ${why}, and Windows runs a shim only through a shell, which Octant does not use for a provider. Point Settings at ${pointAt(input)}.`,
  };
}

function pointAt(input: Parameters<typeof resolveWindowsProviderProgram>[0]): string {
  return input.programHint ?? `the ${input.displayName} .exe instead`;
}
