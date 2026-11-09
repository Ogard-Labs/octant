import type { BrowserDownloadPermissions } from "./browserDownloadPermissions";
import type {
  BrowserDownloadDestination,
  BrowserDownloadFacts,
  BrowserDownloadSaveDecision,
} from "./browserDownloadSave";
import type { BrowserDownloadDestinationReceipt } from "@octant/contracts/browser-download";
import type { BrowserUploadPermissions } from "./browserUploadPermissions";
import type { BrowserProfileChoice } from "@octant/contracts/project-browser";
import { browserProfileFromChoice } from "@octant/domain";
import { browserAgentAvailability } from "@octant/domain";
import { browserSignInOriginRefusal } from "./browserRecoveryMessages";
import { browserToolImage } from "./browserToolImage";
import { admitBrowserUpload } from "./browserUploadFiles";
import {
  browserDownloadSavedResult,
  browserOperationRefusedInPlan,
  browserToolAction,
  browserToolResult,
  browserToolWantsScreenshot,
  parseBrowserToolInput,
  handBrowserToPerson,
  heldForPersonAnswer,
  heldWhileQueued,
  isBrowserToolFlowInput,
  runBrowserToolSteps,
  runRecordedBrowserCall,
  signInPageRefusal,
  type BrowserToolAnswer,
  type BrowserToolInput,
  type BrowserToolRecordingOperation,
} from "./browserToolOperations";
import { BROWSER_TOOL_DEFINITION, BROWSER_TOOL_HELP } from "./browserToolDefinition";
import type {
  BrowserDownloadSource,
  BrowserActionRequest,
  BrowserAutomationSnapshot,
  BrowserContextPolicy,
  BrowserThreadId,
  StoredBrowserProfile,
  ProviderExecutionPolicy,
  ToolActionAuthority,
  ToolActionRequest,
  WindowId,
} from "@octant/contracts";
import { MAX_BROWSER_TABS_PER_CONTEXT, sameToolActionAuthority } from "@octant/contracts";
import { browserProfileKey, storedBrowserProfile } from "@octant/domain";
import { withToolFamilyHelp, type AppManagedToolSet } from "../providers/appManagedToolSet";
import {
  browserFlowAgentActor,
  runBrowserFlowOperation,
  runRecordingFlow,
  type BrowserFlowRefs,
  type BrowserFlowToolPort,
} from "./browserFlows";
import type { BrowserToolApprovalService } from "./browserToolApprovalService";

export const BROWSER_TOOL_NAME = BROWSER_TOOL_DEFINITION.name;

export interface BrowserAppManagedToolsOptions {
  readonly windowId: WindowId;
  readonly threadId: BrowserThreadId;
  readonly mode: "chat" | "work" | "code";
  /** Model selected when this tool set was composed. */
  readonly modelId: string;
  /** Resolves the current persisted model before each approval/effect. */
  readonly resolveModelId: (
    threadId: BrowserThreadId,
    mode: ToolActionAuthority["mode"],
  ) => string | undefined;
  /** Host-owned in-memory bindings that survive per-turn tool-set factories. */
  readonly modelBindings: Map<string, BrowserModelBinding>;
  /** Live task default, used only when navigate omits its explicit profile. */
  readonly resolveTaskProfile?: () => BrowserProfileChoice | undefined;
  readonly resolveAuthority: (
    threadId: BrowserThreadId,
    mode: ToolActionAuthority["mode"],
  ) => ToolActionAuthority | undefined;
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly toolConstraints?: ReadonlyArray<string>;
  readonly browser: {
    readonly inspectThread: (
      windowId: WindowId,
      threadId: BrowserThreadId,
    ) => BrowserAutomationSnapshot;
    readonly create: (input: {
      readonly windowId: WindowId;
      readonly threadId: BrowserThreadId;
      readonly action: ToolActionRequest;
      readonly policy: BrowserContextPolicy;
      readonly profileCaller?: "terminal-grant";
    }) => Promise<BrowserAutomationSnapshot>;
    readonly act: (input: {
      readonly windowId: WindowId;
      readonly threadId?: BrowserThreadId;
      readonly request: BrowserActionRequest;
      readonly capturedBy?: "agent";
      readonly activityBy?: "agent";
      /** On a `record-stop`: end the recording and keep nothing; see the service. */
      readonly discardRecording?: true;
      readonly uploadFiles?: ReadonlyArray<string>;
      readonly uploadSignal?: AbortSignal;
      readonly uploadIsCurrent?: () => boolean;
      readonly releaseUpload?: () => Promise<void>;
      readonly refuseStaleRevision?: boolean;
      readonly holdDownloads?: boolean;
    }) => Promise<BrowserAutomationSnapshot>;
    /**
     * Saves a download the thread's Browser holds into the workspace once
     * `ask` is answered yes; see the service. Absent, `download-save` is refused.
     */
    readonly saveDownload?: (input: {
      readonly windowId: WindowId;
      readonly threadId: BrowserThreadId;
      readonly downloadId: string;
      readonly destination?: BrowserDownloadDestination;
      readonly permissionSignal?: AbortSignal;
      readonly finalAdmission?: (
        facts: BrowserDownloadFacts,
        origin: string,
      ) => BrowserDownloadSaveDecision;
      readonly workspaceRoot: string | undefined;
      readonly signal?: AbortSignal;
      readonly ask: (
        facts: {
          readonly name: string;
          readonly sizeBytes: number;
          readonly mediaType: string;
          readonly source?: BrowserDownloadSource;
        },
        origin: string,
      ) => Promise<"approved" | "denied" | "cancelled" | "expired">;
    }) => Promise<
      | {
          readonly status: "saved";
          readonly destination?: BrowserDownloadDestinationReceipt;
          readonly path: string;
          readonly sizeBytes: number;
          readonly mediaType: string;
        }
      | { readonly status: "refused"; readonly error: string }
    >;
    readonly releaseThread: (
      windowId: WindowId,
      threadId: BrowserThreadId,
    ) => Promise<BrowserAutomationSnapshot>;
    /** What the latest snapshot's refs name; flows read it to describe and find elements. */
    readonly snapshotRefs?: (windowId: WindowId, threadId: BrowserThreadId) => BrowserFlowRefs;
    /** Marks the page as the person's to sign in on; see the service. */
    readonly holdForPerson?: (
      windowId: WindowId,
      threadId: BrowserThreadId,
    ) => (() => void) | undefined;
  };
  readonly approvals?: Pick<BrowserToolApprovalService, "request"> &
    Partial<
      Pick<BrowserToolApprovalService, "isRemembered" | "isUnattendedScope" | "isPairedDevice">
    >;
  /**
   * Set for a CLI the person typed into a thread terminal. It may drive the
   * thread's Private pages only; a page in a signed-in profile needs a person.
   */
  readonly profileCaller?: "terminal-grant";
  /** A host-resolved bounded permission for this exact unattended caller. */
  readonly delegatedProfileIsCurrent?: (
    profile: StoredBrowserProfile,
    origins: ReadonlyArray<string>,
  ) => boolean;
  /**
   * The Project's flows and the recorder of this host. Absent (a CLI in a
   * thread terminal), flow operations are unavailable and nothing is recorded.
   */
  readonly flows?: BrowserFlowToolPort;
  /**
   * The thread's workspace: the Work thread's Project folder. An upload sends
   * files only from it, and a saved download lands only in its `downloads/`
   * folder. Absent, both are refused.
   */
  readonly uploadRoot?: () => string | undefined;
  readonly downloadPermission?: (input: {
    readonly permissionId: string;
    readonly profile: StoredBrowserProfile;
  }) => ReturnType<BrowserDownloadPermissions["prepare"]>;
  readonly uploadPermission?: (input: {
    readonly permissionId: string;
    readonly profile: StoredBrowserProfile;
    readonly origin: string;
    readonly files: ReadonlyArray<string>;
  }) => ReturnType<BrowserUploadPermissions["prepare"]>;
  readonly uuid: () => string;
}

export interface BrowserModelBinding {
  /** Identity of a person-switched page; it grants no agent access. */
  readonly approval?: "pending";
  readonly modelId: string;
  readonly authority: ToolActionAuthority;
}

const hostPolicy: BrowserContextPolicy = {
  profileMode: "isolated",
  allowedOrigins: [],
  credentialFieldProtection: true,
  maxConcurrentTabs: MAX_BROWSER_TABS_PER_CONTEXT,
  sessionTimeoutMs: 600_000,
};

export function createBrowserAppManagedTools(
  options: BrowserAppManagedToolsOptions,
): AppManagedToolSet {
  const initialAuthority = options.resolveAuthority(options.threadId, options.mode);
  const definitions =
    browserAgentAvailability({
      toolTransport: true,
      hostLendsBrowser: true,
      ...(options.toolConstraints === undefined
        ? {}
        : { toolConstraints: options.toolConstraints }),
      readOnly: options.executionPolicy === "plan",
    }).status === "available"
      ? [BROWSER_TOOL_DEFINITION]
      : [];
  // One operation, admitted on its own: a batch runs each step through here.
  const runOne = async (
    input: Exclude<BrowserToolInput, { readonly operation: "steps" }>,
    signal: AbortSignal | undefined,
    afterSignIn = false,
  ): Promise<BrowserToolAnswer> => {
    const authority = options.resolveAuthority(options.threadId, options.mode);
    if (authority === undefined) return failure("browser-authority-unavailable");
    if (initialAuthority !== undefined && !sameToolActionAuthority(initialAuthority, authority)) {
      return failure("browser-authority-stale");
    }
    if (input.operation === "run-script") {
      // The Work/terminal adapter has no live Full-access script admission yet.
      return failure(
        options.executionPolicy === "plan" ? "plan-mode-read-only" : "script-unavailable",
      );
    }
    if (input.operation === "stop") {
      const snapshot = options.browser.inspectThread(options.windowId, options.threadId);
      if (snapshot.context !== undefined) {
        options.modelBindings.delete(String(snapshot.context.contextId));
      }
      return browserToolResult(
        await options.browser.releaseThread(options.windowId, options.threadId),
      );
    }
    if (!modelIsCurrent(options)) return failure("browser-model-stale");
    // Plan admits the reads of the page already open; every other gate below
    // still applies to them.
    if (options.executionPolicy === "plan" && browserOperationRefusedInPlan(input.operation)) {
      return failure("plan-mode-read-only");
    }
    let snapshot = options.browser.inspectThread(options.windowId, options.threadId);
    // While the person signs in, the page is theirs: no other agent action
    // reaches it until they press Continue or the ask ends.
    if (snapshot.waitingForPerson !== undefined) {
      return heldForPersonAnswer(snapshot.waitingForPerson);
    }
    if (snapshot.failure?.category === "context-expired" && input.operation !== "navigate") {
      const previous =
        snapshot.context === undefined
          ? undefined
          : options.modelBindings.get(String(snapshot.context.contextId));
      if (
        previous === undefined ||
        String(previous.modelId) !== String(options.modelId) ||
        !sameToolActionAuthority(previous.authority, authority)
      ) {
        return failure("browser-navigation-required");
      }
      const expiredProfile = storedBrowserProfile(snapshot.context?.policy.profile);
      if (
        expiredProfile !== undefined &&
        (options.profileCaller === "terminal-grant" ||
          options.approvals?.isUnattendedScope?.(options.windowId) === true) &&
        options.delegatedProfileIsCurrent?.(
          expiredProfile,
          snapshot.context?.policy.allowedOrigins ?? [],
        ) !== true
      ) {
        return failure("profile-needs-a-person");
      }
      return browserToolResult(snapshot);
    }
    if (input.operation === "sign-in") {
      const refusal = signInRefusal(options) ?? signInPageRefusal(snapshot);
      if (refusal !== undefined) return failure(refusal);
    }
    const existing = snapshot.context?.state === "active" ? snapshot.context : undefined;
    if (existing === undefined && snapshot.context !== undefined) {
      options.modelBindings.delete(String(snapshot.context.contextId));
    }
    const origin =
      existing === undefined
        ? input.operation === "navigate"
          ? allowedOrigin(input.url)
          : undefined
        : existing.policy.allowedOrigins.join(", ");
    if (origin === undefined) {
      return failure(
        input.operation === "navigate" ? "invalid-browser-url" : "browser-navigation-required",
      );
    }
    // A page's profile is fixed when it opens. An existing page keeps its own,
    // and the agent cannot move it: stopping the browser and opening again is
    // how a different profile is chosen, and the person is asked again.
    const existingProfile = storedBrowserProfile(existing?.policy.profile);
    if (
      existing !== undefined &&
      input.operation === "navigate" &&
      input.profile !== undefined &&
      browserProfileKey(existingProfile) !==
        browserProfileKey(requestedProfile(input.profile, authority))
    ) {
      return failure("browser-profile-differs-stop-first");
    }
    const defaultChoice = options.resolveTaskProfile?.();
    const choice = input.operation === "navigate" ? (input.profile ?? defaultChoice) : undefined;
    const profile: StoredBrowserProfile | undefined =
      existing !== undefined
        ? existingProfile
        : input.operation === "navigate" && choice !== undefined
          ? requestedProfile(choice, authority)
          : undefined;
    if (
      existing === undefined &&
      input.operation === "navigate" &&
      choice === "project" &&
      profile === undefined
    ) {
      return failure("profile-unavailable");
    }
    if (
      profile !== undefined &&
      (options.profileCaller === "terminal-grant" ||
        options.approvals?.isUnattendedScope?.(options.windowId) === true) &&
      options.delegatedProfileIsCurrent?.(profile, [origin]) !== true
    ) {
      return failure("profile-needs-a-person");
    }
    if (
      profile !== undefined &&
      defaultChoice !== undefined &&
      defaultChoice !== "private" &&
      (input.operation !== "navigate" || input.profile === undefined) &&
      options.approvals?.isPairedDevice?.(options.windowId) === true
    )
      return failure("profile-not-local");
    const existingBinding =
      existing === undefined ? undefined : options.modelBindings.get(String(existing.contextId));
    const identityMatches =
      existingBinding !== undefined &&
      String(existingBinding.modelId) === String(options.modelId) &&
      sameToolActionAuthority(existingBinding.authority, authority);
    const contextApproved = identityMatches && existingBinding?.approval !== "pending";
    // A remembered origin grant stands in for the prompt when the context
    // itself is new: "always allow" answered an open for this origin before.
    // An existing context still asks when its binding no longer matches —
    // the remembered grant covers the page, not a new model driving it.
    const remembered =
      (existing === undefined || (identityMatches && existingBinding?.approval === "pending")) &&
      options.approvals?.isRemembered?.(origin, profile) === true;
    if ((existing === undefined || !contextApproved) && !remembered) {
      if (options.approvals === undefined) return failure("browser-approval-required");
      const outcome = await options.approvals.request({
        windowId: options.windowId,
        threadId: String(options.threadId),
        authority,
        origin,
        ...(profile === undefined ? {} : { profile }),
        ...(signal === undefined ? {} : { signal }),
      });
      if (outcome !== "approved") return failure(`browser-approval-${outcome}`);
      if (signal?.aborted) return failure("tool-interrupted");
      const refreshed = options.resolveAuthority(options.threadId, options.mode);
      if (refreshed === undefined || !sameToolActionAuthority(authority, refreshed)) {
        return failure("browser-authority-stale");
      }
      if (!modelIsCurrent(options)) return failure("browser-model-stale");
      if (existing !== undefined) {
        rememberModelBinding(options.modelBindings, String(existing.contextId), {
          modelId: options.modelId,
          authority: refreshed,
        });
      }
    }
    if (remembered && existing !== undefined)
      rememberModelBinding(options.modelBindings, String(existing.contextId), {
        modelId: options.modelId,
        authority,
      });
    if (existing === undefined) {
      const created = await options.browser.create({
        windowId: options.windowId,
        threadId: options.threadId,
        action: actionRequest(options, authority),
        policy: {
          ...hostPolicy,
          ...(profile === undefined ? {} : { profile }),
          allowedOrigins: [origin],
        },
        ...(options.profileCaller === undefined ? {} : { profileCaller: options.profileCaller }),
      });
      snapshot = created;
      if (created.context?.state === "active") {
        const contextId = String(created.context.contextId);
        rememberModelBinding(options.modelBindings, contextId, {
          modelId: options.modelId,
          authority,
        });
      }
    }
    const context = snapshot.context;
    if (context === undefined || context.state !== "active") return browserToolResult(snapshot);
    const contextId = String(context.contextId);
    const binding = options.modelBindings.get(contextId);
    const bindingMatches =
      binding !== undefined &&
      binding.approval !== "pending" &&
      String(binding.modelId) === String(options.modelId) &&
      sameToolActionAuthority(binding.authority, authority);
    if (!bindingMatches && existing !== undefined) {
      if (options.approvals === undefined) return failure("browser-approval-required");
      const outcome = await options.approvals.request({
        windowId: options.windowId,
        threadId: String(options.threadId),
        authority,
        origin,
        ...(profile === undefined ? {} : { profile }),
        ...(signal === undefined ? {} : { signal }),
      });
      if (outcome !== "approved") return failure(`browser-approval-${outcome}`);
      if (signal?.aborted) return failure("tool-interrupted");
      const refreshed = options.resolveAuthority(options.threadId, options.mode);
      if (refreshed === undefined || !sameToolActionAuthority(authority, refreshed)) {
        return failure("browser-authority-stale");
      }
      if (!modelIsCurrent(options)) return failure("browser-model-stale");
      rememberModelBinding(options.modelBindings, contextId, {
        modelId: options.modelId,
        authority: refreshed,
      });
    }
    if (input.operation === "sign-in") {
      const approvals = options.approvals;
      if (approvals === undefined) return failure("browser-approval-required");
      return handBrowserToPerson({
        hold: () =>
          options.browser.holdForPerson?.(options.windowId, options.threadId) ?? (() => undefined),
        ask: () =>
          approvals.request({
            windowId: options.windowId,
            threadId: String(options.threadId),
            authority,
            origin,
            ...(profile === undefined ? {} : { profile }),
            signIn: input.reason === undefined ? {} : { reason: input.reason },
            ...(signal === undefined ? {} : { signal }),
          }),
        snapshotAfter: () => runOne({ operation: "snapshot" }, signal, true),
      });
    }
    if (input.operation === "download-save") {
      // A CLI in a terminal is not the person who would be asked, and a paired
      // device is not at the computer the file would land on.
      if (options.profileCaller === "terminal-grant") return failure("download-needs-a-person");
      if (options.approvals?.isPairedDevice?.(options.windowId) === true) {
        return failure("download-needs-this-computer");
      }
      const approvals = options.approvals;
      const permission =
        input.downloadPermissionId === undefined || profile === undefined
          ? undefined
          : await options.downloadPermission?.({
              permissionId: input.downloadPermissionId,
              profile,
            });
      if (input.downloadPermissionId !== undefined && permission === undefined)
        return failure("download-permission-unavailable");
      if (permission === undefined && approvals === undefined)
        return failure("browser-approval-required");
      if (options.browser.saveDownload === undefined) return failure("download-unavailable");
      if (signal?.aborted) return failure("tool-interrupted");
      const saved = await options.browser.saveDownload({
        windowId: options.windowId,
        threadId: options.threadId,
        downloadId: input.downloadId,
        workspaceRoot: permission === undefined ? options.uploadRoot?.() : undefined,
        ...(permission === undefined
          ? signal === undefined
            ? {}
            : { signal }
          : {
              signal:
                signal === undefined
                  ? permission.signal
                  : AbortSignal.any([signal, permission.signal]),
              permissionSignal: permission.signal,
              destination: permission.destination,
              finalAdmission: permission.reserve,
            }),
        ask: async (facts, pageOrigin) =>
          permission === undefined
            ? (approvals?.request({
                windowId: options.windowId,
                threadId: String(options.threadId),
                authority,
                origin: pageOrigin,
                ...(profile === undefined ? {} : { profile }),
                download: facts,
                ...(signal === undefined ? {} : { signal }),
              }) ?? "denied")
            : permission.inspect(facts, pageOrigin),
      });
      return saved.status === "saved" ? browserDownloadSavedResult(saved) : failure(saved.error);
    }
    const request = browserToolAction(input, context);
    if (request === undefined) return failure("invalid-browser-input");
    if (signal?.aborted) return failure("tool-interrupted");
    let uploadFiles: ReadonlyArray<string> | undefined;
    let releaseUpload: (() => Promise<void>) | undefined;
    let uploadSignal: AbortSignal | undefined;
    let uploadIsCurrent: (() => boolean) | undefined;
    if (input.operation === "upload") {
      // A CLI in a terminal is not the person who would be asked.
      if (options.profileCaller === "terminal-grant") return failure("upload-needs-a-person");
      const approvals = options.approvals;
      if (approvals === undefined) return failure("browser-approval-required");
      const permission =
        input.uploadPermissionId === undefined || profile === undefined
          ? undefined
          : options.uploadPermission?.({
              permissionId: input.uploadPermissionId,
              profile,
              origin,
              files: input.files,
            });
      if (input.uploadPermissionId !== undefined && permission === undefined)
        return failure("upload-permission-required");
      uploadSignal = permission?.signal;
      uploadIsCurrent = permission?.isCurrent;
      const admitted = await admitBrowserUpload({
        workspaceRoot: permission?.workspaceRoot ?? options.uploadRoot?.(),
        files: input.files,
        ask: (files) =>
          permission?.approve(files) ??
          approvals.request({
            windowId: options.windowId,
            threadId: String(options.threadId),
            authority,
            origin,
            ...(profile === undefined ? {} : { profile }),
            upload: files,
            ...(signal === undefined ? {} : { signal }),
          }),
      });
      if (admitted.status === "refused") return failure(admitted.reason);
      uploadFiles = admitted.paths;
      releaseUpload = admitted.release;
    }
    if (releaseUpload !== undefined) {
      const refreshed = options.resolveAuthority(options.threadId, options.mode);
      const refusal = signal?.aborted
        ? "tool-interrupted"
        : refreshed === undefined || !sameToolActionAuthority(authority, refreshed)
          ? "browser-authority-stale"
          : !modelIsCurrent(options)
            ? "browser-model-stale"
            : undefined;
      if (refusal !== undefined) {
        await releaseUpload();
        return failure(refusal);
      }
    }
    // An approval or an upload question may have waited while the agent
    // handed the page to the person; the page is theirs until they answer.
    const heldNow = options.browser.inspectThread(
      options.windowId,
      options.threadId,
    ).waitingForPerson;
    if (heldNow !== undefined) {
      await releaseUpload?.();
      return heldForPersonAnswer(heldNow);
    }
    // The page reads an uploaded file when its form is sent, which can be a
    // later action, so the service keeps the copies until the page closes.
    const acted = await options.browser.act({
      windowId: options.windowId,
      // The service refuses a context that is another thread's, even when the
      // two threads share a Project and so an authority.
      threadId: options.threadId,
      request,
      capturedBy: "agent",
      ...(input.operation === "record-stop" && input.discard === true
        ? { discardRecording: true }
        : {}),
      refuseStaleRevision: true,
      // Downloads are held only for a turn at this computer with a workspace to
      // save into, where the question about saving one can be answered.
      ...(options.profileCaller === "terminal-grant" ||
      options.approvals?.isPairedDevice?.(options.windowId) === true ||
      (options.uploadRoot?.() === undefined && options.downloadPermission === undefined)
        ? {}
        : { holdDownloads: true }),
      ...(uploadFiles === undefined ? {} : { uploadFiles }),
      ...(uploadSignal === undefined ? {} : { uploadSignal }),
      ...(uploadIsCurrent === undefined ? {} : { uploadIsCurrent }),
      ...(releaseUpload === undefined ? {} : { releaseUpload }),
    });
    if (signal?.aborted) return failure("tool-interrupted");
    const heldInQueue = heldWhileQueued(acted);
    if (heldInQueue !== undefined) return heldForPersonAnswer(heldInQueue);
    if (!modelIsCurrent(options)) return failure("browser-model-stale");
    if (
      input.operation === "screenshot" &&
      acted.failure === undefined &&
      browserToolImage(acted.observation?.screenshotDataUrl) === undefined
    ) {
      return failure("browser-screenshot-unavailable");
    }
    return browserToolResult(
      afterSignIn &&
        acted.failure?.category === "policy-denied" &&
        acted.failure.reason === "origin-not-approved"
        ? { ...acted, failure: browserSignInOriginRefusal() }
        : acted,
      browserToolWantsScreenshot(input),
    );
  };
  const activeContextId = (): string | undefined => {
    const context = options.browser.inspectThread(options.windowId, options.threadId).context;
    return context?.state === "active" ? String(context.contextId) : undefined;
  };
  const refsOfLatestSnapshot = (): BrowserFlowRefs =>
    options.browser.snapshotRefs?.(options.windowId, options.threadId) ?? [];
  // Every operation of the agent goes through here, so a flow records what ran
  // and a replay runs each step exactly as a call of its own would.
  const runRecorded = (
    step: Exclude<BrowserToolInput, { readonly operation: "steps" }>,
    signal: AbortSignal | undefined,
  ): Promise<BrowserToolAnswer> =>
    runRecordingFlow({
      step,
      flows: options.browser.snapshotRefs === undefined ? undefined : options.flows,
      refs: refsOfLatestSnapshot,
      contextId: activeContextId,
      run: () => runOne(step, signal),
    });
  const runFlow = async (
    input: Extract<
      BrowserToolInput,
      { readonly operation: "flow-save" | "flow-list" | "flow-run" }
    >,
    signal: AbortSignal | undefined,
  ): Promise<BrowserToolAnswer> => {
    const flows = options.flows;
    if (flows === undefined || options.browser.snapshotRefs === undefined) {
      return failure("browser-flows-unavailable");
    }
    const authority = options.resolveAuthority(options.threadId, options.mode);
    if (authority === undefined) return failure("browser-authority-unavailable");
    if (initialAuthority !== undefined && !sameToolActionAuthority(initialAuthority, authority)) {
      return failure("browser-authority-stale");
    }
    if (!modelIsCurrent(options)) return failure("browser-model-stale");
    if (options.executionPolicy === "plan" && browserOperationRefusedInPlan(input.operation)) {
      return failure("plan-mode-read-only");
    }
    return runBrowserFlowOperation(input, {
      flows,
      projectId: authority.projectId,
      caller: flows.caller(options.windowId),
      actor: () => browserFlowAgentActor(authority, String(options.threadId)),
      contextId: activeContextId,
      refs: refsOfLatestSnapshot,
      run: (step) => runRecorded(step, signal),
    });
  };
  const tools: AppManagedToolSet = {
    definitions,
    execute: async ({ inputJson, name, signal }) => {
      if (name !== BROWSER_TOOL_NAME || definitions.length === 0) {
        return failure("tool-unavailable");
      }
      if (signal?.aborted) return failure("tool-interrupted");
      const input = parseBrowserToolInput(inputJson, {
        allowProfile: true,
        allowUploadPermission: options.uploadPermission !== undefined,
        allowDownloadPermission: options.downloadPermission !== undefined,
      });
      if (input === undefined) return failure("invalid-browser-input");
      // The stop runs without the turn's signal, so a turn that ends mid-call
      // still ends its recording and keeps what was recorded. It runs in Plan
      // too, keeping nothing, so a recording started before Plan never runs
      // on to its own bound.
      const record = async (operation: BrowserToolRecordingOperation) => {
        if (operation === "record-start") return runOne({ operation }, signal);
        if (options.executionPolicy !== "plan") return runOne({ operation }, undefined);
        const stopped = await runOne({ operation, discard: true }, undefined);
        return stopped.isError ? stopped : failure("plan-mode-read-only");
      };
      if (isBrowserToolFlowInput(input)) {
        return input.operation === "flow-run" && input.record === true
          ? runRecordedBrowserCall(() => runFlow(input, signal), record)
          : runFlow(input, signal);
      }
      if (input.operation === "steps") {
        const batch = () => runBrowserToolSteps(input.steps, (step) => runRecorded(step, signal));
        return input.record === true ? runRecordedBrowserCall(batch, record) : batch();
      }
      return runRecorded(input, signal);
    },
  };
  return withToolFamilyHelp(tools, BROWSER_TOOL_HELP);
}

/**
 * Who may be asked to sign in: a person at a window of this computer. A
 * routine, a subagent, a terminal CLI, and a paired device have no one there,
 * or no one who can see the page.
 */
function signInRefusal(options: BrowserAppManagedToolsOptions): string | undefined {
  if (options.profileCaller === "terminal-grant") return "sign-in-needs-a-person";
  if (options.approvals?.isUnattendedScope?.(options.windowId) === true) {
    return "sign-in-needs-a-person";
  }
  if (options.approvals?.isPairedDevice?.(options.windowId) === true) {
    return "sign-in-needs-this-computer";
  }
  return undefined;
}

/** The stored profile a `profile` argument names for this thread, if it has one. */
function requestedProfile(
  choice: BrowserProfileChoice,
  authority: ToolActionAuthority,
): StoredBrowserProfile | undefined {
  return storedBrowserProfile(browserProfileFromChoice(choice, authority.projectId));
}

function modelIsCurrent(options: BrowserAppManagedToolsOptions): boolean {
  const current = options.resolveModelId(options.threadId, options.mode);
  return current !== undefined && String(current) === String(options.modelId);
}

const MAX_BROWSER_MODEL_BINDINGS = 256;

export function rememberModelBinding(
  bindings: Map<string, BrowserModelBinding>,
  contextId: string,
  binding: BrowserModelBinding,
): void {
  if (!bindings.has(contextId) && bindings.size >= MAX_BROWSER_MODEL_BINDINGS) {
    const oldest = bindings.keys().next().value;
    if (oldest !== undefined) bindings.delete(oldest);
  }
  bindings.set(contextId, binding);
}

function actionRequest(
  options: BrowserAppManagedToolsOptions,
  authority: ToolActionAuthority,
): ToolActionRequest {
  return {
    actionId: options.uuid() as ToolActionRequest["actionId"],
    correlationId: options.uuid() as ToolActionRequest["correlationId"],
    capability: { id: "browser-automation" as ToolActionRequest["capability"]["id"], version: 1 },
    authority,
    intent: "Operate the thread-owned isolated browser.",
    approval: { kind: "not-required" },
  };
}

function allowedOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function failure(reason: string) {
  return { result: { error: reason }, isError: true };
}
