import type { UserServiceManager } from "@octant/cli/service-manager";
import type { BackgroundHostChange, BackgroundHostState } from "@octant/contracts/desktop-bridge";

/**
 * Settings → General → "Keep Octant running in the background" and "Open
 * Octant at login". Both are off until the person turns them on.
 *
 * The background host is the per-user LaunchAgent or systemd user unit the
 * `octant` command already manages, pointed at this app's own windowless host
 * (`--octant-host-only`): it starts the host at login and restarts it after an
 * unexpected exit, and a deliberate Quit stays quit. Open at login is the
 * operating system's login item for the app itself.
 *
 * Every answer is read back from the operating system after a change, so the
 * switches show what is installed rather than what was last asked for. Only
 * Octant's own desktop windows reach this through the main process; a paired
 * device or a Nightly client has no channel to it.
 */

export type { BackgroundHostChange, BackgroundHostState };

export interface LoginItem {
  readonly read: () => boolean;
  readonly write: (openAtLogin: boolean) => void;
}

export interface BackgroundHostSettings {
  readonly read: () => Promise<BackgroundHostState>;
  readonly change: (change: BackgroundHostChange) => Promise<BackgroundHostState>;
}

export function createBackgroundHostSettings(options: {
  /** Undefined where the app has no windowless host to install: development runs, Windows. */
  readonly service:
    | Pick<UserServiceManager, "install" | "uninstall" | "enable" | "status">
    | undefined;
  readonly loginItem: LoginItem | undefined;
}): BackgroundHostSettings {
  const { service, loginItem } = options;
  const read = async (
    failure?: "background-service" | "open-at-login",
  ): Promise<BackgroundHostState> => {
    if (service === undefined) return { status: "unsupported" };
    let backgroundService = false;
    try {
      backgroundService = (await service.status()).installed;
    } catch {
      // A manager that cannot answer has installed nothing this app can see.
      failure ??= "background-service";
    }
    return {
      status: "available",
      backgroundService,
      ...(loginItem === undefined ? {} : { openAtLogin: loginItem.read() }),
      ...(failure === undefined ? {} : { failure }),
    };
  };
  return {
    read: () => read(),
    change: async (change) => {
      if (service === undefined) return { status: "unsupported" };
      let failure: "background-service" | "open-at-login" | undefined;
      if (change.backgroundService !== undefined) {
        try {
          if (change.backgroundService) {
            await service.install();
            await service.enable();
          } else {
            await service.uninstall();
          }
        } catch {
          failure = "background-service";
        }
      }
      if (change.openAtLogin !== undefined) {
        try {
          if (loginItem === undefined) throw new Error("No login item on this system.");
          loginItem.write(change.openAtLogin);
        } catch {
          failure ??= "open-at-login";
        }
      }
      return await read(failure);
    },
  };
}

export function decodeBackgroundHostChange(value: unknown): BackgroundHostChange | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0 || keys.some((key) => key !== "backgroundService" && key !== "openAtLogin"))
    return undefined;
  if (record.backgroundService !== undefined && typeof record.backgroundService !== "boolean")
    return undefined;
  if (record.openAtLogin !== undefined && typeof record.openAtLogin !== "boolean") return undefined;
  return {
    ...(typeof record.backgroundService === "boolean"
      ? { backgroundService: record.backgroundService }
      : {}),
    ...(typeof record.openAtLogin === "boolean" ? { openAtLogin: record.openAtLogin } : {}),
  };
}

export function decodeBackgroundHostState(value: unknown): BackgroundHostState {
  if (typeof value !== "object" || value === null) throw new Error("Invalid background state.");
  const record = value as Record<string, unknown>;
  if (record.status === "unsupported") return Object.freeze({ status: "unsupported" });
  if (
    record.status !== "available" ||
    typeof record.backgroundService !== "boolean" ||
    (record.openAtLogin !== undefined && typeof record.openAtLogin !== "boolean") ||
    (record.failure !== undefined &&
      record.failure !== "background-service" &&
      record.failure !== "open-at-login")
  )
    throw new Error("Invalid background state.");
  return Object.freeze({
    status: "available",
    backgroundService: record.backgroundService,
    ...(typeof record.openAtLogin === "boolean" ? { openAtLogin: record.openAtLogin } : {}),
    ...(record.failure === "background-service" || record.failure === "open-at-login"
      ? { failure: record.failure }
      : {}),
  });
}
