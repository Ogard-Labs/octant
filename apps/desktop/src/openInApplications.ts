import type { SpawnOptions } from "node:child_process";
import { basename, delimiter, isAbsolute, join } from "node:path";
import type { OpenInApplicationId } from "@octant/contracts/shell";

export interface OpenInApplicationDescriptor {
  readonly id: OpenInApplicationId;
  readonly label: string;
  readonly available: boolean;
}

export interface OpenInApplicationRequest {
  readonly threadId: string;
  readonly applicationId: OpenInApplicationId;
}

interface SpawnedApplication {
  readonly unref?: () => void;
  readonly once?: (event: "error" | "spawn", listener: (error?: Error) => void) => void;
}

type SpawnApplication = (
  executable: string,
  arguments_: ReadonlyArray<string>,
  options: SpawnOptions,
) => SpawnedApplication;

interface CatalogueEntry {
  readonly id: OpenInApplicationId;
  readonly label: string;
  readonly darwinSystemPaths: ReadonlyArray<string>;
  readonly darwinUserApplicationName?: string;
  readonly linuxSystemPaths: ReadonlyArray<string>;
}

const OPEN_IN_APPLICATIONS: ReadonlyArray<CatalogueEntry> = [
  {
    id: "vscode",
    label: "VS Code",
    darwinSystemPaths: ["/Applications/Visual Studio Code.app"],
    darwinUserApplicationName: "Visual Studio Code.app",
    linuxSystemPaths: ["/usr/share/code/code", "/usr/bin/code", "/snap/bin/code"],
  },
  {
    id: "cursor",
    label: "Cursor",
    darwinSystemPaths: ["/Applications/Cursor.app"],
    darwinUserApplicationName: "Cursor.app",
    linuxSystemPaths: ["/usr/bin/cursor", "/usr/share/cursor/cursor", "/snap/bin/cursor"],
  },
  {
    id: "zed",
    label: "Zed",
    darwinSystemPaths: ["/Applications/Zed.app", "/Applications/Zed Preview.app"],
    darwinUserApplicationName: "Zed.app",
    linuxSystemPaths: ["/usr/bin/zed", "/usr/lib/zed/zed-editor"],
  },
  {
    id: "finder",
    label: "Finder",
    darwinSystemPaths: ["/System/Library/CoreServices/Finder.app"],
    linuxSystemPaths: [],
  },
  {
    id: "terminal",
    label: "Terminal",
    darwinSystemPaths: ["/System/Applications/Utilities/Terminal.app"],
    linuxSystemPaths: [
      "/usr/bin/x-terminal-emulator",
      "/usr/bin/gnome-terminal",
      "/usr/bin/konsole",
    ],
  },
  {
    id: "ghostty",
    label: "Ghostty",
    darwinSystemPaths: ["/Applications/Ghostty.app"],
    darwinUserApplicationName: "Ghostty.app",
    linuxSystemPaths: ["/usr/bin/ghostty"],
  },
  {
    id: "xcode",
    label: "Xcode",
    darwinSystemPaths: ["/Applications/Xcode.app"],
    darwinUserApplicationName: "Xcode.app",
    linuxSystemPaths: [],
  },
];

const OPEN_FAILURE = "Octant could not open the selected application.";

export function detectOpenInApplications(options: {
  readonly exists: (path: string) => boolean;
  readonly homeDirectory: string;
  readonly platform?: NodeJS.Platform;
  readonly pathEnv?: string;
}): ReadonlyArray<OpenInApplicationDescriptor> {
  const platform = options.platform ?? "darwin";
  return OPEN_IN_APPLICATIONS.map((entry) => ({
    id: entry.id,
    label: platform === "linux" && entry.id === "finder" ? "Files" : entry.label,
    available:
      platform === "linux" && entry.id === "finder"
        ? resolveExecutableOnPath("xdg-open", options.exists, options.pathEnv) !== undefined
        : resolveApplicationPath(entry, options, platform) !== undefined,
  }));
}

export async function launchOpenInApplication(options: {
  readonly applicationId: OpenInApplicationId;
  readonly checkoutRoot: string;
  readonly exists: (path: string) => boolean;
  readonly homeDirectory: string;
  readonly platform?: NodeJS.Platform;
  readonly pathEnv?: string;
  readonly shell: { readonly showItemInFolder: (path: string) => void };
  readonly spawn: SpawnApplication;
}): Promise<void> {
  const platform = options.platform ?? "darwin";
  const entry = OPEN_IN_APPLICATIONS.find((candidate) => candidate.id === options.applicationId);
  if (
    entry === undefined ||
    !isAbsolute(options.checkoutRoot) ||
    options.checkoutRoot.includes("\0")
  ) {
    throw new Error(OPEN_FAILURE);
  }
  if (entry.id === "finder") {
    if (platform === "linux") {
      const xdgOpen = resolveExecutableOnPath("xdg-open", options.exists, options.pathEnv);
      if (xdgOpen === undefined) throw new Error(OPEN_FAILURE);
      await spawnDetachedApplication(options.spawn, xdgOpen, [options.checkoutRoot]);
      return;
    }
    options.shell.showItemInFolder(options.checkoutRoot);
    return;
  }
  const applicationPath = resolveApplicationPath(entry, options, platform);
  if (applicationPath === undefined) {
    throw new Error(OPEN_FAILURE);
  }
  if (platform === "linux") {
    const launch = linuxApplicationLaunch(entry.id, applicationPath, options.checkoutRoot);
    await spawnDetachedApplication(options.spawn, applicationPath, launch.arguments_, launch.cwd);
    return;
  }
  await spawnDetachedApplication(options.spawn, "/usr/bin/open", [
    "-a",
    applicationPath,
    options.checkoutRoot,
  ]);
}

export async function openCodeCheckoutInApplicationFromServer(options: {
  readonly serverUrl: string;
  readonly desktopBridgeSecret: string;
  readonly windowId: string;
  readonly request: OpenInApplicationRequest;
  readonly fetch: typeof globalThis.fetch;
  readonly launch: (input: {
    readonly applicationId: OpenInApplicationId;
    readonly checkoutRoot: string;
  }) => void | Promise<void>;
}): Promise<void> {
  try {
    const response = await options.fetch(
      new URL("/api/desktop/code-checkout-open-target", options.serverUrl).toString(),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-desktop-secret": options.desktopBridgeSecret,
        },
        body: JSON.stringify({ windowId: options.windowId, threadId: options.request.threadId }),
      },
    );
    if (!response.ok) throw new Error("unavailable");
    const value: unknown = await response.json();
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      !("checkoutRoot" in value) ||
      typeof value.checkoutRoot !== "string" ||
      !isAbsolute(value.checkoutRoot) ||
      value.checkoutRoot.includes("\0")
    ) {
      throw new Error("invalid");
    }
    await options.launch({
      applicationId: options.request.applicationId,
      checkoutRoot: value.checkoutRoot,
    });
  } catch {
    throw new Error(OPEN_FAILURE);
  }
}

/**
 * Terminals treat a bare path as a command to run; editors take it as a folder.
 * Prefer each terminal's working-directory flag, and fall back to spawn cwd.
 */
function linuxApplicationLaunch(
  applicationId: OpenInApplicationId,
  applicationPath: string,
  checkoutRoot: string,
): { readonly arguments_: ReadonlyArray<string>; readonly cwd?: string } {
  if (applicationId === "ghostty") {
    return { arguments_: [`--working-directory=${checkoutRoot}`] };
  }
  if (applicationId === "terminal") {
    const binary = basename(applicationPath);
    if (binary === "gnome-terminal") {
      return { arguments_: [`--working-directory=${checkoutRoot}`] };
    }
    if (binary === "konsole") {
      return { arguments_: ["--workdir", checkoutRoot] };
    }
    return { arguments_: [], cwd: checkoutRoot };
  }
  return { arguments_: [checkoutRoot] };
}

async function spawnDetachedApplication(
  spawn: SpawnApplication,
  executable: string,
  arguments_: ReadonlyArray<string>,
  cwd?: string,
): Promise<void> {
  let child: SpawnedApplication;
  try {
    child = spawn(executable, arguments_, {
      detached: true,
      shell: false,
      stdio: "ignore",
      ...(cwd === undefined ? {} : { cwd }),
    });
  } catch {
    throw new Error(OPEN_FAILURE);
  }
  await awaitSpawnOutcome(child, OPEN_FAILURE);
}

/**
 * Wait for the child to finish spawning. Missing executables emit `error`
 * asynchronously (ENOENT); a bare try/catch around spawn never sees that.
 */
async function awaitSpawnOutcome(
  child: {
    readonly unref?: () => void;
    readonly once?: (event: "error" | "spawn", listener: (error?: Error) => void) => void;
  },
  failureMessage: string,
): Promise<void> {
  if (child.once === undefined) {
    child.unref?.();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const succeed = () => {
      if (settled) return;
      settled = true;
      child.unref?.();
      resolve();
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      reject(new Error(failureMessage));
    };
    child.once!("error", fail);
    child.once!("spawn", succeed);
  });
}

function resolveExecutableOnPath(
  command: string,
  exists: (path: string) => boolean,
  pathEnv: string | undefined = process.env.PATH,
): string | undefined {
  if (command.includes("\0") || command.includes("/") || command.includes("\\")) {
    return undefined;
  }
  for (const directory of (pathEnv ?? "").split(delimiter)) {
    if (directory === "") continue;
    const candidate = join(directory, command);
    if (isAbsolute(candidate) && exists(candidate)) return candidate;
  }
  return undefined;
}

function resolveApplicationPath(
  entry: CatalogueEntry,
  options: { readonly exists: (path: string) => boolean; readonly homeDirectory: string },
  platform: NodeJS.Platform,
): string | undefined {
  if (platform === "linux") {
    return entry.linuxSystemPaths.find((path) => options.exists(path));
  }
  const candidates = [
    ...entry.darwinSystemPaths,
    ...(entry.darwinUserApplicationName === undefined
      ? []
      : [join(options.homeDirectory, "Applications", entry.darwinUserApplicationName)]),
  ];
  return candidates.find((path) => options.exists(path));
}
