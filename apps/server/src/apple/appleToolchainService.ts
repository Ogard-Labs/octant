import { createHash } from "node:crypto";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
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
  redactedAppleInputDiagnostic,
  type AppleExecutionScope,
} from "@octant/domain";

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
   * Optional XCTest-less Simulator input injector. Tests and reviewed host
   * adapters supply this; when absent, Darwin hosts attempt Simulator.app
   * Accessibility via osascript and other hosts report unavailable.
   */
  readonly injectSimulatorInput?: (
    request: AppleSimulatorRequest,
    context: AppleExecutionContext,
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<AppleProcessResult>;
  readonly realpath: (path: string) => Promise<string>;
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

export class AppleToolchainService {
  readonly #options: AppleToolchainServiceOptions;
  readonly #discovery = new Map<string, DiscoveryCacheEntry>();
  readonly #active = new Map<string, ActiveAction>();
  readonly #recent: RecentEvidenceEntry[] = [];
  #receiptWrites: Promise<void> = Promise.resolve();
  #sequence = 0;
  #lastToolchain: AppleToolchainDiscovery;
  #lastSimulators: ReadonlyArray<AppleSimulatorRecord> = [];

  constructor(options: AppleToolchainServiceOptions) {
    this.#options = options;
    this.#lastToolchain = unavailableToolchain(options.newId(), options.now());
  }

  async discover(
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
    const simulators = parseSimulators(text(devices.stdout));
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
    this.#sequence += 1;
    return { kind: "discovered", ...entry };
  }

  async execute(
    request: AppleBuildRequest | AppleSimulatorRequest,
    context: AppleExecutionContext,
  ): Promise<AppleBuildEvidence> {
    const startedAt = this.#options.now();
    if (!isBuildRequest(request) && isAppleSimulatorInputKind(request.kind)) {
      const prior = this.#findCompletedInput(request, context);
      if (prior !== undefined) return prior;
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
    });
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

  #findDiscovery(request: AppleActionRequest): DiscoveryCacheEntry | undefined {
    if ("projectPath" in request) {
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
        terminal = await this.#command(
          ["xcrun", "simctl", "io", request.simulatorId, "screenshot", "--type", "png", "-"],
          context,
          request.timeoutMs,
          signal,
        );
        if (succeeded(terminal)) {
          const screenshotReference = `apple-screenshot-${request.actionId}`;
          await this.#writeArtifact(screenshotReference, [terminal.stdout]);
          artifacts = [{ kind: "screenshot", reference: screenshotReference }];
          // The captured screen is PNG bytes on stdout. They belong to the
          // screenshot artifact; folding them into the log would make the log
          // unreadable and tell a reader nothing.
          terminal = { ...terminal, stdout: new Uint8Array() };
        }
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
      } else if (
        request.kind === "tap" ||
        request.kind === "type-text" ||
        request.kind === "key-press"
      ) {
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
                  ? `type-text ${outcomeFor(terminal)} (text redacted)`
                  : `${request.kind} ${outcomeFor(terminal)}: ${text(terminal.stderr).slice(0, MAX_DIAGNOSTIC_LENGTH)}`,
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
      if (succeeded(terminal) && request.kind === "boot") {
        this.#setSimulatorState(request.simulatorId, "booted");
      }
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
    } catch {
      const logReference = `apple-log-${request.actionId}`;
      await this.#writeArtifact(logReference, outputs);
      return evidence(
        request,
        signal.aborted ? "cancelled" : "interrupted",
        startedAt,
        this.#options.now(),
        diagnosticsFor(outputs, context),
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
    result = await this.#command(
      ["xcrun", "simctl", "boot", simulatorId],
      context,
      timeoutMs,
      signal,
    );
    if (!succeeded(result)) return result;
    result = await this.#command(
      ["xcrun", "simctl", "bootstatus", simulatorId, "-b"],
      context,
      timeoutMs,
      signal,
    );
    if (succeeded(result)) this.#setSimulatorState(simulatorId, "booted");
    return result;
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
    const argv = darwinSimulatorInputArgv(request);
    if (argv === undefined) {
      return unavailableInputResult("Simulator input request is incomplete for host injection.");
    }
    return this.#command(argv, context, request.timeoutMs, signal);
  }

  /**
   * Bound a host adapter the same way `#command` bounds osascript: a
   * non-settling injector must not leave the action stuck in `#active`.
   */
  async #runInjectedInput(
    run: (signal: AbortSignal) => Promise<AppleProcessResult>,
    timeoutMs: number,
    parent: AbortSignal,
  ): Promise<AppleProcessResult> {
    if (parent.aborted) {
      return {
        termination: "cancelled",
        exitCode: null,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        parserFailed: false,
        cleanupUncertain: false,
      };
    }
    const controller = new AbortController();
    const onParentAbort = () => controller.abort(parent.reason);
    parent.addEventListener("abort", onParentAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("deadline-exceeded")), timeoutMs);
    try {
      return await run(controller.signal);
    } catch (error) {
      if (parent.aborted) {
        return {
          termination: "cancelled",
          exitCode: null,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
          parserFailed: false,
          cleanupUncertain: false,
        };
      }
      if (controller.signal.aborted) {
        return {
          termination: "timed-out",
          exitCode: null,
          stdout: new Uint8Array(),
          stderr: new TextEncoder().encode("Simulator input injection timed out."),
          parserFailed: false,
          cleanupUncertain: true,
        };
      }
      throw error;
    } finally {
      clearTimeout(timer);
      parent.removeEventListener("abort", onParentAbort);
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

  #setSimulatorState(
    simulatorId: AppleSimulatorRecord["simulatorId"],
    state: AppleSimulatorRecord["state"],
  ): void {
    const update = (records: ReadonlyArray<AppleSimulatorRecord>) =>
      records.map((record) =>
        record.simulatorId === simulatorId
          ? decodeAppleSimulatorRecord({ ...record, state })
          : record,
      );
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

function withInputMustReissueNote(value: AppleBuildEvidence): AppleBuildEvidence {
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
    diagnostics: [...value.diagnostics, note].slice(0, MAX_DIAGNOSTICS),
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
      message: match[5]!.slice(0, MAX_DIAGNOSTIC_LENGTH),
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

/**
 * XCTest-less Darwin injection via Simulator.app Accessibility. Typed text is
 * passed only as an osascript argument for execution — never mirrored into
 * durable logs by the caller. Prefer a reviewed injectSimulatorInput adapter
 * when one is configured on the host.
 *
 * Point taps offset live-frame image pixels from Simulator window 1's
 * top-left. That misses title-bar/bezel chrome and does not scale when the
 * frame and window sizes differ; prefer semantic `target`, or supply
 * `injectSimulatorInput` for accurate mapping.
 */
function darwinSimulatorInputArgv(
  request: AppleSimulatorRequest,
): ReadonlyArray<string> | undefined {
  if (request.kind === "tap") {
    if (request.target !== undefined) {
      const target = escapeAppleScriptString(request.target);
      return [
        "osascript",
        "-e",
        'tell application "Simulator" to activate',
        "-e",
        `tell application "System Events" to tell process "Simulator" to click UI element "${target}" of window 1`,
      ];
    }
    if (request.point !== undefined) {
      const x = Math.round(request.point.x);
      const y = Math.round(request.point.y);
      return [
        "osascript",
        "-e",
        'tell application "Simulator" to activate',
        "-e",
        [
          'tell application "System Events"',
          'tell process "Simulator"',
          "set {wx, wy} to position of window 1",
          "end tell",
          `click at {wx + ${x}, wy + ${y}}`,
          "end tell",
        ].join("\n"),
      ];
    }
    return undefined;
  }
  if (request.kind === "type-text") {
    if (request.text === undefined) return undefined;
    const text = escapeAppleScriptString(request.text);
    return [
      "osascript",
      "-e",
      'tell application "Simulator" to activate',
      "-e",
      `tell application "System Events" to keystroke "${text}"`,
    ];
  }
  if (request.kind === "key-press") {
    if (request.key === undefined) return undefined;
    const code = appleScriptKeyCode(request.key);
    if (code === undefined) return undefined;
    return [
      "osascript",
      "-e",
      'tell application "Simulator" to activate',
      "-e",
      `tell application "System Events" to key code ${code}`,
    ];
  }
  return undefined;
}

function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function appleScriptKeyCode(key: string): number | undefined {
  switch (key.toLowerCase()) {
    case "return":
    case "enter":
      return 36;
    case "escape":
    case "esc":
      return 53;
    case "tab":
      return 48;
    case "delete":
    case "backspace":
      return 51;
    case "space":
      return 49;
    case "home":
      // Hardware Home is not a keystroke; callers should prefer a reviewed injector.
      return undefined;
    default:
      return undefined;
  }
}
