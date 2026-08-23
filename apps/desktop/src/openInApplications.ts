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
  readonly systemPaths: ReadonlyArray<string>;
  readonly userApplicationName?: string;
}

const OPEN_IN_APPLICATIONS: ReadonlyArray<CatalogueEntry> = [
  {
    id: "vscode",
    label: "VS Code",
    systemPaths: ["/Applications/Visual Studio Code.app"],
    userApplicationName: "Visual Studio Code.app",
  },
  {
    id: "cursor",
    label: "Cursor",
    systemPaths: ["/Applications/Cursor.app"],
    userApplicationName: "Cursor.app",
  },
  {
    id: "zed",
    label: "Zed",
    systemPaths: ["/Applications/Zed.app", "/Applications/Zed Preview.app"],
    userApplicationName: "Zed.app",
  },
  {
    id: "finder",
    label: "Finder",
    systemPaths: ["/System/Library/CoreServices/Finder.app"],
  },
  {
    id: "terminal",
    label: "Terminal",
    systemPaths: ["/System/Applications/Utilities/Terminal.app"],
  },
  {
    id: "ghostty",
    label: "Ghostty",
    systemPaths: ["/Applications/Ghostty.app"],
    userApplicationName: "Ghostty.app",
  },
  {
    id: "xcode",
    label: "Xcode",
    systemPaths: ["/Applications/Xcode.app"],
    userApplicationName: "Xcode.app",
  },
];

export function detectOpenInApplications(options: {
  readonly exists: (path: string) => boolean;
  readonly homeDirectory: string;
}): ReadonlyArray<OpenInApplicationDescriptor> {
  return OPEN_IN_APPLICATIONS.map((entry) => ({
    id: entry.id,
    label: entry.label,
    available: resolveApplicationPath(entry, options) !== undefined,
  }));
}

export function launchOpenInApplication(options: {
  readonly applicationId: OpenInApplicationId;
  readonly checkoutRoot: string;
  readonly exists: (path: string) => boolean;
  readonly homeDirectory: string;
  readonly shell: { readonly showItemInFolder: (path: string) => void };
  readonly spawn: SpawnApplication;
}): void {
  const entry = OPEN_IN_APPLICATIONS.find((candidate) => candidate.id === options.applicationId);
  const applicationPath = entry === undefined ? undefined : resolveApplicationPath(entry, options);
  if (
    entry === undefined ||
    !isAbsolute(options.checkoutRoot) ||
    options.checkoutRoot.includes("\0") ||
    applicationPath === undefined
  ) {
    throw new Error("Octant could not open the selected application.");
  }
  if (entry.id === "finder") {
    options.shell.showItemInFolder(options.checkoutRoot);
    return;
  }
  try {
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
): string | undefined {
  const candidates = [
    ...entry.systemPaths,
    ...(entry.userApplicationName === undefined
      ? []
      : [join(options.homeDirectory, "Applications", entry.userApplicationName)]),
  ];
  return candidates.find((path) => options.exists(path));
}
