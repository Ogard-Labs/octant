import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  ActorId,
  AggregateId,
  CorrelationId,
  EventId,
  HOST_UPDATE_AGGREGATE_TYPE,
  HOST_UPDATE_REQUESTED_EVENT_NAME,
  HOST_UPDATE_STEP_EVENT_NAME,
  LOCAL_HOST_ID,
  UtcTimestamp,
  type DesktopHostUpdatePending,
  type DesktopHostUpdateReport,
  type EventActor,
  type HostUpdateDrain,
  type HostUpdateFailureReason,
  type HostUpdateHostKind,
  type HostUpdateRequest,
  type HostUpdateRing,
  type HostUpdateStatus,
  type HostUpdateStep,
  type HostUpdateStepOutcome,
} from "@octant/contracts";
import type { MemberBuildDownload, MemberInstallTarget } from "@octant/contracts/shield-servers";
import {
  clearHostUpdatePendingFile,
  clearHostUpdateResultFile,
  decodeHeadlessArtifactManifest,
  HEADLESS_ARTIFACT_MANIFEST_FILENAME,
  readHostUpdatePendingFile,
  readHostUpdateResultFile,
  writeHostUpdateContextFile,
  writeHostUpdatePendingFile,
  type HostUpdateResultFile,
} from "@octant/host-runtime";
import { Schema } from "effect";
import type { HostDrain } from "./hostDrain";
import {
  launchOutOfServiceUpgrade,
  unpackVerifiedBuildForUpgrade,
  type LaunchOutOfServiceUpgradeInput,
  type LaunchOutOfServiceUpgradeResult,
  type UnpackVerifiedBuildInput,
  type UnpackVerifiedBuildResult,
} from "./hostUpdateRunner";
import { readAggregateVersion } from "./persistence/chatProjection";
import type { Journal } from "./persistence/journal";
import type { SqliteConnection } from "./persistence/sqlitePort";
import {
  isNewerVersion,
  type HeadlessBuildCheck,
  type HeadlessBuilds,
} from "./shield/headlessBuilds";

const LOCAL_ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

const DRAIN_POLL_MS = 500;
const STARTUP_RESULT_POLL_MS = 250;
const STARTUP_RESULT_WATCH_MAX_POLLS = 240;

type VerifiedHeadlessBuild = Extract<HeadlessBuildCheck, { readonly status: "verified" }>;

export interface HostUpdateServiceOptions {
  readonly hostKind: HostUpdateHostKind;
  readonly currentVersion: () => string;
  readonly currentRing: () => HostUpdateRing;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly uid: number;
  readonly stateDirectory: string;
  readonly installRoot: string;
  readonly resultPath: string;
  readonly pendingPath: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly builds?: HeadlessBuilds;
  readonly drain: Pick<HostDrain, "enter" | "lift" | "status">;
  readonly connection: SqliteConnection;
  readonly journal: Journal;
  readonly clock: () => string;
  readonly uuid: () => string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** Test seam for reading the installed artifact's store version. */
  readonly readInstalledStoreVersion?: (installRoot: string) => Promise<number | undefined>;
  /** Test seam for unpacking the verified build before handing off to the runner. */
  readonly unpackBuild?: (input: UnpackVerifiedBuildInput) => Promise<UnpackVerifiedBuildResult>;
  /** Test seam for launching `octant server upgrade` outside the host's own service. */
  readonly launchUpgrade?: (
    input: LaunchOutOfServiceUpgradeInput,
  ) => Promise<LaunchOutOfServiceUpgradeResult>;
}

interface PreparedHeadlessState {
  readonly requestId: AggregateId;
  readonly target: MemberInstallTarget;
  readonly fromVersion: string;
  readonly currentStoreVersion: number;
  readonly downloadId?: string;
  readonly buildPath?: string;
  readonly build?: VerifiedHeadlessBuild;
}

interface ActiveDesktopRequest {
  readonly requestId: AggregateId;
  readonly action: "prepare" | "start";
  readonly expectedCurrentVersion: string;
  readonly actor: EventActor;
  readonly drain?: HostUpdateDrain;
  readonly toVersion?: string;
  readonly ring?: HostUpdateRing;
  requestedJournaled: boolean;
}

function headlessTargetFor(
  platform: NodeJS.Platform,
  arch: string,
): MemberInstallTarget | undefined {
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";
  return undefined;
}

async function defaultReadInstalledStoreVersion(installRoot: string): Promise<number | undefined> {
  try {
    const text = await readFile(
      join(installRoot, "current", HEADLESS_ARTIFACT_MANIFEST_FILENAME),
      "utf8",
    );
    return decodeHeadlessArtifactManifest(text).storeVersion;
  } catch {
    return undefined;
  }
}

function defaultActor(actor?: EventActor): EventActor {
  return actor ?? { kind: "local-user", actorId: decodeActorId(LOCAL_ACTOR_ID) };
}

function mapDownloadRefusal(download: MemberBuildDownload): {
  readonly state: "up-to-date" | "refused";
  readonly failureReason?: HostUpdateFailureReason;
  readonly message: string;
} {
  switch (download.refusal) {
    case "no-release":
      return {
        state: "refused",
        failureReason: "ring-no-headless-build",
        message: "Its release ring publishes no headless build.",
      };
    case "no-newer-release":
      return {
        state: "up-to-date",
        message: "This computer is already up to date.",
      };
    case "untrusted-listing":
      return {
        state: "refused",
        failureReason: "untrusted-signature",
        message: "The release listing signature could not be verified, so nothing was downloaded.",
      };
    case "digest-mismatch":
      return {
        state: "refused",
        failureReason: "digest-mismatch",
        message: "The downloaded build did not match its signed digest, so it was discarded.",
      };
    case "build-unverified":
      return {
        state: "refused",
        failureReason: "build-unverified",
        message: "The downloaded build failed signature or file verification, so it was discarded.",
      };
    default:
      return {
        state: "refused",
        failureReason: "unreachable",
        message: "The signed release feed could not be reached.",
      };
  }
}

function mapBuildCheckRefusal(
  reason: Extract<HeadlessBuildCheck, { readonly status: "refused" }>["reason"],
): { readonly failureReason: HostUpdateFailureReason; readonly message: string } {
  switch (reason) {
    case "unsigned":
    case "unverified":
      return {
        failureReason: "untrusted-signature",
        message: "The build does not carry a valid release signature, so it was refused.",
      };
    case "files-mismatch":
      return {
        failureReason: "digest-mismatch",
        message: "A file in the build did not match its signed manifest, so it was refused.",
      };
    default:
      return {
        failureReason: "build-unverified",
        message: "The build could not be verified for this computer.",
      };
  }
}

/**
 * Authoritative host-owned update coordinator for `/api/host-control/update`.
 *
 * - Accepts intent only (request id, expected current version, drain choice):
 *   never a URL, file path, version choice, or command arguments.
 * - Enforces one update at a time per host, idempotent by `requestId`.
 * - Standalone headless hosts verify their own signed build via `HeadlessBuilds`,
 *   drain via `HostDrain`, and spawn `octant server upgrade` outside the host's
 *   own service; whichever version starts next journals the atomic result file.
 * - Desktop hosts hand the verified intent off to desktop main via loopback
 *   `/api/desktop/host-update` so `appUpdateService` and
 *   `resolveUpdateInstallReadiness` remain the single desktop updater.
 */
export class HostUpdateService {
  readonly #options: HostUpdateServiceOptions;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #statuses = new Map<string, HostUpdateStatus>();
  readonly #preparedHeadless = new Map<string, PreparedHeadlessState>();
  readonly #journaledResults = new Set<string>();
  #activeRequestId: string | undefined;
  #startingHeadless:
    | { readonly key: string; readonly promise: Promise<HostUpdateStatus> }
    | undefined;
  #latestRequestId: string | undefined;
  #desktopPending: ActiveDesktopRequest | undefined;
  #startupWatcher: ReturnType<typeof setInterval> | undefined;
  #disposed = false;

  constructor(options: HostUpdateServiceOptions) {
    this.#options = options;
    this.#sleep =
      options.sleep ?? ((milliseconds) => new Promise((done) => setTimeout(done, milliseconds)));
  }

  /**
   * Reconciles any terminal result written to the state directory by an
   * out-of-service upgrade runner before this process started. If a pending
   * marker exists without a result file yet (the runner writes its result
   * right after this server passes its health check), watches briefly until
   * the result lands.
   */
  async reconcileStartupResult(): Promise<HostUpdateResultFile | undefined> {
    const immediate = await this.#consumeResultFileIfPresent();
    if (immediate !== undefined) return immediate;
    const pending = await readHostUpdatePendingFile(this.#options.pendingPath);
    if (pending === undefined || this.#disposed) return undefined;
    // Record the in-flight request id while the runner finishes writing its result.
    this.#latestRequestId = String(pending.requestId);
    let polls = 0;
    this.#startupWatcher = setInterval(() => {
      polls += 1;
      void this.#consumeResultFileIfPresent().then((consumed) => {
        if (consumed !== undefined || polls >= STARTUP_RESULT_WATCH_MAX_POLLS || this.#disposed) {
          this.#stopStartupWatcher();
        }
      });
    }, STARTUP_RESULT_POLL_MS);
    this.#startupWatcher.unref?.();
    return undefined;
  }

  dispose(): void {
    this.#disposed = true;
    this.#stopStartupWatcher();
  }

  async handle(request: HostUpdateRequest, actor?: EventActor): Promise<HostUpdateStatus> {
    await this.#consumeResultFileIfPresent();
    const resolvedActor = defaultActor(actor);
    if (request.action === "status") {
      return this.#status(request.requestId);
    }
    if (request.action === "prepare") {
      return this.#prepare(request.requestId, request.expectedCurrentVersion, resolvedActor);
    }
    return this.#start(
      request.requestId,
      request.expectedCurrentVersion,
      request.drain,
      resolvedActor,
    );
  }

  /** Loopback-only read for desktop main (`/api/desktop/host-update` GET). */
  readDesktopPending(): DesktopHostUpdatePending {
    if (this.#options.hostKind !== "desktop" || this.#desktopPending === undefined) {
      return { pending: null };
    }
    return {
      pending: {
        requestId: this.#desktopPending.requestId,
        action: this.#desktopPending.action,
        expectedCurrentVersion: this.#desktopPending.expectedCurrentVersion,
        ...(this.#desktopPending.drain === undefined ? {} : { drain: this.#desktopPending.drain }),
      },
    };
  }

  /** Loopback-only progress/outcome report from desktop main (`/api/desktop/host-update` POST). */
  reportDesktopUpdate(report: DesktopHostUpdateReport): HostUpdateStatus {
    const key = String(report.requestId);
    const pending = this.#desktopPending;
    const matchedPending =
      pending !== undefined && String(pending.requestId) === key ? pending : undefined;
    const ring = report.ring ?? matchedPending?.ring ?? this.#options.currentRing();
    const drain = matchedPending?.drain;

    const status: HostUpdateStatus = {
      requestId: report.requestId,
      hostKind: "desktop",
      state: report.state,
      fromVersion: report.fromVersion,
      ...(report.toVersion === undefined ? {} : { toVersion: report.toVersion }),
      ring,
      ...(drain === undefined ? {} : { drain }),
      ...(report.step === undefined ? {} : { step: report.step }),
      ...(report.failureReason === undefined ? {} : { failureReason: report.failureReason }),
      ...(report.activeAgentCount === undefined
        ? {}
        : { activeAgentCount: report.activeAgentCount }),
      ...(report.activityUnconfirmed === undefined
        ? {}
        : { activityUnconfirmed: report.activityUnconfirmed }),
      ...(report.message === undefined ? {} : { message: report.message }),
    };
    this.#statuses.set(key, status);
    this.#latestRequestId = key;

    if (matchedPending !== undefined) {
      if (matchedPending.action === "prepare") {
        if (
          report.state === "update-available" ||
          report.state === "up-to-date" ||
          report.state === "refused" ||
          report.state === "failed"
        ) {
          this.#desktopPending = undefined;
        }
      } else if (matchedPending.action === "start") {
        const toVersion = report.toVersion ?? matchedPending.toVersion ?? report.fromVersion;
        if (!matchedPending.requestedJournaled && matchedPending.drain !== undefined) {
          matchedPending.requestedJournaled = true;
          this.#journalRequested({
            requestId: matchedPending.requestId,
            actor: matchedPending.actor,
            hostKind: "desktop",
            fromVersion: report.fromVersion,
            toVersion,
            ring,
            drain: matchedPending.drain,
          });
        }
        if (report.state === "waiting-for-work" && matchedPending.drain !== undefined) {
          this.#journalStep({
            requestId: matchedPending.requestId,
            actor: matchedPending.actor,
            hostKind: "desktop",
            fromVersion: report.fromVersion,
            toVersion,
            ring,
            drain: matchedPending.drain,
            step: report.step ?? "install",
            outcome: "waiting-for-work",
          });
        } else if (
          report.state === "installing" ||
          report.state === "updated" ||
          report.state === "refused" ||
          report.state === "failed"
        ) {
          if (matchedPending.drain !== undefined) {
            this.#journalStep({
              requestId: matchedPending.requestId,
              actor: matchedPending.actor,
              hostKind: "desktop",
              fromVersion: report.fromVersion,
              toVersion,
              ring,
              drain: matchedPending.drain,
              step: report.step ?? "install",
              outcome:
                report.state === "installing" || report.state === "updated"
                  ? "succeeded"
                  : "failed",
              ...(report.failureReason === undefined
                ? {}
                : { failureReason: report.failureReason }),
            });
          }
          if (report.state === "refused" || report.state === "failed") {
            this.#options.drain.lift();
          }
          if (this.#activeRequestId === key) this.#activeRequestId = undefined;
          this.#desktopPending = undefined;
        }
      }
    }
    return status;
  }

  async #status(requestId?: AggregateId): Promise<HostUpdateStatus> {
    const key = requestId === undefined ? this.#latestRequestId : String(requestId);
    if (key !== undefined) {
      const prepared = this.#preparedHeadless.get(key);
      if (prepared?.downloadId !== undefined && this.#options.builds !== undefined) {
        await this.#refreshHeadlessPrepare(prepared);
      }
      const existing = this.#statuses.get(key);
      if (existing !== undefined) return existing;
    }
    return {
      hostKind: this.#options.hostKind,
      state: "idle",
      fromVersion: this.#options.currentVersion(),
      ring: this.#options.currentRing(),
    };
  }

  async #prepare(
    requestId: AggregateId,
    expectedCurrentVersion: string,
    actor: EventActor,
  ): Promise<HostUpdateStatus> {
    const key = String(requestId);
    const currentVersion = this.#options.currentVersion();
    const ring = this.#options.currentRing();
    const existing = this.#statuses.get(key);
    if (existing !== undefined) {
      return this.#status(requestId);
    }
    if (this.#activeRequestId !== undefined && this.#activeRequestId !== key) {
      return {
        requestId,
        hostKind: this.#options.hostKind,
        state: "refused",
        fromVersion: currentVersion,
        ring,
        failureReason: "already-updating",
        message: "An update is already running on this computer.",
      };
    }
    if (expectedCurrentVersion !== currentVersion) {
      return {
        requestId,
        hostKind: this.#options.hostKind,
        state: "refused",
        fromVersion: currentVersion,
        ring,
        failureReason: "version-mismatch",
        message: `This computer runs Octant ${currentVersion}, not ${expectedCurrentVersion}.`,
      };
    }

    if (this.#options.hostKind === "desktop") {
      this.#desktopPending = {
        requestId,
        action: "prepare",
        expectedCurrentVersion,
        actor,
        ring,
        requestedJournaled: false,
      };
      const status: HostUpdateStatus = {
        requestId,
        hostKind: "desktop",
        state: "preparing",
        fromVersion: currentVersion,
        ring,
        step: "prepare",
      };
      this.#statuses.set(key, status);
      this.#latestRequestId = key;
      return status;
    }

    // Standalone headless host prepare
    if (ring === "preview") {
      const status: HostUpdateStatus = {
        requestId,
        hostKind: "headless",
        state: "refused",
        fromVersion: currentVersion,
        ring,
        step: "prepare",
        failureReason: "ring-no-headless-build",
        message: "Its release ring publishes no headless build.",
      };
      this.#statuses.set(key, status);
      this.#latestRequestId = key;
      return status;
    }

    const target = headlessTargetFor(this.#options.platform, this.#options.arch);
    if (target === undefined || this.#options.builds === undefined) {
      const status: HostUpdateStatus = {
        requestId,
        hostKind: "headless",
        state: "refused",
        fromVersion: currentVersion,
        ring,
        step: "prepare",
        failureReason: "unsupported-install",
        message: "This headless host has no signed update feed configured.",
      };
      this.#statuses.set(key, status);
      this.#latestRequestId = key;
      return status;
    }

    const currentStoreVersion =
      (await (this.#options.readInstalledStoreVersion ?? defaultReadInstalledStoreVersion)(
        this.#options.installRoot,
      )) ?? 0;

    // Check locally cached verified build first, then fetch from signed feed if needed.
    const cachedPath = await this.#options.builds.find(target);
    if (cachedPath !== undefined) {
      const checked = await this.#options.builds.check(cachedPath, target);
      if (checked.status === "verified" && isNewerVersion(checked.version, currentVersion)) {
        if (checked.storeVersion < currentStoreVersion) {
          const status: HostUpdateStatus = {
            requestId,
            hostKind: "headless",
            state: "refused",
            fromVersion: currentVersion,
            toVersion: checked.version,
            ring: checked.ring,
            step: "verify",
            failureReason: "downgrade-refused",
            message: "Refused an older store version that would downgrade this computer's store.",
          };
          this.#statuses.set(key, status);
          this.#latestRequestId = key;
          return status;
        }
        this.#preparedHeadless.set(key, {
          requestId,
          target,
          fromVersion: currentVersion,
          currentStoreVersion,
          buildPath: cachedPath,
          build: checked,
        });
        const status: HostUpdateStatus = {
          requestId,
          hostKind: "headless",
          state: "update-available",
          fromVersion: currentVersion,
          toVersion: checked.version,
          ring: checked.ring,
          storeMigration: checked.storeVersion > currentStoreVersion,
          step: "prepare",
        };
        this.#statuses.set(key, status);
        this.#latestRequestId = key;
        return status;
      }
      if (checked.status === "refused") {
        // An unverified local file is never trusted; fall through to the signed feed.
      }
    }

    const download = this.#options.builds.download({ target, newerThan: currentVersion });
    if (download === undefined) {
      const status: HostUpdateStatus = {
        requestId,
        hostKind: "headless",
        state: "refused",
        fromVersion: currentVersion,
        ring,
        step: "download",
        failureReason: "unreachable",
        message: "No signed release feed is configured on this computer.",
      };
      this.#statuses.set(key, status);
      this.#latestRequestId = key;
      return status;
    }

    const prepared: PreparedHeadlessState = {
      requestId,
      target,
      fromVersion: currentVersion,
      currentStoreVersion,
      downloadId: String(download.downloadId),
    };
    this.#preparedHeadless.set(key, prepared);
    this.#latestRequestId = key;
    if (download.state === "refused") {
      return this.#applyDownloadRefusal(prepared, download);
    }
    const status: HostUpdateStatus = {
      requestId,
      hostKind: "headless",
      state: "preparing",
      fromVersion: currentVersion,
      ring: download.ring,
      step: download.state === "verifying" ? "verify" : "download",
    };
    this.#statuses.set(key, status);
    await this.#refreshHeadlessPrepare(prepared);
    return this.#statuses.get(key) ?? status;
  }

  async #refreshHeadlessPrepare(prepared: PreparedHeadlessState): Promise<void> {
    if (prepared.downloadId === undefined || this.#options.builds === undefined) return;
    const key = String(prepared.requestId);
    const currentStatus = this.#statuses.get(key);
    if (currentStatus !== undefined && currentStatus.state !== "preparing") return;
    const progress = this.#options.builds.downloadProgress(prepared.downloadId);
    if (progress === undefined) return;
    if (progress.state === "downloading" || progress.state === "verifying") {
      this.#statuses.set(key, {
        requestId: prepared.requestId,
        hostKind: "headless",
        state: "preparing",
        fromVersion: prepared.fromVersion,
        ...(progress.version === undefined ? {} : { toVersion: progress.version }),
        ring: progress.ring,
        step: progress.state === "verifying" ? "verify" : "download",
      });
      return;
    }
    if (progress.state === "refused") {
      this.#applyDownloadRefusal(prepared, progress);
      return;
    }
    const buildPath = await this.#options.builds.find(prepared.target);
    if (buildPath === undefined) {
      this.#statuses.set(key, {
        requestId: prepared.requestId,
        hostKind: "headless",
        state: "refused",
        fromVersion: prepared.fromVersion,
        ring: progress.ring,
        step: "verify",
        failureReason: "build-unverified",
        message: "The verified build could not be found after download.",
      });
      return;
    }
    const checked = await this.#options.builds.check(buildPath, prepared.target);
    if (checked.status === "refused") {
      const mapped = mapBuildCheckRefusal(checked.reason);
      this.#statuses.set(key, {
        requestId: prepared.requestId,
        hostKind: "headless",
        state: "refused",
        fromVersion: prepared.fromVersion,
        ring: progress.ring,
        step: "verify",
        failureReason: mapped.failureReason,
        message: mapped.message,
      });
      return;
    }
    if (!isNewerVersion(checked.version, prepared.fromVersion)) {
      this.#statuses.set(key, {
        requestId: prepared.requestId,
        hostKind: "headless",
        state: "up-to-date",
        fromVersion: prepared.fromVersion,
        ring: checked.ring,
        step: "prepare",
        message: "This computer is already up to date.",
      });
      return;
    }
    if (checked.storeVersion < prepared.currentStoreVersion) {
      this.#statuses.set(key, {
        requestId: prepared.requestId,
        hostKind: "headless",
        state: "refused",
        fromVersion: prepared.fromVersion,
        toVersion: checked.version,
        ring: checked.ring,
        step: "verify",
        failureReason: "downgrade-refused",
        message: "Refused an older store version that would downgrade this computer's store.",
      });
      return;
    }
    this.#preparedHeadless.set(key, {
      requestId: prepared.requestId,
      target: prepared.target,
      fromVersion: prepared.fromVersion,
      currentStoreVersion: prepared.currentStoreVersion,
      buildPath,
      build: checked,
    });
    this.#statuses.set(key, {
      requestId: prepared.requestId,
      hostKind: "headless",
      state: "update-available",
      fromVersion: prepared.fromVersion,
      toVersion: checked.version,
      ring: checked.ring,
      storeMigration: checked.storeVersion > prepared.currentStoreVersion,
      step: "prepare",
    });
  }

  #applyDownloadRefusal(
    prepared: PreparedHeadlessState,
    download: MemberBuildDownload,
  ): HostUpdateStatus {
    const mapped = mapDownloadRefusal(download);
    const status: HostUpdateStatus = {
      requestId: prepared.requestId,
      hostKind: "headless",
      state: mapped.state,
      fromVersion: prepared.fromVersion,
      ring: download.ring,
      step: "download",
      ...(mapped.failureReason === undefined ? {} : { failureReason: mapped.failureReason }),
      message: mapped.message,
    };
    this.#statuses.set(String(prepared.requestId), status);
    return status;
  }

  async #start(
    requestId: AggregateId,
    expectedCurrentVersion: string,
    drain: HostUpdateDrain,
    actor: EventActor,
  ): Promise<HostUpdateStatus> {
    const key = String(requestId);
    const currentVersion = this.#options.currentVersion();
    const ring = this.#options.currentRing();

    // Coalesce concurrent identical-requestId starts while async build
    // verification is still in flight so only one verification and runner run.
    if (this.#startingHeadless?.key === key) {
      return this.#startingHeadless.promise;
    }

    // Idempotent by requestId: if this exact request already started or finished,
    // return its status without starting a second update.
    const existing = this.#statuses.get(key);
    if (
      existing !== undefined &&
      existing.state !== "idle" &&
      existing.state !== "preparing" &&
      existing.state !== "update-available"
    ) {
      return existing;
    }

    // One update at a time per host.
    if (this.#activeRequestId !== undefined && this.#activeRequestId !== key) {
      return {
        requestId,
        hostKind: this.#options.hostKind,
        state: "refused",
        fromVersion: currentVersion,
        ring,
        failureReason: "already-updating",
        message: "An update is already running on this computer.",
      };
    }

    if (expectedCurrentVersion !== currentVersion) {
      return {
        requestId,
        hostKind: this.#options.hostKind,
        state: "refused",
        fromVersion: currentVersion,
        ring,
        failureReason: "version-mismatch",
        message: `This computer runs Octant ${currentVersion}, not ${expectedCurrentVersion}.`,
      };
    }

    if (this.#options.hostKind === "desktop") {
      this.#activeRequestId = key;
      this.#latestRequestId = key;
      const toVersion = existing?.toVersion;
      const effectiveRing = existing?.ring ?? ring;
      if (drain.kind === "wait") {
        this.#options.drain.enter(drain.minutes);
      }
      this.#desktopPending = {
        requestId,
        action: "start",
        expectedCurrentVersion,
        actor,
        drain,
        ...(toVersion === undefined ? {} : { toVersion }),
        ring: effectiveRing,
        requestedJournaled: false,
      };
      if (toVersion !== undefined) {
        this.#desktopPending.requestedJournaled = true;
        this.#journalRequested({
          requestId,
          actor,
          hostKind: "desktop",
          fromVersion: currentVersion,
          toVersion,
          ring: effectiveRing,
          drain,
        });
      }
      const status: HostUpdateStatus = {
        requestId,
        hostKind: "desktop",
        state: "running",
        fromVersion: currentVersion,
        ...(toVersion === undefined ? {} : { toVersion }),
        ring: effectiveRing,
        drain,
        step: "download",
      };
      this.#statuses.set(key, status);
      return status;
    }

    // Standalone headless host start: validate synchronously, then reserve
    // ownership BEFORE the first await so concurrent start requests with
    // different request IDs are immediately refused and identical request IDs
    // coalesce on the single in-flight start.
    const target = headlessTargetFor(this.#options.platform, this.#options.arch);
    const builds = this.#options.builds;
    if (target === undefined || builds === undefined) {
      return {
        requestId,
        hostKind: "headless",
        state: "refused",
        fromVersion: currentVersion,
        ring,
        step: "verify",
        failureReason: "unsupported-install",
        message: "This headless host has no signed update feed configured.",
      };
    }

    this.#activeRequestId = key;
    this.#latestRequestId = key;
    const startPromise = this.#startHeadlessReserved({
      key,
      requestId,
      actor,
      currentVersion,
      ring,
      drain,
      target,
      builds,
    }).finally(() => {
      if (this.#startingHeadless?.key === key) {
        this.#startingHeadless = undefined;
      }
    });
    this.#startingHeadless = { key, promise: startPromise };
    return startPromise;
  }

  async #startHeadlessReserved(input: {
    readonly key: string;
    readonly requestId: AggregateId;
    readonly actor: EventActor;
    readonly currentVersion: string;
    readonly ring: HostUpdateRing;
    readonly drain: HostUpdateDrain;
    readonly target: MemberInstallTarget;
    readonly builds: HeadlessBuilds;
  }): Promise<HostUpdateStatus> {
    const { key, requestId, actor, currentVersion, ring, drain, target, builds } = input;
    const releaseReservation = () => {
      if (this.#activeRequestId === key) {
        this.#activeRequestId = undefined;
      }
    };
    let launched = false;
    try {
      const prepared = this.#preparedHeadless.get(key);
      const buildPath = prepared?.buildPath ?? (await builds.find(target));
      if (buildPath === undefined) {
        releaseReservation();
        const status: HostUpdateStatus = {
          requestId,
          hostKind: "headless",
          state: "refused",
          fromVersion: currentVersion,
          ring,
          step: "verify",
          failureReason: ring === "preview" ? "ring-no-headless-build" : "build-unverified",
          message:
            ring === "preview"
              ? "Its release ring publishes no headless build."
              : "No verified newer release build is prepared on this computer.",
        };
        this.#statuses.set(key, status);
        return status;
      }

      // Always re-verify the build bytes + signature before draining or swapping.
      const verified = await builds.check(buildPath, target);
      if (verified.status === "refused") {
        releaseReservation();
        const mapped = mapBuildCheckRefusal(verified.reason);
        const status: HostUpdateStatus = {
          requestId,
          hostKind: "headless",
          state: "refused",
          fromVersion: currentVersion,
          ring,
          step: "verify",
          failureReason: mapped.failureReason,
          message: mapped.message,
        };
        this.#statuses.set(key, status);
        return status;
      }
      if (!isNewerVersion(verified.version, currentVersion)) {
        releaseReservation();
        const status: HostUpdateStatus = {
          requestId,
          hostKind: "headless",
          state: "refused",
          fromVersion: currentVersion,
          toVersion: verified.version,
          ring: verified.ring,
          step: "verify",
          failureReason: "downgrade-refused",
          message: `Refused Octant ${verified.version}, which is not newer than ${currentVersion}.`,
        };
        this.#statuses.set(key, status);
        return status;
      }
      const currentStoreVersion =
        prepared?.currentStoreVersion ??
        (await (this.#options.readInstalledStoreVersion ?? defaultReadInstalledStoreVersion)(
          this.#options.installRoot,
        )) ??
        0;
      if (verified.storeVersion < currentStoreVersion) {
        releaseReservation();
        const status: HostUpdateStatus = {
          requestId,
          hostKind: "headless",
          state: "refused",
          fromVersion: currentVersion,
          toVersion: verified.version,
          ring: verified.ring,
          step: "verify",
          failureReason: "downgrade-refused",
          message: "Refused an older store version that would downgrade this computer's store.",
        };
        this.#statuses.set(key, status);
        return status;
      }

      const storeMigration = verified.storeVersion > currentStoreVersion;

      this.#journalRequested({
        requestId,
        actor,
        hostKind: "headless",
        fromVersion: currentVersion,
        toVersion: verified.version,
        ring: verified.ring,
        drain,
      });

      const initialStatus: HostUpdateStatus = {
        requestId,
        hostKind: "headless",
        state: "running",
        fromVersion: currentVersion,
        toVersion: verified.version,
        ring: verified.ring,
        storeMigration,
        drain,
        step: "drain",
      };
      this.#statuses.set(key, initialStatus);

      launched = true;
      void this.#runHeadlessUpgrade({
        requestId,
        actor,
        fromVersion: currentVersion,
        buildPath,
        build: verified,
        storeMigration,
        drain,
      }).catch(() => undefined);

      return initialStatus;
    } catch (error) {
      if (!launched) releaseReservation();
      throw error;
    }
  }

  async #runHeadlessUpgrade(input: {
    readonly requestId: AggregateId;
    readonly actor: EventActor;
    readonly fromVersion: string;
    readonly buildPath: string;
    readonly build: VerifiedHeadlessBuild;
    readonly storeMigration: boolean;
    readonly drain: HostUpdateDrain;
  }): Promise<void> {
    const key = String(input.requestId);
    const workDirectory = join(this.#options.stateDirectory, "host-update", key);
    const failBeforeSwap = async (
      step: HostUpdateStep,
      failureReason: HostUpdateFailureReason,
      message: string,
    ): Promise<void> => {
      // Failure before swap: lift drain, clean work files, keep old version running.
      this.#options.drain.lift();
      await clearHostUpdatePendingFile(this.#options.pendingPath).catch(() => undefined);
      await rm(workDirectory, { force: true, recursive: true }).catch(() => undefined);
      this.#journalStep({
        requestId: input.requestId,
        actor: input.actor,
        hostKind: "headless",
        fromVersion: input.fromVersion,
        toVersion: input.build.version,
        ring: input.build.ring,
        drain: input.drain,
        step,
        outcome: "failed",
        failureReason,
      });
      this.#statuses.set(key, {
        requestId: input.requestId,
        hostKind: "headless",
        state: "failed",
        fromVersion: input.fromVersion,
        toVersion: input.build.version,
        ring: input.build.ring,
        storeMigration: input.storeMigration,
        drain: input.drain,
        step,
        failureReason,
        message,
      });
      if (this.#activeRequestId === key) this.#activeRequestId = undefined;
    };

    try {
      // 1. Unpack verified tarball into private state work folder and re-check digests.
      const unpacked = await (this.#options.unpackBuild ?? unpackVerifiedBuildForUpgrade)({
        tarPath: input.buildPath,
        workDirectory,
        expectedManifestSha256: input.build.manifestSha256,
        expectedSignatureSha256: input.build.signatureSha256,
      });
      if (unpacked.status === "refused") {
        await failBeforeSwap(
          "verify",
          unpacked.reason,
          "The unpacked build did not match its verified manifest and signature.",
        );
        return;
      }

      // 2. Drain running turns according to the person's drain choice.
      if (input.drain.kind === "wait") {
        this.#options.drain.enter(input.drain.minutes);
        while (!this.#disposed) {
          const drainStatus = this.#options.drain.status();
          if (drainStatus.state === "drained" || drainStatus.state === "timed-out") break;
          if (drainStatus.state === "not-draining") {
            await failBeforeSwap("drain", "drain-failed", "The host drain lifted before swapping.");
            return;
          }
          await this.#sleep(DRAIN_POLL_MS);
        }
      } else {
        // Briefly refuse new turns during handoff to the detached upgrader.
        this.#options.drain.enter(1);
      }

      // 3. Write private context + pending marker and launch outside this service.
      if (this.#options.platform !== "linux" && this.#options.platform !== "darwin") {
        await failBeforeSwap(
          "swap",
          "unsupported-install",
          "Detached headless upgrades are supported on Linux and macOS.",
        );
        return;
      }
      const contextPath = join(workDirectory, "context.json");
      const launchdPlistPath =
        this.#options.platform === "darwin"
          ? join(
              this.#options.stateDirectory,
              "host-update",
              `app.octant.upgrade.${key.replace(/[^a-zA-Z0-9]/g, "").slice(0, 16)}.plist`,
            )
          : undefined;
      await clearHostUpdateResultFile(this.#options.resultPath).catch(() => undefined);
      await writeHostUpdateContextFile(contextPath, {
        schemaVersion: 1,
        requestId: input.requestId,
        actor: input.actor,
        hostKind: "headless",
        fromVersion: input.fromVersion,
        toVersion: input.build.version,
        ring: input.build.ring,
        drain: input.drain,
        storeMigration: input.storeMigration,
        resultPath: this.#options.resultPath,
        cleanupWorkDir: workDirectory,
        ...(launchdPlistPath === undefined ? {} : { cleanupLaunchdPlist: launchdPlistPath }),
      });
      await writeHostUpdatePendingFile(this.#options.pendingPath, {
        schemaVersion: 1,
        requestId: input.requestId,
        actor: input.actor,
        hostKind: "headless",
        fromVersion: input.fromVersion,
        toVersion: input.build.version,
        ring: input.build.ring,
        drain: input.drain,
        storeMigration: input.storeMigration,
        startedAt: decodeTimestamp(this.#options.clock()),
      });

      this.#statuses.set(key, {
        requestId: input.requestId,
        hostKind: "headless",
        state: "running",
        fromVersion: input.fromVersion,
        toVersion: input.build.version,
        ring: input.build.ring,
        storeMigration: input.storeMigration,
        drain: input.drain,
        step: "swap",
      });

      const launched = await (this.#options.launchUpgrade ?? launchOutOfServiceUpgrade)({
        platform: this.#options.platform,
        uid: this.#options.uid,
        requestId: key,
        installRoot: this.#options.installRoot,
        stateDirectory: this.#options.stateDirectory,
        artifactRoot: unpacked.artifactRoot,
        updateContextPath: contextPath,
        environment: this.#options.environment ?? {},
      });
      if (launched.status !== "launched") {
        await failBeforeSwap(
          "swap",
          "runner-launch-failed",
          "Octant could not start the out-of-service upgrade runner, so the current version stayed running.",
        );
        return;
      }

      // If the runner fails before stopping this server (e.g., backup failed or
      // owner stop refused), this server stays alive and consumes the result
      // file so the drain lifts and the caller sees the failure cleanly.
      this.#watchResultWhileRunning();
    } catch {
      await failBeforeSwap(
        "swap",
        "install-failed",
        "The update failed before swapping, so the current version stayed running.",
      );
    }
  }

  #watchResultWhileRunning(): void {
    this.#stopStartupWatcher();
    let polls = 0;
    this.#startupWatcher = setInterval(() => {
      polls += 1;
      void this.#consumeResultFileIfPresent().then((consumed) => {
        if (consumed !== undefined || polls >= STARTUP_RESULT_WATCH_MAX_POLLS || this.#disposed) {
          this.#stopStartupWatcher();
        }
      });
    }, STARTUP_RESULT_POLL_MS);
    this.#startupWatcher.unref?.();
  }

  #stopStartupWatcher(): void {
    if (this.#startupWatcher !== undefined) {
      clearInterval(this.#startupWatcher);
      this.#startupWatcher = undefined;
    }
  }

  async #consumeResultFileIfPresent(): Promise<HostUpdateResultFile | undefined> {
    const result = await readHostUpdateResultFile(this.#options.resultPath);
    if (result === undefined) return undefined;
    const key = String(result.requestId);
    if (!this.#journaledResults.has(key)) {
      this.#journaledResults.add(key);
      const outcome: HostUpdateStepOutcome =
        result.outcome === "updated"
          ? "succeeded"
          : result.outcome === "rolled-back"
            ? "rolled-back"
            : result.outcome === "recovery-required"
              ? "recovery-required"
              : "failed";
      this.#journalStep({
        requestId: result.requestId,
        actor: result.actor,
        hostKind: result.hostKind,
        fromVersion: result.fromVersion,
        toVersion: result.toVersion,
        ring: result.ring,
        drain: result.drain,
        step: result.step,
        outcome,
        ...(result.failureReason === undefined ? {} : { failureReason: result.failureReason }),
        ...(result.storeRestored === undefined ? {} : { storeRestored: result.storeRestored }),
      });
    }

    const status: HostUpdateStatus = {
      requestId: result.requestId,
      hostKind: result.hostKind,
      state: result.outcome,
      fromVersion: result.fromVersion,
      toVersion: result.toVersion,
      ring: result.ring,
      storeMigration: result.storeMigration,
      drain: result.drain,
      step: result.step,
      ...(result.failureReason === undefined ? {} : { failureReason: result.failureReason }),
      ...(result.storeRestored === undefined ? {} : { storeRestored: result.storeRestored }),
      message: terminalResultMessage(result),
    };
    this.#statuses.set(key, status);
    this.#latestRequestId = key;
    if (this.#activeRequestId === key) {
      this.#activeRequestId = undefined;
      // If this process is the old server that never stopped, lift the drain now.
      this.#options.drain.lift();
    }
    await clearHostUpdateResultFile(this.#options.resultPath).catch(() => undefined);
    await clearHostUpdatePendingFile(this.#options.pendingPath).catch(() => undefined);
    this.#stopStartupWatcher();
    return result;
  }

  #journalRequested(input: {
    readonly requestId: AggregateId;
    readonly actor: EventActor;
    readonly hostKind: HostUpdateHostKind;
    readonly fromVersion: string;
    readonly toVersion: string;
    readonly ring: HostUpdateRing;
    readonly drain: HostUpdateDrain;
  }): void {
    const requestedAt = decodeTimestamp(this.#options.clock());
    const aggregateId = decodeAggregateId(String(input.requestId));
    this.#options.journal.append({
      aggregate: {
        aggregateType: HOST_UPDATE_AGGREGATE_TYPE,
        aggregateId,
      },
      expectedVersion: readAggregateVersion(
        this.#options.connection,
        HOST_UPDATE_AGGREGATE_TYPE,
        aggregateId,
      ),
      events: [
        {
          eventId: decodeEventId(this.#options.uuid()),
          eventName: HOST_UPDATE_REQUESTED_EVENT_NAME,
          eventVersion: 1,
          hostId: LOCAL_HOST_ID,
          correlationId: decodeCorrelationId(this.#options.uuid()),
          actor: input.actor,
          occurredAt: requestedAt,
          payload: {
            requestId: input.requestId,
            actor: input.actor,
            hostKind: input.hostKind,
            fromVersion: input.fromVersion,
            toVersion: input.toVersion,
            ring: input.ring,
            drain: input.drain,
            requestedAt,
          },
        },
      ],
    });
  }

  #journalStep(input: {
    readonly requestId: AggregateId;
    readonly actor: EventActor;
    readonly hostKind: HostUpdateHostKind;
    readonly fromVersion: string;
    readonly toVersion: string;
    readonly ring: HostUpdateRing;
    readonly drain: HostUpdateDrain;
    readonly step: HostUpdateStep;
    readonly outcome: HostUpdateStepOutcome;
    readonly failureReason?: HostUpdateFailureReason;
    readonly storeRestored?: boolean;
  }): void {
    const recordedAt = decodeTimestamp(this.#options.clock());
    const aggregateId = decodeAggregateId(String(input.requestId));
    this.#options.journal.append({
      aggregate: {
        aggregateType: HOST_UPDATE_AGGREGATE_TYPE,
        aggregateId,
      },
      expectedVersion: readAggregateVersion(
        this.#options.connection,
        HOST_UPDATE_AGGREGATE_TYPE,
        aggregateId,
      ),
      events: [
        {
          eventId: decodeEventId(this.#options.uuid()),
          eventName: HOST_UPDATE_STEP_EVENT_NAME,
          eventVersion: 1,
          hostId: LOCAL_HOST_ID,
          correlationId: decodeCorrelationId(this.#options.uuid()),
          actor: input.actor,
          occurredAt: recordedAt,
          payload: {
            requestId: input.requestId,
            actor: input.actor,
            hostKind: input.hostKind,
            fromVersion: input.fromVersion,
            toVersion: input.toVersion,
            ring: input.ring,
            drain: input.drain,
            step: input.step,
            outcome: input.outcome,
            ...(input.failureReason === undefined ? {} : { failureReason: input.failureReason }),
            ...(input.storeRestored === undefined ? {} : { storeRestored: input.storeRestored }),
            recordedAt,
          },
        },
      ],
    });
  }
}

function terminalResultMessage(result: HostUpdateResultFile): string {
  switch (result.outcome) {
    case "updated":
      return `Octant updated from ${result.fromVersion} to ${result.toVersion}.`;
    case "rolled-back":
      return result.storeRestored
        ? `Octant ${result.toVersion} failed its health check and rolled back to ${result.fromVersion}; the store was restored from its verified backup.`
        : `Octant ${result.toVersion} failed its health check and rolled back to ${result.fromVersion}.`;
    case "recovery-required":
      return `Octant ${result.toVersion} failed its health check and could not restore the store backup. Octant stayed stopped for manual recovery.`;
    case "failed":
      return `Octant could not update from ${result.fromVersion} to ${result.toVersion} and stayed on ${result.fromVersion}.`;
  }
}
