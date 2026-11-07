import type { ManagedChildProcess } from "./serverProcess";
import type { NativeHelperStopOutcome } from "./nativeHelperShutdown";

interface ClosingResource {
  readonly close: () => Promise<void>;
}
interface ManagedLaunchTools extends ClosingResource {
  readonly terminateTrackedProcesses: () => void;
}

/** Fixed resources acquired by one desktop-owned host launch, never a borrowed host. */
export interface DesktopHostLaunchResources {
  readonly server?: ManagedChildProcess;
  readonly credentialBroker?: ClosingResource;
  readonly browserBroker?: ClosingResource;
  readonly computerService?: ClosingResource;
  readonly computerBroker?: ClosingResource;
  readonly simulatorHelpers?: {
    readonly dispose: () => Promise<NativeHelperStopOutcome>;
  };
  readonly simulatorBroker?: ClosingResource;
  readonly avdBroker?: ClosingResource;
  readonly managedTools?: ManagedLaunchTools;
}

export type DesktopHostCleanupStage =
  | "server"
  | "credentials"
  | "browser"
  | "computer"
  | "simulator"
  | "avd"
  | "managed-tools";
export type DesktopHostLaunchClose =
  | { readonly status: "closed" }
  | { readonly status: "failed"; readonly stages: ReadonlyArray<DesktopHostCleanupStage> };

/**
 * One launch retains its held handles through rollback, stop and failed cleanup.
 * Returned Computer and Simulator brokers take responsibility for their
 * service or helper wrapper; before that, this launch closes them directly.
 */
export function createDesktopHostLaunch(options: {
  readonly shutdownServer: (server: ManagedChildProcess) => Promise<void>;
}) {
  let resources: DesktopHostLaunchResources = {};
  let completion: Promise<DesktopHostLaunchClose> | undefined;
  let state: "acquiring" | "closing" | "closed" | "failed" = "acquiring";
  let forceRequested = false;
  let forcedServer: ManagedChildProcess | undefined;
  let forcedTools: ManagedLaunchTools | undefined;
  const forceHeld = (): void => {
    const child = resources.server;
    if (child !== undefined && child !== forcedServer) {
      forcedServer = child;
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      } catch {
        /* The application deadline still exits if a held child cannot be signalled. */
      }
    }
    const tools = resources.managedTools;
    if (tools !== undefined && tools !== forcedTools) {
      forcedTools = tools;
      try {
        tools.terminateTrackedProcesses();
      } catch {
        /* A helper failure cannot prevent the application deadline. */
      }
    }
  };
  return Object.freeze({
    acquired: (next: DesktopHostLaunchResources): void => {
      if (completion !== undefined)
        throw new Error("A closing host launch cannot acquire resources.");
      resources = { ...resources, ...next };
      // App.exit normally ends the process at the deadline. If a caller can
      // continue, keep a late acquisition owned and force it before refusing
      // startup; the startup catch then closes the remaining local resources.
      if (forceRequested) {
        forceHeld();
        throw new Error("Octant is closing.");
      }
    },
    get server() {
      return resources.server;
    },
    get managedTools() {
      return resources.managedTools;
    },
    get state() {
      return state;
    },
    close: (): Promise<DesktopHostLaunchClose> => {
      completion ??= (async () => {
        state = "closing";
        const failed: DesktopHostCleanupStage[] = [];
        const close = async (stage: DesktopHostCleanupStage, work: () => void | Promise<void>) => {
          try {
            await work();
          } catch {
            failed.push(stage);
          }
        };
        const server = resources.server;
        if (server !== undefined) await close("server", () => options.shutdownServer(server));
        await close("credentials", () => resources.credentialBroker?.close());
        await close("browser", () => resources.browserBroker?.close());
        await close("computer", () =>
          resources.computerBroker === undefined
            ? resources.computerService?.close()
            : resources.computerBroker.close(),
        );
        await close("simulator", async () => {
          if (resources.simulatorBroker !== undefined) await resources.simulatorBroker.close();
          else {
            const outcome = await resources.simulatorHelpers?.dispose();
            if (outcome?.status === "failed")
              throw new Error("Simulator helper exit was not confirmed.");
          }
        });
        await close("avd", () => resources.avdBroker?.close());
        await close("managed-tools", () => resources.managedTools?.close());
        if (failed.length > 0) {
          state = "failed";
          return { status: "failed", stages: failed };
        }
        state = "closed";
        return { status: "closed" };
      })();
      return completion;
    },
    /** The existing quit deadline calls this on the current owner, even during startup. */
    forceStop: (): void => {
      forceRequested = true;
      forceHeld();
    },
  });
}
export type DesktopHostLaunch = ReturnType<typeof createDesktopHostLaunch>;

/** Credential setup and synchronous spawn diagnostics never cross the desktop UI boundary. */
export async function startDesktopHostServer<
  TBroker extends ClosingResource,
  TServer extends ManagedChildProcess,
>(
  launch: DesktopHostLaunch,
  options: {
    readonly startBroker: () => Promise<TBroker | undefined>;
    readonly startServer: (broker: TBroker | undefined) => TServer;
  },
): Promise<{ readonly broker: TBroker | undefined; readonly server: TServer }> {
  try {
    const broker = await options.startBroker();
    if (broker !== undefined) launch.acquired({ credentialBroker: broker });
    const server = options.startServer(broker);
    launch.acquired({ server });
    return { broker, server };
  } catch {
    throw new Error("Octant could not start its managed server resources.");
  }
}
