import { isAbsolute } from "node:path";

/**
 * Maximum lifetime of a Quick Look child process. `qlmanage -p` blocks until
 * the panel is dismissed; a bounded lifetime guarantees the child cannot
 * linger forever after the panel is closed another way or the window goes
 * away. The child is also killed immediately when the handoff is cancelled
 * (abort signal) or superseded by a new handoff for the same target.
 */
export const QUICK_LOOK_MAX_LIFETIME_MS = 5 * 60 * 1_000;

/**
 * The three authenticated external-application preview handoff kinds. The
 * renderer never sends a host path; every kind is resolved server-side from
 * the opaque target ref before the native executor touches the filesystem.
 */
export type PreviewHandoffKind = "reveal-in-finder" | "quick-look" | "open-external";

/**
 * Renderer request shape for a preview handoff over IPC. The main process
 * performs the authoritative contract decode; the sandboxed preload validates
 * the shape with its own runtime-free checker so no path can arrive through
 * this channel.
 */
export interface PreviewHandoffIpcRequest {
  readonly target: {
    readonly targetId: string;
    readonly projectId: string;
    readonly hostId: string;
    readonly kind: string;
    readonly opaqueRef: string;
    readonly displayName: string;
  };
  readonly kind: PreviewHandoffKind;
}

/**
 * Injectable native executor port. Tests substitute a mock so no real macOS
 * side effect (Finder, Quick Look, LaunchServices) ever runs in a
 * deterministic suite; the packaged native execution remains a named residual
 * for the V1 evidence packet.
 */
export interface PreviewHandoffExecutor {
  readonly revealInFinder: (path: string) => Promise<void>;
  readonly quickLook: (path: string, signal?: AbortSignal) => Promise<void>;
  readonly openExternal: (path: string) => Promise<void>;
}

interface SpawnedProcess {
  readonly on?: (event: "exit", listener: () => void) => void;
  readonly kill?: () => void;
}

type SpawnProcess = (command: string, args: readonly string[]) => SpawnedProcess;

/**
 * Resolve an opaque preview handoff through the desktop-authenticated server
 * bridge and execute the native affordance. The server re-authorizes the
 * target (mode/Project/thread/posture, plan-mode and remote fail closed) and
 * resolves the opaque ref to the confined export path; this function decodes
 * the bridge reply strictly (exact keys, absolute path, no NUL) and hands the
 * path to the injected executor. Every failure collapses to one sanitized
 * message so a host path or secret can never surface in the renderer.
 */
export async function openPreviewHandoffFromServer(options: {
  readonly serverUrl: string;
  readonly desktopBridgeSecret: string;
  readonly windowId: string;
  readonly request: PreviewHandoffIpcRequest;
  readonly fetch: typeof globalThis.fetch;
  readonly execute: PreviewHandoffExecutor;
  readonly signal?: AbortSignal;
}): Promise<void> {
  try {
    const response = await options.fetch(
      new URL("/api/desktop/preview-handoff", options.serverUrl).toString(),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-desktop-secret": options.desktopBridgeSecret,
        },
        body: JSON.stringify({ windowId: options.windowId, ...options.request }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    if (!response.ok) throw new Error("unavailable");
    const target = decodeHandoffTarget(await response.json());
    switch (target.handoffKind) {
      case "reveal-in-finder":
        await options.execute.revealInFinder(target.path);
        break;
      case "quick-look":
        await options.execute.quickLook(target.path, options.signal);
        break;
      case "open-external":
        await options.execute.openExternal(target.path);
        break;
    }
  } catch {
    throw new Error("Octant could not open the preview externally.");
  }
}

/**
 * Native executor for the packaged Electron app. `shell.showItemInFolder`
 * reveals in Finder, `qlmanage -p` opens Quick Look as an isolated child
 * process with a bounded lifetime, and `shell.openPath` opens the system
 * default application. No generic shell and no string interpolation reaches
 * a process boundary: the path is always one separate spawn argument.
 */
export function createNativePreviewHandoffExecutor(options: {
  readonly shell: {
    readonly showItemInFolder: (path: string) => void;
    readonly openPath: (path: string) => Promise<string>;
  };
  readonly spawn: SpawnProcess;
  readonly quickLookLifetimeMs?: number;
}): PreviewHandoffExecutor {
  const lifetimeMs = options.quickLookLifetimeMs ?? QUICK_LOOK_MAX_LIFETIME_MS;
  return {
    async revealInFinder(path) {
      options.shell.showItemInFolder(path);
    },
    async quickLook(path, signal) {
      await new Promise<void>((resolve) => {
        let child: SpawnedProcess | undefined;
        try {
          child = options.spawn("qlmanage", ["-p", path]);
        } catch {
          resolve();
          return;
        }
        const kill = () => {
          try {
            child?.kill?.();
          } catch {
            // The child already exited; nothing to kill.
          }
        };
        const timer = setTimeout(() => {
          kill();
          resolve();
        }, lifetimeMs);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            kill();
            resolve();
          },
          { once: true },
        );
        child.on?.("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
    async openExternal(path) {
      const error = await options.shell.openPath(path);
      if (error !== "") throw new Error("Octant could not open the preview externally.");
    },
  };
}

function decodeHandoffTarget(value: unknown): {
  readonly handoffKind: PreviewHandoffKind;
  readonly path: string;
} {
  if (!isRecord(value)) throw new Error("invalid");
  if (Object.keys(value).sort().join("\0") !== ["handoffKind", "path"].sort().join("\0")) {
    throw new Error("invalid");
  }
  const { handoffKind, path } = value;
  if (
    handoffKind !== "reveal-in-finder" &&
    handoffKind !== "quick-look" &&
    handoffKind !== "open-external"
  ) {
    throw new Error("invalid");
  }
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) {
    throw new Error("invalid");
  }
  return { handoffKind, path };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
