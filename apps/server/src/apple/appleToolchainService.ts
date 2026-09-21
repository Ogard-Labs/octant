import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, rm, stat, type FileHandle } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  decodeAppleBuildEvidence,
  decodeAppleRuntimeSnapshot,
  decodeAppleSimulatorRecord,
  decodeAppleToolchainDiscovery,
  decodeAppleWorkspaceDiscovery,
  sameToolActionAuthority,
  type AppleActionProgress,
  type AppleActionRequest,
  type AppleBuildEvidence,
  type AppleBuildRequest,
  type AppleDiscoveryRequest,
  type AppleRuntimeSnapshot,
  type AppleSimulatorRecord,
  type AppleSimulatorRequest,
  type AppleToolchainDiscovery,
  type AppleToolchainFailure,
  type AppleWorkspaceDiscovery,
  type ToolActionCancellation,
} from "@octant/contracts";
import {
  APPLE_HOST_RESTART_RECONCILIATION_NOTE,
  evaluateAppleBuildRequest,
  evaluateAppleSimulatorRequest,
  isAppleSimulatorInputKind,
  isAppleSimulatorOpenInputKind,
  redactedAppleInputDiagnostic,
  redactedAppleOpenInputDiagnostic,
  type AppleExecutionScope,
} from "@octant/domain";
import { defaultTemporaryDirectory } from "../code/repositoryTestProcessPort";
import { MAX_APPLE_ARTIFACT_BYTES } from "./appleRuntimeStore";

/**
 * Host link state `xcode-select` reads to answer where the developer directory
 * is. macOS resolves both beneath `/private`, which the confinement profile
 * denies in full, so a confined Apple command needs these two exact reads or it
 * reports "Xcode is unavailable on this host" on a machine with Xcode installed.
 */
export const APPLE_TOOLCHAIN_HOST_READ_PATHS = [
  "/private/var/select/developer_dir",
  "/private/var/db/xcode_select_link",
] as const;

export interface AppleProcessResult {
  readonly termination: "exited" | "cancelled" | "timed-out" | "unavailable";
  readonly exitCode: number | null;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly parserFailed: boolean;
  readonly cleanupUncertain: boolean;
}

export interface AppleExecutionContext extends AppleExecutionScope {
  readonly checkoutRoot: string;
  readonly artifactRoot: string;
  readonly sourceRevision: string;
}

export type AppleDiscoveryResult =
  | {
      readonly kind: "discovered";
      readonly toolchain: AppleToolchainDiscovery;
      readonly workspace: AppleWorkspaceDiscovery;
      readonly simulators: ReadonlyArray<AppleSimulatorRecord>;
    }
  | { readonly kind: "failure"; readonly failure: AppleToolchainFailure };

export interface AppleRuntimeReceipt {
  readonly actionId: string;
  readonly correlationId: string;
  readonly authority: AppleActionRequest["authority"];
  readonly threadId: string;
  readonly checkoutId: string;
  readonly kind: AppleActionRequest["kind"];
  readonly simulatorId?: string;
  bundleIdentifier?: string;
  /** Required for tap / type-text / key-press so restart replay can decode evidence. */
  readonly requestedBy?: AppleSimulatorRequest["requestedBy"];
  readonly startedAt: string;
}

export interface AppleToolchainServiceOptions {
  readonly execute: (
    input: {
      readonly argv: ReadonlyArray<string>;
      readonly cwd: string;
      readonly environment: Readonly<Record<string, string>>;
      readonly timeoutMs: number;
    },
    signal?: AbortSignal,
  ) => Promise<AppleProcessResult>;
  /**
   * Optional XCTest-less Simulator input injector. Tests and the desktop's
   * device helper supply this. When it is absent, every input kind is
   * unavailable: Octant does not script Simulator.app.
   */
  readonly injectSimulatorInput?: (
    request: AppleSimulatorRequest,
    context: AppleExecutionContext,
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<AppleProcessResult>;
  readonly realpath: (path: string) => Promise<string>;
  /**
   * Told which Simulators each successful discovery found, and in what state.
   * The host closes what it granted to a Simulator that is no longer booted,
   * however it came to shut down, including from Xcode or `simctl`.
   */
  readonly observeSimulators?: (simulators: ReadonlyArray<AppleSimulatorRecord>) => void;
  /**
   * Where a screen capture lands before it becomes an artifact. Xcode 27's
   * `simctl io … screenshot -` no longer means stdout: it writes a file named
   * `-` into the working directory — the checkout — and reports nothing, so
   * the capture names a file here instead. It must be a directory the confined
   * command may write; by default that is the process port's own temporary
   * directory.
   */
  readonly captureDirectory?: string;
  /**
   * Names this host in its capture files. Hosts started with different data
   * directories share one temporary directory, and a host may only sweep what
   * is its own: another host's old file can belong to a capture still running.
   * Stable across restarts, so a host clears what its last run left behind.
   */
  readonly captureOwner?: string;
  readonly writeArtifact?: (reference: string, bytes: Uint8Array) => Promise<void>;
  readonly readArtifact?: (reference: string) => Promise<Uint8Array | undefined>;
  readonly persistReceipts?: (receipts: ReadonlyArray<AppleRuntimeReceipt>) => Promise<void>;
  readonly now: () => string;
  readonly newId: () => string;
  /** Override for tests; production uses `process.platform`. */
  readonly platform?: NodeJS.Platform;
}

interface DiscoveryCacheEntry {
  readonly toolchain: AppleToolchainDiscovery;
  readonly workspace: AppleWorkspaceDiscovery;
  readonly simulators: ReadonlyArray<AppleSimulatorRecord>;
}

interface ActiveAction {
  readonly request: AppleActionRequest;
  readonly context: AppleExecutionContext;
  readonly controller: AbortController;
  progress: AppleActionProgress;
  readonly receipt: AppleRuntimeReceipt;
  readonly done: Promise<void>;
  readonly markDone: () => void;
}

interface RecentEvidenceEntry {
  readonly evidence: AppleBuildEvidence;
  readonly authority: AppleExecutionContext["authority"];
  readonly threadId: AppleExecutionContext["threadId"];
  readonly checkoutId: AppleExecutionContext["checkoutId"];
}

const DISCOVERY_TIMEOUT_MS = 30_000;
const MAX_DIAGNOSTICS = 64;
const MAX_DIAGNOSTIC_LENGTH = 2_048;
const MAX_RECENT_EVIDENCE = 64;

export const APPLE_INPUT_MUST_REISSUE_NOTE =
  "Interrupted or unknown Simulator input cannot be retried under the same action id. Issue a new actionId.";

function withSimulatorState(
  records: ReadonlyArray<AppleSimulatorRecord>,
  change: {
    readonly simulatorId: AppleSimulatorRecord["simulatorId"];
    readonly state: AppleSimulatorRecord["state"];
  },
): ReadonlyArray<AppleSimulatorRecord> {
  return records.map((record) =>
    record.simulatorId === change.simulatorId
      ? decodeAppleSimulatorRecord({ ...record, state: change.state })
      : record,
  );
}

export class AppleToolchainService {
  readonly #options: AppleToolchainServiceOptions;
  readonly #discovery = new Map<string, DiscoveryCacheEntry>();
  readonly #active = new Map<string, ActiveAction>();
  readonly #recent: RecentEvidenceEntry[] = [];
  #receiptWrites: Promise<void> = Promise.resolve();
  #sequence = 0;
  #lastToolchain: AppleToolchainDiscovery;
  #lastSimulators: ReadonlyArray<AppleSimulatorRecord> = [];
  readonly #captureDirectory: string;
  readonly #capturePrefix: string;
  /**
   * The last requested pane for each task. Concurrent tasks cannot replace
   * one another's requests; snapshot checkout checks keep requests scoped.
   */
  readonly #paneOpenRequests = new Map<
    string,
    {
      readonly threadId: AppleExecutionContext["threadId"];
      readonly checkoutId: AppleExecutionContext["checkoutId"];
      readonly requestId: string;
      readonly simulatorId: AppleSimulatorRecord["simulatorId"];
      readonly projectPath?: AppleWorkspaceDiscovery["projectPath"];
      readonly requestedAt: string;
    }
  >();
  // Files a running capture owns. A capture may run for minutes, so its file's
  // age says nothing about whether it was abandoned; only this does. Shared by
  // every service in the process: a replaced service's later sweeps would
  // otherwise judge the new service's running capture by age alone.
  readonly #capturesInProgress = capturesInProgress;
  // States an action set while a discovery was reading. A discovery lists the
  // devices and then probes the project, which can take seconds; a boot or
  // shutdown that finishes in between is newer than that list and must not be
  // put back by it.
  #stateChangesDuringDiscovery: Array<{
    readonly simulatorId: AppleSimulatorRecord["simulatorId"];
    readonly state: AppleSimulatorRecord["state"];
  }> = [];
  #discoveriesReading = 0;

  constructor(options: AppleToolchainServiceOptions) {
    this.#options = options;
    this.#captureDirectory = options.captureDirectory ?? defaultTemporaryDirectory();
    const owner = (options.captureOwner ?? "local").replace(/[^A-Za-z0-9]/g, "").slice(0, 32);
    this.#capturePrefix = `${CAPTURE_FILE_PREFIX}${owner.length === 0 ? "local" : owner}-`;
    // Whatever a previous run could not come back for is cleared now, and
    // again later: a leftover seconds old at start is too young to judge, the
    // run that made it is gone with its timers, and no capture is promised.
    for (const delayMs of [0, ...CAPTURE_RETURN_VISITS_MS]) {
      setTimeout(() => {
        void sweepStaleCaptures(
          this.#captureDirectory,
          this.#capturePrefix,
          Date.now(),
          this.#capturesInProgress,
        );
      }, delayMs).unref();
    }
    this.#lastToolchain = unavailableToolchain(options.newId(), options.now());
  }

  async discover(
    request: AppleDiscoveryRequest,
    context: AppleExecutionContext,
  ): Promise<AppleDiscoveryResult> {
    if (this.#discoveriesReading === 0) this.#stateChangesDuringDiscovery = [];
    this.#discoveriesReading += 1;
    try {
      return await this.#discover(request, context);
    } finally {
      this.#discoveriesReading -= 1;
    }
  }

  async #discover(
    request: AppleDiscoveryRequest,
    context: AppleExecutionContext,
  ): Promise<AppleDiscoveryResult> {
    if (!authorizedDiscovery(request, context)) return unauthorizedFailure();
    let projectPath: string;
    try {
      projectPath = await confinedProjectPath(
        context.checkoutRoot,
        request.projectPath,
        this.#options.realpath,
      );
    } catch {
      return invalidFailure("Apple project selection is unavailable.");
    }

    const developer = await this.#command(["xcode-select", "-p"], context, DISCOVERY_TIMEOUT_MS);
    if (!succeeded(developer)) {
      this.#lastToolchain = unavailableToolchain(this.#options.newId(), this.#options.now());
      this.#lastSimulators = [];
      return {
        kind: "failure",
        failure: { category: "xcode-not-found", message: "Xcode is unavailable on this host." },
      };
    }
    const version = await this.#command(["xcodebuild", "-version"], context, DISCOVERY_TIMEOUT_MS);
    const swift = await this.#command(["swift", "--version"], context, DISCOVERY_TIMEOUT_MS);
    const sdks = await this.#command(["xcodebuild", "-showsdks"], context, DISCOVERY_TIMEOUT_MS);
    const changesBeforeDeviceList = this.#stateChangesDuringDiscovery.length;
    const devices = await this.#command(
      ["xcrun", "simctl", "list", "devices", "available", "--json"],
      context,
      DISCOVERY_TIMEOUT_MS,
    );
    const project = await this.#command(
      ["xcodebuild", projectSelector(request.projectPath), projectPath, "-list", "-json"],
      context,
      DISCOVERY_TIMEOUT_MS,
    );
    if (![version, swift, sdks, devices, project].every(succeeded)) {
      return {
        kind: "failure",
        failure: {
          category: "unavailable",
          message: "Apple project discovery is incomplete on this host.",
        },
      };
    }

    const toolchain = decodeAppleToolchainDiscovery({
      toolchainId: this.#options.newId(),
      xcodeVersion: parseXcodeVersion(text(version.stdout)),
      xcodePath: xcodeApplicationPath(text(developer.stdout).trim()),
      developerDirectory: text(developer.stdout).trim(),
      swiftVersion: parseSwiftVersion(text(swift.stdout)),
      sdks: parseSdks(text(sdks.stdout)),
      available: true,
      discoveredAt: this.#options.now(),
    });
    const simulators = this.#stateChangesDuringDiscovery
      .slice(changesBeforeDeviceList)
      .reduce(withSimulatorState, parseSimulators(text(devices.stdout)));
    let metadata: ReturnType<typeof parseProjectMetadata>;
    try {
      metadata = parseProjectMetadata(text(project.stdout));
    } catch {
      return invalidFailure("Apple project metadata is invalid.");
    }
    const workspace = decodeAppleWorkspaceDiscovery({
      actionId: request.actionId,
      correlationId: request.correlationId,
      authority: request.authority,
      projectPath: request.projectPath,
      projectKind: projectKind(request.projectPath),
      ...metadata,
      sourceRevision: context.sourceRevision,
      discoveredAt: this.#options.now(),
    });
    const entry = { toolchain, workspace, simulators };
    this.#discovery.set(
      discoveryKey(request.threadId, request.checkoutId, request.projectPath),
      entry,
    );
    this.#lastToolchain = toolchain;
    this.#lastSimulators = simulators;
    this.#options.observeSimulators?.(simulators);
    this.#sequence += 1;
    return { kind: "discovered", ...entry };
  }

  async execute(
    request: AppleBuildRequest | AppleSimulatorRequest,
    context: AppleExecutionContext,
  ): Promise<AppleBuildEvidence> {
    const startedAt = this.#options.now();
    if (
      !isBuildRequest(request) &&
      (isAppleSimulatorInputKind(request.kind) || isAppleSimulatorOpenInputKind(request.kind))
    ) {
      const prior = this.#findCompletedInput(request, context);
      if (prior !== undefined) return replayedFrom(prior);
    }
    const cached = this.#findDiscovery(request);
    const decision = isBuildRequest(request)
      ? evaluateAppleBuildRequest(
          request,
          cached?.toolchain ?? this.#lastToolchain,
          context,
          cached?.simulators ?? this.#lastSimulators,
        )
      : evaluateAppleSimulatorRequest(request, context, cached?.simulators ?? this.#lastSimulators);
    if (decision.kind === "denied") {
      return this.#record(
        evidenceForDenied(request, decision.reason, startedAt, this.#options.now()),
        context,
      );
    }
    if (request.kind === "archive") {
      return this.#record(
        evidence(request, "unavailable", startedAt, this.#options.now(), [], [], "not-required"),
        context,
      );
    }

    const controller = new AbortController();
    const active = this.#activate(request, context, controller, startedAt);
    try {
      await this.#persistReceipts();
      const result = await this.#run(request, context, controller.signal, active);
      const completed = this.#record(result, context);
      return completed;
    } finally {
      this.#active.delete(String(request.actionId));
      try {
        await this.#persistReceipts();
      } finally {
        active.markDone();
      }
    }
  }

  async cancel(
    cancellation: ToolActionCancellation,
    context: AppleExecutionContext,
  ): Promise<boolean> {
    const active = this.#active.get(String(cancellation.actionId));
    if (
      active === undefined ||
      cancellation.correlationId !== active.request.correlationId ||
      !sameToolActionAuthority(cancellation.authority, active.request.authority) ||
      !sameToolActionAuthority(context.authority, active.context.authority) ||
      context.threadId !== active.context.threadId ||
      context.checkoutId !== active.context.checkoutId
    ) {
      return false;
    }
    active.controller.abort();
    return true;
  }

  async readScreenshotArtifact(
    reference: string,
    context: AppleExecutionContext,
  ): Promise<
    | { readonly kind: "found"; readonly bytes: Uint8Array }
    | { readonly kind: "unavailable"; readonly message: string }
    | { readonly kind: "unauthorized"; readonly message: string }
  > {
    const allowed = this.#recent.some(
      (entry) =>
        recentEvidenceMatches(entry, context) &&
        entry.evidence.artifacts.some(
          (artifact) => artifact.kind === "screenshot" && artifact.reference === reference,
        ),
    );
    if (!allowed) {
      return {
        kind: "unauthorized",
        message: "Apple screenshot evidence is not available for this thread.",
      };
    }
    const bytes = await this.#options.readArtifact?.(reference);
    if (bytes === undefined) {
      return {
        kind: "unavailable",
        message: "Apple screenshot evidence is no longer available on this host.",
      };
    }
    return { kind: "found", bytes };
  }

  snapshot(context: AppleExecutionContext): AppleRuntimeSnapshot {
    const paneOpenRequest = this.#paneOpenRequests.get(String(context.threadId));
    return decodeAppleRuntimeSnapshot({
      sequence: this.#sequence,
      snapshotAt: this.#options.now(),
      toolchain: this.#lastToolchain,
      simulators: this.#lastSimulators,
      active: [...this.#active.values()]
        .filter((active) => contextMatches(active.context, context))
        .map(({ progress }) => progress),
      recentEvidence: this.#recent
        .filter((entry) => recentEvidenceMatches(entry, context))
        .map(({ evidence }) => evidence),
      ...(paneOpenRequest !== undefined &&
      paneOpenRequest.threadId === context.threadId &&
      paneOpenRequest.checkoutId === context.checkoutId
        ? {
            paneOpenRequest: {
              requestId: paneOpenRequest.requestId,
              simulatorId: paneOpenRequest.simulatorId,
              ...(paneOpenRequest.projectPath === undefined
                ? {}
                : { projectPath: paneOpenRequest.projectPath }),
              requestedAt: paneOpenRequest.requestedAt,
            },
          }
        : {}),
    });
  }

  /**
   * Asks the renderer to show this Simulator in the in-app pane. The request
   * is host memory only: it is not journaled, and a restart forgets it.
   */
  requestPaneOpen(
    context: AppleExecutionContext,
    simulatorId: AppleSimulatorRecord["simulatorId"],
  ): AppleRuntimeSnapshot {
    const projectPath = this.#findDiscovery(context)?.workspace.projectPath;
    this.#paneOpenRequests.set(String(context.threadId), {
      threadId: context.threadId,
      checkoutId: context.checkoutId,
      requestId: this.#options.newId(),
      simulatorId,
      ...(projectPath === undefined ? {} : { projectPath }),
      requestedAt: this.#options.now(),
    });
    this.#sequence += 1;
    return this.snapshot(context);
  }

  async reconcileAfterRestart(
    receipts: ReadonlyArray<AppleRuntimeReceipt>,
    context: AppleExecutionContext,
  ): Promise<ReadonlyArray<AppleBuildEvidence>> {
    const reconciled: AppleBuildEvidence[] = [];
    for (const receipt of receipts) {
      if (
        !sameToolActionAuthority(receipt.authority, context.authority) ||
        receipt.threadId !== context.threadId ||
        receipt.checkoutId !== context.checkoutId
      ) {
        continue;
      }
      let cleanup: AppleBuildEvidence["cleanup"] = "not-required";
      if (
        receipt.kind === "run" &&
        receipt.simulatorId !== undefined &&
        receipt.bundleIdentifier !== undefined
      ) {
        const result = await this.#options.execute(
          {
            argv: ["xcrun", "simctl", "terminate", receipt.simulatorId, receipt.bundleIdentifier],
            cwd: context.checkoutRoot,
            environment: {},
            timeoutMs: 30_000,
          },
          undefined,
        );
        cleanup = succeeded(result) && !result.cleanupUncertain ? "complete" : "uncertain";
      }
      const result = decodeAppleBuildEvidence({
        actionId: receipt.actionId,
        correlationId: receipt.correlationId,
        authority: receipt.authority,
        kind: receipt.kind,
        outcome: "interrupted",
        ...(receipt.simulatorId === undefined ? {} : { simulatorId: receipt.simulatorId }),
        ...(receipt.requestedBy === undefined ? {} : { requestedBy: receipt.requestedBy }),
        diagnostics: [
          {
            severity: "note",
            message: APPLE_HOST_RESTART_RECONCILIATION_NOTE,
          },
        ],
        artifacts: [],
        cleanup,
        durationMs: elapsed(receipt.startedAt, this.#options.now()),
        completedAt: this.#options.now(),
      });
      reconciled.push(this.#record(result, context));
    }
    await this.#options.persistReceipts?.([]);
    return reconciled;
  }

  async close(): Promise<void> {
    const activeActions = [...this.#active.values()];
    for (const active of activeActions) active.controller.abort();
    await Promise.allSettled(activeActions.map(({ done }) => done));
  }

  #findDiscovery(
    request: Pick<AppleActionRequest, "threadId" | "checkoutId"> & {
      readonly projectPath?: string;
    },
  ): DiscoveryCacheEntry | undefined {
    if (request.projectPath !== undefined) {
      return this.#discovery.get(
        discoveryKey(request.threadId, request.checkoutId, request.projectPath),
      );
    }
    const prefix = `${request.threadId}:${request.checkoutId}:`;
    return [...this.#discovery.entries()].find(([key]) => key.startsWith(prefix))?.[1];
  }

  #activate(
    request: AppleActionRequest,
    context: AppleExecutionContext,
    controller: AbortController,
    startedAt: string,
  ): ActiveAction {
    if (this.#active.has(String(request.actionId)))
      throw new Error("Apple action is already active.");
    const progress = this.#progress(request, "queued", "authorizing");
    const receipt: AppleRuntimeReceipt = {
      actionId: request.actionId,
      correlationId: request.correlationId,
      authority: request.authority,
      threadId: request.threadId,
      checkoutId: request.checkoutId,
      kind: request.kind,
      ...(request.simulatorId === undefined ? {} : { simulatorId: request.simulatorId }),
      ...(!("bundleIdentifier" in request) || request.bundleIdentifier === undefined
        ? {}
        : { bundleIdentifier: request.bundleIdentifier }),
      ...(!("requestedBy" in request) || request.requestedBy === undefined
        ? {}
        : { requestedBy: request.requestedBy }),
      startedAt,
    };
    let markDone = () => {};
    const done = new Promise<void>((resolveDone) => {
      markDone = resolveDone;
    });
    const active = { request, context, controller, progress, receipt, done, markDone };
    this.#active.set(String(request.actionId), active);
    return active;
  }

  async #run(
    request: AppleActionRequest,
    context: AppleExecutionContext,
    signal: AbortSignal,
    active: ActiveAction,
  ): Promise<AppleBuildEvidence> {
    const startedAt = active.receipt.startedAt;
    const outputs: Uint8Array[] = [];
    let artifacts: AppleBuildEvidence["artifacts"] = [];
    let cleanup: AppleBuildEvidence["cleanup"] = "complete";
    let terminal: AppleProcessResult;
    try {
      if (request.kind === "boot") {
        this.#advance(active, "preparing-destination");
        const previous = this.#simulatorState(request.simulatorId);
        this.#setSimulatorState(request.simulatorId, "booting");
        try {
          terminal = await this.#command(
            ["xcrun", "simctl", "boot", request.simulatorId],
            context,
            request.timeoutMs,
            signal,
          );
          if (succeeded(terminal)) {
            terminal = await this.#command(
              ["xcrun", "simctl", "bootstatus", request.simulatorId, "-b"],
              context,
              request.timeoutMs,
              signal,
            );
          }
          this.#settleBoot(request.simulatorId, previous, succeeded(terminal));
        } catch (error) {
          this.#settleBoot(request.simulatorId, previous, false);
          throw error;
        }
      } else if (request.kind === "shutdown") {
        this.#advance(active, "cleaning-up");
        terminal = await this.#command(
          ["xcrun", "simctl", "shutdown", request.simulatorId],
          context,
          request.timeoutMs,
          signal,
        );
      } else if (request.kind === "terminate") {
        this.#advance(active, "terminating");
        terminal = await this.#command(
          ["xcrun", "simctl", "terminate", request.simulatorId, request.bundleIdentifier!],
          context,
          request.timeoutMs,
          signal,
        );
      } else if (request.kind === "screenshot") {
        this.#advance(active, "capturing-screen");
        // A capture whose process outlived its timeout can write its file after
        // this action already removed it; the next capture clears what is left.
        await sweepStaleCaptures(
          this.#captureDirectory,
          this.#capturePrefix,
          Date.now(),
          this.#capturesInProgress,
        );
        // One file per attempt, not per action: a retry of a capture whose
        // first process is still alive would otherwise share its path, and the
        // two writers would race for the file the retry then reads.
        const capturePath = join(
          this.#captureDirectory,
          `${this.#capturePrefix}${request.actionId}-${randomUUID()}.png`,
        );
        this.#capturesInProgress.add(capturePath);
        let exitedCleanly = false;
        // Whatever happens to the command, the read or the artifact write, the
        // raw screen must not stay behind in the temporary directory.
        try {
          terminal = await this.#command(
            [
              "xcrun",
              "simctl",
              "io",
              request.simulatorId,
              "screenshot",
              "--type",
              "png",
              capturePath,
            ],
            context,
            request.timeoutMs,
            signal,
          );
          exitedCleanly = terminal.termination === "exited" && !terminal.cleanupUncertain;
          if (succeeded(terminal)) {
            const bytes = await readCapture(capturePath);
            if (bytes === undefined) {
              // simctl exited 0 without the file it was asked for: an empty
              // frame would render as nothing and taps on it would be dropped.
              terminal = {
                ...terminal,
                exitCode: 1,
                stderr: appendLine(terminal.stderr, "simctl reported a capture but wrote no PNG."),
              };
            } else {
              const screenshotReference = `apple-screenshot-${request.actionId}`;
              await this.#writeArtifact(screenshotReference, [bytes]);
              artifacts = [{ kind: "screenshot", reference: screenshotReference }];
            }
          }
        } finally {
          this.#capturesInProgress.delete(capturePath);
          // A removal that fails must not throw past this action: that turned a
          // known result into "interrupted". It counts as unconfirmed instead,
          // so the return visits below still come back for the path.
          await rm(capturePath, { force: true }).catch(() => {
            exitedCleanly = false;
          });
          // A command that did not end as a confirmed clean exit may still have
          // a process out there, and it can write the file after the removal
          // above. No later capture is promised, so this action comes back for
          // its own file, later each time; the timers never keep the host alive.
          // A host restart in between is covered by the sweep at start.
          if (!exitedCleanly) {
            for (const delayMs of CAPTURE_RETURN_VISITS_MS) {
              setTimeout(() => {
                // A retry under the same action id reuses this path; while it
                // runs the file is its own, and its `finally` removes it.
                if (this.#capturesInProgress.has(capturePath)) return;
                // Nothing awaits this; a path that cannot be removed is left to
                // the next sweep instead of becoming an unhandled rejection.
                void rm(capturePath, { force: true }).catch(() => undefined);
              }, delayMs).unref();
            }
          }
        }
      } else if (!isBuildRequest(request) && isAppleSimulatorOpenInputKind(request.kind)) {
        // Allow input opens the grant on the host; this action itself injects
        // nothing, so it must not wait on a helper the destination does not need.
        this.#advance(active, "completed", "completed");
        const note = redactedAppleOpenInputDiagnostic();
        const logReference = `apple-log-${request.actionId}`;
        await this.#writeArtifact(logReference, [new TextEncoder().encode(`${note.message}\n`)]);
        return evidence(
          request,
          "succeeded",
          startedAt,
          this.#options.now(),
          [note],
          [{ kind: "log", reference: logReference }],
          "not-required",
        );
      } else if (request.kind === "logs") {
        this.#advance(active, "collecting-logs");
        terminal = await this.#command(
          [
            "xcrun",
            "simctl",
            "spawn",
            request.simulatorId,
            "log",
            "show",
            "--style",
            "json",
            "--last",
            "5m",
            "--predicate",
            `process == "${request.bundleIdentifier}"`,
          ],
          context,
          request.timeoutMs,
          signal,
        );
      } else if (!isBuildRequest(request) && isAppleSimulatorInputKind(request.kind)) {
        this.#advance(active, "injecting-input");
        terminal = await this.#injectInput(request, context, signal);
        // Typed text must never land in stdout/stderr artifacts or diagnostics.
        // Success is verified by a later screenshot, log, or assertion.
        const note = succeeded(terminal)
          ? redactedAppleInputDiagnostic(request)
          : {
              severity: "note" as const,
              message:
                request.kind === "type-text"
                  ? typedTextFailureNote(outcomeFor(terminal), text(terminal.stderr))
                  : inputFailureNote(request, outcomeFor(terminal), text(terminal.stderr), context),
            };
        cleanup = terminal.cleanupUncertain ? "uncertain" : "complete";
        const logReference = `apple-log-${request.actionId}`;
        await this.#writeArtifact(logReference, [new TextEncoder().encode(`${note.message}\n`)]);
        artifacts = [{ kind: "log", reference: logReference }];
        this.#advance(active, "completed", "completed");
        return evidence(
          request,
          outcomeFor(terminal),
          startedAt,
          this.#options.now(),
          [note],
          artifacts,
          cleanup,
        );
      } else if (isBuildRequest(request)) {
        const projectPath = await confinedProjectPath(
          context.checkoutRoot,
          request.projectPath,
          this.#options.realpath,
        );
        this.#advance(active, request.kind === "test" ? "testing" : "building");
        const resultBundle = resolve(context.artifactRoot, `apple-${request.actionId}.xcresult`);
        let readiness: AppleProcessResult | undefined;
        if (request.kind === "run" && request.simulatorId !== undefined) {
          this.#advance(active, "preparing-destination");
          readiness = await this.#ensureSimulatorBooted(
            request.simulatorId,
            context,
            request.timeoutMs,
            signal,
          );
        }
        terminal =
          readiness !== undefined && !succeeded(readiness)
            ? readiness
            : await this.#command(
                xcodebuildCommand(request, projectPath, context.artifactRoot, resultBundle),
                context,
                request.timeoutMs,
                signal,
              );
        if (request.kind === "test") {
          artifacts = [{ kind: "xcresult", reference: `apple-xcresult-${request.actionId}` }];
        }
        if (request.kind === "run" && succeeded(terminal)) {
          const settings = await this.#command(
            xcodebuildSettingsCommand(request, projectPath, context.artifactRoot),
            context,
            request.timeoutMs,
            signal,
          );
          terminal = settings;
          if (succeeded(settings)) {
            const product = parseBuildProduct(text(settings.stdout), context.artifactRoot);
            this.#advance(active, "installing");
            terminal = await this.#command(
              ["xcrun", "simctl", "install", request.simulatorId!, product.applicationPath],
              context,
              request.timeoutMs,
              signal,
            );
            if (succeeded(terminal)) {
              this.#advance(active, "launching");
              terminal = await this.#command(
                [
                  "xcrun",
                  "simctl",
                  "launch",
                  "--terminate-running-process",
                  request.simulatorId!,
                  product.bundleIdentifier,
                ],
                context,
                request.timeoutMs,
                signal,
              );
              active.receipt.bundleIdentifier = product.bundleIdentifier;
              await this.#persistReceipts();
              artifacts = [
                { kind: "application", reference: `apple-application-${request.actionId}` },
              ];
            }
          }
        }
      } else {
        throw new Error("Apple action kind is unsupported.");
      }
      outputs.push(terminal.stdout, terminal.stderr);
      if (succeeded(terminal) && request.kind === "shutdown") {
        this.#setSimulatorState(request.simulatorId, "shutdown");
      }
      cleanup = terminal.cleanupUncertain ? "uncertain" : "complete";
      const logReference = `apple-log-${request.actionId}`;
      await this.#writeArtifact(logReference, outputs);
      artifacts = [{ kind: "log", reference: logReference }, ...artifacts];
      this.#advance(active, "completed", "completed");
      return evidence(
        request,
        outcomeFor(terminal),
        startedAt,
        this.#options.now(),
        diagnosticsFor(outputs, context),
        artifacts,
        cleanup,
      );
    } catch (error) {
      // Whatever threw is the reason this action has no evidence; dropping it
      // left the person with "interrupted" and an empty log. Typed text never
      // enters the note: an error raised on a type-text path can quote the
      // script, so that kind records the fact without the detail.
      const note = unrecordedActionNote(request, error, context);
      // Read before the note joins the log: with no other output the note
      // would be picked up as the log's last line and listed twice.
      const diagnostics = [
        ...diagnosticsFor(outputs, context).slice(0, MAX_DIAGNOSTICS - 1),
        { severity: "note" as const, message: note },
      ];
      outputs.push(new TextEncoder().encode(`${note}\n`));
      const logReference = `apple-log-${request.actionId}`;
      await this.#writeArtifact(logReference, outputs);
      return evidence(
        request,
        signal.aborted ? "cancelled" : "interrupted",
        startedAt,
        this.#options.now(),
        diagnostics,
        [{ kind: "log", reference: logReference }],
        "uncertain",
      );
    }
  }

  async #command(
    argv: ReadonlyArray<string>,
    context: AppleExecutionContext,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<AppleProcessResult> {
    return await this.#options.execute(
      { argv, cwd: context.checkoutRoot, environment: {}, timeoutMs },
      signal,
    );
  }

  async #ensureSimulatorBooted(
    simulatorId: AppleSimulatorRecord["simulatorId"],
    context: AppleExecutionContext,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<AppleProcessResult> {
    let result = await this.#command(
      ["xcrun", "simctl", "bootstatus", simulatorId, "-b"],
      context,
      timeoutMs,
      signal,
    );
    if (succeeded(result)) {
      this.#setSimulatorState(simulatorId, "booted");
      return result;
    }
    const previous = this.#simulatorState(simulatorId);
    this.#setSimulatorState(simulatorId, "booting");
    try {
      result = await this.#command(
        ["xcrun", "simctl", "boot", simulatorId],
        context,
        timeoutMs,
        signal,
      );
      if (!succeeded(result)) {
        this.#settleBoot(simulatorId, previous, false);
        return result;
      }
      result = await this.#command(
        ["xcrun", "simctl", "bootstatus", simulatorId, "-b"],
        context,
        timeoutMs,
        signal,
      );
      this.#settleBoot(simulatorId, previous, succeeded(result));
      return result;
    } catch (error) {
      this.#settleBoot(simulatorId, previous, false);
      throw error;
    }
  }

  #findCompletedInput(
    request: AppleSimulatorRequest,
    context: AppleExecutionContext,
  ): AppleBuildEvidence | undefined {
    for (let index = this.#recent.length - 1; index >= 0; index -= 1) {
      const entry = this.#recent[index];
      if (entry === undefined) continue;
      if (String(entry.evidence.actionId) !== String(request.actionId)) continue;
      if (!recentEvidenceMatches(entry, context)) continue;
      if (entry.evidence.kind !== request.kind) continue;
      // A finished actionId returns stored evidence and never re-injects.
      // Interrupted evidence also refuses re-exec so callers mint a new actionId.
      if (entry.evidence.outcome === "interrupted") {
        return withInputMustReissueNote(entry.evidence);
      }
      return entry.evidence;
    }
    return undefined;
  }

  async #injectInput(
    request: AppleSimulatorRequest,
    context: AppleExecutionContext,
    signal: AbortSignal,
  ): Promise<AppleProcessResult> {
    const inject = this.#options.injectSimulatorInput;
    if (inject !== undefined) {
      return this.#runInjectedInput(
        (bounded) => inject(request, context, request.timeoutMs, bounded),
        request.timeoutMs,
        signal,
      );
    }
    const platform = this.#options.platform ?? process.platform;
    if (platform !== "darwin") {
      return unavailableInputResult(
        "Simulator input injection is unavailable on this host. Open the thread on the Mac that owns the destination.",
      );
    }
    return unavailableInputResult(
      "Simulator input needs the Octant desktop app's device helper. This host has none, and input never activates Simulator.app.",
    );
  }

  /**
   * Bound a host adapter the same way `#command` bounds a process: a
   * non-settling injector must not leave the action stuck in `#active`.
   */
  async #runInjectedInput(
    run: (signal: AbortSignal) => Promise<AppleProcessResult>,
    timeoutMs: number,
    parent: AbortSignal,
  ): Promise<AppleProcessResult> {
    const cancelledClean: AppleProcessResult = {
      termination: "cancelled",
      exitCode: null,
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
      parserFailed: false,
      cleanupUncertain: false,
    };
    // Race cancel/timeout can win before the adapter settles, so input may still
    // apply afterward — mark cleanup uncertain rather than claiming a clean stop.
    const cancelledUncertain: AppleProcessResult = {
      ...cancelledClean,
      cleanupUncertain: true,
    };
    const timedOut: AppleProcessResult = {
      termination: "timed-out",
      exitCode: null,
      stdout: new Uint8Array(),
      stderr: new TextEncoder().encode("Simulator input injection timed out."),
      parserFailed: false,
      cleanupUncertain: true,
    };
    if (parent.aborted) return cancelledClean;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const deadline = new Promise<AppleProcessResult>((resolve) => {
      timer = setTimeout(() => {
        // Resolve first so Promise.race prefers timedOut over an abort-responsive
        // adapter that would otherwise return exited-success in the same turn.
        resolve(timedOut);
        controller.abort(new Error("deadline-exceeded"));
      }, timeoutMs);
      parent.addEventListener(
        "abort",
        () => {
          resolve(cancelledUncertain);
          controller.abort(parent.reason);
        },
        { once: true },
      );
    });

    try {
      // Race so an injector that ignores abort cannot hold `#active` open, and
      // a late success after the deadline cannot become succeeded evidence.
      return await Promise.race([run(controller.signal), deadline]);
    } catch (error) {
      if (parent.aborted) return cancelledUncertain;
      if (controller.signal.aborted) return timedOut;
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  #progress(
    request: AppleActionRequest,
    state: AppleActionProgress["state"],
    step: AppleActionProgress["step"],
  ): AppleActionProgress {
    this.#sequence += 1;
    return {
      actionId: request.actionId,
      correlationId: request.correlationId,
      authority: request.authority,
      kind: request.kind,
      state,
      step,
      sequence: this.#sequence,
      updatedAt: this.#options.now() as AppleActionProgress["updatedAt"],
    };
  }

  #advance(
    active: ActiveAction,
    step: AppleActionProgress["step"],
    state: AppleActionProgress["state"] = "running",
  ): void {
    active.progress = this.#progress(active.request, state, step);
  }

  #record(value: AppleBuildEvidence, context: AppleExecutionContext): AppleBuildEvidence {
    this.#recent.push({
      evidence: value,
      authority: context.authority,
      threadId: context.threadId,
      checkoutId: context.checkoutId,
    });
    if (this.#recent.length > MAX_RECENT_EVIDENCE) this.#recent.shift();
    this.#sequence += 1;
    return value;
  }

  async #writeArtifact(reference: string, chunks: ReadonlyArray<Uint8Array>): Promise<void> {
    if (this.#options.writeArtifact === undefined) return;
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    await this.#options.writeArtifact(reference, new Uint8Array(bytes));
  }

  #simulatorState(
    simulatorId: AppleSimulatorRecord["simulatorId"],
  ): AppleSimulatorRecord["state"] | undefined {
    return this.#lastSimulators.find((record) => String(record.simulatorId) === String(simulatorId))
      ?.state;
  }

  /**
   * The in-app pane treats booting as in-flight and offers Boot only from
   * shutdown. A failed, cancelled, or timed-out boot must not leave the
   * destination stuck, or a retry is refused as destination-not-shutdown.
   */
  #settleBoot(
    simulatorId: AppleSimulatorRecord["simulatorId"],
    previous: AppleSimulatorRecord["state"] | undefined,
    ready: boolean,
  ): void {
    this.#setSimulatorState(simulatorId, ready ? "booted" : (previous ?? "shutdown"));
  }

  #setSimulatorState(
    simulatorId: AppleSimulatorRecord["simulatorId"],
    state: AppleSimulatorRecord["state"],
  ): void {
    const update = (records: ReadonlyArray<AppleSimulatorRecord>) =>
      withSimulatorState(records, { simulatorId, state });
    if (this.#discoveriesReading > 0) {
      this.#stateChangesDuringDiscovery.push({ simulatorId, state });
    }
    this.#lastSimulators = update(this.#lastSimulators);
    for (const [key, entry] of this.#discovery) {
      this.#discovery.set(key, { ...entry, simulators: update(entry.simulators) });
    }
  }

  async #persistReceipts(): Promise<void> {
    if (this.#options.persistReceipts === undefined) return;
    const receipts = [...this.#active.values()].map(({ receipt }) => ({ ...receipt }));
    const write = this.#receiptWrites.then(async () => {
      await this.#options.persistReceipts?.(receipts);
    });
    this.#receiptWrites = write.catch(() => undefined);
    await write;
  }
}

function authorizedDiscovery(
  request: AppleDiscoveryRequest,
  context: AppleExecutionContext,
): boolean {
  return (
    request.authority.extension.kind === "core" &&
    request.authority.mode === "code" &&
    sameToolActionAuthority(request.authority, context.authority) &&
    request.threadId === context.threadId &&
    request.checkoutId === context.checkoutId
  );
}

function contextMatches(left: AppleExecutionContext, right: AppleExecutionContext): boolean {
  return (
    sameToolActionAuthority(left.authority, right.authority) &&
    left.threadId === right.threadId &&
    left.checkoutId === right.checkoutId
  );
}

function recentEvidenceMatches(
  entry: RecentEvidenceEntry,
  context: AppleExecutionContext,
): boolean {
  return (
    sameToolActionAuthority(entry.authority, context.authority) &&
    entry.threadId === context.threadId &&
    entry.checkoutId === context.checkoutId
  );
}

function isBuildRequest(request: AppleActionRequest): request is AppleBuildRequest {
  return (
    request.kind === "build" ||
    request.kind === "test" ||
    request.kind === "run" ||
    request.kind === "clean" ||
    request.kind === "archive"
  );
}

async function confinedProjectPath(
  checkoutRoot: string,
  projectPath: string,
  realpath: (path: string) => Promise<string>,
): Promise<string> {
  if (isAbsolute(projectPath)) throw new Error("absolute path denied");
  const canonicalRoot = await realpath(checkoutRoot);
  const candidate = await realpath(resolve(canonicalRoot, projectPath));
  const fromRoot = relative(canonicalRoot, candidate);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error("project path outside checkout");
  }
  return candidate;
}

function projectSelector(path: string): "-project" | "-workspace" | "-packagePath" {
  if (path.endsWith(".xcworkspace")) return "-workspace";
  if (path.endsWith("Package.swift")) return "-packagePath";
  return "-project";
}

function projectKind(path: string): AppleWorkspaceDiscovery["projectKind"] {
  if (path.endsWith(".xcworkspace")) return "xcode-workspace";
  if (path.endsWith("Package.swift")) return "swift-package";
  return "xcode-project";
}

function parseXcodeVersion(output: string): string {
  return /^Xcode\s+([^\s]+)/m.exec(output)?.[1] ?? "unknown";
}

function parseSwiftVersion(output: string): string {
  return /Swift version\s+([^\s]+)/i.exec(output)?.[1] ?? "unknown";
}

function xcodeApplicationPath(developerDirectory: string): string | undefined {
  const suffix = "/Contents/Developer";
  return developerDirectory.endsWith(suffix)
    ? developerDirectory.slice(0, -suffix.length)
    : undefined;
}

function parseSdks(output: string): AppleToolchainDiscovery["sdks"] {
  const records: Array<NonNullable<AppleToolchainDiscovery["sdks"]>[number]> = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^(.+?)\s+-sdk\s+([A-Za-z]+)([0-9][A-Za-z0-9.]*)$/.exec(line.trim());
    if (match === null) continue;
    const canonicalName = `${match[2]}${match[3]}`;
    records.push({
      canonicalName,
      displayName: match[1]!,
      platform: platformForSdk(canonicalName),
      version: match[3]!,
    });
  }
  return records;
}

function platformForSdk(canonicalName: string): "ios" | "macos" | "watchos" | "tvos" | "visionos" {
  const lower = canonicalName.toLowerCase();
  if (lower.startsWith("macosx")) return "macos";
  if (lower.startsWith("watch")) return "watchos";
  if (lower.startsWith("appletv")) return "tvos";
  if (lower.startsWith("xros")) return "visionos";
  return "ios";
}

function parseSimulators(output: string): ReadonlyArray<AppleSimulatorRecord> {
  const parsed = JSON.parse(output) as { readonly devices?: Record<string, ReadonlyArray<any>> };
  const records: AppleSimulatorRecord[] = [];
  for (const [runtime, devices] of Object.entries(parsed.devices ?? {})) {
    const platform = platformForRuntime(runtime);
    const runtimeVersion = runtimeVersionFor(runtime);
    for (const device of devices) {
      if (typeof device?.udid !== "string" || typeof device?.name !== "string") continue;
      records.push(
        decodeAppleSimulatorRecord({
          simulatorId: simulatorId(device.udid),
          name: device.name,
          platform,
          runtimeVersion,
          state: simulatorState(device.state, device.isAvailable),
          udid: device.udid,
        }),
      );
    }
  }
  return records;
}

function platformForRuntime(runtime: string): "ios" | "macos" | "watchos" | "tvos" | "visionos" {
  if (runtime.includes("watchOS")) return "watchos";
  if (runtime.includes("tvOS")) return "tvos";
  if (runtime.includes("visionOS")) return "visionos";
  if (runtime.includes("macOS")) return "macos";
  return "ios";
}

function runtimeVersionFor(runtime: string): string {
  const match = /(?:iOS|watchOS|tvOS|visionOS|macOS)-([0-9-]+)$/.exec(runtime);
  return match?.[1]?.replaceAll("-", ".") ?? "unknown";
}

function simulatorState(state: unknown, available: unknown) {
  if (available === false) return "unavailable" as const;
  switch (state) {
    case "Booted":
      return "booted" as const;
    case "Booting":
      return "booting" as const;
    case "Shutting Down":
      return "shutting-down" as const;
    default:
      return "shutdown" as const;
  }
}

function simulatorId(udid: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(udid)) {
    return udid;
  }
  const digest = createHash("sha256").update(`octant.apple-simulator.v1\0${udid}`).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function parseProjectMetadata(output: string): {
  readonly schemes: ReadonlyArray<string>;
  readonly configurations: ReadonlyArray<string>;
  readonly targets: ReadonlyArray<string>;
} {
  const parsed = JSON.parse(output) as Record<string, any>;
  const value = parsed.project ?? parsed.workspace ?? parsed.package;
  if (typeof value !== "object" || value === null) throw new Error("metadata missing");
  return {
    schemes: boundedStrings(value.schemes, 128),
    configurations: boundedStrings(value.configurations, 64),
    targets: boundedStrings(value.targets, 256),
  };
}

function boundedStrings(value: unknown, maximum: number): ReadonlyArray<string> {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .slice(0, maximum)
    : [];
}

function xcodebuildCommand(
  request: AppleBuildRequest,
  projectPath: string,
  artifactRoot: string,
  resultBundle: string,
): ReadonlyArray<string> {
  const argv = [
    "xcodebuild",
    projectSelector(request.projectPath),
    projectPath,
    ...(request.scheme === undefined ? [] : ["-scheme", request.scheme]),
    "-configuration",
    request.configuration === "release" ? "Release" : "Debug",
    "-derivedDataPath",
    resolve(artifactRoot, `derived-${request.actionId}`),
    ...destinationArguments(request),
    "CODE_SIGNING_ALLOWED=NO",
  ];
  if (request.kind === "test") argv.push("-resultBundlePath", resultBundle, "test");
  else argv.push(request.kind === "clean" ? "clean" : "build");
  return argv;
}

function xcodebuildSettingsCommand(
  request: AppleBuildRequest,
  projectPath: string,
  artifactRoot: string,
): ReadonlyArray<string> {
  return [
    "xcodebuild",
    projectSelector(request.projectPath),
    projectPath,
    ...(request.scheme === undefined ? [] : ["-scheme", request.scheme]),
    "-configuration",
    request.configuration === "release" ? "Release" : "Debug",
    "-derivedDataPath",
    resolve(artifactRoot, `derived-${request.actionId}`),
    ...destinationArguments(request),
    "CODE_SIGNING_ALLOWED=NO",
    "-showBuildSettings",
    "-json",
  ];
}

function destinationArguments(request: AppleBuildRequest): ReadonlyArray<string> {
  if (request.platform === "macos") return ["-destination", "platform=macOS"];
  if (request.simulatorId === undefined) return [];
  return [
    "-destination",
    `platform=${platformDisplayName(request.platform)} Simulator,id=${request.simulatorId}`,
  ];
}

function platformDisplayName(platform: AppleBuildRequest["platform"]): string {
  switch (platform) {
    case "ios":
      return "iOS";
    case "watchos":
      return "watchOS";
    case "tvos":
      return "tvOS";
    case "visionos":
      return "visionOS";
    case "macos":
      return "macOS";
  }
}

function parseBuildProduct(
  output: string,
  artifactRoot: string,
): { readonly applicationPath: string; readonly bundleIdentifier: string } {
  const parsed = JSON.parse(output) as ReadonlyArray<{
    readonly buildSettings?: Record<string, unknown>;
  }>;
  const settings = parsed[0]?.buildSettings;
  const directory = settings?.TARGET_BUILD_DIR;
  const wrapper = settings?.WRAPPER_NAME;
  const bundleIdentifier = settings?.PRODUCT_BUNDLE_IDENTIFIER;
  if (
    typeof directory !== "string" ||
    typeof wrapper !== "string" ||
    typeof bundleIdentifier !== "string"
  ) {
    throw new Error("build settings missing");
  }
  const applicationPath = resolve(directory, wrapper);
  const relativeProduct = relative(artifactRoot, applicationPath);
  if (
    relativeProduct === ".." ||
    relativeProduct.startsWith(`..${sep}`) ||
    isAbsolute(relativeProduct) ||
    extname(applicationPath) !== ".app"
  ) {
    throw new Error("build product outside artifact root");
  }
  return { applicationPath, bundleIdentifier };
}

/**
 * A host refusal in the form the diagnostic schema accepts: trimmed, non-empty,
 * bounded. `osascript` ends its stderr with a bare `osascript[pid] ` line and a
 * trailing space, and a message the schema refuses threw past the evidence
 * builder into the blanket catch, which reported "interrupted" with an empty
 * log — the one thing a person needed to read was the one thing lost.
 */
/**
 * The refusals the desktop's device helper and its broker name. Only these may
 * follow a failed typed text into evidence: a host's message can begin with
 * what was typed, and a secret can look like a code.
 */
const TYPED_TEXT_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "unsupported-character",
  "keyboard-layout-unsupported",
  "keyboard-layout-unknown",
  "not-booted",
  "no-such-device",
  "toolchain-unavailable",
  "input-service-unavailable",
  "daemon-unresponsive",
  "send-stalled",
  "helper-unavailable",
  "deadline-too-short",
  "deadline-passed",
]);

/**
 * Why typed text failed, without the host's words: the leading reason code
 * when it is one the device helper uses, and nothing otherwise.
 */
function typedTextFailureNote(outcome: AppleBuildEvidence["outcome"], stderr: string): string {
  const code = /^([a-z][a-z-]{2,63}):/.exec(stderr.trimStart())?.[1];
  return code === undefined || !TYPED_TEXT_REFUSAL_CODES.has(code)
    ? `type-text ${outcome} (text redacted)`
    : `type-text ${outcome}: ${code} (text redacted)`;
}

function inputFailureNote(
  request: Pick<AppleSimulatorRequest, "kind" | "point" | "toPoint">,
  outcome: AppleBuildEvidence["outcome"],
  stderr: string,
  context: AppleExecutionContext,
): string {
  // A swipe that did not happen still says where it was meant to go, the same
  // as one that did: "off screen" alone does not tell a reader which end.
  const attempted =
    request.kind === "swipe" && request.point !== undefined && request.toPoint !== undefined
      ? `swipe ${outcome} (x=${request.point.x}, y=${request.point.y} to x=${request.toPoint.x}, y=${request.toPoint.y})`
      : `${request.kind} ${outcome}`;
  // The host's words are journaled, so they cross the same boundary as any
  // other command output: host roots are replaced before anything is kept.
  const detail = stderr
    .replaceAll(context.checkoutRoot, "[PROJECT]")
    .replaceAll(context.artifactRoot, "[ARTIFACT]")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .slice(0, MAX_DIAGNOSTIC_LENGTH - attempted.length - 2)
    .trim();
  return detail.length === 0 ? attempted : `${attempted}: ${detail}`;
}

function unrecordedActionNote(
  request: AppleActionRequest,
  error: unknown,
  context: AppleExecutionContext,
): string {
  if (request.kind === "type-text") return "type-text did not record evidence (detail redacted)";
  // A filesystem error names absolute host paths; they leave the host the same
  // way command output does, with the checkout and artifact roots replaced.
  const reason = (error instanceof Error ? error.message : String(error))
    .replaceAll(context.checkoutRoot, "[PROJECT]")
    .replaceAll(context.artifactRoot, "[ARTIFACT]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DIAGNOSTIC_LENGTH - 64)
    .trim();
  return reason.length === 0
    ? `${request.kind} did not record evidence`
    : `${request.kind} did not record evidence: ${reason}`;
}

function outcomeFor(result: AppleProcessResult): AppleBuildEvidence["outcome"] {
  if (result.cleanupUncertain) return "interrupted";
  if (result.termination === "cancelled") return "cancelled";
  if (result.termination === "timed-out") return "timed-out";
  if (result.termination === "unavailable") return "unavailable";
  if (result.exitCode === null) return "process-died";
  return result.exitCode === 0 ? "succeeded" : "failed";
}

function evidenceForDenied(
  request: AppleActionRequest,
  reason: string,
  startedAt: string,
  completedAt: string,
): AppleBuildEvidence {
  const outcome =
    reason === "invalid-destination" || reason.startsWith("destination-")
      ? "invalid-destination"
      : reason === "toolchain-unavailable"
        ? "unavailable"
        : "unauthorized";
  return evidence(
    request,
    outcome,
    startedAt,
    completedAt,
    [{ severity: "note", message: safeReason(reason) }],
    [],
    "not-required",
  );
}

function evidence(
  request: AppleActionRequest,
  outcome: AppleBuildEvidence["outcome"],
  startedAt: string,
  completedAt: string,
  diagnostics: AppleBuildEvidence["diagnostics"],
  artifacts: AppleBuildEvidence["artifacts"],
  cleanup: AppleBuildEvidence["cleanup"],
): AppleBuildEvidence {
  const requestedBy =
    !isBuildRequest(request) && request.requestedBy !== undefined ? request.requestedBy : undefined;
  return decodeAppleBuildEvidence({
    actionId: request.actionId,
    correlationId: request.correlationId,
    authority: request.authority,
    kind: request.kind,
    ...(request.simulatorId === undefined ? {} : { simulatorId: request.simulatorId }),
    ...(requestedBy === undefined ? {} : { requestedBy }),
    outcome,
    diagnostics,
    artifacts,
    cleanup,
    durationMs: elapsed(startedAt, completedAt),
    completedAt,
  });
}

/**
 * Evidence that answered a request again from memory. Nothing was delivered
 * this time, so a caller that reacts to what happened on a device — renewing an
 * input grant, say — must be able to tell it from a real delivery without
 * comparing timestamps, which a clock change can reorder.
 */
const replayedEvidence = new WeakSet<object>();

export function replayedFrom<Evidence extends object>(value: Evidence): Evidence {
  const replay = { ...value };
  replayedEvidence.add(replay);
  return replay;
}

export function isReplayedEvidence(value: object): boolean {
  return replayedEvidence.has(value);
}

export function withInputMustReissueNote(value: AppleBuildEvidence): AppleBuildEvidence {
  const alreadyNoted = value.diagnostics.some(
    (diagnostic) => diagnostic.message === APPLE_INPUT_MUST_REISSUE_NOTE,
  );
  if (alreadyNoted) return value;
  const note: AppleBuildEvidence["diagnostics"][number] = {
    severity: "note",
    message: APPLE_INPUT_MUST_REISSUE_NOTE,
  };
  return {
    ...value,
    diagnostics:
      value.diagnostics.length >= MAX_DIAGNOSTICS
        ? [...value.diagnostics.slice(0, MAX_DIAGNOSTICS - 1), note]
        : [...value.diagnostics, note],
  };
}

function diagnosticsFor(
  outputs: ReadonlyArray<Uint8Array>,
  context: AppleExecutionContext,
): AppleBuildEvidence["diagnostics"] {
  const diagnostics: AppleBuildEvidence["diagnostics"][number][] = [];
  const sanitized = outputs
    .map(text)
    .join("\n")
    .replaceAll(context.checkoutRoot, "[PROJECT]")
    .replaceAll(context.artifactRoot, "[ARTIFACT]");
  for (const line of sanitized.split(/\r?\n/)) {
    const match = /^(.*?):(\d+):(\d+):\s*(error|warning|note):\s*(.+)$/.exec(line.trim());
    if (match === null) continue;
    diagnostics.push({
      severity: match[4] as "error" | "warning" | "note",
      location: `${match[1]}:${match[2]}:${match[3]}`.slice(0, 512),
      message: (match[5] ?? "").slice(0, MAX_DIAGNOSTIC_LENGTH),
    });
    if (diagnostics.length >= MAX_DIAGNOSTICS) break;
  }
  if (diagnostics.length === 0) {
    const fallback = sanitized
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(-5);
    for (const line of fallback) {
      diagnostics.push({ severity: "note", message: line.slice(0, MAX_DIAGNOSTIC_LENGTH) });
    }
  }
  return diagnostics;
}

function safeReason(reason: string): string {
  return reason.replace(/[^a-z0-9-]/gi, "-").slice(0, 128);
}

function succeeded(result: AppleProcessResult): boolean {
  return result.termination === "exited" && result.exitCode === 0 && !result.cleanupUncertain;
}

function text(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return "";
  }
}

function elapsed(startedAt: string, completedAt: string): number {
  const duration = Date.parse(completedAt) - Date.parse(startedAt);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

function discoveryKey(threadId: unknown, checkoutId: unknown, projectPath: string): string {
  return `${threadId}:${checkoutId}:${projectPath}`;
}

function unavailableToolchain(id: string, discoveredAt: string): AppleToolchainDiscovery {
  return decodeAppleToolchainDiscovery({
    toolchainId: id,
    available: false,
    sdks: [],
    discoveredAt,
  });
}

function unauthorizedFailure(): AppleDiscoveryResult {
  return {
    kind: "failure",
    failure: { category: "unauthorized", message: "Apple discovery is unauthorized." },
  };
}

function invalidFailure(message: string): AppleDiscoveryResult {
  return { kind: "failure", failure: { category: "invalid", message } };
}

const CAPTURE_FILE_PREFIX = "octant-apple-capture-";
/** Every attempt has its own path, so one set serves all services in the process. */
const capturesInProgress = new Set<string>();
const STALE_CAPTURE_MS = 60_000;
/** When an action returns for a file its unconfirmed process may still write. */
const CAPTURE_RETURN_VISITS_MS = [60_000, 5 * 60_000, 15 * 60_000] as const;

/** Removes this host's capture files that no running action still owns. */
async function sweepStaleCaptures(
  directory: string,
  prefix: string,
  nowMs: number,
  inProgress: ReadonlySet<string>,
): Promise<void> {
  let names: ReadonlyArray<string>;
  try {
    names = await readdir(directory);
  } catch {
    return;
  }
  await Promise.all(
    names
      .filter((name) => name.startsWith(prefix) && name.endsWith(".png"))
      .map(async (name) => {
        const path = join(directory, name);
        if (inProgress.has(path)) return;
        try {
          if (nowMs - (await stat(path)).mtimeMs > STALE_CAPTURE_MS)
            await rm(path, { force: true });
        } catch {
          // Already gone, or not ours to remove; neither blocks a capture.
        }
      }),
  );
}

/**
 * A Simulator screen is a few megabytes. The bound is the artifact store's own:
 * a capture it would refuse is refused here, as a failed capture with a reason,
 * rather than thrown past the action as "interrupted".
 */
const MAX_CAPTURE_BYTES = MAX_APPLE_ARTIFACT_BYTES;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/**
 * The capture `simctl` wrote, or nothing. The file sits in a temporary root
 * that code from the checkout can also write to, under a name it can guess, and
 * this read happens in the host process with the host's reach. So the path is
 * opened without following a link, the opened file must be one ordinary file
 * with no second name, of a plausible size, and it is read from that same
 * descriptor; and only a PNG is kept. A link to a host file, a second name for
 * someone else's file, or any other content reads as no capture at all.
 */
async function readCapture(path: string): Promise<Uint8Array | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.size < PNG_SIGNATURE.length ||
      opened.size > MAX_CAPTURE_BYTES
    ) {
      return undefined;
    }
    // The size above is a snapshot, and whoever shares the directory can grow
    // the file after it. Exactly that many bytes are read into a buffer of that
    // size, and one more byte is asked for: if it is there the file changed
    // under the read and the capture is refused, so the host never allocates
    // more than the limit however large the file becomes.
    const bytes = new Uint8Array(opened.size);
    let filled = 0;
    while (filled < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, filled, bytes.byteLength - filled, filled);
      if (bytesRead === 0) return undefined;
      filled += bytesRead;
    }
    const beyond = await handle.read(new Uint8Array(1), 0, 1, filled);
    if (beyond.bytesRead > 0) return undefined;
    return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte) ? bytes : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function appendLine(existing: Uint8Array, line: string): Uint8Array {
  const suffix = new TextEncoder().encode(
    `${existing.byteLength === 0 || existing.at(-1) === 0x0a ? "" : "\n"}${line}\n`,
  );
  const merged = new Uint8Array(existing.byteLength + suffix.byteLength);
  merged.set(existing);
  merged.set(suffix, existing.byteLength);
  return merged;
}

function unavailableInputResult(message: string): AppleProcessResult {
  return {
    termination: "unavailable",
    exitCode: null,
    stdout: new Uint8Array(),
    stderr: new TextEncoder().encode(message),
    parserFailed: false,
    cleanupUncertain: false,
  };
}
