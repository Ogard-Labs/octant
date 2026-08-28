import type { SpawnOptions } from "node:child_process";
import { isAbsolute, join } from "node:path";
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

export function detectOpenInApplications(options: {
  readonly exists: (path: string) => boolean;
  readonly homeDirectory: string;
  readonly platform?: NodeJS.Platform;
}): ReadonlyArray<OpenInApplicationDescriptor> {
  const platform = options.platform ?? "darwin";
  return OPEN_IN_APPLICATIONS.map((entry) => ({
    id: entry.id,
    label: platform === "linux" && entry.id === "finder" ? "Files" : entry.label,
    available:
      platform === "linux" && entry.id === "finder"
        ? true
        : resolveApplicationPath(entry, options, platform) !== undefined,
  }));
}

export function launchOpenInApplication(options: {
  readonly applicationId: OpenInApplicationId;
  readonly checkoutRoot: string;
  readonly exists: (path: string) => boolean;
  readonly homeDirectory: string;
  readonly platform?: NodeJS.Platform;
  readonly shell: { readonly showItemInFolder: (path: string) => void };
  readonly spawn: SpawnApplication;
}): void {
  const platform = options.platform ?? "darwin";
  const entry = OPEN_IN_APPLICATIONS.find((candidate) => candidate.id === options.applicationId);
  if (
    entry === undefined ||
    !isAbsolute(options.checkoutRoot) ||
    options.checkoutRoot.includes("\0")
  ) {
    throw new Error("Octant could not open the selected application.");
  }
  if (entry.id === "finder") {
    if (platform === "linux") {
      try {
        options
          .spawn("/usr/bin/xdg-open", [options.checkoutRoot], {
            detached: true,
            shell: false,
            stdio: "ignore",
          })
          .unref?.();
      } catch {
        throw new Error("Octant could not open the selected application.");
      }
      return;
    }
    options.shell.showItemInFolder(options.checkoutRoot);
    return;
  }
  const applicationPath = resolveApplicationPath(entry, options, platform);
  if (applicationPath === undefined) {
    throw new Error("Octant could not open the selected application.");
  }
  try {
    if (platform === "linux") {
      options
        .spawn(applicationPath, [options.checkoutRoot], {
          detached: true,
          shell: false,
          stdio: "ignore",
        })
        .unref?.();
      return;
    }
    options
      .spawn("/usr/bin/open", ["-a", applicationPath, options.checkoutRoot], {
        detached: true,
        shell: false,
        stdio: "ignore",
      })
      .unref?.();
  } catch {
    throw new Error("Octant could not open the selected application.");
  }
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
  }) => void;
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
    options.launch({
      applicationId: options.request.applicationId,
      checkoutRoot: value.checkoutRoot,
    });
  } catch {
    throw new Error("Octant could not open the selected application.");
  }
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
