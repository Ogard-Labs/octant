import type { AppUpdateState } from "@octant/contracts/app-updates";
import {
  decodeDesktopHostUpdatePending,
  type DesktopHostUpdatePending,
  type DesktopHostUpdateReport,
  type HostUpdateFailureReason,
} from "@octant/contracts/host-update";
import type { UpdateWorkInFlight } from "@octant/domain";
import { probeLocalHost, type LocalHostProbe } from "./localHostProbe";

export const DESKTOP_HOST_UPDATE_ROUTE = "/api/desktop/host-update";
export const DESKTOP_REMOTE_UPDATE_POLL_MS = 2_000;
const REQUEST_TIMEOUT_MS = 5_000;

export interface DesktopRemoteUpdateHostSnapshot {
  readonly state: "stopped" | "starting" | "running" | "attention-required";
  readonly url?: string;
  readonly instanceId?: string;
}

export interface DesktopAppUpdaterPort {
  readonly state: () => AppUpdateState;
  readonly check: () => Promise<AppUpdateState>;
  readonly download: () => Promise<AppUpdateState>;
  readonly install: (work: UpdateWorkInFlight) => Promise<
    | { readonly kind: "installing" }
    | {
        readonly kind: "wait";
        readonly activeAgentCount: number;
        readonly activityUnconfirmed: boolean;
      }
    | { readonly kind: "not-ready" }
  >;
}

export interface DesktopRemoteUpdateControllerOptions {
  readonly readPending: () => Promise<DesktopHostUpdatePending | undefined>;
  readonly reportUpdate: (report: DesktopHostUpdateReport) => Promise<void>;
  readonly updater: DesktopAppUpdaterPort;
  readonly readWorkInFlight: () => Promise<UpdateWorkInFlight>;
  readonly pollIntervalMs?: number;
}

function mapAppRefusalReason(refusal: string | undefined): HostUpdateFailureReason {
  switch (refusal) {
    case "untrusted-signature":
      return "untrusted-signature";
    case "corrupt-artifact":
      return "digest-mismatch";
    case "unsupported-install":
      return "unsupported-install";
    case "not-writable":
      return "not-writable";
    case "unreachable":
      return "unreachable";
    default:
      return "install-failed";
  }
}

/**
 * Verifies `/health` matches the expected `instanceId` before transmitting
 * `x-octant-desktop-secret`, mirroring `readDesktopAgentWork`.
 */
export async function fetchDesktopHostUpdateBridge(options: {
  readonly host: DesktopRemoteUpdateHostSnapshot;
  readonly brokerHeaders: () => Readonly<Record<string, string>>;
  readonly fetch: typeof globalThis.fetch;
  readonly method: "GET" | "POST";
  readonly body?: DesktopHostUpdateReport;
  readonly probeHost?: (input: {
    readonly url: string;
    readonly fetch: typeof globalThis.fetch;
  }) => Promise<LocalHostProbe | undefined>;
  readonly onHostLost?: () => void;
}): Promise<Response | undefined> {
  const { host } = options;
  if (
    host.state === "stopped" ||
    host.state === "starting" ||
    host.url === undefined ||
    host.instanceId === undefined
  ) {
    options.onHostLost?.();
    return undefined;
  }
  const probe = await (options.probeHost ?? probeLocalHost)({
    url: host.url,
    fetch: options.fetch,
  });
  if (probe === undefined || probe.instanceId !== host.instanceId) {
    options.onHostLost?.();
    return undefined;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await options.fetch(new URL(DESKTOP_HOST_UPDATE_ROUTE, probe.url), {
      method: options.method,
      headers: {
        ...options.brokerHeaders(),
        ...(options.method === "POST" ? { "content-type": "application/json" } : {}),
      },
      ...(options.method === "POST" ? { body: JSON.stringify(options.body) } : {}),
      signal: controller.signal,
    });
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export async function readDesktopHostUpdatePending(options: {
  readonly host: DesktopRemoteUpdateHostSnapshot;
  readonly brokerHeaders: () => Readonly<Record<string, string>>;
  readonly fetch: typeof globalThis.fetch;
  readonly probeHost?: (input: {
    readonly url: string;
    readonly fetch: typeof globalThis.fetch;
  }) => Promise<LocalHostProbe | undefined>;
  readonly onHostLost?: () => void;
}): Promise<DesktopHostUpdatePending | undefined> {
  const response = await fetchDesktopHostUpdateBridge({ ...options, method: "GET" });
  if (response === undefined || !response.ok) return undefined;
  try {
    return decodeDesktopHostUpdatePending(await response.json());
  } catch {
    return undefined;
  }
}

export async function postDesktopHostUpdateReport(options: {
  readonly host: DesktopRemoteUpdateHostSnapshot;
  readonly brokerHeaders: () => Readonly<Record<string, string>>;
  readonly fetch: typeof globalThis.fetch;
  readonly report: DesktopHostUpdateReport;
  readonly probeHost?: (input: {
    readonly url: string;
    readonly fetch: typeof globalThis.fetch;
  }) => Promise<LocalHostProbe | undefined>;
  readonly onHostLost?: () => void;
}): Promise<void> {
  await fetchDesktopHostUpdateBridge({
    host: options.host,
    brokerHeaders: options.brokerHeaders,
    fetch: options.fetch,
    method: "POST",
    body: options.report,
    ...(options.probeHost === undefined ? {} : { probeHost: options.probeHost }),
    ...(options.onHostLost === undefined ? {} : { onHostLost: options.onHostLost }),
  });
}

/**
 * Picks up server-recorded remote desktop update requests from loopback
 * `/api/desktop/host-update` and executes them through the single signed
 * `appUpdateService`, preserving `resolveUpdateInstallReadiness` so active work
 * always holds restart until drained/safe.
 */
export class DesktopRemoteUpdateController {
  readonly #options: DesktopRemoteUpdateControllerOptions;
  readonly #pollIntervalMs: number;
  #pollTimer: ReturnType<typeof setInterval> | undefined;
  #inFlight: Promise<void> | undefined;
  #disposed = false;
  /** Tracks requests whose `download()` has already been initiated to avoid double downloads. */
  #downloadStartedForRequestId: string | undefined;

  constructor(options: DesktopRemoteUpdateControllerOptions) {
    this.#options = options;
    this.#pollIntervalMs = options.pollIntervalMs ?? DESKTOP_REMOTE_UPDATE_POLL_MS;
  }

  start(): void {
    if (this.#disposed || this.#pollTimer !== undefined) return;
    this.#pollTimer = setInterval(() => {
      if (this.#inFlight === undefined) void this.pollNow();
    }, this.#pollIntervalMs);
    this.#pollTimer.unref?.();
    void this.pollNow();
  }

  pollNow(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    if (this.#inFlight !== undefined) return this.#inFlight;
    const run = this.#tick().finally(() => {
      if (this.#inFlight === run) this.#inFlight = undefined;
    });
    this.#inFlight = run;
    return run;
  }

  hostStopped(): void {
    this.#downloadStartedForRequestId = undefined;
  }

  dispose(): void {
    this.#disposed = true;
    this.#downloadStartedForRequestId = undefined;
    if (this.#pollTimer !== undefined) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = undefined;
    }
  }

  async #tick(): Promise<void> {
    const response = await this.#options.readPending().catch(() => undefined);
    const pending = response?.pending ?? null;
    if (pending === null || this.#disposed) return;

    const currentVersion = String(this.#options.updater.state().currentVersion);
    if (pending.expectedCurrentVersion !== currentVersion) {
      await this.#options.reportUpdate({
        requestId: pending.requestId,
        state: "refused",
        fromVersion: currentVersion,
        ring: this.#options.updater.state().ring,
        step: "prepare",
        failureReason: "version-mismatch",
        message: `This desktop app runs Octant ${currentVersion}, not ${pending.expectedCurrentVersion}.`,
      });
      return;
    }

    if (pending.action === "prepare") {
      const checked = await this.#options.updater.check();
      if (this.#disposed) return;
      await this.#reportCheckedState(pending.requestId, checked);
      return;
    }

    // action === "start": ensure signed check & download, then respect resolveUpdateInstallReadiness.
    const requestKey = String(pending.requestId);
    let state = this.#options.updater.state();
    if (state.status === "idle" || state.status === "up-to-date" || state.status === "failed") {
      state = await this.#options.updater.check();
      if (this.#disposed) return;
    }
    if (state.status === "up-to-date" || state.status === "idle") {
      await this.#options.reportUpdate({
        requestId: pending.requestId,
        state: "up-to-date",
        fromVersion: String(state.currentVersion),
        ring: state.ring,
        step: "prepare",
        message: state.message ?? "This desktop app is already up to date.",
      });
      return;
    }
    if (state.status === "refused" || state.status === "failed") {
      await this.#options.reportUpdate({
        requestId: pending.requestId,
        state: state.status,
        fromVersion: String(state.currentVersion),
        ring: state.ring,
        step: "verify",
        failureReason: mapAppRefusalReason(state.refusal),
        message: state.message ?? "This desktop app could not verify an update.",
      });
      return;
    }

    if (state.status === "available") {
      if (this.#downloadStartedForRequestId !== requestKey) {
        this.#downloadStartedForRequestId = requestKey;
        state = await this.#options.updater.download();
        if (this.#disposed) return;
      }
    }

    if (state.status === "downloading" || state.status === "checking") {
      await this.#options.reportUpdate({
        requestId: pending.requestId,
        state: "running",
        fromVersion: String(state.currentVersion),
        ...(state.available === undefined ? {} : { toVersion: String(state.available.version) }),
        ring: state.ring,
        step: "download",
      });
      return;
    }

    if (state.status === "refused" || state.status === "failed") {
      this.#downloadStartedForRequestId = undefined;
      await this.#options.reportUpdate({
        requestId: pending.requestId,
        state: state.status,
        fromVersion: String(state.currentVersion),
        ...(state.available === undefined ? {} : { toVersion: String(state.available.version) }),
        ring: state.ring,
        step: "download",
        failureReason: mapAppRefusalReason(state.refusal),
        message: state.message ?? "The desktop app update could not be downloaded.",
      });
      return;
    }

    if (state.status !== "ready") return;

    const work = await this.#options.readWorkInFlight();
    if (this.#disposed) return;
    const outcome = await this.#options.updater.install(work);
    const after = this.#options.updater.state();
    const toVersion =
      after.available === undefined
        ? state.available === undefined
          ? undefined
          : String(state.available.version)
        : String(after.available.version);

    if (outcome.kind === "wait") {
      await this.#options.reportUpdate({
        requestId: pending.requestId,
        state: "waiting-for-work",
        fromVersion: String(after.currentVersion),
        ...(toVersion === undefined ? {} : { toVersion }),
        ring: after.ring,
        step: "install",
        activeAgentCount: outcome.activeAgentCount,
        activityUnconfirmed: outcome.activityUnconfirmed,
        message:
          outcome.activeAgentCount > 0
            ? `Waiting for ${outcome.activeAgentCount} running ${outcome.activeAgentCount === 1 ? "agent" : "agents"} before relaunching.`
            : "Waiting to confirm running work before relaunching.",
      });
      return;
    }

    this.#downloadStartedForRequestId = undefined;
    if (outcome.kind === "installing") {
      await this.#options.reportUpdate({
        requestId: pending.requestId,
        state: "installing",
        fromVersion: String(after.currentVersion),
        ...(toVersion === undefined ? {} : { toVersion }),
        ring: after.ring,
        step: "install",
        message:
          toVersion === undefined
            ? "Relaunching desktop app to finish updating…"
            : `Relaunching desktop app to Octant ${toVersion}…`,
      });
      return;
    }

    await this.#options.reportUpdate({
      requestId: pending.requestId,
      state: after.status === "refused" ? "refused" : "failed",
      fromVersion: String(after.currentVersion),
      ...(toVersion === undefined ? {} : { toVersion }),
      ring: after.ring,
      step: "install",
      failureReason: mapAppRefusalReason(after.refusal),
      message: after.message ?? "The desktop app update could not be installed.",
    });
  }

  async #reportCheckedState(
    requestId: DesktopHostUpdateReport["requestId"],
    checked: AppUpdateState,
  ): Promise<void> {
    if (checked.status === "available" || checked.status === "ready") {
      await this.#options.reportUpdate({
        requestId,
        state: "update-available",
        fromVersion: String(checked.currentVersion),
        ...(checked.available === undefined
          ? {}
          : { toVersion: String(checked.available.version) }),
        ring: checked.ring,
        step: "prepare",
      });
      return;
    }
    if (checked.status === "up-to-date" || checked.status === "idle") {
      await this.#options.reportUpdate({
        requestId,
        state: "up-to-date",
        fromVersion: String(checked.currentVersion),
        ring: checked.ring,
        step: "prepare",
        message: checked.message ?? "This desktop app is already up to date.",
      });
      return;
    }
    await this.#options.reportUpdate({
      requestId,
      state: checked.status === "refused" ? "refused" : "failed",
      fromVersion: String(checked.currentVersion),
      ring: checked.ring,
      step: "prepare",
      failureReason: mapAppRefusalReason(checked.refusal),
      message: checked.message ?? "This desktop app could not check for updates.",
    });
  }
}
